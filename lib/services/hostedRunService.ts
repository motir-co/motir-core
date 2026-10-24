import { FLEET_CONTAINER_SIZE, type TeardownReason } from '@motir/orchestrator';
import { assertWorkspaceFeatureEnabled } from '@/lib/featureFlags/evaluate';
import { checkAgentRunCredits, type AgentModel } from '@/lib/ai/motirAiClient';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { DispatchRunTerminalError } from '@/lib/dispatchRuns/errors';
import { gateIdOfReviewRunKey } from '@/lib/agentReview/reviewRunKey';
import {
  hostedRunWriteAccess,
  repositoriesForItems,
  repositoriesForRepair,
  revokeRunGitCredentials,
  type RunGitNeed,
  type RunRepository,
} from '@/lib/github/runGitCredential';
import {
  HostedModelsUnavailableError,
  HostedRunAlreadyEndedError,
  HostedRunBootFailedError,
  HostedRunCancelForbiddenError,
  HostedContinueRefusedError,
  HostedFixRefusedError,
  HostedRunCardNotReadyError,
  HostedRunCreditsUnavailableError,
  HostedRunNotFoundError,
  HostedRunOutOfCreditsError,
  HostedRunRepositoryNotReadableError,
  HostedRunRepositoryNotWritableError,
  type RunGitWriteRefusal,
} from '@/lib/hostedRuns/errors';
import {
  HOSTED_RUN_STALL_WINDOW_MS,
  HOSTED_RUN_TIMEOUT_MS,
  hostedRunDeadline,
  hostedRunStallWindowMs,
  latestRunCredentialExpiry,
} from '@/lib/hostedRuns/limits';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import type { MemoizingSteps } from '@/lib/jobs/supervision/inProcessSteps';
import { sendEvent } from '@/lib/jobs/sendEvent';
import {
  HOSTED_RUN_ADMIT_RETRY_MS,
  type HostedRunAdmitData,
  type HostedRunSuperviseData,
} from '@/lib/jobs/types';
import { hostedAgentFleetConfig } from '@/lib/orchestrator';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { agentInstanceRunService } from '@/lib/services/agentInstanceRunService';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import {
  hostedAgentContainerService,
  type HostedAgentContainerOutcome,
  type HostedAgentContainerRequest,
  type HostedAgentLivenessVerdict,
  type HostedAgentSession,
  type HostedAgentSupervisionOptions,
} from '@/lib/services/hostedAgentContainerService';
import { hostedRunKeyService } from '@/lib/services/hostedRunKeyService';
import { hostedRunModelService, toOpenCodeModel } from '@/lib/services/hostedRunModelService';
import { projectHostedAgentSettingsService } from '@/lib/services/projectHostedAgentSettingsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { scopeClaimService } from '@/lib/services/scopeClaimService';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { workItemsService } from '@/lib/services/workItemsService';
import { isClaimableState } from '@/lib/workItems/claimOutcome';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';

// START A HOSTED RUN, AND SUPERVISE IT (Story MOTIR-683 · MOTIR-690) — the
// composer `hostedAgentContainerService` was written to be composed by: *"no
// prompt, no run-scoped token, no gateway key, no pull request, no run record —
// those are the composer's"*. `docs/decisions/hosted-agent-run.md` and
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` are the decisions.
//
// ⚠️ EVERY REFUSAL COMES BEFORE ANY SPEND, in this order: the card is ready, the
// model is offered, the organization has credits, every repository the run
// touches can be written, the fleet is configured. Each is a read. Only then is
// the run opened, its cards claimed, its two credentials minted and its machine
// booted — and a failure from that point on hands the run to the end path, so
// nothing minted before it is left alive.
//
// ⚠️ THE CONTAINER IS BOOTED HERE, IN THE REQUEST, AND THAT IS NOT A SHORTCUT.
// The boot's env carries the run credential and the gateway key. A job payload is
// a `job_queue` row and a step memo is a `job_step` row: neither may hold a
// secret. So the start path boots, and the durable job supervises the SESSION the
// boot returned — which is JSON with no secret in it (`HostedRunSuperviseData`).
//
// ⚠️ A RUN IS A RUN, NOT A CARD (the CLI-in-a-container decision). A LEAF is one
// leg; a PARENT is every child its scope claim yields, in dependency order. The
// repository set, the write-access check and the container are all the RUN's.

/** What a start request asks for. `model` is the BARE gateway id. */
export interface StartHostedRunInput {
  workItemKey: string;
  /**
   * The bare model id the person picked. ABSENT means "the server chooses"
   * (Story MOTIR-6989 · MOTIR-6994): the card's model is resolved from its
   * difficulty — a parent's highest among its unfinished leaves — through the
   * project's overrides and motir-ai's defaults (`resolveForWorkItem`), then
   * checked exactly as a sent model is. A sent model always wins.
   */
  model?: string;
  idempotencyKey: string;
  /**
   * `run` (the default) starts a READY card. `continue` (MOTIR-6792) resumes a
   * card whose last run DIED, on that run's branches: the container runs
   * `motir continue <KEY>` instead of `motir run <KEY>`. `fix` (MOTIR-6928;
   * `hosted-agent-run.md` §8.6) repairs a card a REVIEW sent back, on its pull
   * requests' own branches: the container runs `motir fix <KEY>`.
   */
  mode?: 'run' | 'continue' | 'fix';
}

/** A start whose model is settled — sent by the person, or resolved by the server. */
type ResolvedStartInput = StartHostedRunInput & { model: string };

/**
 * What a REVIEW start asks for (Story MOTIR-1626 · MOTIR-6820; `hosted-agent-run.md` §8.1)
 * — the gate the run answers, at the version it asks about. No model: a review has no
 * dispatcher to choose one, so it takes the offered list's default.
 */
export interface StartHostedReviewInput {
  workItemId: string;
  gateId: string;
  subjectVersion: string;
  /** The request's key (`lib/agentReview/reviewRunKey.ts`) — the run's idempotency key,
   *  which is how the run names its gate. */
  idempotencyKey: string;
}

/** The `reviewUnavailableReason` a review run that ended without a verdict leaves on its
 *  still-awaiting gate (`approval-gates.md` §12.6, the column's own comment). */
export const REVIEW_NO_VERDICT_REASON = 'no_verdict';

/** The teardown detail of a review run whose gate was superseded (§12.5). */
export const HOSTED_REVIEW_SUPERSEDED_DETAIL = 'its review was superseded';

export interface HostedRunStarted {
  dispatchRunId: string;
  /** False when `idempotencyKey` named a run already started: nothing new happened. */
  created: boolean;
}

/** Seams a test drives. Nothing here lengthens a shipped budget. */
export interface HostedRunStartOptions {
  now?: () => Date;
  /** Passed to the container boot (its clock, its budgets). */
  supervision?: HostedAgentSupervisionOptions;
}

/**
 * How a hosted run ended, as the END PATH names it (MOTIR-6450).
 *
 * ⚠️ THERE IS NO `succeeded`, AND THAT IS THE POINT. The CLI in the container
 * decides success: it closes the run it adopted `succeeded` exactly as a local run
 * does, after linking its pull requests and moving its cards. The container's
 * exit code is the CLI's own, so an `exited` container is only a container that
 * stopped by itself — a run still OPEN at that moment is a CRASH (the CLI died
 * before closing it; `20` means the launcher never reached the CLI at all), and
 * it is closed `failed`, never `succeeded`.
 */
export type HostedRunEndOutcome =
  | 'exited'
  | 'failed'
  | 'cancelled'
  | 'backstop'
  | 'stall'
  | 'lost_supervision';

/** The exit code the image's launcher uses when it never reached the CLI. */
export const HOSTED_LAUNCHER_NEVER_REACHED_CLI = 20;

/** What {@link hostedRunService.endHostedRun} did — never a throw. JSON, because the
 *  supervisor memoizes it. */
export interface HostedRunEndResult {
  /** True when THIS call closed the run; false when the CLI (or an earlier call) had. */
  closed: boolean;
  runKey: 'revoked' | 'failed';
  runCredential: number;
  gitCredentials: { revoked: number; failed: number };
}

/** The idempotent step the supervisor ends a run under, once its container settled. */
export function hostedRunEndStepId(dispatchRunId: string): string {
  return `hosted-run-end:${dispatchRunId}`;
}

export { hostedRunDispatchId };

/** The `failureDetail` a stall settles with, and how the end path tells it apart. */
export const HOSTED_RUN_STALL_DETAIL = `stalled: no agent output for ${
  HOSTED_RUN_STALL_WINDOW_MS / 60_000
} minutes`;

/** The project key a `MOTIR-<n>` identifier belongs to. */
function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/**
 * The legs of a parent run in DEPENDENCY order — a stable topological sort over
 * the `is_blocked_by` edges among the children, ties broken by board position.
 * The CLI's drain orders its adopted legs the same way (`orderClaimedSet`), so
 * the positions on the run page are the order the container works them. A cycle
 * cannot drop a card: whatever cannot be placed is appended in input order.
 */
function orderLegs(
  children: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ fromId: string; toId: string }>,
): string[] {
  const blockers = new Map<string, string[]>();
  for (const e of edges) blockers.set(e.fromId, [...(blockers.get(e.fromId) ?? []), e.toId]);
  const placed = new Set<string>();
  const out: string[] = [];
  let remaining = children.map((c) => c.id);
  while (remaining.length > 0) {
    const ready = remaining.filter((id) => (blockers.get(id) ?? []).every((b) => placed.has(b)));
    const batch = ready.length > 0 ? ready : remaining;
    for (const id of batch) {
      out.push(id);
      placed.add(id);
    }
    const done = new Set(batch);
    remaining = remaining.filter((id) => !done.has(id));
  }
  return out;
}

/** What the end path makes of a settled container. */
function endOutcomeFor(outcome: HostedAgentContainerOutcome): {
  outcome: HostedRunEndOutcome;
  detail: string;
} {
  if (outcome.outcome !== 'settled') {
    return {
      outcome: 'failed',
      detail: `the container ended as ${outcome.outcome}: ${outcome.detail}`,
    };
  }
  if (outcome.reason === 'job_completed') {
    return {
      outcome: 'exited',
      detail:
        outcome.exitCode === HOSTED_LAUNCHER_NEVER_REACHED_CLI
          ? `the container exited ${HOSTED_LAUNCHER_NEVER_REACHED_CLI}: the launcher never reached the CLI`
          : `the container exited ${String(outcome.exitCode)}`,
    };
  }
  if (outcome.reason === 'job_timed_out') {
    return outcome.failureDetail === HOSTED_RUN_STALL_DETAIL
      ? { outcome: 'stall', detail: HOSTED_RUN_STALL_DETAIL }
      : {
          outcome: 'backstop',
          detail:
            outcome.failureDetail ??
            `timed out at the ${HOSTED_RUN_TIMEOUT_MS / 3_600_000}-hour backstop`,
        };
  }
  if (outcome.reason === 'gate_revoked') return { outcome: 'cancelled', detail: 'cancelled' };
  return {
    outcome: 'failed',
    detail: outcome.failureDetail ?? `the container ended: ${outcome.reason}`,
  };
}

/** How a run is closed for an end outcome the CLI did not close it with. */
const CLOSE_FOR: Record<
  HostedRunEndOutcome,
  {
    stopReason: 'completed' | 'halted' | 'interrupted' | 'abandoned';
    status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  }
> = {
  exited: { stopReason: 'halted', status: 'failed' },
  failed: { stopReason: 'halted', status: 'failed' },
  cancelled: { stopReason: 'interrupted', status: 'cancelled' },
  backstop: { stopReason: 'abandoned', status: 'timed_out' },
  stall: { stopReason: 'abandoned', status: 'timed_out' },
  lost_supervision: { stopReason: 'abandoned', status: 'timed_out' },
};

/** The word the run's closing `log` line names an end by — "crash" for a
 *  container that exited with its run still open. */
const END_LABEL: Record<HostedRunEndOutcome, string> = {
  exited: 'crash',
  failed: 'failed',
  cancelled: 'cancelled',
  backstop: 'backstop',
  stall: 'stalled',
  lost_supervision: 'lost supervision',
};

/** The `failureDetail` a cancelled run's container is torn down with. */
export const HOSTED_RUN_CANCEL_DETAIL = 'cancelled';

/** A request for a container that is already booted — the supervisor's. Its env
 *  and image are empty on purpose: the boot step replays the session (the
 *  `booted` option), and nothing reads either. */
function requestFromSession(session: HostedAgentSession): HostedAgentContainerRequest {
  return {
    dispatchId: session.dispatchId,
    runId: session.runId,
    dispatchRunId: session.dispatchRunId,
    organizationId: session.attribution.orgId,
    workspaceId: session.attribution.workspaceId,
    projectId: session.attribution.projectId,
    repoFullName: session.attribution.repoFullName,
    image: '',
    env: {},
    region: session.handle.region,
    size: session.size,
    timeoutSeconds: session.timeoutSeconds,
  };
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err);
}

/** What the pre-flights settled — the inputs the boot needs. */
interface HostedRunPreflight {
  /** The model the run takes — the dispatcher's choice, or a review's default. BARE. */
  model: string;
  /** Its offered entry, carrying the PROVIDER OpenCode's `--model` is spelled with
   *  (MOTIR-7208; `hosted-agent-run.md` §7). Read in the same call that validated it. */
  offered: AgentModel;
  organizationId: string;
  repositories: RunRepository[];
  fleet: ReturnType<typeof hostedAgentFleetConfig>;
}

/**
 * EVERY REFUSAL BEFORE ANY SPEND, in order: the CI-credit gate, the model, the
 * organization's credits, every repository of the run writable, the fleet
 * configured. Each is a read. Shared by Run hosted and Continue hosted
 * (MOTIR-6792) so a continue costs and refuses exactly like a run — and by the
 * REVIEW start (MOTIR-6820), which passes no model (it takes the offered list's
 * default) and needs every repository READABLE only (`hosted-agent-run.md` §8.1, §8.3).
 */
async function preflight(
  input: { model?: string | undefined },
  projectId: string,
  legIds: string[],
  ctx: ServiceContext,
  need: RunGitNeed = 'write',
  /** `repair` (MOTIR-6928): the repositories of the legs' OPEN pull requests — what a
   *  hosted repair pushes to — rather than the legs' target set. */
  scope: 'legs' | 'repair' = 'legs',
): Promise<HostedRunPreflight> {
  // The CI-credit gate every dispatch entry point runs — here, before the run
  // opens, so an exhausted organization is refused rather than failed.
  await ciAllowanceService.assertDispatchAllowed(ctx);

  // ── 2 · The model, live — never a cache ──────────────────────────────────
  const offered =
    input.model === undefined
      ? await hostedRunModelService.defaultOffered()
      : await hostedRunModelService.assertOffered(input.model);
  const model = offered.id;

  // ── 3 · Credits — the gateway's own balance rule ────────────────────────
  const organizationId = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    workspaceRepository.findOrganizationId(ctx.workspaceId, tx),
  );
  /* v8 ignore next -- a workspace always belongs to an organization */
  if (!organizationId) throw new HostedRunCreditsUnavailableError();
  const credits = await checkAgentRunCredits(organizationId);
  if (credits === null) throw new HostedRunCreditsUnavailableError();
  if (!credits.mayRun) throw new HostedRunOutOfCreditsError(credits.balanceCredits);

  // ── 3b · Every repository the run touches can be written ────────────────
  const repositories: RunRepository[] = await (
    scope === 'repair' ? repositoriesForRepair : repositoriesForItems
  )(projectId, ctx.workspaceId, legIds);
  const access = await hostedRunWriteAccess(repositories, need);
  const refusals = access.filter((a): a is Extract<typeof a, { ok: false }> => !a.ok);
  if (refusals.length > 0) {
    const named = refusals.map(
      ({ ok: _ok, app: _app, ...refusal }) => refusal as RunGitWriteRefusal,
    );
    if (need === 'read') throw new HostedRunRepositoryNotReadableError(named);
    throw new HostedRunRepositoryNotWritableError(named, repositories.length);
  }
  // The fleet, last of the reads: an unconfigured deployment opens nothing.
  const fleet = hostedAgentFleetConfig();
  return { model, offered, organizationId, repositories, fleet };
}

/**
 * Stamp the legs hosted, then admit the run: mint its two credentials, boot the
 * container and hand it to the durable supervisor — for a run already OPENED (by
 * Run hosted's open, or by the continue claim's hosted opening). A run held at
 * its org's plan figure (or an unreadable plan) is NOT ended: it stays open and
 * claimed, and the `hosted-run/admit` job boots it once there is room
 * (MOTIR-9381). A failure after this starts is the caller's to end.
 */
async function launch(
  run: { id: string; startedAt: string },
  input: Pick<ResolvedStartInput, 'model'>,
  target: { identifier: string; projectId: string; legIds: string[] },
  checked: HostedRunPreflight,
  ctx: ServiceContext,
  options: HostedRunStartOptions,
  extraEnv: Record<string, string> = {},
  /** False for a REVIEW (MOTIR-6820): it implements nothing, so it stamps no card's
   *  implementation provenance (`hosted-agent-run.md` §8.3 — it writes no card). */
  stampLegs = true,
): Promise<void> {
  const { identifier, legIds } = target;
  const { organizationId, repositories, fleet } = checked;
  const project = { id: target.projectId };
  if (stampLegs) {
    await withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, async (tx) => {
      for (const id of legIds) {
        await workItemsService.recordImplementationProvenance(
          id,
          { source: 'hosted', harness: 'opencode', model: input.model },
          tx,
        );
      }
    });
  }

  // ── 6 · The boot's NON-SECRET inputs — what a held run is rebuilt from ──
  const admission: HostedRunAdmitData = {
    workspaceId: ctx.workspaceId,
    dispatchRunId: run.id,
    dispatcherUserId: ctx.userId,
    organizationId,
    projectId: project.id,
    identifier,
    /* v8 ignore next -- `repositoriesForItems` refuses an empty set */
    repoFullName: repositories[0]?.repository ?? '',
    model: input.model,
    // The ONE prefixed spelling — the offered entry's own provider (MOTIR-7208).
    // The key, `DispatchRun.model` and the stamped provenance stay BARE.
    openCodeModel: toOpenCodeModel(checked.offered),
    extraEnv,
    idempotencyKey: hostedRunAdmitKey(run.id),
  };

  // ── 7 · Admit and boot — or, held at the plan's figure, WAIT (MOTIR-9381) ──
  const first = await admitHostedRun(admission, { ...options, fleet });
  if (first.kind === 'failed') throw new HostedRunBootFailedError(run.id, first.detail);
  if (first.kind === 'waiting') {
    // The run stays open and claimed; a durable job asks again until it boots.
    await sendEvent('hosted-run/admit', admission, { strict: true });
  }
}

/** One admission job per run, however often it is emitted. */
export function hostedRunAdmitKey(dispatchRunId: string): string {
  return `hosted-run-admit:${dispatchRunId}`;
}

/** Re-exported from the job's payload module, where the job reads it without
 *  loading this service's import graph (MOTIR-9381). */
export { HOSTED_RUN_ADMIT_RETRY_MS };

/**
 * The admission deferrals that clear BY THEMSELVES (MOTIR-9381): the org is at
 * its plan's agent-run figure, or its plan could not be read. A run held for one
 * of these waits. Every other deferral — no paid plan, the kill switch, no
 * organisation, an unreadable count — ends the run as it always did.
 */
export const HOSTED_RUN_WAITING_REASONS: ReadonlySet<string> = new Set([
  'plan_cap',
  'plan_unknown',
]);

/** The backstop's words for a run that waited its whole life for room. */
export const HOSTED_RUN_NEVER_ADMITTED_DETAIL = `it waited the whole ${
  HOSTED_RUN_TIMEOUT_MS / 3_600_000
}-hour backstop and never got room to run`;

/** What one admission pass did. */
export type HostedRunAdmitResult =
  /** Booted and handed to the supervisor — or another pass already holds it. */
  | { kind: 'booted' }
  /** Held for a reason that clears by itself; the run stays open. */
  | { kind: 'waiting'; detail: string }
  /** The run is no longer open (cancelled, or ended): nothing was booted. */
  | { kind: 'closed' }
  /** The run was ended `failed` (or at its backstop) with this detail. */
  | { kind: 'failed'; detail: string };

/** A pass found the run closed after its slot was taken — the slot goes back. */
class HostedRunClosedBeforeBootError extends Error {
  constructor(dispatchRunId: string) {
    super(`hosted run ${dispatchRunId} closed before it booted`);
    this.name = 'HostedRunClosedBeforeBootError';
  }
}

/**
 * ONE ADMISSION PASS (MOTIR-9381) — the first try in the request, and every
 * pass of the `hosted-run/admit` job after it. It reads the run first, so a
 * cancel between passes wins; asks the fleet for a slot ONCE; and only once the
 * slot is taken mints the run key and the run credential, with their lives
 * counted from that instant, so a run that waited boots with credentials good
 * for its whole container life.
 *
 * A second pass for the same run finds its slot already held and boots nothing
 * (`already_booting`). A throw after the run opened is the caller's to end.
 */
async function admitHostedRun(
  data: HostedRunAdmitData,
  options: HostedRunStartOptions & { fleet?: ReturnType<typeof hostedAgentFleetConfig> },
): Promise<HostedRunAdmitResult> {
  const now = options.now ?? ((): Date => new Date());
  const run = await withSystemContext((tx) =>
    dispatchRunRepository.findById(data.dispatchRunId, tx),
  );
  if (!run || run.status !== 'running') return { kind: 'closed' };
  if (now().getTime() >= hostedRunDeadline(new Date(run.startedAt)).getTime()) {
    await hostedRunService.endHostedRun(
      data.dispatchRunId,
      'backstop',
      HOSTED_RUN_NEVER_ADMITTED_DETAIL,
    );
    return { kind: 'failed', detail: HOSTED_RUN_NEVER_ADMITTED_DETAIL };
  }

  const fleet = options.fleet ?? hostedAgentFleetConfig();
  const request: HostedAgentContainerRequest = {
    dispatchId: hostedRunDispatchId(data.dispatchRunId),
    runId: data.dispatchRunId,
    dispatchRunId: data.dispatchRunId,
    organizationId: data.organizationId,
    workspaceId: data.workspaceId,
    projectId: data.projectId,
    repoFullName: data.repoFullName,
    image: fleet.image,
    // The launcher's inputs, and no other credential. The two secrets are added
    // at admission, below.
    env: {
      MOTIR_DISPATCH_RUN_ID: data.dispatchRunId,
      MOTIR_WORK_ITEM_KEY: data.identifier,
      MOTIR_API_URL: resolveBaseUrlTrimmed(),
      MOTIR_MODEL: data.openCodeModel,
      ...data.extraEnv,
    },
    region: fleet.region,
    size: FLEET_CONTAINER_SIZE,
    timeoutSeconds: HOSTED_RUN_TIMEOUT_MS / 1000,
  };

  let booted;
  try {
    booted = await hostedAgentContainerService.boot(request, {
      ...options.supervision,
      envAtAdmission: async () => {
        // A cancel that landed while this pass waited for the slot wins: the
        // slot goes back and nothing is minted or booted.
        const current = await withSystemContext((tx) =>
          dispatchRunRepository.findById(data.dispatchRunId, tx),
        );
        if (current?.status !== 'running') {
          throw new HostedRunClosedBeforeBootError(data.dispatchRunId);
        }
        // ── The two credentials, each dying by the backstop FROM ADMISSION ──
        const admittedAt = now();
        const runKey = await hostedRunKeyService.mintRunKey(
          { id: data.dispatchRunId, organizationId: data.organizationId, startedAt: admittedAt },
          data.model,
          admittedAt,
        );
        const runCredential = await runCredentialService.mintRunCredential(
          {
            dispatchRunId: data.dispatchRunId,
            dispatcherUserId: data.dispatcherUserId,
            expiresAt: latestRunCredentialExpiry(admittedAt),
          },
          admittedAt,
        );
        return {
          MOTIR_RUN_TOKEN: runCredential.token,
          MOTIR_GATEWAY_URL: runKey.containerEnv.MOTIR_GATEWAY_URL,
          MOTIR_RUN_KEY: runKey.containerEnv.MOTIR_RUN_KEY,
        };
      },
    });
  } catch (err) {
    if (err instanceof HostedRunClosedBeforeBootError) return { kind: 'closed' };
    throw err;
  }

  if (booted.phase === 'already_booting') return { kind: 'booted' };
  if (booted.phase === 'terminal') {
    const { outcome } = booted;
    if (
      outcome.outcome === 'admission_deferred' &&
      HOSTED_RUN_WAITING_REASONS.has(outcome.reason)
    ) {
      await recordWaitingLine(run, outcome.detail);
      return { kind: 'waiting', detail: outcome.detail };
    }
    const detail = bootFailureDetail(outcome);
    await hostedRunService.endHostedRun(data.dispatchRunId, 'failed', detail);
    return { kind: 'failed', detail };
  }

  // ── Hand the booted session to the durable supervisor ──────────────────
  // The account the container booted on is on the run BEFORE anything can
  // supervise, reap or bill it (MOTIR-9423); null for the process-wide fleet.
  // A write that fails tears the container down below, like a failed enqueue.
  try {
    await withWorkspaceServiceContext(data.workspaceId, (tx) =>
      dispatchRunRepository.recordFleetShard(
        data.dispatchRunId,
        booted.session.handle.shardId ?? null,
        tx,
      ),
    );
    await sendEvent(
      'hosted-run/supervise',
      {
        workspaceId: data.workspaceId,
        dispatchRunId: data.dispatchRunId,
        session: booted.session,
        idempotencyKey: hostedRunDispatchId(data.dispatchRunId),
      },
      { strict: true },
    );
  } catch (err) {
    // A container nobody supervises spends until the reaper finds it. Tear it
    // down now, through the seam's own settle, and fail the run.
    await hostedAgentContainerService.settle(booted.session, {
      done: true,
      reason: 'provision_failed' satisfies TeardownReason,
      startedAt: null,
      exitCode: null,
      failureDetail: 'its supervision could not be enqueued',
    });
    throw err;
  }
  return { kind: 'booted' };
}

/**
 * The WAITING LINE (MOTIR-9381) — a `log` event on the open run carrying the
 * deferral's own words ("a Standard organization runs 1 agent run at once, and 1
 * is already running"), through the channel the run's closing line uses. Written
 * only when the words changed, so a run that waits an hour is not an hour of
 * identical lines.
 */
async function recordWaitingLine(
  run: { id: string; workspaceId: string; createdById: string | null },
  detail: string,
): Promise<void> {
  if (!run.createdById) return;
  const latest = await withWorkspaceServiceContext(run.workspaceId, (tx) =>
    dispatchRunEventRepository.findLatestOfKind(run.id, 'log', tx),
  );
  const previous = (latest?.data as { waiting?: unknown } | null | undefined)?.waiting;
  if (previous === detail) return;
  try {
    await dispatchRunService.appendEvents(
      run.id,
      [{ kind: 'log', data: { waiting: detail }, body: `[motir] waiting for room: ${detail}\n` }],
      { userId: run.createdById, workspaceId: run.workspaceId },
    );
  } catch (err) {
    // The line is how a person sees why; the wait itself does not depend on it.
    console.error('[hostedRunService] could not record the waiting line', {
      dispatchRunId: run.id,
      detail: detailOf(err),
    });
  }
}

/**
 * CONTINUE HOSTED (Story MOTIR-6527 · MOTIR-6792) — Run hosted's start, with the
 * continue claim where the readiness check and the open were.
 *
 * ⚠️ THE ORDER IS THE CONTRACT. Read which card the continue takes over (the
 * card, or the parent of a dead parent run's leg) WITHOUT a lock; run every
 * pre-flight Run hosted runs, in its order, over the resumed run's repositories;
 * and only then take the claim — so a person told "out of credits" has not
 * locked the card against a teammate's terminal `motir continue`. The claim opens
 * the hosted run itself (its hosted opening, MOTIR-6790): one row is the lock and
 * the run, with ONE `run_opened`. A failure after it ends the run through the
 * shared end path, which never writes the card — so it is continuable again.
 */
async function startContinue(
  input: ResolvedStartInput,
  identifier: string,
  projectId: string,
  ctx: ServiceContext,
  options: HostedRunStartOptions,
  now: Date,
): Promise<HostedRunStarted> {
  const preview = await workItemContinueService.previewHostedContinue(
    projectId,
    identifier,
    ctx,
    now,
  );
  if (!preview.ok) {
    // The same press, committed since step 0: the run the preview refused is ours.
    const replay = await runOpenedByPress(input.idempotencyKey, ctx);
    if (replay) return replay;
    throw new HostedContinueRefusedError(
      identifier,
      preview.reason,
      preview.holder,
      preview.startedAt,
      preview.parentKey,
    );
  }
  const target = preview.key;
  const checked = await preflight(input, projectId, preview.legItemIds, ctx);

  let replayed = false;
  const claim = await workItemContinueService.claimContinue(projectId, target, ctx, now, {
    opening: {
      origin: 'hosted',
      agent: 'opencode',
      model: input.model,
      idempotencyKey: input.idempotencyKey,
    },
    onReplay: () => {
      replayed = true;
    },
  });
  // ⚠️ RACE-ONLY BELOW: the preview refused every state the claim refuses, so
  // these three answers reach here only when a terminal continue or another
  // start won in the gap between the preview and the claim's lock. (A press of
  // the SAME key that won that gap is answered below as a replay; one that won it
  // before the preview was answered above — MOTIR-7312.)
  /* v8 ignore next 9 -- race-only: the preview refused this state a moment earlier */
  if (claim.outcome === 'not_continuable') {
    throw new HostedContinueRefusedError(
      target,
      claim.reason ?? 'no_dead_run',
      claim.holder,
      claim.startedAt,
      claim.parentKey,
    );
  }
  // `mine` is the caller's OWN open continue — a terminal one, never this
  // opening (a repeat of the key is answered `claimed`). A hosted start does not
  // adopt a run somebody's terminal holds, even their own.
  /* v8 ignore next 3 -- race-only: a continue opened since the preview holds the lock */
  if (claim.outcome !== 'claimed' || claim.runId === null) {
    throw new HostedContinueRefusedError(target, 'taken', claim.holder, claim.startedAt);
  }
  const runId = claim.runId;
  // The same press, raced past the short-circuit above: its run is booting.
  /* v8 ignore next -- race-only: two presses of one key both passed the short-circuit */
  if (replayed) return { dispatchRunId: runId, created: false };
  /* v8 ignore next -- a `claimed` answer always carries its run's start */
  const startedAt = claim.startedAt ?? now.toISOString();

  try {
    await launch(
      { id: runId, startedAt },
      input,
      { identifier: target, projectId, legIds: preview.legItemIds },
      checked,
      ctx,
      options,
      { MOTIR_RUN_MODE: 'continue' },
    );
    return { dispatchRunId: runId, created: true };
  } catch (err) {
    if (!(err instanceof HostedRunBootFailedError)) {
      await hostedRunService.endHostedRun(
        runId,
        'failed',
        `the continue could not start: ${detailOf(err)}`,
      );
    }
    throw err;
  }
}

/**
 * THE SAME PRESS, READ AGAIN AFTER A REFUSING PREVIEW (MOTIR-7312). Step 0 of
 * `start` answers a repeated key with the run it opened, but a double-click can
 * interleave a third way: the second press passes step 0 before anything is
 * opened, the first press's claim then commits, and only then does the second
 * press's preview run — so it sees the first press's open run as somebody
 * continuing (or repairing) the card and refuses `taken`. The holder it names is
 * the press itself. So before a continue or fix preview's refusal is thrown, the
 * key is read once more: a run this key opened answers the press, `created: false`,
 * exactly as step 0 would have. No key match ⇒ the refusal stands.
 */
async function runOpenedByPress(
  idempotencyKey: string,
  ctx: ServiceContext,
): Promise<HostedRunStarted | null> {
  const opened = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    dispatchRunRepository.findByIdempotencyKey(ctx.workspaceId, idempotencyKey, tx),
  );
  return opened ? { dispatchRunId: opened.id, created: false } : null;
}

/**
 * RUN HOSTED'S READINESS REFUSAL, READ AGAINST THE KEY FIRST (MOTIR-7330). The
 * same interleaving {@link runOpenedByPress} answers for continue and fix: a
 * double-click's second press passes step 0 before the first press opens its run,
 * the first press then opens it and claims the card (or its scope), and the second
 * press's readiness check reads a card its own first press moved. A run this key
 * opened answers the press, `created: false`; no key match ⇒ the card is refused
 * as not ready, exactly as before.
 */
async function notReadyUnlessPressed(
  idempotencyKey: string,
  identifier: string,
  detail: string,
  ctx: ServiceContext,
): Promise<HostedRunStarted> {
  const replay = await runOpenedByPress(idempotencyKey, ctx);
  if (replay) return replay;
  throw new HostedRunCardNotReadyError(identifier, detail);
}

/**
 * The model a start runs on (MOTIR-6994): the person's pick when they sent one
 * (trimmed), else the card's resolution — a leaf's difficulty, a parent's highest
 * among its unfinished leaves. Nothing to resolve (motir-ai offers no model) is
 * `HostedModelsUnavailableError`, the same refusal the picker path answers; the
 * resolved id is then checked by the pre-flight exactly as a sent one is.
 */
async function settleModel(
  sent: string | undefined,
  workItemId: string,
  ctx: ServiceContext,
): Promise<string> {
  const picked = sent?.trim();
  if (picked) return picked;
  const resolved = await projectHostedAgentSettingsService.resolveForWorkItem(workItemId, ctx);
  if (!resolved) throw new HostedModelsUnavailableError('no model is offered');
  return resolved.model;
}

/**
 * FIX ON THE HOSTED AGENT (Story MOTIR-1626 · MOTIR-6928; `hosted-agent-run.md` §8.6,
 * `approval-gates.md` §12.4b) — {@link startContinue}'s order, around the REPAIR claim.
 *
 * ⚠️ THE ORDER IS THE CONTRACT. Preview the repair WITHOUT a lock and refuse, before any
 * spend, a card the claim would refuse (`not_repairable`), one repairable for any reason
 * but a review's (`not_sent_back` — §12.4b covers a card a REVIEW sent back only), and
 * one whose repair is already open, local or hosted (`taken`, naming the holder). Then
 * every pre-flight Run hosted runs, with the pressing person's model, over the
 * repositories of the card's open pull requests. Only then the claim — which opens the
 * hosted `fix` run itself, so one row is both the one-repair lock and the run, with ONE
 * `run_opened` recording what the claim decided for the container to adopt. A failure
 * after it ends the run through the shared end path.
 *
 * No to-do claim, no status write and no provenance stamp, start or end: a repair moves
 * nothing (§8.6). Its push moves the head, which retires the review's version, and a
 * repair that pushes nothing leaves the card To fix.
 */
async function startFix(
  input: ResolvedStartInput,
  identifier: string,
  projectId: string,
  ctx: ServiceContext,
  options: HostedRunStartOptions,
): Promise<HostedRunStarted> {
  const preview = await workItemRepairService.previewHostedRepair(projectId, identifier, ctx);
  if (!preview.ok) {
    // The same press, committed since step 0: the repair the preview refused is ours.
    const replay = await runOpenedByPress(input.idempotencyKey, ctx);
    if (replay) return replay;
    throw fixRefusal(preview.key, preview.refusal);
  }
  const target = preview.key;
  const legIds = [preview.workItemId];
  const checked = await preflight(input, projectId, legIds, ctx, 'write', 'repair');

  let replayed = false;
  const claim = await workItemRepairService.claimRepair(projectId, target, ctx, {
    opening: {
      origin: 'hosted',
      agent: 'opencode',
      model: input.model,
      idempotencyKey: input.idempotencyKey,
    },
    admit: (repairClass) => {
      // RACE-ONLY: the class changed between the preview and the lock.
      /* v8 ignore next 3 */
      if (repairClass !== 'review') {
        throw fixRefusal(target, { kind: 'not_sent_back', repairClass });
      }
    },
    onReplay: () => {
      replayed = true;
    },
  });
  // ⚠️ RACE-ONLY BELOW: the preview refused every state the claim refuses, so these
  // answers reach here only when a terminal `motir fix` or another press won in the gap
  // between the preview and the claim's lock.
  /* v8 ignore next 7 -- race-only: the preview refused this state a moment earlier */
  if (claim.outcome === 'not_repairable') {
    throw fixRefusal(target, {
      kind: 'not_repairable',
      reason: claim.reason ?? 'not_failing',
      runTargetKey: claim.runTargetKey,
    });
  }
  // `mine` is the caller's OWN open repair — a terminal one, never this opening (a
  // repeat of the key is answered `claimed`). A hosted press never adopts a repair
  // somebody's terminal holds, even their own.
  /* v8 ignore next 3 -- race-only: a repair opened since the preview holds the lock */
  if (claim.outcome !== 'claimed' || claim.runId === null) {
    throw fixRefusal(target, { kind: 'taken', holder: claim.holder, startedAt: claim.startedAt });
  }
  const runId = claim.runId;
  /* v8 ignore next -- race-only: two presses of one key both passed the short-circuit */
  if (replayed) return { dispatchRunId: runId, created: false };
  /* v8 ignore next -- a `claimed` answer always carries its run's start */
  const startedAt = claim.startedAt ?? new Date().toISOString();

  try {
    await launch(
      { id: runId, startedAt },
      input,
      { identifier: target, projectId, legIds },
      checked,
      ctx,
      options,
      { MOTIR_RUN_MODE: 'fix' },
      false,
    );
    return { dispatchRunId: runId, created: true };
  } catch (err) {
    if (!(err instanceof HostedRunBootFailedError)) {
      await hostedRunService.endHostedRun(
        runId,
        'failed',
        `the repair could not start: ${detailOf(err)}`,
      );
    }
    throw err;
  }
}

/** A hosted repair's refusal, from the preview's (or the claim's) answer. */
function fixRefusal(
  key: string,
  refusal:
    | { kind: 'not_repairable'; reason: string; runTargetKey: string | null }
    | { kind: 'not_sent_back'; repairClass: string }
    | { kind: 'taken'; holder: { id: string; name: string } | null; startedAt: string | null },
): HostedFixRefusedError {
  if (refusal.kind === 'not_repairable') {
    return new HostedFixRefusedError(key, 'not_repairable', {
      repairRefusal: refusal.reason,
      runTargetKey: refusal.runTargetKey,
    });
  }
  if (refusal.kind === 'not_sent_back') {
    return new HostedFixRefusedError(key, 'not_sent_back', { repairClass: refusal.repairClass });
  }
  return new HostedFixRefusedError(key, 'taken', {
    holder: refusal.holder,
    startedAt: refusal.startedAt,
  });
}

/**
 * START A HOSTED REVIEW (Story MOTIR-1626 · MOTIR-6820; `hosted-agent-run.md` §8.1) —
 * Run hosted's start with the readiness check and the claim taken OUT: the card is in the
 * review band and belongs to whoever built it, so a review claims nothing and moves no
 * status. Every money and access pre-flight stays, in Run hosted's order: the CI-credit
 * gate, the model (the offered list's DEFAULT — nobody chooses), the organisation's
 * credits, every repository READABLE, the fleet. Then ONE `command: review` run is opened
 * over the card as its one leg (the run token's card binding), its `run_opened` names the
 * gate and version, and the container boots with `MOTIR_RUN_MODE=review`.
 *
 * `ctx` is the run's ATTRIBUTED user (assignee → reporter → the workspace stand-in
 * manager, resolved by the caller): the run's `createdById`, the run token's owner and so
 * the verdict's `decidedById`. The run key is billed to the workspace's organisation, as
 * every hosted run's is.
 *
 * Throws every pre-flight refusal `start` throws (with the read-level
 * `HostedRunRepositoryNotReadableError` and the review's `HostedNoModelOfferedError`),
 * before anything is opened. After the open, a failure ends the run `failed` and is
 * rethrown. Idempotent on `idempotencyKey`: a repeat answers the run it already opened.
 */
async function startReview(
  input: StartHostedReviewInput,
  ctx: ServiceContext,
  options: HostedRunStartOptions,
): Promise<HostedRunStarted> {
  const already = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    dispatchRunRepository.findByIdempotencyKey(ctx.workspaceId, input.idempotencyKey, tx),
  );
  if (already) return { dispatchRunId: already.id, created: false };
  // The `hosted_runs` kill-switch (MOTIR-750) refuses a review run too — it is a
  // hosted container like any other.
  await assertWorkspaceFeatureEnabled(ctx.workspaceId, 'hosted_runs');

  // The caller read the card under its gate a moment ago; only a delete in between
  // finds it gone.
  /* v8 ignore start */
  const target = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
    const item = await workItemRepository.findById(input.workItemId, tx);
    const project = item ? await projectRepository.findById(item.projectId, tx) : null;
    return item && project ? { item, project } : null;
  });
  if (!target) throw new HostedRunCardNotReadyError(input.workItemId, 'it no longer exists');
  /* v8 ignore stop */
  const { item, project } = target;

  const checked = await preflight({}, project.id, [item.id], ctx, 'read');

  const opened = await dispatchRunService.open(
    {
      projectKey: project.identifier,
      command: 'review',
      origin: 'hosted',
      reportedBy: 'cli',
      agent: 'opencode',
      model: checked.model,
      idempotencyKey: input.idempotencyKey,
      cards: [{ key: item.identifier, disposition: 'queued' }],
    },
    ctx,
  );
  const run = opened.run;
  /* v8 ignore next -- race-only: two deliveries of one request both passed the read above */
  if (!opened.created) return { dispatchRunId: run.id, created: false };

  try {
    await dispatchRunService.appendEvents(
      run.id,
      [
        {
          kind: 'run_opened',
          data: {
            command: 'review',
            key: item.identifier,
            origin: 'hosted',
            model: checked.model,
            gateId: input.gateId,
            subjectVersion: input.subjectVersion,
          },
        },
      ],
      ctx,
    );
    await launch(
      run,
      { model: checked.model },
      { identifier: item.identifier, projectId: project.id, legIds: [item.id] },
      checked,
      ctx,
      options,
      {
        MOTIR_RUN_MODE: 'review',
        MOTIR_REVIEW_GATE_ID: input.gateId,
        MOTIR_REVIEW_VERSION: input.subjectVersion,
      },
      false,
    );
    return { dispatchRunId: run.id, created: true };
  } catch (err) {
    if (!(err instanceof HostedRunBootFailedError)) {
      await hostedRunService.endHostedRun(
        run.id,
        'failed',
        `the review could not start: ${detailOf(err)}`,
      );
    }
    throw err;
  }
}

/**
 * A REVIEW run that has ended leaves its reason on its gate (`approval-gates.md` §12.6;
 * `hosted-agent-run.md` §8.4) — whatever the end: the CLI's own close without a verdict,
 * a crash, a stall, the backstop, a cancel, a lost supervision. Written only while the
 * gate is still AWAITING (an accepted verdict decided it; a supersede withdrew it) and
 * only over no reason (a refusal its start recorded is the more specific one). Never a
 * throw: the end path must finish.
 */
async function recordReviewEnd(run: {
  id: string;
  workspaceId: string;
  command: string;
  idempotencyKey: string | null;
}): Promise<void> {
  if (run.command !== 'review') return;
  const gateId = gateIdOfReviewRunKey(run.idempotencyKey);
  if (!gateId) return;
  try {
    await withWorkspaceServiceContext(run.workspaceId, (tx) =>
      approvalGateRepository.setReviewUnavailableReason(gateId, REVIEW_NO_VERDICT_REASON, tx, {
        onlyWhenUnset: true,
      }),
    );
  } catch (err) {
    /* v8 ignore next 4 -- a database fault mid end-path; the run's own close stands */
    console.error('[hostedRunService] could not record the review run’s end on its gate', {
      dispatchRunId: run.id,
      detail: detailOf(err),
    });
  }
}

export const hostedRunService = {
  startReview,

  /**
   * Start a hosted run on a READY card — a leaf, or a parent through its
   * children — and return its id once its container is booted and supervised.
   *
   * Throws, before anything is opened: `HostedRunCardNotReadyError`,
   * `HostedModelNotOfferedError` / `HostedModelsUnavailableError`,
   * `HostedRunOutOfCreditsError` / `HostedRunCreditsUnavailableError`,
   * `HostedRunRepositoryNotWritableError`, `RunGitCredentialUnavailableError`,
   * `OrchestratorNotConfiguredError`, `CiCreditsExhaustedError`, and the not-found
   * errors of the card read. After the run opened, a failure ends it as `failed`
   * and is rethrown (`HostedRunBootFailedError` for a container that never came up).
   */
  async start(
    input: StartHostedRunInput,
    ctx: ServiceContext,
    options: HostedRunStartOptions = {},
  ): Promise<HostedRunStarted> {
    const now = options.now ?? ((): Date => new Date());
    const identifier = input.workItemKey.trim().toUpperCase();
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    await projectAccessService.assertCanEdit(project.id, ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);

    // ── 0 · The same press again — answered with the run it already started ──
    // Before readiness, deliberately: the first press claimed the card, so a
    // retried request would otherwise be refused as not ready rather than told
    // which run it started.
    const already = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      dispatchRunRepository.findByIdempotencyKey(ctx.workspaceId, input.idempotencyKey, tx),
    );
    if (already) return { dispatchRunId: already.id, created: false };
    // ── The `hosted_runs` kill-switch (MOTIR-750) — after the idempotent replay,
    // so a retried press still learns the run it started; before anything opens.
    await assertWorkspaceFeatureEnabled(ctx.workspaceId, 'hosted_runs');

    // A CONTINUE of a dead run (MOTIR-6792) — the card is In Progress by design,
    // so it takes the continue claim's path instead of the readiness below.
    if (input.mode === 'continue') {
      const model = await settleModel(input.model, item.id, ctx);
      return startContinue({ ...input, model }, identifier, project.id, ctx, options, now());
    }
    // A REPAIR of a card a review sent back (MOTIR-6928) — the card is In Review or
    // Implemented by design, so it takes the repair claim's path, not the readiness below.
    if (input.mode === 'fix') {
      const model = await settleModel(input.model, item.id, ctx);
      return startFix({ ...input, model }, identifier, project.id, ctx, options);
    }

    // ── 1 · READY — a leaf by the keyed claim's rule, a parent by the scope claim's ──
    const children = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findChildren(item.id, tx),
    );
    const isParent = children.length > 0;
    let legIds: string[];
    if (isParent) {
      const preview = await scopeClaimService.previewWorkItemScope(project.id, identifier, ctx);
      if (!preview.ok)
        return notReadyUnlessPressed(input.idempotencyKey, identifier, preview.detail, ctx);
      const edges = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemLinkRepository.findBlockedByAmong(
          preview.childIds,
          preview.childIds,
          ctx.workspaceId,
          tx,
        ),
      );
      legIds = orderLegs(
        preview.childIds.map((id) => ({ id })),
        edges,
      );
    } else {
      const state = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findClaimStateById(item.id, tx),
      );
      /* v8 ignore next -- the row was resolved above; only a delete in between gets here */
      if (!state) throw new HostedRunCardNotReadyError(identifier, 'it no longer exists');
      if (!isClaimableState(state)) {
        return notReadyUnlessPressed(
          input.idempotencyKey,
          identifier,
          `it is ${state.status}, not in the to-do category`,
          ctx,
        );
      }
      const readiness = await workItemsService.getReadiness(item.id, ctx);
      if (!readiness.ready) {
        return notReadyUnlessPressed(
          input.idempotencyKey,
          identifier,
          'it is waiting on an open blocker',
          ctx,
        );
      }
      legIds = [item.id];
    }
    // ── 1b · The model — the person's pick, else the card's difficulty ───────
    const model = await settleModel(input.model, item.id, ctx);
    const checked = await preflight({ model }, project.id, legIds, ctx);

    // ── 4 · Open the run, one leg per card, idempotent on the key ───────────
    const legKeys = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const rows = await workItemRepository.findByIds(legIds, tx);
      const byId = new Map(rows.map((r) => [r.id, r.identifier]));
      return legIds.map((id) => byId.get(id) ?? '');
    });
    const command = isParent ? 'run_scope' : 'run';
    const opened = await dispatchRunService.open(
      {
        projectKey: project.identifier,
        command,
        origin: 'hosted',
        reportedBy: 'cli',
        agent: 'opencode',
        model,
        idempotencyKey: input.idempotencyKey,
        cards: legKeys.map((key) => ({ key, disposition: 'queued' as const })),
        ...(isParent ? { scopeKey: identifier, scopeLabel: item.title } : {}),
      },
      ctx,
    );
    const run = opened.run;
    if (!opened.created) return { dispatchRunId: run.id, created: false };

    try {
      await dispatchRunService.appendEvents(
        run.id,
        [
          {
            kind: 'run_opened',
            data: { command, key: identifier, origin: 'hosted', model },
          },
        ],
        ctx,
      );

      // ── 5 · Claim and stamp every leg ──────────────────────────────────────
      if (isParent) {
        const claim = await scopeClaimService.claimScope(
          { kind: 'work_item', projectId: project.id, identifier },
          ctx,
        );
        if (!claim.claimed) {
          throw new HostedRunCardNotReadyError(identifier, `its scope claim was ${claim.outcome}`);
        }
      } else {
        const claim = await workItemsService.claimWorkItem(project.id, identifier, ctx);
        if (claim.outcome !== 'claimed' && claim.outcome !== 'mine') {
          throw new HostedRunCardNotReadyError(identifier, `its claim was ${claim.outcome}`);
        }
      }
      await launch(
        run,
        { model },
        { identifier, projectId: project.id, legIds },
        checked,
        ctx,
        options,
      );
      return { dispatchRunId: run.id, created: true };
    } catch (err) {
      if (!(err instanceof HostedRunBootFailedError)) {
        await this.endHostedRun(run.id, 'failed', `the run could not start: ${detailOf(err)}`);
      }
      throw err;
    }
  },

  /**
   * ONE PASS of a HELD run's admission — the `hosted-run/admit` job's body
   * (MOTIR-9381). `waiting` asks the job to defer and ask again; every other
   * answer ends the job. A throw after the run opened ends the run `failed`,
   * exactly as a start that failed after opening does. Never throws.
   */
  async admit(
    data: HostedRunAdmitData,
    options: HostedRunStartOptions = {},
  ): Promise<HostedRunAdmitResult> {
    try {
      return await admitHostedRun(data, options);
    } catch (err) {
      const detail = `the run could not start: ${detailOf(err)}`;
      await this.endHostedRun(data.dispatchRunId, 'failed', detail);
      return { kind: 'failed', detail };
    }
  },

  /**
   * ONE PASS of a booted run's supervision — the durable job's body. It usually
   * defers (`JobRunDefer`) and returns only once the container has settled, after
   * which the run is ended through {@link endHostedRun} in its own memoized step.
   *
   * No wall-clock deadline but the backstop the container was booted with. The
   * STALL read runs before every poll: a run whose latest event is older than the
   * stall window has an agent alive and silent, and is ended.
   */
  async supervise(
    jobRunId: string,
    data: HostedRunSuperviseData,
    options: HostedAgentSupervisionOptions & { steps: MemoizingSteps },
  ): Promise<HostedAgentContainerOutcome> {
    const outcome = await hostedAgentContainerService.advance(
      jobRunId,
      requestFromSession(data.session),
      {
        ...options,
        booted: data.session,
        liveness: (session, now) => this.livenessOf(data.dispatchRunId, session, now),
      },
    );
    const end = endOutcomeFor(outcome);
    await options.steps.run(hostedRunEndStepId(data.dispatchRunId), () =>
      this.endHostedRun(data.dispatchRunId, end.outcome, end.detail),
    );
    return outcome;
  },

  /**
   * What the supervisor reads before each poll (MOTIR-6450): a run a person
   * CANCELLED — closed `cancelled` by {@link cancel} — is torn down now with the
   * cancel's teardown reason; otherwise the stall read decides.
   */
  async livenessOf(
    dispatchRunId: string,
    session: HostedAgentSession,
    now: Date,
  ): Promise<HostedAgentLivenessVerdict> {
    const run = await withWorkspaceServiceContext(session.attribution.workspaceId, (tx) =>
      dispatchRunRepository.findById(dispatchRunId, tx),
    );
    if (run?.status === 'cancelled') {
      return { reason: 'gate_revoked', detail: HOSTED_RUN_CANCEL_DETAIL };
    }
    // A REVIEW whose gate was withdrawn is cancelled (§12.5): its answer can decide
    // nothing and it is still being paid for. The withdrawal's own seam cancels it at
    // once; this read is the catch-all for a supersede that reached no seam.
    const gateId = run?.command === 'review' ? gateIdOfReviewRunKey(run.idempotencyKey) : null;
    if (gateId) {
      const gate = await withWorkspaceServiceContext(session.attribution.workspaceId, (tx) =>
        approvalGateRepository.findById(gateId, tx),
      );
      if (gate?.state === 'superseded') {
        return { reason: 'gate_revoked', detail: HOSTED_REVIEW_SUPERSEDED_DETAIL };
      }
    }
    return this.stallDetail(dispatchRunId, session, now);
  },

  /**
   * CANCEL a running hosted run (MOTIR-6450) — the dispatcher or a project admin.
   * A run in an agent is handed to `agentInstanceRunService.cancel` (MOTIR-7027).
   *
   * It ends the run through {@link endHostedRun} at once: the gateway key, the run
   * credential and every git token are revoked, so the agent can spend and push
   * nothing more, and the run is closed `cancelled`. The CONTAINER is torn down by
   * its supervisor at the next poll (at most `AGENT_MAX_POLL_INTERVAL_MS`), with
   * the cancel's `gate_revoked` reason, then charged and released as every settled
   * container is — the supervisor stays the ONE owner of the machine, so a cancel
   * racing a poll can never tear it down twice or meter it twice.
   *
   * Refuses — each before anything is revoked — a run that does not exist or is in
   * another workspace (404), is not hosted (404), is not the caller's to cancel
   * (403), or has already ended (409). A cancel racing the CLI's own close resolves
   * to whichever close landed first; the other is a no-op.
   */
  async cancel(dispatchRunId: string, ctx: ServiceContext): Promise<{ dispatchRunId: string }> {
    const run = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      dispatchRunRepository.findById(dispatchRunId, tx),
    );
    // A run in an agent is cancelled through the agent's own end path — its owner
    // only, and its session stopped in the agent (`agent-instance-run.md` §6,
    // MOTIR-7027) — never this container stop. One door, so the run panel's Cancel
    // is the same call whichever kind of run it shows.
    if (run?.origin === 'instance' && run.workspaceId === ctx.workspaceId) {
      return agentInstanceRunService.cancel(dispatchRunId, ctx);
    }
    if (!run || run.workspaceId !== ctx.workspaceId || run.origin !== 'hosted') {
      throw new HostedRunNotFoundError(dispatchRunId);
    }
    if (run.createdById !== ctx.userId) {
      try {
        await projectAccessService.assertCanManage(run.projectId, ctx);
      } catch (err) {
        // A member who cannot even browse the project sees no run (no existence
        // leak); one who can but is not an admin is refused.
        if (err instanceof ProjectNotFoundError) throw new HostedRunNotFoundError(dispatchRunId);
        throw new HostedRunCancelForbiddenError(dispatchRunId);
      }
    }
    if (run.status !== 'running') throw new HostedRunAlreadyEndedError(dispatchRunId, run.status);
    await this.endHostedRun(dispatchRunId, 'cancelled', 'cancelled by a person');
    return { dispatchRunId };
  },

  /**
   * The STALL read: the stall detail when the run's latest event — or its boot,
   * before it has written one — is older than the stall window, else `null`.
   */
  async stallDetail(
    dispatchRunId: string,
    session: HostedAgentSession,
    now: Date,
  ): Promise<string | null> {
    const latest = await withWorkspaceServiceContext(session.attribution.workspaceId, (tx) =>
      dispatchRunEventRepository.findLatestCreatedAt(dispatchRunId, tx),
    );
    const bootedAt = new Date(session.bootedAt).getTime();
    const lastSign = Math.max(latest?.getTime() ?? 0, bootedAt);
    return now.getTime() - lastSign >= hostedRunStallWindowMs() ? HOSTED_RUN_STALL_DETAIL : null;
  },

  /**
   * THE END PATH (MOTIR-6450) — the ONE function every way a hosted run ends
   * calls: a start that failed after the run opened, a supervision whose
   * container settled (the CLI's exit, a stall, the backstop), a person's
   * cancel, and a lost supervision chain the sweep found.
   *
   * ⚠️ THE CONTAINER IS SETTLED BY ITS OWNER, BEFORE THIS IS CALLED. The
   * supervisor's settle step and the sweep's settler each tear it down, record
   * its usage, charge it and release its slot, and only then end the run here; a
   * cancel ends the run first and the supervisor tears the machine down at its
   * next poll (see {@link cancel}). One owner per container is what makes a
   * teardown, a usage row and a release happen exactly once.
   *
   * Then, unconditionally: revoke the gateway key, the run credential and every
   * recorded git token. Then close the run ONLY IF it is still open — the CLI in
   * the container closes the run it adopted, exactly as a local run does — with a
   * `log` event naming which end it was (crash, failed, cancelled, stalled,
   * backstop, lost supervision) and any revocation that failed. A run the CLI
   * already closed keeps its status; the ingest refuses events on a closed run, so
   * nothing more is written to it.
   *
   * It links NO pull request and writes NO work-item status, on any end: on
   * success the CLI already did both, and no other end moves a card (the run-dies
   * decision). Idempotent — revocations are, and the close is skipped for a run
   * already closed — and never a throw.
   */
  async endHostedRun(
    dispatchRunId: string,
    outcome: HostedRunEndOutcome,
    detail: string,
  ): Promise<HostedRunEndResult> {
    const key = await hostedRunKeyService.revokeRunKey(dispatchRunId);
    let runCredential = 0;
    try {
      runCredential = (await runCredentialService.revokeRunCredential(dispatchRunId)).revoked;
    } catch (err) {
      console.error('[hostedRunService] could not revoke the run credential', {
        dispatchRunId,
        detail: detailOf(err),
      });
    }
    const git = await revokeRunGitCredentials(dispatchRunId);
    const gitCredentials = {
      revoked: git.filter((g) => g.status !== 'failed').length,
      failed: git.filter((g) => g.status === 'failed').length,
    };

    const run = await withSystemContext((tx) => dispatchRunRepository.findById(dispatchRunId, tx));
    let closed = false;
    if (run && run.status === 'running' && run.createdById) {
      const ctx: ServiceContext = { userId: run.createdById, workspaceId: run.workspaceId };
      const failures = [
        ...(key.ok ? [] : [`the run key could not be revoked (${key.reason})`]),
        ...(gitCredentials.failed > 0
          ? [`${gitCredentials.failed} git token(s) could not be revoked`]
          : []),
      ];
      try {
        const close = CLOSE_FOR[outcome];
        // The closing line rides the close's own transaction (MOTIR-7489): a CLI
        // close that commits first rolls it back, so it never lands on a run the
        // CLI closed.
        await dispatchRunService.close(
          dispatchRunId,
          { stopReason: close.stopReason, status: close.status },
          ctx,
          'wait',
          {
            data: { end: outcome },
            body: `[motir] hosted run ended (${END_LABEL[outcome]}): ${detail}${
              failures.length > 0 ? ` — ${failures.join('; ')}` : ''
            }\n`,
          },
        );
        closed = true;
      } catch (err) {
        // The CLI closed it between the read and the close: its status stands.
        if (!(err instanceof DispatchRunTerminalError)) {
          console.error('[hostedRunService] could not close the hosted run', {
            dispatchRunId,
            detail: detailOf(err),
          });
        }
      }
    }
    // A REVIEW run's end, closed by whoever: a gate still awaiting was not answered.
    if (run) await recordReviewEnd(run);
    return {
      closed,
      runKey: key.ok ? 'revoked' : 'failed',
      runCredential,
      gitCredentials,
    };
  },
};

/** The reason line for a container that ended at boot, on the run and in the error. */
function bootFailureDetail(outcome: HostedAgentContainerOutcome): string {
  /* v8 ignore next -- boot() ends admission, pull and provision failures only; a SETTLED container is poll()'s, never boot()'s */
  if (outcome.outcome === 'settled') return `the container ended at boot (${outcome.reason})`;
  return `${outcome.outcome}: ${outcome.detail}`;
}
