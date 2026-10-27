// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import type { ApprovalGateDTO, ApprovalGateOverlayReadDTO } from '@/lib/dto/approvalGate';
import type { HomeTabCountsDto, HomeWorkItemRowDto } from '@/lib/dto/home';
import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import type { WorkbenchWindowDto } from '@/lib/dto/workbench';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { WorkbenchTab } from '@/lib/workbench/tab';
import { planReview, planReviewItem } from '../helpers/planReview';
import { fakeLiveSource, type FakeLiveSource } from './helpers/fakeLiveSource';

// THE STORY'S LIVE PATH, ASSEMBLED (Story MOTIR-8539 · Subtask MOTIR-8579).
//
// Each code card of the story tested its own surface against its own fake source.
// This file tests only what the ASSEMBLY can show: the Workbench, the open
// approval and a generating plan mounted together under ONE `LiveSignalProvider`
// backed by ONE fake source, driven by hand, and counted together —
//
//   1. one source drives every applier, each with its exact read count;
//   2. no refresh and no navigation under a 100-signal burst, reads bounded;
//   3. the strip's count and the list's rows agree after every applied answer;
//   4. an unchanged answer mutates no DOM and re-renders no row;
//   5. a changed answer re-renders only what changed;
//   6. the reader's place survives a burst, by node identity;
//   7. the subject-moved notice, applied apart from the port;
//   8. Approve brings the Workbench current through its one read.
//
// Every edge is real except the network: the window read is a stubbed `fetch`,
// the approval and plan reads are their typed clients, stubbed at the module edge.

// ── The things that must NEVER be called ─────────────────────────────────────
const never = vi.hoisted(() => ({
  refresh: vi.fn(),
  coordinated: vi.fn(),
  assign: vi.fn(),
  replace: vi.fn(),
  reload: vi.fn(),
}));

let params = new URLSearchParams();
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: never.refresh, push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));
vi.mock('@/lib/navigation/coordinatedRefresh', () => ({
  useCoordinatedRefresh: () => never.coordinated,
  CoordinatedRefreshProvider: ({ children }: { children: ReactNode }) => children,
}));

// ── The approval's edges ─────────────────────────────────────────────────────
const { fetchApprovalGateOverlay } = vi.hoisted(() => ({ fetchApprovalGateOverlay: vi.fn() }));
vi.mock('@/lib/approvals/approvalOverlayClient', () => ({ fetchApprovalGateOverlay }));
vi.mock('@/app/(authed)/items/[key]/approvalGateActions', () => ({
  decideApprovalGateAction: vi.fn(),
  approveAndMergeAction: vi.fn(),
  retryApproveAndMergeMemberAction: vi.fn(),
}));
vi.mock('@/lib/approvals/decidedGates', () => ({
  announceGateDecided: vi.fn(),
  useDecidedGate: () => null,
  // The press-in-flight mark (MOTIR-9696) has nothing to tell a list here.
  markGatePressPending: () => {},
  clearGatePressPending: () => {},
  useGatePressPending: () => false,
}));
vi.mock('@/app/(authed)/items/[key]/_components/DesignResultPanel', () => ({
  DesignResultPanel: ({ evidence }: { evidence: { id: string } | null }) => (
    <div data-testid="design-port" data-evidence={evidence?.id ?? ''}>
      <p data-testid="design-port-text">The row opens the overlay.</p>
    </div>
  ),
}));

// ── The plan's edges ─────────────────────────────────────────────────────────
const plan = vi.hoisted(() => ({
  fetchPlanReview: vi.fn(),
  approvePlanRequest: vi.fn(async () => ({})),
  fetchRepositorySet: vi.fn(async () => null),
}));
vi.mock('@/lib/planning/planReviewClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/planReviewClient')>()),
  fetchPlanReview: plan.fetchPlanReview,
  approvePlanRequest: plan.approvePlanRequest,
}));
vi.mock('@/lib/planning/repositorySetClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planning/repositorySetClient')>()),
  fetchRepositorySet: plan.fetchRepositorySet,
}));
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: () => <div data-testid="plan-review-canvas" />,
}));
vi.mock('@/components/planning/repositories/RepositorySetStep', () => ({
  RepositorySetStep: () => null,
}));

// ── A RENDER PROBE ───────────────────────────────────────────────────────────
// Every Workbench row and every plan proposal row draws exactly one
// `IssueTypeIcon`, and both rows are memoised. The probe gives each icon INSTANCE a
// stable number (a constant attribute, so it mutates nothing) and records it on
// every render, so a row's render count is the count of its probe's number.
const probe = vi.hoisted(() => ({ renders: [] as number[], next: 0 }));
vi.mock('@/components/issues/IssueTypeIcon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/issues/IssueTypeIcon')>();
  const { useState: useStateProbe } = await import('react');
  return {
    ...actual,
    IssueTypeIcon: () => {
      const [n] = useStateProbe(() => ++probe.next);
      probe.renders.push(n);
      return <i data-render-probe={n} />;
    },
  };
});

const { LiveSignalProvider } = await import('@/lib/live/liveSignal');
const { WorkbenchRereadProvider } = await import('@/lib/workbench/workbenchReread');
const { WorkbenchLiveView } =
  await import('../../app/(authed)/workbench/_components/WorkbenchLiveView');
const { toWorkbenchRowViews } =
  await import('../../app/(authed)/workbench/_components/workbenchRows');
const { WORKBENCH_WINDOW_PATH } = await import('@/lib/workbench/windowClient');
const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');
const { PlanDetail } = await import('@/components/planning/PlanDetail');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MEMBERS: WorkspaceMemberDTO[] = [
  {
    userId: 'u1',
    name: 'Zhu Yue',
    email: 'yue@example.com',
    workspaceRole: 'manager',
    customRole: null,
  },
];
const WORKFLOW = {
  statuses: [
    { key: 'todo', label: 'To Do', category: 'todo' },
    { key: 'in_progress', label: 'In Progress', category: 'in_progress' },
    { key: 'done', label: 'Done', category: 'done' },
  ],
} as unknown as WorkflowDto;

function row(
  identifier: string,
  title = `Card ${identifier}`,
  over: Partial<HomeWorkItemRowDto> = {},
): HomeWorkItemRowDto {
  return {
    id: `wi_${identifier}`,
    identifier,
    kind: 'task',
    type: null,
    key: Number(identifier.split('-')[1]),
    title,
    status: 'todo',
    ciState: null,
    priority: 'medium',
    assigneeId: 'u1',
    reporterId: 'u1',
    executor: null,
    storyPoints: null,
    estimateMinutes: null,
    updatedAt: '2026-10-14T00:00:00.000Z',
    completedAt: null,
    fixReason: null,
    fixDetail: null,
    project: { id: 'p1', identifier: 'MOTIR', name: 'Motir' },
    viewerIsAssignee: true,
    viewerIsReporter: true,
    canContinueHosted: false,
    fixGroupKind: null,
    fixMembers: [],
    resumeState: null,
    resumeRunId: null,
    resumeMembers: [],
    groupHead: null,
    groupMembers: [],
    canFixHosted: false,
    repairRun: null,
    ...over,
  };
}

function counts(over: Partial<HomeTabCountsDto> = {}): HomeTabCountsDto {
  return {
    myWork: 0,
    toDo: 0,
    inProgress: 0,
    toFix: 0,
    toResume: 0,
    recentlyFinished: 0,
    watching: 0,
    approvals: 0,
    planning: 0,
    ...over,
  };
}

function answer(
  items: HomeWorkItemRowDto[],
  strip: HomeTabCountsDto,
  tab: WorkbenchTab = 'todo',
): WorkbenchWindowDto {
  return {
    tab,
    window: {
      kind: 'workItems',
      page: { items, total: items.length, page: 1, pageSize: 25 },
      members: MEMBERS,
      workflow: WORKFLOW,
    },
    counts: strip,
    readAt: new Date().toISOString(),
  } as unknown as WorkbenchWindowDto;
}

const GATE: ApprovalGateDTO = {
  id: 'gate-1',
  workItemId: 'wi-g',
  kind: 'design_result',
  subjectId: 'ev-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: '9840d00ea1b2',
  decidedByLabel: null,
  routedToId: 'u1',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  confirmedRecord: null,
  refusalVerdict: null,
  offersRefusalVerdict: false,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-08T04:00:00.000Z',
  updatedAt: '2026-09-08T04:00:00.000Z',
};
const STAMP = 'v1.stamp-the-read-handed-over';

function gateRead(over: Partial<ApprovalGateOverlayReadDTO> = {}): ApprovalGateOverlayReadDTO {
  return {
    workItem: {
      id: 'wi-g',
      identifier: 'GATE-1',
      title: 'Draw the row',
      status: 'in_review',
      parentIdentifier: null,
    },
    statuses: [],
    gate: GATE,
    canDecide: true,
    canReplan: false,
    routedToLabel: 'Riley Reviewer',
    stamp: STAMP,
    movedSince: [],
    earlierApproval: null,
    subject: {
      state: 'resolved',
      kind: 'design_result',
      evidence: { id: 'ev-1' } as never,
      filesKept: false,
    },
    ...over,
  };
}

const A = planReviewItem({ planItemId: 'a', nodeId: 'a', title: 'Alpha proposal' });
const B = planReviewItem({ planItemId: 'b', nodeId: 'b', title: 'Bravo proposal' });
const C = planReviewItem({ planItemId: 'c', nodeId: 'c', title: 'Charlie proposal' });
const PLAN_ID = 'plan_1';
const PLAN_TOPIC = { kind: 'plan', planId: PLAN_ID } as const;
const WORKBENCH_TOPIC = { kind: 'workbench' } as const;

const generating = (items: PlanReviewItemDto[]): PlanReviewDto =>
  planReview(items, { id: PLAN_ID, status: 'generating', plannedAt: null });

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ── The network ──────────────────────────────────────────────────────────────

/** The window endpoint: each read waits until the test answers it; an abort rejects it. */
function windowFetch() {
  const urls: string[] = [];
  const pending: { resolve: (r: Response) => void; settled: boolean }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      return new Promise<Response>((resolve, reject) => {
        const entry = { resolve, settled: false };
        if (url.includes(WORKBENCH_WINDOW_PATH)) pending.push(entry);
        init?.signal?.addEventListener('abort', () => {
          entry.settled = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }),
  );
  return {
    reads: () => urls.filter((u) => u.includes(WORKBENCH_WINDOW_PATH)),
    others: () => urls.filter((u) => !u.includes(WORKBENCH_WINDOW_PATH)),
    /** Answer the OLDEST read still waiting (an aborted one included). */
    async release(body: WorkbenchWindowDto, index = 0) {
      await act(async () => {
        const [entry] = pending.splice(index, 1);
        entry?.resolve(Response.json(body));
      });
      await act(async () => {});
    },
    waiting: () => pending.length,
  };
}

/** The approval's reads: the LOAD answers at once, each PROBE waits for the test. */
function approvalReads(first: ApprovalGateOverlayReadDTO) {
  const probes: { args: unknown[]; answer: (r: ApprovalGateOverlayReadDTO) => Promise<void> }[] =
    [];
  fetchApprovalGateOverlay.mockImplementation((...args: unknown[]) => {
    if (args[3] === undefined) return Promise.resolve(first);
    return new Promise((resolve) => {
      probes.push({
        args,
        answer: async (r) => {
          await act(async () => resolve(r));
          await act(async () => {});
        },
      });
    });
  });
  return probes;
}

/** The plan's reads: each waits for the test, answered in order. */
function planReads() {
  const pending: ((r: PlanReviewDto) => void)[] = [];
  plan.fetchPlanReview.mockImplementation(
    () => new Promise<PlanReviewDto>((resolve) => pending.push(resolve)),
  );
  return {
    count: () => plan.fetchPlanReview.mock.calls.length,
    waiting: () => pending.length,
    async answer(r: PlanReviewDto) {
      await act(async () => pending.shift()?.(r));
      await act(async () => {});
    },
  };
}

// ── The assembly ─────────────────────────────────────────────────────────────

const START = [
  row('MOTIR-1', 'First card'),
  row('MOTIR-2', 'Second card'),
  row('MOTIR-3', 'Third card'),
];

function Workbench({
  tab = 'todo',
  items = START,
  strip = counts({ toDo: START.length }),
}: {
  tab?: WorkbenchTab;
  items?: HomeWorkItemRowDto[];
  strip?: HomeTabCountsDto;
}) {
  return (
    <WorkbenchLiveView
      tab={tab}
      page={1}
      rows={toWorkbenchRowViews(items, WORKFLOW, MEMBERS, false)}
      pagination={{ total: items.length, page: 1, pageSize: 25 }}
      planningSessions={[]}
      counts={strip}
      label="To do"
      empty={<p>Nothing to do</p>}
      viewerId="u1"
    />
  );
}

interface Shell {
  workbench?: ReactNode;
  overlay?: boolean;
  plan?: PlanReviewDto | null;
}

function mount(fake: FakeLiveSource, shell: Shell = {}) {
  const tree = (s: Shell) => (
    <LiveSignalProvider source={fake.source}>
      <WorkbenchRereadProvider>
        <section data-testid="workbench-surface">{s.workbench ?? <Workbench />}</section>
        {s.plan === null ? null : (
          <section data-testid="plan-surface">
            <PlanDetail initialReview={s.plan ?? generating([A, B, C])} projectKey="MOTIR" />
          </section>
        )}
        {s.overlay === false ? null : <ApprovalOverlay />}
      </WorkbenchRereadProvider>
    </LiveSignalProvider>
  );
  const utils = renderWithIntl(tree(shell), { locale: 'en', messages: en });
  return { ...utils, rerender: (s: Shell) => utils.rerender(tree(s)) };
}

function observe(target: Node) {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((r) => records.push(...r));
  observer.observe(target, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  return {
    records,
    stop: () => {
      records.push(...observer.takeRecords());
      observer.disconnect();
    },
  };
}

/** Renders of the row holding `el`, counted by its probe from index `since`. */
function rendersOf(el: Element, since: number): number {
  const n = Number(el.querySelector('[data-render-probe]')!.getAttribute('data-render-probe'));
  return probe.renders.slice(since).filter((x) => x === n).length;
}

const wbRow = (key: string) => screen.getByTestId(`workbench-row-${key}`);
const planRow = (title: string) => screen.getByText(title).closest('li')!;
const toDoCount = () =>
  Number(/\d+/.exec(screen.getByTestId('workbench-tab-todo').textContent ?? '')?.[0]);

/**
 * The strip and the list AGREE: the To do count is the answer's row count, and
 * every one of those rows is on screen. A row that LEFT may still be drawn — § 26
 * holds it in place until the next load, so it never vanishes under the reader —
 * which is why agreement is read against the answer's rows, not the DOM's total.
 */
function expectAgreement(keys: readonly string[], toDo: number) {
  expect(toDoCount()).toBe(toDo);
  expect(keys).toHaveLength(toDo);
  for (const key of keys) expect(screen.getByTestId(`workbench-row-${key}`)).toBeTruthy();
}

let constructedEventSources = 0;
let hrefAtStart = '';

beforeEach(() => {
  params = new URLSearchParams('tab=todo&view=list&approval=GATE-1&approvalKind=design_result');
  for (const fn of Object.values(never)) fn.mockReset();
  push.mockReset();
  fetchApprovalGateOverlay.mockReset();
  plan.fetchPlanReview.mockReset();
  plan.approvePlanRequest.mockClear();
  plan.fetchRepositorySet.mockClear();
  probe.renders.length = 0;
  constructedEventSources = 0;
  vi.stubGlobal(
    'EventSource',
    class {
      constructor() {
        constructedEventSources += 1;
      }
    },
  );
  vi.spyOn(window.location, 'assign').mockImplementation(never.assign);
  vi.spyOn(window.location, 'replace').mockImplementation(never.replace);
  vi.spyOn(window.location, 'reload').mockImplementation(never.reload);
  hrefAtStart = window.location.href;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectNothingNavigated() {
  for (const [name, fn] of Object.entries(never)) {
    expect(fn, `${name} was called on a live path`).not.toHaveBeenCalled();
  }
  expect(window.location.href).toBe(hrefAtStart);
  expect(constructedEventSources).toBe(0);
}

// ── 1 ────────────────────────────────────────────────────────────────────────

describe('1 · one fake source drives every applier (criterion 8)', () => {
  it('a workbench signal is one window read and one approval probe; a plan signal one review read', async () => {
    const net = windowFetch();
    const probes = approvalReads(gateRead());
    const reviews = planReads();
    const fake = fakeLiveSource();
    mount(fake);
    await act(async () => {});
    // Whatever the plan poll reads on mount is its own first look; count from here.
    const reviewsBefore = reviews.count();

    await fake.fire(WORKBENCH_TOPIC, ['toDo']);
    expect(net.reads()).toEqual([`${WORKBENCH_WINDOW_PATH}?tab=todo`]);
    expect(probes).toHaveLength(1);
    expect(probes[0]!.args[3]).toBe(STAMP);
    expect(reviews.count()).toBe(reviewsBefore);

    await fake.fire(PLAN_TOPIC);
    expect(reviews.count()).toBe(reviewsBefore + 1);
    expect(plan.fetchPlanReview.mock.calls.at(-1)![0]).toBe(PLAN_ID);
    expect(net.reads()).toHaveLength(1);
    expect(probes).toHaveLength(1);

    // Each applier subscribed through the provider, and no transport was built.
    expect(fake.listening(WORKBENCH_TOPIC)).toBeGreaterThanOrEqual(2);
    expect(fake.listening(PLAN_TOPIC)).toBe(1);
    expectNothingNavigated();
  });
});

// ── 2 ────────────────────────────────────────────────────────────────────────

describe('2 · no refresh anywhere, and the reads stay bounded (criterion 1)', () => {
  it('100 interleaved signals call no refresh, no coordinator and no navigation', async () => {
    const net = windowFetch();
    const probes = approvalReads(gateRead());
    const reviews = planReads();
    const fake = fakeLiveSource();
    mount(fake);
    await act(async () => {});
    const reviewsBefore = reviews.count();

    await act(async () => {
      for (let i = 0; i < 50; i += 1) {
        fake.fireSync(WORKBENCH_TOPIC, ['toDo']);
        fake.fireSync(PLAN_TOPIC);
      }
    });
    // ONE read in flight per surface, whatever the burst.
    expect(net.reads()).toHaveLength(1);
    expect(probes).toHaveLength(1);
    expect(reviews.count() - reviewsBefore).toBe(1);

    // With each read held, ten more signals add NOTHING now and ONE read after it.
    await act(async () => {
      for (let i = 0; i < 10; i += 1) {
        fake.fireSync(WORKBENCH_TOPIC, ['toDo']);
        fake.fireSync(PLAN_TOPIC);
      }
    });
    expect(net.reads()).toHaveLength(1);
    expect(probes).toHaveLength(1);

    await net.release(answer(START, counts({ toDo: 3 })));
    await probes[0]!.answer(gateRead());
    await reviews.answer(copy(generating([A, B, C])));
    // Every surface owes ONE read for the burst behind it. The plan's poll used to
    // skip a signal behind a read (MOTIR-8102), which was right for a timer tick; a
    // pushed signal carries no `cadence` mark, so it is a change that must not be
    // lost, and collapses into one follow-up (Story MOTIR-8542 · MOTIR-8732).
    expect(net.reads()).toHaveLength(2);
    expect(probes).toHaveLength(2);
    expect(reviews.count() - reviewsBefore).toBe(2);
    // A signal while the follow-up is out adds nothing now, and one read after it.
    await fake.fire(PLAN_TOPIC);
    expect(reviews.count() - reviewsBefore).toBe(2);
    await reviews.answer(copy(generating([A, B, C])));
    expect(reviews.count() - reviewsBefore).toBe(3);
    expectNothingNavigated();
  });
});

// ── 3 ────────────────────────────────────────────────────────────────────────

describe('3 · the strip and the list agree after every applied answer (criterion 2)', () => {
  it('ten answers moving rows between tabs, a stale one and a wrong-tab one', async () => {
    const net = windowFetch();
    approvalReads(gateRead());
    planReads();
    const fake = fakeLiveSource();
    mount(fake, { overlay: false, plan: null });
    expectAgreement(['MOTIR-1', 'MOTIR-2', 'MOTIR-3'], 3);

    // Each step is the To do set and the strip the endpoint answers with.
    const steps: [string[], Partial<HomeTabCountsDto>][] = [
      [['MOTIR-1', 'MOTIR-2', 'MOTIR-3', 'MOTIR-4'], { toDo: 4 }],
      [['MOTIR-2', 'MOTIR-3', 'MOTIR-4'], { toDo: 3, inProgress: 1 }],
      [['MOTIR-2', 'MOTIR-3', 'MOTIR-4', 'MOTIR-5'], { toDo: 4, inProgress: 1 }],
      [['MOTIR-3', 'MOTIR-4', 'MOTIR-5'], { toDo: 3, inProgress: 2 }],
      [['MOTIR-3', 'MOTIR-4', 'MOTIR-5', 'MOTIR-6', 'MOTIR-7'], { toDo: 5, inProgress: 2 }],
      [['MOTIR-4', 'MOTIR-5', 'MOTIR-6', 'MOTIR-7'], { toDo: 4, inProgress: 3 }],
      [['MOTIR-4', 'MOTIR-5', 'MOTIR-6', 'MOTIR-7'], { toDo: 4, inProgress: 3 }],
      [['MOTIR-5', 'MOTIR-6', 'MOTIR-7', 'MOTIR-8'], { toDo: 4, inProgress: 4 }],
      [['MOTIR-5', 'MOTIR-8'], { toDo: 2, inProgress: 6 }],
      [['MOTIR-5', 'MOTIR-8', 'MOTIR-9'], { toDo: 3, inProgress: 6 }],
    ];
    for (const [keys, strip] of steps) {
      await fake.fire(WORKBENCH_TOPIC, ['toDo', 'inProgress']);
      await net.release(
        answer(
          keys.map((k) => row(k)),
          counts(strip),
        ),
      );
      // Read in the same act the answer landed in.
      expectAgreement(keys, strip.toDo!);
    }

    // An answer naming ANOTHER tab is dropped, and the pair stands.
    await fake.fire(WORKBENCH_TOPIC);
    await net.release(answer([row('MOTIR-40')], counts({ toDo: 9 }), 'watching'));
    expectAgreement(['MOTIR-5', 'MOTIR-8', 'MOTIR-9'], 3);
    expect(screen.queryByTestId('workbench-row-MOTIR-40')).toBeNull();
  });

  it('a read that lands after the reader left and came back is dropped, out of order', async () => {
    const net = windowFetch();
    const fake = fakeLiveSource();
    const view = mount(fake, { overlay: false, plan: null });

    await fake.fire(WORKBENCH_TOPIC);
    // The reader leaves To do and returns; the first read was issued for a view now gone.
    view.rerender({
      overlay: false,
      plan: null,
      workbench: <Workbench tab="in-progress" items={[]} />,
    });
    view.rerender({ overlay: false, plan: null, workbench: <Workbench /> });
    await fake.fire(WORKBENCH_TOPIC);
    expect(net.reads()).toHaveLength(2);

    // The NEWER read lands first, then the older one.
    await net.release(answer([row('MOTIR-1'), row('MOTIR-2')], counts({ toDo: 2 })), 1);
    expectAgreement(['MOTIR-1', 'MOTIR-2'], 2);
    await net.release(
      answer(
        [row('MOTIR-30'), row('MOTIR-31'), row('MOTIR-32'), row('MOTIR-33')],
        counts({ toDo: 4 }),
      ),
      0,
    );
    expect(screen.queryByTestId('workbench-row-MOTIR-30')).toBeNull();
    expectAgreement(['MOTIR-1', 'MOTIR-2'], 2);
  });
});

// ── 4 ────────────────────────────────────────────────────────────────────────

describe('4 · an unchanged answer changes nothing (criterion 3)', () => {
  it('identical window, plan and probe answers: zero mutations, zero row renders', async () => {
    const net = windowFetch();
    const probes = approvalReads(gateRead());
    const reviews = planReads();
    const fake = fakeLiveSource();
    mount(fake);
    await act(async () => {});
    // Let the plan poll's own first look settle before counting.
    while (reviews.waiting() > 0) await reviews.answer(copy(generating([A, B, C])));

    const list = screen.getByTestId('workbench-surface');
    const tree = await screen.findByTestId('plan-proposal-list');
    const dialog = screen.getByRole('dialog');
    const seen = [observe(list), observe(tree), observe(dialog)];
    const since = probe.renders.length;
    const rows = [
      wbRow('MOTIR-1'),
      wbRow('MOTIR-2'),
      planRow('Alpha proposal'),
      planRow('Bravo proposal'),
    ];

    await fake.fire(WORKBENCH_TOPIC, ['toDo']);
    await net.release(answer(copy(START), counts({ toDo: 3 })));
    await probes[0]!.answer(gateRead());
    await fake.fire(PLAN_TOPIC);
    await reviews.answer(copy(generating([A, B, C])));

    for (const s of seen) s.stop();
    for (const s of seen) expect(s.records).toHaveLength(0);
    for (const r of rows) expect(rendersOf(r, since)).toBe(0);
    expectNothingNavigated();
  });
});

// ── 5 ────────────────────────────────────────────────────────────────────────

describe('5 · only what changed re-renders (criterion 3)', () => {
  it('one changed window row renders once; its siblings not at all', async () => {
    const net = windowFetch();
    approvalReads(gateRead());
    planReads();
    const fake = fakeLiveSource();
    mount(fake, { overlay: false, plan: null });
    const [first, second, third] = [wbRow('MOTIR-1'), wbRow('MOTIR-2'), wbRow('MOTIR-3')];
    const since = probe.renders.length;

    await fake.fire(WORKBENCH_TOPIC, ['toDo']);
    await net.release(
      answer([START[0]!, row('MOTIR-2', 'Second card, renamed'), START[2]!], counts({ toDo: 3 })),
    );

    expect(screen.getByText('Second card, renamed')).toBeTruthy();
    expect(rendersOf(second, since)).toBe(1);
    expect(rendersOf(first, since)).toBe(0);
    expect(rendersOf(third, since)).toBe(0);
    expect(wbRow('MOTIR-1')).toBe(first);
  });

  it('one changed proposal renders once; a withdrawn one leaves, and only a NEW one arrives', async () => {
    windowFetch();
    approvalReads(gateRead());
    const reviews = planReads();
    const fake = fakeLiveSource();
    mount(fake, { overlay: false });
    await act(async () => {});
    while (reviews.waiting() > 0) await reviews.answer(copy(generating([A, B, C])));
    const [alpha, bravo, charlie] = [
      planRow('Alpha proposal'),
      planRow('Bravo proposal'),
      planRow('Charlie proposal'),
    ];
    let since = probe.renders.length;

    await fake.fire(PLAN_TOPIC);
    await reviews.answer(generating([copy(A), { ...copy(B), title: 'Bravo, renamed' }, copy(C)]));
    expect(screen.getByText('Bravo, renamed')).toBeTruthy();
    expect(rendersOf(bravo, since)).toBe(1);
    expect(rendersOf(alpha, since)).toBe(0);
    expect(rendersOf(charlie, since)).toBe(0);

    // C is withdrawn and D arrives: C leaves, D renders once, A is not touched. (The
    // plan page draws no entrance motion — `PlanProposalList`'s `live` is the
    // planning workspace's; this list is the page's, so `data-motion` stays unset.)
    since = probe.renders.length;
    const D = planReviewItem({ planItemId: 'd', nodeId: 'd', title: 'Delta proposal' });
    await fake.fire(PLAN_TOPIC);
    await reviews.answer(generating([copy(A), { ...copy(B), title: 'Bravo, renamed' }, D]));
    expect(screen.queryByText('Charlie proposal')).toBeNull();
    expect(rendersOf(planRow('Delta proposal'), since)).toBe(1);
    expect(planRow('Alpha proposal')).toBe(alpha);
    expect(rendersOf(alpha, since)).toBe(0);
    expect(alpha.dataset['motion']).toBeUndefined();
  });
});

// ── 6 ────────────────────────────────────────────────────────────────────────

describe('6 · the reader keeps their place through a burst (criterion 4)', () => {
  it('the Workbench: scroll, a focused row and an open members disclosure', async () => {
    const net = windowFetch();
    const fake = fakeLiveSource();
    const fixDetail = {
      groupKey: null,
      repair: 'fix',
      check: 'lint',
      queueReason: null,
      base: null,
      reviewerName: null,
      notePreview: null,
      gate: null,
      lastHeardAt: null,
      ranByName: null,
      branch: null,
      branches: null,
      pushed: null,
      continueKey: null,
      diedReason: null,
      affected: 1,
      total: 1,
    } as HomeWorkItemRowDto['fixDetail'];
    const stuck = (k: string, over: Partial<HomeWorkItemRowDto> = {}) =>
      row(k, `Title of ${k}`, {
        status: 'implemented',
        fixReason: 'ci_failed',
        fixDetail,
        ...over,
      });
    const entry = stuck('S-1', {
      kind: 'story',
      fixGroupKind: 'run',
      fixMembers: ['S-2', 'S-3', 'S-4', 'S-5', 'S-6'].map((k) => stuck(k)),
    });
    const fixRows = [entry, stuck('S-7')];
    const strip = counts({ toFix: 2 });
    params = new URLSearchParams('tab=to-fix');
    mount(fake, {
      overlay: false,
      plan: null,
      workbench: <Workbench tab="to-fix" items={fixRows} strip={strip} />,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more work items' }));
    const members = screen.getByTestId('workbench-fix-members-S-1');
    expect(members.querySelectorAll('li')).toHaveLength(5);
    const scroller = screen.getByTestId('workbench-surface');
    scroller.scrollTop = 240;
    const link = wbRow('S-7').querySelector('a')!;
    link.focus();
    const nodes = [wbRow('S-1'), wbRow('S-7'), members];

    for (let i = 0; i < 5; i += 1) {
      await fake.fire(WORKBENCH_TOPIC, ['toFix']);
      await net.release(answer(copy(fixRows), strip, 'to-fix'));
    }

    expect(screen.getByTestId('workbench-fix-members-S-1').querySelectorAll('li')).toHaveLength(5);
    // The same DOM nodes, not equal ones: nothing was remounted under the reader.
    const after = [wbRow('S-1'), wbRow('S-7'), screen.getByTestId('workbench-fix-members-S-1')];
    for (const [i, n] of nodes.entries()) expect(after[i]).toBe(n);
    expect(document.activeElement).toBe(link);
    expect(scroller.scrollTop).toBe(240);
    expectNothingNavigated();
  });

  it('the plan and the approval: an open proposal row, the port scroll, a selection and a half-typed reason', async () => {
    const net = windowFetch();
    const probes = approvalReads(gateRead());
    const reviews = planReads();
    const fake = fakeLiveSource();
    mount(fake);
    await act(async () => {});
    while (reviews.waiting() > 0) await reviews.answer(copy(generating([A, B, C])));

    const alpha = planRow('Alpha proposal');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));
    });
    const reason = screen.getByLabelText(en.approvalGate.reason.label) as HTMLTextAreaElement;
    fireEvent.change(reason, { target: { value: 'The empty state needs' } });
    reason.focus();
    reason.setSelectionRange(4, 9);
    const port = screen.getByTestId('design-port');
    const portScroller = port.parentElement!;
    portScroller.scrollTop = 120;
    const text = screen.getByTestId('design-port-text').firstChild!;

    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        fake.fireSync(WORKBENCH_TOPIC, ['toDo']);
        fake.fireSync(PLAN_TOPIC);
      });
      await net.release(answer(copy(START), counts({ toDo: 3 })));
      await probes.at(-1)!.answer(gateRead());
      await reviews.answer(copy(generating([A, B, C])));
    }

    expect(planRow('Alpha proposal')).toBe(alpha);
    expect(screen.getByTestId('design-port')).toBe(port);
    expect(screen.getByTestId('design-port-text').firstChild).toBe(text);
    expect(portScroller.scrollTop).toBe(120);
    expect(screen.getByLabelText(en.approvalGate.reason.label)).toBe(reason);
    expect(reason.value).toBe('The empty state needs');
    expect(document.activeElement).toBe(reason);
    expect([reason.selectionStart, reason.selectionEnd]).toEqual([4, 9]);
    expectNothingNavigated();
  });
});

// ── 7 ────────────────────────────────────────────────────────────────────────

describe('7 · the subject-moved notice, applied apart from the port (criterion 6)', () => {
  it('names what moved, updates in place, leaves the port untouched and Approve live', async () => {
    const net = windowFetch();
    const probes = approvalReads(gateRead());
    planReads();
    const fake = fakeLiveSource();
    mount(fake, { plan: null });
    await act(async () => {});
    const port = screen.getByTestId('design-port');
    const seen = observe(port);

    await fake.fire(WORKBENCH_TOPIC);
    await probes[0]!.answer(gateRead({ movedSince: ['subject'] }));
    await net.release(answer(copy(START), counts({ toDo: 3 })));
    expect(screen.getAllByTestId('approval-subject-moved')).toHaveLength(1);

    await fake.fire(WORKBENCH_TOPIC);
    await probes[1]!.answer(gateRead({ movedSince: ['subject', 'criteria'] }));
    expect(screen.getAllByTestId('approval-subject-moved')).toHaveLength(1);
    seen.stop();

    expect(seen.records).toHaveLength(0);
    expect(screen.getByTestId('design-port')).toBe(port);
    const approve = screen.getByRole('button', {
      name: en.approvalGate.verb.approve,
    }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    expectNothingNavigated();
  });
});

// ── 8 ────────────────────────────────────────────────────────────────────────

describe('8 · Approve lands in place (criterion 5)', () => {
  it('the approve collapses into the Workbench read already out, and the decided plan stays', async () => {
    const net = windowFetch();
    const reviews = planReads();
    const fake = fakeLiveSource();
    const planned = planReview([A, B], { id: PLAN_ID, status: 'planned' });
    mount(fake, { overlay: false, plan: planned });
    await act(async () => {});

    // A nudge's read is out, and a second nudge is already pending behind it.
    await fake.fire(WORKBENCH_TOPIC, ['toDo']);
    await fake.fire(WORKBENCH_TOPIC, ['toDo']);
    expect(net.reads()).toHaveLength(1);

    const approve = screen
      .getAllByRole('button', { name: /^Approve/ })
      .find((b) => b.closest('[data-testid="plan-surface"]'))!;
    await act(async () => {
      fireEvent.click(approve);
    });
    await waitFor(() => expect(plan.approvePlanRequest).toHaveBeenCalledWith(PLAN_ID, null));
    await reviews.answer(
      planReview([A, B], { id: PLAN_ID, status: 'approved', decidedByName: 'Yue' }),
    );

    // Nothing extra: the approve's request joined the pending read.
    expect(net.reads()).toHaveLength(1);
    await net.release(answer([row('MOTIR-11', 'From the plan'), ...START], counts({ toDo: 4 })));
    expect(net.reads()).toHaveLength(2);
    await net.release(answer([row('MOTIR-11', 'From the plan'), ...START], counts({ toDo: 4 })));
    expect(net.reads()).toHaveLength(2);

    expect(screen.getByText('From the plan')).toBeTruthy();
    expect(toDoCount()).toBe(4);
    expect(screen.getByText('Alpha proposal')).toBeTruthy();
    expectNothingNavigated();
  });
});
