import { sleep } from '../util.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AIWebError } from '../errors.js';
import { isPidAlive } from '../lock/profile-lock.js';

export function findChromeExecutable(explicit?: string, platform: NodeJS.Platform = process.platform): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (platform === 'darwin') {
    for (const app of ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Google Chrome Canary']) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
      candidates.push(path.join(os.homedir(), `Applications/${app}.app/Contents/MacOS/${app}`));
    }
  } else if (platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    for (const r of roots) {
      candidates.push(path.join(r, 'Google/Chrome/Application/chrome.exe'));
      candidates.push(path.join(r, 'Microsoft/Edge/Application/msedge.exe'));
    }
  } else {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      for (const dir of (process.env.PATH ?? '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, n));
    }
  }
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* next */
    }
  }
  throw new AIWebError('BROWSER_NOT_FOUND', 'No Chrome/Chromium/Edge executable found. Set AI_WEB_CHROME.', {
    tried: candidates.slice(0, 8),
  });
}

/** Returns pid of a live Chrome holding this profile (SingletonLock), if any. */
export function profileHolderPid(userDataDir: string): number | null {
  try {
    // mac/linux: SingletonLock is a symlink to "<hostname>-<pid>"
    const target = fs.readlinkSync(path.join(userDataDir, 'SingletonLock'));
    const pid = Number(target.slice(target.lastIndexOf('-') + 1));
    return isPidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export interface DevToolsEndpoint {
  port: number;
  wsPath: string;
}

export function readDevToolsActivePort(userDataDir: string): DevToolsEndpoint | null {
  try {
    const [portLine, wsPath] = fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n');
    const port = Number(portLine);
    if (!Number.isInteger(port) || port <= 0 || !wsPath) return null;
    return { port, wsPath: wsPath.trim() };
  } catch {
    return null;
  }
}

/** Ask the CDP HTTP endpoint for the browser websocket URL. null if not reachable. */
export async function probeCdp(port: number, timeoutMs = 1500): Promise<{ wsEndpoint: string; browser: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const j = (await res.json()) as { webSocketDebuggerUrl?: string; Browser?: string };
    if (!j.webSocketDebuggerUrl) return null;
    return { wsEndpoint: j.webSocketDebuggerUrl, browser: j.Browser ?? '' };
  } catch {
    return null;
  }
}

export interface SpawnOptions {
  executable: string;
  userDataDir: string;
  headless: boolean;
  startupTimeoutMs?: number;
  startUrl?: string;
}

export interface SpawnedChrome {
  pid: number;
  port: number;
  wsEndpoint: string;
}

/**
 * Spawn Chrome detached with a dedicated non-default user-data-dir
 * (Chrome >=136 ignores remote debugging on the default dir) and a dynamic
 * CDP port, then wait for DevToolsActivePort + a successful CDP probe.
 */
export async function spawnChrome(opts: SpawnOptions): Promise<SpawnedChrome> {
  fs.mkdirSync(opts.userDataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(opts.userDataDir, 0o700);

  const holder = profileHolderPid(opts.userDataDir);
  if (holder) {
    throw new AIWebError(
      'BROWSER_PROFILE_IN_USE',
      `Profile is open in a Chrome (pid ${holder}) without a usable CDP endpoint. Close it, or run "ai-web browser stop".`,
      { pid: holder },
    );
  }
  // Stale marker from a dead Chrome would make us attach to nothing.
  fs.rmSync(path.join(opts.userDataDir, 'DevToolsActivePort'), { force: true });

  const args = [
    `--user-data-dir=${opts.userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (opts.headless) args.push('--headless=new');
  args.push(opts.startUrl ?? 'about:blank');

  const child = spawn(opts.executable, args, { detached: true, stdio: 'ignore' });
  let spawnError: Error | null = null;
  let exited = false;
  child.once('error', (e) => (spawnError = e));
  child.once('exit', () => (exited = true));
  child.unref();
  const pid = child.pid;
  if (!pid) throw new AIWebError('BROWSER_CONNECT_FAILED', 'Failed to spawn Chrome.', {}, { cause: spawnError });

  const deadline = Date.now() + (opts.startupTimeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (spawnError) throw new AIWebError('BROWSER_CONNECT_FAILED', `Chrome failed to start: ${(spawnError as Error).message}`);
    if (exited && !isPidAlive(pid)) {
      throw new AIWebError(
        'BROWSER_CONNECT_FAILED',
        'Chrome exited during startup (profile may be locked by another Chrome instance).',
      );
    }
    const ep = readDevToolsActivePort(opts.userDataDir);
    if (ep) {
      const probe = await probeCdp(ep.port);
      if (probe) return { pid, port: ep.port, wsEndpoint: probe.wsEndpoint };
    }
    await sleep(100);
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* gone */
  }
  throw new AIWebError('BROWSER_CONNECT_FAILED', 'Timed out waiting for Chrome DevTools endpoint.');
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}
