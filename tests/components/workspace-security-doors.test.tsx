// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Story MOTIR-1215 · Subtask MOTIR-3647 — the two DOORS onto the workspace
// Security pane, and the one condition both share.
//
// ⚠️ ONE OF THE TWO DOORS HAS MOVED (Story MOTIR-4843 · MOTIR-4847). The RAIL
// door is gone: `Security` left the project rail's bottom section entirely, and
// is now a row in the workspace area's OWN rail
// (`lib/settings/workspaceSettingsNav.ts`, covered by
// `SidebarNav-workspace-area.test.tsx`). The palette door below is UNCHANGED —
// a palette action is a second door, and this story removes doors only where
// another covers the same room at the same reveal arm.
//
// ⚠️ AND THE CARVE-OUT BESIDE IT IS RETIRED. This comment used to say
// the workspace Job runs route, `/github` and `/gitlab` "must keep rendering at
// every count — they are workspace-SCOPED but not workspace-NAMED". That was
// MOTIR-3502's AC 6, and it was the tell rather than the exception: a surface
// exempted from a hiding rule BECAUSE IT STILL ANSWERS is one that was never
// given a relocation. Job runs got one (MOTIR-4861's fold-in, since retired with
// the tenant surface by Story MOTIR-9982)
// and Git changed tier (MOTIR-4680), so all of them are gone from this section.
//
// What is unchanged is the REASON: this pane is workspace-named and
// `notFound()`s below the threshold, so a door to it there would be a promise
// the product then refuses (`SidebarNav`'s own standing rule). Below the
// threshold the control is reached through the org-settings fold-in — nothing is
// lost, only re-homed.

let pathname = '/dashboard';
const { navSearchParams } = vi.hoisted(() => ({ navSearchParams: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  // MOTIR-4730 — the planning door in this tree reads the address, so a
  // partial navigation mock is a crash rather than a gap.
  useSearchParams: () => navSearchParams,
}));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn(async () => undefined) }));
vi.mock('@/app/(authed)/_project-actions', () => ({ setActiveProjectAction: vi.fn() }));
vi.mock('@/app/(authed)/_actions', () => ({ switchWorkspaceAction: vi.fn() }));
// The palette composes over provider context; stub each hook so the unit render
// is context-free and it mounts open (the shape every palette test here uses).
vi.mock('@/app/(authed)/_components/CommandPaletteProvider', () => ({
  useCommandPalette: () => ({ open: true, setOpen: vi.fn() }),
}));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({ openCreateIssue: vi.fn(), canCreate: false }),
}));
vi.mock('@/app/(authed)/_components/OnboardingResumeProvider', () => ({
  useOnboardingResume: () => false,
}));
vi.mock('@/lib/contexts/theme-context', () => ({
  useTheme: () => ({ pattern: 'light', setPattern: vi.fn() }),
}));

import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';
import { AppCommandPalette } from '@/app/(authed)/_components/AppCommandPalette';

const PROJECT = {
  id: 'p1',
  key: 'MOTIR',
  identifier: 'MOTIR',
  name: 'Motir',
  archivedAt: null,
} as unknown as ProjectDTO;

const USER = { name: 'Yue', email: 'yue@example.com' };
const HREF = '/settings/workspace/security';

afterEach(cleanup);

function renderRail(workspaceTierRevealed: boolean) {
  return renderWithIntl(
    <SidebarNav
      activeProject={PROJECT}
      settingsPermissions={[]}
      user={USER}
      workspaceTierRevealed={workspaceTierRevealed}
    />,
  );
}

describe('the settings rail', () => {
  // AMENDED, not deleted (MOTIR-4847). Three cases here asserted a rail row that
  // no longer exists — its presence above the reveal, its absence below it, and
  // the `active:` clause the door used to yield to it with. All three are
  // REPLACED by their negations rather than removed: "there is no Security row
  // in this section at any count" is the new contract, and a deleted case would
  // leave it recorded nowhere while the file's name still promised it.

  it('⚠️ renders NO Security row AT EITHER COUNT — the row moved to the area rail', () => {
    for (const revealed of [true, false]) {
      cleanup();
      const { container } = renderRail(revealed);
      expect(container.innerHTML, `revealed=${revealed}`).not.toContain(HREF);
    }
  });

  it('renders no Job runs row either — the row is retired (Story MOTIR-9982)', () => {
    for (const revealed of [true, false]) {
      cleanup();
      renderRail(revealed);
      expect(screen.queryByRole('link', { name: 'Job runs' }), `revealed=${revealed}`).toBeNull();
    }
  });

  it('⚠️ NEITHER neighbour is in this section any more, at either count', () => {
    // This case was `the Git row is unaffected at either count` — Git had moved
    // to the ORGANISATION tier (MOTIR-4680), which gave it no reveal arm and
    // made it the section's only unconditional member.
    //
    // Both witnesses have since left: `Job runs` with MOTIR-4847 and `Git` with
    // MOTIR-4643. So the case can no longer prove "the neighbours are
    // unaffected" by naming a survivor — there is none to name. It asserts their
    // ABSENCE at both counts instead, which is the claim that is now true and
    // the one that fails if either row returns without anyone deciding it
    // should.
    for (const revealed of [true, false]) {
      cleanup();
      const { container } = renderRail(revealed);
      expect(container.innerHTML, `revealed=${revealed}`).not.toContain(
        'href="/settings/organization/git"',
      );
    }
  });

  it('⚠️ the Settings row is not even BUILT on the Security route now', () => {
    // This case used to assert that the door stood down for Security's own row.
    // Both halves of that are gone: there is no Security row to yield to, and
    // `/settings/workspace/security` is inside the workspace AREA, so
    // `SidebarNav` returns that area's own Sidebar before it reaches this
    // section at all (MOTIR-4846's fourth branch). The two clauses that used to
    // negate this pathname were deleted with the rows — a clause that can never
    // fire is not a safe extra, it is an untested branch that reads as covered
    // (MOTIR-4368's finding about this very predicate).
    pathname = HREF;
    renderRail(true);
    expect(screen.queryByRole('link', { name: 'Git' })).toBeNull();
    pathname = '/dashboard';
  });
});

describe('the ⌘K palette', () => {
  function renderPalette(workspaceCount: number, isOrgAdmin = true) {
    return renderWithIntl(
      <AppCommandPalette
        isOrgAdmin={isOrgAdmin}
        workspaces={Array.from({ length: workspaceCount }, (_, i) => ({
          id: `ws${i}`,
          name: `Workspace ${i}`,
          slug: `ws${i}`,
          organizationId: 'org_acme',
        }))}
        activeWorkspaceId="ws0"
        projects={[PROJECT]}
        activeProjectId={PROJECT.id}
      />,
    );
  }

  it('does NOT offer the org security pane to an org MEMBER (MOTIR-6312) — the page refuses them', () => {
    renderPalette(2, false);
    expect(screen.queryByRole('option', { name: /go to organization security/i })).toBeNull();
  });

  it('offers the ORG security pane at every count — an organization always exists', () => {
    for (const count of [1, 2]) {
      cleanup();
      renderPalette(count);
      expect(
        screen.getByRole('option', { name: /go to organization security/i }),
        `count=${count}`,
      ).toBeTruthy();
    }
  });

  it('offers it to NOBODY else — the pane answers a plain org member with the forbidden panel (MOTIR-6175)', () => {
    for (const count of [1, 2]) {
      cleanup();
      renderPalette(count, false);
      expect(
        screen.queryByRole('option', { name: /go to organization security/i }),
        `count=${count}`,
      ).toBeNull();
    }
  });

  it('offers the WORKSPACE pane only once the tier is revealed', () => {
    renderPalette(2);
    expect(screen.getByRole('option', { name: /go to workspace security/i })).toBeTruthy();

    cleanup();
    renderPalette(1);
    expect(screen.queryByRole('option', { name: /go to workspace security/i })).toBeNull();
  });
});
