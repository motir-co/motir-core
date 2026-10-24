/**
 * Every kind of container the fleet can be running.
 *
 * ⚠️ IT LIVES HERE, IN THE PACKAGE, AND `lib/ciFleet/workloads.ts` RE-EXPORTS IT
 * (MOTIR-4299). It is the PORT'S OWN VOCABULARY — three of this file's types
 * carry a `workload` field, and every adapter tags a machine with it — so a
 * package that imported the union from the app would be a package that cannot be
 * built without the app, which is the one thing a package may not be
 * (`docs/decisions/app-shell-over-packages.md` §1 rule 2). The app's registry
 * keeps the COUNTERS, which need repositories and a transaction and could not
 * come here; it takes the union from the package instead.
 *
 * All three members are declared before two of them ship, and that is
 * deliberate: the seam has to exist before the workload does, or the workload
 * lands and the ceiling silently does not see it — exactly how the runner-only
 * ceiling stopped being a bound. The totality guard is the
 * `Record<FleetWorkloadKind, …>` in `lib/ciFleet/workloads.ts`: adding a member
 * without giving it a counter is a COMPILE error there.
 */
export type FleetWorkloadKind =
  /** MOTIR-1921/1922: one ephemeral GitHub Actions runner per queued job. */
  | 'ci_runner'
  /** MOTIR-1981/1990: one container per code-graph index run. */
  | 'code_graph_index'
  /** Epic 9: one container per hosted agent run. */
  | 'hosted_agent'
  /**
   * MOTIR-6860: one user AGENT INSTANCE while it RUNS (`docs/decisions/agent-instances.md`
   * §6). Slot-backed like `hosted_agent`; a hibernated instance holds no slot.
   * Its machines live in per-organisation instance apps, never the fleet app,
   * so the fleet reaper never sees one — the tag below names it in the console.
   */
  | 'agent_instance';

// The CONTAINER-ORCHESTRATOR PORT (Story MOTIR-1916 · MOTIR-1921) —
// `docs/decisions/ci-runner-fleet.md` §4 and §5, transcribed into the codebase
// as the seam every fleet card codes against.
//
// The ADR calls this "the single most load-bearing output: it is what makes this
// decision reversible." NO PROVIDER TYPE CROSSES THIS BOUNDARY. The webhook
// handler (MOTIR-1920), the gate (MOTIR-1922), the provisioner (this card) and
// the meter (MOTIR-1924) see `ContainerHandle` and `ContainerUsage` only — never
// a Fly Machine id, an EC2 instance type or a pod spec. `tests/ciFleet/
// orchestratorPortBoundary.test.ts` asserts that as a dependency guard rather
// than leaving it to convention, because a convention is exactly what erodes
// when a second adapter is a year away.
//
// ⚠️ THE ONE NON-OBVIOUS DECISION, AND THE POINT OF THE PORT: `teardown` and
// `reap` RETURN the usage record (§4). Metering is not a separate call a caller
// can forget — YOU CANNOT DESTROY A CONTAINER WITHOUT PRODUCING ITS COST ROW.
// That is `notes.html` #185 applied at the type level: the meter is built on a
// PHYSICAL quantity emitted by the same operation that guarantees teardown, so
// the two cannot drift, and MOTIR-1924's meter cannot be silently skipped by a
// path that tears down and returns early.

// ⚠️ THE PORT CARRIES A WORKLOAD (MOTIR-2025). It shipped with exactly one
// consumer and was shaped like it: a spec could only describe a CI runner, and a
// status could not say why a container stopped. `code-graph-index-fleet.md` §2
// makes indexing the SECOND consumer, and §11 records that an index container
// has no GitHub job at all — "no runner registers, no `runs-on` resolves, no
// `workflow_job` fires" — so it could only have filled `workflowJobId` by
// inventing a number, which would name the machine `motir-runner-<a lie>` and
// tag it as a CI runner in the Fly console and to the reaper.
//
// So the spec NAMES its workload and `workflowJobId` is nullable. The database
// was already there and already said why: `CiContainerUsage.workflowJobId` is
// `String?` with the comment "NULLABLE because only a CI container has one". The
// column anticipated this; the TypeScript did not.

/** Which implementation is behind the port. `fake` is a first-class member, not
 *  a test artifact: §4's rule 2 requires it to ship alongside the Fly adapter,
 *  because a port with one implementation has never been shown to be a port. */
export type OrchestratorProvider = 'fly' | 'aws' | 'runs_on' | 'arc' | 'fake';

/**
 * The machine class. Fixed by `ci-minutes-allowance.md` §M to be
 * Linux-2-core-EQUIVALENT — GitHub's `ubuntu-latest` on a PRIVATE repository is
 * 2 vCPU / 8 GB, and the ×1.00 multiplier is a parity PROMISE rather than a
 * measurement of whatever hardware was convenient.
 *
 * `performance`, not `shared`, is a product decision (ADR §8): the customer is
 * metered on WALL CLOCK, so a runner suffering CPU steal costs the customer more
 * billed minutes AND Motir more container-seconds — the same slowdown paid for
 * twice.
 */
export interface ContainerSize {
  readonly cpuKind: 'shared' | 'performance';
  readonly cpus: number;
  readonly memoryMb: number;
}

/** What to run. Provider-neutral: no Fly Machine config, no EC2 instance type. */
export interface ContainerSpec {
  /** Attribution, resolved BEFORE provisioning (the gate needs it too). */
  readonly orgId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repoFullName: string;
  /**
   * WHAT this container is, from the fleet's own registry
   * (`lib/ciFleet/workloads.ts`). MOTIR-1997 declared `code_graph_index` and
   * `hosted_agent` on that union BEFORE either shipped, precisely so a new
   * workload would be COUNTED rather than discovered; the same reasoning applies
   * one layer down, to how the container is NAMED and TAGGED at the provider.
   *
   * The adapter derives the machine's name and its fleet metadata from this, so
   * an index container is recognisable in the provider's console — and to
   * `reap()` — as what it actually is.
   */
  readonly workload: FleetWorkloadKind;
  /**
   * The GitHub job this container exists to serve. One job, one container.
   *
   * NULL for every workload that is not a CI runner. An index or agent container
   * is dispatched straight onto this port and never touches Actions, so there is
   * no job id to carry — and inventing one to satisfy the type would make the
   * container unattributable at the provider.
   */
  readonly workflowJobId: number | null;
  /** OCI image ref for the runner image (digest-pinned, never a tag). */
  readonly image: string;
  /** Linux-2-core-EQUIVALENT is fixed by ci-minutes-allowance.md §M. */
  readonly size: ContainerSize;
  /** Injected at boot; never baked into the image. Carries the JIT config. */
  readonly env: Readonly<Record<string, string>>;
  /** Hard kill after this many seconds, whatever the container is doing. */
  readonly timeoutSeconds: number;
  readonly region: string;
  /**
   * Gigabytes of native disk to give the container's own Docker daemon at
   * `/var/lib/docker` (MOTIR-8839). Omitted or 0 ⇒ none, and the daemon lives on
   * the container's root filesystem.
   *
   * WHY A CI RUNNER NEEDS IT: on a Fly Machine's root filesystem the daemon can
   * use neither overlay driver (both refuse the whiteout a layer that deletes a
   * file carries), so it falls back to `vfs`, which stores every layer as a full
   * copy and fills the rootfs before a `services:` job reaches its tests. A native
   * ext4 volume takes `overlay2`. The adapter owns the volume's whole life:
   * created with the container, destroyed with it, swept if it is ever left.
   */
  readonly dockerVolumeGb?: number;
}

/** An opaque, provider-agnostic reference. Persisted; survives a process restart.
 *  That persistence is what makes the reaper possible: a crashed orchestrator
 *  leaves the handle on the intent row, and the sweeper reads it back. */
export interface ContainerHandle {
  readonly provider: OrchestratorProvider;
  /** Fly Machine id; EC2 instance id; pod name. Opaque above the adapter. */
  readonly id: string;
  readonly region: string;
  readonly createdAt: Date;
  /**
   * The provider volume created for this container's Docker daemon, when its
   * spec asked for one (`dockerVolumeGb`). Carried so teardown can delete it
   * even after the container has destroyed itself. OPTIONAL on read: a handle
   * persisted before MOTIR-8839, or rebuilt from a provider listing, has none,
   * and teardown then reads the container's mounts instead.
   */
  readonly volumeId?: string;
}

/**
 * Why a container was destroyed. Recorded on the usage row, because "how did
 * this container end" is the question the fleet's operational story is made of
 * and it is unanswerable after the fact from a timestamp alone.
 */
export type TeardownReason =
  | 'job_completed'
  | 'job_timed_out'
  | 'provision_failed'
  | 'gate_revoked'
  | 'reaped'; // the orchestrator crashed; the sweeper found it

/**
 * Provider-truth status, for the reaper and for diagnostics (§4's `describe`).
 *
 * `exists: false` is a REAL answer, not an error: `auto_destroy` means the happy
 * path ends with the machine deleting itself, so "gone" is the expected terminal
 * observation rather than a failure to observe.
 */
export interface ContainerStatus {
  readonly handleId: string;
  readonly exists: boolean;
  /** The provider's own state string (`created` / `started` / `stopped` /
   *  `destroyed` on Fly). Empty when the container is already gone. */
  readonly state: string;
  /** True once the container has run and stopped, or is gone entirely. */
  readonly terminal: boolean;
  readonly createdAt: Date | null;
  readonly startedAt: Date | null;
  readonly stoppedAt: Date | null;
  /**
   * The container's own exit status, when the provider still reports one.
   *
   * ⚠️ FOR A CI RUNNER THIS CARRIED NO INFORMATION — the runner reports to
   * GitHub, so Motir never needed to know how the process ended. FOR AN INDEX
   * CONTAINER IT IS THE ENTIRE DIAGNOSTIC CHANNEL: the container writes no
   * ledger row and its logs are the operator's, so the dispatcher sees a machine
   * that stopped and a number. `motir-ai`'s indexer image spends a whole
   * taxonomy on it (`src/indexer/exitCodes.ts`: `10` CONFIG · `20` FETCH · `30`
   * BUILD · `40` UPLOAD · `41` RECORD · `50` CREDENTIAL_REFUSED · `70`
   * UNEXPECTED, every value kept below 125 so `137` stays unambiguously the
   * kernel's OOM-kill), and none of it reached Motir through a port that only
   * said `state: 'stopped'`.
   *
   * ⚠️ `null` IS A REAL ANSWER, NOT A GAP, and the consumer must treat it as its
   * own case rather than as success. `auto_destroy` means a machine may be gone
   * before anyone can read it, and a provider is not obliged to have kept the
   * exit event. "Stopped, code unknown" is a third outcome beside "exited 0" and
   * "exited 30".
   *
   * ⚠️ THE PORT DOES NOT INTERPRET THE NUMBER. Mapping `20` to "re-dispatch" and
   * `50` to "mint a fresh credential" belongs to the dispatch service; here it
   * simply becomes observable, as a plain number — never as a provider event
   * type (§4 rule 1).
   */
  readonly exitCode: number | null;
}

/**
 * The CONTAINER-SECONDS RECORD (§5) — what the cost meter consumes and what the
 * fleet's own reconciliation audits. PER RUNNER, never aggregated at write time.
 *
 * ⚠️ THE FIELDS ARE FIXED BY THE ADR, THE SCHEMA IS MOTIR-1924'S. MOTIR-1921
 * EMITS the record from `teardown` / `reap`; MOTIR-1924 persists it into
 * `ci_container_usage` — workspace-scoped, with RLS — via the sink. Keeping the
 * fields here and the table there is what stops the meter, the reconciliation
 * and the margin readout each inventing their own shape; the model's columns
 * mirror this interface one-for-one, and they have to stay that way.
 */
/**
 * WHAT A HANDLE'S SECONDS WERE SPENT ON, when one handle serves more than one
 * repo (MOTIR-3255).
 *
 * ⚠️ WHY THE PORT NEEDS A SHAPE FOR THIS AT ALL. `ContainerUsage` carries ONE
 * `projectId` and ONE `repoFullName`, and the cost meter states that its columns
 * *"mirror this interface one-for-one, and they have to stay that way."* That is
 * exact while a container serves one repo. The warm sync worker
 * (`code-graph-index-fleet.md` §16) is one machine, one ORG, many repos over its
 * life — so a handle that cannot say which project's work it did makes *"what did
 * indexing cost us for project X"* unanswerable, which is the failure MOTIR-1995
 * was filed over.
 *
 * ⚠️ AND THE ADAPTER REPORTS ONLY **WORK**. Idle is DERIVED by the meter, from the
 * handle's lifetime minus the work reported, so the reconciliation Σslices =
 * lifetime holds by construction rather than by trusting a caller to subtract.
 * There is deliberately no way to report an idle slice from out here.
 */
export interface ContainerWorkSlice {
  /**
   * The unit of work — one sync, named by the id its dispatch already carries.
   * It is the IDEMPOTENCY KEY: supervision replays, so a slice is upserted on
   * `(provider, handle, sliceRef)` and a replayed checkpoint costs nothing.
   */
  readonly sliceRef: string;
  /** Whose work it was. A slice always names a project; a null belongs to idle,
   *  which this shape cannot express. */
  readonly projectId: string;
  readonly repoFullName: string;
  /** ⚠️ ABSOLUTE-TO-DATE, never a delta — the same discipline as
   *  {@link ContainerAccrual.accruedSeconds}, and for the same reason. */
  readonly seconds: number;
}

export interface ContainerUsage {
  readonly handleId: string;
  readonly provider: OrchestratorProvider;
  readonly region: string;

  // Attribution — copied from the spec, so a row is readable without a join.
  readonly orgId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  /**
   * `owner/name`, or NULL for a handle that served an ORG rather than one repo
   * (MOTIR-3255). The null is a statement, not a gap: a warm sync worker
   * (`code-graph-index-fleet.md` §16) lives across many repos of one org, and a
   * record naming the last one it touched would read as a fact. What it served is
   * in {@link ContainerUsage.slices}.
   */
  readonly repoFullName: string | null;
  /** WHICH workload this container ran. The fleet org is SHARED — runners, index
   *  containers and Epic 9's agents all bill the same uncapped account — so a
   *  cost row that cannot say which workload it was merges three margins into
   *  one number and makes "what did indexing cost us?" unanswerable. */
  readonly workload: FleetWorkloadKind;
  /** Null for every non-CI workload; see `ContainerSpec.workflowJobId`. The
   *  `ci_container_usage.workflow_job_id` column is already `String?` for
   *  exactly this reason. */
  readonly workflowJobId: number | null;

  // The machine class actually provisioned (may differ from requested on a
  // fallback), which is why it is reported rather than assumed from the spec.
  readonly cpuKind: 'shared' | 'performance';
  readonly cpus: number;
  readonly memoryMb: number;

  // The physical quantity. Provider timestamps where available, ours otherwise.
  readonly createdAt: Date;
  readonly startedAt: Date | null; // null iff it never started (provision_failed)
  readonly stoppedAt: Date;
  readonly billableSeconds: number; // ceil(stoppedAt - startedAt); 0 when never started

  // The commercial mapping, resolved from the DATED rate table at teardown.
  readonly usdPerSecond: string; // decimal string — never a float
  readonly costUsd: string; // billableSeconds × usdPerSecond
  readonly rateEffectiveFrom: Date | null; // WHICH row was applied; null when unpriced

  readonly terminalState: string; // provider-reported
  readonly teardownReason: TeardownReason;

  /**
   * What this handle's seconds were spent on, when it served more than one repo
   * (MOTIR-3255). ABSENT for every one-container-one-repo workload, which is all
   * of them today — those rows are already exactly attributed by the fields
   * above, and an empty array would claim something different from "not
   * applicable".
   *
   * When present, `repoFullName` above is expected to be null: the handle served
   * an ORG, and naming the last repo it happened to touch would read as a fact.
   */
  readonly slices?: readonly ContainerWorkSlice[];

  /**
   * THE DISPATCH RUN this container served (MOTIR-6448) — a hosted-agent
   * container only; ABSENT for a CI runner or an index container, which serve no
   * run. It is not attribution the adapter reproduces at teardown: the caller that
   * owns the run stamps it onto the record, and the meter persists it as a pointer
   * from the usage row to the run (`docs/decisions/hosted-agent-run.md` §1).
   */
  readonly dispatchRunId?: string | null;
}

/**
 * A CHECKPOINT on a container that is STILL RUNNING (Story MOTIR-1981 ·
 * MOTIR-1995) — the same §5 record, minus the two facts only an ending supplies.
 *
 * ⚠️ WHY THE SETTLE-ONLY RECORD ABOVE IS NOT ENOUGH. `ContainerUsage` is produced
 * BY `teardown`, which is what makes the meter unskippable — and which also means
 * a container produces no row at all until it ends. That is right for a container
 * that lives minutes and wrong for one that lives hours: an Epic 9 agent container
 * spans a whole `motir run <story>`, so under teardown-only costing its entire
 * life is invisible spend against a Fly account that offers NEITHER a spending cap
 * NOR a billing alert (`ci-runner-fleet.md` §9). "We will know what it cost once it
 * stops" is not a bound; it is a bound-shaped statement about the past.
 *
 * So supervision reports what a live container has accrued so far, and teardown's
 * record RECONCILES rather than being the only write. An index container is
 * job-shaped and would not have needed this; it is built here because the meter is
 * being written once, and retrofitting it after Epic 9 ships costs a migration and
 * a period of blind spend.
 *
 * ⚠️ `accruedSeconds` IS ABSOLUTE-TO-DATE, NOT A DELTA SINCE THE LAST CHECKPOINT,
 * and that is the whole idempotency argument. Supervision runs as durable Inngest
 * steps which RE-EXECUTE on replay, so a delta-shaped report would double-count
 * every replayed poll — silently, and in the direction that overstates Motir's own
 * cost. An absolute figure makes a replay a no-op by arithmetic instead of by
 * bookkeeping: the writer subtracts what it already stored.
 *
 * There is no `startedAt: null` case here, unlike `ContainerUsage`: a container
 * that has not started has accrued nothing, so there is nothing to checkpoint.
 */
export interface ContainerAccrual {
  readonly handleId: string;
  readonly provider: OrchestratorProvider;
  readonly region: string;

  readonly orgId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  /** As {@link ContainerUsage.repoFullName} — null when the handle served an ORG. */
  readonly repoFullName: string | null;
  readonly workload: FleetWorkloadKind;
  readonly workflowJobId: number | null;

  readonly cpuKind: 'shared' | 'performance';
  readonly cpus: number;
  readonly memoryMb: number;

  readonly createdAt: Date;
  readonly startedAt: Date;
  /** When the container was OBSERVED running — the instant the rate resolves at
   *  and, on the row's first write, the period it is bucketed into. */
  readonly observedAt: Date;
  /** ceil(observedAt − startedAt). TOTAL seconds so far, never an increment. */
  readonly accruedSeconds: number;

  readonly usdPerSecond: string; // decimal string — never a float
  readonly costUsd: string; // accruedSeconds × usdPerSecond
  readonly rateEffectiveFrom: Date | null;

  /** As {@link ContainerUsage.slices} — a checkpoint attributes what the handle
   *  has served SO FAR, on the same absolute-to-date terms as `accruedSeconds`. */
  readonly slices?: readonly ContainerWorkSlice[];

  /** As {@link ContainerUsage.dispatchRunId}. */
  readonly dispatchRunId?: string | null;
}

/**
 * The port. Four operations, and the fourth is the one that makes the other
 * three survivable.
 */
export interface ContainerOrchestrator {
  readonly provider: OrchestratorProvider;

  /** Boot exactly one container. Throws a typed error; NEVER leaves an untracked
   *  container — an adapter that creates a machine and then fails must destroy it
   *  before it throws, or the reaper is the only thing standing between Motir and
   *  an invoice. */
  provision(spec: ContainerSpec): Promise<ContainerHandle>;

  /** Destroy it and RETURN what it cost. IDEMPOTENT: a second call on a destroyed
   *  container resolves without throwing, returns a row for the same `handleId`,
   *  and leaves nothing live. It does NOT promise the identical row — Fly builds
   *  a fresh one; "exactly one row per handle" is the meter's to keep
   *  (`ciFleetCostMeterService.recordContainerUsage` settles a second write as a
   *  duplicate). Idempotence is load-bearing
   *  — the `finally` path and the reaper can both reach the same container, and a
   *  throw from the second one would turn a tidy-up into an incident. */
  teardown(
    handle: ContainerHandle,
    reason: TeardownReason,
    context: UsageAttribution,
  ): Promise<ContainerUsage>;

  /** Provider-truth status, for the reaper and for diagnostics. */
  describe(handle: ContainerHandle): Promise<ContainerStatus>;

  /** The crash-safe sweeper: destroy every container this orchestrator owns that
   *  is older than `olderThan`, returning one usage record each. Called on a
   *  schedule. It queries the PROVIDER, never in-process state — the case it
   *  exists for is the process that held that state having died.
   *
   *  `spare` (MOTIR-6450) is asked FIRST, before attribution or destruction: a
   *  container it answers `true` for is left running and yields no record. It is
   *  how a legitimate long-lived container — a hosted run still holding its fleet
   *  slot, with no wall-clock limit but its own backstop — survives a sweep whose
   *  age cutoff was sized for CI jobs. Absent, nothing is spared. */
  reap(
    olderThan: Date,
    resolve: UsageAttributionResolver,
    spare?: ReapSparePredicate,
  ): Promise<ContainerUsage[]>;

  /** Destroy every Docker volume this adapter created for a container
   *  (`ContainerSpec.dockerVolumeGb`) that is attached to nothing and older than
   *  `olderThan`, and answer how many it destroyed (MOTIR-8839). The backstop for
   *  a teardown that could not delete its volume, or a process that died between
   *  creating one and booting its container. Optional: an adapter that never
   *  creates volumes has nothing to sweep. Never throws. */
  sweepOrphanedVolumes?(olderThan: Date): Promise<number>;
}

/** Whether the reaper must leave a container it found running (MOTIR-6450). A
 *  predicate that throws spares nothing it has not already answered for — the
 *  adapter treats a throw as "do not spare", because the reaper is the backstop
 *  that stops a leak billing. */
export type ReapSparePredicate = (handle: ContainerHandle) => Promise<boolean>;

/**
 * The attribution a usage row carries, threaded into `teardown` rather than
 * remembered by the adapter.
 *
 * WHY IT IS AN ARGUMENT AND NOT ADAPTER STATE: teardown must work after a
 * process restart, from nothing but the persisted handle. An adapter that
 * remembered the spec it booted would produce correct rows right up until the
 * one case the reaper exists for — a crash — and then produce unattributed ones,
 * which is precisely when attribution matters most.
 */
export interface UsageAttribution {
  readonly orgId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repoFullName: string;
  /** Threaded in for the same reason the rest of the attribution is: the reaper
   *  builds this from the PERSISTED record after a crash, and a usage row that
   *  cannot name its workload is a cost nobody can assign. */
  readonly workload: FleetWorkloadKind;
  /** Null for every non-CI workload; see `ContainerSpec.workflowJobId`. */
  readonly workflowJobId: number | null;
  readonly size: ContainerSize;
  /**
   * When the CALLER saw the container start, if it did.
   *
   * ⚠️ THIS IS NOT REDUNDANT WITH THE PROVIDER'S OWN TIMESTAMP, and the reason is
   * the happy path. `auto_destroy: true` means a successful run ends with the
   * machine DELETING ITSELF, so by the time teardown reads the provider the
   * machine — and its event log, the source of the provider-attested start
   * instant — is frequently already gone. Without a caller-observed fallback the
   * best-behaved containers would be exactly the ones that produced a
   * zero-second usage row, and Motir's own cost would read as near zero while
   * the invoice did not.
   *
   * The provider's timestamp WINS whenever it is still available (§5 prefers
   * provider-attested instants); this is the fallback, and its use is visible in
   * the row because a caller-observed start is the caller's clock.
   */
  readonly observedStartedAt: Date | null;
}

/**
 * How the reaper recovers attribution for a container it found on the provider:
 * by looking the handle up against the intent table. Returns null when nothing
 * owns it, which is itself a finding — a container Motir booted and has no record
 * of is still destroyed, and still reported.
 */
export type UsageAttributionResolver = (
  handle: ContainerHandle,
) => Promise<UsageAttribution | null>;

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENT CONTAINERS — a user agent instance (Story MOTIR-6860 · MOTIR-6869)
// ═══════════════════════════════════════════════════════════════════════════
// `docs/decisions/agent-instances.md` §1–§3 and §7. Everything above describes
// a SINGLE-USE container: booted for one job, `auto_destroy`, metered by its
// teardown, swept by `reap`. An instance is the opposite on every axis — a
// machine that outlives its process, a volume that outlives the machine, a
// `stopped` that is a resting state rather than an ending — so it gets its OWN
// half of the port rather than flags on the first half. The ephemeral half is
// unchanged: CI, indexing and the hosted agent keep `provision · teardown ·
// describe · reap` and `auto_destroy: true`.
//
// ⚠️ NO PROVIDER TYPE CROSSES THIS BOUNDARY EITHER. The handle carries opaque
// strings the caller persists (§4's record stores them) and passes back; only
// the adapter knows they are a Fly app, machine and volume.

/** What to boot for one instance (§1). */
export interface PersistentContainerSpec {
  /** The Motir organisation — the adapter derives the instance APP from it (§7). */
  readonly orgId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  /** The instance record's id — names the machine and the volume. */
  readonly instanceId: string;
  /** OCI image ref, DIGEST-pinned (§1). */
  readonly image: string;
  readonly size: ContainerSize;
  /** Injected at boot; never baked into the image. */
  readonly env: Readonly<Record<string, string>>;
  readonly region: string;
  /** The home volume's size (§3: 10 GB, fixed). */
  readonly volumeSizeGb: number;
  /** Where the volume is mounted — the image's `HOME` (§1: `/home/node`). */
  readonly mountPath: string;
  /**
   * The agent terminal's machine config (`docs/decisions/agent-terminal.md` Q2,
   * Q3, Q4, Q8 · MOTIR-6939): the main process, the public service and the
   * per-instance key. `null` boots the machine exactly as before the terminal —
   * the image's own `CMD`, no service — which is what a deployment without
   * `MOTIR_TERMINAL_MASTER_KEY` gets.
   */
  readonly terminal: PersistentTerminalConfig | null;
  /**
   * The machine's main process when {@link terminal} is null (MOTIR-7336): the
   * argv that replaces the image's `CMD` under its unchanged `ENTRYPOINT`. The
   * sandbox image's own `CMD` is an interactive shell, which exits at once with
   * no TTY, so a machine booted without a main process stops seconds after it
   * starts. Ignored when `terminal` is set — the terminal's command is the main
   * process then. Absent or null keeps the image's `CMD`.
   */
  readonly idleCommand?: readonly string[] | null;
}

/**
 * What an agent's machine needs to serve its terminal (`agent-terminal.md` Q2,
 * Q4, Q8). Policy — the command, the port, the key — is decided ABOVE the port;
 * the adapter only writes it into the provider's machine config.
 */
export interface PersistentTerminalConfig {
  /**
   * The config's version, stamped on the machine (Q8). A wake of a machine whose
   * stamp is older (or absent) rewrites the machine's config before starting it.
   */
  readonly version: number;
  /**
   * A NON-SECRET fingerprint of the key in {@link env}, stamped beside the version:
   * a machine stamped with the same version but another key id (the master key
   * was rotated) is rewritten on its next wake too (Q3's rotation rule).
   */
  readonly keyId: string;
  /**
   * The machine's main process: the argv that REPLACES the image's `CMD` under
   * its unchanged `ENTRYPOINT` (Q4), so the entrypoint still seeds the home and
   * sources the agent's config env first.
   */
  readonly command: readonly string[];
  /** Env merged over the spec's (Q3: `MOTIR_TERMINAL_KEY`). Never a user credential. */
  readonly env: Readonly<Record<string, string>>;
  /** The public service the relay dials (Q2). */
  readonly service: PersistentPublicService;
}

/**
 * One public service on the machine (Q2). `autostart` / `autostop` are literal
 * types on purpose: the provider's proxy must NEVER wake a hibernated agent
 * (that would bypass Motir's wake, its credit check and its charge) and never
 * stop one (Motir hibernates), so no caller can ask for anything else.
 */
export interface PersistentPublicService {
  readonly internalPort: number;
  readonly ports: ReadonlyArray<{ readonly port: number; readonly handlers: readonly string[] }>;
  readonly autostart: false;
  readonly autostop: 'off';
}

/** Where the relay dials ONE agent's terminal server (Q2) — the address and the routing headers. */
export interface PersistentTerminalEndpoint {
  /** `wss://…/v1/terminal` on Fly; a local `ws://` address on the fake. */
  readonly url: string;
  /** Headers the dial must carry to reach this one machine (Fly: `fly-force-instance-id`). */
  readonly headers: Readonly<Record<string, string>>;
}

/** The persistent handle (§1's table) — persisted on the instance record. */
export interface PersistentContainerHandle {
  readonly provider: OrchestratorProvider;
  /** The organisation's instance app. */
  readonly app: string;
  readonly machineId: string;
  readonly volumeId: string;
  readonly region: string;
  readonly createdAt: Date;
}

/**
 * A persistent machine's state in the INSTANCE vocabulary (§1). `stopped` is NOT
 * terminal here — it is where a hibernated instance rests — which is why this
 * does not reuse `ContainerStatus.terminal` / `isTerminalState`. `gone` means the
 * machine no longer exists (destroyed, or never found).
 */
export type PersistentContainerState =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'gone'
  | 'failed';

/** Provider-truth status of one persistent machine. */
/**
 * One entry of the machine's own lifecycle timeline (MOTIR-7396). The port does
 * not interpret it: `type` is the provider's own string ('launch' | 'start' |
 * 'exit' | 'stop' | ...), and a type this code has never seen passes through
 * as itself.
 */
export interface PersistentMachineEvent {
  readonly type: string;
  readonly status: string;
  readonly at: Date;
  /** Present on an exit event the provider attached a code to. */
  readonly exitCode?: number;
}

export interface PersistentContainerStatus {
  readonly machineId: string;
  readonly state: PersistentContainerState;
  /** The provider's own state string, for diagnostics; empty when gone. */
  readonly providerState: string;
  /**
   * The start instant of the CURRENT run — the latest `start` event, never the
   * first. A machine woken three times has three runs, and an interval is
   * measured from ITS run's start (§5), never across the hibernated hours.
   */
  readonly startedAt: Date | null;
  /** The stop instant of the current run, when it has stopped since `startedAt`. */
  readonly stoppedAt: Date | null;
  /**
   * The exit code of the machine's main process when it last EXITED on its own
   * (MOTIR-7336: a boot that ends in a stopped machine says why), or null when it
   * never exited, the provider kept no code, or the machine is gone. Absent on an
   * adapter that cannot read it.
   */
  readonly exitCode?: number | null;
  /**
   * The machine's own lifecycle events, oldest first, newest last (MOTIR-7396).
   * Empty when the machine is gone or the provider reported none.
   */
  readonly events: readonly PersistentMachineEvent[];
  /**
   * The image the machine's config names right now (`agent-image-update.md` Q6:
   * the settle of an interrupted update reads WHERE the machine is). Null when
   * the provider named none; absent when the machine is gone.
   */
  readonly image?: string | null;
}

/** Everything in one organisation's instance app — the reconcile's read (§5). */
export interface PersistentAppInventory {
  readonly app: string;
  readonly machines: ReadonlyArray<{
    readonly machineId: string;
    readonly state: PersistentContainerState;
    /** From the machine's own metadata; null when the machine carries none. */
    readonly instanceId: string | null;
    readonly createdAt: Date | null;
  }>;
  readonly volumes: ReadonlyArray<{
    readonly volumeId: string;
    readonly name: string;
    readonly attachedMachineId: string | null;
    readonly createdAt: Date | null;
  }>;
}

/**
 * The persistent half of the port (§1's table). Every operation is IDEMPOTENT on
 * its end state, because a click, a retry and the sweep can all reach the same
 * instance: stopping a stopped machine, destroying a destroyed one and reading a
 * gone one are answers, never throws.
 */
export interface PersistentContainerOrchestrator {
  readonly provider: OrchestratorProvider;

  /** The instance app an organisation's instances boot in (§7) — deterministic. */
  appNameFor(orgId: string): string;

  /** The region a new instance's machine and volume are created in (§3) — the
   *  adapter's own configuration, so no caller reads a provider variable. */
  defaultRegion(): string;

  /**
   * Ensure the organisation's app (with its own private network), create the
   * volume, then create the machine mounting it. NEVER leaves an untracked
   * volume: a machine create that fails destroys the volume it just made before
   * throwing.
   */
  provisionPersistent(spec: PersistentContainerSpec): Promise<PersistentContainerHandle>;

  /** Hibernate: stop the machine; the volume stays. Idempotent on a stopped machine. */
  stop(handle: PersistentContainerHandle): Promise<void>;

  /** Wake: start the machine — always a cold boot of the rootfs, the volume intact. */
  start(handle: PersistentContainerHandle): Promise<void>;

  describePersistent(handle: PersistentContainerHandle): Promise<PersistentContainerStatus>;

  /** Destroy the machine, THEN the volume. Idempotent; never the volume while the machine exists. */
  destroyPersistent(handle: PersistentContainerHandle): Promise<void>;

  /** Every machine and volume in one instance app. An app that does not exist is empty. */
  listPersistent(app: string): Promise<PersistentAppInventory>;

  /** Destroy one volume by id — the reconcile's orphan cleanup. Idempotent. */
  destroyVolume(app: string, volumeId: string): Promise<void>;

  /** Destroy one machine by id — the reconcile's orphan cleanup. Idempotent. */
  destroyMachine(app: string, machineId: string): Promise<void>;

  /**
   * Run ONE command inside a running machine and return its result — how the
   * lifecycle clones a project's repositories into the home (MOTIR-6872) without
   * a credential ever entering the machine's config, env or volume: the command's
   * argv is the only place it travels, for the length of one process.
   *
   * `stdin` (`agent-instance-run.md` §1, §2 — MOTIR-7026) is written to the
   * command's standard input: how a run's credential reaches the agent's run
   * launcher WITHOUT being an environment variable. (Fly's exec API drops a
   * `stdin` field, so that adapter pipes it in through a wrapper whose argv
   * carries it for the one exec — MOTIR-8872.)
   */
  exec(
    handle: PersistentContainerHandle,
    command: readonly string[],
    options?: { timeoutSeconds?: number; stdin?: string },
  ): Promise<PersistentExecResult>;

  /**
   * Bring a STOPPED machine's config up to `terminal` (`agent-terminal.md` Q8) —
   * the wake calls it before {@link start}. When the machine's stamp is newer than
   * `terminal.version`, or the same version with the same `keyId`, it changes
   * nothing (`'current'`); otherwise
   * it rewrites the main process, the service, the env and the stamp, KEEPING the
   * image digest, the volume mount and every other field, WITHOUT starting the
   * machine (`'updated'`). It also ensures the app's public addresses, which an
   * app created before the terminal lacks. Idempotent.
   */
  ensureMachineConfig(
    handle: PersistentContainerHandle,
    terminal: PersistentTerminalConfig,
  ): Promise<'updated' | 'current'>;

  /** Where the relay dials this machine's terminal server (Q2). Pure — no provider call. */
  terminalEndpoint(handle: PersistentContainerHandle): PersistentTerminalEndpoint;

  /**
   * MOVE the machine to a different image (`agent-image-update.md` Q2) — the SAME
   * machine id and volume, the mount at the home, the env, the process, the
   * services and the restart policy all kept: a read of the provider's CURRENT
   * config with ONLY its image replaced, never a config rebuilt from Motir's
   * record. `launch: true` (a running machine) lets the provider reboot it onto
   * the new image; `launch: false` (a stopped one) writes the image without
   * starting it, and the next {@link start} boots it. A provider refusal throws
   * `OrchestratorApiError` and sends no second request. Never destroys or
   * recreates anything.
   */
  moveImage(
    handle: PersistentContainerHandle,
    image: string,
    options: { launch: boolean },
  ): Promise<void>;

  /**
   * Is the coding agent alive on this STARTED machine (`agent-image-update.md`
   * Q3)? Runs the profile's liveness command through {@link exec} with a bounded
   * timeout. NEVER THROWS for a failing or slow command: a non-zero exit and a
   * timeout are answers, as is a machine that could not be asked.
   */
  checkLiveness(
    handle: PersistentContainerHandle,
    command: readonly string[],
    options?: { timeoutSeconds?: number },
  ): Promise<PersistentLivenessResult>;
}

/** What {@link PersistentContainerOrchestrator.checkLiveness} answered. */
export type PersistentLivenessResult =
  | { readonly alive: true }
  | {
      readonly alive: false;
      readonly reason: 'exit';
      readonly exitCode: number;
      readonly detail: string;
    }
  | { readonly alive: false; readonly reason: 'timeout'; readonly detail: string }
  | { readonly alive: false; readonly reason: 'unreachable'; readonly detail: string };

/** What one {@link PersistentContainerOrchestrator.exec} returned. */
export interface PersistentExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE FLEET INVENTORY — what the PROVIDER says is running (Story MOTIR-6906 ·
// MOTIR-6925, `docs/decisions/fleet-per-org-pool.md` §5)
// ═══════════════════════════════════════════════════════════════════════════
// Every read above starts from a handle Motir already holds. The attribution
// reconciler must not: the machine it exists to find is one Motir holds NO record
// of — a crashed boot, a failed teardown, a machine started by hand — so it asks
// the provider for EVERY app in the fleet organisation and EVERY machine in each,
// tagged or not, and treats Motir's own tables only as the index it attributes
// against. Metadata is carried for the alert's context and is never attribution:
// anyone holding the token can write it.

/** One machine as the provider lists it. */
export interface InventoryMachine {
  readonly app: string;
  readonly machineId: string;
  /** The machine's name, for the alert; empty when the provider gives none. */
  readonly name: string;
  /** Where it runs — part of the handle a teardown of it needs. */
  readonly region: string;
  /** The provider's state in the instance vocabulary — `gone` is a machine that
   *  no longer runs anything and is not judged. */
  readonly state: PersistentContainerState;
  /** Null when the provider omits it — such a machine cannot be aged, and is
   *  alerted rather than destroyed on a guess. */
  readonly createdAt: Date | null;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * The inventory half of the port. Both listings THROW on failure — a listing
 * error is never an empty list, because the reconciler would read "nothing is
 * running" and a leak would hide behind an outage. Both actions are IDEMPOTENT
 * on their end state, like every other action on this port.
 */
export interface FleetInventory {
  readonly provider: OrchestratorProvider;
  /** Every app in Motir's fleet organisation — including apps no record names. */
  listApps(): Promise<string[]>;
  /** Every machine in one app, tagged or not. An app that no longer exists is empty. */
  listMachines(app: string): Promise<InventoryMachine[]>;
  /** Destroy one machine, forcibly. Idempotent on one already gone. */
  destroyMachine(app: string, machineId: string): Promise<void>;
  /** Stop one machine — for a PERSISTENT machine whose record owns it but says it
   *  should be resting (§5: stopped, never destroyed). Idempotent. */
  stopMachine(app: string, machineId: string): Promise<void>;
}
