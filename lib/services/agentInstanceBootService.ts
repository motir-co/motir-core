import type {
  AgentInstance,
  AgentInstanceBootAttempt,
  AgentInstanceBootKind,
  AgentInstanceBootOutcome,
  AgentInstanceBootStep,
  AgentInstanceBootStepState,
  Prisma,
} from '@/generated/prisma/client';
import type { PersistentContainerStatus } from '@motir/orchestrator';
import {
  AGENT_BOOT_LEASE_MS,
  AGENT_BOOT_POLL_MS,
  INSTANCE_BOOT_DEADLINE_MS,
} from '@/lib/agentInstances/config';
import {
  mintProjectReadCredentials,
  revokeInstanceCloneCredential,
  type InstanceCloneCredential,
} from '@/lib/github/runGitCredential';
import type { AgentInstanceBootDto, AgentInstanceBootStepFrameDto } from '@/lib/dto/agentInstances';
import type { AgentInstanceBootData } from '@/lib/jobs/types';
import {
  toAgentInstanceBootDto,
  toAgentInstanceBootStepDto,
} from '@/lib/mappers/agentInstanceMappers';
import {
  agentInstanceBootRepository,
  type AgentInstanceBootStepCreateInput,
} from '@/lib/repositories/agentInstanceBootRepository';
import { agentInstanceIntervalRepository } from '@/lib/repositories/agentInstanceIntervalRepository';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { agentInstanceClock, armIdleTimer } from '@/lib/services/agentInstanceActivityService';
import {
  agentInstanceBootSteps as steps,
  agentInstanceLifecycleService,
  type InstanceReach,
} from '@/lib/services/agentInstanceLifecycleService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE BOOT DRIVER (Story MOTIR-7393 · MOTIR-7398, `docs/decisions/agent-instances.md`
// AMENDMENT 6 §3–§4) — what advances one boot attempt of an agent from its
// `provision` row to `running` or `failed`, recording every step as it goes.
//
// ── ONE PASS ────────────────────────────────────────────────────────────────
// `advance` is one pass of the `agent-instance/boot` job. It reads the agent and
// its attempt FROM THE TOP — the step rows are the durable state, nothing is
// remembered between passes (`deferRun`'s contract) — takes or renews the lease,
// and does everything that is possible now: the machine's start, then each
// repository's clone, the probes, and the move to `running`. When it must wait
// for the machine it answers `defer`, and the job defers {@link AGENT_BOOT_POLL_MS}.
//
// ── THE LEASE ───────────────────────────────────────────────────────────────
// Only the job run holding the attempt's lease writes a step or moves the agent
// out of `starting` / `waking`. Every step write renews the lease IN ITS OWN
// TRANSACTION and is skipped when the renewal answered 0, so a pass that lost
// the lease while it was cloning writes nothing more. A pass that cannot take the
// lease exits writing nothing: somebody else is driving.
//
// ── RESUMING ────────────────────────────────────────────────────────────────
// A pass continues from the first step that is neither `done` nor `skipped`. A
// row left `in_progress` is redone — its holder died mid-step — and redoing a
// clone is safe because the clone script skips a repository whose `.git` exists.
//
// ── WHAT IT DOES NOT CHANGE ─────────────────────────────────────────────────
// The clone command, the probes, the `running` transition, the idle timer, the
// failure path (`failInstance`) and AMENDMENT 5's deadline and exit grace are
// the lifecycle's own (`agentInstanceBootSteps`). The deadline applies while the
// boot waits on the MACHINE, exactly as the old inline settle applied it: once the machine
// is running, the clone runs on the lease's bound, not the deadline's.

/** The boot event's idempotency key: one driver per attempt, a resend keyed apart. */
export function agentBootEventKey(
  instanceId: string,
  attempt: number,
  expiredLeaseAt: Date | null = null,
): string {
  const base = `agent-instance-boot:${instanceId}:${attempt}`;
  return expiredLeaseAt ? `${base}:${expiredLeaseAt.toISOString()}` : base;
}

/** An attempt as its opener holds it: its number and the event to send after commit. */
export interface AgentBootOpened {
  attempt: number;
  event: AgentInstanceBootData;
}

/** What one pass leaves the job to do. */
export type AgentBootPassVerdict = { next: 'defer'; deferUntil: Date } | { next: 'done' };

const DONE: AgentBootPassVerdict = { next: 'done' };

/** The detail a step records when its attempt was ended by a delete (§4). */
export const BOOT_STEP_DELETED = 'deleted';

const FINISHED: readonly AgentInstanceBootStepState[] = ['done', 'skipped'];

function terminalOutcome(state: AgentInstance['state']): AgentInstanceBootOutcome {
  return state === 'running' ? 'running' : state === 'deleting' ? 'deleted' : 'failed';
}

/** The machine's own start instant: its newest `start` event at or after the boot began. */
function machineStartedAt(status: PersistentContainerStatus, began: Date): Date | null {
  const starts = status.events.filter(
    (e) => e.type === 'start' && e.at.getTime() >= began.getTime(),
  );
  return starts.at(-1)?.at ?? status.startedAt ?? null;
}

/** The step write every recorded change goes through: a new `seq`, the step's fields. */
async function writeStep(
  step: AgentInstanceBootStep,
  agentInstanceId: string,
  patch: {
    state: AgentInstanceBootStepState;
    startedAt?: Date | null;
    endedAt?: Date | null;
    detail?: string | null;
  },
  tx: Prisma.TransactionClient,
): Promise<AgentInstanceBootStep> {
  const seq = (await agentInstanceBootRepository.maxSeq(agentInstanceId, tx)) + 1;
  return agentInstanceBootRepository.updateStep(step.id, { seq, ...patch }, tx);
}

/** Thrown when the lease is lost mid-pass: the pass ends, writing nothing more. */
class LeaseLost extends Error {}

/**
 * A LEASED write: renew the holder's lease and, only if it is still theirs, run
 * `write` — in ONE transaction, so a holder that lost the lease writes nothing.
 * Throws {@link LeaseLost} when the lease is no longer the holder's.
 */
async function leased<T>(
  attempt: AgentInstanceBootAttempt,
  holder: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withWorkspaceServiceContext(attempt.workspaceId, async (tx) => {
    const until = new Date(agentInstanceClock.now().getTime() + AGENT_BOOT_LEASE_MS);
    if ((await agentInstanceBootRepository.renewLease(attempt.id, holder, until, tx)) !== 1) {
      throw new LeaseLost();
    }
    return write(tx);
  });
}

/** One pass's view of the boot, and the writes it may make. */
class Pass {
  constructor(
    readonly row: AgentInstance,
    readonly attempt: AgentInstanceBootAttempt,
    readonly holder: string,
  ) {}

  /** Record a change to one step, under the lease. */
  async record(
    step: AgentInstanceBootStep,
    patch: Parameters<typeof writeStep>[2],
  ): Promise<AgentInstanceBootStep> {
    return leased(this.attempt, this.holder, (tx) => writeStep(step, this.row.id, patch, tx));
  }

  /**
   * FAIL THE BOOT ON `step` (§3): the step `failed` with `detail` and the attempt
   * closed `failed` — under the lease, in one transaction — then the agent moved
   * to `failed` through `failInstance` (interval `lost`, slot released, a run in
   * it closed first). A delete that got there first owns the agent: its move
   * already closed the attempt, so nothing here is written.
   *
   * The ONE lifecycle line it logs carries ids, states and — when the machine's
   * own state ended the boot — its provider state and exit code (MOTIR-7336: a
   * boot that ended silently cost a Fly-level read to explain). Never a credential.
   */
  async fail(
    step: AgentInstanceBootStep,
    detail: string,
    reason: string,
    machine?: PersistentContainerStatus,
  ): Promise<void> {
    const now = agentInstanceClock.now();
    await leased(this.attempt, this.holder, async (tx) => {
      await writeStep(
        step,
        this.row.id,
        { state: 'failed', startedAt: step.startedAt ?? now, endedAt: now, detail },
        tx,
      );
      await agentInstanceBootRepository.closeAttempt(
        this.attempt.id,
        { endedAt: now, outcome: 'failed' },
        tx,
      );
    });
    console.warn('[agentInstanceBoot] boot failed', {
      instanceId: this.row.id,
      attempt: this.attempt.attempt,
      state: this.row.state,
      step: step.step,
      repository: step.repository,
      ...(machine
        ? { providerState: machine.providerState, exitCode: machine.exitCode ?? null }
        : {}),
      reason,
    });
    await steps.failInstance(this.row, reason, steps.RUN_BOOT_FAILED);
  }
}

/**
 * The agent left its boot state without this driver (another path failed it, an
 * operator moved it): close the attempt with the state's outcome, failing the
 * step that was in progress with the agent's own reason.
 */
async function closeAbandoned(pass: Pass, open: AgentInstanceBootStep | undefined): Promise<void> {
  const now = agentInstanceClock.now();
  const outcome = pass.row.deletedAt ? 'deleted' : terminalOutcome(pass.row.state);
  await leased(pass.attempt, pass.holder, async (tx) => {
    if (open && open.state === 'in_progress' && outcome !== 'running') {
      await writeStep(
        open,
        pass.row.id,
        {
          state: 'failed',
          endedAt: now,
          detail:
            outcome === 'deleted' ? BOOT_STEP_DELETED : (pass.row.failureReason ?? pass.row.state),
        },
        tx,
      );
    }
    await agentInstanceBootRepository.closeAttempt(pass.attempt.id, { endedAt: now, outcome }, tx);
  });
}

/** `provision`: done once the machine exists (create) or its start was accepted (wake). */
async function advanceProvision(
  pass: Pass,
  step: AgentInstanceBootStep,
): Promise<AgentBootPassVerdict | null> {
  if (steps.handleOf(pass.row)) {
    const now = agentInstanceClock.now();
    await pass.record(step, { state: 'done', startedAt: step.startedAt ?? now, endedAt: now });
    return null;
  }
  // The opener died between its provision call and its write. The deadline bounds it.
  const now = agentInstanceClock.now().getTime();
  const began = pass.row.stateChangedAt.getTime();
  if (now - began >= INSTANCE_BOOT_DEADLINE_MS) {
    const reason = `The machine could not be created in time. Wake to try again, or delete it.`;
    await pass.fail(step, reason, reason);
    return DONE;
  }
  return { next: 'defer', deferUntil: nextPoll() };
}

/** `machine_start`: in progress until the machine reports running; failed on an exit or the deadline. */
async function advanceMachineStart(
  pass: Pass,
  step: AgentInstanceBootStep,
): Promise<AgentBootPassVerdict | null> {
  // The account the row records (MOTIR-9472); one that cannot be resolved is read
  // again next poll, and the boot's deadline bounds it.
  let route: Awaited<ReturnType<typeof steps.routeOf>>;
  try {
    route = await steps.routeOf(pass.row);
  } catch {
    return { next: 'defer', deferUntil: nextPoll() };
  }
  const { orchestrator, handle } = route;
  /* v8 ignore next -- `provision` is done only once the handle is set */
  if (!handle) return { next: 'defer', deferUntil: nextPoll() };
  let current = step;
  if (current.state === 'waiting') {
    current = await pass.record(current, {
      state: 'in_progress',
      startedAt: agentInstanceClock.now(),
    });
  }
  let status: PersistentContainerStatus;
  try {
    status = await orchestrator.describePersistent(handle);
  } catch {
    return { next: 'defer', deferUntil: nextPoll() };
  }
  if (status.state === 'gone' || status.state === 'failed') {
    const reason =
      'The machine stopped before it finished starting. Wake to try again, or delete it.';
    await pass.fail(
      current,
      `the machine is ${status.providerState || status.state}`,
      reason,
      status,
    );
    return DONE;
  }
  if (status.state !== 'running') {
    const reason = steps.bootFailureReason(pass.row, status, agentInstanceClock.now().getTime());
    if (!reason) return { next: 'defer', deferUntil: nextPoll() };
    const code = status.exitCode ?? null;
    const detail =
      status.state !== 'stopped'
        ? 'the machine did not start in time'
        : code === null
          ? 'the machine exited'
          : `exit code ${code}`;
    await pass.fail(current, detail, reason, status);
    return DONE;
  }
  const startedAt = machineStartedAt(status, pass.row.stateChangedAt);
  await leased(pass.attempt, pass.holder, async (tx) => {
    await writeStep(
      current,
      pass.row.id,
      { state: 'done', endedAt: startedAt ?? agentInstanceClock.now() },
      tx,
    );
    // §5 of the decision: the interval's start is Fly's, where Fly attests it.
    const open = await agentInstanceIntervalRepository.findOpen(pass.row.id, tx);
    if (open && startedAt && startedAt > open.startedAt) {
      await agentInstanceIntervalRepository.correctStart(open.id, startedAt, tx);
    }
  });
  return null;
}

function nextPoll(): Date {
  return new Date(agentInstanceClock.now().getTime() + AGENT_BOOT_POLL_MS);
}

/**
 * The `clone` rows still to do, ONE exec per repository (§1). The credentials
 * are minted once per installation for this pass, and each is revoked after its
 * installation's last repository — or when the pass ends some other way.
 */
async function advanceClones(
  pass: Pass,
  pending: AgentInstanceBootStep[],
): Promise<AgentBootPassVerdict | null> {
  // Every clone is an exec through the instance's own account (MOTIR-9473).
  let reach: InstanceReach | null;
  try {
    reach = await steps.reachOf(pass.row);
  } catch {
    return { next: 'defer', deferUntil: nextPoll() };
  }
  /* v8 ignore next -- the machine started, so the handle is set */
  if (!reach) return { next: 'defer', deferUntil: nextPoll() };
  let credentials: InstanceCloneCredential[];
  try {
    credentials = await mintProjectReadCredentials(pass.row.projectId, pass.row.workspaceId);
  } catch (err) {
    const detail = steps.describeError(err);
    await pass.fail(
      pending[0]!,
      detail,
      `The project’s repositories could not be cloned: ${detail}`,
    );
    return DONE;
  }
  const tokenOf = new Map<string, InstanceCloneCredential>();
  for (const credential of credentials) {
    for (const repository of credential.repositories) tokenOf.set(repository, credential);
  }
  const lastUse = new Map<InstanceCloneCredential, AgentInstanceBootStep>();
  for (const step of pending) {
    const credential = step.repository ? tokenOf.get(step.repository) : undefined;
    if (credential) lastUse.set(credential, step);
  }
  const revoked = new Set<InstanceCloneCredential>();
  const revoke = async (credential: InstanceCloneCredential) => {
    if (revoked.has(credential)) return;
    revoked.add(credential);
    await revokeInstanceCloneCredential(credential.token);
  };
  try {
    for (const step of pending) {
      const credential = step.repository ? tokenOf.get(step.repository) : undefined;
      if (!credential || !step.repository) {
        // Disconnected from the project since the attempt opened: nothing to clone.
        await pass.record(step, {
          state: 'skipped',
          endedAt: agentInstanceClock.now(),
          detail: 'no longer connected to the project',
        });
        continue;
      }
      const running = await pass.record(step, {
        state: 'in_progress',
        startedAt: agentInstanceClock.now(),
        endedAt: null,
        detail: null,
      });
      let failed: string | null;
      try {
        failed = await steps.cloneRepository(reach, step.repository, credential.token);
      } catch (err) {
        failed = steps.describeError(err);
      }
      if (lastUse.get(credential) === step) await revoke(credential);
      if (failed) {
        await pass.fail(
          running,
          failed,
          `The project’s repositories could not be cloned: cloning ${step.repository} failed: ${failed}`,
        );
        return DONE;
      }
      await pass.record(running, { state: 'done', endedAt: agentInstanceClock.now() });
    }
  } finally {
    for (const credential of credentials) await revoke(credential);
  }
  return null;
}

/** `terminal_check`: the probes, `done` with the terminal's answer — `skipped` with the terminal off. */
async function advanceTerminalCheck(pass: Pass, step: AgentInstanceBootStep): Promise<void> {
  // The probes go to the instance's own account (MOTIR-9473); one that cannot be
  // resolved skips the check, as a probe that could not run does.
  const reach = steps.isTerminalOnQuietly()
    ? await steps.reachOf(pass.row).catch(() => null)
    : null;
  if (!reach) {
    await pass.record(step, { state: 'skipped', endedAt: agentInstanceClock.now() });
    return;
  }
  const running = await pass.record(step, {
    state: 'in_progress',
    startedAt: agentInstanceClock.now(),
    endedAt: null,
    detail: null,
  });
  await steps.probeTerminalServer(pass.row, reach);
  await steps.probeRunCapabilities(pass.row, reach);
  const probed = await steps.reload(pass.row);
  await pass.record(running, {
    state: 'done',
    endedAt: agentInstanceClock.now(),
    detail: `terminal server ${probed.terminalServer}`,
  });
}

/**
 * `ready`: the move to `running` and the attempt's close, in ONE transaction
 * under the lease — then the idle timer, exactly as the old inline settle armed it.
 */
async function advanceReady(pass: Pass, step: AgentInstanceBootStep): Promise<void> {
  const now = agentInstanceClock.now();
  const moved = await leased(pass.attempt, pass.holder, async (tx) => {
    const n =
      (await agentInstanceRepository.transition(
        pass.row.id,
        [pass.row.state],
        'running',
        now,
        { lastActivityAt: now },
        tx,
      )) === 1;
    if (!n) return false;
    await writeStep(step, pass.row.id, { state: 'done', startedAt: now, endedAt: now }, tx);
    await agentInstanceBootRepository.closeAttempt(
      pass.attempt.id,
      { endedAt: now, outcome: 'running' },
      tx,
    );
    return true;
  });
  if (moved) {
    await armIdleTimer(pass.row);
    return;
  }
  // Something else moved the agent (a delete, a failure): close on what it is now.
  const fresh = await steps.reload(pass.row);
  await closeAbandoned(new Pass(fresh, pass.attempt, pass.holder), step);
}

/** The current attempt of an agent the caller owns, with its steps — or null before any. */
async function readCurrent(
  row: AgentInstance,
): Promise<{ attempt: AgentInstanceBootAttempt; steps: AgentInstanceBootStep[] } | null> {
  return withWorkspaceServiceContext(row.workspaceId, async (tx) => {
    const attempt = await agentInstanceBootRepository.findCurrentAttempt(row.id, tx);
    if (!attempt) return null;
    return { attempt, steps: await agentInstanceBootRepository.listSteps(attempt.id, tx) };
  });
}

export const agentInstanceBootService = {
  /**
   * THE BOOT READ (AMENDMENT 6 §6): the caller's agent's CURRENT attempt, steps in
   * read-out order — `null` for an agent that never booted under the driver.
   * Owner-only, through the instance read's own gate: another member's agent, an
   * agent of another project and a missing one are all `AgentInstanceNotFoundError`.
   */
  async readBoot(
    projectKey: string,
    instanceId: string,
    ctx: ServiceContext,
  ): Promise<AgentInstanceBootDto | null> {
    const row = await agentInstanceLifecycleService.ownedInstance(projectKey, instanceId, ctx);
    const current = await readCurrent(row);
    return current ? toAgentInstanceBootDto(current.attempt, current.steps) : null;
  },

  /**
   * THE STREAM'S POLL (AMENDMENT 6 §7): the current attempt as {@link readBoot}
   * reads it, plus the steps of that attempt written after `sinceSeq`, in `seq`
   * order — the `step` frames the stream sends. Same gate as the read, except
   * that a stream already open passes `openStream`: its owner is still owed the
   * last word on an agent deleted mid-boot (the `deleted` rows and `done`), which
   * the live-only read would answer with a not-found instead.
   */
  async readBootSince(
    projectKey: string,
    instanceId: string,
    sinceSeq: number,
    ctx: ServiceContext,
    openStream = false,
  ): Promise<{ boot: AgentInstanceBootDto | null; changed: AgentInstanceBootStepFrameDto[] }> {
    const row = await agentInstanceLifecycleService.ownedInstance(
      projectKey,
      instanceId,
      ctx,
      openStream,
    );
    const current = await readCurrent(row);
    if (!current) return { boot: null, changed: [] };
    const changed = current.steps
      .filter((s) => s.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq)
      .map((s) => ({ ...toAgentInstanceBootStepDto(s), attempt: current.attempt.attempt }));
    return { boot: toAgentInstanceBootDto(current.attempt, current.steps), changed };
  },

  /**
   * OPEN A BOOT ATTEMPT (§2, §5) — the opener's write, inside the CALLER'S
   * transaction (the same one as its guarded move into `starting` / `waking`, so
   * only the winner of that move opens one). Attempt n+1, every step written:
   * `provision` in progress, the rest `waiting` — a wake's `clone` rows
   * `skipped`. Returns the event to send AFTER the transaction commits.
   */
  async start(
    row: AgentInstance,
    kind: AgentInstanceBootKind,
    tx: Prisma.TransactionClient,
  ): Promise<AgentBootOpened> {
    const now = agentInstanceClock.now();
    const current = await agentInstanceBootRepository.findCurrentAttempt(row.id, tx);
    if (current && !current.endedAt) {
      // An attempt nobody closed (a boot the deploy cut off): a new one replaces it.
      await agentInstanceBootRepository.closeAttempt(
        current.id,
        { endedAt: now, outcome: 'failed' },
        tx,
      );
    }
    const attempt = (current?.attempt ?? 0) + 1;
    const opened = await agentInstanceBootRepository.createAttempt(
      {
        workspaceId: row.workspaceId,
        organizationId: row.organizationId,
        agentInstanceId: row.id,
        attempt,
        kind,
        startedAt: now,
      },
      tx,
    );
    const repositories = (
      await projectRepoRepository.listByProject(row.projectId, row.workspaceId, tx)
    ).flatMap((r) => (r.githubRepo ? [`${r.githubRepo.owner}/${r.githubRepo.name}`] : []));
    const planned: Array<
      Pick<AgentInstanceBootStepCreateInput, 'step' | 'repository' | 'state' | 'startedAt'>
    > = [
      { step: 'provision', repository: null, state: 'in_progress', startedAt: now },
      { step: 'machine_start', repository: null, state: 'waiting', startedAt: null },
      ...repositories.map((repository) => ({
        step: 'clone' as const,
        repository,
        state: kind === 'wake' ? ('skipped' as const) : ('waiting' as const),
        startedAt: null,
      })),
      { step: 'terminal_check', repository: null, state: 'waiting', startedAt: null },
      { step: 'ready', repository: null, state: 'waiting', startedAt: null },
    ];
    const seqFrom = (await agentInstanceBootRepository.maxSeq(row.id, tx)) + 1;
    await agentInstanceBootRepository.createSteps(
      planned.map((p, ordinal) => ({
        ...p,
        workspaceId: row.workspaceId,
        bootAttemptId: opened.id,
        seq: seqFrom + ordinal,
        ordinal,
        endedAt: null,
        detail: null,
      })),
      tx,
    );
    return {
      attempt,
      event: {
        workspaceId: row.workspaceId,
        instanceId: row.id,
        attempt,
        idempotencyKey: agentBootEventKey(row.id, attempt),
      },
    };
  },

  /**
   * THE OPENER'S PROVISION WRITE (§5): `provision` done once the machine was
   * created (create) or its start accepted (wake), or `failed` with the
   * provider's words. Written before any lease exists; a failure also closes the
   * attempt `failed` — the caller fails the agent through `failInstance`.
   */
  async recordProvision(
    row: AgentInstance,
    attempt: number,
    failure: string | null,
  ): Promise<void> {
    const now = agentInstanceClock.now();
    await withWorkspaceServiceContext(row.workspaceId, async (tx) => {
      const opened = await agentInstanceBootRepository.findAttempt(row.id, attempt, tx);
      if (!opened || opened.endedAt) return;
      const provision = (await agentInstanceBootRepository.listSteps(opened.id, tx)).find(
        (s) => s.step === 'provision',
      );
      if (provision && !FINISHED.includes(provision.state)) {
        await writeStep(
          provision,
          row.id,
          failure
            ? { state: 'failed', endedAt: now, detail: failure }
            : { state: 'done', endedAt: now },
          tx,
        );
      }
      if (failure) {
        await agentInstanceBootRepository.closeAttempt(
          opened.id,
          { endedAt: now, outcome: 'failed' },
          tx,
        );
      }
    });
  },

  /**
   * DELETION CLOSES THE ATTEMPT (§4), inside the delete's own transaction: the
   * step in progress `failed` with detail `deleted`, the outcome `deleted`, the
   * lease cleared. A driver pass after it finds the attempt closed and writes
   * nothing. No attempt, or a closed one: nothing to do.
   */
  async closeForDeletion(agentInstanceId: string, tx: Prisma.TransactionClient): Promise<void> {
    const current = await agentInstanceBootRepository.findCurrentAttempt(agentInstanceId, tx);
    if (!current || current.endedAt) return;
    const now = agentInstanceClock.now();
    const open = (await agentInstanceBootRepository.listSteps(current.id, tx)).find(
      (s) => s.state === 'in_progress',
    );
    if (open) {
      await writeStep(
        open,
        agentInstanceId,
        { state: 'failed', endedAt: now, detail: BOOT_STEP_DELETED },
        tx,
      );
    }
    await agentInstanceBootRepository.closeAttempt(
      current.id,
      { endedAt: now, outcome: 'deleted' },
      tx,
    );
  },

  /**
   * ONE PASS of the boot driver (§3) for `attempt` of `instanceId`, as `holder`
   * (the job run). `done` when the boot ended, when the attempt is closed or not
   * the agent's current one, or when another holder has the lease — each of the
   * last three writing nothing. `defer` while the machine is coming up.
   */
  async advance(
    instanceId: string,
    attempt: number,
    holder: string,
  ): Promise<AgentBootPassVerdict> {
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row) return DONE;
    const now = agentInstanceClock.now();
    const opened = await withWorkspaceServiceContext(row.workspaceId, async (tx) => {
      const mine = await agentInstanceBootRepository.findAttempt(instanceId, attempt, tx);
      if (!mine || mine.endedAt) return null;
      const current = await agentInstanceBootRepository.findCurrentAttempt(instanceId, tx);
      if (!current || current.id !== mine.id) return null;
      const until = new Date(now.getTime() + AGENT_BOOT_LEASE_MS);
      const taken = await agentInstanceBootRepository.takeLease(mine.id, holder, until, now, tx);
      return taken === 1 ? mine : null;
    });
    if (!opened) return DONE;

    const pass = new Pass(row, opened, holder);
    try {
      const rows = await withWorkspaceServiceContext(row.workspaceId, (tx) =>
        agentInstanceBootRepository.listSteps(opened.id, tx),
      );
      const open = rows.find((s) => !FINISHED.includes(s.state));
      if (row.deletedAt || (row.state !== 'starting' && row.state !== 'waking')) {
        await closeAbandoned(pass, open);
        return DONE;
      }

      const provision = rows.find((s) => s.step === 'provision');
      if (provision && !FINISHED.includes(provision.state)) {
        const verdict = await advanceProvision(pass, provision);
        if (verdict) return verdict;
      }
      const machine = rows.find((s) => s.step === 'machine_start');
      if (machine && !FINISHED.includes(machine.state)) {
        const verdict = await advanceMachineStart(pass, machine);
        if (verdict) return verdict;
      }
      const clones = rows.filter((s) => s.step === 'clone' && !FINISHED.includes(s.state));
      if (clones.length > 0) {
        const verdict = await advanceClones(pass, clones);
        if (verdict) return verdict;
      }
      const terminal = rows.find((s) => s.step === 'terminal_check');
      if (terminal && !FINISHED.includes(terminal.state))
        await advanceTerminalCheck(pass, terminal);
      const ready = rows.find((s) => s.step === 'ready');
      /* v8 ignore next -- every attempt is opened with a `ready` row */
      if (!ready) return DONE;
      await advanceReady(pass, ready);
      return DONE;
    } catch (err) {
      if (err instanceof LeaseLost) return DONE;
      throw err;
    }
  },
};
