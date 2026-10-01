import { chromium, type Browser } from 'playwright-core';
import { paths, type Config } from '../config.js';
import { AIWebError } from '../errors.js';
import { acquireLock, isPidAlive } from '../lock/profile-lock.js';
import type { Logger } from '../logger.js';
import { clearBrowserState, readBrowserState, writeBrowserState, type BrowserState } from './browser-state.js';
import {
  findChromeExecutable,
  probeCdp,
  profileHolderPid,
  readDevToolsActivePort,
  spawnChrome,
  waitForExit,
} from './chrome-launcher.js';

export interface BrowserStatus {
  running: boolean;
  profile: string;
  pid?: number;
  port?: number;
  startedAt?: string;
  headless?: boolean;
}

export interface ManagedBrowser {
  browser: Browser;
  state: BrowserState;
  /** Drops the CDP connection only. Chrome keeps running. */
  disconnect(): Promise<void>;
}

export interface EnsureOptions {
  headless?: boolean;
  startUrl?: string;
}

export class BrowserManager {
  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  /** Live state (pid alive AND CDP answers) or null. Cleans dead state. */
  async #liveState(profile: string): Promise<BrowserState | null> {
    const p = paths(this.cfg, profile);
    const st = readBrowserState(p.state);
    if (st && isPidAlive(st.pid)) {
      const probe = await probeCdp(st.port);
      if (probe) return { ...st, wsEndpoint: probe.wsEndpoint };
    }
    if (st) clearBrowserState(p.state);

    // State lost but Chrome with CDP is up for this profile: adopt it.
    const holder = profileHolderPid(p.userDataDir);
    const ep = holder ? readDevToolsActivePort(p.userDataDir) : null;
    if (holder && ep) {
      const probe = await probeCdp(ep.port);
      if (probe) {
        const adopted: BrowserState = {
          profile,
          pid: holder,
          port: ep.port,
          wsEndpoint: probe.wsEndpoint,
          executable: '',
          userDataDir: p.userDataDir,
          headless: false,
          startedAt: new Date().toISOString(),
        };
        writeBrowserState(p.state, adopted);
        this.log.info({ profile, pid: holder }, 'adopted running chrome');
        return adopted;
      }
    }
    return null;
  }

  async status(profile: string): Promise<BrowserStatus> {
    const st = await this.#liveState(profile);
    if (!st) return { running: false, profile };
    return { running: true, profile, pid: st.pid, port: st.port, startedAt: st.startedAt, headless: st.headless };
  }

  /** Attach to the profile's Chrome, launching it first if needed. */
  async ensure(profile: string, opts: EnsureOptions = {}): Promise<ManagedBrowser> {
    const p = paths(this.cfg, profile);
    let st = await this.#liveState(profile);

    if (!st) {
      // Serialize launches across processes so two callers never spawn two Chromes.
      const lock = await acquireLock(`${p.lock}.launch`, { op: 'launch', timeoutMs: 30_000 });
      try {
        st = await this.#liveState(profile);
        if (!st) {
          const executable = findChromeExecutable(this.cfg.chromePath);
          const headless = opts.headless ?? this.cfg.headless;
          const t0 = Date.now();
          const s = await spawnChrome({
            executable,
            userDataDir: p.userDataDir,
            headless,
            ...(opts.startUrl ? { startUrl: opts.startUrl } : {}),
          });
          st = {
            profile,
            pid: s.pid,
            port: s.port,
            wsEndpoint: s.wsEndpoint,
            executable,
            userDataDir: p.userDataDir,
            headless,
            startedAt: new Date().toISOString(),
          };
          writeBrowserState(p.state, st);
          this.log.info({ profile, pid: s.pid, port: s.port, duration_ms: Date.now() - t0 }, 'chrome launched');
        }
      } finally {
        lock.release();
      }
    }

    try {
      const browser = await chromium.connectOverCDP(st.wsEndpoint, { timeout: 15_000 });
      return {
        browser,
        state: st,
        async disconnect() {
          await browser.close(); // CDP-attached: disconnects, does not kill Chrome
        },
      };
    } catch (e) {
      throw new AIWebError('BROWSER_CONNECT_FAILED', `Could not attach to Chrome over CDP: ${(e as Error).message}`, {}, { cause: e });
    }
  }

  /** Stop the profile's Chrome (SIGTERM, then SIGKILL after grace). */
  async terminate(profile: string): Promise<boolean> {
    const p = paths(this.cfg, profile);
    const st = await this.#liveState(profile);
    if (!st) return false;
    process.kill(st.pid, 'SIGTERM');
    if (!(await waitForExit(st.pid, 8000))) {
      process.kill(st.pid, 'SIGKILL');
      await waitForExit(st.pid, 3000);
    }
    clearBrowserState(p.state);
    this.log.info({ profile, pid: st.pid }, 'chrome terminated');
    return true;
  }
}
