import type { AgentInstance } from '@/generated/prisma/client';
import { AgentInstancesUnavailableError } from '@/lib/agentInstances/errors';
import { terminalMasterKey } from '@/lib/agentInstances/terminal';
import {
  TERMINAL_CLOSE,
  TERMINAL_CONNECTION_LOST_AFTER_MS,
  addressForChannel,
  type AgentTerminalChannel,
  type AgentTerminalCloseReason,
  type TerminalRefusalCode,
} from '@/lib/agentTerminal/protocol';
import { relayAuthorization } from '@/lib/agentTerminal/relayToken';
import { hashTerminalTicket } from '@/lib/agentTerminal/ticket';
import {
  hosterTerminalEndpointFor,
  persistentTerminalEndpoint,
  selectedOrchestratorProvider,
} from '@/lib/orchestrator';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import {
  agentTerminalConnectionRepository,
  type LostConnectionRef,
} from '@/lib/repositories/agentTerminalConnectionRepository';
import { agentTerminalTicketRepository } from '@/lib/repositories/agentTerminalTicketRepository';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE TERMINAL RELAY'S MOTIR SIDE (Story MOTIR-6861 · MOTIR-6940,
// `docs/decisions/agent-terminal.md` Q3, Q8) — every database question the relay
// asks, so the relay stays a thin transport:
//
//   * `authorizeConnection` — redeem the ticket (single use: ONE guarded update,
//     bound to the ticket's own workspace), RE-READ the instance (still that
//     user's, not deleted, serving a terminal, running) and answer Q3's close
//     code, or where to dial with the one-shot relay token already signed.
//     A ticket is redeemed only on its OWN channel (`agent-chat.md` Q4 ·
//     MOTIR-7013): the relay names the path it arrived on, and a terminal ticket
//     on `/v1/chat` — or a chat ticket on `/v1/terminal` — is 4401. The dial goes
//     to the same machine at that channel's path, with the same relay token.
//   * `openConnection` / `closeConnection` — the one row per connection (Q8),
//     recording its channel.
//   * `heartbeatConnections` / `closeOwnLeftovers` / `sweepLostConnections` —
//     the row's liveness (MOTIR-6959): a relay killed without shutting down
//     leaves no row open for ever.
//   * `sweepExpiredTickets` — `system.agent-instance-sweep`'s ticket step.
//
// ⚠️ THIS FILE'S IMPORT GRAPH IS THE RELAY APP'S. `motir-relay` holds only
// `DATABASE_URL`, the master key, `MOTIR_BASE_URL` and `SENTRY_DSN` (Q1), so
// nothing here may reach `projectsService` / `lib/auth` (which refuse to load
// without the web app's secrets). The ticket's MINTING, which needs the project
// and its permissions, is `agentTerminalService`, in the web app.

/** The clock, as a seam so a test can move time without sleeping. */
export const agentTerminalClock = {
  now: (): Date => new Date(),
};

/** How many expired tickets one sweep pass reads; the next pass continues. */
const SWEEP_BATCH = 500;

function requireMasterKey(): string {
  const key = terminalMasterKey();
  if (!key) throw new AgentInstancesUnavailableError('the agent terminal is not configured');
  return key;
}

/** Where the relay dials, and as whom — everything it needs for one connection. */
export interface AgentTerminalConnectionTarget {
  instanceId: string;
  userId: string;
  workspaceId: string;
  /** The socket the ticket opens — the path it was redeemed on. */
  channel: AgentTerminalChannel;
  /** The agent's server at that channel's path, and the headers the dial carries.
   *  `tls` (MOTIR-9470, an AWS instance's host agent): the client pair the dial
   *  presents and the ONE CA it trusts; the host name is not checked. */
  dial: {
    url: string;
    headers: Record<string, string>;
    tls?: { caPem: string; certPem: string; keyPem: string };
  };
}

export type AgentTerminalAuthorization =
  | { ok: true; target: AgentTerminalConnectionTarget }
  | { ok: false; closeCode: TerminalRefusalCode };

function refuse(closeCode: TerminalRefusalCode): AgentTerminalAuthorization {
  return { ok: false, closeCode };
}

/** Q3's re-read, in the table's order: why this instance cannot be dialled now — or null. */
function connectionRefusal(row: AgentInstance, userId: string): TerminalRefusalCode | null {
  if (row.deletedAt || row.ownerId !== userId) return TERMINAL_CLOSE.notOwner;
  if (row.terminalServer === 'absent') return TERMINAL_CLOSE.noTerminalServer;
  if (row.state !== 'running' || !row.flyApp || !row.machineId || !row.volumeId) {
    return TERMINAL_CLOSE.notRunning;
  }
  return null;
}

/** Rows by the workspace they live in — every write is bound to one. */
function groupByWorkspace<T extends { workspaceId: string }>(rows: T[]): Map<string, T[]> {
  const byWorkspace = new Map<string, T[]>();
  for (const r of rows) {
    const group = byWorkspace.get(r.workspaceId) ?? [];
    group.push(r);
    byWorkspace.set(r.workspaceId, group);
  }
  return byWorkspace;
}

const idsOf = (rows: { id: string }[]): string[] => rows.map((r) => r.id);

/**
 * Close lost rows, each in its own workspace: `closedAt = lastSeenAt`, reason
 * `relay_lost`, and NO close code — the relay observed no socket close, and the
 * code the browser saw (most likely 1006) is not something it reported, so a
 * code here would be invented. Returns how many were closed.
 */
async function closeLostRows(rows: LostConnectionRef[]): Promise<number> {
  const reason: AgentTerminalCloseReason = 'relay_lost';
  let closed = 0;
  for (const [workspaceId, lost] of groupByWorkspace(rows)) {
    closed += await withWorkspaceServiceContext(workspaceId, async (tx) => {
      let n = 0;
      for (const row of lost)
        n += await agentTerminalConnectionRepository.closeLost(row, reason, tx);
      return n;
    });
  }
  return closed;
}

export const agentTerminalRelayService = {
  /**
   * THE RELAY'S ONE QUESTION: may this ticket's holder have a terminal, and
   * where? Redeems the ticket (4401 if it is unknown, expired or already used),
   * re-reads the instance (4403 not the ticket's user's or deleted, 4410 no
   * terminal server, 4409 not running), and answers the dial with a freshly
   * signed relay token. Never throws for a refusal.
   *
   * `channel` is the path the ticket arrived on. A ticket minted for the other
   * channel is 4401 — and is spent: the consume comes first, so a ticket is
   * single-use wherever it is presented.
   */
  async authorizeConnection(
    ticket: string,
    channel: AgentTerminalChannel = 'terminal',
  ): Promise<AgentTerminalAuthorization> {
    if (ticket.length === 0 || ticket.length > 256) return refuse(TERMINAL_CLOSE.badTicket);
    const now = agentTerminalClock.now();
    const found = await withSystemContext((tx) =>
      agentTerminalTicketRepository.findByHash(hashTerminalTicket(ticket), tx),
    );
    if (!found) return refuse(TERMINAL_CLOSE.badTicket);
    // The consume is bound to the ticket's own workspace: nothing is written
    // untenanted. Two relays racing on one ticket get 1 and 0.
    const consumed = await withWorkspaceServiceContext(found.workspaceId, (tx) =>
      agentTerminalTicketRepository.consume(found.id, now, tx),
    );
    if (consumed !== 1) return refuse(TERMINAL_CLOSE.badTicket);
    if (found.channel !== channel) return refuse(TERMINAL_CLOSE.badTicket);

    const row = await withWorkspaceServiceContext(found.workspaceId, (tx) =>
      agentInstanceRepository.findById(found.instanceId, tx),
    );
    /* v8 ignore next -- the ticket's FK cascades: a ticket never outlives its instance row. */
    if (!row) return refuse(TERMINAL_CLOSE.notOwner);
    const refusal = connectionRefusal(row, found.userId);
    if (refusal !== null) return refuse(refusal);

    // An instance placed on a fleet account (MOTIR-9470) is dialled where that
    // account says — an AWS one over mutual TLS; one with no account is the
    // process-wide Fly app, as before.
    const shard = row.fleetShardId ? await fleetShardService.getShard(row.fleetShardId) : null;
    const handle = {
      provider:
        shard && selectedOrchestratorProvider() !== 'fake'
          ? shard.provider
          : selectedOrchestratorProvider(),
      app: row.flyApp!,
      machineId: row.machineId!,
      volumeId: row.volumeId!,
      region: row.region,
      createdAt: row.createdAt,
    };
    const endpoint = shard
      ? await hosterTerminalEndpointFor(shard, handle)
      : await persistentTerminalEndpoint(handle);
    const authorization = relayAuthorization({
      masterKey: requireMasterKey(),
      instanceId: row.id,
      machineId: handle.machineId,
      nowMs: now.getTime(),
    });
    return {
      ok: true,
      target: {
        instanceId: row.id,
        userId: found.userId,
        workspaceId: row.workspaceId,
        channel,
        dial: {
          url: addressForChannel(endpoint.url, channel),
          headers: { ...endpoint.headers, authorization },
          ...(endpoint.tls ? { tls: endpoint.tls } : {}),
        },
      },
    };
  },

  /**
   * Record a connection the relay just opened (Q8), held by `relayMachineId`
   * and seen now (MOTIR-6959), on its channel (`terminal` unless named).
   * Returns the row's id.
   */
  async openConnection(input: {
    workspaceId: string;
    instanceId: string;
    userId: string;
    channel?: AgentTerminalChannel;
    relayMachineId: string;
  }): Promise<string> {
    const now = agentTerminalClock.now();
    const row = await withWorkspaceServiceContext(input.workspaceId, (tx) =>
      agentTerminalConnectionRepository.open(
        {
          workspaceId: input.workspaceId,
          instanceId: input.instanceId,
          userId: input.userId,
          channel: input.channel ?? 'terminal',
          relayMachineId: input.relayMachineId,
          openedAt: now,
          lastSeenAt: now,
        },
        tx,
      ),
    );
    return row.id;
  },

  /**
   * THE RELAY'S HEARTBEAT (MOTIR-6959): refresh `lastSeenAt` on the rows this
   * relay holds open. The relay names its live rows, so a row whose close write
   * failed is not kept alive by a relay that has already let it go; and the
   * update is guarded on `relayMachineId` and `closedAt IS NULL`, so it never
   * touches another relay's row or a closed one. One write per workspace — the
   * table has no system write arm. Returns how many rows moved.
   */
  async heartbeatConnections(input: {
    relayMachineId: string;
    connections: { id: string; workspaceId: string }[];
  }): Promise<{ touched: number }> {
    if (input.connections.length === 0) return { touched: 0 };
    const now = agentTerminalClock.now();
    let touched = 0;
    for (const [workspaceId, rows] of groupByWorkspace(input.connections)) {
      touched += await withWorkspaceServiceContext(workspaceId, (tx) =>
        agentTerminalConnectionRepository.touchLastSeen(idsOf(rows), input.relayMachineId, now, tx),
      );
    }
    return { touched };
  },

  /**
   * A RELAY'S BOOT (MOTIR-6959): close, `relay_lost`, every row its own machine
   * left open — a relay that was killed and came back on the same Fly machine.
   * Returns how many were closed.
   */
  async closeOwnLeftovers(relayMachineId: string): Promise<{ closed: number }> {
    let closed = 0;
    for (;;) {
      const rows = await withSystemContext((tx) =>
        agentTerminalConnectionRepository.listOpenByRelayMachine(relayMachineId, SWEEP_BATCH, tx),
      );
      const pass = await closeLostRows(rows);
      closed += pass;
      // A short page is the last; a page that closed nothing would repeat itself.
      if (rows.length < SWEEP_BATCH || pass === 0) return { closed };
    }
  },

  /**
   * `system.agent-instance-sweep`'s connection step (MOTIR-6959): close,
   * `relay_lost`, every open row no relay has vouched for in 5 minutes — a relay
   * machine that died and never came back. `closedAt` is the row's last
   * heartbeat, the last moment it was known open. Bounded per pass.
   */
  async sweepLostConnections(): Promise<{ closed: number }> {
    const cutoff = new Date(agentTerminalClock.now().getTime() - TERMINAL_CONNECTION_LOST_AFTER_MS);
    const rows = await withSystemContext((tx) =>
      agentTerminalConnectionRepository.listLost(cutoff, SWEEP_BATCH, tx),
    );
    return { closed: await closeLostRows(rows) };
  },

  /** Close a connection's row with the browser's close code and the relay's reason. Once. */
  async closeConnection(input: {
    id: string;
    workspaceId: string;
    closeCode: number;
    closeReason: AgentTerminalCloseReason;
  }): Promise<void> {
    await withWorkspaceServiceContext(input.workspaceId, (tx) =>
      agentTerminalConnectionRepository.close(
        input.id,
        {
          closedAt: agentTerminalClock.now(),
          closeCode: input.closeCode,
          closeReason: input.closeReason,
        },
        tx,
      ),
    );
  },

  /**
   * Delete every ticket past its life (Q3: "swept"), in each ticket's own
   * workspace. Bounded per pass; returns how many were deleted.
   */
  async sweepExpiredTickets(): Promise<{ deleted: number }> {
    const now = agentTerminalClock.now();
    const expired = await withSystemContext((tx) =>
      agentTerminalTicketRepository.listExpired(now, SWEEP_BATCH, tx),
    );
    let deleted = 0;
    for (const [workspaceId, tickets] of groupByWorkspace(expired)) {
      deleted += await withWorkspaceServiceContext(workspaceId, (tx) =>
        agentTerminalTicketRepository.deleteExpired(idsOf(tickets), now, tx),
      );
    }
    return { deleted };
  },
};
