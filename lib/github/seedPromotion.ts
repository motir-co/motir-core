import 'server-only';

import { HOSTING_MANIFEST_FILE_NAME } from '@/lib/hosting/manifest';
import { RepoProvisioningApiError, provisioningTransport } from '@/lib/github/repoProvisioning';
import {
  SeedPromotionRefNotFoundError,
  SeedPromotionTemplateNameTakenError,
} from '@/lib/seedRegistry/errors';

// PROMOTE-TO-STARTER's GitHub side (Story MOTIR-704 · MOTIR-710; decision
// MOTIR-706 v2 §3.6). Three calls, each on a credential the caller resolved
// (`provisioningAuth` / `resolveOrgAuth`): resolve a ref to its commit, read the
// hosting manifest AT that commit, and copy that commit's tree into a new
// TEMPLATE repository in Motir's org.
//
// ⚠️ WHY A COPY, AND WHY FROM THE TREE. Establish seeds through
// `POST /repos/{owner}/{template}/generate`, which (a) refuses a repository that
// is not a template and (b) copies the template's DEFAULT BRANCH, never a ref.
// Pointing an entry at the live project repository would therefore seed the next
// project from whatever was last pushed there. So the copy is written from the
// ref's own tree through the git data API: every blob, one tree, one root
// commit, the branch forced to it, then `is_template`. Later commits to the
// project never reach the starter.
//
// Every request goes through `provisioningTransport`, so it is stubbed at the
// same HTTP boundary as establish in the tests.

const GITHUB_API = 'https://api.github.com';
/** Blobs copied at once — enough to keep a starter's few hundred files quick,
 *  few enough to stay inside GitHub's secondary rate limit on content creation. */
const BLOB_COPY_CONCURRENCY = 8;

const { request, readJson, asRecord, errorDetail, isNameCollision, awaitReady } =
  provisioningTransport;

/** A repository on GitHub and the token that reaches it. */
export interface GithubRepoAccess {
  owner: string;
  repo: string;
  token: string;
}

/** A ref resolved to the commit it names. */
export interface ResolvedCommit {
  sha: string;
  treeSha: string;
}

function repoPath(access: Pick<GithubRepoAccess, 'owner' | 'repo'>): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(access.owner)}/${encodeURIComponent(access.repo)}`;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** The template copy's description. Re-reading it is how a retry after a crash
 *  between the copy and the entry write recognises its own repository. */
export function templateCopyDescription(key: string, source: string, sha: string): string {
  return `Motir starter "${key}", promoted from ${source} at ${sha.slice(0, 12)}.`;
}

function isOwnCopy(description: string | null, key: string): boolean {
  return description?.startsWith(`Motir starter "${key}",`) ?? false;
}

export const seedPromotionGithub = {
  /**
   * The commit a branch, tag or SHA names on `source`.
   *
   * @throws SeedPromotionRefNotFoundError when GitHub knows no such ref (404, or
   *   the 422 it answers for a malformed one).
   */
  async resolveCommit(source: GithubRepoAccess, ref: string): Promise<ResolvedCommit> {
    const res = await request(`${repoPath(source)}/commits/${encodeURIComponent(ref)}`, {
      method: 'GET',
      headers: authHeaders(source.token),
    });
    if (res.status === 404 || res.status === 422) {
      throw new SeedPromotionRefNotFoundError(`${source.owner}/${source.repo}`, ref);
    }
    const body = await readJson(res);
    if (!res.ok) throw new RepoProvisioningApiError(res.status, errorDetail(body));
    const sha = body?.['sha'];
    const treeSha = asRecord(asRecord(body?.['commit'])?.['tree'])?.['sha'];
    if (typeof sha !== 'string' || typeof treeSha !== 'string') {
      throw new RepoProvisioningApiError(res.status, 'commit read returned an unexpected shape');
    }
    return { sha, treeSha };
  },

  /** The hosting manifest's text at `commitSha`, or null when the repository has
   *  none there — `parseHostingManifest` turns null into its missing error. */
  async readHostingManifest(source: GithubRepoAccess, commitSha: string): Promise<string | null> {
    const res = await request(
      `${repoPath(source)}/contents/${encodeURIComponent(HOSTING_MANIFEST_FILE_NAME)}` +
        `?ref=${encodeURIComponent(commitSha)}`,
      { method: 'GET', headers: authHeaders(source.token) },
    );
    if (res.status === 404) return null;
    const body = await readJson(res);
    if (!res.ok) throw new RepoProvisioningApiError(res.status, errorDetail(body));
    const content = body?.['content'];
    if (body?.['type'] !== 'file' || typeof content !== 'string') return null;
    return Buffer.from(content, 'base64').toString('utf8');
  },

  /**
   * Copy `commit`'s tree on `source` into a new private TEMPLATE repository
   * `target.org/name`, as one root commit on its default branch.
   *
   * A retry adopts its own earlier copy (recognised by its description) and
   * rewrites the branch to the same tree, so a crash between the copy and the
   * entry write is recovered by promoting again.
   *
   * @throws SeedPromotionTemplateNameTakenError when Motir's org already has a
   *   repository by that name that is not this starter's copy.
   */
  async copyCommitAsTemplate(input: {
    source: GithubRepoAccess;
    commit: ResolvedCommit;
    target: { org: string; token: string };
    name: string;
    key: string;
  }): Promise<{ owner: string; repo: string }> {
    const { source, commit, target, name, key } = input;
    const sourceName = `${source.owner}/${source.repo}`;
    const copy = { owner: target.org, repo: name };
    const description = templateCopyDescription(key, sourceName, commit.sha);

    const created = await request(`${GITHUB_API}/orgs/${encodeURIComponent(target.org)}/repos`, {
      method: 'POST',
      headers: authHeaders(target.token),
      // `auto_init`: the git data API refuses blobs on an EMPTY repository, so
      // the copy starts from GitHub's initial commit and the branch is then
      // forced to a root commit of the source tree, leaving that commit behind.
      body: JSON.stringify({ name, description, private: true, auto_init: true }),
    });
    if (!created.ok) {
      const body = await readJson(created);
      if (!isNameCollision(created.status, body)) {
        throw new RepoProvisioningApiError(created.status, errorDetail(body));
      }
      const existing = await request(repoPath(copy), {
        method: 'GET',
        headers: authHeaders(target.token),
      });
      const existingBody = await readJson(existing);
      const existingDescription = existingBody?.['description'];
      if (
        !existing.ok ||
        !isOwnCopy(typeof existingDescription === 'string' ? existingDescription : null, key)
      ) {
        throw new SeedPromotionTemplateNameTakenError(`${target.org}/${name}`);
      }
    }
    const ready = await awaitReady(target.org, name, target.token);

    const entries = await readTree(source, commit.treeSha);
    const blobShas = [...new Set(entries.filter((e) => e.type === 'blob').map((e) => e.sha))];
    for (let i = 0; i < blobShas.length; i += BLOB_COPY_CONCURRENCY) {
      await Promise.all(
        blobShas
          .slice(i, i + BLOB_COPY_CONCURRENCY)
          .map((sha) => copyBlob(source, copy, target.token, sha)),
      );
    }

    const tree = await postJson(copy, target.token, '/git/trees', {
      tree: entries
        .filter((e) => e.type === 'blob' || e.type === 'commit')
        .map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha })),
    });
    const rootCommit = await postJson(copy, target.token, '/git/commits', {
      message: `Promote ${sourceName} at ${commit.sha.slice(0, 12)} as the "${key}" starter`,
      tree: stringField(tree, 'sha'),
      parents: [],
    });
    await sendJson(
      copy,
      target.token,
      'PATCH',
      `/git/refs/heads/${encodeURIComponent(ready.defaultBranch)}`,
      { sha: stringField(rootCommit, 'sha'), force: true },
    );
    await sendJson(copy, target.token, 'PATCH', '', { is_template: true, description });
    return copy;
  },
};

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
}

/** The commit's whole tree, recursively. A truncated listing is refused rather
 *  than copied short: a starter missing files is worse than no starter. */
async function readTree(source: GithubRepoAccess, treeSha: string): Promise<TreeEntry[]> {
  const res = await request(
    `${repoPath(source)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
    { method: 'GET', headers: authHeaders(source.token) },
  );
  const body = await readJson(res);
  if (!res.ok) throw new RepoProvisioningApiError(res.status, errorDetail(body));
  if (body?.['truncated'] === true) {
    throw new RepoProvisioningApiError(res.status, 'the source tree is too large to copy');
  }
  const tree = body?.['tree'];
  if (!Array.isArray(tree)) {
    throw new RepoProvisioningApiError(res.status, 'tree read returned an unexpected shape');
  }
  const entries = tree.map(asRecord).filter((e): e is Record<string, unknown> => e !== null);
  const out = entries.filter(
    (e): e is Record<string, unknown> & TreeEntry =>
      typeof e['path'] === 'string' &&
      typeof e['mode'] === 'string' &&
      typeof e['sha'] === 'string' &&
      (e['type'] === 'blob' || e['type'] === 'tree' || e['type'] === 'commit'),
  );
  if (!out.some((e) => e.type === 'blob')) {
    throw new RepoProvisioningApiError(res.status, 'the source tree has no files to copy');
  }
  return out.map(({ path, mode, type, sha }) => ({ path, mode, type, sha }));
}

/** One blob, read from the source and written to the copy. Git addresses blobs
 *  by content, so the copy's sha is the source's and the tree can name it. */
async function copyBlob(
  source: GithubRepoAccess,
  copy: { owner: string; repo: string },
  token: string,
  sha: string,
): Promise<void> {
  const res = await request(`${repoPath(source)}/git/blobs/${encodeURIComponent(sha)}`, {
    method: 'GET',
    headers: authHeaders(source.token),
  });
  const body = await readJson(res);
  if (!res.ok) throw new RepoProvisioningApiError(res.status, errorDetail(body));
  const content = body?.['content'];
  if (typeof content !== 'string') {
    throw new RepoProvisioningApiError(res.status, 'blob read returned an unexpected shape');
  }
  await postJson(copy, token, '/git/blobs', {
    content: content.replace(/\n/g, ''),
    encoding: 'base64',
  });
}

async function postJson(
  repo: { owner: string; repo: string },
  token: string,
  path: string,
  payload: unknown,
): Promise<Record<string, unknown> | null> {
  return sendJson(repo, token, 'POST', path, payload);
}

async function sendJson(
  repo: { owner: string; repo: string },
  token: string,
  method: 'POST' | 'PATCH',
  path: string,
  payload: unknown,
): Promise<Record<string, unknown> | null> {
  const res = await request(`${repoPath(repo)}${path}`, {
    method,
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  const body = await readJson(res);
  if (!res.ok) throw new RepoProvisioningApiError(res.status, errorDetail(body));
  return body;
}

function stringField(body: Record<string, unknown> | null, field: string): string {
  const value = body?.[field];
  if (typeof value !== 'string') {
    throw new RepoProvisioningApiError(null, `GitHub answered without a ${field}`);
  }
  return value;
}
