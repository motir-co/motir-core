// The CONTENT-LANGUAGE story's journey across one organisation (Story MOTIR-7734 ·
// Subtask MOTIR-8750), as a regression walk in the CLOUD lane.
//
// One organisation writes its work content in Chinese (`zh`). Three people meet it:
//
//   A — saved account language `en` — plans, approves, and (as the owner) changes
//       the content language in Organization settings;
//   B — saved account language `ko` — drafts an explanation and plans too;
//   an agent — reads its dispatch prompt and files a bug over the MCP.
//
// What the walk proves, step by step (the card's numbering):
//
//   1. A's planning turn submits a `plan` job whose tenant carries
//      `contentLanguage: 'zh'` and `personLanguage: 'en'`; the planner stand-in
//      writes its proposals in the languages that tenant names, and A sees them in
//      the plan review.
//   2. Approved, the created item records `zh` on its title, description and to-do
//      text, and `en` on its explanation.
//   3. B (Korean UI) drafts the explanation with AI on the item's edit page; the
//      draft's terminal frame says `ko`; saved, the explanation records `ko` and the
//      title and description still read `zh`.
//   4. B's own planning turn submits `personLanguage: 'ko'`, `contentLanguage: 'zh'`.
//   5. The coding-agent dispatch prompt names the content language
//      (WORK CONTENT LANGUAGE); a bug created over the MCP with no language records
//      `zh`.
//   6. The owner changes the content language to 日本語 through the settings
//      control; A's next planning job carries `ja`; earlier work still reads `zh`.
//   7. The plan generated while `ja` is approved after the setting moved back to
//      `zh`, and still records `ja` — the planner's statement is fixed at generation.
//   8. `get_project_state` answers `zh` before the change and `ja` after it.
//
// ── WHY THIS LANE, AND WHY THIS NAME ────────────────────────────────────────
// The card names `tests/e2e/content-language-story.spec.ts`. That name would land
// in the MAIN lane, which is cloud-OFF: no Motir AI is configured there, so there
// is no planning surface, no Draft with AI and no `plan` job to read a tenant off.
// `playwright.cloud.config.ts` is the lane whose server installs the motir-ai jobs
// boundary mock (`lib/test-ai-jobs-mock.ts`, `E2E_TEST_AI_JOBS=1`) UNDER the routes,
// so the real routes, services and Postgres run and only motir-ai is played. Its
// `testMatch` is `cloud-*.spec.ts`, which decides the name.
//
// ── WHAT IS PLAYED, AND WHAT IS REAL ────────────────────────────────────────
// motir-ai is the only thing stood in for. The mock RECORDS every submit's tenant
// languages; the spec reads that journal and writes the planner's proposals
// through the REAL internal door motir-ai calls
// (`POST /api/internal/ai/plan-proposals`, service bearer + the job token the
// submit carried), naming `languages` exactly as a planner told those tenant
// languages would. The `generate_explanation` draft is a declared fixture entry
// the mock streams as `token` frames and a terminal `explanation` frame.
//
// SIMPLIFIED where the lane cannot reach the UI: the dispatch prompt, the MCP bug
// and `get_project_state` are agent surfaces, read over `/api/mcp` with a token;
// stored languages are read back through `get_work_item` / `list_work_item_todos`
// (there is no UI that renders a field's recorded language). The SECOND change of
// the setting (back to `zh`, step 7) goes through the same settings control as the
// first.
//
// DETERMINISM (the coding convention § E2E): every wait is a response armed before its action
// (the plan door, the decide route, the content-language PATCH, the explanation
// stream, the save's Server Action), a component state (Regenerate replaces Draft
// only once the draft settled), or an authoritative read (the journal, Postgres,
// the MCP). No fixed sleeps.

import type { Browser, Locator, Page, Request, Response } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { writeFileSync } from 'node:fs';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { E2E_CORE_CALLBACK_SECRET } from './_helpers/log-bug-as-ai';
import { readFixture } from './_helpers/mid-run-seam';
import { msg, signInHere } from './_helpers/i18n-walk';
import { languagesOf, mcp, openMcp } from './_helpers/content-language-seed';
import { createTestPerson } from './_helpers/testPerson';
import type {
  AiJobsFixture,
  GenerateExplanationJobOutcome,
  SubmittedJob,
} from '@/lib/test-ai-jobs-mock';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import type { Locale } from '@/lib/i18n/locales';
import en from '@/messages/en.json';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

test.describe.configure({ timeout: 300_000 });

const PASSWORD = 'content-language-story-9';
const PROJECT_KEY = 'CLS';
const ORG_SETTINGS = '/settings/organization';

// ── The planner stand-in's fixture text, one entry per language ─────────────

interface FeatureText {
  title: string;
  description: string;
  todo: string;
}

/** The first feature A asks for — written in whatever the content language is. */
const CSV_EXPORT: Partial<Record<Locale, FeatureText>> = {
  zh: {
    title: '将看板导出为 CSV',
    description: '让成员把当前看板的卡片导出为一个 CSV 文件。',
    todo: '编写导出接口',
  },
};

/** The feature A asks for after the content language moved to 日本語. */
const DIGEST: Partial<Record<Locale, FeatureText>> = {
  ja: {
    title: '週次ダイジェストを送る',
    description: '毎週月曜日に、先週の変更をまとめたメールを送る。',
    todo: '集計ジョブを書く',
  },
};

/** The explanation, written in the PERSON's language. */
const EXPLANATION: Partial<Record<Locale, string>> = {
  en: 'Teams asked to share their board with people outside Motir.',
};

/** B's draft, which the `generate_explanation` stand-in streams back in Korean. */
const KOREAN_DRAFT: GenerateExplanationJobOutcome = {
  explanationMd: '팀은 Motir 밖의 사람들과 보드를 공유하고 싶어 합니다.',
  language: 'ko',
};

const BUG_TITLE = '导出的文件缺少表头';
const BUG_DESCRIPTION = '下载的 CSV 第一行不是列名。';
const WORK_CONTENT_LANGUAGE_LINE = 'This organisation writes its work content in Chinese (`zh`).';

// ── The motir-ai boundary (the server's jobs mock reads this file) ───────────

function fixturePath(): string {
  const path = process.env['MOTIR_AI_JOBS_FIXTURE_PATH'];
  if (!path) throw new Error('MOTIR_AI_JOBS_FIXTURE_PATH is unset — this is not the cloud lane');
  return path;
}

/** Declare the explanation draft and RESET the journal — the file is shared by the lane. */
function resetSeam(): void {
  const fixture: AiJobsFixture = { generateExplanation: [KOREAN_DRAFT], submitted: [] };
  writeFileSync(fixturePath(), JSON.stringify(fixture, null, 2));
}

/** The submit the mock recorded for a job id. */
function submitOf(jobId: string): SubmittedJob {
  const job = (readFixture().submitted ?? []).find((s) => s.jobId === jobId);
  if (!job) throw new Error(`the jobs mock recorded no submit for ${jobId}`);
  return job;
}

/** The languages a planner told this tenant's languages writes each field in. */
function languagesFor(job: SubmittedJob): { content: Locale; explanation: Locale } {
  const content = job.contentLanguage as Locale;
  const explanation = (job.personLanguage === '' ? content : job.personLanguage) as Locale;
  return { content, explanation };
}

/**
 * Play the planner for one `plan` job: ONE `add` under the anchor epic, every text
 * field in the language the job's tenant says, through the internal door motir-ai
 * calls. `final` closes the plan (`planned`), which raises its approval gate.
 */
async function writeProposalAsPlanner(
  page: Page,
  job: SubmittedJob,
  feature: Partial<Record<Locale, FeatureText>>,
  parentRef: string,
): Promise<string> {
  const { content, explanation } = languagesFor(job);
  const text = feature[content];
  const why = EXPLANATION[explanation];
  if (!text || !why) {
    throw new Error(`no fixture text for content ${content} / explanation ${explanation}`);
  }
  const res = await page.request.post('/api/internal/ai/plan-proposals', {
    headers: {
      authorization: `Bearer ${E2E_CORE_CALLBACK_SECRET}`,
      'x-motir-job-token': job.readBackToken!,
    },
    data: {
      jobId: job.jobId,
      proposals: [
        {
          op: 'add',
          parentRef,
          proposedFields: {
            title: text.title,
            kind: 'task',
            descriptionMd: text.description,
            explanationMd: why,
            todos: [{ text: text.todo }],
          },
          languages: { title: content, description: content, todos: content, explanation },
        },
      ],
      final: true,
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  return text.title;
}

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog').filter({ has: rail(page) });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox').first();
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const bar = (page: Page) => workspace(page).getByTestId('plan-change-confirm-bar');
const approvalRows = (page: Page) =>
  page.getByRole('table', { name: en.workbench.tabs.toApprove }).getByTestId(/^approval-row-/);
const planRow = (page: Page, text: string) => approvalRows(page).filter({ hasText: text });
const verb = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });

const path = (r: Response | Request) => new URL(r.url()).pathname;

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        applicable: false,
        organizationId: null,
        organizationName: null,
        canManageBilling: false,
        hasPaidAiPlan: false,
        balance: 0,
        tierName: null,
        tierAllotment: null,
        renewsAt: null,
      }),
    }),
  );
}

// ── Steps ────────────────────────────────────────────────────────────────────

/**
 * Open *Plan with AI* from a card and send one turn in the page's language. The
 * anchored door's 200 is the authoritative "the run was submitted"; its body names
 * the job, which is how the journal entry is found.
 */
async function askFromCard(
  page: Page,
  key: string,
  text: string,
  lang: string,
): Promise<{ job: SubmittedJob; planId: string; sessionId: string }> {
  await page.goto(`/items/${key}`);
  await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await entrance(page).click();
  await page.waitForURL((url) => url.searchParams.has('plan'));
  await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });

  const sent = page.waitForResponse(
    (r) => /\/api\/work-items\/[^/]+\/ai\/plan$/.test(path(r)) && r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await rail(page)
    .getByRole('button', { name: msg(lang, 'planningWorkspace.conversation.send'), exact: true })
    .click();
  const res = await sent;
  expect(res.status(), await res.text()).toBe(200);
  const { jobId, planId } = (await res.json()) as { jobId: string; planId: string };
  const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
  expect(plan.sessionId).toBeTruthy();
  return { job: submitOf(jobId), planId, sessionId: plan.sessionId! };
}

async function closeSurface(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForURL((url) => !url.searchParams.has('plan'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/**
 * A finished plan waits in Waiting on you; its row opens the planning surface with
 * the plan to decide, and the proposal is on the canvas under its anchor.
 */
async function openPlanForReview(
  page: Page,
  anchorKey: string,
  sessionId: string,
  title: string,
): Promise<void> {
  await page.goto('/workbench?tab=approvals');
  const row = planRow(page, anchorKey);
  await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
  await row.getByRole('button', { name: en.workbench.approvals.review, exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get('planSession') === sessionId);
  await expect(bar(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(bar(page)).toContainText('1 added');
  await expect(
    workspace(page).getByTestId('plan-item-node').filter({ hasText: title }).first(),
  ).toBeVisible();
}

async function approvePlan(page: Page, planId: string): Promise<void> {
  const approved = page.waitForResponse(
    (r) => path(r) === `/api/plans/${planId}/approve` && r.request().method() === 'POST',
  );
  await verb(bar(page), en.approvalGate.planApproval.surface.approve).click();
  expect((await approved).status()).toBe(200);
  const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
  expect(plan.status).toBe('approved');
}

/** The created work item's key, by the title the proposal carried. */
async function keyOf(title: string): Promise<string> {
  return (await adminDb.workItem.findFirstOrThrow({ where: { title } })).identifier;
}

/**
 * Change the organisation's content language through the General card's control
 * and its confirm — the predecessor story's control, driven as
 * `regression-content-language.spec.ts` drives it. The PATCH's 200 is the signal.
 */
async function changeContentLanguage(
  page: Page,
  orgId: string,
  from: string,
  to: string,
): Promise<void> {
  await page.goto(ORG_SETTINGS);
  const control = page
    .getByRole('main')
    .getByRole('combobox', { name: msg('en', 'orgAdmin.settings.contentLanguageLabel') });
  await expect(control).toContainText(from, { timeout: FIRST_PAINT_MS });
  await control.click();
  await page.getByRole('option', { name: to, exact: true }).click();
  await page.getByRole('main').getByRole('button', { name: 'Save changes' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change the content language?' });
  await expect(dialog).toContainText(to);
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' &&
      path(r) === `/api/organizations/${orgId}/content-language`,
  );
  await dialog.getByRole('button', { name: `Change to ${to}` }).click();
  expect((await saved).status()).toBe(200);
}

// ── The world ────────────────────────────────────────────────────────────────

interface StoryWorld {
  orgId: string;
  aEmail: string;
  bEmail: string;
  /** The epic A plans the first feature from. */
  firstAnchor: { key: string; id: string };
  /** The epic B plans from. */
  bAnchor: { key: string; id: string };
  /** The epic A plans the second feature from, once the setting is 日本語. */
  secondAnchor: { key: string; id: string };
  aToken: string;
}

async function seedWorld(): Promise<StoryWorld> {
  const slug = Date.now().toString(36);
  const aEmail = `cls-a-${slug}@example.com`;
  const bEmail = `cls-b-${slug}@example.com`;
  const a = await createTestPerson({ email: aEmail, password: PASSWORD, name: 'Avery Planner' });
  await usersService.setSavedLocale(a.id, 'en');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Content Language Story',
    ownerUserId: a.id,
  });
  // The organisation writes in Chinese.
  await adminDb.organization.update({
    where: { id: workspace.organizationId },
    data: { contentLanguage: 'zh' },
  });
  const project = await projectsService.createProject({
    name: 'Board',
    identifier: PROJECT_KEY,
    workspaceId: workspace.id,
    actorUserId: a.id,
  });
  // Onboarded, or the planning surfaces forward to the onboarding wizard.
  await adminDb.project.update({
    where: { id: project.id },
    data: { onboardingRanAt: new Date() },
  });
  const ctx = { userId: a.id, workspaceId: workspace.id };

  const b = await createTestPerson({ email: bEmail, password: PASSWORD, name: 'Bora Writer' });
  await usersService.setSavedLocale(b.id, 'ko');
  await workspacesService.addMember({ userId: b.id, workspaceId: workspace.id });
  await addToProjectAs({
    key: PROJECT_KEY,
    actorUserId: a.id,
    ctx,
    targetUserId: b.id,
    role: 'member',
  });
  await adminDb.workspaceMembership.updateMany({
    where: { workspaceId: workspace.id, userId: { in: [a.id, b.id] } },
    data: { activeProjectId: project.id },
  });

  const epic = async (title: string) => {
    const row = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'epic', title },
      ctx,
    );
    return { key: row.identifier, id: row.id };
  };
  const firstAnchor = await epic('看板分享');
  const bAnchor = await epic('导入');
  const secondAnchor = await epic('通知');

  const minted = await apiTokensService.create(a.id, workspace.id, {
    label: 'content-language-story-e2e',
    projectId: project.id,
    permissions: [...CLI_TOKEN_GRANT],
  });

  return {
    orgId: workspace.organizationId,
    aEmail,
    bEmail,
    firstAnchor,
    bAnchor,
    secondAnchor,
    aToken: minted.token,
  };
}

/** A second signed-in person, in their own browser context. */
async function openAs(
  browser: Browser,
  baseURL: string,
  locale: string,
  email: string,
): Promise<Page> {
  const context = await browser.newContext({ baseURL, locale });
  const page = await context.newPage();
  await stubAiAccess(page);
  await signInHere(page, email, PASSWORD);
  return page;
}

// ─────────────────────────────────────────────────────────────────────────────

test.beforeEach(async () => {
  await resetDatabase();
  resetSeam();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

test('one organisation writes in its content language, whoever plans, drafts or changes it', async ({
  page,
  browser,
  baseURL,
}) => {
  const world = await seedWorld();
  const client: Client = await openMcp(world.aToken, baseURL!);
  const projectLanguage = async () =>
    (
      await mcp<{ contentLanguage: string }>(client, 'get_project_state', {
        projectKey: PROJECT_KEY,
      })
    ).contentLanguage;

  let firstKey = '';

  try {
    await stubAiAccess(page);
    await signInHere(page, world.aEmail, PASSWORD);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    await test.step('1. A plans in English; the job carries zh + en, the plan is written in zh', async () => {
      const asked = await askFromCard(
        page,
        world.firstAnchor.key,
        'Let people export their board as CSV.',
        'en',
      );
      expect(asked.job.kind).toBe('plan');
      expect(asked.job.contentLanguage).toBe('zh');
      expect(asked.job.personLanguage).toBe('en');
      await closeSurface(page);

      const title = await writeProposalAsPlanner(page, asked.job, CSV_EXPORT, world.firstAnchor.id);
      expect(title).toBe(CSV_EXPORT.zh!.title);
      await openPlanForReview(page, world.firstAnchor.key, asked.sessionId, title);

      await test.step('2. approved: title, description and to-dos record zh; explanation en', async () => {
        await approvePlan(page, asked.planId);
        firstKey = await keyOf(CSV_EXPORT.zh!.title);
        expect(await languagesOf(client, firstKey)).toEqual({
          title: 'zh',
          description: 'zh',
          explanation: 'en',
        });
        const todos = await mcp<{ items: { text: string; textLanguage: string | null }[] }>(
          client,
          'list_work_item_todos',
          { key: firstKey },
        );
        expect(todos.items.map((t) => [t.text, t.textLanguage])).toEqual([
          [CSV_EXPORT.zh!.todo, 'zh'],
        ]);
      });
    });

    const bPage = await openAs(browser, baseURL!, 'ko-KR', world.bEmail);
    try {
      await test.step('3. B (Korean UI) drafts the explanation: it records ko, the rest stays zh', async () => {
        await bPage.goto(`/items/${firstKey}/edit`);
        await expect(bPage.locator('html')).toHaveAttribute('lang', 'ko', {
          timeout: FIRST_PAINT_MS,
        });
        const main = bPage.getByRole('main');
        const draftButton = main.getByRole('button', {
          name: msg('ko', 'draftWithAi.button'),
          exact: true,
        });
        await expect(draftButton).toBeEnabled({ timeout: FIRST_PAINT_MS });

        const submitted = bPage.waitForResponse(
          (r) => path(r) === '/api/ai/explanation' && r.request().method() === 'POST',
        );
        const streamed = bPage.waitForResponse((r) =>
          /^\/api\/ai\/explanation\/[^/]+\/stream$/.test(path(r)),
        );
        await draftButton.click();
        const submit = await submitted;
        expect(submit.status()).toBe(200);
        const stream = await streamed;
        expect(stream.status()).toBe(200);
        // The whole stream, read to its end: the terminal frame names the draft's language.
        const body = await stream.text();
        expect(body).toContain('event: explanation');
        expect(body).toContain('"language":"ko"');
        // The draft SETTLED (its language with it) once Draft has become Regenerate.
        await expect(
          main.getByRole('button', { name: msg('ko', 'draftWithAi.regenerate'), exact: true }),
        ).toBeVisible();

        // The draft job was asked for by B, in B's language, for a zh organisation.
        const { jobId } = (await submit.json()) as { jobId: string };
        const draftJob = submitOf(jobId);
        expect(draftJob.kind).toBe('generate_explanation');
        expect(draftJob.personLanguage).toBe('ko');
        expect(draftJob.contentLanguage).toBe('zh');

        const saved = bPage.waitForResponse(
          (r) => r.request().method() === 'POST' && 'next-action' in r.request().headers(),
        );
        await main.getByRole('button', { name: msg('ko', 'common.save'), exact: true }).click();
        expect((await saved).status()).toBe(200);
        await expect(
          // `exact`: the toast's own line, not its screen-reader announcement
          // (`Notification …`), which shares the text.
          bPage.getByText(msg('ko', 'issueViews.issueSaved', { identifier: firstKey }), {
            exact: true,
          }),
        ).toBeVisible();

        const item = await adminDb.workItem.findFirstOrThrow({ where: { identifier: firstKey } });
        expect(item.explanationMd).toBe(KOREAN_DRAFT.explanationMd);
        expect(item.title).toBe(CSV_EXPORT.zh!.title);
        expect(await languagesOf(client, firstKey)).toEqual({
          title: 'zh',
          description: 'zh',
          explanation: 'ko',
        });
      });

      await test.step('4. B plans: the job carries personLanguage ko, contentLanguage zh', async () => {
        const asked = await askFromCard(
          bPage,
          world.bAnchor.key,
          'CSV 파일에서 카드를 가져오게 해 주세요.',
          'ko',
        );
        expect(asked.job.kind).toBe('plan');
        expect(asked.job.personLanguage).toBe('ko');
        expect(asked.job.contentLanguage).toBe('zh');
      });
    } finally {
      await bPage.context().close();
    }

    await test.step('5. the dispatch prompt names zh; an MCP bug with no language records zh', async () => {
      const dispatch = await mcp<{ prompt: string }>(client, 'dispatch_prompt', { key: firstKey });
      expect(dispatch.prompt).toContain('WORK CONTENT LANGUAGE');
      expect(dispatch.prompt).toContain(WORK_CONTENT_LANGUAGE_LINE);

      const { identifier } = await mcp<{ identifier: string }>(client, 'create_work_item', {
        projectKey: PROJECT_KEY,
        kind: 'bug',
        title: BUG_TITLE,
        descriptionMd: BUG_DESCRIPTION,
      });
      expect(await languagesOf(client, identifier)).toEqual({
        title: 'zh',
        description: 'zh',
        explanation: null,
      });

      // 8, before the change.
      expect(await projectLanguage()).toBe('zh');
    });

    let secondPlan = { planId: '', sessionId: '', title: '' };

    await test.step('6. the owner changes it to 日本語; the next job carries ja; earlier work reads zh', async () => {
      await changeContentLanguage(page, world.orgId, '中文', '日本語');
      const org = await adminDb.organization.findUniqueOrThrow({ where: { id: world.orgId } });
      expect(org.contentLanguage).toBe('ja');

      // 8, after the change.
      expect(await projectLanguage()).toBe('ja');

      const asked = await askFromCard(
        page,
        world.secondAnchor.key,
        'Send a weekly digest of what changed.',
        'en',
      );
      expect(asked.job.contentLanguage).toBe('ja');
      expect(asked.job.personLanguage).toBe('en');
      await closeSurface(page);
      const title = await writeProposalAsPlanner(page, asked.job, DIGEST, world.secondAnchor.id);
      expect(title).toBe(DIGEST.ja!.title);
      secondPlan = { planId: asked.planId, sessionId: asked.sessionId, title };

      // Work written before the change keeps its language.
      expect(await languagesOf(client, firstKey)).toEqual({
        title: 'zh',
        description: 'zh',
        explanation: 'ko',
      });
      const bug = await adminDb.workItem.findFirstOrThrow({ where: { title: BUG_TITLE } });
      expect(await languagesOf(client, bug.identifier)).toMatchObject({
        title: 'zh',
        description: 'zh',
      });
    });

    await test.step('7. moved back to 中文 before approval, the ja plan still records ja', async () => {
      await changeContentLanguage(page, world.orgId, '日本語', '中文');
      const org = await adminDb.organization.findUniqueOrThrow({ where: { id: world.orgId } });
      expect(org.contentLanguage).toBe('zh');

      await openPlanForReview(page, world.secondAnchor.key, secondPlan.sessionId, secondPlan.title);
      await approvePlan(page, secondPlan.planId);
      const key = await keyOf(DIGEST.ja!.title);
      expect(await languagesOf(client, key)).toEqual({
        title: 'ja',
        description: 'ja',
        explanation: 'en',
      });
      const todos = await mcp<{ items: { textLanguage: string | null }[] }>(
        client,
        'list_work_item_todos',
        { key },
      );
      expect(todos.items.map((t) => t.textLanguage)).toEqual(['ja']);
    });
  } finally {
    await client.close();
  }
});
