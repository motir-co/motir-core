import { readFileSync, writeFileSync } from 'node:fs';
import { expect, type Locator, type Page, type Request, type Response } from '@playwright/test';
import { adminDb } from './db-reset';
import { latestPlanningSession } from './planChangeConversation';
import { askFromCard } from './plan-narration-doors';
import type { SseFrameServer } from './sse-frame-server';
import type { SharpenQuestion } from '@/lib/ai/types';
import type { SharpenSettleResult } from '@/lib/dto/sharpen';
import type { SharpenedRequirementDto } from '@/lib/dto/plans';
import type { SharpenControl, SharpenTargetFixture } from '@/lib/test-sharpen-mock';
import { escapeRegExp } from '@/lib/utils/regexp';
import en from '@/messages/en.json';

// THE "GRILL ME" JOURNEY, shared by its two specs (Task MOTIR-1101 · Subtask
// MOTIR-8179): `cloud-grill-me.spec.ts` (the regression cases, every PR) and
// `regression-grill-me.spec.ts` (the story's watchable receipt). Specs never
// import each other, so the fixture writer, the locators, the ask and the
// authoritative reads live here.
//
// ── What is real, and what is SCRIPTED ──────────────────────────────────────
// The run is REAL: the person asks from a card's composer, so the anchored door
// `POST /api/work-items/{key}/ai/plan` opens a real `plan` job, session and
// `generating` plan row. Its job stream is re-targeted at a runner-local SSE
// server (`sse-frame-server.ts`, MOTIR-7982's seam) that holds the run in its
// CONVERSATION PHASE until the spec writes `target_settled` — the frame that
// ends that phase (`lib/planning/planRunPhase.ts`).
//
// The grilling is the REAL Sharpen door (`POST /api/ai/sharpen`, its settle) and
// core's REAL write-back (`PUT /api/internal/ai/plan-sharpening`), with motir-ai's
// `sharpen_turn` played by the Sharpen seam (`lib/test-sharpen-mock.ts`) from a
// SCRIPT this file writes. So no case asserts which question motir-ai would
// choose — that is motir-ai's to prove (MOTIR-8178); every question here is the
// script's own.

// ── The control file the Sharpen seam reads ──────────────────────────────────

function controlPath(): string {
  const p = process.env['MOTIR_AI_SHARPEN_CONTROL_PATH'];
  if (!p) throw new Error('MOTIR_AI_SHARPEN_CONTROL_PATH is not set for this lane');
  return p;
}

/** Declare how every Sharpen session in the test behaves. Keyed as `default`
 *  because the run's plan id is not known until the person has asked. */
export function declareSharpen(fixture: SharpenTargetFixture): void {
  const control: SharpenControl = { default: fixture, submitted: [], writeBacks: [] };
  writeFileSync(controlPath(), JSON.stringify(control, null, 2));
}

/** What the seam recorded: every `sharpen_turn` submit and every write-back. */
export function readSharpen(): SharpenControl {
  return JSON.parse(readFileSync(controlPath(), 'utf8')) as SharpenControl;
}

// ── The script ───────────────────────────────────────────────────────────────

export const ASK = 'Let people export their board as CSV.';
export const PLANNER_REPLY = 'Here is what I looked at.';
export const PLANNER_QUESTION = 'Should the export include archived cards?';
export const PLANNER_ANSWER = 'No, leave archived cards out.';

const reading = (id: string, label: string, detail: string, recommended = false) => ({
  id,
  label,
  detail,
  recommended,
});

export const Q1: SharpenQuestion = {
  id: 'q-trigger',
  text: 'Where does a person start the export?',
  topic: 'workflow',
  because: null,
  quote: null,
  readings: [
    reading('r-board-menu', 'From the board menu', 'One entry, beside the board settings.', true),
    reading('r-toolbar', 'From a toolbar button', 'Always visible above the columns.'),
    reading('r-shortcut', 'From a keyboard shortcut', 'Fast, but hidden from new people.'),
  ],
};

export const Q2: SharpenQuestion = {
  id: 'q-columns',
  text: 'Which columns does the file carry?',
  topic: 'alternative',
  because: 'From the board menu',
  quote: null,
  readings: [
    reading(
      'r-visible',
      'Only the visible columns',
      'What the person sees is what they get.',
      true,
    ),
    reading('r-all', 'Every field', 'Complete, but wide.'),
  ],
};

export const Q3: SharpenQuestion = {
  id: 'q-large',
  text: 'What happens when the board has thousands of cards?',
  topic: 'non_happy',
  because: null,
  quote: null,
  readings: [
    reading('r-email', 'Email a link when it is ready', 'Nobody waits on a spinner.', true),
    reading('r-cap', 'Cap it at 1,000 rows', 'Simple, and says so.'),
  ],
};

export const Q4: SharpenQuestion = {
  id: 'q-format',
  text: 'Which delimiter does the file use?',
  topic: 'technical_thread',
  because: null,
  quote: 'as CSV',
  readings: [
    reading('r-comma', 'A comma', 'What CSV means to most tools.', true),
    reading('r-semicolon', 'A semicolon', 'What some spreadsheet locales expect.'),
  ],
};

export const SCRIPT: SharpenTargetFixture = { mode: 'scripted', questions: [Q1, Q2, Q3, Q4] };

/** The script's recommended reading — what a skip or "You decide" assumes. */
export const recommended = (q: SharpenQuestion) => q.readings.find((r) => r.recommended)!;

// ── The copy, from the catalogue ─────────────────────────────────────────────

export const COPY = {
  control: en.planningWorkspace.grill.control,
  sharpen: en.sharpen,
} as const;

// ── Locators — every one scoped to a role-resolved subtree ───────────────────

export const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
export const workspace = (page: Page) => page.getByRole('dialog').filter({ has: rail(page) });
export const composer = (page: Page) => rail(page).getByRole('textbox');
export const entrance = (page: Page) =>
  page.getByRole('main').getByTestId('work-item-plan-entrance');
export const grillToggle = (page: Page) => rail(page).getByTestId('grill-me-toggle');
export const grillSwitch = (page: Page) => grillToggle(page).getByRole('switch');
export const grillHelp = (page: Page) => rail(page).getByTestId('grill-me-help');
/** The popover is portalled out of the rail, so it is found by its role and name. */
export const grillExplanation = (page: Page) =>
  page.getByRole('dialog', { name: COPY.control.popover.title });
export const question = (page: Page) => rail(page).getByTestId('sharpen-question');
export const readingButton = (page: Page, readingId: string) =>
  question(page).getByTestId(`sharpen-reading-${readingId}`);
export const thread = (page: Page) => rail(page).getByTestId('sharpen-thread');
export const summary = (page: Page) => rail(page).getByTestId('sharpen-summary');
export const conversationPhase = (page: Page) => rail(page).getByTestId('plan-conversation-phase');
export const handoff = (page: Page) => rail(page).getByTestId('plan-handoff');
/** The card's description as the item page renders it. */
export const cardDescription = (page: Page) =>
  page.getByRole('main').getByLabel('Work item description');

// ── The door signals ─────────────────────────────────────────────────────────

const isSharpenDoor = (r: Request): boolean =>
  r.method() === 'POST' && new URL(r.url()).pathname === '/api/ai/sharpen';

/** Every POST to the Sharpen door the page makes from now on. */
export function recordSharpenPosts(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (r) => {
    if (isSharpenDoor(r)) seen.push(r);
  });
  return seen;
}

/** The NEXT Sharpen-door POST's response. Arm it BEFORE the action. */
export function sharpenDoorAnswered(page: Page): Promise<Response> {
  return page.waitForResponse((r) => isSharpenDoor(r.request()));
}

/** The NEXT settle that STORED a turn (`settled` / `failed`, never `pending`) —
 *  the authoritative end of one grilling act. Arm it BEFORE the action. */
export function sharpenTurnSettled(page: Page): Promise<SharpenSettleResult> {
  return page
    .waitForResponse(async (r) => {
      if (r.request().method() !== 'POST') return false;
      if (new URL(r.url()).pathname !== '/api/ai/sharpen/settle') return false;
      try {
        return ((await r.json()) as SharpenSettleResult).outcome !== 'pending';
      } catch {
        return false;
      }
    })
    .then(async (r) => (await r.json()) as SharpenSettleResult);
}

/** The NEXT poll of the run's own plan — a later signal than any render of the
 *  phase it polls in, used before an ABSENCE is asserted. */
export function planPolled(page: Page, planId: string): Promise<Response> {
  return page.waitForResponse(
    (r) =>
      r.request().method() === 'GET' &&
      r.ok() &&
      new URL(r.url()).pathname === `/api/plans/${planId}`,
  );
}

// ── The journey's steps ──────────────────────────────────────────────────────

/** Open the planning overlay from a card — the run will be anchored on it. */
export async function openPlanningFromCard(page: Page, key: string, timeout: number) {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout });
  await entrance(page).click();
  await page.waitForURL((url) => url.searchParams.has('plan'));
  await expect(rail(page)).toBeVisible({ timeout });
}

/** Ask from the card's composer; the run's stream has reached the frame server
 *  when this returns, so the run is in its conversation phase. Answers the
 *  plan the run is writing. */
export async function ask(
  page: Page,
  sse: SseFrameServer,
  email: string,
  text: string,
): Promise<{ planId: string; sessionId: string }> {
  await askFromCard(page, sse, composer(page), text);
  const session = await latestPlanningSession(email);
  const plan = await adminDb.plan.findFirstOrThrow({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
  });
  return { planId: plan.id, sessionId: session.id };
}

let frameSeq = 0;

/** The run settles what it is planning: its conversation phase is over. */
export async function settleTarget(page: Page, sse: SseFrameServer): Promise<void> {
  frameSeq += 1;
  sse.write('target_settled', { seq: 1_000 + frameSeq });
  await expect(handoff(page)).toBeVisible();
}

/** One grilling act — a click — and the stored turn it produced. */
export async function act(page: Page, press: Locator): Promise<SharpenSettleResult> {
  const settled = sharpenTurnSettled(page);
  await press.click();
  return settled;
}

// ── The authoritative reads ──────────────────────────────────────────────────

/** The plan's sharpened requirement. Read from the row: the requirement has NO
 *  rendered surface anywhere in the product (no page draws it), so there is no
 *  UI to assert it through — the plan row is the authority the run plans from. */
export async function planRequirement(planId: string): Promise<SharpenedRequirementDto | null> {
  const plan = await adminDb.plan.findUniqueOrThrow({
    where: { id: planId },
    select: { sharpenedRequirement: true },
  });
  return (plan.sharpenedRequirement as SharpenedRequirementDto | null) ?? null;
}

/** The card's stored description — the "unchanged" baseline. */
export async function cardBody(key: string): Promise<string | null> {
  const item = await adminDb.workItem.findFirstOrThrow({
    where: { identifier: key },
    select: { descriptionMd: true },
  });
  return item.descriptionMd;
}

/** The line a settled answer lands as, in the requirement and on the card. */
export const answerLine = (q: SharpenQuestion, label: string) => `${q.text} — ${label}`;
/** The line a planner assumption lands as on the card. */
export const assumptionLine = (q: SharpenQuestion) =>
  `Planner's assumption — ${q.text} — ${recommended(q).label}`;

/** The card page, loaded fresh: the answers sit under "Acceptance criteria" and
 *  the planner's assumptions under "Assumptions", in that order. */
export async function expectCardCarries(
  page: Page,
  key: string,
  answers: readonly string[],
  assumptions: readonly string[],
  timeout: number,
): Promise<void> {
  await page.goto(`/items/${key}`);
  const body = cardDescription(page);
  await expect(body).toBeVisible({ timeout });
  await expect(body.getByRole('heading', { name: 'Acceptance criteria' })).toBeVisible();
  await expect(body.getByRole('heading', { name: 'Assumptions' })).toBeVisible();
  const pattern = new RegExp(
    [
      'Acceptance criteria',
      ...answers.map(escapeRegExp),
      'Assumptions',
      ...assumptions.map(escapeRegExp),
    ].join('[\\s\\S]*'),
  );
  await expect(body).toHaveText(pattern);
}
