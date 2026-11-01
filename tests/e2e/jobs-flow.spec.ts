// E2E: the Story-1.6 jobs flow, end to end through the REAL runtime (Subtask
// 1.6.6 — closes the Story).
//
// @smoke — proves the background-jobs stack (the defineJob runtime and the retry
// + dead-letter patterns) holds together against a forced failure, driven
// through the running Next server + the engine's worker (a child of the
// Playwright runner, started by `globalSetup`) + Postgres.
//
// Both scenarios drive a REAL job: an invite enqueues `email.send`, the worker
// claims and runs it, and we assert what actually landed in the ledger. That
// real path is the whole point — it's what caught PRODECT_FINDINGS #39 (the
// 1.6.4 dead-letter write never ran on the real executor; only the in-process
// unit harness made it look like it did).
//
// ⚠️ NO DASHBOARD STEP (Story MOTIR-9982 · MOTIR-10042). The tenant Job runs
// surface these scenarios used to finish on is retired; the ledger is staff-only
// at `/admin/jobs` now, whose own specs cover its reads and its operator replay
// door (`tests/e2e/acceptance-admin-jobs.spec.ts`). The ledger rows are what this spec
// proves about the engine, and they are asserted through the database.
//
// TIMING. The forced-failure path runs the full transient retry budget (3
// attempts) before the terminal-failure hook dead-letters. The engine's backoff
// is `retryBackoffMs` — doubling from one second with ±20% jitter — so that is a
// few seconds rather than the ~90s the vendor's ≈ 0s / 30s / 72s cost
// (MOTIR-3418). Its test keeps a generous timeout: the assertion polls, so a
// budget that is larger than it needs to be costs nothing and a tight one turns a
// loaded runner into a flake.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db, truncateJobTables } from './_helpers/db-reset';
import { waitForEmail } from './_helpers/email-capture';
import { armEmailFault, clearEmailFault } from './_helpers/email-fault';
import { startSignedOut } from './_helpers/shell-session';
import { isLandedWorkbenchUrl } from './_helpers/workbench-landing';

const PASSWORD = 'jobs-flow-spec-pass-123';

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobTables();
  await clearEmailFault();
});

test.afterEach(async () => {
  // Never let an armed fault leak into the next spec sharing the dev server.
  await clearEmailFault();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── helpers ────────────────────────────────────────────────────────────────

// Sign up a fresh user via the two-step credentials flow → lands on /dashboard
// with the auto-created "{local}'s Workspace" active (the signer is its owner,
// per the Story-1.2 role-reconciliation finding #36). Single deterministic
// submit — the E2E dev server runs with E2E_DISABLE_RATE_LIMIT=1, so there's no
// 429 to retry around (see shell-session.ts for the rationale).
async function signUp(page: Page, email: string): Promise<void> {
  await startSignedOut(page);
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(PASSWORD);
  await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
  // ⚠️ A registration lands on the onboarding ENTRANCE (MOTIR-4871); this
  // helper keeps its contract by settling there and navigating on.
  await page.waitForURL('**/onboarding', { timeout: 30_000 });
  await page.goto('/workbench');
  await page.waitForURL(isLandedWorkbenchUrl, { timeout: 30_000 });
}

// The signed-up user's auto-created workspace is "{local-part}'s Workspace".
async function workspaceIdFor(email: string): Promise<string> {
  const local = email.split('@')[0]!;
  const ws = await db.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(ws, `auto-created workspace for ${email} should exist`).not.toBeNull();
  return ws!.id;
}

// Send an invite to `inviteeEmail` from the active workspace's settings page.
async function sendInvite(page: Page, inviteeEmail: string): Promise<void> {
  // ⚠️ `/settings/organization` (MOTIR-3502 · organization-tier.md §6d). These
  // fixtures use an auto-created single workspace — the COLLAPSED state, where
  // the workspace area 404s and its Members card (with this Invite button) is
  // hosted by the single Settings home instead.
  await page.goto('/settings/organization');
  await page.getByRole('button', { name: 'Invite' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email address').fill(inviteeEmail);
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  await expect(
    page.getByText(`Invite sent to ${inviteeEmail}`, { exact: true }).first(),
  ).toBeVisible();
}

// ── scenarios ──────────────────────────────────────────────────────────────

test('@smoke happy path: an invite enqueues email.send, which succeeds in the ledger', async ({
  page,
}) => {
  const owner = 'jf-happy-owner@example.com';
  const invitee = 'jf-happy-invitee@example.com';
  await signUp(page, owner);
  const workspaceId = await workspaceIdFor(owner);

  await sendInvite(page, invitee);

  // The invite email actually lands in the outbox (the job ran the provider).
  const email = await waitForEmail(invitee);
  expect(email.subject).toContain('invited to join');

  // The ledger has exactly one succeeded email.send run for this workspace.
  await expect
    .poll(async () =>
      db.jobRun.count({ where: { workspaceId, functionId: 'email.send', status: 'succeeded' } }),
    )
    .toBe(1);
  expect(await db.jobRun.count({ where: { workspaceId, status: 'failed' } })).toBe(0);
});

test('@smoke forced failure: a failing send retries to exhaustion, then dead-letters', async ({
  page,
}) => {
  // Full transient retry budget runs on the real backoff before onFailure fires.
  test.setTimeout(180_000);

  const owner = 'jf-fail-owner@example.com';
  // The recipient contains the armed substring, so its send throws every attempt.
  const invitee = 'jf-fail-forcefail@example.com';
  await signUp(page, owner);
  const workspaceId = await workspaceIdFor(owner);

  await armEmailFault('forcefail');
  await sendInvite(page, invitee);

  // After 3 attempts exhaust, onFailure writes the failed run + the DLQ row.
  await expect
    .poll(
      async () => ({
        failed: await db.jobRun.count({ where: { workspaceId, status: 'failed' } }),
        dlq: await db.jobRunDlq.count({ where: { workspaceId } }),
      }),
      { timeout: 150_000, intervals: [2_500] },
    )
    .toEqual({ failed: 1, dlq: 1 });

  // The dead-letter row recorded the full 3 attempts (the retry budget + 1).
  const dlqRow = await db.jobRunDlq.findFirst({ where: { workspaceId } });
  expect(dlqRow!.attempts).toBe(3);
  expect(dlqRow!.replayedAt).toBeNull();
});
