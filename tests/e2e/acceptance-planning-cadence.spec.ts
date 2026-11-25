// Acceptance E2E — Planning cadence and the person's Stop, end to end in a browser
// (Story MOTIR-12203 · Subtask MOTIR-12216).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// 1. Settings › AI planning: Planning cadence reads Story on a project that never
//    saved one; Subtask and then Story each survive a reload; a member without
//    ai:configure sees it read-only; in German the label and options are German.
// 2. A plan started after Subtask is saved leaves with `planningCadence: 'subtask'`.
// 3. A story planned one step at a time: its subtasks are laid (title and Scope
//    BOUNDARY only), the plan offers Approve and no Resume, and after Approve the
//    subtasks sit in To plan and are not ready work.
// 4. A subtask: one fully written card; after Approve it does not read To plan.
// 5. An epic: only the first story is written; after Approve everything else it
//    proposed reads To plan.
// 6. Story again: the job carries `story`, and a complete plan offers Approve.
// 7. Stop while a card is half written: Approve and no Resume, the half-written
//    card back to its title and boundary, To plan after Approve while the finished
//    cards keep their bodies. Stop before anything finished: nothing to review,
//    and the person is told the plan was discarded.
//
// ── HOW THE PLANNER IS PLAYED, AND WHAT IS NOT CLAIMED ───────────────────────
//
// The lane runs no model: its motir-ai is the jobs mock (`lib/test-ai-jobs-mock.ts`),
// which records each submit — now with the `planningCadence` its context carried. So
// this spec does NOT assert which sessions a walk ran (asserted against the mock, that
// would test the harness); motir-ai's own engine tests prove the walk. It asserts the
// cadence on the submitted job, and plays the hosted planner's writes and close at the
// doors it crosses into motir-core, with the payloads motir-ai sends. Copied from
// motir-ai `parent/MOTIR-12203-planning-cadence` (motir-ai#1150, unmerged when this
// spec was written; the cards' commits named):
//   · the lay's `add` — title, kind and the Scope BOUNDARY body, under its parent and
//     with its edges: `POST /api/internal/ai/plan-proposals` (`appendProposals`,
//     `src/core/coreClient.ts`), the adds `src/jobs/jobPlanWriter.ts` builds;
//   · an author's body and its finished stamp: `PATCH /api/internal/ai/plan-proposals/
//     <id>` (`updateProposal` and `writeAuthorFinished`, `jobPlanWriter.ts`); a
//     committed card's author sends a `modify` through the append door instead;
//   · the cadence end, `walkEndedBy: 'cadence'` on the final append
//     (`walkEndOf`, `src/jobs/planningEngine.ts`, MOTIR-12208 at 4889eea);
//   · the Stop: ONE batch correction putting each cut-off card back to the snapshot
//     taken before its session first wrote it, `authorFinished` cleared
//     (`restore` / `restoreCorrectionOf`, `jobPlanWriter.ts`, `PATCH
//     /api/internal/ai/plan-proposals` via `correctProposals`), then the final append
//     with `walkEndedBy: 'person_stop'` (`planningEngine.ts`, MOTIR-12209 at 1774aac).
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
//
// Each settings save by its PATCH's 200 before the reload; each plan by the review
// read (`planPolled`) that shows it `planned`; Approve by the approve door's 200; the
// board by its own projection read (`getFullBoard`), then the rendered column; Stop by
// the stop door's response. `chapter()` / `beat()` holds are pacing only.

import type { Locator, Page, Response } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { columnByStatus, getFullBoard } from './_helpers/board';
import { seedPlanProgress, type PlanProgressSeed } from './_helpers/plan-progress-seed';
import { startSseFrameServer, type SseFrameServer } from './_helpers/sse-frame-server';
import {
  askFromCard,
  declareJobs,
  latestPlanJob,
  routeJobStream,
  stubAiAccess,
  type HostedJob,
} from './_helpers/plan-narration-doors';
import {
  asSecondPerson,
  composer,
  openFromCard,
  planPolled,
  rail,
} from './_helpers/plan-progress-harness';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import { saveAccountLanguageInSettings } from './_helpers/i18n-walk';
import { E2E_CORE_CALLBACK_SECRET } from './_helpers/log-bug-as-ai';
import { workItemsService } from '@/lib/services/workItemsService';
import { escapeRegExp } from '@/lib/utils/regexp';
import en from '@/messages/en.json';
import de from '@/messages/de.json';

test.describe.configure({ timeout: 600_000 });

const ASK = 'Plan the next step of this work.';
const REPLY = 'Here is the plan.';
const QUESTION = 'Anything else to cover?';

// The WIRE STRING, written out rather than imported: motir-ai reads this literal.
const WIRE_KEY = 'planningCadence';

const SETTINGS = '/settings/project/ai-planning';
const planner = en.settings.aiPlanning.planner;
const SAVE = en.settings.aiPlanning.footer.save;
const APPROVE = en.approvalGate.planApproval.surface.approve;
const STOPPED_BAR = en.approvalGate.statusHeld.planState.stopped;

const boundary = (owns: string) => `## Scope BOUNDARY\n\n${owns}`;
const written = (what: string, owns: string) =>
  `${what}\n\n**Difficulty: low** — one change.\n\n${boundary(owns)}`;

// ── Locators ────────────────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
const cadenceGroup = (page: Page) => main(page).getByRole('radiogroup');
const option = (page: Page, label: string) =>
  cadenceGroup(page).getByRole('radio', { name: new RegExp(`^${escapeRegExp(label)}`) });
const saveButton = (page: Page) => main(page).getByRole('button', { name: SAVE, exact: true });
const bar = (overlay: Locator) => overlay.getByTestId('plan-change-confirm-bar');
const approveButton = (overlay: Locator) =>
  bar(overlay).getByRole('button', { name: APPROVE, exact: true });
const proposalList = (overlay: Locator) => overlay.getByTestId('plan-proposal-list');
const peek = (page: Page) => page.getByRole('dialog').getByTestId('proposal-peek');
const peekBody = (page: Page) =>
  peek(page).locator(`[aria-label="${en.issueViews.issueDescriptionAria}"]`);
const stopButton = (page: Page) => rail(page).getByTestId('plan-change-stop');

// ── The jobs mock's record ──────────────────────────────────────────────────

/** The `planningCadence` the jobs mock recorded on the NEWEST plan submit. */
function recordedCadence(): unknown {
  const fixture = JSON.parse(readFileSync(process.env['MOTIR_AI_JOBS_FIXTURE_PATH']!, 'utf8')) as {
    submitted?: { kind: string; [WIRE_KEY]?: unknown }[];
  };
  const plan = (fixture.submitted ?? []).filter((s) => s.kind === 'plan').at(-1);
  expect(plan, 'the jobs mock recorded a plan submit').toBeDefined();
  return plan![WIRE_KEY];
}

// ── The hosted planner's doors ──────────────────────────────────────────────

const doorHeaders = (job: HostedJob) => ({
  authorization: `Bearer ${E2E_CORE_CALLBACK_SECRET}`,
  'x-motir-job-token': job.token,
});

async function ok(res: Promise<import('@playwright/test').APIResponse>, door: string) {
  const r = await res;
  if (r.status() !== 200) throw new Error(`${door} answered ${r.status()}: ${await r.text()}`);
  return r.json() as Promise<Record<string, unknown>>;
}

interface Lay {
  title: string;
  kind: 'story' | 'task' | 'subtask';
  owns: string;
  parentRef: string;
  blockedByRefs?: string[];
}

/** The lay's appends, one at a time so an edge can name an earlier card. */
async function lay(page: Page, job: HostedJob, cards: Lay[]): Promise<string[]> {
  const ids: string[] = [];
  for (const c of cards) {
    const body = await ok(
      page.request.post('/api/internal/ai/plan-proposals', {
        headers: doorHeaders(job),
        data: {
          jobId: job.jobId,
          proposals: [
            {
              op: 'add',
              proposedFields: { title: c.title, kind: c.kind, descriptionMd: boundary(c.owns) },
              parentRef: c.parentRef,
              ...(c.blockedByRefs ? { blockedByRefs: c.blockedByRefs } : {}),
            },
          ],
        },
      }),
      'plan-proposals (lay)',
    );
    ids.push((body['planItemIds'] as string[])[0]!);
  }
  return ids;
}

/** An author session's write of a proposal's body — finished, or cut off. */
function author(page: Page, job: HostedJob, planItemId: string, body: string, finished: boolean) {
  return ok(
    page.request.patch(`/api/internal/ai/plan-proposals/${planItemId}`, {
      headers: doorHeaders(job),
      data: {
        jobId: job.jobId,
        patch: { descriptionMd: body, ...(finished ? { authorFinished: true } : {}) },
      },
    }),
    'plan-proposals (author)',
  );
}

/** The final append: `walkEndedBy` when the walk ended on purpose, nothing otherwise. */
function close(page: Page, job: HostedJob, walkEndedBy?: 'cadence' | 'person_stop') {
  return ok(
    page.request.post('/api/internal/ai/plan-proposals', {
      headers: doorHeaders(job),
      data: {
        jobId: job.jobId,
        proposals: [],
        final: true,
        ...(walkEndedBy ? { walkEndedBy } : {}),
      },
    }),
    'plan-proposals (close)',
  );
}

// ── The person's surfaces ───────────────────────────────────────────────────

const isSettingsSave = (key: string) => (r: Response) =>
  r.request().method() === 'PATCH' &&
  new URL(r.url()).pathname === `/api/projects/${key}/ai-settings`;

async function openSettings(page: Page): Promise<void> {
  await page.goto(SETTINGS);
  await expect(cadenceGroup(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
}

async function expectCadence(page: Page, label: string): Promise<void> {
  await expect(option(page, label)).toHaveAttribute('aria-checked', 'true');
}

/** Choose a cadence, save, await the PATCH's 200, reload, and read it back. */
async function saveCadence(page: Page, key: string, label: string): Promise<void> {
  await option(page, label).click();
  const saved = page.waitForResponse(isSettingsSave(key));
  await saveButton(page).click();
  expect((await saved).status()).toBe(200);
  await page.reload();
  await expect(cadenceGroup(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expectCadence(page, label);
}

/** Ask on a card from its composer; the run's stream is held open by the frame
 *  server, so nothing settles the job but the doors this spec plays. */
async function startPlan(
  page: Page,
  sse: SseFrameServer,
  seed: PlanProgressSeed,
  key: string,
): Promise<{ planId: string; job: HostedJob }> {
  await openFromCard(page, key);
  await askFromCard(page, sse, composer(page), ASK);
  const job = latestPlanJob();
  const plan = await adminDb.plan.findFirstOrThrow({ where: { sourceJobId: job.jobId } });
  expect(plan.status).toBe('generating');
  expect(plan.projectId).toBe(seed.projectId);
  return { planId: plan.id, job };
}

/** The plan, once its review read says `planned`, opened on its list. */
async function openPlanned(page: Page, planId: string): Promise<Locator> {
  const polled = planPolled(page, planId, (b) => b.status === 'planned');
  const overlay = await openUndecidedPlan(page, planId, { view: 'list' });
  await polled;
  await expect(proposalList(overlay)).toBeVisible();
  return overlay;
}

/** Approve is offered, and the bar is not a stopped plan's (no Resume owed). */
async function expectApproveNoResume(overlay: Locator): Promise<void> {
  await expect(approveButton(overlay)).toBeEnabled();
  await expect(bar(overlay)).not.toHaveAttribute('data-plan-state', 'stopped');
  await expect(overlay.getByText(STOPPED_BAR)).toHaveCount(0);
}

/** A proposal's body in its peek: what it must show, and what it must not. */
async function expectBody(
  overlay: Locator,
  title: string,
  shows: string,
  hides: string | null,
): Promise<void> {
  const page = overlay.page();
  await proposalList(overlay)
    .getByRole('button', { name: new RegExp(`· ${escapeRegExp(title)}$`) })
    .first()
    .click();
  await expect(peek(page)).toBeVisible();
  await expect(peekBody(page)).toContainText(shows);
  if (hides) await expect(peekBody(page)).not.toContainText(hides);
  await page.keyboard.press('Escape');
  await expect(peek(page)).toHaveCount(0);
}

async function approve(page: Page, overlay: Locator, planId: string): Promise<void> {
  const answered = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/plans/${planId}/approve` &&
      r.request().method() === 'POST',
  );
  await approveButton(overlay).click();
  expect((await answered).status()).toBe(200);
  await expect
    .poll(async () => (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status)
    .toBe('approved');
}

/** The created work item of each proposal, by title. */
async function created(planId: string, title: string) {
  const item = await adminDb.planItem.findFirstOrThrow({
    where: { planId, proposedFields: { path: ['title'], equals: title } },
  });
  return adminDb.workItem.findUniqueOrThrow({ where: { id: item.workItemId! } });
}

/** On the board: these cards are in To plan, drawn in that column, and none is ready. */
async function expectToPlan(page: Page, seed: PlanProgressSeed, keys: string[]): Promise<void> {
  const board = await getFullBoard(page.request);
  const toPlan = columnByStatus(board, 'to_plan');
  const inColumn = toPlan.cards.map((c) => c.identifier);
  for (const key of keys) expect(inColumn).toContain(key);

  const ready = await workItemsService.listReady(seed.projectId, {}, seed.reader.ctx);
  const readyKeys = ready.items.map((i) => i.key);
  for (const key of keys) expect(readyKeys).not.toContain(key);

  await page.goto('/boards');
  const column = main(page).getByTestId(`board-column-${toPlan.id}`);
  await expect(column).toBeVisible({ timeout: FIRST_PAINT_MS });
  await column.scrollIntoViewIfNeeded();
  for (const key of keys) await expect(column.getByTestId(`board-card-${key}`)).toBeVisible();
}

// ═══ The recorded walk ═══════════════════════════════════════════════════════

let sse: SseFrameServer;

test.beforeEach(async () => {
  await resetDatabase();
  declareJobs(REPLY, QUESTION);
  sse = await startSseFrameServer();
});

test.afterEach(async () => {
  await sse.close();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

test('a project plans a story at a time or a subtask at a time, and Stop proposes what finished', async ({
  page,
  browser,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-12203');

  const seed = await seedPlanProgress(`cadence-${Date.now()}`);
  const epic = await adminDb.workItem.findFirstOrThrow({
    where: { projectId: seed.projectId, kind: 'epic' },
  });
  const leaf = await workItemsService.createWorkItem(
    {
      projectId: seed.projectId,
      kind: 'subtask',
      title: 'Show the progress receipt link',
      parentId: seed.storyId,
    },
    seed.reader.ctx,
  );
  await stubAiAccess(page);
  await routeJobStream(page, sse);
  await signIn(page, seed.reader.email, 'plan-progress-e2e-pass-7');

  // ── 1. The setting ──────────────────────────────────────────────────────
  await chapter('Planning cadence reads Story on a project that never saved one', async () => {
    await openSettings(page);
    await expect(cadenceGroup(page)).toContainText(planner.cadenceLabel);
    await expectCadence(page, planner.cadence.story.label);
    await expect(option(page, planner.cadence.subtask.label)).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await beat();
  });

  await chapter('Switch to Subtask and back to Story — each survives a reload', async () => {
    await saveCadence(page, seed.projectKey, planner.cadence.subtask.label);
    await beat();
    await saveCadence(page, seed.projectKey, planner.cadence.story.label);
    await beat();
    await saveCadence(page, seed.projectKey, planner.cadence.subtask.label);
  });

  await chapter('A member without ai:configure sees it read-only', async () => {
    const member = await asSecondPerson(browser, baseURL!, seed.teammate.email);
    try {
      await openSettings(member.page);
      await expectCadence(member.page, planner.cadence.subtask.label);
      for (const label of [planner.cadence.story.label, planner.cadence.subtask.label]) {
        await expect(option(member.page, label)).toHaveAttribute('aria-disabled', 'true');
      }
      await option(member.page, planner.cadence.story.label).click({ force: true });
      await expectCadence(member.page, planner.cadence.subtask.label);
      await expect(saveButton(member.page)).toHaveCount(0);
    } finally {
      await member.close();
    }
  });

  await chapter('In German, the label and both options are German', async () => {
    const g = de.settings.aiPlanning.planner;
    await saveAccountLanguageInSettings(page, 'de');
    await openSettings(page);
    await expect(cadenceGroup(page)).toContainText(g.cadenceLabel);
    await expect(cadenceGroup(page)).not.toContainText(planner.cadenceLabel);
    await expect(option(page, g.cadence.story.label)).toBeVisible();
    await expect(option(page, g.cadence.subtask.label)).toHaveAttribute('aria-checked', 'true');
    await beat();
    await saveAccountLanguageInSettings(page, 'en');
  });

  // ── 2–3. A story, one step at a time ────────────────────────────────────
  const S1 = 'Write the receipt exporter';
  const S2 = 'Link the receipt from the card';
  let storyPlan = '';
  await chapter(
    'Subtask cadence: the story’s plan leaves with planningCadence subtask',
    async () => {
      const run = await startPlan(page, sse, seed, seed.storyKey);
      storyPlan = run.planId;
      expect(recordedCadence()).toBe('subtask');
      // The hosted Subtask walk on a story: its subtasks laid, the walk ends.
      const [s1] = await lay(page, run.job, [
        { title: S1, kind: 'subtask', owns: 'Owns the exporter.', parentRef: seed.storyId },
      ]);
      await lay(page, run.job, [
        {
          title: S2,
          kind: 'subtask',
          owns: 'Owns the link.',
          parentRef: seed.storyId,
          blockedByRefs: [`planItem:${s1!}`],
        },
      ]);
      await close(page, run.job, 'cadence');
      const overlay = await openPlanned(page, storyPlan);
      await expectApproveNoResume(overlay);
      await expectBody(overlay, S1, 'Owns the exporter.', 'Difficulty');
      await expectBody(overlay, S2, 'Owns the link.', 'Difficulty');
      await beat();
    },
  );

  await chapter(
    'Approve: every proposed subtask sits in To plan, and none is ready work',
    async () => {
      const overlay = await openPlanned(page, storyPlan);
      await approve(page, overlay, storyPlan);
      const keys = [
        (await created(storyPlan, S1)).identifier,
        (await created(storyPlan, S2)).identifier,
      ];
      await expectToPlan(page, seed, keys);
      await beat();
    },
  );

  // ── 4. A subtask ────────────────────────────────────────────────────────
  await chapter('Subtask cadence on a subtask: one fully written card', async () => {
    const run = await startPlan(page, sse, seed, leaf.identifier);
    expect(recordedCadence()).toBe('subtask');
    const BODY = written('Render the receipt link under the card title.', 'Owns the link.');
    await ok(
      page.request.post('/api/internal/ai/plan-proposals', {
        headers: doorHeaders(run.job),
        data: {
          jobId: run.job.jobId,
          proposals: [{ op: 'modify', workItemId: leaf.id, patch: { descriptionMd: BODY } }],
        },
      }),
      'plan-proposals (author a committed card)',
    );
    await close(page, run.job, 'cadence');
    const overlay = await openPlanned(page, run.planId);
    await expectApproveNoResume(overlay);
    await expect(proposalList(overlay)).toContainText(leaf.title);
    await approve(page, overlay, run.planId);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: leaf.id } });
    expect(after.status).not.toBe('to_plan');
    expect(after.descriptionMd).toContain('Render the receipt link');
    await beat();
  });

  // ── 5. An epic ──────────────────────────────────────────────────────────
  const E1 = 'Export the receipts';
  const E2 = 'Share the receipts';
  const E1A = 'Pick the receipt format';
  const E1B = 'Stream the receipt file';
  await chapter('Subtask cadence on an epic: only the first story is written', async () => {
    const run = await startPlan(page, sse, seed, epic.identifier);
    expect(recordedCadence()).toBe('subtask');
    const [e1] = await lay(page, run.job, [
      { title: E1, kind: 'story', owns: 'Owns the export.', parentRef: epic.id },
      { title: E2, kind: 'story', owns: 'Owns the sharing.', parentRef: epic.id },
    ]);
    await author(
      page,
      run.job,
      e1!,
      written('Receipts export as one file.', 'Owns the export.'),
      true,
    );
    await lay(page, run.job, [
      { title: E1A, kind: 'subtask', owns: 'Owns the format.', parentRef: `planItem:${e1!}` },
      { title: E1B, kind: 'subtask', owns: 'Owns the stream.', parentRef: `planItem:${e1!}` },
    ]);
    await close(page, run.job, 'cadence');
    const overlay = await openPlanned(page, run.planId);
    await expectApproveNoResume(overlay);
    await expectBody(overlay, E1, 'Receipts export as one file.', null);
    await expectBody(overlay, E2, 'Owns the sharing.', 'Difficulty');
    await beat();
    await approve(page, overlay, run.planId);
    expect((await created(run.planId, E1)).status).not.toBe('to_plan');
    const laid = await Promise.all([E2, E1A, E1B].map((t) => created(run.planId, t)));
    await expectToPlan(
      page,
      seed,
      laid.map((c) => c.identifier),
    );
    await beat();
  });

  // ── 6. Story again ──────────────────────────────────────────────────────
  await chapter(
    'Back to Story: the job carries story, and a whole plan reads as today',
    async () => {
      await openSettings(page);
      await saveCadence(page, seed.projectKey, planner.cadence.story.label);
      const run = await startPlan(page, sse, seed, epic.identifier);
      expect(recordedCadence()).toBe('story');
      const [only] = await lay(page, run.job, [
        {
          title: 'Archive old receipts',
          kind: 'story',
          owns: 'Owns archiving.',
          parentRef: epic.id,
        },
      ]);
      await author(
        page,
        run.job,
        only!,
        written('Receipts older than a year move.', 'Owns archiving.'),
        true,
      );
      await close(page, run.job);
      const overlay = await openPlanned(page, run.planId);
      await expectApproveNoResume(overlay);
      await beat();
    },
  );

  // ── 7. Stop mid-walk ────────────────────────────────────────────────────
  const D1 = 'Count the receipts';
  const D2 = 'Name each receipt';
  const D3 = 'Sign each receipt';
  const HALF = 'Signatures use the workspace key and';
  let stopPlan = '';
  await chapter(
    'Stop while a card is half written: Approve, and the card back to its boundary',
    async () => {
      const run = await startPlan(page, sse, seed, seed.storyKey);
      stopPlan = run.planId;
      const ids = await lay(page, run.job, [
        { title: D1, kind: 'task', owns: 'Owns the count.', parentRef: seed.storyId },
        { title: D2, kind: 'task', owns: 'Owns the names.', parentRef: seed.storyId },
        { title: D3, kind: 'task', owns: 'Owns the signature.', parentRef: seed.storyId },
      ]);
      await author(page, run.job, ids[0]!, written('Count them nightly.', 'Owns the count.'), true);
      await author(page, run.job, ids[1]!, written('Name them by date.', 'Owns the names.'), true);
      await author(page, run.job, ids[2]!, HALF, false);

      await expect(stopButton(page)).toBeVisible();
      const stopped = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/ai/plan-change/session/mailbox/stop' &&
          r.request().method() === 'POST',
      );
      await stopButton(page).click();
      expect((await stopped).ok()).toBe(true);

      // The hosted Stop handling: the cut-off card put back, then the close.
      await ok(
        page.request.patch('/api/internal/ai/plan-proposals', {
          headers: doorHeaders(run.job),
          data: {
            jobId: run.job.jobId,
            corrections: [
              {
                planItemId: ids[2]!,
                patch: {
                  title: D3,
                  kind: 'task',
                  descriptionMd: boundary('Owns the signature.'),
                  authorFinished: null,
                },
                parentRef: seed.storyId,
                blockedByRefs: [],
              },
            ],
          },
        }),
        'plan-proposals (restore)',
      );
      await close(page, run.job, 'person_stop');

      const overlay = await openPlanned(page, stopPlan);
      await expectApproveNoResume(overlay);
      await expectBody(overlay, D3, 'Owns the signature.', HALF);
      await beat();
    },
  );

  await chapter(
    'Approve the stopped plan: finished cards keep their bodies, the cut-off one is To plan',
    async () => {
      const overlay = await openPlanned(page, stopPlan);
      await approve(page, overlay, stopPlan);
      expect((await created(stopPlan, D1)).descriptionMd).toContain('Count them nightly.');
      expect((await created(stopPlan, D2)).descriptionMd).toContain('Name them by date.');
      const cut = await created(stopPlan, D3);
      expect(cut.status).toBe('to_plan');
      expect(cut.descriptionMd).not.toContain(HALF);
      await expectToPlan(page, seed, [cut.identifier]);
      await beat();
    },
  );

  await chapter(
    'Stop before anything finished: nothing to review, and the plan says why',
    async () => {
      const run = await startPlan(page, sse, seed, seed.taskKey);
      await expect(stopButton(page)).toBeVisible();
      const stopped = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === '/api/ai/plan-change/session/mailbox/stop' &&
          r.request().method() === 'POST',
      );
      await stopButton(page).click();
      expect((await stopped).ok()).toBe(true);
      await close(page, run.job, 'person_stop');

      const row = await adminDb.plan.findUniqueOrThrow({ where: { id: run.planId } });
      expect([row.status, row.decisionReason]).toEqual(['declined', 'discarded']);
      await page.goto(`/plans/${run.planId}`);
      await expect(main(page).getByText(en.planReview.discardedOutcome)).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(main(page).getByRole('button', { name: APPROVE, exact: true })).toHaveCount(0);
      await beat();
    },
  );
});
