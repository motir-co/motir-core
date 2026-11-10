// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type {
  ApprovalGateKindDTO,
  ApprovalGateSubjectSummaryDTO,
  ApprovalQueueRowDto,
  ApprovalRecordDecidedRowDto,
} from '@/lib/dto/approvalGate';

// THE ROW READS AS A SENTENCE (Story MOTIR-5996 · MOTIR-5999; design-notes § 28,
// DECISION 1) — over EVERY gate kind, in BOTH locales, in every state the row can be
// in: awaiting, decided (the Approvals room's record), a kind this build does not
// render, and a subject that is gone. What each case proves is the same two facts:
// the row names the work item by its title inside the kind's sentence, and no visible
// text on it uses a git host's vocabulary.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=approvals'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

const { ApprovalRow } = await import('@/components/approvals/ApprovalRow');

afterEach(cleanup);

const TITLE = { en: 'Billing export runs nightly', zh: '账单导出每晚运行' };
const HOST_VOCABULARY = /pull request|\bPR\b|merge request|#\d+|拉取请求|合并请求/i;

const SUBJECTS: Record<
  // `plan_approval` has no subject summary yet — its row is MOTIR-6037's (Story MOTIR-6012).
  // `agent_review` is never on a To-approve row — the review agent answers it (ADR §12.1).
  // `manual_work`'s sentence changes with state and routing (four forms, § 33.2), so its row
  // has its own file: `approval-row-manual-work.test.tsx` (MOTIR-7478).
  Exclude<
    ApprovalGateKindDTO,
    'pull_request_merge' | 'plan_approval' | 'agent_review' | 'manual_work' | 'planning_session'
  >,
  ApprovalGateSubjectSummaryDTO
> = {
  design_result: {
    kind: 'design_result',
    designEvidenceId: 'ev',
    producedByKey: null,
    commitSha: '9840d00ea1b2',
    assetCount: 3,
    noteExcerpt: null,
  },
  acceptance_result: {
    kind: 'acceptance_result',
    acceptanceEvidenceId: 'ae',
    producedByKey: null,
    commitSha: '000042cd',
    chapterCount: 3,
  },
  pull_request_approval: {
    kind: 'pull_request_approval',
    members: [
      { repo: 'moooon/motir-core', number: 412, headSha: 'a', state: 'open' },
      { repo: 'moooon/motir-ai', number: 88, headSha: 'b', state: 'open' },
      { repo: 'moooon/motir-gateway', number: 17, headSha: 'c', state: 'open' },
    ],
  },
  decision_approval: {
    kind: 'decision_approval',
    outcome: 'none',
    repo: 'moooon/motir-core',
    number: 440,
    path: null,
    title: null,
    blobSha: null,
    documentCount: 0,
  },
  decision_choice: { kind: 'decision_choice', optionCount: 3, question: 'Which format?' },
  decision_confirmation: {
    kind: 'decision_confirmation',
    decision: 'Exports move to a bucket.',
    changes: ['workflow'],
    supersedesCount: 2,
  },
};

const KINDS = Object.keys(SUBJECTS) as (keyof typeof SUBJECTS)[];

function awaiting(
  kind: ApprovalGateKindDTO,
  subject: ApprovalGateSubjectSummaryDTO | null,
  locale: 'en' | 'zh',
): ApprovalQueueRowDto {
  return {
    gateId: `gate-${kind}`,
    kind,
    state: 'awaiting',
    canDecide: true,
    routedToName: 'Yue',
    waitingSince: new Date(Date.now() - 3_600_000).toISOString(),
    workItem: {
      id: 'wi-1',
      key: 61,
      identifier: 'ACME-61',
      title: TITLE[locale],
      kind: 'story',
      type: null,
    },
    subject,
  } as ApprovalQueueRowDto;
}

function decided(kind: keyof typeof SUBJECTS, locale: 'en' | 'zh'): ApprovalRecordDecidedRowDto {
  return {
    ...awaiting(kind, SUBJECTS[kind], locale),
    state: 'approved',
    decidedAt: new Date().toISOString(),
    decidedByLabel: 'Yue',
    decisionSource: 'ui',
    subjectVersion: 'a'.repeat(40),
    chosenOption: null,
    confirmedRecord: null,
  } as unknown as ApprovalRecordDecidedRowDto;
}

/** The sentence as the catalogue writes it, tags removed — what the reader reads. */
function sentence(locale: 'en' | 'zh', key: string): string {
  const messages = locale === 'en' ? en : zh;
  return (messages.workbench.approvals.sentence as Record<string, string>)
    [key]!.replace(/<\/?title>/g, '')
    .replace('{name}', TITLE[locale]);
}

function render(record: Parameters<typeof ApprovalRow>[0]['record'], locale: 'en' | 'zh') {
  return renderWithIntl(<ApprovalRow record={record} />, {
    locale,
    messages: locale === 'en' ? en : zh,
  });
}

/** The row door's accessible name carries the whole sentence. */
function doorName(): string {
  return screen.getAllByRole('link')[0]!.getAttribute('aria-label') ?? '';
}

describe.each(['en', 'zh'] as const)('the row as a sentence — %s', (locale) => {
  it.each(KINDS)('an AWAITING %s row reads its kind’s sentence and no host vocabulary', (kind) => {
    const { container } = render(
      { section: 'awaiting', row: awaiting(kind, SUBJECTS[kind], locale) },
      locale,
    );

    expect(doorName()).toContain(sentence(locale, kind));
    expect(screen.getByText(TITLE[locale])).toBeTruthy();
    expect(screen.getByText('ACME-61')).toBeTruthy();
    expect(container.textContent).not.toMatch(HOST_VOCABULARY);
  });

  it.each(KINDS)('a DECIDED %s record reads the same sentence and no host vocabulary', (kind) => {
    const { container } = render({ section: 'decided', row: decided(kind, locale) }, locale);

    expect(doorName()).toContain(sentence(locale, kind));
    expect(container.textContent).not.toMatch(HOST_VOCABULARY);
  });

  it('a kind this build does not render reads the NEUTRAL sentence, and still names the work item', () => {
    const { container } = render(
      {
        section: 'awaiting',
        row: awaiting('pull_request_merge', { kind: 'pull_request_merge' }, locale),
      },
      locale,
    );

    expect(doorName()).toContain(sentence(locale, 'other'));
    expect(
      screen.getByText((locale === 'en' ? en : zh).workbench.approvals.notBuiltYet),
    ).toBeTruthy();
    expect(container.textContent).not.toMatch(HOST_VOCABULARY);
  });

  it.each(KINDS)(
    'a %s row whose subject is GONE keeps its kind’s sentence and says Gone',
    (kind) => {
      const { container } = render(
        { section: 'awaiting', row: awaiting(kind, null, locale) },
        locale,
      );

      expect(doorName()).toContain(sentence(locale, kind));
      expect(
        screen.getByText((locale === 'en' ? en : zh).workbench.approvals.subjectGonePill),
      ).toBeTruthy();
      expect(container.textContent).not.toMatch(HOST_VOCABULARY);
    },
  );
});

describe('the approve-to-merge details carry the numbers in the TITLE, never the text', () => {
  it('lists every member as `owner/name · #n` in the cell’s title', () => {
    render(
      {
        section: 'awaiting',
        row: awaiting('pull_request_approval', SUBJECTS.pull_request_approval, 'en'),
      },
      'en',
    );

    const set = screen.getByText('In motir-core, motir-ai, +1 more');
    expect(set.getAttribute('title')).toBe(
      'moooon/motir-core · #412, moooon/motir-ai · #88, moooon/motir-gateway · #17',
    );
    // Lifted above the stretched row door, or the pointer never reaches the title.
    expect(set.className).toMatch(/\brelative\b.*\bz-10\b/);
  });

  it('a decision document that cannot be approved moves its pull request to the title', () => {
    render(
      { section: 'awaiting', row: awaiting('decision_approval', SUBJECTS.decision_approval, 'en') },
      'en',
    );

    const line = screen.getByText('No decision document');
    expect(line.getAttribute('title')).toBe('moooon/motir-core · #440');
    expect(line.className).toMatch(/\brelative\b.*\bz-10\b/);
  });
});

// A CARD-LESS row (Story MOTIR-6012 · MOTIR-6034; ADR `approval-gates.md` §11.1, §11.5b):
// a `plan_approval` gate names no card and opens no overlay. Its row is the PLAN row
// (MOTIR-6037; its own suite is `approval-row-plan.test.tsx`) — what is proved here is
// that it reads its own plain-words line rather than a card sentence, and never writes
// an approval-overlay address. A card-less row with no plan behind it draws nothing.
describe('a CARD-LESS (`plan_approval`) row', () => {
  it.each(['awaiting', 'decided'] as const)('a %s plan row reads the plan line', (section) => {
    const row = {
      // The REGISTERED plan summary (MOTIR-6035), drawn by MOTIR-6037's branch.
      ...awaiting(
        'plan_approval',
        {
          kind: 'plan_approval',
          planId: 'plan-1',
          sessionId: null,
          sessionHasTurns: false,
          title: 'A plan',
          projectName: 'Project',
          targets: [],
          proposalCount: 2,
          author: { source: 'mcp', harness: 'Claude Code', origin: 'user' },
          held: null,
          approving: false,
        },
        'en',
      ),
      workItem: null,
      ...(section === 'decided'
        ? { state: 'approved', decidedAt: new Date().toISOString(), refusalReason: null }
        : {}),
    };
    const { container } = render(
      section === 'decided'
        ? { section, row: row as unknown as ApprovalRecordDecidedRowDto }
        : { section, row: row as ApprovalQueueRowDto },
      'en',
    );
    expect(container.textContent).toContain('Plan —');
    expect(container.textContent).toContain('A plan');
    expect(screen.getAllByRole('link')[0]!.getAttribute('href')).toBe('/plans/plan-1');
    expect(container.innerHTML).not.toContain('approval=');
  });

  it('a card-less row whose subject is gone renders nothing', () => {
    const row = { ...awaiting('plan_approval', null, 'en'), workItem: null };
    const { container } = render({ section: 'awaiting', row: row as ApprovalQueueRowDto }, 'en');
    expect(container.textContent).toBe('');
  });
});
