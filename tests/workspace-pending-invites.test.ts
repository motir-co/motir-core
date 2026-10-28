import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  INVITE_EXPIRY_MS,
  INVITE_IDENTIFIER_PREFIX,
  workspaceInvitesService,
} from '@/lib/services/workspaceInvitesService';
import { InviteNotAllowedForScopeError, NotAMemberError } from '@/lib/workspaces/errors';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from './helpers/db';
import { captureEmailEvents } from './helpers/jobs';
import { randomToken } from './helpers/random';

// The pending-invitations READ (MOTIR-9995), against a real Postgres. Invites
// are planted through `sendInvite`, so each row is exactly what production
// writes; delivery records and dead-lettered runs are seeded the way the
// `email.send` job and the ledger write them, keyed on the invite token.

let emailEvents: ReturnType<typeof captureEmailEvents>;

async function makeWorkspace(email: string, name: string, workspaceName = 'Acme Co.') {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name });
  const { workspace } = await workspacesService.createWorkspace({
    name: workspaceName,
    ownerUserId: user.id,
  });
  return { user, workspace };
}

async function addMember(workspaceId: string, email: string, scope: 'full' | 'limited') {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await workspacesService.addMember({ userId: user.id, workspaceId });
  if (scope === 'limited') {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
      data: { accessScope: 'limited' },
    });
  }
  return user;
}

async function invite(args: {
  inviterUserId: string;
  workspaceId: string;
  email: string;
  accessScope?: 'full' | 'limited';
  projectIds?: string[];
}): Promise<string> {
  await workspaceInvitesService.sendInvite({
    inviterUserId: args.inviterUserId,
    inviterName: 'Inviter',
    workspaceId: args.workspaceId,
    targetEmail: args.email,
    accessScope: args.accessScope,
    projectIds: args.projectIds,
  });
  const row = await adminDb.verification.findFirstOrThrow({
    where: {
      identifier: { startsWith: INVITE_IDENTIFIER_PREFIX },
      value: { contains: args.email },
    },
    orderBy: { createdAt: 'desc' },
  });
  return row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length);
}

async function seedDelivery(
  workspaceId: string,
  token: string,
  state: 'accepted' | 'delivered' | 'bounced' | 'complained' | 'delayed',
): Promise<void> {
  await adminDb.emailDelivery.create({
    data: {
      providerMessageId: `msg_${randomToken()}`,
      provider: 'resend',
      recipient: 'someone@example.com',
      template: 'workspace-invite',
      workspaceId,
      idempotencyKey: token,
      state,
    },
  });
}

async function seedSendRun(
  workspaceId: string,
  token: string,
  status: 'failed' | 'abandoned' | 'succeeded',
): Promise<void> {
  await adminDb.jobRun.create({
    data: {
      workspaceId,
      functionId: 'email.send',
      eventName: 'email.send',
      eventId: `evt-${randomToken()}`,
      lane: 'engine',
      attempt: 0,
      status,
      idempotencyKey: token,
    },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
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

describe('listPendingInvites — what is listed', () => {
  it('lists each pending invitation, newest first, with its inviter, dates, scope and project count', async () => {
    const { user: manager, workspace } = await makeWorkspace('mgr@example.com', 'Ana Ruiz');
    const alpha = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: manager.id,
      name: 'Alpha',
    });
    const beta = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: manager.id,
      name: 'Beta',
    });
    const fullToken = await invite({
      inviterUserId: manager.id,
      workspaceId: workspace.id,
      email: 'full@example.com',
    });
    // The Full invitation is the older one.
    await adminDb.verification.updateMany({
      where: { identifier: INVITE_IDENTIFIER_PREFIX + fullToken },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    await invite({
      inviterUserId: manager.id,
      workspaceId: workspace.id,
      email: 'limited@example.com',
      accessScope: 'limited',
      projectIds: [alpha.id, beta.id],
    });

    const list = await workspaceInvitesService.listPendingInvites({
      userId: manager.id,
      workspaceId: workspace.id,
    });

    expect(list.map((i) => i.email)).toEqual(['limited@example.com', 'full@example.com']);
    const [limited, full] = list;
    expect(limited).toMatchObject({
      accessScope: 'limited',
      projectCount: 2,
      invitedBy: { userId: manager.id, name: 'Ana Ruiz' },
      deliveryState: 'queued',
    });
    expect(full).toMatchObject({ accessScope: 'full', projectCount: 0 });
    // Seven days after sending (the Full row's sent time was back-dated above).
    const lifetime = new Date(limited!.expiresAt).getTime() - new Date(limited!.sentAt).getTime();
    expect(Math.abs(lifetime - INVITE_EXPIRY_MS)).toBeLessThan(5_000);
  });

  it('leaves out accepted, expired, back-dated and other-workspace invitations; an empty workspace lists nothing', async () => {
    const { user: manager, workspace } = await makeWorkspace('mgr@example.com', 'Manager');
    const { workspace: other } = await makeWorkspace('other@example.com', 'Other', 'Other Co.');

    expect(
      await workspaceInvitesService.listPendingInvites({
        userId: manager.id,
        workspaceId: workspace.id,
      }),
    ).toEqual([]);

    // Accepted: the row is deleted on accept.
    const joiner = await usersService.createUser({
      email: 'joiner@example.com',
      password: 'hunter2hunter2',
      name: 'Joiner',
    });
    const acceptedToken = await invite({
      inviterUserId: manager.id,
      workspaceId: workspace.id,
      email: joiner.email,
    });
    await workspaceInvitesService.acceptInvite(acceptedToken, {
      id: joiner.id,
      email: joiner.email,
    });
    // Expired, and retired by back-dating — the same row state either way.
    const expiredToken = await invite({
      inviterUserId: manager.id,
      workspaceId: workspace.id,
      email: 'expired@example.com',
    });
    await adminDb.verification.updateMany({
      where: { identifier: INVITE_IDENTIFIER_PREFIX + expiredToken },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    // A payload naming ANOTHER workspace whose value still contains this
    // workspace's id — the substring filter alone would admit it.
    await adminDb.verification.create({
      data: {
        identifier: INVITE_IDENTIFIER_PREFIX + `planted-${randomToken()}`,
        value: JSON.stringify({
          workspaceId: other.id,
          email: `${workspace.id}@example.com`,
          workspaceRole: 'member',
          inviterUserId: manager.id,
        }),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await invite({
      inviterUserId: manager.id,
      workspaceId: workspace.id,
      email: 'live@example.com',
    });

    const list = await workspaceInvitesService.listPendingInvites({
      userId: manager.id,
      workspaceId: workspace.id,
    });
    expect(list.map((i) => i.email)).toEqual(['live@example.com']);
  });
});

describe('listPendingInvites — delivery state', () => {
  it('derives each of the seven states, a delivery record winning over a failed send', async () => {
    const { user: manager, workspace } = await makeWorkspace('mgr@example.com', 'Manager');
    const send = (email: string) =>
      invite({ inviterUserId: manager.id, workspaceId: workspace.id, email });

    const queued = await send('queued@example.com');
    await seedSendRun(workspace.id, queued, 'abandoned'); // not a dead letter
    const accepted = await send('accepted@example.com');
    await seedDelivery(workspace.id, accepted, 'accepted');
    const delivered = await send('delivered@example.com');
    await seedDelivery(workspace.id, delivered, 'delivered');
    const bounced = await send('bounced@example.com');
    await seedDelivery(workspace.id, bounced, 'bounced');
    const complained = await send('complained@example.com');
    await seedDelivery(workspace.id, complained, 'complained');
    const delayed = await send('delayed@example.com');
    await seedDelivery(workspace.id, delayed, 'delayed');
    const failed = await send('failed@example.com');
    await seedSendRun(workspace.id, failed, 'failed');
    const both = await send('both@example.com');
    await seedSendRun(workspace.id, both, 'failed');
    await seedDelivery(workspace.id, both, 'delayed');

    const list = await workspaceInvitesService.listPendingInvites({
      userId: manager.id,
      workspaceId: workspace.id,
    });
    const stateOf = Object.fromEntries(list.map((i) => [i.email, i.deliveryState]));
    expect(stateOf).toEqual({
      'queued@example.com': 'queued',
      'accepted@example.com': 'accepted',
      'delivered@example.com': 'delivered',
      'bounced@example.com': 'bounced',
      'complained@example.com': 'complained',
      'delayed@example.com': 'delayed',
      'failed@example.com': 'failed',
      'both@example.com': 'delayed',
    });
  });

  it('each workspace sees only its own deliveries, and no field carries the token or the accept link', async () => {
    const a = await makeWorkspace('a@example.com', 'A', 'A Co.');
    const b = await makeWorkspace('b@example.com', 'B', 'B Co.');
    const tokenA = await invite({
      inviterUserId: a.user.id,
      workspaceId: a.workspace.id,
      email: 'shared@example.com',
    });
    const tokenB = await invite({
      inviterUserId: b.user.id,
      workspaceId: b.workspace.id,
      email: 'shared@example.com',
    });
    await seedDelivery(a.workspace.id, tokenA, 'delivered');
    await seedDelivery(b.workspace.id, tokenB, 'bounced');
    await seedSendRun(b.workspace.id, tokenB, 'failed');

    const listA = await workspaceInvitesService.listPendingInvites({
      userId: a.user.id,
      workspaceId: a.workspace.id,
    });
    const listB = await workspaceInvitesService.listPendingInvites({
      userId: b.user.id,
      workspaceId: b.workspace.id,
    });
    expect(listA.map((i) => i.deliveryState)).toEqual(['delivered']);
    expect(listB.map((i) => i.deliveryState)).toEqual(['bounced']);

    const serialized = JSON.stringify([...listA, ...listB]);
    expect(serialized).not.toContain(tokenA);
    expect(serialized).not.toContain(tokenB);
    expect(serialized).not.toContain('/invite/accept');
  });
});

describe('listPendingInvites — who may read it', () => {
  it('refuses a non-member and a Limited member with no invite data', async () => {
    const { user: manager, workspace } = await makeWorkspace('mgr@example.com', 'Manager');
    await invite({ inviterUserId: manager.id, workspaceId: workspace.id, email: 'x@example.com' });
    const outsider = await usersService.createUser({
      email: 'outsider@example.com',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    const limited = await addMember(workspace.id, 'limited-member@example.com', 'limited');

    await expect(
      workspaceInvitesService.listPendingInvites({
        userId: outsider.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toBeInstanceOf(NotAMemberError);
    await expect(
      workspaceInvitesService.listPendingInvites({ userId: limited.id, workspaceId: workspace.id }),
    ).rejects.toBeInstanceOf(InviteNotAllowedForScopeError);
  });

  it('canResend: every row for a Manager, only Full rows for a Full non-Manager', async () => {
    const { user: manager, workspace } = await makeWorkspace('mgr@example.com', 'Manager');
    const full = await addMember(workspace.id, 'full-member@example.com', 'full');
    await invite({
      inviterUserId: manager.id,
      workspaceId: workspace.id,
      email: 'full-invite@example.com',
    });
    await invite({
      inviterUserId: manager.id,
      workspaceId: workspace.id,
      email: 'limited-invite@example.com',
      accessScope: 'limited',
    });

    const byManager = await workspaceInvitesService.listPendingInvites({
      userId: manager.id,
      workspaceId: workspace.id,
    });
    const byFull = await workspaceInvitesService.listPendingInvites({
      userId: full.id,
      workspaceId: workspace.id,
    });
    const resendable = (list: typeof byManager) =>
      Object.fromEntries(list.map((i) => [i.email, i.canResend]));
    expect(resendable(byManager)).toEqual({
      'full-invite@example.com': true,
      'limited-invite@example.com': true,
    });
    expect(resendable(byFull)).toEqual({
      'full-invite@example.com': true,
      'limited-invite@example.com': false,
    });
  });
});
