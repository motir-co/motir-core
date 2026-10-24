import type { Page, Request } from '@playwright/test';
import { WORKBENCH_STREAM_PATH } from '@/lib/live/sources/workbenchStreamSource';

// THE NETWORK LOG A LIVE-PUSH SPEC READS (Story MOTIR-8542 · Subtask MOTIR-8734).
//
// Every claim the story makes to a browser is a claim about the network panel:
// how many `text/event-stream` connections a tab holds, which requests repeat,
// which never leave, and whether the page was ever loaded or refreshed again.
// This records every request the page makes from the moment it is attached, so
// a spec reads as steps (`log.mark()`, act, `log.since(mark)`) rather than as
// listener plumbing.
//
// ⚠️ A DOCUMENT LOAD IS COUNTED BY ITS REQUEST, NOT BY `framenavigated`.
// Playwright fires `framenavigated` for Next's same-document re-render too, so a
// count of that event cannot tell a refresh from a load —
// `regression-workbench-live.spec.ts` measured exactly that on its first green
// walk. A request whose `resourceType()` is `document` is a new document, and
// the window marker (`stampDocument`) is the second, independent witness.
//
// ⚠️ AN RSC REFRESH is an RSC GET of the page's OWN path (the `RSC: 1` header or
// an `_rsc` query) that is NOT a prefetch: Next prefetches the links in view with
// `next-router-prefetch: 1`, and a prefetch reads another view, it re-renders
// nothing (`authoritative-signal.ts`'s `pageRefresh` names the same request).

export interface LoggedRequest {
  /** Order of arrival — what `mark()` answers and `since()` reads from. */
  seq: number;
  request: Request;
  url: URL;
  method: string;
  resourceType: string;
  /** An RSC GET of some route (refresh or prefetch). */
  rsc: boolean;
  /** Next's link prefetch — a one-off read of ANOTHER view, never a refresh. */
  prefetch: boolean;
  /** The response's `content-type`, once headers arrived. */
  contentType: string | null;
  /** When the request finished or failed (an aborted stream fails). */
  ended: 'finished' | 'failed' | null;
}

export interface LiveNetworkLog {
  /** Every request so far, in order. */
  readonly all: readonly LoggedRequest[];
  /** A position in the log, for `since`. */
  mark(): number;
  /** The requests made after `mark`. */
  since(mark: number): LoggedRequest[];
  /** The Workbench stream's requests, after `mark` (every one, open or ended). */
  streams(mark?: number): LoggedRequest[];
  /** The stream requests that answered `text/event-stream`, after `mark`. */
  eventStreams(mark?: number): LoggedRequest[];
  /** Stream connections open right now — answered, and neither finished nor failed. */
  openStreams(): LoggedRequest[];
  /** The most connections that were ever open at once. */
  readonly maxOpenStreams: number;
  /** New documents loaded after `mark`. */
  documentLoads(mark: number): LoggedRequest[];
  /** RSC refreshes of `pathname` after `mark` (prefetches excluded). */
  rscRefreshes(pathname: string, mark: number): LoggedRequest[];
  /** `GET`s of `/api/plans/<id>` (either read — full or `?since=`), after `mark`. */
  planReads(planId: string, mark?: number): LoggedRequest[];
  /** Request keys (`METHOD path?query`) seen MORE THAN ONCE after `mark`, the stream excluded. */
  repeated(mark: number): string[];
  detach(): void;
}

const isStreamUrl = (url: URL) => url.pathname === WORKBENCH_STREAM_PATH;

export function attachLiveNetworkLog(page: Page): LiveNetworkLog {
  const all: LoggedRequest[] = [];
  const byRequest = new Map<Request, LoggedRequest>();
  let maxOpenStreams = 0;

  const openStreams = () =>
    all.filter((r) => isStreamUrl(r.url) && r.contentType !== null && r.ended === null);

  const onRequest = (request: Request) => {
    const headers = request.headers();
    const url = new URL(request.url());
    const entry: LoggedRequest = {
      seq: all.length,
      request,
      url,
      method: request.method(),
      resourceType: request.resourceType(),
      rsc: headers['rsc'] === '1' || url.searchParams.has('_rsc'),
      prefetch: headers['next-router-prefetch'] !== undefined,
      contentType: null,
      ended: null,
    };
    all.push(entry);
    byRequest.set(request, entry);
  };
  const onResponse = (response: import('@playwright/test').Response) => {
    const entry = byRequest.get(response.request());
    if (!entry) return;
    entry.contentType = response.headers()['content-type'] ?? '';
    maxOpenStreams = Math.max(maxOpenStreams, openStreams().length);
  };
  const end = (state: 'finished' | 'failed') => (request: Request) => {
    const entry = byRequest.get(request);
    if (entry) entry.ended = state;
  };
  const onFinished = end('finished');
  const onFailed = end('failed');

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);

  const since = (mark: number) => all.slice(mark);
  const streams = (mark = 0) => since(mark).filter((r) => isStreamUrl(r.url));

  return {
    all,
    mark: () => all.length,
    since,
    streams,
    eventStreams: (mark = 0) =>
      streams(mark).filter((r) => (r.contentType ?? '').startsWith('text/event-stream')),
    openStreams,
    get maxOpenStreams() {
      return maxOpenStreams;
    },
    documentLoads: (mark) => since(mark).filter((r) => r.resourceType === 'document'),
    rscRefreshes: (pathname, mark) =>
      since(mark).filter((r) => r.rsc && !r.prefetch && r.url.pathname === pathname),
    planReads: (planId, mark = 0) =>
      since(mark).filter(
        (r) => r.method === 'GET' && r.url.pathname === `/api/plans/${encodeURIComponent(planId)}`,
      ),
    repeated: (mark) => {
      const seen = new Map<string, number>();
      for (const r of since(mark)) {
        if (isStreamUrl(r.url)) continue;
        const key = `${r.method} ${r.url.pathname}${r.url.search}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      return [...seen].filter(([, n]) => n > 1).map(([key]) => key);
    },
    detach() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
    },
  };
}

// ── the document's own witnesses ────────────────────────────────────────────

/** Stamp the window once; a reload or a new document loses it, a refresh does not. */
export async function setLoadMarker(page: Page, value: string): Promise<void> {
  await page.evaluate((v) => {
    (window as unknown as Record<string, unknown>)['__e2eLoadMarker'] = v;
  }, value);
}

export function loadMarker(page: Page): Promise<unknown> {
  return page.evaluate(
    () => (window as unknown as Record<string, unknown>)['__e2eLoadMarker'] ?? null,
  );
}

/**
 * Remember, inside the page, whether the *Reconnecting…* chip was EVER in the
 * DOM from now on — a MutationObserver sees a chip that came and went between
 * two of the spec's own reads, which a `toBeHidden()` at the end cannot.
 */
export async function watchForReconnecting(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const seen = () => document.querySelector('[data-testid="workbench-reconnecting"]') !== null;
    w['__e2eSawReconnecting'] = seen();
    new MutationObserver(() => {
      if (seen()) w['__e2eSawReconnecting'] = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
}

export function sawReconnecting(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as Record<string, unknown>)['__e2eSawReconnecting'] === true,
  );
}

/**
 * ⚠️ THE VISIBILITY STUB. Playwright cannot background a tab: a page stays
 * `visible` however the browser is driven. So the spec overrides
 * `document.visibilityState` (and `document.hidden`) on the document and
 * dispatches a real `visibilitychange` — the product's own listener runs, reads
 * the overridden state, and does exactly what it does in a backgrounded tab.
 */
export async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}
