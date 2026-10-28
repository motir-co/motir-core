// E2E: the story's operator journey ON THE POSTGRES ENGINE
// (Story MOTIR-3414 · Subtask MOTIR-3427 — closes the Story).
//
// @smoke — the story's `verification_recipe`, automated: trigger the pilot job
// on the NEW engine, watch its run land in the ledger and succeed, then force it
// to fail until it dead-letters. (The dashboard steps and the tenant Replay
// scenario were retired with the tenant Job runs surface — see the note at the
// end of the file.)
//
// ⚠️ WHY THIS IS A SEPARATE SPEC FROM `jobs-flow.spec.ts` RATHER THAN AN EDIT TO
// IT. That spec proves the same journey on INNGEST, and this story does not
// migrate `email.send` — the event cutover is MOTIR-3415's. So the two run
// side by side against the SAME server, which is the whole promise of the
// per-job cutover switch and is worth having a test demonstrate rather than
// assert about. The routing is per-spec (a file the switch reads; see
// `_helpers/job-routing.ts`) and is cleared in `afterEach`, so nothing here
// changes which lane any other spec's jobs run on.
//
// ⚠️ THE PILOT JOB IS `email.send`, chosen because it is the one job with a real
// UI trigger (an invite), a deterministic fault seam, and an observable outcome
// (the outbox) — the same three properties that made it MOTIR-65's subject.
// Routing it here for the length of this spec is NOT the production cutover: that
// is an operator setting `MOTIR_POSTGRES_JOB_IDS`, and which job goes first is
// their call.
//
// ⚠️ AND THE LANE RUNS A THIRD PROCESS. The engine's worker is its own process
// group by design (MOTIR-3421), so a run queued onto it has nothing to claim it
// unless the lane starts one — `globalSetup` does, from the SHIPPED BUNDLE, so
// this spec exercises the packaging and not merely the source. MOTIR-3427's
// original "no bespoke server configuration" criterion could not hold against
// its own architecture and was amended to say so (planning bug MOTIR-3429).
//
// TIMING, and the difference is worth noticing. The Inngest spec's forced-failure
// scenario needs ~150s because it waits out Inngest's real backoff (≈0s / 30s /
// 72s). This engine's backoff is ours — `retryBackoffMs`, 1s / 2s / 4s with
// jitter — so the same journey finishes in seconds. That is a property of owning
// the substrate, not a shortcut: the same three attempts still run.

import { expect, test, type Page } from '@playwright/test';
import { adminDb, resetDatabase, truncateJobTables } from './_helpers/db-reset';
import { waitForEmail } from './_helpers/email-capture';
import { armEmailFault, clearEmailFault } from './_helpers/email-fault';
import { startSignedOut } from './_helpers/shell-session';
import { isLandedWorkbenchUrl } from './_helpers/workbench-landing';

// ⚠️ EVERY DIRECT-DB CALL HERE IS `adminDb`, THE OWNER CLIENT — not the runtime
// singleton, which is what `jobs-flow.spec.ts` and most of this lane still use.
// Two reasons, and neither is style:
//
//   * It is what the client is FOR. These are post-condition assertions and a
//     TRUNCATE. `adminDb`'s own header says so, and `TRUNCATE` requires table
//     ownership outright — the runtime role cannot perform it and must never be
//     granted the ability.
//   * `tests/rls/test-singleton-statement-guard.test.ts` RATCHETS the count of
//     singleton statements under `tests/e2e/**`, and that ratchet only ever
//     falls. Writing this spec the way its sibling is written added 13 to it and
//     turned the guards job red. Converting is the fix; raising the ceiling is
//     the one move that guard exists to refuse.
const PASSWORD = 'pg-engine-spec-pass-123';
const PILOT_JOB = 'email.send';

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobTables();
  await clearEmailFault();
  // Route the pilot onto the new engine for THIS spec only.
});

test.afterEach(async () => {
  // Unconditional, both of them: a spec that leaves the fault armed or the
  // routing set hands the next spec a server behaving differently from the one
  // it was written against — and `jobs-flow.spec.ts` asserts the opposite lane.
  await clearEmailFault();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

// ── helpers ────────────────────────────────────────────────────────────────

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

async function workspaceIdFor(email: string): Promise<string> {
  const local = email.split('@')[0]!;
  const ws = await adminDb.workspace.findFirst({ where: { name: `${local}'s Workspace` } });
  expect(ws, `auto-created workspace for ${email} should exist`).not.toBeNull();
  return ws!.id;
}

/** Trigger the pilot job the way a user does: send an invite, which emits `email.send`. */
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

test('@smoke the pilot job runs on the POSTGRES ENGINE and lands in the same ledger', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const owner = 'pge-happy-owner@example.com';
  const invitee = 'pge-happy-invitee@example.com';
  await signUp(page, owner);
  const workspaceId = await workspaceIdFor(owner);

  await sendInvite(page, invitee);

  // ── it went to the NEW engine ────────────────────────────────────────────
  // The authoritative signal is the committed row, not the UI: `sendEvent` wrote
  // one `job_event` and the dispatcher enqueued one `job_queue` run for the
  // pilot. Nothing else in the product produces those rows.
  await expect
    .poll(async () => adminDb.jobQueueRun.count({ where: { jobId: PILOT_JOB } }), {
      timeout: 30_000,
      intervals: [500],
    })
    .toBe(1);
  expect(await adminDb.jobEvent.count({ where: { name: PILOT_JOB } })).toBe(1);

  // ── the worker claimed it and it succeeded ───────────────────────────────
  await expect
    .poll(
      async () =>
        (await adminDb.jobQueueRun.findFirst({ where: { jobId: PILOT_JOB } }))?.state ?? 'missing',
      { timeout: 30_000, intervals: [500] },
    )
    .toBe('succeeded');

  // The handler really ran: the invite email is in the outbox.
  const email = await waitForEmail(invitee);
  expect(email.subject).toContain('invited to join');

  // ── the LEDGER is indistinguishable from an Inngest-backed run ───────────
  // This is the story's actual promise. Same table, same status, same shape —
  // exactly one row, which is what the memoized `job-run:start` guarantees.
  await expect
    .poll(async () =>
      adminDb.jobRun.count({ where: { workspaceId, functionId: PILOT_JOB, status: 'succeeded' } }),
    )
    .toBe(1);
  expect(await adminDb.jobRun.count({ where: { workspaceId, status: 'failed' } })).toBe(0);
});

test('@smoke a failing pilot run retries on the engine’s own backoff, then dead-letters', async ({
  page,
}) => {
  // Seconds, not the ~150s the Inngest spec needs — see the TIMING note above.
  test.setTimeout(120_000);

  const owner = 'pge-fail-owner@example.com';
  // The recipient carries the armed substring, so every attempt's send throws.
  const invitee = 'pge-fail-forcefail@example.com';
  await signUp(page, owner);
  const workspaceId = await workspaceIdFor(owner);

  await armEmailFault('forcefail');
  await sendInvite(page, invitee);

  // The retry budget runs out and the terminal-failure hook writes BOTH rows —
  // the `failed` ledger row and the dead-letter row — in one transaction.
  await expect
    .poll(
      async () => ({
        failed: await adminDb.jobRun.count({ where: { workspaceId, status: 'failed' } }),
        dlq: await adminDb.jobRunDlq.count({ where: { workspaceId } }),
      }),
      { timeout: 90_000, intervals: [1_000] },
    )
    .toEqual({ failed: 1, dlq: 1 });

  // The queue row is terminal too, and carries the reason an operator needs.
  // The worker writes the ledger and dead-letter rows FIRST and marks the queue
  // row failed in a later transaction (lib/jobs/engine/worker.ts), so seeing the
  // two rows above does not mean the queue row has settled yet: wait for it.
  await expect
    .poll(
      async () =>
        (await adminDb.jobQueueRun.findFirst({ where: { jobId: PILOT_JOB } }))?.state ?? 'missing',
      { timeout: 10_000, intervals: [250] },
    )
    .toBe('failed');
  const queued = await adminDb.jobQueueRun.findFirstOrThrow({ where: { jobId: PILOT_JOB } });
  expect(queued.attempts).toBe(3); // `transient` = 3 total attempts, preserved
  expect(queued.lastError).not.toBeNull();

  // The dead-letter row records the full budget and has not been replayed.
  const dlqRow = await adminDb.jobRunDlq.findFirstOrThrow({ where: { workspaceId } });
  expect(dlqRow.attempts).toBe(3);
  expect(dlqRow.replayedAt).toBeNull();
});

// ⚠️ FOUR DASHBOARD STEPS AND THREE SCENARIOS STOOD HERE, AND THEIR SURFACE IS
// GONE (Story MOTIR-9982 · MOTIR-10042).
//
// The two scenarios above each finished on the tenant Job runs dashboard, and
// three more were driven through it alone: an owner pressing Replay on a
// dead letter the engine had earned, and the runs table's two empty states. The
// tenant dashboard and its replay action are retired; the ledger is staff-only
// at `/admin/jobs`. The ledger rows those scenarios read are asserted above
// through the database, which is what this spec proves about the engine. An
// operator replaying a real dead letter that the worker then re-runs is
// `acceptance-admin-jobs.spec.ts`'s journey, on the surface that owns it now.

// ⚠️ A SCENARIO STOOD HERE AND ITS SUBJECT IS GONE (MOTIR-3418).
//
// "a job NOT routed to the engine still runs on Inngest — the 23 this story does
// not move": it cleared the routing, sent the same invite, and asserted the
// email arrived, the ledger carried a `succeeded` row, and the engine's own
// tables were EMPTY — no `job_event`, no `job_queue`. It was the negative
// direction of the cutover switch driven through the real product, and it needed
// a 150 s budget because the vendor's dev server had to receive the event, match
// the function and invoke it over HTTP.
//
// There is no second lane for a job to run on instead, so the assertion cannot be
// written. What it protected — that a job's runs reach the ledger, and that the email actually lands — is the POSITIVE scenario above,
// which drives the same invite through the same seam and now covers every job
// rather than the one that had been routed.
