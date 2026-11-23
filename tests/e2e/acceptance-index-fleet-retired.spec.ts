import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import {
  paidOrgState,
  resetBillingFixture,
  seedBillingOwner,
  setOrgBillingState,
} from './_helpers/billing';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import {
  clearFleetUseRows,
  grantAndGoLive,
  holdFleetPasses,
  releaseFleetPasses,
  seedOwnAccount,
  writeFleetSwitches,
} from './_helpers/fleet-use-seed';
import {
  clearOrgFleetRows,
  seedCiJob,
  seedLiveHostedRun,
  seedRunningAgent,
} from './_helpers/org-fleet-seed';
import { holdScheduledJob } from './_helpers/scheduled-job-hold';
import { BILLING_CATALOG } from '@/lib/billing/catalog';
import { AGENT_INSTANCE_SWEEP_CRON } from '@/lib/jobs/definitions/agentInstanceSweep';
import { CI_RUNNER_PROVISION_SWEEP_CRON } from '@/lib/jobs/definitions/ciRunnerFleet';
import { FLEET_ATTRIBUTION_CRON } from '@/lib/jobs/definitions/fleetAttribution';
import { assessWatchability } from '../../scripts/upload-acceptance-video.mjs';
import en from '@/messages/en.json';

// THE INDEXER IS GONE FROM EVERY FLEET SCREEN (Story MOTIR-11026 · MOTIR-12043) —
// the story's acceptance receipt, its verification recipe steps 5–7. Once
// motir-core stops running index containers, a platform admin's fleet monitoring,
// a tenant's fleet card and fleet image status show the runner, hosted-agent and
// agent work and images with no indexer count, row or image card; an
// organisation's fleet settings show no index section; and Billing & plans'
// Fleet use lists three kinds, no code-graph indexing line, the merged account as
// the agent hoster at its granted vCPU with no kept-spots line, and the capacity
// request the organisation filed on that account before the change.
//
// ── THE SURFACES, FROM A SEARCH AT THE BUILD COMMIT ───────────────────────────
// At motir-core main 59fe2f6, `code_grep code_graph_index` under `app/` named
// five surfaces: FleetSection.tsx (monitoring), OrgFleetCard.tsx (tenant page),
// fleet-status/page.tsx (image status), FleetSections.tsx (fleet settings) and
// the billing Fleet use section. Re-run on this branch at MOTIR-12043:
//
//     $ git grep -n code_graph_index -- app/
//     (no output; exit 1)
//
// so the search names no surface this walk does not open.
//
// ── WHAT THIS LANE CAN AND CANNOT PROVE ───────────────────────────────────────
// The lane boots no container and runs no admission, so the fleet is SEEDED in
// the shapes its writers leave once the story has merged: a running CI intent, a
// hosted run holding its `hosted_agent` slot, a running agent instance holding
// its `agent_instance` slot, and the Host organisation's merged account as ONE
// `agent_instance` row under its own name (`seedOwnAccount`), live at its grant.
// The one row of the retired kind is history the database still keeps: a
// capacity request the organisation filed on that account before the change,
// whose stored `fleet_kind` is `code_graph_index` (`fleet_capacity_request`
// carries no fleet_kind CHECK). No shard, slot or switch of the kind is written —
// the tightened CHECKs would refuse it. The plan is motir-ai's, answered by the
// lane's billing mock from `setOrgBillingState`. The seams behind these screens
// (the allowance ask, the catch-up, the provisioning replay, the migration
// chain) are the integration gate's,
// `tests/integration/code-graph-index-retirement-gate.test.ts` (MOTIR-12042).
//
// ── WORDS ─────────────────────────────────────────────────────────────────────
// Every word the walk looks FOR is read from `messages/en.json`. The words it
// looks for the ABSENCE of are the English the removed keys held — the keys are
// gone from the catalogue, so they are written once below, as constants.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// The two client reads (fleet settings, Fleet use) wait on their GET's 200,
// armed before the navigation. The admin pages are server-rendered: each waits
// on its section's heading and a seeded count inside it. Every absence is
// asserted in the same scope as a presence asserted first, so an empty page can
// never pass. `beat()` is pacing only. The frame is the lane's 1920×1080.

test.describe.configure({ timeout: 300_000 });

/** The English the retired keys held (MOTIR-12040, MOTIR-12039, MOTIR-12044). */
const REMOVED = {
  monitoringColumn: 'Index containers',
  tenantTile: 'Index containers',
  imageCard: 'Indexer image',
  imagePinVariable: 'MOTIR_INDEXER_IMAGE',
  imageWorkflow: 'Indexer pin',
  settingsSection: 'Index jobs',
  whereItRunsKind: 'Indexer',
  mergedRole: 'Indexer + agent hoster',
  keptSpots: 'kept for indexing',
  indexingLine: 'Code-graph indexing',
} as const;
/** The kind the past capacity request stored. */
const RETIRED_KIND = 'code_graph_index';

const fm = en.platformAdmin.monitoring.fleet;
const tf = en.platformAdmin.tenant.fleet;
const fs = en.platformAdmin.fleetStatus;
const sf = en.settings.organization.fleet;
const fu = en.billing.fleetUse;

const HOST = BILLING_CATALOG.aiPlans.find((p) => p.key === 'host')!;
const GRANTED = 100;
const PAST_ASKED = 192;
const PAST_NOTE = 'Raised for the code-graph indexer';

/** A seeded count of one, standing alone: not part of a figure such as 10 or 21. */
const ONE = /(^|\D)1(?!\d)/;

const fill = (message: string, values: Record<string, string | number>) =>
  message.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));

/** Arm a GET of `path` answering 200, before the navigation that makes it. */
const readOf = (page: Page, path: string): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === path &&
      res.status() === 200,
    { timeout: 45_000 },
  );

const main = (page: Page): Locator => page.getByRole('main');

let hosterSwitchBefore: boolean | null = null;

test.beforeEach(async () => {
  await resetDatabase();
  resetBillingFixture();
  await clearFleetUseRows();
  await clearOrgFleetRows();
  await holdFleetPasses(20 * 60_000);
  await holdScheduledJob('system.ci-runner-provision-sweep', CI_RUNNER_PROVISION_SWEEP_CRON, [
    'system.ci-runner-boot',
  ]);
  await holdScheduledJob('system.agent-instance-sweep', AGENT_INSTANCE_SWEEP_CRON);
  await holdScheduledJob('system.fleet-attribution', FLEET_ATTRIBUTION_CRON);
  writeFleetSwitches({ hostedAgent: 'aws', ciRunner: 'aws' });
  const hoster = await adminDb.platformFleetKindSwitch.findUnique({
    where: { fleetKind: 'agent_instance' },
  });
  hosterSwitchBefore = hoster ? hoster.onPool : null;
});

test.afterEach(async () => {
  writeFleetSwitches({});
  await releaseFleetPasses();
  await clearFleetUseRows();
  await clearOrgFleetRows();
  if (hosterSwitchBefore === null) {
    await adminDb.platformFleetKindSwitch.deleteMany({ where: { fleetKind: 'agent_instance' } });
  } else {
    await adminDb.platformFleetKindSwitch.update({
      where: { fleetKind: 'agent_instance' },
      data: { onPool: hosterSwitchBefore },
    });
  }
});

test.describe('The retired indexer on the fleet screens', () => {
  test('admin fleet monitoring, the tenant card, image status, fleet settings and billing show no indexer', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-11026');
    const pageErrors: Error[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));
    const stamp = Date.now().toString(36);
    const t0 = Date.now();
    const starts: number[] = [];
    const timed = async (title: string, body: () => Promise<void>) => {
      starts.push((Date.now() - t0) / 1000);
      await chapter(title, body);
      await beat();
    };

    // ── the Host organisation, its work and its merged account ────────────────
    const owner = await seedBillingOwner(page, `acc-indexer-retired-${stamp}@example.com`);
    setOrgBillingState(
      owner.organizationId,
      paidOrgState({
        tier: { key: HOST.key, name: HOST.name, monthlyCreditAllotment: HOST.allotment!.credits },
      }),
    );
    const org = {
      organizationId: owner.organizationId,
      workspaceId: owner.workspaceId,
      projectId: owner.projectId,
      ownerId: owner.ownerId,
    };
    await seedCiJob(org, 'running');
    await seedLiveHostedRun(org, owner.ownerId);
    const agentName = `ada-${stamp}`;
    const agentId = await seedRunningAgent(org, owner.ownerId, agentName);
    // A running agent instance holds its `agent_instance` slot for as long as its
    // machine runs — the census the tenant card and the monitor count.
    await adminDb.fleetInFlightSlot.create({
      data: {
        workload: 'agent_instance',
        ref: `agent-instance:${agentId}`,
        organizationId: org.organizationId,
        workspaceId: org.workspaceId,
        containerProvider: 'fake',
        containerId: `fake-e2e-org-fleet-agent-${agentId}`,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    const requestedAt = new Date(Date.now() - 9 * 86_400_000);
    const merged = await seedOwnAccount({
      organizationId: org.organizationId,
      kinds: ['agent_instance'],
      desiredVcpu: 120,
      requestedAt,
    });
    await grantAndGoLive(merged, GRANTED, new Date(Date.now() - 8 * 86_400_000));
    // The capacity request filed on the merged account BEFORE the change, naming
    // the indexer: history the organisation's billing still lists.
    const pastFiledAt = new Date(Date.now() - 7 * 86_400_000);
    await adminDb.fleetCapacityRequest.create({
      data: {
        organizationId: org.organizationId,
        shardId: merged.shardIds[0]!,
        awsAccountId: merged.awsAccountId,
        fleetKind: RETIRED_KIND,
        desiredVcpu: PAST_ASKED,
        reasonMd: 'More index capacity for the monorepo.',
        status: 'closed',
        closedNote: PAST_NOTE,
        requestedByUserId: owner.ownerId,
        createdAt: pastFiledAt,
        filedAt: pastFiledAt,
        closedAt: new Date(pastFiledAt.getTime() + 86_400_000),
      },
    });

    // ── step 5: the platform admin's screens ─────────────────────────────────
    await db.user.update({ where: { id: owner.ownerId }, data: { platformRole: 'superadmin' } });

    await timed(
      'Fleet monitoring: the organisation’s CI, agent-run and agent counts, and no index column',
      async () => {
        expect((await page.goto('/admin/monitoring'))?.status()).toBe(200);
        const fleet = main(page).getByTestId('fleet-orgs');
        await expect(main(page).getByRole('heading', { name: fm.orgs.title })).toBeVisible();
        await fleet.scrollIntoViewIfNeeded();
        const row = fleet.locator(`tr[data-org="${org.organizationId}"]`);
        await expect(row).toBeVisible();
        const cells = row.getByRole('cell');
        await expect(cells.nth(1)).toContainText(HOST.name);
        for (const column of [2, 3, 4]) await expect(cells.nth(column)).toContainText(ONE);

        // The header row names exactly the three kinds, in order, and no index column.
        const headers = fleet.locator('thead tr').last().getByRole('columnheader');
        await expect(headers).toHaveCount(8);
        await expect(headers.nth(2)).toHaveText(fm.orgs.col.ciRunner);
        await expect(headers.nth(3)).toHaveText(fm.orgs.col.hostedAgent);
        await expect(headers.nth(4)).toHaveText(fm.orgs.col.agentInstance);
        await expect(fleet).not.toContainText(REMOVED.monitoringColumn);
      },
    );

    await timed(
      'The tenant’s fleet card: three rows with their counts, and no index row',
      async () => {
        expect((await page.goto(`/admin/tenants/${org.organizationId}`))?.status()).toBe(200);
        const card = main(page).getByTestId('org-fleet-card');
        await expect(card.getByRole('heading', { name: tf.title })).toBeVisible();
        await card.scrollIntoViewIfNeeded();
        for (const key of ['ciRunner', 'hostedAgent', 'agentInstance'] as const) {
          const tile = card.getByTestId(`org-fleet-tile-${key}`);
          await expect(tile).toContainText(tf.workload[key]);
          await expect(tile).toContainText(ONE);
        }
        await expect(card.locator('[data-testid^="org-fleet-tile-"]')).toHaveCount(3);
        await expect(card.getByTestId('org-fleet-tile-index')).toHaveCount(0);
        await expect(card).not.toContainText(REMOVED.tenantTile);
      },
    );

    await timed(
      'Fleet image status: the agent, runner and sandbox images, and no indexer image',
      async () => {
        expect((await page.goto('/admin/fleet-status'))?.status()).toBe(200);
        const images = main(page).locator('section[aria-labelledby="images-heading"]');
        await expect(
          images.getByRole('heading', { name: fs.images.title, exact: true }),
        ).toBeVisible();
        for (const image of ['hosted', 'runner', 'sandbox'] as const) {
          const card = images.locator(`[data-image="${image}"]`);
          await expect(card).toBeVisible({ timeout: 60_000 });
          await expect(card).toContainText(fs.image[image].title);
        }
        await expect(images.locator('[data-image]')).toHaveCount(3);
        await expect(images.locator('[data-image="indexer"]')).toHaveCount(0);
        await expect(main(page)).not.toContainText(REMOVED.imageCard);
        await expect(main(page)).not.toContainText(REMOVED.imagePinVariable);
        await expect(main(page)).not.toContainText(REMOVED.imageWorkflow);
      },
    );

    await db.user.update({ where: { id: owner.ownerId }, data: { platformRole: null } });

    // ── step 6: the organisation's fleet settings ─────────────────────────────
    await timed(
      'Settings › Organization › Fleet: hosted runs, agents and CI, and no index section',
      async () => {
        const read = readOf(page, `/api/organizations/${org.organizationId}/fleet`);
        await page.goto('/settings/organization/fleet');
        await read;
        await expect(page.getByRole('heading', { name: sf.title, level: 1 })).toBeVisible();
        for (const tile of ['agent-runs', 'agents', 'ci']) {
          await expect(main(page).getByTestId(`fleet-tile-${tile}`)).toBeVisible();
        }
        await expect(
          main(page).getByTestId('fleet-hosted').getByTestId('fleet-hosted-row'),
        ).toHaveCount(1);
        await expect(
          main(page).getByTestId('fleet-agents').getByTestId('fleet-agent-row'),
        ).toContainText(sf.agents.running);
        await expect(main(page).getByTestId('fleet-ci').getByTestId('fleet-ci-row')).toHaveCount(1);
        await expect(main(page).getByTestId('fleet-tile-index')).toHaveCount(0);
        await expect(main(page).getByTestId('fleet-index')).toHaveCount(0);
        await expect(main(page)).not.toContainText(REMOVED.settingsSection);
      },
    );

    // ── step 7: Billing & plans ───────────────────────────────────────────────
    const fleetUse = main(page).getByRole('region', { name: fu.title });
    const hosterRow = fleetUse.getByTestId('fleet-account-agent_hoster');

    await timed(
      'Billing & plans: three kinds where it runs, no indexing line, the merged account an agent hoster',
      async () => {
        const read = readOf(page, `/api/organizations/${org.organizationId}/billing/fleet-use`);
        await page.goto('/settings/organization/billing');
        const body = (await (await read).json()) as { fleetUse: Record<string, unknown> };
        expect(body.fleetUse).toBeTruthy();
        await expect(fleetUse.getByRole('heading', { name: fu.whereItRuns })).toBeVisible();
        const kinds = fleetUse
          .getByRole('heading', { name: fu.whereItRuns })
          .locator('xpath=following-sibling::dl[1]')
          .locator('dt');
        await expect(kinds).toHaveCount(3);
        for (const kind of ['hosted_agent', 'ci_runner', 'agent_instance'] as const) {
          await expect(kinds.filter({ hasText: fu.kind[kind] })).toHaveCount(1);
        }
        await expect(kinds.filter({ hasText: REMOVED.whereItRunsKind })).toHaveCount(0);
        await expect(fleetUse).not.toContainText(REMOVED.indexingLine);

        await expect(fleetUse.getByRole('heading', { name: fu.accounts.title })).toBeVisible();
        await hosterRow.scrollIntoViewIfNeeded();
        await expect(hosterRow).toContainText(fu.accounts.kind.agent_hoster);
        await expect(hosterRow).toContainText(fu.accounts.role.agent_hoster);
        await expect(hosterRow).toContainText(fu.accounts.state.live);
        await expect(hosterRow).toContainText(fu.accounts.vcpuGranted);
        await expect(hosterRow).toContainText(String(GRANTED));
        await expect(hosterRow).not.toContainText(REMOVED.mergedRole);
        await expect(hosterRow).not.toContainText(REMOVED.keptSpots);
        await expect(fleetUse.locator('[data-testid^="fleet-account-"]')).toHaveCount(1);
      },
    );

    await timed(
      'The capacity request filed on the merged account before the change is still listed',
      async () => {
        const status = hosterRow.getByTestId('fleet-request-status');
        await expect(status).toBeVisible();
        await expect(status).toContainText(fu.request.status.closed);
        await expect(status).toContainText(
          fu.request.asked.split('{date}')[0]!.replace('{vcpu}', String(PAST_ASKED)),
        );
        await expect(status).toContainText(fill(fu.request.line.closedNote, { note: PAST_NOTE }));
        await expect(hosterRow).not.toContainText(REMOVED.whereItRunsKind);
        expect(
          await adminDb.fleetCapacityRequest.count({
            where: { organizationId: org.organizationId, fleetKind: RETIRED_KIND },
          }),
        ).toBe(1);
      },
    );

    const verdict = assessWatchability({
      chapters: starts.map((tSeconds, i) => ({ label: String(i), tSeconds })),
      meta: { totalSeconds: (Date.now() - t0) / 1000 },
    });
    expect(verdict.watchable, verdict.reason ?? '').toBe(true);
    expect(pageErrors).toEqual([]);
  });
});
