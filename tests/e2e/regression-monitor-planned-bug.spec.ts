import { readFileSync, writeFileSync } from 'node:fs';
import type { APIResponse, Page, Route } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { actionWrite } from './_helpers/authoritative-signal';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import type { AiJobsFixture } from '@/lib/test-ai-jobs-mock';

// A FILED BUG ARRIVES PLANNED, WALKED IN A BROWSER (Story MOTIR-4930 · Subtask
// MOTIR-5853) — the story's acceptance receipt, paced for a person to read: an
// error arrives, becomes a bug, and that bug is ALREADY PLANNED when it is opened
// — a body with acceptance criteria and context refs, an AI-drafted explanation,
// a type, an executor and a size. Then the three ways that could go wrong, each
// shown surviving: a code-blind project, a broken AI, and a person who edited the
// card first.
//
// ── ⚠️ WHAT IS FAKE, AND WHAT IS NOT ───────────────────────────────────────
// TWO things are replaced, both at their boundary and both in the SERVER process:
//   · Sentry — `MOTIR_MONITOR_FAKE_PROVIDER=1`; `POST /api/_test/monitors/poll`
//     seeds the fake's issues and runs a poll synchronously (MOTIR-5584's door).
//   · motir-ai — `E2E_TEST_AI_JOBS=1`; `lib/test-ai-jobs-mock.ts` answers the
//     `author_bug` job from `MOTIR_AI_JOBS_FIXTURE_PATH`, a file re-read on every
//     request, so each chapter declares what the model "said".
// Everything between them is real: the reconcile, the work-item create, the
// dispatch's envelope assembly, the answer's re-validation, the write predicate,
// the gated `updateWorkItem`, and the item page.
//
// ⚠️ THE ENRICHMENT RUNS THROUGH A `_test` DOOR, NOT THE JOB WORKER, and why:
// the lane's worker is a separate process without the motir-ai fake, and giving
// it `MOTIR_AI_URL` would switch the AI layer on for every worker job in the lane.
// `POST /api/_test/monitors/enrich` runs the SAME two service calls the job runs
// (`dispatchEnrichment`, `applyAuthoredBug`) in the server process — the poll
// door's shape. The detached job itself is driven for real by the vitest gate
// (MOTIR-5852).
//
// ⚠️ THE MOUNTING CHECK comes first, so a lane that lost either fake fails there
// instead of filming a thin card as though it were the walk.

const EMAIL = `planned-bug-${Date.now()}@motir.test`;
const PASSWORD = 'Sup3rSecret!Pass';
const ROOM = '/settings/project/monitoring';
const INSTALL_HOST = 'sentry-install.e2e.invalid';
const MOTIR_AI_ORIGIN = /https?:\/\/motir-ai\.e2e\.local\//;

let storeProjectId = '';
let docsProjectId = '';
let ownerCtx = { userId: '', workspaceId: '' };
let storeConnectionId = '';
let docsConnectionId = '';
const escapedRequests: string[] = [];

const fixturePath = () => {
  const p = process.env['MOTIR_AI_JOBS_FIXTURE_PATH'];
  if (!p) throw new Error('MOTIR_AI_JOBS_FIXTURE_PATH is unset — wrong lane');
  return p;
};
const readFixture = (): AiJobsFixture => {
  try {
    return JSON.parse(readFileSync(fixturePath(), 'utf8')) as AiJobsFixture;
  } catch {
    return {};
  }
};
const authorSubmits = () => (readFixture().submitted ?? []).filter((s) => s.kind === 'author_bug');

/** A body shaped exactly as motir-ai renders one (MOTIR-5847/5848). */
function answer(opts: { grounded: boolean; refs: string[] }) {
  const refsSection = opts.grounded
    ? opts.refs.map((r) => `- \`${r}\``).join('\n')
    : [
        '- Context refs could not be resolved: no repository is connected to this project. Any paths below are the stack frames exactly as the monitor reported them, unchecked.',
        ...opts.refs.map((r) => `- \`${r}\``),
      ].join('\n');
  return {
    descriptionMd: [
      '`GET /checkout` throws `TypeError: Cannot read properties of undefined (reading "total")` from `cartTotal`, reached through the checkout page. Seen 14 times since yesterday in `production`, release `web@2.4.1`.',
      '',
      '## Acceptance criteria',
      '',
      '- Opening the checkout with an empty cart shows the empty-cart state instead of an error.',
      '- No new event of this issue is recorded after the fix deploys.',
      '',
      '## Candidate mechanisms',
      '',
      'None of these is established. Each is a hypothesis the stack trace is consistent with, listed so the first person to look can rule them in or out — not a diagnosis.',
      '',
      '- The cart may be read before it has loaded, so `total` is taken from `undefined`.',
      '- An expired session may return a cart with no line items and no totals object.',
      '',
      '## Context refs',
      '',
      refsSection,
    ].join('\n'),
    explanationMd:
      'People with an empty or expired cart cannot reach checkout at all — the page errors instead of explaining. It has happened 14 times since yesterday.',
    type: 'code',
    executor: 'coding_agent',
    storyPoints: 2,
    estimateMinutes: 45,
    contextRefs: opts.refs,
    candidateMechanisms: [
      'The cart may be read before it has loaded, so `total` is taken from `undefined`.',
      'An expired session may return a cart with no line items and no totals object.',
    ],
    grounded: opts.grounded,
    groundingReason: opts.grounded ? 'indexed' : 'no_repos',
  };
}

/** Declare what the NEXT `author_bug` jobs settle as, consumed in submit order. */
function declareAuthorJobs(queue: NonNullable<AiJobsFixture['authorBug']>) {
  const current = readFixture();
  writeFileSync(fixturePath(), JSON.stringify({ ...current, authorBug: queue }, null, 2));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetDatabase();
  writeFileSync(fixturePath(), JSON.stringify({ submitted: [] }));
  const owner = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Zhu Yue',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  ownerCtx = { userId: owner.id, workspaceId: workspace.id };
  const store = await projectsService.createProject({
    name: 'Storefront',
    identifier: 'STORE',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const docs = await projectsService.createProject({
    name: 'Docs site',
    identifier: 'DOCS',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  storeProjectId = store.id;
  docsProjectId = docs.id;
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: store.id },
  });
  // STOREFRONT has an established repository; DOCS has none — the code-blind one.
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspace.id },
    select: { organizationId: true },
  });
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: 'inst-planned-bug',
      workspaceId: workspace.id,
      organizationId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: workspace.id,
      organizationId,
      repoId: '4930101',
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  await linkProjectRepo({
    workspaceId: workspace.id,
    projectId: store.id,
    githubRepoId: repo.id,
    name: 'web',
    role: 'web',
  });
});

/** Sentry's install-approval page, stood in exactly as MOTIR-5584 does. */
async function standInSentry(page: Page): Promise<void> {
  await page.route('**/api/monitors/sentry/oauth/start**', async (route: Route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = new URL(response.headers()['location'] ?? '');
    expect(location.host).toBe(INSTALL_HOST);
    const callback = new URL('/api/monitors/sentry/oauth/callback', route.request().url());
    callback.searchParams.set('code', 'valid-code');
    callback.searchParams.set('installationId', 'inst-planned-bug-1');
    callback.searchParams.set('state', location.searchParams.get('state') ?? '');
    const setCookie = response
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value)
      .join('\n');
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'set-cookie': setCookie },
      body: `<!doctype html><html><head><title>Sentry — Install Motir</title></head>
        <body style="font-family:system-ui;max-width:32rem;margin:4rem auto">
          <h1>Install Motir on fake-org</h1>
          <a href="${callback.toString()}">Approve</a>
        </body></html>`,
    });
  });
}

const FRAMES = [
  { filePath: 'app/checkout/page.tsx', function: 'CheckoutPage', lineNumber: 31, inApp: true },
  { filePath: 'lib/cart/total.ts', function: 'cartTotal', lineNumber: 12, inApp: true },
];

/** One error arrives in Sentry for `connectionId`; a check runs; ONE bug is filed. */
async function errorArrives(page: Page, connectionId: string, externalId: string, title: string) {
  const res: APIResponse = await page.request.post('/api/_test/monitors/poll', {
    data: {
      connectionId,
      issues: [
        {
          externalId,
          title,
          culprit: 'app/checkout/page.tsx in CheckoutPage',
          level: 'error',
          eventCount: 14,
          firstSeenAt: new Date(Date.now() - 86_400_000).toISOString(),
          lastSeenAt: new Date(Date.now() + 60_000).toISOString(),
          environment: 'production',
          release: 'web@2.4.1',
          frames: FRAMES,
        },
      ],
    },
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: 'ok', filed: 1 });
  return adminDb.workItem.findFirstOrThrow({
    where: { kind: 'bug', title },
    select: { id: true, identifier: true },
  });
}

/** Run the enrichment the job would run, through the `_test` door. */
async function enrich(page: Page, workItemId: string, phase?: 'dispatch', jobId?: string) {
  const res = await page.request.post('/api/_test/monitors/enrich', {
    data: { workItemId, ...(phase ? { phase } : jobId ? { phase: 'apply', jobId } : {}) },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    dispatch?: { dispatched: boolean; jobId?: string; reason?: string };
    applied?: { status: string; reason?: string };
  };
}

const description = (page: Page) => page.getByRole('main').getByLabel('Work item description');

async function setActiveProject(projectId: string) {
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: ownerCtx.userId, workspaceId: ownerCtx.workspaceId } },
    data: { activeProjectId: projectId },
  });
}

test('an error arrives as a PLANNED bug — and a code-blind project, a broken AI and a human edit each still get a card', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-4930');

  await page.route(/https?:\/\/([a-z0-9-]+\.)*sentry\.io\//, async (route) => {
    escapedRequests.push(route.request().url());
    await route.abort();
  });
  await page.route(MOTIR_AI_ORIGIN, async (route) => {
    escapedRequests.push(route.request().url());
    await route.abort();
  });

  await chapter(
    'Both fakes are mounted: the monitor door, the AI fixture, and a Sentry grant for fake-org',
    async () => {
      // ⚠️ THE MOUNTING CHECK. Each failure names the LANE, not the assertion.
      expect(
        process.env['MOTIR_AI_JOBS_FIXTURE_PATH'],
        'MOTIR_AI_JOBS_FIXTURE_PATH is unset — wrong lane',
      ).toBeTruthy();
      await signIn(page, EMAIL, PASSWORD);
      const pollDoor = await page.request.post('/api/_test/monitors/poll', {
        data: { connectionId: 'not-a-binding' },
      });
      expect(pollDoor.status(), 'the _test monitor door is not mounted — wrong lane').toBe(404);
      // A 404 cannot tell a mounted door from the production gate — both answer
      // it. A body with no work item is refused 400 only PAST the gate.
      const enrichDoor = await page.request.post('/api/_test/monitors/enrich', { data: {} });
      expect(enrichDoor.status(), 'the _test enrichment door is not mounted — wrong lane').toBe(
        400,
      );

      await standInSentry(page);
      await page.goto(ROOM);
      await page.getByRole('link', { name: 'Connect Sentry' }).click();
      await page.getByRole('link', { name: 'Approve' }).click();
      await page.waitForURL(`**${ROOM}?monitor=connected`);
      await expect(
        page.getByRole('main'),
        'the grant is not the fake’s — wrong lane',
      ).toContainText('fake-org');

      storeConnectionId = (
        await monitorConnectionService.bindProject(
          storeProjectId,
          { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
          ownerCtx,
        )
      ).id;
      docsConnectionId = (
        await monitorConnectionService.bindProject(
          docsProjectId,
          { externalProjectId: 'fake-docs', externalProjectSlug: 'docs' },
          ownerCtx,
        )
      ).id;
      await page.reload();
      await expect(page.getByRole('main')).toContainText('web');
      await beat();
    },
  );

  await chapter('An error arrives — and the bug it becomes is already PLANNED', async () => {
    declareAuthorJobs([
      {
        authoredBug: answer({
          grounded: true,
          refs: ['app/checkout/page.tsx', 'lib/cart/total.ts'],
        }),
      },
      { authoredBug: answer({ grounded: false, refs: ['app/checkout/page.tsx'] }) },
      { status: 'failed' },
      { authoredBug: answer({ grounded: true, refs: ['lib/cart/total.ts'] }) },
    ]);
    const bug = await errorArrives(
      page,
      storeConnectionId,
      'checkout-total',
      'TypeError: Cannot read properties of undefined (reading "total")',
    );
    const outcome = await enrich(page, bug.id);
    expect(outcome).toMatchObject({
      dispatch: { dispatched: true },
      applied: { status: 'applied' },
    });
    expect(authorSubmits().at(-1)).toMatchObject({ hasCode: true });

    await page.goto(`/items/${bug.identifier}`);
    const body = description(page);
    await expect(body.getByRole('heading', { name: 'Acceptance criteria' })).toBeVisible();
    await expect(body.getByRole('listitem').filter({ hasText: 'empty-cart state' })).toBeVisible();
    await expect(body.getByRole('heading', { name: 'Context refs' })).toBeVisible();
    await expect(body.getByText('lib/cart/total.ts')).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('No explanation yet.');
    await expect(page.getByRole('main').getByLabel('Work item explanation')).toContainText(
      'cannot reach checkout',
    );
    // The sizing and routing the answer carried, read from the committed row…
    const row = await adminDb.workItem.findUniqueOrThrow({
      where: { id: bug.id },
      select: {
        type: true,
        executor: true,
        storyPoints: true,
        estimateMinutes: true,
        explanationSource: true,
      },
    });
    expect({ ...row, storyPoints: Number(row.storyPoints) }).toEqual({
      type: 'code',
      executor: 'coding_agent',
      storyPoints: 2,
      estimateMinutes: 45,
      explanationSource: 'ai_draft',
    });
    // …and shown on the page.
    await expect(page.getByRole('main')).toContainText('45m');
    // Paced: the reviewer is accepting what this card SAYS — hold on it.
    await beat();
    await body.getByRole('heading', { name: 'Context refs' }).scrollIntoViewIfNeeded();
    await beat();
  });

  await chapter('The explanation is marked AI-drafted', async () => {
    await expect(page.getByRole('main').getByText('AI-drafted', { exact: true })).toBeVisible();
    await beat();
  });

  await chapter(
    'A code-blind project still gets a planned card — saying refs could not be resolved',
    async () => {
      const bug = await errorArrives(
        page,
        docsConnectionId,
        'docs-search',
        'TypeError: Cannot read properties of undefined (reading "total") in docs search',
      );
      const outcome = await enrich(page, bug.id);
      expect(outcome).toMatchObject({ applied: { status: 'applied' } });
      // The dispatch for the project with no repository carried no repository set.
      expect(authorSubmits().at(-1)).toMatchObject({ hasCode: false });

      // The item page reads the ACTIVE project, so the walk steps into Docs site
      // for this one card and back out after it.
      await setActiveProject(docsProjectId);
      await page.goto(`/items/${bug.identifier}`);
      await expect(description(page)).toContainText('Context refs could not be resolved');
      await expect(
        description(page).getByRole('heading', { name: 'Acceptance criteria' }),
      ).toBeVisible();
      await expect(page.getByRole('main').getByLabel('Work item explanation')).toBeVisible();
      await beat();
      await setActiveProject(storeProjectId);
    },
  );

  await chapter('A broken AI still gets a card — thin, but filed and not lost', async () => {
    const bug = await errorArrives(
      page,
      storeConnectionId,
      'checkout-tax',
      'RangeError: tax rate out of range in checkout',
    );
    const outcome = await enrich(page, bug.id);
    expect(outcome).toMatchObject({ applied: { status: 'skipped', reason: 'job-failed' } });

    await page.goto(`/items/${bug.identifier}`);
    await expect(page.getByRole('main')).toContainText('No explanation yet.');
    await expect(description(page)).toContainText('level');
    await beat();
  });

  await chapter('A person who edited the card first keeps their words', async () => {
    const bug = await errorArrives(
      page,
      storeConnectionId,
      'checkout-coupon',
      'TypeError: coupon.discount is undefined',
    );
    // The job is dispatched; its answer is held back while a person edits.
    const dispatched = await enrich(page, bug.id, 'dispatch');
    expect(dispatched.dispatch).toMatchObject({ dispatched: true });

    const typed = 'Reproduced: the coupon field is empty for guest checkouts. I am on it.';
    await page.goto(`/items/${bug.identifier}/edit`);
    const editor = page.getByRole('textbox', { name: 'Description' });
    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(typed);
    const saved = actionWrite(page, `/items/${bug.identifier}/edit`, bug.id);
    await page.getByRole('button', { name: 'Save' }).click();
    expect((await saved).status()).toBe(200);
    await expect
      .poll(
        async () =>
          (await adminDb.workItem.findUniqueOrThrow({ where: { id: bug.id } })).descriptionMd,
      )
      .toBe(typed);

    // …now the answer lands, and is refused: the card is no longer the one filed.
    const landed = await enrich(page, bug.id, undefined, dispatched.dispatch!.jobId);
    expect(landed.applied).toEqual({ status: 'skipped', reason: 'card-changed' });

    await page.goto(`/items/${bug.identifier}`);
    await expect(description(page)).toContainText(typed);
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: bug.id } })).descriptionMd,
    ).toBe(typed);
    await beat();
  });

  await chapter('Nothing reached sentry.io or a real motir-ai', async () => {
    expect(escapedRequests).toEqual([]);
    await beat();
  });
});
