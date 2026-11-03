import { createAppJwt, type GithubAppRole } from '@/lib/github/appAuth';
import { resolveOrgAuth, type GithubOrgTarget } from '@/lib/github/orgTarget';

// App-level reads the fleet READINESS verdict makes (Story MOTIR-8699 ·
// MOTIR-8713). A LEAF PRIMITIVE in the `lib/github/appAuth.ts` sense: services
// import it, routes never do.
//
// ⚠️ NO CACHE, on purpose. `findProvisioningInstallationId` keeps a negative
// cache for the sync's hot path; readiness must see a permission grant the
// minute an org admin presses Save, so every call here asks GitHub.

const GITHUB_API = 'https://api.github.com';
const PAGE_SIZE = 100;
/** A hard stop on `Link` traversal — 100 pages is 10,000 repositories, far past
 *  any org the fleet serves, and it turns a looping `next` into an error rather
 *  than a hang. */
const MAX_PAGES = 100;

/** A GitHub read the readiness verdict needed failed. `status` is null when
 *  GitHub could not be reached. Carries a short detail, never a body or token. */
export class OrgInstallationReadError extends Error {
  readonly code = 'ORG_INSTALLATION_READ_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached (${detail}).`
        : `GitHub refused the read (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'OrgInstallationReadError';
  }
}

export interface OrgInstallation {
  id: string;
  permissions: Record<string, string>;
  events: string[];
  repositorySelection: 'all' | 'selected';
  suspendedAt: string | null;
}

export interface WorkflowCommit {
  sha: string;
  /** ISO-8601 committer date. */
  committedAt: string;
}

async function getJson(url: string, token: string): Promise<{ res: Response; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
        authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    throw new OrgInstallationReadError(null, err instanceof Error ? err.message : 'unknown');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

function refusal(res: Response, body: unknown): OrgInstallationReadError {
  const message =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['message'] : null;
  return new OrgInstallationReadError(
    res.status,
    typeof message === 'string' ? message.slice(0, 200) : '',
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The `rel="next"` URL of a GitHub `Link` header, or null. */
function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * The App's installation on `org`, with its granted permissions and subscribed
 * events — `GET /orgs/{org}/installation` under the App JWT for `role`, the same
 * credential `resolveProvisioningInstallationId` uses. `null` on 404 (not
 * installed). Any other refusal, an unusable App key or a transport failure
 * throws `OrgInstallationReadError`.
 */
export async function getOrgInstallation(
  org: string,
  role: GithubAppRole,
): Promise<OrgInstallation | null> {
  let jwt: string;
  try {
    jwt = createAppJwt(undefined, role);
  } catch {
    throw new OrgInstallationReadError(null, `the ${role} App is not configured`);
  }
  const { res, body } = await getJson(
    `${GITHUB_API}/orgs/${encodeURIComponent(org)}/installation`,
    jwt,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw refusal(res, body);
  const record = asRecord(body);
  const id = record?.['id'];
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new OrgInstallationReadError(res.status, 'installation read returned no id');
  }
  const permissions: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(record?.['permissions']) ?? {})) {
    if (typeof value === 'string') permissions[key] = value;
  }
  const events = Array.isArray(record?.['events'])
    ? (record['events'] as unknown[]).filter((e): e is string => typeof e === 'string')
    : [];
  const suspended = record?.['suspended_at'];
  return {
    id: String(id),
    permissions,
    events,
    repositorySelection: record?.['repository_selection'] === 'all' ? 'all' : 'selected',
    suspendedAt: typeof suspended === 'string' ? suspended : null,
  };
}

/**
 * Every repository id the installation can reach — `GET /installation/repositories`
 * with the target's installation token, paged to the END through `Link`. Never a
 * capped first page: a repository on page two is as much granted as one on page
 * one.
 */
export async function listInstallationRepositoryIds(target: GithubOrgTarget): Promise<number[]> {
  const { token } = await resolveOrgAuth(target);
  const ids: number[] = [];
  let url: string | null = `${GITHUB_API}/installation/repositories?per_page=${PAGE_SIZE}`;
  for (let page = 0; url !== null; page += 1) {
    if (page >= MAX_PAGES) {
      throw new OrgInstallationReadError(null, 'installation repository list did not end');
    }
    const { res, body } = await getJson(url, token);
    if (!res.ok) throw refusal(res, body);
    const repositories = asRecord(body)?.['repositories'];
    if (!Array.isArray(repositories)) {
      throw new OrgInstallationReadError(res.status, 'repository list returned no repositories');
    }
    for (const repo of repositories) {
      const id = asRecord(repo)?.['id'];
      if (typeof id === 'number') ids.push(id);
    }
    url = nextLink(res.headers.get('link'));
  }
  return ids;
}

/**
 * The newest commit on the default branch that touched `.github` — the workflow
 * files AND the local actions under `.github/actions`, which a job's verdict
 * depends on too — or null when there is none. The fleet readiness verdict reads
 * a repository's workflows at this commit (MOTIR-10290).
 */
export async function latestWorkflowCommit(
  target: GithubOrgTarget,
  owner: string,
  name: string,
): Promise<WorkflowCommit | null> {
  const { token } = await resolveOrgAuth(target);
  const { res, body } = await getJson(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
      `/commits?path=.github&per_page=1`,
    token,
  );
  if (!res.ok) throw refusal(res, body);
  if (!Array.isArray(body)) {
    throw new OrgInstallationReadError(res.status, 'commit list was not a list');
  }
  const first = asRecord(body[0]);
  if (!first) return null;
  const sha = first['sha'];
  const date = asRecord(asRecord(asRecord(first['commit'])?.['committer']))?.['date'];
  if (typeof sha !== 'string' || typeof date !== 'string') {
    throw new OrgInstallationReadError(res.status, 'commit carried no sha or date');
  }
  return { sha, committedAt: date };
}

/** More files than any repository the fleet serves keeps under `.github`; a
 *  larger tree is an error rather than an unbounded run of reads. */
const MAX_WORKFLOW_FILES = 120;

/**
 * Every workflow file and local action at `ref`, with its text — what the fleet
 * readiness verdict reads each job from (`lib/ciFleet/workflowJobs.ts`). One tree read, then one read per
 * file. Throws `OrgInstallationReadError` on any refusal, a truncated tree or a
 * file that is not text, so the caller can tell "unchanged" from "could not read".
 */
export async function readWorkflowSources(
  target: GithubOrgTarget,
  owner: string,
  name: string,
  ref: string,
): Promise<Array<{ path: string; text: string }>> {
  const { token } = await resolveOrgAuth(target);
  const repo = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const tree = await getJson(`${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, token);
  if (!tree.res.ok) throw refusal(tree.res, tree.body);
  const treeBody = asRecord(tree.body);
  if (!treeBody || !Array.isArray(treeBody['tree']) || treeBody['truncated'] === true) {
    throw new OrgInstallationReadError(tree.res.status, 'file tree was missing or truncated');
  }
  const paths: string[] = [];
  for (const entry of treeBody['tree']) {
    const rec = asRecord(entry);
    const path = rec?.['path'];
    if (
      rec?.['type'] === 'blob' &&
      typeof path === 'string' &&
      (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ||
        /^\.github\/actions\/.+\/action\.ya?ml$/.test(path))
    ) {
      paths.push(path);
    }
  }
  if (paths.length > MAX_WORKFLOW_FILES) {
    throw new OrgInstallationReadError(tree.res.status, 'too many workflow files');
  }
  const files: Array<{ path: string; text: string }> = [];
  for (const path of paths) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const file = await getJson(`${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, token);
    if (!file.res.ok) throw refusal(file.res, file.body);
    const body = asRecord(file.body);
    if (!body || body['encoding'] !== 'base64' || typeof body['content'] !== 'string') {
      throw new OrgInstallationReadError(file.res.status, 'workflow file was not base64 text');
    }
    files.push({ path, text: Buffer.from(body['content'], 'base64').toString('utf8') });
  }
  return files;
}

/**
 * An action's `action.yml` (or `action.yaml`) at `ref` — `path` is the action's
 * directory inside the repository, `''` for its root — or null when neither file
 * exists there. Read with the org's installation token: an action in another
 * private repository of the org is readable when the installation reaches it,
 * and a PUBLIC action repository is readable by any installation token. Throws
 * `OrgInstallationReadError` on any other refusal (MOTIR-10290).
 */
export async function readActionMetadata(
  target: GithubOrgTarget,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const { token } = await resolveOrgAuth(target);
  const base = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/`;
  const dir = path
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent)
    .join('/');
  for (const file of ['action.yml', 'action.yaml']) {
    const url = `${base}${dir ? `${dir}/` : ''}${file}?ref=${encodeURIComponent(ref)}`;
    const { res, body } = await getJson(url, token);
    if (res.status === 404) continue;
    if (!res.ok) throw refusal(res, body);
    const record = asRecord(body);
    if (!record || record['encoding'] !== 'base64' || typeof record['content'] !== 'string') {
      throw new OrgInstallationReadError(res.status, 'action metadata was not base64 text');
    }
    return Buffer.from(record['content'], 'base64').toString('utf8');
  }
  return null;
}
