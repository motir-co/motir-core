import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { APIResponse, Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import { seedGithubInstallation } from './_helpers/github-seed';
import { E2E_REPO } from './_helpers/github-const';
import { grantPaidAiPlanIfBilled } from './_helpers/billing';
import {
  connectGithubIdentity,
  repoCreates,
  resetGithubFixture,
  setGithubControl,
} from './_helpers/repository-set-seed';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { plansService } from '@/lib/services/plansService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import type { ProposalInput } from '@/lib/dto/plans';
import type { PlanReviewDto, PlanReviewItemDto } from '@/lib/dto/planReview';
import type { ProjectRepoDto, ProjectRepoEstablishViewDto } from '@/lib/dto/projectRepos';
import type { ReadyItemDto } from '@/lib/dto/ready';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  MIN_MEDIAN_CHAPTER_GAP_SECONDS,
  MIN_WATCHABLE_SECONDS,
  assessWatchability,
  isOwnedRecording,
} from '../../scripts/upload-acceptance-video.mjs';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-10162 — an init card for each repository a plan creates, walked as
 * the story's acceptance receipt (MOTIR-11050).
 *
 * One owner, three projects on one tenant:
 *
 *  - ACME LEDGER, Motir-hosted and recording no repositories. Its plan lays ONE
 *    init card declaring `acme-ledger-service` and two cards that ship in it,
 *    each blocked by the init card. The init card is an agent's job.
 *  - ACME MOBILE, whose repository rows are the organisation's own (a row
 *    connected to the installation's repository). Its plan lays an init card on
 *    the person's own GitHub: a `manual` card, a person's job.
 *  - ACME BILLING, Motir-hosted, whose repository creation the fake host is told
 *    to refuse.
 *
 * The walk:
 *
 *  1. The hosted plan's review: one init card in the adds, no row naming the
 *     repository, and the waiters' order read from the review the pane is built
 *     from.
 *  2. The two init cards' peeks, side by side: neither draws a repository, and
 *     the executor each renders differs — the owner axis, made visible.
 *  3. Approve: the decided review reads in its decided words, every created card's
 *     peek draws an empty repository rail, and the ready queue holds the init
 *     card but not the work behind it.
 *  4. The repository's row is appended and the establish door creates it: the
 *     room says Created and the fake host was asked exactly once.
 *  5. The waiters now name the repository, and with their init card completed by
 *     the establish they reach the ready queue.
 *  6. The billing project's creation is refused: the row stays, the waiter is not
 *     pinned and is still held back.
 *  7. A replay of the establish changes nothing anywhere it can be read.
 *
 * ── WHERE THIS STOPS ─────────────────────────────────────────────────────────
 *
 *  - The walk arrives with the repository row APPENDED through the shipped set
 *    service's `addRow`, and drives the shipped REST establish door from there.
 *    The MCP tool runs in the server process, where the lane's fake git host
 *    lives, and a Playwright runner cannot call it in-process; its sequence,
 *    refusals and replay are asserted by its own card and by the doors gate.
 *  - The manual arm is shown at the REVIEW only. On the person's own GitHub the
 *    creation is that person's act, outside Motir, so a browser run cannot show it.
 *  - Nothing here publishes. The lane's uploader posts the recording of a spec
 *    the pull request changed, from a green run; the second test asserts this
 *    recording's sidecars would pass that uploader's gates.
 *  - Ordering is read from the review (`blockedByNodeIds`) and from the ready
 *    queue (`GET /api/ready`), never by hit-testing an edge on the canvas. The
 *    queue is only READ: `POST /api/ready/next` would claim a card in order to
 *    prove it cannot be claimed.
 *
 * GitHub is the in-server fake (`lib/test-github-repos-mock.ts`); its journal is
 * the evidence of what GitHub was asked. Every wait is on a write's own response,
 * a rendered element, or a poll of a shipped read.
 */

test.describe.configure({ mode: 'serial', timeout: 600_000 });

const PASSWORD = 'init-card-e2e-pass-7';
const EMAIL = 'e2e-init-card@example.com';

/** The repository the hosted plan's init card declares, and the refused one. */
const LEDGER_REPO = 'acme-ledger-service';
const BILLING_REPO = 'acme-billing-service';
/** The repository the person's own init card declares on their GitHub. */
const MOBILE_REPO = 'acme-mobile-app';

/** The titles name no repository, so a facts line is the only place one could show. */
const TITLE = {
  ledgerInit: 'Create the service repository',
  ledgerEndpoints: 'Build the ledger endpoints',
  ledgerCheckout: 'Wire the ledger into checkout',
  mobileInit: 'Create the app repository on your GitHub',
  mobileSignIn: 'Build the sign-in screen',
  billingInit: 'Create the billing repository',
  billingInvoices: 'Build the invoice endpoints',
} as const;

/** The chapters the walk declares, in the order it runs them. */
const CHAPTERS = [
  'The plan review shows one init card, with the work behind it unpinned',
  'Who owns the repository decides who does the init card',
  'Approve: the cards are created with no repository, and the work waits',
  'The repository is created through the establish door',
  'The waiting work now names its repository and may start',
  'A refused creation leaves its waiters held and unpinned',
  'A replay of the establish changes nothing',
] as const;

const peekCopy = enMessages.issueViews;
const reviewCopy = enMessages.planReview;

// ── The seed ────────────────────────────────────────────────────────────────

interface ArmSeed {
  projectId: string;
  projectKey: string;
  planId: string;
}

interface InitCardSeed {
  userId: string;
  workspaceId: string;
  ctx: ServiceContext;
  ledger: ArmSeed;
  mobile: ArmSeed;
  billing: ArmSeed;
}

interface CardSpec {
  title: string;
  type: string;
  executor: 'coding_agent' | 'human';
  storyPoints: number;
  estimateMinutes: number;
}

/**
 * A planned plan laying ONE init card that declares `repo`, and the waiters, each
 * blocked by it. Two appends, because a temp-ref names a proposal appended in an
 * earlier call — the order a planner lays them in.
 */
async function seedInitPlan(
  projectId: string,
  ctx: ServiceContext,
  plan: { title: string; summary: string },
  init: CardSpec & { repo: string },
  waiters: CardSpec[],
): Promise<string> {
  const created = await plansService.createPlan(projectId, plan, ctx);
  const first = await plansService.addProposals(
    created.id,
    [
      {
        op: 'add',
        proposedFields: {
          title: init.title,
          kind: 'task',
          type: init.type,
          executor: init.executor,
          storyPoints: init.storyPoints,
          estimateMinutes: init.estimateMinutes,
          subject: 'init',
          initRepositoryName: init.repo,
        },
      },
    ],
    ctx,
  );
  const initRef = `${TEMP_REF_PREFIX}${first.items[0]!.id}`;
  await plansService.addProposals(
    created.id,
    waiters.map(
      (w): ProposalInput => ({
        op: 'add',
        proposedFields: {
          title: w.title,
          kind: 'task',
          type: w.type,
          executor: w.executor,
          storyPoints: w.storyPoints,
          estimateMinutes: w.estimateMinutes,
        },
        blockedByRefs: [initRef],
      }),
    ),
    ctx,
  );
  await plansService.markPlanned(created.id, ctx);
  return created.id;
}

async function seedProject(
  name: string,
  identifier: string,
  workspaceId: string,
  userId: string,
): Promise<{ projectId: string; projectKey: string }> {
  const project = await projectsService.createProject({
    name,
    identifier,
    workspaceId,
    actorUserId: userId,
  });
  const row = await db.project.findUniqueOrThrow({
    where: { id: project.id },
    select: { identifier: true },
  });
  return { projectId: project.id, projectKey: row.identifier };
}

const agentCard = (title: string, points = 3): CardSpec => ({
  title,
  type: 'code',
  executor: 'coding_agent',
  storyPoints: points,
  estimateMinutes: points * 15,
});

/**
 * The tenant the journey starts from. Every write rides a shipped service — the
 * sanctioned reach for E2E setup — and nothing is approved, appended or created:
 * those are the walk's.
 */
async function seedInitCardTenant(): Promise<InitCardSeed> {
  const owner = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Init Card Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Init Card E2E',
    ownerUserId: owner.id,
  });
  // A Motir-hosted repository is paid-AI-plan only.
  grantPaidAiPlanIfBilled(workspace.organizationId);
  await connectGithubIdentity(owner.id);
  await seedGithubInstallation(workspace.id);
  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };

  const ledgerProject = await seedProject('Acme Ledger', 'ALG', workspace.id, owner.id);
  const mobileProject = await seedProject('Acme Mobile', 'AMB', workspace.id, owner.id);
  const billingProject = await seedProject('Acme Billing', 'ABL', workspace.id, owner.id);

  // The person's own GitHub: the mobile project's set is the organisation's own
  // repository, connected through the installation.
  const mirror = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: workspace.id, name: E2E_REPO.name },
  });
  const connected = await projectRepoSetService.addRow(
    mobileProject.projectId,
    { role: 'web', name: E2E_REPO.name },
    ctx,
  );
  await projectRepoSetService.attachRealizedRepo(connected.id, mirror.id, ctx);

  const ledgerPlan = await seedInitPlan(
    ledgerProject.projectId,
    ctx,
    { title: 'Ship the ledger', summary: 'A ledger service, and checkout wired to it.' },
    { ...agentCard(TITLE.ledgerInit, 2), repo: LEDGER_REPO },
    [agentCard(TITLE.ledgerEndpoints, 5), agentCard(TITLE.ledgerCheckout, 3)],
  );
  const mobilePlan = await seedInitPlan(
    mobileProject.projectId,
    ctx,
    { title: 'Ship the mobile app', summary: 'A mobile app, starting with sign-in.' },
    {
      title: TITLE.mobileInit,
      type: 'manual',
      executor: 'human',
      storyPoints: 1,
      estimateMinutes: 15,
      repo: MOBILE_REPO,
    },
    [agentCard(TITLE.mobileSignIn, 3)],
  );
  const billingPlan = await seedInitPlan(
    billingProject.projectId,
    ctx,
    { title: 'Ship invoicing', summary: 'An invoice service behind billing.' },
    { ...agentCard(TITLE.billingInit, 2), repo: BILLING_REPO },
    [agentCard(TITLE.billingInvoices, 5)],
  );

  return {
    userId: owner.id,
    workspaceId: workspace.id,
    ctx,
    ledger: { ...ledgerProject, planId: ledgerPlan },
    mobile: { ...mobileProject, planId: mobilePlan },
    billing: { ...billingProject, planId: billingPlan },
  };
}

/** Pin `projectId` as the owner's active project — the plans review and `/items`
 *  are active-project scoped. The same pin the shipped seeds take. */
async function activate(seed: InitCardSeed, projectId: string): Promise<void> {
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: seed.userId, workspaceId: seed.workspaceId } },
    data: { activeProjectId: projectId },
  });
}

// ── The shipped reads and doors ───────────────────────────────────────────────

/** Every API path this spec sent, so the last assertion can say what it never sent. */
const sent: string[] = [];

async function call(
  page: Page,
  method: 'GET' | 'POST',
  url: string,
  data?: unknown,
): Promise<APIResponse> {
  sent.push(`${method} ${new URL(url, 'http://local').pathname}`);
  return method === 'GET'
    ? page.request.get(url, { headers: { Accept: 'application/json' } })
    : page.request.post(url, { data: data ?? {} });
}

async function readReview(page: Page, planId: string): Promise<PlanReviewDto> {
  const res = await call(page, 'GET', `/api/plans/${encodeURIComponent(planId)}`);
  expect(res.status(), `the review read for plan ${planId}`).toBe(200);
  return (await res.json()) as PlanReviewDto;
}

function itemTitled(review: PlanReviewDto, title: string): PlanReviewItemDto {
  const item = review.items.find((i) => i.title === title);
  if (!item) throw new Error(`the review of plan ${review.id} has no item titled "${title}"`);
  return item;
}

/** The materialized card's `PROD-<n>` key, from the decided review. */
function keyOf(review: PlanReviewDto, title: string): string {
  const key = itemTitled(review, title).identifier;
  if (!key) throw new Error(`"${title}" was not materialized by plan ${review.id}`);
  return key;
}

async function readRepositories(page: Page, arm: ArmSeed): Promise<ProjectRepoDto[]> {
  const res = await call(
    page,
    'GET',
    `/api/projects/${encodeURIComponent(arm.projectKey)}/repositories`,
  );
  expect(res.status(), `the repository read for ${arm.projectKey}`).toBe(200);
  return ((await res.json()) as ProjectRepoEstablishViewDto).set.rows;
}

/** The keys the shipped dispatch list holds for the project. READ only. */
async function readyKeys(page: Page, arm: ArmSeed): Promise<string[]> {
  const res = await call(
    page,
    'GET',
    `/api/ready?projectKey=${encodeURIComponent(arm.projectKey)}&limit=200`,
  );
  expect(res.status(), `the ready list for ${arm.projectKey}`).toBe(200);
  return ((await res.json()) as { items: ReadyItemDto[] }).items.map((i) => i.key);
}

interface EstablishAnswer {
  rows: { rowId: string; outcome: string; row: ProjectRepoDto | null; failureCode?: string }[];
}

async function establish(page: Page, arm: ArmSeed, rowId: string): Promise<EstablishAnswer> {
  const res = await call(
    page,
    'POST',
    `/api/projects/${encodeURIComponent(arm.projectKey)}/repositories/establish`,
    { rowId },
  );
  expect(res.status(), `the establish door for ${arm.projectKey}`).toBe(200);
  return (await res.json()) as EstablishAnswer;
}

/** The creates the fake host was asked for `name` — a template generate or an
 *  initialised create, whichever the row's starter called. */
function createsFor(name: string): number {
  return repoCreates().filter((c) => c.body?.['name'] === name).length;
}

// ── The rendered surfaces ─────────────────────────────────────────────────────

/** One review row, by the title its open control carries. */
function reviewRow(list: Locator, title: string): Locator {
  return list.locator('li').filter({
    has: list.page().getByRole('button', { name: new RegExp(`· ${escape(title)}$`) }),
  });
}

/** The row's facts line: kind · type · points · difficulty · estimate · repository. */
function factsLine(row: Locator): Locator {
  return row.locator(':scope > div.min-w-0 > div').nth(1);
}

/** The value of one labelled rail field of a peek. */
function railValue(peek: Locator, label: string): Locator {
  return peek.locator(
    `xpath=.//dt[normalize-space(text()[1])='${label}']/following-sibling::dd[1]`,
  );
}

/** The work-item peek `/items?peek=` opens, once its rail has painted. */
async function openCardPeek(page: Page, key: string): Promise<Locator> {
  expect((await page.goto(`/items?peek=${encodeURIComponent(key)}`))?.status()).toBe(200);
  const peek = page.getByRole('dialog', {
    name: peekCopy.quickViewDialogLabel.replace('{key}', key),
  });
  await expect(railValue(peek, peekCopy.repositories)).toBeVisible({ timeout: 30_000 });
  return peek;
}

/** The repository NAMES a peek's rail draws — each is a link to the repository. */
async function railRepositories(peek: Locator): Promise<string[]> {
  const links = railValue(peek, peekCopy.repositories).getByRole('link');
  return (await links.allInnerTexts()).map((t) => t.trim());
}

/** The proposal peek of a review row. */
async function openProposalPeek(list: Locator, title: string): Promise<Locator> {
  const page = list.page();
  await reviewRow(list, title)
    .getByRole('button', { name: new RegExp(`· ${escape(title)}$`) })
    .click();
  const peek = page.getByRole('dialog').getByTestId('proposal-peek');
  await expect(peek).toBeVisible();
  await expect(railValue(peek, peekCopy.repositories)).toBeVisible();
  return peek;
}

async function closePeek(page: Page, peek: Locator): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(peek).toBeHidden();
}

function roomRow(page: Page, name: string): Locator {
  return page.getByRole('main').locator('[data-testid^="takeover-row-"]').filter({ hasText: name });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── The walk ──────────────────────────────────────────────────────────────────

/** The recorded test's output directory, for the sidecar test after it. */
let recordingDir: string | null = null;

test.beforeAll(async () => {
  await resetDatabase();
  resetGithubFixture();
});

test('a plan needing a new repository lays one init card ahead of the work, and its owner decides who does it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}, testInfo) => {
  acceptanceStory('MOTIR-10162');
  recordingDir = testInfo.outputDir;

  const seed = await seedInitCardTenant();
  const { ledger, mobile, billing } = seed;
  await activate(seed, ledger.projectId);
  await signIn(page, EMAIL, PASSWORD);

  // The executors each arm's peek renders, compared across arms in chapter 2.
  let hostedExecutor = '';
  // The ledger plan's overlay the first chapter opens; the second reads its list again.
  let hostedOverlay: Locator | undefined;

  await chapter(CHAPTERS[0], async () => {
    const overlay = await openUndecidedPlan(page, ledger.planId, { view: 'list' });
    hostedOverlay = overlay;
    const list = overlay.getByTestId('plan-proposal-list');
    await expect(list).toBeVisible();

    const adds = list
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: new RegExp(`^${reviewCopy.listAdds}`) }) });
    await expect(adds.locator('li')).toHaveCount(3);
    await expect(reviewRow(adds, TITLE.ledgerInit)).toHaveCount(1);

    // The review the pane is built from: exactly one init card, and both cards
    // behind it are blocked by it.
    const review = await readReview(page, ledger.planId);
    const inits = review.items.filter((i) => i.subject === 'init');
    expect(inits.map((i) => i.title)).toEqual([TITLE.ledgerInit]);
    const init = inits[0]!;
    for (const title of [TITLE.ledgerEndpoints, TITLE.ledgerCheckout]) {
      expect(itemTitled(review, title).blockedByNodeIds, `${title} waits on the init card`).toEqual(
        [init.nodeId],
      );
    }

    // No row names the repository: the facts line renders the item's repository,
    // and none of them has one. The other facts are there.
    for (const title of [TITLE.ledgerInit, TITLE.ledgerEndpoints, TITLE.ledgerCheckout]) {
      const facts = factsLine(reviewRow(adds, title));
      await expect(facts).toBeVisible();
      await expect(facts).not.toContainText(LEDGER_REPO);
      await expect(facts).toContainText('task');
      await expect(facts).toContainText('code');
      const item = itemTitled(review, title);
      await expect(facts).toContainText(
        reviewCopy.listPoints.replace('{n}', String(item.storyPoints)),
      );
      await expect(facts).toContainText(
        reviewCopy.listMinutes.replace('{n}', String(item.estimateMinutes)),
      );
    }
    await expect(list).not.toContainText(LEDGER_REPO);
    await beat();
  });

  await chapter(CHAPTERS[1], async () => {
    // The hosted arm: the init card's peek draws no repository.
    // The list lives in the plan overlay the first chapter opened, not in the page's main.
    const hostedList = hostedOverlay!.getByTestId('plan-proposal-list');
    const hostedPeek = await openProposalPeek(hostedList, TITLE.ledgerInit);
    expect(await railRepositories(hostedPeek)).toEqual([]);
    await expect(railValue(hostedPeek, peekCopy.repositories)).not.toContainText(LEDGER_REPO);
    hostedExecutor = (await railValue(hostedPeek, peekCopy.executor).innerText()).trim();
    expect(hostedExecutor.length).toBeGreaterThan(0);
    await beat();
    await closePeek(page, hostedPeek);

    // The person's arm, on the project whose repositories are their own.
    await activate(seed, mobile.projectId);
    const overlay = await openUndecidedPlan(page, mobile.planId, { view: 'list' });
    const list = overlay.getByTestId('plan-proposal-list');
    const row = reviewRow(list, TITLE.mobileInit);
    await expect(factsLine(row)).toContainText('manual');
    await expect(factsLine(row)).not.toContainText(MOBILE_REPO);

    const personalPeek = await openProposalPeek(list, TITLE.mobileInit);
    expect(await railRepositories(personalPeek)).toEqual([]);
    await expect(railValue(personalPeek, peekCopy.repositories)).not.toContainText(MOBILE_REPO);
    const personalExecutor = (await railValue(personalPeek, peekCopy.executor).innerText()).trim();
    expect(personalExecutor.length).toBeGreaterThan(0);
    // The owner axis: the same kind of card, a different executor.
    expect(personalExecutor).not.toBe(hostedExecutor);
    await beat();
    await closePeek(page, personalPeek);
  });

  let ledgerReview: PlanReviewDto | null = null;

  await chapter(CHAPTERS[2], async () => {
    await activate(seed, ledger.projectId);
    const overlay = await openUndecidedPlan(page, ledger.planId, { view: 'list' });
    const approve = overlay
      .getByTestId('plan-change-confirm-bar')
      .getByRole('button', { name: 'Approve', exact: true });
    await expect(approve).toBeVisible();
    const approved = page.waitForResponse(
      (r) => /\/api\/plans\/[^/]+\/approve/.test(r.url()) && r.request().method() === 'POST',
    );
    await approve.click();
    expect((await approved).status(), 'the approve write succeeded').toBe(200);
    await beat();

    // The decided record: its adds read as Created.
    expect((await page.goto(`/plans/${ledger.planId}`))?.status()).toBe(200);
    const views = page.getByRole('main').getByTestId('plan-proposal-views');
    await expect(views).toBeVisible({ timeout: 30_000 });
    await views
      .getByRole('group', { name: reviewCopy.viewSwitchAria })
      .getByRole('button', { name: reviewCopy.viewList, exact: true })
      .click();
    const list = views.getByTestId('plan-proposal-list');
    await expect(
      list.getByRole('heading', { name: new RegExp(`^${reviewCopy.listCreated}`) }),
    ).toBeVisible();
    await expect(
      list.getByRole('heading', { name: new RegExp(`^${reviewCopy.listAdds}`) }),
    ).toHaveCount(0);
    await beat();

    ledgerReview = await readReview(page, ledger.planId);
    expect(ledgerReview.status).toBe('approved');

    // Declaring a repository is not pinning one: every created card, the init
    // card included, draws an empty repository rail.
    for (const title of [TITLE.ledgerInit, TITLE.ledgerEndpoints, TITLE.ledgerCheckout]) {
      const peek = await openCardPeek(page, keyOf(ledgerReview, title));
      expect(await railRepositories(peek), `${title} names no repository`).toEqual([]);
    }
    await beat();

    // The order holds: the init card may start, the work behind it may not.
    const ready = await readyKeys(page, ledger);
    expect(ready).toContain(keyOf(ledgerReview, TITLE.ledgerInit));
    expect(ready).not.toContain(keyOf(ledgerReview, TITLE.ledgerEndpoints));
    expect(ready).not.toContain(keyOf(ledgerReview, TITLE.ledgerCheckout));
  });

  let ledgerRowId = '';

  await chapter(CHAPTERS[3], async () => {
    // Arrive with the row appended, as a run's tool appends it.
    const appended = await projectRepoSetService.addRow(
      ledger.projectId,
      { role: 'infra', name: LEDGER_REPO },
      seed.ctx,
    );
    ledgerRowId = appended.id;

    const answer = await establish(page, ledger, ledgerRowId);
    const mine = answer.rows.find((r) => r.rowId === ledgerRowId);
    expect(mine?.outcome).toBe('created');
    expect(mine?.row?.state).toBe('created');

    await expect
      .poll(
        async () => (await readRepositories(page, ledger)).find((r) => r.id === ledgerRowId)?.state,
      )
      .toBe('created');
    expect(createsFor(LEDGER_REPO), 'the host was asked to create it once').toBe(1);

    expect((await page.goto('/settings/project/repositories'))?.status()).toBe(200);
    const row = roomRow(page, LEDGER_REPO);
    await expect(row).toBeVisible();
    await expect(
      row.getByText(enMessages.repositorySet.stateCreated, { exact: true }),
    ).toBeVisible();
    await beat();
  });

  let routedBefore: string[] = [];

  await chapter(CHAPTERS[4], async () => {
    const review = ledgerReview!;
    for (const title of [TITLE.ledgerEndpoints, TITLE.ledgerCheckout]) {
      const peek = await openCardPeek(page, keyOf(review, title));
      await expect(railValue(peek, peekCopy.repositories).getByRole('link')).toHaveText([
        LEDGER_REPO,
      ]);
      routedBefore = await railRepositories(peek);
      await beat();
    }
    // The init card itself is never pinned: it created the repository.
    const initPeek = await openCardPeek(page, keyOf(review, TITLE.ledgerInit));
    expect(await railRepositories(initPeek)).toEqual([]);

    // Establishing the repository completed the init card, so the work behind it
    // leaves the wait and may now start — pointed at its checkout.
    await expect
      .poll(async () => readyKeys(page, ledger))
      .toEqual(
        expect.arrayContaining([
          keyOf(review, TITLE.ledgerEndpoints),
          keyOf(review, TITLE.ledgerCheckout),
        ]),
      );
    expect(await readyKeys(page, ledger)).not.toContain(keyOf(review, TITLE.ledgerInit));
  });

  await chapter(CHAPTERS[5], async () => {
    await activate(seed, billing.projectId);
    const approved = await call(
      page,
      'POST',
      `/api/plans/${encodeURIComponent(billing.planId)}/approve`,
    );
    expect(approved.status(), 'the billing plan was approved').toBe(200);
    const review = await readReview(page, billing.planId);

    const appended = await projectRepoSetService.addRow(
      billing.projectId,
      { role: 'infra', name: BILLING_REPO },
      seed.ctx,
    );
    setGithubControl({
      createFailures: {
        [BILLING_REPO]: { status: 403, message: 'Resource not accessible by integration' },
      },
    });

    const answer = await establish(page, billing, appended.id);
    const mine = answer.rows.find((r) => r.rowId === appended.id);
    expect(mine?.outcome).toBe('failed');
    expect(mine?.row?.state).toBe('failed');

    // The row is still read, not hidden.
    const rows = await readRepositories(page, billing);
    expect(rows.find((r) => r.id === appended.id)).toMatchObject({
      name: BILLING_REPO,
      state: 'failed',
    });

    // The waiter is held and unpinned.
    const waiter = keyOf(review, TITLE.billingInvoices);
    const peek = await openCardPeek(page, waiter);
    expect(await railRepositories(peek)).toEqual([]);
    await expect(railValue(peek, peekCopy.repositories)).not.toContainText(BILLING_REPO);
    const ready = await readyKeys(page, billing);
    expect(ready).not.toContain(waiter);
    expect(ready).toContain(keyOf(review, TITLE.billingInit));
    await beat();

    setGithubControl({});
  });

  await chapter(CHAPTERS[6], async () => {
    await activate(seed, ledger.projectId);
    const before = await readRepositories(page, ledger);

    const answer = await establish(page, ledger, ledgerRowId);
    expect(answer.rows.find((r) => r.rowId === ledgerRowId)?.outcome).toBe('already_settled');

    const after = await readRepositories(page, ledger);
    expect(after).toHaveLength(before.length);
    expect(after).toEqual(before);
    expect(createsFor(LEDGER_REPO), 'still one create').toBe(1);

    const peek = await openCardPeek(page, keyOf(ledgerReview!, TITLE.ledgerEndpoints));
    expect(await railRepositories(peek)).toEqual(routedBefore);
    await beat();
  });

  // The queue was only ever read.
  expect(sent.filter((s) => s.startsWith('POST /api/ready'))).toEqual([]);
  expect(sent.some((s) => s.startsWith('GET /api/ready'))).toBe(true);
});

test('the recording declares its story, is paced, and is owned by this spec', async () => {
  test.skip(recordingDir === null, 'the recorded test did not run in this worker');
  const dir = recordingDir!;
  const read = (name: string): unknown => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));

  const chapters = read('chapters.json') as { label: string; tSeconds: number }[];
  expect(chapters.map((c) => c.label)).toEqual([...CHAPTERS]);
  const offsets = chapters.map((c) => c.tSeconds);
  expect(offsets).toEqual([...offsets].sort((a, b) => a - b));

  expect(read('acceptance-story.json')).toEqual({ storyKey: 'MOTIR-10162' });

  const meta = read('recording-meta.json') as { totalSeconds: number; specFile: string };
  const verdict = assessWatchability({ chapters, meta });
  expect(verdict.watchable, verdict.reason ?? '').toBe(true);
  expect(meta.totalSeconds).toBeGreaterThanOrEqual(MIN_WATCHABLE_SECONDS);
  expect(verdict.medianGapSeconds ?? 0).toBeGreaterThanOrEqual(MIN_MEDIAN_CHAPTER_GAP_SECONDS);

  // Owned the way the uploader resolves it: the changed-spec set names this file.
  const thisSpec = 'tests/e2e/acceptance-init-card.spec.ts';
  expect(meta.specFile).toBe(thisSpec);
  expect(isOwnedRecording(meta, new Set([thisSpec]))).toBe(true);

  // The file as executed: the acceptance harness's test, no module mocked, no
  // product surface stubbed.
  const source = readFileSync(path.join(__dirname, 'acceptance-init-card.spec.ts'), 'utf8');
  expect(source).toContain("from './_helpers/acceptance-video'");
  expect(source).not.toMatch(/import \{[^}]*\b(test|expect)\b[^}]*\} from '@playwright\/test'/);
  const lines = source.split('\n').filter((l) => !l.includes('SELF-AUDIT'));
  for (const stub of ['vi.mock', 'page.route(', 'context.route(']) {
    expect(
      lines.filter((l) => l.includes(stub)),
      `no ${stub}`,
    ).toEqual([]); // SELF-AUDIT
  }
});
