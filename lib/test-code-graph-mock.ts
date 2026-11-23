import { isE2EProdHarness } from '@/lib/e2eProdHarness';
import type { MockAgent } from 'undici';

// Node-only INDEX-WRITER boundary mock for E2E (Story MOTIR-3417 · MOTIR-3564).
//
// The index writer path crossed two boundaries in the lane: motir-ai's
// run-credential mint for an index container, and the repo TARBALL resolve. The
// container fleet and its mint left with MOTIR-12036; the tarball resolve stays:
//
//   2. `resolveRepoTarballUrl` → an installation token minted from the App JWT
//      (`POST api.github.com/app/installations/{id}/access_tokens`), then
//      `GET api.github.com/repos/{owner}/{name}/tarball/{ref}` read for its
//      302 `Location` — `redirect: 'manual'`, the body never touched — the
//      pre-signed source URL the handoff hands to motir-codegraph.
//
// SINCE MOTIR-11883 THE TWO JOBS HAND THE INDEX OFF (story MOTIR-11022), and
// `runIndexHandoffSteps` crosses three more boundaries, stubbed here:
//
//   3. `resolveRef` → `GET api.github.com/repos/{owner}/{name}/commits/{ref}`, the
//      live head — answered with {@link e2eHeadSha}, a fixed 40-hex per repository;
//   4. `handOffCodeGraphIndex` → `POST {MOTIR_AI_URL}/v1/code-graph/index-handoff`,
//      answered `202 { jobId }` and remembered per repository;
//   5. `readCodeGraphIndexStatus` → `GET {MOTIR_AI_URL}/v1/code-graph/index-status`,
//      answered "running" for {@link E2E_INDEX_PUBLISH_DELAY_MS} after a handoff and
//      "published at the head" after it — so a run defers at least once, which is
//      what gives a mid-run worker kill a window to land in. A worker restarted
//      inside that window forgets the handoff and answers "published", which is
//      the answer the restarted run needs.
//
// `tests/helpers/indexHandoff.ts`'s `stubIndexHandoff()` does this IN-PROCESS for the
// vitest suites. A Playwright server is a separately-spawned process, so an
// in-process stub cannot reach it — which is exactly why every other external
// boundary in this lane has a `lib/test-*-mock.ts`. This is that file for this
// boundary, in the same shape as `test-code-health-mock` / `test-billing-mock`.
//
// ===========================================================================
// ⚠️ WHERE THIS IS INSTALLED, AND WHY IT IS NOT THE APP SERVER
// ===========================================================================
// MOTIR-3564's own body said to set the credentials "on the app webServer, and —
// this is the half a reader will miss — on the WORKER process too". **It is the
// mirror image of that, and the correction is load-bearing rather than
// pedantic.**
//
// The supervisor is a JOB. It runs in the worker, which is the only process that
// resolves a tarball URL or hands an index off; the app server's whole part
// in a refresh is the webhook writing a `job_queue` row, which crosses neither
// boundary. And putting `MOTIR_AI_URL` + `MOTIR_AI_SERVICE_TOKEN` on the app
// server would not be merely redundant — `lib/ai/availability.ts` reads exactly
// that pair, process-wide, to decide whether the AI layer is configured. Setting
// them would flip the whole lane CLOUD-ON, and four specs
// (`ai-callout-gate`, `cloud-orb-clearance`, `cloud-board-load`,
// `top-bar-budget`) assert the OFF state against this server.
//
// So the lane wires this seam on the WORKER, in
// `tests/e2e/_helpers/job-worker-process.ts`. The `instrumentation.ts` entry
// exists so the flag table stays the one place a reader finds every seam, and so
// a later server-side caller has a door — it is simply not what this lane turns
// on. `scripts/worker.ts` installs it for the worker, because the worker is a
// plain Node bundle and `instrumentation.ts` is a Next.js hook that never runs
// there.
//
// ===========================================================================
// ⚠️ REFUSED OUTSIDE THE HARNESS
// ===========================================================================
// Stricter than its siblings, deliberately: this one is installed from
// `scripts/worker.ts`, which is SHIPPED CODE that runs in production. The flag
// alone is not enough of a gate for that, so the installer also requires
// `E2E_PROD_HARNESS=1` — the flag `playwright.config.ts` sets and no real
// deployment ever does. Both doors call this function, so both inherit it.

/** What the mock served, in order — so a test can assert what was and was not called. */
export interface CodeGraphMockJournalEntry {
  readonly method: string;
  readonly path: string;
}

let journal: CodeGraphMockJournalEntry[] = [];

/** Everything this mock answered since the last reset. */
export function codeGraphMockJournal(): readonly CodeGraphMockJournalEntry[] {
  return journal;
}

/** Per-test reset. */
export function resetCodeGraphMockJournal(): void {
  journal = [];
  handed.clear();
}

function record(method: string, path: string): void {
  journal.push({ method, path: path.split('?')[0] ?? path });
}

/**
 * ⚠️ THE BYTE TRAP, ported across the process boundary.
 *
 * `tests/helpers/indexFleet.ts` keeps a flag that goes true if anything reads the
 * tarball RESPONSE BODY — the §2 OOM, inverted. The equivalent here is stronger
 * and simpler: the writer must never reach `codeload.github.com` AT ALL, because
 * the pre-signed URL is handed to a container and downloaded there. So the
 * download host gets an intercept that FAILS, and any hit is journalled. If a
 * future edit reintroduces the buffering path, the run fails loudly with a
 * recorded reason instead of quietly transferring several hundred megabytes
 * inside the test process.
 */
export const CODELOAD_ORIGIN = 'https://codeload.github.com';

/** The `Location` the tarball redirect hands back — what must reach the container spec. */
export function e2eTarballUrl(owner: string, name: string, ref: string): string {
  return `${CODELOAD_ORIGIN}/${owner}/${name}/legacy.tar.gz/${ref}?token=E2E_PRESIGNED`;
}

/**
 * The live head GitHub answers for a repository: 40 lowercase hex derived from its
 * `owner/name`, so the spec process can compute the commit the worker handed off.
 */
export function e2eHeadSha(owner: string, name: string): string {
  let hash = 0x811c9dc5;
  for (const ch of `${owner}/${name}`.toLowerCase()) {
    hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').repeat(5);
}

/** How long a handed-off commit reads "running" before it reads published. */
export const E2E_INDEX_PUBLISH_DELAY_MS = 2_000;

/** The last handoff per `repoRef`, in this process. */
const handed = new Map<string, { commit: string; at: number; jobId: string; kind: string }>();

const json = { headers: { 'content-type': 'application/json' } } as const;

/** True when this process is allowed to install the seam at all. */
export function codeGraphMockEnabled(): boolean {
  return process.env['E2E_TEST_CODE_GRAPH'] === '1' && isE2EProdHarness();
}

export function installCodeGraphBoundaryMock(agent: MockAgent): void {
  // Refused outside the harness — see the header. Returning rather than throwing
  // matches the siblings: a process that is not the test lane simply has no seam.
  if (!codeGraphMockEnabled()) return;

  const aiOrigin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (aiOrigin) {
    // 4. THE HANDOFF (MOTIR-11883). The body carries the pre-signed source URL, a
    // bearer secret: it is read for the commit and kind and never journalled.
    agent
      .get(aiOrigin)
      .intercept({ path: '/v1/code-graph/index-handoff', method: 'POST' })
      .reply((opts) => {
        record('POST', '/v1/code-graph/index-handoff');
        const body = parseBody(opts.body);
        const jobId = `e2e-index-job-${String(handed.size + 1)}-${String(Date.now())}`;
        handed.set(String(body['repoRef']), {
          commit: String(body['commitSha']),
          at: Date.now(),
          jobId,
          kind: String(body['kind']),
        });
        return { statusCode: 202, data: { jobId }, responseOptions: json };
      })
      .persist();

    // 5. THE STATUS: running for a moment after a handoff, then published at the head.
    agent
      .get(aiOrigin)
      .intercept({
        path: (p) => p.split('?')[0] === '/v1/code-graph/index-status',
        method: 'GET',
      })
      .reply((opts) => {
        record('GET', '/v1/code-graph/index-status');
        const repoRef =
          new URL(String(opts.path), 'http://status.local').searchParams.get('repoRef') ?? '';
        const [owner = '', name = ''] = repoRef.split('/');
        const last = handed.get(repoRef);
        const data: Record<string, unknown> =
          last && Date.now() - last.at < E2E_INDEX_PUBLISH_DELAY_MS
            ? {
                state: 'not_indexed',
                indexedCommit: null,
                inProgressJob: {
                  jobId: last.jobId,
                  kind: last.kind,
                  commit: last.commit,
                  ref: null,
                  state: 'running',
                  enqueuedAt: new Date(last.at).toISOString(),
                  startedAt: new Date(last.at).toISOString(),
                },
                lastFailure: null,
              }
            : {
                state: 'indexed',
                indexedCommit: {
                  commit: last?.commit ?? e2eHeadSha(owner, name),
                  publishedAt: new Date().toISOString(),
                },
                inProgressJob: null,
                lastFailure: null,
              };
        return { statusCode: 200, data, responseOptions: json };
      })
      .persist();
  }

  const github = agent.get('https://api.github.com');

  // 3. THE LIVE HEAD the handoff reads (`application/vnd.github.sha`: the bare sha).
  github
    .intercept({
      path: (p) => /^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+$/.test(p.split('?')[0] ?? p),
      method: 'GET',
    })
    .reply((req) => {
      const path = String(req.path).split('?')[0] ?? '';
      record('GET', '/repos/:owner/:name/commits/:ref');
      const m = /^\/repos\/([^/]+)\/([^/]+)\/commits\//.exec(path);
      return { statusCode: 200, data: e2eHeadSha(m?.[1] ?? '', m?.[2] ?? '') };
    })
    .persist();

  // The installation token the tarball resolve mints from the App JWT.
  //
  // ⚠️ `lib/test-github-repos-mock.ts` intercepts this same path when
  // `E2E_TEST_GITHUB_REPOS=1`. The two never collide in practice — that flag is
  // the ACCEPTANCE lane's and this one is the main lane's — and if they were ever
  // both on, the repos mock registers first (it is earlier in
  // `instrumentation.ts`'s table) and undici serves the first matching intercept,
  // so this one would lie dormant rather than fight it. Either token is fine:
  // nothing downstream verifies it, because the next hop is intercepted too.
  github
    .intercept({
      path: (p) => /^\/app\/installations\/[^/]+\/access_tokens$/.test(p),
      method: 'POST',
    })
    .reply(() => {
      record('POST', '/app/installations/:id/access_tokens');
      return {
        statusCode: 200,
        data: { token: 'ghs_e2e_index_token', expires_at: inOneHour() },
        responseOptions: json,
      };
    })
    .persist();

  // ⚠️ THE 302, AND THE BODY IS EMPTY BY CONSTRUCTION. `resolveRepoTarballUrl`
  // fetches with `redirect: 'manual'` and reads ONLY the `Location` header — a
  // 200 here would mean the host served the bytes, which the resolver treats as a
  // failure (`RepoTarballUrlNotRedirectedError`). So this answers exactly what the
  // real endpoint answers, and nothing more.
  github
    .intercept({
      path: (p) => /^\/repos\/[^/]+\/[^/]+\/tarball\/.+$/.test(p),
      method: 'GET',
    })
    .reply((req) => {
      const path = String(req.path);
      record('GET', path);
      const m = /^\/repos\/([^/]+)\/([^/]+)\/tarball\/(.+)$/.exec(path.split('?')[0] ?? path);
      const location = m
        ? e2eTarballUrl(m[1]!, m[2]!, m[3]!)
        : e2eTarballUrl('owner', 'name', 'main');
      return {
        statusCode: 302,
        data: '',
        responseOptions: { headers: { location } },
      };
    })
    .persist();

  // THE BYTE TRAP. Nothing in this path may download the archive: the pre-signed
  // URL is handed to a container, which fetches it elsewhere. A hit here is a
  // regression to the shape that OOM'd the function on five of five attempts.
  agent
    .get(CODELOAD_ORIGIN)
    .intercept({ path: () => true })
    .reply(() => {
      record('GET', 'codeload:BYTE-TRAP');
      return {
        statusCode: 599,
        data: {
          error:
            'the index path fetched the repo ARCHIVE in-process — the pre-signed URL belongs to the container',
        },
        responseOptions: json,
      };
    })
    .persist();
}

function parseBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'string') return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function inOneHour(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}
