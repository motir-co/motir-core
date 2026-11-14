import type { Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { seedMotirRepository } from '@/tests/helpers/motirRepository';
import { GRACE_HOURS } from '@/lib/publicAddresses/nameHold';
import en from '@/messages/en.json';

/*
 * ONLY A WORKSPACE WITH A MOTIR REPOSITORY HOLDS A motir.site NAME — the
 * story's acceptance walk (Story MOTIR-11283 · Subtask MOTIR-11291;
 * ADR public-tenant-addresses §8 AMENDMENT 5).
 *
 * One continuous test, in three workspaces:
 *
 *   * IMPORTED — its only repository is connected from the organisation. Its
 *     Manager sees why there is no name, and no field to claim one; a claim
 *     sent from the same session anyway is refused 409.
 *   * MOTIR — a repository Motir created. The pane is today's: claim, then
 *     rename through the dated confirm.
 *   * HELD — a Motir repository and a name taken long ago. Its repository is
 *     then transferred out (takeover `done`); the pane keeps the name and its
 *     Release, drops Rename, says why, refuses a rename sent anyway, and
 *     releases.
 *
 * Each state has its own workspace because one rename spends the 30-day
 * change limit. The takeover is written to the row and the page reloaded — the
 * way time and a transfer would arrive — never waited for.
 *
 * ── WHAT IS NOT ASSERTED HERE ──────────────────────────────────────────────
 * That the route, `getClaimEligibility`, the pane's server read and the
 * stray-claim migration agree on all seven repository shapes is the
 * integration gate's (`tests/publicAddresses/motirRepositoryRuleIntegration.test.ts`).
 * A member's view of the new states is the pane's component tests'. The
 * eligible release is MOTIR-4528's walk (`acceptance-workspace-address.spec.ts`).
 *
 * Every string is read from `messages/en.json`; every write is awaited on its
 * own response before the next assertion or reload.
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const copy = en.settings.workspaceAddress;
const PASSWORD = 'Sup3rSecret!Pass';
const BASE = 'motir.e2e';
const OWNER_IMPORTED = 'eligibility-imported@motir.test';
const OWNER_MOTIR = 'eligibility-motir@motir.test';
const OWNER_HELD = 'eligibility-held@motir.test';
const CONTROL = '/settings/workspace/public-address';
const INELIGIBLE = 'SUBDOMAIN_REQUIRES_MOTIR_REPOSITORY';
const HOUR_MS = 60 * 60 * 1000;

let workspaceImported = '';
let workspaceHeld = '';
let heldRepositoryId = '';

/** ICU `{name}` placeholders, filled as next-intl fills them. */
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? `{${k}}`);

const pathOf = (r: Response) => new URL(r.url()).pathname;
const subdomainWrite = (page: Page, method: 'PUT' | 'DELETE') =>
  page.waitForResponse(
    (r) => pathOf(r).endsWith('/public-subdomain') && r.request().method() === method,
  );
const previewRead = (page: Page) =>
  page.waitForResponse(
    (r) => pathOf(r).endsWith('/public-subdomain/preview') && r.request().method() === 'GET',
  );
const main = (page: Page) => page.getByRole('main');
const nameField = (page: Page, label = copy.field.label) =>
  main(page).getByRole('textbox', { name: label });
const dialog = (page: Page) => page.getByRole('alertdialog');
const reason = (page: Page) => main(page).getByTestId('address-reason');

async function seedOwner(
  email: string,
  name: string,
  workspaceName: string,
  key: string,
  repository: Omit<Parameters<typeof seedMotirRepository>[0], 'workspaceId' | 'projectId'>,
) {
  const owner = await usersService.createUser({ email, password: PASSWORD, name });
  const { workspace } = await workspacesService.createWorkspace({
    name: workspaceName,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: `${workspaceName} roadmap`,
    identifier: key,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await adminDb.project.update({ where: { id: project.id }, data: projectAccessData('public') });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  const repo = await seedMotirRepository({
    workspaceId: workspace.id,
    projectId: project.id,
    ...repository,
  });
  return { owner, workspace, project, repo };
}

test.beforeAll(async () => {
  await resetDatabase();

  // Imported: its one repository was connected from the organisation.
  const imported = await seedOwner(OWNER_IMPORTED, 'Ida Importer', 'Umbrella', 'UMBR', {
    name: 'umbrella-api',
    seedSource: 'organization',
    state: 'connected',
  });
  workspaceImported = imported.workspace.id;

  // Motir: a repository Motir created, never transferred.
  await seedOwner(OWNER_MOTIR, 'Max Motir', 'Hooli', 'HOOLI', { name: 'hooli-web' });

  // Held: the same Motir repository, plus `stark` taken more than a day ago
  // (built from GRACE_HOURS) with no change on its ledger, so a release is
  // allowed and the name is held afterwards. Written as the row a claim
  // writes: the base domain is the SERVER's environment, not this process's.
  const held = await seedOwner(OWNER_HELD, 'Hal Holder', 'Stark', 'STARK', { name: 'stark-web' });
  workspaceHeld = held.workspace.id;
  heldRepositoryId = held.repo.id;
  await adminDb.publicAddress.create({
    data: {
      workspaceId: held.workspace.id,
      hostname: `stark.${BASE}`,
      kind: 'workspace_subdomain',
      status: 'active',
      createdAt: new Date(Date.now() - (GRACE_HOURS + 1) * HOUR_MS),
    },
  });
});

test('only a workspace with a Motir repository may claim or rename its motir.site name', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-11283');

  await chapter('An imported-only workspace is told why it has no name', async () => {
    await signIn(page, OWNER_IMPORTED, PASSWORD);
    await page.goto(CONTROL);
    await expect(page.getByRole('heading', { name: copy.title, level: 1 })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(reason(page).getByText(copy.ineligible.title)).toBeVisible();
    await expect(reason(page).getByText(fill(copy.ineligible.body, { base: BASE }))).toBeVisible();
    await expect(main(page).getByRole('textbox')).toHaveCount(0);
    await expect(main(page).getByRole('button', { name: copy.claim })).toHaveCount(0);
    await beat();
  });

  await chapter('A claim sent from that session anyway is refused', async () => {
    const res = await page.request.put(`/api/workspaces/${workspaceImported}/public-subdomain`, {
      data: { label: 'umbrella' },
    });
    expect(res.status(), await res.text()).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(INELIGIBLE);

    await page.reload();
    await expect(reason(page).getByText(copy.ineligible.title)).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(main(page).getByText(`umbrella.${BASE}`)).toHaveCount(0);
    await expect(main(page).getByRole('button', { name: copy.row.copy })).toHaveCount(0);
    await beat();
  });

  await chapter('A workspace with a Motir repository sees today’s pane', async () => {
    await signIn(page, OWNER_MOTIR, PASSWORD);
    await page.goto(CONTROL);
    await expect(nameField(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(main(page).getByRole('button', { name: copy.claim })).toBeVisible();
    await expect(reason(page)).toHaveCount(0);
    await expect(main(page).getByText(copy.ineligible.title)).toHaveCount(0);
    await beat();
  });

  await chapter('It claims a name', async () => {
    await nameField(page).fill('hooli');
    await beat();
    const claimed = subdomainWrite(page, 'PUT');
    await page.getByRole('button', { name: copy.claim }).click();
    const res = await claimed;
    expect(res.status(), await res.text()).toBe(201);

    await expect(main(page).getByText(`hooli.${BASE}`, { exact: true })).toBeVisible();
    await expect(main(page).getByText(copy.row.live, { exact: true })).toBeVisible();
    await beat();
  });

  await chapter('It renames through the dated confirm', async () => {
    await page.getByRole('button', { name: copy.rename, exact: true }).click();
    await nameField(page, copy.field.renameLabel).fill('hooli-xyz');
    const previewed = previewRead(page);
    await page.getByRole('button', { name: copy.review }).click();
    const preview = await previewed;
    expect(preview.status(), await preview.text()).toBe(200);

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByText(`hooli.${BASE} stops answering now.`)).toBeVisible();
    await beat();

    const renamed = subdomainWrite(page, 'PUT');
    await dialog(page).getByRole('button', { name: copy.confirm.rename }).click();
    const res = await renamed;
    expect(res.status(), await res.text()).toBe(200);
    expect(((await res.json()) as { hostname: string }).hostname).toBe(`hooli-xyz.${BASE}`);

    await expect(main(page).getByText(`hooli-xyz.${BASE}`, { exact: true })).toBeVisible();
    await expect(main(page).getByText(`hooli.${BASE}`, { exact: true })).toHaveCount(0);
    await beat();
  });

  await chapter('A held name, while its workspace still has a Motir repository', async () => {
    await signIn(page, OWNER_HELD, PASSWORD);
    await page.goto(CONTROL);
    await expect(main(page).getByText(`stark.${BASE}`, { exact: true })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(page.getByRole('button', { name: copy.rename, exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: copy.release, exact: true })).toBeEnabled();
    await expect(reason(page)).toHaveCount(0);
    await beat();
  });

  await chapter('Its repository is transferred out: the name stays, Rename goes', async () => {
    await adminDb.projectRepo.update({
      where: { id: heldRepositoryId },
      data: { takeoverState: 'done' },
    });
    await page.reload();

    await expect(main(page).getByText(`stark.${BASE}`, { exact: true })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(page.getByRole('button', { name: copy.release, exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: copy.rename, exact: true })).toHaveCount(0);
    await expect(main(page).getByRole('textbox')).toHaveCount(0);
    await expect(reason(page).getByText(copy.ineligible.heldTitle)).toBeVisible();
    await expect(
      reason(page).getByText(fill(copy.ineligible.heldBody, { host: `stark.${BASE}` })),
    ).toBeVisible();
    await beat();
  });

  await chapter('A rename sent from that session anyway is refused', async () => {
    const res = await page.request.put(`/api/workspaces/${workspaceHeld}/public-subdomain`, {
      data: { label: 'stark-industries' },
    });
    expect(res.status(), await res.text()).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(INELIGIBLE);

    await page.reload();
    await expect(main(page).getByText(`stark.${BASE}`, { exact: true })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(main(page).getByText(`stark-industries.${BASE}`)).toHaveCount(0);
    await beat();
  });

  await chapter('It can still release the name, and is told it cannot claim another', async () => {
    const previewed = previewRead(page);
    await page.getByRole('button', { name: copy.release, exact: true }).click();
    const preview = await previewed;
    expect(preview.status(), await preview.text()).toBe(200);

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByText(`stark.${BASE} stops answering now.`)).toBeVisible();
    await expect(dialog(page).getByText(copy.confirm.lockAfterReleaseIneligible)).toBeVisible();
    await expect(dialog(page).getByText(copy.confirm.lockAfterRelease)).toHaveCount(0);
    await beat();

    const released = subdomainWrite(page, 'DELETE');
    await dialog(page).getByRole('button', { name: copy.confirm.release }).click();
    const res = await released;
    expect(res.status(), await res.text()).toBe(200);

    await expect(main(page).getByText(/^stark\.motir\.e2e was released\./)).toBeVisible();
    await expect(main(page).getByRole('button', { name: copy.row.copy })).toHaveCount(0);
    await expect(main(page).getByText(`stark.${BASE}`, { exact: true })).toHaveCount(0);
    await expect(reason(page).getByText(copy.ineligible.title)).toBeVisible();
    await expect(main(page).getByRole('textbox')).toHaveCount(0);
    await beat();
  });
});
