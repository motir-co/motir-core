// E2E: FAN-OUT AND ISOLATION ON THE POSTGRES ENGINE
// (Story MOTIR-3415 · Subtask MOTIR-3462 — closes the Story.)
//
// @smoke — the story's `verification_recipe`, automated: with the fast lane
// routed to the new engine, ONE status transition driven through the UI still
// reaches all FOUR of its consumers, and one consumer's downstream failure does
// not take its siblings with it.
//
// ⚠️ A SEPARATE SPEC FROM `jobs-postgres-engine.spec.ts`, NOT AN EDIT TO IT.
// That one proves the pilot job's DLQ and REPLAY journey (MOTIR-3427); this one
// proves FAN-OUT and ISOLATION. Its retry / dead-letter coverage is not
// re-derived here — a duplicate suite is a maintenance cost with no new
// information. And `jobs-flow.spec.ts` is untouched: it proves the same journey
// on Inngest against the SAME server, which is the cutover switch's whole
// promise.
//
// ⚠️ THE TRANSITION IS DRIVEN THROUGH THE BROWSER, deliberately, and this is the
// point rather than a nicety. The defect that reshaped this story was precisely
// that the EMITTING process is not the process tests emit from: the engine's
// subscriber table is filled by module evaluation, and a Next.js request path
// had evaluated nothing, so `engineSubscribers` returned `[]` and a routed job
// ran on NEITHER lane. A spec calling `sendEvent` — or even the `_test`
// transport — would have passed against that broken code for a different reason
// than the product works. Clicking a control in a real browser against a real
// server is the only version that exercises the path a person takes.
//
// The `_test` transport is still used for SETUP (creating the tree), where the
// question is not which process emits.
//
// ⚠️ NO ACCEPTANCE VIDEO. This story ships no user-observable surface of its own
// — the board, the bell and the jobs dashboard all keep the shape they had — so
// it is a non-UI story and accepts on its tests. The surfaces here are
// instruments it READS, not surfaces it delivers.
//
// Every wait is on an authoritative signal — a committed row, an outbox entry, a
// DOM state the app renders. No `waitForTimeout`: the engine's backoff is ours
// (1s / 2s / 4s), so there is no vendor scheduler to sit out.
//
// ⚠️ EVERY DIRECT-DB CALL IS `adminDb`, THE OWNER CLIENT, for the reason
// `jobs-postgres-engine.spec.ts` records: `tests/rls/test-singleton-statement-guard.test.ts`
// RATCHETS singleton statements under `tests/e2e/**` and that ratchet only falls.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, adminDb, truncateJobTables } from './_helpers/db-reset';
import { waitForEmail, emailsTo } from './_helpers/email-capture';
import { armEmailFault, clearEmailFault } from './_helpers/email-fault';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { FAST_LANE_CONSUMER_IDS } from '@/lib/jobs/latencyBudget';

const PWD = 'fanout-e2e-pass-123';
const EMAIL_SEND = 'email.send';

/** The four consumers of `work-item/transitioned`, from the budget constant
 *  rather than a literal — a fifth consumer must not slip past this spec. */
const FAST_LANE = [...FAST_LANE_CONSUMER_IDS];

interface Tenant {
  workspaceId: string;
  projectId: string;
  ownerId: string;
  ownerEmail: string;
  watcherId: string;
  watcherEmail: string;
}

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobTables();
  await clearEmailFault();
  // The fast lane PLUS `email.send`, because the watcher notification's
  // deliverable is an email and the chain has to be on one lane end to end.
});

test.afterEach(async () => {
  // Unconditional, both: a spec that leaves the fault armed or the routing set
  // hands the next spec a server behaving differently from the one it was
  // written against — and `jobs-flow.spec.ts` asserts the opposite lane.
  await clearEmailFault();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

// ── setup ──────────────────────────────────────────────────────────────────

async function seedTenant(prefix: string): Promise<Tenant> {
  const ownerEmail = `${prefix}-owner@example.com`;
  const watcherEmail = `${prefix}-watcher@example.com`;
  const owner = await usersService.createUser({
    email: ownerEmail,
    password: PWD,
    name: 'Olivia Owner',
  });
  const watcher = await usersService.createUser({
    email: watcherEmail,
    password: PWD,
    name: 'Wendy Watcher',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Fanout Workspace',
    ownerUserId: owner.id,
  });
  await workspacesService.addMember({
    workspaceId: workspace.id,
    userId: watcher.id,
    workspaceRole: 'member',
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Fanout Project',
    identifier: 'FANOUT',
  });
  await adminDb.workspaceMembership.updateMany({
    where: { workspaceId: workspace.id },
    data: { activeProjectId: project.id },
  });
  return {
    workspaceId: workspace.id,
    projectId: project.id,
    ownerId: owner.id,
    ownerEmail,
    watcherId: watcher.id,
    watcherEmail,
  };
}

/** SETUP ONLY — the `_test` transport calls the shipped service paths. */
async function createItem(
  page: Page,
  projectId: string,
  kind: string,
  title: string,
  parentId?: string,
): Promise<{ id: string; identifier: string }> {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind, title, ...(parentId ? { parentId } : {}) },
  });
  expect(res.status(), `create ${kind} "${title}"`).toBe(201);
  return (await res.json()) as { id: string; identifier: string };
}

/** The TRANSITION UNDER TEST — through the detail rail's Status control, in the
 *  browser. Never the transport: see the header. */
/**
 * ⚠️ THE TARGET IS `In Progress`, NOT `Done`, AND THAT IS THE WORKFLOW'S RULE
 * RATHER THAN A PREFERENCE. The default workflow has NO direct `todo → done`
 * edge, so the status picker does not offer `Done` from `To Do` — an earlier
 * draft of this spec hung for 180s clicking an option that legitimately is not
 * there. `todo → in_progress` is a legal edge, it emits the same
 * `work-item/transitioned` event all four consumers subscribe to, and it derives
 * the parent to `in_progress` (rung 1 — `status-derivation.spec.ts`), so it
 * proves the fan-out with ONE transition instead of walking the whole ladder.
 */
async function transitionInTheUi(page: Page, identifier: string, to: string): Promise<void> {
  await page.goto(`/items/${identifier}`);
  await expect(page.getByRole('button', { name: 'Edit Status' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Edit Status' }).click();
  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: to }).click();
  // The optimistic cell settling is the app's own signal that the write landed.
  await expect(page.getByText(to, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
}

/** Poll the ledger for one consumer's terminal state. The authoritative signal. */
async function awaitRunState(
  workspaceId: string | null,
  functionId: string,
  state: string,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await adminDb.jobRun.findFirst({
            where: { functionId },
            orderBy: { startedAt: 'desc' },
          })
        )?.status ?? 'missing',
      { timeout: 60_000, intervals: [500], message: `awaiting ${functionId} → ${state}` },
    )
    .toBe(state);
}

// ── scenarios ──────────────────────────────────────────────────────────────

test('@smoke one UI transition fans out to all FOUR fast-lane consumers on the engine', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const t = await seedTenant('fanout-happy');
  await signIn(page, t.ownerEmail, PWD);

  const parent = await createItem(page, t.projectId, 'story', 'Parent story');
  const child = await createItem(page, t.projectId, 'subtask', 'Child subtask', parent.id);
  // A watcher who is NOT the actor — the notification consumers never
  // self-notify, so a single-user tenant would produce four green ledger rows
  // and no visible effect at all.
  await adminDb.watcher.create({ data: { workItemId: child.id, userId: t.watcherId } });

  // ── the EMPTY STATE first, so nothing below can pass on a pre-existing row ──
  expect(await adminDb.jobRun.count({ where: { functionId: { in: FAST_LANE } } })).toBe(0);
  expect(await adminDb.jobQueueRun.count({ where: { jobId: { in: FAST_LANE } } })).toBe(0);

  // ── ACT: one transition, driven in the browser ────────────────────────────
  await transitionInTheUi(page, child.identifier, 'In Progress');

  // ── FOUR ledger rows prove the FAN-OUT ────────────────────────────────────
  // Derived from the budget constant, so a fifth consumer fails this rather than
  // slipping past.
  for (const consumer of FAST_LANE) {
    await awaitRunState(t.workspaceId, consumer, 'succeeded');
  }
  const succeeded = await adminDb.jobRun.findMany({
    where: { functionId: { in: FAST_LANE }, status: 'succeeded' },
  });
  expect(new Set(succeeded.map((r) => r.functionId))).toEqual(new Set(FAST_LANE));

  // ── THREE visible effects prove the fan-out DID something ─────────────────

  // (1) status-derivation — the parent rolled up, where a person sees it.
  await expect
    .poll(
      async () => (await adminDb.workItem.findUniqueOrThrow({ where: { id: parent.id } })).status,
      { timeout: 60_000, intervals: [500], message: 'awaiting the parent rollup' },
    )
    .toBe('in_progress');
  await page.goto(`/items/${parent.identifier}`);
  await expect(page.getByText('In Progress', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });

  // (2) watcher-notify → email.send — the watcher's email is in the outbox.
  const mail = await waitForEmail(t.watcherEmail, { timeoutMs: 60_000 });
  expect(mail.subject.length).toBeGreaterThan(0);

  // (3) notification-fan-in — the bell entry, seen as the WATCHER.
  await expect
    .poll(async () => adminDb.notification.count({ where: { recipientUserId: t.watcherId } }), {
      timeout: 60_000,
      intervals: [500],
      message: 'awaiting the bell entry for the watcher',
    })
    .toBeGreaterThan(0);
  const watcherPage = await page.context().browser()!.newPage();
  try {
    await signIn(watcherPage, t.watcherEmail, PWD);
    await expect(watcherPage.getByRole('button', { name: /^Notifications,/ })).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await watcherPage.close();
  }
});

test('@smoke a faulted consumer does not take its SIBLINGS down with it', async ({ page }) => {
  test.setTimeout(180_000);
  const t = await seedTenant('fanout-isolation');
  await signIn(page, t.ownerEmail, PWD);

  const parent = await createItem(page, t.projectId, 'story', 'Isolation parent');
  const child = await createItem(page, t.projectId, 'subtask', 'Isolation child', parent.id);
  await adminDb.watcher.create({ data: { workItemId: child.id, userId: t.watcherId } });

  // Fault the WATCHER's address, so `watcher-notify`'s downstream send throws
  // while the other three consumers are untouched. This is the property the
  // dispatcher's header claims and its units assert at the ENQUEUE level — but
  // the enqueue is not where a real consumer fails.
  await armEmailFault('watcher');

  await transitionInTheUi(page, child.identifier, 'In Progress');

  // ⚠️ ASSERT THE SURVIVORS BY NAME, not merely that nothing threw. "Nothing
  // threw" is also true when nothing ran, which is the failure this exists to
  // catch.
  const survivors = FAST_LANE.filter((id) => id !== 'watcher-notify/transitioned');
  for (const consumer of survivors) {
    await awaitRunState(t.workspaceId, consumer, 'succeeded');
  }

  // The parent still rolled up — a person's view of the product is unaffected by
  // one notification channel's bad day.
  await expect
    .poll(
      async () => (await adminDb.workItem.findUniqueOrThrow({ where: { id: parent.id } })).status,
      { timeout: 60_000, intervals: [500] },
    )
    .toBe('in_progress');

  // And the faulted address really did receive nothing. Asserted AFTER the
  // survivors have all reached `succeeded`, so the window in which a watcher
  // email could have arrived has demonstrably elapsed — a bare check straight
  // after the transition would pass before anything had run at all.
  expect(await emailsTo(t.watcherEmail)).toHaveLength(0);
});

test('@smoke an invite still emails exactly once with the fast lane on the engine', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const t = await seedTenant('fanout-invite');
  await signIn(page, t.ownerEmail, PWD);

  const invitee = 'fanout-invitee@example.com';
  // ⚠️ RE-POINTED (MOTIR-3563). This read `/settings/workspace`, which
  // MOTIR-3500 (`ae6c791e`) made `notFound()` below the workspace-tier reveal
  // threshold — `WORKSPACE_TIER_REVEAL_MIN = 2`, and `seedTenant` above creates
  // exactly ONE workspace. So the page 404'd, the Invite button never mounted,
  // and `locator.click` waited out the full 120s budget on both attempts. The
  // affordance did not disappear: below the threshold the workspace sections
  // FOLD IN to `/settings/organization` (`WorkspaceFoldInSection` mounts the
  // very same `MembersCard`), which is where a one-workspace user actually
  // invites from. `workspace-flows.spec.ts` was re-pointed for this at the
  // time and this spec was missed — it is the only other one that reaches the
  // standalone area. Keep the tenant at one workspace: driving the invite from
  // the surface the user really has is the point, and seeding a second
  // workspace purely to reveal a settings area would test the wrong thing.
  await page.goto('/settings/organization');
  await page.getByRole('button', { name: 'Invite' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email address').fill(invitee);
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByText(`Invite sent to ${invitee}`, { exact: true }).first()).toBeVisible();

  await awaitRunState(null, EMAIL_SEND, 'succeeded');
  const mail = await waitForEmail(invitee, { timeoutMs: 60_000 });
  expect(mail.subject).toContain('invited to join');

  // ⚠️ EXACTLY ONE — one ledger row and one outbox entry for one user action.
  // The engine's dedup must not double-send, and equally must not swallow a
  // legitimate first send.
  expect(await adminDb.jobRun.count({ where: { functionId: EMAIL_SEND } })).toBe(1);
  expect(await emailsTo(invitee)).toHaveLength(1);

  // ⚠️ THE SAME-KEY DOUBLE-EMIT IS *NOT* ASSERTED HERE, AND CANNOT BE FROM ANY
  // UI PATH. `workspaceInvitesService` calls `generateToken()` unconditionally
  // (one call site, no reuse branch) and uses that token AS the idempotency key,
  // so two invites to one address are two DIFFERENT invites with two different
  // keys and correctly produce two emails. MOTIR-3462's criterion "two invites
  // with the same idempotency key produce exactly ONE outbox entry" describes a
  // journey the product does not have.
  //
  // The guarantee itself is real and IS proven, one tier down and against real
  // Postgres:
  //   - `tests/jobs/engine-idempotency.test.ts` — two same-key events, one queued
  //     run, including a genuinely CONCURRENT duplicate;
  //   - `tests/jobs/event-cutover-story-gate.test.ts` §1 — two same-key events,
  //     one delivery, read back through the operator DTO.
  // Amended on the card, with the planning bug filed under MOTIR-1465.
});
