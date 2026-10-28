// @vitest-environment happy-dom
import type { ReaderTranslationDTO } from '@/lib/dto/workItemTranslation';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// MOTIR-3435 — `/items/[key]`'s GATE and its read SHAPE.
//
// The pending-frame half of this file went with the frame: MOTIR-3492 removed
// `app/(authed)/items/[key]/loading.tsx` after establishing by A/B that a
// `loading.tsx` flushes a 200 response head before the page runs, which
// destroys this route's cross-workspace `notFound()` 404 — a documented
// no-existence-leak contract. The read-shape assertions below are unaffected
// and are what the story's measured win actually rests on.
//
// The page went from 29 awaits, almost all sequential, to a gate of four plus
// one concurrent group. What is asserted here is the pair of properties that
// restructuring can break silently, and that a green diff looks fine under:
//
//   1. THE GATE IS STILL IN FRONT OF EVERYTHING. `getSession` → `getActiveProject`
//      → `getIssueDetail` → `getPermissions`, in that order, with NO other read
//      started until all four have settled. This page is where the product's
//      access rules are enforced — a missing item, a browse-denied item and an
//      item under a retired project key all resolve BEFORE anything renders — so
//      a read that starts early is how a hidden item becomes visible for a
//      frame. Nothing type-checks differently if one moves.
//
//   2. THE GROUP IS ACTUALLY CONCURRENT, and its conditional members are STILL
//      conditional. Skipping a query is cheaper than parallelising it, so
//      `acceptance*` must not run for a non-story and `rollupForParent` must not
//      run for a leaf — a restructure that "simplifies" a ternary away would
//      make every leaf page pay a recursive-CTE aggregate.
//
// Everything the page imports is mocked at module level, so `lib/db` and the
// service tree never load. The page is an async Server Component — a function
// returning JSX — so it is CALLED, not rendered.

const started: string[] = [];

// ── THE GATES: ONE PER TIER, REBUILT PER CASE (MOTIR-4919) ──────────────────
//
// A promise resolves ONCE. This file used to hold a single module-level gate
// released by `afterEach`, so the FIRST case's teardown resolved it for the
// whole file and from the second case onward `deferred` was `immediate`. Every
// assertion below that reads "in flight while NONE has resolved" was then
// measuring whether the microtask queue drains before a `setTimeout(0)` — which
// it always does, for a `Promise.all` and for a serial chain alike. The
// concurrency assertion could not fail. So the gates are rebuilt in
// `beforeEach`, and each case gets its own unresolved pair.
//
// TWO gates, not one, because the page has two tiers and the late-stack cases
// need them apart. `app/(authed)/items/[key]/page.tsx` STARTS the late reads
// (`readLateSections`, :190) and then AWAITS the tier-two `Promise.all` (:226)
// before it returns. So "the page resolves while the late reads are still
// pending" is only expressible when tier two can settle while late does not —
// with one shared gate, holding the late reads also holds tier two, and the
// page correctly never returns. That is not a defect in the page; it is the
// tier boundary the page is built around, and a single gate cannot straddle it.
let releaseTierTwo: (() => void) | null = null;
let releaseLate: (() => void) | null = null;
let tierTwoGate: Promise<void> = Promise.resolve();
let lateGate: Promise<void> = Promise.resolve();
/** Lets BOTH tiers go — the default teardown, and what a case wants when it is
 *  not asserting anything about the boundary between them. */
const releaseAll = () => {
  releaseTierTwo?.();
  releaseLate?.();
};
/**
 * Resolves only when the test lets THIS READ'S TIER go, and records that it
 * STARTED. The tier is required rather than defaulted: which tier a read sits
 * in is the property this file exists to assert, so it is stated at every mock
 * rather than inherited.
 */
const deferred = <T,>(name: string, value: T, tier: 'tierTwo' | 'late') =>
  vi.fn(async () => {
    started.push(name);
    await (tier === 'tierTwo' ? tierTwoGate : lateGate);
    return value;
  });
/** Resolves immediately; still records the start. */
const immediate = <T,>(name: string, value: T) =>
  vi.fn(async () => {
    started.push(name);
    return value;
  });

const redirected = vi.fn((_to: string) => {
  throw new Error('NEXT_REDIRECT');
});
const notFoundFn = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
const permanentRedirected = vi.fn((_to: string) => {
  throw new Error('NEXT_PERMANENT_REDIRECT');
});

const getSession = vi.fn();
const getActiveProject = vi.fn();
const getIssueDetail = vi.fn();
const getPermissions = vi.fn();
const resolveAliasedIssueKey = vi.fn(async () => null as string | null);

const rollupForParent = deferred('rollup', null, 'tierTwo');
const acceptanceResolve = deferred('acceptanceEligibility', null, 'late');
const acceptanceEvidence = deferred('acceptanceEvidence', null, 'late');

vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirected(to),
  notFound: () => notFoundFn(),
  permanentRedirect: (to: string) => permanentRedirected(to),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: immediate('t', (k: string) => k),
  getLocale: immediate('locale', 'en'),
}));
vi.mock('@/lib/auth', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/projects', () => ({ getActiveProject: () => getActiveProject() }));
vi.mock('@/lib/issues/aliasRedirect', () => ({
  resolveAliasedIssueKey: () => resolveAliasedIssueKey(),
}));
vi.mock('@/lib/services/workItemsService', () => ({
  workItemsService: {
    getIssueDetail: () => getIssueDetail(),
    listLinkedPullRequests: deferred('pullRequests', [], 'late'),
    // ONE call since MOTIR-3660 — `getDeliveryView` returns the repository set
    // already amended by the delivery set, plus the set itself, so the rail and
    // the Development section take their two halves from a single read. That is
    // exactly what this file guards (tier two, read ONCE, not once per tier);
    // what changed is the name of the call, not the property.
    getDeliveryView: deferred('deliveryView', { repos: [], deliveries: [] }, 'tierTwo'),
    resolveReferenceSummaries: deferred('workItemRefs', [], 'tierTwo'),
  },
}));
// The moves an approval HOLDS (MOTIR-5528) — a tier-two member: the held message
// sits under the rail's status value. PARTIAL, because the late reads still reach
// the rest of the service.
vi.mock('@/lib/services/approvalGatesService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/approvalGatesService')>();
  return {
    approvalGatesService: {
      ...actual.approvalGatesService,
      listHeldTransitions: deferred('heldTransitions', [], 'tierTwo'),
      // The header's decision-waiting marker (MOTIR-5878) — a TIER-TWO read, so the
      // header never waits on the late stack. Mocked, not spread from the real
      // service: the real one would open a database transaction here.
      pendingDecisionsFor: deferred('pendingDecisions', new Map(), 'tierTwo'),
    },
  };
});
// The PLAN HOLD (MOTIR-6267) — a tier-two member beside the held moves, for the
// same reason: the status card draws it under its value. Mocked: the real read
// opens a database transaction.
vi.mock('@/lib/services/planTargetLockService', () => ({
  planTargetLockService: { readPlanHold: deferred('planHold', null, 'tierTwo') },
}));
// THE LATE STACK IS DRAINED TOO (MOTIR-6278). The page STARTS `readLateSections`
// and hands the promise to two `<Suspense>` boundaries — which never render
// here, because the page is called, not rendered. So nothing awaited it, and the
// reads inside it that this file does NOT mock (the decision, choice and
// confirmation gate bodies, run history, …) kept running on the real database
// after their case ended: seven `idle in transaction` backends were still open
// when the suite-wide in-flight check looked. Recording the promise in
// `inFlight` puts it under the same `afterEach` drain as the page invocation.
vi.mock('@/app/(authed)/items/[key]/_components/lateReads', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/app/(authed)/items/[key]/_components/lateReads')>();
  return {
    ...actual,
    readLateSections: (input: Parameters<typeof actual.readLateSections>[0]) => {
      const reads = actual.readLateSections(input);
      inFlight.push(reads);
      void reads.catch(() => undefined);
      return reads;
    },
  };
});
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: {
    getPermissions: () => getPermissions(),
    getCommentCapabilities: deferred('commentCaps', {}, 'late'),
    getAttachmentCapabilities: deferred('attachmentCaps', {}, 'late'),
  },
}));
vi.mock('@/lib/services/assignableMembersService', () => ({
  assignableMembersService: { list: deferred('members', [], 'tierTwo') },
}));
vi.mock('@/lib/services/sprintsService', () => ({
  sprintsService: { listByProject: deferred('sprints', [], 'tierTwo') },
}));
// The PENDING-PLAN read (MOTIR-4197): tier two, in the group, CONDITIONAL on
// `plan:view_any` (MOTIR-6328; `ai:view_plan` until then) — the one member whose condition is a PERMISSION rather than
// the item's shape, so both arms are asserted below.
const pendingPlans = deferred('pendingPlans', [], 'tierTwo');
// The PLAN HISTORY read (MOTIR-5547 · design MOTIR-5545 § Plan history 1): tier
// two, the same group and the same `plan:view_any` condition as the pending read.
const planHistory = deferred('planHistory', { items: [], nextCursor: null }, 'tierTwo');
vi.mock('@/lib/services/plansService', () => ({
  plansService: {
    listPendingProposalsForWorkItem: () => pendingPlans(),
    listPlanHistoryForWorkItem: () => planHistory(),
  },
}));
vi.mock('@/lib/services/workItemTodosService', () => ({
  workItemTodosService: {
    listTodos: deferred('todoList', { items: [], progress: { done: 0, total: 0 } }, 'tierTwo'),
    // The notes' card links (bug MOTIR-10023), resolved off the list read: no note links here.
    resolveNotesRefs: async () => ({}),
  },
}));
// The reader's TRANSLATION OFFER (Story MOTIR-7735 · MOTIR-8121) — built from the
// locale and the to-do list the group already reads, so it adds no read of its
// own to the gate and no serial await to the page.
const TRANSLATION_OFFER = {
  targetLanguage: 'en',
  anyNeedsTranslation: true,
  fields: { title: { needsTranslation: true, kept: false, sourceLanguage: 'de', revision: 'r0' } },
};
const READER_TRANSLATION = { offer: TRANSLATION_OFFER, canAddCredits: false };
const getReaderTranslation = vi.fn(async (_input: unknown) => {
  started.push('translationOffer');
  return READER_TRANSLATION as unknown;
});
vi.mock('@/lib/services/workItemTranslationReadService', () => ({
  workItemTranslationReadService: {
    getReaderTranslation: (input: unknown) => getReaderTranslation(input),
  },
}));
vi.mock('@/lib/services/commentsService', () => ({
  commentsService: { listComments: deferred('comments', null, 'late') },
}));
vi.mock('@/lib/services/attachmentsService', () => ({
  attachmentsService: { listForWorkItem: deferred('attachments', null, 'late') },
}));
vi.mock('@/lib/services/acceptanceEvidenceService', () => ({
  acceptanceEvidenceService: { getCurrentForStory: () => acceptanceEvidence() },
}));
vi.mock('@/lib/services/acceptanceVideoEligibilityService', () => ({
  acceptanceVideoEligibilityService: { resolve: () => acceptanceResolve() },
}));
vi.mock('@/lib/services/designEvidenceService', () => ({
  designEvidenceService: { getCurrentForWorkItem: deferred('designEvidence', null, 'late') },
}));
vi.mock('@/lib/services/estimationService', () => ({
  estimationService: {
    getEstimationConfig: deferred('estimationConfig', {}, 'tierTwo'),
    rollupForParent: () => rollupForParent(),
  },
}));
vi.mock('@/lib/services/componentsService', () => ({
  componentsService: { listComponents: deferred('components', [], 'tierTwo') },
}));
vi.mock('@/lib/services/activityService', () => ({
  activityService: {
    listHistory: deferred('history', null, 'late'),
    listAll: deferred('all', null, 'late'),
  },
}));
vi.mock('@/lib/mentions/workItemRefs', () => ({ parseWorkItemRefs: () => [] }));
vi.mock('@/lib/utils/datetime', () => ({ formatDate: () => '' }));
// The REAL error classes, not a stub (MOTIR-5699): the module imports nothing, and a
// stub carrying one export broke the moment anything on this import graph read another
// at LOAD time — `ciPromotion`'s `SKIPPABLE` list does.
vi.mock('@/lib/projects/errors', () => ({ ProjectAccessDeniedError: class extends Error {} }));

// The JSX tree: imported, never executed.
vi.mock('@/components/issues/EstimationConfigProvider', () => ({
  EstimationConfigProvider: () => null,
}));
vi.mock('@/components/issues/ParentRollupBadge', () => ({ ParentRollupBadge: () => null }));
vi.mock('@/components/issues/IssueTypeIcon', () => ({ IssueTypeIcon: () => null }));
vi.mock('@/components/planning/WorkItemPlanEntrance', () => ({ WorkItemPlanEntrance: () => null }));
vi.mock('@/components/ui/EmptyState', () => ({ EmptyState: () => null }));
vi.mock('@/components/ui/MarkdownView', () => ({ MarkdownView: () => null }));
vi.mock('@/components/ui/Pill', () => ({ Pill: () => null }));
vi.mock('@/components/markdown/WorkItemTitle', () => ({ WorkItemTitle: () => null }));

const PROJECT = {
  projectId: 'p1',
  userId: 'u1',
  workspaceId: 'w1',
  project: { identifier: 'MOTIR', ...projectAccessData('members') },
};
const detailFor = (over: Record<string, unknown> = {}) => ({
  item: {
    id: 'i1',
    identifier: 'MOTIR-1',
    kind: 'subtask',
    type: 'code',
    status: 'todo',
    title: 't',
    descriptionMd: null,
    explanationMd: null,
    archivedAt: null,
    targetRepos: [],
    ...over,
  },
  children: [],
  workflow: { statuses: [] },
  ancestors: [],
  blockedBy: [],
  blocks: [],
  relatesTo: [],
  duplicates: [],
  clones: [],
  readiness: { ready: false, openBlockers: [], blockedByAncestor: null },
});

// ── WHY THE PAGE IS IMPORTED IN A HOOK, AND WHY EVERY CALL IS TRACKED (MOTIR-4902)
//
// `import('@/app/(authed)/items/[key]/page')` pulls a 30+ module graph, of which
// only about half is mocked above. Transforming and evaluating it took **6.0 s**
// on this box — and when that import sat inside `callPage`, Vitest billed the
// whole of it to whichever `it()` happened to call first. That case ran at 6.0 s
// of a 15 s `testTimeout` while the other twelve ran at 0–3 ms, so exactly one
// case in the file could lose a race against a loaded machine, and it was the
// most load-bearing one (the gate is in front of EVERY read). A guard whose red
// might mean "the box was busy" has stopped being evidence.
//
// A `beforeAll` is billed against `hookTimeout` (30 s), which is where a
// module-graph load belongs. `callPage` then reuses the reference.
//
// The tracking is the second half, and it is about what a TIMEOUT leaves behind.
// Vitest fails a timed-out case and moves on; the page invocation that case was
// awaiting keeps running, reaches its next mock some time later, and consumes a
// `mockResolvedValueOnce` the NEXT case had queued. The next case then fails
// with an assertion error about a product surface it never executed
// (`expected NEXT_PERMANENT_REDIRECT … got NEXT_NOT_FOUND`), which reads as a
// regression and is not one. `afterEach` runs even for a timed-out case, so
// draining there is what keeps one case's abandoned work out of the next.
type PageModule = typeof import('@/app/(authed)/items/[key]/page');
let pageModule: PageModule;

/** Every page invocation this case started, drained in `afterEach`. */
const inFlight: Promise<unknown>[] = [];

beforeAll(async () => {
  pageModule = await import('@/app/(authed)/items/[key]/page');
});

beforeEach(() => {
  // A promise resolves once, so a gate is per-CASE or it is spent. Both are
  // rebuilt here; nothing outside this hook constructs one.
  tierTwoGate = new Promise<void>((resolve) => {
    releaseTierTwo = resolve;
  });
  lateGate = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  started.length = 0;
  redirected.mockClear();
  notFoundFn.mockClear();
  getSession.mockReset();
  getActiveProject.mockReset();
  getIssueDetail.mockReset();
  getPermissions.mockReset();
  rollupForParent.mockClear();
  acceptanceResolve.mockClear();
  acceptanceEvidence.mockClear();
  pendingPlans.mockClear();
  planHistory.mockClear();
  // One-shot: a queued `mockResolvedValueOnce` that a previous case did not
  // consume must not be waiting for this one. `mockReset` restores the
  // implementation `vi.fn()` was constructed with.
  resolveAliasedIssueKey.mockReset();
});
afterEach(async () => {
  releaseAll();
  // Settle every invocation started by this case — including one Vitest
  // abandoned on a timeout — BEFORE the next case queues a one-shot mock.
  await Promise.allSettled(inFlight.splice(0));
  cleanup();
});

const callPage = (over: Record<string, unknown> = {}) => {
  const pending = Promise.resolve(
    pageModule.default({
      params: Promise.resolve({ key: 'MOTIR-1' }),
      searchParams: Promise.resolve({}),
      ...over,
    } as never),
  );
  inFlight.push(pending);
  // The case's own assertion still reads `pending`; this only keeps a rejection
  // the case abandons from surfacing as an unhandled rejection.
  void pending.catch(() => undefined);
  return pending;
};

// ── WHICH READS MAY PRECEDE THE GATE, AND WHY (MOTIR-4898) ──────────────────
//
// The two cases below assert the SAME property — the gate is in front of every
// read — at two different depths of the page, so each one names the EXACT set
// of reads that may have started by the point it stops. They used to name that
// set as a FILTER instead, and the two filters disagreed: one tolerated `t`,
// its sibling four lines later tolerated `t` AND `locale`. A tolerance is a
// claim about the page, so two different tolerances are two different claims
// about one property, and at most one of them can be right.
//
//   * BEFORE the session settles, NOTHING may have started. An unauthenticated
//     request redirects at the top of the page, ahead of every read including
//     the translator, so the set is EMPTY — not "empty apart from `t`".
//   * `t` (`getTranslations`) is the ONE read that runs after the session check
//     and ahead of the rest of the gate. It resolves a message catalogue and
//     reads no project data, so it cannot distinguish a missing item from a
//     browse-denied one — which is the leak this gate exists to prevent. Every
//     case that gets past the session check therefore expects exactly `t`.
//   * `locale` (`getLocale`) is NOT in that set at any depth. The page calls it
//     inside the tier-two `Promise.all`, which starts only after
//     `getPermissions` has settled — i.e. after the whole gate. Tolerating it
//     here bought nothing (no case has ever recorded it) and cost the one thing
//     the assertion is for: a hoist of `getLocale()` above `getIssueDetail`
//     would have gone unnoticed.
//
// So neither case filters. Anything new in `started` fails, and adding a name
// to one of these arrays is a deliberate statement that the page now starts
// that read before the gate has finished.
describe('the item-detail gate stays in front of every read (MOTIR-3435)', () => {
  it('redirects an unauthenticated request before starting anything', async () => {
    getSession.mockResolvedValue(null);
    await expect(callPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirected).toHaveBeenCalledWith('/sign-in');
    // Not even the translator: the redirect precedes `getTranslations`.
    expect(started).toEqual([]);
  });

  it('404s a missing or browse-denied item without starting a single page read', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getActiveProject.mockResolvedValue(PROJECT);
    const { WorkItemNotFoundError } = await import('@/lib/workItems/errors');
    getIssueDetail.mockRejectedValue(new WorkItemNotFoundError('nope'));

    await expect(callPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundFn).toHaveBeenCalled();
    // The permission read never ran, and neither did anything after it: a 404
    // must not be distinguishable from a denial by what the server did.
    expect(getPermissions).not.toHaveBeenCalled();
    // The translator and nothing else — `locale` belongs to the tier-two group,
    // which this request never reaches.
    expect(started).toEqual(['t']);
  });

  it('308-redirects an item under a retired project key', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getActiveProject.mockResolvedValue(PROJECT);
    const { WorkItemNotFoundError } = await import('@/lib/workItems/errors');
    getIssueDetail.mockRejectedValue(new WorkItemNotFoundError('nope'));
    resolveAliasedIssueKey.mockResolvedValueOnce('NIF-7');

    await expect(callPage()).rejects.toThrow('NEXT_PERMANENT_REDIRECT');
    expect(permanentRedirected).toHaveBeenCalledWith('/items/NIF-7');
    expect(getPermissions).not.toHaveBeenCalled();
  });
});

describe('the remaining reads run CONCURRENTLY (MOTIR-3435)', () => {
  it('starts them all before any resolves — a Promise.all, not a chain', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue(detailFor());
    getPermissions.mockResolvedValue(new Set(['work_item:edit', 'plan:view_any']));

    const pending = callPage();
    // A real macrotask, not a fixed number of microtask ticks: the page gate's
    // own four awaits resolve on the microtask queue and counting them would
    // couple this test to how many `await`s that gate happens to have.
    //
    // ⚠️ AND THE MACROTASK IS WHY THE TEST GATES MUST BE PENDING (MOTIR-4919).
    // A macrotask runs only after the microtask queue has DRAINED, so if the
    // mocked reads can settle, they all have by the time this resumes — and a
    // fully serialised chain reaches this line with every name in `started`,
    // exactly like a `Promise.all`. The assertion below therefore discriminates
    // concurrency from serialisation only while the reads are held OPEN. That
    // is what the per-case gates buy: with the old shared gate, resolved by the
    // first case's teardown, this assertion could not fail.
    await new Promise((r) => setTimeout(r, 0));

    // Every non-conditional member of the group is in flight while NONE has
    // resolved. Serialised awaits would show exactly one.
    for (const name of [
      'pullRequests',
      'deliveryView',
      'members',
      'sprints',
      'commentCaps',
      'attachmentCaps',
      'attachments',
      'designEvidence',
      'components',
      'estimationConfig',
      'workItemRefs',
      // The to-do list (MOTIR-3808) is an unconditional tier-two member: every
      // card has a list, even when it is empty, so this read is never skipped
      // and must not be the one that gets serialised back out of the group.
      'todoList',
      // The pending-plan read (MOTIR-4197) is a tier-two member for an actor
      // holding `plan:view_any`: it sits at the TOP of <main>, so it cannot be
      // late, and it costs the group max() rather than sum() only while it is
      // IN the group — a serial await here is the shape MOTIR-3435 removed.
      'pendingPlans',
      // The plan-history read (MOTIR-5547): the section renders with the first
      // content, after Children, so it joins the group rather than trailing it.
      'planHistory',
      // The held status moves (MOTIR-5528): the rail's status card draws them
      // under its value, so they are read with the rail, not after it.
      'heldTransitions',
      // The plan hold (MOTIR-6267): the status card says it under its value too.
      'planHold',
      // The header's decision-waiting marker (MOTIR-5878): the header is what the
      // reader lands on, so its read is in THIS group, never in the late stack.
      'pendingDecisions',
    ]) {
      expect(started, `${name} should already be in flight`).toContain(name);
    }

    releaseAll();
    await pending.catch(() => undefined);
  });

  it('keeps the CONDITIONAL reads conditional — a leaf subtask pays neither', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue(detailFor()); // subtask, todo, no children
    getPermissions.mockResolvedValue(new Set());

    const pending = callPage();
    // A real macrotask, not a fixed number of microtask ticks: the page gate's
    // own four awaits resolve on the microtask queue and counting them would
    // couple this test to how many `await`s that gate happens to have.
    //
    // ⚠️ AND THE MACROTASK IS WHY THE TEST GATES MUST BE PENDING (MOTIR-4919).
    // A macrotask runs only after the microtask queue has DRAINED, so if the
    // mocked reads can settle, they all have by the time this resumes — and a
    // fully serialised chain reaches this line with every name in `started`,
    // exactly like a `Promise.all`. The assertion below therefore discriminates
    // concurrency from serialisation only while the reads are held OPEN. That
    // is what the per-case gates buy: with the old shared gate, resolved by the
    // first case's teardown, this assertion could not fail.
    await new Promise((r) => setTimeout(r, 0));

    // Not a story at in_review/done → no acceptance reads at all.
    expect(acceptanceResolve).not.toHaveBeenCalled();
    expect(acceptanceEvidence).not.toHaveBeenCalled();
    // No children → no recursive-CTE roll-up. Parallelising this instead of
    // skipping it would make every leaf page pay for it.
    expect(rollupForParent).not.toHaveBeenCalled();
    // No `plan:view_any` → no pending-plan read AT ALL (MOTIR-4197 AC 4): an
    // indicator naming a plan the viewer cannot open is worse than none, and
    // the query is skipped rather than run-and-discarded, so the actor least
    // able to benefit from it never pays for it.
    expect(pendingPlans).not.toHaveBeenCalled();
    // …and no plan-history read either (MOTIR-5547 AC 3): a row linking to a plan
    // the viewer cannot open is worse than no row.
    expect(planHistory).not.toHaveBeenCalled();

    releaseAll();
    await pending.catch(() => undefined);
  });

  it('runs the pending-plan read for an actor holding `plan:view_any`, and only then', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue(detailFor());
    // The VIEW key alone — no `ai:view_plan` (MOTIR-6328): the indicator is a
    // READ, so the authoring key is neither needed nor sufficient.
    getPermissions.mockResolvedValue(new Set(['plan:view_any']));

    const pending = callPage();
    await new Promise((r) => setTimeout(r, 0));

    expect(pendingPlans).toHaveBeenCalledTimes(1);
    // It is IN the group: in flight while the deferred members are unresolved.
    expect(started).toContain('pendingPlans');
    // The plan-history read rides the same condition, once (MOTIR-5547).
    expect(planHistory).toHaveBeenCalledTimes(1);
    expect(started).toContain('planHistory');

    releaseAll();
    await pending.catch(() => undefined);
  });

  it('does NOT run the plan reads for an actor holding only the AUTHORING key `ai:view_plan` (MOTIR-6328)', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue(detailFor());
    getPermissions.mockResolvedValue(new Set(['ai:view_plan']));

    const pending = callPage();
    await new Promise((r) => setTimeout(r, 0));

    expect(pendingPlans).not.toHaveBeenCalled();
    expect(planHistory).not.toHaveBeenCalled();

    releaseAll();
    await pending.catch(() => undefined);
  });

  it('runs the acceptance pair for a story in review, and the roll-up for a parent', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue({
      ...detailFor({ kind: 'story', status: 'in_review' }),
      children: [{ id: 'c1' }],
    });
    getPermissions.mockResolvedValue(new Set());

    const pending = callPage();
    // A real macrotask, not a fixed number of microtask ticks: the page gate's
    // own four awaits resolve on the microtask queue and counting them would
    // couple this test to how many `await`s that gate happens to have.
    //
    // ⚠️ AND THE MACROTASK IS WHY THE TEST GATES MUST BE PENDING (MOTIR-4919).
    // A macrotask runs only after the microtask queue has DRAINED, so if the
    // mocked reads can settle, they all have by the time this resumes — and a
    // fully serialised chain reaches this line with every name in `started`,
    // exactly like a `Promise.all`. The assertion below therefore discriminates
    // concurrency from serialisation only while the reads are held OPEN. That
    // is what the per-case gates buy: with the old shared gate, resolved by the
    // first case's teardown, this assertion could not fail.
    await new Promise((r) => setTimeout(r, 0));

    expect(acceptanceResolve).toHaveBeenCalled();
    expect(acceptanceEvidence).toHaveBeenCalled();
    expect(rollupForParent).toHaveBeenCalled();

    releaseAll();
    await pending.catch(() => undefined);
  });
});

// ── MOTIR-3436 — the late stack ────────────────────────────────────────────
//
// The design decides the page settles TWICE, so the five late sections share
// ONE settle. On this page that is delivered by TWO `<Suspense>` boundaries
// awaiting the SAME promise, because `ChildPanel` is tier-2 and the shipped page
// renders it between them — so what is asserted is the property (one promise,
// therefore one arrival), not the JSX element count.
describe('the late stack (MOTIR-3436)', () => {
  it('does not hold the first flush — the page resolves while the late reads are still pending', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1', name: 'Yue' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue(detailFor());
    getPermissions.mockResolvedValue(new Set(['work_item:edit']));

    // Tier two is let through and the LATE gate is NOT, so every late read is
    // genuinely stuck at the moment the page returns. That is the whole point
    // of the boundary, and it is the assertion this case exists to make.
    //
    // ⚠️ THE TIER-TWO RELEASE IS LOAD-BEARING, NOT A CONVENIENCE (MOTIR-4919).
    // The page AWAITS its tier-two `Promise.all` before it returns (page.tsx
    // :226) and only STARTS the late reads (:190). So holding both tiers would
    // hang the page CORRECTLY, and this case would be asserting nothing about
    // the boundary — it would be waiting on the tier the boundary is not for.
    // This comment used to read "`gate` is never released, so every LATE read
    // is stuck", which was false twice over: one shared gate had already been
    // resolved by the first case's `afterEach`, and holding it would have
    // stopped tier two rather than only the late stack.
    releaseTierTwo?.();
    const rendered = await callPage();
    expect(rendered).toBeTruthy();

    // …and the late reads were nonetheless STARTED, not deferred to the client.
    expect(started).toContain('commentCaps');
    expect(started).toContain('attachmentCaps');
  });

  it('starts the late reads ONCE for both halves — one promise, one settle', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1', name: 'Yue' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue(detailFor());
    getPermissions.mockResolvedValue(new Set());

    // Tier two through, late held — the page returns while the late reads are
    // still in flight, which is the state this counts them in (MOTIR-4919).
    releaseTierTwo?.();
    await callPage();

    // Two boundaries await the same promise. If each had built its own, every
    // late read would have run twice — which is the regression this asserts
    // against, and the reason the two halves cannot each call readLateSections.
    const once = (n: string) => started.filter((s) => s === n).length;
    expect(once('commentCaps')).toBe(1);
    expect(once('attachmentCaps')).toBe(1);
    expect(once('designEvidence')).toBe(1);
  });

  it('keeps the RAIL’s repo delivery in tier two — read once, not once per tier', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1', name: 'Yue' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue(detailFor());
    getPermissions.mockResolvedValue(new Set());

    const pending = callPage();
    await new Promise((r) => setTimeout(r, 0));

    // The rail's Repositories card renders it, so it must be awaited before the
    // first flush; the Development section takes the same value as a prop. ONE
    // read for both halves is the point — `getDeliveryView` returns them
    // together precisely so neither host combines them itself (MOTIR-3660).
    expect(started.filter((s) => s === 'deliveryView').length).toBe(1);
    releaseAll();
    await pending.catch(() => undefined);
  });
});

describe('error containment survives the move behind a boundary (MOTIR-3436)', () => {
  it('a failing attachments read degrades that section, it does not reject the stack', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1', name: 'Yue' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue(detailFor());
    getPermissions.mockResolvedValue(new Set());
    const { attachmentsService } = await import('@/lib/services/attachmentsService');
    (
      attachmentsService.listForWorkItem as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('boom'));

    // The try/catch travelled WITH the read into `lateReads`, so the failure
    // becomes a null page and the panel renders its own ErrorState + retry. A
    // boundary must not turn a caught failure into a thrown one — that is what
    // an `error.tsx` would have done, and why this card adds none.
    releaseAll();
    await expect(callPage()).resolves.toBeTruthy();
  });
});

describe('permission shaping travels WITH the section (MOTIR-3437)', () => {
  // The capability reads decide what a section OFFERS, not merely what it
  // shows. They moved into `lateReads` with their sections, so what is asserted
  // is that the actor's caps reach the section UNMODIFIED — a page that
  // narrowed or defaulted them on the way is how a read-only viewer gets
  // offered a composer that will 403.
  const callLower = async (
    caps: {
      canComment: boolean;
      canModerate: boolean;
      canCreate: boolean;
      canDeleteAll: boolean;
    },
    canViewPages = false,
  ) => {
    const { LateLowerSections } =
      await import('@/app/(authed)/items/[key]/_components/LateSections');
    const reads = Promise.resolve({
      projectId: 'p1',
      pullRequests: [],
      commentCaps: { canComment: caps.canComment, canModerate: caps.canModerate },
      attachmentCaps: { canCreate: caps.canCreate, canDeleteAll: caps.canDeleteAll },
      initialComments: null,
      initialHistory: null,
      initialAll: null,
      initialAttachments: null,
      acceptanceEligibility: null,
      acceptanceEvidence: null,
      canDecideAcceptance: false,
      designEvidence: null,
      isDesignCard: false,
    });
    return (await LateLowerSections({
      reads: reads as never,
      itemId: 'i1',
      itemIdentifier: 'PROD-1',
      canViewPages,
      canEditWorkItem: false,
      currentUserId: 'u1',
      currentUserName: 'Yue',
      workflowStatuses: [] as never,
      mentionCandidates: [],
      activityTab: 'comments',
    })) as { props: { children: { props: Record<string, unknown> }[] } };
  };

  it('a VIEWER gets read-only Comments and Attachments', async () => {
    const el = await callLower({
      canComment: false,
      canModerate: false,
      canCreate: false,
      canDeleteAll: false,
    });
    const [, attachments, activity] = el.props.children;
    expect(attachments).toBeDefined();
    expect(activity).toBeDefined();
    expect(attachments!.props.canCreate).toBe(false);
    expect(attachments!.props.canDeleteAll).toBe(false);
    expect((activity!.props.comments as { canComment: boolean }).canComment).toBe(false);
  });

  it('an EDITOR gets the composer and the upload control', async () => {
    const el = await callLower({
      canComment: true,
      canModerate: false,
      canCreate: true,
      canDeleteAll: false,
    });
    const [, attachments, activity] = el.props.children;
    expect(attachments).toBeDefined();
    expect(activity).toBeDefined();
    expect(attachments!.props.canCreate).toBe(true);
    expect((activity!.props.comments as { canComment: boolean }).canComment).toBe(true);
  });

  // MOTIR-7575 — the Pages section opens the lower half, and is ABSENT (not
  // disabled) for a reader the page found without `page:view` or on the Visitor
  // path: no element, so no client island and no read of the Pages route.
  const NO_CAPS = { canComment: false, canModerate: false, canCreate: false, canDeleteAll: false };

  it('mounts the Pages section FIRST, before Attachments, for a reader holding page:view', async () => {
    const { PagesSection } = await import('@/app/(authed)/items/[key]/_components/PagesSection');
    const el = await callLower(NO_CAPS, true);
    const [pages] = el.props.children as unknown as { type: unknown; props: unknown }[];
    expect(pages!.type).toBe(PagesSection);
    expect(pages!.props).toEqual({
      workItemId: 'i1',
      identifier: 'PROD-1',
      projectId: 'p1',
      canEditWorkItem: false,
    });
  });

  it('renders NO Pages section when the reader is withheld', async () => {
    const el = await callLower(NO_CAPS, false);
    const [pages, attachments, activity] = el.props.children;
    expect(pages).toBeNull();
    expect(attachments).toBeDefined();
    expect(activity).toBeDefined();
  });
});

describe('the header’s decision-waiting marker (MOTIR-5878)', () => {
  // The page is CALLED, not rendered, so what is asserted is the element tree it
  // returns: the header mounts the marker exactly when the early read found a
  // decision on THIS item, with the routed person named from the page's members.
  const findAll = (node: unknown, type: unknown, out: Record<string, unknown>[] = []) => {
    if (Array.isArray(node)) {
      for (const n of node) findAll(n, type, out);
    } else if (node && typeof node === 'object' && '$$typeof' in node) {
      const el = node as unknown as { type: unknown; props: Record<string, unknown> };
      if (el.type === type) out.push(el.props);
      for (const value of Object.values(el.props ?? {})) findAll(value, type, out);
    }
    return out;
  };

  const renderHeader = async (
    pending: Map<string, unknown>,
    members: { userId: string; name: string; email: string }[] = [],
  ) => {
    const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
    const { assignableMembersService } = await import('@/lib/services/assignableMembersService');
    vi.mocked(approvalGatesService.pendingDecisionsFor).mockResolvedValueOnce(pending as never);
    vi.mocked(assignableMembersService.list).mockResolvedValueOnce(members as never);
    const { DecisionWaitingHeaderLink } =
      await import('@/app/(authed)/items/[key]/_components/DecisionWaitingHeaderLink');
    getSession.mockResolvedValue({ user: { id: 'u1', name: 'Yue' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue(detailFor());
    getPermissions.mockResolvedValue(new Set(['work_item:edit']));
    releaseAll();
    return findAll(await callPage(), DecisionWaitingHeaderLink);
  };

  it('mounts the marker for an awaiting gate, naming the routed member', async () => {
    const markers = await renderHeader(
      new Map([['i1', { state: 'others', kind: 'design_result', routedToId: 'u2' }]]),
      [{ userId: 'u2', name: 'Ana Ruiz', email: 'ana@ex.com' }],
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]!.decision).toEqual({
      state: 'others',
      kind: 'design_result',
      routedToId: 'u2',
    });
    expect(markers[0]!.routedToName).toBe('Ana Ruiz');
  });

  it('mounts NOTHING when the read finds no awaiting gate (none, decided or superseded)', async () => {
    expect(await renderHeader(new Map())).toHaveLength(0);
  });

  it('passes a null name for a routee outside the member list — the marker’s own fallback', async () => {
    const markers = await renderHeader(
      new Map([['i1', { state: 'others', kind: 'acceptance_result', routedToId: 'gone' }]]),
    );
    expect(markers[0]!.routedToName).toBeNull();
  });
});
describe('the Pages section’s capability is threaded from the page (MOTIR-7575)', () => {
  const findAll = (node: unknown, type: unknown, out: Record<string, unknown>[] = []) => {
    if (Array.isArray(node)) {
      for (const n of node) findAll(n, type, out);
    } else if (node && typeof node === 'object' && '$$typeof' in node) {
      const el = node as unknown as { type: unknown; props: Record<string, unknown> };
      if (el.type === type) out.push(el.props);
      for (const value of Object.values(el.props ?? {})) findAll(value, type, out);
    }
    return out;
  };

  const lowerHalf = async (held: string[]) => {
    const { LateLowerSections, LateLowerFallback } =
      await import('@/app/(authed)/items/[key]/_components/LateSections');
    getSession.mockResolvedValue({ user: { id: 'u1', name: 'Yue' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue(detailFor());
    getPermissions.mockResolvedValue(new Set(held));
    releaseAll();
    const tree = await callPage();
    return {
      sections: findAll(tree, LateLowerSections),
      fallbacks: findAll(tree, LateLowerFallback),
    };
  };

  it('a reader holding page:view gets the section and its reserved skeleton', async () => {
    const { sections, fallbacks } = await lowerHalf(['page:view']);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.canViewPages).toBe(true);
    expect(sections[0]!.itemIdentifier).toBe('MOTIR-1');
    expect(fallbacks[0]!.withPages).toBe(true);
  });

  it('a reader without page:view gets neither — no section, no skeleton that vanishes', async () => {
    const { sections, fallbacks } = await lowerHalf(['work_item:edit']);
    expect(sections[0]!.canViewPages).toBe(false);
    expect(fallbacks[0]!.withPages).toBe(false);
  });
});

describe('the translation offer reaches the view (MOTIR-8121 · MOTIR-8122)', () => {
  const findAll = (node: unknown, type: unknown, out: Record<string, unknown>[] = []) => {
    if (Array.isArray(node)) {
      for (const n of node) findAll(n, type, out);
    } else if (node && typeof node === 'object' && '$$typeof' in node) {
      const el = node as unknown as { type: unknown; props: Record<string, unknown> };
      if (el.type === type) out.push(el.props);
      for (const value of Object.values(el.props ?? {})) findAll(value, type, out);
    }
    return out;
  };

  const renderOffer = async () => {
    const { TranslationProvider } =
      await import('@/app/(authed)/items/[key]/_components/translation/TranslationProvider');
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    getActiveProject.mockResolvedValue(PROJECT);
    getIssueDetail.mockResolvedValue(detailFor());
    getPermissions.mockResolvedValue(new Set(['work_item:edit']));
    releaseAll();
    return findAll(await callPage(), TranslationProvider);
  };

  beforeEach(() => getReaderTranslation.mockClear());

  it('hands a signed-in reader the offer built for their locale and the card’s to-dos', async () => {
    const providers = await renderOffer();
    expect(providers).toHaveLength(1);
    // The shipped offer and credit link, plus (MOTIR-8832) the reader's auto-translate
    // context layered over them: this project's switch is not on, so the host is the
    // on-demand one.
    expect(providers[0]!.translation).toMatchObject(READER_TRANSLATION);
    const auto = (providers[0]!.translation as ReaderTranslationDTO).auto;
    expect(auto).toMatchObject({ credit: 'ok', targetLanguage: 'en' });
    expect(auto?.autoTranslateWorkContent).toBeFalsy();
    expect(providers[0]!.itemId).toBe('i1');
    expect(getReaderTranslation).toHaveBeenCalledTimes(1);
    const input = getReaderTranslation.mock.calls[0]![0] as {
      readerLocale: string;
      todos: unknown[];
      workItem: { id: string };
    };
    expect(input.readerLocale).toBe('en');
    expect(input.todos).toEqual([]);
    expect(input.workItem.id).toBe('i1');
  });

  it('a failing offer read degrades to NO offer — no provider; it does not reject the page', async () => {
    getReaderTranslation.mockRejectedValueOnce(new Error('store down'));
    expect(await renderOffer()).toHaveLength(0);
  });
});
