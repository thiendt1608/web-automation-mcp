import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import type { Config } from './config.js';

/** Logs go to stderr (+ file). NEVER stdout: stdio MCP uses it for JSON-RPC. */
export function createLogger(cfg: Pick<Config, 'home' | 'logLevel'>, opts: { file?: boolean } = {}): Logger {
  const redact = {
    paths: ['*.cookie', '*.cookies', '*.authorization', '*.token', '*.password', 'cookie', 'authorization', 'token', 'password'],
    censor: '[redacted]',
  };
  const streams: pino.StreamEntry[] = [{ stream: pino.destination({ dest: 2, sync: true }) }];
  if (opts.file !== false) {
    const dir = path.join(cfg.home, 'logs');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    streams.push({ stream: pino.destination({ dest: path.join(dir, 'ai-web.log'), sync: true, mkdir: true }) });
  }
  return pino({ level: cfg.logLevel, redact, base: { pid: process.pid } }, pino.multistream(streams));
}

export type { Logger };
