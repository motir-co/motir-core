// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { QuickViewData } from '@/app/(authed)/items/_components/IssueQuickViewPanel';

// The /items QUICK-VIEW peek (Subtask 2.5.19) under happy-dom — the client
// pieces of the card's "trigger sets ?peek + the modal renders the item + Open
// full page href is /items/[key] + close clears the param" AC. The peek is
// URL-driven, so the trigger and the close affordances just NAVIGATE; we stub
// next/navigation (no real router under happy-dom) and assert the pushed URLs.
// The populated panel is presentational (data in), so it renders directly. The
// open→peek→Open-full-page flow end-to-end + the open-modal a11y sweep are the
// Story E2E's job (2.5.6).

const push = vi.fn();
let searchParamsString = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(searchParamsString),
}));

import { QuickViewCloseButton } from '@/app/(authed)/items/_components/QuickViewCloseButton';
import { IssueQuickViewPanel } from '@/app/(authed)/items/_components/IssueQuickViewPanel';

// Opening / closing the peek updates the URL via SHALLOW routing (bug 8.8.2) —
// `window.history.pushState`, NOT `router.push` — so it's a pure URL change that
// never re-renders the host server page (no underlying-list refetch). So the
// trigger/close assert against a pushState spy, not the router mock.
const historyPush = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});

afterEach(() => {
  push.mockReset();
  historyPush.mockClear();
  searchParamsString = '';
  cleanup();
});

const DATA: QuickViewData = {
  folderId: null,
  folderPath: [],
  identifier: 'PROD-7',
  title: 'Email + password sign-in',
  projectIdentifier: 'PROD',
  workItemRefs: {},
  kind: 'story',
  statusLabel: 'In Progress',
  statusCategory: 'in_progress',
  fixReason: null,
  descriptionMd: 'Sign in with email and password.',
  explanationMd: null,
  type: null,
  executor: null,
  difficulty: null,
  obsolescence: null,
  obsolescenceNoteMd: null,
  assigneeName: 'Marco Ortiz',
  reporterName: 'Alice Chen',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: 'Jun 12, 2026',
  sprintName: null,
  storyPoints: null,
  estimateLabel: '8h',
  customFields: [],
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
  parent: { identifier: 'PROD-1', title: 'Q3 launch', kind: 'epic' },
  readiness: null,
  archived: null,
  pullRequests: [],
  repoDelivery: [],
  deliveries: [],
  hasChildren: false,
  canPlan: true,
  // MOTIR-2562 — the editor inputs the widened payload carries. The peek's rail
  // is a write surface, so a QuickViewData now also names the item's internal id,
  // the raw current values each control selects against, and the option sources.
  id: 'cmqvitem00000000000000p7',
  status: 'in_progress',
  assigneeId: null,
  parentId: null,
  sprintId: null,
  dueDate: null,
  estimateMinutes: null,
  workflow: { statuses: [], transitions: [], policyMode: 'restricted' },
  members: [],
  sprints: [],
  projectComponents: [],
  estimation: {
    estimationStatistic: 'story_points' as const,
    pointScale: 'fibonacci' as const,
    customScaleValues: [],
    canEdit: true,
  },
};

// The /items row peek-on-click (the per-row eye `QuickViewTrigger` was removed
// in MOTIR-1306 — a plain row click now opens the peek). The shared
// plain-click→peek guard (`usePeekRowClick`) is exercised through
// `RelationshipPeekLink` in relationships-panel.test.tsx, and the row-link wiring
// (List + Tree: plain click → peek, ⌘/ctrl-click → detail page) is covered
// end-to-end by issue-list-flow.spec.ts.

describe('IssueQuickViewPanel — the Development section (MOTIR-1579)', () => {
  it('renders the EmptyState when the item has no linked PR (design Panel 4a)', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    const section = screen.getByTestId('development-section');
    expect(section.textContent).toContain('Development');
    expect(section.textContent).toContain('No linked pull request');
    // The quiet copy names the explicit UI and MCP doors.
    expect(section.textContent).toContain('+ Link pull request');
    expect(section.textContent).toContain('link_pull_request over the MCP');
  });

  it('renders pr-rows with the PR-state + CI-state pills, meta, and the external link-out (design Panel 3)', () => {
    const data: QuickViewData = {
      ...DATA,
      pullRequests: [
        {
          id: 'pr-131',
          title: 'Add per-route rate limiting',
          repo: 'moooon/motir-core',
          number: 131,
          state: 'merged',
          ci: 'passing',
          headSha: null,
          url: 'https://github.com/moooon/motir-core/pull/131',
          githubReview: null,
          preview: null,
          baseRef: 'main',
          conflicted: false,
        },
        {
          id: 'pr-57',
          title: 'Throttle burst traffic on /v1',
          repo: 'moooon/motir-gateway',
          number: 57,
          state: 'open',
          ci: 'running',
          headSha: null,
          url: 'https://github.com/moooon/motir-gateway/pull/57',
          githubReview: null,
          preview: null,
          baseRef: 'main',
          conflicted: false,
        },
        {
          id: 'pr-119',
          title: 'Spike: webhook signatures',
          repo: 'moooon/motir-core',
          number: 119,
          state: 'closed',
          ci: null, // no CI recorded → NO CI pill
          headSha: null,
          url: 'https://github.com/moooon/motir-core/pull/119',
          githubReview: null,
          preview: null,
          baseRef: 'main',
          conflicted: false,
        },
      ],
    };
    render(<IssueQuickViewPanel state="ready" data={data} />);
    const section = screen.getByTestId('development-section');
    // State is conveyed by TEXT (pill labels), not colour alone (AA).
    expect(section.textContent).toContain('Add per-route rate limiting');
    expect(section.textContent).toContain('moooon/motir-core · #131');
    expect(section.textContent).toContain('Merged');
    expect(section.textContent).toContain('Checks passing');
    expect(section.textContent).toContain('Open');
    expect(section.textContent).toContain('Checks running');
    expect(section.textContent).toContain('Closed');
    // The null-CI row renders NO CI pill: exactly two "Checks …" pills total.
    expect(section.textContent!.match(/Checks /g)).toHaveLength(2);
    // Each row links out to the PR in a new tab.
    const out = screen.getAllByRole('link', { name: 'Open on GitHub' });
    expect(out).toHaveLength(3);
    expect(out[0]!.getAttribute('href')).toBe('https://github.com/moooon/motir-core/pull/131');
    expect(out[0]!.getAttribute('target')).toBe('_blank');
    expect(out[0]!.getAttribute('rel')).toContain('noopener');
    // The caption names the explicit MCP door instead of promising a text-derived link.
    expect(section.textContent).toContain('Linked by link_pull_request over the MCP');
  });
});

describe('IssueQuickViewPanel — populated (ready)', () => {
  it('renders the item title + status + assignee', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    expect(screen.getByText('Email + password sign-in')).toBeTruthy();
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
    expect(screen.getByText('Marco Ortiz')).toBeTruthy();
  });

  it('"Open full page" + the header identifier both link to /items/[key]', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    expect(screen.getByTestId('quick-view-open-full').getAttribute('href')).toBe('/items/PROD-7');
    expect(screen.getByRole('link', { name: 'PROD-7' }).getAttribute('href')).toBe('/items/PROD-7');
  });

  it('opens every detail-page link in a NEW TAB — target=_blank + rel=noopener (8.8.31)', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    // The four links that navigate to a work-item DETAIL page (`/items/<KEY>`):
    // the header identifier, "Open full page →", the description-footer "more"
    // link (all → /items/PROD-7), and the rail Parent link (→ /items/PROD-1).
    const detailLinks = screen
      .getAllByRole('link')
      .filter((a) => /^\/items\/[A-Z]/.test(a.getAttribute('href') ?? ''));
    expect(detailLinks).toHaveLength(4);
    for (const a of detailLinks) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    }
  });
});

describe('IssueQuickViewPanel — expanded field set (Subtask 8.8.8)', () => {
  // A fully-populated leaf (subtask) so the leaf-only Type/Executor rows render
  // alongside labels, components, sprint, story points, and the audit line.
  const FULL: QuickViewData = {
    ...DATA,
    identifier: 'PROD-9',
    kind: 'subtask',
    type: 'code',
    executor: 'coding_agent',
    labels: [
      { id: 'l1', name: 'auth' },
      { id: 'l2', name: 'security' },
    ],
    components: [{ id: 'c1', name: 'API' }],
    sprintName: 'Sprint 7',
    storyPoints: 5,
    createdAt: '2026-06-02T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    customFields: [
      {
        id: 'f1',
        key: 'team',
        label: 'Team',
        fieldType: 'text',
        description: null,
        options: [],
        value: { text: 'Platform', number: null, date: null, option: null, user: null },
      },
      {
        id: 'f2',
        key: 'tier',
        label: 'Tier',
        fieldType: 'text',
        description: null,
        options: [],
        value: null,
      },
    ],
  };

  it('renders the work type, executor, labels, components, sprint, and story points', () => {
    render(<IssueQuickViewPanel state="ready" data={FULL} />);
    expect(screen.getByText('Code')).toBeTruthy();
    expect(screen.getByText('Agent')).toBeTruthy();
    // Rail field titles resolve from the `issueViews` namespace (bug 8.8.x:
    // they were read via the `labels` namespace, so the raw key path showed).
    expect(screen.getByText('Labels')).toBeTruthy();
    expect(screen.getByText('Components')).toBeTruthy();
    expect(screen.getByText('auth')).toBeTruthy();
    expect(screen.getByText('security')).toBeTruthy();
    expect(screen.getByText('API')).toBeTruthy();
    expect(screen.getByText('Sprint 7')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('shows valued custom fields and hides empty ones behind the disclosure', () => {
    render(<IssueQuickViewPanel state="ready" data={FULL} />);
    // The valued custom field is visible; the empty one is hidden until expand.
    expect(screen.getByText('Platform')).toBeTruthy();
    expect(screen.queryByText('Tier')).toBeNull();
    // ⚠️ The label changed in MOTIR-2599, deliberately. 8.8.8 built this
    // disclosure READ-ONLY, so "Show more fields (N)" was accurate. Now the rail
    // edits, it is the only ROUTE to an empty field someone wants to fill, and a
    // label promising only to "show" them understates what it does.
    const more = screen.getByRole('button', { name: /1 more field/ });
    fireEvent.click(more);
    expect(screen.getByText('Tier')).toBeTruthy();
  });

  it('omits the leaf-only Type/Executor rows for a container kind (story)', () => {
    // The base DATA is a story (no work type) — Type/Executor must not render.
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    expect(screen.queryByText('Agent')).toBeNull();
  });
});

describe('IssueQuickViewPanel — readiness banner (Subtask 2.5.21)', () => {
  // The banner shows only for a TODO-category item with blockers.
  const TODO = { ...DATA, statusLabel: 'To Do', statusCategory: 'todo' as const };

  it('blocked: renders the Blocked banner naming open blockers as new-tab detail links (8.8.32)', () => {
    searchParamsString = 'view=list&peek=PROD-7';
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{
          ...TODO,
          readiness: { ready: false, blockers: ['PROD-3', 'PROD-8'], blockedByAncestor: null },
        }}
      />,
    );
    expect(screen.getByText('Blocked')).toBeTruthy();
    expect(screen.getByText(/Waiting on 2 work items/)).toBeTruthy();
    // 8.8.32 (overrides the 2.5.20 peek-swap + the 8.8.31 exclusion): each blocker
    // link now points to the blocker's DETAIL page and opens in a NEW TAB, so a
    // click leaves the current peek open in the original tab.
    const b3 = screen.getByRole('link', { name: 'PROD-3' });
    expect(b3.getAttribute('href')).toBe('/items/PROD-3');
    expect(b3.getAttribute('target')).toBe('_blank');
    expect(b3.getAttribute('rel')).toContain('noopener');
    const b8 = screen.getByRole('link', { name: 'PROD-8' });
    expect(b8.getAttribute('href')).toBe('/items/PROD-8');
    expect(b8.getAttribute('target')).toBe('_blank');
    expect(b8.getAttribute('rel')).toContain('noopener');
  });

  it('cascade-blocked: names the blocked parent (own blockers clear) so the banner is not a bare "Blocked" (7.0.13)', () => {
    searchParamsString = 'view=list&peek=PROD-7';
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{
          ...TODO,
          readiness: {
            ready: false,
            blockers: [],
            blockedByAncestor: { id: 'ancestor-8', identifier: 'PROD-8', title: '7.19 Roadmap' },
          },
        }}
      />,
    );
    // The SOFT banner (MOTIR-6377): the peek renders the same variant.
    expect(screen.getByText('Parent blocked')).toBeTruthy();
    expect(screen.queryByText('Blocked')).toBeNull();
    expect(screen.getByText(/Waiting on a parent item —/)).toBeTruthy();
    const parent = screen.getByRole('link', { name: 'PROD-8' });
    expect(parent.getAttribute('href')).toBe('/items/PROD-8');
    expect(parent.getAttribute('target')).toBe('_blank'); // peek → new tab
  });

  it('ready: renders "Ready to start" when the verdict is ready (all blockers resolved, OR none — bug-ready-banner-no-deps)', () => {
    // `{ ready: true, blockers: [] }` is the payload for BOTH "every blocker is
    // terminal" and "the item has no blockers at all" — a no-dependency todo item
    // is the most ready it can be and shows the same green banner.
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...TODO, readiness: { ready: true, blockers: [], blockedByAncestor: null } }}
      />,
    );
    expect(screen.getByText('Ready to start')).toBeTruthy();
    expect(screen.getByText('All blockers resolved')).toBeTruthy();
  });

  it('null verdict: renders NO readiness banner (no verdict carried)', () => {
    render(<IssueQuickViewPanel state="ready" data={{ ...TODO, readiness: null }} />);
    expect(screen.queryByText('Blocked')).toBeNull();
    expect(screen.queryByText('Ready to start')).toBeNull();
  });

  it('non-todo status: suppresses the banner even with open blockers (moot past todo)', () => {
    // Same blocked verdict as the first case, but the item is in-progress.
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{
          ...DATA,
          statusCategory: 'in_progress',
          readiness: { ready: false, blockers: ['PROD-3', 'PROD-8'], blockedByAncestor: null },
        }}
      />,
    );
    expect(screen.queryByText('Blocked')).toBeNull();
    expect(screen.queryByRole('link', { name: 'PROD-3' })).toBeNull();
  });
});

describe('IssueQuickViewPanel — the ARCHIVED state (bug MOTIR-2050)', () => {
  // An archived item IS reachable in the peek: an archived `motir:` reference
  // chip opens one (WorkItemRefChip), and the detail read behind the payload
  // doesn't filter `archivedAt`. Before this fix the payload carried no archived
  // field at all, so the peek showed an archived item as an ordinary one — and,
  // because archiving leaves `status` at `todo`, as a "Ready to start" one.
  const ARCHIVED = {
    ...DATA,
    statusLabel: 'To Do',
    statusCategory: 'todo' as const,
    readiness: { ready: true, blockers: [], blockedByAncestor: null },
    archived: { atLabel: 'Jun 15, 2026', byName: 'Alice Chen' },
  };

  it('renders NO readiness banner on an archived item, todo status notwithstanding', () => {
    render(<IssueQuickViewPanel state="ready" data={ARCHIVED} />);
    expect(screen.queryByText('Ready to start')).toBeNull();
    expect(screen.queryByText('All blockers resolved')).toBeNull();
  });

  it('renders NO readiness banner on an archived + BLOCKED item either', () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{
          ...ARCHIVED,
          readiness: { ready: false, blockers: ['PROD-3'], blockedByAncestor: null },
        }}
      />,
    );
    expect(screen.queryByText('Blocked')).toBeNull();
    expect(screen.queryByText(/Waiting on/)).toBeNull();
  });

  it('states the archived fact — the same banner + copy the detail page uses, actor and date named', () => {
    render(<IssueQuickViewPanel state="ready" data={ARCHIVED} />);
    const banner = screen.getByTestId('quick-view-archived-banner');
    expect(within(banner).getByText('This work item is archived')).toBeTruthy();
    expect(banner.textContent).toContain('Alice Chen');
    expect(banner.textContent).toContain('Jun 15, 2026');
    // Read-only surface: no Restore, and so no "Restore it to bring it back."
    // promise — "Open full page →" is the door to the action.
    expect(banner.textContent).not.toContain('Restore it to bring it back');
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
    expect(screen.getByTestId('quick-view-open-full')).toBeTruthy();
  });

  it('falls back to a former member when no archived actor resolved', () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...ARCHIVED, archived: { atLabel: 'Jun 15, 2026', byName: null } }}
      />,
    );
    expect(screen.getByTestId('quick-view-archived-banner').textContent).toContain(
      'a former member',
    );
  });

  it('marks the header with the neutral "Archived" chip, so the state survives scrolling', () => {
    render(<IssueQuickViewPanel state="ready" data={ARCHIVED} />);
    expect(screen.getByText('Archived')).toBeTruthy();
  });

  it('hides the Plan / Re-plan door on an archived item — it is not work to plan', () => {
    // The same gate the detail page applies (`canEdit && !isArchived`), now
    // reachable here because the payload carries the archived state.
    render(<IssueQuickViewPanel state="ready" data={ARCHIVED} />);
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
  });

  it('a LIVE item shows no archived banner and no chip', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    expect(screen.queryByTestId('quick-view-archived-banner')).toBeNull();
    expect(screen.queryByText('Archived')).toBeNull();
  });
});

describe('IssueQuickViewPanel — the Plan / Re-plan entrance (MOTIR-910)', () => {
  it('carries the SAME per-item door the detail page does, scoped to this item', () => {
    // ⚠️ RE-POINTED (MOTIR-4730). This asserted `/planning` — a destination. The
    // workspace is an overlay: the door's href is THIS page plus the workspace's
    // namespaced query, and `?peek=` rides along, which is what lets the reader
    // come back to the peek they launched from.
    searchParamsString = 'peek=PROD-7';
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    const door = screen.getByTestId('work-item-plan-entrance');
    const url = new URL(door.getAttribute('href')!, 'https://motir.test');
    expect(url.pathname).toBe('/items');
    expect(url.searchParams.get('planItem')).toBe('PROD-7');
    expect(url.searchParams.get('peek')).toBe('PROD-7');
  });

  it('reads "Plan" for a childless item and "Re-plan" once it has children', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    expect(screen.getByTestId('work-item-plan-entrance').getAttribute('data-mode')).toBe('plan');
    cleanup();

    render(<IssueQuickViewPanel state="ready" data={{ ...DATA, hasChildren: true }} />);
    expect(screen.getByTestId('work-item-plan-entrance').getAttribute('data-mode')).toBe('replan');
  });

  it('shows NO door to an actor who cannot edit the plan', () => {
    // Planning proposes plan changes; a browse-only viewer gets no door rather
    // than one that fails on the first turn.
    render(<IssueQuickViewPanel state="ready" data={{ ...DATA, canPlan: false }} />);
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
  });

  it('⚠️ does NOT hand the peek off any more — the workspace opens ABOVE it', () => {
    // INVERTED, deliberately (MOTIR-4730, the design's own decision in
    // `design/ai-chat/design-notes.md`). This used to pass `props.onClose` as the
    // door's `onActivate`, dismissing the peek as the workspace opened — right
    // when opening meant NAVIGATING away. An overlay is a layer: it opens above
    // the quick view, `?peek=` stays in the address, and closing it returns the
    // reader to the peek they launched from. Closing the peek on the way in
    // would throw away the thing they are planning about.
    const onClose = vi.fn();
    render(<IssueQuickViewPanel state="ready" data={DATA} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('work-item-plan-entrance'));
    expect(onClose).not.toHaveBeenCalled();
  });

  // bug MOTIR-2084 — the door offered planning on work the engine refuses to
  // re-plan: `validatePlanProposals` throws `PlanTargetImmutableError` for a
  // modify/remove against a terminal target, and the canvas already draws such
  // an item `locked`. Both faces, and the gate is on the CATEGORY (so the
  // workflow's second done-category status, Cancelled, is covered too).
  it('hides the door on a DONE item — the Plan face', () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, statusLabel: 'Done', statusCategory: 'done' }}
      />,
    );
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
  });

  it('hides the door on a DONE item — the Re-plan face (children do not re-open it)', () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, statusLabel: 'Done', statusCategory: 'done', hasChildren: true }}
      />,
    );
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
  });

  it('hides the door on a CANCELLED item — the gate reads the category, not the "done" key', () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, statusLabel: 'Cancelled', statusCategory: 'done' }}
      />,
    );
    expect(screen.queryByTestId('work-item-plan-entrance')).toBeNull();
  });

  it('still shows the door on live work — the gate is not over-broad', () => {
    // todo and in_progress both keep it; the DATA fixture is in_progress.
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    expect(screen.getByTestId('work-item-plan-entrance')).toBeTruthy();
    cleanup();

    render(<IssueQuickViewPanel state="ready" data={{ ...DATA, statusCategory: 'todo' }} />);
    expect(screen.getByTestId('work-item-plan-entrance')).toBeTruthy();
  });
});

describe('IssueQuickViewPanel — not found / no access', () => {
  it('renders the unavailable state naming the key, with no "Open full page"', () => {
    render(<IssueQuickViewPanel state="notfound" peekKey="PROD-404" />);
    expect(screen.getByText('This work item isn’t available')).toBeTruthy();
    expect(screen.getByText(/PROD-404/)).toBeTruthy();
    expect(screen.queryByTestId('quick-view-open-full')).toBeNull();
  });
});

describe('QuickViewCloseButton — clears ?peek', () => {
  it('drops only the peek param, preserving the rest', () => {
    searchParamsString = 'view=list&peek=PROD-7';
    render(<QuickViewCloseButton variant="icon" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(historyPush).toHaveBeenCalledWith(null, '', '/items?view=list');
  });

  it('navigates to the clean /items when peek was the only param', () => {
    searchParamsString = 'peek=PROD-7';
    render(<QuickViewCloseButton variant="button" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(historyPush).toHaveBeenCalledWith(null, '', '/items');
  });

  // MOTIR-1352: a non-URL host (the roadmap-canvas peek) supplies its own close;
  // the URL is never touched.
  it('calls the supplied onClose and leaves the URL untouched when onClose is given', () => {
    searchParamsString = 'view=list&peek=PROD-7';
    const onClose = vi.fn();
    render(<QuickViewCloseButton variant="icon" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(historyPush).not.toHaveBeenCalled();
  });
});

// bug MOTIR-2097 — the peek's face follows the same shared rule. The payload
// already carries `kind` and `descriptionMd`, so rule 2 lands here with no DTO
// change (unlike the /items row menu — see MOTIR-2098).
describe('IssueQuickViewPanel — which Plan / Re-plan face the peek wears', () => {
  const mode = () => screen.getByTestId('work-item-plan-entrance').getAttribute('data-mode');

  it('rule 2 — a DESCRIBED leaf reads Re-plan, not Plan', () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, kind: 'subtask', hasChildren: false, descriptionMd: 'Do the thing.' }}
      />,
    );
    expect(mode()).toBe('replan');
  });

  it('rule 2 — a leaf with no description reads Plan', () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, kind: 'subtask', hasChildren: false, descriptionMd: null }}
      />,
    );
    expect(mode()).toBe('plan');
  });

  it('rule 2 — a whitespace-only description does not count as one', () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, kind: 'bug', hasChildren: false, descriptionMd: '   \n  ' }}
      />,
    );
    expect(mode()).toBe('plan');
  });

  it('rule 3 — a childless STORY reads Plan even with a description', () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, kind: 'story', hasChildren: false, descriptionMd: 'A big story.' }}
      />,
    );
    expect(mode()).toBe('plan');
  });

  it('rule 3 — a story WITH children reads Re-plan', () => {
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{ ...DATA, kind: 'story', hasChildren: true, descriptionMd: null }}
      />,
    );
    expect(mode()).toBe('replan');
  });
});

// THE QUICK VIEW'S TRANSLATION (Story MOTIR-7735 · MOTIR-8122; design MOTIR-8112
// D3). The offer rides the peek read (`QuickViewData.translation`); the overlay
// draws the same control under its title and marks only the title and the
// description, and its press posts once for the whole item.
describe('IssueQuickViewPanel — translation', () => {
  const translated: QuickViewData = {
    ...DATA,
    translation: {
      canAddCredits: false,
      offer: {
        targetLanguage: 'en',
        anyNeedsTranslation: true,
        fields: {
          title: { needsTranslation: true, kept: false, sourceLanguage: 'de', revision: 'r0' },
          description: {
            needsTranslation: true,
            kept: false,
            sourceLanguage: 'de',
            revision: 'r0',
          },
          explanation: {
            needsTranslation: true,
            kept: false,
            sourceLanguage: 'de',
            revision: 'r0',
          },
        },
      },
    },
  };
  afterEach(() => vi.unstubAllGlobals());

  it('offers Translate, swaps the title and description, and marks only those', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        targetLanguage: 'en',
        fields: [
          { fieldRef: 'title', status: 'ready', text: 'Translated title' },
          { fieldRef: 'description', status: 'ready', text: 'Translated description.' },
          { fieldRef: 'explanation', status: 'failed' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<IssueQuickViewPanel state="ready" data={translated} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Translate' })));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/work-items/${translated.id}/translate`);
    expect(screen.getByText('Translated title')).toBeTruthy();
    expect(screen.getByText('Translated description.')).toBeTruthy();
    expect(container.querySelectorAll('[data-translation-mark="translated"]')).toHaveLength(2);
    expect(container.querySelector('[data-translation-mark="failed"]')).toBeNull();
  });

  it('no offer on the peek read → no control', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    expect(screen.queryByRole('group', { name: 'Translation' })).toBeNull();
  });
});
