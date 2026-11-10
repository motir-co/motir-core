import { readFileSync, writeFileSync } from 'node:fs';
import type { Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { createTestPerson } from './_helpers/testPerson';
import { closeRun, ingestContext } from './_helpers/agent-run-seed';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { linkPr } from './_helpers/pr-link';
import { headShaFor } from './_helpers/approve-and-merge-seed';
import { HOSTED_RUN_PASSWORD } from './_helpers/hosted-run-seed';
import {
  readFakeContainers,
  readHostedRunJournal,
  resetHostedRunJournal,
  runTokenFor,
  writeHostedRunFixture,
} from './_helpers/hosted-run-boundary';
import {
  readPlannerModelFixture,
  writePlannerModelFixture,
} from './_helpers/planner-model-fixture';
import { markProjectOnboarded } from './_helpers/ai-augment-replan-seed';
import type { ContinueHostedSeed } from './_helpers/continue-hosted-seed';
import {
  REVIEW_REPO,
  seedDeliveringCard,
  seedReviewAgent,
  type ReviewAgentCard,
} from './_helpers/review-agent-seed';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import type { AiJobsFixture, GuideJobOutcome } from '@/lib/test-ai-jobs-mock';
import type { HostedRunFixture } from '@/lib/test-hosted-run-mock';
import type { PlannerModelFixture } from '@/lib/test-planner-model-mock';
import type { OrgTierFixture } from '@/lib/test-org-tier-fixture';
import en from '@/messages/en.json';

// ORG AND PLATFORM ADMINS SET THE MODEL FOR EACH MOTIR AI FUNCTION — the story's
// acceptance receipt (Story MOTIR-10838 · MOTIR-10849; design
// `design/org-admin/design-notes.md`, the AI models room and the console's
// per-function default rows).
//
// ── THE RECORDED WALK (the first test, chaptered) ─────────────────────────────
// A superadmin sets the platform Debug default, then the review-agent, design-run
// and High run-side defaults, in the console. The owner of a Standard organisation
// opens Organization settings → AI models and sees it locked, naming no model. The
// organisation moves to Pro: every row is editable and inheriting, and Debug names
// the platform default just set. The owner sets Guide, and a Guide me through turn
// is submitted and answered. The owner sets the design-run, review-agent and High
// models; a design work item's Run hosted preselects the organisation's design-run
// model and its run is minted on it; a High work item in a project with its own
// High override is preselected and minted on the PROJECT'S model, not the
// organisation's; and a hosted review the worker starts is minted on the
// organisation's review-agent model.
//
// ── THE REST (unrecorded tests, no `acceptanceStory`) ─────────────────────────
// An operator reads the console with no controls; a plain member reads the room;
// a model withdrawn from the planning list is flagged in the room; Standard again
// locks the room with the choices kept and a design run falls back to the platform
// default, and Pro again applies them with no re-entry; motir-ai down shows the
// unavailable faces and refuses a save; the room's loading face names no model.
//
// ── THE BOUNDARY ─────────────────────────────────────────────────────────────
// This lane never calls a real motir-ai. Four file-backed seams answer it:
//   * `lib/test-planner-model-mock.ts` — the planning settings, the Guide / Debug /
//     Ask defaults, the planning-model list and ONE org's planning-side overrides;
//   * `lib/test-hosted-run-mock.ts` — the run offer, the run-model defaults, the
//     org tier read, the gateway mint (journalled) and the repo read;
//   * `lib/test-org-tier-fixture.ts` — the ONE tier file both of those answer an
//     org's tier from, in the webServer and in the job worker;
//   * `lib/test-ai-jobs-mock.ts` — the Guide turn's canned answer.
// So this spec proves what motir-core SHOWS from motir-ai's answers and what it
// SENDS to motir-ai. Which model a Guide job ran on is motir-ai's to prove (its
// integration gate, MOTIR-10847). A hosted run's model is motir-core's own
// resolution, so it is asserted for real: on the gateway mint's journal line and
// on the run row.
//
// ── THE WAITS ────────────────────────────────────────────────────────────────
// Every assertion waits on an authoritative signal: a Server Action's or a
// PATCH's response before a row is read, the fixture file a save wrote, the start
// route's 201 and the journal's `gateway_mint` line (polled) for a run, and the
// fake orchestrator's record of a review's boot. The only pauses are `chapter()`'s
// and `beat()`'s own holds, taken after the assertion.
//
// ⚠️ THE 28xxx PULL-REQUEST BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 420_000 });

const room = en.settings.organization.aiModels;
const orgNav = en.settings.organization.nav;
const ap = en.platformAdmin.aiPlanning;
const rd = en.platformAdmin.runModels.defaults;
const lists = en.platformAdmin.modelLists;
const planningList = en.platformAdmin.planningList;

// ── The models: synthetic ids that exist only in this spec's fixtures ─────────
// Planning side.
const PLAN_BASE = 'e2e-plan-base'; // every audience's planning model
const PLAN_DEBUG = 'e2e-plan-debug'; // the platform Debug default the superadmin sets
const PLAN_GUIDE = 'e2e-plan-guide'; // the organisation's Guide choice
const PLANNING_IDS = [PLAN_BASE, PLAN_DEBUG, PLAN_GUIDE];
// Run side.
const RUN_DEFAULT = 'e2e-run-default'; // the offer's default and every level's seed
const RUN_HIGH = 'e2e-run-high'; // the platform High default the superadmin sets
const RUN_REVIEW = 'e2e-run-review'; // the platform review-agent default
const RUN_DESIGN = 'e2e-run-design'; // the platform design-run default
const ORG_HIGH = 'e2e-org-high'; // the organisation's High choice
const ORG_REVIEW = 'e2e-org-review'; // the organisation's review-agent choice
const ORG_DESIGN = 'e2e-org-design'; // the organisation's design-run choice
const PROJECT_HIGH = 'e2e-project-high'; // the project's own High override
const RUN_IDS = [
  RUN_DEFAULT,
  RUN_HIGH,
  RUN_REVIEW,
  RUN_DESIGN,
  ORG_HIGH,
  ORG_REVIEW,
  ORG_DESIGN,
  PROJECT_HIGH,
];
const EVERY_ID = [...PLANNING_IDS, ...RUN_IDS];

const REVIEW_PR = { number: 28101 };

// ── Fixtures ────────────────────────────────────────────────────────────────

const TIER_FIXTURE = process.env['MOTIR_AI_ORG_TIER_FIXTURE_PATH'];
const JOBS_FIXTURE =
  process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-ai-jobs-fixture.json';

function plannerFixture(): PlannerModelFixture {
  return {
    settings: (['customer', 'meta', 'internal'] as const).map((audience) => ({
      audience,
      model: PLAN_BASE,
    })),
    offered: PLANNING_IDS.map((id) => ({ id, provider: 'anthropic' })),
    list: PLANNING_IDS.map((model) => ({ model })),
  };
}

function hostedFixture(): HostedRunFixture {
  return {
    models: {
      ids: RUN_IDS,
      default: RUN_DEFAULT,
      defaultsByDifficulty: {
        trivial: RUN_DEFAULT,
        low: RUN_DEFAULT,
        medium: RUN_DEFAULT,
        high: RUN_DEFAULT,
      },
    },
    mayRun: true,
  };
}

const readHostedFixture = (): HostedRunFixture =>
  JSON.parse(
    readFileSync(process.env['MOTIR_HOSTED_RUN_FIXTURE_PATH']!, 'utf8'),
  ) as HostedRunFixture;

function setTier(orgId: string, tierKey: string): void {
  if (!TIER_FIXTURE) throw new Error('MOTIR_AI_ORG_TIER_FIXTURE_PATH is not set');
  writeFileSync(
    TIER_FIXTURE,
    JSON.stringify({ tiers: { [orgId]: tierKey } } satisfies OrgTierFixture),
  );
}

function readJobsFixture(): AiJobsFixture {
  try {
    return JSON.parse(readFileSync(JOBS_FIXTURE, 'utf8')) as AiJobsFixture;
  } catch {
    return {};
  }
}

/** Append the next Guide job's answer, keeping what the mock has recorded. */
function queueGuide(outcome: GuideJobOutcome): void {
  const f = readJobsFixture();
  f.guide = [...(f.guide ?? []), outcome];
  writeFileSync(JOBS_FIXTURE, JSON.stringify(f, null, 2));
}

// ── The world: one organisation, its owner, a member, and two staff ───────────

interface World {
  s: ContinueHostedSeed;
  orgId: string;
  orgName: string;
  superadmin: { id: string; name: string; email: string };
  operator: { id: string; name: string; email: string };
}

let staffSeq = 0;
async function staff(role: 'operator' | 'superadmin') {
  const email = `${role}-${Date.now().toString(36)}-${staffSeq++}@moooon.net`;
  const person = await createTestPerson({
    email,
    password: HOSTED_RUN_PASSWORD,
    name: role === 'superadmin' ? 'Sam Superadmin' : 'Olu Operator',
  });
  await adminDb.user.update({ where: { id: person.id }, data: { platformRole: role } });
  return person;
}

async function seedWorld(): Promise<World> {
  const s = await seedReviewAgent(Date.now().toString(36).slice(-5).toUpperCase());
  const workspace = await adminDb.workspace.findUniqueOrThrow({
    where: { id: s.hosted.workspaceId },
    include: { organization: true },
  });
  // The project's OWN High override, which must keep winning over the org's choice.
  await adminDb.project.update({
    where: { id: s.hosted.projectId },
    data: { hostedModelHigh: PROJECT_HIGH, reviewAgentEnabled: true },
  });
  await markProjectOnboarded(s.hosted.projectId);
  setTier(workspace.organizationId, 'standard');
  return {
    s,
    orgId: workspace.organizationId,
    orgName: workspace.organization.name,
    superadmin: await staff('superadmin'),
    operator: await staff('operator'),
  };
}

const ctxOf = (w: World) => ({ userId: w.s.hosted.userId, workspaceId: w.s.hosted.workspaceId });

async function seedCard(
  w: World,
  title: string,
  extra: { type?: 'design'; difficulty?: 'high' } = {},
): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: w.s.hosted.projectId, kind: 'task', title },
    ctxOf(w),
  );
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      ...(extra.type ? { type: extra.type } : {}),
      ...(extra.difficulty ? { difficulty: extra.difficulty } : {}),
    },
  });
  return { id: item.id, identifier: item.identifier };
}

// ── Locators and signals ─────────────────────────────────────────────────────

const main = (page: Page) => page.getByRole('main');
const roomRow = (page: Page, id: string) => main(page).getByTestId(`org-ai-models-row-${id}`);
const roomPicker = (page: Page, name: string) =>
  main(page).getByRole('combobox', { name: `Model for ${name}`, exact: true });
const consoleRow = (page: Page, key: string) =>
  main(page).getByTestId(`function-default-row-${key}`);

/** Arm a wait for the next Server Action's response — a POST carrying `Next-Action`. */
const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

const roomRead = (page: Page, orgId: string, side: 'planning' | 'runs') =>
  page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === `/api/organizations/${orgId}/ai-models/${side}` &&
      res.request().method() === 'GET',
    { timeout: FIRST_PAINT_MS },
  );

/** The PATCH saving ONE row of the room, told apart by its own body. */
const roomSave = (page: Page, orgId: string, side: 'planning' | 'runs', id: string) =>
  page.waitForResponse((res) => {
    if (new URL(res.url()).pathname !== `/api/organizations/${orgId}/ai-models/${side}`) {
      return false;
    }
    if (res.request().method() !== 'PATCH') return false;
    const body = res.request().postDataJSON() as { function?: string; key?: string };
    return (body.function ?? body.key) === id;
  });

/** Open the room fresh and wait for both of its reads. */
async function openRoom(page: Page, orgId: string): Promise<void> {
  const planning = roomRead(page, orgId, 'planning');
  const runs = roomRead(page, orgId, 'runs');
  await page.goto('/settings/organization/ai-models');
  expect((await planning).status()).toBe(200);
  expect((await runs).status()).toBe(200);
  await expect(main(page).getByRole('heading', { name: room.title, level: 1 })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
}

/** The page's text holds none of the model ids either fixture names. */
async function expectNoModelIds(page: Page): Promise<void> {
  const text = await main(page).innerText();
  for (const id of EVERY_ID) expect(text, `the page names ${id}`).not.toContain(id);
}

/** Choose a model on one room row (the picker's own option). */
async function chooseInRoom(page: Page, name: string, model: string): Promise<void> {
  await roomPicker(page, name).click();
  await page.getByRole('option').filter({ hasText: model }).first().click();
  await expect(roomPicker(page, name)).toContainText(model);
}

/** Choose a model on a console row and confirm with a reason; answers the action's response. */
async function saveConsoleRow(
  page: Page,
  key: string,
  pickerAria: string,
  model: string,
  reason: string,
  confirmLabel: string,
): Promise<Response> {
  const row = consoleRow(page, key);
  await row.getByRole('combobox', { name: pickerAria, exact: true }).click();
  await page.getByRole('option').filter({ hasText: model }).first().click();
  await row.getByRole('button', { name: ap.save, exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('textbox', { name: ap.confirm.reasonLabel }).fill(reason);
  const answered = serverAction(page);
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
  const res = await answered;
  await expect(dialog).toHaveCount(0);
  return res;
}

interface ModelsBody {
  resolved: { model: string; source: string; difficulty: string | null; design: boolean } | null;
}

const modelsRead = (page: Page, key: string) =>
  page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/hosted-runs/models' &&
      new URL(res.url()).searchParams.get('workItem') === key &&
      res.request().method() === 'GET',
    { timeout: FIRST_PAINT_MS },
  );

const runPicker = (page: Page): Locator =>
  main(page).getByRole('combobox', { name: 'Model', exact: true });

/** Open a card, read Run hosted's preselection, and answer the resolved model. */
async function preselection(page: Page, key: string): Promise<ModelsBody['resolved']> {
  const read = modelsRead(page, key);
  await page.goto(`/items/${key}`);
  const res = await read;
  expect(res.status()).toBe(200);
  const { resolved } = (await res.json()) as ModelsBody;
  expect(resolved, `Run hosted resolved a model for ${key}`).not.toBeNull();
  await expect(runPicker(page)).toContainText(resolved!.model, { timeout: FIRST_PAINT_MS });
  return resolved;
}

/** The model a run was minted on (the journal) and opened with (its row), which must agree. */
async function mintedModel(dispatchRunId: string): Promise<string> {
  await expect
    .poll(
      () =>
        readHostedRunJournal().some((e) => e.type === 'gateway_mint' && e.runRef === dispatchRunId),
      { timeout: 60_000, message: `a gateway mint for ${dispatchRunId}` },
    )
    .toBe(true);
  const mint = readHostedRunJournal().find(
    (e) => e.type === 'gateway_mint' && e.runRef === dispatchRunId,
  );
  const models = mint?.type === 'gateway_mint' ? mint.models : [];
  expect(models).toHaveLength(1);
  const run = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: dispatchRunId } });
  expect(run.model, 'the run row names the model it was minted on').toBe(models[0]);
  return models[0]!;
}

/**
 * Press Run on the open card, answer the run it opened, and close it as a container does.
 * The run id is read off the run list the section refetches after the start, not off the
 * 201's body: Chrome never reports that chunked body finished once the page refreshes on
 * it, so reading it never resolves (the regression-hosted-agent-run spec's finding).
 */
async function startHosted(page: Page, key: string, baseURL: string): Promise<string> {
  const started = page.waitForResponse(
    (res) =>
      res.url().endsWith(`/api/work-items/${key}/hosted-runs`) && res.request().method() === 'POST',
    { timeout: 30_000 },
  );
  const listed = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/work-items/${key}/dispatch-runs`) &&
      res.request().method() === 'GET',
    { timeout: 30_000 },
  );
  await main(page).getByTestId('run-hosted').click();
  expect((await started).status()).toBe(201);
  const { runs } = (await (await listed).json()) as { runs: { id: string; origin: string }[] };
  const run = runs.find((r) => r.origin === 'hosted');
  expect(run, `the run list carries the hosted run just started on ${key}`).toBeTruthy();
  const runId = run!.id;
  const model = await mintedModel(runId);
  // Free the slot: the run closes as its container would, with its own credential.
  const api = await ingestContext(runTokenFor(runId), baseURL);
  await closeRun(api, runId, 'completed');
  await api.dispose();
  return model;
}

/** Deliver the card's pull request green, so the review agent's job starts a review run. */
async function deliverGreen(page: Page, card: ReviewAgentCard): Promise<void> {
  const headRef = `review/${card.identifier.toLowerCase()}`;
  const opened = await postSignedWebhook(
    page.request,
    'pull_request',
    pullRequestPayload({
      action: 'opened',
      number: REVIEW_PR.number,
      title: card.title,
      headRef,
      state: 'open',
      merged: false,
      repo: REVIEW_REPO,
    }),
  );
  expect(opened.status()).toBe(200);
  await linkPr(page, { workItemId: card.id, repo: REVIEW_REPO, number: REVIEW_PR.number, headRef });
  const green = await postSignedWebhook(
    page.request,
    'check_suite',
    checkSuitePayload({
      conclusion: 'success',
      headSha: headShaFor(REVIEW_PR.number),
      prNumber: REVIEW_PR.number,
      headBranch: headRef,
      repo: REVIEW_REPO,
    }),
  );
  expect(green.status()).toBe(200);
}

/** The review run the worker booted for `card`, by the fake orchestrator's record. */
async function reviewRunId(card: ReviewAgentCard): Promise<string> {
  const find = () =>
    Object.values(readFakeContainers()).find(
      (m) =>
        m.spec.env?.['MOTIR_RUN_MODE'] === 'review' &&
        m.spec.env?.['MOTIR_WORK_ITEM_KEY'] === card.identifier,
    );
  await expect
    .poll(() => find() !== undefined, {
      timeout: 90_000,
      message: `a review run booted for ${card.identifier}`,
    })
    .toBe(true);
  return find()!.spec.env!['MOTIR_DISPATCH_RUN_ID']!;
}

async function signInStaff(page: Page, person: { email: string }): Promise<void> {
  await signIn(page, person.email, HOSTED_RUN_PASSWORD);
}

async function signInOwner(page: Page, w: World): Promise<void> {
  await signIn(page, w.s.owner.email, HOSTED_RUN_PASSWORD);
}

// ── Setup ──────────────────────────────────────────────────────────────────

let w: World;

test.beforeEach(async () => {
  await resetDatabase();
  writePlannerModelFixture(plannerFixture());
  writeHostedRunFixture(hostedFixture());
  resetHostedRunJournal();
  writeFileSync(JOBS_FIXTURE, JSON.stringify({}, null, 2));
  w = await seedWorld();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── 1. The recorded walk ─────────────────────────────────────────────────────

test('platform defaults, a Standard org locked, a Pro org choosing its models, and the runs that use them', async ({
  page,
  baseURL,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-10838');
  if (!baseURL) throw new Error('no Playwright baseURL');
  const guideCard = await workItemsService.createWorkItem(
    {
      projectId: w.s.hosted.projectId,
      kind: 'task',
      title: 'Point the domain at Motir',
      type: 'manual',
      executor: 'human',
    },
    ctxOf(w),
  );
  const [stepOne] = await Promise.all(
    ['Open the registrar', 'Add the CNAME record'].map(
      async (text) =>
        (await workItemTodosService.addTodo(guideCard.id, { text }, ctxOf(w))).todo.id,
    ),
  );
  const designCard = await seedCard(w, 'Draw the onboarding checklist', {
    type: 'design',
    difficulty: 'high',
  });
  const highCard = await seedCard(w, 'Reconcile the ledger rounding', { difficulty: 'high' });
  const reviewed = await seedDeliveringCard(w.s, 'Show the widget count');

  await chapter('The console: a superadmin sets the platform Debug default', async () => {
    await signInStaff(page, w.superadmin);
    await page.goto('/admin/ai-planning');
    for (const fn of ['guide', 'debug', 'ask'] as const) {
      await expect(consoleRow(page, fn)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(
        consoleRow(page, fn).getByRole('combobox', {
          name: ap.functions.pickerAria.replace('{name}', ap.functions[fn].name),
        }),
      ).toContainText(ap.functions.inherits);
    }
    // The audiences and the dry-run review row are drawn as before.
    for (const audience of ['customer', 'meta', 'internal']) {
      await expect(main(page).getByTestId(`ai-planning-row-${audience}`)).toContainText(PLAN_BASE);
    }
    await beat();

    const res = await saveConsoleRow(
      page,
      'debug',
      ap.functions.pickerAria.replace('{name}', ap.functions.debug.name),
      PLAN_DEBUG,
      'Diagnose defects on the debugging model',
      ap.confirm.confirm,
    );
    expect(res.status()).toBe(200);
    expect(readPlannerModelFixture().functions?.debug).toMatchObject({
      model: PLAN_DEBUG,
      updatedByCoreUserId: w.superadmin.id,
    });
    await expect(consoleRow(page, 'debug')).toContainText(PLAN_DEBUG);
    await page.reload();
    await expect(consoleRow(page, 'debug')).toContainText(`by ${w.superadmin.name}`, {
      timeout: FIRST_PAINT_MS,
    });
  });

  await chapter('The console: review-agent, design-run and High run-side defaults', async () => {
    await page.goto('/admin/run-models');
    await expect(main(page).getByTestId('run-side-defaults')).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    for (const [key, model] of [
      ['review', RUN_REVIEW],
      ['design', RUN_DESIGN],
      ['high', RUN_HIGH],
    ] as const) {
      const name = rd.row[key].name;
      const res = await saveConsoleRow(
        page,
        key,
        rd.pickerAria.replace('{name}', name),
        model,
        `Set the platform ${name} default`,
        ap.confirm.confirm,
      );
      expect(res.status()).toBe(200);
      await expect(consoleRow(page, key)).toContainText(ap.changed.justNowByYou);
    }
    const models = readHostedFixture().models;
    expect(models?.reviewAgentDefault).toBe(RUN_REVIEW);
    expect(models?.designRunDefault).toBe(RUN_DESIGN);
    expect(models?.defaultsByDifficulty?.high).toBe(RUN_HIGH);
    expect(readHostedFixture().runModelDefaultsChanged?.review?.updatedByCoreUserId).toBe(
      w.superadmin.id,
    );
    await beat();
  });

  await chapter('A Standard organisation: AI models is locked, and names no model', async () => {
    await signInOwner(page, w);
    await page.goto('/settings/organization');
    const planning = roomRead(page, w.orgId, 'planning');
    const runs = roomRead(page, w.orgId, 'runs');
    await page.getByRole('link', { name: orgNav.aiModels, exact: true }).click();
    await page.waitForURL('**/settings/organization/ai-models');
    expect((await planning).status()).toBe(200);
    expect((await runs).status()).toBe(200);
    const locked = main(page).getByTestId('org-ai-models-locked');
    await expect(locked).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(locked).toContainText(room.locked.title);
    await expect(locked.getByRole('link', { name: room.locked.seePlans })).toHaveAttribute(
      'href',
      '/settings/organization/billing',
    );
    await expect(main(page).getByRole('combobox')).toHaveCount(0);
    await expect(main(page).getByTestId('org-ai-models-save')).toHaveCount(0);
    await expectNoModelIds(page);
    await beat();
  });

  await chapter('Moved to Pro: every function is editable and inherits', async () => {
    setTier(w.orgId, 'pro');
    await openRoom(page, w.orgId);
    for (const id of [
      'planning',
      'guide',
      'debug',
      'ask',
      'review',
      'trivial',
      'low',
      'medium',
      'high',
      'design',
    ]) {
      await expect(main(page).getByTestId(`org-ai-models-source-${id}`)).toHaveText(
        room.source.inherits,
      );
    }
    await expect(roomPicker(page, room.fn.debug.name)).toContainText(PLAN_DEBUG);
    await expect(roomPicker(page, room.fn.guide.name)).toContainText(PLAN_BASE);
    await expect(main(page).getByTestId('org-ai-models-save')).toBeDisabled();
    await beat();
  });

  await chapter('The owner sets Guide, and it is saved as the organisation’s choice', async () => {
    await chooseInRoom(page, room.fn.guide.name, PLAN_GUIDE);
    const saved = roomSave(page, w.orgId, 'planning', 'guide');
    await main(page).getByTestId('org-ai-models-save').click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText(room.saved.title)).toBeVisible();
    await expect(main(page).getByTestId('org-ai-models-source-guide')).toHaveText(room.source.org);
    expect(readPlannerModelFixture().orgOverrides?.[w.orgId]?.guide).toMatchObject({
      model: PLAN_GUIDE,
      updatedByCoreUserId: w.s.owner.id,
    });
    await beat();
  });

  await chapter('Guide me through: the next turn is submitted and answered', async () => {
    queueGuide({
      guideTurn: {
        messageMd: 'Start with the registrar: sign in and open the DNS records.',
        actions: [{ type: 'current_step', rowId: stepOne }],
      },
    });
    await page.goto(`/items/${guideCard.identifier}`);
    const opened = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/ai/guide' && r.request().method() === 'POST',
    );
    const settled = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/ai/guide/settle' && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /Guide me through/ }).click({ timeout: FIRST_PAINT_MS });
    expect((await opened).status()).toBe(200);
    const settle = await settled;
    expect(settle.status()).toBe(200);
    expect(((await settle.json()) as { outcome?: string }).outcome).toBe('guided');
    expect(
      (readJobsFixture().submitted ?? []).filter((j) => j.kind === 'guide_work_item'),
    ).toHaveLength(1);
    await expect(page.getByRole('complementary', { name: 'Motir AI' })).toContainText(
      'Start with the registrar',
      { timeout: FIRST_PAINT_MS },
    );
    await beat();
    await page.keyboard.press('Escape');
  });

  await chapter('The owner sets the design-run, review-agent and High models', async () => {
    await openRoom(page, w.orgId);
    await chooseInRoom(page, room.fn.design.name, ORG_DESIGN);
    await chooseInRoom(page, room.fn.review.name, ORG_REVIEW);
    await chooseInRoom(page, en.labels.difficulty.high, ORG_HIGH);
    const saves = ['design', 'review', 'high'].map((id) => roomSave(page, w.orgId, 'runs', id));
    await main(page).getByTestId('org-ai-models-save').click();
    for (const res of await Promise.all(saves)) expect(res.status()).toBe(200);
    for (const id of ['design', 'review', 'high']) {
      await expect(main(page).getByTestId(`org-ai-models-source-${id}`)).toHaveText(
        room.source.org,
      );
    }
    const stored = await adminDb.organization.findUniqueOrThrow({ where: { id: w.orgId } });
    expect([stored.hostedDesignModel, stored.hostedReviewModel, stored.hostedModelHigh]).toEqual([
      ORG_DESIGN,
      ORG_REVIEW,
      ORG_HIGH,
    ]);
    await beat();
  });

  await chapter('A design work item runs on the organisation’s design-run model', async () => {
    const resolved = await preselection(page, designCard.identifier);
    expect(resolved).toMatchObject({ model: ORG_DESIGN, source: 'org_design', design: true });
    await expect(runPicker(page)).toHaveAccessibleDescription(/Organisation design-run model/);
    await beat();
    expect(await startHosted(page, designCard.identifier, baseURL)).toBe(ORG_DESIGN);
  });

  await chapter('A High work item: the project’s own override still wins', async () => {
    const resolved = await preselection(page, highCard.identifier);
    expect(resolved).toMatchObject({ model: PROJECT_HIGH, source: 'override', difficulty: 'high' });
    await expect(runPicker(page)).toHaveAccessibleDescription('Project override for High');
    await beat();
    expect(await startHosted(page, highCard.identifier, baseURL)).toBe(PROJECT_HIGH);
  });

  await chapter('A hosted review runs on the organisation’s review-agent model', async () => {
    await deliverGreen(page, reviewed);
    const runId = await reviewRunId(reviewed);
    expect(await mintedModel(runId)).toBe(ORG_REVIEW);
    await page.goto(`/items/${reviewed.identifier}`);
    await expect(main(page).getByTestId('agent-review-band')).toHaveAttribute(
      'data-state',
      'reviewing',
      { timeout: FIRST_PAINT_MS },
    );
    await beat();
  });
});

// ── 2. The rest, unrecorded ──────────────────────────────────────────────────

test('an operator reads the console defaults with no picker, Clear or Save', async ({ page }) => {
  await signInStaff(page, w.operator);
  await page.goto('/admin/ai-planning');
  await expect(consoleRow(page, 'debug')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(consoleRow(page, 'debug')).toContainText(ap.functions.inherits);
  await expect(main(page).getByRole('combobox')).toHaveCount(0);
  await expect(main(page).getByRole('button', { name: ap.save, exact: true })).toHaveCount(0);

  await page.goto('/admin/run-models');
  await expect(main(page).getByTestId('run-side-defaults')).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(consoleRow(page, 'high')).toContainText(RUN_DEFAULT);
  await expect(main(page).getByTestId('run-side-defaults').getByRole('combobox')).toHaveCount(0);
  await expect(main(page).getByTestId('run-side-defaults-read-only')).toBeVisible();
});

test('a plain member has no AI models row and reads the room without controls', async ({
  page,
}) => {
  setTier(w.orgId, 'pro');
  await signIn(page, w.s.ben.email, HOSTED_RUN_PASSWORD);
  await page.goto('/settings/organization');
  await expect(main(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(page.getByRole('link', { name: orgNav.aiModels, exact: true })).toHaveCount(0);

  await openRoom(page, w.orgId);
  await expect(main(page).getByTestId('org-ai-models-read-only')).toHaveText(
    room.readOnly.replace('{org}', w.orgName),
  );
  await expect(roomRow(page, 'guide')).toContainText(PLAN_BASE);
  await expect(main(page).getByRole('combobox')).toHaveCount(0);
  await expect(main(page).getByTestId('org-ai-models-save')).toHaveCount(0);
  await expect(main(page).getByTestId(/^org-ai-models-clear-/)).toHaveCount(0);
});

test('a Guide model removed from the planning list is flagged withdrawn in the room', async ({
  page,
}) => {
  setTier(w.orgId, 'pro');
  const fixture = plannerFixture();
  fixture.orgOverrides = { [w.orgId]: { guide: { model: PLAN_GUIDE } } };
  writePlannerModelFixture(fixture);

  await signInStaff(page, w.superadmin);
  await page.goto('/admin/ai-planning');
  const listRow = main(page).getByTestId(`planner-model-list-row-${PLAN_GUIDE}`);
  await listRow
    .getByRole('button', { name: `${lists.remove} ${PLAN_GUIDE}` })
    .click({ timeout: FIRST_PAINT_MS });
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('textbox', { name: lists.reasonLabel }).fill('Retire the guide model');
  const answered = serverAction(page);
  await dialog.getByRole('button', { name: planningList.remove.confirm }).click();
  expect((await answered).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  expect(readPlannerModelFixture().list?.map((e) => e.model)).not.toContain(PLAN_GUIDE);

  await signInOwner(page, w);
  await openRoom(page, w.orgId);
  await expect(main(page).getByTestId('org-ai-models-withdrawn-chip-guide')).toHaveText(
    room.withdrawnChip,
  );
  await expect(main(page).getByTestId('org-ai-models-withdrawn-guide')).toContainText(PLAN_BASE);
});

test('Standard again: locked with the choices kept and a design run on the platform default; Pro again: applied with no re-entry', async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error('no Playwright baseURL');
  const hosted = hostedFixture();
  hosted.models!.designRunDefault = RUN_DESIGN;
  writeHostedRunFixture(hosted);
  await signInOwner(page, w);

  // On Pro, the owner's choices are written through the room's own route.
  setTier(w.orgId, 'pro');
  for (const [key, model] of [
    ['design', ORG_DESIGN],
    ['review', ORG_REVIEW],
    ['high', ORG_HIGH],
  ] as const) {
    const res = await page.request.patch(`/api/organizations/${w.orgId}/ai-models/runs`, {
      data: { key, model },
    });
    expect(res.status(), await res.text()).toBe(200);
  }
  const before = await adminDb.organization.findUniqueOrThrow({ where: { id: w.orgId } });

  // Standard: the room is locked, says the choices are kept, and names no model.
  setTier(w.orgId, 'standard');
  await openRoom(page, w.orgId);
  await expect(main(page).getByTestId('org-ai-models-locked')).toBeVisible();
  await expect(main(page).getByTestId('org-ai-models-not-applying')).toHaveText(
    room.locked.notApplying.replace('{org}', w.orgName),
  );
  await expectNoModelIds(page);
  const standardCard = await seedCard(w, 'Sketch the empty state', { type: 'design' });
  expect(await preselection(page, standardCard.identifier)).toMatchObject({
    model: RUN_DESIGN,
    source: 'platform_design',
  });
  expect(await startHosted(page, standardCard.identifier, baseURL)).toBe(RUN_DESIGN);

  // Pro again, with no write in between: the same stored values, applied again.
  setTier(w.orgId, 'pro');
  await openRoom(page, w.orgId);
  await expect(roomPicker(page, room.fn.design.name)).toContainText(ORG_DESIGN);
  await expect(roomPicker(page, room.fn.review.name)).toContainText(ORG_REVIEW);
  await expect(roomPicker(page, en.labels.difficulty.high)).toContainText(ORG_HIGH);
  expect(await adminDb.organization.findUniqueOrThrow({ where: { id: w.orgId } })).toEqual(before);
  const proCard = await seedCard(w, 'Sketch the error state', { type: 'design' });
  expect(await preselection(page, proCard.identifier)).toMatchObject({
    model: ORG_DESIGN,
    source: 'org_design',
  });
  expect(await startHosted(page, proCard.identifier, baseURL)).toBe(ORG_DESIGN);
});

test('motir-ai down: the room and the console show their unavailable faces, and a save is refused', async ({
  page,
}) => {
  setTier(w.orgId, 'pro');
  writePlannerModelFixture({ ...plannerFixture(), unavailable: true });
  writeHostedRunFixture({ ...hostedFixture(), unavailable: true });

  await signInOwner(page, w);
  await openRoom(page, w.orgId);
  await expect(main(page).getByTestId('org-ai-models-unavailable')).toContainText(
    room.unavailable.body,
  );
  await expect(main(page).getByTestId('org-ai-models-retry')).toBeVisible();
  await expect(main(page).getByTestId(/^org-ai-models-row-/)).toHaveCount(0);
  await expectNoModelIds(page);

  // A save attempt is refused, and nothing reaches the stored state.
  const refused = await page.request.patch(`/api/organizations/${w.orgId}/ai-models/runs`, {
    data: { key: 'high', model: ORG_HIGH },
  });
  expect(refused.status()).toBe(503);
  expect(((await refused.json()) as { code?: string }).code).toBe('MODELS_UNREADABLE');
  const planningRefused = await page.request.patch(
    `/api/organizations/${w.orgId}/ai-models/planning`,
    { data: { function: 'guide', model: PLAN_GUIDE } },
  );
  expect(planningRefused.status()).toBe(503);
  expect(
    (await adminDb.organization.findUniqueOrThrow({ where: { id: w.orgId } })).hostedModelHigh,
  ).toBeNull();

  await signInStaff(page, w.superadmin);
  await page.goto('/admin/ai-planning');
  await expect(main(page).getByTestId('ai-planning-unavailable')).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(main(page).getByTestId(/^function-default-row-/)).toHaveCount(0);
  await page.goto('/admin/run-models');
  await expect(main(page).getByTestId('run-side-defaults-unavailable')).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(main(page).getByTestId(/^function-default-row-/)).toHaveCount(0);
  await expectNoModelIds(page);
});

test('the room’s loading face shows no row value until both reads answer', async ({ page }) => {
  setTier(w.orgId, 'pro');
  await signInOwner(page, w);

  // Hold both reads until the loading face has been asserted.
  const held: Array<() => Promise<void>> = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/organizations/${w.orgId}/ai-models/*`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    held.push(() => route.continue());
    await released;
  });

  await page.goto('/settings/organization/ai-models');
  await expect.poll(() => held.length, { timeout: FIRST_PAINT_MS }).toBe(2);
  await expect(main(page).getByTestId('org-ai-models-skeleton-guide')).toBeVisible();
  await expect(main(page).getByTestId('org-ai-models-skeleton-design')).toBeVisible();
  await expect(roomPicker(page, room.fn.guide.name)).toContainText(room.loadingTrigger);
  await expect(main(page).getByTestId(/^org-ai-models-source-/)).toHaveCount(0);
  await expectNoModelIds(page);

  const planning = roomRead(page, w.orgId, 'planning');
  const runs = roomRead(page, w.orgId, 'runs');
  release();
  await Promise.all(held.map((go) => go()));
  expect((await planning).status()).toBe(200);
  expect((await runs).status()).toBe(200);
  await expect(main(page).getByTestId('org-ai-models-source-guide')).toHaveText(
    room.source.inherits,
  );
  await expect(main(page).getByTestId('org-ai-models-skeleton-guide')).toHaveCount(0);
});
