#!/usr/bin/env node
import fs from 'node:fs';
import { BrowserManager } from '../core/browser/browser-manager.js';
import { findChromeExecutable } from '../core/browser/chrome-launcher.js';
import { loadConfig, paths } from '../core/config.js';
import { toErrorPayload } from '../core/errors.js';
import { createLogger } from '../core/logger.js';

const USAGE = `ai-web <command>

  doctor                         check node, Chrome, directories
  status [profile]               browser status (default: all known profiles)
  browser start <profile> [url]  launch (or attach to) the profile's Chrome, headed unless AI_WEB_HEADLESS=1
  browser stop <profile>         terminate the profile's Chrome
`;

function out(v: unknown): void {
  process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, a, b] = argv;
  const cfg = loadConfig();
  const mgr = new BrowserManager(cfg, createLogger(cfg));

  switch (cmd) {
    case 'doctor': {
      const nodeMajor = Number(process.versions.node.split('.')[0]);
      let chrome: string | null = null;
      try {
        chrome = findChromeExecutable(cfg.chromePath);
      } catch {
        /* reported below */
      }
      const checks = {
        node: { version: process.versions.node, ok: nodeMajor >= 22 },
        chrome: { path: chrome, ok: chrome !== null },
        home: { path: cfg.home, ok: true },
      };
      fs.mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
      out(checks);
      return checks.node.ok && checks.chrome.ok ? 0 : 1;
    }
    case 'status': {
      const dir = `${cfg.home}/state`;
      const names = a ? [a] : fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
      out(await Promise.all(names.map((n) => mgr.status(n))));
      return 0;
    }
    case 'browser': {
      if (!b) break;
      if (a === 'start') {
        const m = await mgr.ensure(b, argv[3] ? { startUrl: argv[3] } : {});
        const s = m.state;
        await m.disconnect();
        out({ profile: s.profile, pid: s.pid, port: s.port, userDataDir: paths(cfg, b).userDataDir });
        return 0;
      }
      if (a === 'stop') {
        out({ stopped: await mgr.terminate(b) });
        return 0;
      }
      break;
    }
  }
  process.stderr.write(USAGE);
  return cmd ? 2 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${JSON.stringify(toErrorPayload(e))}\n`);
    process.exit(1);
  },
);
