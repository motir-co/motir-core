// Typed errors for the HOSTED RUN domain (Story MOTIR-683).
//
// Kept in their own file, like every other domain's, so a route handler can map
// them without importing the service. Each carries a stable string `code`.
//
// ⚠️ THE TWO MODEL ERRORS ARE DISTINCT ON PURPOSE (MOTIR-6483). They need
// different copy — "choose again" against "try later" — and collapsing them would
// let "motir-ai is down" read as "that model is not allowed", or the reverse.
// The codes are the literals `docs/decisions/hosted-agent-run.md` §7 names, so
// the start path, the route and the design all speak one spelling.

import type { AgentCapacityReason } from './capacityReasons';

/**
 * The chosen model is not on motir-ai's offered list — it was never offered,
 * or it has left the list since the page loaded. The person chooses again.
 */
export class HostedModelNotOfferedError extends Error {
  readonly code = 'hosted_model_not_offered' as const;
  constructor(readonly model: string) {
    super(`The model ${model} is not offered for hosted runs.`);
    this.name = 'HostedModelNotOfferedError';
  }
}

/**
 * motir-ai could not answer which models are offered — unreachable, timed out,
 * a 5xx, an unconfigured client, or an answer that is not a model list. Nothing
 * is started; the person tries again later.
 */
export class HostedModelsUnavailableError extends Error {
  readonly code = 'hosted_models_unavailable' as const;
  constructor(detail: string) {
    super(`The models a hosted run may use could not be read: ${detail}`);
    this.name = 'HostedModelsUnavailableError';
  }
}

/**
 * motir-ai answered, and offers NO model at all (MOTIR-6820; `hosted-agent-run.md` §7's
 * pointer). Only the REVIEW run meets it: it has no dispatcher to choose, so it takes the
 * list's default, else the first model offered — and an empty list is a review that could
 * not run, reason _no model_. Distinct from {@link HostedModelsUnavailableError}: motir-ai
 * being down never reads as "no models exist".
 */
export class HostedNoModelOfferedError extends Error {
  readonly code = 'hosted_no_model_offered' as const;
  constructor() {
    super('No model is offered for hosted runs.');
    this.name = 'HostedNoModelOfferedError';
  }
}

// --- The hosted-run key wiring (MOTIR-689) ---

/** Why a per-run key could not be minted. Every reason means the same thing to
 *  the start path: fail the run BEFORE the container boots. */
export type HostedRunKeyNotMintedReason =
  /** This deployment lacks `MOTIR_GATEWAY_URL` or `MOTIR_RUN_KEY_MINT_SECRET`. */
  | 'not_configured'
  /** The gateway answered and refused (a 4xx, or its own `run_keys_not_configured`). */
  | 'refused'
  /** The gateway could not be reached, timed out, or failed. */
  | 'unavailable'
  /** The run is past its timeout, or the model is empty — nothing was asked. */
  | 'invalid_request';

/**
 * A per-run key was NOT minted. The start path (MOTIR-690) receives it BEFORE
 * booting anything: no container, no spend (`docs/decisions/hosted-agent-run.md`,
 * and MOTIR-689's approach).
 */
export class HostedRunKeyNotMintedError extends Error {
  constructor(
    readonly reason: HostedRunKeyNotMintedReason,
    message: string,
    /** The gateway's own refusal code, when it answered one. */
    readonly gatewayCode: string | null = null,
  ) {
    super(message);
    this.name = 'HostedRunKeyNotMintedError';
  }
}

// --- The run's git credentials (MOTIR-6449) ---
//
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §5 and §8: a hosted run
// writes as Motir's GitHub App, and a run that cannot write is refused before
// anything boots, naming EVERY repository that cannot be written.

/** What one repository needs before a hosted run can write it — the one fix the
 *  person (or the owner of the GitHub account) has to make. */
export type RunGitWriteFix = 'reconnect' | 'accept_permissions';

/** One repository of the run that its App cannot write, with the decision's
 *  reason verbatim and, for `accept_permissions`, where the owner accepts. */
export interface RunGitWriteRefusal {
  /** `owner/name`. */
  repository: string;
  reason: string;
  fix: RunGitWriteFix;
  /** The installation's settings page on GitHub, when it is known. */
  fixUrl: string | null;
}

/**
 * A run covers at least one repository its App cannot write (§8). Carries every
 * refused repository, not the first: a person fixing them one run at a time
 * would be told the next only after the last fix.
 */
export class HostedRunRepositoryNotWritableError extends Error {
  readonly code = 'hosted_repository_not_writable' as const;
  constructor(
    readonly refusals: readonly RunGitWriteRefusal[],
    /** How many repositories the run covers in all, when the caller knows —
     *  the refusal reads "n of this run's total" (MOTIR-6518 §18.3). */
    readonly totalRepositories: number | null = null,
  ) {
    super(refusals.map((r) => r.reason).join('; '));
    this.name = 'HostedRunRepositoryNotWritableError';
  }
}

/**
 * A REVIEW run covers at least one repository its App cannot READ (MOTIR-6820;
 * `hosted-agent-run.md` §8.1, §8.3). A review pushes nothing, so it needs only read
 * access — the refusals are the write check's, asked at the read level, every refused
 * repository named.
 */
export class HostedRunRepositoryNotReadableError extends Error {
  readonly code = 'hosted_repository_not_readable' as const;
  constructor(readonly refusals: readonly RunGitWriteRefusal[]) {
    super(refusals.map((r) => r.reason).join('; '));
    this.name = 'HostedRunRepositoryNotReadableError';
  }
}

/** Why a git credential could not be produced for reasons that are NOT one of
 *  the two refusals a person can act on. */
export type RunGitCredentialUnavailableReason =
  /** The App the repository needs is not configured on this deployment. */
  | 'not_configured'
  /** GitHub could not be reached, or answered something unexpected. */
  | 'github_unavailable'
  /** A repository of the run has nothing on GitHub yet (its row is not realized). */
  | 'repository_unrealized'
  /** The run covers no repository at all. */
  | 'no_repository';

/** The run's git credential could not be minted, for an operational reason. The
 *  start path fails the run; the refresh route answers it as a server fault. */
export class RunGitCredentialUnavailableError extends Error {
  readonly code = 'run_git_credential_unavailable' as const;
  constructor(
    readonly reason: RunGitCredentialUnavailableReason,
    message: string,
  ) {
    super(message);
    this.name = 'RunGitCredentialUnavailableError';
  }
}

// --- Starting a hosted run (MOTIR-690) ---

/**
 * The card cannot be run hosted right now: a LEAF that is not in the to-do
 * category or still has an open blocker, or a PARENT whose scope is not
 * finishable, not one layer deep, or holds a child that is not claimable. `detail`
 * says which, in words the person can act on. Nothing was opened, minted or
 * booted — or, when the claim itself lost a race after the run opened, the run
 * was ended as failed before this was thrown.
 */
export class HostedRunCardNotReadyError extends Error {
  readonly code = 'hosted_run_card_not_ready' as const;
  constructor(
    readonly key: string,
    readonly detail: string,
  ) {
    super(`${key} cannot be run hosted: ${detail}`);
    this.name = 'HostedRunCardNotReadyError';
  }
}

/**
 * motir-ai answered the credit pre-flight `mayRun: false` — the dispatcher's
 * organization has no credits for an agent run (`POST /v1/credits/agent-run-check`,
 * the gateway's own balance rule). Nothing was opened, minted or booted.
 */
export class HostedRunOutOfCreditsError extends Error {
  readonly code = 'hosted_run_out_of_credits' as const;
  constructor(readonly balanceCredits: number | null) {
    super('The organization has no credits left for a hosted run.');
    this.name = 'HostedRunOutOfCreditsError';
  }
}

/**
 * The resolved model has no agent-run capacity right now (MOTIR-9628) — the
 * agent share of one of its limits is used, or the provider is answering it
 * with 429s (`lib/services/agentRunCapacityService.ts`). Refused in the
 * pre-flight, before the credit check: nothing was opened, minted, reserved or
 * booted, and nothing is queued, deferred or retried — the person picks another
 * model or tries again shortly. It carries the bare model id and the reason code
 * only, never a counter, a limit or a share.
 */
export class HostedRunNoCapacityError extends Error {
  readonly code = 'hosted_run_no_capacity' as const;
  constructor(
    readonly model: string,
    readonly reason: AgentCapacityReason,
  ) {
    super(`The model ${model} has no agent-run capacity right now.`);
    this.name = 'HostedRunNoCapacityError';
  }
}

/**
 * The credit pre-flight could not be ASKED — motir-ai unreachable, unconfigured
 * or answering something that is not a verdict. An unanswered question is never
 * an acceptance, so nothing is started; the person tries again.
 */
export class HostedRunCreditsUnavailableError extends Error {
  readonly code = 'hosted_run_credits_unavailable' as const;
  constructor() {
    super('The credit check for a hosted run could not be made. Try again shortly.');
    this.name = 'HostedRunCreditsUnavailableError';
  }
}

/**
 * The run opened but its container could not be booted — the fleet at its
 * ceiling, the image not pullable, a refused provision, or this deployment not
 * wired for hosted runs. The run has already been ended as `failed` (its key and
 * credential revoked) before this is thrown; `dispatchRunId` names it so the
 * caller can show what happened.
 */
export class HostedRunBootFailedError extends Error {
  readonly code = 'hosted_run_boot_failed' as const;
  constructor(
    readonly dispatchRunId: string,
    readonly detail: string,
  ) {
    super(`The hosted run could not be started: ${detail}`);
    this.name = 'HostedRunBootFailedError';
  }
}

/** No hosted run by that id in the caller's workspace (MOTIR-6450) — also what a
 *  LOCAL run answers, since only a hosted run can be cancelled here. → 404. */
export class HostedRunNotFoundError extends Error {
  readonly code = 'hosted_run_not_found' as const;
  constructor(readonly dispatchRunId: string) {
    super(`No hosted run ${dispatchRunId}.`);
    this.name = 'HostedRunNotFoundError';
  }
}

/** Only the person who dispatched a hosted run, or a project admin, may cancel
 *  it (MOTIR-6450). → 403. */
export class HostedRunCancelForbiddenError extends Error {
  readonly code = 'hosted_run_cancel_forbidden' as const;
  constructor(readonly dispatchRunId: string) {
    super('Only the person who started this run, or a project admin, can cancel it.');
    this.name = 'HostedRunCancelForbiddenError';
  }
}

/** The hosted run has already ended — there is nothing to cancel (MOTIR-6450). → 409. */
export class HostedRunAlreadyEndedError extends Error {
  readonly code = 'hosted_run_already_ended' as const;
  constructor(
    readonly dispatchRunId: string,
    readonly status: string,
  ) {
    super(`This run has already ended (${status}).`);
    this.name = 'HostedRunAlreadyEndedError';
  }
}

// --- Continuing a dead run hosted (Story MOTIR-6527 · MOTIR-6792) ---

/** Why a Continue hosted was refused — the continue claim's own answers, spelled
 *  as the hosted door's codes. */
export type HostedContinueRefusal =
  | 'taken'
  | 'run_alive'
  | 'no_branch'
  | 'use_fix'
  | 'not_in_progress'
  | 'no_dead_run'
  | 'continue_the_parent'
  | 'gate_awaiting'
  | 'gate_sent_back';

const HOSTED_CONTINUE_CODE = {
  taken: 'hosted_continue_taken',
  run_alive: 'hosted_continue_run_alive',
  no_branch: 'hosted_continue_nothing_pushed',
  use_fix: 'hosted_continue_use_fix',
  not_in_progress: 'hosted_continue_not_in_progress',
  no_dead_run: 'hosted_continue_no_dead_run',
  continue_the_parent: 'hosted_continue_the_parent',
  gate_awaiting: 'hosted_continue_gate_awaiting',
  gate_sent_back: 'hosted_continue_gate_sent_back',
} as const satisfies Record<HostedContinueRefusal, string>;

const HOSTED_CONTINUE_WHY: Record<HostedContinueRefusal, string> = {
  taken: 'somebody is already continuing it',
  run_alive: 'its run is still running',
  no_branch: 'its run pushed nothing to continue from',
  use_fix: 'its pull request is open — a red one is fixed, not continued',
  not_in_progress: 'it is not In Progress',
  no_dead_run: 'no run of it died',
  continue_the_parent: 'it is a leg of a parent run; continue the parent',
  gate_awaiting: 'its run stopped at a gate that is still waiting for approval',
  gate_sent_back: 'its run stopped at a gate that was sent back, not approved',
};

/**
 * A Continue hosted the continue claim would refuse — or did, under its lock.
 * Nothing was opened, minted or booted: every one of these answers before the
 * lock is taken, or is the lock's own refusal.
 */
export class HostedContinueRefusedError extends Error {
  readonly code: (typeof HOSTED_CONTINUE_CODE)[HostedContinueRefusal];
  constructor(
    readonly key: string,
    readonly reason: HostedContinueRefusal,
    /** Who holds it — `taken` and `run_alive`. */
    readonly holder: { id: string; name: string } | null = null,
    readonly startedAt: string | null = null,
    /** The parent to continue instead — `continue_the_parent`. */
    readonly parentKey: string | null = null,
  ) {
    super(`${key} cannot be continued hosted: ${HOSTED_CONTINUE_WHY[reason]}`);
    this.name = 'HostedContinueRefusedError';
    this.code = HOSTED_CONTINUE_CODE[reason];
  }
}

// --- Repairing a card a review sent back, hosted (Story MOTIR-1626 · MOTIR-6928) ---

/**
 * Why a *Fix on the hosted agent* was refused (`hosted-agent-run.md` §8.6,
 * `approval-gates.md` §12.4b).
 *
 * - `not_sent_back` — the card is repairable, but NOT because a review sent it back: red
 *   CI, a merge-queue failure or an acceptance Re-run. §12.4b widens the hosted repair to
 *   a review's `changes_requested` only (§12.9 leaves the rest undecided).
 * - `not_repairable` — the repair claim itself refuses the card; `repairRefusal` carries
 *   its own reason (`not_implemented`, `not_failing`, `repair_on_run_target`, …).
 * - `taken` — a `fix` run is already open on the card, local or hosted: the one-repair
 *   lock. `holder` and `startedAt` name it.
 */
export type HostedFixRefusal = 'not_sent_back' | 'not_repairable' | 'taken';

const HOSTED_FIX_CODE = {
  not_sent_back: 'hosted_fix_not_sent_back',
  not_repairable: 'hosted_fix_not_repairable',
  taken: 'hosted_fix_taken',
} as const satisfies Record<HostedFixRefusal, string>;

const HOSTED_FIX_WHY: Record<HostedFixRefusal, string> = {
  not_sent_back: 'only a card a review sent back can be repaired on the hosted agent',
  not_repairable: 'there is nothing for a repair to do on it',
  taken: 'somebody is already repairing it',
};

/**
 * A *Fix on the hosted agent* the repair claim would refuse — or did, under its lock.
 * Nothing was opened, minted or booted: each answers before the lock is taken, or is
 * the lock's own refusal.
 */
export class HostedFixRefusedError extends Error {
  readonly code: (typeof HOSTED_FIX_CODE)[HostedFixRefusal];
  /** The claim's own refusal — `not_repairable` only. */
  readonly repairRefusal: string | null;
  /** The class the card IS repairable as — `not_sent_back` only. */
  readonly repairClass: string | null;
  /** Who holds the open repair — `taken` only. */
  readonly holder: { id: string; name: string } | null;
  readonly startedAt: string | null;
  /** Where the repair runs instead — a `not_repairable` of `repair_on_run_target`. */
  readonly runTargetKey: string | null;
  constructor(
    readonly key: string,
    readonly reason: HostedFixRefusal,
    detail: {
      repairRefusal?: string | null;
      repairClass?: string | null;
      holder?: { id: string; name: string } | null;
      startedAt?: string | null;
      runTargetKey?: string | null;
    } = {},
  ) {
    super(
      `${key} cannot be repaired on the hosted agent: ${HOSTED_FIX_WHY[reason]}${
        detail.repairRefusal ? ` (${detail.repairRefusal})` : ''
      }`,
    );
    this.name = 'HostedFixRefusedError';
    this.code = HOSTED_FIX_CODE[reason];
    this.repairRefusal = detail.repairRefusal ?? null;
    this.repairClass = detail.repairClass ?? null;
    this.holder = detail.holder ?? null;
    this.startedAt = detail.startedAt ?? null;
    this.runTargetKey = detail.runTargetKey ?? null;
  }
}
