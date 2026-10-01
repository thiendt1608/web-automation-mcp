import type { Page } from 'playwright-core';
import { AIWebError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Throttle } from '../safety/throttle.js';
import { sleep } from '../util.js';

export interface InteractionOptions {
  /** Per-action timeout. */
  timeoutMs: number;
  signal?: AbortSignal;
  throttle?: Throttle;
  log?: Logger;
  /** Label for logs (provider id). */
  provider?: string;
}

/**
 * Uniform timeout / abort / throttle / logging around Playwright page actions.
 * Playwright has no AbortSignal support, so we race the action against abort.
 */
export class Interaction {
  constructor(
    readonly page: Page,
    private readonly opts: InteractionOptions,
  ) {}

  async #run<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const { signal, throttle, log, provider } = this.opts;
    if (signal?.aborted) throw new AIWebError('ABORTED', `Aborted before ${op}.`);
    // Listener must exist before any await, or an abort during throttling is missed.
    const aborted = Promise.withResolvers<never>();
    aborted.promise.catch(() => undefined);
    const onAbort = () => aborted.reject(new AIWebError('ABORTED', `Aborted during ${op}.`));
    signal?.addEventListener('abort', onAbort, { once: true });
    const t0 = Date.now();
    try {
      await Promise.race([throttle?.wait(signal), aborted.promise]);
      if (signal?.aborted) throw new AIWebError('ABORTED', `Aborted before ${op}.`);
      const out = await Promise.race([fn(), aborted.promise]);
      log?.debug({ provider, operation: op, status: 'ok', duration_ms: Date.now() - t0 });
      return out;
    } catch (e) {
      const code = e instanceof AIWebError ? e.code : (e as Error).name;
      log?.debug({ provider, operation: op, status: 'error', duration_ms: Date.now() - t0, error_code: code });
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  goto(url: string) {
    return this.#run('goto', () => this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.opts.timeoutMs }));
  }

  click(selector: string) {
    return this.#run('click', () => this.page.locator(selector).first().click({ timeout: this.opts.timeoutMs }));
  }

  fill(selector: string, text: string) {
    return this.#run('fill', () => this.page.locator(selector).first().fill(text, { timeout: this.opts.timeoutMs }));
  }

  /** Focus then insert text in one input event: right choice for long prompts (no per-key typing). */
  insertText(selector: string, text: string) {
    return this.#run('insertText', async () => {
      await this.page.locator(selector).first().focus({ timeout: this.opts.timeoutMs });
      await this.page.keyboard.insertText(text);
    });
  }

  press(key: string) {
    return this.#run('press', () => this.page.keyboard.press(key));
  }

  waitFor(selector: string, state: 'visible' | 'hidden' | 'attached' | 'detached' = 'visible', timeoutMs?: number) {
    return this.#run('waitFor', () =>
      this.page.locator(selector).first().waitFor({ state, timeout: timeoutMs ?? this.opts.timeoutMs }),
    );
  }

  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
    return this.#run('evaluate', () => this.page.evaluate(fn as (a: unknown) => R | Promise<R>, arg as unknown));
  }

  screenshot(path: string) {
    return this.#run('screenshot', () => this.page.screenshot({ path, fullPage: false, timeout: this.opts.timeoutMs }));
  }
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  signal?: AbortSignal;
  /** Return false for errors that must not be retried. */
  shouldRetry?: (e: unknown) => boolean;
}

/**
 * Bounded exponential-backoff retry. ONLY for idempotent, pre-submit steps
 * (locating composer, focusing). NEVER wrap a submit.
 */
export async function retryIdempotent<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  let last: unknown;
  for (let i = 0; i < o.attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e instanceof AIWebError && e.code === 'ABORTED') throw e;
      if (o.shouldRetry && !o.shouldRetry(e)) throw e;
      if (i < o.attempts - 1) await sleep(o.baseDelayMs * 2 ** i, o.signal);
    }
  }
  throw last;
}
