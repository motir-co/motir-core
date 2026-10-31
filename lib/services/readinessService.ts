import type { ReadinessDTO } from '@/lib/dto/readiness';
import { databaseConnectionRepository } from '@/lib/repositories/databaseConnectionRepository';

// IS THIS PROCESS WARM ENOUGH TO BE SENT TRAFFIC? (Bug MOTIR-8231)
//
// A freshly deployed `app` machine used to take requests the moment its port
// opened. At that point the Next server has loaded no route module and the
// `pg.Pool` behind `@/lib/db` has opened no connection (it is lazy), so the first
// burst — usually GitHub webhooks, which keep arriving through a rollout — paid
// for both at once. The P2028 that filed this card fired at UPTIME 15 s, with the
// event loop blocked for 1285 ms and the busiest pool at 9 connections, none idle
// and nobody waiting: the 2 s `maxWait` ran out while connections were still
// being ESTABLISHED. The pool was not starved (MOTIR-6788's fix was in the
// stack); it was cold.
//
// So `fly.toml` declares an `[[http_service.checks]]` against this service's
// route, and Fly's proxy routes nothing to a machine whose check has not passed.
// The check answers 503 until one warm-up has finished:
//   1. load the webhook route's service graph, the hottest path during a deploy;
//   2. run `WARM_CONNECTIONS` `SELECT 1`s CONCURRENTLY, so the pool has to open
//      that many connections rather than reuse one;
//   3. confirm the pool now holds at least that many OPEN (`totalCount`);
//   4. render `/health/warm-up` over loopback, which warms the PAGE runtime
//      (Bug MOTIR-10142, below).
//
// ⚠️ THE STATE IS PER MODULE INSTANCE, AND THAT IS WHAT MAKES IT TRUE. The Next
// server evaluates `lib/db.ts` once per Turbopack runtime (MOTIR-7073), and this
// module once per runtime too. The check is a ROUTE HANDLER, so it warms the
// route-handler runtime's pool — the one `POST /api/github/webhook` transacts on
// — and reports that pool, not the page runtime's.
//
// ⚠️ THE PAGE RUNTIME IS WARMED BY A REQUEST, BECAUSE NOTHING ELSE RUNS THERE
// (Bug MOTIR-10142). Next evaluates a page's server components and the client
// components it server-renders in registries of their own, and only when a
// request reaches them — its start-up preload loads the route entries without
// evaluating the pages under them. So the `import` above never reached the page
// runtime, and a rehearsal web task froze its loop for 2231 ms five minutes into
// serving, on the first request that opened a page: the page's server graph and
// its editor's, each with its own Yjs (the minute Yjs logged "already imported").
// Step 4 makes a request of our own do that before the load balancer sends any:
// `app/health/warm-up/page.tsx` imports exactly those two graphs. It goes to
// loopback on `PORT` — the port the standalone server listens on, `0.0.0.0` in
// the Dockerfile — never to the address in the check's own request, whose Host
// header a caller chooses.
//
// ⚠️ STEP 4 IS BEST-EFFORT, NOT A CONDITION OF READINESS. A cold page costs a
// slow first request; a process that never answers 200 costs the deploy. So a
// warm-up page that cannot be reached, or answers an error, is logged and the
// process goes ready on the first three steps — exactly as it did before.
//
// ⚠️ IT NEVER WAITS ON THE WARM-UP. The first check starts it and answers 503 at
// once; a later check, after it finished, answers 200. Fly retries on its
// interval, so nothing is lost by not blocking, and a check that answered only
// when the warm-up happened to finish inside its timeout would be measuring the
// timeout.
//
// ⚠️ ONCE READY, IT STAYS READY. `pg.Pool` closes a connection idle for 10 s, so
// the open count falls again on a quiet machine. Re-checking it would pull a
// healthy machine out of rotation every time its traffic paused, which is the
// outage this card exists to prevent rather than the one it fixes. The warm-up
// is for the moment a process starts, and nothing about it changes a pool size
// or a transaction budget.

/** How many connections the warm-up opens before the process is declared ready. */
export const WARM_CONNECTIONS = 5;

/** The page the warm-up renders to warm the page runtime (MOTIR-10142). */
export const PAGE_WARM_UP_PATH = '/health/warm-up';

/** How long the page warm-up may take before readiness stops waiting for it. */
export const PAGE_WARM_UP_TIMEOUT_MS = 30_000;

let ready = false;
let warming: Promise<void> | null = null;

async function warmUp(): Promise<void> {
  // The webhook route's whole service graph, evaluated into this runtime's module
  // cache now rather than inside the first delivery.
  await import('@/lib/services/githubWebhookService');
  await Promise.all(
    Array.from({ length: WARM_CONNECTIONS }, () => databaseConnectionRepository.ping()),
  );
  const open = databaseConnectionRepository.openConnections();
  // A null count is a client planted on `globalThis` (a bench script): its pool
  // is not ours to read, and the round trips above are all the warm-up can do.
  if (open !== null && open < WARM_CONNECTIONS) return;
  await warmPageRuntime();
  ready = true;
}

/** Render the warm-up page over loopback; a failure is logged, never thrown. */
async function warmPageRuntime(): Promise<void> {
  const url = `http://127.0.0.1:${process.env['PORT'] || '3000'}${PAGE_WARM_UP_PATH}`;
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(PAGE_WARM_UP_TIMEOUT_MS),
    });
    // Read to the end: the render is not finished until the stream is.
    await res.arrayBuffer();
    if (!res.ok) console.warn(`[readiness] ${url} answered ${res.status}; pages stay cold`);
  } catch (err: unknown) {
    console.warn(`[readiness] ${url} could not be rendered; pages stay cold`, err);
  }
}

function snapshot(state: ReadinessDTO['state']): ReadinessDTO {
  return {
    state,
    openConnections: databaseConnectionRepository.openConnections(),
    warmConnections: WARM_CONNECTIONS,
  };
}

export const readinessService = {
  /**
   * Whether this process is ready for traffic. Starts the warm-up on the first
   * call (and again after a failed one), and never awaits it.
   */
  check(): ReadinessDTO {
    if (ready) return snapshot('ready');
    if (!warming) {
      warming = warmUp()
        .catch((err: unknown) => {
          // Logged rather than thrown: nobody awaits this promise, and the next
          // check starts a fresh attempt. An unreachable database keeps the
          // machine out of rotation, which is the right answer for it.
          console.error('[readiness] warm-up failed; the next check retries', err);
        })
        .finally(() => {
          warming = null;
        });
    }
    return snapshot('warming');
  },
};
