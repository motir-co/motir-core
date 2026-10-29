// Node-only GitHub REPO-PROVISIONING + COLLABORATOR boundary mock for E2E
// (Story MOTIR-1775 · MOTIR-1785).
//
// The repository set is established SERVER-side: `projectRepoProvisioningService`
// calls `lib/github/repoProvisioning.ts`, which `fetch`es api.github.com, and
// `projectRepoAccessService` calls `lib/github/repoCollaborators.ts`, which does
// the same. Neither call ever leaves the Next process for the browser, so
// Playwright's `page.route` cannot see them — this seam stands in for GitHub the
// SAME way test-oauth-mock / test-blob-mock / test-billing-mock do: an undici
// intercept installed by instrumentation.ts behind an E2E_TEST_GITHUB_REPOS=1 env
// gate, dormant everywhere else.
//
// ⚠️ NO REAL REPOSITORY IS EVER CREATED. That is this module's whole reason to
// exist (MOTIR-1785's acceptance criterion): an E2E that made real repositories on
// every CI run would leave a mess in Motir's org that nothing cleans up.
//
// What it intercepts (every call the two shipped boundaries make):
//   - GET  /orgs/{org}/installation                        → the Studio App's installation id
//   - POST /app/installations/{id}/access_tokens           → a synthetic installation token
//   - POST /repos/{owner}/{starter}/generate               → template-seeded create (the `web` role)
//   - POST /orgs/{org}/repos                               → initialised create (every other role)
//   - GET  /repos/{owner}/{name}                           → the readiness read (spike §4.2)
//   - PUT  /repos/{owner}/{name}/contents/...              → the CI stub commit (best-effort)
//   - PUT  /repos/{owner}/{name}/collaborators/{login}     → the admin invite (MOTIR-1900)
//   - GET  /repos/{owner}/{name}/collaborators/{login}     → has the invitee accepted?
//   - GET  /repos/{owner}/{name}/contents/{path}           → the design manifest read (MOTIR-1529)
//   - GET  /repos/{owner}/{name}/branches/{branch}         → the seed head (MOTIR-4589)
//   - the starter PROMOTION's reads and writes (Story MOTIR-704 · MOTIR-6415):
//       GET  …/commits/{ref}, GET …/git/trees/{sha}, GET …/git/blobs/{sha},
//       POST …/git/{blobs,trees,commits}, PATCH …/git/refs/heads/{branch},
//       PATCH /repos/{owner}/{name} (marking the copy a template)
//   Every repository-scoped read and write above answers ONLY inside Motir's
//   provisioning org, for the same reason the readiness read does.
//
// TWO FILES, deliberately not one:
//   * the CONTROL file (MOTIR_GITHUB_CONTROL_PATH) — the spec WRITES, the mock
//     READS, re-read on every request so a spec can change GitHub's behaviour
//     mid-test (force row 2 to fail, then let the retry succeed).
//   * the JOURNAL file (MOTIR_GITHUB_JOURNAL_PATH) — the mock WRITES, the spec
//     READS. This is what makes "assert the exact outbound request bodies"
//     possible from a runner in a different process.
//   Sharing one file would make the mock's journal write clobber a control edit
//   the spec had just made (and vice-versa), which is a race a test must not have.

import { createHash } from 'node:crypto';
import { appendFixtureFileSync, readFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';

const GITHUB_ORIGIN = 'https://api.github.com';

/** One outbound call the fake saw — the journal's line shape (JSONL). */
export interface GithubCall {
  method: string;
  /** Path only (the origin is always api.github.com), query included. */
  path: string;
  /** The parsed JSON request body, or null for a bodyless call. */
  body: Record<string, unknown> | null;
}

/** A scripted GitHub refusal. */
export interface GithubRefusal {
  status: number;
  message: string;
}

/**
 * What the spec tells the fake GitHub to do. Every field is optional; the empty
 * control is a GitHub on which everything succeeds.
 */
export interface GithubReposControl {
  /**
   * A monotonic stamp the SPEC bumps when it resets the fixture.
   *
   * The fake's "which repositories exist" table is process-local (see {@link
   * created}), but `resetDatabase()` runs in the RUNNER — so without this the
   * table would outlive the tenant that filled it, and the next test to derive
   * the same project slug would hit the 422 `already exists` ADOPT path instead
   * of a clean create. Two tests would then take different code paths through
   * the shipped primitive while appearing to assert the same thing, which is
   * exactly the kind of difference an equivalence test must not have.
   */
  epoch?: number;
  /** Repo NAME → the refusal its CREATE answers. Cleared by the spec to let a retry pass. */
  createFailures?: Record<string, GithubRefusal>;
  /** Repo NAME → the refusal its collaborator PUT answers (the degrade-on-failure case). */
  inviteFailures?: Record<string, GithubRefusal>;
  /** Repo NAMEs whose invite answers `204` — the account ALREADY has access. */
  alreadyHasAccess?: string[];
  /** `"{repo}:{login}"` pairs the fake reports as accepted collaborators on a GET. */
  accepted?: string[];
  /**
   * Repo NAME → file path → the text the fake's tree holds for it (MOTIR-6415).
   * Served by the contents read, and copied by a promotion's tree read. A path
   * not listed is GitHub's `404`, which is what the design manifest read must
   * get for a starter that is not built on the design system.
   */
  files?: Record<string, Record<string, string>>;
}

function readControl(): GithubReposControl {
  const path = process.env['MOTIR_GITHUB_CONTROL_PATH'];
  if (!path) return {};
  try {
    return JSON.parse(readFixtureFileSync(path)) as GithubReposControl;
  } catch {
    // No file yet (or a half-written one) is the "everything succeeds" default —
    // never a crash, so a spec that never writes a control still runs.
    return {};
  }
}

/** Append one call to the journal. JSONL so a concurrent append can never
 *  truncate an earlier line the way a read-modify-write of a JSON array would. */
function journal(call: GithubCall): void {
  const path = process.env['MOTIR_GITHUB_JOURNAL_PATH'];
  if (!path) return;
  try {
    appendFixtureFileSync(path, `${JSON.stringify(call)}\n`);
  } catch {
    /* the journal is evidence, not behaviour — never fail a request over it */
  }
}

const json = { headers: { 'content-type': 'application/json' } };

/**
 * What an intercept callback hands back. Spelled out (rather than inferred) so
 * undici's `MockReplyOptionsCallback<T>` binds `T` to `object | string` instead of
 * to the literal shape of whichever branch TypeScript happens to see first — the
 * branches legitimately return different bodies.
 */
interface MockReply {
  statusCode: number;
  data: object | string;
  responseOptions: { headers: Record<string, string> };
}

/** The request shape undici hands a reply callback. `body` is OPTIONAL here to
 *  match `MockResponseCallbackOptions` — a bodyless GET carries none. */
interface MockRequest {
  path: string;
  body?: unknown;
}

const reply = (statusCode: number, data: object | string): MockReply => ({
  statusCode,
  data,
  responseOptions: json,
});

/** `/repos/{owner}/{name}/collaborators/{login}` → its parts, or null. */
function parseCollaborator(path: string): { owner: string; repo: string; login: string } | null {
  const m = /^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/?]+)$/.exec(path);
  return m ? { owner: m[1]!, repo: m[2]!, login: m[3]! } : null;
}

/**
 * Motir's provisioning org for this run, as the server sees it.
 *
 * Used to NARROW the broadest intercept (`GET /repos/{owner}/{name}`) to
 * repositories this mock could plausibly have made. The acceptance lane runs
 * EVERY `acceptance*.spec.ts` in one server, so an unscoped read intercept would
 * also shadow any other spec's GitHub repo read and quietly change its behaviour
 * — a mock that reaches past its own subject is a flake generator for tests it
 * was never meant to touch.
 */
function provisioningOrg(): string {
  return (process.env['GITHUB_FALLBACK_ORG'] ?? '').trim();
}

/** `/repos/{owner}/{name}` (the readiness read) → its parts, or null. Matches
 *  ONLY inside Motir's provisioning org — see {@link provisioningOrg}. */
function parseRepo(path: string): { owner: string; name: string } | null {
  const m = /^\/repos\/([^/]+)\/([^/?]+)$/.exec(path);
  if (!m) return null;
  const org = provisioningOrg();
  if (org.length === 0 || m[1]!.toLowerCase() !== org.toLowerCase()) return null;
  return { owner: m[1]!, name: m[2]! };
}

/** The repository-scoped sub-resources this fake serves, after `/repos/{owner}/{name}/`.
 *  The one capture group is the part each reply reads (a path, a branch, a sha). */
const CONTENTS = /^contents\/([^?]+)(?:\?.*)?$/;
const BRANCH = /^branches\/([^/?]+)$/;
const COMMIT = /^commits\/([^/?]+)$/;
const TREE = /^git\/trees\/([^/?]+)(?:\?.*)?$/;
const BLOB = /^git\/blobs\/([^/?]+)$/;
const GIT_WRITE = /^git\/(blobs|trees|commits)$/;
const REF = /^git\/refs\/heads\/([^?]+)$/;

/** `/repos/{owner}/{name}/<sub>` → the repository and `sub`'s capture, or null.
 *  Matches ONLY inside Motir's provisioning org — see {@link provisioningOrg}. */
function parseRepoSub(
  path: string,
  sub: RegExp,
): { owner: string; name: string; rest: string } | null {
  const m = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
  if (!m) return null;
  const org = provisioningOrg();
  if (org.length === 0 || m[1]!.toLowerCase() !== org.toLowerCase()) return null;
  const tail = sub.exec(m[3]!);
  return tail ? { owner: m[1]!, name: m[2]!, rest: tail[1]! } : null;
}

/** A stable 40-hex git-shaped sha for `seed`, so a run's journal is repeatable. */
function fakeSha(seed: string, kind: string): string {
  return createHash('sha1').update(`${kind}:${seed}`).digest('hex');
}

function parseBody(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Repos the fake has "created", name → numeric id. Process-local: the run is a
 * single server boot, and persisting it would only add a way for two specs to
 * disagree with each other. A row's `adopted` retry path re-reads the SAME name,
 * which is exactly what this map makes work.
 */
const created = new Map<string, number>();
let nextRepoId = 900_001;
let seenEpoch: number | undefined;
/** Blob sha → its text, filled by a tree read so the blob reads that follow it
 *  can answer. Keyed by content, so it never needs clearing between tests. */
const blobs = new Map<string, string>();

/** Read the control AND honour its epoch: a new stamp means the spec reset the
 *  fixture, so the fake forgets every repository it ever made. Called at the top
 *  of every intercept, which is the only place both facts are in hand. */
function control(): GithubReposControl {
  const next = readControl();
  if (next.epoch !== seenEpoch) {
    seenEpoch = next.epoch;
    created.clear();
    nextRepoId = 900_001;
  }
  return next;
}

export function installGithubReposMock(agent: MockAgent): void {
  const pool = agent.get(GITHUB_ORIGIN);

  // ── The credential path ────────────────────────────────────────────────────
  // `GET /orgs/{org}/installation` — an APP-JWT read, the only credential that
  // exists before an installation token does.
  pool
    .intercept({
      path: (p) => new RegExp(`^/orgs/${provisioningOrg()}/installation$`, 'i').test(p),
      method: 'GET',
    })
    .reply((req: MockRequest): MockReply => {
      journal({ method: 'GET', path: String(req.path), body: null });
      return reply(200, { id: 99_100_001 });
    })
    .persist();

  pool
    .intercept({ path: (p) => p.startsWith('/app/installations/'), method: 'POST' })
    .reply((req: MockRequest): MockReply => {
      journal({ method: 'POST', path: String(req.path), body: null });
      return reply(200, {
        token: 'ghs_e2e_provisioning_token',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    })
    .persist();

  // ── Creation: the template path (`web`) and the initialised path ───────────
  const create = (req: MockRequest): MockReply => {
    const path = String(req.path);
    const body = parseBody(req.body);
    journal({ method: 'POST', path, body });

    const name = typeof body?.['name'] === 'string' ? body['name'] : '';
    // The `owner` field only appears on the /generate call; an initialised create
    // lands in the org named in its own path.
    const owner =
      typeof body?.['owner'] === 'string'
        ? body['owner']
        : (/^\/orgs\/([^/]+)\/repos$/.exec(path)?.[1] ?? 'motir-projects');

    const refusal = control().createFailures?.[name];
    if (refusal) return reply(refusal.status, { message: refusal.message });

    // A repeat create of a name the fake already made is GitHub's 422
    // `already exists` — the shipped primitive's ADOPT path, not a failure.
    if (created.has(name)) {
      return reply(422, {
        message: 'Repository creation failed.',
        errors: [{ message: 'name already exists on this account' }],
      });
    }

    const id = nextRepoId++;
    created.set(name, id);
    return reply(201, { id, name, owner: { login: owner } });
  };

  pool
    .intercept({ path: (p) => /^\/repos\/[^/]+\/[^/]+\/generate$/.test(p), method: 'POST' })
    .reply(create)
    .persist();

  pool
    .intercept({
      path: (p) => new RegExp(`^/orgs/${provisioningOrg()}/repos$`, 'i').test(p),
      method: 'POST',
    })
    .reply(create)
    .persist();

  // ── The readiness read ─────────────────────────────────────────────────────
  // `default_branch` is populated immediately: the fake has no tree to build, and
  // a spec that needs the `creating` state to be OBSERVABLE gets it from a
  // create-side delay in the control rather than from a starved readiness poll.
  pool
    .intercept({ path: (p) => parseRepo(p) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      journal({ method: 'GET', path, body: null });
      const parsed = parseRepo(path)!;
      const id = created.get(parsed.name);
      if (!id) return reply(404, { message: 'Not Found' });
      return reply(200, {
        id,
        name: parsed.name,
        owner: { login: parsed.owner },
        default_branch: 'main',
      });
    })
    .persist();

  // ── The files of a repository the fake made (MOTIR-1529 · MOTIR-6415) ──────
  // The design manifest read after a template create, and a promotion's
  // hosting-manifest read. `404` for any path the control does not list.
  pool
    .intercept({ path: (p) => parseRepoSub(p, CONTENTS) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      journal({ method: 'GET', path, body: null });
      const { name, rest } = parseRepoSub(path, CONTENTS)!;
      const text = control().files?.[name]?.[decodeURIComponent(rest)];
      if (text === undefined || !created.has(name)) return reply(404, { message: 'Not Found' });
      return reply(200, {
        type: 'file',
        path: rest,
        encoding: 'base64',
        content: Buffer.from(text, 'utf8').toString('base64'),
      });
    })
    .persist();

  // ── The seed head: the branch's commit ─────────────────────────────────────
  pool
    .intercept({ path: (p) => parseRepoSub(p, BRANCH) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      journal({ method: 'GET', path, body: null });
      const { name, rest } = parseRepoSub(path, BRANCH)!;
      if (!created.has(name)) return reply(404, { message: 'Not Found' });
      return reply(200, { name: rest, commit: { sha: fakeSha(name, 'head') } });
    })
    .persist();

  // ── A promotion's reads of its SOURCE (Story MOTIR-704 · MOTIR-710) ────────
  // The ref resolves to the repository's one commit; its tree is the control's
  // `files` for that repository, and each blob is read back by its sha.
  pool
    .intercept({ path: (p) => parseRepoSub(p, COMMIT) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      journal({ method: 'GET', path, body: null });
      const { name } = parseRepoSub(path, COMMIT)!;
      if (!created.has(name)) return reply(404, { message: 'Not Found' });
      return reply(200, {
        sha: fakeSha(name, 'head'),
        commit: { tree: { sha: fakeSha(name, 'tree') } },
      });
    })
    .persist();

  pool
    .intercept({ path: (p) => parseRepoSub(p, TREE) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      journal({ method: 'GET', path, body: null });
      const { name } = parseRepoSub(path, TREE)!;
      const files = control().files?.[name] ?? {};
      const tree = Object.entries(files).map(([filePath, text]) => {
        const sha = fakeSha(text, 'blob');
        blobs.set(sha, text);
        return { path: filePath, mode: '100644', type: 'blob', sha };
      });
      return reply(200, { sha: fakeSha(name, 'tree'), tree, truncated: false });
    })
    .persist();

  pool
    .intercept({ path: (p) => parseRepoSub(p, BLOB) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      journal({ method: 'GET', path, body: null });
      const text = blobs.get(parseRepoSub(path, BLOB)!.rest);
      if (text === undefined) return reply(404, { message: 'Not Found' });
      return reply(200, { encoding: 'base64', content: Buffer.from(text).toString('base64') });
    })
    .persist();

  // ── A promotion's writes to its COPY ───────────────────────────────────────
  // Each git object answers a sha derived from what it was asked to hold, so
  // the journal shows the copy's commit naming the tree that was posted.
  pool
    .intercept({ path: (p) => parseRepoSub(p, GIT_WRITE) !== null, method: 'POST' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const body = parseBody(req.body);
      journal({ method: 'POST', path, body });
      const { name, rest } = parseRepoSub(path, GIT_WRITE)!;
      return reply(201, { sha: fakeSha(`${name}:${JSON.stringify(body)}`, rest) });
    })
    .persist();

  pool
    .intercept({ path: (p) => parseRepoSub(p, REF) !== null, method: 'PATCH' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const body = parseBody(req.body);
      journal({ method: 'PATCH', path, body });
      const { rest } = parseRepoSub(path, REF)!;
      return reply(200, { ref: `refs/heads/${rest}`, object: { sha: body?.['sha'] ?? null } });
    })
    .persist();

  pool
    .intercept({ path: (p) => parseRepo(p) !== null, method: 'PATCH' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const body = parseBody(req.body);
      journal({ method: 'PATCH', path, body });
      const parsed = parseRepo(path)!;
      if (!created.has(parsed.name)) return reply(404, { message: 'Not Found' });
      return reply(200, { name: parsed.name, owner: { login: parsed.owner }, ...body });
    })
    .persist();

  // ── The collaborator INVITE (MOTIR-1900) ───────────────────────────────────
  pool
    .intercept({ path: (p) => parseCollaborator(p) !== null, method: 'PUT' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const body = parseBody(req.body);
      journal({ method: 'PUT', path, body });
      const target = parseCollaborator(path)!;
      const scripted = control();

      const refusal = scripted.inviteFailures?.[target.repo];
      if (refusal) return reply(refusal.status, { message: refusal.message });
      // 204 — already a collaborator. No invitation is created and none is pending.
      if (scripted.alreadyHasAccess?.includes(target.repo)) return reply(204, '');
      return reply(201, {
        id: 55_500_001,
        html_url: `https://github.com/${target.owner}/${target.repo}/invitations`,
      });
    })
    .persist();

  // ── "Has this login accepted?" — `204` yes, `404` no (a pending invitee) ────
  pool
    .intercept({ path: (p) => parseCollaborator(p) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      journal({ method: 'GET', path, body: null });
      const target = parseCollaborator(path)!;
      const accepted = control().accepted ?? [];
      return accepted.includes(`${target.repo}:${target.login}`)
        ? reply(204, '')
        : reply(404, { message: 'Not Found' });
    })
    .persist();

  // ── The CI stub's contents PUT (best-effort in the shipped primitive) ───────
  pool
    .intercept({ path: (p) => /^\/repos\/[^/]+\/[^/]+\/contents\//.test(p), method: 'PUT' })
    .reply((req: MockRequest): MockReply => {
      journal({ method: 'PUT', path: String(req.path), body: parseBody(req.body) });
      return reply(201, { content: {} });
    })
    .persist();
}
