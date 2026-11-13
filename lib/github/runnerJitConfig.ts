import { resolveOrgAuth, type GithubOrgTarget } from '@/lib/github/orgTarget';

// The JIT-CONFIG boundary (Story MOTIR-1916 · MOTIR-1921) — the one module that
// asks GitHub for a runner's startup configuration, and the one that takes it
// back.
//
// A LEAF PRIMITIVE in the `lib/github/appAuth.ts` sense, and the exact sibling of
// `lib/github/runnerGroups.ts`: services import it directly, routes never do, and
// it authenticates through `resolveOrgAuth()` (`lib/github/orgTarget.ts`) so
// "which org, and with which credential?" keeps exactly ONE reader. With no target
// that is the provisioning org, every shipped caller's default; a
// `GithubOrgTarget` (MOTIR-8702) mints and de-registers in that org through that
// installation instead — and `deleteRunnersNamed` forwards it to every delete, so
// a runner listed in one org is never deleted by id in another. The deadline, the
// rate-limit reading and the JIT-only rule below hold for every target.
//
// ⚠️ A JIT CONFIG, NEVER A REGISTRATION TOKEN — `docs/decisions/ci-runner-fleet.md`
// §7.4, and this is the whole security posture of the fleet in one choice:
//
//   > `POST /orgs/{org}/actions/runners/registration-token` returns a token that
//   > "expires after one hour" and can register ANY runner in the org — handing
//   > it into a container that will execute customer code is handing over an
//   > org-wide registration capability for an hour.
//
// The container this credential reaches runs CUSTOMER code that an AI AGENT
// wrote, and the repository's own workflow file decides what executes (§7). A JIT
// config is one runner, one config, and NO registration capability inside the
// container; §7.3's group scoping is applied at MINT time, by the orchestrator,
// rather than trusted to the thing being scoped. There is no function in this
// module that mints a registration token, and that absence is the point — a
// caller cannot reach for one, because there is nothing to reach for.
//
// ⚠️ MINTING REGISTERS THE RUNNER IMMEDIATELY — verified against the live org on
// 2026-08-01 and recorded on the card: the `201` returns a runner row
// (`status: "offline"`) BEFORE any container exists. So a minted-but-unused
// config is not a wasted API call, it is a DANGLING REGISTERED RUNNER, and it
// must be de-registered explicitly rather than left for GitHub to tidy. That is
// why {@link runnerJitConfigClient.deleteRunner} exists and why every mint in
// `ciRunnerBootService` is paired with one on the failure path.

const GITHUB_API = 'https://api.github.com';

/**
 * GitHub's registration ceiling: **1,500 runners per 5 minutes** per org
 * (Actions limits reference, verified 2026-08-01) ≈ 5 registrations/second.
 *
 * ADR §6 records that this sits roughly two orders of magnitude above the
 * fleet's need and that "the binding constraint is Motir's own admission gate,
 * deliberately" (MOTIR-1922). It is documented here anyway because the card
 * requires the ceiling to surface as a TYPED, RETRYABLE refusal rather than an
 * opaque 4xx: when it does bind, the difference between "retry in 30s" and "a
 * 403 nobody can interpret" is the difference between a queue draining and an
 * outage.
 */
export const GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN = 1500;

/**
 * THE DEADLINE ON EVERY CALL IN THIS MODULE (`docs/jobs.md` rule 3, MOTIR-2011).
 *
 * `fetch` has no timeout of its own, and every call here runs inside a
 * background-job invocation: an unresponsive GitHub is waited on until the
 * PLATFORM kills the invocation, which arrives as a bare
 * `FUNCTION_INVOCATION_TIMEOUT` 504 with no step output — indistinguishable from
 * a crashed app, and (with the fleet job's `retryPolicy: 'none'`) a straight trip
 * to `job_run_dlq`. Bounded, the same hang is a typed error the boot path
 * classifies and releases the claim on, INSIDE the budget.
 *
 * 15s rather than `motirAiClient`'s 30s because this is one small JSON call to
 * `api.github.com` with no think time behind it — nothing here builds a graph or
 * ships a tarball. It is counted into `FLEET_TIME_BUDGETS.mintDeadlineMs` and
 * asserted against the route's `maxDuration` in
 * `tests/ciFleet/fleetTimeBudgets.test.ts`; rule 3's inequality is a property of
 * the SUM along a step, so this number is not free to grow on its own.
 */
export const RUNNER_JIT_REQUEST_TIMEOUT_MS = 15_000;

// ── Typed errors ────────────────────────────────────────────────────────────

/** Any GitHub refusal or transport failure while managing a JIT runner. Carries
 *  the STATUS and a short detail, never the raw body. */
export class RunnerJitApiError extends Error {
  readonly code = 'RUNNER_JIT_API_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached while configuring a JIT runner (${detail}).`
        : `GitHub refused a JIT-runner call (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'RunnerJitApiError';
  }
}

/**
 * The org's runner-registration ceiling is exhausted — RETRYABLE, and typed so
 * the caller can say so.
 *
 * Distinct from {@link RunnerJitApiError} because the correct response is
 * different in kind: this job is not un-runnable, it is early. The intent stays
 * pending and the next sweep picks it up; nothing is failed and nothing is
 * dropped. Folding it into the generic error would make a burst look like a
 * fleet outage.
 */
export class RunnerRegistrationRateLimitedError extends Error {
  readonly code = 'RUNNER_REGISTRATION_RATE_LIMITED' as const;
  readonly retryable = true as const;
  constructor(
    readonly status: number,
    /** GitHub's own `retry-after`, when it sent one. */
    readonly retryAfterSeconds: number | null,
  ) {
    super(
      `GitHub is rate-limiting runner registration (HTTP ${status}` +
        `${retryAfterSeconds === null ? '' : `, retry after ${retryAfterSeconds}s`}). ` +
        `The org ceiling is ${GITHUB_RUNNER_REGISTRATIONS_PER_5_MIN} registrations per 5 minutes.`,
    );
    this.name = 'RunnerRegistrationRateLimitedError';
  }
}

/**
 * GitHub did not answer inside {@link RUNNER_JIT_REQUEST_TIMEOUT_MS} — RETRYABLE,
 * and typed so the boot path can say so instead of dying with the invocation.
 *
 * Distinct from {@link RunnerJitApiError}'s transport case (`status: null`) on
 * purpose, and the distinction is operational rather than cosmetic: a refused
 * connection means GitHub answered "no", while a deadline means Motir stopped
 * WAITING and therefore does not know what happened on the other side. On a
 * mint that difference decides the cleanup — the runner may already be
 * registered, so the caller must go looking for it BY NAME (§7.4's dangling-JIT
 * case; {@link runnerJitConfigClient.deleteRunnersNamed}).
 */
export class RunnerJitTimeoutError extends Error {
  readonly code = 'RUNNER_JIT_TIMEOUT' as const;
  readonly retryable = true as const;
  constructor(
    /** Which call ran out of time — the log's only clue about what may be left
     *  behind at GitHub. */
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`GitHub did not answer a JIT-runner ${operation} within ${timeoutMs}ms.`);
    this.name = 'RunnerJitTimeoutError';
  }
}

// ── Shapes ──────────────────────────────────────────────────────────────────

/** What a mint returns. `encodedJitConfig` is a CREDENTIAL — it is passed to the
 *  runner at startup and must never be logged, persisted, or returned above the
 *  service that hands it to the orchestrator. */
export interface JitRunnerConfig {
  /** GitHub's numeric runner id — what de-registration names, and the only part
   *  of this that is safe to persist. */
  readonly runnerId: number;
  readonly runnerName: string;
  readonly encodedJitConfig: string;
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

/**
 * One GitHub call — the module's ONLY `fetch`, so the deadline is applied once
 * and cannot be forgotten at a new call site. Transport failures normalize to
 * {@link RunnerJitApiError}, a blown deadline to {@link RunnerJitTimeoutError}.
 *
 * `AbortController` + `setTimeout` rather than `AbortSignal.timeout()`, matching
 * the repository's three existing deadline sites (`motirAiClient.aiFetch`,
 * `lib/git/providers/github.ts`, `…/gitlab.ts`): the same `signal.aborted` check
 * tells OUR deadline apart from the runtime's opaque "This operation was
 * aborted", which is what makes the error message name a number an operator can
 * act on.
 */
async function request(
  url: string,
  init: { method: string; token: string; body?: string; operation: string },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNNER_JIT_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: init.method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
        authorization: `Bearer ${init.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new RunnerJitTimeoutError(init.operation, RUNNER_JIT_REQUEST_TIMEOUT_MS);
    }
    throw new RunnerJitApiError(null, err instanceof Error ? err.message : 'unknown');
  } finally {
    // The deadline bounds TIME-TO-RESPONSE-HEADERS, not body consumption: cleared
    // the moment `fetch` resolves, exactly as `aiFetch` does. Every body in this
    // module is a small JSON document, so nothing is left unbounded in practice.
    clearTimeout(timer);
  }
}

/**
 * Is this refusal the registration ceiling rather than a real error?
 *
 * GitHub reports a secondary rate limit as **403 or 429**, and distinguishes it
 * from a permission failure by a `retry-after` header or an exhausted
 * `x-ratelimit-remaining`. Both signals are checked because GitHub sends
 * different ones for primary and secondary limits, and treating a plain 403
 * (genuinely missing permission) as retryable would make a misconfigured App
 * retry forever instead of failing loudly on the first job.
 */
function rateLimitOf(res: Response): RunnerRegistrationRateLimitedError | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = res.headers.get('retry-after');
  const remaining = res.headers.get('x-ratelimit-remaining');
  const parsed = retryAfter === null ? null : Number(retryAfter);
  const hasRetryAfter = parsed !== null && Number.isFinite(parsed);
  const exhausted = remaining === '0';
  if (!hasRetryAfter && !exhausted) return null;
  return new RunnerRegistrationRateLimitedError(res.status, hasRetryAfter ? parsed : null);
}

// ── The client ──────────────────────────────────────────────────────────────

export const runnerJitConfigClient = {
  /**
   * Mint the startup configuration for exactly ONE ephemeral runner.
   *
   * `runnerGroupId` is REQUIRED and has no default. §7.3 forbids the `Default`
   * group (id 1, `visibility: "all"`), and the way to forbid it in code is to
   * give the caller nothing to omit — `projectRunnerGroupService.
   * requireRunnerGroupId` throws rather than returning null for the same reason.
   *
   * `labels` is the single §M-compliant fleet label. The runner is booted with
   * `--no-default-labels` (the orchestrator's job), so what is named here is
   * EXACTLY what the runner will match — no `self-hosted`, no `linux`, no `x64`.
   * A runner carrying GitHub's default labels would match `runs-on: self-hosted`
   * in some unrelated tenant's workflow, which is §7.3's cross-tenant pickup
   * arriving through the label axis instead of the group axis.
   */
  async mint(
    input: {
      name: string;
      runnerGroupId: number;
      labels: readonly string[];
      workFolder?: string;
    },
    target?: GithubOrgTarget,
  ): Promise<JitRunnerConfig> {
    const { org, token } = await resolveOrgAuth(target);
    const res = await request(
      `${GITHUB_API}/orgs/${encodeURIComponent(org)}/actions/runners/generate-jitconfig`,
      {
        method: 'POST',
        token,
        operation: 'mint',
        body: JSON.stringify({
          name: input.name,
          runner_group_id: input.runnerGroupId,
          labels: [...input.labels],
          work_folder: input.workFolder ?? '_work',
        }),
      },
    );

    const limited = rateLimitOf(res);
    if (limited) throw limited;

    const body = await readJson(res);
    if (!res.ok) throw new RunnerJitApiError(res.status, errorDetail(body));

    const runner = asRecord(body?.['runner']);
    const rawId = runner?.['id'];
    const runnerId = typeof rawId === 'number' ? rawId : Number(rawId);
    const encoded = body?.['encoded_jit_config'];
    if (!Number.isInteger(runnerId) || typeof encoded !== 'string' || encoded.length === 0) {
      // A 201 whose shape we cannot read is WORSE than a refusal: GitHub has
      // registered a runner we now cannot name, so we cannot de-register it
      // either. Fail loudly so the reconciliation notices, rather than returning
      // a half-built config the caller would try to boot.
      throw new RunnerJitApiError(res.status, 'jit-config mint returned an unexpected shape');
    }
    const name = runner?.['name'];
    return {
      runnerId,
      runnerName: typeof name === 'string' ? name : input.name,
      encodedJitConfig: encoded,
    };
  },

  /**
   * De-register the runner. IDEMPOTENT against one that is already gone: a 404 is
   * the desired end state reached by someone else — which is the NORMAL case on
   * the happy path, because an ephemeral runner de-registers ITSELF when its one
   * job finishes.
   *
   * The call that matters is the abnormal one. §7.4's verified finding is that
   * `generate-jitconfig` registers the runner at MINT time, before any container
   * exists, so every path between "minted" and "the runner took its job" must
   * come back here or leave a permanently-offline runner in the org's list. Those
   * accumulate silently, count against nothing, and are indistinguishable from a
   * real fleet runner that has wedged — which is exactly what makes them
   * expensive later.
   */
  async deleteRunner(runnerId: number, target?: GithubOrgTarget): Promise<void> {
    await runnerJitConfigClient.removeRunner(runnerId, target);
  },

  /**
   * {@link deleteRunner}, saying WHICH end state it reached: `removed` when this
   * call de-registered the runner, `gone` when GitHub no longer knew it (404).
   *
   * The idle retirement (MOTIR-11230) needs the difference. It de-registers a
   * runner BEFORE it destroys the runner's container, because a registered runner
   * can be handed a job at any moment and a de-registered one cannot — and a
   * runner that is already `gone` has de-registered ITSELF, which an ephemeral
   * runner does only after its one job. Any other refusal throws, and the caller
   * must leave the container alone: GitHub declined to remove a runner that may
   * be running a job.
   */
  async removeRunner(runnerId: number, target?: GithubOrgTarget): Promise<'removed' | 'gone'> {
    const { org, token } = await resolveOrgAuth(target);
    const res = await request(
      `${GITHUB_API}/orgs/${encodeURIComponent(org)}/actions/runners/${runnerId}`,
      { method: 'DELETE', token, operation: 'de-registration' },
    );
    if (res.ok) return 'removed';
    if (res.status === 404) return 'gone';
    throw new RunnerJitApiError(res.status, errorDetail(await readJson(res)));
  },

  /**
   * What GitHub says about ONE registered runner right now — `null` when it no
   * longer knows it (404), which for an ephemeral runner means it ran its one job
   * and de-registered itself (MOTIR-11230).
   *
   * `busy` is GitHub's own answer to "is this runner running a job". It is the
   * fact the idle retirement must never get wrong, so a body that does not carry
   * it as a boolean throws rather than reading as idle.
   */
  async readRunner(
    runnerId: number,
    target?: GithubOrgTarget,
  ): Promise<{ busy: boolean; online: boolean } | null> {
    const { org, token } = await resolveOrgAuth(target);
    const res = await request(
      `${GITHUB_API}/orgs/${encodeURIComponent(org)}/actions/runners/${runnerId}`,
      { method: 'GET', token, operation: 'runner read' },
    );
    if (res.status === 404) return null;
    const body = await readJson(res);
    if (!res.ok) throw new RunnerJitApiError(res.status, errorDetail(body));
    const busy = body?.['busy'];
    if (typeof busy !== 'boolean') {
      throw new RunnerJitApiError(res.status, 'runner read returned no busy flag');
    }
    return { busy, online: body?.['status'] === 'online' };
  },

  /**
   * De-register by NAME — the cleanup for a mint whose ANSWER never arrived
   * (MOTIR-2011).
   *
   * {@link deleteRunner} needs the numeric id from the mint's 201, and a mint
   * that blows its deadline never delivers one. But §7.4's verified finding is
   * that `generate-jitconfig` registers the runner BEFORE returning, so a
   * timed-out mint is precisely the case that can leave a dangling registered
   * runner — the one case with no id to name it by. The name is the other
   * handle: `runnerNameFor(intent)` is deterministic, so the runner the mint may
   * have created is findable without it.
   *
   * The `name` query parameter is sent AND the result is filtered again here.
   * Belt and braces on purpose: if a GitHub that ignored an unknown parameter
   * returned the whole org's runner list, an unfiltered delete would de-register
   * the entire fleet mid-job. The client-side match is what makes that
   * impossible rather than unlikely.
   *
   * Returns the ids it removed (empty when GitHub never registered one, which is
   * the good case). Never throws for "already gone" — {@link deleteRunner}'s 404
   * tolerance covers the race with the sweeper.
   */
  async deleteRunnersNamed(name: string, target?: GithubOrgTarget): Promise<number[]> {
    const { org, token } = await resolveOrgAuth(target);
    const res = await request(
      `${GITHUB_API}/orgs/${encodeURIComponent(org)}/actions/runners` +
        `?per_page=100&name=${encodeURIComponent(name)}`,
      { method: 'GET', token, operation: 'runner lookup' },
    );
    const body = await readJson(res);
    if (!res.ok) throw new RunnerJitApiError(res.status, errorDetail(body));

    const listed = Array.isArray(body?.['runners']) ? (body['runners'] as unknown[]) : [];
    const ids = listed.flatMap((entry) => {
      const runner = asRecord(entry);
      if (runner?.['name'] !== name) return [];
      const id = typeof runner['id'] === 'number' ? runner['id'] : Number(runner['id']);
      return Number.isInteger(id) ? [id] : [];
    });

    for (const id of ids) await runnerJitConfigClient.deleteRunner(id, target);
    return ids;
  },
};
