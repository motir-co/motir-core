import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  PROJECT_SETTINGS_NAV,
  hasVisibleSettingsArea,
  settingsEntryViewKey,
  visibleSettingsNav,
} from '@/lib/settings/projectSettingsNav';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';
import {
  type LegacyAccessLevel,
  modeForLegacyLevel,
  setProjectAccess,
} from '@/tests/helpers/projectAccess';

// Story 6.5 · Subtask 6.5.4 — the settings-area role-gating matrix proven over
// the REAL stack (Postgres + the shipped services), the DB-backed half of the
// story-closing verification. The 6.5.2 unit suite
// (`tests/settings/projectSettingsNav.test.ts`) pins the registry's pure
// predicates in isolation; this suite proves the chain the area actually runs:
//
//     seeded 6.4 role  →  projectAccessService.getPermissions  →
//     the registry's per-entry `permission` key  →  the visible nav + the
//     page-level gate
//
// ⚠️ RE-POINTED BY MOTIR-2468. The chain used to run through
// `getSettingsCapabilities` and a two-boolean predicate; it now runs through the
// actor's resolved PERMISSION SET, because two bits cannot express a role that
// holds one administrative domain and not another.
//
// agree end-to-end with the 6.4.3 policy, for every (access level × role). It is
// DRIVEN from the registry — it asserts each `PROJECT_SETTINGS_NAV` entry's
// visibility equals its own predicate applied to the actor's REAL capabilities,
// so a new entry (or a new predicate, e.g. a `canManage`-gated Story-6.6 row)
// is covered the moment it lands; and it pins the two area invariants the
// design names — NO nav leak (a non-browser sees nothing) and NO orphan page (a
// visible nav ⟺ a browsable project).

const PASSWORD = 'settings-area-matrix-pass-123';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  // Release the worktree-side pool so it doesn't keep the runner alive past the
  // last test (mirrors project-access-service / project-isolation).
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeUser(email: string, name = 'User') {
  return usersService.createUser({ email, password: PASSWORD, name });
}

function ctxFor(userId: string, workspaceId: string): WorkspaceContext {
  return { userId, workspaceId };
}

type Role = 'owner' | 'wsAdmin' | 'plainMember' | 'viewer' | 'member' | 'admin' | 'nonMember';

interface Scenario {
  projectId: string;
  ctxs: Record<Role, WorkspaceContext>;
}

/**
 * Build a workspace + project at `level`, then attach one actor per role. The
 * access level is set FIRST (going `private` auto-seeds the THEN-current members
 * as project members — only the owner exists at that point), so the
 * workspace-admin + plain-member carry NO project membership and each role is
 * set up cleanly. Mirrors `project-access-service.test.ts`'s `buildScenario`.
 */
async function buildScenario(level: LegacyAccessLevel, slug: string): Promise<Scenario> {
  const owner = await makeUser(`owner-${slug}@ex.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const ownerCtx = ctxFor(owner.id, workspace.id);

  // `public` is refused by the service setter on a self-hosted build (which a
  // Vitest run is), so seed it directly at the data layer; the 3 other levels go
  // through the real setter, as the mode each maps to.
  if (level === 'public') {
    await setProjectAccess(adminDb, project.id, 'public');
  } else {
    await projectMembersService.setAccessMode({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      mode: modeForLegacyLevel(level),
    });
  }

  const wsAdmin = await makeUser(`wsadmin-${slug}@ex.com`, 'WsAdmin');
  await workspacesService.addMember({
    userId: wsAdmin.id,
    workspaceId: workspace.id,
    workspaceRole: 'manager',
  });

  const plainMember = await makeUser(`plain-${slug}@ex.com`, 'Plain');
  await workspacesService.addMember({ userId: plainMember.id, workspaceId: workspace.id });

  async function projectActor(role: 'viewer' | 'member' | 'admin') {
    const u = await makeUser(`${role}-${slug}@ex.com`, role);
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    await addToProjectAs({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: u.id,
      role,
    });
    return u;
  }
  const viewer = await projectActor('viewer');
  const member = await projectActor('member');
  const admin = await projectActor('admin');

  // A workspace member with NO project role — the genuine non-member on a
  // private project (a non-WORKSPACE user can't even resolve a context).
  const nonMember = await makeUser(`outsider-${slug}@ex.com`, 'Outsider');
  await workspacesService.addMember({ userId: nonMember.id, workspaceId: workspace.id });

  return {
    projectId: project.id,
    ctxs: {
      owner: ownerCtx,
      wsAdmin: ctxFor(wsAdmin.id, workspace.id),
      plainMember: ctxFor(plainMember.id, workspace.id),
      viewer: ctxFor(viewer.id, workspace.id),
      member: ctxFor(member.id, workspace.id),
      admin: ctxFor(admin.id, workspace.id),
      nonMember: ctxFor(nonMember.id, workspace.id),
    },
  };
}

// The expected (browse, manage) verdict per role for each access level — the
// 6.4.3 policy the settings area rides. `browse` decides whether ANY settings
// entry/page is reachable (no nav leak); `manage` decides the admin-only
// surfaces (the Details danger zone today, the Story-6.6 Automation row next).
const EXPECTED: Record<LegacyAccessLevel, Record<Role, { browse: boolean; manage: boolean }>> = {
  open: {
    owner: { browse: true, manage: true },
    wsAdmin: { browse: true, manage: true },
    plainMember: { browse: true, manage: false },
    viewer: { browse: true, manage: false },
    member: { browse: true, manage: false },
    admin: { browse: true, manage: true },
    nonMember: { browse: true, manage: false },
  },
  // A legacy `limited` project resolves as Members only (Story MOTIR-6169):
  // the two workspace members never added to it no longer enter it.
  limited: {
    owner: { browse: true, manage: true },
    wsAdmin: { browse: true, manage: true },
    plainMember: { browse: false, manage: false },
    viewer: { browse: true, manage: false },
    member: { browse: true, manage: false },
    admin: { browse: true, manage: true },
    nonMember: { browse: false, manage: false },
  },
  private: {
    owner: { browse: true, manage: true },
    wsAdmin: { browse: true, manage: true },
    plainMember: { browse: false, manage: false },
    viewer: { browse: true, manage: false },
    member: { browse: true, manage: false },
    admin: { browse: true, manage: true },
    nonMember: { browse: false, manage: false },
  },
  // `public` (Story 6.12) — browse is true for EVERYONE (the cross-org read
  // exception); `manage` is unchanged (workspace owner/admin or project admin),
  // so the settings-area row mirrors `open`. These actors all resolve through
  // the workspace-scoped getSettingsCapabilities; the anonymous public-READ path
  // is the public-VIEW surface's concern (6.12.4 / 6.12.9) — settings stays
  // member-facing.
  public: {
    owner: { browse: true, manage: true },
    wsAdmin: { browse: true, manage: true },
    plainMember: { browse: true, manage: false },
    viewer: { browse: true, manage: false },
    member: { browse: true, manage: false },
    admin: { browse: true, manage: true },
    nonMember: { browse: true, manage: false },
  },
};

// The registry's SECOND axis (MOTIR-4243), and this matrix is about the FIRST:
// it walks the real resolved permission set for every seeded role, so it asks
// its questions on a build where every room exists. The deployment axis has its
// own coverage in `tests/settings/projectSettingsNav.test.ts`, where it costs no
// database.
// MOTIR-6995 adds the hosted-runs axis beside it, and MOTIR-9966 the project's
// Motir-repository axis, so every room exists here.
const ON_CLOUD = {
  publicProjectsAvailable: true,
  hostedRunsAvailable: true,
  motirRepositoriesPresent: true,
};

const LEVELS: LegacyAccessLevel[] = ['open', 'limited', 'private', 'public'];
const ROLES: Role[] = ['owner', 'wsAdmin', 'plainMember', 'viewer', 'member', 'admin', 'nonMember'];

describe('settings-area role-gating matrix — capabilities ride the 6.4.3 policy', () => {
  for (const level of LEVELS) {
    describe(`access level: ${level}`, () => {
      let scenario: Scenario;

      beforeEach(async () => {
        scenario = await buildScenario(level, `${level}`);
      });

      for (const role of ROLES) {
        it(`${role} — capabilities match the policy`, async () => {
          const caps = await projectAccessService.getSettingsCapabilities(
            scenario.projectId,
            scenario.ctxs[role],
          );
          const expected = EXPECTED[level][role];
          expect(caps.canBrowse).toBe(expected.browse);
          expect(caps.canManage).toBe(expected.manage);
        });
      }
    });
  }
});

describe('settings-area role-gating matrix — nav visibility (driven from the registry)', () => {
  for (const level of LEVELS) {
    describe(`access level: ${level}`, () => {
      let scenario: Scenario;

      beforeEach(async () => {
        scenario = await buildScenario(level, `nav-${level}`);
      });

      for (const role of ROLES) {
        it(`${role} — every registry entry's visibility equals its key on the real resolved set`, async () => {
          const held = await projectAccessService.getPermissions(
            scenario.projectId,
            scenario.ctxs[role],
          );
          const visible = visibleSettingsNav(held, PROJECT_SETTINGS_NAV, ON_CLOUD);
          const visibleIds = new Set(visible.map((e) => e.id));

          // Drift-proof: assert PER entry that visibility === whether the actor
          // really holds that entry's declared key, over the REAL seeded role.
          // A new entry is covered the moment it lands, with no matrix edit.
          for (const entry of PROJECT_SETTINGS_NAV) {
            // ⚠️ RESTORED 2026-09-13 — the Approvals room is manage-only (MOTIR-4880 re-plan ·
            // MOTIR-5394); MOTIR-5278's browse view is reverted.
            // MOTIR-5278 had read the entry's VIEW key here.
            // MOTIR-6995 — Hosted agent declares a distinct VIEW key again
            // (`work_item:edit`), so visibility is read through the entry's
            // effective view key, which IS `permission` for every other entry.
            expect(visibleIds.has(entry.id)).toBe(held.has(settingsEntryViewKey(entry)));
          }
        });

        it(`${role} — no nav leak / no orphan page, and the AREA DOOR follows the rows`, async () => {
          const held = await projectAccessService.getPermissions(
            scenario.projectId,
            scenario.ctxs[role],
          );
          const visible = visibleSettingsNav(held, PROJECT_SETTINGS_NAV, ON_CLOUD);

          // ⚠️ THE SPLIT MOVED (MOTIR-2468). It used to be browse-vs-manage: a
          // non-admin browser saw every entry except Automation. Every entry now
          // gates on an administrative key its destination actually asserts, so
          // the split is administer-vs-not: an actor holding `project:administer`
          // (a project admin, or the workspace owner/admin always-pass tier) sees
          // the whole rail; everyone else sees NOTHING.
          // ⚠️ RESTORED 2026-09-13 — the Approvals room is manage-only (MOTIR-4880 re-plan ·
          // MOTIR-5394); MOTIR-5278's browse view is reverted.
          // MOTIR-5278 had added a third arm between these two: a non-admin browser
          // sees exactly Approvals.
          // MOTIR-6995 — a third arm between the two: a non-admin who may EDIT
          // work (a member) sees exactly the Hosted agent room, read-only, because
          // its view key is `work_item:edit` (design MOTIR-6991).
          // MOTIR-8830 — and a fourth: Translation's view key is `project:browse`, so
          // anyone who can browse sees it, read-only, in registry order.
          // MOTIR-9966 — and Environment, whose view key is also `project:browse`
          // (General, so it leads). MOTIR-10037 — and Production, right after it.
          if (held.has('project:administer')) {
            expect(visible).toEqual(PROJECT_SETTINGS_NAV);
          } else {
            expect(visible.map((e) => e.id)).toEqual([
              ...(held.has('project:browse') ? ['environment', 'production'] : []),
              ...(held.has('work_item:edit') ? ['hosted-agent'] : []),
              ...(held.has('project:browse') ? ['translation'] : []),
            ]);
          }

          // And the DOOR agrees with the ROWS — an actor is never handed a link
          // into an area that renders an empty rail (design panel 1).
          expect(hasVisibleSettingsArea(held, ON_CLOUD)).toBe(visible.length > 0);
        });
      }
    });
  }
});

describe('settings-area role-gating matrix — page-level resolution', () => {
  it('an in-workspace non-member on a private project resolves (no-browse caps), NOT a 404', async () => {
    // The "made private while still pinned" path: the page must render the
    // 6.4.4 no-access STATE (a resolvable context with canBrowse=false), never
    // throw — the area layout shows NoAccessState, not a crash.
    const scenario = await buildScenario('private', 'page-private');
    const caps = await projectAccessService.getSettingsCapabilities(
      scenario.projectId,
      scenario.ctxs.nonMember,
    );
    expect(caps.canBrowse).toBe(false);
    expect(caps.canManage).toBe(false);
  });

  it('a cross-tenant / nonexistent project throws ProjectNotFoundError (the 404 gate, no existence leak)', async () => {
    const scenario = await buildScenario('open', 'page-foreign');
    await expect(
      projectAccessService.getSettingsCapabilities('prj_does_not_exist', scenario.ctxs.owner),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
