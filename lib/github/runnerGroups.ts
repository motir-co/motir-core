import { githubFetch } from '@/lib/github/githubFetch';
import { resolveOrgAuth, type GithubOrgTarget } from '@/lib/github/orgTarget';

// The RUNNER-GROUP boundary (Story MOTIR-1916 · MOTIR-1972) — the one module
// that talks to GitHub about a project's self-hosted runner group. Everything
// above it (`projectRunnerGroupService`) is row bookkeeping; everything below it
// is `fetch`. That line is where the tests fake.
//
// It is a LEAF PRIMITIVE in the `lib/github/appAuth.ts` sense — services import
// it directly; routes never do. It authenticates through `resolveOrgAuth()`
// (`lib/github/orgTarget.ts`) for the same reason `repoCollaborators.ts` reads
// the provisioning org: "which org, and with which credential?" keeps exactly ONE
// reader, so a group can never be created in a different org than the
// repositories it access-lists. With no target that reader answers the
// provisioning org — every shipped caller's default; a `GithubOrgTarget`
// (MOTIR-8702) acts on that org through that installation instead. The template
// is the same for every target: `allows_public_repositories` is never a
// parameter, in any org.
//
// ⚠️ NO SECOND PERMISSION IS NEEDED, and this is measured, not assumed
// (MOTIR-1919, verified against the live org on 2026-08-01):
// `organization_self_hosted_runners: write` on the provisioning App ("Motir
// Studio") covers the runner-GROUP endpoints as well as the token/JIT ones —
// GitHub's fine-grained reference lists POST/PATCH/DELETE
// `/orgs/{org}/actions/runner-groups…` under *Organization permissions for
// "Self-hosted runners"*. Group creation also works on `motir-projects`' `free`
// plan (`201`, verified by API and in the console) despite GitHub's docs
// claiming Team is required — that documentation is stale.
//
// THE TEMPLATE IS `motir-project-template` (group id 104), created by hand in
// MOTIR-1919 so the programmatic path has something exact to copy:
// `visibility: "selected"`, `allows_public_repositories: false`, no workflow
// restriction. A console template and a programmatic path that differ would be a
// silent divergence, so {@link RUNNER_GROUP_TEMPLATE} states the shape once and
// both create and adopt assert against it.
//
// ⚠️ `allows_public_repositories` STAYS FALSE. A fork's pull request can execute
// arbitrary code on a self-hosted runner; ADR §7 treats the container as hostile
// throughout. It is not a parameter of any function here — a caller cannot ask
// for a public-fork-visible group, because there is no argument to ask with.

const GITHUB_API = 'https://api.github.com';

/** GitHub's page ceiling for the runner-group list read. */
const PAGE_SIZE = 100;

/** How many pages the by-name lookup will walk before giving up. §7.3's named
 *  unknown is the number of groups an org may hold — measured to at least 102 —
 *  so the adopt path cannot assume one page. 50 pages is 5,000 groups: far past
 *  any real org, and bounded so a paging bug cannot spin forever. */
const MAX_PAGES = 50;

/**
 * The group shape every Motir-created group has, and the ONLY one this module
 * will create or adopt — matching `motir-project-template` (id 104) exactly.
 *
 * `visibility: 'selected'` is what makes `selected_repository_ids` mean
 * anything; `all` is the org-wide group §7.3 forbids.
 */
export const RUNNER_GROUP_TEMPLATE = {
  visibility: 'selected',
  allowsPublicRepositories: false,
  restrictedToWorkflows: false,
} as const;

/** The DETERMINISTIC name of a project's runner group. Deterministic on purpose:
 *  an orphaned group in Motir's org is attributable to the project that made it
 *  with no reverse lookup, and a re-run can ADOPT the group a crashed earlier run
 *  created instead of making a second one. */
export function runnerGroupNameFor(projectId: string): string {
  return `motir-project-${projectId}`;
}

// ── Typed errors ────────────────────────────────────────────────────────────

/** Any GitHub refusal or transport failure while managing a runner group.
 *  Carries the STATUS and a short detail, never the raw body — the same posture
 *  `repoProvisioning.ts` holds. */
export class RunnerGroupApiError extends Error {
  readonly code = 'RUNNER_GROUP_API_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while managing the runner group (${detail}).`
        : `GitHub refused a runner-group call (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'RunnerGroupApiError';
  }
}

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface RunnerGroup {
  /** GitHub's numeric group id — what a JIT config names as `runner_group_id`. */
  id: number;
  name: string;
  visibility: string;
  allowsPublicRepositories: boolean;
}

// ── Plumbing ────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(await res.json());
  } catch {
    return null;
  }
}

function errorDetail(body: Record<string, unknown> | null): string {
  const message = body?.['message'];
  return typeof message === 'string' ? message.slice(0, 200) : '';
}

/** One GitHub call, with transport failures normalized to the typed error. */
async function request(
  url: string,
  init: { method: string; token: string; body?: string },
): Promise<Response> {
  try {
    return await githubFetch('runnerGroups', url, {
      method: init.method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
        authorization: `Bearer ${init.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
    });
  } catch (err) {
    throw new RunnerGroupApiError(null, err instanceof Error ? err.message : 'unknown');
  }
}

/** GitHub's group JSON → the shape above. Returns null when the payload is not a
 *  group (no numeric id), which a caller treats as an API-shape failure. */
function toGroup(body: Record<string, unknown> | null): RunnerGroup | null {
  const rawId = body?.['id'];
  const id = typeof rawId === 'number' ? rawId : typeof rawId === 'string' ? Number(rawId) : NaN;
  if (!Number.isInteger(id)) return null;
  const name = body?.['name'];
  return {
    id,
    name: typeof name === 'string' ? name : '',
    visibility: typeof body?.['visibility'] === 'string' ? body['visibility'] : '',
    allowsPublicRepositories: body?.['allows_public_repositories'] === true,
  };
}

// ── The client ──────────────────────────────────────────────────────────────

export const runnerGroupClient = {
  /**
   * Create the project's group, access-listed to `selectedRepositoryIds` in the
   * SAME call — so there is never an instant where a group Motir made is visible
   * to a repository set it was not meant to serve.
   *
   * The body is {@link RUNNER_GROUP_TEMPLATE} verbatim; nothing about the shape
   * is a parameter.
   */
  async createGroup(
    input: {
      name: string;
      selectedRepositoryIds: readonly number[];
    },
    target?: GithubOrgTarget,
  ): Promise<RunnerGroup> {
    const { org, token } = await resolveOrgAuth(target);
    const res = await request(
      `${GITHUB_API}/orgs/${encodeURIComponent(org)}/actions/runner-groups`,
      {
        method: 'POST',
        token,
        body: JSON.stringify({
          name: input.name,
          visibility: RUNNER_GROUP_TEMPLATE.visibility,
          allows_public_repositories: RUNNER_GROUP_TEMPLATE.allowsPublicRepositories,
          restricted_to_workflows: RUNNER_GROUP_TEMPLATE.restrictedToWorkflows,
          selected_repository_ids: [...input.selectedRepositoryIds],
        }),
      },
    );
    const body = await readJson(res);
    if (!res.ok) throw new RunnerGroupApiError(res.status, errorDetail(body));
    const group = toGroup(body);
    if (!group)
      throw new RunnerGroupApiError(res.status, 'group create returned an unexpected shape');
    return group;
  },

  /**
   * Read ONE group by id. Returns null on 404 — the SELF-HEALING signal: a group
   * deleted out of band (an operator tidying the org) is not an error, it is a
   * group to re-create, and the caller does exactly that.
   */
  async getGroup(id: number, target?: GithubOrgTarget): Promise<RunnerGroup | null> {
    const { org, token } = await resolveOrgAuth(target);
    const res = await request(
      `${GITHUB_API}/orgs/${encodeURIComponent(org)}/actions/runner-groups/${id}`,
      { method: 'GET', token },
    );
    if (res.status === 404) return null;
    const body = await readJson(res);
    if (!res.ok) throw new RunnerGroupApiError(res.status, errorDetail(body));
    const group = toGroup(body);
    if (!group)
      throw new RunnerGroupApiError(res.status, 'group read returned an unexpected shape');
    return group;
  },

  /**
   * Find a group by its exact NAME, or null.
   *
   * This is the ADOPT path, and it is what keeps "create the group" idempotent
   * across a crash: a run that created the group on GitHub and died before
   * persisting the id would otherwise make a SECOND group on its retry — two
   * groups for one project, one of them orphaned and access-listing live
   * repositories. Names are compared case-insensitively because GitHub does not
   * distinguish two groups by case alone.
   */
  async findGroupByName(name: string, target?: GithubOrgTarget): Promise<RunnerGroup | null> {
    const { org, token } = await resolveOrgAuth(target);
    const wanted = name.toLowerCase();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await request(
        `${GITHUB_API}/orgs/${encodeURIComponent(org)}/actions/runner-groups` +
          `?per_page=${PAGE_SIZE}&page=${page}`,
        { method: 'GET', token },
      );
      const body = await readJson(res);
      if (!res.ok) throw new RunnerGroupApiError(res.status, errorDetail(body));
      const raw = body?.['runner_groups'];
      const entries = Array.isArray(raw) ? raw : [];
      for (const entry of entries) {
        const group = toGroup(asRecord(entry));
        if (group && group.name.toLowerCase() === wanted) return group;
      }
      if (entries.length < PAGE_SIZE) return null;
    }
    return null;
  },

  /**
   * REPLACE the group's access list with exactly `repositoryIds`.
   *
   * A whole-array PUT, not an add/remove pair, because the desired state is what
   * the caller computed under the project's row lock: an incremental call would
   * make the GitHub side depend on what it already held, which is precisely the
   * read-derived race the lock exists to close. An EMPTY list is legal and
   * meaningful — a project whose repositories have all been transferred out has a
   * group that grants nothing, which is the correct intermediate state before the
   * group is deleted.
   */
  async setGroupRepositories(
    id: number,
    repositoryIds: readonly number[],
    target?: GithubOrgTarget,
  ): Promise<void> {
    const { org, token } = await resolveOrgAuth(target);
    const res = await request(
      `${GITHUB_API}/orgs/${encodeURIComponent(org)}/actions/runner-groups/${id}/repositories`,
      {
        method: 'PUT',
        token,
        body: JSON.stringify({ selected_repository_ids: [...repositoryIds] }),
      },
    );
    if (res.ok) return;
    throw new RunnerGroupApiError(res.status, errorDetail(await readJson(res)));
  },

  /**
   * Delete the group. IDEMPOTENT against an already-deleted one: a 404 is the
   * desired end state reached by someone else, not a failure — which matters
   * because the delete runs from a handoff saga and a project deletion, either of
   * which may be retried.
   */
  async deleteGroup(id: number, target?: GithubOrgTarget): Promise<void> {
    const { org, token } = await resolveOrgAuth(target);
    const res = await request(
      `${GITHUB_API}/orgs/${encodeURIComponent(org)}/actions/runner-groups/${id}`,
      { method: 'DELETE', token },
    );
    if (res.ok || res.status === 404) return;
    throw new RunnerGroupApiError(res.status, errorDetail(await readJson(res)));
  },
};
