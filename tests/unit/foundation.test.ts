import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { assertValidProfileName, loadConfig, paths } from '../../src/core/config.js';
import { AIWebError, toErrorPayload } from '../../src/core/errors.js';

describe('errors', () => {
  it('maps code to retryable and never leaks stack', () => {
    const p = toErrorPayload(new AIWebError('SESSION_BUSY', 'busy', { active_job_id: 'j1' }));
    expect(p).toEqual({ code: 'SESSION_BUSY', message: 'busy', retryable: true, details: { active_job_id: 'j1' } });
    expect(JSON.stringify(toErrorPayload(new Error('x')))).not.toContain('at ');
  });
  it('wraps unknown + AbortError', () => {
    expect(toErrorPayload(new Error('boom')).code).toBe('INTERNAL');
    const a = new Error('a');
    a.name = 'AbortError';
    expect(toErrorPayload(a).code).toBe('ABORTED');
  });
});

describe('config', () => {
  it('defaults and overrides', () => {
    const c = loadConfig({ AI_WEB_HOME: '/tmp/x', AI_WEB_SEND_INTERVAL_MS: '100' });
    expect(c.home).toBe('/tmp/x');
    expect(c.sendIntervalMs).toBe(100);
    expect(c.headless).toBe(false);
  });
  it('rejects bad numbers', () => {
    expect(() => loadConfig({ AI_WEB_SEND_INTERVAL_MS: '-1' })).toThrow();
    expect(() => loadConfig({ AI_WEB_SEND_INTERVAL_MS: 'abc' })).toThrow();
  });
  it('rejects path traversal in profile names', () => {
    for (const bad of ['../x', 'a/b', '', 'A', '-a']) expect(() => assertValidProfileName(bad)).toThrow();
    expect(paths(loadConfig({ AI_WEB_HOME: '/tmp/x' }), 'chatgpt').userDataDir).toBe('/tmp/x/profiles/chatgpt');
  });
});

describe('logger', () => {
  it('writes to stderr only, nothing on stdout, redacts secrets', () => {
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', `
        import { createLogger } from './src/core/logger.ts';
        const l = createLogger({ home: process.env.AI_WEB_HOME, logLevel: 'info' }, { file: false });
        l.info({ cookie: 'SECRET' }, 'hello');
      `, '--input-type=module'],
      { encoding: 'utf8', env: { ...process.env, AI_WEB_HOME: '/tmp/ai-web-logtest' } },
    );
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('hello');
    expect(r.stderr).not.toContain('SECRET');
  });
});
