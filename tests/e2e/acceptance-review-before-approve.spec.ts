import type { Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  checkSuitePayload,
  postSignedWebhook,
  pullRequestPayload,
  seedGithubInstallation,
} from './_helpers/github-seed';
import { E2E_GITHUB_USER, E2E_PROVISIONING_ORG } from './_helpers/github-const';
import { linkPr, type E2ERepoRef } from './_helpers/pr-link';
import { previewHostingFake, resetPreviewHosting } from './_helpers/preview-hosting';
import { startPreviewTlsFront, type PreviewTlsFront } from './_helpers/preview-tls-front';
import { setReaderLanguage } from './_helpers/reader-language';
import { createTestPerson } from './_helpers/testPerson';
import {
  startPreviewUpstreamStandIn,
  type PreviewUpstreamStandIn,
} from '@/tests/helpers/previewUpstreamStandIn';
import { linkProjectRepo } from '@/tests/helpers/projectRepoLink';
import { writeFixtureFileSync } from '@/lib/test-fixture-file';
import { PREVIEW_IMAGE_WORKFLOW_PATH } from '@/lib/preview/lifecycleEvents';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { CUSTOM_WORKSPACE_ROLE_TIER } from '@/lib/workspaces/roles';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

/*
 * REVIEW BEFORE YOU APPROVE — the story's acceptance walk
 * (Story MOTIR-4881 · Subtask MOTIR-12118; design `design/github/design-notes.md` § 35).
 *
 * A pull request's row in the Development block offers its code link-out only when the
 * READER can open that code. On a repository Motir created, that depends on the reader:
 * a member whose invitation is accepted opens it; an invited member is pointed at the
 * waiting invitation; a member whose role carries no code access, or who has no
 * GitHub account Motir knows, gets no link-out at all — and the second is pointed at
 * the running preview instead, which is how they review the change. A connected
 * repository is the row as it always was.
 *
 * One recorded test walks the recipe as each of four members, in the approval overlay
 * (where most approvals are decided), and as the no-GitHub member on the item page's
 * Development card, its quick-view peek, a second card whose pull request has no ready
 * preview, and in zh.
 *
 * ── EVERY STATE CHANGE GOES THROUGH THE SHIPPED PATH ───────────────────────
 * The pull requests open, link and go green through the signed webhook and the real
 * link door; the merge gate the overlay opens is the one CI promotion raised in this
 * `manual` project. The preview is made ready exactly as MOTIR-5766's receipt
 * (`acceptance-pr-previews.spec.ts`) makes it: a signed `pull_request` and a successful
 * image `workflow_run`, against the fake hosting port, the TLS front and the upstream
 * stand-in. The reader states are seeded as the access derivation reads them: a GitHub
 * identity row (or none), and the collaborator record the invitation saga leaves.
 *
 * ── WHY THE NO-PREVIEW CASE IS A SECOND CARD ───────────────────────────────
 * Closing the preview means closing its pull request, which ends that pull request's
 * merge gate too, so the overlay would no longer be the surface the step asks about. A
 * second card's pull request — whose image never lands — reads the same branch of the
 * row (no READY preview) with its gate still open.
 *
 * ⚠️ EVERY WAIT IS AUTHORITATIVE — a webhook delivery's processed 200, the gate row, the
 * overlay's settled name (set only when the gate's read answers), the row's
 * `data-preview-state` after a reload, the preview host's own `main`. No timed wait.
 *
 * ⚠️ THE 48xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).
 */

test.describe.configure({ mode: 'serial', timeout: 480_000 });

const PASSWORD = 'Review-before-approve-e2e-4881';
const OWNER = 'rba-owner@motir.test';
const ACCEPTED = 'rba-accepted@motir.test';
const INVITED = 'rba-invited@motir.test';
const NO_GITHUB = 'rba-no-github@motir.test';
const ROLE_CANNOT_EDIT = 'rba-reviewer@motir.test';

const CREATED_NAME = 'rba-web';
const CREATED: E2ERepoRef = {
  owner: E2E_PROVISIONING_ORG,
  name: CREATED_NAME,
  defaultBranch: 'main',
};
const CREATED_INSTALLATION_ID = '99004881';
const CREATED_PROVIDER_REPO_ID = 48810001;
const CONNECTED = {
  providerRepoId: '48810002',
  owner: 'acme-rba',
  name: 'rba-api',
  defaultBranch: 'main',
  archived: false,
} as const;
const INVITATION = `https://github.com/${E2E_PROVISIONING_ORG}/${CREATED_NAME}/invitations`;

// ⚠️ NESTED `{ number: n }` so the number-block guard reads every delivery's number.
const PRS = {
  web: { number: 48101 },
  api: { number: 48102 },
  noPreview: { number: 48103 },
} as const;
const headOf = (n: number) => n.toString(16).padStart(8, '0').repeat(5);

const DOMAIN = process.env['MOTIR_PREVIEW_DOMAIN'] ?? 'preview.localhost';
const TLS_PORT = Number(process.env['E2E_PREVIEW_TLS_PORT'] ?? 3293);
const STATE_WAIT_MS = 180_000;

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

type Messages = typeof en;
const ZH = zh as unknown as Messages;
const fill = (text: string, vars: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '');
/** A catalogue sentence with its rich tags removed — what the line reads as text. */
const plain = (s: string) => s.replace(/<\/?(link|tone)>/g, '');

interface SeededCard {
  id: string;
  key: string;
}
interface Seed {
  workspaceId: string;
  createdRepoId: string;
  walk: SeededCard;
  noPreview: SeededCard;
}

let seed: Seed;
let standIn: PreviewUpstreamStandIn;
let front: PreviewTlsFront;

// ── The deliveries ──────────────────────────────────────────────────────────

/** The Motir-created repository's deliveries carry ITS installation, as the
 *  provisioning org's App delivers them. */
const createdDelivery = {
  installation: { id: Number(CREATED_INSTALLATION_ID) },
  repository: {
    id: CREATED_PROVIDER_REPO_ID,
    name: CREATED_NAME,
    owner: { login: E2E_PROVISIONING_ORG },
  },
};

function createdPullRequest(pr: { number: number }, title: string) {
  return {
    action: 'opened',
    ...createdDelivery,
    pull_request: {
      number: pr.number,
      state: 'open',
      merged: false,
      title,
      head: { ref: `feature/rba-${pr.number}`, sha: headOf(pr.number) },
      base: { ref: 'main' },
      user: { id: E2E_GITHUB_USER.id },
    },
  };
}

function createdImageRun(pr: { number: number }) {
  return {
    action: 'completed',
    ...createdDelivery,
    workflow_run: {
      path: PREVIEW_IMAGE_WORKFLOW_PATH,
      event: 'pull_request',
      head_sha: headOf(pr.number),
      pull_requests: [{ number: pr.number }],
      conclusion: 'success',
    },
  };
}

function createdGreen(pr: { number: number }) {
  return {
    action: 'completed',
    ...createdDelivery,
    check_suite: {
      status: 'completed',
      conclusion: 'success',
      head_sha: headOf(pr.number),
      head_branch: `feature/rba-${pr.number}`,
      pull_requests: [{ number: pr.number }],
      app: { slug: 'e2e-ci' },
    },
  };
}

async function deliver(page: Page, event: string, payload: unknown, what: string): Promise<void> {
  const res = await postSignedWebhook(page.request, event, payload);
  expect(res.status(), `${what}: ${await res.text()}`).toBe(200);
}

/** Open a pull request on the Motir-created repository and link it to the card. */
async function openOnCreated(page: Page, card: SeededCard, pr: { number: number }) {
  await deliver(
    page,
    'pull_request',
    createdPullRequest(pr, `Export invoices, take ${pr.number}`),
    `open ${pr.number}`,
  );
  await linkPr(page, {
    workItemId: card.id,
    repo: CREATED,
    number: pr.number,
    headRef: `feature/rba-${pr.number}`,
  });
}

/** Wait for the card's approve-to-merge gate — the row CI promotion raises. */
async function awaitMergeGate(card: SeededCard): Promise<void> {
  await expect
    .poll(
      async () =>
        (await adminDb.approvalGate.count({
          where: { workItemId: card.id, kind: 'pull_request_approval', state: 'awaiting' },
        })) > 0,
      { timeout: STATE_WAIT_MS },
    )
    .toBe(true);
}

// ── The surfaces ────────────────────────────────────────────────────────────

const prName = (repo: { owner: string; name: string }, pr: { number: number }) =>
  `${repo.owner}/${repo.name} · #${pr.number}`;

/** The approval overlay, by its SETTLED name — composed from the gate read's own work
 *  item, so finding it is the wait for that read. */
async function openOverlay(page: Page, card: SeededCard, m: Messages = en): Promise<Locator> {
  await page.goto(`/items/${card.key}?approval=${card.key}&approvalKind=pull_request_approval`);
  const dialog = page.getByRole('dialog', {
    name: fill(m.approvalOverlay.dialogTitle, {
      kind: m.approvalGate.pullRequestApproval.kindLabel,
      key: card.key,
    }),
    exact: true,
  });
  await expect(dialog).toBeVisible({ timeout: FIRST_PAINT_MS });
  return dialog;
}

/** One pull request's row inside a host — the overlay, the item page's main, the peek. */
function rowIn(host: Locator, repo: { owner: string; name: string }, pr: { number: number }) {
  return host.getByRole('listitem').filter({ hasText: prName(repo, pr) });
}

const linkOut = (row: Locator, m: Messages = en) =>
  row.getByRole('link', { name: m.github.development.openOnGithub, exact: true });
const accessLine = (row: Locator) => row.getByTestId('pr-row-access');
const previewOf = (row: Locator) => row.getByTestId('pr-row-preview');

/** The row exactly as it shipped before this story: its link-out, no access line. */
async function expectAsToday(row: Locator, url: string): Promise<void> {
  await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(linkOut(row)).toHaveAttribute('href', url);
  await expect(accessLine(row)).toHaveCount(0);
}

/** The no-GitHub reader's row with a ready preview above: no link-out, the line that
 *  names the preview. */
async function expectPointedAtPreview(row: Locator, m: Messages = en): Promise<void> {
  await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(previewOf(row)).toHaveAttribute('data-preview-state', 'ready');
  await expect(linkOut(row, m)).toHaveCount(0);
  await expect(accessLine(row)).toHaveAttribute('data-access-variant', 'noGithubPreview');
  await expect(accessLine(row)).toHaveText(plain(m.github.development.access.noGithubPreview));
}

const githubUrl = (repo: { owner: string; name: string }, pr: { number: number }) =>
  `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`;

// ── Seed ────────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  await resetDatabase();
  resetPreviewHosting();
  const repository = `${E2E_PROVISIONING_ORG}/${CREATED_NAME}`;
  writeFixtureFileSync(
    process.env['MOTIR_GITHUB_PREVIEW_CONTROL_PATH']!,
    JSON.stringify({
      repositories: [repository],
      manifests: { [repository]: JSON.stringify(MANIFEST) },
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
    identifier: 'RBA',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  // A person approves a green pull request before it merges — the gate this walk opens.
  await adminDb.project.update({
    where: { id: project.id },
    data: { prMergeMode: 'manual', prMergeModeDecidedAt: new Date() },
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };

  // The four readers. The one whose role cannot edit holds a CUSTOM role that may
  // browse and comment but not edit — the permission, not the membership, withholds.
  const person = async (email: string, name: string) => {
    const user = await createTestPerson({ email, password: PASSWORD, name });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    return user;
  };
  const accepted = await person(ACCEPTED, 'Abe Accepted');
  const invited = await person(INVITED, 'Ivy Invited');
  const noGithub = await person(NO_GITHUB, 'Nell Nogit');
  const reviewer = await person(ROLE_CANNOT_EDIT, 'Rex Reviewer');
  const role = await adminDb.workspaceRoleDefinition.create({
    data: {
      workspaceId: workspace.id,
      name: 'Reviewer',
      permissions: ['project:browse', 'comment:add', 'page:view'],
    },
  });
  await adminDb.$transaction((tx) =>
    workspaceMembershipRepository.setWorkspaceRole(
      reviewer.id,
      workspace.id,
      { workspaceRole: CUSTOM_WORKSPACE_ROLE_TIER, roleDefinitionId: role.id },
      tx,
    ),
  );
  for (const u of [owner, accepted, invited, noGithub, reviewer]) {
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: u.id, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  // The web repository Motir CREATED for the project, in Motir's org, hosted on Fly —
  // the state the establish flow leaves behind — with its previews on.
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: CREATED_INSTALLATION_ID,
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
      repoId: String(CREATED_PROVIDER_REPO_ID),
      owner: E2E_PROVISIONING_ORG,
      name: CREATED_NAME,
      defaultBranch: 'main',
      archived: false,
    },
  });
  const row = await projectRepoSetService.addRow(
    project.id,
    { role: 'web', name: CREATED_NAME },
    ctx,
  );
  await projectRepoSetService.markCreating(row.id, ctx);
  await projectRepoSetService.attachRealizedRepoRow(row.id, mirror.id, ctx);
  await projectRepoSetService.setHosting(
    row.id,
    { target: 'fly', useCase: 'mvp', size: 'small' },
    ctx,
  );
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: { previewEnabledAt: new Date(), previewPushNamespace: `mh-${row.id}-pv` },
  });

  // The repository the project CONNECTED: the organisation's own, on the shared E2E
  // installation. Motir knows nothing of a reader's access to it.
  await seedGithubInstallation(workspace.id, [CONNECTED]);
  const connected = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: CONNECTED.providerRepoId },
  });
  await linkProjectRepo({
    workspaceId: workspace.id,
    projectId: project.id,
    githubRepoId: connected.id,
    name: connected.name,
    role: 'api',
  });

  // What the access derivation reads: a connected GitHub identity (none for the
  // no-GitHub member) and the collaborator record the invitation saga leaves.
  let ghId = 48810;
  for (const u of [accepted, invited, reviewer]) {
    ghId += 1;
    await adminDb.githubIdentity.create({
      data: {
        userId: u.id,
        githubUserId: String(ghId),
        githubLogin: `rba-${ghId}`,
        accessTokenEncrypted: 'not-read-by-this-walk',
      },
    });
  }
  const collaborator = (userId: string, login: string, state: 'accepted' | 'invited') =>
    adminDb.projectRepoCollaborator.create({
      data: {
        workspaceId: workspace.id,
        projectRepoId: row.id,
        userId,
        githubLogin: login,
        permission: 'push',
        invitedAt: new Date(),
        acceptedAt: state === 'accepted' ? new Date() : null,
        invitationUrl: state === 'invited' ? INVITATION : null,
      },
    });
  await collaborator(accepted.id, 'rba-48811', 'accepted');
  await collaborator(invited.id, 'rba-48812', 'invited');
  await collaborator(reviewer.id, 'rba-48813', 'accepted');

  const card = async (title: string): Promise<SeededCard> => {
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title },
      ctx,
    );
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: owner.id } });
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
    return { id: item.id, key: item.identifier };
  };
  seed = {
    workspaceId: workspace.id,
    createdRepoId: mirror.id,
    walk: await card('Let customers download invoices'),
    noPreview: await card('Paginate the invoice list'),
  };
});

test.afterAll(async () => {
  await standIn?.stop();
  await front?.stop();
});

// ── The walk ────────────────────────────────────────────────────────────────

test('each reader sees the code link-out their access allows, and a reader with no GitHub account is pointed at the preview', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-4881');
  const A = en.github.development.access;
  let previewHost = '';

  await chapter(
    'The run’s pull requests are green, previewed, and waiting at the merge gate',
    async () => {
      await signIn(page, OWNER, PASSWORD);
      // The walk card: one pull request on each repository.
      await openOnCreated(page, seed.walk, PRS.web);
      await deliver(
        page,
        'pull_request',
        pullRequestPayload({
          action: 'opened',
          number: PRS.api.number,
          title: 'Export invoices — API',
          headRef: `feature/rba-${PRS.api.number}`,
          state: 'open',
          merged: false,
          repo: CONNECTED,
        }),
        `open ${PRS.api.number}`,
      );
      await linkPr(page, {
        workItemId: seed.walk.id,
        repo: CONNECTED,
        number: PRS.api.number,
        headRef: `feature/rba-${PRS.api.number}`,
      });
      // The second card: one pull request on the Motir-created repository, whose image
      // never lands — so it has no ready preview.
      await openOnCreated(page, seed.noPreview, PRS.noPreview);

      // The walk card's image lands: the preview is ready, and points at the stand-in.
      await deliver(page, 'workflow_run', createdImageRun(PRS.web), 'image');
      await expect(async () => {
        await page.goto(`/items/${seed.walk.key}`);
        await expect(previewOf(rowIn(page.getByRole('main'), CREATED, PRS.web))).toHaveAttribute(
          'data-preview-state',
          'ready',
          { timeout: 5_000 },
        );
      }).toPass({ timeout: STATE_WAIT_MS, intervals: [2_000, 3_000, 5_000] });
      const preview = await adminDb.previewDeployment.findFirstOrThrow({
        where: { repoId: seed.createdRepoId, pullRequestNumber: PRS.web.number },
      });
      previewHost = preview.host;
      previewHostingFake('fly').setUpstream(preview.flyAppName!, standIn.origin);

      // CI goes green on every pull request; CI promotion raises each card's gate.
      await deliver(page, 'check_suite', createdGreen(PRS.web), `green ${PRS.web.number}`);
      await deliver(
        page,
        'check_suite',
        checkSuitePayload({
          conclusion: 'success',
          headSha: headOf(PRS.api.number),
          prNumber: PRS.api.number,
          headBranch: `feature/rba-${PRS.api.number}`,
          repo: CONNECTED,
        }),
        `green ${PRS.api.number}`,
      );
      await deliver(
        page,
        'check_suite',
        createdGreen(PRS.noPreview),
        `green ${PRS.noPreview.number}`,
      );
      await awaitMergeGate(seed.walk);
      await awaitMergeGate(seed.noPreview);
      await beat();
    },
  );

  await chapter('A member whose invitation is accepted: both rows open on GitHub', async () => {
    await signIn(page, ACCEPTED, PASSWORD);
    const dialog = await openOverlay(page, seed.walk);
    await expectAsToday(rowIn(dialog, CREATED, PRS.web), githubUrl(CREATED, PRS.web));
    await expectAsToday(rowIn(dialog, CONNECTED, PRS.api), githubUrl(CONNECTED, PRS.api));
    await beat();
  });

  await chapter(
    'An invited member: the link-out stays, and the line points at the invitation',
    async () => {
      await signIn(page, INVITED, PASSWORD);
      const dialog = await openOverlay(page, seed.walk);
      const row = rowIn(dialog, CREATED, PRS.web);
      await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(linkOut(row)).toHaveAttribute('href', githubUrl(CREATED, PRS.web));
      await expect(accessLine(row)).toHaveAttribute('data-access-variant', 'invited');
      await expect(accessLine(row)).toHaveText(plain(A.invited));
      const accept = accessLine(row).getByRole('link');
      await expect(accept).toHaveAttribute('href', INVITATION);
      await expect(accept).toHaveAttribute('target', '_blank');
      await expectAsToday(rowIn(dialog, CONNECTED, PRS.api), githubUrl(CONNECTED, PRS.api));
      await beat();
    },
  );

  await chapter(
    'A member whose role has no code access: no link-out, and the line says why',
    async () => {
      await signIn(page, ROLE_CANNOT_EDIT, PASSWORD);
      const dialog = await openOverlay(page, seed.walk);
      const row = rowIn(dialog, CREATED, PRS.web);
      await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(linkOut(row)).toHaveCount(0);
      await expect(accessLine(row)).toHaveAttribute('data-access-variant', 'roleCannotEdit');
      await expect(accessLine(row)).toHaveText(A.roleCannotEdit);
      await expectAsToday(rowIn(dialog, CONNECTED, PRS.api), githubUrl(CONNECTED, PRS.api));
      await beat();
    },
  );

  let previewHref = '';
  await chapter(
    'A member with no GitHub account: no link-out, pointed at the preview above',
    async () => {
      await signIn(page, NO_GITHUB, PASSWORD);
      const dialog = await openOverlay(page, seed.walk);
      const row = rowIn(dialog, CREATED, PRS.web);
      await expectPointedAtPreview(row);
      // It names the preview line above it, and does not repeat that line's link.
      await expect(accessLine(row).getByRole('link')).toHaveCount(0);
      const previewLink = previewOf(row).getByRole('link', { name: previewHost });
      await expect(previewLink).toHaveAttribute('target', '_blank');
      previewHref = (await previewLink.getAttribute('href'))!;
      expect(previewHref).toBe(`https://${previewHost}`);
      await expectAsToday(rowIn(dialog, CONNECTED, PRS.api), githubUrl(CONNECTED, PRS.api));
      await beat();
    },
  );

  await chapter('The preview link opens the running change', async () => {
    // The link opens a new tab; the walk follows it in this one, so the recording keeps it.
    await page.goto(previewHref);
    await page.waitForURL((url) => url.host === previewHost, { timeout: FIRST_PAINT_MS });
    await expect(async () => {
      await page.goto(previewHref);
      await expect(page.getByRole('main')).toHaveAttribute('data-testid', 'preview-stand-in', {
        timeout: 3_000,
      });
    }).toPass({ timeout: 30_000 });
    await beat();
  });

  await chapter(
    'A pull request with no ready preview: no link-out, and no preview to point at',
    async () => {
      const dialog = await openOverlay(page, seed.noPreview);
      const row = rowIn(dialog, CREATED, PRS.noPreview);
      await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
      // Its image never landed: whatever its preview line says, it is not ready.
      await expect(
        row.locator('[data-testid="pr-row-preview"][data-preview-state="ready"]'),
      ).toHaveCount(0);
      await expect(linkOut(row)).toHaveCount(0);
      await expect(accessLine(row)).toHaveAttribute('data-access-variant', 'noGithubNoPreview');
      await expect(accessLine(row)).toHaveText(plain(A.noGithubNoPreview));
      await beat();
    },
  );

  await chapter('The item page and its quick-view peek read the same as the overlay', async () => {
    await page.goto(`/items/${seed.walk.key}`);
    const main = page.getByRole('main');
    await expectPointedAtPreview(rowIn(main, CREATED, PRS.web));
    await expectAsToday(rowIn(main, CONNECTED, PRS.api), githubUrl(CONNECTED, PRS.api));
    await beat();

    await page.goto(`/items?peek=${encodeURIComponent(seed.walk.key)}`);
    const peek = page.getByRole('dialog', {
      name: fill(en.issueViews.quickViewDialogLabel, { key: seed.walk.key }),
    });
    await expect(peek).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expectPointedAtPreview(rowIn(peek, CREATED, PRS.web));
    await expectAsToday(rowIn(peek, CONNECTED, PRS.api), githubUrl(CONNECTED, PRS.api));
    await beat();
  });

  await chapter('In Chinese, the line reads the zh catalogue', async () => {
    await setReaderLanguage(page, NO_GITHUB, 'zh');
    const dialog = await openOverlay(page, seed.walk, ZH);
    const row = rowIn(dialog, CREATED, PRS.web);
    await expectPointedAtPreview(row, ZH);
    await expect(accessLine(row)).not.toContainText(plain(A.noGithubPreview));
    await beat();
  });
});
