import { sleep } from '../util.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AIWebError } from '../errors.js';

export interface LockInfo {
  pid: number;
  nonce: string;
  startedAt: string;
  op: string;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readInfo(file: string): LockInfo | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockInfo>;
    if (typeof v.pid === 'number' && typeof v.nonce === 'string') return v as LockInfo;
    return null;
  } catch {
    return null;
  }
}

export interface LockHandle {
  readonly info: LockInfo;
  release(): void;
}

export interface AcquireOptions {
  op: string;
  timeoutMs: number;
  pollMs?: number;
  signal?: AbortSignal;
}

/**
 * Cross-process lock using O_EXCL file creation. Stale locks (owner pid dead,
 * or file unparsable for longer than a grace period) are reclaimed.
 * Same-process re-entry is NOT allowed: a second acquire waits like any other.
 */
export async function acquireLock(file: string, opts: AcquireOptions): Promise<LockHandle> {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + opts.timeoutMs;
  const poll = opts.pollMs ?? 50;
  const info: LockInfo = {
    pid: process.pid,
    nonce: crypto.randomBytes(8).toString('hex'),
    startedAt: new Date().toISOString(),
    op: opts.op,
  };

  for (;;) {
    if (opts.signal?.aborted) throw new AIWebError('ABORTED', 'Aborted while waiting for lock.');
    try {
      // Write full content atomically-enough: create exclusively then write.
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(info));
      } finally {
        fs.closeSync(fd);
      }
      return {
        info,
        release() {
          const cur = readInfo(file);
          if (cur && cur.nonce === info.nonce) {
            try {
              fs.unlinkSync(file);
            } catch {
              /* already gone */
            }
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    const holder = readInfo(file);
    if (holder === null) {
      // Empty/partial file: creator may be mid-write. Reclaim only if old.
      try {
        const age = Date.now() - fs.statSync(file).mtimeMs;
        if (age > 2000) tryReclaim(file, null);
      } catch {
        /* vanished, retry */
      }
    } else if (!isPidAlive(holder.pid)) {
      tryReclaim(file, holder.nonce);
    }

    if (Date.now() >= deadline) {
      throw new AIWebError('SESSION_BUSY', 'Profile is busy with another operation.', {
        holder_pid: holder?.pid,
        holder_op: holder?.op,
        holder_since: holder?.startedAt,
      });
    }
    await sleep(poll, opts.signal);
  }
}

/** Remove a stale lock only if it still carries the nonce we judged stale. */
function tryReclaim(file: string, nonce: string | null): void {
  const stolen = `${file}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(file, stolen);
  } catch {
    return; // someone else reclaimed or released
  }
  const got = readInfo(stolen);
  const wasStale = nonce === null ? got === null : got?.nonce === nonce;
  if (!wasStale && got) {
    // We grabbed a fresh lock by mistake; put it back if the slot is free.
    try {
      fs.linkSync(stolen, file);
    } catch {
      /* slot retaken; holder will notice nothing worse than losing exclusivity once */
    }
  }
  try {
    fs.unlinkSync(stolen);
  } catch {
    /* ignore */
  }
}

export function readLockInfo(file: string): LockInfo | null {
  const i = readInfo(file);
  return i && isPidAlive(i.pid) ? i : null;
}
