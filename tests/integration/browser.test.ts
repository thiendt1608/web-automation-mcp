import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserManager } from '../../src/core/browser/browser-manager.js';
import { spawnChrome, findChromeExecutable } from '../../src/core/browser/chrome-launcher.js';
import { Interaction } from '../../src/core/browser/interaction.js';
import { getOrCreatePage } from '../../src/core/browser/page-manager.js';
import { loadConfig, paths } from '../../src/core/config.js';
import { isPidAlive } from '../../src/core/lock/profile-lock.js';
import { createLogger } from '../../src/core/logger.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const cleanup: Array<() => void> = [];

let home: string;
let mgr: BrowserManager;
const cfg = () => loadConfig({ AI_WEB_HOME: home, AI_WEB_HEADLESS: '1' });

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiweb-int-'));
  const c = cfg();
  mgr = new BrowserManager(c, createLogger({ home, logLevel: 'warn' }, { file: false }));
});

afterAll(async () => {
  for (const fn of cleanup) fn();
  for (const p of ['alpha', 'beta', 'gamma']) await mgr.terminate(p).catch(() => undefined);
  fs.rmSync(home, { recursive: true, force: true });
});

describe('BrowserManager with real Chrome', () => {
  it('launches, persists state, and disconnect() does NOT kill Chrome', async () => {
    expect(await mgr.status('alpha')).toEqual({ running: false, profile: 'alpha' });
    const m = await mgr.ensure('alpha');
    const { pid, port } = m.state;
    expect(isPidAlive(pid)).toBe(true);
    expect(fs.existsSync(paths(cfg(), 'alpha').state)).toBe(true);
    expect((fs.statSync(paths(cfg(), 'alpha').userDataDir).mode & 0o777).toString(8)).toBe('700');

    await m.disconnect();
    expect(isPidAlive(pid)).toBe(true);
    const s = await mgr.status('alpha');
    expect(s).toMatchObject({ running: true, pid, port });
  });

  it('reconnects to the same Chrome from a separate process (no second launch)', async () => {
    const before = await mgr.status('alpha');
    const script = `
      import { BrowserManager } from './src/core/browser/browser-manager.ts';
      import { loadConfig } from './src/core/config.ts';
      import { createLogger } from './src/core/logger.ts';
      const cfg = loadConfig();
      const m = await new BrowserManager(cfg, createLogger(cfg, { file: false })).ensure('alpha');
      const page = await m.browser.contexts()[0].newPage();
      const v = await page.evaluate(() => 20 + 22);
      await page.close();
      await m.disconnect();
      console.log(JSON.stringify({ pid: m.state.pid, v }));
    `;
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, AI_WEB_HOME: home, AI_WEB_HEADLESS: '1', AI_WEB_LOG_LEVEL: 'warn' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').pop()!)).toEqual({ pid: before.pid, v: 42 });
    expect(isPidAlive(before.pid!)).toBe(true);
  });

  it('concurrent ensure() calls on a cold profile spawn exactly one Chrome', async () => {
    const ms = await Promise.all([mgr.ensure('beta'), mgr.ensure('beta'), mgr.ensure('beta')]);
    expect(new Set(ms.map((m) => m.state.pid)).size).toBe(1);
    await Promise.all(ms.map((m) => m.disconnect()));
  });

  it('adopts a live Chrome when the state file is lost', async () => {
    const before = await mgr.status('beta');
    fs.rmSync(paths(cfg(), 'beta').state);
    const m = await mgr.ensure('beta');
    expect(m.state.pid).toBe(before.pid);
    await m.disconnect();
  });

  it('terminate() stops Chrome, clears state, and a new ensure() launches a fresh one', async () => {
    const m1 = await mgr.ensure('gamma');
    const old = m1.state.pid;
    await m1.disconnect();
    expect(await mgr.terminate('gamma')).toBe(true);
    expect(isPidAlive(old)).toBe(false);
    expect(fs.existsSync(paths(cfg(), 'gamma').state)).toBe(false);
    expect(await mgr.terminate('gamma')).toBe(false);
    const m2 = await mgr.ensure('gamma');
    expect(m2.state.pid).not.toBe(old);
    await m2.disconnect();
  });

  it('cookies persist across Chrome restarts of the same profile', async () => {
    const m1 = await mgr.ensure('gamma');
    const ctx = m1.browser.contexts()[0]!;
    await ctx.addCookies([{ name: 'k', value: 'v', url: 'https://example.com', expires: Math.floor(Date.now() / 1000) + 3600 }]);
    await m1.disconnect();
    await mgr.terminate('gamma'); // graceful SIGTERM flushes the cookie DB
    const m2 = await mgr.ensure('gamma');
    const cookies = await m2.browser.contexts()[0]!.cookies('https://example.com');
    await m2.disconnect();
    expect(cookies.find((c) => c.name === 'k')?.value).toBe('v');
  });
});

describe('profile in use without CDP', () => {
  it('reports BROWSER_PROFILE_IN_USE instead of hanging or killing', async () => {
    const exe = findChromeExecutable();
    const dir = fs.mkdtempSync(path.join(home, 'manual-'));
    // A Chrome the user opened by hand: no remote debugging flag.
    const c = spawn(exe, [`--user-data-dir=${dir}`, '--headless=new', '--no-first-run', 'about:blank'], { stdio: 'ignore', detached: true });
    c.unref();
    try {
      // wait for SingletonLock (real condition, not a guessed sleep)
      await expect
        .poll(() => fs.existsSync(path.join(dir, 'SingletonLock')) || fs.lstatSync(path.join(dir, 'SingletonLock'), { throwIfNoEntry: false }) !== undefined, { timeout: 15000 })
        .toBe(true);
      await expect(spawnChrome({ executable: exe, userDataDir: dir, headless: true })).rejects.toMatchObject({
        code: 'BROWSER_PROFILE_IN_USE',
      });
      expect(isPidAlive(c.pid!)).toBe(true);
    } finally {
      process.kill(c.pid!, 'SIGKILL');
    }
  });
});

describe('page manager + interaction', () => {
  it('reuses a tab on the same origin and wraps actions with timeout/abort', async () => {
    const m = await mgr.ensure('alpha');
    try {
      const srv = http.createServer((_q, r) => {
        r.setHeader('content-type', 'text/html');
        r.end('<input id=a><button id=b onclick="document.title=document.getElementById(\'a\').value">go</button>');
      });
      srv.listen(0, '127.0.0.1');
      await once(srv, 'listening');
      const port = (srv.address() as AddressInfo).port;
      cleanup.push(() => srv.close());
      const url = `http://127.0.0.1:${port}/`;
      const p1 = await getOrCreatePage(m.browser, url);
      expect(await getOrCreatePage(m.browser, `${url}other`)).toBe(p1); // same origin → same tab
      const other = await getOrCreatePage(m.browser, `http://localhost:${port}/`); // different origin → new tab
      expect(other).not.toBe(p1);
      await other.close();
      const ac = new AbortController();
      const it = new Interaction(p1, { timeoutMs: 1500, signal: ac.signal });
      await it.insertText('#a', 'hello world');
      await it.click('#b');
      expect(await p1.title()).toBe('hello world');
      expect(await it.evaluate((n: number) => n * 2, 21)).toBe(42);

      await expect(it.click('#missing')).rejects.toThrow(/Timeout/);

      const slow = it.waitFor('#never', 'visible', 20000);
      ac.abort();
      await expect(slow).rejects.toMatchObject({ code: 'ABORTED' });
      await expect(it.click('#b')).rejects.toMatchObject({ code: 'ABORTED' });
    } finally {
      await m.disconnect();
    }
  });
});
