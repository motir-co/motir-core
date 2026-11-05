import type { Locator, Page, Response, Route } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import {
  paidOrgState,
  pinContextCookies,
  resetBillingFixture,
  seedBillingOwner,
  setOrgBillingState,
  TIERS,
} from './_helpers/billing';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import { holdFleetPasses, releaseFleetPasses } from './_helpers/fleet-use-seed';
import {
  clearOrgFleetRows,
  seedCiJob,
  seedFleetPeople,
  seedIndexJob,
  seedLiveHostedRun,
  seedMotirStop,
  seedOtherOrg,
  seedRunningAgent,
  type FleetPerson,
} from './_helpers/org-fleet-seed';
import { holdScheduledJob } from './_helpers/scheduled-job-hold';
import { signIn, SHELL_PASSWORD } from './_helpers/shell-session';
import { AGENT_INSTANCE_SWEEP_CRON } from '@/lib/jobs/definitions/agentInstanceSweep';
import { CI_RUNNER_PROVISION_SWEEP_CRON } from '@/lib/jobs/definitions/ciRunnerFleet';
import { FLEET_ATTRIBUTION_CRON } from '@/lib/jobs/definitions/fleetAttribution';
import en from '@/messages/en.json';

// ORG ADMINS SEE WHAT THEIR ORGANISATION RUNS ON THE FLEET, AND CAN STOP IT
// (Story MOTIR-10363 · MOTIR-10372) — the story's acceptance receipt. An org
// admin opens Settings › Organization › Fleet, reads its tiles and six sections
// over only its own work, watches the 30-second poll and Refresh, sees one
// section fail alone and recover, cancels a hosted run, hibernates another
// member's agent (who is told in the drawer), opens Stop everything with the
// counts unreadable and then readable, and confirms it: the result, partly
// failed, stays through a poll and a reload until Dismiss. A superadmin then
// reads the org-admin stop on the platform tenant page; a plain member gets the
// forbidden panel and a non-member a 404.
//
// ── WHAT THIS LANE CAN AND CANNOT PROVE ───────────────────────────────────────
// The lane boots no container and runs no admission, so the fleet is SEEDED as
// rows in the shapes their writers leave (`_helpers/org-fleet-seed.ts`). Every
// stop runs through the page's REAL Server Actions and services against those
// rows; the container provider and GitHub are the lane's fakes. So this proves
// what a PERSON sees and can do. Two-organisation isolation across every door,
// the field-by-field response and the service refusals are the story
// integration gate's (`tests/orgFleet/orgFleetStoryGate.test.ts`, MOTIR-10371);
// the walk only checks that a second org's work is absent from the page.
//
// ── THE PARTIAL FAILURE ───────────────────────────────────────────────────────
// A seeded agent has no machine in the lane's persistent fake, so its stop never
// confirms: the instance stays `hibernating` and Stop everything counts it as
// "did not stop". That is the provider not confirming a stop — the real failure
// the result's partial line exists for — reached without a new seam and without
// editing a row mid-stop. The admin's own agent is the one Stop everything hits.
//
// ── WITHOUT THE FLEET METER ───────────────────────────────────────────────────
// This lane is cloud-on only (`playwright.acceptance.config.ts` sets
// MOTIR_CLOUD), so the build without the meter is the MAIN lane's:
// `org-fleet-selfhost.spec.ts` asserts no rail row and the 404 there.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every read the next assertion depends on waits on the fleet GET armed before
// the action; every Server Action waits on its POST's response; cancel and
// hibernate are then read back from the stored row. The 30-second tick is
// proven by the next fleet read arriving with no input. `beat()` is pacing only.

test.describe.configure({ timeout: 360_000 });

const copy = en.settings.organization.fleet;
const fleetPath = '/settings/organization/fleet';
const apiPath = (orgId: string) => `/api/organizations/${orgId}/fleet`;
const states = en.orgAdmin.states;

const fill = (message: string, values: Record<string, string | number>) =>
  message.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));

// ── page helpers ──────────────────────────────────────────────────────────────

/** Arm the island's next fleet read; answers its response. */
const fleetRead = (page: Page, orgId: string, timeout = 45_000): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === apiPath(orgId) &&
      res.status() === 200,
    { timeout },
  );

/** Arm the next Server Action POST from the Fleet page; answers its response. */
const actionResponse = (page: Page): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' &&
      new URL(res.url()).pathname === fleetPath &&
      res.request().headers()['next-action'] !== undefined,
    { timeout: 60_000 },
  );

/** Scoped to the page's `main`: a page-rooted test id can match React's
 *  outgoing or staging subtree (MOTIR-5037). */
const main = (page: Page): Locator => page.getByRole('main');
const section = (page: Page, id: string): Locator => main(page).getByTestId(`fleet-${id}`);
const agentRow = (page: Page, ownerName: string): Locator =>
  section(page, 'agents').getByTestId('fleet-agent-row').filter({ hasText: ownerName });

/** The org settings rail's hrefs, in order. */
async function railHrefs(page: Page): Promise<string[]> {
  const hrefs = await page
    .locator('a[href^="/settings/organization"]')
    .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
  return [...new Set(hrefs)];
}

// ── the walk ──────────────────────────────────────────────────────────────────

test.beforeEach(async () => {
  await resetDatabase();
  resetBillingFixture();
  await clearOrgFleetRows();
  await holdFleetPasses(20 * 60_000);
  await holdScheduledJob('system.ci-runner-provision-sweep', CI_RUNNER_PROVISION_SWEEP_CRON, [
    'system.ci-runner-boot',
  ]);
  await holdScheduledJob('system.agent-instance-sweep', AGENT_INSTANCE_SWEEP_CRON);
  await holdScheduledJob('system.fleet-attribution', FLEET_ATTRIBUTION_CRON);
});

test.afterEach(async () => {
  await releaseFleetPasses();
  await clearOrgFleetRows();
});

test.describe('Fleet in Settings › Organization', () => {
  test('an org admin sees its fleet, cancels, hibernates and stops everything; others cannot', async ({
    page,
    browser,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-10363');
    const pageErrors: Error[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));
    const stamp = Date.now().toString(36);

    // ── the org, its people and its fleet ─────────────────────────────────────
    const owner = await seedBillingOwner(page, `acc-fleet-owner-${stamp}@example.com`);
    setOrgBillingState(owner.organizationId, paidOrgState({ tier: TIERS.pro }));
    const org = {
      organizationId: owner.organizationId,
      workspaceId: owner.workspaceId,
      projectId: owner.projectId,
      ownerId: owner.ownerId,
    };
    const { admin, member, plainMember } = await seedFleetPeople(org, stamp);
    const hostedRuns = [
      await seedLiveHostedRun(org, member.id),
      await seedLiveHostedRun(org, member.id),
    ];
    const ciInFlight = await seedCiJob(org, 'running');
    await seedCiJob(org, 'pending');
    const memberAgent = await seedRunningAgent(org, member.id, `mira-${stamp}`);
    const adminAgent = await seedRunningAgent(org, admin.id, `ada-${stamp}`);
    const indexRef = await seedIndexJob(org);
    await seedMotirStop(org.organizationId, new Date(Date.now() - 3 * 60 * 60_000));
    const other = await seedOtherOrg(stamp);

    const signInAs = async (target: Page, who: FleetPerson) => {
      await signIn(target, who.email, SHELL_PASSWORD);
      await pinContextCookies(target, {
        workspaceId: org.workspaceId,
        organizationId: org.organizationId,
      });
    };

    await chapter('An admin opens Fleet, after Usage, and reads only its own work', async () => {
      await signInAs(page, admin);
      await page.goto('/settings/organization');
      const hrefs = await railHrefs(page);
      const usage = hrefs.indexOf('/settings/organization/usage');
      expect(usage).toBeGreaterThanOrEqual(0);
      expect(hrefs[usage + 1]).toBe(fleetPath);
      await beat();

      await page.locator(`a[href="${fleetPath}"]`).first().click();
      await expect(page).toHaveURL(new RegExp(`${fleetPath}$`));
      await expect(page.getByRole('heading', { name: copy.title, level: 1 })).toBeVisible();
      for (const tile of ['agent-runs', 'agents', 'ci', 'index']) {
        await expect(main(page).getByTestId(`fleet-tile-${tile}`)).toBeVisible();
      }
      await expect(section(page, 'hosted').getByTestId('fleet-hosted-row')).toHaveCount(2);
      await expect(section(page, 'agents').getByTestId('fleet-agent-row')).toHaveCount(2);
      await expect(agentRow(page, member.name)).toContainText(copy.agents.running);
      await expect(section(page, 'ci').getByTestId('fleet-ci-row')).toHaveCount(2);
      await expect(section(page, 'ci')).toContainText(copy.ci.cause.planLimit);
      // Index jobs: a count and the not-charged-or-stopped line, no control.
      const index = section(page, 'index');
      await expect(index).toContainText(copy.index.note);
      await expect(index).toContainText(/1\s*running/);
      await expect(index.getByRole('button')).toHaveCount(0);
      await expect(section(page, 'motir-stops').getByTestId('fleet-motir-stop-row')).toHaveCount(1);
      await expect(section(page, 'motir-stops')).toContainText(copy.motirStops.reason.record_ended);
      // The second organisation's work is nowhere on the page.
      await expect(page.getByText(other.agentName)).toHaveCount(0);
      await expect(page.getByText(other.owner.name)).toHaveCount(0);
      await beat();
    });

    await chapter('Agent rows offer Hibernate only, and link nowhere', async () => {
      const rows = section(page, 'agents').getByTestId('fleet-agent-row');
      await expect(rows.locator('a')).toHaveCount(0);
      await expect(rows.locator('[href]')).toHaveCount(0);
      for (const row of await rows.all()) {
        const buttons = row.getByRole('button');
        await expect(buttons).toHaveCount(1);
        await expect(buttons).toHaveText(copy.agents.hibernate);
      }
      await beat();
    });

    await chapter(
      'The page re-reads every 30 seconds and on Refresh, keeping its data',
      async () => {
        const tick = fleetRead(page, org.organizationId);
        const ticked = (await (await tick).json()) as { fleet: unknown };
        expect(ticked.fleet).toBeTruthy();
        await expect(section(page, 'hosted').getByTestId('fleet-hosted-row')).toHaveCount(2);
        await beat();

        const refreshed = fleetRead(page, org.organizationId);
        await page.getByRole('button', { name: copy.refresh.button }).click();
        await refreshed;
        await expect(section(page, 'hosted').getByTestId('fleet-hosted-row')).toHaveCount(2);
        await expect(main(page).getByTestId('fleet-refresh-cue')).toContainText('30 seconds');
        await beat();
      },
    );

    await chapter('One section fails alone, never as a zero, and recovers on Retry', async () => {
      const failCi = async (route: Route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const res = await route.fetch();
        const body = (await res.json()) as { fleet: Record<string, unknown> };
        body.fleet['ciJobs'] = { kind: 'not_read' };
        await route.fulfill({ response: res, json: body });
      };
      await page.route(`**${apiPath(org.organizationId)}`, failCi);
      const failed = fleetRead(page, org.organizationId);
      await page.getByRole('button', { name: copy.refresh.button }).click();
      await failed;
      const ci = section(page, 'ci');
      await expect(ci).toContainText(copy.ci.failed);
      await expect(ci).toContainText(copy.section.failedBody);
      await expect(ci.getByTestId('fleet-ci-row')).toHaveCount(0);
      await expect(ci).not.toContainText(/\b0 in flight/);
      await expect(section(page, 'hosted').getByTestId('fleet-hosted-row')).toHaveCount(2);
      await expect(section(page, 'agents').getByTestId('fleet-agent-row')).toHaveCount(2);
      await beat();

      await page.unroute(`**${apiPath(org.organizationId)}`, failCi);
      const recovered = fleetRead(page, org.organizationId);
      await ci.getByRole('button', { name: copy.section.retry }).click();
      await recovered;
      await expect(ci.getByTestId('fleet-ci-row')).toHaveCount(2);
      await beat();
    });

    await chapter('The admin cancels a hosted run', async () => {
      const row = section(page, 'hosted').getByTestId('fleet-hosted-row').first();
      await row.getByRole('button', { name: /^Cancel the run of/ }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(copy.cancelRun.title);
      await beat();
      const answered = actionResponse(page);
      const reread = fleetRead(page, org.organizationId);
      await dialog.getByRole('button', { name: copy.cancelRun.confirm }).click();
      expect((await answered).status()).toBe(200);
      await reread;
      await expect(section(page, 'hosted').getByTestId('fleet-hosted-row')).toHaveCount(1);
      const stored = await adminDb.dispatchRun.findMany({
        where: { id: { in: hostedRuns } },
        select: { status: true },
      });
      expect(stored.map((r) => r.status).sort()).toEqual(['cancelled', 'running']);
      await beat();
    });

    await chapter(`The admin hibernates ${member.name}’s agent`, async () => {
      const row = agentRow(page, member.name);
      await row.getByRole('button', { name: copy.agents.hibernate }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText(fill(copy.hibernate.title, { owner: member.name }));
      await expect(dialog).toContainText(member.name);
      await beat();
      const answered = actionResponse(page);
      await dialog.getByRole('button', { name: copy.hibernate.confirm }).click();
      expect((await answered).status()).toBe(200);
      await expect(row.getByRole('button')).toHaveCount(0);
      await expect(row).toContainText(copy.agents.hibernating);
      const stored = await adminDb.agentInstance.findUniqueOrThrow({ where: { id: memberAgent } });
      expect(stored.state).toBe('hibernating');
      await beat();
    });

    await chapter(`${member.name} is told, once, in the drawer`, async () => {
      const notes = await adminDb.notification.findMany({
        where: { type: 'agent_hibernated_by_admin' },
      });
      expect(notes.map((n) => [n.recipientUserId, n.actorId])).toEqual([[member.id, admin.id]]);
      const context = await browser.newContext();
      try {
        const memberPage = await context.newPage();
        await signInAs(memberPage, member);
        const bell = memberPage.getByRole('button', { name: /^Notifications,/ });
        await expect(bell).toHaveAccessibleName(/unread/);
        await bell.click();
        const drawer = memberPage.getByRole('dialog', { name: 'Notifications' });
        await expect(drawer).toContainText(admin.name);
        await expect(drawer).toContainText('hibernated your agent');
        await expect(drawer).toContainText(`mira-${stamp}`);
        await expect(drawer).toContainText(/stopped it at \S+/);
      } finally {
        await context.close();
      }
      await beat();
    });

    await chapter('Stop everything: unreadable counts offer Try again, never confirm', async () => {
      let unreadable = true;
      const blurPreview = async (route: Route) => {
        const req = route.request();
        if (req.method() !== 'POST' || req.headers()['next-action'] === undefined) {
          return route.fallback();
        }
        const res = await route.fetch();
        const text = await res.text();
        // The preview's answer is the only action result that carries `countedAt`.
        if (!unreadable || !text.includes('"countedAt"')) {
          return route.fulfill({ response: res, body: text });
        }
        const headers = { ...res.headers() };
        delete headers['content-length'];
        await route.fulfill({
          status: res.status(),
          headers,
          body: text.replace(/"ciContainers":\d+/, '"ciContainers":null'),
        });
      };
      await page.route(`**${fleetPath}`, blurPreview);

      const counted = actionResponse(page);
      await main(page).getByTestId('fleet-stop-all').click();
      await counted;
      const dialog = page.getByRole('alertdialog');
      await expect(dialog.getByTestId('stop-all-unreadable')).toContainText(
        copy.stopAll.unreadableTitle,
      );
      await expect(dialog.getByRole('button', { name: copy.stopAll.confirm })).toHaveCount(0);
      await beat();

      unreadable = false;
      const recounted = actionResponse(page);
      await dialog.getByRole('button', { name: copy.stopAll.retry }).click();
      await recounted;
      await page.unroute(`**${fleetPath}`, blurPreview);
      await expect(dialog.getByTestId('stop-all-effect-ci')).toContainText('1 container');
      await expect(dialog.getByTestId('stop-all-effect-hosted')).toContainText('1');
      await expect(dialog.getByTestId('stop-all-effect-agents')).toContainText('1');
      await expect(dialog.getByTestId('stop-all-effect-index')).toContainText(
        'indexing is not stopped here',
      );
      await beat();
    });

    await chapter('The admin stops everything; one agent does not confirm', async () => {
      const dialog = page.getByRole('alertdialog');
      const answered = actionResponse(page);
      const reread = fleetRead(page, org.organizationId);
      await dialog.getByRole('button', { name: copy.stopAll.confirm }).click();
      expect((await answered).status()).toBe(200);
      await reread;
      const result = main(page).getByTestId('fleet-stop-result');
      await expect(result).toHaveAttribute('data-partial', 'true');
      await expect(result).toContainText(copy.result.partialTitle);
      await expect(result).toContainText(/Stopped by you, today at/);
      await expect(main(page).getByTestId('fleet-stop-result-agents')).toContainText(
        'the stop did not confirm',
      );
      await expect(result).toContainText(copy.result.index);
      await expect(main(page).getByTestId('fleet-last-stop')).toContainText(/Last stopped by you/);

      const ci = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
        where: { id: ciInFlight },
      });
      expect(ci.teardownReason).toBe('org_admin_stop');
      expect(
        (await adminDb.dispatchRun.findMany({ where: { id: { in: hostedRuns } } })).map(
          (r) => r.status,
        ),
      ).toEqual(['cancelled', 'cancelled']);
      expect(
        (await adminDb.agentInstance.findUniqueOrThrow({ where: { id: adminAgent } })).state,
      ).toBe('hibernating');
      await beat();
    });

    await chapter('The result stays through a poll and a reload until Dismiss', async () => {
      const result = main(page).getByTestId('fleet-stop-result');
      await fleetRead(page, org.organizationId);
      await expect(result).toContainText(copy.result.partialTitle);
      await beat();

      const firstRead = page.waitForResponse(
        (res) => new URL(res.url()).pathname === fleetPath && res.request().method() === 'GET',
      );
      await page.reload();
      await firstRead;
      await expect(result).toContainText(copy.result.partialTitle);
      await expect(main(page).getByTestId('fleet-last-stop')).toContainText(
        new RegExp(`Last stopped by ${admin.name}, today at`),
      );
      // The index job kept running: its row and its count are unchanged.
      await expect(section(page, 'index')).toContainText(/1\s*running/);
      expect(
        await adminDb.fleetInFlightSlot.count({
          where: { ref: indexRef, workload: 'code_graph_index' },
        }),
      ).toBe(1);
      await beat();

      await result.getByRole('button', { name: copy.result.dismissAria }).click();
      await expect(result).toHaveCount(0);
      await beat();
    });

    await chapter('A superadmin reads the org-admin stop on the tenant page', async () => {
      await db.user.update({ where: { id: other.owner.id }, data: { platformRole: 'superadmin' } });
      const context = await browser.newContext();
      try {
        const staff = await context.newPage();
        await signIn(staff, other.owner.email, SHELL_PASSWORD);
        const res = await staff.goto(`/admin/tenants/${org.organizationId}`);
        expect(res?.status()).toBe(200);
        const block = staff.getByTestId('org-fleet-last-org-admin-stop');
        await expect(block).toContainText(en.platformAdmin.tenant.fleet.orgAdminStop.title);
        await expect(block).toContainText('1 CI containers');
        await expect(staff.getByTestId('org-fleet-last-stop')).toHaveCount(0);
      } finally {
        await context.close();
      }
      await db.user.update({ where: { id: other.owner.id }, data: { platformRole: null } });
      await beat();
    });

    await chapter('A plain member gets the forbidden panel; a non-member gets 404', async () => {
      const context = await browser.newContext();
      try {
        const memberPage = await context.newPage();
        await signInAs(memberPage, plainMember);
        await memberPage.goto(fleetPath);
        await expect(memberPage.getByText(states.forbiddenTitle)).toBeVisible();
        await expect(memberPage.getByTestId('fleet-hosted')).toHaveCount(0);
        await expect(memberPage.getByTestId('fleet-tiles')).toHaveCount(0);
        await memberPage.goto('/settings/organization');
        await expect(memberPage.locator(`a[href="${fleetPath}"]`)).toHaveCount(0);
        expect((await memberPage.request.get(apiPath(org.organizationId))).status()).toBe(403);
      } finally {
        await context.close();
      }
      const strangerContext = await browser.newContext();
      try {
        const stranger = await strangerContext.newPage();
        await signIn(stranger, other.owner.email, SHELL_PASSWORD);
        expect((await stranger.request.get(apiPath(org.organizationId))).status()).toBe(404);
      } finally {
        await strangerContext.close();
      }
      await beat();
    });

    expect(pageErrors).toEqual([]);
  });
});
