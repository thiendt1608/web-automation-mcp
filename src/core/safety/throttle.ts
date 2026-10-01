import { sleep } from '../util.js';

/** Enforces a minimum gap between successive `wait()` completions. */
export class Throttle {
  #last = 0;
  #chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly delay: (ms: number, s?: AbortSignal) => Promise<void> = sleep,
  ) {}

  /** Calls are serialized so concurrent callers each get their own gap. */
  wait(signal?: AbortSignal): Promise<void> {
    const run = this.#chain.then(async () => {
      const gap = this.#last + this.minIntervalMs - this.now();
      if (gap > 0) await this.delay(gap, signal);
      this.#last = this.now();
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }
}
