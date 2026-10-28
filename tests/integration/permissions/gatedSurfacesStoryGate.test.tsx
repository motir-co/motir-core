// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// MOTIR-6177 — Story MOTIR-6166's INTEGRATION gate: the ASSEMBLED seam from a
// real actor's resolved permissions, through the same resolution the pages make,
// to the controls each gated surface draws — as a project VIEWER and as a
// MEMBER, against the real resolver on a real Postgres.
//
// ⚠️ NO CAPABILITY OBJECT IS BUILT BY HAND. Every permission set below comes from
// `projectAccessService.getPermissionsDTO` / `getCapabilities` for a seeded
// actor — the reads `app/(authed)/layout.tsx` and the pages make — and every org
// role from `organizationsService.resolveActiveOrganization`. A component test
// with a typed-in `['work_item:edit']` cannot reach the resolver half of the seam,
// and that half is what a real Viewer's session goes through.
//
// DATA is still handed in where a surface fetches it client-side (the board and
// backlog projections): that is data, not a capability, and the per-surface
// component suites own it. `getSession` is the one module mocked (CLAUDE.md).

const sessionState: { user: { id: string; email: string; name: string } | null } = { user: null };
vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(async () =>
    sessionState.user ? { user: sessionState.user, session: { token: 't' } } : null,
  ),
}));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({
    open: false,
    setOpen: vi.fn(),
    openCreateIssue: vi.fn(),
    canCreate: true,
    issuesChangedAt: 0,
  }),
  useNotifyIssuesChanged: () => () => {},
}));
vi.mock('@/app/(authed)/_components/CommandPaletteProvider', () => ({
  useCommandPalette: () => ({ open: true, setOpen: vi.fn() }),
}));
vi.mock('@/app/(authed)/_components/OnboardingResumeProvider', () => ({
  useOnboardingResume: () => false,
}));
vi.mock('@/lib/contexts/theme-context', () => ({
  useTheme: () => ({ pattern: 'light', setPattern: vi.fn() }),
}));

const { db } = await import('@/lib/db');
const { adminDb } = await import('../../helpers/adminDb');
const { truncateAuthTables } = await import('../../helpers/db');
const { renderWithIntl: render } = await import('../../helpers/renderWithIntl');
const { makeWorkItemFixture, createTestWorkItem } = await import('../../fixtures');
const { createTestUser } = await import('../../fixtures/userFixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectAccessService } = await import('@/lib/services/projectAccessService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { workflowsService } = await import('@/lib/services/workflowsService');
const { orgCan } = await import('@/lib/organizations/capabilities');
const { ProjectAccessProvider } = await import('@/app/(authed)/_components/ProjectAccessProvider');
const { CoreFieldsPanel } = await import('@/app/(authed)/items/[key]/_components/CoreFieldsPanel');
const { TodoListSection } = await import('@/app/(authed)/items/[key]/_components/TodoListSection');
const { BacklogContainer } = await import('@/app/(authed)/backlog/_components/BacklogContainer');
const { BoardContainer } = await import('@/app/(authed)/boards/_components/BoardContainer');
const { OrgControl } = await import('@/app/(authed)/_components/OrgControl');
const { AppCommandPalette } = await import('@/app/(authed)/_components/AppCommandPalette');
const { updateIssueAction } = await import('@/app/(authed)/items/[key]/edit/actions');

type Persona = 'viewer' | 'member';

interface Actor {
  userId: string;
  email: string;
  /** Exactly what `app/(authed)/layout.tsx` hands `ProjectAccessProvider`. */
  permissions: Awaited<ReturnType<typeof projectAccessService.getPermissionsDTO>>['permissions'];
  /** Exactly what `boards/page.tsx` hands `BoardContainer`. */
  canEdit: boolean;
  orgRole: string;
}

interface Scenario {
  fx: Awaited<ReturnType<typeof makeWorkItemFixture>>;
  itemIdentifier: string;
  actors: Record<Persona, Actor>;
}

let seq = 0;

async function buildScenario(): Promise<Scenario> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Gate ${n}`, identifier: `GAT${n}` });
  const item = await createTestWorkItem(fx, { kind: 'task', title: 'A card everyone can read' });
  const ownerCtx = { userId: fx.ownerId, workspaceId: fx.workspaceId };

  async function persona(role: Persona): Promise<Actor> {
    const email = `gate-${role}-${n}@example.com`;
    const user = await createTestUser({ email, name: role });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    await addToProjectAs({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: ownerCtx,
      targetUserId: user.id,
      role,
    });
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: user.id, workspaceId: fx.workspaceId } },
      data: { activeProjectId: fx.projectId },
    });
    const ctx = { userId: user.id, workspaceId: fx.workspaceId };
    const [dto, caps, org] = await Promise.all([
      projectAccessService.getPermissionsDTO(fx.projectId, ctx),
      projectAccessService.getCapabilities(fx.projectId, ctx),
      organizationsService.resolveActiveOrganization(user.id),
    ]);
    return {
      userId: user.id,
      email,
      permissions: dto.permissions,
      canEdit: caps.canEdit,
      orgRole: org!.role,
    };
  }

  return {
    fx,
    itemIdentifier: item.identifier,
    actors: { viewer: await persona('viewer'), member: await persona('member') },
  };
}

let s: Scenario;

beforeEach(async () => {
  await truncateAuthTables();
  s = await buildScenario();
});
afterEach(() => {
  cleanup();
  sessionState.user = null;
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const REASON = /— You have read-only access to this project$/;

describe('the resolver draws the line the story is about', () => {
  it('a Viewer resolves to browse without any write key; a Member holds the writes', () => {
    const v = new Set(s.actors.viewer.permissions);
    const m = new Set(s.actors.member.permissions);
    expect(v.has('project:browse')).toBe(true);
    for (const key of [
      'work_item:edit',
      'sprint:manage',
      'comment:add',
      'board:configure',
    ] as const) {
      expect(v.has(key), key).toBe(false);
    }
    for (const key of ['work_item:edit', 'sprint:manage', 'comment:add'] as const) {
      expect(m.has(key), key).toBe(true);
    }
    expect(s.actors.viewer.canEdit).toBe(false);
    expect(s.actors.member.canEdit).toBe(true);
  });
});

describe('the work item page', () => {
  async function renderRail(who: Persona) {
    const detail = await workItemsService.getIssueDetail(
      s.fx.projectId,
      s.itemIdentifier,
      s.fx.ctx,
    );
    const workflow = await workflowsService.getWorkflow(s.fx.projectId, s.fx.workspaceId);
    return render(
      <ProjectAccessProvider permissions={s.actors[who].permissions}>
        <CoreFieldsPanel item={detail.item} members={[]} workflow={workflow} parent={null} />
        <TodoListSection
          initialWorkItemRefs={{}}
          workItemId={detail.item.id}
          initialTodos={[]}
          initialProgress={{ done: 0, total: 0 }}
          canEdit={s.actors[who].permissions.includes('work_item:edit')}
        />
      </ProjectAccessProvider>,
    );
  }

  it('as a VIEWER: every field is non-interactive and says why; no to-do add row', async () => {
    await renderRail('viewer');
    expect(screen.queryAllByRole('button', { name: /^Edit / })).toHaveLength(0);
    const disabled = screen.getAllByRole('button', { name: REASON });
    expect(disabled.length).toBeGreaterThanOrEqual(6);
    for (const b of disabled) {
      fireEvent.click(b);
      expect(b.getAttribute('aria-disabled')).toBe('true');
    }
    expect(document.querySelectorAll('[role="listbox"],[role="grid"]')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Add step' })).toBeNull();
  });

  it('as a MEMBER: every field opens its editor', async () => {
    await renderRail('member');
    expect(screen.queryAllByRole('button', { name: REASON })).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Work type' }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1);
    expect(screen.getByLabelText('Add a step…')).toBeTruthy();
  });

  it('a VIEWER calling the item write DIRECTLY is refused in place, and no row changes', async () => {
    const before = await adminDb.workItem.findFirstOrThrow({
      where: { projectId: s.fx.projectId, title: 'A card everyone can read' },
    });
    sessionState.user = {
      id: s.actors.viewer.userId,
      email: s.actors.viewer.email,
      name: 'viewer',
    };
    const result = await updateIssueAction({
      id: before.id,
      priority: 'highest',
      expectedUpdatedAt: before.updatedAt.toISOString(),
    });
    expect(result.ok).toBe(false);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.priority).toBe(before.priority);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());

    // …and the same call as the MEMBER lands — the refusal is about the key.
    sessionState.user = {
      id: s.actors.member.userId,
      email: s.actors.member.email,
      name: 'member',
    };
    const ok = await updateIssueAction({
      id: before.id,
      priority: 'highest',
      expectedUpdatedAt: before.updatedAt.toISOString(),
    });
    expect(ok.ok).toBe(true);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: before.id } })).priority).toBe(
      'highest',
    );
  });
});

describe('the backlog and the board', () => {
  // The backlog and the board are two independent client islands, each settling
  // on its own fetch. `holdSprints` keeps the backlog's `/api/sprints` read
  // pending until `releaseSprints()`, so a case can pin the order CI hit
  // (MOTIR-6341): board rendered, backlog still a skeleton.
  let releaseSprints: () => void = () => {};

  function stubCollections(itemId: string, { holdSprints = false } = {}) {
    const ok = (body: unknown) =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    const sprintsGate = holdSprints
      ? new Promise<void>((resolve) => {
          releaseSprints = () => resolve();
        })
      : Promise.resolve();
    const row = {
      id: itemId,
      key: 1,
      parentId: null,
      kind: 'task',
      identifier: 'GAT-1',
      title: 'A card everyone can read',
      status: 'todo',
      priority: 'medium',
      assigneeId: null,
      position: 'a0',
      estimateMinutes: null,
      storyPoints: null,
      archivedAt: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/points')) return ok({ committed: 0, completed: 0, remaining: 0 });
        if (url.startsWith('/api/sprints')) return sprintsGate.then(() => ok({ sprints: [] }));
        if (url.startsWith('/api/backlog'))
          return ok({ items: [row], nextCursor: null, totalCount: 1 });
        if (url.startsWith('/api/board'))
          return ok({
            boardId: 'b1',
            name: 'Default',
            type: 'kanban',
            swimlaneGroupBy: 'none',
            swimlanes: [],
            unmappedStatuses: [],
            cap: 5000,
            truncated: false,
            sprint: null,
            columns: [
              {
                id: 'c1',
                name: 'To do',
                position: 'a0',
                wipLimit: null,
                statusKeys: ['todo'],
                cards: [
                  {
                    ...row,
                    projectId: 'p',
                    ciState: null,
                    statusCategory: 'todo',
                    dueDate: null,
                    ready: true,
                    pendingDecision: null,
                  },
                ],
                totalCount: 1,
                cursor: null,
              },
            ],
          });
        return ok({});
      }),
    );
  }

  async function renderCollections(who: Persona, opts?: { holdSprints?: boolean }) {
    const item = await adminDb.workItem.findFirstOrThrow({ where: { projectId: s.fx.projectId } });
    stubCollections(item.id, opts);
    const workflow = await workflowsService.getWorkflow(s.fx.projectId, s.fx.workspaceId);
    return render(
      <ProjectAccessProvider permissions={s.actors[who].permissions}>
        <div id="board-toolbar-groupby-slot" className="contents" />
        <BacklogContainer workflow={workflow} members={[]} projectName="Gate" />
        <BoardContainer projectName="Gate" workflow={workflow} canEdit={s.actors[who].canEdit} />
      </ProjectAccessProvider>,
    );
  }

  it('as a VIEWER: no drag, no enabled create, no bulk selection, no writing row or column menu', async () => {
    await renderCollections('viewer', { holdSprints: true });
    await screen.findByTestId('board');
    releaseSprints();
    // The absence checks below prove nothing against a skeleton — wait for the
    // backlog to render its row first.
    await screen.findByTestId('backlog-row-GAT-1');
    expect(screen.queryByTestId('backlog-row-check-GAT-1')).toBeNull();
    expect(screen.queryByTestId('backlog-row-actions-GAT-1')).toBeNull();
    expect(screen.queryByTestId('create-sprint')).toBeNull();
    expect((await screen.findByTestId('create-issue-backlog')).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(screen.queryAllByRole('button', { name: 'Column actions' })).toHaveLength(0);
    const group = screen.getByRole('group', { name: 'Swimlane group by' });
    expect(
      within(group)
        .getAllByRole('button')
        .every((b) => (b as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(screen.getByText(/Read-only access — you can view this board/)).toBeTruthy();
  });

  it('as a MEMBER: grooming and creating are all there', async () => {
    await renderCollections('member');
    await screen.findByTestId('board');
    expect(await screen.findByTestId('backlog-row-actions-GAT-1')).toBeTruthy();
    expect(screen.getByTestId('backlog-row-check-GAT-1')).toBeTruthy();
    expect(screen.getByTestId('create-sprint')).toBeTruthy();
    expect((await screen.findByTestId('create-issue-backlog')).tagName).toBe('BUTTON');
    expect(screen.queryByText(/Read-only access — you can view this board/)).toBeNull();
  });
});

describe('navigation', () => {
  it('the org menu offers a plain org member no forbidden room, and an org owner every room', async () => {
    const owner = await organizationsService.resolveActiveOrganization(s.fx.ownerId);
    for (const [role, admin] of [
      [s.actors.viewer.orgRole, false],
      [owner!.role, true],
    ] as const) {
      cleanup();
      expect(orgCan(role, 'manageOrgSettings')).toBe(admin);
      render(
        <OrgControl
          activeOrg={{ id: owner!.organization.id, name: owner!.organization.name, role }}
          orgs={[owner!.organization]}
          cloudBilling
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Organization menu' }));
      // Usage & cost is Owner/Admin too since the org-roles merge (MOTIR-6167 over
      // MOTIR-6175): a Member's org menu carries no org rows (MOTIR-6312 · panel 3).
      for (const room of ['Security', 'Members', 'Usage & cost', 'Billing & plans']) {
        expect(screen.queryByRole('link', { name: room }) !== null, `${role}: ${room}`).toBe(admin);
      }
    }
  });

  it('⌘K offers Create only to an actor the create modal is mounted for', async () => {
    const project = s.fx.project;
    for (const [who, offered] of [
      ['viewer', false],
      ['member', true],
    ] as const) {
      cleanup();
      render(
        <AppCommandPalette
          workspaces={[]}
          activeWorkspaceId={s.fx.workspaceId}
          projects={[project]}
          activeProjectId={project.id}
          settingsPermissions={s.actors[who].permissions}
        />,
      );
      await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
      expect(screen.queryByRole('option', { name: /create work item/i }) !== null, who).toBe(
        offered,
      );
    }
  });
});
