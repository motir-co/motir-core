import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE INTEGRATION GATE for pending invitations (Story MOTIR-9981 · MOTIR-9998),
// against real Postgres. Each code card tests its own piece; this file asserts
// the SEAMS between them: what Resend writes is what the list reads back, a
// retired row stays counted by the hourly limit while it leaves the list, the
// delivery join follows the NEW token after a Resend, and the `canResend` flag
// the list shows agrees with what the real Resend allows.
//
// Delivery rows and failed ledger rows are seeded through their repositories,
// keyed on the invite token exactly as the `email.send` job stamps them. The
// session and the active workspace are the only seams mocked (the server action
// reads both from cookies), plus Next's revalidation, which is observed.

const mockSession: { current: { user: { id: string; email: string; name: string } } | null } = {
  current: null,
};
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: async () => mockSession.current };
});
const activeWorkspace: { current: { userId: string; workspaceId: string } | null } = {
  current: null,
};
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => activeWorkspace.current };
});
const revalidated = vi.hoisted(() => [] as string[]);
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => revalidated.push(path),
  revalidateTag: () => undefined,
}));

import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  INVITE_IDENTIFIER_PREFIX,
  workspaceInvitesService,
} from '@/lib/services/workspaceInvitesService';
import { emailDeliveryRepository } from '@/lib/repositories/emailDeliveryRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { resendInviteAction } from '@/app/(authed)/settings/workspace/actions';
import {
  InviteExpiredOrMissingError,
  InviteNotAllowedForScopeError,
  InviteRateLimitedError,
  InviteScopeForbiddenError,
  InviteTargetAlreadyMemberError,
  NotAMemberError,
} from '@/lib/workspaces/errors';
import type { PendingInviteDTO } from '@/lib/dto/invites';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from './helpers/db';
import { captureEmailEvents } from './helpers/jobs';
import { randomToken } from './helpers/random';

let emailEvents: ReturnType<typeof captureEmailEvents>;
type User = { id: string; email: string; name: string };

async function makeUser(email: string, name = email): Promise<User> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name });
  return { id: user.id, email: user.email, name };
}

/** A workspace with a Manager (its owner), a Full member and a Limited member. */
async function makeWorkspace(tag: string) {
  const manager = await makeUser(`${tag}-manager@example.com`, `${tag} Manager`);
  const { workspace } = await workspacesService.createWorkspace({
    name: `${tag} Co.`,
    ownerUserId: manager.id,
  });
  const full = await makeUser(`${tag}-full@example.com`);
  await workspacesService.addMember({ userId: full.id, workspaceId: workspace.id });
  const limited = await makeUser(`${tag}-limited@example.com`);
  await workspacesService.addMember({ userId: limited.id, workspaceId: workspace.id });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: limited.id, workspaceId: workspace.id } },
    data: { accessScope: 'limited' },
  });
  return { workspaceId: workspace.id, workspaceName: workspace.name, manager, full, limited };
}
type Fixture = Awaited<ReturnType<typeof makeWorkspace>>;

/** Send an invite through the real service; returns its token and row id. */
async function send(
  f: Fixture,
  email: string,
  opts: { by?: User; scope?: 'full' | 'limited' } = {},
): Promise<{ token: string; id: string }> {
  await workspaceInvitesService.sendInvite({
    inviterUserId: (opts.by ?? f.manager).id,
    inviterName: (opts.by ?? f.manager).name,
    workspaceId: f.workspaceId,
    targetEmail: email,
    accessScope: opts.scope,
  });
  const row = await adminDb.verification.findFirstOrThrow({
    where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX }, value: { contains: email } },
    orderBy: { createdAt: 'desc' },
  });
  return { token: row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length), id: row.id };
}

function resend(f: Fixture, id: string, actor: User = f.manager) {
  return workspaceInvitesService.resendInvite({
    actorUserId: actor.id,
    actorName: actor.name,
    workspaceId: f.workspaceId,
    inviteId: id,
  });
}

function list(f: Fixture, viewer: User = f.manager): Promise<PendingInviteDTO[]> {
  return workspaceInvitesService.listPendingInvites({
    userId: viewer.id,
    workspaceId: f.workspaceId,
  });
}

async function liveRow(email: string) {
  const rows = await adminDb.verification.findMany({
    where: {
      identifier: { startsWith: INVITE_IDENTIFIER_PREFIX },
      value: { contains: email },
      expiresAt: { gt: new Date() },
    },
  });
  expect(rows).toHaveLength(1);
  return {
    id: rows[0]!.id,
    token: rows[0]!.identifier.slice(INVITE_IDENTIFIER_PREFIX.length),
  };
}

// The production writer of both rows is the `email.send` job, which runs under
// the SYSTEM context — so that is the context the seed writes under.
async function seedDelivery(
  f: Fixture,
  token: string,
  state: 'accepted' | 'delivered' | 'bounced' | 'complained' | 'delayed',
) {
  await withSystemContext((tx) =>
    emailDeliveryRepository.create(
      {
        providerMessageId: `msg_${randomToken()}`,
        provider: 'resend',
        recipient: 'someone@example.com',
        template: 'workspace-invite',
        workspaceId: f.workspaceId,
        idempotencyKey: token,
        state,
      },
      tx,
    ),
  );
}

async function seedSendRun(f: Fixture, token: string, status: 'failed' | 'abandoned') {
  await withSystemContext((tx) =>
    jobRunRepository.create(
      {
        workspaceId: f.workspaceId,
        functionId: 'email.send',
        eventName: 'email.send',
        eventId: `evt-${randomToken()}`,
        lane: 'engine',
        attempt: 0,
        status,
        idempotencyKey: token,
      },
      tx,
    ),
  );
}

/** Rows and enqueues before an action, to assert a refusal wrote nothing. */
async function snapshot() {
  return { rows: await adminDb.verification.count(), emails: emailEvents.events.length };
}
async function expectNothingWritten(before: { rows: number; emails: number }) {
  expect(await adminDb.verification.count()).toBe(before.rows);
  expect(emailEvents.events).toHaveLength(before.emails);
}

function asActor(f: Fixture, user: User) {
  mockSession.current = { user };
  activeWorkspace.current = { userId: user.id, workspaceId: f.workspaceId };
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  mockSession.current = null;
  activeWorkspace.current = null;
  revalidated.length = 0;
  emailEvents = captureEmailEvents();
});

afterEach(async () => {
  emailEvents.restore();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('send → list → Resend → list', () => {
  it('a sent invite lists as queued, with the inviter, scope, a seven-day expiry and no token', async () => {
    const f = await makeWorkspace('a');
    const { token } = await send(f, 'new@example.com');

    const [row, ...rest] = await list(f);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      email: 'new@example.com',
      invitedBy: { userId: f.manager.id, name: f.manager.name },
      accessScope: 'full',
      deliveryState: 'queued',
      canResend: true,
    });
    const lifetime = Date.parse(row!.expiresAt) - Date.parse(row!.sentAt);
    expect(Math.abs(lifetime - 7 * 24 * 60 * 60 * 1000)).toBeLessThan(5_000);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('/invite/accept');
  });

  it('after a Resend the address lists once, later, under the original inviter, with a new id', async () => {
    const f = await makeWorkspace('a');
    const first = await send(f, 'again@example.com');
    const [before] = await list(f);
    const resendAt = Date.now();
    await resend(f, first.id, f.full);

    const after = await list(f);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(before!.id);
    expect(Date.parse(after[0]!.sentAt)).toBeGreaterThan(Date.parse(before!.sentAt));
    expect(after[0]!.invitedBy).toEqual({ userId: f.manager.id, name: f.manager.name });

    const retired = await adminDb.verification.findUniqueOrThrow({ where: { id: first.id } });
    expect(retired.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(retired.expiresAt.getTime()).toBeGreaterThanOrEqual(resendAt - 1_000);
  });

  it('the old token is unknown to validate and accept; the new one validates and accepts', async () => {
    const f = await makeWorkspace('a');
    const joiner = await makeUser('joiner@example.com');
    const first = await send(f, joiner.email);
    await resend(f, first.id);
    const fresh = await liveRow(joiner.email);

    expect(await workspaceInvitesService.validateInvite(first.token)).toBeNull();
    expect(await workspaceInvitesService.validateInvite('never-issued')).toBeNull();
    await expect(
      workspaceInvitesService.acceptInvite(first.token, { id: joiner.id, email: joiner.email }),
    ).rejects.toBeInstanceOf(InviteExpiredOrMissingError);

    expect(await workspaceInvitesService.validateInvite(fresh.token)).toMatchObject({
      workspaceName: f.workspaceName,
      email: joiner.email,
    });
    await workspaceInvitesService.acceptInvite(fresh.token, { id: joiner.id, email: joiner.email });
    expect(
      await adminDb.workspaceMembership.count({
        where: { userId: joiner.id, workspaceId: f.workspaceId },
      }),
    ).toBe(1);
  });

  it("the delivery join follows the NEW token: the old token's bounce does not leak onto it", async () => {
    const f = await makeWorkspace('a');
    const first = await send(f, 'bounced-once@example.com');
    await seedDelivery(f, first.token, 'bounced');
    expect((await list(f))[0]!.deliveryState).toBe('bounced');

    await resend(f, first.id);
    expect((await list(f)).map((r) => r.deliveryState)).toEqual(['queued']);
  });

  it('neither an accepted nor a retired invite is listed; an empty workspace lists nothing', async () => {
    const f = await makeWorkspace('a');
    expect(await list(f)).toEqual([]);
    const joiner = await makeUser('accepted@example.com');
    const accepted = await send(f, joiner.email);
    await workspaceInvitesService.acceptInvite(accepted.token, {
      id: joiner.id,
      email: joiner.email,
    });
    const retired = await send(f, 'retired@example.com');
    await resend(f, retired.id);

    const rows = await list(f);
    expect(rows.map((r) => r.email)).toEqual(['retired@example.com']);
    expect(rows[0]!.id).not.toBe(retired.id);
  });
});

describe('delivery states from seeded rows', () => {
  it('reads all seven, accepted never as delivered', async () => {
    const f = await makeWorkspace('a');
    const seeds = {
      'queued@example.com': async () => undefined,
      'accepted@example.com': async (t: string) => seedDelivery(f, t, 'accepted'),
      'delivered@example.com': async (t: string) => seedDelivery(f, t, 'delivered'),
      'bounced@example.com': async (t: string) => seedDelivery(f, t, 'bounced'),
      'complained@example.com': async (t: string) => seedDelivery(f, t, 'complained'),
      'delayed@example.com': async (t: string) => seedDelivery(f, t, 'delayed'),
      'failed@example.com': async (t: string) => seedSendRun(f, t, 'failed'),
    };
    for (const [email, seed] of Object.entries(seeds)) {
      await seed((await send(f, email)).token);
    }

    const state = Object.fromEntries((await list(f)).map((r) => [r.email, r.deliveryState]));
    expect(state).toEqual({
      'queued@example.com': 'queued',
      'accepted@example.com': 'accepted',
      'delivered@example.com': 'delivered',
      'bounced@example.com': 'bounced',
      'complained@example.com': 'complained',
      'delayed@example.com': 'delayed',
      'failed@example.com': 'failed',
    });
    expect(state['accepted@example.com']).not.toBe('delivered');
  });

  it('a delivery row beats a failed ledger row; an abandoned run is not failed', async () => {
    const f = await makeWorkspace('a');
    const both = await send(f, 'both@example.com');
    await seedSendRun(f, both.token, 'failed');
    await seedDelivery(f, both.token, 'delivered');
    const abandoned = await send(f, 'abandoned@example.com');
    await seedSendRun(f, abandoned.token, 'abandoned');

    const state = Object.fromEntries((await list(f)).map((r) => [r.email, r.deliveryState]));
    expect(state).toEqual({ 'both@example.com': 'delivered', 'abandoned@example.com': 'queued' });
  });

  it('each workspace sees only its own invites and states, none downgraded to queued', async () => {
    const a = await makeWorkspace('a');
    const b = await makeWorkspace('b');
    const aBounced = await send(a, 'shared@example.com');
    await seedDelivery(a, aBounced.token, 'bounced');
    const aFailed = await send(a, 'a-only@example.com');
    await seedSendRun(a, aFailed.token, 'failed');
    const bDelivered = await send(b, 'shared@example.com');
    await seedDelivery(b, bDelivered.token, 'delivered');
    const bFailed = await send(b, 'b-only@example.com');
    await seedSendRun(b, bFailed.token, 'failed');

    const stateOf = async (f: Fixture) =>
      Object.fromEntries((await list(f)).map((r) => [r.email, r.deliveryState]));
    expect(await stateOf(a)).toEqual({
      'shared@example.com': 'bounced',
      'a-only@example.com': 'failed',
    });
    expect(await stateOf(b)).toEqual({
      'shared@example.com': 'delivered',
      'b-only@example.com': 'failed',
    });
  });
});

describe('the hourly limit counts retired rows', () => {
  it('the original plus two Resends pass; a third Resend and a fresh send are refused, writing nothing', async () => {
    const f = await makeWorkspace('a');
    await send(f, 'limit@example.com');
    await resend(f, (await liveRow('limit@example.com')).id);
    await resend(f, (await liveRow('limit@example.com')).id);

    const before = await snapshot();
    const third = await resend(f, (await liveRow('limit@example.com')).id).catch((e: unknown) => e);
    expect(third).toBeInstanceOf(InviteRateLimitedError);
    expect((third as InviteRateLimitedError).max).toBe(3);
    const fresh = await workspaceInvitesService
      .sendInvite({
        inviterUserId: f.manager.id,
        inviterName: f.manager.name,
        workspaceId: f.workspaceId,
        targetEmail: 'limit@example.com',
      })
      .catch((e: unknown) => e);
    expect(fresh).toBeInstanceOf(InviteRateLimitedError);
    expect((fresh as InviteRateLimitedError).max).toBe(3);
    await expectNothingWritten(before);
    expect((await list(f)).filter((r) => r.email === 'limit@example.com')).toHaveLength(1);

    asActor(f, f.manager);
    expect(await resendInviteAction((await liveRow('limit@example.com')).id)).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
    });
  });
});

describe('who may resend, and canResend agrees with it', () => {
  it('Manager: Limited and Full; Full non-Manager: Full only; Limited member and non-member: none', async () => {
    const f = await makeWorkspace('a');
    const outsider = await makeUser('outsider@example.com');
    await send(f, 'm-limited@example.com', { scope: 'limited' });
    await send(f, 'm-full@example.com');
    await send(f, 'f-full@example.com');
    await send(f, 'f-limited@example.com', { scope: 'limited' });
    await send(f, 'l-full@example.com');
    await send(f, 'o-full@example.com');

    const flag = async (viewer: User, email: string) =>
      (await list(f, viewer)).find((r) => r.email === email)!.canResend;
    const outcome = async (actor: User, email: string) =>
      resend(f, (await liveRow(email)).id, actor).then(
        () => 'ok' as const,
        (e: unknown) => e,
      );

    // The flag the list shows, read before each attempt, must equal the result.
    const cases: [User, string, true | (new (...a: never[]) => Error)][] = [
      [f.manager, 'm-limited@example.com', true],
      [f.manager, 'm-full@example.com', true],
      [f.full, 'f-full@example.com', true],
      [f.full, 'f-limited@example.com', InviteScopeForbiddenError],
    ];
    for (const [actor, email, expected] of cases) {
      const shown = await flag(actor, email);
      const before = await snapshot();
      const got = await outcome(actor, email);
      if (expected === true) {
        expect(got).toBe('ok');
        expect(shown).toBe(true);
      } else {
        expect(got).toBeInstanceOf(expected);
        expect(shown).toBe(false);
        await expectNothingWritten(before);
      }
    }

    const before = await snapshot();
    expect(await outcome(f.limited, 'l-full@example.com')).toBeInstanceOf(
      InviteNotAllowedForScopeError,
    );
    expect(await outcome(outsider, 'o-full@example.com')).toBeInstanceOf(NotAMemberError);
    await expectNothingWritten(before);

    asActor(f, f.full);
    expect(await resendInviteAction((await liveRow('f-limited@example.com')).id)).toEqual({
      ok: false,
      code: 'INVITE_SCOPE_FORBIDDEN',
    });
    asActor(f, f.limited);
    expect(await resendInviteAction((await liveRow('l-full@example.com')).id)).toEqual({
      ok: false,
      code: 'INVITE_NOT_ALLOWED_FOR_SCOPE',
    });
    asActor(f, outsider);
    expect(await resendInviteAction((await liveRow('o-full@example.com')).id)).toEqual({
      ok: false,
      code: 'NOT_A_MEMBER',
    });
    await expectNothingWritten(before);
  });

  it('a Limited member and a non-member cannot read the list', async () => {
    const f = await makeWorkspace('a');
    const outsider = await makeUser('outsider@example.com');
    await send(f, 'x@example.com');
    await expect(list(f, f.limited)).rejects.toBeInstanceOf(InviteNotAllowedForScopeError);
    await expect(list(f, outsider)).rejects.toBeInstanceOf(NotAMemberError);
  });
});

describe('Resend refusals on the invite itself', () => {
  it('an address that has since joined is ALREADY_MEMBER, writing nothing', async () => {
    const f = await makeWorkspace('a');
    const joiner = await makeUser('joined@example.com');
    const earlier = await send(f, joiner.email);
    await workspacesService.addMember({ userId: joiner.id, workspaceId: f.workspaceId });

    const before = await snapshot();
    await expect(resend(f, earlier.id)).rejects.toBeInstanceOf(InviteTargetAlreadyMemberError);
    asActor(f, f.manager);
    expect(await resendInviteAction(earlier.id)).toEqual({ ok: false, code: 'ALREADY_MEMBER' });
    await expectNothingWritten(before);
  });

  it('another workspace, expired, retired, non-invite and unknown rows are all the same refusal', async () => {
    const f = await makeWorkspace('a');
    const other = await makeWorkspace('b');
    const foreign = await send(other, 'foreign@example.com');
    const expired = await send(f, 'expired@example.com');
    await adminDb.verification.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const retired = await send(f, 'retired@example.com');
    await resend(f, retired.id);
    const notInvite = await adminDb.verification.create({
      data: {
        identifier: `trust-device-${randomToken()}`,
        value: f.manager.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const before = await snapshot();
    asActor(f, f.manager);
    for (const id of [foreign.id, expired.id, retired.id, notInvite.id, 'no-such-id']) {
      await expect(resend(f, id)).rejects.toBeInstanceOf(InviteExpiredOrMissingError);
      expect(await resendInviteAction(id)).toEqual({
        ok: false,
        code: 'INVITE_EXPIRED_OR_MISSING',
      });
    }
    await expectNothingWritten(before);
  });

  it('two concurrent Resends: one wins, one is refused, one live link remains', async () => {
    const f = await makeWorkspace('a');
    const invite = await send(f, 'race@example.com');
    const results = await Promise.allSettled([resend(f, invite.id), resend(f, invite.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(InviteExpiredOrMissingError);
    await liveRow('race@example.com');
    expect((await list(f)).filter((r) => r.email === 'race@example.com')).toHaveLength(1);
  });
});

describe('resendInviteAction', () => {
  it('succeeds for a Manager and revalidates both hosts of the Members card', async () => {
    const f = await makeWorkspace('a');
    const invite = await send(f, 'ok@example.com');
    asActor(f, f.manager);
    expect(await resendInviteAction(invite.id)).toEqual({ ok: true });
    expect(revalidated).toEqual(
      expect.arrayContaining(['/settings/workspace', '/settings/organization']),
    );
  });
});
