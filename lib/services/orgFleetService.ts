import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import type {
  OrgFleetAgentInstanceDTO,
  OrgFleetCiJobDTO,
  OrgFleetDTO,
  OrgFleetHostedRunDTO,
  OrgFleetMotirStopDTO,
  OrgFleetPart,
  OrgFleetTilesDTO,
} from '@/lib/dto/orgFleet';
import type { FleetUseWaitingDTO } from '@/lib/dto/fleetUse';
import {
  toOrgFleetAgentInstanceDTO,
  toOrgFleetCiJobDTO,
  toOrgFleetHostedRunDTO,
  toOrgFleetMotirStopDTO,
  toOrgFleetTilesDTO,
} from '@/lib/mappers/orgFleetMappers';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { fleetMachineKillRepository } from '@/lib/repositories/fleetMachineKillRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { billingService, type OrgActorInput } from '@/lib/services/billingService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { fleetUseService } from '@/lib/services/fleetUseService';
import { bucketWaitingReasons, waitingBucketOf } from '@/lib/services/fleetUseCountsService';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE ORG FLEET READ — what one organisation runs on the fleet now, and what
// Motir itself stopped for it in the last seven days, for the Settings ›
// Organization › Fleet page. Owner or admin only.
//
// ⚠️ COMPOSE, NEVER RE-DERIVE. The tiles are `fleetUseService`'s figures; the
// live hosted runs are the slots the platform stop reads; the agents are
// `agentInstanceRepository.listLiveForOrganization`; the CI totals are the
// statements the counts service runs and each waiting job's cause is its bucket;
// the index count is `fleetCeilingService.orgCensus`. This service only joins
// names onto rows and contains failures.
//
// ⚠️ ONE ORGANISATION. Every statement is filtered by the `organizationId` the
// caller passed — the route param, after the gate — never one read off a row.
// The slot, instance, intent and kill reads run under the system arm, which
// bypasses tenancy, so that filter is the isolation; project names and card
// titles are read under each row's own workspace.
//
// ⚠️ CONTAIN EACH PART. Only the gate refuses the whole read. Each part fails to
// its own `not_read` and is logged; a failed read is never an empty list or a 0.
//
// ⚠️ A REPORT. It takes no admission lock and writes nothing.

const LOG = '[orgFleetService]';
const MOTIR_STOPS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const HOSTED_RUN_PREFIX = hostedRunDispatchId('');

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError';
}

async function contained<T extends object>(
  part: string,
  organizationId: string,
  read: () => Promise<T>,
): Promise<OrgFleetPart<T>> {
  try {
    return { kind: 'read', ...(await read()) };
  } catch (err) {
    console.error(`${LOG} could not read the organization's ${part}`, {
      organizationId,
      error: errorName(err),
    });
    return { kind: 'not_read' };
  }
}

/** The run a `hosted_agent` slot holds, from its ref; null for a ref of another shape. */
function dispatchRunIdOf(ref: string): string | null {
  return ref.startsWith(HOSTED_RUN_PREFIX) ? ref.slice(HOSTED_RUN_PREFIX.length) || null : null;
}

function groupByWorkspace<T>(
  rows: readonly T[],
  workspaceOf: (row: T) => string,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const key = workspaceOf(row);
    const list = out.get(key);
    if (list) list.push(row);
    else out.set(key, [row]);
  }
  return out;
}

/** Project names, each read under its own workspace's binding. */
async function projectNamesOf(
  rows: ReadonlyArray<{ workspaceId: string; projectId: string | null }>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const [workspaceId, group] of groupByWorkspace(rows, (row) => row.workspaceId)) {
    const ids = [...new Set(group.flatMap((row) => (row.projectId ? [row.projectId] : [])))];
    if (ids.length === 0) continue;
    const projects = await withWorkspaceServiceContext(workspaceId, (tx) =>
      projectRepository.findManyByIds(ids, tx),
    );
    for (const project of projects) names.set(project.id, project.name);
  }
  return names;
}

/** Display names only — never an email or an id. `user` carries no RLS. */
async function displayNamesOf(userIds: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  const users = await userRepository.findByIds(ids);
  return new Map(users.map((user) => [user.id, user.name]));
}

async function readTiles(input: OrgActorInput, now: Date): Promise<OrgFleetTilesDTO> {
  return toOrgFleetTilesDTO(await fleetUseService.readForOrganization(input, now));
}

async function readHostedRuns(
  organizationId: string,
  now: Date,
): Promise<{ rows: OrgFleetHostedRunDTO[] }> {
  const heads = await withSystemContext(async (tx) => {
    const slots = await fleetInFlightSlotRepository.listLiveForOrganization(
      organizationId,
      'hosted_agent',
      now,
      tx,
    );
    const ids = slots.flatMap((slot) => {
      const id = dispatchRunIdOf(slot.ref);
      return id ? [id] : [];
    });
    return dispatchRunRepository.findHeadsByIds(ids, tx);
  });
  if (heads.length === 0) return { rows: [] };

  const projectNames = await projectNamesOf(heads);
  const cards = new Map<string, { key: string; title: string | null }>();
  for (const [workspaceId, group] of groupByWorkspace(heads, (head) => head.workspaceId)) {
    const targets = await withWorkspaceServiceContext(workspaceId, (tx) =>
      dispatchRunRepository.findTargets(
        group.map((head) => head.id),
        tx,
      ),
    );
    for (const [id, target] of targets) cards.set(id, target);
  }
  const dispatchers = await displayNamesOf(heads.map((head) => head.createdById));

  const rows = [...heads]
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id))
    .map((head) =>
      toOrgFleetHostedRunDTO({
        id: head.id,
        startedAt: head.startedAt,
        projectName: projectNames.get(head.projectId) ?? null,
        card: cards.get(head.id) ?? null,
        dispatcherName: head.createdById ? (dispatchers.get(head.createdById) ?? null) : null,
      }),
    );
  return { rows };
}

async function readAgentInstances(
  organizationId: string,
): Promise<{ rows: OrgFleetAgentInstanceDTO[] }> {
  const instances = await withSystemContext((tx) =>
    agentInstanceRepository.listLiveForOrganization(organizationId, tx),
  );
  if (instances.length === 0) return { rows: [] };
  const projectNames = await projectNamesOf(instances);
  const owners = await displayNamesOf(instances.map((instance) => instance.ownerId));
  return {
    rows: instances.map((instance) =>
      toOrgFleetAgentInstanceDTO(instance, {
        ownerName: owners.get(instance.ownerId) ?? null,
        projectName: projectNames.get(instance.projectId) ?? null,
      }),
    ),
  };
}

async function readCiJobs(organizationId: string): Promise<{
  inFlight: number;
  waiting: FleetUseWaitingDTO;
  rows: OrgFleetCiJobDTO[];
}> {
  const { open, inFlight, waiting } = await withSystemContext(async (tx) => {
    const open = await ciRunnerProvisioningIntentRepository.listOpenForOrganization(
      organizationId,
      tx,
    );
    const inFlight = await ciRunnerProvisioningIntentRepository.countInFlightForOrganization(
      organizationId,
      tx,
    );
    const pending =
      await ciRunnerProvisioningIntentRepository.countPendingForOrganizationByWaitingReason(
        organizationId,
        tx,
      );
    const waiting = bucketWaitingReasons(
      pending.map((row) => ({ reason: row.waitingReason, count: row.count })),
    );
    return { open, inFlight, waiting };
  });
  const projectNames = await projectNamesOf(open);
  return {
    inFlight,
    waiting,
    rows: open.map((intent) =>
      toOrgFleetCiJobDTO(
        intent,
        intent.projectId ? (projectNames.get(intent.projectId) ?? null) : null,
        waitingBucketOf,
      ),
    ),
  };
}

async function readIndexJobs(organizationId: string, now: Date): Promise<{ running: number }> {
  const census = await withSystemContext((tx) =>
    fleetCeilingService.orgCensus(organizationId, now, tx),
  );
  return { running: census.byWorkload.code_graph_index };
}

async function readMotirStops(
  organizationId: string,
  now: Date,
): Promise<{ since: string; entries: OrgFleetMotirStopDTO[] }> {
  const since = new Date(now.getTime() - MOTIR_STOPS_WINDOW_MS);
  const kills = await withSystemContext((tx) =>
    fleetMachineKillRepository.listSinceForOrganization(organizationId, since, tx),
  );
  const entries: OrgFleetMotirStopDTO[] = [];
  for (const kill of kills) {
    const entry = toOrgFleetMotirStopDTO(kill);
    if (entry) entries.push(entry);
    else
      console.error(`${LOG} a kill row carries a reason this read does not know`, {
        organizationId,
        reason: kill.reason,
      });
  }
  return { since: since.toISOString(), entries };
}

export const orgFleetService = {
  /**
   * What the org runs on the fleet now. Owner or admin only — Billing & plans'
   * own view gate: BillingNotAvailableError off-cloud, OrganizationNotFoundError
   * for a non-member, BillingForbiddenError for a plain member, all before any
   * read.
   */
  async read(input: OrgActorInput, now = new Date()): Promise<OrgFleetDTO> {
    await billingService.assertCanViewBilling(input);
    const { organizationId } = input;
    return {
      tiles: await contained('fleet use figures', organizationId, () => readTiles(input, now)),
      hostedRuns: await contained('hosted runs', organizationId, () =>
        readHostedRuns(organizationId, now),
      ),
      agentInstances: await contained('agent instances', organizationId, () =>
        readAgentInstances(organizationId),
      ),
      ciJobs: await contained('CI jobs', organizationId, () => readCiJobs(organizationId)),
      indexJobs: await contained('index jobs', organizationId, () =>
        readIndexJobs(organizationId, now),
      ),
      motirStops: await contained('Motir stops', organizationId, () =>
        readMotirStops(organizationId, now),
      ),
    };
  },
};
