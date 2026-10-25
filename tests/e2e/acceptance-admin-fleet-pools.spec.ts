import type { Locator } from '@playwright/test';
import { FLEET_CONTAINER_SIZE } from '@motir/orchestrator';
import { test, expect } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signUpToOnboarding } from './_helpers/shell-session';
import { clearAgentRunnerSwitch, writeCiRunnerSwitch } from './_helpers/fake-aws-boundary';
import { clearFleetRows, seedTenantOrg } from './_helpers/fleet-monitor-seed';
import {
  clearPoolRows,
  failQuotaRead,
  holdGrowthPass,
  POOL_ACCOUNT_PREFIX,
  releaseGrowthPass,
  seedGrowthEvent,
  seedPoolAccount,
  seedQuotaRequest,
  seedRunningJobs,
} from './_helpers/fleet-pools-seed';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-9367 — the platform admin sees every pool, walked as the story's
 * acceptance receipt (MOTIR-9565).
 *
 * A superadmin opens `/admin/monitoring` over a SEEDED estate (the rows, and why
 * the growth pass is held off while they are read, are in
 * `_helpers/fleet-pools-seed.ts`). The CI runner is put on AWS through the lane's
 * switch fixture; the other three kinds stay on Fly.
 *
 *  1. The Pools section: four blocks in order, the CI runner on AWS, the indexer
 *     on Fly in words with no figure.
 *  2. The CI pool: two shared accounts, one past 70% in words, the pool's
 *     capacity, use and percent, and the Motir spare waiting for quota.
 *  3. Two more accounts whose quota is not read (one never, one failed after an
 *     earlier read): the Not-read mark, no number and no zero, and the pool total
 *     not available rather than a partial sum.
 *  4. The quota requests: the open one first, then a newer denial reading denied.
 *  5. The growth events, newest first: a refusal in AWS's words, then a promotion.
 *  6. The Fleet section still renders, above the Pools section.
 *
 * The cross-workspace totals, the audit entry, the tenant refusal and the
 * no-secret/no-email assertions are the integration gate's
 * (`tests/platform/poolsStoryIntegration.test.tsx`), not walked here.
 *
 * Every wait is on a server-rendered block, row or heading, or on a response
 * status; there are no timers beyond the recorder's own holds.
 */

const pm = enMessages.platformAdmin.monitoring.pools;
const fm = enMessages.platformAdmin.monitoring.fleet;

const STAFF = 'acceptance-pools-staff@example.com';
const REFUSAL = 'You have exceeded the allowed number of AWS accounts.';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// The account and request tables are wide; beside the admin sidebar, 1440px keeps
// every column inside its scroll box in the video.
const WIDE = { width: 1440, height: 810 };

/** One running CI job's use: one container's vCPU. */
const C = FLEET_CONTAINER_SIZE.cpus;
const vcpu = (n: number) => `${n} vCPU`;
/** The account past 70%: 4 jobs on a quota of 5 containers' worth — 80%. */
const HOT = { granted: 5 * C, jobs: 4 };
/** The account under it: 4 jobs on 10 containers' worth — 40%. */
const COOL = { granted: 10 * C, jobs: 4 };

/** The cells of a row a granted quota decides: granted, percent and distance to 70%. */
async function quotaCells(row: Locator): Promise<string[]> {
  const cells = row.getByRole('cell');
  return Promise.all([3, 5, 6].map(async (i) => (await cells.nth(i).innerText()).trim()));
}

test.beforeEach(async () => {
  // Hold the worker's growth pass BEFORE the switch flips, so no pass ever sees
  // the CI runner on AWS while this walk's rows are on the page.
  await holdGrowthPass();
  await resetDatabase();
  await clearFleetRows();
  await clearPoolRows();
  writeCiRunnerSwitch('aws');
});

test.afterEach(async () => {
  // Back to Fly for every later spec, then the rows, then the pass.
  clearAgentRunnerSwitch();
  await clearPoolRows();
  await releaseGrowthPass();
});

test('a platform admin reads every pool: the CI pool past 70%, an unread quota, the spare, the requests and the growth', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9367');

  // ── The estate. Two tenants' CI jobs on two shared accounts.
  const northwind = await seedTenantOrg('Northwind Labs', 'e2e-pools-northwind');
  const halcyon = await seedTenantOrg('Halcyon Studio', 'e2e-pools-halcyon');
  const hot = await seedPoolAccount({ name: 'a', granted: HOT.granted });
  const cool = await seedPoolAccount({ name: 'b', granted: COOL.granted });
  await seedRunningJobs(northwind, hot.id, HOT.jobs / 2);
  await seedRunningJobs(halcyon, hot.id, HOT.jobs / 2);
  await seedRunningJobs(halcyon, cool.id, COOL.jobs);
  // The Motir spare: provisioned below a shared account's quota, its raise open.
  const spare = await seedPoolAccount({
    name: 'spare',
    granted: 5,
    role: 'spare',
    state: 'provisioning',
  });
  await seedQuotaRequest({
    shardId: spare.id,
    status: 'pending',
    desired: 128,
    askedAgoMs: 2 * DAY,
  });
  // A denial on the cooler account, NEWER than the open request.
  await seedQuotaRequest({
    shardId: cool.id,
    status: 'denied',
    desired: 512,
    askedAgoMs: 1 * DAY,
    closedAgoMs: 20 * 60 * MIN,
  });
  await seedGrowthEvent({
    triggeringShardId: hot.id,
    vcpuInUse: 4 * C,
    grantedQuota: HOT.granted,
    outcome: 'spare_promoted',
    spareShardId: cool.id,
    agoMs: 5 * DAY,
  });
  await seedGrowthEvent({
    triggeringShardId: hot.id,
    vcpuInUse: 4 * C,
    grantedQuota: HOT.granted,
    outcome: 'refused',
    reason: REFUSAL,
    agoMs: 3 * 60 * MIN,
  });

  // ── The operator: a signed-up account granted `superadmin`.
  await page.setViewportSize(WIDE);
  await signUpToOnboarding(page, STAFF);
  await adminDb.user.update({ where: { email: STAFF }, data: { platformRole: 'superadmin' } });

  const main = page.getByRole('main');
  const section = main.getByTestId('pools-section');
  const ci = section.getByTestId('pool-ci_runner');
  const indexer = section.getByTestId('pool-code_graph_index');
  const rowOf = (name: string) => ci.locator(`tr[data-account="${POOL_ACCOUNT_PREFIX}${name}"]`);
  const total = ci.locator('[data-element="pool-total"]');

  await chapter('Monitoring · Pools: four fleet kinds, the CI runner on AWS', async () => {
    expect((await page.goto('/admin/monitoring'))?.status()).toBe(200);
    await expect(section.getByRole('heading', { level: 2, name: pm.title })).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await expect(section.locator('[data-testid^="pool-"]')).toHaveCount(4);
    const order = await section
      .locator('[data-testid^="pool-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    expect(order).toEqual([
      'pool-ci_runner',
      'pool-hosted_agent',
      'pool-code_graph_index',
      'pool-agent_instance',
    ]);
    await expect(ci).toHaveAttribute('data-state', 'aws');
    await expect(ci.getByText(pm.provider.aws)).toBeVisible();

    // The indexer is on Fly: said in words, with nothing to count.
    await expect(indexer).toHaveAttribute('data-state', 'fly');
    await expect(indexer.getByText('Indexer runs on Fly')).toBeVisible();
    await expect(indexer.locator('[data-element="pool-total"]')).toHaveCount(0);
    await expect(indexer.locator('tr[data-account]')).toHaveCount(0);
    await expect(indexer.locator('[data-element="quota-request-list"]')).toHaveCount(0);
    await expect(indexer.locator('[data-element="growth-event-list"]')).toHaveCount(0);
    expect(await indexer.innerText()).not.toMatch(/\d/);
    await beat();
  });

  await chapter('The CI pool: one account past 70%, and the Motir spare waiting', async () => {
    await ci.scrollIntoViewIfNeeded();
    const capacity = HOT.granted + COOL.granted;
    const used = (HOT.jobs + COOL.jobs) * C;
    await expect(total).toHaveAttribute('data-complete', 'true');
    await expect(total).toContainText(vcpu(capacity));
    await expect(total).toContainText(vcpu(used));
    await expect(total).toContainText(`${Math.round((used / capacity) * 100)}%`);

    const hotRow = rowOf('a');
    await expect(hotRow).toHaveAttribute('data-over', 'true');
    const over = hotRow.locator('[data-mark="over"]');
    await expect(over).toContainText(pm.over);
    const past = HOT.jobs * C - Math.ceil(HOT.granted * 0.7);
    await expect(over).toContainText(past === 0 ? pm.atThreshold : `${vcpu(past)} past it`);
    await expect(hotRow.getByRole('cell').nth(5)).toHaveText('80%');

    const coolRow = rowOf('b');
    await expect(coolRow).toHaveAttribute('data-over', 'false');
    await expect(coolRow.getByRole('cell').nth(5)).toHaveText('40%');
    await expect(coolRow.getByRole('cell').nth(6)).toHaveText(
      `${vcpu(Math.ceil(COOL.granted * 0.7) - COOL.jobs * C)} to go`,
    );
    await expect(ci.getByText('1 account over 70%')).toBeVisible();

    // The spare is listed apart from the shared accounts, and is waiting.
    const spareLine = ci.locator('[data-element="spare-line"]');
    await spareLine.scrollIntoViewIfNeeded();
    const spareRow = spareLine.locator(`[data-spare="${POOL_ACCOUNT_PREFIX}spare"]`);
    await expect(spareRow.getByText(pm.spare.waiting)).toBeVisible();
    await expect(spareRow).toContainText('A raise to 128 vCPU was asked');
    await expect(rowOf('spare')).toHaveCount(0);
    await beat();
  });

  await chapter('A quota nobody has read: the Not-read mark, never a number', async () => {
    // Two more shared accounts: one never read, one whose read failed after an
    // earlier success. The page is reloaded, as an operator would.
    const never = await seedPoolAccount({ name: 'c', granted: null });
    const failed = await seedPoolAccount({ name: 'd', granted: 4 * C });
    await failQuotaRead(failed.id, new Date(Date.now() - 3 * DAY));
    await seedRunningJobs(northwind, never.id, 1);
    expect((await page.reload())?.status()).toBe(200);
    await ci.scrollIntoViewIfNeeded();

    for (const [name, readWords] of [
      ['c', pm.neverRead],
      ['d', 'last read 3 d ago'],
    ] as const) {
      const row = rowOf(name);
      await expect(row.getByLabel(pm.notReadLabel)).toBeVisible();
      await expect(row.locator('[data-mark="not-read"]')).toContainText(readWords);
      const [granted, percent, toThreshold] = await quotaCells(row);
      expect(percent).toBe(pm.notAvailable);
      expect(toThreshold).toBe(pm.notAvailable);
      for (const text of [granted!, percent!, toThreshold!]) {
        expect(text).not.toMatch(/\b0\b/);
        expect(text).not.toMatch(/\d+\s*(vCPU|%)/);
      }
    }
    // The pool total is not available: no partial capacity, no percent.
    await expect(total).toHaveAttribute('data-complete', 'false');
    await expect(total).toContainText('2 accounts’ quota is not read, so the total is not known');
    await expect(total).not.toContainText(vcpu(HOT.granted + COOL.granted));
    expect(await total.innerText()).not.toMatch(/\d+\s*%/);
    await beat();
  });

  await chapter('Quota raises asked of AWS: the open one first, the denial in words', async () => {
    const list = ci.locator('[data-element="quota-request-list"]');
    await list.scrollIntoViewIfNeeded();
    const rows = list.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).getByRole('cell').nth(0)).toHaveText(`${POOL_ACCOUNT_PREFIX}spare`);
    await expect(rows.nth(0)).toContainText(pm.requests.status.pending);
    await expect(rows.nth(0)).toContainText(vcpu(128));
    await expect(rows.nth(1).getByRole('cell').nth(0)).toHaveText(`${POOL_ACCOUNT_PREFIX}b`);
    await expect(rows.nth(1)).toContainText(pm.requests.status.denied);
    await expect(rows.nth(1)).toContainText(pm.requests.notGranted);
    await expect(rows.nth(1)).toContainText(`quota stays ${vcpu(COOL.granted)}`);
    await beat();
  });

  await chapter('Growth at 70%: a refusal in AWS’s own words, then a promotion', async () => {
    const list = ci.locator('[data-element="growth-event-list"]');
    await list.scrollIntoViewIfNeeded();
    const rows = list.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(pm.events.outcome.refused);
    await expect(rows.nth(0)).toContainText(`AWS said: “${REFUSAL}”`);
    await expect(rows.nth(1)).toContainText(pm.events.outcome.spare_promoted);
    await expect(rows.nth(1)).toContainText(`${POOL_ACCOUNT_PREFIX}a`);
    await expect(rows.nth(1)).toContainText(`${4 * C} of ${HOT.granted} vCPU`);
    await beat();
  });

  await chapter('The Fleet section still renders, above the Pools section', async () => {
    const fleet = main.getByTestId('fleet-orgs');
    await fleet.scrollIntoViewIfNeeded();
    await expect(main.getByRole('heading', { name: fm.orgs.title })).toBeVisible();
    await expect(fleet.getByRole('row', { name: /Northwind Labs/ })).toBeVisible();
    await expect(fleet.getByRole('row', { name: /Halcyon Studio/ })).toBeVisible();
    const fleetFirst = await fleet.evaluate(
      (el) =>
        !!(
          el.compareDocumentPosition(document.querySelector('[data-testid="pools-section"]')!) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
    );
    expect(fleetFirst).toBe(true);
    await beat();
  });
});
