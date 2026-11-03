// Node-only GitHub FLEET ORG CI boundary mock for E2E (Story MOTIR-8699 · MOTIR-8717).
//
// `/admin/fleet-settings` is server rendered and flips through a Server Action, so every
// GitHub call behind it is made by the Next process — Playwright's `page.route` reaches
// none of them. This seam stands in for GitHub the way `test-github-merge-mock` does: an
// undici intercept on the ONE shared `MockAgent`, installed from `lib/test-mock-seams.ts`
// behind `E2E_TEST_GITHUB_FLEET_ORG_CI=1`, dormant everywhere else. The REAL clients
// (`orgInstallation.ts`, `repoVisibility.ts`, `actionsVariables.ts`, `repoProvisioning.ts`'s
// installation lookup) and the REAL App JWT + installation-token mint (`appAuth.ts`) run
// against it, so the lane exercises the shipped readiness verdict and the shipped flip.
//
// What it intercepts — exactly the calls `fleetOrgCiSettingService` and
// `fleetReadinessService` make on this branch, and nothing else:
//
//   - POST   /app/installations/{id}/access_tokens        → a token NAMED for that installation,
//                                                            for an installation the control names
//   - GET    /orgs/{org}/installation                     → id, permissions, events,
//                                                            repository_selection, suspended_at;
//                                                            404 when the control says not installed
//                                                            (`getOrgInstallation`, and the
//                                                            setting's `findProvisioningInstallationId`)
//   - GET    /installation/repositories                   → the control's repository ids, paged with
//                                                            a `Link` header (`listInstallationRepositoryIds`)
//   - GET    /repos/{org}/{name}                          → `private` (`repoVisibilityClient.isPrivate`,
//                                                            which BOTH services call — not in the
//                                                            card's list, and required by it)
//   - GET    /repos/{org}/{name}/commits?path=.github/workflows
//                                                         → one commit, sha + date from the control
//                                                            (`latestWorkflowCommit`)
//   - GET    /orgs/{org}/actions/variables/{name}         → the variable store
//   - POST   /orgs/{org}/actions/variables                → create (GitHub's create is on the
//                                                            COLLECTION, not on the name)
//   - PATCH  /orgs/{org}/actions/variables/{name}         → update
//   - DELETE /orgs/{org}/actions/variables/{name}         → delete
//   - GET    /repos/{org}/{name}/code-scanning/default-setup
//                                                         → the repository's CodeQL default setup
//                                                            (MOTIR-10289): the store's, else the
//                                                            control's, else `not-configured`
//   - PATCH  /repos/{org}/{name}/code-scanning/default-setup
//                                                         → moves its runner in the store; 422 for
//                                                            a repository not configured
//
// ⚠️ SCOPED TO THE ORGS AND INSTALLATIONS THE CONTROL NAMES, AND REGISTERED BEFORE THE
// MERGE AND REPOS SEAMS. Undici tries intercepts in REGISTRATION order and falls through a
// predicate that answers false. The repos seam answers EVERY `POST /app/installations/*`
// and the merge seam answers `GET /repos/{owner}/{name}` for its own repositories, so this
// seam claims a path only for an org (or an installation id, or the token it minted) its
// control lists, and every other call reaches the seams after it untouched. An org the
// control does not name is never answered here; with no other seam claiming it, the shared
// agent REFUSES it by name (`lib/test-mock-agent.ts`).
//
// ⚠️ THE VARIABLE ENDPOINTS DEMAND THE MINTED TOKEN. A variable call that does not carry
// `Bearer <the token this seam minted for that org's installation>` is answered 401, so a
// green walk proves the shipped token mint ran rather than being skipped.
//
// THREE FILES:
//   * the CONTROL file (E2E_GITHUB_FLEET_ORG_CI_CONTROL) — the spec WRITES, the mock READS,
//     re-read on every request, so a spec can move the verdict between two page loads;
//   * the JOURNAL file (E2E_GITHUB_FLEET_ORG_CI_JOURNAL) — the mock WRITES, the spec READS,
//     JSONL, every intercepted call with the status it was answered;
//   * the STORE file (the control path + `.store.json`) — the mock's own state: each org's
//     variables and which forced failures it has already spent. The spec only READS it.
//     Kept apart from the control so the spec's writes and the mock's writes never race on
//     one file.
//
// ⚠️ A FORCED FAILURE IS SPENT ONCE. `failNextWrite: { id, status }` makes the NEXT write
// (POST, PATCH or DELETE) to that org answer `status` and change NOTHING in the store. The
// store records the `id` it spent, so re-arming the same control does not fail a second
// write; arm a new `id` for another failure.
//
// No org login is spelled in this file: every org arrives as control data.

import {
  appendFixtureFileSync,
  readFixtureFileSync,
  writeFixtureFileSync,
} from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';

const GITHUB_ORIGIN = 'https://api.github.com';

/** The env vars the lane sets (see `playwright.acceptance.config.ts`). */
export const FLEET_ORG_CI_CONTROL_ENV = 'E2E_GITHUB_FLEET_ORG_CI_CONTROL';
export const FLEET_ORG_CI_JOURNAL_ENV = 'E2E_GITHUB_FLEET_ORG_CI_JOURNAL';

/** One repository of an org, as the fake reports it. */
export interface FleetOrgCiRepository {
  /** GitHub's numeric repository id — what `/installation/repositories` lists. */
  id: number;
  name: string;
  /** Defaults to `true`. */
  private?: boolean;
  /** The newest commit touching `.github/workflows`; omitted → no such commit. */
  workflowCommit?: { sha: string; date: string };
  /** Defaults to `true`: whether the installation reaches it. */
  granted?: boolean;
  /** Its CodeQL default setup as the run starts; omitted → `not-configured`. */
  defaultSetup?: FleetOrgCiDefaultSetup;
}

/** A repository's CodeQL default setup, as the fake holds it. */
export interface FleetOrgCiDefaultSetup {
  state: 'configured' | 'not-configured';
  runnerType?: 'standard' | 'labeled';
  runnerLabel?: string | null;
}

/** A forced failure for the next variable write to the org. */
export interface FleetOrgCiForcedFailure {
  /** A fresh id per arming — the store records the ids it has spent. */
  id: string;
  /** The HTTP status the write answers. */
  status: number;
}

/** What the fake GitHub reports for ONE org. */
export interface FleetOrgCiOrgControl {
  /** The App installation's id on this org. */
  installationId: string;
  /** Defaults to `true`; `false` answers `/orgs/{org}/installation` with 404. */
  installed?: boolean;
  /** The installation's granted permissions. */
  permissions?: Record<string, string>;
  /** The installation's subscribed events. */
  events?: string[];
  repositorySelection?: 'all' | 'selected';
  suspendedAt?: string | null;
  repositories?: FleetOrgCiRepository[];
  /** Page size for `/installation/repositories`; the client asks for 100. Smaller pages
   *  make the fake answer with a `Link: rel="next"` header. */
  repositoriesPageSize?: number;
  failNextWrite?: FleetOrgCiForcedFailure | null;
}

/** The control file: org login → what GitHub says about it. The empty control answers for
 *  no org. */
export interface FleetOrgCiControl {
  orgs?: Record<string, FleetOrgCiOrgControl>;
}

/** An org variable as the store holds it. */
export interface FleetOrgCiStoredVariable {
  value: string;
  visibility: string;
}

/** The store file: the mock's own state. */
export interface FleetOrgCiStore {
  /** lowercased org → variable name → value. */
  variables: Record<string, Record<string, FleetOrgCiStoredVariable>>;
  /** Forced-failure ids already spent. */
  spentFailures: string[];
  /** lowercased org → lowercased repository → its default setup after a PATCH. */
  defaultSetups?: Record<string, Record<string, FleetOrgCiDefaultSetup>>;
}

/** One outbound call the fake answered — the journal's line shape (JSONL). */
export interface FleetOrgCiCall {
  method: string;
  path: string;
  /** The org the call was about (lowercased), when it named one. */
  org: string | null;
  body: Record<string, unknown> | null;
  /** The status this seam answered. */
  status: number;
}

/** The store file's path for a control path. Exported for the spec helper and the test. */
export function fleetOrgCiStorePath(controlPath: string): string {
  return `${controlPath}.store.json`;
}

/** The installation token this seam mints for an installation id. */
export function fleetOrgCiToken(installationId: string): string {
  return `ghs_e2e_fleet_org_ci_${installationId}`;
}

function controlPath(): string | null {
  return process.env[FLEET_ORG_CI_CONTROL_ENV] || null;
}

function readControl(): FleetOrgCiControl {
  const path = controlPath();
  if (!path) return {};
  try {
    return JSON.parse(readFixtureFileSync(path)) as FleetOrgCiControl;
  } catch {
    // No file yet, or a half-written one: this seam then answers for no org.
    return {};
  }
}

function readStore(): FleetOrgCiStore {
  const path = controlPath();
  const empty: FleetOrgCiStore = { variables: {}, spentFailures: [] };
  if (!path) return empty;
  try {
    const parsed = JSON.parse(readFixtureFileSync(fleetOrgCiStorePath(path))) as FleetOrgCiStore;
    return {
      variables: parsed.variables ?? {},
      spentFailures: parsed.spentFailures ?? [],
      defaultSetups: parsed.defaultSetups ?? {},
    };
  } catch {
    return empty;
  }
}

function writeStore(store: FleetOrgCiStore): void {
  const path = controlPath();
  if (!path) return;
  writeFixtureFileSync(fleetOrgCiStorePath(path), JSON.stringify(store));
}

/** JSONL, so a concurrent append can never truncate an earlier line. */
function journal(call: FleetOrgCiCall): void {
  const path = process.env[FLEET_ORG_CI_JOURNAL_ENV];
  if (!path) return;
  try {
    appendFixtureFileSync(path, `${JSON.stringify(call)}\n`);
  } catch {
    /* the journal is evidence, not behaviour — never fail a request over it */
  }
}

interface MockReply {
  statusCode: number;
  data: object | string;
  responseOptions: { headers: Record<string, string> };
}

interface MockRequest {
  path: string;
  method?: string;
  body?: unknown;
  headers?: unknown;
}

const reply = (
  statusCode: number,
  data: object | string,
  headers: Record<string, string> = {},
): MockReply => ({
  statusCode,
  data,
  responseOptions: { headers: { 'content-type': 'application/json', ...headers } },
});

/** The control entry for an org, matched case-insensitively as GitHub does. */
function orgControl(
  control: FleetOrgCiControl,
  org: string,
): { login: string; entry: FleetOrgCiOrgControl } | null {
  const key = org.toLowerCase();
  for (const [login, entry] of Object.entries(control.orgs ?? {})) {
    if (login.toLowerCase() === key) return { login, entry };
  }
  return null;
}

/** The org whose installation is `installationId`, when the control names one. */
function orgOfInstallation(
  control: FleetOrgCiControl,
  installationId: string,
): { login: string; entry: FleetOrgCiOrgControl } | null {
  for (const [login, entry] of Object.entries(control.orgs ?? {})) {
    if (String(entry.installationId) === installationId) return { login, entry };
  }
  return null;
}

function headerOf(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1]);
    }
    return null;
  }
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const entry = Object.entries(headers as Record<string, unknown>).find(
    ([k]) => k.toLowerCase() === name,
  );
  return entry ? String(entry[1]) : null;
}

/** The org whose minted token a request carries, when it carries one of ours. */
function orgOfToken(
  control: FleetOrgCiControl,
  headers: unknown,
): { login: string; entry: FleetOrgCiOrgControl } | null {
  const auth = headerOf(headers, 'authorization');
  if (!auth) return null;
  const token = auth.replace(/^(Bearer|token)\s+/i, '');
  for (const [login, entry] of Object.entries(control.orgs ?? {})) {
    if (fleetOrgCiToken(String(entry.installationId)) === token) return { login, entry };
  }
  return null;
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

function queryParam(path: string, name: string): string | null {
  const q = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
  return new URLSearchParams(q).get(name);
}

const pathOnly = (p: string) => p.split('?')[0] ?? p;
const decode = (s: string) => decodeURIComponent(s);

const TOKEN_PATH = /^\/app\/installations\/([^/]+)\/access_tokens$/;
const ORG_INSTALLATION_PATH = /^\/orgs\/([^/]+)\/installation$/;
const INSTALLATION_REPOS_PATH = /^\/installation\/repositories$/;
const REPO_PATH = /^\/repos\/([^/]+)\/([^/]+)$/;
const COMMITS_PATH = /^\/repos\/([^/]+)\/([^/]+)\/commits$/;
const VARIABLES_PATH = /^\/orgs\/([^/]+)\/actions\/variables$/;
const VARIABLE_PATH = /^\/orgs\/([^/]+)\/actions\/variables\/([^/]+)$/;
const DEFAULT_SETUP_PATH = /^\/repos\/([^/]+)\/([^/]+)\/code-scanning\/default-setup$/;

/** A path's org (decoded), when the pattern matches and the control names that org. */
function scopedOrg(pattern: RegExp, path: string): RegExpExecArray | null {
  const m = pattern.exec(pathOnly(path));
  if (!m) return null;
  return orgControl(readControl(), decode(m[1]!)) ? m : null;
}

/** The variable call's checks shared by every verb: the token must be the one this seam
 *  minted for that org, or the call is answered 401 (and journalled). */
function authorised(req: MockRequest, org: { entry: FleetOrgCiOrgControl }): boolean {
  const auth = headerOf(req.headers, 'authorization') ?? '';
  return auth === `Bearer ${fleetOrgCiToken(String(org.entry.installationId))}`;
}

/** Spend the org's forced failure, if one is armed and not yet spent. */
function spendFailure(store: FleetOrgCiStore, entry: FleetOrgCiOrgControl): number | null {
  const failure = entry.failNextWrite;
  if (!failure || store.spentFailures.includes(failure.id)) return null;
  store.spentFailures.push(failure.id);
  return failure.status;
}

export function installGithubFleetOrgCiMock(agent: MockAgent): void {
  const pool = agent.get(GITHUB_ORIGIN);

  // ── The installation-token mint, for an installation the control names ─────
  pool
    .intercept({
      path: (p) => {
        const m = TOKEN_PATH.exec(p);
        return m !== null && orgOfInstallation(readControl(), decode(m[1]!)) !== null;
      },
      method: 'POST',
    })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const id = decode(TOKEN_PATH.exec(path)![1]!);
      const owner = orgOfInstallation(readControl(), id)!;
      journal({ method: 'POST', path, org: owner.login.toLowerCase(), body: null, status: 201 });
      return reply(201, {
        token: fleetOrgCiToken(id),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    })
    .persist();

  // ── The App's installation on the org (App JWT) ────────────────────────────
  pool
    .intercept({ path: (p) => scopedOrg(ORG_INSTALLATION_PATH, p) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const m = ORG_INSTALLATION_PATH.exec(pathOnly(path))!;
      const { login, entry } = orgControl(readControl(), decode(m[1]!))!;
      const org = login.toLowerCase();
      if (entry.installed === false) {
        journal({ method: 'GET', path, org, body: null, status: 404 });
        return reply(404, { message: 'Not Found' });
      }
      journal({ method: 'GET', path, org, body: null, status: 200 });
      return reply(200, {
        id: Number(entry.installationId),
        account: { login, type: 'Organization' },
        permissions: entry.permissions ?? {},
        events: entry.events ?? [],
        repository_selection: entry.repositorySelection ?? 'selected',
        suspended_at: entry.suspendedAt ?? null,
      });
    })
    .persist();

  // ── The repositories the installation reaches, paged ───────────────────────
  // Scoped by the TOKEN, as the accounts seam scopes its own read: the path names no org.
  pool
    .intercept({
      path: (p) => INSTALLATION_REPOS_PATH.test(pathOnly(p)),
      method: 'GET',
      headers: (headers) => orgOfToken(readControl(), headers) !== null,
    })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const { login, entry } = orgOfToken(readControl(), req.headers)!;
      const granted = (entry.repositories ?? []).filter((r) => r.granted !== false);
      const size = Math.max(1, entry.repositoriesPageSize ?? 100);
      const page = Math.max(1, Number(queryParam(path, 'page') ?? '1') || 1);
      const slice = granted.slice((page - 1) * size, page * size);
      const headers: Record<string, string> = {};
      if (page * size < granted.length) {
        headers['link'] =
          `<${GITHUB_ORIGIN}/installation/repositories?per_page=${size}&page=${page + 1}>; rel="next"`;
      }
      journal({ method: 'GET', path, org: login.toLowerCase(), body: null, status: 200 });
      return reply(
        200,
        {
          total_count: granted.length,
          repository_selection: entry.repositorySelection ?? 'selected',
          repositories: slice.map((r) => ({
            id: r.id,
            name: r.name,
            full_name: `${login}/${r.name}`,
            private: r.private ?? true,
            owner: { login },
          })),
        },
        headers,
      );
    })
    .persist();

  // ── A repository's visibility ──────────────────────────────────────────────
  pool
    .intercept({ path: (p) => scopedOrg(REPO_PATH, p) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const m = REPO_PATH.exec(pathOnly(path))!;
      const { login, entry } = orgControl(readControl(), decode(m[1]!))!;
      const name = decode(m[2]!);
      const org = login.toLowerCase();
      const repo = (entry.repositories ?? []).find(
        (r) => r.name.toLowerCase() === name.toLowerCase(),
      );
      if (!repo) {
        journal({ method: 'GET', path, org, body: null, status: 404 });
        return reply(404, { message: 'Not Found' });
      }
      journal({ method: 'GET', path, org, body: null, status: 200 });
      return reply(200, {
        id: repo.id,
        name: repo.name,
        full_name: `${login}/${repo.name}`,
        private: repo.private ?? true,
        visibility: (repo.private ?? true) ? 'private' : 'public',
        owner: { login },
      });
    })
    .persist();

  // ── The newest commit touching `.github/workflows` ─────────────────────────
  pool
    .intercept({ path: (p) => scopedOrg(COMMITS_PATH, p) !== null, method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const m = COMMITS_PATH.exec(pathOnly(path))!;
      const { login, entry } = orgControl(readControl(), decode(m[1]!))!;
      const name = decode(m[2]!);
      const org = login.toLowerCase();
      const repo = (entry.repositories ?? []).find(
        (r) => r.name.toLowerCase() === name.toLowerCase(),
      );
      if (!repo) {
        journal({ method: 'GET', path, org, body: null, status: 404 });
        return reply(404, { message: 'Not Found' });
      }
      journal({ method: 'GET', path, org, body: null, status: 200 });
      const commit = repo.workflowCommit;
      return reply(
        200,
        commit
          ? [{ sha: commit.sha, commit: { committer: { date: commit.date } } }]
          : ([] as object[]),
      );
    })
    .persist();

  // ── The org variable store ─────────────────────────────────────────────────
  const variableCall = (method: 'GET' | 'PATCH' | 'DELETE') => (req: MockRequest) => {
    const path = String(req.path);
    const m = VARIABLE_PATH.exec(pathOnly(path))!;
    const owner = orgControl(readControl(), decode(m[1]!))!;
    const org = owner.login.toLowerCase();
    const name = decode(m[2]!);
    const body = parseBody(req.body);
    const answer = (status: number, data: object | string): MockReply => {
      journal({ method, path, org, body, status });
      return reply(status, data);
    };
    if (!authorised(req, owner)) return answer(401, { message: 'Bad credentials' });

    const store = readStore();
    const vars = (store.variables[org] ??= {});
    if (method === 'GET') {
      const v = vars[name];
      return v
        ? answer(200, { name, value: v.value, visibility: v.visibility })
        : answer(404, { message: 'Not Found' });
    }
    const forced = spendFailure(store, owner.entry);
    if (forced !== null) {
      // Spent, and the variables untouched: a refused write changes nothing.
      writeStore(store);
      return answer(forced, { message: 'Resource not accessible by integration' });
    }
    if (!vars[name]) return answer(404, { message: 'Not Found' });
    if (method === 'DELETE') {
      delete vars[name];
      writeStore(store);
      return answer(204, '');
    }
    vars[name] = {
      value: typeof body?.['value'] === 'string' ? body['value'] : vars[name]!.value,
      visibility:
        typeof body?.['visibility'] === 'string' ? body['visibility'] : vars[name]!.visibility,
    };
    writeStore(store);
    return answer(204, '');
  };

  pool
    .intercept({ path: (p) => scopedOrg(VARIABLE_PATH, p) !== null, method: 'GET' })
    .reply(variableCall('GET'))
    .persist();
  pool
    .intercept({ path: (p) => scopedOrg(VARIABLE_PATH, p) !== null, method: 'PATCH' })
    .reply(variableCall('PATCH'))
    .persist();
  pool
    .intercept({ path: (p) => scopedOrg(VARIABLE_PATH, p) !== null, method: 'DELETE' })
    .reply(variableCall('DELETE'))
    .persist();

  // ── A repository's CodeQL default setup (MOTIR-10289) ─────────────────────
  const defaultSetupCall = (method: 'GET' | 'PATCH') => (req: MockRequest) => {
    const path = String(req.path);
    const m = DEFAULT_SETUP_PATH.exec(pathOnly(path))!;
    const owner = orgControl(readControl(), decode(m[1]!))!;
    const org = owner.login.toLowerCase();
    const name = decode(m[2]!).toLowerCase();
    const body = parseBody(req.body);
    const answer = (status: number, data: object): MockReply => {
      journal({ method, path, org, body, status });
      return reply(status, data);
    };
    if (!authorised(req, owner)) return answer(401, { message: 'Bad credentials' });
    const repo = (owner.entry.repositories ?? []).find((r) => r.name.toLowerCase() === name);
    if (!repo) return answer(404, { message: 'Not Found' });
    const store = readStore();
    const setups = ((store.defaultSetups ??= {})[org] ??= {});
    const current = setups[name] ?? repo.defaultSetup ?? { state: 'not-configured' };
    if (method === 'GET') {
      return answer(200, {
        state: current.state,
        runner_type: current.runnerType ?? 'standard',
        runner_label: current.runnerLabel ?? null,
      });
    }
    if (current.state !== 'configured') {
      return answer(422, { message: 'Code scanning default setup is not configured' });
    }
    const runnerType = body?.['runner_type'] === 'labeled' ? 'labeled' : 'standard';
    const label = body?.['runner_label'];
    setups[name] = {
      state: 'configured',
      runnerType,
      runnerLabel: runnerType === 'labeled' && typeof label === 'string' ? label : null,
    };
    writeStore(store);
    return answer(200, {});
  };
  for (const method of ['GET', 'PATCH'] as const) {
    pool
      .intercept({ path: (p) => scopedOrg(DEFAULT_SETUP_PATH, p) !== null, method })
      .reply(defaultSetupCall(method))
      .persist();
  }

  // The CREATE is on the collection.
  pool
    .intercept({ path: (p) => scopedOrg(VARIABLES_PATH, p) !== null, method: 'POST' })
    .reply((req: MockRequest): MockReply => {
      const path = String(req.path);
      const m = VARIABLES_PATH.exec(pathOnly(path))!;
      const owner = orgControl(readControl(), decode(m[1]!))!;
      const org = owner.login.toLowerCase();
      const body = parseBody(req.body);
      const answer = (status: number, data: object): MockReply => {
        journal({ method: 'POST', path, org, body, status });
        return reply(status, data);
      };
      if (!authorised(req, owner)) return answer(401, { message: 'Bad credentials' });

      const store = readStore();
      const forced = spendFailure(store, owner.entry);
      if (forced !== null) {
        writeStore(store);
        return answer(forced, { message: 'Resource not accessible by integration' });
      }
      const name = typeof body?.['name'] === 'string' ? body['name'] : '';
      const value = typeof body?.['value'] === 'string' ? body['value'] : '';
      if (!name) return answer(422, { message: 'Invalid request' });
      const vars = (store.variables[org] ??= {});
      if (vars[name]) return answer(409, { message: 'Already exists' });
      vars[name] = {
        value,
        visibility: typeof body?.['visibility'] === 'string' ? body['visibility'] : 'all',
      };
      writeStore(store);
      return answer(201, {});
    })
    .persist();
}
