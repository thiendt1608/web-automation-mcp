import { AIWebError } from './errors.js';

/** Sleep that rejects with ABORTED if the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(new AIWebError('ABORTED', 'Aborted.'));
    return promise;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(new AIWebError('ABORTED', 'Aborted.'));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
  return promise;
}
