// The type surface for background-job events (Story 1.6 · Subtask 1.6.2).
//
// `JobEventDataMap` is the single source of truth for "which events exist and
// what payload each carries." It powers compile-time safety in two places:
//   - `sendEvent(name, data)` constrains `name` to a known key and `data` to
//     that key's payload shape — `sendEvent('typo.event', …)` is a type error.
//   - `defineJob({ id })` constrains `id` to a known key, and the handler's
//     `event.data` is typed to the matching payload.
//
// CONVENTION (per the Subtask card): a job's `id` and its triggering event
// name are the SAME string (1:1). So the keys of this map ARE both the event
// names and the job ids. `email.send` (1.6.3) and the rest land as new keys.
//
// WORKSPACE-SCOPING INVARIANT: business events carry a `workspaceId` that
// `sendEvent` requires to be EXPLICIT — no event slips through having simply
// forgotten the field. For most events that id is a real workspace (string).
// `email.send` is the deliberate carve-out: a transactional email can be
// genuinely cross-workspace (a password reset is identity-scoped — the user
// may belong to many workspaces or none), so its `workspaceId` is `string |
// null`, where `null` means "system / no single workspace". `null` is the
// value the job_run row stores (the workspace_id FK is nullable — see the
// 1.6.2 schema), NOT a `"system"` sentinel string (that would violate the FK).
//
// The OTHER untenanted path is SYSTEM events (the `system.*` namespace), which
// are NOT dispatched through `sendEvent` at all. They are CRON-triggered (1.6.4:
// `system.daily-health-check` runs on a schedule) or driven by the in-process
// test harness. A scheduled job has no real triggering event, so the wrapper
// synthesizes the ledger's `event_name` as `scheduled.{job_id}` (see
// defineJob); the payload type therefore makes `workspaceId` optional.

import type { DesignAutoRerunRequestedData } from '@/lib/services/designAutoRerunService';
import type {
  PreviewEffectRequestedData,
  PreviewStartRequestedData,
} from '@/lib/services/previewLifecycleService';
import type { GateResumeRequestedData } from '@/lib/services/gateResumeRequest';
import type { PlanOfferRequirementPageRequestedData } from '@/lib/services/requirementPageSaveService';
import type { TransactionalEmail } from '@/lib/services/emailService';
import type { HostedAgentSession } from '@/lib/services/hostedAgentContainerService';

export interface SystemScheduledData {
  /**
   * System events are untenanted, so this is optional. When present it's
   * recorded on the job_run row; when absent the row's workspace_id is null.
   * Cron-triggered runs carry no payload, so this is typically absent.
   */
  workspaceId?: string;
}

/**
 * The `email.send` event payload. Composes the email domain's
 * `TransactionalEmail` (recipient + template + the template's typed data)
 * with the two background-job envelope fields every dispatched email needs:
 *   - `workspaceId` — the owning workspace, or `null` for a cross-workspace /
 *     system email (e.g. password reset). Stored on the job_run row.
 *   - `idempotencyKey` — a per-send unique key (the reset token, the invite
 *     token). Inngest dedups same-key events inside its window, so a retried
 *     Server Action that re-fires the same send becomes one delivery, not two.
 *
 * The intersection distributes over `TransactionalEmail`'s union, so each
 * template arm keeps its own `data` shape while gaining the envelope fields.
 */
export type EmailSendData = TransactionalEmail & {
  workspaceId: string | null;
  idempotencyKey: string;
};

/**
 * The `work-item/comment.created` event payload (Story 5.1 · Subtask 5.1.2) —
 * emitted AFTER a comment write commits (never inside the transaction: a
 * rollback must not have notified anyone). Deliberately CHANNEL-AGNOSTIC so
 * the 5.1.6 mention-email job, Story 5.4 (watchers) and Story 5.7 (the in-app
 * bell) all fan in off the same events without reshaping them.
 *
 * `mentionedUserIds` carries the validated, persisted mention set of the
 * write that fired the event. On a comment EDIT the same event re-fires with
 * ONLY the newly-added mention ids (no re-notify on unchanged mentions); the
 * consumer's idempotency key (comment × user) makes any overlap harmless.
 */
export interface WorkItemCommentCreatedData {
  workspaceId: string;
  workItemId: string;
  commentId: string;
  /** The actor whose write produced the mentions (comment author / editor). */
  authorId: string;
  mentionedUserIds: string[];
  /**
   * Automation provenance (Story 6.6 · Subtask 6.6.3). Set to the rule id when
   * this comment was written by an automation rule's `add_comment` action;
   * absent on an ordinary user comment. The automation engine's `commented`-
   * trigger consumer SKIPS any event carrying this — the verified Jira loop-
   * prevention default (rules don't trigger rules), so an add-comment action
   * cannot re-fire a comment-trigger rule. The mention / watcher consumers
   * ignore it (mention + watcher emails still send for an automation comment).
   */
  viaAutomationRuleId?: string;
}

/**
 * The `work-item/mentioned` event payload (Story 5.1 · Subtask 5.1.6) — the
 * DESCRIPTION-mention sibling of `work-item/comment.created`. Emitted AFTER a
 * work-item create / description-changing update commits, carrying ONLY the
 * newly-added, view-validated mention ids (an edit never re-notifies mentions
 * the previous body already carried). Channel-agnostic like its sibling, for
 * the same 5.4 / 5.7 fan-in reasons.
 *
 * `revisionId` is the `work_item_revision` row written atomically with the
 * mutation that introduced the mentions — the consumer's idempotency scope
 * (revision × user), playing the role `commentId` plays on the comment event.
 */
export interface WorkItemMentionedData {
  workspaceId: string;
  workItemId: string;
  /** The revision row recording the create/update that added the mentions. */
  revisionId: string;
  /** The actor whose write produced the mentions. */
  authorId: string;
  mentionedUserIds: string[];
}

/**
 * The `work-item/transitioned` event payload (Story 5.4 · Subtask 5.4.5) —
 * emitted AFTER a status transition commits (never inside the transaction: a
 * rollback must not have notified anyone — the 5.1.2 rule), from BOTH paths
 * that route through `workItemsService.applyStatusTransition`: the direct
 * `updateStatus` entry point and the board move (`boardsService.moveCard`,
 * the most common way a status changes in practice). A no-op move (same
 * status) emits nothing. Channel-agnostic like its `work-item/*` siblings —
 * the 5.4.5 watcher-email job consumes it today, Story 5.7's in-app bell
 * fans in off the same event later.
 *
 * `revisionId` is the `work_item_revision` row written atomically with the
 * status change — the consumer's idempotency scope (revision × user), the
 * same role `commentId` / `revisionId` play on the mention events.
 */
export interface WorkItemTransitionedData {
  workspaceId: string;
  workItemId: string;
  /** The actor who moved the status — never self-notified. */
  actorId: string;
  fromStatusKey: string;
  toStatusKey: string;
  /** The revision row recording the transition. */
  revisionId: string;
  /**
   * Automation provenance (Story 6.6 · Subtask 6.6.2). Set to the rule id when
   * this transition was performed by an automation rule's `transition` action;
   * absent on a user-driven move. The automation engine SKIPS any event
   * carrying this — the verified Jira loop-prevention default (rules don't
   * trigger rules). The 6.6.3 `transitioned`-trigger consumer reads it; the
   * existing watcher/bell consumers ignore it.
   */
  viaAutomationRuleId?: string;
}

/**
 * The `work-item/created` event payload (Story 6.6 · Subtask 6.6.2) — emitted
 * AFTER a work-item create commits (never inside the tx: a rollback must not
 * have fired a rule — the 5.1.2 rule), from the SHIPPED `workItemsService`
 * create path. The automation engine's `created`-trigger consumer reads it; it
 * is the same event the 5.7 stub anticipates for assignment notifications.
 * Workspace-scoped; `projectId` lets the engine load the project's rules in one
 * indexed read without re-fetching the item first.
 */
export interface WorkItemCreatedData {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  /** The actor who created the item (a rule run is attributed to the rule
   * owner, not this actor — the recorded 6.6 deviation). */
  actorId: string;
  /** Automation provenance — set when the create itself was performed by a
   * rule action (none ship in 6.6.2, but the field exists so a future
   * create-item action can't loop). The engine skips provenance-carrying
   * events. */
  viaAutomationRuleId?: string;
  /** Monitor provenance (MOTIR-5849) — set when the create was the monitor
   *  reconciler FILING a bug, naming the binding that filed it. The bug
   *  enrichment trigger reads it to tell a monitor bug whose link has not yet
   *  committed from a bug somebody filed by hand (`ServiceContext`'s note). */
  viaMonitorConnectionId?: string;
}

/**
 * The `work-item/child-set.changed` event payload (Story MOTIR-2888 · Subtask
 * MOTIR-2892; `docs/decisions/status-derivation.md` §3a) — emitted AFTER an edit
 * that adds a row to, or removes one from, some parent's DIRECT child set
 * WITHOUT transitioning anything: a re-parent, an archive, an unarchive, a
 * delete. Post-commit like its `work-item/*` siblings.
 *
 * It exists because status derivation became a RECOMPUTE over the child SET, and
 * the only event it rode (`work-item/transitioned`) fires on none of these. The
 * one that mattered most was invisible twice over: `moveWorkItem` emitted NOTHING
 * AT ALL before this, so a `move_to_parent` reached no job in the system.
 *
 * CREATE is deliberately NOT in here — `work-item/created` (6.6.2) already
 * carries it, and adding a second event for the same edit would double-fire the
 * recompute.
 */
export interface WorkItemChildSetChangedData {
  workspaceId: string;
  /** The PARENT ids whose direct child set changed — ONE for an archive /
   *  unarchive / delete, TWO for a re-parent (the previous parent, which may
   *  now be finished, and the new one, which may need to come back). Never
   *  empty: an edit that touches no parent emits nothing at all. */
  parentIds: string[];
  /** The child that entered or left the set. Carried for the run log and for
   *  triage — the recompute reads the PARENTS, so this is not an input. */
  workItemId: string;
  /** Which edit produced it, so a run log can tell an archive from a move. */
  reason: 'reparented' | 'archived' | 'unarchived' | 'deleted';
  /**
   * WHEN the edit committed, ISO-8601 (Bug MOTIR-2965). The recompute's backward
   * arm dates its claim from the newest edit to the child set, and every edit on
   * THIS event removes a row from that set — so unlike a create or a transition,
   * it leaves nothing behind for `aggregateChildrenStatus.lastChangedAt` to read.
   * Without it, archiving the started child of a parent a person had already
   * moved would read as a stale claim and be declined.
   */
  occurredAt: string;
}

/**
 * The `work-item/field.changed` event payload (Story 6.6 · Subtask 6.6.2) —
 * emitted AFTER a free-form work-item UPDATE commits, carrying the built-in
 * field ids that actually changed (computed from the 1.4.6 revision diff). The
 * automation engine's `field_changed`-trigger consumer narrows by its
 * configured field id against `changedFields`; `assignee` is the verified
 * "assigned" preset. Status transitions DON'T ride this event — they ride
 * `work-item/transitioned` from the typed-workflow path. Emitted only when at
 * least one automatable built-in field (assignee / priority / dueDate /
 * estimate) changed, so the event is never a no-op for the engine.
 */
export interface WorkItemFieldChangedData {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  /** The actor who edited the item. */
  actorId: string;
  /** The changed built-in field ids — a subset of
   * `AUTOMATION_FIELD_CHANGED_FIELDS` (assignee / priority / dueDate /
   * estimate). Always non-empty (the emit gate). */
  changedFields: string[];
  /** The `work_item_revision` row recording the edit. */
  revisionId: string;
  /** Automation provenance — set when the edit was performed by a rule's
   * `set_field` action; the engine skips provenance-carrying events (loop
   * prevention). */
  viaAutomationRuleId?: string;
}

/**
 * The `work-item/embedding.requested` event payload (Story MOTIR-2694 · Subtask
 * MOTIR-2696, per `docs/decisions/plan-tree-embeddings.md` §6.3) — emitted AFTER
 * a work-item write commits, on the three triggers the ADR pins: CREATE, an
 * UPDATE where the embedded document's hash CHANGED, and MATERIALIZE (an
 * approved plan's proposals becoming work items).
 *
 * ⚠️ IT CARRIES AN ID, NOT A PAYLOAD, AND THAT IS THE DESIGN (§6.3.3). The job
 * re-reads the item's CURRENT title and description at run time rather than
 * embedding text captured here, so two rapid edits converge on the current text
 * whichever order their jobs run in — and the trailing job's content hash then
 * matches the row the leading one wrote, so it skips. No sequence number, no
 * lock, no ordering guard. Adding a text field to this payload would quietly
 * delete that property.
 *
 * A status flip, re-parent, sprint move, assignee change, priority bump or
 * reorder emits NOTHING: the trigger is the CONTENT hash, not the row (§3), and
 * the emit gate is applied at the call site so the overwhelming majority of
 * work-item writes never even enqueue.
 */
export interface WorkItemEmbeddingRequestedData {
  workspaceId: string;
  workItemId: string;
}

/**
 * The `page/embedding.requested` event payload (Story MOTIR-9490 · MOTIR-9571) —
 * emitted AFTER a page write commits, by every door that changes a page's title,
 * body or liveness: create (empty or from markdown), a markdown save, a
 * collaborative update, a rename, a version restore, and an archive or restore
 * (one per page in the set).
 *
 * ⚠️ AN ID, NOT A PAYLOAD — the same design as {@link WorkItemEmbeddingRequestedData}:
 * the job re-reads the page's current text (and whether it is archived) at run
 * time, so rapid edits converge whatever order their jobs run in.
 */
export interface PageEmbeddingRequestedData {
  workspaceId: string;
  pageId: string;
}

/**
 * The `filter-subscription/deliver` event payload (Story 6.2 · Subtask 6.2.5)
 * — one per DUE subscription, enqueued by the hourly `system.filter-
 * subscription-tick` cron so each delivery retries/dead-letters independently
 * (the watcher fan-out shape). The consumer (savedFilterSubscriptionsService.
 * deliver) resolves the filter AS the subscriber and enqueues the durable
 * `email.send`. Workspace-scoped — the tick reads the denormalized
 * `workspaceId` so it never touches the RLS-protected saved_filter.
 */
export interface FilterSubscriptionDeliverData {
  workspaceId: string;
  subscriptionId: string;
  /** The per-occurrence email idempotency key — one mail per scheduled tick. */
  occurrenceKey: string;
}

/**
 * The `public-follow/digest` event payload (Story 8.9 · Subtask 8.9.7) — one per
 * DUE follower, enqueued by the weekly `system.public-follow-digest-tick` cron
 * so each delivery retries / dead-letters independently (the filter-subscription
 * fan-out shape). The consumer re-reads the shipped set AT SEND TIME, which is
 * why it carries an id rather than the items themselves: a digest composed at
 * tick time could mail an epic that was made private in between.
 * Workspace-scoped — the follow row carries a denormalized `workspaceId`.
 */
export interface PublicFollowDigestData {
  workspaceId: string;
  followId: string;
  /** `<followId>:<ISO week>` — one mail per follower per week, at most. */
  occurrenceKey: string;
}

/**
 * The `system.billing-seat-sync` event payload (Story 8.1 · Subtask 8.1.12) —
 * one per org-membership add/remove, enqueued best-effort AFTER the membership tx
 * commits (`enqueueScaledTrackerSeatSync`). The consumer
 * (billingService.syncScaledTrackerSeatQuantity) re-derives the org's active-
 * member count and sets the scaled-tracker Stripe seat `quantity` over the
 * boundary. SYSTEM-scoped (no `workspaceId`): an org spans workspaces, so the job
 * runs under `withSystemContext`, like every `system.*` job — and the `system.*`
 * namespace keeps it out of `WorkspaceScopedEventName` / `sendEvent` (it carries
 * no workspace id, so it is enqueued via `inngest.send` directly).
 */
export interface BillingSeatSyncData {
  organizationId: string;
}

/**
 * The `system.platform-meter-report` event payload (Story MOTIR-727 · MOTIR-5286) —
 * ONE settled fleet container to report to motir-ai's platform usage rollup, named
 * by the key the settle path holds. The job re-reads the row, so a retry always
 * sends the row's own id as the receiver's idempotency key.
 */
export type PlatformMeterReportData =
  | { containerProvider: string; handleId: string }
  /** One CHARGED agent-storage day (MOTIR-7294), by its charge row. */
  | { storageChargeId: string };

/**
 * The `system.code-graph-index` event payload (Story 7.5 · MOTIR-1500) — one per
 * NEWLY-ADDED GitHub repo, enqueued best-effort AFTER the installation's repos
 * persist (`enqueueCodeGraphIndex`, from the webhook reconcile + the fresh-install
 * bind paths). The consumer (codeGraphIndexService) fetches the repo's tarball
 * with the installation token and hands the BYTES to motir-ai per project (the
 * open-core producer half). `installationId` is GitHub's numeric installation id
 * (the token-minting key); `workspaceId` is the installation's bound workspace —
 * carried so the run is scoped on the job_run ledger (a real, valid FK), even
 * though the job is `system.*`-namespaced and enqueued via `inngest.send`
 * (NOT `sendEvent`), like every system job. The repo identity rides in the
 * payload so the handler indexes exactly the added repo without re-diffing.
 */
export interface CodeGraphIndexData {
  installationId: string;
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
}

/**
 * The `system.code-graph-refresh` event payload (Story 7.10 · MOTIR-893) — one
 * per default-branch PUSH to a connected repo, enqueued best-effort by the
 * webhook (`enqueueCodeGraphRefresh`) after the push resolves to a stored repo.
 * Same shape as the initial index: the consumer re-fetches the repo AT ITS
 * DEFAULT BRANCH (so coalesced pushes index the latest head once) and re-drives
 * the same fetch → bytes → motir-ai path; motir-ai's indexer refreshes the
 * existing graph incrementally. The job is DEBOUNCED per repo (rapid pushes
 * coalesce into one run with the latest event), which is why this is a separate
 * event from `system.code-graph-index` — the initial index must run promptly on
 * install, never sit out a debounce window.
 */
export type CodeGraphRefreshData = CodeGraphIndexData;

/**
 * The `system.ci-runner-boot` event payload (Story MOTIR-1916 · MOTIR-1921) —
 * one per provisioning INTENT to serve with an ephemeral runner.
 *
 * ⚠️ IT CARRIES THE INTENT ID AND NOTHING ELSE, deliberately. Everything the
 * boot needs — the org, the workspace, the project, the repo, the job — is
 * already on the intent row that MOTIR-1920 wrote, and the row is the source of
 * truth for it. Copying that attribution into the event would create a second
 * copy that can disagree with the first, and the moment it did, a container's
 * cost would be attributed by whichever copy the code happened to read.
 *
 * It is a `system.*` event because the fleet spans tenants exactly as Motir's
 * infrastructure bill does — the same reason `system.ci-minutes-reconcile` is.
 * The handler re-reads the intent for everything, and the event is enqueued via
 * `inngest.send`, never `sendEvent`, like every system job.
 *
 * ⚠️ `workspaceId` IS TYPED `null`, NOT `string` (MOTIR-1998). It shipped as
 * `string` carrying `''`, and that empty string voided the ledger row the field
 * exists to scope: `defineJob` forwards it as `data?.workspaceId ?? null`, and
 * `''` is not nullish, so `''` reached `job_run.workspace_id`, tripped the
 * workspace FK (`P2003`), and was swallowed by `isVanishedRunError` — the catch
 * that exists for a genuinely vanished tenant (MOTIR-1545). The result was NO
 * ledger row at all for the one job in the system that spends real money per
 * invocation. `null` is the honest value: the fleet is cross-tenant, the ledger's
 * `workspace_id` is nullable, and `system.fleet-attribution` (which
 * replaced `system.ci-runner-reap`) lands untenanted rows the same way.
 *
 * The type is the literal `null` rather than `string | null` ON PURPOSE — it is
 * what makes `''` (and any other string) a COMPILE error at the one call site
 * that builds this event, so the defect cannot recur by editing a literal. If
 * the fleet ever wants tenant-visible runs, widen this to `string | null` and
 * thread the intent's real workspace id through `ciRunnerBootEvent`; that is a
 * deliberate scope change, not a typo away.
 *
 * ONE EVENT PER INTENT, not one per batch: a batch handler that died halfway
 * would leave the containers it had already booted with no supervisor, which is
 * precisely the orphan the reaper exists to catch and the shape not to
 * manufacture on purpose.
 */
export interface CiRunnerBootData {
  intentId: string;
  workspaceId: null;
}

/**
 * The `hosted-run/supervise` event payload (Story MOTIR-683 · MOTIR-690) — one
 * per hosted run, emitted by the start path once its container is booted.
 *
 * ⚠️ IT CARRIES NO SECRET, and that is why the start path boots before it
 * enqueues. The boot's env holds the run credential and the gateway key; this
 * payload is a `job_queue` row. So the container is booted in the request, and
 * the job supervises the SESSION the boot returned — a handle, attribution and
 * instants, JSON by contract (`HostedAgentSession`).
 */
export interface HostedRunSuperviseData {
  workspaceId: string;
  /** The run — `DispatchRun.id`, the one id (§1). */
  dispatchRunId: string;
  /** The booted container, exactly as `hostedAgentContainerService.boot` returned it. */
  session: HostedAgentSession;
  /** `hosted-run:<dispatchRunId>` — one supervision per run, however often emitted. */
  idempotencyKey: string;
}

/** How long a held run waits before its admission asks again (MOTIR-9381). It
 *  bounds how soon a freed slot is taken, never whether the run boots. It lives
 *  here, not in `hostedRunService`, so the job definition (and so the job
 *  registry the docs-guard lane loads) never pulls in the service's graph. */
export const HOSTED_RUN_ADMIT_RETRY_MS = 30_000;

/**
 * The `hosted-run/admit` event payload (Story MOTIR-9363 · MOTIR-9381) — one per
 * hosted run that was held at admission for a reason that clears by itself (its
 * org at its plan's agent-run figure, or its plan unreadable). Each pass of the
 * job asks for a fleet slot once and, when admitted, boots the run.
 *
 * ⚠️ IT CARRIES NO SECRET, for {@link HostedRunSuperviseData}'s reason: it is a
 * `job_queue` row. It holds only the NON-SECRET inputs the boot is rebuilt from;
 * the run key and the run credential are minted at admission, inside the pass
 * that boots, and only ever reach the container's env.
 */
export interface HostedRunAdmitData {
  workspaceId: string;
  /** The run — `DispatchRun.id`. */
  dispatchRunId: string;
  /** Who started it: the run credential is minted for them. */
  dispatcherUserId: string;
  organizationId: string;
  projectId: string;
  /** The card (or parent) the container runs `motir run` on. */
  identifier: string;
  repoFullName: string;
  /** The BARE gateway model id the run key is minted for. */
  model: string;
  /** The same model as OpenCode spells it (`MOTIR_MODEL`). */
  openCodeModel: string;
  /** The mode-specific, non-secret launcher inputs (`MOTIR_RUN_MODE`, …). */
  extraEnv: Record<string, string>;
  /** `hosted-run-admit:<dispatchRunId>` — one admission job per run. */
  idempotencyKey: string;
}

/**
 * The `agent-instance-run/launch` payload (Story MOTIR-6864 · MOTIR-7026,
 * `docs/decisions/agent-instance-run.md` §4) — one per run started in a
 * developer's agent, emitted by the start once the run is open and its cards
 * claimed. The job waits for the agent to come up and runs the launcher.
 *
 * ⚠️ IT CARRIES NO SECRET: the run token is minted by the launch step itself and
 * travels only on the exec's stdin (§2).
 */
export interface AgentInstanceRunLaunchData {
  workspaceId: string;
  /** The run — `DispatchRun.id`. */
  dispatchRunId: string;
  /** `agent-instance-run:<dispatchRunId>` — one launch per run, however often emitted. */
  idempotencyKey: string;
}

/**
 * The `agent-instance-run/supervise` payload (Story MOTIR-6864 · MOTIR-7027,
 * `docs/decisions/agent-instance-run.md` §6) — one per run started in a
 * developer's agent, emitted by the start beside the launch. The job polls the
 * run each minute until it ends. It carries no secret.
 */
export interface AgentInstanceRunSuperviseData {
  workspaceId: string;
  /** The run — `DispatchRun.id`. */
  dispatchRunId: string;
  /** `agent-instance-run/supervise:<dispatchRunId>` — one supervision per run. */
  idempotencyKey: string;
}

/**
 * The `agent-instance/idle-check` payload (Story MOTIR-6860 · MOTIR-6873) — the
 * idle TIMER of one agent instance. Emitted when an instance starts running and
 * whenever its activity is bumped; the job is DEBOUNCED on `instanceId`, so it
 * runs once the instance has gone quiet for the idle window, and the debounce
 * cap makes it run at the 12-hour backstop even under steady activity
 * (`docs/decisions/agent-instances.md` §2).
 */
export interface AgentInstanceIdleCheckData {
  workspaceId: string;
  instanceId: string;
}

/**
 * The `agent-instance/boot` payload (Story MOTIR-7393 · MOTIR-7398,
 * `docs/decisions/agent-instances.md` AMENDMENT 6 §3) — one boot attempt of one
 * agent, driven to `running` or `failed`. Sent by the create or wake that opened
 * the attempt, and again by the sweep for an attempt whose lease expired.
 */
export interface AgentInstanceBootData {
  workspaceId: string;
  instanceId: string;
  /** The boot attempt this driver advances, numbered per agent from 1. */
  attempt: number;
  /**
   * `agent-instance-boot:<instanceId>:<attempt>` — one driver per attempt; a
   * resend for an expired lease carries that lease's expiry, so it is never
   * swallowed as a duplicate of the first (`agentBootEventKey`).
   */
  idempotencyKey: string;
}

/**
 * Map of event-name → payload. Each key is a job id and the event name that
 * triggers it; for an event's FIRST consumer the two are the same string (the
 * 1:1 convention). An event with MULTIPLE consumers (e.g.
 * `work-item/comment.created`, consumed by the 5.1.6 mention job AND the
 * 5.4.5 watcher job) registers each additional consumer under its own
 * distinct id with an explicit `trigger` (see `defineJob`). Grows one entry
 * per event. (An event MAY land before its consuming job does —
 * `work-item/comment.created` ships with 5.1.2 while the mention-notification
 * job consuming it is 5.1.6; publishing to an event no function subscribes to
 * is a no-op on Inngest's side.)
 */
/**
 * The `account/data-export.requested` event payload (Story 8.4 · MOTIR-3701) —
 * emitted AFTER `requestDataExport`'s transaction commits, so the build job can
 * never read a row a rollback removed.
 *
 * `workspaceId` is `string | null` and always `null` in practice: a personal-data
 * export is IDENTITY-scoped and spans every workspace the person belongs to, so
 * it has no single owning tenant. This is the `email.send` carve-out, for the
 * same reason a password reset has one — and `null` is the value the job_run
 * row stores, never a `"system"` sentinel (the workspace_id FK would reject it).
 */
export interface DataExportRequestedData {
  workspaceId: string | null;
  /** Whose data is being exported. Also the job's concurrency key. */
  userId: string;
  /** The `data_export_request` row this build records its outcome on. */
  requestId: string;
}

export interface JobEventDataMap {
  'system.daily-health-check': SystemScheduledData;
  'system.attachment-gc': SystemScheduledData;
  /** MOTIR-4219 — the certificate sweep. Cross-tenant, cron-only. */
  'system.public-address-certificate-refresh': SystemScheduledData;
  'system.rate-limit-sweep': SystemScheduledData;
  /** MOTIR-6984 — the daily OAuth sweep. Identity-scoped tables, cron-only. */
  'system.oauth-sweep': SystemScheduledData;
  /** MOTIR-8227 — the hourly work-item embedding sweep. Cross-tenant, cron-only. */
  'system.work-item-embedding-sweep': SystemScheduledData;
  'system.filter-subscription-tick': SystemScheduledData;
  'system.public-follow-digest-tick': SystemScheduledData;
  'system.auto-plan-cadence-tick': SystemScheduledData;
  'system.automation-retention-sweep': SystemScheduledData;
  /** The ACCOUNT-ERASURE sweep (Story 8.4 · MOTIR-3702) — erases and anonymises
   *  the accounts whose 30-day grace period has run out, which is what makes
   *  `motir.co/legal/privacy` §6's *"we erase or anonymise within 30 days"*
   *  true. Cron triggered, so it carries no tenant: the due set spans users and
   *  tenants and the ledger row is untenanted, like every `system.*` sweep. */
  'system.account-erasure-sweep': SystemScheduledData;
  /** The ORGANIZATION-DELETION reminders (Story MOTIR-6306 · MOTIR-6395) — the
   *  seven-day and one-day notices to a closing org's Owner and Admins. Cron
   *  triggered, so it carries no payload beyond the scheduled envelope. */
  'system.organization-deletion-reminders': SystemScheduledData;
  /** The ORGANIZATION ERASURE sweep (Story MOTIR-6306 · MOTIR-6400) — erases every
   *  organization whose deletion window has ended, resumably. Cron triggered. */
  'system.organization-erasure-sweep': SystemScheduledData;
  /** The ORGANIZATION RETENTION purge (Story MOTIR-6306 · MOTIR-6401) — removes an
   *  erased organization's tombstone and billing record seven years after the
   *  erasure, in both repositories. Cron triggered. */
  'system.organization-retention-purge': SystemScheduledData;
  /** The code-graph OFFBOARDING sweep (Story MOTIR-2192 · MOTIR-2168) — drains
   *  due `code_graph_offboarding` rows through motir-ai's offboard seam, which is
   *  what makes §14's retention window real. Cron triggered, so it carries no
   *  payload beyond the scheduled envelope. */
  'system.code-graph-offboard-sweep': SystemScheduledData;
  /** Monthly CI-minutes reconciliation (Story MOTIR-1775 · MOTIR-1896) — cron
   *  triggered, so it carries no payload beyond the scheduled envelope. */
  'system.ci-minutes-reconcile': SystemScheduledData;
  /** The live CI charge (Story MOTIR-6906 · MOTIR-6910) — every debit period,
   *  each live CI container's minutes are charged. Cron triggered. */
  'system.ci-live-charge': SystemScheduledData;
  'system.ci-actions-gate-sweep': SystemScheduledData;
  /** The migrate-onboarding SWEEP lane — every transition of that state machine
   *  is observed only by an open browser tab, so this re-derives from durable
   *  state for the runs nobody is watching: it completes runs whose project is
   *  already established (MOTIR-2092) and advances runs wedged at `index` whose
   *  code-graph index has since succeeded (MOTIR-2082). Cron triggered, so it
   *  carries no payload beyond the scheduled envelope. */
  'system.migrate-onboarding-sweep': SystemScheduledData;
  /** The planning-target lease sweep (Story MOTIR-2786 · MOTIR-2787) — releases
   *  every `plan_target_lock` whose window has run out, so a crashed planner can
   *  never leave an item permanently unplannable. Cross-tenant by design. */
  'system.plan-target-lock-sweep': SystemScheduledData;
  /** The DRIFT RECOMPUTE sweep (MOTIR-4644) — counts commits between the graph's
   *  head and the default branch's, off every render path. */
  'system.code-graph-drift-sweep': SystemScheduledData;
  'system.preview-enablement-sweep': SystemScheduledData;
  /** The preview reaper (Story MOTIR-5766 · MOTIR-5776) — finishes interrupted
   *  teardowns and closes previews whose close was missed. Cross-tenant. */
  'system.preview-reaper': SystemScheduledData;
  /** The preview usage accrual (Story MOTIR-5766 · MOTIR-5777) — one slice of
   *  every live preview's usage into its organisation's CI pool. Cross-tenant. */
  'system.preview-usage-accrual': SystemScheduledData;
  /** One effect of a committed preview transition (MOTIR-5776), enqueued by the
   *  webhook after the transition commits. */
  'preview/effect.requested': PreviewEffectRequestedData;
  /** A preview image landed: start the head's release (MOTIR-5776). */
  'preview/start.requested': PreviewStartRequestedData;
  /** The index CATCH-UP sweep (MOTIR-5290) — re-asks the internal index allowance
   *  for repositories paused by a hard stop, and refreshes only where the head
   *  moved. Cross-tenant by design. */
  'system.code-graph-index-catch-up': SystemScheduledData;
  /** The dispatch-run housekeeping (Story MOTIR-1789 · MOTIR-1792) — nulls
   *  opt-in log bodies past their 30-day window and closes runs nothing is
   *  holding, so a dead run stops rendering as `running`. Cron triggered, so it
   *  carries no payload beyond the scheduled envelope. Cross-tenant by design:
   *  it DISCOVERS across workspaces and WRITES within each. */
  'system.dispatch-run-sweep': SystemScheduledData;
  /** The run-liveness sweep (Story MOTIR-6526 · MOTIR-6528) — closes a LOCAL
   *  run whose heartbeat has lapsed as `abandoned`, writing no card status, so
   *  the run's record agrees with what `isRunAlive` already reads. Cron
   *  triggered; cross-tenant by design, like the dispatch-run sweep. */
  'system.run-liveness-sweep': SystemScheduledData;
  /** The open-delivery reconcile (MOTIR-5390) — re-reads open, delivering pull
   *  requests from GitHub and replays a close whose webhook delivery was lost, so
   *  a missed merge no longer holds its card at In Review for ever. Carries no
   *  payload beyond the scheduled envelope. Cross-tenant by design. */
  'system.pull-request-reconcile': SystemScheduledData;
  /** The abandoned-plan reconciler (MOTIR-3064) — asks motir-ai what became of
   *  the job behind every empty `generating` plan past its grace, and declines
   *  the ones whose producer is gone, so a dead generation can no longer pause a
   *  project's auto-plan cadence for good. Cross-tenant by design. */
  'system.abandoned-plan-sweep': SystemScheduledData;
  /** The staff "View as" session expiry sweep (Story 10.3 · MOTIR-749) —
   *  records `user.impersonation_end` (`endedBy: expiry`) for every session past
   *  its time-box that nobody came back to, so the audit trail never shows a
   *  session that began and never ended. Cross-tenant by design. */
  'system.impersonation-expiry-sweep': SystemScheduledData;
  /** The abandoned-SUPERVISION sweep (Story MOTIR-3778 · MOTIR-3830) — settles a
   *  container supervision whose chain of self-rescheduling passes stopped, so a
   *  container Motir is no longer watching is torn down, metered and its
   *  admission slot released rather than left to the 70-minute fleet reaper,
   *  which does none of the three for an index container. Cross-tenant by
   *  design: the fleet spans tenants because the infrastructure bill does. */
  'system.supervision-sweep': SystemScheduledData;
  'system.job-run-reap': SystemScheduledData;
  /** The queue retention pass (Story MOTIR-8540) — deletes succeeded `job_queue`
   *  rows past the window, their steps and orphaned events. Cross-tenant by design. */
  'system.job-queue-retention': SystemScheduledData;
  /** The personal-data export retention sweep (Story 8.4 · MOTIR-3701) —
   *  deletes each archive's blob once its seven-day window has run out and
   *  moves the row to `expired`. Cross-tenant by design. */
  'system.data-export-expiry-sweep': SystemScheduledData;
  /** The expired name-hold sweep (Story MOTIR-4528 · MOTIR-9509) — deletes the
   *  public-hostname reservations whose hold has lapsed. Cross-tenant by design. */
  'system.public-hostname-reservation-sweep': SystemScheduledData;
  /** The runner FLEET (Story MOTIR-1916 · MOTIR-1921): the interim pending-intent
   *  trigger, the per-intent boot, and the crash-backstop reaper. */
  'system.ci-runner-provision-sweep': SystemScheduledData;
  'system.ci-runner-boot': CiRunnerBootData;
  'system.fleet-attribution': SystemScheduledData;
  /** The fleet debit monitor (Story MOTIR-6905 · MOTIR-7318): an alert per
   *  organisation whose running and debited disagree. Cross-tenant by design. */
  'system.fleet-debit-monitor': SystemScheduledData;
  /** The fleet headroom pass (Story MOTIR-8953 · MOTIR-8969) — each fleet account,
   *  GitHub org and fleet kind against 70% of its limits, one alert per (subject,
   *  limit). Cross-tenant by design: the limits are Motir's, not a tenant's. */
  'system.fleet-shard-headroom': SystemScheduledData;
  /** The capacity alert pass (Story MOTIR-9539 · MOTIR-9612) — every provider/model
   *  limit against the alert share, one alert per limit. Cross-tenant by design:
   *  the limits are Motir's, not a tenant's. */
  'system.capacity-alert-evaluation': SystemScheduledData;
  /** The pool growth pass (Story MOTIR-9362 · MOTIR-9462) — each fleet kind on its
   *  AWS pool grows by itself at 70% of an account's live granted quota.
   *  Cross-tenant by design: the pools are Motir's, not a tenant's. */
  'system.fleet-pool-growth': SystemScheduledData;
  /** The Host account reconcile (Story MOTIR-9365 · MOTIR-9582) — every org whose
   *  plan reads `host` gets its three AWS accounts and their quota raises.
   *  Cross-tenant by design: it walks every Host org. */
  'system.host-account-reconcile': SystemScheduledData;
  /** The Host account state pass (Story MOTIR-9365 · MOTIR-9585) — every own AWS
   *  account's state and entry times. Cross-tenant by design: it walks every
   *  Host org's accounts. */
  'system.host-account-state': SystemScheduledData;
  /** The tenant account reconcile (Story MOTIR-9792 · MOTIR-9942) — every
   *  enterprise tenant AWS account not yet ready is created or found, then
   *  bootstrapped. Cross-tenant by design: it walks every requested account. */
  'system.hosting-tenant-account-reconcile': SystemScheduledData;
  'system.billing-seat-sync': BillingSeatSyncData;
  /** A settled fleet container's usage-and-cost report to motir-ai (MOTIR-5286). */
  'system.platform-meter-report': PlatformMeterReportData;
  'system.code-graph-index': CodeGraphIndexData;
  'system.code-graph-refresh': CodeGraphRefreshData;
  'filter-subscription/deliver': FilterSubscriptionDeliverData;
  'public-follow/digest': PublicFollowDigestData;
  'account/data-export.requested': DataExportRequestedData;
  /** A booted hosted run's supervision (Story MOTIR-683 · MOTIR-690). */
  'hosted-run/supervise': HostedRunSuperviseData;
  /** A held hosted run's admission, retried until it boots (Story MOTIR-9363 · MOTIR-9381). */
  'hosted-run/admit': HostedRunAdmitData;
  /** One agent instance's idle timer (Story MOTIR-6860 · MOTIR-6873). */
  'agent-instance/idle-check': AgentInstanceIdleCheckData;
  /** One boot attempt of an agent, driven step by step (Story MOTIR-7393 · MOTIR-7398). */
  'agent-instance/boot': AgentInstanceBootData;
  /** The launch of a card's run in a developer's agent (Story MOTIR-6864 · MOTIR-7026). */
  'agent-instance-run/launch': AgentInstanceRunLaunchData;
  /** The supervision of a card's run in a developer's agent (Story MOTIR-6864 · MOTIR-7027). */
  'agent-instance-run/supervise': AgentInstanceRunSuperviseData;
  'email.send': EmailSendData;
  'work-item/comment.created': WorkItemCommentCreatedData;
  'work-item/mentioned': WorkItemMentionedData;
  'work-item/transitioned': WorkItemTransitionedData;
  'work-item/created': WorkItemCreatedData;
  'work-item/field.changed': WorkItemFieldChangedData;
  'work-item/child-set.changed': WorkItemChildSetChangedData;
  'work-item/derivation.requested': WorkItemDerivationRequestedData;
  'work-item/embedding.requested': WorkItemEmbeddingRequestedData;
  'page/embedding.requested': PageEmbeddingRequestedData;
  'pull-request/auto-merge.requested': PullRequestAutoMergeRequestedData;
  /** An `agent_review` gate was RAISED (Story MOTIR-1626 · MOTIR-6819; `approval-gates.md`
   *  §12.2, `hosted-agent-run.md` §8.1) — start ONE review run for it. Emitted after the
   *  raising transaction commits. Consumed by `agent-review/requested`
   *  (`lib/jobs/definitions/agentReviewRequested.ts`, MOTIR-6820), and emitted again by
   *  *Review again*. */
  'agent-review/requested': AgentReviewRequestedData;
  /** A person sent a HOSTED design back with Revise (MOTIR-700): start its automatic
   *  re-run, or record why not. Emitted by the design handler AFTER the refusal commits. */
  'design/auto-rerun.requested': DesignAutoRerunRequestedData;
  /** A gate a `gated` run stopped at was APPROVED (MOTIR-7710): resume the run on the
   *  hosted agent if it was hosted, and record what happened. Emitted by both decide
   *  doors AFTER the decision commits. */
  'run/gate-resume.requested': GateResumeRequestedData;
  /** A plan offer carrying a composed requirement was CONFIRMED (MOTIR-10091): save the
   *  requirement as its page in Requirements Docs and record it on the offer. Emitted by
   *  the confirm AFTER the transaction that claimed the offer commits; keyed by the offer
   *  turn, so one offer gets one page. */
  'plan-offer/requirement-page.requested': PlanOfferRequirementPageRequestedData;
  /** A push moved a repository's DEFAULT branch (MOTIR-5914): re-read the host's
   *  mergeability of every open pull request that targets it, and withdraw the question
   *  over any that now conflict. Emitted by the push webhook after its own write. */
  'pull-request/base-moved': PullRequestBaseMovedData;
  'pull-request/head-moved': PullRequestHeadMovedData;
  /** A Motir repository's environment configuration changed (Story MOTIR-9795 ·
   *  MOTIR-9961): one entry added, replaced or deleted. Emitted by
   *  `environmentConfigService` AFTER the change commits; carries no value. The
   *  deploying stories subscribe to it to redeploy that environment. */
  'environment.config.changed': EnvironmentConfigChangedData;
  /** The monitor-issue reconciler's TICK (Story MOTIR-4929 · MOTIR-5581) — cron
   *  triggered and cross-tenant: it discovers every binding and fans out. */
  'system.monitor-issue-reconcile': SystemScheduledData;
  /** ONE binding's poll, fanned out by the tick above (MOTIR-5581). */
  'monitor/connection.poll-requested': MonitorConnectionPollRequestedData;
  /** A monitor-filed bug the enrichment never reached, found by the poll's
   *  standing backfill sweep (Story MOTIR-5975 · MOTIR-5983). Consumed by the
   *  SAME dispatch-and-apply the `work-item/created` enrichment runs. */
  'monitor-issue/enrichment-backfill': MonitorEnrichmentBackfillData;
  /** The DLQ standing-depth filer (MOTIR-5869) — files one bug per job function
   *  whose dead letters have stood undisposed for seven days. Cross-tenant by
   *  design: `job_run_dlq` is deployment-wide. */
  'system.dlq-standing-depth-sweep': SystemScheduledData;
  /** The agent-instance sweep (Story MOTIR-6860 · MOTIR-6873) — settles, reconciles
   *  and hibernates instances, destroys orphans and charges pending intervals.
   *  Cross-tenant by design: it walks every live instance. */
  'system.agent-instance-sweep': SystemScheduledData;
  /** The agent storage charge (Story MOTIR-6914 · MOTIR-6919) — writes and debits
   *  one storage day per agent per UTC day on which it existed. Cross-tenant by
   *  design: it walks every instance that stood in its window. */
  'system.agent-instance-storage-charge': SystemScheduledData;
}

/**
 * The `monitor/connection.poll-requested` event payload (Story MOTIR-4929 ·
 * MOTIR-5581) — one per bound monitored project per tick.
 */
export interface MonitorConnectionPollRequestedData {
  /** The binding's workspace — the run's tenant on its ledger row. */
  workspaceId: string;
  /** The `monitor_connection` row to poll; the run re-reads it for everything. */
  connectionId: string;
  /** `<connectionId>:<tick run id>` — so a retried tick enqueues ONE poll of a
   *  binding per tick, never two. */
  idempotencyKey: string;
}

/**
 * The `monitor-issue/enrichment-backfill` event payload (Story MOTIR-5975 ·
 * MOTIR-5983) — the `work-item/created` enrichment trigger's fields, rebuilt by
 * the backfill sweep from a link row, plus the dedup key.
 */
export interface MonitorEnrichmentBackfillData {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  /** The binding's binder — the identity the bug was filed as. */
  actorId: string;
  viaMonitorConnectionId: string;
  /** `monitor-enrich-backfill:<monitor_issue.id>` — ONE enqueue per link, for
   *  good: a double emit, or two polls emitting before either run starts, lands
   *  one queue row, so one `author_bug` is submitted. */
  idempotencyKey: string;
}

/**
 * The `pull-request/base-moved` event payload (MOTIR-5914, for bug MOTIR-5907;
 * design/github § 30 rule 1). A conflict usually arrives with NO event on the pull
 * request — another merge moves the BASE — so the push to that base is what asks.
 */
export interface PullRequestBaseMovedData {
  /** The repository's tenant — `github_repo.workspace_id`. */
  workspaceId: string;
  /** The `github_repo` ROW id. */
  repoId: string;
  /** The branch that moved (the repository's default branch). */
  baseRef: string;
  /** The new head of that branch, when the delivery carried one. */
  baseHeadSha: string | null;
  /** `<repoId>:<baseHeadSha>` — a redelivered push for the same head enqueues nothing new. */
  idempotencyKey: string;
}

/**
 * The `pull-request/head-moved` event payload (MOTIR-7063) — one per `synchronize`. The
 * base-branch push asks about every pull request on the base; a push to the pull
 * request's OWN branch asks about that one, because a head pushed onto a base that has
 * already moved past it conflicts with no event on the base at all.
 */
/**
 * The `environment.config.changed` event payload (Story MOTIR-9795 · MOTIR-9961)
 * — one per add, replace or delete of an environment entry. It names the entry
 * and never carries its value, secret or not.
 */
export interface EnvironmentConfigChangedData {
  workspaceId: string;
  projectRepositoryId: string;
  environment: 'production' | 'preview' | 'release';
  name: string;
  action: 'added' | 'replaced' | 'deleted';
  actorId: string;
}

export interface PullRequestHeadMovedData {
  /** The repository's tenant — `github_repo.workspace_id`. */
  workspaceId: string;
  /** The `github_pull_request` ROW id. */
  pullRequestId: string;
  /** The pull request's number on the host. */
  number: number;
  /** The head the push delivered — the one the pending reading is owed at. */
  headSha: string;
  /** `<pullRequestId>:<headSha>` — a redelivered push for the same head enqueues nothing new. */
  idempotencyKey: string;
}

/**
 * The `agent-review/requested` event payload (Story MOTIR-1626 · MOTIR-6819; ADR
 * `approval-gates.md` §12.2, `hosted-agent-run.md` §8.1) — one per `agent_review` gate ROW
 * CREATED, emitted after the creating transaction commits (`lib/workspaces/afterCommit.ts`).
 * The consumer (MOTIR-6820) re-reads the gate by id and starts a review run only while it
 * is still `awaiting` at `subjectVersion`.
 */
export interface AgentReviewRequestedData {
  workspaceId: string;
  /** The `agent_review` gate the run answers. */
  gateId: string;
  /** The RUN TARGET the gate hangs on (§12.1). */
  workItemId: string;
  /** The delivery-set version the review is about — `deliverySetVersion`'s spelling. */
  subjectVersion: string;
  /**
   * The REQUEST's key (MOTIR-6820) — `agent-review:<gateId>:raise` for the gate's raise,
   * `agent-review:<gateId>:again:<uuid>` for one *Review again* press
   * (`lib/agentReview/reviewRunKey.ts`). The job's dedup key and the review run's
   * idempotency key, so a redelivered request starts nothing twice. Absent on an event
   * emitted before it existed: the consumer then reads it as the raise.
   */
  idempotencyKey?: string;
}

/**
 * The `pull-request/auto-merge.requested` event payload (Story MOTIR-4882 ·
 * MOTIR-5518) — one pull request, at the head whose checks just went green, on a run
 * target in an `auto` project. Emitted by the CI promotion AFTER it commits.
 */
export interface PullRequestAutoMergeRequestedData {
  workspaceId: string;
  /** The RUN TARGET — the work item a refusal comment is posted on. */
  workItemId: string;
  /** The `github_pull_request` row to merge. */
  pullRequestId: string;
  /** The head that went green. A pull request no longer at it is skipped, and the
   *  merge is pinned to it (`expectedHeadSha`). */
  headSha: string;
  /** Who a refusal comment is written as — the promotion's actor, the workspace owner. */
  actorUserId: string;
  /** `<pullRequestId>:<headSha>` — the job's dedup key, so one head is attempted once. */
  idempotencyKey: string;
}

/**
 * The `work-item/derivation.requested` event payload (Bug MOTIR-2902).
 *
 * ── Why this event exists, and why it is not one of the other three ─────────
 * Derivation's three shipped triggers all ride an edit that ANNOUNCES itself: a
 * transition, a create, a child-set edit. A bulk import performs a fourth kind
 * of edit that announces nothing — `setImportedStatus` pins a child's mapped
 * status and deliberately emits NO `work-item/transitioned`, so an import cannot
 * fan out one notification per imported row. That contract is correct and stays.
 *
 * The consequence was that the ONLY derivation trigger an import produced was
 * the `work-item/created` that fired BEFORE the pin, so the recompute could read
 * the child as `todo`, settle the parent at `todo`, and never re-fire — the child
 * set never changes again. This event is the pin's own trigger: derivation-only,
 * with no notification consumer, so the storm the import avoids stays avoided.
 *
 * ⚠️ It carries NO `occurredAt`, unlike `work-item/child-set.changed`, and that
 * is deliberate. Per `RecomputeTrigger`, only an edit INVISIBLE to the aggregate
 * needs to date itself. A status pin leaves its mark on a live child row, so
 * `aggregateChildrenStatus.lastChangedAt` already dates it — and reading the date
 * off the SET rather than off the event is what keeps the recompute idempotent
 * under redelivery.
 */
export interface WorkItemDerivationRequestedData {
  workspaceId: string;
  /** The parent to recompute. Never null: an item with no parent has nothing to
   *  derive, so the emit site skips it rather than sending a no-op. */
  parentId: string;
  /** The child whose status was pinned. Carried for the run log and triage; the
   *  recompute reads the PARENT, so this is not an input. */
  workItemId: string;
  /** Which silent edit asked for it, so a run log can tell them apart if more
   *  are added. */
  reason: 'imported-status-pinned';
}

/** Every registered event/job name. */
export type JobEventName = keyof JobEventDataMap;

/** The payload type for a given event name. */
export type JobEventData<N extends JobEventName> = JobEventDataMap[N];

/**
 * The names of events that are workspace-scoped (everything OUTSIDE the
 * `system.*` namespace). `sendEvent` is typed to accept only these — system
 * events never go through `sendEvent` (they are cron / harness triggered):
 * `email.send` + the `work-item/*` events.
 */
export type { DesignAutoRerunRequestedData };
export type { PreviewEffectRequestedData, PreviewStartRequestedData };
export type { GateResumeRequestedData };
export type { PlanOfferRequirementPageRequestedData };

export type WorkspaceScopedEventName = Exclude<JobEventName, `system.${string}`>;

/**
 * The names of SYSTEM events — the `system.*` namespace, the exact complement of
 * {@link WorkspaceScopedEventName}.
 *
 * ⚠️ THE SPLIT IS KEPT, NOT WIDENED (Story MOTIR-3415 · MOTIR-3456). `sendEvent`
 * still accepts only workspace-scoped names, because the invariant it enforces —
 * every business event carries an EXPLICIT tenant — is real and a system
 * payload's `workspaceId` is optional. Widening one function to cover both would
 * have to drop that assertion for everybody.
 *
 * So the system namespace gets its own doors in `sendEvent.ts`
 * (`sendSystemEvent` / `dispatchSystemEvent`) rather than a looser `sendEvent`.
 * What changes is only that system events now travel through the module where
 * the per-job cutover switch is read, instead of calling the Inngest client
 * directly: an emitter that bypasses that module is an emitter the switch cannot
 * route, which is the defect MOTIR-3456 closes.
 */
export type SystemEventName = Extract<JobEventName, `system.${string}`>;
