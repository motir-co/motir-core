// MOTIR-5022 — the PINNED result shape of every memoized step, by id.
//
// ── What a pin is, and what it buys ─────────────────────────────────────────
// A `step.run(id, fn)` result is stored in `job_step` under `(run_id, id)` and
// returned on replay WITHOUT executing the step. The id therefore identifies a
// unit of work across a DEPLOY, and the stored value is only as current as the
// revision that wrote it. Change what a step returns while keeping its id, and
// a run that resumes across the deploy replays the old JSON into the new
// reader. Nothing in the type system can see it: the reader's static type is
// the new one, and the boundary is JSON.
//
// Each entry below is that step's result shape AS OF THE ID IT CARRIES.
// `tests/jobs/step-result-shape-guard.test.ts` recomputes every one of them
// from the tree and fails on any disagreement, so the change that used to reach
// production silently now fails a test with the two shapes side by side.
//
// ── How to update this file, and the decision it is asking you for ──────────
// The guard failing is the question *did you mean to change what this step
// RETURNS?*, and it has exactly two honest answers:
//
//   • **The shape change is real** ⇒ the step needs a NEW ID. Bump it
//     (`resolve-target` → `resolve-target-v2`), move the OLD id into
//     `RETIRED_STEP_IDS` with its shape, and add the new id here. That is what
//     makes the stale row unreadable, which is the whole fix.
//   • **The shape did not really change** — a type was renamed, a field's
//     declaration moved, an alias was inlined ⇒ paste the computed shape from
//     the failure message over the old one. The diff of THIS FILE is then the
//     reviewable record that the members are the same.
//
// ⚠️ THERE IS NO THIRD ANSWER, and the tempting one is "bump the pin because
// the run needs to be green". A pin edited without the id bump records that a
// shape changed and asserts nothing about the memos already in `job_step`.
//
// ⚠️ AND BUMPING AN ID IS NOT FREE EVERYWHERE — read
// `lib/jobs/engine/step.ts`'s test before you do it. A new id means the step
// RE-EXECUTES on a resumed run. That is correct for a read (`resolve-target-v2`
// is DB reads only, which is why MOTIR-5020 could bump it) and WRONG for
// anything that provisions, claims or tears down: bumping `index-boot:` would
// bill a second container rather than re-attach to the first. Where the step
// has an external effect, the answer is to keep the id and make the REPLAYED
// value safe at the boundary — `requireCurrentIndexTarget` in
// `lib/services/codeGraphIndexService.ts` is the worked example — and to record
// that here rather than in a commit message.
//
// ── The format ──────────────────────────────────────────────────────────────
// The key is the step id AS WRITTEN: a literal's text, or a template's source
// text (`` `index-admit:${subject}` ``). Editing a template IS a change of
// id, so pinning its source is the right granularity. The shape is the
// structural fingerprint `tests/jobs/stepResultShapes.ts` computes — members
// sorted, expanded through every type declared in this repository, stopping at
// library types by name. It is generated, not written by hand; the guard's
// failure message prints the string to paste.

/** One memoized step's result shape, as of the id it carries. */
export interface StepShapePin {
  /** Where the id is written, repo-relative. A move is a review moment, so it is asserted. */
  readonly file: string;
  /** The structural fingerprint of the awaited result. */
  readonly shape: string;
}

/** A step id that is OUT OF USE, and may never be used again with another shape. */
export interface RetiredStepId {
  /** The shape the memos written under this id carry — what a replay would hand a reader. */
  readonly shape: string;
  /** The id that replaced it. */
  readonly supersededBy: string;
  /** Why it was retired. */
  readonly reason: string;
}

/**
 * Every live memoized step, by id.
 *
 * 63 entries over 71 call sites: an id used at several sites in one handler is
 * pinned once, and the guard requires those sites to agree.
 *
 * ⚠️ MOTIR-6448 KEPT SEVEN IDS ON PURPOSE. `ContainerUsage` / `ContainerAccrual`
 * gained an OPTIONAL `dispatchRunId`, which changed the shape of every boot,
 * settle and reap step that returns a usage record (`boot-runner`,
 * `settle-runner`, `index-boot:` / `index-settle:`, the two hosted-agent steps
 * and `reap-orphaned-containers`). Each of them provisions or tears down, so a
 * new id would re-provision on a resumed run. The replayed value is safe at the
 * boundary instead: a memo written before the change carries no
 * `dispatchRunId`, and its one reader (`ciFleetCostMeterService`'s usage
 * mapping) reads it as `record.dispatchRunId ?? null` — a row naming no run,
 * which is exactly what every pre-change row is.
 *
 * ⚠️ MOTIR-6911 KEPT `boot-runner` AND `settle-runner` ON PURPOSE. Admission's
 * deferral reason gained `credits_insufficient` and `balance_unavailable`, which
 * WIDENS the `gate_deferred` union those steps return. They provision, so a new
 * id would re-provision on a resumed run; a memo written before the change
 * carries one of the older reasons, every one of which the new union still
 * holds, so a replay reads exactly as it did.
 *
 * ⚠️ MOTIR-6925 KEPT `sweep-agent-instances` ON PURPOSE. Its `orphans` lost the
 * `machines` count when orphaned machines moved to the fleet-attribution
 * reconciler, which NARROWS the shape. The sweep hibernates and charges, so a
 * new id would re-run it on a resumed run. A memo written before the change
 * carries `orphans: { machines, volumes }` — a superset of what is pinned — and
 * its one reader is the job's own return value, which nothing destructures.
 *
 * ⚠️ MOTIR-8968 KEPT `boot-runner` AND `settle-runner` ON PURPOSE, as MOTIR-6911
 * did. Admission's deferral reason gained `shard_capacity` (every fleet account
 * of the kind is full), which WIDENS the `gate_deferred` union. A memo written
 * before the change carries one of the older reasons, all of which the new union
 * still holds, so a replay reads exactly as it did.
 *
 * ⚠️ MOTIR-8711 KEPT `boot-runner` ON PURPOSE. Its supervising `session` gained an
 * OPTIONAL `runnerTarget` (the org and installation the runner was minted in),
 * which WIDENS the shape. The step provisions, so a new id would re-provision on
 * a resumed run. A memo written before the change carries no `runnerTarget`, and
 * its one reader (teardown's `deregisterQuietly`) reads it as
 * `session.runnerTarget ?? undefined` — the provisioning installation, which is
 * where every pre-change runner was minted.
 *
 * ⚠️ MOTIR-9375 KEPT `boot-runner`, `settle-runner`, `index-admit:`, `index-boot:`
 * AND `index-settle:` ON PURPOSE. The env-sized org pool was retired for the
 * plan's CI burst cap, so the CI deferral reason `org_pool` became `plan_cap`
 * and the index deferral lost `org_pool` outright. Each of those steps admits,
 * provisions or tears down, so a new id would re-run it on a resumed run. A memo
 * written before the change can carry `reason: "org_pool"`, and it replays as a
 * plain deferral: the reason is copied into a terminal outcome or a retry
 * detail, and the only branch on it (`ai_plan_required` in the index admission
 * wait) is not taken for `org_pool`, which keeps waiting exactly as it did.
 *
 * ⚠️ MOTIR-9381 KEPT `hostedAgentBootStepId(…)` ON PURPOSE. Admission gained the
 * `already_booting` phase, which WIDENS the shape. The step provisions, so a new
 * id would re-provision on a resumed run; a memo written before the change
 * carries `supervising` or `terminal`, both of which the new union still holds.
 */
export const LIVE_STEP_SHAPES: Record<string, StepShapePin> = {
  '`head-settle-${pass}`': {
    file: 'lib/jobs/definitions/pullRequestHeadMoved.ts',
    shape:
      '{ gatesRaised: number; held: number; outcome: "clean" | "conflicted" | "failed" | "skipped" | "unknown"; promoted: number; withdrawn: number }',
  },
  '`index-admit:${subject}`': {
    file: 'lib/services/codeGraphIndexDispatchService.ts',
    shape:
      '{ admission: { admittedAt: string; detail: string; slotRef: string }; admittedAt: string; census: { byWorkload: { agent_instance: number; ci_runner: number; code_graph_index: number; hosted_agent: number }; total: number }; outcome: "admitted"; requestedAt: string } | { admission: { admittedAt: string; detail: string; slotRef: string }; admittedAt: string; outcome: "already_held"; requestedAt: string } | { admittedAt: string; detail: string; outcome: "deferred"; reason: "ai_plan_required" | "fleet_ceiling" | "gate_unavailable" | "index_cap" | "org_index_cap" | "plan_unknown" | "repo_index_in_flight"; requestedAt: string }',
  },
  '`index-boot:${subject}`': {
    file: 'lib/services/codeGraphIndexDispatchService.ts',
    shape:
      '{ outcome: { billableSeconds: number; containerId: string; coreTimings?: undefined | { phasesMs: { admissionWait?: number | undefined; boot?: number | undefined; pollToDetect?: number | undefined }; totalMs?: number | undefined }; costUsd: string; failureDetail: null | string; indexMode?: "rebuild" | "sync" | undefined; outcome: "settled"; reason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; usage: { billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; dispatchRunId?: null | string | undefined; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "agent_instance" | "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string }; verdict: { detail: string; exitClass: "credential_refused" | "dispatch_malformed" | "exit_unobserved" | "graph_unbuildable" | "indexed" | "never_started" | "out_of_memory" | "pointer_unrecorded" | "repo_unfetchable" | "supervision_timed_out" | "unclassified" | "upload_failed"; exitCode: null | number; indexed: boolean; redispatchable: boolean } } | { detail: string; outcome: "admission_deferred"; reason: "ai_plan_required" | "fleet_ceiling" | "gate_unavailable" | "index_cap" | "org_index_cap" | "plan_unknown" | "repo_index_in_flight" } | { detail: string; outcome: "image_unpullable" } | { detail: string; outcome: "provision_failed" } | { detail: string; outcome: "teardown_failed" }; phase: "terminal" } | { phase: "supervising"; session: { attribution: { orgId: string; projectId: string; repoFullName: string; workspaceId: string }; bootedAt: string; credentialExpiresAt: string; dispatchId: string; handle: { createdAt: string; id: string; provider: "arc" | "fake" | "fly" | "runs_on"; region: string }; repoRef: string; runId: string; slotRef: string; syncGranted?: false | true | undefined } }',
  },
  '`index-settle:${subject}`': {
    file: 'lib/services/codeGraphIndexDispatchService.ts',
    shape:
      '{ billableSeconds: number; containerId: string; coreTimings?: undefined | { phasesMs: { admissionWait?: number | undefined; boot?: number | undefined; pollToDetect?: number | undefined }; totalMs?: number | undefined }; costUsd: string; failureDetail: null | string; indexMode?: "rebuild" | "sync" | undefined; outcome: "settled"; reason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; usage: { billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; dispatchRunId?: null | string | undefined; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "agent_instance" | "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string }; verdict: { detail: string; exitClass: "credential_refused" | "dispatch_malformed" | "exit_unobserved" | "graph_unbuildable" | "indexed" | "never_started" | "out_of_memory" | "pointer_unrecorded" | "repo_unfetchable" | "supervision_timed_out" | "unclassified" | "upload_failed"; exitCode: null | number; indexed: boolean; redispatchable: boolean } } | { detail: string; outcome: "admission_deferred"; reason: "ai_plan_required" | "fleet_ceiling" | "gate_unavailable" | "index_cap" | "org_index_cap" | "plan_unknown" | "repo_index_in_flight" } | { detail: string; outcome: "image_unpullable" } | { detail: string; outcome: "provision_failed" } | { detail: string; outcome: "teardown_failed" }',
  },
  // MOTIR-7130 — whether an `upload_failed` attempt was refused for SIZE. A pure
  // read (motir-ai's run verdict), memoized because the answer decides whether a
  // second billed container boots, so a later pass must replay it, not re-ask.
  '`index-size-refusal:${subject}`': {
    file: 'lib/services/codeGraphIndexDispatchService.ts',
    shape: '{ refusedForSize: null } | { refusedForSize: { capBytes: number; sizeBytes: number } }',
  },
  '`settle-${pass}`': {
    file: 'lib/jobs/definitions/pullRequestBaseMoved.ts',
    shape:
      '{ conflicted: number; failed: number; held: number; unknown: Array<{ number: number; pullRequestId: string }>; withdrawn: number }',
  },
  'advance-wedged-index-runs': {
    file: 'lib/jobs/definitions/migrateOnboardingSweep.ts',
    shape: '{ advanced: number; failed: number; scanned: number }',
  },
  'assert-pending': {
    file: 'lib/jobs/definitions/ciActionsGateSweep.ts',
    shape: '{ applied: number; failed: number }',
  },
  // MOTIR-8839 added the OPTIONAL `session.handle.volumeId` (the runner's Docker
  // volume) WITHOUT an id bump, on purpose: this step PROVISIONS, so a new id
  // would boot a second container on a resumed run. The replayed value is safe at
  // the boundary instead — a session memoised before the field existed simply
  // lacks it, and the settle's teardown then finds the volume in the machine's
  // own mounts, or the fleet reconciler's orphan sweep deletes it.
  //
  // MOTIR-9348 added the OPTIONAL `session.image` the same way, for the same
  // reason: a session memoised before it existed lacks it, and the never-started
  // verdict then names the image `unknown` rather than failing.
  //
  // MOTIR-8964 added the OPTIONAL `session.handle.shardId` (the fleet account the
  // container was booted in) the same way, for the same reason: a session
  // memoised before it existed lacks it, and every later step resolves it to the
  // process-wide fleet — where every such container was booted.
  'boot-runner': {
    file: 'lib/services/ciRunnerBootService.ts',
    shape:
      '{ outcome: { billableSeconds: number; bootLatencyMs: null | number; containerId: string; costUsd: string; outcome: "settled"; reason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; usage: { billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; dispatchRunId?: null | string | undefined; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "agent_instance" | "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string } } | { detail: string; outcome: "gate_deferred"; reason: "ai_plan_required" | "balance_unavailable" | "ci_credits_exhausted" | "credits_insufficient" | "fleet_ceiling" | "gate_unavailable" | "plan_cap" | "plan_unknown" | "shard_capacity" } | { detail: string; outcome: "image_unpullable" } | { detail: string; outcome: "no_runner_group" } | { detail: string; outcome: "provision_failed" } | { outcome: "already_claimed" } | { outcome: "not_configured" } | { outcome: "rate_limited"; retryAfterSeconds: null | number } | { outcome: "unknown_intent" }; phase: "terminal" } | { phase: "supervising"; session: { attribution: { orgId: string; projectId: string; repoFullName: string; workflowJobId: number; workspaceId: string }; bootedAt: string; githubRunnerId: null | number; handle: { createdAt: string; id: string; provider: "arc" | "fake" | "fly" | "runs_on"; region: string; shardId?: string | undefined; volumeId?: string | undefined }; image?: string | undefined; intentId: string; queuedAt: string; runnerTarget?: null | undefined | { installationId: string; org: string; role: "provisioning" | "user-facing" } } }',
  },
  'build-archive': {
    file: 'lib/jobs/definitions/dataExportBuild.ts',
    shape:
      '{ bytes: number; counts: { [key: string]: number }; failureReason?: undefined; files: { missing: number; packaged: number }; requestId: string; status: "ready" } | { bytes?: undefined; counts?: undefined; failureReason: string; files?: undefined; requestId: string; status: "failed" }',
  },
  'cancel-offboarding': {
    file: 'lib/jobs/indexFleetSteps.ts',
    shape: '{ cancelled: number }',
  },
  'cascade-to-children': {
    file: 'lib/jobs/definitions/statusDerivation.ts',
    shape:
      '{ childIds: Array<string>; itemId: string; outcome: "cascaded"; postDatedIds?: Array<string> | undefined; toStatus: string } | { itemId: string; outcome: "access_denied" } | { itemId: string; outcome: "no_matching_status" } | { itemId: string; outcome: "no_open_children" } | { itemId: string; outcome: "post_dated_only"; postDatedIds: Array<string> } | { itemId: string; outcome: "toggle_off" } | { outcome: "not_done" } | { outcome: "unresolvable" }',
  },
  'catch-up-paused-indexes': {
    file: 'lib/jobs/definitions/codeGraphIndexCatchUp.ts',
    shape:
      '{ organizationsAsked: number; outcomes: Array<{ organizationId: string; outcome: "action_failed" | "ask_failed" | "head_unknown" | "index_enqueued" | "pause_cleared" | "refresh_enqueued" | "still_stopped"; repoRef: string }>; scanned: number }',
  },
  'deliver-digest': {
    file: 'lib/jobs/definitions/publicFollowDigestDeliver.ts',
    shape: '{ itemCount: number; sent: boolean }',
  },
  'deliver-subscription': {
    file: 'lib/jobs/definitions/filterSubscriptionDeliver.ts',
    shape:
      '{ count: number; recipient: string; status: "delivered"; total: number } | { reason: "filter_gone" | "filter_invalid" | "no_access" | "subscription_gone"; status: "skipped" }',
  },
  'derive-first-audit': {
    file: 'lib/jobs/definitions/codeGraphIndex.ts',
    shape:
      '{ outcomes: Array<{ projectId: string; reason?: "already_audited" | "coverage_unavailable" | "submit_failed" | undefined; status: "skipped" | "submitted" }>; repoRef: string; skipped?: "lookup_failed" | "no_owner" | "no_projects" | undefined; submitted: number }',
  },
  'dispatch-boots': {
    file: 'lib/jobs/definitions/ciRunnerFleet.ts',
    shape: '{ dispatched: number }',
  },
  'dispatch-bug-authoring': {
    file: 'lib/jobs/definitions/monitorBugEnrich.ts',
    shape:
      '{ dispatched: false; reason: "ai-not-configured" | "already-dispatched" | "no-binder" | "no-monitor-link" | "not-a-bug" } | { dispatched: true; framesRead: boolean; jobId: string }',
  },
  '`apply-authored-bug-${poll}`': {
    file: 'lib/jobs/definitions/monitorBugEnrich.ts',
    shape:
      '{ reason: "ai-unreachable" | "bug-gone" | "card-changed" | "invalid-answer" | "job-failed" | "terminal-status" | "timed-out"; status: "skipped" } | { status: "applied" } | { status: "pending" }',
  },
  // The BACKFILL twin of the two above (MOTIR-5983): the same calls, the same
  // shapes, its own ids — so each id is written in exactly one file.
  'backfill-dispatch-bug-authoring': {
    file: 'lib/jobs/definitions/monitorBugEnrichBackfill.ts',
    shape:
      '{ dispatched: false; reason: "ai-not-configured" | "already-dispatched" | "no-binder" | "no-monitor-link" | "not-a-bug" } | { dispatched: true; framesRead: boolean; jobId: string }',
  },
  '`backfill-apply-authored-bug-${poll}`': {
    file: 'lib/jobs/definitions/monitorBugEnrichBackfill.ts',
    shape:
      '{ reason: "ai-unreachable" | "bug-gone" | "card-changed" | "invalid-answer" | "job-failed" | "terminal-status" | "timed-out"; status: "skipped" } | { status: "applied" } | { status: "pending" }',
  },
  'dispatch-outward-analysis': {
    file: 'lib/jobs/definitions/outwardBugTelemetry.ts',
    shape:
      '{ dispatched: boolean; jobId?: string | undefined; reason?: "ai-not-configured" | "meta-project" | "not-a-bug" | undefined }',
  },
  'drain-due-offboardings': {
    file: 'lib/jobs/definitions/codeGraphOffboardSweep.ts',
    shape:
      '{ coordinationRowsDeleted: number; due: number; failed: number; localRootsRemoved: number; offboarded: number; remaining: number; snapshotObjectsDeleted: number }',
  },
  'embed-work-item': {
    file: 'lib/jobs/definitions/workItemEmbedding.ts',
    shape:
      '{ embedded: boolean; model?: string | undefined; reason?: "ai-not-configured" | "not-found" | "unchanged" | undefined }',
  },
  'enqueue-due-deliveries': {
    file: 'lib/jobs/definitions/filterSubscriptionTick.ts',
    shape: '{ due: number; enqueued: number; hour: number; scanned: number }',
  },
  'enqueue-due-digests': {
    file: 'lib/jobs/definitions/publicFollowDigestTick.ts',
    shape: '{ enqueued: number; projects: number }',
  },
  'purge-retained-organizations': {
    file: 'lib/jobs/definitions/organizationRetentionPurge.ts',
    shape:
      '{ failed: number; failures: Array<{ error: string; organizationId: string }>; purged: number; scanned: number }',
  },
  'erase-due-organizations': {
    file: 'lib/jobs/definitions/organizationErasureSweep.ts',
    shape:
      '{ claimed: number; erased: number; failed: number; failures: Array<{ error: string; requestId: string; step: string }>; reconciled: number; resumed: number; scanned: number; skipped: number }',
  },
  'erase-due-accounts': {
    file: 'lib/jobs/definitions/accountErasureSweep.ts',
    shape:
      '{ blocked: number; erased: number; exportBlobFailures: Array<{ error: string; exportRequestId: string }>; exportsDeleted: number; failed: number; failures: Array<{ error: string; requestId: string }>; resumed: number; scanned: number; skipped: number; workspacesDeleted: number }',
  },
  'fleet-boot-preflight': {
    file: 'lib/jobs/definitions/dailyHealthCheck.ts',
    shape:
      '{ detail: string; reference: string; verdict: "indeterminate" } | { detail: string; reference: string; verdict: "unpullable" } | { detail: string; verdict: "not_applicable" } | { digest: null | string; reference: string; verdict: "bootable" }',
  },
  'hostedAgentBootStepId(request.dispatchId)': {
    file: 'lib/services/hostedAgentContainerService.ts',
    shape:
      '{ outcome: { billableSeconds: number; containerId: string; costUsd: string; exitCode: null | number; failureDetail: null | string; outcome: "settled"; reason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; usage: { billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; dispatchRunId?: null | string | undefined; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "agent_instance" | "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string } } | { detail: string; outcome: "admission_deferred"; reason: string } | { detail: string; outcome: "image_unpullable" } | { detail: string; outcome: "provision_failed" } | { detail: string; outcome: "teardown_failed" }; phase: "terminal" } | { phase: "already_booting" } | { phase: "supervising"; session: { attribution: { orgId: string; projectId: string; repoFullName: string; workspaceId: string }; bootedAt: string; dispatchId: string; dispatchRunId: null | string; handle: { createdAt: string; id: string; provider: "arc" | "fake" | "fly" | "runs_on"; region: string }; runId: string; size: { cpuKind: "performance" | "shared"; cpus: number; memoryMb: number }; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; timeoutSeconds: number } }',
  },
  // MOTIR-6514 — the machine-time charge that follows a settle naming a run. A
  // `retryable` result is thrown inside the step and never memoized, so it is
  // absent from the shape by construction.
  'hostedAgentChargeStepId(dispatchId)': {
    file: 'lib/services/hostedAgentContainerService.ts',
    shape:
      '{ balanceAfter: number; billableSeconds: number; credits: number; exhausted: boolean; idempotent: boolean; outcome: "charged" } | { detail: string; outcome: "refused" } | { outcome: "not_charged"; reason: "disabled" | "no_run" | "not_settled" | "unconfigured" | "zero_seconds" }',
  },
  'hostedAgentSettleStepId(request.dispatchId)': {
    file: 'lib/services/hostedAgentContainerService.ts',
    shape:
      '{ billableSeconds: number; containerId: string; costUsd: string; exitCode: null | number; failureDetail: null | string; outcome: "settled"; reason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; usage: { billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; dispatchRunId?: null | string | undefined; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "agent_instance" | "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string } } | { detail: string; outcome: "admission_deferred"; reason: string } | { detail: string; outcome: "image_unpullable" } | { detail: string; outcome: "provision_failed" } | { detail: string; outcome: "teardown_failed" }',
  },
  // MOTIR-690 — a hosted run ended through the end path's seam once its
  // container settled. Idempotent by construction (revocations are, and the close
  // is skipped for a run already closed), so the memo only saves the calls.
  'hostedRunEndStepId(data.dispatchRunId)': {
    file: 'lib/services/hostedRunService.ts',
    shape:
      '{ closed: boolean; gitCredentials: { failed: number; revoked: number }; runCredential: number; runKey: "failed" | "revoked" }',
  },
  'index-allowance': {
    file: 'lib/jobs/indexFleetSteps.ts',
    shape:
      '{ outcome: null | string; proceed: true } | { outcome: string; proceed: false; reason: `paused_index_${string}` }',
  },
  'index-container-ai-address': {
    file: 'lib/jobs/definitions/dailyHealthCheck.ts',
    shape:
      '{ address: string; detail: string; verdict: "indeterminate" } | { address: string; detail: string; verdict: "private_address" } | { address: string; status: number; verdict: "reachable" } | { detail: string; verdict: "not_applicable" } | { detail: string; verdict: "unconfigured" }',
  },
  'index-rebuild-streak': {
    file: 'lib/jobs/definitions/dailyHealthCheck.ts',
    shape:
      '{ blindSpot: string; candidates: Array<string>; checkedAt: string; entries: Array<{ consecutiveRebuilds: number; modeRuns: number; repoRef: string; state: "rebuilding" | "syncing" | "unknown"; succeededRuns: number }>; offenders: Array<{ consecutiveRebuilds: number; modeRuns: number; repoRef: string; state: "rebuilding" | "syncing" | "unknown"; succeededRuns: number }>; threshold: number; unknownRepoRefs: Array<string>; verdict: "rebuilding" } | { blindSpot: string; checkedAt: string; detail: string; verdict: "not_applicable" } | { blindSpot: string; checkedAt: string; entries: Array<{ consecutiveRebuilds: number; modeRuns: number; repoRef: string; state: "rebuilding" | "syncing" | "unknown"; succeededRuns: number }>; threshold: number; unknownRepoRefs: Array<string>; verdict: "ok" }',
  },
  'index-fleet-boot-preflight': {
    file: 'lib/jobs/definitions/dailyHealthCheck.ts',
    shape:
      '{ detail: string; reference: string; verdict: "indeterminate" } | { detail: string; reference: string; verdict: "unpullable" } | { detail: string; verdict: "not_applicable" } | { digest: null | string; reference: string; verdict: "bootable" }',
  },
  'job-run:start': {
    file: 'lib/jobs/engine/ledger.ts',
    shape:
      'null | { attempt: number; delivery: null | { lastEventAt: null | string; providerMessageId: null | string; recipient: string; state: "accepted" | "bounced" | "complained" | "delayed" | "delivered"; template: string }; durationMs: null | number; eventId: string; eventName: string; failure: null | { code?: string | undefined; message: string; stack?: string | undefined }; finishedAt: null | string; functionId: string; id: string; idempotencyKey: null | string; lane: "engine" | "inngest"; output: unknown; startedAt: string; status: "abandoned" | "failed" | "running" | "succeeded"; workspaceId: null | string }',
  },
  'job-run:succeeded': {
    file: 'lib/jobs/engine/ledger.ts',
    shape:
      'null | { attempt: number; delivery: null | { lastEventAt: null | string; providerMessageId: null | string; recipient: string; state: "accepted" | "bounced" | "complained" | "delayed" | "delivered"; template: string }; durationMs: null | number; eventId: string; eventName: string; failure: null | { code?: string | undefined; message: string; stack?: string | undefined }; finishedAt: null | string; functionId: string; id: string; idempotencyKey: null | string; lane: "engine" | "inngest"; output: unknown; startedAt: string; status: "abandoned" | "failed" | "running" | "succeeded"; workspaceId: null | string }',
  },
  'list-members': {
    file: 'lib/jobs/definitions/pullRequestBaseMoved.ts',
    shape: 'Array<{ number: number; pullRequestId: string }>',
  },
  'list-pending-intents': {
    file: 'lib/jobs/definitions/ciRunnerFleet.ts',
    shape: 'Array<string>',
  },
  'reconcile-github-queue': {
    file: 'lib/jobs/definitions/ciRunnerFleet.ts',
    shape: '{ added: number }',
  },
  'mark-stale-for-terminal-target': {
    file: 'lib/jobs/definitions/planDrift.ts',
    shape: '{ markedStale: Array<string>; restored: Array<string>; skipped: Array<string> }',
  },
  'mention-fan-out': {
    file: 'lib/jobs/definitions/mentionNotify.ts',
    shape: '{ notifiedUserIds: Array<string> }',
  },
  // The monitor-configuration probe (MOTIR-5831). Its result is a VERDICT the
  // handler branches on, so a replayed shape from an older revision would decide
  // whether the run goes red — which is exactly what this pin exists to catch.
  'monitor-config-preflight': {
    file: 'lib/jobs/definitions/dailyHealthCheck.ts',
    shape:
      '{ blindSpot: string; detail: string; offenders: Array<{ missing: Array<string>; providerId: string; required: Array<string> }>; providers: Array<{ missing: Array<string>; providerId: string; required: Array<string> }>; verdict: "incomplete" } | { blindSpot: string; detail: string; providers: Array<{ missing: Array<string>; providerId: string; required: Array<string> }>; verdict: "complete" } | { blindSpot: string; detail: string; providers: Array<{ missing: Array<string>; providerId: string; required: Array<string> }>; verdict: "not_applicable" }',
  },
  'credential-expiry': {
    file: 'lib/jobs/definitions/dailyHealthCheck.ts',
    shape:
      '{ checkedAt: string; entries: Array<{ daysRemaining: number; envVar: string; expiresAt: string; name: string; renewal: string; source: string; state: "expired" | "expiring" | "healthy" }>; expiring: Array<{ daysRemaining: number; envVar: string; expiresAt: string; name: string; renewal: string; source: string; state: "expired" | "expiring" | "healthy" }>; offenders: Array<{ daysRemaining: number; envVar: string; expiresAt: string; name: string; renewal: string; source: string; state: "expired" | "expiring" | "healthy" }>; skipped: Array<string>; verdict: "expired" } | { checkedAt: string; entries: Array<{ daysRemaining: number; envVar: string; expiresAt: string; name: string; renewal: string; source: string; state: "expired" | "expiring" | "healthy" }>; offenders: Array<{ daysRemaining: number; envVar: string; expiresAt: string; name: string; renewal: string; source: string; state: "expired" | "expiring" | "healthy" }>; skipped: Array<string>; verdict: "expiring" } | { checkedAt: string; entries: Array<{ daysRemaining: number; envVar: string; expiresAt: string; name: string; renewal: string; source: string; state: "expired" | "expiring" | "healthy" }>; skipped: Array<string>; verdict: "ok" }',
  },
  'hosted-run-probe': {
    file: 'lib/jobs/definitions/dailyHealthCheck.ts',
    shape:
      '{ checkedAt: string; offenders: Array<{ completedAt: string; families: Array<string>; org: string; repo: string; runAttempt: number; runId: string }>; ownedOrgs: Array<string>; runsChecked: number; verdict: "hosted_runs"; windowStart: string } | { checkedAt: string; ownedOrgs: Array<string>; runsChecked: number; verdict: "not_applicable"; windowStart: string } | { checkedAt: string; ownedOrgs: Array<string>; runsChecked: number; verdict: "ok"; windowStart: string }',
  },
  'notification-fan-in': {
    file: 'lib/jobs/definitions/notificationFanIn.ts',
    shape: '{ writtenUserIds: Array<string> }',
  },
  'probe-boot': {
    file: 'lib/test-deferring-job.ts',
    shape: '{ bootedAt: string }',
  },
  'purge-expired-job-queue': {
    file: 'lib/jobs/definitions/jobQueueRetention.ts',
    shape:
      '{ batches: number; drained: boolean; jobEvent: number; jobQueue: number; jobStep: number }',
  },
  'purge-expired-job-runs': {
    file: 'lib/jobs/definitions/jobRunReap.ts',
    shape: '{ batches: number; deleted: number; drained: boolean; kept: number }',
  },
  'reap-abandoned-job-runs': {
    file: 'lib/jobs/definitions/jobRunReap.ts',
    shape: '{ abandoned: number; scanned: number; stillLive: number }',
  },
  'fleet-shard-headroom': {
    file: 'lib/jobs/definitions/fleetShardHeadroom.ts',
    shape:
      '{ accounts: number; alerted: number; failures: number; kinds: number; moves: { [key: string]: { capacity_refused?: number | undefined; provider_unavailable?: number | undefined } }; orgs: number; readings: Array<{ capacity: number; fraction: number; limit: string; subject: { fleetKind: string } | { githubOrg: string } | { shardId: string }; used: number }> }',
  },
  'fleet-debit-monitor': {
    file: 'lib/jobs/definitions/fleetDebitMonitor.ts',
    shape: '{ alerted: number; failures: number; mismatched: number; orgs: number }',
  },
  // MOTIR-8839 added `orphanedVolumesDestroyed` WITHOUT an id bump: the result is
  // only returned as the job's output — nothing branches on it — and a pass
  // re-decides from the inventory rather than replaying, so a memo written
  // before the field existed is read by no one who needs it.
  'reconcile-fleet-attribution': {
    file: 'lib/jobs/definitions/fleetAttribution.ts',
    shape:
      '{ apps: number; failures: number; killed: Array<{ action: "destroyed" | "stopped"; app: string; machineId: string; reason: "no_record" | "org_stopped" | "record_ended"; workload: "agent_instance" | "ci_runner" | "code_graph_index" | "hosted_agent" | null }>; listed: number; matched: number; orphanedVolumesDestroyed: number; outcome: "reconciled"; spared: number; unavailableApps: Array<string>; undated: number } | { detail: string; outcome: "inventory_unavailable" } | { outcome: "disabled" }',
  },
  'recompute-code-graph-drift': {
    file: 'lib/jobs/definitions/codeGraphDriftSweep.ts',
    shape: '{ counted: number; indeterminate: number; scanned: number; skipped: number }',
  },
  'reconcile-abandoned-plans-v3': {
    file: 'lib/jobs/definitions/abandonedPlanSweep.ts',
    // MOTIR-8304 added `lostMachine` and MOTIR-8307 `autoResume` to the
    // `awaiting_resume` outcome, so the id was bumped.
    //
    // MOTIR-9065 added the OPTIONAL `jobCancel` to the `awaiting_resume` and
    // `declined` outcomes and the `job_queued` keep reason. The id is KEPT: the
    // change only ADDS members, so every memo written under the old shape is still
    // a valid value of the new one, and the handler returns it without reading it.
    shape:
      '{ declined: number; outcomes: Array<{ autoResume: null | { count: number; jobId: string; started: true } | { reason: "bound_spent" | "lost_race" | "no_proposal" | "not_failed" | "not_resumable" | "starter_cannot_plan" | "submit_refused"; started: false }; jobCancel?: undefined | { cancelled: false; why: string } | { cancelled: true }; lostMachine: boolean; outcome: "awaiting_resume"; planId: string; projectId: string; reason: "job_gone" | "job_terminal" | "lease_lapsed" | "max_age" | "silent" } | { jobCancel?: undefined | { cancelled: false; why: string } | { cancelled: true }; outcome: "declined"; planId: string; projectId: string; reason: "job_gone" | "job_terminal" | "lease_lapsed" | "max_age" | "silent" } | { outcome: "left_as_is"; planId: string; projectId: string; reason: "ai_unreachable" | "job_in_flight" | "job_queued" | "revision_held" | "row_moved" | "session_waiting" | "writing" } | { outcome: "revision_failed"; planId: string; projectId: string; reason: "job_gone" | "job_terminal" | "lease_lapsed" | "max_age" | "silent" } | { outcome: "revision_released"; planId: string; projectId: string; reason: "job_gone" | "job_terminal" | "lease_lapsed" | "max_age" | "silent" }>; scanned: number }',
  },

  'reconcile-established-runs': {
    file: 'lib/jobs/definitions/migrateOnboardingSweep.ts',
    shape: '{ failed: number; scanned: number; terminated: number }',
  },
  'reconcile-fleet': {
    file: 'lib/jobs/definitions/ciMinutesReconcile.ts',
    shape:
      '{ discrepancies: Array<{ containerCount: number; containerMinutes: number; driftMinutes: number; exceedsTolerance: boolean; fleetJobCount: number; meteredMinutes: number; repoName: string }>; org: string; outcome: "reconciled"; periodStart: Date; repos: Array<{ containerCount: number; containerMinutes: number; driftMinutes: number; exceedsTolerance: boolean; fleetJobCount: number; meteredMinutes: number; repoName: string }> } | { outcome: "skipped"; reason: "metering_disabled" }',
  },
  'list-pollable-connections': {
    file: 'lib/jobs/definitions/monitorIssueReconcile.ts',
    shape: 'Array<{ id: string; workspaceId: string }>',
  },
  'dispatch-polls': {
    file: 'lib/jobs/definitions/monitorIssueReconcile.ts',
    shape: '{ dispatched: number }',
  },
  'poll-v3': {
    file: 'lib/jobs/definitions/monitorIssueReconcile.ts',
    shape:
      '{ enrichmentRequested: number; evidenceBackfilled: number; filed: number; pages: number; refiled: number; refreshed: number; skipped: number; status: "failed" | "ok"; updated: number }',
  },
  'resolve-linked-issues': {
    file: 'lib/jobs/definitions/monitorIssueResolve.ts',
    shape: '{ failed: number; gone: number; links: number; resolved: number; skipped: number }',
  },
  'reconcile-open-deliveries-v5': {
    file: 'lib/jobs/definitions/pullRequestReconcile.ts',
    shape:
      '{ examined: number; failed: number; gatesRaised: number; gone: number; implemented: number; implementedRefused: number; promoted: number; queueExitsResolved: number; replayed: number; skippedNoLiveCard: number; stillOpen: number; transitioned: number }',
  },
  'reconcile-github-billed': {
    file: 'lib/jobs/definitions/ciMinutesReconcile.ts',
    shape:
      '{ discrepancies: Array<{ driftMinutes: number; exceedsTolerance: boolean; meteredMinutes: number; repoName: string; reportedMinutes: number }>; month: number; org: string; outcome: "reconciled"; repos: Array<{ driftMinutes: number; exceedsTolerance: boolean; meteredMinutes: number; repoName: string; reportedMinutes: number }>; year: number } | { outcome: "skipped"; reason: "metering_disabled" | "no_billing_credential" }',
  },
  'send-due-org-deletion-reminders': {
    file: 'lib/jobs/definitions/organizationDeletionReminders.ts',
    shape: '{ remindersSent: number }',
  },
  'refresh-certificates': {
    file: 'lib/jobs/definitions/publicAddressCertificateRefresh.ts',
    shape: '{ changed: number; failed: number; scanned: number; skipped: "not-configured" | null }',
  },
  'close-expired-staff-sessions': {
    file: 'lib/jobs/definitions/impersonationExpirySweep.ts',
    shape: '{ closed: number; scanned: number }',
  },
  'raise-awaiting-reply-planning-sessions': {
    file: 'lib/jobs/definitions/planTargetLockSweep.ts',
    // Added by MOTIR-7913: the lock sweep marks and gates a conversation the person left
    // waiting on the planner's reply, ahead of the idle close.
    shape: '{ raised: number; sessionIds: Array<string> }',
  },
  'close-idle-planning-sessions': {
    file: 'lib/jobs/definitions/planTargetLockSweep.ts',
    // Added by MOTIR-7638 (AMENDMENT 23 §2): the lock sweep closes an idle
    // session before it releases expired leases.
    shape: '{ closed: number; sessionIds: Array<string> }',
  },
  'release-lapsed-plan-revisions': {
    file: 'lib/jobs/definitions/planTargetLockSweep.ts',
    // Added by MOTIR-8208: a revision re-opens its plan to `generating`, so the lock
    // sweep gives a plan whose revision lease lapsed back to `planned`.
    shape: '{ planIds: Array<string>; restored: number }',
  },
  'release-expired-planning-locks': {
    file: 'lib/jobs/definitions/planTargetLockSweep.ts',
    // `plan_awaiting_review` added by MOTIR-5647: a lock held by a plan that has
    // reached `planned` is waiting for a PERSON, not for a crashed author, so the
    // lease never expires it (AMENDMENT 16 D9). The sweep reports the skip rather
    // than walking past a selected row silently.
    //
    // `session_waiting` added by MOTIR-7912 (and `awaiting_resume` / `session_waiting`
    // on `reconcile-abandoned-plans`): a lease held by a failed-waiting or
    // awaiting-person session is spared. The ids are KEPT for the reason below — the
    // change only ADDS members, so every memo written under the old shape is still a
    // valid value of the new one.
    //
    // `rested` added by MOTIR-6066: a target the plan ADOPTED from a hand-park
    // has no prior status to restore, so the sweep rests it at `todo` /
    // `blocked` instead (AMENDMENT 16 D8 as amended). The id is KEPT, not
    // bumped, for the reason this file gives for a step with an external
    // effect: the step RELEASES LOCKS, so a new id would re-run it on a resumed
    // run. And the replayed value is already safe at the boundary — the change
    // only ADDS a member, so every memo written under the old shape is a valid
    // value of the new one, and the handler returns it without reading it.
    //
    // `plan_generating` added by MOTIR-9260: a session-held lock whose session has a
    // `generating` plan that wrote within `PLAN_STALLED_AFTER_MS` is a live walk, so
    // it is spared. Id KEPT for the same reason — the change only ADDS a member.
    shape:
      '{ entries: Array<{ outcome: "left_as_is" | "plan_awaiting_review" | "plan_generating" | "rested" | "restored" | "session_waiting" | "unattributable"; workItemId: string }>; released: number }',
  },
  'resolve-target-v2': {
    file: 'lib/jobs/indexFleetSteps.ts',
    shape:
      '{ anchorProjectId: string; indexed: true; organizationId: string; providerId: "github" | "gitlab"; repoRef: string } | { indexed: false; reason: "installation_missing" | "no_projects" | "provider_cannot_index" | "workspace_missing" }',
  },
  'restore-for-revived-target': {
    file: 'lib/jobs/definitions/planDrift.ts',
    shape: '{ markedStale: Array<string>; restored: Array<string>; skipped: Array<string> }',
  },
  'resync-disabled-orgs': {
    file: 'lib/jobs/definitions/ciActionsGateSweep.ts',
    shape: '{ organizations: number; synced: number }',
  },
  // MOTIR-6340 added the OPTIONAL `planHeld` member and KEPT the id, on purpose.
  // `run-rules` has external effects — it runs each rule's actions (a transition,
  // a field write, a comment) — so bumping it would re-apply them on every run
  // resumed across the deploy. The replay is safe as it stands: a memo written
  // before the change has no `planHeld`, and absent reads as 0, which is exactly
  // what that run recorded (a held card was then counted in `failed`). Nothing
  // branches on the summary; it is surfaced on `job_run.output` only.
  // MOTIR-6396 added the OPTIONAL `orgClosing` member the same way and for the same
  // reason: absent reads as 0, and no earlier run skipped for a closing org.
  // MOTIR-6681 added the OPTIONAL `heldByMark` member the same way: absent reads as 0,
  // and no earlier run met a marked card (the rule did not exist).
  'run-rules': {
    file: 'lib/jobs/definitions/automationEngine.ts',
    shape:
      '{ deduped: number; failed: number; heldByMark?: number | undefined; matched: number; noActions: number; orgClosing?: number | undefined; planHeld?: number | undefined; skipped: boolean; succeeded: number }',
  },
  'schedule-health': {
    file: 'lib/jobs/definitions/dailyHealthCheck.ts',
    shape:
      '{ checkedAt: string; entries: Array<{ cron: string; functionId: string; judgedAgainst: null | string; lastRunAt: null | string }>; overdue: Array<{ cron: string; functionId: string; judgedAgainst: null | string; lastRunAt: null | string }> }',
  },
  // MOTIR-5873 added the OPTIONAL `skipped` member and KEPT the id, on purpose.
  // `send` has an external effect — bumping it would re-send a reset or an
  // invite on every run resumed across the deploy. The replay is safe as it
  // stands: a memo written before the change has no `skipped`, and absent reads
  // as "not skipped", which is exactly what that memo recorded (it was sent).
  // Nothing branches on the value; it is surfaced on `job_run.output` only.
  // MOTIR-6310 WIDENED `template` by one member (`ownership-transferred`) and
  // kept the id for the same reason: every memo already stored carries one of
  // the older members, which is still a member, so the replay reads true.
  // MOTIR-6921 widened it by one more (`agents-deletion-scheduled`), and MOTIR-7606
  // by its Contact-sales staff template, each for the same reason and with the same id.
  // MOTIR-9386 NARROWED it again, removing that staff template with its
  // feature, and KEPT the id: bumping would re-send every email of a resumed run.
  // A memo already stored with the removed member replays a value nothing reads —
  // `template` is surfaced on `job_run.output` only and no code branches on it.
  send: {
    file: 'lib/jobs/definitions/emailSend.ts',
    shape:
      '{ providerMessageId: null | string; skipped?: "notification_budget_exhausted" | undefined; template: "agents-deletion-scheduled" | "automation-rule-failed" | "data-export-ready" | "email-change" | "filter-subscription" | "follow-confirm" | "follow-digest" | "mention-notification" | "organization-deletion-cancelled" | "organization-deletion-reminder" | "organization-deletion-scheduled" | "organization-erased" | "ownership-transferred" | "password-reset" | "two-factor-otp" | "watcher-comment-notification" | "watcher-transition-notification" | "workspace-invite"; to: string }',
  },
  'settle-runner': {
    file: 'lib/services/ciRunnerBootService.ts',
    shape:
      '{ billableSeconds: number; bootLatencyMs: null | number; containerId: string; costUsd: string; outcome: "settled"; reason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; usage: { billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; dispatchRunId?: null | string | undefined; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "agent_instance" | "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string } } | { detail: string; outcome: "gate_deferred"; reason: "ai_plan_required" | "balance_unavailable" | "ci_credits_exhausted" | "credits_insufficient" | "fleet_ceiling" | "gate_unavailable" | "plan_cap" | "plan_unknown" | "shard_capacity" } | { detail: string; outcome: "image_unpullable" } | { detail: string; outcome: "no_runner_group" } | { detail: string; outcome: "provision_failed" } | { outcome: "already_claimed" } | { outcome: "not_configured" } | { outcome: "rate_limited"; retryAfterSeconds: null | number } | { outcome: "unknown_intent" }',
  },
  sweep: {
    file: 'lib/jobs/definitions/automationEngine.ts',
    shape: '{ deleted: number }',
  },
  'sweep-abandoned-supervisions': {
    file: 'lib/jobs/definitions/supervisionSweep.ts',
    shape: '{ scanned: number; settled: number; skipped: number }',
  },
  'repair-stranded-index-usage': {
    file: 'lib/jobs/definitions/supervisionSweep.ts',
    shape: '{ scanned: number; settled: number }',
  },
  'sweep-auto-plan-projects': {
    file: 'lib/jobs/definitions/autoPlanCadenceTick.ts',
    shape:
      '{ failed: number; fired: number; outcomes: Array<{ error: string; projectId: string; status: "failed" } | { itemKey: string; jobId: string; planId: string; projectId: string; status: "fired" } | { projectId: string; reason: "code_blind" | "no_expandable_stub" | "no_owner" | "pending_proposal" | "project_gone" | "ready_set_healthy"; status: "skipped" }>; scanned: number; skipped: number }',
  },
  // Agent instances (Story MOTIR-6860 · MOTIR-6873). The same change WIDENED the
  // fleet's workload union by `agent_instance` (MOTIR-6872), which moved eight
  // pins above in place: a widened union keeps every stored memo a member of the
  // new shape, and those steps provision or settle containers, so a bumped id
  // would re-execute them — the header's "keep the id" case. The one that GAINED
  // a key rather than a member, `index-admit`'s `census.byWorkload`, is never read
  // back by `codeGraphIndexDispatchService`, so a replayed memo without it is inert.
  'check-instance-idle': {
    file: 'lib/jobs/definitions/agentInstanceIdleCheck.ts',
    shape: '"active" | "backstop" | "idle" | "noop"',
  },
  // MOTIR-7026 — a run in the caller's agent launches through its terminal server.
  'launch-agent-run': {
    file: 'lib/jobs/definitions/agentInstanceRunLaunch.ts',
    shape: '"failed" | "launched" | "noop"',
  },
  'sweep-stale-claims': {
    file: 'lib/jobs/definitions/fleetAttribution.ts',
    shape: 'number',
  },
  'sweep-vanished-in-flight': {
    file: 'lib/jobs/definitions/fleetAttribution.ts',
    shape: 'number',
  },
  'ci-live-charge': {
    file: 'lib/jobs/definitions/ciLiveCharge.ts',
    shape:
      '{ accrued: number; containers: number; failures: number; organizations: Array<{ accruedMinutes: number; charge: string; organizationId: string }>; outcome: "ticked"; stopped: Array<string>; tickStart: string } | { outcome: "disabled" }',
  },
  'sweep-agent-terminal-tickets': {
    file: 'lib/jobs/definitions/agentInstanceSweep.ts',
    shape: '{ deleted: number }',
  },
  'sweep-lost-terminal-connections': {
    file: 'lib/jobs/definitions/agentInstanceSweep.ts',
    shape: '{ closed: number }',
  },
  'sweep-agent-plan-lapse': {
    file: 'lib/jobs/definitions/agentInstanceSweep.ts',
    shape: '{ deleted: number; errors: number; noticed: number }',
  },
  'sweep-agent-instances': {
    file: 'lib/jobs/definitions/agentInstanceSweep.ts',
    shape:
      '{ charges: { charged: number; notCharged: number; refused: number; retryable: number }; errors: number; hibernated: { backstop: number; credits: number; idle: number }; orphans: { volumes: number }; reconciled: number; rolled: number; settled: number }',
  },
  'charge-agent-instance-storage': {
    file: 'lib/jobs/definitions/agentInstanceStorageCharge.ts',
    shape:
      '{ charged: number; notCharged: number; refused: number; retryable: number; written: number }',
  },
  'reap-lapsed-runs': {
    file: 'lib/jobs/definitions/runLivenessSweep.ts',
    shape: '{ runsFailed: number; runsRacedByClose: number; runsReaped: number }',
  },
  'sweep-dispatch-runs': {
    file: 'lib/jobs/definitions/dispatchRunSweep.ts',
    shape:
      '{ bodiesCleared: number; runsFailed: number; runsRacedByClose: number; runsReaped: number; workspacesSwept: number }',
  },
  'sweep-expired-counters': {
    file: 'lib/jobs/definitions/rateLimitSweep.ts',
    shape: '{ batches: number; deleted: number }',
  },
  'sweep-expired-exports': {
    file: 'lib/jobs/definitions/dataExportExpirySweep.ts',
    shape: '{ expired: number; failed: number; scanned: number }',
  },
  'sweep-oauth-leftovers': {
    file: 'lib/jobs/definitions/oauthSweep.ts',
    shape:
      '{ accessTokens: number; authorizationCodes: number; clients: number; refreshTokens: number }',
  },
  'embed-stale-work-items': {
    file: 'lib/jobs/definitions/workItemEmbeddingSweep.ts',
    shape:
      '{ configured: boolean; embedded: number; failed: number; failedIds: Array<string>; givenUp: number; givenUpIds: Array<string>; projectsVisited: number; scanned: number; truncated: boolean }',
  },
  'sweep-standing-dead-letters': {
    file: 'lib/jobs/definitions/dlqStandingDepthSweep.ts',
    shape:
      '{ alreadyFiled: number; filed: Array<string>; qualifying: number; rearmed: number; skipped: "no-system-principal" | null; standing: number }',
  },
  'sweep-orphans': {
    file: 'lib/jobs/definitions/attachmentGc.ts',
    shape: '{ deleted: number; failed: number; scanned: number }',
  },
  'report-container': {
    file: 'lib/jobs/definitions/platformMeterReport.ts',
    shape:
      '{ containerUsageId: string; idempotent: boolean; outcome: "reported" } | { outcome: "missing" } | { outcome: "not_settled" }',
  },
  'report-storage': {
    file: 'lib/jobs/definitions/platformMeterReport.ts',
    shape:
      '{ idempotent: boolean; outcome: "reported"; storageChargeId: string } | { outcome: "missing" } | { outcome: "not_charged" }',
  },
  'sync-seat-quantity': {
    file: 'lib/jobs/definitions/billingSeatSync.ts',
    shape:
      '{ applied: boolean; outcome: "no_active_tracker_subscription" | "no_customer" | "org_not_found" | "unchanged" | "updated" }',
  },
  'watcher-fan-out': {
    file: 'lib/jobs/definitions/watcherNotify.ts',
    shape: '{ notifiedUserIds: Array<string> }',
  },
  '`recompute-parent-v5-${i}`': {
    file: 'lib/jobs/definitions/statusDerivation.ts',
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "approval_pending"; parentId: string; toStatus: string } | { outcome: "delivery_owned"; parentId: string; toStatus: string } | { outcome: "held_by_mark"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "plan_held"; parentId: string; toStatus: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
  },
  'recompute-parent-v5': {
    file: 'lib/jobs/definitions/statusDerivation.ts',
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "approval_pending"; parentId: string; toStatus: string } | { outcome: "delivery_owned"; parentId: string; toStatus: string } | { outcome: "held_by_mark"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "plan_held"; parentId: string; toStatus: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
  },
  'roll-up-parent-v5': {
    file: 'lib/jobs/definitions/statusDerivation.ts',
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "approval_pending"; parentId: string; toStatus: string } | { outcome: "delivery_owned"; parentId: string; toStatus: string } | { outcome: "held_by_mark"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "plan_held"; parentId: string; toStatus: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
  },
};

/**
 * Step ids that are out of use — and are held here so they cannot come BACK
 * carrying a different shape.
 *
 * ⚠️ THIS IS THE HALF THAT SURVIVES A REVERT. Bumping an id fixes the outage
 * only while the bump stands: revert `resolve-target-v2` to `resolve-target`
 * and the tree type-checks, the tests that know about `IndexTarget` pass, and
 * every `job_step` row written before MOTIR-4652 becomes readable again by a
 * reader that expects `anchorProjectId`. The guard refuses a retired id by
 * name, which is the only mechanism in the tree that notices.
 *
 * A retired id is never deleted from this list. The memos are still in the
 * table.
 */
export const RETIRED_STEP_IDS: Record<string, RetiredStepId> = {
  'reconcile-abandoned-plans-v2': {
    shape:
      '{ declined: number; outcomes: Array<{ outcome: "awaiting_resume"; planId: string; projectId: string; reason: "job_gone" | "job_terminal" | "lease_lapsed" | "max_age" | "silent" } | { outcome: "declined"; planId: string; projectId: string; reason: "job_gone" | "job_terminal" | "lease_lapsed" | "max_age" | "silent" } | { outcome: "left_as_is"; planId: string; projectId: string; reason: "ai_unreachable" | "job_in_flight" | "revision_held" | "row_moved" | "session_waiting" | "writing" } | { outcome: "revision_failed"; planId: string; projectId: string; reason: "job_gone" | "job_terminal" | "lease_lapsed" | "max_age" | "silent" } | { outcome: "revision_released"; planId: string; projectId: string; reason: "job_gone" | "job_terminal" | "lease_lapsed" | "max_age" | "silent" }>; scanned: number }',
    supersededBy: 'reconcile-abandoned-plans-v3',
    reason:
      'MOTIR-8304 and MOTIR-8307 added required `lostMachine` and `autoResume` members to the `awaiting_resume` outcome. A memo written under the old id lacks both; the step is an idempotent recompute from live state (an automatic resume it started has already cleared the failure, so a re-run finds nothing to resume), so re-executing it under the new id on a resumed run is safe.',
  },
  '`recompute-parent-v4-${i}`': {
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "approval_pending"; parentId: string; toStatus: string } | { outcome: "held_by_mark"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "plan_held"; parentId: string; toStatus: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
    supersededBy: '`recompute-parent-v5-${i}`',
    reason:
      'MOTIR-8327 added `delivery_owned` to the parent rollup’s outcome union (a container that delivers its own OPEN pull request keeps the review rung its CI and merge gate gave it: the backward derivation to a still-built child set stands down, recorded rather than moving the parent). A memo written under the old id carries the narrower shape; the step is an idempotent derivation, so re-executing it under the new id on a resumed run is safe.',
  },
  'recompute-parent-v4': {
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "approval_pending"; parentId: string; toStatus: string } | { outcome: "held_by_mark"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "plan_held"; parentId: string; toStatus: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
    supersededBy: 'recompute-parent-v5',
    reason:
      'MOTIR-8327 added `delivery_owned` to the parent rollup’s outcome union (a container that delivers its own OPEN pull request keeps the review rung its CI and merge gate gave it: the backward derivation to a still-built child set stands down, recorded rather than moving the parent). A memo written under the old id carries the narrower shape; the step is an idempotent derivation, so re-executing it under the new id on a resumed run is safe.',
  },
  'roll-up-parent-v4': {
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "approval_pending"; parentId: string; toStatus: string } | { outcome: "held_by_mark"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "plan_held"; parentId: string; toStatus: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
    supersededBy: 'roll-up-parent-v5',
    reason:
      'MOTIR-8327 added `delivery_owned` to the parent rollup’s outcome union (a container that delivers its own OPEN pull request keeps the review rung its CI and merge gate gave it: the backward derivation to a still-built child set stands down, recorded rather than moving the parent). A memo written under the old id carries the narrower shape; the step is an idempotent derivation, so re-executing it under the new id on a resumed run is safe.',
  },
  'reconcile-abandoned-plans': {
    shape:
      '{ declined: number; outcomes: Array<{ outcome: "awaiting_resume"; planId: string; projectId: string; reason: "job_gone" | "job_terminal" | "lease_lapsed" | "max_age" | "no_producer" } | { outcome: "declined"; planId: string; projectId: string; reason: "job_gone" | "job_terminal" | "lease_lapsed" | "max_age" | "no_producer" } | { outcome: "left_as_is"; planId: string; projectId: string; reason: "ai_unreachable" | "job_in_flight" | "no_producer_recent" | "revision_held" | "row_moved" | "session_waiting" } | { outcome: "revision_failed"; planId: string; projectId: string; reason: "job_gone" | "job_terminal" | "lease_lapsed" | "max_age" | "no_producer" } | { outcome: "revision_released"; planId: string; projectId: string; reason: "job_gone" | "job_terminal" | "lease_lapsed" | "max_age" | "no_producer" }>; scanned: number }',
    supersededBy: 'reconcile-abandoned-plans-v2',
    reason:
      'MOTIR-8132 changed the sweep’s reason members (`no_producer` → `silent`, `no_producer_recent` → `writing`) when it began judging a plan by its silence. A memo written under the old id carries members the new reader does not know; the step is an idempotent recompute from live state, so re-executing it under the new id on a resumed run is safe.',
  },
  'reap-orphaned-containers': {
    shape:
      '{ reaped: number; staleClaims: number; usages: Array<{ billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; dispatchRunId?: null | string | undefined; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "agent_instance" | "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string }> }',
    supersededBy: 'reconcile-fleet-attribution',
    reason:
      'MOTIR-6925 replaced the tag-scoped orphan reaper with the fleet-attribution reconciler, which lists every machine in the fleet organisation and matches each to a record (`docs/decisions/fleet-per-org-pool.md` §5). The `system.ci-runner-reap` job that carried this step is gone; its stale-claim half is the new `sweep-stale-claims` step.',
  },
  '`recompute-parent-v3-${i}`': {
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "approval_pending"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "plan_held"; parentId: string; toStatus: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
    supersededBy: '`recompute-parent-v4-${i}`',
    reason:
      'MOTIR-6681 added `held_by_mark` to the parent rollup’s outcome union (a MARKED parent stays finished: the backward derivation from a reopened child is refused, and recorded rather than failing the job — MOTIR-6672). A memo written under the old id carries the narrower shape; the step is an idempotent derivation, so re-executing it under the new id on a resumed run is safe.',
  },
  'recompute-parent-v3': {
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "approval_pending"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "plan_held"; parentId: string; toStatus: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
    supersededBy: 'recompute-parent-v4',
    reason:
      'MOTIR-6681 added `held_by_mark` to the parent rollup’s outcome union (a MARKED parent stays finished: the backward derivation from a reopened child is refused, and recorded rather than failing the job — MOTIR-6672). A memo written under the old id carries the narrower shape; the step is an idempotent derivation, so re-executing it under the new id on a resumed run is safe.',
  },
  'roll-up-parent-v3': {
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "approval_pending"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "plan_held"; parentId: string; toStatus: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
    supersededBy: 'roll-up-parent-v4',
    reason:
      'MOTIR-6681 added `held_by_mark` to the parent rollup’s outcome union (a MARKED parent stays finished: the backward derivation from a reopened child is refused, and recorded rather than failing the job — MOTIR-6672). A memo written under the old id carries the narrower shape; the step is an idempotent derivation, so re-executing it under the new id on a resumed run is safe.',
  },
  '`index-admit:${projectId}`': {
    shape:
      '{ admission: { admittedAt: string; detail: string; slotRef: string }; admittedAt: string; census: { byWorkload: { agent_instance: number; ci_runner: number; code_graph_index: number; hosted_agent: number }; total: number }; outcome: "admitted"; requestedAt: string } | { admission: { admittedAt: string; detail: string; slotRef: string }; admittedAt: string; outcome: "already_held"; requestedAt: string } | { admittedAt: string; detail: string; outcome: "deferred"; reason: "fleet_ceiling" | "gate_unavailable" | "index_cap" | "org_index_cap" | "org_pool" | "repo_index_in_flight"; requestedAt: string }',
    supersededBy: '`index-admit:${subject}`',
    reason:
      "MOTIR-6586 moved the three index supervision steps into `advanceIndexAttempt`, whose ids are built from the ATTEMPT'S subject (`indexAttemptSubject`) so a re-dispatched container gets memos and a `job_supervision` row of its own. Only the TEMPLATE TEXT changed: for attempt 1 the subject IS the bare `projectId`, so the runtime id is byte-identical to every memo written under this template, and a run in flight across the deploy replays them unchanged. The shape did not move. Retired rather than re-pinned because the guard keys on the text, and a template naming `${projectId}` again would be a second spelling of the same ids.",
  },
  '`index-boot:${projectId}`': {
    shape:
      '{ outcome: { billableSeconds: number; containerId: string; coreTimings?: undefined | { phasesMs: { admissionWait?: number | undefined; boot?: number | undefined; pollToDetect?: number | undefined }; totalMs?: number | undefined }; costUsd: string; failureDetail: null | string; indexMode?: "rebuild" | "sync" | undefined; outcome: "settled"; reason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; usage: { billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string }; verdict: { detail: string; exitClass: "credential_refused" | "dispatch_malformed" | "exit_unobserved" | "graph_unbuildable" | "indexed" | "never_started" | "out_of_memory" | "pointer_unrecorded" | "repo_unfetchable" | "supervision_timed_out" | "unclassified" | "upload_failed"; exitCode: null | number; indexed: boolean; redispatchable: boolean } } | { detail: string; outcome: "admission_deferred"; reason: "fleet_ceiling" | "gate_unavailable" | "index_cap" | "org_index_cap" | "org_pool" | "repo_index_in_flight" } | { detail: string; outcome: "image_unpullable" } | { detail: string; outcome: "provision_failed" } | { detail: string; outcome: "teardown_failed" }; phase: "terminal" } | { phase: "supervising"; session: { attribution: { orgId: string; projectId: string; repoFullName: string; workspaceId: string }; bootedAt: string; credentialExpiresAt: string; dispatchId: string; handle: { createdAt: string; id: string; provider: "arc" | "fake" | "fly" | "runs_on"; region: string }; repoRef: string; runId: string; slotRef: string; syncGranted?: false | true | undefined } }',
    supersededBy: '`index-boot:${subject}`',
    reason:
      "MOTIR-6586 moved the three index supervision steps into `advanceIndexAttempt`, whose ids are built from the ATTEMPT'S subject (`indexAttemptSubject`) so a re-dispatched container gets memos and a `job_supervision` row of its own. Only the TEMPLATE TEXT changed: for attempt 1 the subject IS the bare `projectId`, so the runtime id is byte-identical to every memo written under this template, and a run in flight across the deploy replays them unchanged. The shape did not move. Retired rather than re-pinned because the guard keys on the text, and a template naming `${projectId}` again would be a second spelling of the same ids.",
  },
  '`index-settle:${projectId}`': {
    shape:
      '{ billableSeconds: number; containerId: string; coreTimings?: undefined | { phasesMs: { admissionWait?: number | undefined; boot?: number | undefined; pollToDetect?: number | undefined }; totalMs?: number | undefined }; costUsd: string; failureDetail: null | string; indexMode?: "rebuild" | "sync" | undefined; outcome: "settled"; reason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; usage: { billableSeconds: number; costUsd: string; cpuKind: "performance" | "shared"; cpus: number; createdAt: Date; handleId: string; memoryMb: number; orgId: string; projectId: string; provider: "arc" | "fake" | "fly" | "runs_on"; rateEffectiveFrom: Date | null; region: string; repoFullName: null | string; slices?: Array<{ projectId: string; repoFullName: string; seconds: number; sliceRef: string }> | undefined; startedAt: Date | null; stoppedAt: Date; teardownReason: "gate_revoked" | "job_completed" | "job_timed_out" | "provision_failed" | "reaped"; terminalState: string; usdPerSecond: string; workflowJobId: null | number; workload: "ci_runner" | "code_graph_index" | "hosted_agent"; workspaceId: string }; verdict: { detail: string; exitClass: "credential_refused" | "dispatch_malformed" | "exit_unobserved" | "graph_unbuildable" | "indexed" | "never_started" | "out_of_memory" | "pointer_unrecorded" | "repo_unfetchable" | "supervision_timed_out" | "unclassified" | "upload_failed"; exitCode: null | number; indexed: boolean; redispatchable: boolean } } | { detail: string; outcome: "admission_deferred"; reason: "fleet_ceiling" | "gate_unavailable" | "index_cap" | "org_index_cap" | "org_pool" | "repo_index_in_flight" } | { detail: string; outcome: "image_unpullable" } | { detail: string; outcome: "provision_failed" } | { detail: string; outcome: "teardown_failed" }',
    supersededBy: '`index-settle:${subject}`',
    reason:
      "MOTIR-6586 moved the three index supervision steps into `advanceIndexAttempt`, whose ids are built from the ATTEMPT'S subject (`indexAttemptSubject`) so a re-dispatched container gets memos and a `job_supervision` row of its own. Only the TEMPLATE TEXT changed: for attempt 1 the subject IS the bare `projectId`, so the runtime id is byte-identical to every memo written under this template, and a run in flight across the deploy replays them unchanged. The shape did not move. Retired rather than re-pinned because the guard keys on the text, and a template naming `${projectId}` again would be a second spelling of the same ids.",
  },
  poll: {
    shape:
      '{ filed: number; pages: number; refiled: number; skipped: number; status: "failed" | "ok"; updated: number }',
    supersededBy: 'poll-v2',
    reason:
      'MOTIR-5729 added `refreshed` to the monitor poll summary — a hand-linked issue below the minimum level now gets a facts-only refresh, counted apart so `filed` keeps its meaning. A memo written under the old id carries the narrower shape. The step is the RECONCILER: it is keyed on the provider’s issue id under a unique index and a claim-or-lock, so re-executing it under the new id on a resumed run files nothing twice — which is why the answer is a bump rather than a boundary guard on the replayed value.',
  },
  'poll-v2': {
    shape:
      '{ filed: number; pages: number; refiled: number; refreshed: number; skipped: number; status: "failed" | "ok"; updated: number }',
    supersededBy: 'poll-v3',
    reason:
      'MOTIR-5983 added `evidenceBackfilled` and `enrichmentRequested` to the monitor poll summary — the poll now ends with a standing backfill sweep that reads never-read links’ evidence and requests enrichment for monitor-filed bugs the enrichment never reached, counted apart so the reconcile counts keep their meaning. A memo written under the old id carries the narrower shape. The step is the RECONCILER plus an idempotent sweep (evidence writes are conditional on the stored event, and every backfill event carries a per-link idempotency key), so re-executing it under the new id on a resumed run files and requests nothing twice — which is why the answer is a bump rather than a boundary guard on the replayed value.',
  },
  'reconcile-open-deliveries': {
    shape:
      '{ examined: number; failed: number; gone: number; replayed: number; skippedNoLiveCard: number; stillOpen: number; transitioned: number }',
    supersededBy: 'reconcile-open-deliveries-v2',
    reason:
      "MOTIR-5671 added `gatesRaised` to the reconcile summary — the sweep now repairs a card whose GATES are wrong as well as one whose merge was never heard about, and counts that separately because it is a different repair. A memo written under the old id carries the narrower shape. The step is a READ and an idempotent repair (`reconcileGatesFor` only raises what is missing, and the job is `retryPolicy: 'idempotent'`), so re-executing it under the new id on a resumed run is safe — which is why the answer is a bump rather than a boundary guard on the replayed value.",
  },
  'reconcile-open-deliveries-v2': {
    shape:
      '{ examined: number; failed: number; gatesRaised: number; gone: number; replayed: number; skippedNoLiveCard: number; stillOpen: number; transitioned: number }',
    supersededBy: 'reconcile-open-deliveries-v3',
    reason:
      'MOTIR-5838 added `promoted` to the reconcile summary — the sweep now also repairs a card whose recorded CHECK SET is wrong (a `pending` row left behind by a lost completion, which folds the pull request to `running` for ever), and counts that separately because it is a third repair, distinct from a lost merge and a missing gate. A memo written under the old id carries the narrower shape. Every limb of the step is a read or an idempotent repair — `reconcileGatesFor` only raises what is missing, the host check-set read is a read, `settlePending` is guarded on the row still reading `pending` so a second pass matches nothing, and `promoteIfCiAlreadyGreen` moves only a card at `implemented` — so re-executing it under the new id on a resumed run is safe, which is why the answer is a bump rather than a boundary guard on the replayed value.',
  },
  'reconcile-open-deliveries-v3': {
    shape:
      '{ examined: number; failed: number; gatesRaised: number; gone: number; promoted: number; replayed: number; skippedNoLiveCard: number; stillOpen: number; transitioned: number }',
    supersededBy: 'reconcile-open-deliveries-v4',
    reason:
      'MOTIR-6848 added `queueExitsResolved` to the reconcile summary — the sweep now also reads the conclusion of a standing merge-queue exit’s failing check from the host when Motir never received it, and re-settles a cancelled / timed-out one (§4 SIXTH AMENDMENT). A memo written under the old id carries the narrower shape. The new limb is a read plus writes guarded on the conclusion still being null and a re-settle that re-judges to the same answer on a second call, so re-executing the step under the new id on a resumed run is safe — which is why the answer is a bump rather than a boundary guard on the replayed value.',
  },
  'reconcile-open-deliveries-v4': {
    shape:
      '{ examined: number; failed: number; gatesRaised: number; gone: number; promoted: number; queueExitsResolved: number; replayed: number; skippedNoLiveCard: number; stillOpen: number; transitioned: number }',
    supersededBy: 'reconcile-open-deliveries-v5',
    reason:
      'MOTIR-9455 added `implemented` and `implementedRefused` to the reconcile summary — the sweep now also re-syncs a still-open, non-draft pull request whose delivered card was left at `in_progress` (a run that never reported `implemented`, or an `opened` / `ready_for_review` delivery that was lost or refused), through the link-time resync, and counts the cards it lifted and the ones the sync refused. A memo written under the old id carries the narrower shape. The new limb asks only about a card still at `in_progress`, through the delivery path, which reads `noop` for a card already at `implemented` and never moves one back from In Review, so re-executing the step under the new id on a resumed run is safe — which is why the answer is a bump rather than a boundary guard on the replayed value.',
  },
  '`recompute-parent-v2-${i}`': {
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "approval_pending"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
    supersededBy: '`recompute-parent-v3-${i}`',
    reason:
      'MOTIR-6265 added `plan_held` to the parent rollup’s outcome union (the plan hold: a parent an UNDECIDED plan is rewriting is not the derivation’s to move, `agent-authored-plans.md` AMENDMENT 21 §5(b)). A memo written under the old id carries the narrower shape; the step is an idempotent derivation, so re-executing it under the new id on a resumed run is safe.',
  },
  'recompute-parent-v2': {
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "approval_pending"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
    supersededBy: 'recompute-parent-v3',
    reason:
      'MOTIR-6265 added `plan_held` to the parent rollup’s outcome union (the plan hold: a parent an UNDECIDED plan is rewriting is not the derivation’s to move, `agent-authored-plans.md` AMENDMENT 21 §5(b)). A memo written under the old id carries the narrower shape; the step is an idempotent derivation, so re-executing it under the new id on a resumed run is safe.',
  },
  'roll-up-parent-v2': {
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "approval_pending"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
    supersededBy: 'roll-up-parent-v3',
    reason:
      'MOTIR-6265 added `plan_held` to the parent rollup’s outcome union (the plan hold: a parent an UNDECIDED plan is rewriting is not the derivation’s to move, `agent-authored-plans.md` AMENDMENT 21 §5(b)). A memo written under the old id carries the narrower shape; the step is an idempotent derivation, so re-executing it under the new id on a resumed run is safe.',
  },
  'roll-up-parent': {
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
    supersededBy: 'roll-up-parent-v2',
    reason:
      'MOTIR-5526 added `approval_pending` to the parent rollup’s outcome union (the approval-gate guard refuses a derivation that would take `approved` or `done` from its writer while a pull request is open). A memo written under the old id carries the narrower shape; the step is an idempotent derivation, so re-executing it under the new id on a resumed run is safe.',
  },
  'recompute-parent': {
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
    supersededBy: 'recompute-parent-v2',
    reason:
      'MOTIR-5526 added `approval_pending` to the parent rollup’s outcome union (the approval-gate guard refuses a derivation that would take `approved` or `done` from its writer while a pull request is open). A memo written under the old id carries the narrower shape; the step is an idempotent derivation, so re-executing it under the new id on a resumed run is safe.',
  },
  '`recompute-parent-${i}`': {
    shape:
      '{ outcome: "access_denied"; parentId: string } | { outcome: "already_there"; parentId: string; toStatus: string } | { outcome: "illegal_transition"; parentId: string; toStatus: string } | { outcome: "no_matching_status"; parentId: string } | { outcome: "no_parent" } | { outcome: "no_rung"; parentId: string } | { outcome: "rolled_back"; parentId: string; toStatus: string } | { outcome: "rolled_up"; parentId: string; toStatus: string; via?: Array<string> | undefined } | { outcome: "same_rung"; parentId: string; toStatus: string } | { outcome: "stale_backward"; parentId: string; toStatus: string } | { outcome: "toggle_off"; parentId: string } | { outcome: "unresolvable" }',
    supersededBy: '`recompute-parent-v2-${i}`',
    reason:
      'MOTIR-5526 added `approval_pending` to the parent rollup’s outcome union (the approval-gate guard refuses a derivation that would take `approved` or `done` from its writer while a pull request is open). A memo written under the old id carries the narrower shape; the step is an idempotent derivation, so re-executing it under the new id on a resumed run is safe.',
  },
  'resolve-target': {
    shape:
      '{ indexed: false; reason: "installation_missing" | "no_projects" | "provider_cannot_index" | "workspace_missing" } | { indexed: true; organizationId: string; projectIds: Array<string>; providerId: "github" | "gitlab"; repoRef: string }',
    supersededBy: 'resolve-target-v2',
    reason:
      "MOTIR-4652 replaced `projectIds: string[]` with `anchorProjectId: string` and kept the id. A run that resumed across that deploy replayed the old row into the new reader, `JSON.stringify` dropped the absent field, and motir-ai refused the credential mint with `'coreProjectId' must be a non-empty string` — every code-graph refresh in the estate, reported as `succeeded` (MOTIR-5020).",
  },
};

/**
 * The seams that FORWARD an id rather than naming one — `ctx.step.run(id, fn)`
 * inside a `SupervisionSteps` adapter. They are not steps and have no shape of
 * their own: the ids they carry are the `index-*` / `*-runner` entries above,
 * written at the supervision's own call sites.
 *
 * Declared rather than skipped, because a scanner that silently ignores what it
 * cannot pin is a scanner whose green means nothing. A forwarding site in a
 * file that is not listed here fails the guard.
 */
export const FORWARDING_SEAMS: Record<string, string> = {
  'lib/jobs/definitions/ciRunnerFleet.ts':
    "`stepSeam` — adapts `ctx.step` to `RunnerSupervisionSteps` for `ciRunnerBootService`, whose own `steps.run('boot-runner' | 'settle-runner', …)` sites are pinned above.",
  'lib/jobs/definitions/hostedRunSupervise.ts':
    '`ctx.step` adapted to `MemoizingSteps` for `hostedRunService.supervise` (MOTIR-690), whose own `steps.run(hostedRunEndStepId(…))` site is pinned above, and which hands the same seam to `hostedAgentContainerService.advance`, whose boot / settle / charge sites are pinned above.',
  'lib/jobs/indexFleetSteps.ts':
    '`stepSeam` — adapts `ctx.step` to `SupervisionSteps` for `codeGraphIndexDispatchService`, whose own `steps.run(`index-admit:` | `index-boot:` | `index-settle:`, …)` sites are pinned above.',
};
