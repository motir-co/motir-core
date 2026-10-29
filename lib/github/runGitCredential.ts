import type { ProjectRepoState, ProjectRepoTakeoverState } from '@/generated/prisma/client';
import {
  createAppJwt,
  GithubAppNotConfiguredError,
  GithubAppTokenError,
  type GithubAppRole,
} from '@/lib/github/appAuth';
import { decryptToken, encryptToken } from '@/lib/github/tokenCrypto';
import { DispatchRunNotFoundError, RunCredentialRunNotLiveError } from '@/lib/dispatchRuns/errors';
import {
  HostedRunRepositoryNotWritableError,
  RunGitCredentialUnavailableError,
  type RunGitWriteFix,
  type RunGitWriteRefusal,
} from '@/lib/hostedRuns/errors';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { dispatchRunGitCredentialRepository } from '@/lib/repositories/dispatchRunGitCredentialRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import type { ProjectRepoWithRealized } from '@/lib/mappers/projectRepoMappers';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// A HOSTED RUN'S GIT CREDENTIALS (Story MOTIR-683 · MOTIR-6449;
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §2, §5, §6, §8).
//
// A hosted run writes to git AS MOTIR'S GITHUB APP, never as a person: the
// dispatcher needs no GitHub account, and no code path here reads a person's
// GitHub token. The unit is the RUN — its repositories are the union of its legs'
// repository sets — so everything below is sized to the run, never to one card or
// one repository.
//
// ONE APP PER REPOSITORY, picked from the project repository's establish state,
// never guessed from an owner login:
//
//   - `created` (Motir made it, and it is still in Motir's organisation) →
//     `motir-studio`, the App installed on Motir's own organisation;
//   - `connected`, or a `created` repository whose takeover has moved it to the
//     team's account → `motir-integration`, the App the team installed.
//
// THE CREDENTIAL is an installation access token, minted UNCACHED — the shipped
// `mintInstallationToken` in `appAuth.ts` is cached process-wide, installation-wide
// and all-permission, none of which may reach a container — ONE PER INSTALLATION
// the run's repositories span, narrowed with `repository_ids` to exactly the run's
// repositories in that installation and to `contents: write` + `pull_requests:
// write`, plus `workflows: write` when the installation holds it
// (`hosted-run-runs-the-cli-as-the-app.md` AMENDMENT 2026-10-29). GitHub fixes its life at one hour; the run asks again through its
// git-credential route (MOTIR-6538) for as long as it runs. Every token minted is
// RECORDED (encrypted) so the end path can revoke it — `DELETE /installation/token`
// authenticates with the token itself, so a token nobody kept cannot be revoked.

const GITHUB_API = 'https://api.github.com';

/** The two Apps a hosted run writes with. */
export type RunGitApp = 'motir-studio' | 'motir-integration';

const ROLE: Record<RunGitApp, GithubAppRole> = {
  'motir-studio': 'provisioning',
  'motir-integration': 'user-facing',
};

const APP_LABEL: Record<RunGitApp, string> = {
  'motir-studio': 'Motir Studio',
  'motir-integration': 'Motir Integration',
};

/** The permissions every run token is narrowed to (§5). Never `administration`. */
export const RUN_GIT_PERMISSIONS = { contents: 'write', pull_requests: 'write' } as const;

/**
 * Added to a build run's narrowing when the installation holds it (AMENDMENT 2026-10-29),
 * so a run can push `.github/workflows/` changes. Not required: an installation that has
 * not accepted it still runs, and a workflow change fails at push as before. Asking for a
 * permission the installation lacks would fail the whole mint, hence "when held".
 */
export const RUN_GIT_WORKFLOWS_PERMISSION = { workflows: 'write' } as const;

/**
 * A REVIEW run's narrowing (MOTIR-6820; `hosted-agent-run.md` §8.3): it pushes nothing,
 * so its installation token is requested with `contents: read` ONLY — it can fetch the
 * pull requests at their reviewed heads and can write nothing.
 */
export const RUN_GIT_REVIEW_PERMISSIONS = { contents: 'read' } as const;

/** What a run needs of a repository: a build writes it, a review only reads it. */
export type RunGitNeed = 'write' | 'read';

/** The permissions a run's token is narrowed to, by what its command does and what the
 *  installation holds. */
function permissionsFor(
  command: string,
  installationPermissions: Record<string, string>,
): Record<string, string> {
  if (command === 'review') return RUN_GIT_REVIEW_PERMISSIONS;
  return canWrite(installationPermissions['workflows'])
    ? { ...RUN_GIT_PERMISSIONS, ...RUN_GIT_WORKFLOWS_PERMISSION }
    : RUN_GIT_PERMISSIONS;
}

/**
 * Which App writes a project repository. A `created` repository stays Motir's
 * until its takeover has TRANSFERRED it (`awaiting_reinstall` onwards): before
 * that it is still in Motir's organisation, where only `motir-studio` reaches it.
 */
export function runGitAppFor(row: {
  state: ProjectRepoState;
  takeoverState: ProjectRepoTakeoverState | null;
}): RunGitApp {
  if (row.state !== 'created') return 'motir-integration';
  return row.takeoverState === 'awaiting_reinstall' || row.takeoverState === 'done'
    ? 'motir-integration'
    : 'motir-studio';
}

/** One repository of a run. */
export interface RunRepository {
  projectRepoId: string;
  /** `owner/name`. */
  repository: string;
  /** GitHub's numeric repository id, as a string — what `repository_ids` names. */
  providerRepoId: string;
  app: RunGitApp;
}

/** One repository's answer from {@link hostedRunWriteAccess}. */
export type RunGitWriteAccess =
  | { repository: string; app: RunGitApp; ok: true }
  | ({ app: RunGitApp; ok: false } & RunGitWriteRefusal);

/** What the run is handed for one repository. Repositories in one installation
 *  share a token. */
export interface RunGitCredentialEntry {
  repository: string;
  /** The secret. Put on the wire; never log or echo it. */
  token: string;
  expiresAt: Date;
  /** The App's bot, as git's author and committer — never the dispatcher. */
  author: { name: string; email: string };
}

/** The outcome of revoking one recorded token — never a throw. */
export interface RunGitRevokeResult {
  credentialId: string;
  installationId: string;
  repositories: string[];
  /** `expired`: GitHub's own expiry passed, nothing was called. */
  status: 'revoked' | 'expired' | 'failed';
  detail: string | null;
}

// ── GitHub ────────────────────────────────────────────────────────────────

/** A GitHub call, or a typed "could not ask". */
async function github(
  path: string,
  init: { method?: string; authorization?: string; body?: unknown },
): Promise<Response> {
  try {
    return await fetch(`${GITHUB_API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.authorization ? { authorization: init.authorization } : {}),
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'motir',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (err) {
    throw new RunGitCredentialUnavailableError(
      'github_unavailable',
      `GitHub could not be reached (${err instanceof Error ? err.message : 'unknown'})`,
    );
  }
}

/** The App JWT for `app`, or the not-configured error. */
function appJwt(app: RunGitApp): string {
  try {
    return createAppJwt(undefined, ROLE[app]);
  } catch (err) {
    if (err instanceof GithubAppNotConfiguredError || err instanceof GithubAppTokenError) {
      throw new RunGitCredentialUnavailableError(
        'not_configured',
        `the ${APP_LABEL[app]} app is not configured on this deployment`,
      );
    }
    throw err;
  }
}

interface InstallationOnRepo {
  id: string;
  /** The account the installation is on (`<account>` in the refusal). */
  account: string;
  permissions: Record<string, string>;
  suspended: boolean;
  /** The installation's settings page, where an owner accepts permissions. */
  htmlUrl: string | null;
}

/** `app`'s installation that reaches `repository`, or null when there is none —
 *  GitHub answers 404 both when the App is not installed on the account and when
 *  the repository is not among the installation's selected ones. */
async function installationOn(
  app: RunGitApp,
  repository: string,
): Promise<InstallationOnRepo | null> {
  const res = await github(`/repos/${repository}/installation`, {
    authorization: `Bearer ${appJwt(app)}`,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new RunGitCredentialUnavailableError(
      'github_unavailable',
      `GitHub answered ${res.status} when asked for the ${APP_LABEL[app]} installation on ${repository}`,
    );
  }
  const body = (await res.json()) as {
    id?: number | string | null;
    account?: { login?: string } | null;
    permissions?: Record<string, string>;
    suspended_at?: string | null;
    html_url?: string | null;
  };
  if (body.id === undefined || body.id === null) {
    throw new RunGitCredentialUnavailableError(
      'github_unavailable',
      'GitHub answered an installation with no id',
    );
  }
  return {
    id: String(body.id),
    account: body.account?.login ?? repository.split('/')[0] ?? repository,
    permissions: body.permissions ?? {},
    suspended: Boolean(body.suspended_at),
    htmlUrl: body.html_url ?? null,
  };
}

const canWrite = (level: string | undefined) => level === 'write' || level === 'admin';
const canRead = (level: string | undefined) => level === 'read' || canWrite(level);

/** The two refusals, verbatim from the decision (§8). */
const REFUSAL: Record<RunGitWriteFix, (repository: string, account: string) => string> = {
  reconnect: (repository) =>
    `Motir Integration can no longer reach ${repository} — reconnect it in the Repositories room`,
  accept_permissions: (repository, account) =>
    `hosted runs on ${repository} need Motir Integration's updated permissions — an owner of ${account} accepts them on GitHub`,
};

type RepoAccess =
  | { ok: true; installation: InstallationOnRepo }
  | { ok: false; refusal: RunGitWriteRefusal };

/** Whether `app` can write (or, for a review, read) `repository`, with the installation
 *  when it can. */
async function accessFor(
  repository: string,
  app: RunGitApp,
  need: RunGitNeed = 'write',
): Promise<RepoAccess> {
  const installation = await installationOn(app, repository);
  if (app === 'motir-studio') {
    // Motir's own App not reaching a repository Motir created is an operational
    // fault, not something a person can fix — so not one of the two refusals.
    if (installation === null || installation.suspended) {
      throw new RunGitCredentialUnavailableError(
        'github_unavailable',
        `the Motir Studio app does not reach ${repository}`,
      );
    }
    return { ok: true, installation };
  }
  if (installation === null || installation.suspended) {
    return {
      ok: false,
      refusal: {
        repository,
        reason: REFUSAL.reconnect(repository, ''),
        fix: 'reconnect',
        fixUrl: null,
      },
    };
  }
  const lacking =
    need === 'read'
      ? !canRead(installation.permissions['contents'])
      : !canWrite(installation.permissions['contents']) ||
        !canWrite(installation.permissions['pull_requests']);
  if (lacking) {
    return {
      ok: false,
      refusal: {
        repository,
        reason: REFUSAL.accept_permissions(repository, installation.account),
        fix: 'accept_permissions',
        fixUrl: installation.htmlUrl,
      },
    };
  }
  return { ok: true, installation };
}

// ── The bot author, per App ───────────────────────────────────────────────

const botAuthors = new Map<RunGitApp, Promise<{ name: string; email: string }>>();

/** The App's bot identity — `<slug>[bot]` and its noreply address — read once per
 *  process: the slug from the App's own `GET /app`, the bot's user id from
 *  `GET /users/<slug>[bot]`. A failed read is not cached. */
export function runGitBotAuthor(app: RunGitApp): Promise<{ name: string; email: string }> {
  const cached = botAuthors.get(app);
  if (cached) return cached;
  const pending = (async () => {
    const appRes = await github('/app', { authorization: `Bearer ${appJwt(app)}` });
    const appBody = appRes.ok ? ((await appRes.json()) as { slug?: string }) : {};
    if (!appBody.slug) {
      throw new RunGitCredentialUnavailableError(
        'github_unavailable',
        `GitHub answered ${appRes.status} when asked for the ${APP_LABEL[app]} app`,
      );
    }
    const login = `${appBody.slug}[bot]`;
    const userRes = await github(`/users/${encodeURIComponent(login)}`, {});
    const userBody = userRes.ok ? ((await userRes.json()) as { id?: number | string }) : {};
    if (userBody.id === undefined || userBody.id === null) {
      throw new RunGitCredentialUnavailableError(
        'github_unavailable',
        `GitHub answered ${userRes.status} when asked for ${login}`,
      );
    }
    return { name: login, email: `${userBody.id}+${login}@users.noreply.github.com` };
  })();
  botAuthors.set(app, pending);
  pending.catch(() => botAuthors.delete(app));
  return pending;
}

/** Test seam: forget the per-process bot identities. */
export function _resetRunGitBotAuthors(): void {
  botAuthors.clear();
}

// ── The run's repositories ────────────────────────────────────────────────

async function findRun(dispatchRunId: string) {
  const run = await withSystemContext((tx) => dispatchRunRepository.findById(dispatchRunId, tx));
  if (!run) throw new DispatchRunNotFoundError(dispatchRunId);
  return run;
}

/**
 * The run's repository set: the union of its legs' repository sets, in project
 * repository order. A leg whose card names no repository is on the project's
 * PRIMARY repository, as its dispatch prompt is (`resolveDispatchRepos`).
 */
export async function runRepositories(dispatchRunId: string): Promise<RunRepository[]> {
  const run = await findRun(dispatchRunId);
  const itemIds = await withWorkspaceServiceContext(run.workspaceId, async (tx) => {
    const legs = await dispatchRunCardRepository.listByRun(run.id, tx);
    return legs.map((l) => l.workItemId).filter((id): id is string => id !== null);
  });
  // A REPAIR (`hosted-agent-run.md` §8.6, MOTIR-6928) pushes to its pull requests' own
  // branches, so its set is the repositories of those pull requests — not the card's
  // target set, which may name a repository nothing was delivered to.
  if (run.command === 'fix') return repositoriesForRepair(run.projectId, run.workspaceId, itemIds);
  return repositoriesForItems(run.projectId, run.workspaceId, itemIds);
}

/**
 * The repository set a REPAIR over `itemIds` pushes to (Story MOTIR-1626 · MOTIR-6928;
 * `hosted-agent-run.md` §8.6): the project repositories behind the cards' OPEN pull
 * requests — the delivery set the repair claim hands over — in project repository order.
 * A merged or closed member cannot be pushed to, so it adds nothing. Refuses, as
 * {@link repositoriesForItems} does, a set with no repository in it.
 */
export async function repositoriesForRepair(
  projectId: string,
  workspaceId: string,
  itemIds: readonly string[],
): Promise<RunRepository[]> {
  const set = await withWorkspaceServiceContext(workspaceId, async (tx) => {
    const deliveries = await workItemDeliveryRepository.listByWorkItems([...itemIds], tx);
    const open = new Set(
      deliveries
        .filter((d) => d.pullRequest.state === 'open' && !d.pullRequest.merged)
        .map((d) => d.repoId),
    );
    const projectRows = await projectRepoRepository.listByProject(projectId, workspaceId, tx);
    return projectRows.filter((row) => row.githubRepoId !== null && open.has(row.githubRepoId));
  });
  if (set.length === 0) {
    throw new RunGitCredentialUnavailableError(
      'no_repository',
      'the repair covers no open pull request in a repository of its project',
    );
  }
  return set.map(toRunRepository);
}

/**
 * The repository set a run over `itemIds` WOULD cover — {@link runRepositories}'
 * rule, answered from the cards rather than from a run. The start path (MOTIR-690)
 * needs it BEFORE a run exists: it refuses a run that could not write, and a
 * refusal must open nothing.
 */
export async function repositoriesForItems(
  projectId: string,
  workspaceId: string,
  itemIds: readonly string[],
): Promise<RunRepository[]> {
  const { rows, chosen } = await withWorkspaceServiceContext(workspaceId, async (tx) => {
    const refs = await workItemRepoRepository.listByWorkItems([...itemIds], tx);
    const projectRows = await projectRepoRepository.listByProject(projectId, workspaceId, tx);
    const picked = new Set(refs.map((r) => r.projectRepoId));
    const itemsWithRefs = new Set(refs.map((r) => r.workItemId));
    const primary = projectRows[0];
    if (primary && itemIds.some((id) => !itemsWithRefs.has(id))) picked.add(primary.id);
    return { rows: projectRows, chosen: picked };
  });

  const set = rows.filter((row) => chosen.has(row.id));
  if (set.length === 0) {
    throw new RunGitCredentialUnavailableError(
      'no_repository',
      'the run covers no repository of its project',
    );
  }
  return set.map(toRunRepository);
}

/** One project repository as a run's repository, refusing one with nothing on GitHub. */
function toRunRepository(row: ProjectRepoWithRealized): RunRepository {
  if (!row.githubRepo) {
    throw new RunGitCredentialUnavailableError(
      'repository_unrealized',
      `the project repository "${row.name}" has no repository on GitHub yet`,
    );
  }
  return {
    projectRepoId: row.id,
    repository: `${row.githubRepo.owner}/${row.githubRepo.name}`,
    providerRepoId: row.githubRepo.repoId,
    app: runGitAppFor(row),
  };
}

// ── The check ─────────────────────────────────────────────────────────────

/**
 * Whether each repository can be written by its App — one answer per repository,
 * in the order given. The run can write only when every answer is ok. A pure
 * read: nothing is minted. The start path refuses on it, and the Repositories room
 * shows it. `need: 'read'` asks the same question at the read level — a REVIEW run's
 * pre-flight (MOTIR-6820), which only needs `contents: read`.
 */
export async function hostedRunWriteAccess(
  repos: readonly Pick<RunRepository, 'repository' | 'app'>[],
  need: RunGitNeed = 'write',
): Promise<RunGitWriteAccess[]> {
  const out: RunGitWriteAccess[] = [];
  for (const { repository, app } of repos) {
    if (app === 'motir-studio') {
      appJwt(app); // configured, or the typed error
      out.push({ repository, app, ok: true });
      continue;
    }
    const access = await accessFor(repository, app, need);
    out.push(access.ok ? { repository, app, ok: true } : { app, ok: false, ...access.refusal });
  }
  return out;
}

// ── The mint ──────────────────────────────────────────────────────────────

/**
 * Mint the run's git credentials: ONE uncached installation token per App
 * installation the run's repositories span, narrowed to exactly the run's
 * repositories in it and to {@link RUN_GIT_PERMISSIONS}, each recorded against
 * the run. Returns one entry per repository, in the run's order.
 *
 * Refuses a run that does not exist or is no longer `running`, and a run with a
 * repository its App cannot write (`HostedRunRepositoryNotWritableError`, naming
 * every such repository) — recording nothing in either case.
 */
export async function mintRunGitCredentials(
  dispatchRunId: string,
): Promise<RunGitCredentialEntry[]> {
  const run = await findRun(dispatchRunId);
  if (run.status !== 'running') throw new RunCredentialRunNotLiveError(run.id, run.status);
  const repos = await runRepositories(run.id);

  // Resolve every repository's installation before minting anything, so a run
  // that cannot write one repository is refused with all of them named.
  const resolved: { repo: RunRepository; installation: InstallationOnRepo }[] = [];
  const refusals: RunGitWriteRefusal[] = [];
  const need: RunGitNeed = run.command === 'review' ? 'read' : 'write';
  for (const repo of repos) {
    const access = await accessFor(repo.repository, repo.app, need);
    if (access.ok) resolved.push({ repo, installation: access.installation });
    else refusals.push(access.refusal);
  }
  if (refusals.length > 0) throw new HostedRunRepositoryNotWritableError(refusals);

  const groups = new Map<
    string,
    {
      app: RunGitApp;
      installationId: string;
      installationPermissions: Record<string, string>;
      repos: RunRepository[];
    }
  >();
  for (const { repo, installation } of resolved) {
    const key = `${repo.app}:${installation.id}`;
    const group = groups.get(key) ?? {
      app: repo.app,
      installationId: installation.id,
      installationPermissions: installation.permissions,
      repos: [],
    };
    group.repos.push(repo);
    groups.set(key, group);
  }

  const minted: {
    app: RunGitApp;
    installationId: string;
    installationPermissions: Record<string, string>;
    repos: RunRepository[];
    token: string;
    expiresAt: Date;
  }[] = [];
  for (const group of groups.values()) {
    const res = await github(`/app/installations/${group.installationId}/access_tokens`, {
      method: 'POST',
      authorization: `Bearer ${appJwt(group.app)}`,
      body: {
        // By id, not name: a rename between resolve and mint cannot widen it.
        repository_ids: group.repos.map((r) => Number(r.providerRepoId)),
        permissions: permissionsFor(run.command, group.installationPermissions),
      },
    });
    if (!res.ok) {
      throw new RunGitCredentialUnavailableError(
        'github_unavailable',
        `GitHub answered ${res.status} when minting the run's token on ${group.repos
          .map((r) => r.repository)
          .join(', ')}`,
      );
    }
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token || !body.expires_at) {
      throw new RunGitCredentialUnavailableError(
        'github_unavailable',
        'GitHub answered a token response with an unexpected shape',
      );
    }
    minted.push({ ...group, token: body.token, expiresAt: new Date(body.expires_at) });
  }

  const authors = new Map<RunGitApp, { name: string; email: string }>();
  for (const m of minted) {
    if (!authors.has(m.app)) authors.set(m.app, await runGitBotAuthor(m.app));
  }

  await withWorkspaceServiceContext(run.workspaceId, (tx) =>
    dispatchRunGitCredentialRepository.createMany(
      minted.map((m) => ({
        workspaceId: run.workspaceId,
        dispatchRunId: run.id,
        app: m.app,
        installationId: m.installationId,
        repositories: m.repos.map((r) => r.repository),
        tokenEncrypted: encryptToken(m.token),
        expiresAt: m.expiresAt,
      })),
      tx,
    ),
  );

  const byRepo = new Map<string, RunGitCredentialEntry>();
  for (const m of minted) {
    for (const r of m.repos) {
      byRepo.set(r.repository, {
        repository: r.repository,
        token: m.token,
        expiresAt: m.expiresAt,
        author: authors.get(m.app)!,
      });
    }
  }
  return repos.map((r) => byRepo.get(r.repository)!);
}

// ── The revoke ────────────────────────────────────────────────────────────

/**
 * Revoke every token recorded for the run with `DELETE /installation/token`, and
 * delete the rows it has dealt with. NEVER throws: each token's outcome is a typed
 * result the end path records on the run, and GitHub's one-hour expiry is the
 * backstop. A token already past its expiry is not called for (`expired`); a
 * token GitHub already considers dead (401 / 404) counts as revoked. A FAILED
 * revoke keeps its row, so a later call can try it again.
 */
export async function revokeRunGitCredentials(
  dispatchRunId: string,
  opts: { now?: Date } = {},
): Promise<RunGitRevokeResult[]> {
  const now = opts.now ?? new Date();
  let workspaceId: string;
  try {
    const run = await withSystemContext((tx) => dispatchRunRepository.findById(dispatchRunId, tx));
    if (!run) return [];
    workspaceId = run.workspaceId;
  } catch {
    return [];
  }

  let rows: Awaited<ReturnType<typeof dispatchRunGitCredentialRepository.listByRun>>;
  try {
    rows = await withWorkspaceServiceContext(workspaceId, (tx) =>
      dispatchRunGitCredentialRepository.listByRun(dispatchRunId, tx),
    );
  } catch (err) {
    return [
      {
        credentialId: '',
        installationId: '',
        repositories: [],
        status: 'failed',
        detail: `the run's recorded tokens could not be read (${err instanceof Error ? err.message : 'unknown'})`,
      },
    ];
  }

  const results: RunGitRevokeResult[] = [];
  for (const row of rows) {
    const base = {
      credentialId: row.id,
      installationId: row.installationId,
      repositories: row.repositories,
    };
    if (row.expiresAt.getTime() <= now.getTime()) {
      results.push({ ...base, status: 'expired', detail: null });
      continue;
    }
    try {
      const res = await fetch(`${GITHUB_API}/installation/token`, {
        method: 'DELETE',
        headers: {
          authorization: `token ${decryptToken(row.tokenEncrypted)}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'motir',
        },
      });
      results.push(
        res.ok || res.status === 401 || res.status === 404
          ? { ...base, status: 'revoked', detail: null }
          : { ...base, status: 'failed', detail: `GitHub answered ${res.status}` },
      );
    } catch (err) {
      results.push({
        ...base,
        status: 'failed',
        detail: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  const done = results.filter((r) => r.status !== 'failed').map((r) => r.credentialId);
  try {
    await withWorkspaceServiceContext(workspaceId, (tx) =>
      dispatchRunGitCredentialRepository.deleteByIds(done, tx),
    );
  } catch {
    // The rows stay; their tokens are revoked or expired, so a later call finds
    // them expired or answered 401/404 — revoked either way.
  }
  return results;
}

// ── An agent instance's CLONE credential (MOTIR-6872) ─────────────────────

/** The permissions an instance's clone token is narrowed to: READ, nothing else. */
export const INSTANCE_CLONE_PERMISSIONS = { contents: 'read' } as const;

/** One short-lived clone token and the repositories (`owner/name`) it reaches. */
export interface InstanceCloneCredential {
  repositories: string[];
  /** The secret. Handed to one exec's argv; never logged, stored or echoed. */
  token: string;
  expiresAt: Date;
}

/**
 * Mint the CLONE credentials for a new agent instance
 * (`docs/decisions/agent-instances.md` §1): one uncached installation token per
 * App installation the project's repositories span, narrowed to exactly those
 * repositories and to {@link INSTANCE_CLONE_PERMISSIONS}. NOTHING is recorded —
 * the caller revokes each token the moment its clone returns
 * ({@link revokeInstanceCloneCredential}), and GitHub's one-hour expiry is the
 * backstop.
 *
 * A project repository with no repository on GitHub yet is skipped (there is
 * nothing to clone), and a project with none at all answers `[]`.
 */
export async function mintProjectReadCredentials(
  projectId: string,
  workspaceId: string,
): Promise<InstanceCloneCredential[]> {
  const rows = await withWorkspaceServiceContext(workspaceId, (tx) =>
    projectRepoRepository.listByProject(projectId, workspaceId, tx),
  );
  const repos: RunRepository[] = rows.flatMap((row) =>
    row.githubRepo
      ? [
          {
            projectRepoId: row.id,
            repository: `${row.githubRepo.owner}/${row.githubRepo.name}`,
            providerRepoId: row.githubRepo.repoId,
            app: runGitAppFor(row),
          },
        ]
      : [],
  );
  if (repos.length === 0) return [];

  const groups = new Map<
    string,
    { app: RunGitApp; installationId: string; repos: RunRepository[] }
  >();
  for (const repo of repos) {
    const installation = await installationOn(repo.app, repo.repository);
    if (installation === null || installation.suspended) {
      throw new RunGitCredentialUnavailableError(
        'github_unavailable',
        `${APP_LABEL[repo.app]} can no longer reach ${repo.repository}`,
      );
    }
    const key = `${repo.app}:${installation.id}`;
    const group = groups.get(key) ?? { app: repo.app, installationId: installation.id, repos: [] };
    group.repos.push(repo);
    groups.set(key, group);
  }

  const out: InstanceCloneCredential[] = [];
  for (const group of groups.values()) {
    const res = await github(`/app/installations/${group.installationId}/access_tokens`, {
      method: 'POST',
      authorization: `Bearer ${appJwt(group.app)}`,
      body: {
        repository_ids: group.repos.map((r) => Number(r.providerRepoId)),
        permissions: INSTANCE_CLONE_PERMISSIONS,
      },
    });
    if (!res.ok) {
      throw new RunGitCredentialUnavailableError(
        'github_unavailable',
        `GitHub answered ${res.status} when minting the clone token on ${group.repos
          .map((r) => r.repository)
          .join(', ')}`,
      );
    }
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token || !body.expires_at) {
      throw new RunGitCredentialUnavailableError(
        'github_unavailable',
        'GitHub answered a token response with an unexpected shape',
      );
    }
    out.push({
      repositories: group.repos.map((r) => r.repository),
      token: body.token,
      expiresAt: new Date(body.expires_at),
    });
  }
  return out;
}

/** Revoke one clone token (`DELETE /installation/token`). Best-effort — never throws;
 *  a token GitHub already considers dead counts as revoked, and the one-hour expiry
 *  is the backstop for a revoke that fails. */
export async function revokeInstanceCloneCredential(token: string): Promise<boolean> {
  try {
    const res = await github('/installation/token', {
      method: 'DELETE',
      authorization: `token ${token}`,
    });
    return res.ok || res.status === 401 || res.status === 404;
  } catch {
    return false;
  }
}
