// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import messages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { recordDto } from '../helpers/howToTestFixtures';

// GUIDE ME THROUGH ON THE ITEM PAGE (Story MOTIR-7459 · MOTIR-7467; design
// `design/runs/run-section--guide-door.mock.html`). The page's REAL
// `LateUpperSections` over a fixture read: a manual card's slot carries the guide
// door (or nothing), a code card's carries its Run section exactly as before, and
// the two never both show. The door itself is rendered on its own below.

const push = vi.fn();
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({
    refresh: vi.fn(),
    push,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => '/items/ACME-12',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages, namespace: namespace as never }),
}));
vi.mock('@/app/(authed)/items/[key]/_components/lateReads', () => ({ RUN_HISTORY_PAGE: 20 }));
vi.mock('@/app/(authed)/items/[key]/_components/runTimes', () => ({ formatRunTimes: () => ({}) }));
vi.mock('@/app/(authed)/items/[key]/_components/RunSection', () => ({
  // A marker, so a test can see whether the Run section's body rendered.
  RunSection: () => <div data-testid="run-section-body" />,
}));
vi.mock('@/app/(authed)/items/[key]/_components/DevelopmentLinkControl', () => ({
  DevelopmentLinkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LinkPullRequestDoor: () => null,
  LinkPullRequestForm: () => null,
  RemovePullRequestLinkButton: () => null,
}));

import { LateUpperSections } from '@/app/(authed)/items/[key]/_components/LateSections';
import { GuideMeThroughSection } from '@/app/(authed)/items/[key]/_components/GuideMeThroughSection';
import type { LateReads } from '@/app/(authed)/items/[key]/_components/lateReads';

afterEach(() => {
  cleanup();
  push.mockReset();
});

const g = messages.runs.guide;

const NO_GATE = {
  gate: null,
  canDecide: false,
  routedToLabel: null,
  earlierApproval: null,
  settingsDoor: null,
  stamp: null,
  movedSince: [],
};

function reads(): LateReads {
  return {
    pullRequests: [],
    commentCaps: {} as LateReads['commentCaps'],
    attachmentCaps: {} as LateReads['attachmentCaps'],
    initialComments: null,
    initialHistory: null,
    initialAll: null,
    initialAttachments: null,
    acceptanceEligibility: null,
    acceptanceEvidence: null,
    showAcceptance: false,
    acceptanceGate: NO_GATE,
    projectId: 'proj-acme',
    designEvidence: null,
    isDesignCard: false,
    designGate: { ...NO_GATE, subject: null },
    runs: [],
    scopeRun: null,
    howToTest: recordDto(),
    mergeGate: { ...NO_GATE, members: [], autoQueueExits: [] },
    repair: null,
    monitorIssueLinks: [],
    monitorHasConnection: false,
    continueView: { state: 'none' },
    decisionGate: { ...NO_GATE, document: null },
    choiceGate: { ...NO_GATE, body: null, workItemRefs: {} },
    confirmGate: { ...NO_GATE, body: null, workItemRefs: {} },
    agentReview: null,
    gatedRun: null,
  } as LateReads;
}

async function renderStack(
  manual: React.ComponentProps<typeof LateUpperSections>['manual'],
): Promise<void> {
  const ui = await LateUpperSections({
    reads: Promise.resolve(reads()),
    itemId: 'wi-acme-12',
    itemIdentifier: 'ACME-12',
    currentUserId: 'u-viewer',
    canEdit: true,
    repoDelivery: [],
    deliveries: [],
    manual,
  });
  render(ui);
}

const headings = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);

describe('the Run slot on the item page (MOTIR-7467)', () => {
  it('a CODE card renders its Run section exactly as before, and no guide door', async () => {
    await renderStack(null);
    expect(headings()).toContain(messages.runs.title);
    expect(screen.getByTestId('run-section-body')).toBeTruthy();
    expect(screen.queryByTestId('guide-door-section')).toBeNull();
  });

  it('a MANUAL card with the door shown draws Guide in the slot, and no Run section', async () => {
    await renderStack({ door: { progress: { done: 2, total: 4, next: 3 } } });
    expect(headings()).toContain(g.title);
    expect(headings()).not.toContain(messages.runs.title);
    expect(screen.queryByTestId('run-section-body')).toBeNull();
    expect(screen.getByTestId('guide-door')).toBeTruthy();
    // The guide leads the stack, directly above Development.
    const order = headings();
    expect(order.indexOf(g.title)).toBeLessThan(order.indexOf(messages.github.development.title));
  });

  it('a MANUAL card where the door is not shown leaves the slot EMPTY', async () => {
    await renderStack({ door: null });
    expect(headings()).not.toContain(g.title);
    expect(headings()).not.toContain(messages.runs.title);
    expect(screen.queryByTestId('run-section-body')).toBeNull();
    expect(screen.queryByTestId('guide-door')).toBeNull();
    expect(headings()).toContain(messages.github.development.title);
  });
});

describe('GuideMeThroughSection', () => {
  it('names the progress and where the walk picks up, with its bar', () => {
    render(<GuideMeThroughSection itemKey="ACME-12" progress={{ done: 2, total: 4, next: 3 }} />);
    expect(screen.getByText(g.lead)).toBeTruthy();
    const progress = screen.getByTestId('guide-door-progress');
    expect(progress.textContent).toContain('2 of 4 steps done · picks up at step 3');
    expect(screen.getByRole('img', { name: '2 of 4 steps done' })).toBeTruthy();
  });

  it('reads all done when every row is ticked', () => {
    render(
      <GuideMeThroughSection itemKey="ACME-12" progress={{ done: 4, total: 4, next: null }} />,
    );
    expect(screen.getByTestId('guide-door-progress').textContent).toContain('4 of 4 steps done');
    expect(screen.getByTestId('guide-door-progress').textContent).not.toContain('picks up');
  });

  it('draws no progress at all on a card with no rows, and says Motir AI will propose them', () => {
    render(<GuideMeThroughSection itemKey="ACME-12" progress={null} />);
    expect(screen.queryByTestId('guide-door-progress')).toBeNull();
    expect(screen.getByText(g.leadNoList)).toBeTruthy();
  });

  it('opens the overlay at the guide address', () => {
    render(<GuideMeThroughSection itemKey="ACME-12" progress={null} />);
    const door = screen.getByRole('button', { name: g.door });
    const href = door.getAttribute('data-href') ?? '';
    const params = new URLSearchParams(href.split('?')[1] ?? '');
    expect(params.get('plan')).toBe('guide');
    expect(params.get('planItem')).toBe('ACME-12');
    fireEvent.click(door);
  });

  it('carries every string in both locales', () => {
    expect(Object.keys(zhMessages.runs.guide).sort()).toEqual(Object.keys(g).sort());
  });
});
