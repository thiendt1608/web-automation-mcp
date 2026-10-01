import type { Browser, BrowserContext, Page } from 'playwright-core';
import { AIWebError } from '../errors.js';

/** Chrome's default context holds the persistent profile's cookies. */
export function defaultContext(browser: Browser): BrowserContext {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new AIWebError('BROWSER_CONNECT_FAILED', 'Chrome exposes no default browser context.');
  return ctx;
}

export function findPage(browser: Browser, origin: string): Page | null {
  return (
    defaultContext(browser)
      .pages()
      .find((p) => !p.isClosed() && new URL(p.url(), 'about:blank').origin === origin) ?? null
  );
}

/**
 * Reuse a tab on `origin` if one exists, else reuse a blank tab, else open a new one.
 * Navigates to `url` only when the tab is not already on the origin.
 */
export async function getOrCreatePage(browser: Browser, url: string, timeoutMs = 30_000): Promise<Page> {
  const origin = new URL(url).origin;
  const existing = findPage(browser, origin);
  if (existing) return existing;

  const ctx = defaultContext(browser);
  const blank = ctx.pages().find((p) => !p.isClosed() && p.url() === 'about:blank');
  const page = blank ?? (await ctx.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  return page;
}

export async function closePage(page: Page): Promise<void> {
  if (!page.isClosed()) await page.close();
}
