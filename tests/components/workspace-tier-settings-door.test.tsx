// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';

// The workspace-tier settings SUB-ROUTES, at both sides of the reveal threshold
// (MOTIR-3502 · `docs/decisions/organization-tier.md` §6d).
//
// ⚠️ THIS FILE WAS ABOUT THE **NO-PROJECT** SETTINGS DOOR, AND THAT DOOR IS GONE
// (MOTIR-4873). Its premise was: "with no active project this row is the rail's
// only settings entry, so deleting it would leave that user with no door at
// all" — so the row was RE-POINTED at `/settings/organization` (below the
// threshold) or `/settings/workspace` (at it) rather than removed.
//
// Every member is inside a project now (MOTIR-4870), so the row always
// deep-links to project settings and there is no reader for the re-pointed arm.
// The three cases that asserted its href are removed below, each in place.
//
// ⚠️ AND THE RATIONALE THIS FILE KEPT INSTEAD HAS ALSO GONE — the two stories
// met here, and each falsified the other's surviving half. This comment said
// "what survives is the claim §6d is actually about: the Job runs and Git rows
// are PRESENT at both counts, because they are workspace-SCOPED but not
// workspace-NAMED". MOTIR-4843 · MOTIR-4847 retired exactly that: `Security` and
// `Job runs` LEFT this section for the workspace area's own rail, `Git` left a
// tier earlier (MOTIR-4680), and §6d is satisfied by RELOCATION rather than by
// exemption — below the reveal both are reached through `/settings/organization`,
// where `WorkspaceFoldInSection` and the Job runs fold-in hosted them (the latter
// since retired with the tenant Job runs surface, Story MOTIR-9982). Its own
// half is equally gone: it closed "the door itself is unchanged and still
// re-pointed rather than removed", and the re-pointing is what MOTIR-4873
// removed.
//
// SO WHAT IS LEFT IS A NEGATIVE, AND IT IS WORTH KEEPING AS ONE: this rail names
// nothing in the workspace tier at EITHER count. Below the threshold it never
// did; at the threshold it used to name the area, and no longer does — the door
// moved to the workspace SWITCHER (MOTIR-4843) and the arm that put the href
// here regardless went with the projectless reader (MOTIR-4873). The four cases
// below assert that from both sides of the threshold, which is what shows the
// reveal has stopped changing this component's markup at all, and what fails if
// a workspace-tier href is ever re-introduced here. That is why the file is
// trimmed twice rather than deleted.
//
// ⚠️ ITS FIXTURE RENDERS `activeProject={null}`, which the product can no longer
// produce. It is kept because it is INCIDENTAL here — every assertion below is
// about workspace/organisation routes, none reads the project — and swapping it
// for a real project would add the switcher's markup to the very `container`
// these cases scan for route names. A fixture that cannot occur is a fair
// simplification when nothing under test depends on it; it would not be if one
// of these assertions ever started reading the project tier.

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}));
vi.mock('@/app/(authed)/_components/OnboardingResumeProvider', () => ({
  useOnboardingResume: () => false,
}));
vi.mock('@/lib/hooks/useSidebarCollapsed', () => ({
  useSidebarCollapsed: () => [false, vi.fn()],
}));

afterEach(cleanup);

const user = { name: 'Ada', email: 'ada@example.com' };

function renderRail(workspaceTierRevealed: boolean) {
  return renderWithIntl(
    <SidebarNav
      activeProject={null}
      variant="rail"
      user={user}
      workspaceTierRevealed={workspaceTierRevealed}
    />,
  );
}

/** The area's OWN href — a sub-route href does not match. */
function namesTheWorkspaceArea(html: string): boolean {
  return html.includes('href="/settings/workspace"');
}

describe('the workspace-tier sub-routes BELOW the reveal threshold', () => {
  it('names no /settings/workspace area anywhere in its markup', () => {
    const { container } = renderRail(false);
    expect(namesTheWorkspaceArea(container.innerHTML)).toBe(false);
  });

  // ⚠️ REMOVED (MOTIR-4873): 'points at the org settings home, which HOSTS the
  // folded-in sections', and 'is the DEFAULT — omitting the prop points at the
  // home that exists at every count'. Both asserted the href of the
  // no-project settings door, which no longer has a reader.

  it('⚠️ names NO workspace sub-route either — the exemption is gone (MOTIR-4847)', () => {
    // AMENDED, and its assertion INVERTED. This case used to assert
    // the workspace Job runs route PRESENT here, on the §6 "reveals a tier rather
    // than relocating every page" reading. That reading was the defect: a
    // workspace-tier surface answering 200 below the reveal, advertised from the
    // PROJECT's rail, is what MOTIR-4861's fold-in and this card together
    // repair. Below the threshold nothing in this rail names the workspace tier
    // at all — not the area, not one of its rooms.
    const { container } = renderRail(false);
    expect(container.innerHTML).not.toContain('/settings/workspace');
  });

  it('⚠️ names no organisation sub-route either — `Git` has left this rail as well', () => {
    // ⚠️ INVERTED A SECOND TIME (Story MOTIR-1754 · MOTIR-1768), and the title
    // went with the assertion. This case was `keeps the Git row, which is
    // organisation-scoped and not this rule's business`, and its rationale was
    // "GIT NOW NAMES THE ORGANISATION (MOTIR-4669 · MOTIR-4680) — a TIER move,
    // not the §6 fold this file is about; present at both counts because an
    // organisation always exists". That reading was correct and is simply
    // spent: MOTIR-4643 folded Code health + Git into the one primary
    // `Codebase` entry, so the row is not in this section at either count and
    // there is no longer an organisation-tier row here to be "not this rule's
    // business".
    //
    // It is asserted ABSENT rather than dropped because that is what fails if
    // the fold is ever partly reverted and a loose `Git` row returns.
    const { container } = renderRail(false);
    expect(container.innerHTML).not.toContain('/settings/organization/git');
    // ⚠️ AND THE WITNESS THAT THIS IS NOT AN EMPTY RAIL. `Git` used to be it —
    // the one row asserted PRESENT, which is what kept every negative above
    // from passing on markup that rendered nothing. With the row gone the
    // primary section carries the proof instead: it renders unconditionally now
    // (MOTIR-4873), so a rail that painted nothing fails here.
    expect(container.innerHTML).toContain('/items');
  });
});

describe('the workspace-tier sub-routes AT the reveal threshold', () => {
  // ⚠️ REMOVED (MOTIR-4873): 'points at the workspace area, exactly as it does
  // on main' — the third and last assertion about the no-project door's href.

  it('names NEITHER the area NOR anything beneath it — the rail is out of this tier', () => {
    // ⚠️ THIS CASE WAS `names the area and NOTHING BENEATH IT` AND EXPECTED
    // `href="/settings/workspace"` (MOTIR-4847). Two stories met on it and the
    // area's href left the rail by BOTH doors at once:
    //
    //   · MOTIR-4843 moved the workspace-settings DOOR to the workspace
    //     SWITCHER, which is a different component and so is not in this
    //     `container` at all; and
    //   · MOTIR-4873 removed the arm that put it here anyway. The rail's
    //     settings row used to render UNCONDITIONALLY for a reader with no
    //     active project and point at the workspace area — which is the only
    //     reason this projectless fixture ever saw that href. Every member is
    //     inside a project now (MOTIR-4870), so the row renders on permission
    //     like any other and deep-links to PROJECT settings.
    //
    // So the rail names nothing in this tier at EITHER count, which makes this
    // case and its sibling above assert the same thing from opposite sides of
    // the threshold. That is not redundancy to trim: the pair is what shows the
    // reveal no longer changes this component's markup, and it is the assertion
    // that fails if a workspace-tier href is ever re-introduced here.
    const { container } = renderRail(true);
    // NOTHING IN THE WORKSPACE TIER — not the area, not one of its rooms. This
    // is main's assertion set (MOTIR-4873 · MOTIR-4847) kept whole.
    expect(container.innerHTML).not.toContain('href="/settings/workspace"');
    expect(container.innerHTML).not.toContain('/settings/workspace/security');
    // ⚠️ AND NOTHING IN THE ORGANISATION TIER EITHER (Story MOTIR-1754 ·
    // MOTIR-1768). This line asserted `/settings/organization/git` PRESENT,
    // with the note "the Git row is organisation-scoped and stays, which is
    // what keeps this from passing on an empty rail". MOTIR-4643 folded that
    // row into the primary `Codebase` entry, so the assertion is inverted and
    // the non-emptiness witness has to be found elsewhere — the line below.
    expect(container.innerHTML).not.toContain('/settings/organization/git');
    expect(container.innerHTML).toContain('/items');
  });
});
