import type { Page, Request } from '@playwright/test';

// WHAT A PAGE RE-FETCHED UNDER A READER, COUNTED FROM THE NETWORK LOG
// (Story MOTIR-8539 · Subtask MOTIR-8571).
//
// The story's claim is that another actor's write never refreshes the page a
// reader is on. Component state cannot carry that claim: a refresh that lands
// and re-renders the same bytes looks, from inside React, exactly like nothing
// happening. So the counts here come from the BROWSER — the requests the page
// sent and the documents it loaded — and the only thing read from inside the
// page is the stream's own frames, tee'd off the response the app is reading.
//
// Three numbers, each with one meaning:
//
//   · RSC REFETCHES OF THE CURRENT PATH. A `router.refresh()` (and the shell's
//     coordinated one, which calls it) is a GET of the current URL carrying
//     `RSC: 1` (or an `_rsc=` cache-buster). A PREFETCH also carries `RSC: 1`,
//     and it is not a refresh, so `Next-Router-Prefetch` excludes it. A server
//     ACTION is a POST, and it is the reader's own press, so GET only.
//   · DOCUMENT LOADS. A request of resource type `document` on the main frame.
//     ⚠️ NOT `framenavigated`, which Playwright also fires for Next's
//     client-side re-render: MOTIR-5245's spec counted one "navigation" for the
//     very refresh its story caused (`regression-workbench-live.spec.ts`,
//     `stampDocument`). A `document` request is a load and nothing else.
//   · STREAM NUDGES. `/api/workbench/stream` frames that name at least one moved
//     tab — the frames `useWorkbenchLiveStream` turns into a nudge. A frame
//     with `moved: []` primes the cursor and is not counted, matching the hook.
//
// ⚠️ INSTALL BEFORE THE FIRST `goto`. The frame counter is an init script that
// wraps `fetch` for the stream's address only, so it has to be in the page
// before the app's own code asks for the stream. Every other request passes
// through untouched.

/** The counters' window key — one name, so the init script and the reads agree. */
const WINDOW_KEY = '__refreshCounter';

export interface StreamFrameMark {
  /** `Date.now()` in the page when the frame was parsed. */
  at: number;
  /** The tabs the frame named. */
  moved: string[];
}

export interface RefreshCounts {
  /** GET requests for the current path carrying `RSC: 1` / `_rsc=`, prefetches excluded. */
  rscRefetches: number;
  /** Main-frame requests of resource type `document`. */
  documentLoads: number;
  /** Stream frames naming at least one moved tab. */
  streamNudges: number;
}

export interface RefreshCounter {
  /** Zero every count — call once the page has settled, before the burst. */
  reset(): Promise<void>;
  /** The counts since the last `reset()`. */
  read(): Promise<RefreshCounts>;
  /** The counted stream frames since the last `reset()`, oldest first. */
  frames(): Promise<StreamFrameMark[]>;
  /** RSC refetches counted and not yet finished (or failed). */
  inFlight(): number;
}

function isRscGet(request: Request): boolean {
  if (request.method() !== 'GET') return false;
  const headers = request.headers();
  if (headers['next-router-prefetch']) return false;
  return headers['rsc'] === '1' || new URL(request.url()).searchParams.has('_rsc');
}

/**
 * Install the counter on `page`. Returns the reader; nothing is counted until
 * the page starts making requests, and {@link RefreshCounter.reset} zeroes it.
 */
export async function installRefreshCounter(page: Page): Promise<RefreshCounter> {
  await page.addInitScript((key: string) => {
    const state = { frames: [] as { at: number; moved: string[] }[] };
    (window as unknown as Record<string, unknown>)[key] = state;
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('/api/workbench/stream') || !response.body) return response;
      // Tee the stream: the app reads one branch exactly as it would have, and
      // this reads the other. Nothing the app sees changes.
      const [forApp, forCounter] = response.body.tee();
      void (async () => {
        const reader = forCounter.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            return;
          }
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          let cut = buffer.indexOf('\n\n');
          while (cut !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('\n');
            if (data) {
              try {
                const frame = JSON.parse(data) as { moved?: unknown };
                const moved = Array.isArray(frame.moved)
                  ? frame.moved.filter((m): m is string => typeof m === 'string')
                  : [];
                if (moved.length > 0) state.frames.push({ at: Date.now(), moved });
              } catch {
                // Not a JSON frame — not one the hook would count either.
              }
            }
            cut = buffer.indexOf('\n\n');
          }
        }
      })();
      return new Response(forApp, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  }, WINDOW_KEY);

  let rscRefetches = 0;
  let documentLoads = 0;
  const open = new Set<Request>();

  page.on('request', (request) => {
    if (request.frame() !== page.mainFrame()) return;
    if (request.resourceType() === 'document') {
      documentLoads += 1;
      return;
    }
    if (!isRscGet(request)) return;
    // Scoped to the page the reader is ON: a refresh is a re-fetch of the
    // current path, and a fetch of any other path is a navigation somebody made.
    const current = new URL(page.url()).pathname;
    if (new URL(request.url()).pathname !== current) return;
    rscRefetches += 1;
    open.add(request);
  });
  const settle = (request: Request): void => {
    open.delete(request);
  };
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);

  const frames = async (): Promise<StreamFrameMark[]> =>
    page.evaluate((key: string) => {
      const state = (
        window as unknown as Record<string, { frames: StreamFrameMark[] } | undefined>
      )[key];
      return state ? [...state.frames] : [];
    }, WINDOW_KEY);

  return {
    async reset() {
      rscRefetches = 0;
      documentLoads = 0;
      open.clear();
      await page.evaluate((key: string) => {
        const state = (window as unknown as Record<string, { frames: unknown[] } | undefined>)[key];
        if (state) state.frames.length = 0;
      }, WINDOW_KEY);
    },
    async read() {
      return { rscRefetches, documentLoads, streamNudges: (await frames()).length };
    },
    frames,
    inFlight() {
      return open.size;
    },
  };
}

/** One row of the printed table. */
export interface RefreshCountRow extends RefreshCounts {
  case: string;
  writes: number;
}

/** The table every spec using this counter prints, so the rows read the same. */
export function formatRefreshTable(rows: readonly RefreshCountRow[]): string {
  const header = ['case', 'writes', 'stream nudges', 'RSC refetches', 'document loads'];
  const body = rows.map((r) => [
    r.case,
    String(r.writes),
    String(r.streamNudges),
    String(r.rscRefetches),
    String(r.documentLoads),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`;
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}
