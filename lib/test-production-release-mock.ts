// Node-only GitHub boundary mock for a PRODUCTION RELEASE, for E2E (Story
// MOTIR-9797 · MOTIR-10040).
//
// A merge's release runs in the JOB WORKER: `hosting/merge-release.requested`
// reads the repository's hosting manifest at the merged commit
// (`hostedRepositoryAccessService.readManifestAt`), and `hosted-release.status`
// posts the release's GitHub deployment and its statuses (`repoDeployments`).
// Both reach api.github.com with an installation token of Motir's own org
// (`provisioningAuth`). None of that is reachable from the browser, so this seam
// stands in for those calls the way the other GitHub seams do: an undici
// intercept on the ONE shared `MockAgent`, behind `E2E_TEST_PRODUCTION_RELEASE=1`.
//
// What it intercepts:
//   - GET  /orgs/{org}/installation                        → the org's App installation
//                                                            (ONLY with the repos seam
//                                                            off, which answers it itself)
//   - GET  /repos/{owner}/{name}/contents/motir.hosting.json?ref=
//                                                          → the manifest the control names
//   - POST /repos/{owner}/{name}/deployments               → a new deployment id
//   - POST /repos/{owner}/{name}/deployments/{id}/statuses → accepted
// The installation-token mint itself is the merge seam's (or the repos seam's).
//
// ⚠️ SCOPED TO THE REPOSITORIES THE CONTROL NAMES, and registered before the merge
// and repos seams, which answer other paths of the same host: a path of any other
// repository falls through to them untouched, and a call no seam claims is refused
// by name by the shared agent (`lib/test-mock-agent.ts`).
//
// ⚠️ WORKER-ONLY by the lane's wiring (`productionReleaseSeamEnv` in
// `tests/e2e/_helpers/job-worker-process.ts`): no web-server path of the release
// reaches GitHub. It keeps no state in memory that a second copy could disagree
// with: the control and the journal are files.
//
// TWO FILES, as the other GitHub seams have them:
//   * the CONTROL file (MOTIR_PRODUCTION_RELEASE_CONTROL_PATH) — the spec WRITES,
//     the mock READS on every request;
//   * the JOURNAL file (MOTIR_PRODUCTION_RELEASE_JOURNAL_PATH) — the mock WRITES
//     each deployment and status it accepted, JSONL.

import { appendFixtureFileSync, readFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';

const GITHUB_ORIGIN = 'https://api.github.com';

/** What the spec tells the fake GitHub. */
export interface ProductionReleaseControl {
  /** Orgs whose App installation this seam answers, with the installation id. */
  installations?: Record<string, number>;
  /** `owner/name` → the hosting manifest the repository has at every commit. */
  manifests?: Record<string, unknown>;
}

/** One call the fake accepted — the journal's line shape. */
export interface ProductionReleaseCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

interface MockReply {
  statusCode: number;
  data: object | string;
  responseOptions: { headers: Record<string, string> };
}

interface MockRequest {
  path: string;
  body?: unknown;
}

const reply = (statusCode: number, data: object): MockReply => ({
  statusCode,
  data,
  responseOptions: { headers: { 'content-type': 'application/json' } },
});

function readControl(): ProductionReleaseControl {
  const path = process.env['MOTIR_PRODUCTION_RELEASE_CONTROL_PATH'];
  if (!path) return {};
  try {
    return JSON.parse(readFixtureFileSync(path)) as ProductionReleaseControl;
  } catch {
    // No file yet, or a half-written one: this seam then answers for nothing.
    return {};
  }
}

function journal(call: ProductionReleaseCall): void {
  const path = process.env['MOTIR_PRODUCTION_RELEASE_JOURNAL_PATH'];
  if (!path) return;
  try {
    appendFixtureFileSync(path, `${JSON.stringify(call)}\n`);
  } catch {
    /* the journal is evidence, not behaviour — never fail a request over it */
  }
}

function bodyOf(req: MockRequest): Record<string, unknown> | null {
  if (typeof req.body !== 'string') return null;
  try {
    return JSON.parse(req.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const INSTALLATION_PATH = /^\/orgs\/([^/]+)\/installation$/;
const MANIFEST_PATH = /^\/repos\/([^/]+)\/([^/]+)\/contents\/motir\.hosting\.json\?ref=[^&]+$/;
const DEPLOYMENTS_PATH = /^\/repos\/([^/]+)\/([^/]+)\/deployments$/;
const STATUSES_PATH = /^\/repos\/([^/]+)\/([^/]+)\/deployments\/(\d+)\/statuses$/;

/** The installation id for a path's org, when the control names it. */
function installationFor(path: string): number | null {
  const m = INSTALLATION_PATH.exec(path);
  if (!m) return null;
  const entry = Object.entries(readControl().installations ?? {}).find(([org]) => same(org, m[1]!));
  return entry?.[1] ?? null;
}

/** The manifest a path's repository has, when the control names it. */
function manifestFor(pattern: RegExp, path: string): unknown {
  const m = pattern.exec(path);
  if (!m) return undefined;
  const repository = `${m[1]}/${m[2]}`;
  const entry = Object.entries(readControl().manifests ?? {}).find(([r]) => same(r, repository));
  return entry?.[1];
}

// Deployment ids only have to be unique per repository across the lane's
// lifetime, and the worker can restart, so they start from the clock.
let deploymentSeq = Math.floor(Date.now() / 1000);

export function installProductionReleaseMock(agent: MockAgent): void {
  const pool = agent.get(GITHUB_ORIGIN);

  if (process.env['E2E_TEST_GITHUB_REPOS'] !== '1') {
    pool
      .intercept({ path: (p) => installationFor(p) !== null, method: 'GET' })
      .reply((req: MockRequest): MockReply => reply(200, { id: installationFor(req.path) }))
      .persist();
  }

  pool
    .intercept({ path: (p) => manifestFor(MANIFEST_PATH, p) !== undefined, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const manifest = manifestFor(MANIFEST_PATH, req.path);
      journal({ method: 'GET', path: req.path, body: null });
      return reply(200, {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64'),
      });
    })
    .persist();

  pool
    .intercept({ path: (p) => manifestFor(DEPLOYMENTS_PATH, p) !== undefined, method: 'POST' })
    .reply((req: MockRequest): MockReply => {
      const body = bodyOf(req);
      journal({ method: 'POST', path: req.path, body });
      deploymentSeq += 1;
      return reply(201, { id: deploymentSeq, ref: body?.['ref'] ?? null });
    })
    .persist();

  pool
    .intercept({ path: (p) => manifestFor(STATUSES_PATH, p) !== undefined, method: 'POST' })
    .reply((req: MockRequest): MockReply => {
      const body = bodyOf(req);
      journal({ method: 'POST', path: req.path, body });
      return reply(201, { state: body?.['state'] ?? null });
    })
    .persist();
}
