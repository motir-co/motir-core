import type { Locator, Page, Response } from '@playwright/test';
import { expect, test } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { resetBillingFixture, seedBillingOwner } from './_helpers/billing';
import {
  armFleetControl,
  countFleetAuditRows,
  failNextWrite,
  pickRunnableRepo,
  readFleetJournal,
  readSettingRow,
  readStoredVariable,
  readyOrgControl,
  resetFleetSeam,
  seedMotirCiTarget,
  variableWrites,
  withoutVariablesWrite,
} from './_helpers/fleet-org-ci';
import { MOTIR_RUNNER_LABEL, MOTIR_RUNNER_VARIABLE } from '@/lib/ciFleet/config';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-8699 — platform admins switch Motir's own private repositories' CI onto
 * the shared runner fleet from ONE audited /admin setting (MOTIR-8717).
 *
 * The assembled `/admin/fleet-settings` surface, served by the lane's real Next server
 * against the real test database. Only api.github.com is faked, at the transport, by
 * `lib/test-github-fleet-org-ci-mock.ts` (`E2E_TEST_GITHUB_FLEET_ORG_CI`, armed in
 * `playwright.acceptance.config.ts`): the real installation reads, the real App JWT and
 * token mint, the real readiness verdict, the real flip and its audit row all run. With
 * the seam unarmed the shared agent refuses every one of those calls, `listTargets`
 * fails, the page renders its error card, and case 3's populated verdict fails.
 *
 *  0. Precondition: a private, all-runnable repository in the fleet job inventory, the
 *     seam answering, and the page rendering the setting heading.
 *  1. A tenant owner gets the ordinary 404.
 *  2. A support principal has no rail row, and the route 404s.
 *  3. A superadmin, not ready (no `Variables: write`): OFF, nine conditions, the
 *     variables one unmet in words, ON disabled with its reason, no variable write.
 *  4. Ready: the verdict reads Ready and ON is enabled.
 *  5. ON with a blank reason is refused inline; nothing is written.
 *  6. ON with a reason: the page re-reads ON, who and why, and GitHub's read-back; one
 *     variable write; the stored row is on.
 *  7. ON again from a tab opened before step 6: "Already on", no new write.
 *  8. OFF while GitHub refuses the write: stated in words, "Nothing changed", and the
 *     row, the variable and the audit count are all exactly as before.
 *  9. Not ready while ON: OFF stays offered and the warning band shows; OFF with a
 *     reason removes the variable (one DELETE).
 * 10. The audit log lists exactly the two flips, with direction, actor and reason.
 *
 * Every wait is the page's own rendered text or the Server Action's committed response,
 * never a timeout.
 */

const fs = enMessages.platformAdmin.fleetSettings;
const shellLabels = enMessages.platformAdmin.shell;
const nav = enMessages.platformAdmin.nav;
const audit = enMessages.platformAdmin.audit;

const OWNER = 'acceptance-fleet-settings-owner@example.com';
const REASON_ON = 'Moving Motir CI onto the fleet for the October pilot';
const REASON_STALE = 'Second operator, same intent, older page';
const REASON_FAILED = 'Rolling back while the fleet image is rebuilt';
const REASON_OFF = 'Fleet degraded; back to GitHub-hosted until it is fixed';

const PAGE = '/admin/fleet-settings';

/** Fill a catalogue message's simple `{name}` placeholders. */
function fill(message: string, values: Record<string, string | number>): string {
  return message.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}

/** A message as a literal pattern. */
const literal = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** Arm the wait for the flip's Server Action BEFORE the press, so it cannot be missed. */
function flipResponse(p: Page): Promise<Response> {
  return p.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      r.request().headers()['next-action'] !== undefined &&
      new URL(r.url()).pathname === PAGE,
  );
}

/** Press the switch, give the reason, confirm; resolves on the action's response. */
async function flip(p: Page, reason: string, confirmLabel: string): Promise<void> {
  await p.getByRole('switch', { name: fs.setting.title }).click();
  const dialog = p.getByRole('alertdialog');
  await dialog.getByLabel(fs.confirm.reasonLabel).fill(reason);
  const answered = flipResponse(p);
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
  expect((await answered).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
}

test('a superadmin reads the fleet readiness verdict, turns Motir CI on and off with a reason, a refused write changes nothing, and both flips are audited; others are refused', async ({
  page,
  browser,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-8699');
  test.setTimeout(180_000);

  // Case 0's manifest guard runs FIRST: no qualifying repository fails here, by name.
  const repo = pickRunnableRepo();

  await resetDatabase();
  resetBillingFixture();
  resetFleetSeam();
  const seed = await seedMotirCiTarget(repo);
  const org = seed.org;
  const orgKey = org.toLowerCase();
  const ready = readyOrgControl(repo);
  armFleetControl({ orgs: { [org]: withoutVariablesWrite(ready) } });

  await seedBillingOwner(page, OWNER);
  const main = page.getByRole('main');
  const settingSwitch = page.getByRole('switch', { name: fs.setting.title });
  const readinessCard = main.getByTestId('fleet-readiness');
  const conditions = readinessCard.locator('[data-testid^="fleet-condition-"]');
  const lastChanged = main.getByTestId('fleet-org-ci-last-changed');
  const variableLine = main.getByTestId('fleet-org-ci-variable');
  const answer = main.getByTestId('fleet-org-ci-answer');

  await chapter('A tenant owner opens /admin/fleet-settings — it does not exist', async () => {
    const res = await page.goto(PAGE);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: fs.title, level: 1 })).toHaveCount(0);
    // The tenant's visit asked GitHub nothing.
    expect(readFleetJournal()).toEqual([]);
  });

  await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'support' } });

  await chapter(
    'Support staff: no Fleet settings row in the console, and the route 404s',
    async () => {
      await page.goto('/admin');
      // The console's rail is up (its Monitoring row shows), and it has no Fleet settings row.
      await expect(page.getByRole('link', { name: nav.monitoring, exact: true })).toBeVisible();
      await expect(
        page.getByRole('link', { name: shellLabels.navFleetSettings, exact: true }),
      ).toHaveCount(0);
      await beat();
      const res = await page.goto(PAGE);
      expect(res?.status()).toBe(404);
      await expect(page.getByRole('heading', { name: fs.title, level: 1 })).toHaveCount(0);
    },
  );

  await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'superadmin' } });

  await chapter('A superadmin opens Operations → Fleet settings', async () => {
    await page.goto('/admin');
    await page.getByRole('link', { name: shellLabels.navFleetSettings, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
    await expect(page.getByRole('heading', { name: fs.title, level: 1 })).toBeVisible();
    // Case 0: the setting is drawn for the seeded pair, and it was the SEAM that answered
    // the installation read behind it.
    await expect(page.getByRole('heading', { name: fs.setting.title, level: 2 })).toBeVisible();
    await expect(
      main.getByText(fill(fs.setting.pair, { project: seed.projectKey, org }), { exact: true }),
    ).toBeVisible();
    expect(
      readFleetJournal().some((c) => c.path === `/orgs/${org}/installation` && c.status === 200),
    ).toBe(true);
  });

  await chapter('Not ready: Variables (write) is not granted, so ON is held back', async () => {
    await expect(settingSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(main.getByText(fs.state.off, { exact: true })).toBeVisible();
    await expect(conditions).toHaveCount(9);
    await expect(readinessCard.locator('[data-state="met"]')).toHaveCount(8);
    const variables = readinessCard.getByTestId('fleet-condition-app_variables_permission');
    await expect(variables).toHaveAttribute('data-state', 'unmet');
    await expect(variables).toContainText(fs.cond.app_variables_permission.label);
    await expect(variables).toContainText(
      fill(fs.why.permission_missing, {
        org,
        permission: fs.permission.organization_actions_variables,
      }),
    );
    await expect(
      readinessCard
        .getByTestId('fleet-readiness-verdict')
        .getByText(fill(fs.readiness.unmetCount, { count: 1 }), { exact: true }),
    ).toBeVisible();
    await expect(settingSwitch).toBeDisabled();
    await expect(main.getByTestId('fleet-org-ci-blocked')).toHaveText(fs.blocked);
    expect(variableWrites()).toEqual([]);
    await beat();
  });

  armFleetControl({ orgs: { [org]: ready } });

  await chapter('Ready: every condition is met and ON is offered', async () => {
    await page.reload();
    await expect(
      readinessCard.getByTestId('fleet-readiness-verdict').getByText(fs.readiness.ready, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      readinessCard.getByText(fill(fs.readiness.readySub, { count: 9 }), { exact: true }),
    ).toBeVisible();
    await expect(readinessCard.locator('[data-state="met"]')).toHaveCount(9);
    await expect(settingSwitch).toBeEnabled();
    await expect(settingSwitch).toHaveAttribute('aria-checked', 'false');
  });

  // Case 7's tab: opened NOW, before the flip, so it still shows OFF when it presses.
  // Its own context, carrying the same session, so the lane's one recording stays this
  // page's.
  const otherContext = await browser.newContext({
    storageState: await page.context().storageState(),
  });
  const other = await otherContext.newPage();
  await other.goto(PAGE);
  await expect(other.getByRole('switch', { name: fs.setting.title })).toBeEnabled();
  await expect(other.getByRole('switch', { name: fs.setting.title })).toHaveAttribute(
    'aria-checked',
    'false',
  );

  await chapter('Turning ON with a blank reason is refused before anything is sent', async () => {
    const before = readFleetJournal().length;
    await settingSwitch.click();
    const dialog = page.getByRole('alertdialog', {
      name: fill(fs.confirm.onTitle, { org }),
    });
    await expect(dialog).toBeVisible();
    const reason = dialog.getByLabel(fs.confirm.reasonLabel);
    const confirm = dialog.getByRole('button', { name: fs.confirm.confirmOn, exact: true });
    await reason.fill('   ');
    await expect(confirm).toBeDisabled();
    await expect(dialog.getByText(fs.confirm.reasonHintEmpty, { exact: true })).toBeVisible();
    await beat();
    await dialog.getByRole('button', { name: fs.confirm.cancel, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // Nothing reached GitHub, let alone a write.
    expect(readFleetJournal().length).toBe(before);
    expect(await readSettingRow(seed)).toBeNull();
    expect(await countFleetAuditRows()).toBe(0);
  });

  await chapter('Turning ON with a reason: the page re-reads ON, who, why and GitHub', async () => {
    await flip(page, REASON_ON, fs.confirm.confirmOn);
    await expect(answer).toHaveText(fs.done.on);
    await expect(settingSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(main.getByText(fs.state.on, { exact: true })).toBeVisible();
    await expect(lastChanged).toContainText(`by ${OWNER},`);
    await expect(lastChanged).toContainText(`— “${REASON_ON}”`);
    await expect(variableLine).toHaveText(
      fill(fs.variable.present, { name: MOTIR_RUNNER_VARIABLE, value: MOTIR_RUNNER_LABEL, org }),
    );

    // Exactly ONE variable write, to the seeded org, carrying the label, private.
    const writes = variableWrites();
    expect(writes).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: `/orgs/${org}/actions/variables`,
        org: orgKey,
        status: 201,
        body: { name: MOTIR_RUNNER_VARIABLE, value: MOTIR_RUNNER_LABEL, visibility: 'private' },
      }),
    ]);
    expect(readStoredVariable(org, MOTIR_RUNNER_VARIABLE)).toEqual({
      value: MOTIR_RUNNER_LABEL,
      visibility: 'private',
    });
    expect(await readSettingRow(seed)).toMatchObject({ enabled: true, lastReason: REASON_ON });
    expect(await countFleetAuditRows()).toBe(1);
    await beat();
  });

  await chapter(
    'The tab opened before the flip turns ON again: already on, nothing written',
    async () => {
      const writesBefore = variableWrites().length;
      await flip(other, REASON_STALE, fs.confirm.confirmOn);
      const otherAnswer = other.getByRole('main').getByTestId('fleet-org-ci-answer');
      await expect(otherAnswer).toContainText(fs.refused.alreadyOn);
      await expect(otherAnswer).toHaveAttribute('data-tone', 'info');
      expect(variableWrites().length).toBe(writesBefore);
      expect(await countFleetAuditRows()).toBe(1);
      expect(await readSettingRow(seed)).toMatchObject({ enabled: true, lastReason: REASON_ON });
      await otherContext.close();
      // The recorded page still reads the first flip's actor and reason.
      await page.reload();
      await expect(lastChanged).toContainText(`— “${REASON_ON}”`);
    },
  );

  await chapter('GitHub refuses the OFF write: stated in words, and nothing changed', async () => {
    const rowBefore = await readSettingRow(seed);
    const variableBefore = readStoredVariable(org, MOTIR_RUNNER_VARIABLE);
    const auditBefore = await countFleetAuditRows();
    armFleetControl({ orgs: { [org]: { ...ready, failNextWrite: failNextWrite(403) } } });

    await flip(page, REASON_FAILED, fs.confirm.confirmOff);
    await expect(answer).toHaveAttribute('role', 'alert');
    await expect(answer).toContainText(
      fill(fs.refused.githubStatus, {
        direction: fs.direction.off,
        operation: fs.operation.delete,
        name: MOTIR_RUNNER_VARIABLE,
        org: orgKey,
        status: 403,
      }),
    );
    await expect(answer).toContainText(fs.refused.nothingChanged);
    await expect(settingSwitch).toHaveAttribute('aria-checked', 'true');

    expect(variableWrites().at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/orgs/${org}/actions/variables/${MOTIR_RUNNER_VARIABLE}`,
      status: 403,
    });
    expect(await readSettingRow(seed)).toEqual(rowBefore);
    expect(rowBefore).toMatchObject({ enabled: true });
    expect(readStoredVariable(org, MOTIR_RUNNER_VARIABLE)).toEqual(variableBefore);
    expect(variableBefore).toMatchObject({ value: MOTIR_RUNNER_LABEL });
    expect(await countFleetAuditRows()).toBe(auditBefore);
    await beat();
  });

  // The verdict stops being ready while the setting is ON: workflow_job unsubscribed.
  armFleetControl({ orgs: { [org]: { ...ready, events: ['pull_request'] } } });

  await chapter('Not ready while ON: OFF is still offered, and the page warns', async () => {
    await page.reload();
    await expect(
      readinessCard.getByTestId('fleet-condition-workflow_job_subscription'),
    ).toHaveAttribute('data-state', 'unmet');
    await expect(settingSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(settingSwitch).toBeEnabled();
    const degraded = main.getByTestId('fleet-org-ci-degraded');
    await expect(degraded).toContainText(fs.degraded.title);
    await expect(degraded).toContainText(fs.degraded.body);
    await expect(main.getByText(fs.offNeverBlocked, { exact: true })).toBeVisible();
    await beat();
  });

  await chapter('Turning OFF with a reason: GitHub-hosted again, the variable gone', async () => {
    const before = readFleetJournal().length;
    await flip(page, REASON_OFF, fs.confirm.confirmOff);
    await expect(answer).toHaveText(fs.done.off);
    await expect(settingSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(main.getByText(fs.state.off, { exact: true })).toBeVisible();
    await expect(lastChanged).toContainText(`— “${REASON_OFF}”`);
    await expect(variableLine).toHaveText(
      fill(fs.variable.absent, { name: MOTIR_RUNNER_VARIABLE, org }),
    );

    const flipWrites = variableWrites(readFleetJournal().slice(before));
    expect(flipWrites).toEqual([
      expect.objectContaining({
        method: 'DELETE',
        path: `/orgs/${org}/actions/variables/${MOTIR_RUNNER_VARIABLE}`,
        org: orgKey,
        status: 204,
      }),
    ]);
    expect(readStoredVariable(org, MOTIR_RUNNER_VARIABLE)).toBeNull();
    expect(await readSettingRow(seed)).toMatchObject({ enabled: false, lastReason: REASON_OFF });
    expect(await countFleetAuditRows()).toBe(2);
  });

  await chapter(
    'The audit log holds exactly the two flips, with who, why and which way',
    async () => {
      await page.goto(`/admin/audit-log?q=${encodeURIComponent(seed.projectKey)}`);
      await expect(page.getByRole('heading', { name: audit.title, level: 1 })).toBeVisible();
      const table = main.getByTestId('audit-table');
      const rows = table.locator('[data-testid^="audit-row-"]');
      await expect(rows).toHaveCount(2);

      // The chain, oldest first: ON (OFF → ON) then OFF (ON → OFF).
      const entries = await adminDb.platformAuditLog.findMany({
        where: { action: { startsWith: 'fleet.org_ci.' } },
        orderBy: { seq: 'asc' },
        select: { seq: true, action: true, reason: true, metadata: true },
      });
      expect(entries.map((e) => [e.action, e.reason])).toEqual([
        ['fleet.org_ci.enable', REASON_ON],
        ['fleet.org_ci.disable', REASON_OFF],
      ]);
      expect(entries[0]!.metadata).toMatchObject({ from: false, to: true, org: orgKey });
      expect(entries[1]!.metadata).toMatchObject({ from: true, to: false, org: orgKey });

      // On the page, newest first, each with the actor, the time and the reason.
      const expectRow = async (row: Locator, action: string, reason: string) => {
        await expect(row).toContainText(action);
        await expect(row).toContainText(OWNER);
        await expect(row).toContainText(reason);
        await expect(row.locator('time')).toHaveCount(1);
      };
      await expectRow(rows.nth(0), 'fleet.org_ci.disable', REASON_OFF);
      await expectRow(rows.nth(1), 'fleet.org_ci.enable', REASON_ON);

      // The direction, read from the entry the way an operator would open it.
      const enable = entries[0]!.seq;
      await table
        .getByRole('button', { name: fill(audit.detail.toggle, { n: enable }), exact: true })
        .click();
      const detail = main.getByTestId('audit-detail');
      await expect(detail).toContainText('"from": false');
      await expect(detail).toContainText('"to": true');
      await expect(detail).toContainText(literal(REASON_ON));
      await beat();
    },
  );
});
