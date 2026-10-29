import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { openUndecidedPlan } from './_helpers/open-undecided-plan';
import { E2E_PROVISIONING_ORG } from './_helpers/github-const';
import {
  githubJournal,
  repoCreates,
  resetGithubFixture,
  seedRepositorySet,
  setGithubControl,
  type RepositorySetSeed,
} from './_helpers/repository-set-seed';
import {
  applyHostingDecision,
  proposeHostedWebRow,
  repoRowId,
  resetSeedRegistry,
  type HostingDecision,
} from './_helpers/seed-registry-seed';
import {
  SEED_SOURCE_AWS_STARTER,
  SEED_SOURCE_EXPO_MOBILE_FOUNDATION,
  SEED_SOURCE_FLY_STARTER,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-704 — every repository Motir creates starts from the starter that
 * fits it, walked as the story's acceptance receipt (MOTIR-6415).
 *
 * One owner, one plan whose architecture needs a web app and a mobile app:
 *
 *  1. The plan is approved and the Repositories room shows both rows, each
 *     seeded from its role's foundation — the web row from the serverless
 *     starter and the mobile row from the Expo foundation, both marked Default
 *     because the plan named no hosting and no stack.
 *  2. The person re-points the mobile row to an initialised repository and back
 *     again, through the row's Starter picker.
 *  3. A hosting decision puts the web row on Fly: the row now starts from the
 *     Fly starter as a MATCH (no Default), with the Fly target pill.
 *  4. The picker offers only what may deploy to Fly — not the serverless or the
 *     AWS starter — and a PATCH forced past the picker is refused, naming the rule.
 *  5. Continue: both repositories are created, each from its own template, and
 *     the room keeps the seed and target pills on the created rows.
 *  6. The owner, made a platform operator, promotes the Fly repository from
 *     `/admin/starters` into a starter of its own.
 *  7. The next web row on Fly is proposed the promoted starter, the newest of the
 *     two that fit it.
 *  8. The operator retires it: the library says Retired, the picker stops
 *     offering it, and a re-point to it is refused.
 *  9. Without the platform role, the library and its writes are not found.
 *
 * Two hand-offs are reached through services rather than a surface, because no
 * surface ships them yet: the hosting decision that writes a row's target
 * (`seed-registry-seed.ts` names why), and the "next plan" of chapter 7, which is
 * that decision applied to a new web row. Everything after each hand-off is
 * walked through the product.
 *
 * GitHub is the in-server fake (`lib/test-github-repos-mock.ts`): no repository is
 * created, and the journal is the evidence of what GitHub was asked. Every wait is
 * on a write's own response or on a server-rendered row.
 */

const seedCopy = enMessages.repositorySet.seed;
const starters = enMessages.platformAdmin.starters;
const promoteCopy = starters.promoteForm;

test.describe.configure({ timeout: 600_000 });

/** The Fly starter's own `motir.hosting.json` (`tests/fixtures/hosting-manifests`). */
const FLY_MANIFEST = readFileSync(
  join(__dirname, '../fixtures/hosting-manifests/fly.json'),
  'utf8',
);

/** The hosting decision this walk makes for a web app: an MVP, small, on Fly. */
const ON_FLY: HostingDecision = { target: 'fly', useCase: 'mvp', size: 'small', stack: 'nextjs' };

const PROMOTED_KEY = 'nextjs-fly-acme-booking';
const PROMOTED_LABEL = 'Next.js · Fly (Acme Booking)';

const LABEL = {
  serverless: 'Next.js · serverless',
  fly: 'Next.js · Fly',
  aws: 'Next.js · AWS',
  expo: 'Expo · mobile',
  initialised: 'Initialised repository',
} as const;

const main = (page: Page): Locator => page.getByRole('main');

/** One row of the room, by the repository's name. */
const roomRow = (page: Page, name: string): Locator =>
  main(page).locator('[data-testid^="takeover-row-"]').filter({ hasText: name });

const starterPill = (row: Locator, label: string): Locator =>
  row.getByLabel(seedCopy.starterPillLabel.replace('{label}', label), { exact: true });

const targetPill = (row: Locator, target: string): Locator =>
  row.getByLabel(seedCopy.targetPillLabel.replace('{target}', target), { exact: true });

const defaultPill = (row: Locator): Locator => row.getByText(seedCopy.default, { exact: true });

const picker = (page: Page, rowId: string): Locator => page.locator(`#starter-${rowId}`);

async function openRoom(page: Page): Promise<void> {
  expect((await page.goto('/settings/project/repositories'))?.status()).toBe(200);
}

/** Every starter label this walk can meet, longest first so a label that
 *  extends another (the promoted Fly starter) is read as itself. */
const KNOWN_LABELS = [PROMOTED_LABEL, ...Object.values(LABEL)].sort((a, b) => b.length - a.length);

/** The starters the row's Starter picker offers, by label, in the order shown.
 *  An option's text is its label followed by what it serves, so each is read as
 *  the known label it starts with. Leaves the picker closed. */
async function offered(page: Page, rowId: string): Promise<string[]> {
  await picker(page, rowId).click();
  await expect(page.getByRole('listbox')).toBeVisible();
  const texts = await page
    .getByRole('option')
    .evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  return texts.map((text) => KNOWN_LABELS.find((label) => text.startsWith(label)) ?? text);
}

/** Pick `label` in the row's Starter picker and wait for the PATCH it sends. */
async function repoint(page: Page, rowId: string, label: string): Promise<void> {
  await picker(page, rowId).click();
  const patched = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' &&
      new RegExp(`/repositories/${rowId}$`).test(new URL(r.url()).pathname),
  );
  await page.getByRole('option', { name: new RegExp(`^${escape(label)}`) }).click();
  expect((await patched).status(), `the re-point to ${label} was accepted`).toBe(200);
}

/** A re-point sent straight to the route, past the picker. */
async function forcedRepoint(
  page: Page,
  seed: RepositorySetSeed,
  rowId: string,
  seedSource: string,
): Promise<{ status: number; refusal: unknown }> {
  const res = await page.request.patch(
    `/api/projects/${encodeURIComponent(seed.projectKey)}/repositories/${encodeURIComponent(rowId)}`,
    { data: { seedSource } },
  );
  const body = (await res.json().catch(() => null)) as { refusal?: unknown } | null;
  return { status: res.status(), refusal: body?.refusal ?? null };
}

/** Tick one box of a promote-form check group. A box's accessible name is its
 *  label followed by its state (`MVP, not selected`), so it is matched by prefix
 *  inside the group its legend names. */
async function tick(form: Locator, legend: string, label: string): Promise<void> {
  const box = form
    .getByRole('group', { name: legend })
    .getByRole('checkbox', { name: new RegExp(`^${escape(label)},`) });
  await box.click();
  await expect(box).toHaveAttribute('aria-checked', 'true');
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function approvePlan(page: Page, seed: RepositorySetSeed): Promise<void> {
  const overlay = await openUndecidedPlan(page, seed.planId);
  const approve = overlay
    .getByTestId('plan-change-confirm-bar')
    .getByRole('button', { name: 'Approve', exact: true });
  await expect(approve).toBeVisible();
  const approved = page.waitForResponse(
    (r) => /\/api\/plans\/[^/]+\/approve/.test(r.url()) && r.request().method() === 'POST',
  );
  await approve.click();
  expect((await approved).status(), 'the approve write succeeded').toBe(200);
}

/** The `owner/repo` each template create generated from, in order. */
function generatedFrom(): string[] {
  return repoCreates()
    .map((c) => /^\/repos\/([^/]+\/[^/]+)\/generate$/.exec(c.path)?.[1])
    .filter((slug): slug is string => slug !== undefined);
}

test.beforeEach(async () => {
  await resetDatabase();
  resetGithubFixture();
  await resetSeedRegistry();
});

test.afterEach(async () => {
  // The registry outlives the tenant: put the shipped six back for every later spec.
  await resetSeedRegistry();
});

test('a repository starts from the starter that fits it, and an operator grows the library', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-704');

  const seed = await seedRepositorySet('e2e-seeds@example.com', 'Acme Booking', 'ASR', {
    roles: ['web', 'mobile'],
    withInstallation: true,
    withIdentity: true,
  });
  const webName = seed.webRepoName;
  const mobileName = `${seed.projectSlug}-mobile`;
  await signIn(page, seed.email, seed.password);

  await chapter('The plan is approved: each repository starts from its foundation', async () => {
    await approvePlan(page, seed);
    await openRoom(page);
    const web = roomRow(page, webName);
    const mobile = roomRow(page, mobileName);
    await expect(web).toBeVisible();
    await expect(mobile).toBeVisible();

    await expect(starterPill(web, LABEL.serverless)).toBeVisible();
    await expect(defaultPill(web)).toBeVisible();
    await expect(web.getByText(seedCopy.noTarget, { exact: true })).toBeVisible();
    await expect(web.locator('[data-testid^="seed-why-"]')).toHaveAttribute(
      'data-why',
      'no_target',
    );

    await expect(starterPill(mobile, LABEL.expo)).toBeVisible();
    await expect(mobile.getByText(seedCopy.noTarget, { exact: true })).toHaveCount(0);
    await beat();
  });

  const webId = await repoRowId(seed, webName);
  const mobileId = await repoRowId(seed, mobileName);

  await chapter('The person re-points the mobile repository, and back', async () => {
    const mobile = roomRow(page, mobileName);
    expect(await offered(page, mobileId)).toEqual([LABEL.expo, LABEL.initialised]);

    await repoint(page, mobileId, LABEL.initialised);
    await expect(starterPill(mobile, LABEL.initialised)).toBeVisible();
    await expect(defaultPill(mobile)).toHaveCount(0);
    await beat();

    await repoint(page, mobileId, LABEL.expo);
    await expect(starterPill(mobile, LABEL.expo)).toBeVisible();
    await expect(mobile.locator('[data-testid^="seed-why-"]')).toHaveAttribute(
      'data-why',
      'by_hand',
    );
    await beat();
  });

  await chapter('A hosting decision puts the web app on Fly: the Fly starter matches', async () => {
    expect(await applyHostingDecision(seed, webId, ON_FLY)).toBe(SEED_SOURCE_FLY_STARTER);
    await openRoom(page);
    const web = roomRow(page, webName);
    await expect(starterPill(web, LABEL.fly)).toBeVisible();
    await expect(targetPill(web, seedCopy.target.fly)).toBeVisible();
    await expect(defaultPill(web)).toHaveCount(0);
    await expect(web.locator('[data-testid^="seed-why-"]')).toHaveAttribute('data-why', 'matched');
    await beat();
  });

  await chapter('Only what deploys to Fly is offered, and nothing else is accepted', async () => {
    const options = await offered(page, webId);
    expect(options).toEqual([LABEL.fly, LABEL.initialised]);
    expect(options).not.toContain(LABEL.serverless);
    expect(options).not.toContain(LABEL.aws);

    for (const key of [SEED_SOURCE_PLATFORM_STARTER, SEED_SOURCE_AWS_STARTER]) {
      expect(await forcedRepoint(page, seed, webId, key)).toEqual({
        status: 422,
        refusal: 'target_mismatch',
      });
    }
    await openRoom(page);
    await expect(starterPill(roomRow(page, webName), LABEL.fly)).toBeVisible();
    await beat();
  });

  await chapter('Continue: both repositories are created, each from its own starter', async () => {
    await page.goto(`/plans/${seed.planId}`); // decided: the plan page renders
    await expect(page.getByRole('heading', { name: 'Motir will host your code' })).toBeVisible();
    const established = page.waitForResponse(
      (r) => /\/repositories\/establish$/.test(r.url()) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Continue' }).click();
    expect((await established).status(), 'the establish run committed').toBe(200);
    await expect(main(page).getByTestId('repo-setup-status')).toHaveText(
      enMessages.repositorySet.ready,
      {
        timeout: 60_000,
      },
    );

    expect(generatedFrom().sort()).toEqual(
      [
        `motir-co/${SEED_SOURCE_EXPO_MOBILE_FOUNDATION}`,
        `motir-co/${SEED_SOURCE_FLY_STARTER}`,
      ].sort(),
    );

    await openRoom(page);
    const web = roomRow(page, webName);
    const mobile = roomRow(page, mobileName);
    await expect(
      web.getByText(enMessages.repositorySet.stateCreated, { exact: true }),
    ).toBeVisible();
    await expect(starterPill(web, LABEL.fly)).toBeVisible();
    await expect(targetPill(web, seedCopy.target.fly)).toBeVisible();
    await expect(starterPill(mobile, LABEL.expo)).toBeVisible();
    await expect(picker(page, webId)).toHaveCount(0);

    expect(await forcedRepoint(page, seed, webId, SEED_SOURCE_PLATFORM_STARTER)).toEqual({
      status: 409,
      refusal: 'not_editable',
    });
    await beat();
  });

  // The Fly repository's tree, as the fake GitHub serves it to a promotion.
  setGithubControl({
    files: {
      [webName]: {
        'motir.hosting.json': FLY_MANIFEST,
        'README.md': '# Acme Booking\n',
      },
    },
  });
  await adminDb.user.update({ where: { email: seed.email }, data: { platformRole: 'operator' } });

  await chapter('An operator promotes the Fly repository into a starter', async () => {
    expect((await page.goto('/admin/starters'))?.status()).toBe(200);
    const table = main(page).getByTestId('starters-table');
    await expect(table.locator('[data-testid^="starter-row-"]')).toHaveCount(6);
    await main(page).getByRole('link', { name: starters.promote }).click();
    await expect(main(page).getByRole('heading', { name: promoteCopy.title })).toBeVisible();

    const form = main(page).getByTestId('promote-form');
    await form.getByRole('combobox', { name: promoteCopy.field.source, exact: true }).click();
    await page
      .getByRole('option', { name: new RegExp(`^${escape(`${E2E_PROVISIONING_ORG}/${webName}`)}`) })
      .click();
    await form.getByRole('textbox', { name: promoteCopy.field.ref, exact: true }).fill('main');
    await form.getByRole('combobox', { name: promoteCopy.field.role, exact: true }).click();
    await page.getByRole('option', { name: 'web', exact: true }).click();
    await form.getByRole('textbox', { name: promoteCopy.field.stack, exact: true }).fill('nextjs');
    await form
      .getByRole('textbox', { name: promoteCopy.field.label, exact: true })
      .fill(PROMOTED_LABEL);
    await form
      .getByRole('textbox', { name: promoteCopy.field.key, exact: true })
      .fill(PROMOTED_KEY);
    await tick(form, promoteCopy.field.uses, seedCopy.use.mvp);
    await tick(form, promoteCopy.field.sizes, seedCopy.size.small);
    await tick(form, promoteCopy.field.targets, seedCopy.target.fly);
    await form
      .getByRole('textbox', { name: promoteCopy.field.reason, exact: true })
      .fill('Acme Booking’s Fly app is the shape our MVPs keep asking for.');
    await beat();

    await form.getByTestId('promote-review').click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByTestId('promote-confirm-facts')).toContainText(seedCopy.target.fly);
    const promoted = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/platform/seed-registry/promote') && r.request().method() === 'POST',
    );
    await confirm.getByTestId('promote-confirm').click();
    expect((await promoted).status(), 'the promotion committed').toBe(200);

    await expect(page).toHaveURL(/\/admin\/starters\?promoted=/);
    const row = main(page).getByTestId(`starter-row-${PROMOTED_KEY}`);
    await expect(row).toContainText(PROMOTED_LABEL);
    await expect(row).toContainText(starters.status.active);
    await expect(row).toContainText(`${E2E_PROVISIONING_ORG}/${webName}`);
    await beat();

    // GitHub was asked to make the copy, mark it a template, and nothing else of
    // the source: the copy is a new private repository named by the key.
    const copy = repoCreates().find((c) => c.body?.['name'] === PROMOTED_KEY);
    expect(copy?.path).toBe(`/orgs/${E2E_PROVISIONING_ORG}/repos`);
    expect(copy?.body?.['private']).toBe(true);
    const marked = githubJournal().find(
      (c) => c.method === 'PATCH' && c.path === `/repos/${E2E_PROVISIONING_ORG}/${PROMOTED_KEY}`,
    );
    expect(marked?.body?.['is_template']).toBe(true);
  });

  const siteName = `${seed.projectSlug}-site`;
  let siteId = '';

  await chapter('The next web app on Fly is proposed the promoted starter', async () => {
    const proposed = await proposeHostedWebRow(seed, siteName, ON_FLY);
    expect(proposed.seedSource).toBe(PROMOTED_KEY);
    siteId = proposed.rowId;

    await openRoom(page);
    const site = roomRow(page, siteName);
    await expect(starterPill(site, PROMOTED_LABEL)).toBeVisible();
    await expect(targetPill(site, seedCopy.target.fly)).toBeVisible();
    await expect(defaultPill(site)).toHaveCount(0);
    expect(await offered(page, siteId)).toEqual(
      expect.arrayContaining([PROMOTED_LABEL, LABEL.fly, LABEL.initialised]),
    );
    await beat();
  });

  await chapter('Retired: the library says so, and the picker stops offering it', async () => {
    expect((await page.goto('/admin/starters'))?.status()).toBe(200);
    const row = main(page).getByTestId(`starter-row-${PROMOTED_KEY}`);
    await row.getByTestId(`retire-${PROMOTED_KEY}`).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByTestId('retire-reason').fill('Superseded by the shipped Fly starter.');
    const retired = page.waitForResponse((r) =>
      /\/api\/platform\/seed-registry\/[^/]+\/retire$/.test(r.url()),
    );
    await dialog.getByTestId('retire-confirm').click();
    expect((await retired).status(), 'the retirement committed').toBe(200);
    // The default view lists Active entries only, so a retired one leaves it;
    // the Retired view is where the library says what happened to it.
    await expect(dialog).toBeHidden();
    expect((await page.goto('/admin/starters?status=retired'))?.status()).toBe(200);
    await expect(row).toContainText(starters.status.retired);
    await beat();

    await openRoom(page);
    const options = await offered(page, siteId);
    expect(options).toEqual([LABEL.fly, LABEL.initialised]);
    expect(await forcedRepoint(page, seed, siteId, PROMOTED_KEY)).toEqual({
      status: 422,
      refusal: 'retired',
    });
    await repoint(page, siteId, LABEL.fly);
    await expect(starterPill(roomRow(page, siteName), LABEL.fly)).toBeVisible();
    await beat();
  });

  await adminDb.user.update({ where: { email: seed.email }, data: { platformRole: null } });

  await chapter('Without the platform role, the library is not there', async () => {
    expect((await page.goto('/admin/starters'))?.status()).toBe(404);
    const promote = await page.request.post('/api/platform/seed-registry/promote', {
      data: { sourceRowId: webId, ref: 'main', key: 'nope', reason: 'not staff' },
    });
    expect(promote.status()).toBe(404);
    const retire = await page.request.post(
      `/api/platform/seed-registry/${SEED_SOURCE_FLY_STARTER}/retire`,
      { data: { reason: 'not staff' } },
    );
    expect(retire.status()).toBe(404);
    await beat();
  });
});
