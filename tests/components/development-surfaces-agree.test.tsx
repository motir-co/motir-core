// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import messages from '@/messages/en.json';
import type { LinkedPullRequestDto } from '@/lib/dto/github';

// MOTIR-3036 — THE DETAIL PAGE AND THE QUICK VIEW DERIVE THE AWAITING SET FROM
// THE SAME CODE.
//
// The Development section is mounted twice, and until this card each host
// computed the placeholder list itself:
//
//     awaitingRepos={repoDelivery.filter((d) => d.state !== 'delivered')}
//
// Two copies of one editorial decision, in two files, with nothing asserting
// they agree — which is how the section came to say "No pull request yet" about
// a repository whose pull request was on the row above it, on one surface, from
// a filter that was correct for the completion gate and wrong for a row.
//
// A test that renders one host and checks the output cannot catch that: it
// passes while the other host says the other thing. So this file asserts the
// SEAM, from both ends.
//
//   * The quick view is a client component, so it is RENDERED — the real panel,
//     the real section, the defect's own shape.
//   * The detail page is a Server Component that no unit environment can mount,
//     so its half is asserted against its SOURCE: it must hand the section the
//     item's set and take no editorial decision of its own.
//
// Either host re-growing a private filter fails this file.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/items',
  useSearchParams: () => new URLSearchParams(''),
}));

import {
  IssueQuickViewPanel,
  type QuickViewData,
} from '@/app/(authed)/items/_components/IssueQuickViewPanel';

const t = messages.github.development;

afterEach(cleanup);

const QUICK_VIEW_PANEL = 'app/(authed)/items/_components/IssueQuickViewPanel.tsx';
// MOTIR-3436 moved the Development SECTION off the detail page's critical path
// and into the late stack's own component. The guard follows the surface, not
// the filename it used to live in — a source guard pointed at a file the code
// left passes forever. Its anchor assertion below is what makes that visible
// the next time the surface moves.
const DETAIL_PAGE = 'app/(authed)/items/[key]/_components/LateSections.tsx';

/** The pull request in the report: OPEN, so its repository is `awaiting`. Its
 *  DTO names the repository `owner/name`; the item's set names it bare. */
const OPEN_PR: LinkedPullRequestDto = {
  id: 'pr-open-2120',
  title: 'feat(advisories): flag a card whose deliverable…',
  repo: 'moooon-B-V/motir-core',
  number: 2120,
  state: 'open',
  ci: 'running',
  headSha: null,
  url: 'https://github.com/moooon-B-V/motir-core/pull/2120',
  githubReview: null,
  preview: null,
  baseRef: 'main',
  conflicted: false,
};

const DATA: QuickViewData = {
  folderId: null,
  folderPath: [],
  identifier: 'MOTIR-2903',
  title: 'Planning bug: every readiness signal read green',
  projectIdentifier: 'MOTIR',
  workItemRefs: {},
  kind: 'bug',
  statusLabel: 'In Review',
  statusCategory: 'in_progress',
  fixReason: null,
  descriptionMd: null,
  explanationMd: null,
  type: 'code',
  executor: 'coding_agent',
  difficulty: null,
  obsolescence: null,
  obsolescenceNoteMd: null,
  assigneeName: null,
  reporterName: 'Zhu Yue',
  priority: 'medium',
  labels: [],
  components: [],
  dueLabel: null,
  sprintName: null,
  storyPoints: null,
  estimateLabel: null,
  customFields: [],
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  parent: null,
  readiness: null,
  archived: null,
  pullRequests: [OPEN_PR],
  repoDelivery: [{ repo: 'motir-core', state: 'awaiting', primary: true }],
  deliveries: [],
  hasChildren: false,
  canPlan: true,
  id: 'cmqvitem0000000000003036',
  status: 'in_review',
  assigneeId: null,
  parentId: null,
  sprintId: null,
  dueDate: null,
  estimateMinutes: 30,
  workflow: { statuses: [], transitions: [], policyMode: 'restricted' },
  members: [],
  sprints: [],
  projectComponents: [],
  estimation: {
    estimationStatistic: 'story_points' as const,
    pointScale: 'fibonacci' as const,
    customScaleValues: [],
    canEdit: false,
  },
};

describe('the quick view — the surface the defect was reported on', () => {
  it('does not say "No pull request yet" about the repository listed directly above', () => {
    render(<IssueQuickViewPanel state="ready" data={DATA} />);
    // Scoped to the section: the peek ALSO renders the repository rail, which
    // names the same repositories in its own (honest) words.
    const section = within(screen.getByTestId('development-section'));
    expect(section.getByText(OPEN_PR.title)).toBeTruthy();
    expect(section.queryByText(t.noPullRequestYet)).toBeNull();
    expect(section.getAllByRole('listitem')).toHaveLength(1);
  });

  it('still draws the placeholder for a repository that genuinely has no pull request', () => {
    // The suppression must be a cross-reference, not a blanket removal: a second
    // repository with nothing linked is exactly what the row exists for.
    render(
      <IssueQuickViewPanel
        state="ready"
        data={{
          ...DATA,
          repoDelivery: [
            { repo: 'motir-core', state: 'awaiting', primary: true },
            { repo: 'motir-ai', state: 'awaiting', primary: false },
          ],
        }}
      />,
    );
    const section = within(screen.getByTestId('development-section'));
    const rows = section.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText(t.noPullRequestYet)).toBeTruthy();
    expect(within(rows[1]!).getByText('motir-ai')).toBeTruthy();
  });
});

describe('neither host derives the set itself', () => {
  // Read from disk rather than imported: the detail page is a Server Component
  // with a database read at module scope, and the assertion is about what the
  // file SAYS anyway — a host that decides nothing.
  const source = (path: string) => readFileSync(path, 'utf8');

  it.each([QUICK_VIEW_PANEL, DETAIL_PAGE])(
    '%s hands the section the item’s set, unfiltered',
    (path) => {
      const s = source(path);
      // It mounts the section with the raw set…
      expect(s).toMatch(/repoDelivery=\{(data\.)?repoDelivery( \?\? \[\])?\}/);
      // …and nowhere filters a delivery list on its way there. This is the exact
      // expression both hosts carried, and the one that must not come back.
      expect(s).not.toMatch(/repoDelivery[^\n]*\.filter\(/);
      expect(s).not.toContain("state !== 'delivered'");
      // The old prop name is the other tell: it named a list the host had
      // already reduced. Nothing should pass one again.
      expect(s).not.toContain('awaitingRepos');
    },
  );

  it('finds the guarded files where it expects them', () => {
    // A source guard that reads the wrong path passes forever. Anchor it on
    // something only these two files contain.
    expect(source(QUICK_VIEW_PANEL)).toContain('<DevelopmentSection');
    expect(source(DETAIL_PAGE)).toContain('<DevelopmentSectionBody');
  });
});
