import type { Page } from '@playwright/test';
import { ORIGIN_SECRET_HEADER, deriveOriginSecret } from '@motir/orchestrator';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { emailBox, startSignedOut } from './_helpers/shell-session';
import { postSignedWebhook } from './_helpers/github-seed';
import { E2E_GITHUB_USER, E2E_PROVISIONING_ORG } from './_helpers/github-const';
import { previewHostingFake, resetPreviewHosting } from './_helpers/preview-hosting';
import { startPreviewTlsFront, type PreviewTlsFront } from './_helpers/preview-tls-front';
import {
  startPreviewUpstreamStandIn,
  type PreviewUpstreamStandIn,
} from '@/tests/helpers/previewUpstreamStandIn';
import { createTestPerson } from './_helpers/testPerson';
import { writeFixtureFileSync } from '@/lib/test-fixture-file';
import { GATE_COOKIE } from '@/lib/preview/gate';
import { PREVIEW_IMAGE_WORKFLOW_PATH } from '@/lib/preview/lifecycleEvents';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { CUSTOM_WORKSPACE_ROLE_TIER } from '@/lib/workspaces/roles';
import en from '@/messages/en.json';

/*
 * A PULL REQUEST'S PREVIEW, end to end — the story's acceptance walk
 * (Story MOTIR-5766 · Subtask MOTIR-5781).
 *
 * One continuous, recorded test walks the story's verification recipe: a pull
 * request on a Motir-hosted web repository is opened and its row in the work
 * item's Development block says the preview is building; its image lands and the
 * row says ready, with the preview's address as a link; a viewer signed out of
 * Motir opens it, signs in, and is handed to the running application; a person
 * whose custom role lacks `project:browse` is refused; the pull request closes and
 * both the row and the preview host say so. The failed page is a second, short
 * test, outside the recording.
 *
 * ── EVERY STATE CHANGE GOES THROUGH THE SHIPPED PATH ───────────────────────
 * The `pull_request` and `workflow_run` deliveries are signed and POSTed to
 * `/api/github/webhook`; the lifecycle's effects — the GitHub deployment, the
 * release's start, its health, its teardown — run as jobs on the lane's worker,
 * against the fake hosting port's shared store (MOTIR-10098). The spec inserts no
 * `preview_deployment` row; it READS one, for the release's app name, which is
 * what it needs to point that release at the stand-in (MOTIR-10100).
 *
 * ── THE PREVIEW HOST IS SERVED AS PRODUCTION SERVES IT ─────────────────────
 * Over TLS on the default port: Chromium maps `*.preview.localhost` onto
 * `preview-tls-front.ts`, which relays to the app server with the Host header
 * intact, and the certificate is a throwaway the context accepts. So the gate's
 * own `https://<host>` redirects, its `__Host-` cookie and `previewUrl()`'s
 * default scheme are what the walk exercises — no lane-only scheme.
 *
 * ── THE APPLICATION IS A STAND-IN ──────────────────────────────────────────
 * The forward is a server-side rewrite, so what answers is a real loopback
 * server (`tests/helpers/previewUpstreamStandIn.ts`) that records what it was
 * sent — which is how the walk proves the origin secret arrived and Motir's
 * cookies did not.
 */

test.describe.configure({ mode: 'serial', timeout: 420_000 });

const STORY = 'MOTIR-5766';
const PASSWORD = 'Previews-e2e-Pass-7';
const OWNER = 'preview-owner@motir.test';
const CONTRACTOR = 'preview-contractor@motir.test';
const REPO = 'acme-web';
const REPOSITORY = `${E2E_PROVISIONING_ORG}/${REPO}`;
const INSTALLATION_ID = '99005766';
const PROVIDER_REPO_ID = 57660001;
const WALK_PR = 7;
const FAILED_PR = 8;
const HEAD = 'a7'.repeat(20);
const FAILED_HEAD = 'b8'.repeat(20);
const DOMAIN = process.env['MOTIR_PREVIEW_DOMAIN'] ?? 'preview.localhost';
const TLS_PORT = Number(process.env['E2E_PREVIEW_TLS_PORT'] ?? 3293);
const STATE_WAIT_MS = 180_000;

/** Node lower-cases a received header's name. */
const SECRET_HEADER = ORIGIN_SECRET_HEADER.toLowerCase();
const copy = en.github.development.preview;
const gate = en.previewGate;

/** The manifest the repository's head carries, as `motir.hosting.json`. */
const MANIFEST = {
  schemaVersion: 1,
  targets: ['fly'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'postgres', migrateCommand: 'node migrate.js deploy' },
};

// Every `*.preview.localhost` connection goes to the TLS front; nothing else moves.
test.use({
  launchOptions: { args: [`--host-resolver-rules=MAP *.${DOMAIN} 127.0.0.1:${TLS_PORT}`] },
  ignoreHTTPSErrors: true,
});

interface Seed {
  ownerId: string;
  workspaceId: string;
  repoId: string;
  itemKey: string;
  itemId: string;
}

let seed: Seed;
let standIn: PreviewUpstreamStandIn;
let front: PreviewTlsFront;

const delivery = {
  installation: { id: Number(INSTALLATION_ID) },
  repository: { id: PROVIDER_REPO_ID, name: REPO, owner: { login: E2E_PROVISIONING_ORG } },
};

function pullRequest(action: 'opened' | 'closed', number: number, head: string) {
  return {
    action,
    number,
    ...delivery,
    pull_request: {
      number,
      state: action === 'closed' ? 'closed' : 'open',
      merged: false,
      title: `Invoices page, take ${number}`,
      head: { ref: `feature/invoices-${number}`, sha: head },
      base: { ref: 'main' },
      user: { id: E2E_GITHUB_USER.id },
    },
  };
}

function imageRun(number: number, head: string, conclusion: 'success' | 'failure') {
  return {
    action: 'completed',
    ...delivery,
    workflow_run: {
      path: PREVIEW_IMAGE_WORKFLOW_PATH,
      event: 'pull_request',
      head_sha: head,
      pull_requests: [{ number }],
      conclusion,
    },
  };
}

async function deliver(page: Page, event: string, payload: unknown): Promise<void> {
  const res = await postSignedWebhook(page.request, event, payload);
  expect(res.status(), await res.text()).toBe(200);
}

/** The pull request the delivery synced, linked to the card as a run links it. */
async function linkToCard(number: number): Promise<void> {
  const pr = await adminDb.githubPullRequest.findFirstOrThrow({
    where: { repoId: seed.repoId, number },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: seed.workspaceId,
      workItemId: seed.itemId,
      githubPullRequestId: pr.id,
      repoId: seed.repoId,
    },
  });
}

const previewLine = (page: Page) => page.getByRole('main').getByTestId('pr-row-preview');

/** Re-read the card until the row's preview carries `state` — the row is
 *  server-rendered, so a reload is how a reader sees a new state. */
async function awaitRowState(page: Page, state: string): Promise<void> {
  await expect(async () => {
    await page.goto(`/items/${seed.itemKey}`);
    await expect(previewLine(page)).toHaveAttribute('data-preview-state', state, {
      timeout: 5_000,
    });
  }).toPass({ timeout: STATE_WAIT_MS, intervals: [2_000, 3_000, 5_000] });
}

/** Sign in on Motir's own form, wherever a redirect landed the page on it. */
async function signInHere(page: Page, email: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === '/sign-in');
  await emailBox(page).fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('main').getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

async function previewRow(number: number) {
  return adminDb.previewDeployment.findFirstOrThrow({
    where: { repoId: seed.repoId, pullRequestNumber: number },
  });
}

test.beforeAll(async () => {
  await resetDatabase();
  resetPreviewHosting();
  writeFixtureFileSync(
    process.env['MOTIR_GITHUB_PREVIEW_CONTROL_PATH']!,
    JSON.stringify({
      repositories: [REPOSITORY],
      manifests: { [REPOSITORY]: JSON.stringify(MANIFEST) },
    }),
  );
  standIn = await startPreviewUpstreamStandIn();
  front = await startPreviewTlsFront(TLS_PORT, test.info().project.use.baseURL!);

  const owner = await createTestPerson({ email: OWNER, password: PASSWORD, name: 'Ada Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Invoicing',
    identifier: 'INV',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };

  // A member whose CUSTOM role can comment but not browse: the permission, not
  // the membership, is what refuses them.
  const contractor = await createTestPerson({
    email: CONTRACTOR,
    password: PASSWORD,
    name: 'Cy Contractor',
  });
  await workspacesService.addMember({ userId: contractor.id, workspaceId: workspace.id });
  const role = await adminDb.workspaceRoleDefinition.create({
    data: { workspaceId: workspace.id, name: 'Commenter', permissions: ['comment:add'] },
  });
  await adminDb.$transaction((tx) =>
    workspaceMembershipRepository.setWorkspaceRole(
      contractor.id,
      workspace.id,
      { workspaceRole: CUSTOM_WORKSPACE_ROLE_TIER, roleDefinitionId: role.id },
      tx,
    ),
  );

  // The web repository Motir CREATED for the project, in Motir's org, hosted on
  // Fly — the state the establish flow leaves behind — with its previews on.
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: INSTALLATION_ID,
      workspaceId: null,
      accountLogin: E2E_PROVISIONING_ORG,
      accountType: 'Organization',
    },
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: workspace.id,
      organizationId: (await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } }))
        .organizationId,
      repoId: String(PROVIDER_REPO_ID),
      owner: E2E_PROVISIONING_ORG,
      name: REPO,
      defaultBranch: 'main',
      archived: false,
    },
  });
  const row = await projectRepoSetService.addRow(project.id, { role: 'web', name: REPO }, ctx);
  await projectRepoSetService.markCreating(row.id, ctx);
  await projectRepoSetService.attachRealizedRepoRow(row.id, mirror.id, ctx);
  await projectRepoSetService.setHosting(
    row.id,
    { target: 'fly', useCase: 'mvp', size: 'small' },
    ctx,
  );
  // Switched on as enablement leaves a repository; enablement's own GitHub writes
  // are its suite's, not this walk's.
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: { previewEnabledAt: new Date(), previewPushNamespace: `mh-${row.id}-pv` },
  });

  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: 'Let customers download invoices' },
    ctx,
  );
  seed = {
    ownerId: owner.id,
    workspaceId: workspace.id,
    repoId: mirror.id,
    itemKey: item.identifier,
    itemId: item.id,
  };
});

test.afterAll(async () => {
  await standIn?.stop();
  await front?.stop();
});

test('the lane mounts the fake hosting port, over its shared store', async () => {
  // `previewHostingFake` refuses unless the lane names the shared store, and
  // answers only when the orchestrator is the fake — so this cannot pass on a lane
  // whose arrangement would reach nobody.
  const fake = previewHostingFake('fly');
  expect(fake.target).toBe('fly');
  expect(process.env['MOTIR_FAKE_HOSTING_STATE_PATH']).toBeTruthy();
  expect(await fake.listReleases({ appRef: 'mh-no-such-app' })).toEqual([]);
});

test('a pull request’s preview, from building to running to shut down', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory(STORY);
  const flyReplay: string[] = [];
  page.on('response', (response) => {
    if (response.headers()['fly-replay'] !== undefined) flyReplay.push(response.url());
  });

  await chapter('A pull request opens, and its row says the preview is building', async () => {
    await deliver(page, 'pull_request', pullRequest('opened', WALK_PR, HEAD));
    await linkToCard(WALK_PR);
    await page.goto('/sign-in');
    await signInHere(page, OWNER);
    await page.waitForURL((url) => url.pathname !== '/sign-in', { timeout: FIRST_PAINT_MS });
    await page.goto(`/items/${seed.itemKey}`);
    const line = previewLine(page);
    await expect(line).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(line).toHaveAttribute('data-preview-state', 'building');
    await expect(line).toHaveText(copy.building);
    await expect(line.getByRole('link')).toHaveCount(0);
    await beat();
  });

  let href = '';
  let host = '';
  await chapter('Its image lands; the row says ready and links the preview', async () => {
    await deliver(page, 'workflow_run', imageRun(WALK_PR, HEAD, 'success'));
    await awaitRowState(page, 'ready');
    const row = await previewRow(WALK_PR);
    host = row.host;
    const link = previewLine(page).getByRole('link', { name: host });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    href = (await link.getAttribute('href'))!;
    expect(href).toBe(`https://${host}`);
    // The tenant's application, for this walk: the stand-in, which records what
    // the preview host forwards to it.
    previewHostingFake('fly').setUpstream(row.flyAppName!, standIn.origin);
    standIn.reset();
    await beat();
  });

  await chapter(
    'Signed out, the link goes through Motir’s sign-in to the running app',
    async () => {
      await startSignedOut(page);
      // The row's link opens a new tab; the walk follows it in this one, so the
      // recording keeps it.
      await page.goto(href);
      await signInHere(page, OWNER);
      await page.waitForURL((url) => url.host === host, { timeout: FIRST_PAINT_MS });
      // The gate cookie the handshake set, host-only and Secure, on the preview host.
      const pass = (await page.context().cookies(`https://${host}`)).find(
        (c) => c.name === GATE_COOKIE,
      );
      expect(pass, 'the gate cookie is stored on the preview host').toBeDefined();
      expect(pass!.secure).toBe(true);
      await expect(async () => {
        await page.goto(href);
        await expect(page.getByRole('main')).toHaveAttribute('data-testid', 'preview-stand-in', {
          timeout: 3_000,
        });
      }).toPass({ timeout: 30_000 });
      await expect(page.getByRole('heading', { level: 1 })).toContainText('stand-in');
      await beat();

      const received = await standIn.waitForRequest((r) => r.headers[SECRET_HEADER] !== undefined);
      const { flyAppName } = await previewRow(WALK_PR);
      expect(received.headers[SECRET_HEADER]).toBe(
        deriveOriginSecret(process.env['MOTIR_HOSTING_ORIGIN_SECRET_KEY']!, flyAppName!),
      );
      const cookie = String(received.headers.cookie ?? '');
      expect(cookie).not.toMatch(/better-auth\./);
      expect(cookie).not.toContain(GATE_COOKIE);
      expect(received.headers['x-forwarded-host']).toBe(host);
    },
  );

  await chapter('Someone whose role cannot browse the project is refused', async () => {
    await startSignedOut(page);
    await page.context().clearCookies({ domain: host });
    await page.goto(href);
    await signInHere(page, CONTRACTOR);
    await expect(page.getByRole('heading', { level: 1, name: gate.refused.title })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(page.getByTestId('preview-stand-in')).toHaveCount(0);
    await beat();
  });

  await chapter('The pull request closes; the row and the preview host both say so', async () => {
    await deliver(page, 'pull_request', pullRequest('closed', WALK_PR, HEAD));
    await startSignedOut(page);
    await page.goto(href);
    await signInHere(page, OWNER);
    await page.waitForURL((url) => url.host === host, { timeout: FIRST_PAINT_MS });
    await expect(async () => {
      await page.goto(href);
      await expect(page.getByRole('heading', { level: 1, name: gate.closed.title })).toBeVisible({
        timeout: 3_000,
      });
    }).toPass({ timeout: STATE_WAIT_MS });
    await beat();
    await awaitRowState(page, 'closed');
    await expect(previewLine(page)).toHaveText(copy.closed);
    await expect(previewLine(page).getByRole('link')).toHaveCount(0);
    await beat();
  });

  expect(flyReplay, 'no response in the walk carries fly-replay').toEqual([]);
});

test('a preview whose image fails says so, on the row and on the preview host', async ({
  page,
}) => {
  await deliver(page, 'pull_request', pullRequest('opened', FAILED_PR, FAILED_HEAD));
  await linkToCard(FAILED_PR);
  await deliver(page, 'workflow_run', imageRun(FAILED_PR, FAILED_HEAD, 'failure'));
  const { host } = await previewRow(FAILED_PR);

  await page.goto(`https://${host}`);
  await signInHere(page, OWNER);
  await expect(page.getByRole('heading', { level: 1, name: gate.failed.title })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });

  await page.goto(`/items/${seed.itemKey}`);
  const failed = page
    .getByRole('main')
    .locator('[data-testid="pr-row-preview"][data-preview-state="failed"]');
  await expect(failed).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(failed).toContainText(`${copy.failed} · `);
  await expect(failed).toContainText('failure');
  await expect(failed.getByRole('link')).toHaveCount(0);
});
