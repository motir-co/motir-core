// Node-only GitHub PREVIEW boundary mock for E2E (Story MOTIR-5766 · MOTIR-5781).
//
// A pull request's preview reaches GitHub from the JOB WORKER, never from the
// browser: the lifecycle's effects create the preview's deployment and post its
// statuses (`lib/github/previewDeployments.ts`), and its start reads the hosting
// manifest at the pull request's head (`seedPromotionGithub.readHostingManifest`).
// `page.route` cannot see any of it, so this seam stands in for GitHub the way
// the merge seam does: an undici intercept on the ONE shared `MockAgent`,
// installed from the seam table behind `E2E_TEST_GITHUB_PREVIEW=1`, dormant
// everywhere else. The SHIPPED client runs against it.
//
// What it intercepts, for a repository its control names and no other:
//   - GET  /repos/{owner}/{name}/contents/motir.hosting.json?ref=
//                                         → the manifest the control names, as GitHub's
//                                           JSON file object (base64), or GitHub's 404
//   - POST /repos/{owner}/{name}/deployments            → a new deployment id
//   - POST /repos/{owner}/{name}/deployments/{id}/statuses → the status, accepted
//
// The installation token those calls carry is the merge seam's (or the repos seam's)
// mint: this seam answers none of its own.
//
// ⚠️ SCOPED, AND REGISTERED BEFORE THE MERGE SEAM. That seam answers
// `contents/{path}` as RAW text for the repositories its own control names; the
// manifest read asks for GitHub's JSON object. Claiming only the repositories THIS
// control lists keeps every other repository's contents read where it was.
//
// TWO FILES, as every GitHub seam here has them:
//   * the CONTROL file (MOTIR_GITHUB_PREVIEW_CONTROL_PATH) — the spec WRITES, the mock
//     READS, re-read on every request;
//   * the JOURNAL file (MOTIR_GITHUB_PREVIEW_JOURNAL_PATH) — the mock WRITES, the spec
//     READS, which is how a runner in another process sees what the worker posted.

import { appendFixtureFileSync, readFixtureFileSync } from '@/lib/test-fixture-file';
import { HOSTING_MANIFEST_FILE_NAME } from '@/lib/hosting/manifest';
import type { MockAgent } from 'undici';

const GITHUB_ORIGIN = 'https://api.github.com';

export interface GithubPreviewControl {
  /** `owner/name` of each repository this seam answers for. */
  repositories?: string[];
  /** `owner/name` → the hosting manifest's TEXT, served at every ref. A listed
   *  repository with no entry has no manifest (GitHub's 404). */
  manifests?: Record<string, string>;
}

/** One call the seam answered, as the journal records it. */
export interface GithubPreviewCall {
  method: string;
  path: string;
  /** `owner/name`. */
  repository: string;
  body: Record<string, unknown> | null;
}

function readControl(): GithubPreviewControl {
  const path = process.env['MOTIR_GITHUB_PREVIEW_CONTROL_PATH'];
  if (!path) return {};
  try {
    return JSON.parse(readFixtureFileSync(path)) as GithubPreviewControl;
  } catch {
    // No file yet, or a half-written one: this seam then answers for no repository.
    return {};
  }
}

/** JSONL, so a concurrent append can never truncate an earlier line. */
function journal(call: GithubPreviewCall): void {
  const path = process.env['MOTIR_GITHUB_PREVIEW_JOURNAL_PATH'];
  if (!path) return;
  try {
    appendFixtureFileSync(path, `${JSON.stringify(call)}\n`);
  } catch {
    /* the journal is evidence, not behaviour — never fail a request over it */
  }
}

interface MockReply {
  statusCode: number;
  data: object;
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

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const MANIFEST_PATH = new RegExp(
  `^/repos/([^/]+)/([^/]+)/contents/${HOSTING_MANIFEST_FILE_NAME.replace(/\./g, '\\.')}(?:\\?.*)?$`,
);
const DEPLOYMENTS_PATH = /^\/repos\/([^/]+)\/([^/]+)\/deployments$/;
const STATUSES_PATH = /^\/repos\/([^/]+)\/([^/]+)\/deployments\/([^/]+)\/statuses$/;

/** A path's `owner/name`, when this seam answers for that repository. */
function scoped(pattern: RegExp, path: string): string | null {
  const m = pattern.exec(path);
  if (!m) return null;
  const repository = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`;
  return (readControl().repositories ?? []).some((r) => same(r, repository)) ? repository : null;
}

function parseBody(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

let deploymentSeq = 0;

export function installGithubPreviewMock(agent: MockAgent): void {
  const pool = agent.get(GITHUB_ORIGIN);

  pool
    .intercept({ path: (p) => scoped(MANIFEST_PATH, p) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const repository = scoped(MANIFEST_PATH, path)!;
      journal({ method: 'GET', path, repository, body: null });
      const text = Object.entries(readControl().manifests ?? {}).find(([k]) =>
        same(k, repository),
      )?.[1];
      if (text === undefined) return reply(404, { message: 'Not Found' });
      return reply(200, {
        type: 'file',
        name: HOSTING_MANIFEST_FILE_NAME,
        path: HOSTING_MANIFEST_FILE_NAME,
        encoding: 'base64',
        content: Buffer.from(text, 'utf8').toString('base64'),
      });
    })
    .persist();

  pool
    .intercept({ path: (p) => scoped(DEPLOYMENTS_PATH, p) !== null, method: 'POST' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const body = parseBody(req.body);
      journal({ method: 'POST', path, repository: scoped(DEPLOYMENTS_PATH, path)!, body });
      // Unique across processes that both install the seam: a time base plus a counter.
      deploymentSeq += 1;
      const id = Date.now() * 1000 + deploymentSeq;
      return reply(201, { id, sha: body?.['ref'] ?? null, environment: body?.['environment'] });
    })
    .persist();

  pool
    .intercept({ path: (p) => scoped(STATUSES_PATH, p) !== null, method: 'POST' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const body = parseBody(req.body);
      journal({ method: 'POST', path, repository: scoped(STATUSES_PATH, path)!, body });
      return reply(201, { id: Date.now(), state: body?.['state'] ?? null });
    })
    .persist();
}
