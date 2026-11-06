// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, screen, within } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { WorkspaceSummaryDTO } from '@/lib/dto/workspaces';
import type { OrganizationDTO } from '@/lib/dto/organizations';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ThemeProvider } from '@/lib/contexts/theme-context';

// MOTIR-2558 — the STORY gate's seam half
// (`design/shell/design-notes.md` § *The context row*).
//
// The unit files each render one component with hand-made props:
// `shell-tier-nav.test.tsx` pins the ladder, `sidebar-nav-rail-head.test.tsx`
// pins that the rail gave the control up, `brand-tile-contrast.test.ts` pins the
// tile. What none of them can see is the thing this story actually introduced:
// **two `ShellTierNav` instances, in two hosts, fed from ONE layout, carrying
// DIFFERENT parts of the path.** A unit test cannot tell "the tier nav renders
// three tiers" apart from "the tier nav renders three tiers when the layout
// actually hands it a project" — and it is the second that people rely on.
//
// So this file drives the REAL TopNav with the REAL ShellTierNav (no stub,
// unlike `top-nav-brand-slot` / `top-nav-control-budget`, which stub it because
// they are about other clusters), and reads the layout itself for the wiring a
// render cannot reach.

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => {
    const messages = (await import('@/messages/en.json')).default as Record<string, unknown>;
    const shell = messages.shell as Record<string, Record<string, string>>;
    return (key: string) => {
      const [group, leaf] = key.split('.');
      return shell?.[group!]?.[leaf!] ?? key;
    };
  }),
}));
const { navSearchParams } = vi.hoisted(() => ({ navSearchParams: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  // MOTIR-4730 — the planning door in this tree reads the address, so a
  // partial navigation mock is a crash rather than a gap.
  useSearchParams: () => navSearchParams,
}));
// Only the modals and the right cluster's own controls are stubbed — the LEFT
// cluster is the subject and renders for real.
vi.mock('@/app/(authed)/_components/CreateIssueModal', () => ({ CreateIssueModal: () => null }));
vi.mock('@/app/(authed)/settings/project/members/_components/BuildInPublicDialog', () => ({
  BuildInPublicDialog: () => null,
}));

import { TopNav, type TopNavProps } from '@/app/(authed)/_components/TopNav';
import { ShellTierNav } from '@/app/(authed)/_components/ShellTierNav';
import { CommandPaletteProvider } from '@/app/(authed)/_components/CommandPaletteProvider';
import { CreateIssueProvider } from '@/app/(authed)/_components/CreateIssueProvider';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import { ReportProvider } from '@/app/(authed)/_components/ReportProvider';

const LAYOUT = readFileSync(resolve(import.meta.dirname, '../../app/(authed)/layout.tsx'), 'utf8');

const ORG = { id: 'org1', name: 'moooon B.V.', slug: 'moooon', role: 'owner' };
const ORGS = [{ id: 'org1', name: 'moooon B.V.', slug: 'moooon' }] as unknown as OrganizationDTO[];
const ws = (id: string, name: string) =>
  ({ id, name, slug: name.toLowerCase(), role: 'admin' }) as unknown as WorkspaceSummaryDTO;
const PROJECT = {
  id: 'p1',
  name: 'Motir',
  identifier: 'MOTIR',
  archivedAt: null,
} as unknown as ProjectDTO;

/** The layout's own prop shape, as `app/(authed)/layout.tsx` assembles it. */
function layoutProps(over: Partial<TopNavProps> = {}): TopNavProps {
  return {
    activeOrg: ORG,
    orgs: ORGS,
    workspaces: [ws('w1', 'Engineering'), ws('w2', 'Marketing')],
    activeWorkspaceId: 'w1',
    activeProject: PROJECT,
    projects: [PROJECT],
    aiConfigured: true,
    user: { name: 'Zhu Yue', email: 'yue@example.com' },
    initialUnreadCount: 3,
    buildInPublicProjectKey: null,
    buildingInPublic: true,
    cloudBilling: false,
    showPlanWithAi: true,
    ...over,
  };
}

function wrap(node: React.ReactNode) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <CommandPaletteProvider>
          <CreateIssueProvider canEdit>
            <ProjectAccessProvider permissions={['work_item:edit', 'project:administer']}>
              <ReportProvider projectKey="MOTIR" canEdit>
                {node}
              </ReportProvider>
            </ProjectAccessProvider>
          </CreateIssueProvider>
        </CommandPaletteProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

afterEach(cleanup);

describe('the context path, from the layout’s props to both hosts (MOTIR-2558)', () => {
  describe('the BAR — TopNav with the real tier nav', () => {
    it('carries the whole path when the layout hands it a project', async () => {
      const bar = await TopNav(layoutProps());
      const { container } = renderWithIntl(wrap(bar));
      const header = container.querySelector('header')!;

      expect(within(header).getByRole('button', { name: 'Organization menu' })).toBeTruthy();
      expect(within(header).getByRole('button', { name: 'Switch workspace' })).toBeTruthy();
      // the one that is new, and the reason this file exists
      expect(within(header).getByRole('button', { name: 'Switch project' }).textContent).toContain(
        'Motir',
      );
    });

    it('with no project, the tier reads "No project" and offers no create-first door', async () => {
      // History: MOTIR-4873 inverted this to "offers NOTHING", because every
      // member was inside a project (MOTIR-4870). A Limited member added to no
      // project made the state reachable again (Story MOTIR-6169 · MOTIR-6548):
      // the tier now renders the switcher with no project — an italic crumb and
      // an empty list — and still NOT the retired create-first door.
      const bar = await TopNav(layoutProps({ activeProject: null, projects: [] }));
      const { container } = renderWithIntl(wrap(bar));
      const header = container.querySelector('header')!;

      const trigger = within(header).getByRole('button', { name: 'Switch project' });
      expect(trigger.textContent).toContain('No project');
      expect(
        within(header).queryByRole('button', { name: 'Create your first project' }),
      ).toBeNull();
    });

    it('keeps the brand tile ahead of the path', async () => {
      const bar = await TopNav(layoutProps());
      const { container } = renderWithIntl(wrap(bar));
      // MOTIR-4799 — the tile points at the LANDING now; selector composed
      // from the owner constant rather than re-typed.
      const brand = container.querySelector(`a[href="${AUTHED_LANDING_PATH}"]`)!;
      // MOTIR-8932 — the tile is motir.co's logo tile, drawn inside the Link.
      expect(brand.querySelector('rect')!.getAttribute('class')).toBe('fill-(--el-logo-tile)');
    });
  });

  describe('the DRAWER — the same component, the other placement', () => {
    it('carries the ancestors and NO project tier', () => {
      renderWithIntl(
        wrap(
          <ShellTierNav
            activeOrg={ORG}
            orgs={ORGS}
            workspaces={[ws('w1', 'Engineering'), ws('w2', 'Marketing')]}
            activeWorkspaceId="w1"
            cloudBilling={false}
            placement="drawer"
          />,
        ),
      );
      expect(screen.getByRole('button', { name: 'Organization menu' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Switch workspace' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Switch project' })).toBeNull();
    });
  });

  // ⚠️ REMOVED (MOTIR-4873): 'the create-first door opens the SAME modal the
  // rail head opened'. It clicked the tier's create-first button and asserted
  // `CreateProjectModal` mounted — "the door moved, the room did not". The DOOR
  // is now gone from this tier; the ROOM is not, and the switcher's own specs
  // are where it is covered. Re-pointing this spec at the switcher would have
  // duplicated those rather than preserved anything this file is about (the
  // context path's own seam).

  describe('the WIRING — what a render cannot see', () => {
    it('feeds the bar’s instance the project half of the path', () => {
      // `TopNav` receives it and passes it down; the layout is where it is
      // RESOLVED, and a render of TopNav alone cannot prove the layout hands it
      // over. Reading the call site is what closes that.
      const topNavCall = /<TopNav\b[\s\S]*?\/>/.exec(LAYOUT)?.[0] ?? '';
      expect(topNavCall).toContain('activeProject={activeProject}');
      expect(topNavCall).toContain('projects={projects}');
      expect(topNavCall).toContain('aiConfigured={aiPlanningConfigured}');
    });

    it('gives the drawer header the drawer placement', () => {
      const drawerTier = /header=\{\s*<ShellTierNav[\s\S]*?\/>/.exec(LAYOUT)?.[0] ?? '';
      expect(drawerTier).toContain('placement="drawer"');
      expect(drawerTier).not.toContain('activeProject');
    });

    it('adds no new read — the props were already resolved for the rail', () => {
      // The move must not have cost a round-trip: `projectsService` is called
      // exactly where it was, for the same two values — plus the no-project
      // shell's create-door read (MOTIR-6548), which the layout makes ONLY when
      // there is no active project, so the everyday request pays nothing for it.
      const calls = LAYOUT.match(/projectsService\.\w+/g) ?? [];
      expect(new Set(calls)).toEqual(
        new Set([
          'projectsService.listProjects',
          'projectsService.getActiveProject',
          'projectsService.canOfferCreateProject',
        ]),
      );
      expect(LAYOUT).toMatch(
        /ctx && !activeProject\s*\?\s*await projectsService\.canOfferCreateProject/,
      );
    });

    it('stops feeding the rail data it no longer has a control for', () => {
      const sidebarCalls = LAYOUT.match(/<SidebarNav\b[\s\S]*?\/>/g) ?? [];
      expect(sidebarCalls).toHaveLength(2); // the rail and the drawer body
      for (const call of sidebarCalls) {
        expect(call).not.toContain('projects={projects}');
        expect(call).not.toContain('aiConfigured');
      }
    });
  });
});
