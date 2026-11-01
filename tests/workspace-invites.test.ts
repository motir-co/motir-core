import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock for getSession — the routes call it to read the signed-in
// user. The mock returns whatever `mockSession.current` holds at call
// time, so each test can swap the session by mutating that object.
const mockSession: { current: { user: { id: string; email: string; name: string } } | null } = {
  current: null,
};
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getSession: async () => mockSession.current,
  };
});
// The Resend server action (MOTIR-9996) also reads the active workspace and
// revalidates; the invite routes touch neither, so these mocks change nothing
// for them.
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
import { projectsService } from '@/lib/services/projectsService';
import { organizationsService } from '@/lib/services/organizationsService';
import {
  INVITE_IDENTIFIER_PREFIX,
  workspaceInvitesService,
} from '@/lib/services/workspaceInvitesService';
import { verificationRepository } from '@/lib/repositories/verificationRepository';
import { resendInviteAction } from '@/app/(authed)/settings/workspace/actions';
import {
  InviteExpiredOrMissingError,
  InviteNotAllowedForScopeError,
  InviteRateLimitedError,
  InviteScopeForbiddenError,
  InviteTargetAlreadyMemberError,
  NotAMemberError,
} from '@/lib/workspaces/errors';
import { POST as sendInvitePOST } from '@/app/api/workspaces/[workspaceId]/invites/route';
import { GET as validateInviteGET } from '@/app/api/invites/[token]/route';
import { POST as acceptInvitePOST } from '@/app/api/invites/[token]/accept/route';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from './helpers/db';
import { captureConsoleEmails, captureEmailEvents, runEmailSendJob } from './helpers/jobs';

// Integration tests against a real Postgres. Hits the route handlers
// directly (so the request → service → repo → Prisma chain is
// exercised end-to-end), then asserts DB state via the service for
// reads where we already have a helper, and via `db.*` for raw row
// counts when no service helper exists. Per CLAUDE.md, reaching into
// `db.*` is allowed in tests for state assertions.

const BASE_URL = 'http://localhost:3000';

// Story 1.6.3: sendInvite no longer dispatches the email inline — it ENQUEUES
// an `email.send` event. So we capture the enqueued events (which also stops
// the publish from reaching a non-existent dev server) for the whole file:
// every helper that plants an invite (createInvite) goes through sendInvite,
// so the spy must be active in every block, not just the "send" describe.
let emailEvents: ReturnType<typeof captureEmailEvents>;

function paramsFor<T>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

function postInvite(workspaceId: string, body: unknown): Promise<Response> {
  return sendInvitePOST(
    new Request(`${BASE_URL}/api/workspaces/${workspaceId}/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    paramsFor({ workspaceId }),
  );
}

function getValidate(token: string): Promise<Response> {
  return validateInviteGET(
    new Request(`${BASE_URL}/api/invites/${token}`, { method: 'GET' }),
    paramsFor({ token }),
  );
}

function postAccept(token: string): Promise<Response> {
  return acceptInvitePOST(
    new Request(`${BASE_URL}/api/invites/${token}/accept`, { method: 'POST' }),
    paramsFor({ token }),
  );
}

async function makeInviter(email = 'inviter@example.com', name = 'Inviter One') {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name });
  const { workspace, membership } = await workspacesService.createWorkspace({
    name: 'Acme Co.',
    ownerUserId: user.id,
  });
  return { user, workspace, membership };
}

// Helper to plant an invite directly via the service when a test
// needs to set one up without going through the email path.
async function createInvite(args: {
  workspaceId: string;
  email: string;
  inviterUserId: string;
}): Promise<string> {
  await workspaceInvitesService.sendInvite({
    inviterUserId: args.inviterUserId,
    inviterName: 'Inviter',
    workspaceId: args.workspaceId,
    targetEmail: args.email,
  });
  const row = await adminDb.verification.findFirstOrThrow({
    where: {
      identifier: { startsWith: INVITE_IDENTIFIER_PREFIX },
      value: { contains: args.email },
    },
  });
  return row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length);
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  mockSession.current = null;
  activeWorkspace.current = null;
  revalidated.length = 0;
  emailEvents = captureEmailEvents();
});

afterEach(() => {
  emailEvents.restore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST /api/workspaces/[workspaceId]/invites — send', () => {
  it('creates a Verification row and enqueues the invite email (happy path)', async () => {
    const { user, workspace } = await makeInviter();
    mockSession.current = { user: { id: user.id, email: user.email, name: user.name } };

    const res = await postInvite(workspace.id, { email: 'newbie@example.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const rows = await adminDb.verification.findMany({
      where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX } },
    });
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.value);
    // `workspaceRole` alone — the legacy `role` key is retired (MOTIR-6569).
    expect(payload).toEqual({
      workspaceId: workspace.id,
      email: 'newbie@example.com',
      workspaceRole: 'member',
      inviterUserId: user.id,
      // A Full invite naming no project — the default (Story MOTIR-6169 · MOTIR-6546).
      accessScope: 'full',
      projectIds: [],
    });
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const token = rows[0]!.identifier.slice(INVITE_IDENTIFIER_PREFIX.length);

    // Exactly one tenanted email.send event was enqueued for the invitee,
    // keyed by the invite token, with the workspace-invite template.
    expect(emailEvents.events).toHaveLength(1);
    const event = emailEvents.events[0]!;
    expect(event.data.template).toBe('workspace-invite');
    expect(event.data.to).toBe('newbie@example.com');
    expect(event.data.workspaceId).toBe(workspace.id);
    expect(event.data.idempotencyKey).toBe(token);

    // End-to-end: draining the queued event renders + sends the invite, with
    // the accept link unredacted in the plain-text body (dev-console contract
    // from 1.1.6).
    const emails = captureConsoleEmails();
    try {
      await runEmailSendJob(event.data);
      expect(emails.lines).toHaveLength(1);
      expect(emails.lines[0]).toContain('To: newbie@example.com');
      expect(emails.lines[0]).toContain("You're invited to join Acme Co. on Motir");
      expect(emails.lines[0]).toMatch(/Accept invite: https?:\/\/[^\s]+\/invite\/accept\?token=/);
    } finally {
      emails.restore();
    }
  });

  it('returns 422 ALREADY_MEMBER when target email is already in the workspace', async () => {
    const { user, workspace } = await makeInviter();
    const teammate = await usersService.createUser({
      email: 'teammate@example.com',
      password: 'hunter2hunter2',
      name: 'Teammate',
    });
    await workspacesService.addMember({ userId: teammate.id, workspaceId: workspace.id });
    mockSession.current = { user: { id: user.id, email: user.email, name: user.name } };

    const res = await postInvite(workspace.id, { email: 'teammate@example.com' });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('ALREADY_MEMBER');

    const rows = await adminDb.verification.count({
      where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX } },
    });
    expect(rows).toBe(0);
    expect(emailEvents.events).toHaveLength(0);
  });

  it('returns 404 NOT_FOUND when requester is not in the workspace (anti-enumeration)', async () => {
    // Subtask 1.2.7: cross-tenant invite attempts must NOT return 403. A 403
    // ("you're not a member") confirms the workspace exists; the route now
    // maps NotAMemberError → 404 so a probing attacker can't distinguish a
    // real-but-foreign workspace id from one that never existed.
    const { workspace } = await makeInviter();
    const outsider = await usersService.createUser({
      email: 'outsider@example.com',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    mockSession.current = {
      user: { id: outsider.id, email: outsider.email, name: outsider.name },
    };

    const res = await postInvite(workspace.id, { email: 'newbie@example.com' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('NOT_FOUND');

    const rows = await adminDb.verification.count({
      where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX } },
    });
    expect(rows).toBe(0);
    expect(emailEvents.events).toHaveLength(0);
  });

  it('rate-limits: 3 invites in the window succeed, 4th returns 429 RATE_LIMITED', async () => {
    const { user, workspace } = await makeInviter();
    mockSession.current = { user: { id: user.id, email: user.email, name: user.name } };

    for (let i = 0; i < 3; i++) {
      const res = await postInvite(workspace.id, { email: 'spam-target@example.com' });
      expect(res.status).toBe(200);
    }
    const fourth = await postInvite(workspace.id, { email: 'spam-target@example.com' });
    expect(fourth.status).toBe(429);
    const body = await fourth.json();
    expect(body.code).toBe('RATE_LIMITED');

    const rows = await adminDb.verification.count({
      where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX } },
    });
    expect(rows).toBe(3);
    expect(emailEvents.events).toHaveLength(3);
  });
});

describe('POST /api/invites/[token]/accept', () => {
  it('happy path: matching email → creates membership and consumes token', async () => {
    const { user: inviter, workspace } = await makeInviter();
    const invitee = await usersService.createUser({
      email: 'invitee@example.com',
      password: 'hunter2hunter2',
      name: 'Invitee',
    });
    const token = await createInvite({
      workspaceId: workspace.id,
      email: invitee.email,
      inviterUserId: inviter.id,
    });

    mockSession.current = {
      user: { id: invitee.id, email: invitee.email, name: invitee.name },
    };
    const res = await postAccept(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: workspace.id, skippedProjects: [] });

    const membership = await workspacesService.findMembership(invitee.id, workspace.id);
    expect(membership).not.toBeNull();

    const remaining = await adminDb.verification.count({
      where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX } },
    });
    expect(remaining).toBe(0);
  });

  it('upward-auto-joins the invitee into the workspace’s ORG so the access gate grants access (Story 6.10.4)', async () => {
    // Regression: the org access gate (6.10.4) DENIES a workspace member who is
    // not an org member, so accepting a cross-org invite MUST also enrol the
    // invitee in the workspace's org — otherwise the post-accept active-workspace
    // resolution can't reach the joined workspace (the workspace-flows e2e timed
    // out on exactly this).
    const { user: inviter, workspace } = await makeInviter('inviter2@example.com', 'Inviter Two');
    const invitee = await usersService.createUser({
      email: 'crossorg@example.com',
      password: 'hunter2hunter2',
      name: 'Cross Org',
    });
    const token = await createInvite({
      workspaceId: workspace.id,
      email: invitee.email,
      inviterUserId: inviter.id,
    });

    mockSession.current = {
      user: { id: invitee.id, email: invitee.email, name: invitee.name },
    };
    const res = await postAccept(token);
    expect(res.status).toBe(200);

    // The invitee is now an ORG member (role member) of the workspace's org...
    const access = await organizationsService.resolveWorkspaceAccess(invitee.id, workspace.id);
    expect(access).not.toBeNull();
    expect(access!.orgRole).toBe('member');
    // ...and the active-workspace resolver can land them on the joined workspace.
    const resolved = await workspacesService.resolveActiveWorkspace(invitee.id, workspace.id);
    expect(resolved).toBe(workspace.id);
  });

  it('returns 403 INVITE_EMAIL_MISMATCH and preserves the token when email differs', async () => {
    const { user: inviter, workspace } = await makeInviter();
    const wrong = await usersService.createUser({
      email: 'wrong@example.com',
      password: 'hunter2hunter2',
      name: 'Wrong',
    });
    const token = await createInvite({
      workspaceId: workspace.id,
      email: 'target@example.com',
      inviterUserId: inviter.id,
    });

    mockSession.current = { user: { id: wrong.id, email: wrong.email, name: wrong.name } };
    const res = await postAccept(token);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('INVITE_EMAIL_MISMATCH');

    // Token survives — they can sign in with the right email and retry.
    const stillThere = await workspaceInvitesService.validateInvite(token);
    expect(stillThere).not.toBeNull();
    // No membership was created.
    const memberships = await workspacesService.findMembership(wrong.id, workspace.id);
    expect(memberships).toBeNull();
  });

  it('returns 404 INVITE_EXPIRED_OR_MISSING when the token is expired', async () => {
    const { user: inviter, workspace } = await makeInviter();
    const invitee = await usersService.createUser({
      email: 'late@example.com',
      password: 'hunter2hunter2',
      name: 'Late',
    });
    const token = await createInvite({
      workspaceId: workspace.id,
      email: invitee.email,
      inviterUserId: inviter.id,
    });
    // Backdate the row's expiresAt to simulate "clicked after 7 days".
    await adminDb.verification.updateMany({
      where: { identifier: INVITE_IDENTIFIER_PREFIX + token },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    mockSession.current = {
      user: { id: invitee.id, email: invitee.email, name: invitee.name },
    };
    const res = await postAccept(token);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('INVITE_EXPIRED_OR_MISSING');
  });

  it('single-use: a second accept with the same token returns 404 (token consumed)', async () => {
    const { user: inviter, workspace } = await makeInviter();
    const invitee = await usersService.createUser({
      email: 'twice@example.com',
      password: 'hunter2hunter2',
      name: 'Twice',
    });
    const token = await createInvite({
      workspaceId: workspace.id,
      email: invitee.email,
      inviterUserId: inviter.id,
    });
    mockSession.current = {
      user: { id: invitee.id, email: invitee.email, name: invitee.name },
    };

    const first = await postAccept(token);
    expect(first.status).toBe(200);

    const second = await postAccept(token);
    expect(second.status).toBe(404);
    expect((await second.json()).code).toBe('INVITE_EXPIRED_OR_MISSING');
  });
});

describe('accept — the invite payload names its `workspaceRole` (MOTIR-6569)', () => {
  // A pending invite is a Verification row whose `value` is the JSON payload.
  // Its role is `workspaceRole`. A token minted before MOTIR-6562 carried only
  // the legacy `role`; every such token lapsed after 7 days, so MOTIR-6569
  // retired the fallback and a `role`-only payload is refused.
  async function plantInvite(workspaceId: string, email: string, fields: object): Promise<string> {
    const token = `planted-${email.split('@')[0]}`;
    await adminDb.verification.create({
      data: {
        identifier: INVITE_IDENTIFIER_PREFIX + token,
        value: JSON.stringify({ workspaceId, email, ...fields }),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  async function acceptAs(email: string, token: string) {
    const invitee = await usersService.createUser({
      email,
      password: 'hunter2hunter2',
      name: email.split('@')[0]!,
    });
    mockSession.current = { user: { id: invitee.id, email: invitee.email, name: invitee.name } };
    const res = await postAccept(token);
    return { res, invitee };
  }

  async function workspaceRoleOf(userId: string, workspaceId: string) {
    const m = await adminDb.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    return m?.workspaceRole;
  }

  it('a token carrying only the legacy `role` key is refused, and no membership is written', async () => {
    const { user, workspace } = await makeInviter();
    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      const email = `legacy-${role}@example.com`;
      const token = await plantInvite(workspace.id, email, { role, inviterUserId: user.id });
      const { res, invitee } = await acceptAs(email, token);
      expect(res.status, role).toBe(404);
      expect(await workspaceRoleOf(invitee.id, workspace.id), role).toBeUndefined();
    }
  });

  it('a token naming only `workspaceRole` is accepted as that role', async () => {
    const { user, workspace } = await makeInviter();
    const token = await plantInvite(workspace.id, 'new@example.com', {
      workspaceRole: 'viewer',
      inviterUserId: user.id,
    });
    const { res, invitee } = await acceptAs('new@example.com', token);
    expect(res.status).toBe(200);
    expect(await workspaceRoleOf(invitee.id, workspace.id)).toBe('viewer');
  });

  it('a stray legacy `role` beside `workspaceRole` is ignored', async () => {
    const { user, workspace } = await makeInviter();
    const token = await plantInvite(workspace.id, 'both@example.com', {
      workspaceRole: 'member',
      role: 'owner',
      inviterUserId: user.id,
    });
    const { res, invitee } = await acceptAs('both@example.com', token);
    expect(res.status).toBe(200);
    expect(await workspaceRoleOf(invitee.id, workspace.id)).toBe('member');
  });

  it('a token naming neither role — or only unknown values — is refused as invalid', async () => {
    const { user, workspace } = await makeInviter();
    const neither = await plantInvite(workspace.id, 'neither@example.com', {
      inviterUserId: user.id,
    });
    const bogus = await plantInvite(workspace.id, 'bogus@example.com', {
      workspaceRole: 'superuser',
      role: 'root',
      inviterUserId: user.id,
    });
    for (const [email, token] of [
      ['neither@example.com', neither],
      ['bogus@example.com', bogus],
    ] as const) {
      const { res, invitee } = await acceptAs(email, token);
      expect(res.status).toBe(404);
      expect(await workspaceRoleOf(invitee.id, workspace.id)).toBeUndefined();
    }
  });
});

describe('GET /api/invites/[token] — validate', () => {
  it('returns { workspaceName, inviterName, email } for a live token', async () => {
    const { user: inviter, workspace } = await makeInviter('boss@example.com', 'Ben Liu');
    const token = await createInvite({
      workspaceId: workspace.id,
      email: 'newbie@example.com',
      inviterUserId: inviter.id,
    });

    const res = await getValidate(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspaceName: 'Acme Co.',
      inviterName: 'Ben Liu',
      email: 'newbie@example.com',
    });
  });
});

// ── Story MOTIR-6169 · MOTIR-6546 — an invite carries the access scope ──────────

describe('an invite carries the access scope', () => {
  async function setup() {
    const { user: manager, workspace } = await makeInviter('mgr-scope@example.com', 'Manager');
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
    const contractor = await usersService.createUser({
      email: 'contractor-scope@example.com',
      password: 'hunter2hunter2',
      name: 'Contractor',
    });
    return { manager, workspace, alpha, beta, contractor };
  }

  async function tokenFor(email: string): Promise<string> {
    const row = await adminDb.verification.findFirstOrThrow({
      where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX }, value: { contains: email } },
    });
    return row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length);
  }

  it("a Manager's Limited invite with one project → accept → a Limited membership and exactly that project", async () => {
    const f = await setup();
    mockSession.current = { user: { id: f.manager.id, email: f.manager.email, name: 'Manager' } };
    const sent = await postInvite(f.workspace.id, {
      email: f.contractor.email,
      accessScope: 'limited',
      projectIds: [f.alpha.id],
    });
    expect(sent.status).toBe(200);
    const token = await tokenFor(f.contractor.email);

    mockSession.current = {
      user: { id: f.contractor.id, email: f.contractor.email, name: 'Contractor' },
    };
    const res = await postAccept(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: f.workspace.id, skippedProjects: [] });

    const membership = await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: f.contractor.id, workspaceId: f.workspace.id } },
    });
    expect(membership.accessScope).toBe('limited');
    const added = await adminDb.projectMembership.findMany({ where: { userId: f.contractor.id } });
    expect(added.map((r) => r.projectId)).toEqual([f.alpha.id]);
    const listed = await projectsService.listProjects(f.workspace.id, f.contractor.id);
    expect(listed.map((p) => p.identifier)).toEqual([f.alpha.identifier]);
  });

  it('an invite stored before the change — no accessScope, no projectIds — accepts as Full with no project rows', async () => {
    const f = await setup();
    const token = 'legacy-scope-token';
    await adminDb.verification.create({
      data: {
        identifier: INVITE_IDENTIFIER_PREFIX + token,
        value: JSON.stringify({
          workspaceId: f.workspace.id,
          email: f.contractor.email,
          workspaceRole: 'member',
          inviterUserId: f.manager.id,
        }),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    mockSession.current = {
      user: { id: f.contractor.id, email: f.contractor.email, name: 'Contractor' },
    };
    expect((await postAccept(token)).status).toBe(200);
    const membership = await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: f.contractor.id, workspaceId: f.workspace.id } },
    });
    expect(membership.accessScope).toBe('full');
    expect(await adminDb.projectMembership.count({ where: { userId: f.contractor.id } })).toBe(0);
  });

  it('a Limited member cannot invite, and a Full Member cannot send a Limited or project invite — none writes a row', async () => {
    const f = await setup();
    const limited = await usersService.createUser({
      email: 'limited-inviter@example.com',
      password: 'hunter2hunter2',
      name: 'Limited',
    });
    await workspacesService.addMember({ userId: limited.id, workspaceId: f.workspace.id });
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: limited.id, workspaceId: f.workspace.id } },
      data: { accessScope: 'limited' },
    });
    const full = await usersService.createUser({
      email: 'full-inviter@example.com',
      password: 'hunter2hunter2',
      name: 'Full',
    });
    await workspacesService.addMember({ userId: full.id, workspaceId: f.workspace.id });

    const before = await adminDb.verification.count();
    mockSession.current = { user: { id: limited.id, email: limited.email, name: 'Limited' } };
    const byLimited = await postInvite(f.workspace.id, { email: 'x1@example.com' });
    expect(byLimited.status).toBe(403);
    expect(((await byLimited.json()) as { code: string }).code).toBe(
      'INVITE_NOT_ALLOWED_FOR_SCOPE',
    );

    mockSession.current = { user: { id: full.id, email: full.email, name: 'Full' } };
    const limitedInvite = await postInvite(f.workspace.id, {
      email: 'x2@example.com',
      accessScope: 'limited',
    });
    expect(limitedInvite.status).toBe(403);
    expect(((await limitedInvite.json()) as { code: string }).code).toBe('INVITE_SCOPE_FORBIDDEN');
    const projectInvite = await postInvite(f.workspace.id, {
      email: 'x3@example.com',
      accessScope: 'limited',
      projectIds: [f.alpha.id],
    });
    expect(projectInvite.status).toBe(403);
    expect(await adminDb.verification.count()).toBe(before);
    // …while a Full Member's Full invite still works, as before.
    expect((await postInvite(f.workspace.id, { email: 'x4@example.com' })).status).toBe(200);
  });

  it('a malformed projectIds is a 400 before anything is read (MOTIR-6546)', async () => {
    const f = await setup();
    mockSession.current = { user: { id: f.manager.id, email: f.manager.email, name: 'Manager' } };
    for (const projectIds of ['p1', [1, 2], [f.alpha.id, null]]) {
      const res = await postInvite(f.workspace.id, {
        email: 'bad-ids@example.com',
        accessScope: 'limited',
        projectIds,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
    }
  });

  it('projects on a Full invite are a 400, and so is a project of another workspace or an archived one', async () => {
    const f = await setup();
    const { workspace: elsewhere, user: otherOwner } = await makeInviter(
      'other-scope@example.com',
      'Other',
    );
    const foreign = await projectsService.createProject({
      workspaceId: elsewhere.id,
      actorUserId: otherOwner.id,
      name: 'Foreign',
    });
    await adminDb.project.update({ where: { id: f.beta.id }, data: { archivedAt: new Date() } });
    const before = await adminDb.verification.count();
    mockSession.current = { user: { id: f.manager.id, email: f.manager.email, name: 'Manager' } };
    const fullWithProjects = await postInvite(f.workspace.id, {
      email: 'y1@example.com',
      accessScope: 'full',
      projectIds: [f.alpha.id],
    });
    expect(fullWithProjects.status).toBe(400);
    for (const bad of [foreign.id, f.beta.id]) {
      const res = await postInvite(f.workspace.id, {
        email: 'y2@example.com',
        accessScope: 'limited',
        projectIds: [bad],
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('INVITE_PROJECT_INVALID');
    }
    expect(await adminDb.verification.count()).toBe(before);
  });

  it('a project archived between send and accept is skipped and named', async () => {
    const f = await setup();
    mockSession.current = { user: { id: f.manager.id, email: f.manager.email, name: 'Manager' } };
    await postInvite(f.workspace.id, {
      email: f.contractor.email,
      accessScope: 'limited',
      projectIds: [f.alpha.id, f.beta.id],
    });
    const token = await tokenFor(f.contractor.email);
    await adminDb.project.update({ where: { id: f.beta.id }, data: { archivedAt: new Date() } });
    mockSession.current = {
      user: { id: f.contractor.id, email: f.contractor.email, name: 'Contractor' },
    };
    const res = await postAccept(token);
    expect(await res.json()).toEqual({ workspaceId: f.workspace.id, skippedProjects: ['Beta'] });
    const added = await adminDb.projectMembership.findMany({ where: { userId: f.contractor.id } });
    expect(added.map((r) => r.projectId)).toEqual([f.alpha.id]);
  });
});

describe('resendInvite — replace a pending invitation (MOTIR-9996)', () => {
  async function rowFor(token: string) {
    return adminDb.verification.findFirstOrThrow({
      where: { identifier: INVITE_IDENTIFIER_PREFIX + token },
    });
  }

  function payloadOf(value: string) {
    return JSON.parse(value) as Record<string, unknown>;
  }

  async function liveRowsFor(email: string) {
    return adminDb.verification.findMany({
      where: {
        identifier: { startsWith: INVITE_IDENTIFIER_PREFIX },
        value: { contains: email },
        expiresAt: { gt: new Date() },
      },
    });
  }

  async function memberOf(workspaceId: string, email: string, scope: 'full' | 'limited') {
    const user = await usersService.createUser({
      email,
      password: 'hunter2hunter2',
      name: email,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId });
    if (scope === 'limited') {
      await adminDb.workspaceMembership.update({
        where: { userId_workspaceId: { userId: user.id, workspaceId } },
        data: { accessScope: 'limited' },
      });
    }
    return user;
  }

  it('mints a new link with the same payload and original inviter, emails it, and retires the old one', async () => {
    const { user: manager, workspace } = await makeInviter('mgr-resend@example.com', 'Ana Ruiz');
    const resender = await memberOf(workspace.id, 'resender@example.com', 'full');
    const oldToken = await createInvite({
      workspaceId: workspace.id,
      email: 'marta@example.com',
      inviterUserId: manager.id,
    });
    const oldRow = await rowFor(oldToken);
    const before = Date.now();

    await workspaceInvitesService.resendInvite({
      actorUserId: resender.id,
      actorName: 'Resender',
      workspaceId: workspace.id,
      inviteId: oldRow.id,
    });

    const [fresh] = await liveRowsFor('marta@example.com');
    const newToken = fresh!.identifier.slice(INVITE_IDENTIFIER_PREFIX.length);
    expect(newToken).not.toBe(oldToken);
    expect(payloadOf(fresh!.value)).toMatchObject({
      workspaceId: workspace.id,
      email: 'marta@example.com',
      accessScope: 'full',
      projectIds: [],
      inviterUserId: manager.id,
      resentByUserId: resender.id,
    });
    expect(await workspaceInvitesService.validateInvite(newToken)).toMatchObject({
      workspaceName: workspace.name,
      email: 'marta@example.com',
    });
    const sent = emailEvents.events.at(-1)!.data;
    expect(sent.idempotencyKey).toBe(newToken);
    expect(sent.to).toBe('marta@example.com');
    expect((sent.data as { inviterName: string }).inviterName).toBe('Resender');

    // The old link: kept as a row (it counts toward the limit), no longer valid.
    const retired = await rowFor(oldToken);
    expect(retired.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(retired.expiresAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(await workspaceInvitesService.validateInvite(oldToken)).toBeNull();
    expect(await workspaceInvitesService.inspectInvite(oldToken)).toEqual({ status: 'expired' });
    await expect(
      workspaceInvitesService.acceptInvite(oldToken, { id: 'anyone', email: 'marta@example.com' }),
    ).rejects.toBeInstanceOf(InviteExpiredOrMissingError);
  });

  it('a failed retire rolls the new row back, and of two concurrent Resends exactly one wins', async () => {
    const { user: manager, workspace } = await makeInviter('mgr-race@example.com', 'Manager');
    const token = await createInvite({
      workspaceId: workspace.id,
      email: 'race@example.com',
      inviterUserId: manager.id,
    });
    const row = await rowFor(token);
    const resend = () =>
      workspaceInvitesService.resendInvite({
        actorUserId: manager.id,
        actorName: 'Manager',
        workspaceId: workspace.id,
        inviteId: row.id,
      });

    const spy = vi
      .spyOn(verificationRepository, 'retireUnexpiredByIdentifier')
      .mockResolvedValue(0);
    const rowsBefore = await adminDb.verification.count();
    const eventsBefore = emailEvents.events.length;
    await expect(resend()).rejects.toBeInstanceOf(InviteExpiredOrMissingError);
    spy.mockRestore();
    expect(await adminDb.verification.count()).toBe(rowsBefore);
    expect(emailEvents.events).toHaveLength(eventsBefore);

    const results = await Promise.allSettled([resend(), resend()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = results.filter((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(InviteExpiredOrMissingError);
    expect(await liveRowsFor('race@example.com')).toHaveLength(1);
  });

  it('the original plus two Resends succeed; the third Resend and a new send are refused at the limit', async () => {
    const { user: manager, workspace } = await makeInviter('mgr-limit@example.com', 'Manager');
    await createInvite({
      workspaceId: workspace.id,
      email: 'limit@example.com',
      inviterUserId: manager.id,
    });
    const resendLatest = async () => {
      const [live] = await liveRowsFor('limit@example.com');
      return workspaceInvitesService.resendInvite({
        actorUserId: manager.id,
        actorName: 'Manager',
        workspaceId: workspace.id,
        inviteId: live!.id,
      });
    };
    await resendLatest();
    await resendLatest();
    const eventsBefore = emailEvents.events.length;

    const refusal = await resendLatest().catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(InviteRateLimitedError);
    expect((refusal as InviteRateLimitedError).max).toBe(3);
    const rows = await adminDb.verification.count({
      where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX } },
    });
    expect(rows).toBe(3);
    expect(emailEvents.events).toHaveLength(eventsBefore);
    await expect(
      workspaceInvitesService.sendInvite({
        inviterUserId: manager.id,
        inviterName: 'Manager',
        workspaceId: workspace.id,
        targetEmail: 'limit@example.com',
      }),
    ).rejects.toBeInstanceOf(InviteRateLimitedError);
  });

  it('who may resend: Manager any, Full only Full, Limited and non-members none — refusals write nothing', async () => {
    const { user: manager, workspace } = await makeInviter('mgr-roles@example.com', 'Manager');
    const full = await memberOf(workspace.id, 'full-roles@example.com', 'full');
    const limited = await memberOf(workspace.id, 'limited-roles@example.com', 'limited');
    const outsider = await usersService.createUser({
      email: 'outsider-roles@example.com',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    const fullToken = await createInvite({
      workspaceId: workspace.id,
      email: 'full-invitee@example.com',
      inviterUserId: manager.id,
    });
    await workspaceInvitesService.sendInvite({
      inviterUserId: manager.id,
      inviterName: 'Manager',
      workspaceId: workspace.id,
      targetEmail: 'limited-invitee@example.com',
      accessScope: 'limited',
    });
    const fullId = (await rowFor(fullToken)).id;
    const limitedId = (await liveRowsFor('limited-invitee@example.com'))[0]!.id;

    const asActor = async (user: { id: string; email: string }, inviteId: string) => {
      mockSession.current = { user: { id: user.id, email: user.email, name: user.email } };
      activeWorkspace.current = { userId: user.id, workspaceId: workspace.id };
      return resendInviteAction(inviteId);
    };

    const rowsBefore = await adminDb.verification.count();
    const eventsBefore = emailEvents.events.length;
    expect(await asActor(full, limitedId)).toEqual({ ok: false, code: 'INVITE_SCOPE_FORBIDDEN' });
    expect(await asActor(limited, fullId)).toEqual({
      ok: false,
      code: 'INVITE_NOT_ALLOWED_FOR_SCOPE',
    });
    expect(await asActor(outsider, fullId)).toEqual({ ok: false, code: 'NOT_A_MEMBER' });
    expect(await adminDb.verification.count()).toBe(rowsBefore);
    expect(emailEvents.events).toHaveLength(eventsBefore);
    await expect(
      workspaceInvitesService.resendInvite({
        actorUserId: full.id,
        actorName: 'Full',
        workspaceId: workspace.id,
        inviteId: limitedId,
      }),
    ).rejects.toBeInstanceOf(InviteScopeForbiddenError);
    await expect(
      workspaceInvitesService.resendInvite({
        actorUserId: limited.id,
        actorName: 'Limited',
        workspaceId: workspace.id,
        inviteId: fullId,
      }),
    ).rejects.toBeInstanceOf(InviteNotAllowedForScopeError);
    await expect(
      workspaceInvitesService.resendInvite({
        actorUserId: outsider.id,
        actorName: 'Outsider',
        workspaceId: workspace.id,
        inviteId: fullId,
      }),
    ).rejects.toBeInstanceOf(NotAMemberError);

    // A Full non-Manager may resend a Full invitation; a Manager a Limited one.
    expect(await asActor(full, fullId)).toEqual({ ok: true });
    expect(revalidated).toEqual(
      expect.arrayContaining(['/settings/workspace', '/settings/organization']),
    );
    expect(await asActor(manager, limitedId)).toEqual({ ok: true });
    const [resentLimited] = await liveRowsFor('limited-invitee@example.com');
    expect(payloadOf(resentLimited!.value)).toMatchObject({ accessScope: 'limited' });
  });

  it('refuses an address that has joined, and a missing, expired, foreign or non-invite row', async () => {
    const { user: manager, workspace } = await makeInviter('mgr-refuse@example.com', 'Manager');
    const { user: otherOwner, workspace: other } = await makeInviter(
      'other-refuse@example.com',
      'Other',
    );
    const joinedToken = await createInvite({
      workspaceId: workspace.id,
      email: 'joined@example.com',
      inviterUserId: manager.id,
    });
    await memberOf(workspace.id, 'joined@example.com', 'full');
    const expiredToken = await createInvite({
      workspaceId: workspace.id,
      email: 'expired-resend@example.com',
      inviterUserId: manager.id,
    });
    await adminDb.verification.updateMany({
      where: { identifier: INVITE_IDENTIFIER_PREFIX + expiredToken },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const foreignToken = await createInvite({
      workspaceId: other.id,
      email: 'foreign@example.com',
      inviterUserId: otherOwner.id,
    });
    const notAnInvite = await adminDb.verification.create({
      data: {
        identifier: 'trust-device-resend-test',
        value: manager.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const rowsBefore = await adminDb.verification.count();
    const eventsBefore = emailEvents.events.length;
    const resend = (inviteId: string) =>
      workspaceInvitesService.resendInvite({
        actorUserId: manager.id,
        actorName: 'Manager',
        workspaceId: workspace.id,
        inviteId,
      });

    await expect(resend((await rowFor(joinedToken)).id)).rejects.toBeInstanceOf(
      InviteTargetAlreadyMemberError,
    );
    for (const id of [
      'no-such-invite',
      (await rowFor(expiredToken)).id,
      (await rowFor(foreignToken)).id,
      notAnInvite.id,
    ]) {
      await expect(resend(id)).rejects.toBeInstanceOf(InviteExpiredOrMissingError);
    }
    expect(await adminDb.verification.count()).toBe(rowsBefore);
    expect(emailEvents.events).toHaveLength(eventsBefore);
  });
});
