import fs from 'node:fs';
import path from 'node:path';

export interface BrowserState {
  profile: string;
  pid: number;
  port: number;
  wsEndpoint: string;
  executable: string;
  userDataDir: string;
  headless: boolean;
  startedAt: string;
}

export function readBrowserState(file: string): BrowserState | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as BrowserState;
    if (typeof v.pid === 'number' && typeof v.port === 'number' && typeof v.wsEndpoint === 'string') return v;
    return null;
  } catch {
    return null;
  }
}

/** Atomic write: temp file + rename. */
export function writeBrowserState(file: string, state: BrowserState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function clearBrowserState(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* absent */
  }
}
