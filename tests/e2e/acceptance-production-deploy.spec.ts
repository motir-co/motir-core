// Acceptance E2E — a merge reaches production, and an administrator rolls it back (Story
// MOTIR-9797 · Subtask MOTIR-10040).
//
// THE RECORDED WALK (one test, chaptered, in the card's fixed order): an administrator opens the
// Production room of a repository Motir hosts and finds it empty; a first merge arrives and its
// release reads Building with no address, then Live with its address, Copy and the merge trigger;
// a second merge goes live and the first reads Replaced; Roll back names the release it leaves and
// the one it returns to and says the schema stays, Cancel changes nothing, and confirming makes
// the earlier release live again, the newer one Rolled back, and the live card "Restored by
// rollback · Ada Admin". Then a member reads the same room with no Roll back in the page, a
// repository with one release offers Roll back disabled with its reason, a customer repository is
// neither offered nor addressable (404), and a failed build lands in history while the live card
// keeps the earlier release.
//
// THE RECEIPT IS CI's. This repository's acceptance lane carries
// `./.github/actions/upload-acceptance-video` (`.github/workflows/acceptance-tests.yml`), so a green
// pull-request run publishes this walk as MOTIR-9797's acceptance video; no MCP publish is made.
//
// ── What is real ────────────────────────────────────────────────────────────
// Everything from the webhook down: each merge is GitHub's signed `workflow_run` completed for the
// `production-image` workflow, POSTed to `/api/github/webhook`; the merge-release JOB runs in the
// lane's job worker — the manifest read, the production database, the migration, the deploy, the
// GitHub deployment status — and the rollback runs in the webServer through the panel's own route.
// The deploy and database ports are their FAKES, and the worker's GitHub calls are the seam in
// `lib/test-production-release-mock.ts`. The hosting fake's cross-process store is what lets the
// webServer roll back the release the worker made live; its HOLD sidecar is how this spec keeps a
// deploy (and a rollback) in flight for as long as the screen needs to show it. The seed builds the
// actors and the three repositories through the real services (`production-seed.ts`) and switches
// production on as enablement records it; no release is seeded.
//
// DETERMINISM (the coding convention § E2E): every merge awaits the webhook's 200, which the route
// answers only after the release job is enqueued; every state the JOB ENGINE makes is awaited with
// `expect.poll` over the release rows, the authoritative read, before the page is loaded to show
// it; every page load awaits its document response; the rollback arms `page.waitForResponse` for
// its POST before the click and awaits its 200. The room is a server read with no live update, so
// "watching" is a reload once the rows say the state changed. `beat()` / `chapter()` are pacing
// only. No `waitForTimeout`.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  commit,
  deliverMerge,
  holdHosting,
  releaseHosting,
  releasesOf,
  seedProductionRoom,
  type ProductionRepo,
  type ProductionSeed,
} from './_helpers/production-seed';
import en from '@/messages/en.json';

const t = en.settings.production;
const ROOM = '/settings/project/production';
const FIRST = commit(1);
const SECOND = commit(2);
const ONLY = commit(3);
const BROKEN = commit(4);
const short = (sha: string) => sha.slice(0, 7);

// The recorded walk is paced for the video and waits on a job engine; it runs a few minutes.
test.describe.configure({ timeout: 360_000 });

let seed: ProductionSeed;

test.beforeEach(async () => {
  await resetDatabase();
  releaseHosting();
  seed = await seedProductionRoom(`${Date.now()}`);
});

test.afterEach(() => {
  // A failed step must not leave a deploy held for the next spec's releases.
  releaseHosting();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── The room ──────────────────────────────────────────────────────────────────

/** The panel, scoped to the page's main region. */
const panel = (page: Page): Locator => page.getByRole('main').getByTestId('production-panel');
const currentCard = (page: Page) => panel(page).getByTestId('production-current-release');
const historyRows = (page: Page) => panel(page).getByTestId('production-release-row');
const rollbackButton = (page: Page) =>
  panel(page).getByRole('button', { name: t.rollback.action, exact: true });

/** Open the room on a repository and wait for its document. */
async function openRoom(page: Page, repo: ProductionRepo): Promise<void> {
  const res = await page.goto(`${ROOM}?repository=${repo.id}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: t.title })).toBeVisible();
  await expect(page.getByRole('main').getByTestId('production-panel-header')).toHaveText(repo.name);
  await expect(panel(page)).toBeVisible();
}

/** The history's rows as `[short commit, state word]`, top to bottom. */
async function history(page: Page): Promise<Array<[string, string]>> {
  const rows = await historyRows(page).all();
  return Promise.all(
    rows.map(
      async (row) =>
        [
          (await row.locator('code').textContent()) ?? '',
          (await row.getAttribute('data-state')) ?? '',
        ] as [string, string],
    ),
  );
}

/** Deliver a merge and wait until the job engine has the release in `state`. */
async function merge(
  page: Page,
  repo: ProductionRepo,
  sha: string,
  state: 'releasing' | 'live' | 'failed',
  conclusion: 'success' | 'failure' = 'success',
): Promise<void> {
  expect(await deliverMerge(page.request, repo, sha, conclusion)).toBe(200);
  await expect
    .poll(async () => (await releasesOf(repo)).find((r) => r.commit === sha)?.state ?? null, {
      timeout: 60_000,
    })
    .toBe(state);
}

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('a merge goes live in production and an administrator rolls it back; a member reads it, a customer repository has no room', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9797');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, seed.adminEmail, seed.password);

  await chapter('Production of a repository Motir hosts, before any merge', async () => {
    await openRoom(page, seed.web);
    const empty = panel(page).getByTestId('production-empty-state');
    await expect(empty).toContainText(t.empty.title);
    await expect(empty).toContainText(t.empty.body);
    await expect(currentCard(page)).toHaveCount(0);
    await expect(panel(page).getByTestId('production-release-history')).toHaveCount(0);
    await expect(panel(page).getByTestId('production-address')).toHaveCount(0);
    await expect(rollbackButton(page)).toHaveCount(0);
    await beat();
  });

  await chapter('A first merge into main: building, with no address yet', async () => {
    // The deploy waits at the fake provider until this spec lets it go, so the
    // release stays in flight while the room shows it.
    holdHosting('deploy');
    await merge(page, seed.web, FIRST, 'releasing');
    await openRoom(page, seed.web);
    expect(await history(page)).toEqual([[short(FIRST), 'building']]);
    const row = historyRows(page).first();
    await expect(row.getByTestId('production-state-pill')).toHaveText(t.state.building);
    await expect(row.getByTestId('production-trigger')).toHaveText(t.trigger.mergeDefault);
    // Nothing serves yet: no live card, no address, no Roll back.
    await expect(panel(page).getByTestId('production-empty-state')).toBeVisible();
    await expect(panel(page)).not.toContainText(seed.web.address!);
    await expect(rollbackButton(page)).toHaveCount(0);
    await beat();
  });

  await chapter('The release goes live, at its production address', async () => {
    releaseHosting();
    await expect
      .poll(async () => (await releasesOf(seed.web))[0]?.state, { timeout: 60_000 })
      .toBe('live');
    await openRoom(page, seed.web);
    const card = currentCard(page);
    await expect(card).toContainText(short(FIRST));
    await expect(card.getByTestId('production-state-pill')).toHaveText(t.state.live);
    await expect(card.getByTestId('production-trigger')).toHaveText(t.trigger.mergeDefault);
    const address = card.getByTestId('production-address');
    await expect(address).toContainText(seed.web.address!);
    await expect(address).toHaveAttribute('href', `https://${seed.web.address}`);
    await expect(address).toHaveAttribute('target', '_blank');
    // One release: Roll back is shown to an administrator, disabled with its reason.
    await expect(rollbackButton(page)).toBeDisabled();
    await expect(card.getByTestId('production-rollback-helper')).toHaveText(t.rollback.unavailable);
    await beat();

    const copy = card.getByRole('button', { name: `Copy ${seed.web.address}` });
    await copy.click();
    await expect(copy).toHaveText(t.address.copied);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(seed.web.address);
    await beat();
  });

  await chapter('A second merge goes live; the first reads Replaced', async () => {
    await merge(page, seed.web, SECOND, 'live');
    await openRoom(page, seed.web);
    await expect(currentCard(page)).toContainText(short(SECOND));
    await expect(currentCard(page).getByTestId('production-state-pill')).toHaveText(t.state.live);
    // Newest first, and only the live row carries the address.
    expect(await history(page)).toEqual([
      [short(SECOND), 'live'],
      [short(FIRST), 'replaced'],
    ]);
    await expect(historyRows(page).nth(1)).not.toContainText(seed.web.address!);
    await expect(historyRows(page).nth(0)).toContainText(seed.web.address!);
    await expect(rollbackButton(page)).toBeEnabled();
    await expect(currentCard(page).getByTestId('production-rollback-helper')).toHaveText(
      t.rollback.helper,
    );
    await beat();
  });

  const dialog = page.getByRole('alertdialog', {
    name: t.dialog.title.replace('{repository}', seed.web.name),
  });

  await chapter('Roll back names both releases; Cancel changes nothing', async () => {
    await rollbackButton(page).click();
    await expect(dialog).toBeVisible();
    const body = dialog.getByTestId('production-rollback-dialog');
    const leaving = body.locator('dt', { hasText: t.dialog.leaving }).locator('xpath=..');
    const returning = body.locator('dt', { hasText: t.dialog.returning }).locator('xpath=..');
    await expect(leaving.locator('code')).toHaveText(short(SECOND));
    await expect(returning.locator('code')).toHaveText(short(FIRST));
    await expect(leaving.locator('time')).toHaveAttribute('datetime', /.+/);
    await expect(returning.locator('time')).toHaveAttribute('datetime', /.+/);
    await expect(body).toContainText(t.dialog.body.replace('{address}', seed.web.address!));
    await expect(body).toContainText('The database schema is not reverted');
    await expect(dialog.getByRole('button', { name: t.dialog.confirm })).toBeEnabled();
    await beat();

    await dialog.getByRole('button', { name: t.dialog.cancel }).click();
    await expect(dialog).toHaveCount(0);
    expect(await releasesOf(seed.web)).toEqual([
      { commit: SECOND, state: 'live' },
      { commit: FIRST, state: 'replaced' },
    ]);
    await expect(currentCard(page)).toContainText(short(SECOND));
    await beat();
  });

  await chapter('Confirm: the earlier release is live again, restored by rollback', async () => {
    await rollbackButton(page).click();
    await expect(dialog).toBeVisible();
    // The provider's rollback waits until the busy state has been on screen.
    holdHosting('rollback');
    const rolledBack = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        new URL(res.url()).pathname.endsWith(`/repositories/${seed.web.id}/production/rollback`),
    );
    await dialog.getByRole('button', { name: t.dialog.confirm }).click();
    const submitting = dialog.getByRole('button', { name: t.dialog.submitting });
    await expect(submitting).toBeDisabled();
    await expect(dialog.getByTestId('production-rollback-dialog')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(dialog.getByRole('button', { name: t.dialog.cancel })).toBeDisabled();
    await beat();
    releaseHosting();
    expect((await rolledBack).status()).toBe(200);

    await expect(dialog).toHaveCount(0);
    const card = currentCard(page);
    await expect(card).toContainText(short(FIRST));
    await expect(card.getByTestId('production-state-pill')).toHaveText(t.state.live);
    await expect(card.getByTestId('production-trigger')).toHaveText(
      t.trigger.rollback.replace('{name}', seed.adminName),
    );
    await expect(card.getByTestId('production-address')).toContainText(seed.web.address!);
    expect(await history(page)).toEqual([
      [short(SECOND), 'rolledBack'],
      [short(FIRST), 'live'],
    ]);
    expect(await releasesOf(seed.web)).toEqual([
      { commit: SECOND, state: 'rolled_back' },
      { commit: FIRST, state: 'live' },
    ]);
    await beat();
  });

  await chapter('A member reads the same room, with no Roll back at all', async () => {
    await signIn(page, seed.memberEmail, seed.password);
    await openRoom(page, seed.web);
    const card = currentCard(page);
    await expect(card).toContainText(short(FIRST));
    await expect(card.getByTestId('production-state-pill')).toHaveText(t.state.live);
    await expect(card.getByTestId('production-address')).toContainText(seed.web.address!);
    expect(await history(page)).toEqual([
      [short(SECOND), 'rolledBack'],
      [short(FIRST), 'live'],
    ]);
    // Absent, not disabled — and the note says who can.
    await expect(panel(page).getByTestId('production-rollback')).toHaveCount(0);
    await expect(rollbackButton(page)).toHaveCount(0);
    await expect(panel(page).getByRole('note')).toHaveText(t.readOnly.note);
    await beat();
  });

  await chapter(
    'A repository with one release: Roll back is disabled, with its reason',
    async () => {
      await signIn(page, seed.adminEmail, seed.password);
      await merge(page, seed.api, ONLY, 'live');
      await openRoom(page, seed.api);
      await expect(currentCard(page)).toContainText(short(ONLY));
      await expect(currentCard(page).getByTestId('production-address')).toContainText(
        seed.api.address!,
      );
      await expect(rollbackButton(page)).toBeDisabled();
      await expect(rollbackButton(page)).toHaveAttribute(
        'aria-describedby',
        'production-rollback-helper',
      );
      await expect(currentCard(page).getByTestId('production-rollback-helper')).toHaveText(
        t.rollback.unavailable,
      );
      // The two Motir repositories' releases never cross.
      expect(await history(page)).toEqual([[short(ONLY), 'live']]);
      await beat();
    },
  );

  await chapter('A customer repository is not offered, and its address is not found', async () => {
    const picker = page.getByRole('main').getByRole('combobox', { name: t.repositoryLabel });
    await picker.click();
    const options = page.getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(page.getByRole('listbox')).toContainText(seed.web.name);
    await expect(page.getByRole('listbox')).toContainText(seed.api.name);
    await expect(page.getByRole('listbox')).not.toContainText(seed.customer.name);
    await page.keyboard.press('Escape');
    await beat();

    const res = await page.goto(`${ROOM}?repository=${seed.customer.id}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('main').getByTestId('production-not-found')).toContainText(
      t.notFound.title,
    );
    await expect(page.getByRole('main').getByTestId('production-panel')).toHaveCount(0);
    await expect(page.getByRole('link', { name: t.notFound.back })).toHaveAttribute('href', ROOM);
    expect(await releasesOf(seed.customer)).toEqual([]);
    await beat();
  });

  await chapter('A merge whose build failed changes nothing that is serving', async () => {
    await merge(page, seed.web, BROKEN, 'failed', 'failure');
    await openRoom(page, seed.web);
    const newest = historyRows(page).first();
    await expect(newest).toHaveAttribute('data-state', 'failed');
    await expect(newest.locator('code')).toHaveText(short(BROKEN));
    await expect(newest.getByTestId('production-state-pill')).toHaveText(t.state.failed);
    await expect(newest.getByTestId('production-failure-reason')).toHaveText(t.reason.build);
    await expect(newest).not.toContainText(seed.web.address!);
    await expect(panel(page).getByTestId('production-failed-newer-note')).toHaveText(
      t.failedNewer.replace('{commit}', short(FIRST)),
    );
    // The live card still shows the release the rollback restored.
    await expect(currentCard(page)).toContainText(short(FIRST));
    await expect(currentCard(page).getByTestId('production-state-pill')).toHaveText(t.state.live);
    expect((await releasesOf(seed.web)).map((r) => r.state)).toEqual([
      'failed',
      'rolled_back',
      'live',
    ]);
    await beat();
  });
});
