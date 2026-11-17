import type { Locator, Page } from '@playwright/test';
import { createTranslator } from 'next-intl';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { latestPlanningSession } from './_helpers/planChangeConversation';
import {
  seedPlanProgress,
  PLAN_PROGRESS_PASSWORD,
  type PlanProgressSeed,
} from './_helpers/plan-progress-seed';
import { startSseFrameServer, type SseFrameServer } from './_helpers/sse-frame-server';
import {
  askFromCard,
  declareJobs,
  hostedStep,
  latestPlanJob,
  proposalRef,
  routeJobStream,
  stubAiAccess,
  type HostedJob,
} from './_helpers/plan-narration-doors';
import {
  composer,
  node,
  openFromCard,
  paneProgress,
  rail,
  resetJobsFixture,
  showCanvas,
  workspace,
} from './_helpers/plan-progress-harness';
import { plansService } from '@/lib/services/plansService';
import { POLL_MS } from '@/lib/hooks/useGeneratingPlanPoll';
import { UNKNOWN_FACT_KEY } from '@/lib/planning/progressFacts';
import { escapeRegExp } from '@/lib/utils/regexp';
import en from '@/messages/en.json';

// MOTIR-11598 — the E2E + ACCEPTANCE VIDEO for Story MOTIR-11489.
//
// The story's claim, in a real browser: the hosted final check is ONE step,
// "check & fix". Every card's session opens at once, each says it is checking
// and fixing its own card, each finding reads as fixed or as left for a person
// with its reason, and a card is looked at again only when a card it waits on
// changed what it delivers. There is no second "fix" step after the check.
//
// ── What the spec plays, and where each shape comes from ────────────────────
// This lane runs no model: its motir-ai is the jobs mock
// (`lib/test-ai-jobs-mock.ts`). The final check is played at the two doors it
// crosses into motir-core, with the payloads motir-ai's merged final check sends
// (motir-ai `claude/project-thread-w8c6km` at b723b35f, motir-ai#1099):
//   · `src/jobs/dryRunStage.ts`:
//       – the stage's ONE `check` frame (`ports.signal('check', {})`, L496);
//       – the untargeted `check` plan step the whole review holds (L500);
//       – one targeted `check` step per card session (`checkStepOpener`, L314),
//         which reaches `POST /api/internal/ai/plan-step` (the real door here);
//       – `dryRunStarted` (L465), `dryRunChecking` per container (L768),
//         `dryRunContainerResult` (L406), `dryRunFindingOutcome` (L420) and
//         `dryRunRechecking` (L960). A recheck RESUMES the card's own session,
//         so it posts no new plan step.
//   · `src/llm/progressFacts.ts`: the fact family and codes. Every outcome rides
//     `dry_run` (`finding_fixed`, `not_fixed_<reason>`), and `rechecking` carries
//     `params.title` (the card) and `params.blocker` (the upstream card's name).
// Each of those codes is an entry of motir-core's `FACT_KEYS.dry_run`
// (`lib/planning/progressFacts.ts`). The happy path scripts no `dry_run_repair`
// fact; only the older-plan case does, because an older stored plan carries them.
//
// The frames go through MOTIR-7982's seam: the browser's own job-stream request is
// re-targeted at a runner-local SSE server (`startSseFrameServer`), which writes
// each frame in motir-ai's `{ jobId, seq, data }` envelope (`jobStreamFrame`, the
// same writer as `jobStreamBody`). The page's real unwrap reads them one at a time,
// so a row is there only because its own frame arrived. The plan, its two
// containers and its four leaves are real proposals laid through the shipped plans
// service, so every head names a real stored title.
//
// ── Determinism, and the pace ───────────────────────────────────────────────
// Every wait is a landmark: a row count or a head count the rail must reach after
// a write. Nothing sleeps to wait for state; `beat()` and `chapter()`'s holds are
// pacing for a viewer only (`acceptance-video.ts` § Pacing). The page is never
// resized: the lane records every receipt at `ACCEPTANCE_FRAME`.
//
// Every expected sentence is produced from the message catalogue through
// `createTranslator`; no expected line is typed here.

const ASK = 'Split the export work into cards.';
const REPLY = 'Here are the cards, checked.';
const QUESTION = 'Should the export keep the old column order?';

const NS = 'planningWorkspace.conversation';

/** The two containers and their leaves. */
const A = 'Ship the CSV export';
const B = 'Ship the export settings';
const A1 = 'Write the CSV writer';
const A2 = 'Stream the CSV download';
const A3 = 'Show the export button';
const B1 = 'Store the export preferences';

/** The finding the check fixed on A1, and the one it left on B1. */
const FIXED = 'The CSV writer had no header row';
const LEFT = 'The preferences card is too big for one pull request';

// ── The catalogue — every expected line comes from here ──────────────────────

type Tr = (key: string, values?: Record<string, string | number>) => string;

/** A translator that THROWS on a missing key or parameter. */
const tc = createTranslator({
  locale: 'en',
  messages: en,
  namespace: NS,
  onError: (error) => {
    throw error;
  },
}) as unknown as Tr;
const tRoot = createTranslator({
  locale: 'en',
  messages: en,
  onError: (error) => {
    throw error;
  },
}) as unknown as Tr;

const fact = (key: string, values?: Record<string, string | number>) => tc(`fact.${key}`, values);
const GENERIC = fact(UNKNOWN_FACT_KEY);
const CHECK_TAG = tc('act.checking');
const PLAN_LINE = tc('act.checkingLine');
const headLine = (title: string) => tc('act.checkingCardLine', { title });
const progressCue = (title: string) => tRoot('planReview.progress.checkingCard', { title });
/** No visible string on the run's surfaces may say either. */
const BANNED = /dry.?run|repair/i;

// ── Locators ─────────────────────────────────────────────────────────────────

const acts = (page: Page) => rail(page).getByTestId('plan-change-acts');
const factRows = (page: Page) => acts(page).getByTestId('plan-change-act-fact');
const checkActs = (page: Page) => acts(page).getByTestId('plan-change-act-checking');
const fixActs = (page: Page) => acts(page).getByTestId('plan-change-act-repairing');
const groups = (page: Page) => rail(page).getByTestId('plan-narration-group');
const checkGroups = (page: Page) =>
  groups(page).filter({ has: page.locator('[data-kind="check"]') });
/** The ONE group whose head names `title`. */
const cardGroup = (page: Page, title: string) =>
  checkGroups(page).filter({
    has: page
      .getByTestId('plan-narration-head-title')
      .filter({ hasText: new RegExp(`^${escapeRegExp(title)}$`) }),
  });
const progressDetails = (page: Page) =>
  page.getByRole('dialog', { name: en.planReview.progress.detailsAria });

// ── The played planner ───────────────────────────────────────────────────────

/** Write ONE `progress_fact` frame: the payload motir-ai's `progressFacts.ts`
 *  builds, which the frame server envelopes. */
function writeFact(
  sse: SseFrameServer,
  code: string,
  params: Record<string, unknown>,
  ref: string | null = null,
  family = 'dry_run',
): void {
  sse.write('progress_fact', { fact: family, code, ref, params });
}

/** Write a fact and wait for the rail to draw it as row `index`, reading `line`. */
async function factLands(
  page: Page,
  sse: SseFrameServer,
  index: number,
  line: string,
  code: string,
  params: Record<string, unknown>,
  ref: string | null = null,
  family = 'dry_run',
): Promise<void> {
  writeFact(sse, code, params, ref, family);
  await expect(factRows(page)).toHaveCount(index + 1, { timeout: 4 * POLL_MS });
  await expect(factRows(page).nth(index)).toContainText(line);
  await expect(factRows(page).nth(index)).not.toContainText(GENERIC);
}

// ── Seeding ──────────────────────────────────────────────────────────────────

interface Hosted {
  planId: string;
  job: HostedJob;
  /** Each laid card's `planItem:` ref, by title. */
  refs: Map<string, string>;
}

async function lay(
  planId: string,
  seed: PlanProgressSeed,
  cards: readonly {
    title: string;
    kind: 'task' | 'subtask';
    parentRef: string;
    blockedByRefs?: string[];
  }[],
): Promise<string[]> {
  const laid = await plansService.addProposals(
    planId,
    cards.map((c) => ({
      op: 'add' as const,
      proposedFields: { title: c.title, kind: c.kind },
      parentRef: c.parentRef,
      ...(c.blockedByRefs ? { blockedByRefs: c.blockedByRefs } : {}),
    })),
    seed.reader.ctx,
  );
  expect(laid.appendedItemIds).toHaveLength(cards.length);
  return laid.appendedItemIds.map((id) => proposalRef(id));
}

/** Sign in, ask from the story's composer (the real anchored door), and lay the
 *  plan: two containers under the story, then their leaves. A2 waits on A1, whose
 *  delivery the check will change; A3 waits on B1, whose delivery it will not. */
async function openRun(page: Page, sse: SseFrameServer, slug: string): Promise<Hosted> {
  declareJobs(REPLY, QUESTION);
  const seed = await seedPlanProgress(`${slug}-${Date.now()}`);
  await stubAiAccess(page);
  await routeJobStream(page, sse);
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
  await openFromCard(page, seed.storyKey);
  await askFromCard(page, sse, composer(page), ASK);
  const session = await latestPlanningSession(seed.reader.email);
  const plan = await adminDb.plan.findFirstOrThrow({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
  });
  const job = latestPlanJob();
  expect(plan.sourceJobId, 'the hosted plan carries the job the mock answered').toBe(job.jobId);
  expect(plan.status).toBe('generating');

  const [a, b] = await lay(plan.id, seed, [
    { title: A, kind: 'task', parentRef: seed.storyId },
    { title: B, kind: 'task', parentRef: seed.storyId },
  ]);
  const [a1, b1] = await lay(plan.id, seed, [
    { title: A1, kind: 'subtask', parentRef: a! },
    { title: B1, kind: 'subtask', parentRef: b! },
  ]);
  const [a2, a3] = await lay(plan.id, seed, [
    { title: A2, kind: 'subtask', parentRef: a!, blockedByRefs: [a1!] },
    { title: A3, kind: 'subtask', parentRef: a!, blockedByRefs: [b1!] },
  ]);
  const refs = new Map([
    [A, a!],
    [B, b!],
    [A1, a1!],
    [A2, a2!],
    [A3, a3!],
    [B1, b1!],
  ]);
  return { planId: plan.id, job, refs };
}

/** Every card the check opens a session on: the leaves, then each container's own
 *  check. Six sessions across two containers. */
const CHECKED = [A1, A2, A3, A, B1, B] as const;

/** Open the final check: its one frame, its plan-wide step and its first facts. */
async function openFinalCheck(page: Page, sse: SseFrameServer, hosted: Hosted): Promise<void> {
  sse.write('check', {});
  await expect(checkActs(page)).toHaveCount(1, { timeout: 4 * POLL_MS });
  await expect(checkActs(page)).toContainText(CHECK_TAG);
  await expect(checkActs(page)).toContainText(PLAN_LINE);
  await hostedStep(page, hosted.job, 'final-check', { step: 'check' });
  await factLands(page, sse, 0, fact('dryRun.started'), 'started', {});
  await factLands(
    page,
    sse,
    1,
    fact('dryRun.checking', { title: A }),
    'checking',
    { title: A },
    hosted.refs.get(A)!,
  );
  await factLands(
    page,
    sse,
    2,
    fact('dryRun.checking', { title: B }),
    'checking',
    { title: B },
    hosted.refs.get(B)!,
  );
}

/** Open every card's session, through the real plan-step door, before any outcome. */
async function openEverySession(page: Page, hosted: Hosted): Promise<void> {
  for (const [i, title] of CHECKED.entries()) {
    await hostedStep(page, hosted.job, `final-check-${i + 1}`, {
      step: 'check',
      target: hosted.refs.get(title)!,
    });
  }
  // The plan-wide head plus one head per card.
  await expect(checkGroups(page)).toHaveCount(CHECKED.length + 1, { timeout: 4 * POLL_MS });
}

/** One head per checked card: the `check & fix` tag, `Checking and fixing {title}`,
 *  live. */
async function expectOneHeadPerCard(page: Page): Promise<void> {
  for (const title of CHECKED) {
    const group = cardGroup(page, title);
    await expect(group, `${title} has exactly one head`).toHaveCount(1);
    await expect(group).toHaveAttribute('data-session', 'live');
    await expect(group.locator('[data-kind]')).toHaveText(CHECK_TAG);
    await expect(group.getByTestId('plan-narration-head-line')).toHaveText(headLine(title));
  }
  // The check's own head names the plan's step, not a card.
  const planHead = checkGroups(page).filter({ hasText: PLAN_LINE });
  await expect(planHead).toHaveCount(1);
  await expect(planHead.getByTestId('plan-narration-head-title')).toHaveCount(0);
}

/** Neither the rail nor the progress card says "dry run" or "repair". */
async function expectNoBannedWords(page: Page, ...scopes: Locator[]): Promise<void> {
  for (const scope of scopes) {
    const text = await scope.innerText();
    expect(text, 'no visible string says "dry run" or "repair"').not.toMatch(BANNED);
  }
}

test.describe.configure({ timeout: 420_000 });

let sse: SseFrameServer;

test.beforeEach(async () => {
  await resetDatabase();
  resetJobsFixture();
  sse = await startSseFrameServer();
});

test.afterEach(async () => {
  await sse.close();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECEIPT
// ─────────────────────────────────────────────────────────────────────────────

test('the final check reads as one check & fix step: every card at once, each finding’s outcome, and one recheck', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-11489');
  let hosted!: Hosted;

  await chapter('Ask Motir AI for a plan — two containers and their four cards', async () => {
    hosted = await openRun(page, sse, 'final-check');
    await showCanvas(page);
    for (const title of CHECKED) {
      await expect(node(page, title)).toBeVisible({ timeout: 4 * POLL_MS });
    }
    await expect(factRows(page)).toHaveCount(0);
    await beat();
  });

  await chapter(
    'The final check opens every card’s session at once — one check & fix each',
    async () => {
      await openFinalCheck(page, sse, hosted);
      await openEverySession(page, hosted);
      await expectOneHeadPerCard(page);
      // One step: the check's own act, and no fix act after it.
      await expect(checkActs(page)).toHaveCount(1);
      await expect(fixActs(page)).toHaveCount(0);
      await beat();
    },
  );

  await chapter('The plan progress card says each card is being checked and fixed', async () => {
    await expect(paneProgress(page)).toBeVisible();
    await paneProgress(page).click();
    const details = progressDetails(page);
    await expect(details).toBeVisible();
    for (const title of CHECKED) {
      await expect(details.getByText(progressCue(title), { exact: true })).toHaveCount(1);
    }
    await expectNoBannedWords(page, details);
    await beat();
    await page.keyboard.press('Escape');
    await expect(details).toBeHidden();
  });

  await chapter(
    'Each finding reads as fixed, or as left for a person with its reason',
    async () => {
      await factLands(
        page,
        sse,
        3,
        fact('repair.findingFixed', { summary: FIXED }),
        'finding_fixed',
        { summary: FIXED },
        hosted.refs.get(A1)!,
      );
      await beat();
      await factLands(
        page,
        sse,
        4,
        fact('repair.notFixedSizing', { summary: LEFT }),
        'not_fixed_sizing',
        { summary: LEFT },
        hosted.refs.get(B1)!,
      );
      await beat();
    },
  );

  await chapter(
    'Only the card whose upstream changed is checked again, under the same step',
    async () => {
      const recheck = fact('dryRun.rechecking', { title: A2, blocker: A1 });
      await factLands(
        page,
        sse,
        5,
        recheck,
        'rechecking',
        { title: A2, blocker: A1 },
        hosted.refs.get(A2)!,
      );
      // The recheck resumed A2's own session: no second head, no new act.
      await expect(cardGroup(page, A2)).toHaveCount(1);
      await expect(checkGroups(page)).toHaveCount(CHECKED.length + 1);
      await expect(checkActs(page)).toHaveCount(1);
      await expect(fixActs(page)).toHaveCount(0);
      // A3 waits on B1, whose delivery did not change: no recheck names it.
      await expect(factRows(page).filter({ hasText: A3 })).toHaveCount(0);
      await expect(factRows(page).filter({ hasText: B1 })).toHaveCount(0);
      await beat();
    },
  );

  await chapter(
    'The containers close — and nothing on the run says dry run or repair',
    async () => {
      await factLands(
        page,
        sse,
        6,
        fact('dryRun.containerFound', { title: A, count: 1 }),
        'container_found',
        { title: A, count: 1 },
        hosted.refs.get(A)!,
      );
      await factLands(
        page,
        sse,
        7,
        fact('dryRun.containerFound', { title: B, count: 1 }),
        'container_found',
        { title: B, count: 1 },
        hosted.refs.get(B)!,
      );
      await expect(checkActs(page)).toContainText(PLAN_LINE);
      await expect(fixActs(page)).toHaveCount(0);
      await expectNoBannedWords(page, rail(page), paneProgress(page));
      await beat();
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// AN OLDER STORED PLAN
// ─────────────────────────────────────────────────────────────────────────────

test('an older plan’s stream, with a repair pass after the check, still renders under one check & fix step', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  const hosted = await openRun(page, sse, 'final-check-older');
  await openFinalCheck(page, sse, hosted);
  await openEverySession(page, hosted);
  await expectOneHeadPerCard(page);

  // What an older motir-ai sent after its check: a `repair` frame, then the
  // repair's own facts under `dry_run_repair`.
  sse.write('repair', {});
  await expect(fixActs(page)).toHaveCount(1, { timeout: 4 * POLL_MS });
  await factLands(page, sse, 3, fact('repair.started'), 'started', {}, null, 'dry_run_repair');
  await factLands(
    page,
    sse,
    4,
    fact('repair.findingFixed', { summary: FIXED }),
    'finding_fixed',
    { summary: FIXED },
    null,
    'dry_run_repair',
  );
  await factLands(
    page,
    sse,
    5,
    fact('repair.notFixedSizing', { summary: LEFT }),
    'not_fixed_sizing',
    { summary: LEFT },
    null,
    'dry_run_repair',
  );

  // Still one check & fix step, one head per card.
  await expect(checkActs(page)).toHaveCount(1);
  await expect(checkActs(page)).toContainText(CHECK_TAG);
  await expectOneHeadPerCard(page);
  // The fix act that remains is worded as the validity re-open's fix: it never
  // claims to fix what the final check found (MOTIR-11491 keeps it for that pass).
  await expect(fixActs(page)).toContainText(tc('act.repairingLine'));
  await expect(fixActs(page)).not.toContainText(PLAN_LINE);
  await expect(workspace(page)).toBeVisible();
  await expect(paneProgress(page)).toBeVisible();
  expect(errors, 'no page or console error').toEqual([]);
});
