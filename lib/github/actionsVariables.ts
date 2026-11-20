import { githubFetch } from '@/lib/github/githubFetch';
import { resolveOrgAuth, type GithubOrgTarget } from '@/lib/github/orgTarget';

// The ORG ACTIONS-VARIABLE boundary (Story MOTIR-1916 · MOTIR-2015) — the one
// module that talks to GitHub about a variable a workflow reads.
//
// It is the sibling of `lib/github/runnerGroups.ts` and deliberately mirrors it:
// all of the host mechanics live here, none of the bookkeeping does, and the line
// between them is where the tests fake. It is a LEAF PRIMITIVE in the
// `lib/github/appAuth.ts` sense — services import it directly; routes never do.
// It authenticates through `resolveOrgAuth()` (`lib/github/orgTarget.ts`) for the
// same reason the group client does: "which org, with which credential?" keeps
// exactly ONE reader, so a variable can never be written into a different org
// than the runner groups and repositories it governs. With no target that reader
// answers the provisioning org, which is the default every shipped caller takes;
// a caller that names a `GithubOrgTarget` (MOTIR-8702) acts on that org through
// that installation instead, and every inner call it makes forwards the target.
//
// ⚠️ ORGANIZATION SCOPE ONLY — THERE IS NO REPOSITORY-VARIABLE FUNCTION HERE, and
// its absence is load-bearing rather than an omission (ADR §N.1, MOTIR-2015).
// GitHub resolves `vars.X` at repository level FIRST and falls back to the org, so
// a repository variable is the one write that would SURVIVE MOTIR-711's transfer:
// the repo leaves Motir's org still asking for `motir-runner`, nobody boots a
// runner for it, and every job queues until GitHub expires it at 24 hours. An org
// variable cannot do that — it is a property of the ORG, so a transferred repo
// stops resolving it the moment it moves, `runs-on` falls back to `ubuntu-latest`,
// and the handover needs no unset call at all. Adding a repo-scoped writer here
// would make that guarantee one careless call site away from being false, so the
// capability simply does not exist in this module. (§7.3's per-project-label
// fallback, if the runner-group ceiling ever binds, is what would reintroduce it —
// as its own card, with the handover unset in the same diff.)
//
// ⚠️ THE PERMISSION IS `Variables: write` AT ORGANIZATION LEVEL, and it is
// MEASURED, not assumed (MOTIR-2016, verified against the live installation on
// 2026-08-02): `motir-studio` now carries `organization_actions_variables: write`
// on installation 150298786, GRANTED and not merely declared. It is a DISTINCT
// permission from the `administration` / `workflows` /
// `organization_self_hosted_runners` ones the App already held — none of those
// reach these endpoints — which is why it needed its own manual card and an
// installation re-approval before this module could exist.

const GITHUB_API = 'https://api.github.com';

/**
 * Who may read an org variable. `private` = every PRIVATE repository in the org,
 * which is exactly the set Motir provisions (`repoProvisioning` creates both the
 * templated and the initialised repo with `private: true`).
 *
 * ⚠️ `private` RATHER THAN `all`, deliberately. The fleet's runner groups are
 * created with `allows_public_repositories: false` (§7, `runnerGroups.ts`) because
 * a fork's pull request can execute arbitrary code on a self-hosted runner. So a
 * PUBLIC repository in Motir's org that resolved this variable would ask for a
 * runner the group may never give it — and a job nobody can serve does not fail,
 * it QUEUES for 24 hours. Scoping the variable to private repositories makes that
 * repository fall back to GitHub-hosted instead, which is the safe direction: the
 * one visibility the fleet refuses to serve is the one that never sees the
 * variable. (A repo made public later loses the variable and starts falling back,
 * which is the same correct outcome arrived at from the other side.)
 */
const VARIABLE_VISIBILITY = 'private' as const;

/** Any GitHub refusal or transport failure while managing an org variable.
 *  Carries the STATUS and a short detail, never the raw body — the same posture
 *  `repoProvisioning.ts` and `runnerGroups.ts` hold. */
export class ActionsVariableApiError extends Error {
  readonly code = 'ACTIONS_VARIABLE_API_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while managing an Actions variable (${detail}).`
        : `GitHub refused an Actions-variable call (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'ActionsVariableApiError';
  }
}

/** An organization variable as GitHub holds it. */
export interface OrgVariable {
  name: string;
  value: string;
  visibility: string;
}

/** What {@link actionsVariableClient.ensureOrgVariable} had to do. */
export type EnsureOrgVariableOutcome =
  /** No variable existed; this call created it. */
  | 'created'
  /** One existed with a different value and/or visibility; this call fixed it. */
  | 'updated'
  /** It already held exactly the desired value and visibility. */
  | 'unchanged';

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
    return await githubFetch('actionsVariables', url, {
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
    throw new ActionsVariableApiError(null, err instanceof Error ? err.message : 'unknown');
  }
}

/** GitHub's variable JSON → the shape above; null when the payload is not one. */
function toVariable(body: Record<string, unknown> | null): OrgVariable | null {
  const name = body?.['name'];
  const value = body?.['value'];
  if (typeof name !== 'string' || typeof value !== 'string') return null;
  return {
    name,
    value,
    visibility: typeof body?.['visibility'] === 'string' ? body['visibility'] : '',
  };
}

function variablesBase(org: string): string {
  return `${GITHUB_API}/orgs/${encodeURIComponent(org)}/actions/variables`;
}

// ── The client ──────────────────────────────────────────────────────────────

export const actionsVariableClient = {
  /**
   * Read ONE organization variable by name, or null when it does not exist.
   *
   * A 404 is "absent", never a failure: absence is the state this module's whole
   * purpose is to move away from, and it is also the correct reading on a fresh
   * org that has never established a repository.
   */
  async getOrgVariable(name: string, target?: GithubOrgTarget): Promise<OrgVariable | null> {
    const { org, token } = await resolveOrgAuth(target);
    const res = await request(`${variablesBase(org)}/${encodeURIComponent(name)}`, {
      method: 'GET',
      token,
    });
    if (res.status === 404) return null;
    const body = await readJson(res);
    if (!res.ok) throw new ActionsVariableApiError(res.status, errorDetail(body));
    const variable = toVariable(body);
    if (!variable) {
      throw new ActionsVariableApiError(res.status, 'variable read returned an unexpected shape');
    }
    return variable;
  },

  /**
   * Make the org variable `name` hold exactly `value`, creating it if absent and
   * correcting it if it has drifted.
   *
   * READ-THEN-WRITE RATHER THAN A BLIND WRITE, because GitHub gives no upsert
   * here: `POST …/variables` is create-only (a 409 once the variable exists) and
   * `PATCH …/variables/{name}` is update-only (a 404 while it does not). Either
   * one alone is wrong exactly half the time, so the read is what decides — and it
   * also makes the common case (the variable is already right, which is every
   * establishment after the first) cost one GET and no write at all.
   *
   * THE READ-DERIVED WRITE IS SAFE UNLOCKED, unlike the runner group's access list.
   * The group's `PUT …/repositories` replaces a whole ARRAY computed from a
   * project's current set, so two concurrent syncs lose each other's repositories —
   * hence that service's `FOR UPDATE`. Here the desired value is a CONSTANT
   * ({@link MOTIR_RUNNER_LABEL}, via the caller), identical for every project and
   * every caller forever. Two racing ensures write the same bytes; the loser of the
   * create race sees the 409 handled below and re-reads. There is no state to lose,
   * so there is nothing to lock.
   *
   * IDEMPOTENT under every interleaving, and self-healing: a variable an operator
   * deletes or edits by hand is restored by the next establishment.
   */
  async ensureOrgVariable(
    name: string,
    value: string,
    target?: GithubOrgTarget,
  ): Promise<EnsureOrgVariableOutcome> {
    const existing = await this.getOrgVariable(name, target);
    if (existing && existing.value === value && existing.visibility === VARIABLE_VISIBILITY) {
      return 'unchanged';
    }
    return existing ? this.patch(name, value, target) : this.create(name, value, target);
  },

  /** POST the create. A 409 means a concurrent ensure won the race — the variable
   *  now exists, so this falls through to the PATCH, which converges on the same
   *  value rather than reporting a conflict the caller cannot act on. */
  async create(
    name: string,
    value: string,
    target?: GithubOrgTarget,
  ): Promise<EnsureOrgVariableOutcome> {
    const { org, token } = await resolveOrgAuth(target);
    const res = await request(variablesBase(org), {
      method: 'POST',
      token,
      body: JSON.stringify({ name, value, visibility: VARIABLE_VISIBILITY }),
    });
    if (res.ok) return 'created';
    if (res.status === 409) return this.patch(name, value, target);
    throw new ActionsVariableApiError(res.status, errorDetail(await readJson(res)));
  },

  /** PATCH the correction. `visibility` is re-sent so a hand-edited variable is
   *  brought back to {@link VARIABLE_VISIBILITY}, not merely to the right value —
   *  a variable scoped `all` would reach public repositories the fleet refuses to
   *  serve, which is the failure the visibility choice exists to prevent. */
  async patch(
    name: string,
    value: string,
    target?: GithubOrgTarget,
  ): Promise<EnsureOrgVariableOutcome> {
    const { org, token } = await resolveOrgAuth(target);
    const res = await request(`${variablesBase(org)}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify({ name, value, visibility: VARIABLE_VISIBILITY }),
    });
    if (res.ok) return 'updated';
    throw new ActionsVariableApiError(res.status, errorDetail(await readJson(res)));
  },

  /**
   * DELETE the org variable `name`, so every workflow reading it falls back to its
   * own default (`vars.X || 'ubuntu-latest'`). A 404 answers `'absent'` rather
   * than failing: the desired end state — no variable — already holds, whoever
   * reached it. Any other refusal throws {@link ActionsVariableApiError}.
   */
  async deleteOrgVariable(name: string, target?: GithubOrgTarget): Promise<'deleted' | 'absent'> {
    const { org, token } = await resolveOrgAuth(target);
    const res = await request(`${variablesBase(org)}/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      token,
    });
    if (res.status === 204 || res.ok) return 'deleted';
    if (res.status === 404) return 'absent';
    throw new ActionsVariableApiError(res.status, errorDetail(await readJson(res)));
  },
};

/** The visibility every Motir-written org variable carries — exported for the
 *  tests that assert the wire, so the assertion and the code cannot drift. */
export const ORG_VARIABLE_VISIBILITY = VARIABLE_VISIBILITY;
