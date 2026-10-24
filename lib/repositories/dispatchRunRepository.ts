import type {
  DispatchCommand,
  DispatchRun,
  DispatchRunStatus,
  Prisma,
} from '@/generated/prisma/client';

// Single Prisma operations on `dispatch_run` — the HEADER of one CLI invocation
// (Story MOTIR-1789 · MOTIR-1791, ADR `docs/decisions/dispatch-run-record.md`).
//
// ⚠️ EVERY METHOD HERE TAKES `tx`, READS INCLUDED, and that is a deliberate
// departure from the "reads may use the `db` singleton" half of the layer rule —
// the same departure `workItemDeliveryRepository` and `workItemRepoRepository`
// make, for the same reason. Every row is gated by an RLS policy on
// `app.workspace_id`, a GUC bound by `withWorkspaceContext` on a TRANSACTION and
// by nothing else. A read through the bare singleton does not fail: it returns
// an EMPTY LIST, indistinguishable from "this project has never been run", which
// is by a wide margin the worse of the two failures. Requiring `tx` turns it
// into a type error at the call site.
//
// No business logic, no transactions, no DTO mapping — `dispatchRunService`
// (MOTIR-1792) composes these.

/** A run WITH its legs, in the run's own stored order — the read `/runs/[id]`
 *  and the ingest's own close-out both need, without a second round trip. */
export type DispatchRunWithCards = Prisma.DispatchRunGetPayload<{
  include: {
    cards: true;
    agentInstance: { select: { id: true; name: true; profileId: true } };
  };
}>;

/** A run as the INDEX reads it: the legs, plus the scope's own key. */
export type DispatchRunListRow = Prisma.DispatchRunGetPayload<{
  include: {
    cards: true;
    agentInstance: { select: { id: true; name: true; profileId: true } };
    scope: { select: { identifier: true } };
  };
}>;

/**
 * The agent a run executed in (MOTIR-7023, `agent-instance-run.md` §5), as the
 * run's reads carry it — the name and the profile the run section and the run
 * modal print. Null for every `local` / `hosted` run, and for an `instance` run
 * whose agent row was removed (`SET NULL`).
 */
export interface DispatchRunAgentInstanceRef {
  id: string;
  name: string;
  profileId: string;
}

const AGENT_INSTANCE_REF = { select: { id: true, name: true, profileId: true } } as const;

const WITH_CARDS = {
  cards: { orderBy: { position: 'asc' } },
  agentInstance: AGENT_INSTANCE_REF,
} as const;

/** The list reads only: the scope's identifier rides the same `findMany`, so the
 *  index can name a run by its target without a second query. */
const WITH_CARDS_AND_SCOPE = {
  ...WITH_CARDS,
  scope: { select: { identifier: true } },
} as const;

/** A RUNNING run in one agent — the active-run read by agent (§5). */
/**
 * An agent's LATEST run, whatever its status — My agents' "Last run" line
 * (MOTIR-7029). A bare row, not the model: the panel reads only these facts.
 */
export interface LatestDispatchRunInAgent {
  id: string;
  agentInstanceId: string;
  status: DispatchRunStatus;
  startedAt: Date;
  endedAt: Date | null;
}

/** The card a run works on, as a panel names it: its key and its title. */
export interface DispatchRunTargetCard {
  workItemKey: string;
  /** Null when the work item has since been deleted — the key the run saw stays. */
  title: string | null;
}

export interface RunningDispatchRunInAgent {
  id: string;
  agentInstanceId: string;
  projectId: string;
  command: DispatchCommand;
  startedAt: Date;
  createdById: string | null;
}

const RUNNING_IN_AGENT_SELECT = {
  id: true,
  agentInstanceId: true,
  projectId: true,
  command: true,
  startedAt: true,
  createdById: true,
} as const;

/**
 * One page of a run listing: the cap, the opaque cursor, and — for the reads
 * that offer it — the STATUS narrowing.
 *
 * `startedAt DESC, id DESC` is already a TOTAL order because `id` breaks the
 * tie, which is what makes the cursor safe: two runs opened in the same
 * millisecond cannot straddle a page boundary in an order the next call
 * disagrees with.
 */
export interface DispatchRunPage {
  take: number;
  cursor?: string | undefined;
  /** Omit for every status; a non-empty list narrows the query itself. */
  statuses?: DispatchRunStatus[] | undefined;
  /**
   * The Runs room's `mine` scope (Story MOTIR-6179 · MOTIR-6331): only runs
   * this user STARTED. Omit for every run. Applied by the QUERY, like
   * `statuses`, so a page is never shortened after the read; it rides the
   * `[projectId, startedAt]` / `[scopeWorkItemId, startedAt]` indexes.
   */
  createdById?: string | undefined;
  /**
   * A Visitor's WITHHOLDING (Story MOTIR-6170 · MOTIR-6645): a run scoped to,
   * or holding a card for, any of these work items (a private epic's
   * descendants) is not listed. Applied by the QUERY, so a page is never
   * shortened after the read. Omit for a member.
   */
  withheldWorkItemIds?: readonly string[] | undefined;
}

/** A row the active-run read matched — its `agentInstanceId` is non-null by the filter. */
function inAgent(
  row: Omit<RunningDispatchRunInAgent, 'agentInstanceId'> & { agentInstanceId: string | null },
): RunningDispatchRunInAgent {
  return { ...row, agentInstanceId: row.agentInstanceId! };
}

/** The `mine` narrowing, as a `where` fragment — empty when absent. */
function startedBy(createdById: string | undefined) {
  return createdById ? { createdById } : {};
}

/** The {@link DispatchRunPage.withheldWorkItemIds} clause, or `{}`. */
function notTouching(ids: readonly string[] | undefined): Prisma.DispatchRunWhereInput {
  if (!ids || ids.length === 0) return {};
  return {
    NOT: {
      OR: [
        { scopeWorkItemId: { in: [...ids] } },
        { cards: { some: { workItemId: { in: [...ids] } } } },
      ],
    },
  };
}

/**
 * The terminal columns, read under a row lock.
 *
 * A bare row type rather than the Prisma model, because the guard's whole job is
 * to answer ONE question — is this run already closed? — and a caller handed the
 * whole row starts deriving other things from a snapshot it only holds for the
 * length of one transaction.
 */
export interface LockedDispatchRunTerminalState {
  id: string;
  status: DispatchRun['status'];
  stopReason: DispatchRun['stopReason'];
  endedAt: Date | null;
  /** Who opened it — the heartbeat's owner check (MOTIR-6528). */
  createdById: string | null;
  /** The agent an `instance` run is running in — whose idle signal its events bump (MOTIR-7027). */
  agentInstanceId: string | null;
}

/** An open run and who started it — the holder a refused repair claim names. */
export interface RunningDispatchRunHolder {
  id: string;
  startedAt: Date;
  createdById: string | null;
  /** `hosted` when the run is a container's (a hosted repair — MOTIR-6928), else `local`. */
  origin: DispatchRun['origin'];
  /** Null when the operator's account has since been deleted (`SET NULL`). */
  createdBy: { id: string; name: string } | null;
}

/** An open run and the legs it holds among the cards asked about (MOTIR-6930). */
export interface RunningDispatchRunForItems extends RunningDispatchRunHolder {
  origin: DispatchRun['origin'];
  cards: { workItemId: string | null }[];
}

/** A run's terminal facts and its starter — the repair view's read. */
export interface LatestDispatchRun extends RunningDispatchRunHolder {
  /** Where it runs — a `hosted` repair is drawn with its run link (MOTIR-6930). */
  origin: DispatchRun['origin'];
  status: DispatchRunStatus;
  stopReason: DispatchRun['stopReason'];
  endedAt: Date | null;
}

/** What {@link dispatchRunRepository.findLatestForWorkItem} returns. */
export interface LatestRunForWorkItem {
  id: string;
  command: DispatchCommand;
  origin: DispatchRun['origin'];
  status: DispatchRunStatus;
  stopReason: DispatchRun['stopReason'];
  startedAt: Date;
  endedAt: Date | null;
  lastHeartbeatAt: Date | null;
  /** Who reports it — the lapse window `isRunAlive` applies (MOTIR-7450). */
  reportedBy: DispatchRun['reportedBy'];
  createdById: string | null;
  createdBy: { id: string; name: string } | null;
  scopeWorkItemId: string | null;
  scope: { identifier: string } | null;
  /** The leg naming the work item — empty for a scoped run's container. */
  cards: Array<{ id: string; sessionBranch: string | null }>;
}

/**
 * "The card's run" as ONE expression (MOTIR-9046): any run but a `review` that
 * holds a leg for the work item or is scoped to it. Every read of a card's
 * newest run builds its `where` from this, so the definition cannot drift.
 */
function notAReviewRunFor(workItemId: string): Prisma.DispatchRunWhereInput {
  return {
    command: { not: 'review' },
    OR: [{ scopeWorkItemId: workItemId }, { cards: { some: { workItemId } } }],
  };
}

/** What {@link dispatchRunRepository.findLatestResumeRunForWorkItem} returns (MOTIR-9046). */
export interface LatestResumeRunForWorkItem {
  id: string;
  command: DispatchCommand;
  status: DispatchRunStatus;
  startedAt: Date;
  endedAt: Date | null;
  /** The leg naming the work item — empty for a scoped run's container. */
  cards: Array<{ id: string }>;
  agentInstance: { id: string; name: string; profileId: string; ownerId: string } | null;
}

export const dispatchRunRepository = {
  /** Open a run. `tx` required — a write. */
  async create(
    data: Prisma.DispatchRunCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRun> {
    return tx.dispatchRun.create({ data });
  },

  /**
   * THE ACTIVE-RUN READ BY AGENT (MOTIR-7023, `agent-instance-run.md` §5): the
   * RUNNING run in this agent, or null. The start, Hibernate, Delete, the idle
   * check and the image update share it. At most one row can match — the partial
   * unique index `dispatch_run_agent_instance_running_key` guarantees it, and
   * serves this read (its predicate is this filter).
   */
  async findRunningByAgentInstance(
    agentInstanceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<RunningDispatchRunInAgent | null> {
    const row = await tx.dispatchRun.findFirst({
      where: { agentInstanceId, status: 'running' },
      select: RUNNING_IN_AGENT_SELECT,
    });
    return row ? inAgent(row) : null;
  },

  /**
   * {@link findRunningByAgentInstance} for a LIST of agents, in ONE query — the
   * card's agent picker asks it for every agent it offers, so a per-agent read
   * would be an N+1 on the picker. At most one row per agent (the index).
   */
  async findRunningByAgentInstances(
    agentInstanceIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<RunningDispatchRunInAgent[]> {
    if (agentInstanceIds.length === 0) return [];
    const rows = await tx.dispatchRun.findMany({
      where: { agentInstanceId: { in: [...agentInstanceIds] }, status: 'running' },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: RUNNING_IN_AGENT_SELECT,
    });
    return rows.map(inAgent);
  },

  /**
   * Each agent's LATEST run, whatever its status, in ONE query (MOTIR-7029) — the
   * My agents panel's "Last run" line after a run closes. `DISTINCT ON` keeps one
   * row per agent, newest `started_at` first (then `id`, the total order the run
   * listings use), and rides `dispatch_run_agent_instance_id_started_at_idx`. An
   * agent that never ran is absent.
   */
  async findLatestByAgentInstances(
    agentInstanceIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<LatestDispatchRunInAgent[]> {
    if (agentInstanceIds.length === 0) return [];
    return tx.$queryRaw<LatestDispatchRunInAgent[]>`
      SELECT DISTINCT ON (agent_instance_id)
        id,
        agent_instance_id AS "agentInstanceId",
        status::text AS status,
        started_at AS "startedAt",
        ended_at AS "endedAt"
      FROM dispatch_run
      WHERE agent_instance_id = ANY(${[...agentInstanceIds]}::text[])
      ORDER BY agent_instance_id, started_at DESC, id DESC
    `;
  },

  /**
   * The card each of these runs works on — its KEY and TITLE — in ONE query
   * (MOTIR-7029): a scope run's scope target, else its first leg. The My agents
   * panel names the run by both. A run with neither is absent from the map.
   */
  async findTargetCards(
    runIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, DispatchRunTargetCard>> {
    if (runIds.length === 0) return new Map();
    const rows = await tx.dispatchRun.findMany({
      where: { id: { in: [...runIds] } },
      select: {
        id: true,
        scope: { select: { identifier: true, title: true } },
        cards: {
          orderBy: { position: 'asc' },
          take: 1,
          select: { workItemKey: true, workItem: { select: { title: true } } },
        },
      },
    });
    const out = new Map<string, DispatchRunTargetCard>();
    for (const row of rows) {
      if (row.scope) {
        out.set(row.id, { workItemKey: row.scope.identifier, title: row.scope.title });
        continue;
      }
      const leg = row.cards[0];
      if (leg?.workItemKey) {
        out.set(row.id, { workItemKey: leg.workItemKey, title: leg.workItem?.title ?? null });
      }
    }
    return out;
  },

  /**
   * The card each of these runs works on, in ONE query (MOTIR-7026): a scope
   * run's scope target, else its first leg — what the "already running" refusal
   * and the card's agent picker name beside the run id. A run with neither is
   * absent from the map.
   */
  async findTargetKeys(
    runIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, string>> {
    if (runIds.length === 0) return new Map();
    const rows = await tx.dispatchRun.findMany({
      where: { id: { in: [...runIds] } },
      select: {
        id: true,
        scope: { select: { identifier: true } },
        cards: { orderBy: { position: 'asc' }, take: 1, select: { workItemKey: true } },
      },
    });
    const out = new Map<string, string>();
    for (const row of rows) {
      const key = row.scope?.identifier ?? row.cards[0]?.workItemKey ?? null;
      if (key) out.set(row.id, key);
    }
    return out;
  },

  /**
   * The card each of these runs works on — its KEY and its TITLE — in ONE query
   * (MOTIR-7028): the card's agent picker names a busy agent's work item by both
   * (`design/runs/design-notes.md` § Revision 2, the busy row). The same target
   * rule as {@link findTargetKeys}: the scope target, else the first leg. The
   * title is the work item's current one, or null for a leg whose card is gone
   * (the key survives it). A run with neither is absent from the map.
   */
  async findTargets(
    runIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, { key: string; title: string | null }>> {
    if (runIds.length === 0) return new Map();
    const rows = await tx.dispatchRun.findMany({
      where: { id: { in: [...runIds] } },
      select: {
        id: true,
        scope: { select: { identifier: true, title: true } },
        cards: {
          orderBy: { position: 'asc' },
          take: 1,
          select: { workItemKey: true, workItem: { select: { title: true } } },
        },
      },
    });
    const out = new Map<string, { key: string; title: string | null }>();
    for (const row of rows) {
      if (row.scope) {
        out.set(row.id, { key: row.scope.identifier, title: row.scope.title });
        continue;
      }
      const leg = row.cards[0];
      if (leg?.workItemKey) {
        out.set(row.id, { key: leg.workItemKey, title: leg.workItem?.title ?? null });
      }
    }
    return out;
  },

  /**
   * The id of the newest RUNNING run whose SCOPE TARGET is this work item, or
   * that holds a leg for it, or null — the run a How-to-test record is
   * attributed to (MOTIR-5331). HOW TO TEST is written onto the run target, so a
   * scoped run's close-out publish on its story must resolve to that run even
   * though the story is not one of its legs. Read server-side so an agent is
   * never asked for an id it cannot know.
   */
  async findLatestRunningIdForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await tx.dispatchRun.findFirst({
      where: {
        // A review run writes no How to test (§8.3), so it is never the record's run.
        ...notAReviewRunFor(workItemId),
        status: 'running',
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    return row?.id ?? null;
  },

  /**
   * The SCOPE of the newest RUNNING run holding a leg for one work item, or null
   * — how a dispatch prompt learns whether its item is its own run target or one
   * child of a scoped run (MOTIR-5334). A run is opened with its whole plan of
   * legs before its first dispatch, so the leg exists by the time the prompt is
   * asked for. Null when no running run carries the item, or the one that does
   * has no scope.
   */
  async findRunningScopeForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; identifier: string } | null> {
    const row = await tx.dispatchRun.findFirst({
      where: { status: 'running', cards: { some: { workItemId } } },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { scope: { select: { id: true, identifier: true } } },
    });
    return row?.scope ?? null;
  },

  /**
   * The newest RUNNING run of one COMMAND that holds a leg for this work item, with
   * the person who started it, or null — the REPAIR claim's lock read (MOTIR-5464).
   *
   * An open `fix` run IS the one-repair-at-a-time lock, so the question is asked
   * of the run table rather than of a column on the card. It is only a lock
   * because the caller holds the CARD's row lock while it asks and while it opens
   * the run that answers the next caller: two claimants serialize on the card, so
   * the second one reads the first one's committed run here.
   */
  async findRunningByCommandForWorkItem(
    workItemId: string,
    command: DispatchCommand,
    tx: Prisma.TransactionClient,
  ): Promise<RunningDispatchRunHolder | null> {
    return tx.dispatchRun.findFirst({
      where: { status: 'running', command, cards: { some: { workItemId } } },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        startedAt: true,
        createdById: true,
        origin: true,
        createdBy: { select: { id: true, name: true } },
      },
    });
  },

  /**
   * The OPEN runs of one command holding a leg for ANY of these work items, newest
   * first, each with the legs it holds among them (Story MOTIR-1626 · MOTIR-6930) —
   * the Workbench To fix page and the item page's banner read which sent-back card is
   * being repaired, and whether on the hosted agent, in ONE query for a page of rows.
   */
  async findRunningByCommandForWorkItems(
    workItemIds: readonly string[],
    command: DispatchCommand,
    tx: Prisma.TransactionClient,
  ): Promise<RunningDispatchRunForItems[]> {
    if (workItemIds.length === 0) return [];
    return tx.dispatchRun.findMany({
      where: {
        status: 'running',
        command,
        cards: { some: { workItemId: { in: [...workItemIds] } } },
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        origin: true,
        startedAt: true,
        createdById: true,
        createdBy: { select: { id: true, name: true } },
        cards: {
          where: { workItemId: { in: [...workItemIds] } },
          select: { workItemId: true },
        },
      },
    });
  },

  /**
   * The NEWEST run of one command that held a leg for this work item, in ANY
   * status, with its starter, or null — what the Development block reads to say
   * whether a repair is running, gave up, or never happened (MOTIR-5466).
   */
  async findLatestByCommandForWorkItem(
    workItemId: string,
    command: DispatchCommand,
    tx: Prisma.TransactionClient,
  ): Promise<LatestDispatchRun | null> {
    return tx.dispatchRun.findFirst({
      where: { command, cards: { some: { workItemId } } },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        origin: true,
        status: true,
        stopReason: true,
        startedAt: true,
        endedAt: true,
        createdById: true,
        createdBy: { select: { id: true, name: true } },
      },
    });
  },

  /**
   * THE LANE THIS CARD LAST RAN ON (MOTIR-700): the newest run that carried it —
   * by a leg or as a scope — with the three facts an automatic hosted re-run
   * reuses: where it executed, who started it, and which model it ran. Null when
   * the card has never been run.
   */
  async findLatestLaneForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Pick<DispatchRun, 'id' | 'origin' | 'createdById' | 'model'> | null> {
    return tx.dispatchRun.findFirst({
      where: {
        // ⚠️ NEVER A REVIEW RUN (MOTIR-1626): a review builds nothing, so it is not the
        // lane, the dispatcher or the model that produced the design being re-run.
        ...notAReviewRunFor(workItemId),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, origin: true, createdById: true, model: true },
    });
  },

  /**
   * The NEWEST run of any command but `review` that holds a leg for this work item or
   * is SCOPED to it, with everything the continue claim reads about it (MOTIR-6532): its
   * liveness columns, its starter, its scope, and the leg naming this item (none
   * for a scoped run's container). Null when the item has never been run.
   */
  async findLatestForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<LatestRunForWorkItem | null> {
    return tx.dispatchRun.findFirst({
      where: {
        // ⚠️ NEVER A REVIEW RUN (MOTIR-1626; `hosted-agent-run.md` §8.1 / §8.3). A review
        // builds nothing and holds no card: its end is not the card's run dying, and a
        // review opened after a build died must not hide that death from To fix.
        ...notAReviewRunFor(workItemId),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        command: true,
        origin: true,
        status: true,
        stopReason: true,
        startedAt: true,
        endedAt: true,
        lastHeartbeatAt: true,
        reportedBy: true,
        createdById: true,
        createdBy: { select: { id: true, name: true } },
        scopeWorkItemId: true,
        scope: { select: { identifier: true } },
        cards: {
          where: { workItemId },
          select: { id: true, sessionBranch: true },
          take: 1,
        },
      },
    });
  },

  /**
   * The card's newest run (see `notAReviewRunFor`) with only what the resume read
   * needs: the run, the card's own leg and the agent it executed in (MOTIR-9046).
   * ⚠️ NOT narrowed to runs with an agent: narrowing would answer "the newest run
   * in an agent" and skip a newer hosted run.
   */
  async findLatestResumeRunForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<LatestResumeRunForWorkItem | null> {
    return tx.dispatchRun.findFirst({
      where: notAReviewRunFor(workItemId),
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        command: true,
        status: true,
        startedAt: true,
        endedAt: true,
        cards: { where: { workItemId }, select: { id: true }, take: 1 },
        agentInstance: { select: { id: true, name: true, profileId: true, ownerId: true } },
      },
    });
  },

  /**
   * ONE run by id, in the same projection as {@link findLatestForWorkItem}, but
   * only when it holds a leg for (or is scoped to) this work item — the run a
   * dispatch prompt's `continueFrom` names (MOTIR-6531). Null otherwise, including
   * for another workspace's run, which RLS hides.
   */
  async findForWorkItemById(
    id: string,
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<LatestRunForWorkItem | null> {
    return tx.dispatchRun.findFirst({
      where: {
        id,
        OR: [{ scopeWorkItemId: workItemId }, { cards: { some: { workItemId } } }],
      },
      select: {
        id: true,
        command: true,
        origin: true,
        status: true,
        stopReason: true,
        startedAt: true,
        endedAt: true,
        lastHeartbeatAt: true,
        reportedBy: true,
        createdById: true,
        createdBy: { select: { id: true, name: true } },
        scopeWorkItemId: true,
        scope: { select: { identifier: true } },
        cards: { where: { workItemId }, select: { id: true, sessionBranch: true }, take: 1 },
      },
    });
  },

  /** One run's starter — the name a continue says it took over from (MOTIR-6532). */
  async findRunStarterById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ createdBy: { id: string; name: string } | null } | null> {
    return tx.dispatchRun.findUnique({
      where: { id },
      select: { createdBy: { select: { id: true, name: true } } },
    });
  },

  /** One run WITH its legs, in stored `position` order. */
  async findByIdWithCards(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunWithCards | null> {
    return tx.dispatchRun.findUnique({ where: { id }, include: WITH_CARDS });
  },

  /**
   * Several runs' SCOPE cards, by run id (MOTIR-7589) — the head of a dead run's To fix
   * entry is the card the run was pointed at (`design/workbench/design-notes.md` § 34.2).
   * `scopeWorkItemId` is null for a single-card run; its one leg is then the head.
   */
  async findScopesByIds(
    ids: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; scopeWorkItemId: string | null; endedAt: Date | null }[]> {
    if (ids.length === 0) return [];
    return tx.dispatchRun.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, scopeWorkItemId: true, endedAt: true },
    });
  },

  /**
   * A gated run's header as its To resume entry names it (MOTIR-7712): where it ran,
   * who reported it, and who started it.
   */
  async findResumeHeaderById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{
    origin: DispatchRun['origin'];
    reportedBy: DispatchRun['reportedBy'];
    createdBy: { id: string; name: string } | null;
    agentInstance: { name: string } | null;
  } | null> {
    return tx.dispatchRun.findUnique({
      where: { id },
      select: {
        origin: true,
        reportedBy: true,
        createdBy: { select: { id: true, name: true } },
        agentInstance: { select: { name: true } },
      },
    });
  },

  /** One run, header only — the cheap read the append path makes per batch. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<DispatchRun | null> {
    return tx.dispatchRun.findUnique({ where: { id } });
  },

  /**
   * The IDEMPOTENT open: the run this workspace already has under this key.
   *
   * The unique index `(workspace_id, idempotency_key)` is what makes a retried
   * open one row rather than two runs that each saw half the work; this is the
   * read that turns the second call into a no-op instead of a constraint error.
   */
  async findByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRun | null> {
    return tx.dispatchRun.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
    });
  },

  /**
   * The RUNNING runs whose idempotency key starts with `prefix`, in one workspace —
   * what a REVIEW run's gate is found by (MOTIR-6820): the server opens every review run
   * under `agent-review:<gateId>:…`, so the gate's in-flight review is this read. Served
   * by the `(workspace_id, idempotency_key)` unique index's prefix.
   */
  async listRunningByIdempotencyKeyPrefix(
    workspaceId: string,
    prefix: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string }>> {
    return tx.dispatchRun.findMany({
      where: { workspaceId, status: 'running', idempotencyKey: { startsWith: prefix } },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
  },

  /**
   * The LATEST run, in any status, whose idempotency key starts with `prefix` — the
   * review run an `agent_review` gate's band links (MOTIR-6825): every review run of a
   * gate is opened under `agent-review:<gateId>:…`, so its newest run is this read.
   */
  async findLatestByIdempotencyKeyPrefix(
    workspaceId: string,
    prefix: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; command: DispatchRun['command']; startedAt: Date } | null> {
    return tx.dispatchRun.findFirst({
      where: { workspaceId, idempotencyKey: { startsWith: prefix } },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, command: true, startedAt: true },
    });
  },

  /**
   * ONE CARD'S RUN HISTORY — every run that owned a leg naming it, newest first.
   *
   * ⚠️ CURSOR-PAGINATED, because run history is UNBOUNDED. A card worked by
   * `motir auto` every night accumulates a run per night for as long as the
   * project lives, and the card page's run section renders a page of them.
   *
   * The `some` filter reads through the LEG rather than a column on the run: a
   * run owns a set of cards, so "runs for this card" is a question about the
   * legs and there is no denormalized answer to keep in sync.
   */
  async listByWorkItem(
    workItemId: string,
    {
      take,
      cursor,
      createdById,
    }: { take: number; cursor?: string | undefined; createdById?: string | undefined },
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunWithCards[]> {
    return tx.dispatchRun.findMany({
      where: { cards: { some: { workItemId } }, ...startedBy(createdById) },
      include: WITH_CARDS,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * Runs pointed AT one container as their scope — the story's own run history.
   *
   * A different question from {@link listByWorkItem} and not a special case of
   * it: a scoped run's legs are the container's CHILDREN, so the container
   * itself has no leg and would not appear in its own card history.
   */
  async listByScope(
    scopeWorkItemId: string,
    { take, cursor, statuses, createdById, withheldWorkItemIds }: DispatchRunPage,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunListRow[]> {
    return tx.dispatchRun.findMany({
      where: {
        scopeWorkItemId,
        ...(statuses ? { status: { in: statuses } } : {}),
        ...startedBy(createdById),
        ...notTouching(withheldWorkItemIds),
      },
      include: WITH_CARDS_AND_SCOPE,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * A project's runs, newest first — the RUNS INDEX's read (MOTIR-3922).
   *
   * ⚠️ THE FILTER IS APPLIED HERE, NOT BY THE CALLER. `statuses` narrows the
   * query rather than the page, because a service that filtered the rows it got
   * back would hand out short pages and, at a page boundary, an empty one with a
   * cursor still to follow — which every client reads as "no more runs".
   */
  async listByProject(
    projectId: string,
    { take, cursor, statuses, createdById, withheldWorkItemIds }: DispatchRunPage,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunListRow[]> {
    return tx.dispatchRun.findMany({
      where: {
        projectId,
        ...(statuses ? { status: { in: statuses } } : {}),
        ...startedBy(createdById),
        ...notTouching(withheldWorkItemIds),
      },
      include: WITH_CARDS_AND_SCOPE,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * The run's terminal columns, LOCKED `FOR UPDATE` inside the caller's
   * transaction — the read-derived guard every close derives from
   * (lock-before-a-read-derived-update, `CLAUDE.md` § concurrency).
   *
   * ⚠️ WHY A CLOSE NEEDS A LOCK AT ALL. Two things race to close one run: the
   * CLI's own `run_closed` report, and the abandoned-run reap that decided
   * nothing was holding it. Without the lock both read `running`, both write,
   * and the loser's write LANDS — so a run that finished cleanly can end up
   * recorded as `timed_out`, which is the one outcome a reader would take as
   * evidence that something went wrong. With it, the second writer re-reads a
   * row that is already terminal and returns without writing.
   *
   * `tx` REQUIRED: a row lock lives only for its transaction, so a caller
   * without one would take the lock and drop it on the next statement.
   */
  async findTerminalStateForUpdate(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<LockedDispatchRunTerminalState | null> {
    const rows = await tx.$queryRaw<LockedDispatchRunTerminalState[]>`
      SELECT "id",
             "status",
             "stop_reason" AS "stopReason",
             "ended_at"    AS "endedAt",
             "created_by_id" AS "createdById",
             "agent_instance_id" AS "agentInstanceId"
        FROM "dispatch_run"
       WHERE "id" = ${id}
       FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /** Close a run. `tx` required — a write, and one the guard above must precede. */
  async update(
    id: string,
    data: Prisma.DispatchRunUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRun> {
    return tx.dispatchRun.update({ where: { id }, data });
  },

  /**
   * Record the agent-runner account a hosted run's container booted on
   * (MOTIR-9423) — null for the process-wide fleet. One update; `tx` required.
   */
  async recordFleetShard(
    id: string,
    fleetShardId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.dispatchRun.update({ where: { id }, data: { fleetShardId } });
  },

  /**
   * Record that the run is alive (MOTIR-6528). `tx` required — a write, and one
   * the locked terminal read must precede, so a heartbeat can never land on a
   * run the lapse reap has just closed.
   */
  async touchHeartbeat(id: string, at: Date, tx: Prisma.TransactionClient): Promise<void> {
    await tx.dispatchRun.update({ where: { id }, data: { lastHeartbeatAt: at } });
  },

  /**
   * The LAPSE REAP's cross-tenant discovery read (MOTIR-6528): LOCAL and
   * INSTANCE runs still `running` whose last heartbeat is older than the cut-off,
   * oldest first. Both heartbeat from the CLI and `isRunAlive` lapses both by the
   * same rule; the reap closes an `instance` one through the agent's end path,
   * which revokes its credentials and stops its session (`agent-instance-run.md`
   * §6, MOTIR-7027).
   *
   * ⚠️ TWO CUT-OFFS, ONE PER REPORTER (MOTIR-7450, `agent-reported-runs.md` §5): a
   * CLI-reported run lapses at `cliHeartbeatBefore` (5 minutes), an AGENT-reported
   * one at `agentHeartbeatBefore` (60 minutes), because the agent touches its run on
   * its Motir calls rather than on a timer.
   *
   * A null heartbeat never matches — a run opened by a CLI that never heartbeats
   * stays on the 12-hour age reap, and a HOSTED run's liveness is its
   * supervision. Same `withSystemContext` contract as
   * {@link listStaleRunningAcrossWorkspaces}: read-only, every write re-binds.
   */
  async listLapsedHeartbeatingRunningAcrossWorkspaces(
    cutoffs: { cliHeartbeatBefore: Date; agentHeartbeatBefore: Date },
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRun[]> {
    return tx.dispatchRun.findMany({
      where: {
        status: 'running',
        origin: { in: ['local', 'instance'] },
        OR: [
          { reportedBy: 'cli', lastHeartbeatAt: { lt: cutoffs.cliHeartbeatBefore } },
          { reportedBy: 'agent', lastHeartbeatAt: { lt: cutoffs.agentHeartbeatBefore } },
        ],
      },
      orderBy: { lastHeartbeatAt: 'asc' },
      take,
    });
  },

  /**
   * The OPEN run a caller holds on one card (MOTIR-7450, `agent-reported-runs.md`
   * §3) — the run `report_action` writes into, found from the card and the caller
   * rather than from a run id: `running`, opened by `createdById`, and holding a
   * leg on the card or scoped to it, of EITHER reporter. Newest first, so a stale
   * run nobody closed yet never shadows the one being worked.
   *
   * ⚠️ NEVER A REVIEW RUN: a review builds nothing and holds no card, and its
   * events are the review's own (`hosted-agent-run.md` §8).
   */
  async findOpenForCreatorOnWorkItem(
    createdById: string,
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunWithCards | null> {
    return tx.dispatchRun.findFirst({
      where: {
        createdById,
        status: 'running',
        command: { not: 'review' },
        OR: [{ scopeWorkItemId: workItemId }, { cards: { some: { workItemId } } }],
      },
      include: WITH_CARDS,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * HEARTBEAT EVERY OPEN RUN one caller opened (MOTIR-7450, `agent-reported-runs.md`
   * §5) — what every Motir MCP call by that caller does, in ONE statement.
   *
   * `staleBefore` is the throttle: a run beaten more recently than it is left alone,
   * so a burst of tool calls costs one write a minute, not one per call. The ids come
   * from {@link findStaleHeartbeatIdsForCreator}; the throttle and `running` are
   * re-checked here. `tx` required — a write.
   *
   * ⚠️ LOCAL RUNS ONLY. A HOSTED run's liveness is its supervision and its age reap
   * reads a NULL heartbeat, so a stamp here would take it off that reap for good; an
   * INSTANCE run is beaten by the CLI inside the agent, and the developer's own calls
   * from elsewhere would keep a dead one looking alive.
   *
   * ⚠️ NO EXPLICIT LOCK, AND NONE IS NEEDED. A close holds the run's row lock; this
   * update waits on it, and PostgreSQL re-checks `status = 'running'` against the
   * committed row before writing, so a heartbeat never lands on a run the reap or
   * the agent has just closed.
   */
  async touchHeartbeatsByIds(
    ids: string[],
    staleBefore: Date,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const r = await tx.dispatchRun.updateMany({
      where: {
        id: { in: ids },
        status: 'running',
        OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: staleBefore } }],
      },
      data: { lastHeartbeatAt: at },
    });
    return r.count;
  },

  /**
   * The ids of a creator's open LOCAL runs whose heartbeat is older than
   * `staleBefore` (or unset) — the READ in front of {@link touchHeartbeatsByIds}.
   * `reportedBy` narrows to one reporter, or `null` reads both.
   *
   * It exists so the every-call heartbeat costs a READ on the ordinary call: most
   * calls come from a caller with no stale run, and those must issue no write at all
   * (a read-only tool is measured issuing zero writes,
   * `tests/mcp/tool-hints-integration.test.ts`).
   */
  async findStaleHeartbeatIdsForCreator(
    createdById: string,
    reportedBy: DispatchRun['reportedBy'] | null,
    staleBefore: Date,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.dispatchRun.findMany({
      where: {
        createdById,
        status: 'running',
        origin: 'local',
        ...(reportedBy !== null ? { reportedBy } : {}),
        OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: staleBefore } }],
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  },

  /**
   * A project's LIVE runs — the `/ready` strip's ONE read (MOTIR-1793).
   *
   * ⚠️ NOT paginated, and that is the decision rather than an omission. The
   * population is bounded by how many runs one project has IN FLIGHT, which is a
   * handful; the alternative — a per-card *"is there a live run?"* endpoint —
   * is an N+1 acquired on the busiest surface in the product, and the kind that
   * looks fine with three rows.
   */
  async listActiveByProject(
    projectId: string,
    tx: Prisma.TransactionClient,
    createdById?: string,
    // A Visitor's withholding (MOTIR-6645) — see {@link DispatchRunPage}.
    withheldWorkItemIds?: readonly string[],
  ): Promise<DispatchRunWithCards[]> {
    return tx.dispatchRun.findMany({
      where: {
        projectId,
        status: 'running',
        ...startedBy(createdById),
        ...notTouching(withheldWorkItemIds),
      },
      include: WITH_CARDS,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * The SWEEP's CROSS-TENANT discovery read (MOTIR-1792): every run still
   * `running` past the cut-off, in ANY workspace, oldest first.
   *
   * ⚠️ IT MUST RUN UNDER `withSystemContext`, and it returns the WHOLE ROW so the
   * caller can read `workspaceId` off it. The abandoned runs a sweep has to close
   * are spread across tenants by construction — one operator's laptop died, and
   * another's did — and the workspace is not known until the first row comes
   * back, so no wrapper could have bound it up front. The `FOR SELECT` system arm
   * (`20260829130000_dispatch_run_system_read`) is what admits this read, and it
   * is READ-ONLY: every write the sweep then makes re-binds to that row's own
   * workspace.
   */
  async listStaleRunningAcrossWorkspaces(
    startedBefore: Date,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRun[]> {
    return tx.dispatchRun.findMany({
      // ⚠️ `lastHeartbeatAt: null` (MOTIR-6528): a HEARTBEATING run is alive for
      // as long as it keeps reporting, however long it runs
      // (`run-death-keeps-work.md` §1), so the age reap is for the runs that
      // cannot prove they are alive — a legacy CLI's, and a hosted run's, whose
      // 12 hours is the spend backstop. A heartbeating run that goes silent is
      // the lapse reap's.
      where: { status: 'running', startedAt: { lt: startedBefore }, lastHeartbeatAt: null },
      orderBy: { startedAt: 'asc' },
      take,
    });
  },

  /**
   * The ABANDONED-RUN REAP's discovery read (MOTIR-1792): runs still `running`
   * that started before a cut-off, oldest first.
   *
   * Status-first ordering matches the `(status, started_at)` index, and `running`
   * is a tiny minority of the table — the same shape `job_run`'s reap read has.
   */
  async listStaleRunning(
    startedBefore: Date,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRun[]> {
    return tx.dispatchRun.findMany({
      where: { status: 'running', startedAt: { lt: startedBefore } },
      orderBy: { startedAt: 'asc' },
      take,
    });
  },
};
