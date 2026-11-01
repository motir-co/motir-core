// E2E: a repository whose graph is too large, as a person meets it on /code
// (Story MOTIR-7092 · MOTIR-7134). Its paced receipt,
// `acceptance-graph-too-large.spec.ts`, was retired by MOTIR-9411: the receipt
// is recorded, and this file asserts every state it showed.
//
// The story: motir-ai refuses a graph over the supported 1 GiB at the upload
// grant, motir-core stops retrying and writes the size and the limit onto the
// repository (MOTIR-7130), and the `/code` row says so in plain words
// (MOTIR-7132, as the approved design MOTIR-7126 draws it). This drives that row.
//
// ⚠️ NOTHING ABOUT THE VERDICT IS STUBBED. Each state is reached the way
// `code-index-freshness.spec.ts` reaches its own: by seeding the REAL columns —
// here `GithubRepo.indexRefused*`, which the settle writes — and letting the
// shipped derivation and the shipped row render them.
//
// ⚠️ ONE DEVIATION FROM THE CARD, RECORDED RATHER THAN HIDDEN. The card says
// recovery goes through `recordIndexSucceeded`, "which runs the shipped settle
// path and its clear". It does not: that helper writes a succeeded LEDGER row and
// the settle's `markIndexSettled` stamp (MOTIR-10171), but never the refusal
// clear (`_helpers/migrate-index-seed.ts`). So recovery here makes BOTH
// writes an indexed run makes — the ledger row through that helper, and the
// repository settle + refusal clear through the SHIPPED repository methods
// `indexFleetSteps.settleIndexingRepo` calls (`markIndexSettled`,
// `clearIndexRefusal`). The job path itself is proven by MOTIR-7133's suite.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { setReaderLanguage } from './_helpers/reader-language';
import { projectsService } from '@/lib/services/projectsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  E2E_INDEX_REPOS,
  indexRepoRef,
  recordIndexSucceeded,
  seedConnectedRepos,
} from './_helpers/migrate-index-seed';

const [REPO, SECOND] = [E2E_INDEX_REPOS[0]!, E2E_INDEX_REPOS[1]!];
const REPO_REF = indexRepoRef(REPO);
const SECOND_REF = indexRepoRef(SECOND);
const EMAIL = 'graph-too-large@example.com';

const GIB = 1024 ** 3;
const REFUSED_SIZE = 1_503_238_553; // reads "1.4 GiB"

const TITLE =
  'The last index was refused: the code graph was 1.4 GiB, and the supported maximum is 1 GiB.';
const LAST_GRAPH = 'Motir keeps planning against the last code graph it indexed.';
const NOT_UPDATING = 'This index is not updating.';

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

/** Sign up, then give the auto-created workspace one ACTIVE project. */
async function seedTenant(page: Page): Promise<Tenant> {
  await signUp(page, EMAIL);
  const local = EMAIL.split('@')[0]!;
  const user = await adminDb.user.findFirstOrThrow({ where: { email: EMAIL } });
  const ws = await adminDb.workspace.findFirstOrThrow({ where: { name: `${local}'s Workspace` } });
  const project = await projectsService.createProject({
    workspaceId: ws.id,
    actorUserId: user.id,
    name: 'Too Large Demo',
    identifier: 'TLG',
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } },
    data: { activeProjectId: project.id },
  });
  return { userId: user.id, workspaceId: ws.id, projectId: project.id };
}

/** Put one connected repository into the project's SET, realized — returns its row id. */
async function giveProjectRepo(t: Tenant, repo: { owner: string; name: string }): Promise<string> {
  const row = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: t.workspaceId, owner: repo.owner, name: repo.name },
  });
  const created = await projectRepoSetService.addRow(
    t.projectId,
    { role: repo.name === REPO.name ? 'web' : 'api', name: repo.name },
    { userId: t.userId, workspaceId: t.workspaceId },
  );
  await adminDb.projectRepo.update({ where: { id: created.id }, data: { githubRepoId: row.id } });
  return row.id;
}

/**
 * The state MOTIR-7130 leaves after a run refused for size: the two numbers and
 * the time on the repository, and the claim still on a run the ledger records
 * as FAILED — which is what makes `refreshFailing` true beside the refusal.
 */
async function seedRefused(t: Tenant, repoId: string): Promise<void> {
  const failed = await adminDb.jobRun.create({
    data: {
      workspaceId: t.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'code-graph/index.requested',
      eventId: `evt-refused-${repoId}`,
      lane: 'inngest',
      attempt: 1,
      status: 'failed',
    },
  });
  await adminDb.githubRepo.update({
    where: { id: repoId },
    data: {
      indexingRunId: failed.id,
      indexRefusedSizeBytes: BigInt(REFUSED_SIZE),
      indexRefusedCapBytes: BigInt(GIB),
      indexRefusedAt: new Date(),
    },
  });
}

/** Arrive at /code the way a member does — the sidebar's Codebase row (MOTIR-4866). */
async function openCodeFromNav(page: Page): Promise<void> {
  await page.goto('/dashboard');
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Codebase', exact: true })
    .click();
  await expect(page).toHaveURL(/\/code(\?|$)/);
  await expect(page.getByRole('heading', { name: 'Codebase', level: 1 })).toBeVisible();
}

const rows = (page: Page) => page.getByRole('list', { name: /repositories this project/i });
const rowFor = (page: Page, ref: string) =>
  rows(page).getByRole('listitem').filter({ hasText: ref });

test('1–2 · a repository refused for size: the size, the limit and what to do — and not "not updating"', async ({
  page,
}) => {
  const t = await seedTenant(page);
  await seedConnectedRepos(t.workspaceId, [REPO]);
  const repoId = await giveProjectRepo(t, REPO);
  await recordIndexSucceeded(t.workspaceId, REPO_REF);
  await adminDb.githubRepo.update({
    where: { id: repoId },
    data: { indexedHeadSha: 'a1b2c3d', defaultBranchHeadSha: 'e4f5a6b' },
  });
  await seedRefused(t, repoId);

  await openCodeFromNav(page);
  const row = rowFor(page, REPO_REF);

  await expect(row.getByText(TITLE)).toBeVisible();
  await expect(row.getByText(LAST_GRAPH, { exact: false })).toBeVisible();
  await expect(row.locator('code', { hasText: 'codegraph.json' })).toBeVisible();
  await expect(
    row.locator('code', { hasText: '"exclude": ["tests/", "fixtures/"]' }),
  ).toBeVisible();
  await expect(row.getByText(/or contact Motir\./)).toBeVisible();
  await expect(row.getByText('Stale', { exact: true })).toBeVisible();
  // ⚠️ THE PRECEDENCE (design §17.3): the run that was refused also failed, so
  // `refreshFailing` is true — and the row still carries ONE warning.
  await expect(row.getByText(NOT_UPDATING)).toHaveCount(0);
  await expect(row.getByText(/The last index was refused/)).toHaveCount(1);
});

test('3 · behind as well: the drift line sits beside the pill, the refusal shows once', async ({
  page,
}) => {
  const t = await seedTenant(page);
  await seedConnectedRepos(t.workspaceId, [REPO]);
  const repoId = await giveProjectRepo(t, REPO);
  await recordIndexSucceeded(t.workspaceId, REPO_REF);
  await adminDb.githubRepo.update({
    where: { id: repoId },
    data: {
      indexedHeadSha: 'a1b2c3d',
      defaultBranchHeadSha: 'e4f5a6b',
      commitsBehind: 312,
      commitsBehindBaseSha: 'a1b2c3d',
      commitsBehindHeadSha: 'e4f5a6b',
    },
  });
  await seedRefused(t, repoId);

  await page.goto('/code');
  const row = rowFor(page, REPO_REF);
  await expect(row.getByText('312 commits behind')).toBeVisible();
  await expect(row.getByText(/The last index was refused/)).toHaveCount(1);
  await expect(row.getByText(NOT_UPDATING)).toHaveCount(0);
});

test('4 · refused before any index: the Never indexed pill, and no sentence about a last graph', async ({
  page,
}) => {
  const t = await seedTenant(page);
  await seedConnectedRepos(t.workspaceId, [REPO, SECOND]);
  await giveProjectRepo(t, REPO);
  const secondId = await giveProjectRepo(t, SECOND);
  await adminDb.githubRepo.update({
    where: { id: secondId },
    data: { indexedHeadSha: null, defaultBranchHeadSha: 'e4f5a6b' },
  });
  await seedRefused(t, secondId);

  await page.goto('/code');
  const row = rowFor(page, SECOND_REF);
  await expect(row.getByText('Never indexed', { exact: true })).toBeVisible();
  await expect(row.getByText(TITLE)).toBeVisible();
  await expect(row.locator('code', { hasText: 'codegraph.json' })).toBeVisible();
  await expect(row.getByText(LAST_GRAPH)).toHaveCount(0);
});

test('5 · planning is not blocked by the refusal — it keeps reading the previous graph', async ({
  page,
}) => {
  const t = await seedTenant(page);
  await seedConnectedRepos(t.workspaceId, [REPO]);
  const repoId = await giveProjectRepo(t, REPO);
  await recordIndexSucceeded(t.workspaceId, REPO_REF);
  await seedRefused(t, repoId);

  await page.goto('/code');
  await expect(rowFor(page, REPO_REF).getByText(/The last index was refused/)).toBeVisible();
  await page.goto('/planning');
  await expect(page.getByRole('dialog', { name: /plan/i })).toBeVisible();
});

test('6 · recovered: after an indexed run the row reads Indexed and the refusal is gone', async ({
  page,
}) => {
  const t = await seedTenant(page);
  await seedConnectedRepos(t.workspaceId, [REPO]);
  const repoId = await giveProjectRepo(t, REPO);
  await recordIndexSucceeded(t.workspaceId, REPO_REF);
  await adminDb.githubRepo.update({
    where: { id: repoId },
    data: { indexedHeadSha: 'a1b2c3d', defaultBranchHeadSha: 'e4f5a6b' },
  });
  await seedRefused(t, repoId);

  await page.goto('/code');
  await expect(rowFor(page, REPO_REF).getByText(/The last index was refused/)).toBeVisible();

  // The two writes an INDEXED run makes: the succeeded ledger row, and the
  // repository settle that releases the claim, stamps the head, and clears the
  // refusal (`indexFleetSteps.settleIndexingRepo`, MOTIR-7130).
  await recordIndexSucceeded(t.workspaceId, REPO_REF);
  const { organizationId } = await adminDb.githubRepo.findFirstOrThrow({
    where: { workspaceId: t.workspaceId, owner: REPO.owner, name: REPO.name },
    select: { organizationId: true },
  });
  await withSystemContext(async (tx) => {
    await githubRepoRepository.markIndexSettled(
      REPO_REF,
      organizationId,
      { headSha: 'e4f5a6b' },
      tx,
    );
    await githubRepoRepository.clearIndexRefusal(REPO_REF, tx);
  });

  await page.reload();
  const row = rowFor(page, REPO_REF);
  await expect(row.getByText('Indexed', { exact: true })).toBeVisible();
  await expect(row.getByText(/The last index was refused/)).toHaveCount(0);
  await expect(row.getByText(NOT_UPDATING)).toHaveCount(0);
});

test('7 · Chinese: the refusal reads in the zh.json text', async ({ page }) => {
  const t = await seedTenant(page);
  await seedConnectedRepos(t.workspaceId, [REPO]);
  const repoId = await giveProjectRepo(t, REPO);
  await recordIndexSucceeded(t.workspaceId, REPO_REF);
  await seedRefused(t, repoId);

  await page.goto('/code');
  await setReaderLanguage(page, EMAIL, 'zh');
  await page.reload();

  // The list's accessible name is translated too, so the row is found by its
  // repository ref alone rather than through the English list label.
  const row = page.getByRole('listitem').filter({ hasText: REPO_REF });
  await expect(
    row.getByText('上一次建立索引被拒绝：代码图大小为 1.4 GiB，而支持的上限为 1 GiB。'),
  ).toBeVisible();
  await expect(row.getByText(/Motir 会继续基于上一次成功建立索引的代码图进行规划。/)).toBeVisible();
  await expect(row.getByText(/或联系 Motir。/)).toBeVisible();
  await expect(row.getByText('该索引没有在更新。')).toHaveCount(0);
});
