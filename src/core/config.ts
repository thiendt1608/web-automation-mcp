import os from 'node:os';
import path from 'node:path';

export interface Config {
  home: string;
  headless: boolean;
  chromePath?: string;
  /** Min ms between message submits per provider. */
  sendIntervalMs: number;
  /** Min ms between page interactions. */
  interactionIntervalMs: number;
  responseTimeoutMs: number;
  lockTimeoutMs: number;
  breakerCooldownMs: number;
  logLevel: string;
  logContent: boolean;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const v = env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number, got "${v}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg: Config = {
    home: path.resolve(env.AI_WEB_HOME || path.join(os.homedir(), '.ai-web')),
    headless: env.AI_WEB_HEADLESS === '1' || env.AI_WEB_HEADLESS === 'true',
    sendIntervalMs: num(env, 'AI_WEB_SEND_INTERVAL_MS', 5000),
    interactionIntervalMs: num(env, 'AI_WEB_INTERACTION_INTERVAL_MS', 1000),
    responseTimeoutMs: num(env, 'AI_WEB_RESPONSE_TIMEOUT_MS', 15 * 60_000),
    lockTimeoutMs: num(env, 'AI_WEB_LOCK_TIMEOUT_MS', 5000),
    breakerCooldownMs: num(env, 'AI_WEB_BREAKER_COOLDOWN_MS', 5 * 60_000),
    logLevel: env.AI_WEB_LOG_LEVEL || 'info',
    logContent: env.AI_WEB_LOG_CONTENT === '1',
  };
  if (env.AI_WEB_CHROME) cfg.chromePath = env.AI_WEB_CHROME;
  return cfg;
}

const PROVIDER_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function assertValidProfileName(name: string): void {
  if (!PROVIDER_RE.test(name)) throw new Error(`Invalid profile/provider name "${name}"`);
}

export function paths(cfg: Config, profile: string) {
  assertValidProfileName(profile);
  return {
    userDataDir: path.join(cfg.home, 'profiles', profile),
    state: path.join(cfg.home, 'state', `${profile}.json`),
    lock: path.join(cfg.home, 'locks', `${profile}.lock`),
    breaker: path.join(cfg.home, 'breaker', `${profile}.json`),
    jobsDir: path.join(cfg.home, 'jobs'),
    logsDir: path.join(cfg.home, 'logs'),
  };
}
