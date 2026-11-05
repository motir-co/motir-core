import type { AgentInstance, OrgFleetStopAction } from '@/generated/prisma/client';
import type {
  OrgFleetCancelRunOutcomeDTO,
  OrgFleetHibernateOutcomeDTO,
  OrgFleetStopPreviewDTO,
  OrgFleetStopResultDTO,
} from '@/lib/dto/orgFleetStop';
import { actionsRunsClient } from '@/lib/github/actionsRuns';
import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import { OrgFleetInstanceNotFoundError, OrgFleetRunNotFoundError } from '@/lib/orgFleet/errors';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { ciRunnerProvisioningIntentRepository as intents } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { orgFleetLastStopRepository } from '@/lib/repositories/orgFleetLastStopRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { agentInstanceLifecycleService } from '@/lib/services/agentInstanceLifecycleService';
import { billingService, type OrgActorInput } from '@/lib/services/billingService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { fleetStopService } from '@/lib/services/fleetStopService';
import { orgFleetNotificationService } from '@/lib/services/orgFleetNotificationService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { withSystemContext } from '@/lib/workspaces/context';

// AN ORGANISATION OWNER OR ADMIN STOPS THE ORG'S OWN FLEET WORK
// (`docs/decisions/agent-instances.md` §8 AMENDMENT 8). The org-scoped twin of
// `platformFleetStopService`: the same three stop paths, in the same order, with
// the same never-throw posture, behind Billing & plans' view gate instead of the
// platform's superadmin door, and recorded `org_admin_stop`:
//
//   1. CI — `fleetStopService.stopOrganization(org, 'org_admin_stop')` cancels the
//      org's live GitHub Actions runs on its Motir-hosted repositories, then
//      destroys its CI containers and settles their intents `org_admin_stop`.
//   2. HOSTED AGENTS — every live `hosted_agent` slot of the org names a run;
//      `hostedRunService.endHostedRun(run, 'cancelled', …)` closes it, with a
//      detail line naming the admin, and the run's supervisor tears it down.
//   3. AGENT INSTANCES — `hibernateAllForOrganization(org, 'org_admin_stop')`, so
//      a run in an agent is closed `cancelled` before its machine stops.
//
// ⚠️ WHO MAY CALL is decided HERE, never in a route or page: every method starts
// with `billingService.assertCanViewBilling` — 404 to a non-member (no existence
// leak), 403 to a plain member, 404 off a build without the fleet meter — and
// every refusal comes BEFORE the first effect.
//
// ⚠️ INDEX CONTAINERS ARE NEVER STOPPED. Indexing is not charged; the preview
// counts them so the admin sees what stays running.
//
// ⚠️ NO OTHER ORGANISATION IS TOUCHED. The reads below run under the system arm,
// which bypasses tenancy, so the `organizationId` filter in every one of them is
// the isolation. A single run or agent is acted on only when the org's own live
// list holds it; any other id is the same not-found, so ids cannot be probed.
//
// ⚠️ IT NEVER THROWS ON A PARTIAL STOP. Each path reports its failures; the only
// throws are the refusals.

const LOG = '[orgFleetStopService]';
const HOSTED_RUN_PREFIX = hostedRunDispatchId('');
/** States a hibernate leaves alone because the agent already rests. */
const RESTING: readonly AgentInstance['state'][] = ['hibernated', 'hibernating', 'failed'];

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

/** The run a `hosted_agent` slot holds, from its ref; null for a ref of another shape. */
function dispatchRunIdOf(ref: string): string | null {
  return ref.startsWith(HOSTED_RUN_PREFIX) ? ref.slice(HOSTED_RUN_PREFIX.length) || null : null;
}

/** The org's live hosted-agent runs, by the slots that hold their containers. */
async function liveHostedRuns(organizationId: string, now: Date): Promise<string[]> {
  const slots = await withSystemContext((tx) =>
    fleetInFlightSlotRepository.listLiveForOrganization(organizationId, 'hosted_agent', now, tx),
  );
  return slots.flatMap((slot) => {
    const id = dispatchRunIdOf(slot.ref);
    return id ? [id] : [];
  });
}

/** A count for the preview, or null when it could not be read — never a 0. */
async function counted(what: string, organizationId: string, read: () => Promise<number>) {
  try {
    return await read();
  } catch (err) {
    console.error(`${LOG} could not count the ${what}`, {
      organizationId,
      detail: detailOf(err),
    });
    return null;
  }
}

async function countActiveRuns(organizationId: string): Promise<number> {
  let runs = 0;
  for (const repo of await fleetStopService.listHostedRepos(organizationId)) {
    runs += (await actionsRunsClient.listActiveRuns(repo)).length;
  }
  return runs;
}

async function displayNameOf(userId: string): Promise<string | null> {
  try {
    const [user] = await userRepository.findByIds([userId]);
    return user?.name ?? null;
  } catch (err) {
    console.error(`${LOG} could not read the acting admin's name`, { detail: detailOf(err) });
    return null;
  }
}

/**
 * Record the org's newest stop for the Fleet page's "Last stopped by" line —
 * AFTER the stop's effects, best effort: a failed write is logged and never
 * changes, undoes or fails the stop. The org id is the caller's, never a row's.
 */
async function recordLastStop(
  organizationId: string,
  actorUserId: string,
  actorName: string | null,
  action: OrgFleetStopAction,
  stoppedAt: Date,
): Promise<void> {
  try {
    await withSystemContext((tx) =>
      orgFleetLastStopRepository.upsert(
        { organizationId, actorUserId, actorName, action, stoppedAt },
        tx,
      ),
    );
  } catch (err) {
    console.error(`${LOG} could not record the last stop`, {
      organizationId,
      action,
      detail: detailOf(err),
    });
  }
}

/** The close detail of a hosted run an admin cancelled — the one free-text record. */
function hostedRunDetail(name: string | null): string {
  return name ? `stopped by ${name}, an organization admin` : 'stopped by an organization admin';
}

async function endHostedRun(
  organizationId: string,
  dispatchRunId: string,
  detail: string,
): Promise<{ closed: boolean; failed: boolean }> {
  try {
    const ended = await hostedRunService.endHostedRun(dispatchRunId, 'cancelled', detail);
    return { closed: ended.closed, failed: ended.runKey === 'failed' };
  } catch (err) {
    console.error(`${LOG} could not end a hosted run`, {
      organizationId,
      dispatchRunId,
      detail: detailOf(err),
    });
    return { closed: false, failed: true };
  }
}

export const orgFleetStopService = {
  /** What Stop everything would stop now — the confirmation's counts. */
  async previewStopEverything(
    input: OrgActorInput,
    now: Date = new Date(),
  ): Promise<OrgFleetStopPreviewDTO> {
    await billingService.assertCanViewBilling(input);
    const { organizationId } = input;
    return {
      ciRuns: await counted('active CI runs', organizationId, () =>
        countActiveRuns(organizationId),
      ),
      ciContainers: await counted('CI containers', organizationId, () =>
        withSystemContext((tx) => intents.countInFlightForOrganization(organizationId, tx)),
      ),
      hostedRuns: await counted(
        'hosted runs',
        organizationId,
        async () => (await liveHostedRuns(organizationId, now)).length,
      ),
      runningAgents: await counted('running agents', organizationId, async () => {
        const rows = await withSystemContext((tx) =>
          agentInstanceRepository.listLiveForOrganization(organizationId, tx),
        );
        return rows.filter((row) => row.state === 'running').length;
      }),
      indexContainers: await counted('index containers', organizationId, async () => {
        const census = await withSystemContext((tx) =>
          fleetCeilingService.orgCensus(organizationId, now, tx),
        );
        return census.byWorkload.code_graph_index;
      }),
    };
  },

  /** Stop the org's CI, then its hosted runs, then its running agents. */
  async stopEverything(
    input: OrgActorInput,
    now: () => Date = () => new Date(),
  ): Promise<OrgFleetStopResultDTO> {
    await billingService.assertCanViewBilling(input);
    const { organizationId, actorUserId } = input;
    const stoppedByName = await displayNameOf(actorUserId);

    // ── 1 · CI: cancel the runs, then destroy the containers ─────────────────
    const ci = await fleetStopService.stopOrganization(organizationId, 'org_admin_stop', { now });

    // ── 2 · hosted-agent runs: end each; its supervisor tears the container down
    let hostedRunsEnded = 0;
    let hostedFailures = 0;
    let runs: string[] = [];
    try {
      runs = await liveHostedRuns(organizationId, now());
    } catch (err) {
      hostedFailures += 1;
      console.error(`${LOG} could not list the hosted runs`, {
        organizationId,
        detail: detailOf(err),
      });
    }
    const detail = hostedRunDetail(stoppedByName);
    for (const dispatchRunId of runs) {
      const ended = await endHostedRun(organizationId, dispatchRunId, detail);
      if (ended.closed) hostedRunsEnded += 1;
      if (ended.failed) hostedFailures += 1;
    }

    // ── 3 · agent instances: hibernate every running one ─────────────────────
    let agentsHibernated = 0;
    let agentFailures = 0;
    try {
      const agents = await agentInstanceLifecycleService.hibernateAllForOrganization(
        organizationId,
        'org_admin_stop',
      );
      agentsHibernated = agents.hibernated;
      agentFailures = agents.failures.length;
      // Each owner whose agent this stop hibernated is told (MOTIR-10368); the
      // service skips the admin's own agents and never throws.
      const at = now();
      for (const instanceId of agents.hibernatedInstanceIds) {
        await orgFleetNotificationService.notifyOwnerOfAdminHibernate({
          instanceId,
          actorUserId,
          at,
        });
      }
    } catch (err) {
      agentFailures += 1;
      console.error(`${LOG} could not hibernate the agents`, {
        organizationId,
        detail: detailOf(err),
      });
    }

    const result: OrgFleetStopResultDTO = {
      runsCancelled: ci.runsCancelled,
      ciContainersStopped: ci.containersStopped,
      hostedRunsEnded,
      agentsHibernated,
      failures: { ci: ci.failures, hosted: hostedFailures, agents: agentFailures },
      stoppedByName,
      stoppedAt: now().toISOString(),
    };
    // Only a stop that stopped something replaces the record: a second call
    // that found nothing keeps the earlier admin's line.
    const stoppedSomething =
      result.runsCancelled +
        result.ciContainersStopped +
        result.hostedRunsEnded +
        result.agentsHibernated >
      0;
    if (stoppedSomething) {
      await recordLastStop(
        organizationId,
        actorUserId,
        stoppedByName,
        'stop_everything',
        new Date(result.stoppedAt),
      );
    }
    return result;
  },

  /**
   * Cancel ONE of the org's live hosted runs, whoever started it. Any id that is
   * not one of them — another org's, an ended one, an agent's — is
   * OrgFleetRunNotFoundError.
   */
  async cancelHostedRun(
    input: OrgActorInput,
    dispatchRunId: string,
    now: Date = new Date(),
  ): Promise<OrgFleetCancelRunOutcomeDTO> {
    await billingService.assertCanViewBilling(input);
    const { organizationId, actorUserId } = input;
    if (!(await liveHostedRuns(organizationId, now)).includes(dispatchRunId)) {
      throw new OrgFleetRunNotFoundError(dispatchRunId);
    }
    const actorName = await displayNameOf(actorUserId);
    const ended = await hostedRunService.endHostedRun(
      dispatchRunId,
      'cancelled',
      hostedRunDetail(actorName),
    );
    if (ended.closed) {
      await recordLastStop(organizationId, actorUserId, actorName, 'cancel_hosted_run', now);
    }
    return { dispatchRunId, closed: ended.closed, at: now.toISOString() };
  },

  /**
   * Hibernate ONE live agent of the org, whoever owns it (§8 AMENDMENT 8). A run
   * in it is closed `cancelled` first. Any id that is not a live instance of THIS
   * org is OrgFleetInstanceNotFoundError.
   */
  async hibernateAgent(
    input: OrgActorInput,
    instanceId: string,
    now: () => Date = () => new Date(),
  ): Promise<OrgFleetHibernateOutcomeDTO> {
    await billingService.assertCanViewBilling(input);
    const { organizationId, actorUserId } = input;
    const row = await withSystemContext((tx) => agentInstanceRepository.findById(instanceId, tx));
    if (!row || row.organizationId !== organizationId || row.deletedAt) {
      throw new OrgFleetInstanceNotFoundError(instanceId);
    }
    if (RESTING.includes(row.state)) return { kind: 'already_resting', instanceId };
    if (row.state !== 'running') return { kind: 'in_motion', instanceId };

    if (!(await agentInstanceLifecycleService.beginHibernate(row.id, 'org_admin_stop'))) {
      // Another path moved it first: say where it is now, never that we did it.
      const after = await withSystemContext((tx) => agentInstanceRepository.findById(row.id, tx));
      return after && RESTING.includes(after.state)
        ? { kind: 'already_resting', instanceId }
        : { kind: 'in_motion', instanceId };
    }
    const at = now();
    await recordLastStop(
      organizationId,
      actorUserId,
      await displayNameOf(actorUserId),
      'hibernate_agent',
      at,
    );
    // ── The owner-notification point: the owner is told here, after success. ──
    await orgFleetNotificationService.notifyOwnerOfAdminHibernate({
      instanceId: row.id,
      actorUserId,
      at,
    });
    return {
      kind: 'hibernated',
      instanceId: row.id,
      ownerUserId: row.ownerId,
      actorUserId,
      at: at.toISOString(),
    };
  },
};
