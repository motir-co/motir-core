import type { Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  openAgentSession,
  publishDesignResult,
  servePublishedMock,
} from './_helpers/design-approval-seed';
import {
  BABYSITTER_TITLES,
  seedDesignBabysitter,
  seedEarlierRevises,
  seedLastHostedRun,
  type DesignBabysitterSeed,
} from './_helpers/design-babysitter-seed';
import {
  fakeContainerCount,
  resetHostedRunJournal,
  writeHostedRunFixture,
} from './_helpers/hosted-run-boundary';
import { adminDb } from '@/tests/helpers/adminDb';
import en from '@/messages/en.json';

// DESIGN REVIEW WITHOUT A BABYSITTER — THE BROWSER PROOF (Story MOTIR-693 · MOTIR-6417;
// `docs/decisions/hosted-design-rerun-and-design-approval-switch.md`; design MOTIR-694).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// PART A — the owner turns design approval OFF on Settings → Approvals. A design result
// is then published, and nobody presses anything: the card reads Done, its record says
// "Approved automatically · Design approval is off for this project", and the card built
// on it reads "Ready to start".
//
// PART B — the switch is on. A design whose last run was HOSTED is sent back with a
// reason and Revise. Motir starts one hosted run on its own, the card says "Re-running on
// the hosted agent", and that run's prompt carries the reason. A card that has already
// been sent back three times says "Automatic re-run skipped" instead, and nothing starts.
//
// ── WHAT IS REAL, AND THE ONE BOUNDARY ──────────────────────────────────────
//
// The switch is the real card and route; the publishes are the real
// `publish_design_result` tool over `/api/mcp`; the Revise is the overlay's real server
// action; the re-run is the real `design/auto-rerun.requested` job in the lane's job
// worker, calling the real hosted start. What is NOT real is what this lane never
// reaches: no container boots (`MOTIR_FLEET_ORCHESTRATOR=fake`), and the gateway /
// motir-ai / GitHub answers come from `E2E_TEST_HOSTED_RUN=1`'s stub. "Dispatched" is
// therefore read as the fake fleet's container count, which moves only when a real start
// boots one.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: the PATCH's response, the server action's response,
// the persisted record (`expect.poll` on the row the job writes) before a reload, and
// the elements a person reads. `chapter()` / `beat()` only HOLD a state already proven.

test.describe.configure({ timeout: 300_000 });

const DEFAULT_MODEL = 'e2e-hosted-default';
const REASON = 'tighter spacing, the header is too loud';
const r = en.approvalGate.reason;
const rerun = en.approvalGate.autoRerun;
const record = en.approvalGate.record;

const main = (page: Page) => page.getByRole('main');
const designSection = (page: Page) =>
  main(page)
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: en.designResult.title }) });
const statusCard = (page: Page) =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });
const dialogFor = (page: Page, key: string) =>
  page.getByRole('dialog', { name: `${en.workbench.approvals.kind.design_result} for ${key}` });

const serverAction = (page: Page) =>
  page.waitForResponse(
    (res) => res.request().method() === 'POST' && Boolean(res.request().headers()['next-action']),
  );

async function publish(seed: DesignBabysitterSeed, baseURL: string): Promise<void> {
  const client = await openAgentSession(seed.token, baseURL);
  const published = await publishDesignResult(client, seed.designKey);
  expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
  await client.close();
}

async function latestDesignGateId(seed: DesignBabysitterSeed): Promise<string> {
  const gate = await adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId: seed.designId, kind: 'design_result' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return gate.id;
}

/** Press Request changes → reason → Revise in the overlay, as the reviewer does. */
async function revise(page: Page, seed: DesignBabysitterSeed): Promise<Locator> {
  await page.goto(`/items/${seed.designKey}`);
  await expect(page.getByRole('heading', { name: BABYSITTER_TITLES.design })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await designSection(page)
    .getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove, exact: true })
    .click();
  const dialog = dialogFor(page, seed.designKey);
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('button', { name: en.approvalGate.verb.requestChanges, exact: true })
    .click();
  await dialog.getByLabel(r.label).pressSequentially(REASON, { delay: 15 });
  await dialog
    .getByRole('radiogroup', { name: r.verdict.legend })
    .locator('label[data-verdict="revise"]')
    .click();
  const action = serverAction(page);
  await dialog.getByRole('button', { name: r.proceed, exact: true }).click();
  expect((await action).status()).toBe(200);
  await expect(
    dialog.getByText(en.approvalGate.state.changesRequested, { exact: true }),
  ).toBeVisible();
  return dialog;
}

/** The job writes ONE record per refusal — wait on THAT row, then read the page. */
async function waitForRerunRecord(gateId: string) {
  await expect
    .poll(async () => adminDb.designAutoRerun.findUnique({ where: { gateId } }), {
      timeout: 60_000,
      message: 'the design/auto-rerun.requested job wrote its record',
    })
    .not.toBeNull();
  return adminDb.designAutoRerun.findUniqueOrThrow({ where: { gateId } });
}

test.describe('design review without a babysitter', () => {
  test.beforeEach(async () => {
    await resetDatabase();
    writeHostedRunFixture({
      models: { ids: [DEFAULT_MODEL], default: DEFAULT_MODEL },
      mayRun: true,
    });
    resetHostedRunJournal();
  });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('switched off, a published design is approved on the record; sent back, a hosted design re-runs with the reason', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-693');
    const seed = await seedDesignBabysitter('happy', `BBS${Date.now().toString(36)}`);
    await servePublishedMock(page);
    await signIn(page, seed.email, seed.password);

    await chapter('Part A — the owner turns design approval off', async () => {
      await page.goto('/settings/project/approvals');
      const card = main(page).locator('#design-approval');
      await expect(
        card.getByRole('heading', { name: en.approvals.designApproval.title }),
      ).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      const toggle = card.getByRole('switch', { name: en.approvals.designApproval.title });
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(card.getByText(en.approvals.designApproval.onWhat)).toBeVisible();

      const saved = page.waitForResponse(
        (res) => res.url().endsWith('/approval-gates') && res.request().method() === 'PATCH',
      );
      await toggle.click();
      expect((await saved).status()).toBe(200);
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(card.getByText(en.approvals.designApproval.offWhat)).toBeVisible();
      // It survives a reload — the stored value, not the optimistic one.
      await page.reload();
      await expect(
        main(page).locator('#design-approval').getByRole('switch', {
          name: en.approvals.designApproval.title,
        }),
      ).toHaveAttribute('aria-checked', 'false');
      await beat();
    });

    await chapter('A design is published, and nobody has to press anything', async () => {
      await publish(seed, baseURL!);
      await page.goto(`/items/${seed.designKey}`);
      await expect(page.getByRole('heading', { name: BABYSITTER_TITLES.design })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(statusCard(page).getByText('Done', { exact: true })).toBeVisible();
      const section = designSection(page);
      await expect(section.getByText(record.systemApproved, { exact: true })).toBeVisible();
      // The owner holds workflow:manage, so the setting is a link back to the switch.
      await expect(
        section.getByRole('link', { name: record.systemApprovedWhy, exact: true }),
      ).toHaveAttribute('href', '/settings/project/approvals#design-approval');
      await expect(section.getByText(record.unattributed)).toHaveCount(0);
      await beat();

      await page.goto(`/items/${seed.dependentKey}`);
      await expect(page.getByRole('heading', { name: BABYSITTER_TITLES.dependent })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(main(page).getByText('Ready to start')).toBeVisible();
      await beat();
    });

    await chapter('Part B — design approval back on; a hosted design is sent back', async () => {
      await page.goto('/settings/project/approvals');
      const toggle = main(page)
        .locator('#design-approval')
        .getByRole('switch', { name: en.approvals.designApproval.title });
      const saved = page.waitForResponse(
        (res) => res.url().endsWith('/approval-gates') && res.request().method() === 'PATCH',
      );
      await toggle.click();
      expect((await saved).status()).toBe(200);
      await expect(toggle).toHaveAttribute('aria-checked', 'true');

      // A person reopens the design; its last run was on the hosted agent.
      await adminDb.workItem.update({
        where: { id: seed.designId },
        data: { status: 'in_progress' },
      });
      await seedLastHostedRun(seed, DEFAULT_MODEL);
      await publish(seed, baseURL!);
      const before = fakeContainerCount();

      const dialog = await revise(page, seed);
      await expect(dialog.getByText(`“${REASON}”`)).toBeVisible();
      await page.keyboard.press('Escape');

      const row = await waitForRerunRecord(await latestDesignGateId(seed));
      expect(row.outcome).toBe('started');
      // Exactly ONE container booted — the one automatic run.
      expect(fakeContainerCount()).toBe(before + 1);

      await page.reload();
      const line = designSection(page).getByTestId('auto-rerun-line');
      await expect(line.getByText(rerun.started, { exact: true })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(line.getByText(/automatic re-run 1 of 3/)).toBeVisible();
      await expect(line.getByRole('link', { name: rerun.viewRun })).toHaveAttribute(
        'href',
        new RegExp(`run=${row.dispatchRunId}`),
      );
      await beat();
    });

    await chapter('The run it started is handed the reason', async () => {
      const res = await page.request.get(`/api/v1/work-items/${seed.designKey}/dispatch-prompt`, {
        headers: { Authorization: `Bearer ${seed.token}` },
      });
      expect(res.status()).toBe(200);
      expect(((await res.json()) as { prompt: string }).prompt).toContain(REASON);
      await beat();
    });
  });

  test('past the cap, a Revise starts nothing and the card says why', async ({ page, baseURL }) => {
    const seed = await seedDesignBabysitter('cap', `BBC${Date.now().toString(36)}`);
    await seedLastHostedRun(seed, DEFAULT_MODEL);
    await seedEarlierRevises(seed, 3);
    await publish(seed, baseURL!);
    await servePublishedMock(page);
    await signIn(page, seed.email, seed.password);
    const before = fakeContainerCount();

    await revise(page, seed);
    await page.keyboard.press('Escape');

    const row = await waitForRerunRecord(await latestDesignGateId(seed));
    expect(row).toMatchObject({ outcome: 'skipped', skipReason: 'cap_reached', ordinal: 4 });
    expect(fakeContainerCount()).toBe(before);

    await page.reload();
    const line = designSection(page).getByTestId('auto-rerun-line');
    await expect(line.getByText(rerun.skipped, { exact: true })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(line.getByText(/sent back 3 times/)).toBeVisible();
    await expect(line.getByRole('link', { name: rerun.next.cap_reached })).toBeVisible();
    await expect(statusCard(page).getByText('To Do', { exact: true })).toBeVisible();
  });
});
