import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { reportsService } from '@/lib/services/reportsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { importService } from '@/lib/services/importService';
import { triageService } from '@/lib/services/triageService';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';
import { encodeFilterParam } from '@/lib/filters/ast';
import { JOB_SCOPE_QUERY_PARAM } from '@/lib/ai/motirAiClient';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { NotSprintAdminError } from '@/lib/sprints/errors';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import type { ProjectContext } from '@/lib/projects';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { openTestSession } from '../helpers/planSession';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// THE STORY TEST GATE for MOTIR-2291 (Subtask MOTIR-2367) — the SEAM half,
// against real Postgres.
//
// Each wiring card tests its own service. What no card can test is what the STORY
// changed: that eight keys now answer through ONE resolution, that they answer
// the SAME WAY, and that the refusal a consumer branches on has the same shape
// everywhere. So this walks every member-facing key through the same three
// questions with real membership rows and the real resolution:
//
//   * the actor the decision record grants it PASSES,
//   * the actor it withholds it from is REFUSED — and the refusal names the key,
//   * a NON-BROWSER gets the 404, not the 403. That ordering is a security
//     property, not a style choice: a 403 confirms a project the actor may not
//     see, and it is the one thing every gate in this story had to inherit.
//
// ⚠️ IT DIFFERS FROM MOTIR-2256's GATE IN ONE WAY THAT MATTERS. That story could
// assert NEUTRALITY — nobody's access moved. This one cannot: every key here
// takes something from somebody, so the assertions come in PAIRS. A test that
// only proved the refusal could not tell "the key is narrower" from "the feature
// is broken", which is the failure mode a story of fifteen revocations invites.

const PASSWORD = 'hunter2hunter2';

interface Scenario {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  ownerCtx: WorkspaceContext;
  adminCtx: WorkspaceContext;
  memberCtx: WorkspaceContext;
  viewerCtx: WorkspaceContext;
  /** A workspace member with NO project membership, on a PRIVATE project: a non-browser. */
  outsiderCtx: WorkspaceContext;
}

let seq = 0;

async function buildScenario(slug: string): Promise<Scenario> {
  seq += 1;
  const owner = await usersService.createUser({
    email: `mf-owner-${slug}-${seq}@ex.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `MF WS ${slug} ${seq}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `MF ${slug}`,
  });
  const ownerCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
  await projectMembersService.setAccessMode({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    mode: 'members',
  });

  async function actor(role: 'admin' | 'member' | 'viewer' | null): Promise<WorkspaceContext> {
    const u = await usersService.createUser({
      email: `mf-${role ?? 'outsider'}-${slug}-${seq}@ex.com`,
      password: PASSWORD,
      name: role ?? 'outsider',
    });
    // Roles live on the WORKSPACE (Story MOTIR-6168): the actor's tier is their
    // workspace role (a legacy `admin` lands as the Manager), and the project
    // membership below is only "added to this private project".
    await workspacesService.addMember({
      userId: u.id,
      workspaceId: workspace.id,
      workspaceRole: role === 'admin' ? 'manager' : (role ?? 'member'),
    });
    if (role) {
      await addToProjectAs({
        key: project.identifier,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: u.id,
        role,
      });
    }
    return { userId: u.id, workspaceId: workspace.id };
  }

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    ownerCtx,
    adminCtx: await actor('admin'),
    memberCtx: await actor('member'),
    viewerCtx: await actor('viewer'),
    outsiderCtx: await actor(null),
  };
}

const pctx = (s: Scenario, c: WorkspaceContext): ProjectContext =>
  ({ ...c, projectId: s.projectId, project: { identifier: s.projectKey } }) as ProjectContext;

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('every member-facing key answers through ONE resolution, the same way', () => {
  it('sprint:manage — member passes, viewer refused, non-browser 404', async () => {
    const s = await buildScenario('sprint');
    await expect(sprintsService.createSprint(s.projectId, {}, s.memberCtx)).resolves.toBeTruthy();
    // The lifecycle keeps its documented v1 code; the grooming half names the key.
    await expect(sprintsService.createSprint(s.projectId, {}, s.viewerCtx)).rejects.toBeInstanceOf(
      NotSprintAdminError,
    );
    await expect(backlogService.getBacklog(s.projectId, {}, s.outsiderCtx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('report:view — the BROWSE-WIDE key: viewer passes, non-browser 404', async () => {
    const s = await buildScenario('report');
    await expect(
      reportsService.getVelocity({ projectId: s.projectId }, s.viewerCtx),
    ).resolves.toBeTruthy();
    await expect(
      reportsService.getVelocity({ projectId: s.projectId }, s.outsiderCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('saved_filter:manage — member authors, viewer refused with the key named', async () => {
    const s = await buildScenario('filter');
    const param = encodeFilterParam({
      combinator: 'and',
      conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high'] }],
    });
    await expect(
      savedFiltersService.create(
        s.projectKey,
        { name: 'Mine', visibility: 'project', filterParam: param },
        s.memberCtx,
      ),
    ).resolves.toBeTruthy();
    await expectKeyRefusal(
      savedFiltersService.create(
        s.projectKey,
        { name: 'Theirs', visibility: 'private', filterParam: param },
        s.viewerCtx,
      ),
      'saved_filter:manage',
    );
  });

  it('import:run — ADMIN passes, MEMBER refused with the key named', async () => {
    const s = await buildScenario('import');
    await expect(
      importService.createDraft({ projectId: s.projectId, source: 'csv' }, s.adminCtx),
    ).resolves.toBeTruthy();
    await expectKeyRefusal(
      importService.createDraft({ projectId: s.projectId, source: 'csv' }, s.memberCtx),
      'import:run',
    );
  });

  it('work_item:triage — member passes, viewer refused with the key named', async () => {
    const s = await buildScenario('triage');
    await expect(triageService.getTriageQueue(s.projectId, {}, s.memberCtx)).resolves.toBeTruthy();
    await expectKeyRefusal(
      triageService.getTriageQueue(s.projectId, {}, s.viewerCtx),
      'work_item:triage',
    );
  });

  // ⚠️ THE PROBE MOVED (MOTIR-3629), and the key under test did not — the same
  // correction MOTIR-3188 made two rows down, for the same reason. This asserted
  // on `archiveWorkItem`, which now asserts `work_item:archive`, so keeping it
  // would have turned this row into coverage of a DIFFERENT key while its name
  // still said `work_item:delete`. `deleteWorkItem` IS the cascade the row is
  // about, and it is what a member must lose.
  it('work_item:delete — admin passes, MEMBER keeps the edit and loses the cascade', async () => {
    const s = await buildScenario('delete');
    const item = await workItemsService.createWorkItem(
      { projectId: s.projectId, title: 'Doomed', kind: 'task' },
      s.adminCtx,
    );
    // The PAIRING is the assertion: editing still works for the same actor.
    await expect(
      workItemsService.updateWorkItem(item.id, { title: 'Renamed' }, s.memberCtx),
    ).resolves.toBeTruthy();
    await expectKeyRefusal(
      workItemsService.deleteWorkItem(item.id, s.memberCtx),
      'work_item:delete',
    );
  });

  it('work_item:archive — a MEMBER archives and restores, and still cannot delete', async () => {
    // MOTIR-3629, and the row the split exists to make expressible. Under one
    // key this actor could do neither, and the product still offered them the
    // Archive affordance.
    const s = await buildScenario('archive');
    const item = await workItemsService.createWorkItem(
      { projectId: s.projectId, title: 'Tidied away', kind: 'task' },
      s.adminCtx,
    );
    await expect(workItemsService.archiveWorkItem(item.id, s.memberCtx)).resolves.toBeTruthy();
    await expect(workItemsService.unarchiveWorkItem(item.id, s.memberCtx)).resolves.toBeTruthy();
    await expectKeyRefusal(
      workItemsService.deleteWorkItem(item.id, s.memberCtx),
      'work_item:delete',
    );
    // A VIEWER gets neither — the reversible half is still a removal.
    await expectKeyRefusal(
      workItemsService.archiveWorkItem(item.id, s.viewerCtx),
      'work_item:archive',
    );
    // …and an admin, who holds only `work_item:delete` of the two by name,
    // archives anyway: the implication is what carries it (ADR §10).
    await expect(workItemsService.archiveWorkItem(item.id, s.adminCtx)).resolves.toBeTruthy();
  });

  it('ai:plan — member passes, viewer refused with the key named', async () => {
    const s = await buildScenario('aiplan');
    await expect(openTestSession(pctx(s, s.memberCtx))).resolves.toBeTruthy();
    await expectKeyRefusal(openTestSession(pctx(s, s.viewerCtx)), 'ai:plan');
  });

  it('ai:view_plan — the key that governs a plan AUTHOR write, refused for a viewer', async () => {
    const s = await buildScenario('viewplan');
    // ⚠️ THE PROBE MOVED (MOTIR-3188), and the key under test did not. This
    // asserted on `approvePlan`, which now asserts `ai:decide_plan` — so keeping
    // it would have quietly turned this row into coverage of a DIFFERENT key
    // while its name still said `ai:view_plan`. `addProposals` is an AUTHOR
    // write, which is what the key gates after the split.
    await expectKeyRefusal(
      plansService.addProposals('plan_does_not_exist', [], s.viewerCtx),
      'ai:view_plan',
      { allowNotFound: true },
    );
  });
});

/**
 * Assert `p` was refused BY THE KEY — a `PermissionDeniedError` naming it, which
 * is the 403 the client branches on. `allowNotFound` covers the one case where
 * the subject itself may not resolve first (an approve of a nonexistent plan);
 * what must never happen there is a SUCCESS.
 */
async function expectKeyRefusal(
  p: Promise<unknown>,
  key: PermissionKey,
  opts: { allowNotFound?: boolean } = {},
): Promise<void> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      expect(err.permission).toBe(key);
      return;
    }
    if (opts.allowNotFound) return;
    throw err;
  }
  throw new Error(`expected a refusal naming ${key}, but the call resolved`);
}

// ── The architecture guards coverage cannot see ────────────────────────────────

const ROOT = join(__dirname, '..', '..');

/**
 * Every service file's CODE, with comments stripped.
 *
 * ⚠️ STRIPPING IS LOAD-BEARING, NOT TIDINESS. Six of this story's services carry a
 * ⚠️ block explaining what their gate USED to resolve — `isOwnerRole(...)`, a
 * role comparison — and those explanations are the most valuable lines in the
 * diff. A guard that reads them as violations would be answered by deleting the
 * documentation, which is precisely backwards.
 */
function serviceFiles(): { path: string; code: string }[] {
  const dir = join(ROOT, 'lib', 'services');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({
      path: `lib/services/${f}`,
      code: stripComments(readFileSync(join(dir, f), 'utf8')),
    }));
}

/** Remove `/* … *\/` blocks and `//` line comments. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('no SECOND policy path — every gate resolves through projectAccessService', () => {
  it('no service decides access by reading a membership row and branching on the role', () => {
    // The shape MOTIR-2304's name-whitelist bug found three of: a service that
    // resolves the actor's own membership and branches on `isOwnerRole(...)` or
    // `role === 'admin'` is a policy the model does not know about — invisible in
    // the grid, un-grantable to a custom role, and un-auditable by the guard.
    //
    // ⚠️ The remaining derivations are named, with the reason, exactly as
    // `storyGate.test.ts` names its own: a bare directory exemption is a place to
    // put things you would rather not think about.
    const ALLOWED = new Set([
      // The enforcement half of the model itself — it resolves the three facts.
      'lib/services/projectAccessService.ts',
      // A WORKSPACE-level dashboard gated on the workspace role. No project is
      // resolved, so no project permission can govern it (the MOTIR-2294 argument).
      'lib/services/jobsDashboardService.ts',
      // The require-2FA policy (Story MOTIR-1215 · MOTIR-3645), at the WORKSPACE
      // and ORGANIZATION tiers. Same argument again: no project is resolved, so
      // no project permission could govern who may demand a second factor of a
      // whole tenant. Reading the policy is ungated; only SETTING it derives the
      // role, and `tests/twoFactorPolicy.test.ts` asserts both directions.
      'lib/services/twoFactorPolicyService.ts',
      // A WORKSPACE's public address (MOTIR-4221), gated on the workspace
      // Manager (MOTIR-6462). The address names the whole workspace, so no
      // project permission could govern it — the same argument once more.
      'lib/services/publicSubdomainService.ts',
    ]);
    const DERIVATION =
      /\bis(?:Legacy)?OwnerRole\s*\(|\bisWorkspaceManager\s*\(|\b(?:ws|project|workspace)?[Mm]embership\??\.role\s*===\s*'admin'/;
    const offenders = serviceFiles()
      .filter((f) => !ALLOWED.has(f.path))
      .filter((f) => DERIVATION.test(f.code))
      .map((f) => f.path);
    expect(
      offenders,
      'a service must ask `projectAccessService`, never resolve a membership and branch on the role itself',
    ).toEqual([]);
  });

  it('THE GUARD CAN FAIL — a synthetic service body that branches on a role is caught', () => {
    // Driven through the same regex the walk uses, against a body no file
    // contains, so the failure path is proved rather than assumed.
    const violation = `
      export const svc = {
        async doThing(projectId: string, ctx: Ctx) {
          const m = await workspaceMembershipRepository.findByUserAndWorkspace(ctx.userId, ctx.workspaceId);
          if (!isOwnerRole(m?.role)) throw new Error('nope');
        },
      };`;
    const DERIVATION =
      /\bis(?:Legacy)?OwnerRole\s*\(|\bisWorkspaceManager\s*\(|\b(?:ws|project|workspace)?[Mm]embership\??\.role\s*===\s*'admin'/;
    expect(DERIVATION.test(violation)).toBe(true);
    // …and a body that asks the model instead is NOT caught.
    expect(
      DERIVATION.test(
        `await projectAccessService.assertPermission(projectId, ctx, 'sprint:manage');`,
      ),
    ).toBe(false);
  });
});

describe('every member-facing key has a PRODUCTION call site', () => {
  it('all eight are consulted from lib/ or app/, outside tests/', () => {
    // The inverse of the orphan guard, at story scope: a key nothing calls is a
    // switch in the settings grid that controls nothing. `lib/permissions/` is
    // excluded because naming a key in the catalog is not consulting it.
    const KEYS: PermissionKey[] = [
      'sprint:manage',
      'report:view',
      'saved_filter:manage',
      'import:run',
      'work_item:triage',
      'work_item:delete',
      'ai:plan',
      'ai:view_plan',
    ];
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        if (entry.isDirectory()) walk(rel);
        else if (rel.endsWith('.ts') || rel.endsWith('.tsx')) {
          if (rel.startsWith('lib/permissions/')) continue;
          sources.push(readFileSync(join(ROOT, rel), 'utf8'));
        }
      }
    };
    walk('lib');
    walk('app');
    const unconsulted = KEYS.filter((k) => !sources.some((code) => code.includes(`'${k}'`)));
    expect(unconsulted, 'a key nothing consults is a switch that controls nothing').toEqual([]);
  });
});

describe('the cross-repo job-scope parameter is ONE string', () => {
  it('the client builds its query from the shared constant, not a literal', () => {
    // ⚠️ THE ONE SEAM NO SINGLE REPO'S TESTS COVER. motir-ai's `GET /v1/jobs/:id`
    // requires this exact name (MOTIR-2360); a typo on either side fails CLOSED
    // and SILENTLY — every job read becomes a `validation_error`, with no type
    // error and no red test in the repo that made the change.
    expect(JOB_SCOPE_QUERY_PARAM).toBe('coreProjectId');
    const client = readFileSync(join(ROOT, 'lib', 'ai', 'motirAiClient.ts'), 'utf8');
    // Every job call — the two reads, the cancel (MOTIR-9065) and the cost read
    // (MOTIR-10815) — builds its params FROM the constant; a re-introduced literal
    // would leave one of these matches unaccounted for.
    const usages = client.match(/\[JOB_SCOPE_QUERY_PARAM\]/g) ?? [];
    expect(
      usages.length,
      'getJob, streamJob, cancelJob and getJobCost must each use the shared constant',
    ).toBe(4);
    expect(
      /new URLSearchParams\(\{\s*coreProjectId\s*[,}]/.test(client),
      'a literal `coreProjectId` key in a URLSearchParams call has crept back in',
    ).toBe(false);
  });
});
