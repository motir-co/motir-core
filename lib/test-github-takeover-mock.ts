// Node-only GitHub TAKEOVER boundary mock for E2E (Story MOTIR-9800 · MOTIR-12140).
//
// Taking a repository over reaches GitHub from TWO processes. A Fly or serverless
// takeover from the Repositories room runs `projectRepoTakeoverService.requestTakeover`
// in the WEBSERVER; the organisation-wide AWS handover runs the same transfer, and the
// deploy role's owner lookup and the production config's removal before it, as steps
// of `hosting.tenant-handover.advance` in the JOB WORKER. None of it leaves the server
// for the browser, so `page.route` cannot see it, and the lane refuses api.github.com
// outright (`lib/test-mock-agent.ts`), so without this seam every takeover fails at its
// first call.
//
// What it intercepts (every call the takeover makes that no other seam answers):
//   - GET    /users/{login}                                    → the account's numeric id
//                                                                (the handover deploy role's
//                                                                destination owner)
//   - PUT    /repos/{owner}/{repo}/actions/permissions         → 204 (§G: Actions re-enabled)
//   - DELETE /repos/{owner}/{repo}/actions/secrets/{name}      → 204 (the preview push secret)
//   - DELETE /repos/{owner}/{repo}/actions/variables/{name}    → 204 (preview + production
//                                                                variables)
//   - DELETE /repos/{owner}/{repo}/environments/{env}          → 204 (the `production`
//                                                                environment)
//   - DELETE /repos/{owner}/{repo}/environments/{env}/secrets/{name}
//                                                              → 204 (the production push
//                                                                credential)
//   - POST   /repos/{owner}/{repo}/transfer                    → 202 with `owner.login` set to
//                                                                `new_owner`, so the transfer
//                                                                reads completed and a grace
//                                                                window starts at once
// The org installation read and the installation-token mint are NOT here: the repos
// seam answers them in the webServer and the production-release and merge seams in the
// worker, exactly as for every other job that reaches GitHub.
//
// ⚠️ WHY A SEAM OF ITS OWN AND NOT A FEW MORE INTERCEPTS IN `test-github-repos-mock`.
// That seam keeps the repositories it created in a PROCESS-LOCAL map, so the lane
// deliberately never mirrors it into the worker (`job-worker-process.ts`), and the AWS
// handover's GitHub calls are made THERE. This one is STATELESS — every answer is a
// function of the request — and journals to a FILE, so both processes install it and
// the spec reads one journal for both.
//
// ⚠️ SCOPED TO MOTIR'S PROVISIONING ORG (`GITHUB_FALLBACK_ORG`), like the repos seam:
// a repository-scoped call anywhere else falls through to the next seam, or to the
// mock agent's refusal. And REGISTERED BEFORE every other GitHub seam
// (`lib/test-mock-seams.ts`), so a seam that claims a whole repository's paths cannot
// shadow these.
//
// The JOURNAL (MOTIR_GITHUB_TAKEOVER_JOURNAL_PATH) is JSONL — the mock writes, the spec
// reads. There is no control file: nothing a spec drives needs GitHub to refuse a
// takeover call (the handover's failed-step retry is injected at the fake AWS tenant).

import { createHash } from 'node:crypto';
import { appendFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';

const GITHUB_ORIGIN = 'https://api.github.com';

export const GITHUB_TAKEOVER_JOURNAL_PATH_ENV = 'MOTIR_GITHUB_TAKEOVER_JOURNAL_PATH';

/** One call the seam answered — the journal's line shape. */
export interface GithubTakeoverCall {
  method: string;
  /** Path only, query included. */
  path: string;
  /** The parsed JSON request body, or null for a bodyless call. */
  body: Record<string, unknown> | null;
}

interface MockRequest {
  path: string;
  body?: unknown;
}

interface MockReply {
  statusCode: number;
  data: object | string;
  responseOptions: { headers: Record<string, string> };
}

const reply = (statusCode: number, data: object | string): MockReply => ({
  statusCode,
  data,
  responseOptions: { headers: { 'content-type': 'application/json' } },
});

function provisioningOrg(): string {
  return (process.env['GITHUB_FALLBACK_ORG'] ?? '').trim().toLowerCase();
}

/** The repository-scoped sub-resources this seam answers, by method. */
const REPOSITORY_ROUTES: ReadonlyArray<{ method: string; sub: RegExp }> = [
  { method: 'PUT', sub: /^actions\/permissions$/ },
  { method: 'DELETE', sub: /^actions\/secrets\/[^/]+$/ },
  { method: 'DELETE', sub: /^actions\/variables\/[^/]+$/ },
  { method: 'DELETE', sub: /^environments\/[^/]+$/ },
  { method: 'DELETE', sub: /^environments\/[^/]+\/secrets\/[^/]+$/ },
  { method: 'POST', sub: /^transfer$/ },
];

/** Does the seam answer `method path`? Exported for its unit test. */
export function takeoverMockAnswers(method: string, path: string): boolean {
  const bare = path.split('?')[0]!;
  if (method === 'GET' && /^\/users\/[^/]+$/.test(bare)) return true;
  const m = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(bare);
  if (!m) return false;
  const org = provisioningOrg();
  if (org.length === 0 || m[1]!.toLowerCase() !== org) return false;
  return REPOSITORY_ROUTES.some((route) => route.method === method && route.sub.test(m[3]!));
}

/** A stable positive numeric id for a login, as GitHub's `GET /users/{login}`
 *  answers one: the same login always reads the same id, in every process. */
export function takeoverMockAccountId(login: string): number {
  const digest = createHash('sha256').update(login.toLowerCase()).digest();
  return 10_000_000 + (digest.readUInt32BE(0) % 80_000_000);
}

function parseBody(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'string' || body.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function journal(call: GithubTakeoverCall): void {
  const path = process.env[GITHUB_TAKEOVER_JOURNAL_PATH_ENV];
  if (!path) return;
  try {
    appendFixtureFileSync(path, `${JSON.stringify(call)}\n`);
  } catch {
    /* the journal is evidence, not behaviour — never fail a request over it */
  }
}

/** The answer to one call the seam claims. Exported for its unit test. */
export function takeoverMockReply(method: string, path: string, rawBody: unknown): MockReply {
  const body = parseBody(rawBody);
  journal({ method, path, body });
  const bare = path.split('?')[0]!;
  const user = /^\/users\/([^/]+)$/.exec(bare);
  if (user) {
    const login = decodeURIComponent(user[1]!);
    return reply(200, { login, id: takeoverMockAccountId(login), type: 'User' });
  }
  if (method === 'POST' && bare.endsWith('/transfer')) {
    const repo = /^\/repos\/[^/]+\/([^/]+)\//.exec(bare)![1]!;
    const newOwner = typeof body?.['new_owner'] === 'string' ? body['new_owner'] : '';
    return reply(202, {
      name: decodeURIComponent(repo),
      full_name: `${newOwner}/${decodeURIComponent(repo)}`,
      owner: { login: newOwner },
    });
  }
  return reply(204, '');
}

export function installGithubTakeoverMock(agent: MockAgent): void {
  const pool = agent.get(GITHUB_ORIGIN);
  for (const method of ['GET', 'PUT', 'DELETE', 'POST'] as const) {
    pool
      .intercept({ path: (p) => takeoverMockAnswers(method, p), method })
      .reply((req: MockRequest): MockReply => takeoverMockReply(method, String(req.path), req.body))
      .persist();
  }
}
