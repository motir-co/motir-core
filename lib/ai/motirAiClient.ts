import 'server-only';

// The motir-core → motir-ai client: a SERVER-ONLY leaf primitive (like
// lib/email.ts). Services import it; routes never do, and the `server-only`
// import above makes bundling it into a Client Component a build error — the
// open-core invariant that browsers never reach motir-ai (docs/ai-boundary.md).
//
// It is the single seam the 7.2 chat, 7.3/7.4 generation, and the 7.8 planning
// tools call — a clean abstraction over the boundary, not endpoint glue. It
// submits jobs (minting the §4b job-scoped read-back token), polls them, and
// streams them, mapping the §5 problem+json taxonomy to motir-core typed errors.

import { mintJobToken } from './jobToken';
import { assertFlagOn, evaluateOrgFeatureFlags } from '@/lib/featureFlags/evaluate';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import type {
  CalculatorAnswerDTO,
  CalculatorCategoriesDTO,
  CalculatorEmptyCategoryDTO,
  CalculatorEstimateDTO,
  CalculatorEstimateRequestDTO,
} from '@/lib/dto/billing';
import {
  parseIndexAllowanceSummary,
  parseIndexAllowanceVerdict,
  parseOrgIndexPools,
  parseOrgTiers,
  type IndexAllowanceSummary,
  type OrgIndexPools,
  type IndexAllowanceVerdict,
} from '@/lib/ciFleet/indexAllowance';
import {
  MotirAiConfigError,
  MotirAiConflictError,
  MotirAiInsufficientBalanceError,
  MotirAiUnavailableError,
  PlatformLessonNotFoundError,
  PlannerModelListEntryInUseError,
  PlannerModelListFallbackError,
  PlannerModelListRefusedError,
  PlannerModelNotOfferedError,
  PlannerModelNotQualifiedError,
  PlannerModelUnreachableError,
  AI_JOB_ABANDONED_PROBLEM_CODE,
  calculatorRefusalOf,
  calculatorUnavailableOf,
  errorFromProblem,
  jobErrorFromProblem,
  planChangeRefusalOf,
  type JobView,
} from './errors';
import type {
  RawDowngradePreview,
  RawDowngradeResult,
  RawPendingDowngrade,
  RawUpgradePreview,
  RawUpgradeResult,
  AdminCreditWriteInput,
  AdminCreditWriteResult,
  AdminLedgerQuery,
  AdminLedgerRead,
  AdminTierWriteInput,
  AdminTierWriteResult,
  CiOverageDebitInput,
  JobContextBag,
  JobKind,
  JobStreamEvent,
  PlannerModelCandidateRead,
  PlannerModelListEntryRead,
  PlannerModelListRead,
  PlannerModelListWriteInput,
  PlannerModelSettingsRead,
  PlannerModelWriteInput,
  PlannerModelWriteResult,
  PreplanStateQuery,
  Problem,
  RawBillingHistoryResponse,
  RawCiOverageDebitResponse,
  RawEmbeddingBatchResponse,
  RawJobResponse,
  RawPreplanSession,
  RawPreplanStateResponse,
  RawSubscriptionResponse,
  RawUsageResponse,
  RequestEnvelope,
  SubscriptionQuery,
  Tenant,
  UsageQuery,
} from './types';
import { parseJobWalkStop } from '@/lib/planChange/failureRecord';
import { PLANNER_MODEL_LIST_REASONS, type PlannerModelListReason } from './types';
import type { CategoryFigures, SpendCategory } from '@/lib/platform/spend';

// The actor a job runs on behalf of — the read-back token is minted for them, so
// motir-ai reads/proposes only what this user could (contract §4b).
export interface RequestActor {
  userId: string;
}

interface ClientConfig {
  url: string;
  serviceToken: string;
}

/**
 * motir-ai's base URL as THIS PROCESS reaches it — WITHOUT the service token
 * (MOTIR-2026).
 *
 * ⚠️ IT EXISTS SO ONE CALLER CAN HAVE THE URL AND NOT THE TOKEN. {@link config}
 * refuses when `MOTIR_AI_SERVICE_TOKEN` is unset and hands the token back beside
 * the url, so a caller that needs only the address cannot use it.
 *
 * ⚠️ IT IS NOT THE ADDRESS AN INDEX CONTAINER IS GIVEN — see
 * {@link motirAiContainerBaseUrl}, directly below, and read the two together.
 * This paragraph used to say the opposite in those words ("a fleet index
 * container is handed `MOTIR_AI_BASE_URL`…"), and the dispatcher did exactly
 * what it said. **CORRECTED (MOTIR-4518):** `MOTIR_AI_URL` is the address
 * motir-core reaches motir-ai at, which in production was a PRIVATE, org-scoped
 * 6PN name (`http://motir-ai.internal:8080`) from 2026-08-21 until 2026-10-02 —
 * and is motir-ai's PUBLIC origin since, because motir-ai's pool
 * suspends to zero and a 6PN name cannot wake it (application-hosting.md
 * Amendment 9, MOTIR-7407); an index container runs in a DIFFERENT
 * organization, where that 6PN name does not resolve at all. Every index run died at
 * `getaddrinfo ENOTFOUND motir-ai.internal` for two weeks — after building the
 * graph, one call before it could be uploaded — because these two values were
 * one value.
 *
 * Read at CALL time, like everything else here.
 */
export function motirAiBaseUrl(): string {
  const url = process.env['MOTIR_AI_URL'];
  if (!url) throw new MotirAiConfigError('MOTIR_AI_URL is not set');
  return url.replace(/\/+$/, '');
}

/**
 * The env var carrying the address an INDEX CONTAINER is given for motir-ai.
 * Exported so the preflight and its message name the same literal the accessor
 * reads (MOTIR-4518).
 */
export const MOTIR_AI_CONTAINER_URL_ENV_VAR = 'MOTIR_AI_CONTAINER_URL';

/**
 * motir-ai's base URL AS THE INDEX CONTAINER MUST REACH IT (MOTIR-4518) — the
 * value that becomes the container's `MOTIR_AI_BASE_URL`.
 *
 * ⚠️ WHY THIS IS A SECOND ACCESSOR AND NOT A SECOND CALL TO ITS TWIN. The two
 * callers are in DIFFERENT PLACES, so they are different values, and the code
 * has to be able to say so:
 *
 * | who is calling | from where | which address |
 * | --- | --- | --- |
 * | motir-core (this process) | the `moooon` organization | {@link motirAiBaseUrl} — `MOTIR_AI_URL`, the public origin in production (Amendment 9) |
 * | an index container | the FLEET's own organization | this accessor — `MOTIR_AI_CONTAINER_URL`, which must resolve from outside `moooon` |
 *
 * A `.internal` name is 6PN: the platform resolves it only for machines in the
 * SAME organization as the app it names, so it is unusable for the row below —
 * private-network addressing is scoped to a network, and the two callers are on
 * different ones. Both rows hold the public origin in production today, for
 * DIFFERENT reasons: the container because of the org boundary, motir-core
 * because motir-ai's pool sleeps and only the Fly proxy wakes it
 * (application-hosting.md Amendment 9, MOTIR-7407). They stay two variables
 * so the two callers can diverge again without one dragging the other.
 *
 * ⚠️ AND THERE IS NO FALLBACK TO `MOTIR_AI_URL`, DELIBERATELY. A default is what
 * turned the original mistake into two silent weeks: the container booted, ran
 * for nineteen minutes, built a 45 MB graph and threw it away at the upload
 * grant, while the ledger recorded success. Unset must be LOUD and must be loud
 * BEFORE a machine is billed — this throws inside `bootIndexContainer`'s
 * deployment gate, which releases the admission slot and records a failure
 * instead of a phantom index.
 *
 * The container's authority is unchanged and is not widened by this: it still
 * carries only a run-scoped credential, minted per (project, repo, run), and
 * motir-ai's container-facing routes are gated on it (`runCredentialAuth`) —
 * verified anonymously against the public host, which answers 401
 * `service_unauthorized` rather than serving anything.
 *
 * Read at CALL time, like everything else here.
 */
export function motirAiContainerBaseUrl(): string {
  const url = process.env[MOTIR_AI_CONTAINER_URL_ENV_VAR];
  if (!url) {
    throw new MotirAiConfigError(`${MOTIR_AI_CONTAINER_URL_ENV_VAR} is not set`);
  }
  return url.replace(/\/+$/, '');
}

// Read + validate config at CALL time (not module load), so the module imports
// cleanly in dev/test/CI without these env vars set — and fails FAST with a
// clear error the moment a caller actually tries to reach motir-ai.
function config(): ClientConfig {
  // The url is resolved through the exported accessor rather than re-read here,
  // so both callers normalise it the same way. The ORDER is unchanged: a
  // deployment missing both variables still hears about the url first.
  const url = motirAiBaseUrl();
  const serviceToken = process.env['MOTIR_AI_SERVICE_TOKEN'];
  if (!serviceToken) throw new MotirAiConfigError('MOTIR_AI_SERVICE_TOKEN is not set');
  return { url, serviceToken };
}

function authHeaders(serviceToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${serviceToken}`,
    'content-type': 'application/json',
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Request deadlines (MOTIR-1974) ──────────────────────────────────────────
//
// Every call across this boundary rides a DEADLINE. `fetch` has none of its
// own, so an unresponsive motir-ai is waited on until something ELSE kills the
// caller — and on Vercel that something is the platform, which returns a bare
// `FUNCTION_INVOCATION_TIMEOUT` 504 with no step output. That is how the whole
// `system.code-graph-index` fleet dead-lettered: Inngest never saw a
// `MotirAiUnavailableError` its retry budget could absorb, only an untyped
// invocation kill it could not distinguish from a crashed app.
//
// The deadline bounds TIME-TO-RESPONSE-HEADERS, not body consumption: the timer
// is cleared the moment `fetch` resolves. So it covers connect + request-send +
// the server's think time, while leaving a long-lived response body —
// `streamJob`'s SSE stream — free to run as long as it needs. A stream that
// never connects still fails fast.
//
// It is now the ONLY deadline on this boundary. The second, much longer one
// existed for the tarball-upload call, which shipped a whole repo and waited for
// the graph build; that call is gone (MOTIR-2138) and every remaining method is
// a JSON request whose answer is either fast or broken. A NEW slow call does not
// get an exemption here — it gets a job.
export const MOTIR_AI_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The detail for a `fetch` that threw. Node's `fetch` (undici) throws one
 * `TypeError('fetch failed')` for EVERY transport failure and puts what actually
 * happened on `err.cause` — `ENOTFOUND` for a name that does not resolve,
 * `ECONNREFUSED`, `ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`. Reporting the bare
 * message made every outage read the same: MOTIR-7337 was 78 events across five
 * monitor issues of `fetch failed` and nothing else, and telling "the name is
 * gone" from "the machine is asleep" took a timeline reconstruction.
 *
 * Only the cause's CODE is appended, never its message: the message names hosts
 * and private addresses, and this text reaches API callers (the v1 error body is
 * `err.message`). The whole cause rides `Error.cause` for the monitor instead.
 */
function describeTransportFailure(err: unknown): string {
  const message = describe(err);
  const codes: string[] = [];
  let cause: unknown = err instanceof Error ? err.cause : undefined;
  // A cause can itself have a cause (an AggregateError of per-address connect
  // failures, a wrapped socket error); three levels is deeper than undici nests.
  for (let depth = 0; depth < 3 && cause instanceof Error; depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && code && !codes.includes(code)) codes.push(code);
    cause = cause.cause;
  }
  return codes.length > 0 ? `${message} (${codes.join(', ')})` : message;
}

/**
 * `fetch` with a deadline, mapping BOTH a transport failure and a timeout to
 * `MotirAiUnavailableError` — the single typed error every caller (and every
 * job retry budget) already understands.
 */
async function aiFetch(
  input: string,
  init: RequestInit,
  timeoutMs: number = MOTIR_AI_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    // The abort is OURS, so report the deadline rather than the opaque
    // "This operation was aborted" the runtime throws.
    if (controller.signal.aborted) {
      throw new MotirAiUnavailableError(`motir-ai did not respond within ${timeoutMs}ms`);
    }
    throw new MotirAiUnavailableError(describeTransportFailure(err), { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

// Best-effort parse of a non-2xx body into a Problem (contract §5); falls back
// to a synthetic problem when the body isn't problem+json.
async function readProblem(res: Response): Promise<Problem> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && typeof (body as Problem).code === 'string') {
      return body as Problem;
    }
  } catch {
    // not JSON — fall through
  }
  return {
    type: 'about:blank',
    title: res.statusText || 'request failed',
    status: res.status,
    code: 'internal_error',
  };
}

/**
 * How long a KEYED submit keeps re-sending before it gives up (MOTIR-9255).
 *
 * motir-ai's conversation machines suspend after a minute idle, and waking one was
 * measured at ~76 s — and two minutes when Fly's own wake timed out. A single
 * 30 s attempt therefore fails the first turn after a quiet spell while the
 * request is still served once the machine is up: a billed job nobody follows.
 * A submit that carries an `idempotencyKey` re-sends under the SAME key until
 * this budget is spent; motir-ai answers every repeat with the one job the key
 * created, so a re-send can never run or bill a turn twice.
 */
export const MOTIR_AI_SUBMIT_BUDGET_MS = 90_000;

/** The pause between two attempts of a keyed submit. */
export const MOTIR_AI_SUBMIT_RESEND_PAUSE_MS = 2_000;

/**
 * POST /v1/jobs once per attempt until one answers or the budget is spent. Only a
 * `MotirAiUnavailableError` — a timeout, a transport failure, a 5xx from a proxy
 * that could not wake the machine — is re-sent; anything else is final. Without a
 * key there is ONE attempt, as there always was: a keyless re-send could create a
 * second job.
 */
async function postJobWithinBudget(
  url: string,
  init: RequestInit,
  keyed: boolean,
): Promise<Response> {
  const deadline = Date.now() + MOTIR_AI_SUBMIT_BUDGET_MS;
  for (;;) {
    const remaining = deadline - Date.now();
    try {
      const res = await aiFetch(url, init, Math.min(MOTIR_AI_REQUEST_TIMEOUT_MS, remaining));
      if (!res.ok) throw errorFromProblem(await readProblem(res));
      return res;
    } catch (err) {
      const left = deadline - Date.now() - MOTIR_AI_SUBMIT_RESEND_PAUSE_MS;
      if (!keyed || !(err instanceof MotirAiUnavailableError) || left <= 0) throw err;
      await new Promise((resolve) => setTimeout(resolve, MOTIR_AI_SUBMIT_RESEND_PAUSE_MS));
    }
  }
}

// POST /v1/jobs — mint the read-back token, post a valid v1 envelope, return the
// jobId. Never blocks on execution (motir-ai returns 202 immediately).
export async function submitJob(
  kind: JobKind,
  tenant: Tenant,
  context: JobContextBag,
  actor: RequestActor,
  opts: {
    resume?: { planId: string; fromJobId: string };
    /** One job per key (MOTIR-9255): a keyed submit is re-sent within
     *  {@link MOTIR_AI_SUBMIT_BUDGET_MS}, and a repeat answers the first job. */
    idempotencyKey?: string;
  } = {},
): Promise<{ jobId: string }> {
  const { url, serviceToken } = config();
  // THE PER-ORG KILL-SWITCHES (MOTIR-750), read here because every new planning
  // job — every surface, every actorless cadence — leaves through this one
  // function. One indexed statement against core's own database, no external
  // round trip; a suspended org (MOTIR-748) reads every switch off. `ai_planning`
  // off refuses the job before anything is minted or sent (→ 403
  // `ORG_FEATURE_DISABLED`); `web_search` off rides the envelope as
  // `tenant.webSearch: false` for motir-ai to honour.
  const switches = await evaluateOrgFeatureFlags(tenant.organizationId);
  assertFlagOn(switches, 'ai_planning');
  const sentTenant: Tenant = switches.web_search ? tenant : { ...tenant, webSearch: false };
  // Each submission — a resume included — is a NEW job, so the mint gives it a
  // fresh `jobKey`: its read-backs are metered per job (MOTIR-8599 / MOTIR-8604).
  const readBackToken = mintJobToken({
    userId: actor.userId,
    workspaceId: tenant.workspaceId,
    projectId: tenant.projectId,
  });
  const envelope: RequestEnvelope = {
    envelopeVersion: 'v1',
    jobKind: kind,
    tenant: sentTenant,
    context,
    readBackToken,
    // Only when resuming a failed walk (MOTIR-7916): absent ⇒ the body is byte-identical to today.
    ...(opts.resume ? { resume: opts.resume } : {}),
    // Only on a keyed submit (MOTIR-9255): absent ⇒ the body is byte-identical to today.
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  };

  const res = await postJobWithinBudget(
    `${url}/v1/jobs`,
    { method: 'POST', headers: authHeaders(serviceToken), body: JSON.stringify(envelope) },
    Boolean(opts.idempotencyKey),
  );

  const body: unknown = await res.json();
  const jobId = (body as { jobId?: unknown })?.jobId;
  if (typeof jobId !== 'string' || !jobId) {
    throw new MotirAiUnavailableError('submit response missing a jobId');
  }
  return { jobId };
}

/**
 * The query parameter the two job reads scope themselves with — the ONE seam in
 * MOTIR-2291 that no single repo's tests can cover.
 *
 * ⚠️ IT IS A CROSS-REPO CONTRACT AND IT FAILS CLOSED AND SILENTLY. motir-ai's
 * `GET /v1/jobs/:id` requires this exact name (MOTIR-2360); a typo on either side
 * produces a `validation_error` on every job read — no type error, no test
 * failure in the repo that made it, just a product where nothing streams. Naming
 * it once here, and pinning the string in
 * `tests/permissions/memberFacingGate.integration.test.ts`, is what makes a drift
 * a red test rather than a support ticket.
 */
export const JOB_SCOPE_QUERY_PARAM = 'coreProjectId';

// GET /v1/jobs/:id — status + result, with a failed job's error mapped to a
// typed error. A 404 / transport failure throws a typed error.
//
// ⚠️ `coreProjectId` IS REQUIRED, AND MOTIR-AI DOES NOT READ IT YET (Story
// MOTIR-2291 · Subtask MOTIR-2359). Until this card, a job was readable by its
// ID ALONE on both sides of the boundary: this call sent the SERVICE token and
// nothing else, and motir-ai's `GET /v1/jobs/:id` answered `getJobView(id)` with
// no tenant filter — its `JobView` carries no owning project, so core had nothing
// to check even if it wanted to. The binding exists upstream
// (`PlanJob.aiProjectId` → `AiProject.coreProjectId`); MOTIR-2360 is the card
// that enforces it on the read.
//
// So core starts SENDING the id first. Sending one the producer does not yet
// read is harmless; requiring one the consumer does not yet send is not, which is
// why the order is this way round. The parameter is NON-OPTIONAL on purpose: a
// call site that cannot supply a project id is a call site that has not resolved
// its project, and that is the bug this whole story is about.
export async function getJob(jobId: string, coreProjectId: string): Promise<JobView> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({ [JOB_SCOPE_QUERY_PARAM]: coreProjectId });
  const res = await aiFetch(`${url}/v1/jobs/${encodeURIComponent(jobId)}?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));

  const body = (await res.json()) as RawJobResponse;
  return {
    jobId: body.jobId,
    status: body.status,
    result: body.result ?? null,
    error: body.error ? jobErrorFromProblem(body.error) : null,
    walkStop: parseJobWalkStop(body.error?.walkStop),
    // Read from the RAW problem: once mapped, an abandoned job's error is the same
    // `MotirAiUnavailableError` an outage produces (MOTIR-8304).
    lostMachine: body.status === 'failed' && body.error?.code === AI_JOB_ABANDONED_PROBLEM_CODE,
    // motir-ai's own verdict on a failed planning job (MOTIR-9121); anything that is not a
    // boolean reads as "did not say", never as `false`.
    ...(typeof body.resumable === 'boolean' ? { resumable: body.resumable } : {}),
  };
}

// DELETE /v1/jobs/:id — cancel a job core has given up on (MOTIR-9065), so a job
// still waiting in motir-ai's queue cannot start later against a session core has
// already recorded failed. The route is the one `docs/contract.md` names
// (`200 { jobId, status: "canceled" }`); it carries the same project scope as
// `getJob`. A non-2xx throws the typed error, which the caller reports — a cancel
// that could not be made is said, never swallowed.
export async function cancelJob(
  jobId: string,
  coreProjectId: string,
): Promise<{ jobId: string; status: string }> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({ [JOB_SCOPE_QUERY_PARAM]: coreProjectId });
  const res = await aiFetch(`${url}/v1/jobs/${encodeURIComponent(jobId)}?${params.toString()}`, {
    method: 'DELETE',
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as { jobId: string; status: string };
  return { jobId: body.jobId, status: body.status };
}

// GET /v1/usage — the org cost rollup for the cost dashboard (Subtask 7.2.11),
// at a drill level (org / workspace / project). Read-through: the caller is the
// aiUsageService, which has already gated the actor and narrowed the scope. A
// transport failure / non-2xx maps to a typed error the dashboard renders as
// the error/retry state (never a misleading zero balance).
export async function getOrgUsage(query: UsageQuery): Promise<RawUsageResponse> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    coreOrganizationId: query.coreOrganizationId,
    scope: query.scope,
  });
  if (query.coreWorkspaceId) params.set('coreWorkspaceId', query.coreWorkspaceId);
  if (query.coreProjectId) params.set('coreProjectId', query.coreProjectId);
  if (query.page) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));

  const res = await aiFetch(`${url}/v1/usage?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawUsageResponse;
}

// POST /v1/credits/ci-overage — charge an org's credit ledger for CI-minutes
// OVERAGE (MOTIR-1899's endpoint; `docs/decisions/ci-minutes-allowance.md` §8.6).
//
// The caller (`ciAllowanceService`) invokes this as a BEST-EFFORT side effect
// AFTER its own charge transaction commits: the debit crosses the open-core
// boundary, so it must never roll back the local record and never fail a request
// (the shipped side-effects-outside-tx rule; `notes.html` #39). This function
// still THROWS a typed error on failure — swallowing belongs at the call site,
// which is the layer that knows the write is already durable and can decide to
// retry the same `externalRef`.
//
// Idempotent on `externalRef`, and the response's `idempotent: true` is load-
// bearing rather than informational: it is the ONLY way to learn that a debit
// which timed out had in fact landed, which is what lets a retry be safe.
export async function debitCiOverage(
  input: CiOverageDebitInput,
): Promise<RawCiOverageDebitResponse> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/credits/ci-overage`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawCiOverageDebitResponse;
}

// ── A hosted run's machine-time charge (MOTIR-6514 · motir-ai MOTIR-6513) ────

/**
 * What `POST /v1/credits/agent-machine` takes. motir-core owns the seconds, the
 * rate and the conversion (`docs/decisions/hosted-agent-machine-charge.md` §5);
 * motir-ai is handed WHOLE credits and the seconds they came from, and nothing
 * else — no cost figure, no meter row.
 */
export interface AgentMachineDebitInput {
  coreOrganizationId: string;
  /** The run's `DispatchRun.id` — send this OR `instanceIntervalId`, never both. */
  coreRunId?: string;
  /**
   * One RUNNING INTERVAL of a user agent instance (`AgentInstanceInterval.id`,
   * MOTIR-6873 · motir-ai MOTIR-6871) — recorded on motir-ai's instance-usage
   * record, never on a run's usage.
   */
  instanceIntervalId?: string;
  /** Whole credits (integer ≥ 1), already converted. */
  credits: number;
  /** The settled billable seconds the credits were computed from (integer ≥ 1). */
  billableSeconds: number;
  /** The idempotency key — the dispatch run id (one charge per run), or
   *  `agent-instance-interval:<id>` (one charge per interval). */
  externalRef: string;
  reason?: string;
  /**
   * WHERE THE RUN RAN (Story MOTIR-727 · MOTIR-7240 · motir-ai MOTIR-7238) — the run's
   * core workspace and project, sent together on the `coreRunId` path only. motir-ai
   * writes them onto the run's usage row ONCE, which is what lets the platform usage
   * rollup place the run's coding spend below its org; a run charged without them is
   * reported in the org's unattributed bucket. Never sent with `instanceIntervalId`:
   * an agent instance is not scoped to a project, and motir-ai refuses the pair.
   */
  coreWorkspaceId?: string;
  coreProjectId?: string;
}

/** The same body `ci-overage` answers, `idempotent` included. */
export type RawAgentMachineDebitResponse = RawCiOverageDebitResponse;

/**
 * POST /v1/credits/agent-machine — charge an org's ledger for ONE hosted run's
 * machine time, the ledger's third non-AI debit.
 *
 * `debitCiOverage`'s contract exactly: the caller invokes it AFTER the meter write
 * has committed, and this function THROWS a typed error on failure — the caller
 * (`hostedRunChargeService`) is the layer that knows the seconds are durable and
 * decides to retry. Idempotent on `externalRef`, so a retry after a timed-out call
 * that had in fact landed answers `idempotent: true` and moves nothing.
 */
export async function debitAgentMachine(
  input: AgentMachineDebitInput,
): Promise<RawAgentMachineDebitResponse> {
  const { url, serviceToken } = config();
  // The address travels whole or not at all — motir-ai refuses half of one.
  const { coreWorkspaceId, coreProjectId, ...charge } = input;
  const body =
    coreWorkspaceId && coreProjectId ? { ...charge, coreWorkspaceId, coreProjectId } : charge;
  const res = await aiFetch(`${url}/v1/credits/agent-machine`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawAgentMachineDebitResponse;
}

// ── An agent instance's daily storage charge (MOTIR-6919 · motir-ai MOTIR-6915) ──

/**
 * What `POST /v1/credits/agent-storage` takes: ONE agent instance's storage for
 * ONE UTC day, at the rate `docs/decisions/agent-instance-storage.md` §2 fixes.
 * There is no `externalRef` — motir-ai builds the key from `instanceId` and `day`
 * (`agent-storage:<instance id>:<day>`), so an agent is charged at most once per
 * day whatever this side retries.
 */
export interface AgentStorageDebitInput {
  coreOrganizationId: string;
  /** `AgentInstance.id`. */
  instanceId: string;
  /** The UTC day charged, `YYYY-MM-DD`. */
  day: string;
  /** Whole credits (integer ≥ 1) — the record's daily rate. */
  credits: number;
  reason?: string;
}

/** The same body `ci-overage` answers, `idempotent` included. */
export type RawAgentStorageDebitResponse = RawCiOverageDebitResponse;

/**
 * POST /v1/credits/agent-storage — charge an org's ledger for one agent's storage
 * on one UTC day, the `agent_storage` kind.
 *
 * {@link debitAgentMachine}'s contract: it THROWS a typed error on failure, and the
 * caller (`agentInstanceStorageChargeService`) — which has already written the
 * `pending` row — decides to retry. Idempotent on the instance and the day, so a
 * retry after a timed-out call that had in fact landed answers `idempotent: true`.
 */
export async function debitAgentStorage(
  input: AgentStorageDebitInput,
): Promise<RawAgentStorageDebitResponse> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/credits/agent-storage`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawAgentStorageDebitResponse;
}

/**
 * POST /v1/credits/index-check — may this organisation's next index container
 * boot? (MOTIR-4593; motir-ai MOTIR-5284.)
 *
 * ⚠️ Motir does not charge for code indexing. This reads an internal allowance and
 * attributes nothing.
 *
 * ⚠️ TOTAL, like {@link fetchCodeGraphRunVerdict}: every failure — unconfigured,
 * unreachable, a non-2xx, an older motir-ai that does not serve the route, a body
 * that is not a verdict — returns `null`. `null` means "could not ask", and the
 * DISPATCHER decides what that means (it boots: see
 * `codeGraphIndexDispatchService.askIndexAllowance`). That is also what lets the
 * two repositories' pull requests merge in either order.
 */
export async function checkIndexAllowance(
  coreOrganizationId: string,
): Promise<IndexAllowanceVerdict | null> {
  try {
    const { url, serviceToken } = config();
    const res = await aiFetch(`${url}/v1/credits/index-check`, {
      method: 'POST',
      headers: authHeaders(serviceToken),
      body: JSON.stringify({ coreOrganizationId }),
    });
    if (!res.ok) return null;
    return parseIndexAllowanceVerdict(await res.json());
  } catch {
    return null;
  }
}

/**
 * POST /v1/credits/index-draw — attribute ONE torn-down container's seconds to the
 * organisation's index allowance (MOTIR-4593; motir-ai MOTIR-5284). Idempotent on
 * `idempotencyKey`, so a replayed settle attributes once.
 *
 * ⚠️ Never a charge, and it cannot move the visible balance — motir-ai has no
 * path from this route to the ledger.
 *
 * ⚠️ TOTAL: `null` on every failure, for the reason above. A draw that could not
 * be sent is a gap in internal accounting; it must never fail a teardown.
 */
export async function drawIndexAllowance(input: {
  coreOrganizationId: string;
  containerSeconds: number;
  idempotencyKey: string;
}): Promise<IndexAllowanceVerdict | null> {
  try {
    const { url, serviceToken } = config();
    const res = await aiFetch(`${url}/v1/credits/index-draw`, {
      method: 'POST',
      headers: authHeaders(serviceToken),
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    return parseIndexAllowanceVerdict(await res.json());
  } catch {
    return null;
  }
}

/**
 * GET /v1/admin/index-allowance/summary — the per-tier index-allowance summary for
 * one period, for the PLATFORM ADMIN's Monitoring section (MOTIR-4595; motir-ai
 * MOTIR-5340). Internal accounting only — Motir does not charge for code indexing.
 *
 * ⚠️ TOTAL: `null` on every failure. The caller renders `null` as UNKNOWN, never as
 * a table of zeros — a missing read drawn as "0 crossed" would tell an operator
 * the gate holds when nobody asked.
 */
export async function fetchIndexAllowanceSummary(
  window?: string,
): Promise<IndexAllowanceSummary | null> {
  try {
    const { url, serviceToken } = config();
    const query = window ? `?${new URLSearchParams({ window }).toString()}` : '';
    const res = await aiFetch(`${url}/v1/admin/index-allowance/summary${query}`, {
      method: 'GET',
      headers: authHeaders(serviceToken),
    });
    if (!res.ok) return null;
    return parseIndexAllowanceSummary(await res.json());
  } catch {
    return null;
  }
}

/**
 * GET /v1/admin/index-allowance/orgs/:coreOrganizationId — one organisation's two
 * pools, never conflated, for the PLATFORM ADMIN's org page (MOTIR-5341; motir-ai
 * MOTIR-5340). Internal accounting only.
 *
 * ⚠️ TOTAL: `null` on every failure, which the card renders as UNKNOWN — both pools,
 * never zero. `{ known: false }` is a different answer: motir-ai has never seen the
 * org.
 */
export async function fetchOrgIndexPools(
  coreOrganizationId: string,
): Promise<OrgIndexPools | null> {
  try {
    const { url, serviceToken } = config();
    const res = await aiFetch(
      `${url}/v1/admin/index-allowance/orgs/${encodeURIComponent(coreOrganizationId)}`,
      { method: 'GET', headers: authHeaders(serviceToken) },
    );
    if (!res.ok) return null;
    return parseOrgIndexPools(await res.json());
  } catch {
    return null;
  }
}

/**
 * POST /v1/admin/orgs/tiers — resolve a page of organisations to their motir-ai
 * tier in one call (MOTIR-4595; motir-ai MOTIR-5340). At most 100 ids.
 *
 * ⚠️ TOTAL: `null` when the lookup failed, so a caller can tell "tier unknown"
 * (could not ask) from "no tier" (motir-ai has never seen the org).
 */
export async function fetchOrgTiers(
  coreOrganizationIds: string[],
): Promise<Map<string, string | null> | null> {
  if (coreOrganizationIds.length === 0) return new Map();
  try {
    const { url, serviceToken } = config();
    const res = await aiFetch(`${url}/v1/admin/orgs/tiers`, {
      method: 'POST',
      headers: authHeaders(serviceToken),
      body: JSON.stringify({ coreOrganizationIds }),
    });
    if (!res.ok) return null;
    return parseOrgTiers(await res.json());
  } catch {
    return null;
  }
}

/**
 * POST /v1/embeddings — compute vectors for the plan-tree semantic store (Story
 * MOTIR-2694 · MOTIR-2696; motir-ai's half is MOTIR-2720).
 *
 * `serviceAuth` like every other core → ai call. This repo stores embeddings and
 * does not produce them (`docs/decisions/plan-tree-embeddings.md` §6.2), so this
 * is the ONLY way a vector enters motir-core.
 *
 * BATCH: one call embeds up to `EMBEDDING_BATCH_MAX_INPUTS` texts and returns one
 * vector per input IN REQUEST ORDER — the caller pairs them positionally, so an
 * answer of the wrong length is a contract violation and is refused here rather
 * than mis-attributed to the wrong work item. That check is not defensive
 * boilerplate: a mis-paired vector is stored as if it were real and then ranks
 * the wrong card forever, with nothing failing.
 *
 * THROWS a typed error on any failure — never a partial or placeholder result.
 * Swallowing belongs at the call site, which is the layer that knows an item
 * without an embedding is simply "not yet a candidate" (ADR §6.3.5) rather than
 * an error, and that the job's retry budget will come back to it.
 */
export async function embedTexts(input: string[]): Promise<RawEmbeddingBatchResponse> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/embeddings`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));

  // VALIDATED, not cast — the same reasoning as `offboardCodeGraph` above, for a
  // consequence that is quieter and worse. Every field here is written straight
  // into a durable row: a missing `model` would store `undefined` as the hard
  // ranking filter, and a short `embeddings` array would pair vectors with the
  // wrong items from that index on.
  const body = (await res.json()) as Partial<RawEmbeddingBatchResponse> | null;
  if (
    !body ||
    typeof body.model !== 'string' ||
    body.model === '' ||
    typeof body.dimensions !== 'number' ||
    !Array.isArray(body.embeddings)
  ) {
    throw new MotirAiUnavailableError(
      'motir-ai returned a malformed body from POST /v1/embeddings',
    );
  }
  if (body.embeddings.length !== input.length) {
    throw new MotirAiUnavailableError(
      `motir-ai returned ${body.embeddings.length} embeddings for ${input.length} inputs`,
    );
  }
  return { model: body.model, dimensions: body.dimensions, embeddings: body.embeddings };
}

// GET /v1/stripe/subscription — the org's AI-pool Stripe subscription lifecycle
// (status + renewal + resolved tier) the billing panel renders (Subtask 8.1.13 →
// the 8.1.5 store). Read-through: the caller (billingService) has already gated
// the actor + the cloud build. motir-ai returns the EMPTY shape (`status: null`)
// for a free / never-transacted org — NOT a 404 — so this never throws on "no
// subscription"; only a transport failure / non-2xx maps to a typed error.
export async function getOrgSubscription(
  query: SubscriptionQuery,
): Promise<RawSubscriptionResponse> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({ coreOrganizationId: query.coreOrganizationId });
  const res = await aiFetch(`${url}/v1/stripe/subscription?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawSubscriptionResponse;
}

// GET /v1/stripe/billing-history — an org's default payment method and recent
// invoices, read-only from Stripe through motir-ai (MOTIR-7304 → the MOTIR-7303
// route), for the operator console's Billing & plans tab. The caller
// (platformOrgBillingService) has already gated the platform principal + the cloud
// build. An org with no Stripe customer is the EMPTY shape, NOT a 404; a transport
// failure, a non-2xx or a malformed body THROWS, and the caller renders the card's
// unavailable state.
export async function getBillingHistory(
  query: SubscriptionQuery,
): Promise<RawBillingHistoryResponse> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({ coreOrganizationId: query.coreOrganizationId });
  const res = await aiFetch(`${url}/v1/stripe/billing-history?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as Partial<RawBillingHistoryResponse> | null;
  if (!body || !Array.isArray(body.invoices) || body.paymentMethod === undefined) {
    throw new MotirAiUnavailableError(
      'motir-ai returned a malformed body from GET /v1/stripe/billing-history',
    );
  }
  return { paymentMethod: body.paymentMethod, invoices: body.invoices };
}

// ── The public calculator (motir-ai MOTIR-8627 · core MOTIR-8637) ─────────────
//
// GET /v1/public/calculator/categories and POST /v1/public/calculator/estimate.
// Both routes are public on motir-ai's side (no bearer needed); they go through
// this seam anyway, so the calculator shares the boundary's one deadline and one
// problem taxonomy (the service token rides along and is ignored there). The
// request carries exactly the engine's three keys — no organization id, no
// quantity — and nothing is cached: the engine owns the live model list.
//
// Each answer is SHAPE-VALIDATED, never cast: a body missing a field the view
// reads is a boundary failure (MotirAiUnavailableError → 502), not a half-drawn
// estimate. The engine's own answers are recognised first: its `unavailable`
// detail prefix and its rate limit → CalculatorUnavailableError (ask again), its
// `validation_error` → CalculatorRequestRefusedError.

async function calculatorCall(path: string, init: RequestInit): Promise<unknown> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}${path}`, { ...init, headers: authHeaders(serviceToken) });
  if (!res.ok) {
    const problem = await readProblem(res);
    throw (
      calculatorUnavailableOf(problem) ?? calculatorRefusalOf(problem) ?? errorFromProblem(problem)
    );
  }
  try {
    return await res.json();
  } catch {
    throw malformedCalculatorBody(path);
  }
}

function malformedCalculatorBody(path: string): MotirAiUnavailableError {
  return new MotirAiUnavailableError(`motir-ai returned a malformed body from ${path}`);
}

const CALCULATOR_CATEGORIES_PATH = '/v1/public/calculator/categories';
const CALCULATOR_ESTIMATE_PATH = '/v1/public/calculator/estimate';

export async function getCalculatorCategories(): Promise<CalculatorCategoriesDTO> {
  const body = await calculatorCall(CALCULATOR_CATEGORIES_PATH, { method: 'GET' });
  if (!isCalculatorCategories(body)) throw malformedCalculatorBody(CALCULATOR_CATEGORIES_PATH);
  return body;
}

export async function estimateCalculator(
  request: CalculatorEstimateRequestDTO,
): Promise<CalculatorAnswerDTO> {
  const body = await calculatorCall(CALCULATOR_ESTIMATE_PATH, {
    method: 'POST',
    body: JSON.stringify({
      plannedPerMonth: { low: request.plannedPerMonth.low, high: request.plannedPerMonth.high },
      runPerMonth: { low: request.runPerMonth.low, high: request.runPerMonth.high },
      categories: [...request.categories],
      ...(request.shares ? { shares: { ...request.shares } } : {}),
      cadence: request.cadence,
    }),
  });
  if (isCalculatorEmptyCategory(body)) return body;
  if (!isCalculatorEstimate(body)) throw malformedCalculatorBody(CALCULATOR_ESTIMATE_PATH);
  // An engine from before MOTIR-9223 answers without the two echoes; the ranges it
  // priced are then exactly the ones sent, so they are filled from the request.
  return {
    ...body,
    plannedPerMonth: body.plannedPerMonth ?? { ...request.plannedPerMonth },
    runPerMonth: body.runPerMonth ?? { ...request.runPerMonth },
  };
}

type Json = Record<string, unknown>;
const CALCULATOR_LANES = ['planning', 'running'] as const;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}
function isStrList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isStr);
}
function isCadence(v: unknown): boolean {
  return v === 'annual' || v === 'monthly';
}
function perLane(v: unknown, test: (x: unknown) => boolean): boolean {
  return isObj(v) && CALCULATOR_LANES.every((lane) => test(v[lane]));
}
function isRange(v: unknown): boolean {
  return isObj(v) && isNum(v['low']) && isNum(v['high']);
}
function isTopUpAmount(v: unknown): boolean {
  return isObj(v) && isNum(v['units']) && isNum(v['credits']) && isNum(v['priceUsd']);
}

function isSplit(v: unknown): boolean {
  return (
    isObj(v) &&
    isNum(v['count']) &&
    Array.isArray(v['categories']) &&
    v['categories'].every(
      (c) => isObj(c) && isStr(c['key']) && isNum(c['weight']) && isStrList(c['models']),
    )
  );
}

function isCalculatorCategories(v: unknown): v is CalculatorCategoriesDTO {
  return (
    isObj(v) &&
    isNum(v['version']) &&
    isStr(v['categoryRuleVersion']) &&
    isStr(v['modelsReadAt']) &&
    Array.isArray(v['cadences']) &&
    v['cadences'].every(isCadence) &&
    isCadence(v['defaultCadence']) &&
    Array.isArray(v['categories']) &&
    v['categories'].every(
      (c) =>
        isObj(c) &&
        isStr(c['key']) &&
        Array.isArray(c['models']) &&
        c['models'].every((m) => isObj(m) && isStr(m['id']) && isStr(m['provider'])),
    )
  );
}

function isCalculatorEstimate(v: unknown): v is CalculatorEstimateDTO {
  if (!isObj(v) || v['kind'] !== 'estimate') return false;
  const { credits, recommendation: rec, topUp, ceiling } = v;
  return (
    isNum(v['version']) &&
    isStr(v['profilesVersion']) &&
    isStr(v['categoryRuleVersion']) &&
    isCadence(v['cadence']) &&
    (v['plannedPerMonth'] === undefined || isRange(v['plannedPerMonth'])) &&
    (v['runPerMonth'] === undefined || isRange(v['runPerMonth'])) &&
    isObj(credits) &&
    isNum(credits['low']) &&
    isNum(credits['high']) &&
    perLane(v['perItemCredits'], isNum) &&
    isSplit(v['split']) &&
    isObj(rec) &&
    (rec['planKey'] === null || isStr(rec['planKey'])) &&
    (rec['planName'] === null || isStr(rec['planName'])) &&
    isNum(rec['monthlyPriceUsd']) &&
    // Absent from an engine older than MOTIR-9189; a number whenever it is sent.
    (rec['poolCredits'] === undefined || isNum(rec['poolCredits'])) &&
    isObj(topUp) &&
    isTopUpAmount(topUp['low']) &&
    isTopUpAmount(topUp['high']) &&
    isObj(ceiling) &&
    (ceiling['credits'] === null || isNum(ceiling['credits'])) &&
    typeof ceiling['exceeded'] === 'boolean' &&
    isNum(ceiling['excessCredits']) &&
    (ceiling['outcome'] === 'within_ladder' ||
      ceiling['outcome'] === 'larger_pool' ||
      ceiling['outcome'] === 'largest_pool' ||
      ceiling['outcome'] === 'top_ups_only')
  );
}

function isCalculatorEmptyCategory(v: unknown): v is CalculatorEmptyCategoryDTO {
  return (
    isObj(v) &&
    v['kind'] === 'empty_category' &&
    isNum(v['version']) &&
    isStr(v['categoryRuleVersion']) &&
    isStrList(v['categories'])
  );
}

// POST /v1/stripe/checkout-session — start a subscription-mode, Stripe-hosted
// Checkout Session for an org + a selected price, returning the hosted URL the
// caller redirects to (Subtask 8.1.6 → the 8.1.5 endpoint). The Stripe SECRET
// never crosses this boundary — motir-ai owns the SDK and the customer; motir-core
// only initiates and gets back a URL (the open-core invariant). The caller
// (billingService) has already gated the actor (org owner) + the cloud build. A
// transport failure / non-2xx maps to a typed error.
export async function createCheckoutSession(input: {
  coreOrganizationId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  /**
   * Unit count for the resolved Price — the credit top-up's bundle multiplier
   * (MOTIR-2949). motir-ai reads it as an optional integer >= 1 and defaults to
   * 1; the caller (`billingService.startCheckout`) always sends an explicit
   * number, so the charge is never decided by a default two services away.
   */
  quantity?: number;
  idempotencyKey?: string;
}): Promise<CheckoutSessionOutcome> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/stripe/checkout-session`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body: unknown = await res.clone().json();
  const outcome = (body as { outcome?: unknown; livePriceLookupKey?: unknown }) ?? {};
  // An org already on a live AI plan gets a pointer to the upgrade path, a normal
  // 200 and never a second subscription (motir-ai MOTIR-8386).
  if (outcome.outcome === 'existing_plan' && typeof outcome.livePriceLookupKey === 'string') {
    return { outcome: 'existing_plan', livePriceLookupKey: outcome.livePriceLookupKey };
  }
  return { outcome: 'session', ...(await readSessionUrl(res)) };
}

/**
 * What a checkout answers (motir-ai MOTIR-8386): a session to redirect to, or — for
 * an org that already holds a live AI plan — the plan it holds, so the caller sends
 * the person to the upgrade path instead of a second subscription.
 */
export type CheckoutSessionOutcome =
  | { outcome: 'session'; url: string }
  | { outcome: 'existing_plan'; livePriceLookupKey: string };

// POST /v1/stripe/portal-session — open a short-lived Billing Portal session for
// an org that already has a Stripe Customer, returning its URL (the client
// redirects immediately — the portal session expires in ~5 min). A 404 (the org
// has no customer yet) maps to MotirAiJobNotFoundError via the §5 `not_found`
// code. The caller has already gated the actor (org owner) + the cloud build.
export async function createPortalSession(input: {
  coreOrganizationId: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/stripe/portal-session`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return readSessionUrl(res);
}

// ── Changing the org's AI plan (motir-ai MOTIR-8396 / MOTIR-8398 / MOTIR-8399) ──
//
// The caller (billingService) has already gated the actor (an owner or admin) and
// the cloud build. A refusal motir-ai answers with a reason the dialog draws
// (`same_plan`, `payment_failed`, `preview_expired`, …) becomes a typed
// MotirAiPlanChangeRefusedError carrying that reason; everything else maps through
// the shared problem taxonomy.

async function planChangePost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}${path}`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const problem = await readProblem(res);
    throw planChangeRefusalOf(problem) ?? errorFromProblem(problem);
  }
  return (await res.json()) as T;
}

// POST /v1/stripe/upgrade/preview — what an upgrade costs now and grants. Writes nothing.
export function previewPlanUpgrade(input: {
  coreOrganizationId: string;
  toPlanKey: string;
}): Promise<RawUpgradePreview> {
  return planChangePost('/v1/stripe/upgrade/preview', input);
}

// POST /v1/stripe/upgrade — upgrade now, at the `prorationDate` the preview returned.
export function upgradePlan(input: {
  coreOrganizationId: string;
  toPlanKey: string;
  prorationDate: number;
}): Promise<RawUpgradeResult> {
  return planChangePost('/v1/stripe/upgrade', input);
}

// POST /v1/stripe/downgrade/preview — what a downgrade at the period end would do.
export function previewPlanDowngrade(input: {
  coreOrganizationId: string;
  toPlanKey: string;
}): Promise<RawDowngradePreview> {
  return planChangePost('/v1/stripe/downgrade/preview', input);
}

// POST /v1/stripe/downgrade — schedule the lower plan for the period end.
export function schedulePlanDowngrade(input: {
  coreOrganizationId: string;
  toPlanKey: string;
}): Promise<RawDowngradeResult> {
  return planChangePost('/v1/stripe/downgrade', input);
}

// GET /v1/stripe/pending-plan-change — the downgrade the org's live plan has
// scheduled, or `null`. Never a 404: no live plan is `null`.
export async function getPendingPlanChange(
  query: SubscriptionQuery,
): Promise<{ pendingDowngrade: RawPendingDowngrade | null }> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({ coreOrganizationId: query.coreOrganizationId });
  const res = await aiFetch(`${url}/v1/stripe/pending-plan-change?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as { pendingDowngrade?: RawPendingDowngrade | null } | null;
  return { pendingDowngrade: body?.pendingDowngrade ?? null };
}

// Both Stripe session endpoints return `{ url }` (contract §2.4); a 2xx body
// missing the URL is an unexpected upstream response, not a client condition.
async function readSessionUrl(res: Response): Promise<{ url: string }> {
  const body: unknown = await res.json();
  const sessionUrl = (body as { url?: unknown })?.url;
  if (typeof sessionUrl !== 'string' || !sessionUrl) {
    throw new MotirAiUnavailableError('stripe session response missing a url');
  }
  return { url: sessionUrl };
}

// The motir-ai seat-sync response (Subtask 8.1.12): whether a Stripe write was
// applied + why. The caller (the seat-sync job) uses it only for logging — the
// durable effect is on the Stripe side.
export interface SeatQuantityResult {
  applied: boolean;
  outcome:
    | 'org_not_found'
    | 'no_customer'
    | 'no_active_tracker_subscription'
    | 'unchanged'
    | 'updated';
}

// POST /v1/stripe/seat-quantity — set the org's scaled-tracker seat `quantity` to
// an ABSOLUTE target (the recomputed active-member count), prorated + invoiced
// promptly (Subtask 8.1.12 → the 8.1.5/8.1.12 endpoint). motir-ai owns the Stripe
// SDK + secret and resolves the tracker line itself; motir-core only passes the
// org + count. A non-scaled org is a benign no-op `200` (never a 404), so the
// caller fires this on any membership change. A transport failure / non-2xx maps
// to a typed error the seat-sync job's retry budget absorbs.
export async function setSeatQuantity(input: {
  coreOrganizationId: string;
  quantity: number;
}): Promise<SeatQuantityResult> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/stripe/seat-quantity`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as SeatQuantityResult;
}

// GET /v1/preplan — the resumable pre-plan read surface (Subtask 7.3.25): the
// session decisions/position/transcript + each artifact's forward revision log /
// diffs. Read-through: the caller (the 7.3.5 gate / 7.3.9 resume) has already
// gated the actor + resolved the core ids. Keyed by (coreWorkspaceId,
// coreProjectId); motir-ai resolves its AiProject READ-ONLY and returns the empty
// state for a not-yet-started project (never a 404). A transport failure / non-2xx
// maps to a typed error the caller renders as the error/retry state.
export async function getPreplanState(query: PreplanStateQuery): Promise<RawPreplanStateResponse> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    coreWorkspaceId: query.coreWorkspaceId,
    coreProjectId: query.coreProjectId,
  });
  const res = await aiFetch(`${url}/v1/preplan?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawPreplanStateResponse;
}

// PATCH /v1/preplan — the pre-plan WRITE seam (Subtask 7.3.81): persist the
// onboarding design choice the user picked in the design step (MOTIR-1040). Unlike
// the read above, a write FIND-OR-CREATES the AiProject + its org spine, so the
// body carries the `coreOrganizationId` too (the caller — aiPreplanService — has
// resolved it). `designChoice` is Motir's three axes `{ styleId, paletteId, typeId }`,
// validated against the motir-core registries BEFORE this call (motir-ai stores it
// opaquely); `designStarter` is the distinct with-design-vs-bare starter flag.
// motir-ai returns the updated session DTO (same shape GET's `session` carries),
// so the choice can be echoed back. A transport failure / non-2xx maps to a typed
// error the caller degrades on (the choice is kept optimistically in the UI).
export interface SaveDesignChoiceInput {
  coreOrganizationId: string;
  coreWorkspaceId: string;
  coreProjectId: string;
  designChoice: { styleId: string; paletteId: string; typeId: string };
  designStarter: string;
}

export async function saveDesignChoice(input: SaveDesignChoiceInput): Promise<RawPreplanSession> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/preplan`, {
    method: 'PATCH',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawPreplanSession;
}

// ── Coding convention + code-health audit (Story 7.14 / MOTIR-926) ───────────
// The read seam the Code-health page reads over the boundary. Reads are keyed by
// (coreWorkspaceId, coreProjectId, repoKey) query params — per-repo scope per
// MOTIR-1662. The convention is DERIVED + AUTO-USED (no approve/edit write path;
// MOTIR-1660 / MOTIR-1663).

export interface RawConventionProvenance {
  ruleId: string;
  category: string;
  source: 'adopted' | 'proposed';
  evidence?: Record<string, unknown>;
  confidence?: number;
}

// The EXACT mirror of motir-ai's `CodingConventionDto`
// (`src/services/codingConventionService.ts`). It carries NO lifecycle fields —
// MOTIR-1660/1662 deleted the `proposed → standard` approve gate, so there is no
// `status`, `approvedBy*`, `editedBy*` or `supersededByVersion` to mirror. Keep
// this type keyed to the producer's DTO, never to what a consumer wishes for
// (MOTIR-2127: the fictional shape made every read map to null).
export interface RawConvention {
  id: string;
  aiProjectId: string;
  repoKey: string;
  version: number;
  contentMd: string;
  provenance: RawConventionProvenance[];
  sourceAuditId: string | null;
  // Who wrote this version (MOTIR-9080). Optional on the wire: a motir-ai that
  // predates the editable convention sends none of the three, and reads as
  // `derived` with nothing waiting.
  authorKind?: 'derived' | 'edited';
  editedByUserId?: string | null;
  pendingDerivedMd?: string | null;
  createdAt: string;
  updatedAt: string;
}

// The EXACT mirror of motir-ai's `ConventionSurface` — the body `GET /v1/convention`
// returns. `convention` is the LATEST derived convention for the requested
// (project, repoKey), or null when none exists; the surface does NOT echo the
// requested `repoKey` (each row carries its own).
export interface RawConventionSurface {
  convention: RawConvention | null;
  versions: RawConvention[];
  nextCursor: string | null;
}

export interface RawCodeAuditSummary {
  id: string;
  aiProjectId: string;
  healthSummary: unknown;
  codeGraphRef: string | null;
  repoKey: string | null;
  jobId: string | null;
  createdAt: string;
}

// The §10.3 external-scanner state motir-ai stamps on the latest audit and hoists
// onto the read-back surface (MOTIR-1610). Loosely mirrored here (like
// `healthSummary`); the service maps it defensively into the DTO.
export interface RawExternalScannerState {
  detected: string[];
  ingested: {
    source: string;
    analyses: number;
    tools: string[];
    findingCount: number;
  } | null;
  noExternalScanner: boolean;
  suggestion: 'github_code_scanning' | 'sonarqube' | null;
}

export interface RawCodeAuditSurface {
  audit: RawCodeAuditSummary | null;
  findings: unknown[];
  total: number;
  nextOffset: number | null;
  // The latest audit's §10.3 scanner state (MOTIR-1610), or null for the empty
  // surface / an audit recorded before the column existed.
  scanner?: RawExternalScannerState | null;
}

export interface CodeAuditQuery {
  coreWorkspaceId: string;
  coreProjectId: string;
  repoKey?: string;
  findingsOffset?: number;
  findingsLimit?: number;
}

// GET /v1/code-audit — latest audit summary + its first findings page.
export async function getCodeAudit(query: CodeAuditQuery): Promise<RawCodeAuditSurface> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    coreWorkspaceId: query.coreWorkspaceId,
    coreProjectId: query.coreProjectId,
  });
  if (query.repoKey) params.set('repoKey', query.repoKey);
  if (query.findingsOffset !== undefined)
    params.set('findingsOffset', String(query.findingsOffset));
  if (query.findingsLimit !== undefined) params.set('findingsLimit', String(query.findingsLimit));
  const res = await aiFetch(`${url}/v1/code-audit?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawCodeAuditSurface;
}

export interface CodeGraphReadRequest {
  coreWorkspaceId: string;
  coreProjectId: string;
  tool: 'code_explore' | 'code_search' | 'code_grep';
  /** The project's whole realized repository set — bound by core, never by the agent. */
  repoRefs: string[];
  /** `query` for explore/search; `pattern` (+ `regex` / `caseInsensitive` / `path`) for grep. */
  args: {
    query?: string;
    pattern?: string;
    regex?: boolean;
    caseInsensitive?: boolean;
    path?: string;
    cursor?: string;
    repos?: string[];
    limit?: number;
  };
}

/** motir-ai's answer — the route's state union, exactly as it sends it (contract §2.4). */
export type RawCodeGraphRead =
  | { state: 'ok'; text: string }
  | { state: 'no_graph' }
  | { state: 'not_indexed'; repoRef: string }
  /** `code_grep` only: the repo's graph predates the file-contents table (MOTIR-10066). */
  | { state: 'content_not_indexed'; repoRef: string }
  | { state: 'repo_not_in_set'; repoRef: string }
  | { state: 'stale_cursor' }
  | { state: 'invalid_cursor' }
  | { state: 'graph_unavailable'; reason: string };

// POST /v1/code-graph/read — ONE graph read through the hosted planner's own
// executor (Story MOTIR-7858 · MOTIR-7860 / MOTIR-7862). Only core ids, repo refs
// and the tool's args cross: the graph-read credential is minted INSIDE motir-ai
// and never comes back. Every named state is a 200; a non-2xx is THROWN, as every
// sibling here throws it — mapping a failure to a state is the service's call.
export async function readCodeGraph(input: CodeGraphReadRequest): Promise<RawCodeGraphRead> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/code-graph/read`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawCodeGraphRead;
}

export interface RefreshCodeAuditResult {
  auditJobId: string;
  conventionJobId: string;
}

// POST /v1/code-context/refresh — the 7.14.7 RE-AUDIT / REFRESH trigger (MOTIR-928).
// Re-submits `code_audit` + `propose_convention` for the project so a freshly
// configured external scanner is detected + ingested and the report refreshes (the
// "Deepen this audit" → "Re-audit now" action, MOTIR-1592). Mints the §4b read-back
// token the same way `submitJob` does (the audit job reads private-repo code
// scanning through motir-core's proxy, MOTIR-1605). motir-ai queues both jobs and
// returns their ids (202); the durable effect is the new CodeAudit + proposed
// version the worker writes.
export async function refreshCodeAudit(
  tenant: Tenant,
  context: JobContextBag,
  actor: RequestActor,
): Promise<RefreshCodeAuditResult> {
  const { url, serviceToken } = config();
  const readBackToken = mintJobToken({
    userId: actor.userId,
    workspaceId: tenant.workspaceId,
    projectId: tenant.projectId,
  });
  const res = await aiFetch(`${url}/v1/code-context/refresh`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify({ envelopeVersion: 'v1', tenant, context, readBackToken }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));

  const body = (await res.json()) as Partial<RefreshCodeAuditResult>;
  if (typeof body.auditJobId !== 'string' || typeof body.conventionJobId !== 'string') {
    throw new MotirAiUnavailableError('refresh response missing a job id');
  }
  return { auditJobId: body.auditJobId, conventionJobId: body.conventionJobId };
}

export interface ConventionQuery {
  coreWorkspaceId: string;
  coreProjectId: string;
  repoKey?: string;
  versionsCursor?: string;
  versionsLimit?: number;
}

// GET /v1/convention — latest derived convention + version history (per-repo
// scope per MOTIR-1662; derived = auto-used, no approve gate).
export async function getConvention(query: ConventionQuery): Promise<RawConventionSurface> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    coreWorkspaceId: query.coreWorkspaceId,
    coreProjectId: query.coreProjectId,
  });
  if (query.repoKey) params.set('repoKey', query.repoKey);
  if (query.versionsCursor) params.set('versionsCursor', query.versionsCursor);
  if (query.versionsLimit !== undefined) params.set('versionsLimit', String(query.versionsLimit));
  const res = await aiFetch(`${url}/v1/convention?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawConventionSurface;
}

export interface PutConventionInput {
  coreWorkspaceId: string;
  coreProjectId: string;
  repoKey: string;
  contentMd: string;
  editedByUserId: string;
  // The version the editor loaded (0 when the repository had none).
  baseVersion: number;
}

// PUT /v1/convention — a person's save: motir-ai records version + 1 as an `edited`
// version, or refuses a stale `baseVersion` as a 409 (MOTIR-9080), which
// `errorFromProblem` maps to `MotirAiConventionConflictError`.
export async function putConvention(input: PutConventionInput): Promise<RawConvention> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/convention`, {
    method: 'PUT',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawConvention;
}

// The RUN-SCOPED CREDENTIAL a fleet index container presents to motir-ai
// (MOTIR-1989 / MOTIR-1986). `credential` is OPAQUE to motir-core: motir-ai signs
// it and motir-ai verifies it, and nothing here parses, inspects or re-signs it.
//
// ⚠️ THE RESPONSE DELIBERATELY DOES NOT CARRY `aiProjectId`, and that absence is
// the contract rather than an omission. motir-core passes the credential straight
// through to a container; motir-ai resolves the project identity FROM the
// credential on every container-facing call, so "nothing in a request body can
// name a project" (`motir-ai/docs/contract.md`). A field here would hand
// motir-core an internal identity of the closed layer that it has no use for.
export interface CodeGraphRunCredential {
  /** The bearer the container presents. Opaque; treat as a secret. */
  credential: string;
  /** ISO-8601 — when it stops working. Minutes away, by design. */
  expiresAt: string;
  /**
   * OPTIONAL (MOTIR-3252) — a single-key, GET-only pre-signed URL for the repo's
   * PREVIOUS code-graph snapshot, which the container syncs against instead of
   * re-parsing the whole tree.
   *
   * **Opaque here, exactly like `credential`.** motir-core does not know the
   * snapshot key, cannot compute it, and holds no object-storage credential — all
   * three by decision (`docs/decisions/code-graph-index-fleet.md` §4/§5). motir-ai
   * mints it because it has the coordination row and the bucket; this side carries
   * it to the container's environment and never opens it.
   *
   * **Absent is the normal answer, not a failure.** A first index has no previous
   * snapshot, and a `codegraphVersion` bump deliberately withholds it so the run
   * rebuilds — the re-index the schema promises. Either way the container does a
   * full build, which is what it did unconditionally before this existed. That is
   * also what makes the two repos' halves free to merge in any order: an older
   * motir-ai simply never returns the field.
   */
  previousSnapshotUrl?: string;
}

/**
 * POST /v1/code-graph/run-credential — mint ONE index run's motir-ai credential
 * (MOTIR-1989; motir-ai's half is MOTIR-1986).
 *
 * `serviceAuth`-gated: motir-core is the caller, so this is the ONE call in the
 * flow that carries `MOTIR_AI_SERVICE_TOKEN`. What comes back authorizes exactly
 * two operations (`upload-grant`, `record-pointer`) for exactly one
 * `(project, repo, run)`, for minutes — and the container-facing routes REFUSE the
 * broad service token outright, so a misconfigured dispatch that handed a
 * container the service token fails loudly instead of silently granting it every
 * project.
 *
 * ⚠️ CREDENTIAL SCOPE IS THE ISOLATION BOUNDARY
 * (`docs/decisions/code-graph-index-fleet.md` §4). The fleet org is shared with CI
 * runners that execute customer-authored code, so a container's blast radius is
 * decided entirely by what it is handed. This is the narrow thing it is handed —
 * which is only true while the caller treats a failed mint as FATAL. There is no
 * broader credential to fall back to, and reaching for one would dissolve the
 * decision that made one shared org acceptable.
 *
 * The `(org, workspace, project)` triple find-or-creates the `AiProject`, exactly
 * as a job submit does. A non-2xx maps through the §5 problem+json taxonomy to a
 * typed error; a motir-ai that never answers becomes `MotirAiUnavailableError`
 * under the standard deadline — which since MOTIR-2138 is the only one this
 * boundary has. It is a small JSON round trip, as every method here now is.
 */
export async function mintCodeGraphRunCredential(input: {
  coreOrganizationId: string;
  coreWorkspaceId: string;
  coreProjectId: string;
  repoRef: string;
  /** The dispatching run, carried for attribution; not itself an authority. */
  runId: string;
  /** Optional; motir-ai clamps it to [60, 3600]. Omit to take its default. */
  ttlSeconds?: number;
}): Promise<CodeGraphRunCredential> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/code-graph/run-credential`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify({
      coreOrganizationId: input.coreOrganizationId,
      coreWorkspaceId: input.coreWorkspaceId,
      coreProjectId: input.coreProjectId,
      repoRef: input.repoRef,
      runId: input.runId,
      ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
    }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));

  // ⚠️ THE BODY IS VALIDATED, not cast. Everywhere else in this client a cast is
  // fine: the value lands in a DTO a human reads, and a missing field renders as
  // blank. Here it lands in a CONTAINER SPEC. A response that parsed but carried
  // no `credential` would boot a machine with an empty
  // `MOTIR_INDEX_RUN_CREDENTIAL`, which the container reports as a CONFIG failure
  // — blaming the dispatch for a defect in the response, one process away from
  // anything that could see it. So a malformed body fails HERE, before a spec
  // exists.
  const body = (await res.json()) as Partial<CodeGraphRunCredential> | null;
  if (!body || typeof body.credential !== 'string' || body.credential.length === 0) {
    throw new MotirAiUnavailableError(
      'motir-ai returned no credential from POST /v1/code-graph/run-credential',
    );
  }
  if (typeof body.expiresAt !== 'string' || body.expiresAt.length === 0) {
    throw new MotirAiUnavailableError(
      'motir-ai returned a run credential with no expiry from POST /v1/code-graph/run-credential',
    );
  }
  // The snapshot grant is OPTIONAL and is validated only for shape — a malformed
  // one is DROPPED rather than fatal, because the run it would have accelerated
  // still succeeds without it. This is the one field here whose absence is
  // routine, so it must not learn the fatal treatment of the two above.
  const previousSnapshotUrl =
    typeof body.previousSnapshotUrl === 'string' && body.previousSnapshotUrl.length > 0
      ? body.previousSnapshotUrl
      : undefined;

  return {
    credential: body.credential,
    expiresAt: body.expiresAt,
    ...(previousSnapshotUrl ? { previousSnapshotUrl } : {}),
  };
}

/**
 * WHAT THE CONTAINER ITSELF DID on one index run (MOTIR-5058).
 *
 * ⚠️ THIS IS NOT `IndexMode`, AND THE WHOLE CARD IS THAT THEY ARE DIFFERENT
 * FACTS WEARING ONE NAME. `codeGraphIndexService`'s `IndexMode` is derived on
 * THIS side from whether a snapshot was OFFERED — it answers *did we give this
 * run a chance to sync*. This one is the container's own report of what it then
 * DID with that chance. A run handed a pointer that rebuilt anyway is `sync` over
 * there and `build` here, and until this read existed nothing on this side could
 * tell that apart from a run that genuinely synced (MOTIR-5055).
 *
 * The vocabulary is the CONTAINER's (`sync` / `build`), deliberately not
 * re-spelled into `IndexMode`'s (`sync` / `rebuild`). Two words that differ are
 * what stops a later reader assuming the two fields are interchangeable.
 */
export interface CodeGraphRunVerdict {
  repoRef: string;
  runId: string;
  commitSha: string | null;
  /** `null` when the container reported no mode — never to be read as `build`. */
  indexMode: 'sync' | 'build' | null;
  /** Why a run that WAS offered a snapshot rebuilt anyway. Bounded to 300 chars. */
  fallbackReason: string | null;
  /**
   * WHAT THE RUN COST, as the CONTAINER measured it (MOTIR-5101) — `null` when
   * motir-ai recorded none.
   *
   * ⚠️ THIS IS THE ONLY INSTRUMENT THAT CAN MEASURE WHAT A SYNC SAVES, and the
   * reason it had to cross the boundary at all is that the obvious local
   * substitute is wrong. `job_run.duration_ms` is right here, queryable and
   * plausible — and it spans machine create, image pull, a fixed 15 000 ms
   * detect cap and teardown. That overhead measured 31 513 ms and 58 738 ms on
   * two runs eighteen minutes apart, a swing 62% the size of the effect; on
   * MOTIR-5031's three runs it placed a `sync` and a `rebuild` 0.5% apart while
   * the container's own `totalMs` resolved the same pair at 93 778 → 50 203 ms.
   * So the local number does not fail loudly — it reports, stably, that
   * incremental indexing does nothing.
   *
   * ⚠️ AND `null` IS NOT ZERO. Every run recorded before MOTIR-5101 shipped has
   * a verdict and no timings, which is the whole of the store's history — so
   * absent must read as *nobody measured this*, never as an instantaneous run.
   */
  timings: CodeGraphRunTimings | null;
  /**
   * WHY THE RUN FAILED, as motir-ai recorded it (MOTIR-6786 · MOTIR-7129) — `null`
   * when it recorded no failure, or an older motir-ai that never sends one.
   *
   * ⚠️ IT DESCRIBES THE RUN'S LATEST FAILED ATTEMPT, AND A LATER PUBLISH DOES NOT
   * CLEAR IT: a non-null `indexMode` beside it means the run was re-dispatched and
   * published in the end. Read the two together.
   */
  failure: CodeGraphRunFailure | null;
}

/**
 * One run's recorded failure (MOTIR-7129). `failureClass` is motir-ai's: the
 * container's exit-code classes (`UPLOAD`, `GRANT`, `BUILD`, …) and motir-ai's own
 * `GRAPH_TOO_LARGE` (MOTIR-7127), the one class that carries the two sizes.
 */
export interface CodeGraphRunFailure {
  failureClass: string;
  message: string;
  /** Null when the request never got a response. */
  httpStatus: number | null;
  /** The graph's uncompressed size, in bytes — only on `GRAPH_TOO_LARGE`. */
  sizeBytes: number | null;
  /** The supported maximum it was refused against — only on `GRAPH_TOO_LARGE`. */
  capBytes: number | null;
}

/** The class motir-ai records when the upload grant refuses a graph for size (MOTIR-7127). */
export const GRAPH_TOO_LARGE_FAILURE = 'GRAPH_TOO_LARGE';

/**
 * One run's self-measured cost, as motir-ai stored it (MOTIR-5101).
 *
 * Every field is independently nullable because they arrive independently: the
 * sync counts only exist on a run that synced, and `peakRssMb` only from a
 * container new enough to send it.
 */
export interface CodeGraphRunTimings {
  /** The container's own wall clock for the run, excluding the report call. */
  totalMs: number | null;
  /** `totalMs` − Σ`phasesMs`: interstitial work, or a phase nobody wrapped. */
  unaccountedMs: number | null;
  /** Peak RESIDENT SET in whole MB — not heap; a whole-tree index is mostly off-heap. */
  peakRssMb: number | null;
  /** Phase name → wall-clock ms. Bounded by motir-ai at 32 entries, 32-char keys. */
  phasesMs: Record<string, number> | null;
  /** The whitelisted `SyncResult` counts — what a sync actually touched. */
  syncCounts: Record<string, number> | null;
}

/**
 * GET /v1/code-graph/run/verdict — read back what the container reported for one
 * run (MOTIR-5058; motir-ai's half ships on the same card).
 *
 * ⚠️ **IT NEVER THROWS, AND IT IS THE ONLY METHOD IN THIS FILE THAT DOES NOT.**
 * Everywhere else here a failure is fatal because the caller cannot proceed
 * without the answer. This one is TELEMETRY read at the very end of a settled
 * run: the container has finished, the graph is published, the ledger row is
 * about to be written, and the only thing a throw could achieve is to fail a run
 * that fully succeeded over a diagnostic. So every failure — a non-2xx, a
 * malformed body, a motir-ai that never answers, a deployment that has no such
 * route — returns `null`, and the caller records no container mode.
 *
 * ⚠️ **THAT TOTALITY IS WHAT MAKES MERGE ORDER FREE**, which is the property this
 * card is built around rather than a nicety. An older motir-ai answers this route
 * with a 404 and this function returns `null`, exactly as it does for a run that
 * reported nothing — so motir-core's half may merge and deploy FIRST, alone, and
 * the ledger it writes is byte-identical to today's until the other half lands.
 * It is the same property `previousSnapshotUrl` relies on one function up, and it
 * is why this is a boundary contract rather than a lockstep deploy.
 *
 * ⚠️ **`null` IS NOT `build`.** Four distinct situations produce it — no route,
 * no verdict recorded, a lost write, a call that failed — and none of them is
 * evidence about what the run did. A caller that defaults it manufactures exactly
 * the false confidence this card exists to remove.
 */
export async function fetchCodeGraphRunVerdict(input: {
  coreWorkspaceId: string;
  coreProjectId: string;
  repoRef: string;
  /** The SAME `runId` that was sent to `mintCodeGraphRunCredential`. */
  runId: string;
}): Promise<CodeGraphRunVerdict | null> {
  try {
    const { url, serviceToken } = config();
    const query = new URLSearchParams({
      coreWorkspaceId: input.coreWorkspaceId,
      coreProjectId: input.coreProjectId,
      repoRef: input.repoRef,
      runId: input.runId,
    });
    const res = await aiFetch(`${url}/v1/code-graph/run/verdict?${query.toString()}`, {
      method: 'GET',
      headers: authHeaders(serviceToken),
    });
    // A 404 is the OLDER-motir-ai arm and is not an error here; so is any other
    // non-2xx, for the reason in the doc block.
    if (!res.ok) return null;

    const body = (await res.json()) as { verdict?: Partial<CodeGraphRunVerdict> | null } | null;
    const verdict = body?.verdict;
    // `{ verdict: null }` is the route's own ABSENT answer and arrives here as the
    // same `null` every other miss does — which is correct: the caller's question
    // is "do I know what the container did", and all of these answer no.
    if (!verdict || typeof verdict !== 'object') return null;

    const indexMode =
      verdict.indexMode === 'sync' || verdict.indexMode === 'build' ? verdict.indexMode : null;
    const fallbackReason =
      typeof verdict.fallbackReason === 'string' && verdict.fallbackReason.length > 0
        ? verdict.fallbackReason
        : null;
    const timings = parseRunTimings(verdict.timings);
    const failure = parseRunFailure(verdict.failure);

    // A body that carries NOTHING tells us nothing — report it as absent rather
    // than as a verdict whose every field is null, so the caller has one shape to
    // reason about instead of two.
    //
    // ⚠️ THE TIMINGS ARE PART OF THAT TEST SINCE MOTIR-5101, AND OMITTING THEM
    // HERE WOULD HAVE SILENTLY DISCARDED THE CARD'S OWN DELIVERABLE. A run that
    // reported its cost but no mode — a container whose `indexMode` was
    // unrecognised, which motir-ai stores as `null` by design — carries a
    // perfectly good measurement, and the old two-term test threw the whole
    // verdict away before anyone could read it.
    //
    // ⚠️ AND SO IS THE FAILURE SINCE MOTIR-7129, for the same reason: a failed run
    // never publishes, so its verdict carries no mode, no reason and no timings —
    // the three-term test returned `null` for EVERY failed run and the failure
    // motir-ai has stored since MOTIR-6786 never reached this side. A body with
    // none of the four is still `null`.
    if (indexMode === null && fallbackReason === null && timings === null && failure === null) {
      return null;
    }

    return {
      repoRef: typeof verdict.repoRef === 'string' ? verdict.repoRef : input.repoRef,
      runId: typeof verdict.runId === 'string' ? verdict.runId : input.runId,
      commitSha: typeof verdict.commitSha === 'string' ? verdict.commitSha : null,
      indexMode,
      fallbackReason,
      timings,
      failure,
    };
  } catch {
    // Deliberately total. See the doc block: a settled run must not fail on a
    // telemetry read, and an unreachable motir-ai is indistinguishable from one
    // that has nothing to report — both mean "no container mode recorded".
    return null;
  }
}

/**
 * The `failure` half of a verdict body, validated field by field (MOTIR-7129).
 *
 * The same discipline as {@link parseRunTimings}: a field of the wrong type becomes
 * `null`, never a coerced value. A failure needs a class and a message to be one at
 * all, so a body missing either is no failure; every other field is kept or
 * nulled on its own. A size must be a finite, non-negative number — the numbers
 * reach a customer-facing row (`GithubRepo.indexRefusedSizeBytes`).
 */
function parseRunFailure(value: unknown): CodeGraphRunFailure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['failureClass'] !== 'string' || raw['failureClass'].length === 0) return null;
  if (typeof raw['message'] !== 'string') return null;

  const size = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const httpStatus = raw['httpStatus'];
  return {
    failureClass: raw['failureClass'],
    message: raw['message'],
    httpStatus: typeof httpStatus === 'number' && Number.isInteger(httpStatus) ? httpStatus : null,
    sizeBytes: size(raw['sizeBytes']),
    capBytes: size(raw['capBytes']),
  };
}

/**
 * The `timings` half of a verdict body, validated field by field (MOTIR-5101).
 *
 * ⚠️ NOTHING IS TRUSTED AND NOTHING IS DEFAULTED. This is a body from another
 * service across the open/closed boundary, read at the end of a settled run: a
 * field of the wrong type must become `null`, never a coerced number, because a
 * plausible value here is indistinguishable from a measured one and lands on a
 * durable ledger row. Returns `null` when no field survived, so the caller never
 * has to tell an absent object from an all-null one.
 */
function parseRunTimings(value: unknown): CodeGraphRunTimings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const numberMap = (v: unknown): Record<string, number> | null => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Record<string, number> = {};
    for (const [key, entry] of Object.entries(v as Record<string, unknown>)) {
      const n = num(entry);
      if (n !== null) out[key] = n;
    }
    return Object.keys(out).length > 0 ? out : null;
  };

  const timings: CodeGraphRunTimings = {
    totalMs: num(raw['totalMs']),
    unaccountedMs: num(raw['unaccountedMs']),
    peakRssMb: num(raw['peakRssMb']),
    phasesMs: numberMap(raw['phasesMs']),
    syncCounts: numberMap(raw['syncCounts']),
  };

  return Object.values(timings).some((field) => field !== null) ? timings : null;
}

/** What motir-ai removed for ONE repo (`POST /v1/code-graph/offboard`). */
// ── A hosted agent run's token and credit cost (MOTIR-689) ──────────────────

/**
 * What ONE hosted agent run cost, as motir-ai records it (MOTIR-6381's
 * `AgentRunUsageDto`). The fields motir-core reads are the totals; the rest of
 * the body is ignored.
 */
export interface RawAgentRunUsage {
  coreRunId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The MODEL-CALL credits (MOTIR-689's figure, unchanged). */
  credits: number;
  /** The machine-time charge (MOTIR-6513 · MOTIR-6514); `0` until the run is charged. */
  machineCredits: number;
  machineSeconds: number;
  /** `credits + machineCredits`, as motir-ai sums them. */
  totalCredits: number;
}

const AGENT_RUN_USAGE_TOTALS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'credits',
] as const;

/**
 * GET /v1/agent-runs/:coreRunId/usage — one hosted run's token, cache and credit
 * totals, keyed by its `DispatchRun.id` (`docs/decisions/hosted-agent-run.md` §1).
 *
 * ⚠️ A 404 IS `null`, NEVER AN ERROR: motir-ai answers it for a run whose agent
 * has not yet made a billed call, which is the ordinary state of a run that has
 * just booted. Every OTHER failure throws — transport and deadline as
 * {@link MotirAiUnavailableError}, a non-2xx as its §5 typed error, a body that
 * carries no numeric totals as `MotirAiUnavailableError` — so a caller can never
 * read "could not ask" as "cost nothing".
 */
export async function getAgentRunUsage(coreRunId: string): Promise<RawAgentRunUsage | null> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/agent-runs/${encodeURIComponent(coreRunId)}/usage`, {
    method: 'GET',
    headers: authHeaders(serviceToken),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    throw new MotirAiUnavailableError('agent-run usage answered with no body');
  }
  for (const key of AGENT_RUN_USAGE_TOTALS) {
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) {
      throw new MotirAiUnavailableError(`agent-run usage answered without a numeric ${key}`);
    }
  }
  return {
    coreRunId: typeof body['coreRunId'] === 'string' ? body['coreRunId'] : coreRunId,
    inputTokens: body['inputTokens'] as number,
    outputTokens: body['outputTokens'] as number,
    cacheReadTokens: body['cacheReadTokens'] as number,
    cacheWriteTokens: body['cacheWriteTokens'] as number,
    credits: body['credits'] as number,
    // ⚠️ OPTIONAL ON THE WIRE: a motir-ai that predates the machine charge omits
    // them, and a run it never charged for machine time has none to report. The
    // total then IS the model-call credits, never a missing number.
    machineCredits: numericOr(body['machineCredits'], 0),
    machineSeconds: numericOr(body['machineSeconds'], 0),
    totalCredits: numericOr(
      body['totalCredits'],
      (body['credits'] as number) + numericOr(body['machineCredits'], 0),
    ),
  };
}

function numericOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export interface CodeGraphOffboardRepoResult {
  repoRef: string;
  snapshotObjectsDeleted: number;
  localRootRemoved: boolean;
  coordinationRowsDeleted: number;
}

/** What one offboard call removed, per repo and in total. */
export interface CodeGraphOffboardResult {
  /** False when motir-ai has no `AiProject` for these ids — a success, not a 404. */
  projectFound: boolean;
  repos: CodeGraphOffboardRepoResult[];
  snapshotObjectsDeleted: number;
  localRootsRemoved: number;
  coordinationRowsDeleted: number;
}

/**
 * REMOVE a tenant's derived code graph (MOTIR-2168 ·
 * `docs/decisions/code-graph-index-fleet.md` §14.5) — the wire between
 * motir-core's offboarding queue and the three deletions motir-ai performs
 * (snapshot → local root → coordination row).
 *
 * Omit `repoRef` to cover EVERY repo of the project (the project-archive and
 * workspace-delete arms); supply it for one (the repo-disconnect arm).
 *
 * JSON only, under the single {@link MOTIR_AI_REQUEST_TIMEOUT_MS} deadline like
 * every other method here — §11's MOTIR-2138 amendment. It posts a scope and
 * reads counts; it must never grow a byte body or a deadline of its own.
 *
 * ⚠️ It does NOT treat "nothing was there" as a failure. motir-ai answers 200
 * with zero counts for an unknown project or an unindexed repo, and the SWEEP
 * depends on that: its queue rows deliberately outlive the projects they name, so
 * "not here" is the expected steady state on a re-run. Only a real transport or
 * server failure throws, which is what leaves the row due for the next tick.
 */
export async function offboardCodeGraph(input: {
  coreWorkspaceId: string;
  coreProjectId: string;
  repoRef?: string;
}): Promise<CodeGraphOffboardResult> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/code-graph/offboard`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify({
      coreWorkspaceId: input.coreWorkspaceId,
      coreProjectId: input.coreProjectId,
      ...(input.repoRef === undefined ? {} : { repoRef: input.repoRef }),
    }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));

  // VALIDATED, not cast — the same reasoning as `mintCodeGraphRunCredential`, for
  // a different consequence. This value decides whether the sweep DELETES its
  // queue row. A response that parsed but carried no counts would read as a
  // successful removal and retire the only record that anything was owed, turning
  // a malformed reply into permanent retention with nothing left to retry.
  const body = (await res.json()) as Partial<CodeGraphOffboardResult> | null;
  if (!body || typeof body.coordinationRowsDeleted !== 'number' || !Array.isArray(body.repos)) {
    throw new MotirAiUnavailableError(
      'motir-ai returned no offboarding counts from POST /v1/code-graph/offboard',
    );
  }
  return {
    projectFound: body.projectFound === true,
    repos: body.repos as CodeGraphOffboardRepoResult[],
    snapshotObjectsDeleted: body.snapshotObjectsDeleted ?? 0,
    localRootsRemoved: body.localRootsRemoved ?? 0,
    coordinationRowsDeleted: body.coordinationRowsDeleted,
  };
}

// ⚠️ THE BYTE-UPLOAD METHOD IS GONE, AND MUST NOT COME BACK (MOTIR-2138). This
// client used to carry the boundary's ONE binary method — a POST of a repo's raw
// gzipped tarball to motir-ai's ingest route (MOTIR-1500), under a 180 s deadline
// of its own — and MOTIR-2027 / MOTIR-2057 moved BOTH code-graph jobs off it onto
// the container fleet without removing it. It then sat here for weeks with no
// caller: exported, tested, and one import away from re-creating the defect
// MOTIR-2057 fixed — `motir-core`'s whole-tree parse does not fit in 180 s, so
// the abandoned path failed ~68% of refreshes for three days before anyone
// connected the symptom to it.
//
// Anything that wants a graph built dispatches a CONTAINER: the pre-signed
// tarball URL is resolved above (`mintCodeGraphRunCredential` +
// `codeGraphIndexDispatchService` in `lib/jobs/indexFleetSteps.ts`) and the
// container fetches the repo itself, so the bytes never enter a Vercel function.
// This boundary is JSON-only, and every method on it now rides the single
// `MOTIR_AI_REQUEST_TIMEOUT_MS` deadline. Retiring the motir-ai ROUTE this used
// to call is MOTIR-2139, in the other repo
// (`docs/decisions/code-graph-index-fleet.md` §11).

// GET /v1/jobs/:id/stream — yield SSE frames (status / progress / done / error)
// as they arrive, FOLLOWING THE JOB TO ITS END. A transport failure throws a
// typed error before the first yield.
//
// ⚠️ ONE motir-ai stream is a WINDOW, not the job (MOTIR-7985). motir-ai holds a
// stream open for five minutes and then closes it with `done { timedOut: true }`
// whatever the job's status — a transport limit, not an outcome. Relayed as-is,
// that `done` read as "the run settled" to every consumer: the planning rail
// said "Nothing came back to change" five minutes into a run that went on for
// fifteen more, and never heard how it really ended. So this generator
// re-subscribes on a timed-out `done` and swallows it; the only `done` it yields
// is the one motir-ai writes on a terminal status.
//
// A re-subscribe replays the job from seq 0 (motir-ai's contract §2.1), so
// {@link followJobStream} drops what this caller has already been handed:
// progress frames by their `seq`, and the opening `status` frame when it repeats
// the last status relayed.
//
// `coreProjectId` is required for the same reason as {@link getJob} — see the ⚠️
// there. The stream is the same passthrough one layer down, so it had the same
// hole and takes the same parameter.
export function streamJob(jobId: string, coreProjectId: string): AsyncGenerator<JobStreamEvent> {
  return followJobStream(() => streamJobWindow(jobId, coreProjectId));
}

/** Whether a `done` frame is motir-ai closing a stream WINDOW rather than the job
 *  ending — `done { timedOut: true }`, written when the stream's deadline passes. */
export function isStreamWindowTimeout(frame: JobStreamEvent): boolean {
  return (
    frame.event === 'done' &&
    typeof frame.data === 'object' &&
    frame.data !== null &&
    (frame.data as { timedOut?: unknown }).timedOut === true
  );
}

/**
 * Chain stream WINDOWS into one stream of the job (MOTIR-7985). `openWindow`
 * subscribes once; every window that ends on a timed-out `done` is followed by
 * another, until one ends any other way — a terminal `done`, an `error` frame,
 * or the upstream closing. Frames a later window replays are dropped, so the
 * caller sees each progress frame once and in order.
 */
export async function* followJobStream(
  openWindow: () => AsyncIterable<JobStreamEvent>,
): AsyncGenerator<JobStreamEvent> {
  let lastSeq = 0;
  let lastStatus: unknown = undefined;
  for (;;) {
    let windowClosed = false;
    for await (const frame of openWindow()) {
      if (isStreamWindowTimeout(frame)) {
        windowClosed = true;
        break;
      }
      if (frame.event === 'status') {
        const status = fieldOf(frame.data, 'status');
        if (status !== undefined && status === lastStatus) continue;
        lastStatus = status;
      } else {
        const seq = fieldOf(frame.data, 'seq');
        if (typeof seq === 'number') {
          if (seq <= lastSeq) continue;
          lastSeq = seq;
        }
      }
      yield frame;
    }
    if (!windowClosed) return;
  }
}

function fieldOf(data: unknown, key: string): unknown {
  return typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

// One subscription to `GET /v1/jobs/:id/stream` — one WINDOW of the job. Ends
// when motir-ai closes the stream: on the job's terminal status, or when the
// window's deadline passes (`done { timedOut: true }`).
async function* streamJobWindow(
  jobId: string,
  coreProjectId: string,
): AsyncGenerator<JobStreamEvent> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({ [JOB_SCOPE_QUERY_PARAM]: coreProjectId });
  const res = await aiFetch(
    `${url}/v1/jobs/${encodeURIComponent(jobId)}/stream?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${serviceToken}`, Accept: 'text/event-stream' },
    },
  );
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  if (!res.body) throw new MotirAiUnavailableError('stream response had no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseFrame(frame);
        if (parsed) yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Parse one SSE frame ("event: x\ndata: {...}") into a JobStreamEvent. Returns
// null for a comment-only / dataless frame. Exported for unit testing.
export function parseSseFrame(frame: string): JobStreamEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // comment
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // leave as raw string
  }
  return { event, data };
}

// ── The per-project LESSON INSPECTION reads (Subtask MOTIR-3337 over MOTIR-3335) ──
//
// The `/v1/lessons` pair, keyed by the core identity exactly as `getCodeAudit`
// and `getConvention` are. There is no new convention here: same `config()`,
// same `authHeaders`, same `aiFetch` (which maps a transport failure and the
// 30s deadline alike to `MotirAiUnavailableError`), same
// `errorFromProblem(await readProblem(res))` on a non-2xx.
//
// ⚠️ TENANT ONLY, decided UPSTREAM. motir-ai selects `aiProjectId = <this
// project>` and never the injection clause `scope = 'global' OR aiProjectId =
// …`, so the shipped global corpus cannot reach a customer's screen
// (`motir-ai/docs/contract.md`, `GET /v1/lessons`). motir-core does not filter
// a second time and must not start: a second filter here would let the upstream
// one be removed without a failing test on either side.

/** One lesson as motir-ai returns it. Dates are ISO-8601 strings on the wire. */
export interface RawLesson {
  id: string;
  scope: string;
  aiProjectId: string | null;
  mistakeType: string;
  title: string;
  body: string;
  why: string;
  howToApply: string;
  categories?: string[];
  kinds?: string[];
  types?: string[];
  phases?: string[];
  sourceRef: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastOccurredAt: string;
  recurrenceCount?: number;
  /** Whether the planner is being told this today. */
  injected: boolean;
  /** Why not, when it is not — `disabled` | `not_recurred`, else null. */
  injectionBlock: string | null;
  /**
   * The HUMAN OVERRIDE (MOTIR-3330) — `retired` | `exempt`, else null.
   *
   * Optional here because an upstream that predates it sends none, and the
   * absence is honest: no decision has been recorded.
   */
  humanOverride?: string | null;
  /** When that decision was made (ISO-8601) and by whom (a core user id). */
  humanOverrideAt?: string | null;
  humanOverrideBy?: string | null;
  /** The retire-by-non-recurrence window, in days, THIS row was judged against. */
  retentionDays?: number;
  subject?: string | null;
}

export interface RawLessonPage {
  lessons: RawLesson[];
  nextCursor: string | null;
  /** Every tenant lesson — the LIBRARY's size, not this page's. */
  total: number;
  /** The subset the planner is currently being told. */
  applied: number;
  /** The instant every row on this page was labelled against (ISO-8601). */
  staleCutoff: string;
  /** The retire-by-non-recurrence window, in days. */
  retentionDays: number;
}

export interface LessonListQuery {
  coreWorkspaceId: string;
  coreProjectId: string;
  cursor?: string;
  limit?: number;
}

// GET /v1/lessons — one page of THIS project's own lessons.
export async function getLessons(query: LessonListQuery): Promise<RawLessonPage> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    coreWorkspaceId: query.coreWorkspaceId,
    coreProjectId: query.coreProjectId,
  });
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const res = await aiFetch(`${url}/v1/lessons?${params.toString()}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as Partial<RawLessonPage>;
  // The malformed-body arm `refreshCodeAudit` and `setSeatQuantity` already use:
  // a 200 whose shape is wrong is an unavailable upstream, not a page of zero
  // lessons — which is what an unchecked `body.lessons ?? []` would render it as,
  // and an empty list is exactly the answer a real project legitimately gives.
  if (!Array.isArray(body.lessons)) {
    throw new MotirAiUnavailableError('lessons response missing `lessons`');
  }
  return {
    lessons: body.lessons,
    nextCursor: body.nextCursor ?? null,
    // ⚠️ `??` the COUNTS to the page length rather than to 0: an upstream that
    // predates them would otherwise render as "0 lessons" on a screen that is
    // visibly showing some. Falling back to what we can see is wrong by at most
    // a page; falling back to zero contradicts the rows beside it.
    total: typeof body.total === 'number' ? body.total : body.lessons.length,
    applied: typeof body.applied === 'number' ? body.applied : body.lessons.length,
    staleCutoff: body.staleCutoff ?? new Date(0).toISOString(),
    retentionDays: typeof body.retentionDays === 'number' ? body.retentionDays : 0,
  };
}

export interface LessonDetailQuery {
  coreWorkspaceId: string;
  coreProjectId: string;
  lessonId: string;
}

// GET /v1/lessons/:id — one lesson in full.
//
// An id belonging to another project raises the same upstream `not_found` as an
// unknown one, so nothing here can distinguish them either — the existence-oracle
// posture is preserved by NOT adding a check that would.
export interface CreateLessonRequest {
  coreOrganizationId: string;
  coreWorkspaceId: string;
  coreProjectId: string;
  mistakeType: string;
  title: string;
  body: string;
  why: string;
  howToApply: string;
  kinds?: string[];
  types?: string[];
  phases?: string[];
  sourceRef?: string;
  /** The SCALAR fourth routing axis (MOTIR-5081). Omitted = unconstrained. */
  subject?: string;
}

// POST /v1/lessons — ADD one lesson to THIS project's own store (Story
// MOTIR-3331 · MOTIR-3360). The write sibling of `getLessons` / `getLesson`
// above, and shaped like them: the CORE identity in the body, the service token
// in the header, a typed error out of `errorFromProblem`.
//
// ⚠️ NO `scope` FIELD, AND THAT IS THE CONTRACT, not an omission. The route
// creates tenant rows only, and refuses a body that names `scope` rather than
// dropping it — so this type having no such member is what keeps a caller from
// ever forming the request. A lesson that applies to every project is Motir's own
// curated corpus and arrives by migration.
//
// ⚠️ THE FIELD NAMES ARE A CROSS-REPO STRING AGREEMENT (the warning beside
// `JOB_SCOPE_QUERY_PARAM`): motir-ai's `parseAddLessonBody` requires these exact
// names, and a typo on either side is a `validation_error` at runtime with no
// type error and no test failure in the repo that made it. The seam test asserts
// on the SERIALIZED body for that reason.
//
// The upstream's near-duplicate refusal (409) and its validation errors are
// mapped by `errorFromProblem` and propagate — deliberately. That refusal names
// the existing lesson's id and title, and the caller needs both: a generic
// "could not create" turns an actionable answer into a dead end.
export async function createLesson(input: CreateLessonRequest): Promise<RawLesson> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/lessons`, {
    method: 'POST',
    headers: { ...authHeaders(serviceToken), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as Partial<RawLesson>;
  // The malformed-body arm the reads above already use: a 200/201 whose shape is
  // wrong is an unavailable upstream, not a lesson.
  if (typeof body.id !== 'string') {
    throw new MotirAiUnavailableError('create-lesson response missing `id`');
  }
  return body as RawLesson;
}

// ── The TEACHING read (Subtask MOTIR-3478 over MOTIR-3477) ──────────────────
//
// `POST /v1/lessons/search`. The reads above are the INSPECTION pair and are
// tenant-only by decision; this one is the teaching read and answers across BOTH
// scopes — the shared corpus and this project's own — because a caller about to
// act should be taught by both and it does not matter which of the two a past
// mistake happens to be recorded in.
//
// ⚠️ SO THE `isTenantRow` NARROWING THAT GUARDS THE INSPECTION READS MUST NOT BE
// APPLIED TO THIS ONE. It is a second line of defence there precisely because a
// global row arriving would be a defect; here a global row is the larger half of
// the correct answer. Same store, same client, opposite filters — the reason
// each is written at its own call site rather than in a shared helper.
//
// ⚠️ NO `scope` FIELD AND NO `aiProjectId` ON THE WIRE. The acting project is
// the core identity in the body, resolved upstream, so a caller cannot name
// another project's store. Same cross-repo string agreement as `createLesson`:
// `parseSearchLessonsBody` requires these exact names.

/** One ranked lesson as the teaching read returns it — prose, not identifiers. */
export interface RawRankedLesson {
  id: string;
  title: string;
  body: string;
  howToApply: string;
  scope: string;
  kinds?: string[];
  types?: string[];
  phases?: string[];
  /**
   * The SCALAR fourth axis. Optional on the wire because an older motir-ai does
   * not send it, and absent is read as "this row carries no subject" — which is
   * also what a row with no subject means, and the two are the same answer to
   * the caller.
   */
  subject?: string | null;
  /** Cosine distance to the query; lower is nearer. */
  distance: number;
}

export interface SearchLessonsRequest {
  coreWorkspaceId: string;
  coreProjectId: string;
  query: string;
  kinds?: string[];
  types?: string[];
  phases?: string[];
  /**
   * The SCALAR fourth axis (MOTIR-5621) — one value or none, never a list,
   * matching the write side and every layer beneath it. `parseSearchLessonsBody`
   * upstream has accepted this field since MOTIR-5080, so this hop needs no
   * co-ordinated motir-ai change to start working.
   */
  subject?: string;
  limit?: number;
}

export async function searchLessons(input: SearchLessonsRequest): Promise<RawRankedLesson[]> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/lessons/search`, {
    method: 'POST',
    headers: { ...authHeaders(serviceToken), 'content-type': 'application/json' },
    body: JSON.stringify({
      coreWorkspaceId: input.coreWorkspaceId,
      coreProjectId: input.coreProjectId,
      query: input.query,
      // ⚠️ SPREAD, so an axis the caller omitted is ABSENT from the JSON rather
      // than present as `null` or `[]`. The distinction survives this hop
      // because the upstream SQL depends on it: an absent axis omits its clause,
      // and an empty one renders a filter that matches nothing.
      ...(input.kinds ? { kinds: input.kinds } : {}),
      ...(input.types ? { types: input.types } : {}),
      ...(input.phases ? { phases: input.phases } : {}),
      // The scalar axis, spread for the same reason and with the same
      // consequence: absent omits its clause upstream, and `''` would render a
      // filter matching the lessons whose subject is the empty string, i.e.
      // none of them.
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as { lessons?: unknown };
  // The malformed-body arm the reads above use: a 200 whose shape is wrong is an
  // unavailable upstream, NOT a search that matched nothing — and here the two
  // are the exact pair of answers the caller must be able to tell apart.
  if (!Array.isArray(body.lessons)) {
    throw new MotirAiUnavailableError('lesson-search response missing `lessons`');
  }
  return body.lessons as RawRankedLesson[];
}

export interface ReinforceLessonRequest {
  coreWorkspaceId: string;
  coreProjectId: string;
  lessonId: string;
  /** The caller's identity for the EVENT — what makes the call idempotent. */
  occurrenceRef: string;
}

/** What the reinforce route answers with. */
export interface RawReinforcedLesson {
  id: string;
  title: string;
  scope: string;
  lastOccurredAt: string;
  recurrenceCount: number;
  /** Whether THIS call is the one that counted; `false` is a replay, not an error. */
  counted: boolean;
}

/**
 * Record that an occurrence matched a lesson (Bug MOTIR-3547 · MOTIR-3553).
 *
 * ⚠️ It reaches GLOBAL rows as well as this project's own — the upstream route
 * resolves over both scopes deliberately, because the entire curated corpus is
 * global and MOTIR-3323 established it must be reinforceable. Another tenant's
 * lesson still raises `not_found`.
 */
export async function reinforceLesson(input: ReinforceLessonRequest): Promise<RawReinforcedLesson> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/lessons/${encodeURIComponent(input.lessonId)}/reinforce`, {
    method: 'POST',
    headers: { ...authHeaders(serviceToken), 'content-type': 'application/json' },
    body: JSON.stringify({
      coreWorkspaceId: input.coreWorkspaceId,
      coreProjectId: input.coreProjectId,
      occurrenceRef: input.occurrenceRef,
    }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as Partial<RawReinforcedLesson>;
  // A 200 whose shape is wrong is an unavailable upstream, not a silent
  // success — the same arm the lesson search takes, and for the sharper reason
  // here: a caller that reads a malformed body as "recorded" stops recording.
  if (typeof body.id !== 'string' || typeof body.counted !== 'boolean') {
    throw new MotirAiUnavailableError('reinforce-lesson response missing `id` / `counted`');
  }
  return body as RawReinforcedLesson;
}

export async function getLesson(query: LessonDetailQuery): Promise<RawLesson> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    coreWorkspaceId: query.coreWorkspaceId,
    coreProjectId: query.coreProjectId,
  });
  const res = await aiFetch(
    `${url}/v1/lessons/${encodeURIComponent(query.lessonId)}?${params.toString()}`,
    { headers: authHeaders(serviceToken) },
  );
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as Partial<RawLesson>;
  if (typeof body.id !== 'string') {
    throw new MotirAiUnavailableError('lesson response missing `id`');
  }
  return body as RawLesson;
}

// ── The lesson WRITE half (Subtask MOTIR-3345 · Story MOTIR-3330) ──
//
// Two named acts on one axis. NEITHER SENDS THE OVERRIDE VALUE: motir-ai reads
// the row to decide what `apply` means — clear the retirement on a row somebody
// switched off, exempt from the clock on a row that aged out (MOTIR-3344). Core
// says WHICH lesson and WHO is acting, and nothing else.

export interface LessonWriteQuery {
  coreWorkspaceId: string;
  coreProjectId: string;
  lessonId: string;
  /**
   * The acting core user id.
   *
   * ⚠️ Required, and threaded rather than defaulted. The detail surface promises
   * to say who switched a lesson off; the upstream can only record that if this
   * side sends it, and its absence is invisible until somebody opens that view
   * and finds an audit line saying nothing.
   */
  actorId: string;
}

async function lessonWrite(
  query: LessonWriteQuery,
  action: 'retire' | 'apply',
): Promise<RawLesson> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/lessons/${encodeURIComponent(query.lessonId)}/${action}`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify({
      coreWorkspaceId: query.coreWorkspaceId,
      coreProjectId: query.coreProjectId,
      actorId: query.actorId,
    }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json()) as Partial<RawLesson>;
  // Same malformed-body arm the reads use: a 200 whose shape is wrong is an
  // unavailable upstream, not a lesson.
  if (typeof body.id !== 'string') {
    throw new MotirAiUnavailableError(`lesson ${action} response missing \`id\``);
  }
  return body as RawLesson;
}

// POST /v1/lessons/:id/retire — stop applying this lesson.
export function retireLesson(query: LessonWriteQuery): Promise<RawLesson> {
  return lessonWrite(query, 'retire');
}

// POST /v1/lessons/:id/apply — apply it again. Idempotent, and the upstream
// decides whether that means clearing the retirement or exempting the row.
export function applyLesson(query: LessonWriteQuery): Promise<RawLesson> {
  return lessonWrite(query, 'apply');
}

// ── The models a hosted run may use (MOTIR-6483) ────────────────────────────
//
// GET /v1/agent-models — motir-ai's OFFERED list for a hosted agent run and its
// default (`docs/decisions/hosted-agent-run.md` §7): every model the gateway
// serves, from a provider the hosted egress contract configures, that motir-ai
// can bill in the agent lane. Ids are the gateway's BARE ids.
//
// Kept as one self-contained block — its types and parser live here rather than
// in `./types` — so it stays a single hunk beside the other agent-run reads.

/** One offered model, as motir-ai names it. */
export interface AgentModel {
  /** The gateway's bare id (`claude-opus-5-5`), never provider-prefixed (`toOpenCodeModel` adds that). */
  id: string;
  provider: string;
}

/**
 * The offered list, or `unavailable`. ⚠️ `unavailable` is a STATE, never an
 * empty list: a network error, a timeout, a non-2xx, an unconfigured client or
 * a body that is not a model list must never read as "no models exist".
 */
export type AgentModelsRead =
  | {
      state: 'ok';
      models: AgentModel[];
      default: string | null;
      defaultsByDifficulty: AgentModelDefaultsByDifficulty;
    }
  | { state: 'unavailable'; reason: string };

/**
 * motir-ai's platform default model per leaf difficulty (MOTIR-6990 · MOTIR-6993):
 * all four levels, each an offered bare id or null.
 */
export type AgentModelDefaultsByDifficulty = Record<WorkItemDifficultyDto, string | null>;

/** Every level null — what an older motir-ai, which serves no such field, reads as. */
function noDifficultyDefaults(): AgentModelDefaultsByDifficulty {
  return { trivial: null, low: null, medium: null, high: null };
}

/**
 * `defaultsByDifficulty` is ADDITIVE on the contract, so a missing field (an older
 * motir-ai) is all-null rather than a refusal. A present field that is not an
 * object, or a level that is neither a string nor null, is a malformed answer.
 */
function parseDefaultsByDifficulty(value: unknown): AgentModelDefaultsByDifficulty | null {
  if (value === undefined) return noDifficultyDefaults();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = noDifficultyDefaults();
  for (const level of WORK_ITEM_DIFFICULTIES) {
    const id = (value as Record<string, unknown>)[level];
    if (id === undefined || id === null) continue;
    if (typeof id !== 'string' || !id) return null;
    out[level] = id;
  }
  return out;
}

function parseAgentModels(body: unknown): AgentModelsRead | null {
  if (!body || typeof body !== 'object') return null;
  const {
    models,
    default: defaultId,
    defaultsByDifficulty,
  } = body as { models?: unknown; default?: unknown; defaultsByDifficulty?: unknown };
  if (!Array.isArray(models)) return null;
  const parsed: AgentModel[] = [];
  for (const m of models) {
    const { id, provider } = (m ?? {}) as { id?: unknown; provider?: unknown };
    if (typeof id !== 'string' || !id || typeof provider !== 'string') return null;
    parsed.push({ id, provider });
  }
  if (defaultId !== null && defaultId !== undefined && typeof defaultId !== 'string') return null;
  const byDifficulty = parseDefaultsByDifficulty(defaultsByDifficulty);
  if (!byDifficulty) return null;
  return {
    state: 'ok',
    models: parsed,
    default: defaultId ?? null,
    defaultsByDifficulty: byDifficulty,
  };
}

/**
 * GET /v1/agent-models over the service credential. TOTAL: every failure is
 * `{ state: 'unavailable' }` with its reason, so the caller decides what an
 * unanswered question means (the start path refuses; the picker disables).
 * No cache — see `hostedRunModelService`.
 */
export async function getAgentModels(): Promise<AgentModelsRead> {
  try {
    const { url, serviceToken } = config();
    const res = await aiFetch(`${url}/v1/agent-models`, {
      method: 'GET',
      headers: authHeaders(serviceToken),
    });
    if (!res.ok) return { state: 'unavailable', reason: `motir-ai answered ${res.status}` };
    const parsed = parseAgentModels(await res.json().catch(() => null));
    return (
      parsed ?? {
        state: 'unavailable',
        reason: 'motir-ai answered a body that is not a model list',
      }
    );
  } catch (err) {
    return { state: 'unavailable', reason: describe(err) };
  }
}

// ── The platform planning model (Story MOTIR-7220 · MOTIR-7227) ─────────────
//
// Which model Motir PLANS with, one setting per audience (customer · meta ·
// internal). Stored and validated in motir-ai; read and written here only for the
// operator console (`platformPlannerModelService`). Unlike `getAgentModels`, these
// THROW rather than degrade: the console shows an error card with retry when
// motir-ai cannot answer, so a guessed value is never drawn.

function isPlannerModelSettingsRead(body: unknown): body is PlannerModelSettingsRead {
  if (!body || typeof body !== 'object') return false;
  const { settings, offered } = body as { settings?: unknown; offered?: unknown };
  return Array.isArray(settings) && Array.isArray(offered);
}

/**
 * GET /v1/planner-model-settings — the three audience settings and the offered
 * planning models.
 *
 * @throws MotirAiUnavailableError on a transport failure, a 5xx or a body that is
 *   not the settings shape; the §5 typed error for any other non-2xx.
 */
export async function getPlannerModelSettings(): Promise<PlannerModelSettingsRead> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/planner-model-settings`, {
    method: 'GET',
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body: unknown = await res.json().catch(() => null);
  if (!isPlannerModelSettingsRead(body)) {
    throw new MotirAiUnavailableError(
      'motir-ai answered a body that is not planner-model settings',
    );
  }
  return body;
}

/**
 * The probe's reason out of a `model_unreachable` detail. motir-ai words it
 * `model "<id>" is not reachable for the planner: <reason>`; anything else is
 * passed through whole rather than dropped.
 */
function unreachableReason(detail: string | undefined, fallback: string): string {
  if (!detail) return fallback;
  const marker = 'is not reachable for the planner: ';
  const at = detail.indexOf(marker);
  return at === -1 ? detail : detail.slice(at + marker.length);
}

/**
 * PUT /v1/planner-model-settings — set one audience's planning model.
 *
 * @throws PlannerModelNotOfferedError when motir-ai answers `validation_error`
 *   (the model is not offered for planning — possibly no longer, since the page
 *   loaded).
 * @throws PlannerModelUnreachableError when its probe failed (`model_unreachable`).
 * @throws MotirAiUnavailableError on a transport failure or a 5xx; the §5 typed
 *   error for any other non-2xx.
 */
export async function setPlannerModel(
  input: PlannerModelWriteInput,
): Promise<PlannerModelWriteResult> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/planner-model-settings`, {
    method: 'PUT',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const problem = await readProblem(res);
    if (problem.code === 'validation_error') {
      throw new PlannerModelNotOfferedError(input.model, problem.detail);
    }
    if (problem.code === 'model_unreachable') {
      throw new PlannerModelUnreachableError(
        input.model,
        unreachableReason(problem.detail, problem.title),
      );
    }
    throw errorFromProblem(problem);
  }
  const body = (await res.json().catch(() => null)) as PlannerModelWriteResult | null;
  if (!body || typeof body.previousModel !== 'string' || typeof body.model !== 'string') {
    throw new MotirAiUnavailableError('motir-ai answered a body that is not a planner-model write');
  }
  return body;
}

// ── The planning-model list (Story MOTIR-7521 · MOTIR-7524) ───────────────
//
// Which models an audience MAY be set to, curated in the operator console and
// stored in motir-ai (`GET` / `PUT /v1/planner-model-list`, motir-ai MOTIR-7520).
// Like the settings pair above these THROW rather than degrade: an unanswered
// read is `MotirAiUnavailableError`, never an empty list.

function isPlannerModelListEntry(value: unknown): value is PlannerModelListEntryRead {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['model'] === 'string' &&
    (e['provider'] === null || typeof e['provider'] === 'string') &&
    typeof e['offered'] === 'boolean' &&
    (e['reason'] === null ||
      (PLANNER_MODEL_LIST_REASONS as readonly unknown[]).includes(e['reason'])) &&
    (e['addedByCoreUserId'] === null || typeof e['addedByCoreUserId'] === 'string') &&
    typeof e['createdAt'] === 'string'
  );
}

function isPlannerModelCandidate(value: unknown): value is PlannerModelCandidateRead {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return typeof c['id'] === 'string' && typeof c['provider'] === 'string';
}

function parsePlannerModelList(body: unknown): PlannerModelListRead | null {
  if (!body || typeof body !== 'object') return null;
  const { entries, candidates } = body as { entries?: unknown; candidates?: unknown };
  if (!Array.isArray(entries) || !entries.every(isPlannerModelListEntry)) return null;
  // `candidates` (motir-ai MOTIR-7614) is additive: a motir-ai that predates it
  // answers none, which reads as nothing addable rather than as an outage.
  if (candidates === undefined) return { entries, candidates: [] };
  if (!Array.isArray(candidates) || !candidates.every(isPlannerModelCandidate)) return null;
  return { entries, candidates };
}

/**
 * GET /v1/planner-model-list — every listed model, each with whether motir-ai
 * offers it for planning right now and, when it does not, why.
 *
 * @throws MotirAiUnavailableError on a transport failure, a 5xx or a body that is
 *   not the list shape; the §5 typed error for any other non-2xx.
 */
export async function getPlannerModelList(): Promise<PlannerModelListRead> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/planner-model-list`, {
    method: 'GET',
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const parsed = parsePlannerModelList(await res.json().catch(() => null));
  if (!parsed) {
    throw new MotirAiUnavailableError('motir-ai answered a body that is not a planning-model list');
  }
  return parsed;
}

/** motir-ai's `REASON_TEXT`, read back into the reason it was written from. */
const NOT_QUALIFIED_TEXT: Record<PlannerModelListReason, string> = {
  not_servable: 'the gateway does not serve it',
  not_chat: 'it is not a chat model',
  unrated: 'it has no planning-lane rate in force',
};

/**
 * A planning-model list `validation_error` → its typed refusal. motir-ai has one
 * wire code for all of them and names the cause in `detail`, so the detail's
 * fixed wording is what tells them apart (motir-ai `plannerModelService.ts`,
 * `addToPlannerModelList` / `removeFromPlannerModelList`). A wording this does
 * not recognise is `PlannerModelListRefusedError` with the detail kept whole —
 * never a guess at which refusal it was.
 */
function plannerModelListRefusal(input: PlannerModelListWriteInput, detail: string): Error {
  const { model } = input;
  const notQualified = 'cannot be allowed for planning: ';
  const at = detail.indexOf(notQualified);
  if (input.action === 'add' && at !== -1) {
    const why = detail.slice(at + notQualified.length);
    const reason =
      PLANNER_MODEL_LIST_REASONS.find((r) => NOT_QUALIFIED_TEXT[r] === why.trim()) ?? null;
    return new PlannerModelNotQualifiedError(model, reason, why);
  }
  if (input.action === 'remove' && detail.includes("is the planner's fallback")) {
    return new PlannerModelListFallbackError(model);
  }
  const inUse = /is the planning model of: (.+?) — /.exec(detail);
  if (input.action === 'remove' && inUse) {
    const audiences = inUse[1]!
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    return new PlannerModelListEntryInUseError(model, audiences);
  }
  return new PlannerModelListRefusedError(model, detail);
}

/**
 * PUT /v1/planner-model-list — add or remove one model, answered with the list
 * as it stands after the change. Adding a listed model and removing an unlisted
 * one are motir-ai no-ops, so both answer the list unchanged.
 *
 * @throws PlannerModelNotQualifiedError for an add motir-ai would not plan with.
 * @throws PlannerModelListFallbackError for a remove of the planner's fallback.
 * @throws PlannerModelListEntryInUseError for a remove of a model an audience uses.
 * @throws PlannerModelListRefusedError for any other `validation_error`.
 * @throws MotirAiUnavailableError on a transport failure, a 5xx or a body that is
 *   not the list shape; the §5 typed error for any other non-2xx.
 */
export async function updatePlannerModelList(
  input: PlannerModelListWriteInput,
): Promise<PlannerModelListRead> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/planner-model-list`, {
    method: 'PUT',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const problem = await readProblem(res);
    if (problem.code === 'validation_error') {
      throw plannerModelListRefusal(input, problem.detail ?? problem.title);
    }
    throw errorFromProblem(problem);
  }
  const parsed = parsePlannerModelList(await res.json().catch(() => null));
  if (!parsed) {
    throw new MotirAiUnavailableError('motir-ai answered a body that is not a planning-model list');
  }
  return parsed;
}

// ── Platform-staff credit ops (MOTIR-747 · 10.3.2) ──────────────────────────
//
// The operator side of motir-ai's credit ledger: grant / adjust an org's credits,
// assign its plan tier, read its ledger. Called ONLY from
// `platformCreditOpsService` (superadmin-gated and audited on core's side); the
// ledger stays in motir-ai and core holds no billing table. Like the planner-model
// pair above these THROW rather than degrade — the console shows an error state
// rather than a guessed balance, and "the figures aren't loaded" is never drawn as 0.

/**
 * Map a staff credit op's non-2xx answer. `conflict` is split on its detail
 * prefix (`insufficient_balance:` is the overdraw; anything else is a reused
 * `requestId` or an erased org) before the generic §5 switch.
 */
async function adminCreditProblem(res: Response): Promise<Error> {
  const problem = await readProblem(res);
  if (problem.code === 'conflict') {
    const detail = problem.detail ?? problem.title;
    if (detail.startsWith('insufficient_balance:')) {
      return new MotirAiInsufficientBalanceError(detail);
    }
    return new MotirAiConflictError(detail);
  }
  return errorFromProblem(problem);
}

function isAdminCreditWriteResult(body: unknown): body is AdminCreditWriteResult {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<AdminCreditWriteResult>;
  return (
    typeof b.balanceCredits === 'number' &&
    typeof b.idempotent === 'boolean' &&
    !!b.transaction &&
    typeof b.transaction.id === 'string' &&
    typeof b.transaction.credits === 'number'
  );
}

function isAdminTierWriteResult(body: unknown): body is AdminTierWriteResult {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<AdminTierWriteResult>;
  return (
    typeof b.changed === 'boolean' &&
    typeof b.idempotent === 'boolean' &&
    !!b.assignment &&
    typeof b.assignment.toTierKey === 'string' &&
    !!b.tier &&
    typeof b.tier.key === 'string'
  );
}

function isAdminLedgerRead(body: unknown): body is AdminLedgerRead {
  if (!body || typeof body !== 'object') return false;
  const b = body as Partial<AdminLedgerRead>;
  return (
    typeof b.known === 'boolean' && typeof b.balanceCredits === 'number' && Array.isArray(b.entries)
  );
}

/**
 * POST /v1/admin/credits — append ONE staff `grant` (positive) or `adjustment`
 * (signed, non-zero) row to an org's ledger. Idempotent on `requestId`: a replay
 * answers the stored row with `idempotent: true` and writes nothing.
 *
 * @throws MotirAiInsufficientBalanceError when an adjustment would overdraw.
 * @throws MotirAiConflictError for a reused `requestId` or an erased org.
 * @throws MotirAiBadRequestError for `validation_error`.
 * @throws MotirAiUnavailableError on a transport failure, a 5xx or a malformed body.
 */
export async function adminWriteCredits(
  input: AdminCreditWriteInput,
): Promise<AdminCreditWriteResult> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/admin/credits`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await adminCreditProblem(res);
  const body: unknown = await res.json().catch(() => null);
  if (!isAdminCreditWriteResult(body)) {
    throw new MotirAiUnavailableError('motir-ai answered a body that is not a credit write');
  }
  return body;
}

/**
 * POST /v1/admin/tier — assign an org's `PlanTier`. Grants nothing (a tier's
 * allotment arrives with its billing cycle), and a paid org's next Stripe
 * subscription event still sets its tier from the subscription.
 *
 * @throws MotirAiConflictError for a reused `requestId` or an erased org.
 * @throws MotirAiBadRequestError for `validation_error` (an unknown `tierKey`).
 * @throws MotirAiUnavailableError on a transport failure, a 5xx or a malformed body.
 */
export async function adminAssignTier(input: AdminTierWriteInput): Promise<AdminTierWriteResult> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/admin/tier`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await adminCreditProblem(res);
  const body: unknown = await res.json().catch(() => null);
  if (!isAdminTierWriteResult(body)) {
    throw new MotirAiUnavailableError('motir-ai answered a body that is not a tier assignment');
  }
  return body;
}

/**
 * GET /v1/admin/ledger — one org's balance, tier, latest staff tier assignment
 * and one page of its ledger, newest first. Provisions nothing: an org motir-ai
 * has never seen answers `known: false` with a zero balance.
 *
 * @throws MotirAiBadRequestError for a bad `limit` / `cursor`.
 * @throws MotirAiUnavailableError on a transport failure, a 5xx or a malformed body.
 */
export async function getAdminLedger(query: AdminLedgerQuery): Promise<AdminLedgerRead> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({ coreOrganizationId: query.coreOrganizationId });
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const res = await aiFetch(`${url}/v1/admin/ledger?${params.toString()}`, {
    method: 'GET',
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw await adminCreditProblem(res);
  const body: unknown = await res.json().catch(() => null);
  if (!isAdminLedgerRead(body)) {
    throw new MotirAiUnavailableError('motir-ai answered a body that is not a ledger read');
  }
  return body;
}

/** motir-ai's answer to the hosted-run credit pre-flight (MOTIR-6447). */
export interface AgentRunCreditVerdict {
  /** The one boolean the start path acts on — the gateway's own balance rule. */
  mayRun: boolean;
  balanceCredits: number;
}

function parseAgentRunCreditVerdict(body: unknown): AgentRunCreditVerdict | null {
  if (!body || typeof body !== 'object') return null;
  const { mayRun, balanceCredits } = body as { mayRun?: unknown; balanceCredits?: unknown };
  if (typeof mayRun !== 'boolean') return null;
  return { mayRun, balanceCredits: typeof balanceCredits === 'number' ? balanceCredits : 0 };
}

/**
 * POST /v1/credits/agent-run-check — may this organization start a hosted agent
 * run? (MOTIR-6447; motir-ai `docs/contract.md`.) Asked by the start path BEFORE a
 * run is opened, a key minted or a container booted (MOTIR-690).
 *
 * ⚠️ TOTAL: every failure — unconfigured, unreachable, a non-2xx, a body with no
 * `mayRun` — returns `null`, which means "could not ask". The contract answers a
 * refusal as a 200 with `mayRun: false` and an undecidable request as an error
 * with NO `mayRun`, precisely so the two never read alike; the start path refuses
 * on both, with different words.
 */
export async function checkAgentRunCredits(
  coreOrganizationId: string,
): Promise<AgentRunCreditVerdict | null> {
  try {
    const { url, serviceToken } = config();
    const res = await aiFetch(`${url}/v1/credits/agent-run-check`, {
      method: 'POST',
      headers: authHeaders(serviceToken),
      body: JSON.stringify({ coreOrganizationId }),
    });
    if (!res.ok) return null;
    return parseAgentRunCreditVerdict(await res.json().catch(() => null));
  } catch {
    return null;
  }
}

// ── Organization lifecycle (Story MOTIR-6306) ────────────────────────────────

/** motir-ai's answer to a closing / reopen call: whether anything changed, and
 *  whether the org now reads as closing. An org motir-ai has never seen answers
 *  `{ changed: false }` with 200, never a 404. */
export interface OrgClosingResult {
  changed: boolean;
  closing: boolean;
}

/**
 * POST /v1/orgs/:id/closing — tell motir-ai the organization is closing, so every
 * active subscription stops renewing (MOTIR-6392). Idempotent on motir-ai's side;
 * the schedule service calls it after its commit and never un-schedules on a
 * failure (it throws, and the caller logs).
 */
export async function markOrgClosing(
  coreOrganizationId: string,
  dueAt: Date,
): Promise<OrgClosingResult> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/orgs/${encodeURIComponent(coreOrganizationId)}/closing`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify({ dueAt: dueAt.toISOString() }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as OrgClosingResult;
}

/**
 * DELETE /v1/orgs/:id/closing — a cancel: restore each subscription's own prior
 * renewal (MOTIR-6392). Idempotent; called after the cancel commits.
 */
export async function reopenOrg(coreOrganizationId: string): Promise<OrgClosingResult> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/orgs/${encodeURIComponent(coreOrganizationId)}/closing`, {
    method: 'DELETE',
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as OrgClosingResult;
}

/** motir-ai's answer to an org offboard: whether the tenant was erased this call
 *  (`false` for an org it never saw, and on a re-run over a tombstone). */
export interface OrgOffboardResult {
  erased: boolean;
}

/**
 * POST /v1/orgs/:id/offboard — erase the organization's AI tenant down to its
 * billing tombstone (MOTIR-6393). Idempotent; the erasure sweep calls it as its
 * third step and retries on the next run when it throws.
 */
export async function offboardOrg(coreOrganizationId: string): Promise<OrgOffboardResult> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/orgs/${encodeURIComponent(coreOrganizationId)}/offboard`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as OrgOffboardResult;
}

/** motir-ai's answer to a retained-ledger purge: whether it removed a tombstone
 *  this call (`false` for an org it never saw, or one already purged). */
export interface OrgPurgeRetainedResult {
  purged: boolean;
}

/**
 * POST /v1/orgs/:id/purge-retained — remove an erased organization's tombstone,
 * credit ledger and Stripe ids once its seven-year retention has run
 * (MOTIR-6394). Idempotent; motir-ai refuses (409) an org that is not a
 * tombstone. The retention purge calls it FIRST and retries on the next run when
 * it throws.
 */
export async function purgeOrgRetained(
  coreOrganizationId: string,
): Promise<OrgPurgeRetainedResult> {
  const { url, serviceToken } = config();
  const res = await aiFetch(
    `${url}/v1/orgs/${encodeURIComponent(coreOrganizationId)}/purge-retained`,
    { method: 'POST', headers: authHeaders(serviceToken) },
  );
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as OrgPurgeRetainedResult;
}

// ── The PLATFORM RUNS SLICE (Story MOTIR-727 · MOTIR-731 · motir-ai MOTIR-7239) ──

/** One planning run or hosted agent run, as `GET /v1/platform/runs` returns it. */
export interface RawPlatformRun {
  kind: 'planning' | 'coding';
  id: string;
  /** The planning run's job id, or the hosted run's `DispatchRun.id`. */
  ref: string;
  coreOrganizationId: string;
  coreWorkspaceId: string | null;
  coreProjectId: string | null;
  model: string | null;
  status: string | null;
  startedAt: string;
  lastActivityAt: string;
  inputTokens: number;
  outputTokens: number;
  credits: number;
}

export interface RawPlatformRunsPage {
  items: RawPlatformRun[];
  nextCursor: string | null;
  codingRunsUnattributedExcluded: boolean;
}

export interface PlatformRunsQuery {
  coreOrganizationId?: string | null;
  coreWorkspaceId?: string | null;
  coreProjectId?: string | null;
  kind?: 'planning' | 'coding' | null;
  limit?: number | null;
  /** A cursor the route issued, or one {@link platformRunsCursorAt} built. */
  cursor?: string | null;
}

/**
 * The runs slice's cursor for "everything strictly older than (startedAt, id)".
 *
 * ⚠️ BUILT HERE ON PURPOSE. motir-ai's keyset is `(startedAt DESC, id DESC)` and its
 * cursor is exactly that position (`docs/contract.md` § `GET /v1/platform/runs`), so
 * a page merged from TWO sources — the overview feed, which interleaves motir-core's
 * own tenant events with these runs — can resume the run half from the last run it
 * actually SHOWED, rather than from the end of a page it only partly used.
 */
export function platformRunsCursorAt(startedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: startedAt.toISOString(), i: id })).toString('base64url');
}

/**
 * GET /v1/platform/runs — the estate's recent planning and hosted runs, newest
 * first, keyset-paged, optionally scoped. Read-through: the caller is a
 * `platform*Service` method that has already passed the platform-staff gate.
 */
export async function getPlatformRuns(query: PlatformRunsQuery): Promise<RawPlatformRunsPage> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams();
  for (const key of [
    'coreOrganizationId',
    'coreWorkspaceId',
    'coreProjectId',
    'kind',
    'cursor',
  ] as const) {
    const value = query[key];
    if (value) params.set(key, value);
  }
  if (query.limit) params.set('limit', String(query.limit));
  const res = await aiFetch(`${url}/v1/platform/runs?${params.toString()}`, {
    method: 'GET',
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawPlatformRunsPage;
}

// ── The PLATFORM METER REPORT (Story MOTIR-727 · MOTIR-5286 · motir-ai MOTIR-7290) ──

/** The fleet workloads motir-ai's rollup takes, one category each. */
export type PlatformMeterWorkload = 'agent' | 'agent_instance' | 'ci' | 'index';

/**
 * One meter owner's report (`POST /v1/platform/meter`). motir-core owns the fleet
 * meter, so it reports a settled container's seconds and cost; motir-ai records
 * them and never prices them. NOT a charge — credits move on the debit routes.
 */
export type PlatformMeterReport =
  | {
      kind: 'container';
      /** `CiContainerUsage.id` — the idempotency key at the receiver. */
      containerUsageId: string;
      coreOrganizationId: string;
      coreWorkspaceId: string | null;
      coreProjectId: string | null;
      workload: PlatformMeterWorkload;
      billableSeconds: number;
      /** A DECIMAL STRING, exactly as the meter stored it — never a float. */
      costUsd: string;
      settledAt: string;
    }
  | {
      kind: 'storage';
      instanceId: string;
      coreOrganizationId: string;
      /** `YYYY-MM-DD`, UTC. */
      day: string;
      gbSeconds: number;
      costUsd: string;
    };

/**
 * POST /v1/platform/meter — idempotent on the report's source id: a replay answers
 * `idempotent: true` and adds nothing, so a job may retry it freely. Every failure
 * throws (transport as {@link MotirAiUnavailableError}, a non-2xx as its §5 typed
 * error), which is what lets the job's retry policy own the outage.
 */
export async function reportPlatformMeter(
  report: PlatformMeterReport,
): Promise<{ sourceId: string; idempotent: boolean }> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/platform/meter`, {
    method: 'POST',
    headers: authHeaders(serviceToken),
    body: JSON.stringify(report),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as { sourceId: string; idempotent: boolean };
}

// ── The PLATFORM SPEND READ (Story MOTIR-727 · MOTIR-732 · motir-ai MOTIR-7284) ──

export type PlatformUsageLevel = 'platform' | 'organization' | 'workspace' | 'project';

export interface RawPlatformModelFigures {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheMissTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  credits: number;
  costMicroUsd: number;
  /** At platform level, how many organizations used the model; null below it. */
  orgs: number | null;
}

/** `GET /v1/platform/usage` — one entity's spend for a period. */
export interface RawPlatformUsage {
  period: string;
  level: PlatformUsageLevel;
  entityId: string;
  categories: CategoryFigures[];
  models: { planning_tokens: RawPlatformModelFigures[]; agent_tokens: RawPlatformModelFigures[] };
  spend: {
    chargedCredits: number;
    chargedCostMicroUsd: number;
    costMicroUsdInclIndexing: number;
    machineSeconds: number;
  };
  orgsWithSpend: number | null;
}

/**
 * GET /v1/platform/usage — one entity's spend for `period` (`YYYY-MM` or `all`),
 * all eight categories, the token categories' models and the totals, read from
 * motir-ai's pre-aggregated rollup. Read-through: the caller is a
 * `platform*Service` method that has already passed the platform-staff gate.
 */
export async function getPlatformUsage(query: {
  period: string;
  level?: PlatformUsageLevel;
  entityId?: string | null;
}): Promise<RawPlatformUsage> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({ period: query.period, level: query.level ?? 'platform' });
  if (query.entityId) params.set('entityId', query.entityId);
  const res = await aiFetch(`${url}/v1/platform/usage?${params.toString()}`, {
    method: 'GET',
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawPlatformUsage;
}

/** One entity's row in a spend LIST (`/v1/platform/usage/orgs`, `/children`). */
export interface RawSpendRow {
  entityId: string;
  /** Credits per CHARGED category — indexing is never charged, so never here. */
  credits: Record<Exclude<SpendCategory, 'indexing'>, number>;
  /** Indexing's column is its seconds. */
  indexingSeconds: number;
  chargedCredits: number;
  /** What it cost Motir, indexing included, micro-dollars. */
  costMicroUsd: number;
  cost: Record<SpendCategory, number>;
}

/** The sorts a spend list takes: Motir cost (default), charged total, or a category. */
export type SpendListSort = 'cost' | 'charged' | SpendCategory;

export interface RawPlatformUsageOrgs {
  period: string;
  sort: SpendListSort;
  items: RawSpendRow[];
  nextCursor: string | null;
  /** The whole estate for the period — every organization, not this page or filter. */
  estate: RawSpendRow;
}

/**
 * GET /v1/platform/usage/orgs — the Tenants list: every organization's spend for
 * `period`, keyset-paged by `sort`, optionally narrowed to `coreOrganizationIds`
 * (an EMPTY list narrows to nothing and still answers the estate total).
 */
export async function getPlatformUsageOrgs(query: {
  period: string;
  sort?: SpendListSort | null;
  limit?: number | null;
  cursor?: string | null;
  coreOrganizationIds?: string[] | null;
}): Promise<RawPlatformUsageOrgs> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({ period: query.period });
  if (query.sort) params.set('sort', query.sort);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.coreOrganizationIds)
    params.set('coreOrganizationIds', query.coreOrganizationIds.join(','));
  const res = await aiFetch(`${url}/v1/platform/usage/orgs?${params.toString()}`, {
    method: 'GET',
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawPlatformUsageOrgs;
}

/** `GET /v1/platform/usage/children` — an entity's children's spend, one keyset page. */
export interface RawPlatformUsageChildren {
  period: string;
  sort: SpendListSort;
  level: PlatformUsageLevel;
  entityId: string;
  childLevel: PlatformUsageLevel;
  items: RawSpendRow[];
  nextCursor: string | null;
  /** At organization scope: what no workspace holds (no project; org-level by nature). */
  remainder: { noProject: RawSpendRow; orgLevel: RawSpendRow } | null;
}

/**
 * GET /v1/platform/usage/children — the spend of an organization's workspaces (or
 * a workspace's projects) for `period`, keyset-paged by `sort`; at organization
 * scope it also carries the `remainder` rows no workspace holds.
 */
export async function getPlatformUsageChildren(query: {
  period: string;
  level: Exclude<PlatformUsageLevel, 'platform' | 'project'>;
  entityId: string;
  sort?: SpendListSort | null;
  limit?: number | null;
  cursor?: string | null;
}): Promise<RawPlatformUsageChildren> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({
    period: query.period,
    level: query.level,
    entityId: query.entityId,
  });
  if (query.sort) params.set('sort', query.sort);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const res = await aiFetch(`${url}/v1/platform/usage/children?${params.toString()}`, {
    method: 'GET',
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawPlatformUsageChildren;
}

/** One period's figures in the month series (`/v1/platform/usage/months`). */
export interface RawMonthFigures {
  /** `YYYY-MM`, or `all` for the all-time row. */
  period: string;
  categories: Record<
    SpendCategory,
    { credits: number; usageQuantity: number; costMicroUsd: number }
  >;
  spend: {
    chargedCredits: number;
    chargedCostMicroUsd: number;
    costMicroUsdInclIndexing: number;
    machineSeconds: number;
  };
}

export interface RawPlatformUsageMonths {
  level: PlatformUsageLevel;
  entityId: string;
  /** Newest first. */
  items: RawMonthFigures[];
  /** A `YYYY-MM` to pass back for the older months. */
  nextCursor: string | null;
  allTime: RawMonthFigures;
}

/**
 * GET /v1/platform/usage/months — one entity's spend month by month, newest first,
 * keyset on the month, with its all-time row.
 */
export async function getPlatformUsageMonths(query: {
  level: PlatformUsageLevel;
  entityId?: string | null;
  limit?: number | null;
  cursor?: string | null;
}): Promise<RawPlatformUsageMonths> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams({ level: query.level });
  if (query.entityId) params.set('entityId', query.entityId);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  const res = await aiFetch(`${url}/v1/platform/usage/months?${params.toString()}`, {
    method: 'GET',
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  return (await res.json()) as RawPlatformUsageMonths;
}

// ── The PLATFORM lessons console (MOTIR-1411 over motir-ai MOTIR-1410) ─────────
//
// `/v1/admin/lessons` — every tenant's lessons and the global corpus in one list,
// and the three curate acts. Same `config()` / `aiFetch` / problem mapping as the
// tenant-scoped `/v1/lessons` pair above; the difference is that these rows name
// their TENANT (`null` for a global lesson), because the console shows them all.
//
// ⚠️ motir-ai WRITES NO AUDIT ROW; every write answers the from → to record and
// core appends it to its own platform log (`platformLessonsService`), the
// planner-model split. `audit: null` is a write that changed nothing.

/** The core identity a tenant lesson belongs to; `null` on a global lesson. */
export interface RawPlatformLessonTenant {
  coreOrganizationId: string;
  coreWorkspaceId: string;
  coreProjectId: string;
}

export interface RawPlatformLesson extends RawLesson {
  tenant: RawPlatformLessonTenant | null;
}

export interface RawPlatformLessonOccurrence {
  at: string;
  source: string;
  occurrenceRef: string;
}

export interface RawPlatformLessonDetail extends RawPlatformLesson {
  occurrences: RawPlatformLessonOccurrence[];
}

export interface RawPlatformLessonPage {
  lessons: RawPlatformLesson[];
  nextCursor: string | null;
  retentionDays: number;
}

export interface RawPlatformLessonAudit {
  action: 'ai.lesson.edit' | 'ai.lesson.enable' | 'ai.lesson.disable' | 'ai.lesson.promote';
  lessonId: string;
  actorCoreUserId: string;
  at: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface RawPlatformLessonWrite {
  lesson: RawPlatformLesson;
  audit: RawPlatformLessonAudit | null;
}

export interface PlatformLessonListQuery {
  scope?: 'global' | 'tenant';
  mistakeType?: string;
  category?: string;
  enabled?: boolean;
  coreOrganizationId?: string;
  coreProjectId?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface PlatformLessonEditPatch {
  title?: string;
  why?: string;
  howToApply?: string;
  categories?: string[];
}

export type PlatformLessonPromotion = 'global' | 'planning_craft';

/** A non-2xx from an id-addressed lesson route, with `not_found` given its own class. */
async function platformLessonError(res: Response, lessonId: string): Promise<Error> {
  const problem = await readProblem(res);
  if (problem.code === 'not_found') return new PlatformLessonNotFoundError(lessonId);
  return errorFromProblem(problem);
}

// GET /v1/admin/lessons — one page across every tenant and the global corpus.
export async function listPlatformLessons(
  query: PlatformLessonListQuery,
): Promise<RawPlatformLessonPage> {
  const { url, serviceToken } = config();
  const params = new URLSearchParams();
  if (query.scope) params.set('scope', query.scope);
  if (query.mistakeType) params.set('mistakeType', query.mistakeType);
  if (query.category) params.set('category', query.category);
  if (query.enabled !== undefined) params.set('enabled', String(query.enabled));
  if (query.coreOrganizationId) params.set('coreOrganizationId', query.coreOrganizationId);
  if (query.coreProjectId) params.set('coreProjectId', query.coreProjectId);
  if (query.q) params.set('q', query.q);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  const res = await aiFetch(`${url}/v1/admin/lessons${qs ? `?${qs}` : ''}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json().catch(() => null)) as Partial<RawPlatformLessonPage> | null;
  // A 200 whose shape is wrong is an unavailable upstream, not an empty corpus.
  if (!body || !Array.isArray(body.lessons)) {
    throw new MotirAiUnavailableError('platform lessons response missing `lessons`');
  }
  return {
    lessons: body.lessons,
    nextCursor: body.nextCursor ?? null,
    retentionDays: typeof body.retentionDays === 'number' ? body.retentionDays : 0,
  };
}

// GET /v1/admin/lessons/:id — one lesson with its newest occurrences.
export async function getPlatformLesson(lessonId: string): Promise<RawPlatformLessonDetail> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/admin/lessons/${encodeURIComponent(lessonId)}`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw await platformLessonError(res, lessonId);
  const body = (await res.json().catch(() => null)) as RawPlatformLessonDetail | null;
  if (!body || typeof body.id !== 'string') {
    throw new MotirAiUnavailableError('platform lesson response is not a lesson');
  }
  return { ...body, occurrences: Array.isArray(body.occurrences) ? body.occurrences : [] };
}

async function platformLessonWrite(
  lessonId: string,
  path: string,
  method: 'PATCH' | 'PUT' | 'POST',
  payload: Record<string, unknown>,
): Promise<RawPlatformLessonWrite> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/admin/lessons/${encodeURIComponent(lessonId)}${path}`, {
    method,
    headers: authHeaders(serviceToken),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await platformLessonError(res, lessonId);
  const body = (await res.json().catch(() => null)) as RawPlatformLessonWrite | null;
  if (!body || !body.lesson || typeof body.lesson.id !== 'string' || body.audit === undefined) {
    throw new MotirAiUnavailableError('platform lesson write answered no `{ lesson, audit }`');
  }
  return body;
}

// PATCH /v1/admin/lessons/:id — edit title / why / howToApply / categories.
export function editPlatformLesson(
  lessonId: string,
  patch: PlatformLessonEditPatch,
  actorCoreUserId: string,
): Promise<RawPlatformLessonWrite> {
  return platformLessonWrite(lessonId, '', 'PATCH', { ...patch, actorCoreUserId });
}

// PUT /v1/admin/lessons/:id/enabled — the operator switch.
export function setPlatformLessonEnabled(
  lessonId: string,
  enabled: boolean,
  actorCoreUserId: string,
): Promise<RawPlatformLessonWrite> {
  return platformLessonWrite(lessonId, '/enabled', 'PUT', { enabled, actorCoreUserId });
}

// POST /v1/admin/lessons/:id/promote — to `global` or `planning_craft`.
export function promotePlatformLesson(
  lessonId: string,
  to: PlatformLessonPromotion,
  actorCoreUserId: string,
): Promise<RawPlatformLessonWrite> {
  return platformLessonWrite(lessonId, '/promote', 'POST', { to, actorCoreUserId });
}

// ── The lesson-retirement window N (MOTIR-1463) ────────────────────────────────
//
// `/v1/admin/lesson-retention` — one platform-wide setting motir-ai owns. Like
// the curate writes, a PUT answers the from → to record core appends to its
// platform audit log, `audit: null` when N already had that value.

export interface RawLessonRetention {
  days: number;
  defaultDays: number;
  isSet: boolean;
  updatedAt: string | null;
  updatedByCoreUserId: string | null;
  minDays: number;
  maxDays: number;
}

export interface RawLessonRetentionWrite {
  setting: RawLessonRetention;
  audit: {
    action: 'ai.lesson.retention_set';
    actorCoreUserId: string;
    at: string;
    before: { days: number };
    after: { days: number };
  } | null;
}

function isRetention(body: unknown): body is RawLessonRetention {
  return (
    !!body &&
    typeof body === 'object' &&
    typeof (body as RawLessonRetention).days === 'number' &&
    typeof (body as RawLessonRetention).isSet === 'boolean'
  );
}

// GET /v1/admin/lesson-retention
export async function getLessonRetention(): Promise<RawLessonRetention> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/admin/lesson-retention`, {
    headers: authHeaders(serviceToken),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = await res.json().catch(() => null);
  if (!isRetention(body)) {
    throw new MotirAiUnavailableError('lesson-retention response is not a setting');
  }
  return body;
}

// GET /v1/admin/lesson-retention/impact?days=N
export async function previewLessonRetentionImpact(
  days: number,
): Promise<{ days: number; wouldRest: number }> {
  const { url, serviceToken } = config();
  const res = await aiFetch(
    `${url}/v1/admin/lesson-retention/impact?days=${encodeURIComponent(String(days))}`,
    { headers: authHeaders(serviceToken) },
  );
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json().catch(() => null)) as {
    days?: unknown;
    wouldRest?: unknown;
  } | null;
  if (!body || typeof body.wouldRest !== 'number' || typeof body.days !== 'number') {
    throw new MotirAiUnavailableError('lesson-retention impact response has no count');
  }
  return { days: body.days, wouldRest: body.wouldRest };
}

// PUT /v1/admin/lesson-retention
export async function setLessonRetention(
  days: number,
  actorCoreUserId: string,
): Promise<RawLessonRetentionWrite> {
  const { url, serviceToken } = config();
  const res = await aiFetch(`${url}/v1/admin/lesson-retention`, {
    method: 'PUT',
    headers: authHeaders(serviceToken),
    body: JSON.stringify({ days, actorCoreUserId }),
  });
  if (!res.ok) throw errorFromProblem(await readProblem(res));
  const body = (await res.json().catch(() => null)) as RawLessonRetentionWrite | null;
  if (!body || !isRetention(body.setting) || body.audit === undefined) {
    throw new MotirAiUnavailableError('lesson-retention write answered no `{ setting, audit }`');
  }
  return body;
}
