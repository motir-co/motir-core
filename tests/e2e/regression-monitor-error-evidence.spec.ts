import { readFileSync, writeFileSync } from 'node:fs';
import type { APIResponse, Page, Route } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { agentSession } from './_helpers/agent-authored-plan-seed';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import type { AiJobsFixture } from '@/lib/test-ai-jobs-mock';

// A MONITOR-FILED BUG CARRIES ITS ERROR EVIDENCE, WALKED IN A BROWSER (Story
// MOTIR-5975 · Subtask MOTIR-5985) — the story's acceptance receipt, paced for a
// person to watch: an error's latest event shows on the filed bug's Errors row
// (the full message, the app's own frames first, the tags, the request line),
// the SAME evidence comes back over `get_work_item` and in the dispatch prompt,
// a bug filed before this story is backfilled and enriched exactly once, and a
// refused read leaves the evidence standing, marked out of date.
//
// ── ⚠️ WHAT IS FAKE, AND WHAT IS NOT ───────────────────────────────────────
// Sentry (`MOTIR_MONITOR_FAKE_PROVIDER=1`) and motir-ai (`E2E_TEST_AI_JOBS=1`) are
// replaced at their boundary, in the SERVER process, exactly as
// `regression-monitor-planned-bug.spec.ts` replaces them. The fake runs the
// evidence through the SAME tag filter and path reader the Sentry adapter does,
// so a `user.email` seeded here is dropped by the product, not by the spec.
// Everything between is real: the poll, the store, the backfill sweep, the item
// page, `/api/mcp` and `/api/v1`'s dispatch prompt.
//
// ⚠️ THE ENRICHMENT RUNS THROUGH THE `_test` DOOR, NOT THE JOB WORKER — the
// lane's worker has no motir-ai fake (the planned-bug spec's header says why).
// So this spec asserts the SWEEP'S poll-side counts (`evidenceBackfilled`,
// `enrichmentRequested`) and the enrichment's outcome through the door; the
// detached `monitor-issue/enrichment-backfill` job is driven for real by the
// story's vitest gate (MOTIR-5984).
//
// ⚠️ A "PRE-STORY" LINK is planted from the store: a bug filed normally, then
// its link's evidence cleared, its job id cleared, and both rows backdated past
// the sweep's one-hour grace window — the state every bug filed before this
// story is in. Its issue is NOT in the next poll's listing, so only the sweep
// can reach it.
//
// ⚠️ THE PROMPT'S SECTION is the banner `ERROR EVIDENCE — …`, not a Markdown
// `## Error evidence` — the recorded deviation on MOTIR-5982.

const EMAIL = `error-evidence-${Date.now()}@motir.test`;
const PASSWORD = 'Sup3rSecret!Pass';
const ROOM = '/settings/project/monitoring';
const INSTALL_HOST = 'sentry-install.e2e.invalid';
const MOTIR_AI_ORIGIN = /https?:\/\/motir-ai\.e2e\.local\//;
const PROMPT_BANNER = 'ERROR EVIDENCE — what the monitor recorded for this work item';

let projectId = '';
let ownerCtx = { userId: '', workspaceId: '' };
let connectionId = '';
let token = '';
const escapedRequests: string[] = [];

const T0 = Date.now();
const EVENT_AT = new Date(T0 - 5 * 60_000).toISOString();
const MESSAGE =
  'Transaction API error: A commit cannot be executed on an expired transaction. ' +
  'The timeout for this transaction was 5000 ms, however 19058 ms passed since the start ' +
  'of the transaction. Consider increasing the interactive transaction timeout or doing ' +
  'less work in the transaction, because the webhook handler upserts every pull request ' +
  'in one transaction.';
const TITLE_A = `PrismaClientKnownRequestError: ${MESSAGE}`;
const TITLE_B = 'TypeError: Cannot read properties of undefined (reading "installation")';
const FRAMES = [
  {
    filePath: 'lib/services/githubWebhookService.ts',
    function: 'upsertPullRequest',
    lineNumber: 412,
    inApp: true,
  },
  {
    filePath: 'lib/services/githubWebhookService.ts',
    function: 'handlePullRequestEvent',
    lineNumber: 188,
    inApp: true,
  },
  { filePath: 'app/api/github/webhook/route.ts', function: 'POST', lineNumber: 74, inApp: true },
  {
    filePath: 'node_modules/@prisma/client/runtime/library.js',
    function: 'commit',
    lineNumber: 121,
    inApp: false,
  },
  {
    filePath: 'node_modules/next/dist/server/base-server.js',
    function: 'handleRequest',
    lineNumber: 900,
    inApp: false,
  },
];

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
  const project = await projectsService.createProject({
    name: 'Motir core',
    identifier: 'CORE',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  projectId = project.id;
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  // The bearer an agent reads the work item with — project-scoped, read only.
  token = (
    await apiTokensService.create(owner.id, workspace.id, {
      label: 'error-evidence-e2e',
      projectId: project.id,
      permissions: ['project:browse'],
    })
  ).token;
});

/** Sentry's install-approval page, stood in exactly as the planned-bug walk does. */
async function standInSentry(page: Page): Promise<void> {
  await page.route('**/api/monitors/sentry/oauth/start**', async (route: Route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const location = new URL(response.headers()['location'] ?? '');
    expect(location.host).toBe(INSTALL_HOST);
    const callback = new URL('/api/monitors/sentry/oauth/callback', route.request().url());
    callback.searchParams.set('code', 'valid-code');
    callback.searchParams.set('installationId', 'inst-error-evidence-1');
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

/** The webhook failure: a long message, 3 app frames + 2 framework, tags with a
 *  user's email, a request with a query string. */
function issueA(lastSeenMinutes: number) {
  return {
    externalId: 'webhook-expired-tx',
    title: TITLE_A,
    culprit: 'lib/services/githubWebhookService.ts in upsertPullRequest',
    level: 'error',
    eventCount: 107,
    firstSeenAt: new Date(T0 - 86_400_000).toISOString(),
    lastSeenAt: new Date(T0 + lastSeenMinutes * 60_000).toISOString(),
    environment: 'production',
    release: 'motir-core@5b9ad67fb',
    frames: FRAMES,
    exception: { type: 'PrismaClientKnownRequestError', message: MESSAGE },
    rawTags: [
      { key: 'environment', value: 'production' },
      { key: 'transaction', value: 'POST /api/github/webhook' },
      { key: 'user.email', value: 'someone@example.com' },
      { key: 'runtime', value: 'node' },
    ],
    requestMethod: 'POST',
    requestUrl: 'https://app.motir.co/api/github/webhook?x=1',
    eventId: '3f9a1c7e04b2d88a91c0e5f1a2b3c4d5',
    eventAt: EVENT_AT,
  };
}

/** The second error — filed, then made to look as if it predates the story. */
function issueB() {
  return {
    externalId: 'installation-undefined',
    title: TITLE_B,
    culprit: 'lib/services/githubInstallService.ts in resolveInstallation',
    level: 'error',
    eventCount: 12,
    firstSeenAt: new Date(T0 - 3 * 86_400_000).toISOString(),
    lastSeenAt: new Date(T0 + 60_000).toISOString(),
    environment: 'production',
    release: 'motir-core@5b9ad67fb',
    frames: [
      {
        filePath: 'lib/services/githubInstallService.ts',
        function: 'resolveInstallation',
        lineNumber: 57,
        inApp: true,
      },
    ],
    exception: {
      type: 'TypeError',
      message: 'Cannot read properties of undefined (reading "installation")',
    },
    rawTags: [{ key: 'transaction', value: 'GET /api/github/install' }],
    requestMethod: 'GET',
    requestUrl: '/api/github/install?setup_action=install',
    eventId: 'b7e0c1d2a3f4e5d6c7b8a9f0e1d2c3b4',
    eventAt: new Date(T0 - 10 * 60_000).toISOString(),
  };
}

/** Seed the fake and run ONE poll synchronously; returns its summary. */
async function poll(page: Page, issues: unknown[], extra: Record<string, unknown> = {}) {
  const res: APIResponse = await page.request.post('/api/_test/monitors/poll', {
    data: { connectionId, issues, ...extra },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    status: string;
    filed: number;
    evidenceBackfilled: number;
    enrichmentRequested: number;
  };
}

async function bugTitled(title: string) {
  return adminDb.workItem.findFirstOrThrow({
    where: { kind: 'bug', projectId, title: { startsWith: title.slice(0, 60) } },
    select: { id: true, identifier: true },
  });
}

// Scoped to the LIVE page, never page-rooted.
const row = (page: Page) => page.getByRole('main').getByTestId('error-row');

test('a monitor-filed bug carries its error evidence — on the page, over MCP and in the prompt — an old bug is backfilled once, and a refused read leaves it standing', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
  baseURL,
}) => {
  acceptanceStory('MOTIR-5975');
  test.setTimeout(300_000);

  await page.route(/https?:\/\/([a-z0-9-]+\.)*sentry\.io\//, async (route) => {
    escapedRequests.push(route.request().url());
    await route.abort();
  });
  await page.route(MOTIR_AI_ORIGIN, async (route) => {
    escapedRequests.push(route.request().url());
    await route.abort();
  });

  let bugA = { id: '', identifier: '' };
  let bugB = { id: '', identifier: '' };

  await chapter('Both fakes are mounted, and Sentry is connected for the project', async () => {
    // ⚠️ THE MOUNTING CHECK. Each failure names the LANE, not the assertion.
    expect(process.env['MOTIR_AI_JOBS_FIXTURE_PATH'], 'no AI fixture — wrong lane').toBeTruthy();
    await signIn(page, EMAIL, PASSWORD);
    const pollDoor = await page.request.post('/api/_test/monitors/poll', {
      data: { connectionId: 'not-a-binding' },
    });
    expect(pollDoor.status(), 'the _test monitor door is not mounted — wrong lane').toBe(404);
    const enrichDoor = await page.request.post('/api/_test/monitors/enrich', { data: {} });
    expect(enrichDoor.status(), 'the _test enrichment door is not mounted — wrong lane').toBe(400);

    await standInSentry(page);
    await page.goto(ROOM);
    await page.getByRole('link', { name: 'Connect Sentry' }).click();
    await page.getByRole('link', { name: 'Approve' }).click();
    await page.waitForURL(`**${ROOM}?monitor=connected`);
    await expect(page.getByRole('main'), 'the grant is not the fake’s — wrong lane').toContainText(
      'fake-org',
    );
    connectionId = (
      await monitorConnectionService.bindProject(
        projectId,
        { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
        ownerCtx,
      )
    ).id;
  });

  await chapter('An error arrives — and its bug shows the evidence on its Errors row', async () => {
    const summary = await poll(page, [issueA(2), issueB()]);
    expect(summary).toMatchObject({ status: 'ok', filed: 2 });
    bugA = await bugTitled(TITLE_A);
    bugB = await bugTitled(TITLE_B);

    await page.goto(`/items/${bugA.identifier}`);
    const errorRow = row(page);
    await expect(errorRow).toHaveCount(1);
    // Collapsed by default: the door summarises what broke and where.
    const summaryLine = errorRow.getByTestId('evidence-summary');
    await expect(summaryLine).toContainText('PrismaClientKnownRequestError');
    await expect(summaryLine).toContainText('POST /api/github/webhook');
    await beat();
    await errorRow.getByRole('button', { name: /Show evidence/ }).click();
    const block = errorRow.getByTestId('evidence-block');
    await expect(block).toBeVisible();
    // The FULL message — longer than the title limit, never cut silently.
    await block.getByRole('button', { name: 'Show full message' }).click();
    await expect(block.getByTestId('evidence-message')).toContainText(
      'upserts every pull request in one transaction.',
    );
    // The app's own frames first, as path:line with their function.
    const frames = block.locator('[data-frame="app"]');
    await expect(frames).toHaveCount(3);
    await expect(frames.nth(0)).toContainText('lib/services/githubWebhookService.ts:412');
    await expect(frames.nth(0)).toContainText('in upsertPullRequest');
    await expect(frames.nth(2)).toContainText('app/api/github/webhook/route.ts:74');
    await expect(block.getByRole('button', { name: 'Show 2 framework frames' })).toBeVisible();
    // The tags — WITHOUT the user's email; the request — WITHOUT its query.
    await expect(block.locator('[data-tag="transaction"]')).toContainText(
      'POST /api/github/webhook',
    );
    await expect(block.locator('[data-tag="environment"]')).toBeVisible();
    await expect(block.locator('[data-tag="user.email"]')).toHaveCount(0);
    await expect(block).not.toContainText('someone@example.com');
    await expect(block.locator('[data-evidence-block="request"]')).toHaveText(
      /POST \/api\/github\/webhook$/,
    );
    await expect(block).not.toContainText('x=1');
    await expect(block).toContainText('Latest event');
    await expect(block).toContainText('Event 3f9a1c7e04b2…');
    await beat();
    await beat();
  });

  await chapter(
    'An agent reads the same evidence over MCP, and in its dispatch prompt',
    async () => {
      const client = await agentSession(token, baseURL!);
      const result = await client.callTool({
        name: 'get_work_item',
        arguments: { key: bugA.identifier },
      });
      await client.close();
      const errors = (
        result.structuredContent as {
          errors: Array<{ evidence: Record<string, unknown> }>;
        }
      ).errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]!.evidence).toMatchObject({
        state: 'present',
        stale: false,
        exception: { type: 'PrismaClientKnownRequestError', message: MESSAGE },
        request: { method: 'POST', path: '/api/github/webhook' },
        eventId: '3f9a1c7e04b2d88a91c0e5f1a2b3c4d5',
        eventAt: new Date(EVENT_AT).toISOString(),
      });
      const evidence = errors[0]!.evidence as {
        frames: Array<{ filePath: string; inApp: boolean | null }>;
        tags: Array<{ key: string }>;
      };
      expect(evidence.frames.slice(0, 3).map((f) => f.inApp)).toEqual([true, true, true]);
      expect(evidence.tags.map((t) => t.key)).toEqual(['environment', 'transaction', 'runtime']);
      const payload = JSON.stringify(result.structuredContent);
      expect(payload).not.toContain('someone@example.com');
      expect(payload).not.toContain('x=1');

      const res = await page.request.get(`/api/v1/work-items/${bugA.identifier}/dispatch-prompt`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status()).toBe(200);
      const prompt = ((await res.json()) as { prompt: string }).prompt;
      const section = prompt.slice(prompt.indexOf(PROMPT_BANNER));
      expect(prompt).toContain(PROMPT_BANNER);
      expect(section).toContain('Exception: PrismaClientKnownRequestError');
      expect(section).toContain('[app] lib/services/githubWebhookService.ts:412 upsertPullRequest');
      expect(section).toContain('transaction = POST /api/github/webhook');
      expect(section).toContain('Request: POST /api/github/webhook');
      expect(prompt).not.toContain('someone@example.com');
      expect(prompt).not.toContain('x=1');

      // Show the prompt the agent receives, so the receipt shows it too.
      await page.setContent(
        `<pre style="font:13px/1.45 ui-monospace,monospace;white-space:pre-wrap;padding:24px">${section
          .slice(0, 1800)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')}</pre>`,
      );
      await beat();
    },
  );

  await chapter(
    'A bug filed before this story has no evidence — until the next check backfills it',
    async () => {
      // Make B a PRE-STORY link: no evidence, never dispatched, and older than the
      // sweep's one-hour grace window (see the header).
      const past = new Date(T0 - 3 * 3_600_000);
      await adminDb.monitorIssue.updateMany({
        where: { workItemId: bugB.id },
        data: {
          exceptionType: null,
          exceptionMessage: null,
          requestMethod: null,
          requestPath: null,
          eventId: null,
          eventAt: null,
          evidenceReadAt: null,
          evidenceCheckedAt: null,
          authoringJobId: null,
          createdAt: past,
        },
      });
      await adminDb.$executeRaw`UPDATE monitor_issue SET frames = NULL, tags = NULL WHERE work_item_id = ${bugB.id}`;
      await adminDb.workItem.update({
        where: { id: bugB.id },
        data: { createdAt: new Date(past.getTime() + 1_000) },
      });

      await page.goto(`/items/${bugB.identifier}`);
      await expect(row(page)).toContainText(
        'Evidence not read yet — it arrives with the next check.',
      );
      await beat();

      // The next check. B's issue is NOT in its listing — only the sweep reaches it.
      const summary = await poll(page, [issueA(2), issueB()]);
      expect(summary).toMatchObject({
        status: 'ok',
        evidenceBackfilled: 1,
        enrichmentRequested: 1,
      });

      await page.reload();
      const bRow = row(page);
      await expect(bRow).not.toContainText('Evidence not read yet');
      await expect(bRow.getByTestId('evidence-summary')).toContainText('TypeError');
      await bRow.getByRole('button', { name: /Show evidence/ }).click();
      await expect(bRow.getByTestId('evidence-block')).toContainText(
        'lib/services/githubInstallService.ts:57',
      );
      await beat();
    },
  );

  await chapter(
    'The old bug is enriched ONCE — and the next check asks for nothing more',
    async () => {
      writeFileSync(
        fixturePath(),
        JSON.stringify({
          ...readFixture(),
          authorBug: [
            {
              authoredBug: {
                descriptionMd: [
                  '`GET /api/github/install` throws `TypeError` reading `installation` from `resolveInstallation`.',
                  '',
                  '## Acceptance criteria',
                  '',
                  '- Finishing the GitHub install with no installation id shows the retry state instead of an error.',
                  '',
                  '## Context refs',
                  '',
                  '- `lib/services/githubInstallService.ts`',
                ].join('\n'),
                explanationMd:
                  'People finishing the GitHub install hit an error page instead of a retry.',
                type: 'code',
                executor: 'coding_agent',
                storyPoints: 2,
                estimateMinutes: 45,
                contextRefs: ['lib/services/githubInstallService.ts'],
                candidateMechanisms: [],
                grounded: false,
                groundingReason: 'no_repos',
              },
            },
          ],
        }),
      );
      const before = authorSubmits().length;
      const res = await page.request.post('/api/_test/monitors/enrich', {
        data: { workItemId: bugB.id },
      });
      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({
        dispatch: { dispatched: true },
        applied: { status: 'applied' },
      });
      expect(authorSubmits().length).toBe(before + 1);

      await page.reload();
      await expect(page.getByRole('main').getByLabel('Work item description')).toContainText(
        'shows the retry state instead of an error',
      );
      // The next check: nothing left to backfill, nothing left to enrich.
      const again = await poll(page, [issueA(2), issueB()]);
      expect(again).toMatchObject({ status: 'ok', evidenceBackfilled: 0, enrichmentRequested: 0 });
      expect(authorSubmits().length).toBe(before + 1);
      await beat();
    },
  );

  await chapter(
    'A check that FAILS leaves the evidence standing — marked out of date',
    async () => {
      // The error recurs, and this time the latest-event read is refused.
      const summary = await poll(page, [issueA(10), issueB()], {
        failNextContext: { status: 503, reason: 'Sentry is unavailable' },
      });
      expect(summary).toMatchObject({ status: 'ok' });

      await page.goto(`/items/${bugA.identifier}`);
      const errorRow = row(page);
      await expect(errorRow.getByTestId('evidence-summary')).toContainText('out of date');
      await errorRow.getByRole('button', { name: /Show evidence/ }).click();
      const block = errorRow.getByTestId('evidence-block');
      await expect(block.locator('[data-evidence-block="stale"]')).toContainText(
        'The last check failed',
      );
      // The old evidence, with its ORIGINAL event.
      await expect(block).toContainText('PrismaClientKnownRequestError');
      await expect(block).toContainText('Event 3f9a1c7e04b2…');
      const link = await adminDb.monitorIssue.findFirstOrThrow({ where: { workItemId: bugA.id } });
      expect(link.eventAt?.toISOString()).toBe(new Date(EVENT_AT).toISOString());
      expect(link.evidenceCheckedAt!.getTime()).toBeGreaterThan(link.evidenceReadAt!.getTime());
      await beat();
      await beat();
    },
  );

  await chapter('Nothing reached sentry.io or a real motir-ai', async () => {
    expect(escapedRequests).toEqual([]);
  });
});
