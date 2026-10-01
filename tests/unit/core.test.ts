import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBrowserState, writeBrowserState } from '../../src/core/browser/browser-state.js';
import { findChromeExecutable, readDevToolsActivePort } from '../../src/core/browser/chrome-launcher.js';
import { retryIdempotent } from '../../src/core/browser/interaction.js';
import { AIWebError } from '../../src/core/errors.js';
import { acquireLock, isPidAlive } from '../../src/core/lock/profile-lock.js';
import { Throttle } from '../../src/core/safety/throttle.js';
import { sleep } from '../../src/core/util.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiweb-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('profile lock', () => {
  it('excludes a second acquirer in the same process, then hands over on release', async () => {
    const f = path.join(dir, 'a.lock');
    const a = await acquireLock(f, { op: 'a', timeoutMs: 500 });
    await expect(acquireLock(f, { op: 'b', timeoutMs: 150 })).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    a.release();
    const b = await acquireLock(f, { op: 'b', timeoutMs: 500 });
    b.release();
    expect(fs.existsSync(f)).toBe(false);
  });

  it('reclaims a lock whose owner pid is dead', async () => {
    const f = path.join(dir, 'a.lock');
    const dead = spawnSync(process.execPath, ['-e', '0']);
    fs.writeFileSync(f, JSON.stringify({ pid: dead.pid, nonce: 'x', startedAt: 'now', op: 'old' }));
    expect(isPidAlive(dead.pid)).toBe(false);
    const h = await acquireLock(f, { op: 'new', timeoutMs: 1000 });
    expect(h.info.op).toBe('new');
    h.release();
  });

  it('does not steal from a live owner and release by a stale handle is a no-op', async () => {
    const f = path.join(dir, 'a.lock');
    const a = await acquireLock(f, { op: 'a', timeoutMs: 500 });
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid, nonce: 'other', startedAt: 'now', op: 'o' }));
    a.release(); // nonce mismatch → must not delete
    expect(fs.existsSync(f)).toBe(true);
  });

  it('provides mutual exclusion across real processes', async () => {
    const f = path.join(dir, 'x.lock');
    const counter = path.join(dir, 'counter');
    fs.writeFileSync(counter, '0');
    // Each worker does read-modify-write under the lock; lost updates ⇒ broken exclusion.
    const script = `
      import { acquireLock } from '${path.resolve('src/core/lock/profile-lock.ts')}';
      import fs from 'node:fs';
      for (let i = 0; i < 15; i++) {
        const h = await acquireLock(${JSON.stringify(f)}, { op: 'w', timeoutMs: 20000, pollMs: 5 });
        const n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
        await new Promise((r) => setTimeout(r, 2));
        fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
        h.release();
      }
    `;
    const run = () =>
      new Promise<number>((resolve) => {
        const c = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: 'inherit' });
        c.on('exit', (code) => resolve(code ?? -1));
      });
    const codes = await Promise.all([run(), run(), run()]);
    expect(codes).toEqual([0, 0, 0]);
    expect(fs.readFileSync(counter, 'utf8')).toBe('45');
  }, 60000);
});

describe('throttle', () => {
  it('spaces concurrent callers by the min interval', async () => {
    let t = 0;
    const waits: number[] = [];
    const th = new Throttle(
      100,
      () => t,
      async (ms) => {
        waits.push(ms);
        t += ms;
      },
    );
    t = 1000;
    await Promise.all([th.wait(), th.wait(), th.wait()]);
    expect(waits).toEqual([100, 100]); // first free (last=0), then two gaps
  });
});

describe('retryIdempotent', () => {
  it('retries then succeeds, honours attempts and shouldRetry, never retries ABORTED', async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error('a')).mockResolvedValue('ok');
    await expect(retryIdempotent(f, { attempts: 3, baseDelayMs: 1 })).resolves.toBe('ok');
    expect(f).toHaveBeenCalledTimes(2);

    const g = vi.fn().mockRejectedValue(new Error('x'));
    await expect(retryIdempotent(g, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow('x');
    expect(g).toHaveBeenCalledTimes(3);

    const h = vi.fn().mockRejectedValue(new AIWebError('ABORTED', 'a'));
    await expect(retryIdempotent(h, { attempts: 3, baseDelayMs: 1 })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(h).toHaveBeenCalledTimes(1);

    const k = vi.fn().mockRejectedValue(new Error('fatal'));
    await expect(retryIdempotent(k, { attempts: 3, baseDelayMs: 1, shouldRetry: () => false })).rejects.toThrow('fatal');
    expect(k).toHaveBeenCalledTimes(1);
  });
});

describe('sleep', () => {
  it('rejects ABORTED on abort and when already aborted', async () => {
    const ac = new AbortController();
    const p = sleep(5000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(sleep(10, ac.signal)).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('state + launcher helpers', () => {
  it('state roundtrip is atomic and tolerant of garbage', () => {
    const f = path.join(dir, 's', 'p.json');
    const st = {
      profile: 'p', pid: 1, port: 2, wsEndpoint: 'ws://x', executable: 'e', userDataDir: 'u', headless: true, startedAt: 't',
    };
    writeBrowserState(f, st);
    expect(readBrowserState(f)).toEqual(st);
    fs.writeFileSync(f, '{garbage');
    expect(readBrowserState(f)).toBeNull();
  });

  it('parses DevToolsActivePort and rejects malformed', () => {
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '53122\n/devtools/browser/abc\n');
    expect(readDevToolsActivePort(dir)).toEqual({ port: 53122, wsPath: '/devtools/browser/abc' });
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), 'nope\n');
    expect(readDevToolsActivePort(dir)).toBeNull();
  });

  it('findChromeExecutable honours explicit path and errors clearly', () => {
    expect(findChromeExecutable(process.execPath)).toBe(process.execPath);
    const empty = fs.mkdtempSync(path.join(dir, 'bin'));
    const old = process.env.PATH;
    process.env.PATH = empty;
    try {
      expect(() => findChromeExecutable(undefined, 'linux')).toThrowError(/AI_WEB_CHROME/);
    } finally {
      process.env.PATH = old;
    }
  });
});
