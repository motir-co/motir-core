// Acceptance E2E — at takeover a live app is handed over, not destroyed (Story MOTIR-9800 ·
// Subtask MOTIR-12140).
//
// THE RECORDED WALK (one test, chaptered — the story's verification recipe, steps 1 to 8): an
// organisation administrator tries to take ONE AWS repository over and is refused, because its
// organisation's AWS account holds another; takes over the AWS hosting instead, with an owner email
// and a GitHub owner; watches the Handover checklist run, retries the one step made to fail, and
// enters the code AWS emailed. Before AWS's own steps each Production panel reads handing over with
// its release still Live, the preview is gone and both production stacks are still there. Once the
// owner has done AWS's steps the checklist finishes — Motir's access removed, the account out of
// Motir's AWS Organization, each repository transferred — and each panel reads Handed over with the
// account and the address the app answers on without Motir, and no deploy or rollback; a merge to
// main deploys nothing. Then the Fly repository is moved to the administrator's GitHub: its panel
// runs a 30-day grace window, an export downloads as a pg_dump, and Stop now ends it, keeping the
// final export and deleting the app and its database.
//
// THE RECEIPT IS CI's. This repository's acceptance lane carries
// `./.github/actions/upload-acceptance-video` (`.github/workflows/acceptance-tests.yml`), so a green
// pull-request run publishes this walk as MOTIR-9800's acceptance video; no MCP publish is made.
//
// ── What is real ────────────────────────────────────────────────────────────
// Everything from the routes down: the take-it-over route and its shared-account refusal, the
// handover routes and `tenantAccountHandoverService` (its steps run as `hosting.tenant-handover
// .advance` jobs in the lane's worker), the shipped transfer, the deploy freeze in the merge
// webhook, the export, its download, and `stopApplication`. The boundaries are the lane's fakes:
// the AWS tenant (`lib/test-fake-aws-tenant.ts`, read and steered through
// `_helpers/takeover-handover.ts`), the hosting and database ports, the blob store, `pg_dump`, and
// GitHub — the release seam, and the takeover seam (`lib/test-github-takeover-mock.ts`) both the
// webServer and the worker install. The spec never writes a fake's state file directly.
//
// DETERMINISM (the coding convention § E2E): every mutation arms `page.waitForResponse` before its
// click and awaits its status; every state a worker job makes is awaited on the row's own state
// text (the checklist re-reads it every 5 s) or with `expect.poll` over the database; every page
// load awaits its document. `beat()` / `chapter()` are pacing only. No `waitForTimeout`, no resize.
import { randomInt } from 'node:crypto';
import type { Locator, Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import { E2E_PROVISIONING_ORG } from './_helpers/github-const';
import { signIn } from './_helpers/shell-session';
import {
  PRODUCTION_INSTALLATION_ID,
  PRODUCTION_MANIFEST,
  commit,
  deliverMerge,
  releaseHosting,
  releasesOf,
  writeProductionReleaseControl,
  type ProductionRepo,
} from './_helpers/production-seed';
import { previewHostingFake } from './_helpers/preview-hosting';
import { connectGithubIdentity } from './_helpers/repository-set-seed';
import {
  failTenantOperationOnce,
  fakeDatabaseExists,
  markTenantStandaloneDone,
  readFakeExportDump,
  readTenantAccount,
  readTenantEmailCode,
  resetTakeoverTenant,
  seedTakeoverTenant,
  tenantCalls,
} from './_helpers/takeover-handover';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { setWorkspaceRoleFor } from '../helpers/workspaceRoleFixtures';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import en from '@/messages/en.json';

const ta = en.repositoryTakeover.awsHandover;
const tp = en.settings.production;
const ROOM = '/settings/project/repositories';
const PRODUCTION = '/settings/project/production';
const PASSWORD = 'takeover-e2e-pass-9800';
const ACCOUNT = '210987654321';
const OWNER_EMAIL = 'cloud-owner@acme.example';
const GITHUB_LOGIN = 'ada-acme';
const PREVIEW_PR = 3;
const DAY_MS = 86_400_000;
/** A checklist step runs as a job in the lane's worker; the panel re-reads every 5 s. */
const WORKER = { timeout: 120_000 };

// Two hosting kinds, a worker-driven checklist with a retry and an email code, an export and a
// stop: a long walk.
test.describe.configure({ timeout: 600_000 });

interface Seed {
  organizationId: string;
  organizationName: string;
  adminEmail: string;
  adminUserId: string;
  workspaceId: string;
  shop: ProductionRepo;
  api: ProductionRepo;
  fly: ProductionRepo;
}

let seed: Seed;

/** The organisation the recipe starts from: two AWS repositories on its one tenant account (the
 *  first with an open preview), one Fly repository, every production app live, and the acting
 *  user an organisation administrator with a connected GitHub identity. */
async function seedTakeoverRoom(slug: string): Promise<Seed> {
  const owner = await usersService.createUser({
    email: `takeover-owner-${slug}@example.com`,
    password: PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme Workspace',
    ownerUserId: owner.id,
  });
  const organization = await adminDb.organization.findUniqueOrThrow({
    where: { id: workspace.organizationId },
    select: { id: true, name: true },
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Acme Shop',
    identifier: 'HAND',
  });

  const base = 890_000_000 + randomInt(1_000_000) * 10;
  const mirrored = [
    { key: 'shop', name: `shop-web-${slug}`, providerRepoId: String(base + 1), target: 'aws' },
    { key: 'api', name: `shop-api-${slug}`, providerRepoId: String(base + 2), target: 'aws' },
    { key: 'fly', name: `shop-blog-${slug}`, providerRepoId: String(base + 3), target: 'fly' },
  ] as const;
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      // The id `deliverMerge` signs its workflow_run with: a merge from any other
      // installation is `unknown_installation` and releases nothing.
      installationId: PRODUCTION_INSTALLATION_ID,
      accountLogin: E2E_PROVISIONING_ORG,
      accountType: 'Organization',
    },
    repos: mirrored.map((r) => ({
      providerRepoId: r.providerRepoId,
      owner: E2E_PROVISIONING_ORG,
      name: r.name,
      defaultBranch: 'main',
      archived: false,
    })),
  });

  async function repo(entry: (typeof mirrored)[number]): Promise<ProductionRepo> {
    const githubRepo = await adminDb.githubRepo.findFirstOrThrow({
      where: { workspaceId: workspace.id, repoId: entry.providerRepoId },
    });
    const row = await linkProjectRepo({
      workspaceId: workspace.id,
      projectId: project.id,
      githubRepoId: githubRepo.id,
      name: entry.name,
      role: entry.key === 'shop' ? 'web' : 'api',
    });
    await adminDb.projectRepo.update({
      where: { id: row.id },
      data: {
        state: 'created',
        seedSource: 'nextjs-prisma-fly-starter',
        ...(entry.target === 'aws'
          ? { hostingTarget: 'aws', hostingShape: 'container' }
          : { hostingTarget: 'fly' }),
      },
    });
    const address = `${entry.key}--acme-${slug}.motir.site`;
    const app = await hostedApplicationService.ensureApplication(row.id);
    await adminDb.hostedApplication.update({
      where: { id: app.id },
      data: {
        productionAppName: `mh-${row.id}`,
        productionEnabledAt: new Date(),
        productionAddress: address,
      },
    });
    return { id: row.id, name: entry.name, providerRepoId: entry.providerRepoId, address };
  }
  const shop = await repo(mirrored[0]);
  const api = await repo(mirrored[1]);
  const fly = await repo(mirrored[2]);

  // The release seam's GitHub: the org's installation, and each repository's manifest — the AWS
  // apps without a database, the Fly app with the Postgres database its export dumps.
  const awsManifest = { ...PRODUCTION_MANIFEST, database: { kind: 'none' as const } };
  writeProductionReleaseControl({
    installations: { [E2E_PROVISIONING_ORG]: 99_100_001 },
    manifests: {
      [`${E2E_PROVISIONING_ORG}/${shop.name}`]: awsManifest,
      [`${E2E_PROVISIONING_ORG}/${api.name}`]: awsManifest,
      [`${E2E_PROVISIONING_ORG}/${fly.name}`]: PRODUCTION_MANIFEST,
    },
  });

  // The organisation's ONE tenant AWS account, ready, and the account as the fake holds it: each
  // AWS app's stacks, Motir's roles, inside Motir's AWS Organization, and the shop's open preview.
  await adminDb.hostingTenantAccount.create({
    data: {
      organizationId: organization.id,
      awsAccountId: ACCOUNT,
      state: 'ready',
      region: 'us-east-1',
    },
  });
  seedTakeoverTenant({
    accountId: ACCOUNT,
    primaryEmail: `motir-tenant-${slug}@motir.example`,
    apps: [
      { repositoryId: shop.id, shape: 'container', previewPullRequest: PREVIEW_PR },
      { repositoryId: api.id, shape: 'container' },
    ],
  });

  // The acting user: a workspace admin AND an organisation admin (never the owner, who rides the
  // always-pass rail), with the GitHub identity a takeover runs as.
  const adminEmail = `takeover-admin-${slug}@example.com`;
  const admin = await usersService.createUser({
    email: adminEmail,
    password: PASSWORD,
    name: 'Ada Admin',
  });
  await workspacesService.addMember({ userId: admin.id, workspaceId: workspace.id });
  await adminDb.projectMembership.create({
    data: { userId: admin.id, projectId: project.id, workspaceId: workspace.id },
  });
  await setWorkspaceRoleFor(admin.id, workspace.id, 'admin');
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: admin.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  await adminDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: organization.id, userId: admin.id } },
    create: { organizationId: organization.id, userId: admin.id, role: 'admin' },
    update: { role: 'admin' },
  });
  await connectGithubIdentity(admin.id, GITHUB_LOGIN);

  return {
    organizationId: organization.id,
    organizationName: organization.name,
    adminEmail,
    adminUserId: admin.id,
    workspaceId: workspace.id,
    shop,
    api,
    fly,
  };
}

test.beforeEach(async () => {
  await resetDatabase();
  releaseHosting();
  resetTakeoverTenant();
  seed = await seedTakeoverRoom(`${Date.now()}`);
});

test.afterEach(() => {
  releaseHosting();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── Reads and drivers ─────────────────────────────────────────────────────────

const main = (page: Page): Locator => page.getByRole('main');
const panel = (page: Page): Locator => main(page).getByTestId('production-panel');
const steps = (page: Page): Locator => main(page).getByRole('list', { name: ta.stepsLabel });
const stepRow = (page: Page, step: string): Locator =>
  steps(page).locator(`li[data-step="${step}"]`);

const STEP_ORDER = [
  'destroy_previews',
  'create_deploy_role',
  'open_upstream',
  'move_email',
  'await_standalone',
  'remove_access',
  'leave_organization',
  'transfer_repositories',
] as const;

const handoverRoute =
  (leaf: '' | '/email-code' | '/retry' | '/recheck') =>
  (res: Response): boolean =>
    res.request().method() === 'POST' &&
    new URL(res.url()).pathname ===
      `/api/organizations/${seed.organizationId}/hosting/aws-handover${leaf}`;

const takeoverRoute =
  (repo: ProductionRepo) =>
  (res: Response): boolean =>
    res.request().method() === 'POST' &&
    new URL(res.url()).pathname.endsWith(`/repositories/${repo.id}/takeover`);

const applicationRoute =
  (appId: string, leaf: string, method = 'POST') =>
  (res: Response): boolean =>
    res.request().method() === method &&
    new URL(res.url()).pathname ===
      `/api/organizations/${seed.organizationId}/hosting/applications/${appId}${leaf}`;

async function openRepositories(page: Page): Promise<void> {
  expect((await page.goto(ROOM))?.status()).toBe(200);
  await expect(
    main(page).getByRole('heading', { name: en.repositoryTakeover.title }).first(),
  ).toBeVisible({ timeout: FIRST_PAINT_MS });
}

async function openProduction(page: Page, repo: ProductionRepo): Promise<void> {
  expect((await page.goto(`${PRODUCTION}?repository=${repo.id}`))?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: tp.title })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(panel(page)).toBeVisible();
}

/** Deliver a merge to main through the real webhook and wait for its release to go live. */
async function releaseLive(page: Page, repo: ProductionRepo, sha: string): Promise<void> {
  expect(await deliverMerge(page.request, repo, sha)).toBe(200);
  await expect
    .poll(async () => (await releasesOf(repo)).find((r) => r.commit === sha)?.state ?? null, {
      timeout: 90_000,
    })
    .toBe('live');
}

async function applicationOf(repo: ProductionRepo) {
  return adminDb.hostedApplication.findFirstOrThrow({
    where: { projectRepositoryId: repo.id },
    select: {
      id: true,
      state: true,
      upstreamAddress: true,
      productionAddress: true,
      stopsAt: true,
      handedOverAccountId: true,
    },
  });
}

/** The edge's own read of a motir.site address: is any application still on it? */
async function answeringOn(address: string): Promise<boolean> {
  const app = await adminDb.hostedApplication.findFirst({
    where: { productionAddress: address },
    select: { id: true },
  });
  return app !== null;
}

/** The public host contract answers an address it no longer serves with the shared 404. */
async function expectSharedNotFound(page: Page, address: string): Promise<void> {
  expect(await answeringOn(address)).toBe(false);
  const res = await page.request.get(`/api/public/hosts/${address}`, { maxRedirects: 0 });
  expect(res.status()).toBe(404);
}

/** No field anywhere on the page asks for a payment detail or a root credential. */
async function expectNoPaymentOrRootField(page: Page): Promise<void> {
  await expect(
    page.getByRole('textbox', { name: /payment|card|billing|root|password|secret key/i }),
  ).toHaveCount(0);
}

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('an administrator hands over AWS hosting with its apps running, and a Fly app runs its grace window and stops', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9800');

  // Every production app is live before the recipe starts: one merge each, released by the
  // worker against the fake hosting port.
  await releaseLive(page, seed.shop, commit(1));
  await releaseLive(page, seed.api, commit(2));
  await releaseLive(page, seed.fly, commit(3));
  const flyApp = await applicationOf(seed.fly);
  expect(fakeDatabaseExists(seed.fly.id)).toBe(true);
  const accountBefore = readTenantAccount(ACCOUNT)!;
  expect(accountBefore.stacks.map((s) => s.name)).toContain(
    `motir-release-mh-${seed.shop.id}-pr${PREVIEW_PR}`,
  );

  await signIn(page, seed.adminEmail, PASSWORD);

  await chapter(
    'Recipe step 1 — one AWS repository cannot be taken over alone: the account holds another',
    async () => {
      await openRepositories(page);
      await main(page)
        .getByRole('button', { name: new RegExp(`^Move .*${seed.shop.name} to my GitHub$`) })
        .click();
      const modal = page.getByRole('dialog');
      await modal.getByRole('button', { name: en.repositorySet.continueCta }).click();
      const refused = page.waitForResponse(takeoverRoute(seed.shop));
      await page
        .getByRole('dialog')
        .getByRole('button', { name: en.repositoryTakeover.confirmCta })
        .click();
      expect((await refused).status()).toBe(409);

      const refusal = page.getByRole('dialog');
      await expect(refusal.getByRole('list', { name: ta.refusalOthersLabel })).toHaveText(
        seed.api.name,
      );
      await expect(refusal.getByRole('status')).toContainText(ta.nothingChanged);
      await expect(refusal.getByRole('button', { name: ta.takeOver })).toBeVisible();

      // Nothing moved in the account: its stacks, roles, email and membership read as seeded.
      expect(readTenantAccount(ACCOUNT)).toEqual(accountBefore);
      await beat();
    },
  );

  await chapter(
    'Recipe step 2 — Take over AWS hosting: the owner email, the GitHub owner, and the checklist',
    async () => {
      // The one failure this walk retries: the deploy role's first creation, in the worker.
      failTenantOperationOnce('iam.createRole');

      await page.getByRole('dialog').getByRole('button', { name: ta.takeOver }).click();
      const form = page.getByRole('dialog');
      await form.getByLabel(ta.ownerEmailLabel).fill(OWNER_EMAIL);
      await form.getByLabel(ta.githubOwnerLabel).fill(GITHUB_LOGIN);
      await expectNoPaymentOrRootField(page);
      await beat();
      await form.getByRole('button', { name: ta.continue }).click();

      const confirm = page.getByRole('alertdialog', { name: ta.confirmTitle });
      await expect(confirm).toContainText(OWNER_EMAIL);
      await expect(confirm).toContainText(GITHUB_LOGIN);
      const started = page.waitForResponse(handoverRoute(''));
      await confirm.getByRole('button', { name: ta.start }).click();
      expect((await started).status()).toBe(201);

      await expect(steps(page).locator('li[data-step]')).toHaveCount(STEP_ORDER.length);
      const order = await steps(page)
        .locator('li[data-step]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-step')));
      expect(order).toEqual([...STEP_ORDER]);
      await expect(steps(page)).toContainText(ta.step.destroy_previews.label);
      await expect(steps(page)).toContainText(ta.step.transfer_repositories.label);
      await beat();
    },
  );

  await chapter(
    'A failed step reads Failed with a retry, and the retry resumes there',
    async () => {
      const failed = stepRow(page, 'create_deploy_role');
      await expect(failed).toHaveAttribute('data-step-status', 'failed', WORKER);
      await expect(stepRow(page, 'destroy_previews')).toHaveAttribute('data-step-status', 'done');
      await expect(failed.getByRole('alert')).toBeVisible();
      await beat();

      const retryAt = new Date();
      const retried = page.waitForResponse(handoverRoute('/retry'));
      await failed.getByRole('button', { name: ta.retry }).click();
      expect((await retried).status()).toBe(200);
      await expect(failed).toHaveAttribute('data-step-status', 'done', WORKER);
      await expect(stepRow(page, 'destroy_previews')).toHaveAttribute('data-step-status', 'done');

      // Resumed AT the failed step: the previews were not destroyed a second time.
      expect(
        tenantCalls(ACCOUNT, retryAt).filter((c) => c.operation === 'cloudformation.deleteStack'),
      ).toEqual([]);
      expect(
        tenantCalls(ACCOUNT).filter(
          (c) => c.kind === 'operation' && c.operation === 'iam.createRole',
        ),
      ).toHaveLength(1);
      await beat();
    },
  );

  await chapter('The account email moves with the code AWS emailed to the new owner', async () => {
    const email = stepRow(page, 'move_email');
    await expect(email).toHaveAttribute('data-step-status', 'waiting_on_you', WORKER);
    await expect(stepRow(page, 'open_upstream')).toHaveAttribute('data-step-status', 'done');
    const code = readTenantEmailCode(ACCOUNT);
    expect(code).not.toBeNull();
    await email.getByLabel(ta.codeLabel).fill(code!);
    await beat();
    const confirmed = page.waitForResponse(handoverRoute('/email-code'));
    await email.getByRole('button', { name: ta.confirmCode }).click();
    expect((await confirmed).status()).toBe(200);
    await expect(email).toHaveAttribute('data-step-status', 'done', WORKER);
    expect(readTenantAccount(ACCOUNT)!.primaryEmail).toBe(OWNER_EMAIL);
    await expect(stepRow(page, 'await_standalone')).toHaveAttribute(
      'data-step-status',
      'waiting_on_you',
      WORKER,
    );
    await expectNoPaymentOrRootField(page);
    await beat();
  });

  await chapter(
    'Recipe step 3 — before AWS’s own steps: handing over, still Live, previews gone',
    async () => {
      for (const repo of [seed.shop, seed.api]) {
        const app = await applicationOf(repo);
        expect(app.state).toBe('handing_over');
        expect(app.upstreamAddress).toBeTruthy();
        await openProduction(page, repo);
        await expect(panel(page).getByTestId('production-handing-over')).toContainText(
          tp.handover.notice.title,
        );
        await expect(panel(page).getByTestId('production-current-release')).toContainText(
          tp.state.live,
        );
        await expect(panel(page).getByTestId('production-rollback')).toHaveCount(0);
        await beat();
      }

      // The address each app answers on without Motir, listed on the checklist to re-point at.
      await openRepositories(page);
      for (const repo of [seed.shop, seed.api]) {
        const { upstreamAddress } = await applicationOf(repo);
        await expect(main(page)).toContainText(upstreamAddress!);
      }

      // The preview stack is gone; both production stacks are still there.
      const stacks = readTenantAccount(ACCOUNT)!.stacks.map((s) => s.name);
      expect(stacks.filter((name) => /-pr\d+$/.test(name))).toEqual([]);
      expect(stacks).toEqual(
        expect.arrayContaining([
          `motir-release-mh-${seed.shop.id}`,
          `motir-release-mh-${seed.api.id}`,
        ]),
      );
      await beat();
    },
  );

  await chapter(
    'Recipe step 4 — the owner does AWS’s own steps; Motir’s access goes, the account leaves, the repositories move',
    async () => {
      markTenantStandaloneDone(ACCOUNT);
      const standalone = stepRow(page, 'await_standalone');
      const rechecked = page.waitForResponse(handoverRoute('/recheck'));
      await standalone.getByRole('button', { name: ta.checkAgain }).first().click();
      expect((await rechecked).status()).toBe(200);
      for (const step of [
        'await_standalone',
        'remove_access',
        'leave_organization',
        'transfer_repositories',
      ]) {
        await expect(stepRow(page, step)).toHaveAttribute('data-step-status', 'done', WORKER);
      }
      const account = readTenantAccount(ACCOUNT)!;
      expect(account.inOrganization).toBe(false);
      await expectNoPaymentOrRootField(page);
      await beat();
    },
  );

  await chapter(
    'Recipe step 5 — each panel reads Handed over: the account, the upstream address, no deploy',
    async () => {
      for (const repo of [seed.shop, seed.api]) {
        const app = await applicationOf(repo);
        expect(app.state).toBe('handed_over');
        await openProduction(page, repo);
        const handedOver = panel(page).getByTestId('production-handed-over');
        await expect(handedOver).toHaveAttribute('data-target', 'aws');
        await expect(handedOver.getByTestId('production-handed-over-account')).toContainText(
          '2109 8765 4321',
        );
        await expect(handedOver.getByTestId('production-handed-over-upstream')).toContainText(
          app.upstreamAddress!,
        );
        await expect(panel(page).getByTestId('production-current-release')).toHaveCount(0);
        await expect(panel(page).getByTestId('production-rollback')).toHaveCount(0);
        await expect(panel(page).getByRole('button', { name: /deploy|roll back/i })).toHaveCount(0);
        await expectSharedNotFound(page, repo.address!);
        await beat();
      }
    },
  );

  await chapter(
    'Recipe step 6 — a merge to main in a handed-over repository deploys nothing',
    async () => {
      const before = await releasesOf(seed.shop);
      const queued = () =>
        adminDb.jobQueueRun.count({
          where: { eventName: 'hosting/merge-release.requested', workspaceId: seed.workspaceId },
        });
      const queuedBefore = await queued();
      // The webhook awaits its whole handling — the enqueue included — before it answers.
      expect(await deliverMerge(page.request, seed.shop, commit(4))).toBe(200);
      expect(await queued()).toBe(queuedBefore);
      expect(await releasesOf(seed.shop)).toEqual(before);

      await openProduction(page, seed.shop);
      await expect(panel(page).getByTestId('production-handed-over')).toBeVisible();
      await beat();
    },
  );

  await chapter(
    'Recipe step 7 — the Fly repository moves to my GitHub and runs a 30-day grace window',
    async () => {
      await openRepositories(page);
      await main(page)
        .getByRole('button', { name: new RegExp(`^Move .*${seed.fly.name} to my GitHub$`) })
        .click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: en.repositorySet.continueCta })
        .click();
      await beat();
      const moved = page.waitForResponse(takeoverRoute(seed.fly));
      await page
        .getByRole('dialog')
        .getByRole('button', { name: en.repositoryTakeover.confirmCta })
        .click();
      expect((await moved).status()).toBe(200);

      const row = await adminDb.projectRepo.findUniqueOrThrow({
        where: { id: seed.fly.id },
        select: { takeoverTransferredAt: true },
      });
      const app = await applicationOf(seed.fly);
      expect(app.state).toBe('grace');
      expect(app.stopsAt!.getTime() - row.takeoverTransferredAt!.getTime()).toBe(30 * DAY_MS);

      await openProduction(page, seed.fly);
      await expect(panel(page).getByTestId('production-grace-banner')).toBeVisible();
      const grace = panel(page).getByTestId('production-grace-panel');
      await expect(grace).toContainText(tp.handover.grace.runsUntil);
      await expect(grace.getByTestId('production-grace-stops-at')).toHaveAttribute(
        'datetime',
        app.stopsAt!.toISOString(),
      );
      await expect(grace.getByTestId('production-export')).toHaveText(tp.handover.exports.download);
      await expect(grace.getByTestId('production-stop')).toHaveText(tp.handover.stop.button);
      await beat();
    },
  );

  await chapter('Download export: a pg_dump of the production database', async () => {
    const grace = panel(page).getByTestId('production-grace-panel');
    const created = page.waitForResponse(applicationRoute(flyApp.id, '/exports'));
    await grace.getByTestId('production-export').click();
    expect((await created).status()).toBe(202);
    await expect(grace.getByTestId('production-export-row')).toHaveCount(1, WORKER);

    const stored = await adminDb.hostedApplicationExport.findFirstOrThrow({
      where: { applicationId: flyApp.id },
      select: { id: true, storageKey: true },
    });
    const dump = readFakeExportDump(stored.storageKey);
    expect(dump).not.toBeNull();
    // The download answers with a short-lived signed link to the private bucket. The lane has no
    // bucket, and a browser navigation that 302s to the `.invalid` store host and turns into a
    // download leaves the page on Chromium's error page whether or not a route serves it (the CI
    // run never even reached the route), so the walk follows the link the panel offers with the
    // signed-in session's own request context instead: one recorded download, a 302 to a SIGNED
    // URL for exactly this export as an attachment, and the stored object behind it is the dump.
    const link = grace.getByTestId('production-export-download');
    await link.hover();
    const href = await link.getAttribute('href');
    expect(href).toBe(
      `/api/organizations/${seed.organizationId}/hosting/applications/${flyApp.id}` +
        `/exports/${stored.id}/download`,
    );
    const redirected = await page.request.get(href!, { maxRedirects: 0 });
    expect(redirected.status()).toBe(302);
    const signed = new URL(redirected.headers()['location']!);
    expect(decodeURIComponent(signed.pathname).endsWith(stored.storageKey)).toBe(true);
    expect(signed.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(signed.searchParams.get('response-content-disposition')).toMatch(/^attachment;/);
    expect(dump!.length).toBeGreaterThan(0);
    expect(dump!.subarray(0, 5).toString('latin1')).toBe('PGDMP');
    await expect
      .poll(() => adminDb.hostedApplicationExportDownload.count({ where: { exportId: stored.id } }))
      .toBe(1);
    await beat();
  });

  await chapter(
    'Recipe step 8 — Stop now: the final export is kept, the app and its database are deleted',
    async () => {
      await panel(page).getByTestId('production-stop').click();
      const dialog = page.getByRole('alertdialog').getByTestId('production-stop-dialog');
      await expect(dialog).toContainText(tp.handover.dialog.deleteDatabase);
      await beat();
      const stopped = page.waitForResponse(applicationRoute(flyApp.id, '/stop'));
      await page.getByRole('alertdialog').getByTestId('production-stop-confirm').click();
      expect((await stopped).status()).toBe(200);

      const handedOver = panel(page).getByTestId('production-handed-over');
      await expect(handedOver).toHaveAttribute('data-target', 'fly', WORKER);
      await expect(handedOver.getByTestId('production-final-export')).toBeVisible();
      await expect(panel(page).getByTestId('production-rollback')).toHaveCount(0);

      expect((await applicationOf(seed.fly)).state).toBe('handed_over');
      expect(previewHostingFake('fly').app(`mh-${seed.fly.id}`)).toBeUndefined();
      expect(fakeDatabaseExists(seed.fly.id)).toBe(false);
      await expectSharedNotFound(page, seed.fly.address!);
      await beat();
    },
  );
});
