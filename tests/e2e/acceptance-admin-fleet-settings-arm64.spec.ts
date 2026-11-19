import type { Page, Response } from '@playwright/test';
import { expect, test } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { resetBillingFixture, seedBillingOwner } from './_helpers/billing';
import {
  armFleetControl,
  pickRunnableRepo,
  readStoredVariable,
  readyOrgControl,
  resetFleetSeam,
  seedMotirCiTarget,
  variableWrites,
} from './_helpers/fleet-org-ci';
import {
  MOTIR_ARM64_RUNNER_LABEL,
  MOTIR_RUNNER_ARM64_VARIABLE,
  MOTIR_RUNNER_LABEL,
  MOTIR_RUNNER_VARIABLE,
} from '@/lib/ciFleet/config';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-11779 — arm64 CI jobs run on a Graviton fleet runner (MOTIR-11788).
 *
 * The assembled `/admin/fleet-settings` surface, served by the acceptance lane's real
 * Next server against the real test database, with only api.github.com faked at the
 * transport (`lib/test-github-fleet-org-ci-mock.ts`). A superadmin walks the story's
 * verification recipe steps 1–3 and 7 on the CI fleet switch's arm64 line:
 *
 *  1. No arm64 runner AMI pinned: the arm64 row reads not set, with the not-ready
 *     reason in words; the x86 verdict and switch are exactly as before.
 *  2. ON: `MOTIR_RUNNER` is written and shows set; nothing names `MOTIR_RUNNER_ARM64`.
 *  3. OFF: `MOTIR_RUNNER` is gone; the arm64 row still reads not set, no error.
 *  7. An arm64 AMI pinned (armed through the seam's control key — the lane's one
 *     server cannot be restarted with a new env mid-spec): the row reads ready; ON
 *     writes both variables and both show set; OFF deletes both.
 *
 * Every flip assertion waits on the flip's Server Action response, armed before the
 * confirm press, or on a reload, the seam's journal or its stored variables — never on
 * the optimistic UI or a timeout. The label is imported, never written as a literal.
 */

const fs = enMessages.platformAdmin.fleetSettings;
const OWNER = 'acceptance-fleet-arm64-owner@example.com';
const PAGE = '/admin/fleet-settings';
const ARM64_AMI_ID = 'ami-0a64a64a64a64a64a';

const REASON_ON_UNPINNED = 'Fleet pilot for x86 jobs while the arm64 AMI is being built';
const REASON_OFF_UNPINNED = 'Pausing the pilot before the arm64 AMI lands';
const REASON_ON_PINNED = 'arm64 AMI is pinned: move arm64 jobs onto Graviton runners';
const REASON_OFF_PINNED = 'Rolling the fleet back to GitHub-hosted runners';

/** Fill a catalogue message's simple `{name}` placeholders. */
function fill(message: string, values: Record<string, string | number>): string {
  return message.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}

/** Arm the wait for the flip's Server Action BEFORE the press, so it cannot be missed. */
function flipResponse(p: Page): Promise<Response> {
  return p.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      r.request().headers()['next-action'] !== undefined &&
      new URL(r.url()).pathname === PAGE,
  );
}

/** Press the switch, give the reason, confirm; resolves on the action's 200. */
async function flip(p: Page, reason: string, confirmLabel: string): Promise<void> {
  await p.getByRole('switch', { name: fs.setting.title }).click();
  const dialog = p.getByRole('alertdialog');
  await dialog.getByLabel(fs.confirm.reasonLabel).fill(reason);
  const answered = flipResponse(p);
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
  expect((await answered).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
}

test('a superadmin sees the arm64 line: not ready with no arm64 AMI, both variables set when pinned, both gone on OFF', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-11779');
  test.setTimeout(180_000);

  const repo = pickRunnableRepo();
  await resetDatabase();
  resetBillingFixture();
  resetFleetSeam();
  const seed = await seedMotirCiTarget(repo);
  const org = seed.org;
  const ready = readyOrgControl(repo);
  // Not pinned, stated rather than left to the lane's env.
  armFleetControl({ orgs: { [org]: ready }, arm64RunnerAmiId: null });

  await seedBillingOwner(page, OWNER);
  await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'superadmin' } });

  const main = page.getByRole('main');
  const settingSwitch = page.getByRole('switch', { name: fs.setting.title });
  const verdict = main.getByTestId('fleet-readiness').getByTestId('fleet-readiness-verdict');
  const variableLine = main.getByTestId('fleet-org-ci-variable');
  const arm64Line = main.getByTestId('fleet-org-ci-arm64-variable');
  const arm64Readiness = main.getByTestId('fleet-org-ci-arm64-readiness');
  const arm64Reason = main.getByTestId('fleet-org-ci-arm64-not-ready-reason');
  const answer = main.getByTestId('fleet-org-ci-answer');

  const x86Present = fill(fs.variable.present, {
    name: MOTIR_RUNNER_VARIABLE,
    value: MOTIR_RUNNER_LABEL,
    org,
  });
  const x86Absent = fill(fs.variable.absent, { name: MOTIR_RUNNER_VARIABLE, org });
  const arm64Present = fill(fs.variable.arm64.present, {
    name: MOTIR_RUNNER_ARM64_VARIABLE,
    value: MOTIR_ARM64_RUNNER_LABEL,
    org,
  });
  const arm64Absent = fill(fs.variable.arm64.absent, { name: MOTIR_RUNNER_ARM64_VARIABLE, org });
  const notPinned = fs.arm64Readiness.reasons.arm64_runner_ami_not_pinned;

  await chapter('No arm64 AMI pinned: the arm64 line reads not set, and why', async () => {
    await page.goto(PAGE);
    await expect(page.getByRole('heading', { name: fs.title, level: 1 })).toBeVisible();
    // The x86 verdict is unchanged: arm64 adds no readiness condition.
    await expect(verdict.getByText(fs.readiness.ready, { exact: true })).toBeVisible();
    await expect(settingSwitch).toBeEnabled();
    await expect(settingSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(variableLine).toHaveText(x86Absent);
    await expect(arm64Line).toContainText(arm64Absent);
    await expect(arm64Readiness).toHaveAttribute('data-ready', 'false');
    await expect(arm64Readiness).toHaveAttribute('data-reason', 'arm64_runner_ami_not_pinned');
    await expect(arm64Readiness).toContainText(fs.arm64Readiness.notReadyLabel);
    await expect(arm64Reason).toHaveText(notPinned);
    await beat();
  });

  await chapter('Turning ON unpinned: only MOTIR_RUNNER is written', async () => {
    const before = variableWrites().length;
    await flip(page, REASON_ON_UNPINNED, fs.confirm.confirmOn);
    await expect(answer).toHaveText(fs.done.on);
    await expect(settingSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(variableLine).toHaveText(x86Present);
    await expect(arm64Line).toContainText(arm64Absent);
    await expect(arm64Reason).toHaveText(notPinned);

    const writes = variableWrites().slice(before);
    expect(writes).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: `/orgs/${org}/actions/variables`,
        status: 201,
        body: { name: MOTIR_RUNNER_VARIABLE, value: MOTIR_RUNNER_LABEL, visibility: 'private' },
      }),
    ]);
    expect(JSON.stringify(writes)).not.toContain(MOTIR_RUNNER_ARM64_VARIABLE);
    expect(readStoredVariable(org, MOTIR_RUNNER_VARIABLE)).toEqual({
      value: MOTIR_RUNNER_LABEL,
      visibility: 'private',
    });
    expect(readStoredVariable(org, MOTIR_RUNNER_ARM64_VARIABLE)).toBeNull();
    await beat();
  });

  await chapter('Turning OFF unpinned: MOTIR_RUNNER is gone, and no error', async () => {
    const before = variableWrites().length;
    await flip(page, REASON_OFF_UNPINNED, fs.confirm.confirmOff);
    await expect(answer).toHaveText(fs.done.off);
    await expect(answer).not.toHaveAttribute('role', 'alert');
    await expect(settingSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(variableLine).toHaveText(x86Absent);
    await expect(arm64Line).toContainText(arm64Absent);

    const writes = variableWrites().slice(before);
    expect(writes[0]).toMatchObject({
      method: 'DELETE',
      path: `/orgs/${org}/actions/variables/${MOTIR_RUNNER_VARIABLE}`,
    });
    // Deleting the absent arm64 variable, if sent, is a DELETE GitHub answers 404 —
    // which the flip treats as already gone.
    for (const write of writes.slice(1)) {
      expect(write).toMatchObject({
        method: 'DELETE',
        path: `/orgs/${org}/actions/variables/${MOTIR_RUNNER_ARM64_VARIABLE}`,
      });
    }
    expect(readStoredVariable(org, MOTIR_RUNNER_VARIABLE)).toBeNull();
    expect(readStoredVariable(org, MOTIR_RUNNER_ARM64_VARIABLE)).toBeNull();
    await beat();
  });

  armFleetControl({ orgs: { [org]: ready }, arm64RunnerAmiId: ARM64_AMI_ID });

  await chapter('An arm64 AMI is pinned: the arm64 pool reads ready', async () => {
    await page.reload();
    await expect(arm64Readiness).toHaveAttribute('data-ready', 'true');
    await expect(arm64Readiness).toContainText(fs.arm64Readiness.readyLabel);
    await expect(arm64Readiness).toContainText(
      fill(fs.arm64Readiness.ready, { name: MOTIR_RUNNER_ARM64_VARIABLE }),
    );
    await expect(arm64Reason).toHaveCount(0);
    await expect(arm64Line).toContainText(arm64Absent);
    await expect(settingSwitch).toHaveAttribute('aria-checked', 'false');
    await beat();
  });

  await chapter('Turning ON pinned: both variables are written and both show set', async () => {
    const before = variableWrites().length;
    await flip(page, REASON_ON_PINNED, fs.confirm.confirmOn);
    await expect(answer).toHaveText(fs.done.on);
    await expect(variableLine).toHaveText(x86Present);
    await expect(arm64Line).toContainText(arm64Present);
    await beat();

    const writes = variableWrites().slice(before);
    expect(writes).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: `/orgs/${org}/actions/variables`,
        status: 201,
        body: { name: MOTIR_RUNNER_VARIABLE, value: MOTIR_RUNNER_LABEL, visibility: 'private' },
      }),
      expect.objectContaining({
        method: 'POST',
        path: `/orgs/${org}/actions/variables`,
        status: 201,
        body: {
          name: MOTIR_RUNNER_ARM64_VARIABLE,
          value: MOTIR_ARM64_RUNNER_LABEL,
          visibility: 'private',
        },
      }),
    ]);
    expect(readStoredVariable(org, MOTIR_RUNNER_VARIABLE)).toEqual({
      value: MOTIR_RUNNER_LABEL,
      visibility: 'private',
    });
    expect(readStoredVariable(org, MOTIR_RUNNER_ARM64_VARIABLE)).toEqual({
      value: MOTIR_ARM64_RUNNER_LABEL,
      visibility: 'private',
    });

    // GitHub's read-back, not the action's answer: a reload still reads both set.
    await page.reload();
    await expect(settingSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(variableLine).toHaveText(x86Present);
    await expect(arm64Line).toContainText(arm64Present);
    await beat();
  });

  await chapter('Turning OFF pinned: both variables are deleted', async () => {
    const before = variableWrites().length;
    await flip(page, REASON_OFF_PINNED, fs.confirm.confirmOff);
    await expect(answer).toHaveText(fs.done.off);
    await expect(settingSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(variableLine).toHaveText(x86Absent);
    await expect(arm64Line).toContainText(arm64Absent);
    await expect(arm64Readiness).toHaveAttribute('data-ready', 'true');

    expect(variableWrites().slice(before)).toEqual([
      expect.objectContaining({
        method: 'DELETE',
        path: `/orgs/${org}/actions/variables/${MOTIR_RUNNER_VARIABLE}`,
      }),
      expect.objectContaining({
        method: 'DELETE',
        path: `/orgs/${org}/actions/variables/${MOTIR_RUNNER_ARM64_VARIABLE}`,
      }),
    ]);
    expect(readStoredVariable(org, MOTIR_RUNNER_VARIABLE)).toBeNull();
    expect(readStoredVariable(org, MOTIR_RUNNER_ARM64_VARIABLE)).toBeNull();

    await page.reload();
    await expect(variableLine).toHaveText(x86Absent);
    await expect(arm64Line).toContainText(arm64Absent);
    await beat();
  });
});
