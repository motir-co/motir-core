// Typed errors for the DISPATCH RUN domain (Story MOTIR-1789 · MOTIR-1792).
//
// Kept in their own file, like every other domain's, so route handlers and the
// v1 error map import them without pulling in the Prisma client. Each carries a
// stable string `code`; `lib/api/v1/errors.ts`'s `DOMAIN_ERROR_STATUS` owns the
// translation to a status, and `tests/api/v1/dispatch-runs-route.test.ts` drives
// the REAL error through the wrapper for each — an unproven row in that map is
// indistinguishable from a missing one, and a missing one is a silent 500.
//
// Status map (the v1 layer owns the translation):
//   DispatchRunNotFoundError        → 404  (also every cross-workspace read)
//   DispatchRunTerminalError        → 409
//   DuplicateDispatchRunError       → 409
//   DispatchRunAgentBusyError       → 409 (server-opened `instance` runs only —
//                                     mapped by `mapAgentInstanceError`)
//   UnknownDispatchRunCardError     → 422
//   DispatchRunEventBodyTooLargeError → 413
//   DispatchRunEventLimitError      → 422
//   DispatchRunNoTargetError        → 422
//   RunFoundReportReasonInvalidError → 422 (MCP only — `report_unbuildable_target`
//                                     has no `/api/v1` door, so no status row)

/**
 * 404 — no such run FOR THIS CALLER.
 *
 * ⚠️ A run in another workspace raises THIS, never a 403. RLS makes the read
 * return nothing, so the service cannot tell "does not exist" from "not yours"
 * even if it wanted to — which is the ADR §4 existence-oracle contract falling
 * out of the tenancy gate rather than being re-implemented on top of it.
 */
export class DispatchRunNotFoundError extends Error {
  readonly code = 'DISPATCH_RUN_NOT_FOUND';
  constructor(id: string) {
    super(`No dispatch run ${id}.`);
    this.name = 'DispatchRunNotFoundError';
  }
}

/**
 * 409 — the run is already closed, and this call would re-open or re-close it.
 *
 * Raised by BOTH the append and the close, from the same locked read, because
 * they are the same fact: a terminal run's history is finished. A 409 rather
 * than a 422: the request is well-formed and would have been accepted a moment
 * earlier, which is exactly what a conflict status means.
 */
export class DispatchRunTerminalError extends Error {
  readonly code = 'DISPATCH_RUN_TERMINAL';
  constructor(
    id: string,
    readonly status: string,
  ) {
    super(`Dispatch run ${id} is already ${status}; its history is closed.`);
    this.name = 'DispatchRunTerminalError';
  }
}

/**
 * A SWEEP backed off a run because another transaction holds one of the cards it
 * covers (MOTIR-6881) — typically a continue claim that is about to close the same
 * run itself. Server-internal: only the run sweeps ask for this behaviour, and they
 * count it rather than surface it. The next sweep reaps the run if nobody did.
 */
export class DispatchRunCardsBusyError extends Error {
  readonly code = 'DISPATCH_RUN_CARDS_BUSY';
  constructor(id: string) {
    super(`Dispatch run ${id} covers a card another writer holds; skipped this pass.`);
    this.name = 'DispatchRunCardsBusyError';
  }
}

/**
 * 409 — two opens raced on one `idempotencyKey` and this one lost.
 *
 * ⚠️ IT EXISTS SO A `P2002` NEVER ESCAPES. The happy path for a REPEATED open is
 * not this error at all — it is the existing run, returned — and the read that
 * finds it runs first. This is the narrow window between that read and the
 * insert, where the unique index is the arbiter. The caller's remedy is to read
 * the run it already has, so the message says so.
 */
export class DuplicateDispatchRunError extends Error {
  readonly code = 'DUPLICATE_DISPATCH_RUN';
  constructor(idempotencyKey: string) {
    super(
      `A dispatch run with idempotency key '${idempotencyKey}' was opened concurrently. ` +
        'Read it rather than opening a second.',
    );
    this.name = 'DuplicateDispatchRunError';
  }
}

/**
 * 409 — the agent already has a RUNNING run (MOTIR-7023,
 * `docs/decisions/agent-instance-run.md` §5): at most one per agent, enforced by
 * the partial unique index `dispatch_run_agent_instance_running_key`.
 *
 * Raised by the open's own read when the running run is already visible, and by
 * the translation of the index's unique violation when two opens raced — so a
 * raw `P2002` never escapes. `runId` names the run holding the agent; it is null
 * only inside the losing transaction, where the winner cannot be read any more
 * (the violation aborted it), and `dispatchRunService.open` re-reads it before
 * the error leaves the service.
 */
export class DispatchRunAgentBusyError extends Error {
  readonly code = 'agent_instance_run_active' as const;
  constructor(
    readonly agentInstanceId: string,
    readonly runId: string | null,
    /** The card the running run works on (MOTIR-7026: §4's refusal names it), when known. */
    readonly workItemKey: string | null = null,
  ) {
    super(
      runId && workItemKey
        ? `This agent is already running ${workItemKey} (run ${runId}). Wait for it to finish or cancel it first.`
        : runId
          ? `This agent is already running run ${runId}. Wait for it to finish or cancel it first.`
          : 'This agent is already running a run. Wait for it to finish or cancel it first.',
    );
    this.name = 'DispatchRunAgentBusyError';
  }
}

/**
 * 422 — an `instance` open that names no agent, or an agent on a run that is not
 * `instance` (MOTIR-7023). Server-internal: only the server opens a run in an
 * agent, so this is a caller bug, never a person's refusal.
 */
export class DispatchRunAgentInstanceMismatchError extends Error {
  readonly code = 'DISPATCH_RUN_AGENT_INSTANCE_MISMATCH' as const;
  constructor(origin: string) {
    super(
      origin === 'instance'
        ? 'A run in an agent must name the agent it runs in.'
        : `A ${origin} run cannot name an agent.`,
    );
    this.name = 'DispatchRunAgentInstanceMismatchError';
  }
}

/**
 * 422 — an event names a work item that is not in this run's SET.
 *
 * A run's set is settled at open, deliberately, so an event for a card the run
 * does not own is a client bug rather than a card to add: silently creating a
 * leg here would let the set grow behind the plan the run published, and the
 * plan is the thing the record exists to hold.
 *
 * The one exception is `motir auto`, which discovers its set one card at a time
 * — it APPENDS legs through the open operation's own `cards` list on each
 * iteration rather than through an event.
 */
export class UnknownDispatchRunCardError extends Error {
  readonly code = 'UNKNOWN_DISPATCH_RUN_CARD';
  constructor(key: string) {
    super(`This run does not own ${key}; an event cannot add a card to a run's set.`);
    this.name = 'UnknownDispatchRunCardError';
  }
}

/**
 * 422 — an event that is not `agent_exited` carries a `model` (MOTIR-7502).
 *
 * The leg's model has ONE producer, the agent's exit, because that is the only
 * moment the self-report exists (`dispatch-run-record.md`, the leg-model
 * amendment). A `model` on any other kind is refused by name rather than
 * silently dropped: dropping it would let a reporter believe it recorded a fact
 * the record does not hold. Refused before anything is written, so no event in
 * the batch lands.
 */
export class DispatchRunEventModelNotAllowedError extends Error {
  readonly code = 'DISPATCH_RUN_EVENT_MODEL_NOT_ALLOWED';
  readonly field = 'model';
  constructor(readonly kind: string) {
    super(`\`model\` is accepted only on an \`agent_exited\` event, not on \`${kind}\`.`);
    this.name = 'DispatchRunEventModelNotAllowedError';
  }
}

/**
 * 413 — one event's opt-in log body is over the cap.
 *
 * ⚠️ REFUSED, NOT TRUNCATED (ADR Q4). A silently shortened log is worse than an
 * absent one: it reads as the whole tail, and the line that mattered is the one
 * that was cut. The reporter's remedy is to split the body across events, which
 * is what the stream is for.
 */
export class DispatchRunEventBodyTooLargeError extends Error {
  readonly code = 'DISPATCH_RUN_BODY_TOO_LARGE';
  constructor(
    readonly limitBytes: number,
    readonly actualBytes: number,
  ) {
    super(
      `An event body of ${actualBytes} bytes exceeds the ${limitBytes}-byte limit. ` +
        'Split it across events rather than truncating it.',
    );
    this.name = 'DispatchRunEventBodyTooLargeError';
  }
}

/**
 * 422 — the run has reached its event ceiling.
 *
 * The ceiling is per RUN and is the bound that makes an opt-in log body safe to
 * accept at all: without it a chatty agent's stream is unbounded tenant storage.
 * The run stays OPEN and closable — refusing the close as well would leave a run
 * permanently `running`, which is the state the reap exists to eliminate.
 */
export class DispatchRunEventLimitError extends Error {
  readonly code = 'DISPATCH_RUN_EVENT_LIMIT';
  constructor(
    id: string,
    readonly limit: number,
  ) {
    super(
      `Dispatch run ${id} has reached its ${limit}-event limit; no further events are recorded. ` +
        'The run can still be closed.',
    );
    this.name = 'DispatchRunEventLimitError';
  }
}

/**
 * 422 — a close-out prompt was asked for a run with NO RUN TARGET (Story
 * MOTIR-4906 · MOTIR-5357): an unscoped batch, whose every card was its own
 * target and published in its own prompt. Refused rather than answered with a
 * plausible default target, which would write one run's How to test onto an item
 * the run was never launched against.
 */
export class DispatchRunNoTargetError extends Error {
  readonly code = 'NO_RUN_TARGET';
  constructor(id: string) {
    super(
      `Dispatch run ${id} was not launched against a work item, so it has no run target to ` +
        'write How to test onto — each of its cards is its own target.',
    );
    this.name = 'DispatchRunNoTargetError';
  }
}

/** The bounds of a run-found report's `reason`, after trimming. */
export const RUN_FOUND_REPORT_REASON_MAX = 4000;

/**
 * 422 — a run-found report's `reason` is empty or longer than
 * {@link RUN_FOUND_REPORT_REASON_MAX} characters once trimmed (Story MOTIR-5544 ·
 * MOTIR-6285, `runFoundReportService.reportUnbuildableTarget`).
 *
 * Refused, not truncated: the reason is the runner's verbatim account of why the
 * card could not be built, and a cut account reads as a whole one. Checked
 * BEFORE anything is resolved, so the refusal is the same for every target and
 * says nothing about the card, its run or its plan.
 */
export class RunFoundReportReasonInvalidError extends Error {
  readonly code = 'RUN_FOUND_REPORT_REASON_INVALID';
  constructor(readonly length: number) {
    super(
      `A run-found report's reason must be 1-${RUN_FOUND_REPORT_REASON_MAX} characters once ` +
        `trimmed; this one is ${length}. Send the same text as your comment on the card.`,
    );
    this.name = 'RunFoundReportReasonInvalidError';
  }
}

/** The bounds of a run's discrepancy record (MOTIR-8655, decision page MOTIR-8654 §2). */
export const RUN_DISCREPANCY_POINTS_MAX = 20;
export const RUN_DISCREPANCY_FIELD_MAX = 2000;

/**
 * 422 — a discrepancy record is malformed: no points and no decisions, more than
 * {@link RUN_DISCREPANCY_POINTS_MAX} of either, or a `planAsked` / `built` / `why` (a decision's
 * `planSaid` / `chose` / `why`, or an `alternatives` it sent) that is empty or longer than
 * {@link RUN_DISCREPANCY_FIELD_MAX} characters once trimmed (Story MOTIR-8651 · MOTIR-8655,
 * `runDiscrepancyService.recordDiscrepancy`; the decisions arm is MOTIR-10000).
 *
 * Refused, not truncated, and checked BEFORE anything is resolved or written: a cut point
 * reads as a whole one, and the refusal says nothing about the card or its run.
 */
export class RunDiscrepancyInvalidError extends Error {
  readonly code = 'RUN_DISCREPANCY_INVALID';
  constructor(
    readonly reason:
      | 'points_empty'
      | 'points_too_many'
      | 'decisions_too_many'
      | 'field_empty'
      | 'field_too_long',
    readonly where?:
      | { point: number; field: 'planAsked' | 'built' | 'why' }
      | { decision: number; field: 'planSaid' | 'chose' | 'why' | 'alternatives' },
  ) {
    let at = '';
    if (where && 'point' in where) at = ` (point ${where.point}, \`${where.field}\`)`;
    if (where && 'decision' in where) at = ` (decision ${where.decision}, \`${where.field}\`)`;
    super(
      reason === 'points_empty'
        ? 'A discrepancy record needs at least one point (planAsked · built · why) or one ' +
            'decision (planSaid · chose · why); nothing was written.'
        : reason === 'points_too_many'
          ? `A discrepancy record takes at most ${RUN_DISCREPANCY_POINTS_MAX} points; list the ` +
            'most important ones and call once. Nothing was written.'
          : reason === 'decisions_too_many'
            ? `A discrepancy record takes at most ${RUN_DISCREPANCY_POINTS_MAX} decisions; list ` +
              'the most important ones and call once. Nothing was written.'
            : reason === 'field_empty'
              ? `A discrepancy point's fields must each be non-empty${at}; nothing was written.`
              : `A discrepancy point's fields are at most ${RUN_DISCREPANCY_FIELD_MAX} characters` +
                `${at}; shorten it. Nothing was written.`,
    );
    this.name = 'RunDiscrepancyInvalidError';
  }
}

/**
 * 409 — the card's open leg already carries a discrepancy record. ONE record per leg
 * (decision page MOTIR-8654 §3): the first call wrote the comment and the finding, and this
 * one writes nothing — no second comment.
 */
export class DiscrepancyAlreadyRecordedError extends Error {
  readonly code = 'DISCREPANCY_ALREADY_RECORDED';
  constructor(readonly workItemKey: string) {
    super(
      `${workItemKey} already has a discrepancy record on this run. Record ONE per card, with ` +
        'every point in it; nothing was written.',
    );
    this.name = 'DiscrepancyAlreadyRecordedError';
  }
}

/**
 * 403 — a hosted run's own credential (MOTIR-688) reaching a DIFFERENT run's
 * ingest, or opening a run at all. A run token is bound to exactly one
 * `DispatchRun` (`ApiToken.dispatchRunId`) and may report to that run alone;
 * the server opens hosted runs itself, so it never opens one.
 *
 * ⚠️ CHECKED BEFORE THE RUN IS READ, so the answer is the same whether the run
 * it named exists, is closed, or lives in another workspace — the refusal says
 * nothing about any run but the token's own.
 */
export class DispatchRunTokenOutOfScopeError extends Error {
  readonly code = 'DISPATCH_RUN_TOKEN_OUT_OF_SCOPE';
  constructor() {
    super('This credential is bound to a different dispatch run.');
    this.name = 'DispatchRunTokenOutOfScopeError';
  }
}

/**
 * A run credential was asked for a run that is no longer `running` (MOTIR-688).
 * A credential minted for a closed run would be a live key to nothing — or, worse,
 * a live key that outlived the run's own end path, which is the only thing that
 * revokes it. Raised by `runCredentialService.mintRunCredential`, a server-side
 * call with no route of its own.
 */
export class RunCredentialRunNotLiveError extends Error {
  readonly code = 'RUN_CREDENTIAL_RUN_NOT_LIVE';
  constructor(
    readonly dispatchRunId: string,
    readonly status: string,
  ) {
    super(
      `Dispatch run ${dispatchRunId} is ${status}; a run credential is minted only for a running run.`,
    );
    this.name = 'RunCredentialRunNotLiveError';
  }
}

/**
 * A run credential was asked to live past its run's timeout (MOTIR-688,
 * `docs/decisions/hosted-agent-run.md` §5): nothing a run holds may outlive it by
 * more than the settle margin, and the expiry is the backstop when the end
 * path's revoke fails — so an expiry past that bound is refused, never clamped.
 */
export class RunCredentialExpiryTooLateError extends Error {
  readonly code = 'RUN_CREDENTIAL_EXPIRY_TOO_LATE';
  constructor(
    readonly requested: Date,
    readonly latest: Date,
  ) {
    super(
      `A run credential may expire no later than ${latest.toISOString()} (the run's timeout plus ` +
        `the settle margin); ${requested.toISOString()} was requested.`,
    );
    this.name = 'RunCredentialExpiryTooLateError';
  }
}

/**
 * 422 — a dispatch prompt was asked to CONTINUE a run it cannot continue
 * (MOTIR-6531): the run is still open, it succeeded, it holds no leg for this work
 * item, or it is not this caller's workspace's (RLS answers nothing, and this is
 * the same answer — never a 404 that would confirm another tenant's run exists).
 *
 * 422 rather than 400: v1's statuses are a closed set with no 400, and every
 * "refused before anything was written, here is what to fix" on this API is a 422
 * (`lib/api/v1/errors.ts`).
 */
export class ContinueFromInvalidError extends Error {
  readonly code = 'CONTINUE_FROM_INVALID';
  constructor(
    runId: string,
    readonly why: 'unknown' | 'still_running' | 'succeeded' | 'gate_awaiting' | 'gate_sent_back',
  ) {
    super(
      why === 'still_running'
        ? `Run ${runId} is still open; only a run that has ended can be continued.`
        : why === 'succeeded'
          ? `Run ${runId} succeeded; there is nothing to continue.`
          : why === 'gate_awaiting'
            ? `Run ${runId} stopped at a gate that is still waiting for approval; it resumes once a gate is approved.`
            : why === 'gate_sent_back'
              ? `Run ${runId} stopped at a gate that was sent back, not approved; there is nothing released to resume.`
              : `Run ${runId} is not a run of this work item.`,
    );
    this.name = 'ContinueFromInvalidError';
  }
}

/**
 * The CONTINUE RUN an MCP caller named is not one it may keep alive or close
 * (Story MOTIR-7261 · MOTIR-7262): `touch_work_item_continue` and
 * `close_work_item_continue` act only on an open-or-closed `continue` run of THAT
 * card, opened by the CALLER. {@link RepairRunRefusedError}, one lifecycle over —
 * MCP only, so it has no row in `DOMAIN_ERROR_STATUS` either.
 *
 * - `not_found` — no such run, a run in another workspace, or a run that is not
 *   a `continue` run of this card. Nothing to act on: claim the continue first.
 * - `not_yours` — the card's continue run, opened by somebody else. The claim is
 *   what names them; this refusal writes nothing and keeps nothing alive.
 *
 * Naming the second is no existence leak: a caller who can reach these tools
 * holds `work_item:edit` on the project, and `claim_work_item_continue` already
 * answers `taken` with the holder and the run id.
 */
export class ContinueRunRefusedError extends Error {
  readonly code: 'CONTINUE_RUN_NOT_FOUND' | 'CONTINUE_RUN_NOT_YOURS';
  constructor(
    runId: string,
    workItemKey: string,
    readonly why: 'not_found' | 'not_yours',
  ) {
    super(
      why === 'not_yours'
        ? `Run ${runId} is the continue of ${workItemKey}, but somebody else opened it. Only the ` +
            'person who claimed a continue may keep it alive or close it; nothing was written.'
        : `Run ${runId} is not a continue run of ${workItemKey}. Claim the continue with ` +
            '`claim_work_item_continue` and use the `runId` it answers; nothing was written.',
    );
    this.code = why === 'not_yours' ? 'CONTINUE_RUN_NOT_YOURS' : 'CONTINUE_RUN_NOT_FOUND';
    this.name = 'ContinueRunRefusedError';
  }
}

/**
 * The REPAIR RUN an MCP caller named is not one it may keep alive or close
 * (Story MOTIR-6804 · MOTIR-6807): `touch_work_item_repair` and
 * `close_work_item_repair` act only on an open-or-closed `fix` run of THAT card,
 * opened by the CALLER. MCP only — the tools are the one door that addresses a
 * run by card as well as by id — so, like `RunFoundReportReasonInvalidError`,
 * it has no row in `DOMAIN_ERROR_STATUS`.
 *
 * Two reasons, told apart because the caller's next move differs:
 *
 * - `not_found` — no such run, a run in another workspace, or a run that is not
 *   a `fix` run holding this card. Nothing to act on: claim the repair first.
 * - `not_yours` — the card's repair run, opened by somebody else. The claim is
 *   what names them; this refusal writes nothing and keeps nothing alive.
 *
 * Naming the second is no existence leak: a caller who can reach these tools
 * holds `work_item:edit` on the project, and `claim_work_item_repair` already
 * answers `taken` with the holder and the run id.
 */
export class RepairRunRefusedError extends Error {
  readonly code: 'REPAIR_RUN_NOT_FOUND' | 'REPAIR_RUN_NOT_YOURS';
  constructor(
    runId: string,
    workItemKey: string,
    readonly why: 'not_found' | 'not_yours',
  ) {
    super(
      why === 'not_yours'
        ? `Run ${runId} is the repair of ${workItemKey}, but somebody else opened it. Only the ` +
            'person who claimed a repair may keep it alive or close it; nothing was written.'
        : `Run ${runId} is not a repair run of ${workItemKey}. Claim the repair with ` +
            '`claim_work_item_repair` and use the `runId` it answers; nothing was written.',
    );
    this.code = why === 'not_yours' ? 'REPAIR_RUN_NOT_YOURS' : 'REPAIR_RUN_NOT_FOUND';
    this.name = 'RepairRunRefusedError';
  }
}

// ── AGENT-REPORTED RUNS (Story MOTIR-7446 · MOTIR-7450) ────────────────────
// `docs/decisions/agent-reported-runs.md`. MCP only — `start_work_item_run`,
// `report_action` and `close_work_item_run` are the one door (MOTIR-7451) — so,
// like `RepairRunRefusedError`, none of these has a row in `DOMAIN_ERROR_STATUS`.
// Every one is raised BEFORE anything is written.

/**
 * The caller does not hold the claim a run is opened over (§2): the card, or for a
 * container one of its children, is not In Progress and assigned to the caller.
 * `offenderKey` names the card that failed — the container itself, or the child.
 */
export class AgentRunNotClaimedError extends Error {
  readonly code = 'AGENT_RUN_NOT_CLAIMED';
  constructor(
    readonly workItemKey: string,
    readonly offenderKey: string,
  ) {
    super(
      offenderKey === workItemKey
        ? `You do not hold the claim on ${workItemKey}. Claim it with \`claim_work_item\` ` +
            'first; a run is opened only over a card that is In Progress and assigned to you. ' +
            'Nothing was written.'
        : `You do not hold the claim on ${offenderKey}, a child of ${workItemKey}. A parent's ` +
            'run covers every child that is not done, so each must be In Progress and assigned ' +
            'to you. Nothing was written.',
    );
    this.name = 'AgentRunNotClaimedError';
  }
}

/** A run somebody else opened (§4): only its opener may close it. */
export class AgentRunNotYoursError extends Error {
  readonly code = 'AGENT_RUN_NOT_YOURS';
  constructor(
    readonly runId: string,
    readonly workItemKey: string,
  ) {
    super(
      `Run ${runId} on ${workItemKey} was opened by somebody else. Only the person who opened ` +
        'a run may close it; nothing was written.',
    );
    this.name = 'AgentRunNotYoursError';
  }
}

/**
 * No open run of the caller's holds the card `report_action` named (§3). The run is
 * found from the card and the caller, so this is also what an agent outside any run
 * gets, and the message tells it what to call.
 */
export class AgentRunNoOpenRunError extends Error {
  readonly code = 'AGENT_RUN_NO_OPEN_RUN';
  constructor(readonly workItemKey: string) {
    super(
      `You have no open run on ${workItemKey}. Call \`start_work_item_run\` with this key ` +
        'once you hold its claim, then report your steps; nothing was written.',
    );
    this.name = 'AgentRunNoOpenRunError';
  }
}

/**
 * An event kind an agent may not send (§3). Two reasons, named apart:
 *
 * - `kind` — only `checkout_ready`, `delivery_linked`, `leg_verdict` and
 *   `card_settled` may be reported; every other kind is the server's or the runner's.
 * - `cli_run` — the run is a CLI or hosted one, whose runner writes those four
 *   itself, so the agent reports `action` only there.
 */
export class AgentRunEventKindNotAllowedError extends Error {
  readonly code = 'AGENT_RUN_EVENT_KIND_NOT_ALLOWED';
  constructor(
    readonly kind: string,
    readonly why: 'kind' | 'cli_run',
  ) {
    super(
      why === 'kind'
        ? `An agent may not report a \`${kind}\` event. It may send only checkout_ready, ` +
            'delivery_linked, leg_verdict and card_settled; nothing was written.'
        : `This run is reported by its runner, which writes \`${kind}\` itself. Report your ` +
            'step with `action` only; nothing was written.',
    );
    this.name = 'AgentRunEventKindNotAllowedError';
  }
}

/**
 * A `report_action` or `close_work_item_run` that is malformed: an `action` that is
 * empty or longer than {@link AGENT_ACTION_MAX_CHARS}, an `action` or `events`
 * without the card's `key`, or a close with `abandoned`, which only the reap writes.
 */
export const AGENT_ACTION_MAX_CHARS = 500;

export class AgentRunReportInvalidError extends Error {
  readonly code = 'AGENT_RUN_REPORT_INVALID';
  constructor(
    readonly reason: 'action_empty' | 'action_too_long' | 'key_required' | 'abandoned',
    detail?: number,
  ) {
    super(
      reason === 'action_empty'
        ? '`action` is empty. Say the step you are about to take in one line; nothing was written.'
        : reason === 'action_too_long'
          ? `\`action\` is ${detail ?? 'over'} characters; the limit is ${AGENT_ACTION_MAX_CHARS}. ` +
            'Say the step in one line, never a transcript, diff or file contents; nothing was written.'
          : reason === 'key_required'
            ? '`key` is required with `action` or `events`: the run is found from the card. ' +
              'Call with no arguments for a heartbeat only; nothing was written.'
            : '`abandoned` is written only by the reap. Close with the outcome that happened; ' +
              'nothing was written.',
    );
    this.name = 'AgentRunReportInvalidError';
  }
}

/**
 * 422 — a run's STOP report is malformed (MOTIR-8722, `runStopReportService`): the finding
 * is empty or over `RUN_STOP_COMMENT_MAX` characters once trimmed, or a brief field is over
 * `RUN_STOP_FIELD_MAX`. Refused, not truncated, and checked before anything is resolved or
 * written. The body schema refuses the same input first as `INVALID_BODY`; this is the
 * service's own guard.
 */
export class RunStopReportInvalidError extends Error {
  readonly code = 'RUN_STOP_REPORT_INVALID';
  constructor(readonly field: string) {
    super(`A run's stop report has an empty or over-long \`${field}\`; nothing was written.`);
    this.name = 'RunStopReportInvalidError';
  }
}
