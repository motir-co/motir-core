import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { TERMINAL_CLOSE } from '@/lib/agentTerminal/protocol';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
import '@/lib/jobs/definitions/agentInstanceSweep';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { agentInstanceSweepService } from '@/lib/services/agentInstanceSweepService';
import {
  agentTerminalClock,
  agentTerminalRelayService as relayService,
} from '@/lib/services/agentTerminalRelayService';
import { relayMachineId } from '@/lib/agentTerminal/relay/machineId';
import { agentTerminalConnectionRepository } from '@/lib/repositories/agentTerminalConnectionRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { setWorkspaceRoleFor } from '../helpers/workspaceRoleFixtures';
import { clock, fleet, fx, setUpHarness, tearDownHarness } from './_harness';

// THE TERMINAL TICKET (Story MOTIR-6861 · MOTIR-6940, `docs/decisions/agent-terminal.md`
// Q3) against a real Postgres and the fake persistent fleet: the route's owner-only
// ticket and its refusals, and the relay's redeem — single use, 60-second life,
// bound to its own agent — plus the connection row and the sweep.

const session = { user: null as { id: string; email: string } | null };
const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (session.user ? { user: session.user } : null)),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => ctxRef.current,
}));

const route = await import('@/app/api/projects/[key]/instances/[id]/terminal-ticket/route');

const MASTER = 'm'.repeat(48);

beforeEach(async () => {
  await setUpHarness();
  vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', MASTER);
  vi.stubEnv('MOTIR_RELAY_URL', '');
  vi.spyOn(agentTerminalClock, 'now').mockImplementation(() => clock.now());
  await actAs(fx.ownerId);
});
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function actAs(userId: string): Promise<void> {
  const user = await adminDb.user.findUniqueOrThrow({ where: { id: userId } });
  session.user = { id: user.id, email: user.email };
  ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId } as WorkspaceContext;
}

async function member(role: 'member' | 'admin' | 'viewer'): Promise<string> {
  const user = await adminDb.user.create({
    data: { name: `M ${role}`, email: `t-${role}-${Date.now()}-${Math.random()}@example.com` },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: fx.workspaceId, userId: user.id, workspaceRole: 'member' },
  });
  if (role !== 'member') await setWorkspaceRoleFor(user.id, fx.workspaceId, role);
  return user.id;
}

const running = async (name = 'yue-claude') => {
  const dto = await lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, fx.ctx);
  expect(dto.state).toBe('running');
  return dto.id;
};

const post = (id: string, body?: string) =>
  route.POST(
    new Request(
      `http://test/api/projects/${fx.projectIdentifier}/instances/${id}/terminal-ticket`,
      { method: 'POST', body },
    ),
    { params: Promise.resolve({ key: fx.projectIdentifier, id }) },
  );

async function ticketFor(id: string, body?: string) {
  const res = await post(id, body);
  expect(res.status).toBe(200);
  return (await res.json()) as { url: string; ticket: string; expiresAt: string };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('the ticket route (Q3)', () => {
  it('gives the OWNER a 60-second ticket for their running agent, storing only its hash', async () => {
    const id = await running();
    const res = await post(id);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { url: string; ticket: string; expiresAt: string };
    expect(body.url).toBe('wss://relay.motir.co/v1/terminal');
    expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(body.expiresAt).getTime() - clock.now().getTime()).toBe(60_000);

    const rows = await adminDb.agentTerminalTicket.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      instanceId: id,
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      tokenHash: sha256(body.ticket),
      consumedAt: null,
    });
    // The ticket itself is in no column.
    expect(JSON.stringify(rows[0])).not.toContain(body.ticket);
  });

  it('reads MOTIR_RELAY_URL at call time, and takes no body (the session rides the open frame)', async () => {
    const id = await running();
    vi.stubEnv('MOTIR_RELAY_URL', 'ws://localhost:8080/v1/terminal');
    const body = await ticketFor(id, JSON.stringify({ sessionId: 'ignored' }));
    expect(body.url).toBe('ws://localhost:8080/v1/terminal');
    expect(Object.keys(body).sort()).toEqual(['channel', 'expiresAt', 'ticket', 'url']);
    expect(body).toMatchObject({ channel: 'terminal' });
  });

  it('with no body — or none naming a channel — mints a TERMINAL ticket, exactly as before (MOTIR-7013)', async () => {
    const id = await running();
    for (const body of [undefined, '', '{}', JSON.stringify({ channel: 'terminal' })]) {
      const res = await ticketFor(id, body);
      expect(res).toMatchObject({ channel: 'terminal', url: 'wss://relay.motir.co/v1/terminal' });
    }
    const rows = await adminDb.agentTerminalTicket.findMany({});
    expect(rows.map((r) => r.channel)).toEqual(['terminal', 'terminal', 'terminal', 'terminal']);
  });

  it('mints a CHAT ticket for the owner of a running agent: stored with its channel, the relay URL on /v1/chat (agent-chat.md Q4)', async () => {
    const id = await running();
    const body = await ticketFor(id, JSON.stringify({ channel: 'chat' }));
    expect(body).toMatchObject({ channel: 'chat', url: 'wss://relay.motir.co/v1/chat' });
    expect(new Date(body.expiresAt).getTime() - clock.now().getTime()).toBe(60_000);
    const [row] = await adminDb.agentTerminalTicket.findMany({});
    expect(row).toMatchObject({
      channel: 'chat',
      tokenHash: sha256(body.ticket),
      userId: fx.ownerId,
    });

    // A configured relay keeps its host and prefix; only the channel's path moves.
    vi.stubEnv('MOTIR_RELAY_URL', 'ws://localhost:8080/relay/v1/terminal');
    expect((await ticketFor(id, JSON.stringify({ channel: 'chat' }))).url).toBe(
      'ws://localhost:8080/relay/v1/chat',
    );
  });

  it('refuses an unknown channel — or a body that is not an object — with 400, and mints nothing', async () => {
    const id = await running();
    for (const body of [
      JSON.stringify({ channel: 'shell' }),
      JSON.stringify({ channel: 'CHAT' }),
      JSON.stringify({ channel: null }),
      JSON.stringify({ channel: ['chat'] }),
      JSON.stringify(['chat']),
      'chat',
      'null',
    ]) {
      const res = await post(id, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(await adminDb.agentTerminalTicket.count()).toBe(0);
  });

  it('refuses a chat ticket exactly as a terminal one: not_owner 403 for a non-owner, not_running 409 for a stopped agent', async () => {
    const id = await running();
    const chat = JSON.stringify({ channel: 'chat' });
    await actAs(await member('admin'));
    let res = await post(id, chat);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_owner' });

    await actAs(fx.ownerId);
    await lifecycle.hibernate(fx.projectIdentifier, id, fx.ctx);
    res = await post(id, chat);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_running' });
    expect(await adminDb.agentTerminalTicket.count()).toBe(0);
  });

  it('refuses another member and a MANAGER alike with not_owner — and gives neither a ticket', async () => {
    const id = await running();
    for (const role of ['member', 'admin'] as const) {
      await actAs(await member(role));
      const res = await post(id);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'not_owner' });
    }
    expect(await adminDb.agentTerminalTicket.count()).toBe(0);
  });

  it('answers not_owner for an agent that does not exist or is deleted — no existence leak', async () => {
    const res = await post('no-such-agent');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'not_owner' });
    const id = await running();
    await adminDb.agentInstance.update({ where: { id }, data: { deletedAt: new Date() } });
    expect((await post(id)).status).toBe(403);
  });

  it('refuses a reader without instance:use, and an unauthenticated caller', async () => {
    const id = await running();
    await actAs(await member('viewer'));
    const res = await post(id);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ permission: 'instance:use' });
    session.user = null;
    ctxRef.current = null;
    expect((await post(id)).status).toBe(401);
    expect(await adminDb.agentTerminalTicket.count()).toBe(0);
  });

  it('refuses not_running for a hibernated agent and no_terminal_server for an old image, 409 both', async () => {
    const id = await running();
    await adminDb.agentInstance.update({ where: { id }, data: { terminalServer: 'absent' } });
    let res = await post(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'no_terminal_server' });

    await adminDb.agentInstance.update({ where: { id }, data: { terminalServer: 'present' } });
    await lifecycle.hibernate(fx.projectIdentifier, id, fx.ctx);
    res = await post(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_running' });
    expect(await adminDb.agentTerminalTicket.count()).toBe(0);
    // The route never wakes anything (Q6): the machine stays stopped.
    expect((await adminDb.agentInstance.findUniqueOrThrow({ where: { id } })).state).toBe(
      'hibernated',
    );
  });

  it('is unavailable (503) while the terminal master key is unset', async () => {
    const id = await running();
    vi.stubEnv('MOTIR_TERMINAL_MASTER_KEY', '');
    const res = await post(id);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'agent_instances_unavailable' });
  });
});

describe('the relay’s redeem (Q3)', () => {
  it('redeems ONCE: the dial target is the ticket’s own agent, with a signed relay token', async () => {
    fleet.setTerminalAddress('ws://127.0.0.1:7999');
    const id = await running();
    const other = await running('second');
    const { ticket } = await ticketFor(id);

    const verdict = await relayService.authorizeConnection(ticket);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
    expect(verdict.target).toMatchObject({
      instanceId: id,
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });
    // A ticket names ONE agent: it can never reach the second one.
    expect(verdict.target.instanceId).not.toBe(other);
    expect(verdict.target.dial.url).toBe('ws://127.0.0.1:7999/v1/terminal');
    expect(verdict.target.dial.headers['x-motir-machine-id']).toBe(row.machineId);
    expect(verdict.target.dial.headers['authorization']).toMatch(
      /^Motir-Relay [A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/,
    );
    const payload = JSON.parse(
      Buffer.from(
        verdict.target.dial.headers['authorization']!.split(' ')[1]!.split('.')[0]!,
        'base64url',
      ).toString('utf8'),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({ instanceId: id, machineId: row.machineId });
    // No session is bound into the token: the browser's `open` frame names it.
    expect(payload).not.toHaveProperty('sessionId');
    expect(payload['exp']).toBe(Math.floor(clock.now().getTime() / 1000) + 60);
    expect((await adminDb.agentTerminalTicket.findFirstOrThrow({})).consumedAt).toEqual(
      clock.now(),
    );

    // A second use is refused.
    expect(await relayService.authorizeConnection(ticket)).toEqual({
      ok: false,
      closeCode: TERMINAL_CLOSE.badTicket,
    });
    fleet.setTerminalAddress(null);
  });

  it('reads a placed instance’s account and dials it there — the fake while the fake is selected (MOTIR-9470)', async () => {
    fleet.setTerminalAddress('ws://127.0.0.1:7999');
    const id = await running();
    const shard = await adminDb.fleetShard.create({
      data: {
        name: 'agent-hoster-ticket',
        fleetKind: 'agent_instance',
        provider: 'aws',
        state: 'active',
        githubOrg: 'motir-co',
        githubInstallationId: '556677',
        awsAccountId: '111100000042',
        awsRegion: 'us-east-1',
        credentialRef: 'FLEET_SHARD_TICKET',
      },
    });
    await adminDb.agentInstance.update({
      where: { id },
      data: { fleetShardId: shard.id, availabilityZone: 'us-east-1a' },
    });
    const { ticket } = await ticketFor(id);
    const verdict = await relayService.authorizeConnection(ticket);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.target.dial.url).toBe('ws://127.0.0.1:7999/v1/terminal');
    expect(verdict.target.dial).not.toHaveProperty('tls');
    await adminDb.agentInstance.update({
      where: { id },
      data: { fleetShardId: null, availabilityZone: null },
    });
    await adminDb.fleetShard.delete({ where: { id: shard.id } });
    fleet.setTerminalAddress(null);
  });

  it('refuses an unknown, empty or oversized ticket, and one past its 60 seconds', async () => {
    const id = await running();
    for (const bad of ['', 'x'.repeat(300), 'not-a-ticket-anyone-minted']) {
      expect(await relayService.authorizeConnection(bad)).toEqual({ ok: false, closeCode: 4401 });
    }
    const { ticket } = await ticketFor(id);
    clock.advance(60_000);
    expect(await relayService.authorizeConnection(ticket)).toEqual({ ok: false, closeCode: 4401 });
    expect((await adminDb.agentTerminalTicket.findFirstOrThrow({})).consumedAt).toBeNull();
  });

  it('lets exactly one of two concurrent redeems through', async () => {
    const id = await running();
    const { ticket } = await ticketFor(id);
    const verdicts = await Promise.all([
      relayService.authorizeConnection(ticket),
      relayService.authorizeConnection(ticket),
    ]);
    expect(verdicts.filter((v) => v.ok)).toHaveLength(1);
    expect(verdicts.filter((v) => !v.ok)).toEqual([{ ok: false, closeCode: 4401 }]);
  });

  it('re-reads the instance: 4409 not running, 4410 no terminal server, 4403 no longer the user’s', async () => {
    const id = await running();
    const redeemAfter = async (patch: Record<string, unknown>) => {
      const { ticket } = await ticketFor(id);
      await adminDb.agentInstance.update({ where: { id }, data: patch });
      const verdict = await relayService.authorizeConnection(ticket);
      await adminDb.agentInstance.update({
        where: { id },
        data: { state: 'running', terminalServer: 'present', ownerId: fx.ownerId, deletedAt: null },
      });
      return verdict;
    };
    expect(await redeemAfter({ state: 'hibernating' })).toEqual({ ok: false, closeCode: 4409 });
    expect(await redeemAfter({ terminalServer: 'absent' })).toEqual({
      ok: false,
      closeCode: 4410,
    });
    expect(await redeemAfter({ deletedAt: new Date() })).toEqual({ ok: false, closeCode: 4403 });
    const someoneElse = await member('member');
    expect(await redeemAfter({ ownerId: someoneElse })).toEqual({ ok: false, closeCode: 4403 });
  });

  it('redeems a ticket ONLY on its own channel: the other path is 4401, and the ticket is spent (agent-chat.md Q4)', async () => {
    fleet.setTerminalAddress('ws://127.0.0.1:7999');
    const id = await running();

    // A chat ticket on the terminal path, a terminal ticket on the chat path.
    for (const [minted, presented] of [
      ['chat', 'terminal'],
      ['terminal', 'chat'],
    ] as const) {
      const { ticket } = await ticketFor(id, JSON.stringify({ channel: minted }));
      expect(await relayService.authorizeConnection(ticket, presented)).toEqual({
        ok: false,
        closeCode: TERMINAL_CLOSE.badTicket,
      });
      // Spent where it was presented: not redeemable on its own channel afterwards.
      expect(await relayService.authorizeConnection(ticket, minted)).toEqual({
        ok: false,
        closeCode: TERMINAL_CLOSE.badTicket,
      });
    }
    // With no channel named, a redeem is the terminal's — so a chat ticket is refused.
    const { ticket: chatTicket } = await ticketFor(id, JSON.stringify({ channel: 'chat' }));
    expect(await relayService.authorizeConnection(chatTicket)).toEqual({
      ok: false,
      closeCode: TERMINAL_CLOSE.badTicket,
    });

    // On its own path, a chat ticket dials the SAME machine at /v1/chat with a relay token.
    const row = await adminDb.agentInstance.findUniqueOrThrow({ where: { id } });
    const { ticket } = await ticketFor(id, JSON.stringify({ channel: 'chat' }));
    const verdict = await relayService.authorizeConnection(ticket, 'chat');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.target).toMatchObject({ instanceId: id, userId: fx.ownerId, channel: 'chat' });
    expect(verdict.target.dial.url).toBe('ws://127.0.0.1:7999/v1/chat');
    expect(verdict.target.dial.headers['x-motir-machine-id']).toBe(row.machineId);
    expect(verdict.target.dial.headers['authorization']).toMatch(/^Motir-Relay /);
    fleet.setTerminalAddress(null);
  });
});

describe('the connection record and the sweep (Q3, Q8)', () => {
  it('opens and closes one row — and the table has no column for content', async () => {
    const id = await running();
    const rowId = await relayService.openConnection({
      workspaceId: fx.workspaceId,
      instanceId: id,
      userId: fx.ownerId,
      relayMachineId: 'relay-a',
    });
    const opened = await adminDb.agentTerminalConnection.findUniqueOrThrow({
      where: { id: rowId },
    });
    expect(opened).toMatchObject({
      channel: 'terminal',
      openedAt: clock.now(),
      lastSeenAt: clock.now(),
      relayMachineId: 'relay-a',
      closedAt: null,
      closeReason: null,
    });
    clock.advance(90_000);
    const close = {
      id: rowId,
      workspaceId: fx.workspaceId,
      closeCode: 1000,
      closeReason: 'browser_closed' as const,
    };
    await relayService.closeConnection(close);
    await relayService.closeConnection({ ...close, closeCode: 4502, closeReason: 'unreachable' });
    const closed = await adminDb.agentTerminalConnection.findUniqueOrThrow({
      where: { id: rowId },
    });
    expect(closed).toMatchObject({ closeCode: 1000, closeReason: 'browser_closed' });
    expect(closed.closedAt!.getTime() - closed.openedAt.getTime()).toBe(90_000);
    expect(Object.keys(closed).sort()).toEqual(
      [
        'closeCode',
        'closeReason',
        'channel',
        'closedAt',
        'createdAt',
        'id',
        'instanceId',
        'lastSeenAt',
        'openedAt',
        'relayMachineId',
        'userId',
        'workspaceId',
      ].sort(),
    );
  });

  it('records a chat connection’s channel on its row (agent-chat.md Q10)', async () => {
    const id = await running();
    const rowId = await relayService.openConnection({
      workspaceId: fx.workspaceId,
      instanceId: id,
      userId: fx.ownerId,
      channel: 'chat',
      relayMachineId: 'relay-a',
    });
    expect(
      await adminDb.agentTerminalConnection.findUniqueOrThrow({ where: { id: rowId } }),
    ).toMatchObject({ channel: 'chat', closedAt: null });
  });

  it('deletes only tickets past their life, through the sweep job’s own step', async () => {
    const id = await running();
    await ticketFor(id);
    clock.advance(30_000);
    await ticketFor(id);
    clock.advance(31_000); // the first is past its 60 s, the second is not
    vi.spyOn(agentInstanceSweepService, 'sweep').mockResolvedValue({ settled: 0 } as never);
    const steps: string[] = [];
    const step = {
      run: async <T>(name: string, fn: () => Promise<T>) => {
        steps.push(name);
        return fn();
      },
    };
    await engineJob('system.agent-instance-sweep')!.handler(
      { step } as never,
      jobServices as never,
    );
    expect(steps).toEqual([
      'sweep-agent-instances',
      'sweep-agent-terminal-tickets',
      'sweep-lost-terminal-connections',
      // MOTIR-6921: the plan-lapse pass, its own step for the same memoized-shape reason.
      'sweep-agent-plan-lapse',
    ]);
    expect(await adminDb.agentTerminalTicket.count()).toBe(1);
    clock.advance(60_000);
    expect(await relayService.sweepExpiredTickets()).toEqual({ deleted: 1 });
    expect(await relayService.sweepExpiredTickets()).toEqual({ deleted: 0 });
  });
});

describe('a relay that dies leaves no row open for ever (MOTIR-6959)', () => {
  const open = (instanceId: string, relayMachineId: string) =>
    relayService.openConnection({
      workspaceId: fx.workspaceId,
      instanceId,
      userId: fx.ownerId,
      relayMachineId,
    });
  const row = (id: string) => adminDb.agentTerminalConnection.findUniqueOrThrow({ where: { id } });
  const ref = (id: string) => ({ id, workspaceId: fx.workspaceId });

  it('the heartbeat moves only this relay’s own OPEN rows', async () => {
    const id = await running();
    const t0 = clock.now();
    const mine = await open(id, 'relay-a');
    const theirs = await open(id, 'relay-b');
    const mineClosed = await open(id, 'relay-a');
    await relayService.closeConnection({
      ...ref(mineClosed),
      closeCode: 1000,
      closeReason: 'browser_closed',
    });
    clock.advance(60_000);
    // Handed every id, it still touches only relay-a's open row.
    const result = await relayService.heartbeatConnections({
      relayMachineId: 'relay-a',
      connections: [ref(mine), ref(theirs), ref(mineClosed)],
    });
    expect(result).toEqual({ touched: 1 });
    expect((await row(mine)).lastSeenAt).toEqual(clock.now());
    expect((await row(theirs)).lastSeenAt).toEqual(t0);
    expect((await row(mineClosed)).lastSeenAt).toEqual(t0);
    expect(
      await relayService.heartbeatConnections({ relayMachineId: 'relay-a', connections: [] }),
    ).toEqual({ touched: 0 });
  });

  it('the sweep job closes a row not seen for 5 minutes at its last heartbeat, and leaves a fresh one', async () => {
    const id = await running();
    const staleSeenAt = clock.now();
    const stale = await open(id, 'relay-dead');
    const fresh = await open(id, 'relay-live');
    clock.advance(4 * 60_000);
    await relayService.heartbeatConnections({
      relayMachineId: 'relay-live',
      connections: [ref(fresh)],
    });
    clock.advance(2 * 60_000); // stale: 6 minutes unseen; fresh: 2
    vi.spyOn(agentInstanceSweepService, 'sweep').mockResolvedValue({ settled: 0 } as never);
    const results: Record<string, unknown> = {};
    const step = {
      run: async <T>(name: string, fn: () => Promise<T>) => {
        const value = await fn();
        results[name] = value;
        return value;
      },
    };
    await engineJob('system.agent-instance-sweep')!.handler(
      { step } as never,
      jobServices as never,
    );
    expect(results['sweep-lost-terminal-connections']).toEqual({ closed: 1 });
    expect(await row(stale)).toMatchObject({
      closedAt: staleSeenAt,
      closeReason: 'relay_lost',
      closeCode: null,
    });
    expect(await row(fresh)).toMatchObject({ closedAt: null, closeReason: null });
    // Exactly at the 5-minute line it is lost; a minute short, it is not.
    expect(await relayService.sweepLostConnections()).toEqual({ closed: 0 });
    clock.advance(2 * 60_000);
    expect(await relayService.sweepLostConnections()).toEqual({ closed: 0 });
    clock.advance(60_000);
    expect(await relayService.sweepLostConnections()).toEqual({ closed: 1 });
  });

  it('a heartbeat landing between the sweep’s read and its close wins', async () => {
    const id = await running();
    const rowId = await open(id, 'relay-a');
    const seen = await row(rowId);
    clock.advance(60_000);
    await relayService.heartbeatConnections({
      relayMachineId: 'relay-a',
      connections: [ref(rowId)],
    });
    const closed = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      agentTerminalConnectionRepository.closeLost(seen, 'relay_lost', tx),
    );
    expect(closed).toBe(0);
    expect((await row(rowId)).closedAt).toBeNull();
  });

  it('a relay’s boot closes its own machine’s leftovers, and nobody else’s', async () => {
    const id = await running();
    const leftoverSeenAt = clock.now();
    const leftover = await open(id, 'relay-a');
    const other = await open(id, 'relay-b');
    const done = await open(id, 'relay-a');
    clock.advance(30_000);
    await relayService.closeConnection({
      ...ref(done),
      closeCode: 1000,
      closeReason: 'browser_closed',
    });
    clock.advance(30_000);
    expect(await relayService.closeOwnLeftovers('relay-a')).toEqual({ closed: 1 });
    expect(await row(leftover)).toMatchObject({
      closedAt: leftoverSeenAt,
      closeReason: 'relay_lost',
      closeCode: null,
    });
    expect(await row(other)).toMatchObject({ closedAt: null });
    expect(await row(done)).toMatchObject({ closeCode: 1000, closeReason: 'browser_closed' });
    expect(await relayService.closeOwnLeftovers('relay-a')).toEqual({ closed: 0 });
  });

  it('names the relay by FLY_MACHINE_ID, else by host and process', () => {
    expect(relayMachineId({ FLY_MACHINE_ID: ' 148e21 ' }, () => 'h', 7)).toBe('148e21');
    expect(relayMachineId({}, () => 'host', 42)).toBe('host-42');
    expect(relayMachineId({ FLY_MACHINE_ID: '' }, () => 'host', 42)).toBe('host-42');
  });
});
