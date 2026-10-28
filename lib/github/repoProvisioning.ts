import { createAppJwt, mintInstallationToken } from '@/lib/github/appAuth';
import { provisioningOrgLogin } from '@/lib/ciMetering/config';
import { OrgTargetAuthError, resolveOrgAuth, type GithubOrgTarget } from '@/lib/github/orgTarget';
import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';

// The repo-CREATION boundary (Story MOTIR-1775 · MOTIR-1781) — the one module
// that talks to GitHub about making a repository exist. Everything above it
// (`projectRepoProvisioningService`) is plain orchestration over the set's rows;
// everything below it is `fetch`. That line is where the tests fake, which is why
// this file holds ALL of the host mechanics and none of the row bookkeeping.
//
// It is a LEAF PRIMITIVE in the `lib/github/appAuth.ts` sense — services import
// it directly; routes never do.
//
// ⚠️ WHY THIS IS NOT ON THE `GitProvider` SEAM. Every method of that seam is one
// EVERY host backs, dispatched by a STORED row's `provider` discriminator. Repo
// creation has neither property. `docs/decisions/ci-minutes-allowance.md` §5.6
// records the structural reason: Motir creates repositories ONLY in its own
// GitHub org, and the shipped GitLab provider exists for connect-existing only —
// a namespace the user already owns. And at creation time there is no stored row
// to dispatch on: the target is env configuration, not a connection. Adding an
// optional seam method would model a capability with no second implementation and
// no dispatch key, which is exactly the "define the interface alongside a real
// implementation" rule this codebase adopted after MOTIR-1566. If Motir ever
// creates repos on another host, that is a new card and an ADR amendment.
//
// THE MECHANICS ARE THE SPIKE'S, NOT RE-DERIVED (`docs/github-repo-creation-mechanics.md`):
//   * Mechanic 1 — `POST /orgs/{org}/repos` and `POST /repos/{o}/{r}/generate`
//     are both available to an INSTALLATION token; `POST /user/repos` is
//     user-token-only and therefore never reachable server-side. There is no
//     user-account path here, by construction.
//   * Mechanic 2 — a repo the App CREATES is auto-granted to the installation,
//     but GitHub fires NO `installation_repositories` delivery for it. The mirror
//     is written in-flow by the caller; nothing subscribes to `repository`.
//   * Mechanic 4.1 — the governing limit is 80 content-generating requests per
//     minute. A 2–5 repo set is nowhere near it, and the caller creates rows
//     SEQUENTIALLY, which also stays clear of the 100-concurrent ceiling.
//   * Mechanic 4.2 — `201` does NOT mean the repository is ready. A generated
//     repo returns before its tree is populated, so every row is readiness-read
//     before it is reported established.
//   * Mechanic 4.3 — a name collision is a `422` whose `errors` SHAPE differs
//     between the two endpoints (objects from `/orgs/{org}/repos`, plain strings
//     from `/generate`). Detection is therefore on the status plus a
//     case-insensitive `already exists` match across the body's message strings,
//     never on the shape — see `isNameCollision`, which also records the
//     correction this card made to the spike's own wording.

const GITHUB_API = 'https://api.github.com';

/** The `.gitignore` template GitHub applies to an initialised repo. Matches the
 *  platform starter's stack, so the two seed paths do not disagree about what a
 *  Motir-created repository ignores. */
const GITIGNORE_TEMPLATE = 'Node';

/** The licence GitHub applies to an initialised repo — MIT, because that is what
 *  `nextjs-prisma-vercel-starter` (the `web` seed, §2 of the ADR) already ships.
 *  A set whose web repo is MIT and whose api repo is something else would be a
 *  licensing decision made by accident of seed path. */
const LICENSE_TEMPLATE = 'mit';

/** The org that owns `nextjs-prisma-vercel-starter`. The starter is public and
 *  `is_template: true` (verified live in the spike §4.4), so the same template
 *  seeds every `web` row with no per-template exclusivity. */
const STARTER_TEMPLATE_OWNER = 'moooon-B-V';

/** Readiness polling (spike §4.2). A generated repo's `201` precedes its tree, so
 *  a row is only reported established once GitHub reports a non-empty
 *  `default_branch`. Bounded — a repo that never becomes ready is an honest
 *  per-row failure, not an unbounded wait holding the establish step open. */
const DEFAULT_READINESS_ATTEMPTS = 10;
const DEFAULT_READINESS_DELAY_MS = 1_000;

// ── Typed errors ────────────────────────────────────────────────────────────
//
// The card's requirement: no raw GitHub payload escapes. Every failure below is
// one of these, each carrying a stable `code` and a `reason` written for a HUMAN
// — the string the caller persists on the row and MOTIR-1782 renders verbatim.

/** Base of every provisioning failure. `reason` is the renderable, user-facing
 *  sentence; `message` is the developer-facing form that carries it. */
export abstract class RepoProvisioningError extends Error {
  abstract readonly code: string;
  constructor(readonly reason: string) {
    super(reason);
    this.name = new.target.name;
  }
}

/** Motir's provisioning org and/or its "Motir Studio" App credentials are not
 *  configured (`GITHUB_FALLBACK_ORG`, `GITHUB_STUDIO_APP_ID`,
 *  `GITHUB_STUDIO_APP_PRIVATE_KEY` — MOTIR-1779). A first-class state, not a
 *  crash: a self-hosted instance never provisions, so the flow is simply
 *  unreachable there. → 503 */
export class RepoProvisioningNotConfiguredError extends RepoProvisioningError {
  readonly code = 'REPO_PROVISIONING_NOT_CONFIGURED' as const;
  constructor() {
    super(
      'Repository hosting is not configured on this deployment, so no repository could be created.',
    );
  }
}

/** The name is already taken in Motir's org by a repository this project may not
 *  claim. NEVER auto-renamed (a silent rename makes the record disagree with what
 *  the user chose) and never blindly adopted — spike §4.3 finding 3. → 409 */
export class RepoNameTakenOnHostError extends RepoProvisioningError {
  readonly code = 'REPO_NAME_TAKEN_ON_HOST' as const;
  constructor(readonly repoName: string) {
    super(
      `The repository name "${repoName}" is already taken and belongs to another project. ` +
        'Choose a different name for this row, or connect the existing repository instead.',
    );
  }
}

/** GitHub accepted the create but the repository never became readable within the
 *  readiness window (spike §4.2). The repository may well exist — which is why
 *  this is a resumable row failure and a re-run adopts rather than re-creates. */
export class RepoNotReadyError extends RepoProvisioningError {
  readonly code = 'REPO_NOT_READY' as const;
  constructor(readonly repoName: string) {
    super(
      `GitHub created "${repoName}" but it was not ready in time. It may finish on its own — retry this row.`,
    );
  }
}

/** Any other GitHub refusal or transport failure — an org policy, a revoked
 *  credential, a secondary rate limit, an outage. Carries the STATUS and a short
 *  detail, never the raw body. */
export class RepoProvisioningApiError extends RepoProvisioningError {
  readonly code = 'REPO_PROVISIONING_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while creating the repository (${detail}).`
        : `GitHub refused to create the repository (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
  }
}

/** The installation of the tenant's ASSIGNED GitHub org (MOTIR-8966) could not
 *  be authenticated. The repository is NOT created anywhere else instead: a
 *  repository in the wrong org would be a real artifact under the wrong
 *  installation that cannot be rolled back. */
export class RepoHostOrgUnavailableError extends RepoProvisioningError {
  readonly code = 'REPO_HOST_ORG_UNAVAILABLE' as const;
  constructor(
    readonly org: string,
    readonly status: number | null,
  ) {
    super(
      `Motir could not reach its GitHub organisation "${org}" to create the repository` +
        `${status === null ? '' : ` (HTTP ${status})`}. Nothing was created — retry this row.`,
    );
  }
}

// ── Inputs / outputs ────────────────────────────────────────────────────────

export interface ProvisionRepoInput {
  /** The row's intended repo name — already shape-validated by the set service. */
  name: string;
  /** The row's role (ADR §1.1) — selects the seed path and names the repo. */
  role: ProjectRepoRoleDto;
  /** The row's seed source (ADR §2). `nextjs-prisma-vercel-starter` templates the
   *  repo; anything else initialises it. An UNKNOWN key initialises rather than
   *  throwing: MOTIR-709's registry will add keys, and a row whose key this build
   *  does not know is better served by an honest empty repo than by a failure. */
  seedSource: string;
  /** The owning project's display name — the README/description names it. */
  projectName: string;
}

export interface ProvisionedRepo {
  /** GitHub's numeric id of the PROVISIONING installation this repo landed in —
   *  the key the mirror row hangs off and the token mint uses. */
  installationId: string;
  /** GitHub's own repo id (as a string). */
  providerRepoId: string;
  owner: string;
  /** The repository's name in GITHUB's casing — authoritative for a checkout. */
  name: string;
  defaultBranch: string;
  /**
   * TRUE when this call did not create the repository but ADOPTED one that
   * already existed under the same name in Motir's org. That happens on exactly
   * one path: a previous attempt created the repo and crashed (or timed out)
   * before the row was attached, so a re-run must resolve the row rather than
   * make a second repository. The caller re-checks that no OTHER project's row
   * already claims it before attaching — see the service.
   */
  adopted: boolean;
  /**
   * The default-branch head once seeding finished (MOTIR-4589) — the template's
   * commit, or the initialised commit plus the CI stub. The project row records
   * it, and the repository's first index waits until the branch moves past it.
   * NULL on an ADOPTED repository (this call did not seed it, so it cannot say
   * what the seed was) and when the head could not be read: either way the
   * repository indexes as it always has.
   */
  seedHeadSha: string | null;
}

// ── Configuration + the installation id ─────────────────────────────────────

/** Poll settings, overridable ONLY by tests (the `_reset…` precedent in
 *  `appAuth.ts`). Production always uses the constants above. */
let readinessPoll = {
  attempts: DEFAULT_READINESS_ATTEMPTS,
  delayMs: DEFAULT_READINESS_DELAY_MS,
};

/** Test-only: shorten (or restore) the readiness poll so the not-ready path is
 *  exercisable without real sleeps. Pass `null` to restore the defaults. */
export function _setReadinessPollForTests(
  opts: { attempts?: number; delayMs?: number } | null,
): void {
  readinessPoll =
    opts === null
      ? { attempts: DEFAULT_READINESS_ATTEMPTS, delayMs: DEFAULT_READINESS_DELAY_MS }
      : {
          attempts: opts.attempts ?? DEFAULT_READINESS_ATTEMPTS,
          delayMs: opts.delayMs ?? DEFAULT_READINESS_DELAY_MS,
        };
}

/** The provisioning installation id, cached per org for the process. It is a
 *  stable property of "our App on our org" — one lookup, not one per row. */
const installationIdCache = new Map<string, string>();

/** "The provisioning App is NOT installed on this org", remembered for
 *  {@link NOT_INSTALLED_TTL_MS} so a tenant project's sync does not ask GitHub on
 *  every establish (MOTIR-8712). Positives live in `installationIdCache`. */
const notInstalledCache = new Map<string, number>();
const NOT_INSTALLED_TTL_MS = 10 * 60_000;

/** Test-only: clear the resolved-installation cache between tests. */
export function _resetProvisioningInstallationCache(): void {
  installationIdCache.clear();
  notInstalledCache.clear();
}

/** Whether this deployment can provision at all — the org login is configured
 *  AND the Studio App has credentials. Callers use it to answer "is the create
 *  path reachable?" without forming a request. */
export function isRepoProvisioningConfigured(): boolean {
  return (
    provisioningOrgLogin() !== null &&
    Boolean(process.env['GITHUB_STUDIO_APP_ID']) &&
    Boolean(process.env['GITHUB_STUDIO_APP_PRIVATE_KEY'])
  );
}

/** Motir's provisioning org login, or throw the typed not-configured error.
 *  Read from the SAME accessor the CI meter gates on (`lib/ciMetering/config.ts`)
 *  so "which org does Motir own?" has exactly one reader and cannot drift. */
function requireOrg(): string {
  const org = provisioningOrgLogin();
  if (!org) throw new RepoProvisioningNotConfiguredError();
  return org;
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse a JSON body defensively — a non-JSON error body is not itself an error
 *  to throw over; the STATUS is what the caller branches on. */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(await res.json());
  } catch {
    return null;
  }
}

/** GitHub's `message` from an error body, trimmed to a short developer detail.
 *  Deliberately not the whole payload — no raw GitHub body escapes this module. */
function errorDetail(body: Record<string, unknown> | null): string {
  const message = body?.['message'];
  return typeof message === 'string' ? message.slice(0, 200) : '';
}

/**
 * Is this response the "name already exists" collision?
 *
 * Spike §4.3 finding 2 says: match on the 422 STATUS plus a case-insensitive
 * `already exists`, and NOT on the `errors` element SHAPE — `/orgs/{org}/repos`
 * returns objects there while `/generate` returns plain strings, so a parser
 * reading `errors[0].message` reads `undefined` on one of the two endpoints.
 *
 * ⚠️ CORRECTION TO THE SPIKE (MOTIR-1781). §4.3 further narrows that to "a match
 * on `message`" — and its OWN transcripts show that is not sufficient. Only the
 * generate endpoint puts the phrase in the top-level `message`:
 *
 *   POST /orgs/{org}/repos  → message: "Repository creation failed."
 *                             errors: [{ …, message: "name already exists on this account" }]
 *   POST /repos/{o}/{r}/generate → message: "Could not clone: Name already exists on this account"
 *                             errors: ["Could not clone: Name already exists on this account"]
 *
 * Matching `message` alone therefore MISSES every org-create collision — which is
 * the path this card uses for every non-web row. So the phrase is looked for in
 * the top-level message OR in any `errors` entry, with each entry read
 * shape-TOLERANTLY (a string as itself, an object via its `message`). That honours
 * the finding's real content — do not bind to one shape — rather than its
 * shorthand. The spike doc is corrected alongside this.
 */
function isNameCollision(status: number, body: Record<string, unknown> | null): boolean {
  if (status !== 422) return false;
  return collisionCandidates(body).some((text) => text.toLowerCase().includes('already exists'));
}

/** Every string a GitHub error body could carry the collision phrase in, across
 *  BOTH documented error shapes. */
function collisionCandidates(body: Record<string, unknown> | null): string[] {
  const out: string[] = [];
  if (typeof body?.['message'] === 'string') out.push(body['message']);
  const errors = body?.['errors'];
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === 'string') out.push(entry);
      else {
        const nested = asRecord(entry)?.['message'];
        if (typeof nested === 'string') out.push(nested);
      }
    }
  }
  return out;
}

/** Resolve GitHub's numeric installation id for the Studio App on Motir's org.
 *  An APP-level read (the App JWT), which is the only credential available
 *  before an installation token exists. */
async function resolveProvisioningInstallationId(org: string): Promise<string> {
  const cached = installationIdCache.get(org);
  if (cached) return cached;

  let jwt: string;
  try {
    jwt = createAppJwt(undefined, 'provisioning');
  } catch {
    // An unwired / unusable Studio key is the not-configured state, not a crash:
    // it is exactly the self-hosted case, and MOTIR-1779 is a manual subtask that
    // a given deployment may never have run.
    throw new RepoProvisioningNotConfiguredError();
  }

  const res = await request(`${GITHUB_API}/orgs/${encodeURIComponent(org)}/installation`, {
    method: 'GET',
    headers: { authorization: `Bearer ${jwt}` },
  });
  const body = await readJson(res);
  if (!res.ok) throw new RepoProvisioningApiError(res.status, errorDetail(body));
  const id = body?.['id'];
  const installationId = typeof id === 'number' || typeof id === 'string' ? String(id) : null;
  if (!installationId) {
    throw new RepoProvisioningApiError(res.status, 'installation lookup returned no id');
  }
  installationIdCache.set(org, installationId);
  return installationId;
}

/**
 * The provisioning App's installation id on `org`, read with the App JWT
 * (`GET /orgs/{org}/installation`) — the same resolver `provisioningAuth()` uses,
 * exported for a caller that must PROVE a delivery's installation is the
 * provisioning App's on some org (MOTIR-8720: the fleet intake's connected-org
 * fallback). Positive results are cached per org; a 404 (the App is not
 * installed there) is a `RepoProvisioningApiError` with that status, a transport
 * failure one with `status: null`, and an unwired Studio key
 * `RepoProvisioningNotConfiguredError`.
 */
export function provisioningInstallationIdFor(org: string): Promise<string> {
  return resolveProvisioningInstallationId(org);
}

/**
 * The provisioning App's installation id on `org`, or NULL when the App is not
 * installed there (GitHub's 404) — the normal "not served" state of every tenant's
 * connected org, which is why it is an answer rather than a throw (MOTIR-8712).
 * A null is remembered for ten minutes; `bypassNegativeCache` re-asks (the
 * one-shot sync script). Any other failure still throws as
 * {@link provisioningInstallationIdFor} does.
 */
export async function findProvisioningInstallationId(
  org: string,
  options: { bypassNegativeCache?: boolean } = {},
): Promise<string | null> {
  const key = org.trim().toLowerCase();
  const until = notInstalledCache.get(key);
  if (!options.bypassNegativeCache && until !== undefined && until > Date.now()) return null;
  try {
    const id = await resolveProvisioningInstallationId(org);
    notInstalledCache.delete(key);
    return id;
  } catch (err) {
    if (err instanceof RepoProvisioningApiError && err.status === 404) {
      notInstalledCache.set(key, Date.now() + NOT_INSTALLED_TTL_MS);
      return null;
    }
    throw err;
  }
}

/** One GitHub call, with transport failures normalized to the typed error. */
async function request(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<Response> {
  try {
    return await fetch(url, {
      method: init.method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
        ...init.headers,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
    });
  } catch (err) {
    throw new RepoProvisioningApiError(null, err instanceof Error ? err.message : 'unknown');
  }
}

// ── Seed content for a role the single starter does not fit ────────────────

/** The CI stub an initialised repo starts with (ADR §2). Deliberately minimal
 *  and GREEN: it exists so the first card dispatched into the repo EDITS a
 *  workflow rather than inventing one, and so the repo's Actions surface is real
 *  from minute one.
 *
 *  `runs-on` goes through the runner-selection seam (`vars.MOTIR_RUNNER` with an
 *  `ubuntu-latest` fallback — MOTIR-1925's shape) because Motir pays for these
 *  minutes: a repo Motir hosts must be movable onto Motir's own fleet without
 *  editing every repo it ever created (MOTIR-1907). The fallback is what runs
 *  until the variable is set, so this is correct today and correct after. */
function ciStubWorkflow(repoName: string): string {
  return [
    `# CI for ${repoName} — a stub created by Motir when this repository was initialised.`,
    '# It is intentionally minimal: the first card dispatched into this repo replaces',
    '# these steps with the real build/test pipeline for its stack.',
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '',
    'jobs:',
    '  ci:',
    "    runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}",
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: No pipeline configured yet',
    '        run: echo "This repository has no build yet. Motir replaces this step with the real one."',
    '',
  ].join('\n');
}

/** The repository description GitHub also renders into the `auto_init` README
 *  (`# <name>` + the description), which is how an initialised repo satisfies
 *  ADR §2's "a README naming the project and the row's role" in the SAME call
 *  that creates it — no second commit, no read-modify-write of a file GitHub
 *  just wrote. */
function initialisedDescription(input: ProvisionRepoInput): string {
  return (
    `The ${input.role} repository for ${input.projectName}. ` +
    'Initialised by Motir — the first card dispatched here builds its skeleton.'
  );
}

// ── The provisioning credential, as ONE reader ──────────────────────────────

/** Motir's org, the Studio App's installation on it, and a fresh installation
 *  token — everything a call against a Motir-OWNED repository needs.
 *
 *  Exported so the COLLABORATOR boundary (`lib/github/repoCollaborators.ts`,
 *  MOTIR-1900) authenticates through the same path rather than re-deriving the
 *  org, re-resolving the installation and re-minting the token. "Which org does
 *  Motir own, and with which credential?" keeps exactly one reader — the same
 *  discipline `provisioningOrgLogin()` enforces one layer down — so an invite can
 *  never be sent against a different org than the repository was created in. */
export async function provisioningAuth(): Promise<{
  org: string;
  installationId: string;
  token: string;
}> {
  const org = requireOrg();
  const installationId = await resolveProvisioningInstallationId(org);
  const { token } = await mintProvisioningToken(installationId);
  return { org, installationId, token };
}

// ── The client ──────────────────────────────────────────────────────────────

export const repoProvisioningClient = {
  /**
   * Create ONE repository in Motir's org and return it once GitHub reports it
   * ready. Seeds per role (ADR §2): the platform starter templates a `web` row;
   * every other role gets an initialised repo (README naming the project + role,
   * a licence, a `.gitignore`, a CI stub).
   *
   * IDEMPOTENT for a re-run. A `422 already exists` is not treated as a failure
   * outright: the repository is read back and returned with `adopted: true`, so a
   * retry after a crash-between-create-and-attach resolves the row instead of
   * making a second repository. This is safe HERE and would not have been in the
   * design the spike examined: every created repo now lives in MOTIR's own org
   * (the 2026-07-30 ADR amendment), so a collision there is Motir's own artifact,
   * not the unrelated third-party repo §4.3 finding 3 warns about. The remaining
   * risk — that the existing repo belongs to a DIFFERENT project's row — is not
   * decidable here (this module knows nothing about rows); the caller checks it
   * against the set before attaching, and `attachRealizedRepo`'s unique index is
   * the backstop. Nothing is ever renamed.
   *
   * `target` (MOTIR-8966) is the tenant's ASSIGNED Motir-owned GitHub org: the
   * create, the collision read-back and the readiness poll all act on
   * `target.org`, through its installation, and the result carries that
   * installation. A failed mint is {@link RepoHostOrgUnavailableError} — never a
   * create in the fallback org. No target is today's path, unchanged.
   */
  async provisionRepository(
    input: ProvisionRepoInput,
    target?: GithubOrgTarget,
  ): Promise<ProvisionedRepo> {
    const { org, installationId, token } = target
      ? await targetAuth(target)
      : await provisioningAuth();
    const auth = { authorization: `Bearer ${token}` };

    const templated = input.seedSource === SEED_SOURCE_PLATFORM_STARTER;
    const res = templated
      ? await request(
          `${GITHUB_API}/repos/${STARTER_TEMPLATE_OWNER}/${SEED_SOURCE_PLATFORM_STARTER}/generate`,
          {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
              owner: org,
              name: input.name,
              description: `The ${input.role} repository for ${input.projectName}. Created by Motir.`,
              private: true,
              include_all_branches: false,
            }),
          },
        )
      : await request(`${GITHUB_API}/orgs/${encodeURIComponent(org)}/repos`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({
            name: input.name,
            description: initialisedDescription(input),
            private: true,
            auto_init: true,
            license_template: LICENSE_TEMPLATE,
            gitignore_template: GITIGNORE_TEMPLATE,
          }),
        });

    if (!res.ok) {
      const body = await readJson(res);
      if (isNameCollision(res.status, body)) {
        // Adopt (never rename). `readRepository` throws the typed name-taken error
        // if the repo has since vanished — a collision we cannot even read is not
        // one we can claim.
        const existing = await readRepository(org, input.name, token);
        if (!existing) throw new RepoNameTakenOnHostError(input.name);
        return { installationId, ...existing, adopted: true, seedHeadSha: null };
      }
      throw new RepoProvisioningApiError(res.status, errorDetail(body));
    }

    // `201` is not readiness (spike §4.2) — a templated repo returns before its
    // tree is populated. Poll until GitHub reports a default branch.
    const ready = await awaitReady(org, input.name, token);

    // The CI stub is the ONE thing `auto_init` cannot give an initialised repo,
    // so it is a second commit — and only for the non-templated path (the starter
    // ships its own CI). Best-effort: a repository that exists with no stub is a
    // usable repository, and failing the whole row over a missing placeholder
    // would turn a cosmetic gap into a lost artifact.
    if (!templated) await seedCiStub(org, ready.name, token, ready.defaultBranch);

    // Read AFTER every seeding write, so the stub's commit counts as seed too.
    const seedHeadSha = await readBranchHead(org, ready.name, token, ready.defaultBranch);
    return { installationId, ...ready, adopted: false, seedHeadSha };
  },
};

/** The assigned org's auth (MOTIR-8966): its installation, never the fallback
 *  org's. A failed mint is the row's typed failure. */
async function targetAuth(
  target: GithubOrgTarget,
): Promise<{ org: string; installationId: string; token: string }> {
  try {
    return await resolveOrgAuth(target);
  } catch (err) {
    if (err instanceof OrgTargetAuthError)
      throw new RepoHostOrgUnavailableError(err.org, err.status);
    throw err;
  }
}

/** Mint the provisioning installation token, translating an unwired Studio App
 *  into the typed not-configured error rather than leaking `appAuth`'s. */
async function mintProvisioningToken(installationId: string) {
  try {
    return await mintInstallationToken(installationId, 'provisioning');
  } catch (err) {
    if (err instanceof Error && err.name === 'GithubAppNotConfiguredError') {
      throw new RepoProvisioningNotConfiguredError();
    }
    throw new RepoProvisioningApiError(null, err instanceof Error ? err.message : 'unknown');
  }
}

interface ReadRepo {
  providerRepoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

/** Read one repository. Returns null on 404 (it does not exist / is unreachable);
 *  every other refusal is the typed API error. `defaultBranch` is empty when
 *  GitHub has not populated it yet — the readiness signal the spike named. */
async function readRepository(org: string, name: string, token: string): Promise<ReadRepo | null> {
  const res = await request(
    `${GITHUB_API}/repos/${encodeURIComponent(org)}/${encodeURIComponent(name)}`,
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
  );
  if (res.status === 404) return null;
  const body = await readJson(res);
  if (!res.ok) throw new RepoProvisioningApiError(res.status, errorDetail(body));
  const rawId = body?.['id'];
  const providerRepoId =
    typeof rawId === 'number' || typeof rawId === 'string' ? String(rawId) : null;
  const repoName = typeof body?.['name'] === 'string' ? body['name'] : null;
  const ownerLogin = asRecord(body?.['owner'])?.['login'];
  if (!providerRepoId || !repoName) {
    throw new RepoProvisioningApiError(res.status, 'repository read returned an unexpected shape');
  }
  return {
    providerRepoId,
    owner: typeof ownerLogin === 'string' ? ownerLogin : org,
    name: repoName,
    defaultBranch: typeof body?.['default_branch'] === 'string' ? body['default_branch'] : '',
  };
}

/** Poll a just-created repository until it reports a default branch (spike
 *  §4.2), then return it. Throws {@link RepoNotReadyError} when the window
 *  closes first — the repository may still exist, which is why the row's failure
 *  is resumable and the retry adopts. */
async function awaitReady(org: string, name: string, token: string): Promise<ReadRepo> {
  const { attempts, delayMs } = readinessPoll;
  let last: ReadRepo | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs);
    last = await readRepository(org, name, token);
    if (last && last.defaultBranch.length > 0) return last;
  }
  throw new RepoNotReadyError(name);
}

/** The head commit of one branch, or null when it cannot be read. Best-effort by
 *  contract: a missing seed head only means the repository is indexed at once,
 *  as every repository was before MOTIR-4589 — never a failed row. */
async function readBranchHead(
  org: string,
  name: string,
  token: string,
  branch: string,
): Promise<string | null> {
  try {
    const res = await request(
      `${GITHUB_API}/repos/${encodeURIComponent(org)}/${encodeURIComponent(name)}` +
        `/branches/${encodeURIComponent(branch)}`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const sha = asRecord(asRecord(await readJson(res))?.['commit'])?.['sha'];
    return typeof sha === 'string' && sha.length > 0 ? sha : null;
  } catch (err) {
    console.error(
      `[repoProvisioning] seed head not read for ${org}/${name}:`,
      err instanceof Error ? err.message : 'unknown',
    );
    return null;
  }
}

/** Commit the CI stub into a freshly initialised repository. A NEW file, so no
 *  blob sha is needed. Best-effort by contract — see the call site. */
async function seedCiStub(org: string, name: string, token: string, branch: string): Promise<void> {
  try {
    const res = await request(
      `${GITHUB_API}/repos/${encodeURIComponent(org)}/${encodeURIComponent(name)}` +
        '/contents/.github/workflows/ci.yml',
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          message: 'chore(ci): add the CI stub Motir initialises a repository with',
          content: Buffer.from(ciStubWorkflow(name), 'utf8').toString('base64'),
          branch,
        }),
      },
    );
    if (!res.ok) {
      console.error(
        `[repoProvisioning] CI stub not written for ${org}/${name}: GitHub returned ${res.status}`,
      );
    }
  } catch (err) {
    console.error(
      `[repoProvisioning] CI stub not written for ${org}/${name}:`,
      err instanceof Error ? err.message : 'unknown',
    );
  }
}
