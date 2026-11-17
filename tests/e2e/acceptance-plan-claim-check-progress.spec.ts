import type { Locator, Page } from '@playwright/test';
import { createTranslator } from 'next-intl';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { latestPlanningSession } from './_helpers/planChangeConversation';
import { setReaderLanguage } from './_helpers/reader-language';
import {
  seedPlanProgress,
  PLAN_PROGRESS_PASSWORD,
  type PlanProgressSeed,
} from './_helpers/plan-progress-seed';
import { startSseFrameServer, type SseFrameServer } from './_helpers/sse-frame-server';
import {
  askFromCard,
  declareJobs,
  latestPlanJob,
  proposalRef,
  routeJobStream,
  stubAiAccess,
} from './_helpers/plan-narration-doors';
import {
  composer,
  node,
  openFromCard,
  rail,
  resetJobsFixture,
  showCanvas,
} from './_helpers/plan-progress-harness';
import { plansService } from '@/lib/services/plansService';
import { POLL_MS } from '@/lib/hooks/useGeneratingPlanPoll';
import { UNKNOWN_FACT_KEY } from '@/lib/planning/progressFacts';
import en from '@/messages/en.json';
import nl from '@/messages/nl.json';

// MOTIR-11544 — the E2E + ACCEPTANCE VIDEO for Story MOTIR-11494.
//
// The story's claim, in a real browser: while a planner checks a level's code
// names, the progress rail says so ONE CARD AT A TIME — a line per card checked,
// naming the card and how many issues the check found on it (0 included) — and
// the level's close keeps its own line: every name held, or N cards sent back.
//
// ── What is real, and what is PLAYED ────────────────────────────────────────
// This lane runs no model: its motir-ai is the jobs mock
// (`lib/test-ai-jobs-mock.ts`), and plan.py lives in motir-meta. That motir-ai's
// claim check SENDS these frames is proven in motir-ai (`claimCardChecked`,
// `claimCheckEnded`), and that motir-core words motir-ai's own payloads in every
// locale is `tests/planning/claimCheckFactsSeam.test.ts`. Here the planner is
// played at the boundary it crosses into motir-core:
//   · the ask from the card is the REAL anchored door, and opens a real hosted
//     plan in the real workspace;
//   · the level's three cards are laid through the shipped plans service in the
//     runner process, so the rail names real proposals by their real refs;
//   · the check's frames are the payloads motir-ai sends — `claim_check` /
//     `card_checked` with `params: { title, count }`, then `held`, or
//     `sent_back` with `params: { count, cards }` — written ONE AT A TIME into the
//     run's job stream.
// THE ONE SEAM is MOTIR-7982's: the browser's own job-stream request is
// re-targeted at a runner-local SSE server (`startSseFrameServer`), which wraps
// each frame in motir-ai's `{ jobId, seq, data }` envelope. No read is
// intercepted, so a row on the rail can only be there because its own frame
// arrived — the record is asserted BETWEEN writes.
//
// ── Determinism, and the pace ───────────────────────────────────────────────
// Every wait is a landmark: the row count the record must reach after a write.
// Nothing sleeps to wait for state; `beat()` and `chapter()`'s holds are pacing
// for a viewer only (`acceptance-video.ts` § Pacing).
//
// Every expected sentence is produced from the message catalogue through
// `createTranslator` — no expected line is typed here.

const ASK = 'Split the export work into cards.';
const REPLY = 'Here are the cards I am checking.';
const QUESTION = 'Should the export keep the old column order?';

const NS = 'planningWorkspace.conversation';

/** The level's three cards, and the issue count the check finds on each. */
const LEVEL = [
  { title: 'Publish the export layer', count: 1 },
  { title: 'Read the export settings', count: 0 },
  { title: 'Retire the legacy export route', count: 2 },
] as const;

/** The second level's three cards: two are sent back. */
const SENT_BACK_LEVEL = [
  { title: 'Add the export audit log', count: 2 },
  { title: 'Show the export history', count: 0 },
  { title: 'Rename the export queue', count: 1 },
] as const;

type Locale = 'en' | 'nl';

// ── The catalogue — every expected line comes from here ──────────────────────

/** A translator over one locale's raw catalogue that THROWS on a missing key or
 *  parameter, so a line the catalogue cannot word fails here, not on screen. */
function catalogue(locale: Locale) {
  return createTranslator({
    locale,
    messages: locale === 'en' ? en : nl,
    namespace: NS,
    onError: (error) => {
      throw error;
    },
  });
}

const say = (locale: Locale, key: string, params?: Record<string, string | number>): string =>
  (catalogue(locale) as unknown as (k: string, p?: Record<string, string | number>) => string)(
    key,
    params,
  );

/** The catalogue's line for one card checked, in `locale`. */
const cardCheckedLine = (locale: Locale, title: string, count: number): string =>
  say(locale, 'fact.claimCheck.cardChecked', { title, count });

/** The catalogue's generic line — what an uncatalogued code falls to. */
const genericLine = (locale: Locale): string => say(locale, `fact.${UNKNOWN_FACT_KEY}`);

// ── The played planner — one `progress_fact` frame at a time ─────────────────

/** Write ONE `progress_fact` frame into the run's open stream: the payload
 *  motir-ai's `progressFacts.ts` builds, which the frame server envelopes. */
function writeFact(
  sse: SseFrameServer,
  fact: string,
  code: string,
  params: Record<string, unknown>,
  ref: string | null = null,
): void {
  sse.write('progress_fact', { fact, code, ref, params });
}

// ── Locators ─────────────────────────────────────────────────────────────────

const acts = (page: Page) => rail(page).getByTestId('plan-change-acts');
const factRows = (page: Page) => acts(page).getByTestId('plan-change-act-fact');

/** No row on the record reads the generic line. */
async function expectNoGenericRow(rows: Locator, locale: Locale): Promise<void> {
  const generic = genericLine(locale);
  const count = await rows.count();
  for (let i = 0; i < count; i += 1) {
    await expect(rows.nth(i), `row ${i + 1} is the generic line`).not.toContainText(generic);
  }
}

// ── Seeding ──────────────────────────────────────────────────────────────────

interface Hosted {
  planId: string;
  /** Each laid card's `planItem:` ref, by title. */
  refs: Map<string, string>;
}

/** Ask for a plan from the story's composer — the real anchored door — and
 *  return the `generating` plan it opened for the job the mock answered. */
async function askHosted(page: Page, sse: SseFrameServer, seed: PlanProgressSeed) {
  await openFromCard(page, seed.storyKey);
  await askFromCard(page, sse, composer(page), ASK);
  const session = await latestPlanningSession(seed.reader.email);
  const plan = await adminDb.plan.findFirstOrThrow({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
  });
  expect(plan.sourceJobId, 'the hosted plan carries the job the mock answered').toBe(
    latestPlanJob().jobId,
  );
  expect(plan.status).toBe('generating');
  return plan.id;
}

/** Lay a level of cards under the story through the shipped plans service. */
async function layLevel(
  planId: string,
  seed: PlanProgressSeed,
  titles: readonly string[],
): Promise<Map<string, string>> {
  const laid = await plansService.addProposals(
    planId,
    titles.map((title) => ({
      op: 'add' as const,
      proposedFields: { title, kind: 'task' as const },
      parentRef: seed.storyId,
    })),
    seed.reader.ctx,
  );
  expect(laid.appendedItemIds).toHaveLength(titles.length);
  return new Map(titles.map((title, i) => [title, proposalRef(laid.appendedItemIds[i]!)]));
}

/** Sign in, ask, and lay the level — the walk every test starts from. */
async function openRun(
  page: Page,
  sse: SseFrameServer,
  slug: string,
  titles: readonly string[],
  locale: Locale = 'en',
): Promise<{ seed: PlanProgressSeed; hosted: Hosted }> {
  declareJobs(REPLY, QUESTION);
  const seed = await seedPlanProgress(`${slug}-${Date.now()}`);
  await stubAiAccess(page);
  await routeJobStream(page, sse);
  await signIn(page, seed.reader.email, PLAN_PROGRESS_PASSWORD);
  if (locale !== 'en') {
    // Set BEFORE the run opens: switching a signed-in reader's language is a
    // navigation, which would remount the rail and drop the rows it drew.
    await setReaderLanguage(page, seed.reader.email, locale);
  }
  const planId = await askHosted(page, sse, seed);
  if (locale !== 'en') {
    await expect(page.locator('html')).toHaveAttribute('lang', locale, { timeout: FIRST_PAINT_MS });
  }
  const refs = await layLevel(planId, seed, titles);
  return { seed, hosted: { planId, refs } };
}

/** Write each card's `card_checked` and assert the record grew by exactly that
 *  card's row — drawn because ITS frame arrived — before the next is written. */
async function checkLevel(
  page: Page,
  sse: SseFrameServer,
  hosted: Hosted,
  level: readonly { title: string; count: number }[],
  locale: Locale,
  beat: () => Promise<void>,
): Promise<void> {
  for (const [i, card] of level.entries()) {
    writeFact(
      sse,
      'claim_check',
      'card_checked',
      { title: card.title, count: card.count },
      hosted.refs.get(card.title)!,
    );
    await expect(factRows(page)).toHaveCount(i + 1, { timeout: 4 * POLL_MS });
    const row = factRows(page).nth(i);
    await expect(row).toContainText(cardCheckedLine(locale, card.title, card.count));
    await expect(row).not.toContainText(genericLine(locale));
    await beat();
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

test('the progress rail draws one line per card checked as each card’s check lands, then the level’s held line', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-11494');
  let hosted!: Hosted;

  await chapter('Ask Motir AI for a plan — the planner lays a level of three cards', async () => {
    ({ hosted } = await openRun(
      page,
      sse,
      'claim-check',
      LEVEL.map((c) => c.title),
    ));
    await showCanvas(page);
    for (const card of LEVEL) {
      await expect(node(page, card.title)).toBeVisible({ timeout: 4 * POLL_MS });
    }
    // The check has written nothing yet: the record holds only the run's opening act
    // (`firstAct`'s `submitted`), and no fact row.
    await expect(acts(page)).toBeVisible();
    await expect(factRows(page)).toHaveCount(0);
    await beat();
  });

  await chapter('The planner checks each card’s code names — one line per card', async () => {
    await checkLevel(page, sse, hosted, LEVEL, 'en', beat);
    // Exactly one row per card, each naming its own card.
    await expect(factRows(page)).toHaveCount(LEVEL.length);
    for (const [i, card] of LEVEL.entries()) {
      await expect(factRows(page).nth(i)).toContainText(card.title);
    }
  });

  await chapter('The level closes — every card’s code names held', async () => {
    writeFact(sse, 'claim_check', 'held', { count: 0 });
    await expect(factRows(page)).toHaveCount(LEVEL.length + 1, { timeout: 4 * POLL_MS });
    await expect(factRows(page).nth(LEVEL.length)).toContainText(say('en', 'fact.claimCheck.held'));
    // The per-card rows are all still on the record, above the held line.
    for (const [i, card] of LEVEL.entries()) {
      await expect(factRows(page).nth(i)).toContainText(
        cardCheckedLine('en', card.title, card.count),
      );
    }
    await expectNoGenericRow(factRows(page), 'en');
    await beat();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SEND-BACK
// ─────────────────────────────────────────────────────────────────────────────

test('a level that sends two cards back draws the sent-back line reading 2, and its findings draw no rows', async ({
  page,
  beat,
}) => {
  const { hosted } = await openRun(
    page,
    sse,
    'claim-check-sent-back',
    SENT_BACK_LEVEL.map((c) => c.title),
  );
  await expect(factRows(page)).toHaveCount(0);
  await checkLevel(page, sse, hosted, SENT_BACK_LEVEL, 'en', beat);

  const sentBack = SENT_BACK_LEVEL.filter((c) => c.count > 0);
  expect(sentBack).toHaveLength(2);
  writeFact(sse, 'claim_check', 'sent_back', {
    count: sentBack.length,
    cards: sentBack.map((card) => ({
      ref: hosted.refs.get(card.title)!,
      findings: [
        {
          kind: 'path_missing',
          path: 'lib/export/gone.ts',
          detail: '`lib/export/gone.ts` is not on origin/main in `motir-core`.',
        },
      ],
    })),
  });

  // ONE more row — the sent-back line; the findings in its params are not rows.
  await expect(factRows(page)).toHaveCount(SENT_BACK_LEVEL.length + 1, { timeout: 4 * POLL_MS });
  const line = factRows(page).nth(SENT_BACK_LEVEL.length);
  await expect(line).toContainText(say('en', 'fact.claimCheck.sentBack', { count: 2 }));
  await expect(line).not.toContainText('lib/export/gone.ts');
  await expect(acts(page)).not.toContainText('path_missing');
  await expectNoGenericRow(factRows(page), 'en');
  await beat();
});

// ─────────────────────────────────────────────────────────────────────────────
// IN DUTCH
// ─────────────────────────────────────────────────────────────────────────────

test('with the reader’s language Dutch, each per-card line is the Dutch catalogue’s line for its card', async ({
  page,
  beat,
}) => {
  const { hosted } = await openRun(
    page,
    sse,
    'claim-check-nl',
    LEVEL.map((c) => c.title),
    'nl',
  );
  await expect(factRows(page)).toHaveCount(0);
  await checkLevel(page, sse, hosted, LEVEL, 'nl', beat);
  for (const [i, card] of LEVEL.entries()) {
    const row = factRows(page).nth(i);
    await expect(row).toContainText(cardCheckedLine('nl', card.title, card.count));
    // Not the English line: the row is worded by the reader's catalogue.
    await expect(row).not.toContainText(cardCheckedLine('en', card.title, card.count));
  }
  await expectNoGenericRow(factRows(page), 'nl');
});
