// E2E — the PLANNER SPEAKS in the plan-change thread (Subtask MOTIR-2226,
// consuming MOTIR-2222; design `design/ai-chat/` § "The planner SPEAKS…").
//
// Drives the whole loop from the user's seat: a planning turn comes back with a
// QUESTION, the rail shows it and the composer asks for the answer, the reply is
// sent, and the thread resumes — plus the two things the design says must hold
// beyond the happy path: the pending state SURVIVES A RELOAD (it is derived from
// the persisted thread, not from client state), and a question the user ignores
// is SUPERSEDED rather than dropped or blocking.
//
// DETERMINISM (`notes.html` #37 · `motir-core/CLAUDE.md` § E2E waits on the
// authoritative signal). Every assertion here waits on a real response or a real
// DOM state; there is no `waitForTimeout` anywhere in the file.
//
// WHAT IS STUBBED, and why only this. motir-ai has no presence in CI, so the two
// hops that reach it are faked at the BROWSER boundary — the only interceptable
// seam (a server-side fetch out of a route handler is not reachable from
// `page.route`; mistakes #112 / #152): the SUBMIT, and the planner-turn
// recording, whose real route would call motir-ai's `GET /v1/jobs/:id`.
//
// Everything else is REAL, and deliberately so — the point of the card is that
// the planner's turn is a PERSISTED row rather than client chrome, and a spec
// that faked the thread would prove nothing about that:
//   • the assistant turn is written to Postgres by the stub (through the same
//     locked service append the route would have used), so the rail renders a
//     genuine row;
//   • the thread the rail shows is re-read through the real open/resume endpoint;
//   • the ANSWER is a real `POST …/session/turns` against motir-core + Postgres;
//   • the reload re-reads that thread from the database, which is the whole
//     assertion.

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { persistAskTurn, readNamedSession } from './_helpers/plan-session-turn';
import { seedAiAugmentReplan, markProjectOnboarded } from './_helpers/ai-augment-replan-seed';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { jobStreamBody } from './_helpers/job-stream-frames';

// ⚠️ RE-POINTED FOR THE OVERLAY (MOTIR-4732, story MOTIR-4725). The planning
// workspace was a ROUTE at `/planning`; it is a full-screen OVERLAY on the page
// you are already on. So an address that used to BE the workspace is now a host
// page plus four namespaced parameters, and a `waitForURL` that matched the old
// path matches nothing. The assertions about what the workspace DOES are
// unchanged — only how it is reached and how its arrival is detected.
//
// (`/planning?…` still resolves: `app/(authed)/planning/page.tsx` forwards an old
// link to the host page it belonged to. Its own coverage is in
// `tests/integration/planning/planChangeSeams.test.ts`; these specs address the
// overlay directly, which is what a reader would write today.)

test.describe.configure({ timeout: 120_000 });

const QUESTION = 'Taking money in from customers, or paying suppliers out?';
const REPORT = 'I searched the plan for payments. Nothing matched.';

const AI_ACCESS_NA = {
  applicable: false,
  organizationId: null,
  organizationName: null,
  canManageBilling: false,
  hasPaidAiPlan: false,
  balance: 0,
  tierName: null,
  tierAllotment: null,
  renewsAt: null,
};

async function stubAiAccess(page: Page): Promise<void> {
  await page.route('**/api/ai/access', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AI_ACCESS_NA),
    });
  });
}

/**
 * The DOOR — the only part of sending a turn that reaches motir-ai.
 *
 * ⚠️ IT MOVED (MOTIR-1343). A project turn used to append through
 * `…/session/turns` (pure database) and submit separately through
 * `…/session/submit`; it now posts to `POST /api/ai/ask`, which appends AND
 * runs. This spec is about what the PLANNER says, not about how a turn is
 * classified, so the door is answered with the REDIRECT — the shape a
 * plan-change turn produces — and everything downstream is the shipped
 * plan-edit tail exactly as before.
 *
 * The turn itself is still appended FOR REAL, through the shipped append route,
 * so the thread the rail reads back is the persisted one. That is the half a
 * stub must never fake here: these tests assert what is ON the thread.
 */
async function stubSubmit(page: Page, jobId: string): Promise<void> {
  await page.route('**/api/ai/ask', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    // Through the real session doors — the held session, or a first turn that
    // starts one (MOTIR-6023) — carrying the answer-bar flag as the ask door does.
    const appended = await persistAskTurn(route);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        outcome: 'redirected',
        jobId,
        planId: null,
        session: await appended.json(),
      }),
    });
  });
}

/** The augment job's SSE — the REAL frame vocabulary the rail narrates. */
async function stubStream(page: Page, jobId: string): Promise<void> {
  await page.route(`**/api/ai/augment/${jobId}/stream`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      // motir-ai's wire: each progress frame in its `{ jobId, seq, data }` envelope.
      body: jobStreamBody(jobId, [
        ['search', {}],
        ['done', {}],
      ]),
    });
  });
}

/**
 * The planner-turn recording. Its real route reads the utterance from motir-ai,
 * which CI cannot reach — so the stub does what the route would have done with
 * the answer in hand: it WRITES the assistant turn as a real row, through the
 * same row-locked service append, then answers with the live thread.
 *
 * That keeps the one thing this card is about honest: what the rail renders, and
 * what a reload re-reads, is a persisted `assistant` turn — not a stub payload.
 */
async function stubPlannerTurn(
  page: Page,
  ctx: { userId: string; workspaceId: string; projectId: string },
  utterance: { message: string; question: string | null },
): Promise<void> {
  await page.route('**/api/ai/plan-change/session/planner-turn', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();

    const session = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planChangeSessionRepository.findByProjectAndScope(
        ctx.projectId,
        PROJECT_SCOPE_KEY,
        ctx.workspaceId,
        tx,
      ),
    );
    if (session) {
      const existing = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        planChangeTurnRepository.listBySessionId(session.id, ctx.workspaceId, tx),
      );
      // Idempotent, exactly as the real route is: a reload replays this call.
      const already = existing.some((t) => t.role === 'assistant' && t.body === utterance.message);
      if (!already) {
        await withWorkspaceContext(ctx, async (tx) => {
          await planChangeTurnRepository.create(
            {
              workspaceId: ctx.workspaceId,
              sessionId: session.id,
              seq: existing.length,
              role: 'assistant',
              body: utterance.message,
              question: utterance.question,
              jobId: session.lastJobId,
            },
            tx,
          );
          await planChangeSessionRepository.update(
            session.id,
            { turnCount: existing.length + 1 },
            tx,
          );
        });
      }
    }

    // The session the recording NAMED, re-read by id (MOTIR-6023).
    const live = await readNamedSession(route);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: await live.text(),
    });
  });
}

const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });

/** Send whatever the composer currently prompts for, waiting on the DOOR's 200
 *  — the turn is a persisted row written by that call, so its write response is
 *  the authoritative "the thread advanced" signal (never a timeout).
 *
 *  ⚠️ THE DOOR MOVED (MOTIR-1343). The project thread used to append through
 *  `…/session/turns` and submit separately; it now posts to `/api/ai/ask`, which
 *  appends AND runs, so that is where the 200 comes from. The path matched is
 *  the door EXACTLY — `/api/ai/ask/settle` shares the prefix, and matching it
 *  here would resolve on the previous turn's filing instead of this one's
 *  append. */
async function send(page: Page, text: string, button: 'Send' | 'Answer'): Promise<void> {
  const appended = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/ask' && r.request().method() === 'POST',
  );
  await page.getByRole('textbox', { name: /Reply, or refine|Answer Motir AI/ }).fill(text);
  await page.getByRole('button', { name: button, exact: true }).click();
  expect((await appended).status()).toBe(200);
}

/** Wait for the planner's turn to have been RECORDED — the authoritative signal
 *  that the run settled and the utterance is on the thread. */
function recorded(page: Page) {
  return page.waitForResponse(
    (r) =>
      r.url().includes('/api/ai/plan-change/session/planner-turn') &&
      r.request().method() === 'POST',
  );
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('a question shows in the rail, the composer asks for the answer, and the reply resumes the thread', async ({
  page,
}) => {
  const seed = await seedAiAugmentReplan(`planner-turn-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  const ctx = {
    userId: seed.ctx.userId,
    workspaceId: seed.ctx.workspaceId,
    projectId: seed.projectId,
  };

  await signIn(page, seed.email, seed.password);
  await stubAiAccess(page);
  await stubSubmit(page, 'job-ask-1');
  await stubStream(page, 'job-ask-1');
  await stubPlannerTurn(page, ctx, { message: REPORT, question: QUESTION });

  await page.goto('/roadmap?plan=project&planFrom=project');
  await expect(rail(page)).toBeVisible();

  // 1. An underdetermined request goes out.
  const asked = recorded(page);
  await send(page, 'add payments', 'Send');
  expect((await asked).status()).toBe(200);

  // 2. The planner's QUESTION lands in the rail — as the planner, not as the user.
  const question = page.getByTestId('plan-change-question');
  await expect(question).toBeVisible();
  await expect(question).toContainText(REPORT);
  await expect(question).toContainText('asking');

  // 3. And the WHOLE composer changes: the bar, the placeholder, the button.
  await expect(page.getByTestId('plan-change-awaiting')).toContainText('Waiting for your answer');
  await expect(page.getByTestId('plan-change-awaiting')).toContainText(QUESTION);
  await expect(page.getByRole('textbox', { name: 'Answer Motir AI…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Answer', exact: true })).toBeVisible();

  // 4. THE RELOAD — the pending state is recovered from the persisted thread, not
  //    from anything the client was holding. This is the criterion the whole
  //    "awaiting is derived" decision exists for.
  await page.reload();
  await expect(page.getByTestId('plan-change-question')).toBeVisible();
  await expect(page.getByTestId('plan-change-awaiting')).toContainText(QUESTION);
  await expect(page.getByRole('button', { name: 'Answer', exact: true })).toBeVisible();

  // 5. The answer is an ORDINARY user turn, and the thread resumes.
  await stubSubmit(page, 'job-ask-2');
  await stubStream(page, 'job-ask-2');
  await stubPlannerTurn(page, ctx, {
    message: 'Understood — customer checkout it is.',
    question: null,
  });
  const resumed = recorded(page);
  await send(page, 'Taking money from customers.', 'Answer');
  expect((await resumed).status()).toBe(200);

  // The reply is shown as just the message (MOTIR-7497), and the resumption is
  // marked.
  await expect(
    rail(page)
      .getByTestId('conversation-user-turn')
      .filter({ hasText: 'Taking money from customers.' }),
  ).toBeVisible();
  await expect(page.getByTestId('plan-change-answered')).toContainText(
    'Answered — planning resumed',
  );

  // 6. The composer is back to normal — the planner is no longer waiting.
  await expect(page.getByTestId('plan-change-awaiting')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Reply, or refine further…' })).toBeVisible();

  // 7. The transcript never rewrote itself: the question is still there, as asked.
  await expect(page.getByTestId('plan-change-question')).toContainText(REPORT);
});

test('a question the user ignores is SUPERSEDED — marked, never dropped and never blocking', async ({
  page,
}) => {
  const seed = await seedAiAugmentReplan(`planner-supersede-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  const ctx = {
    userId: seed.ctx.userId,
    workspaceId: seed.ctx.workspaceId,
    projectId: seed.projectId,
  };

  await signIn(page, seed.email, seed.password);
  await stubAiAccess(page);
  await stubSubmit(page, 'job-ask-1');
  await stubStream(page, 'job-ask-1');
  await stubPlannerTurn(page, ctx, { message: REPORT, question: QUESTION });

  await page.goto('/roadmap?plan=project&planFrom=project');
  const asked = recorded(page);
  await send(page, 'add payments', 'Send');
  expect((await asked).status()).toBe(200);
  await expect(page.getByTestId('plan-change-awaiting')).toBeVisible();

  // The user changes the subject from a SECOND surface — the case the design
  // calls "the user sends anything else". Appending straight to the thread is
  // exactly what another tab (or the MCP append tool) does: no answer bar was
  // involved, so nothing marks it as a reply.
  const appended = page.waitForResponse(
    (r) => r.url().includes('/api/ai/plan-change/session/turns') && r.request().method() === 'POST',
  );
  await page.evaluate(async () => {
    // A second surface names the conversation by id (MOTIR-6023): it reads the
    // caller's resumable session, then appends to exactly that one.
    // The resumable read answers `{ session, earlier }` since MOTIR-6024.
    const { session } = (await (await fetch('/api/ai/plan-change/session')).json()) as {
      session: { id: string } | null;
    };
    await fetch('/api/ai/plan-change/session/turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: session?.id ?? '',
        body: 'Actually — re-sequence the Billing epic first.',
      }),
    });
  });
  expect((await appended).status()).toBe(200);

  await page.reload();

  // Superseded: marked, and the question bubble is untouched.
  await expect(page.getByTestId('plan-change-superseded')).toContainText(
    'Not answered — Motir AI carried on with what you asked',
  );
  await expect(page.getByTestId('plan-change-question')).toContainText(REPORT);
  // Never blocking — the composer is back to its ordinary self.
  await expect(page.getByTestId('plan-change-awaiting')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Reply, or refine further…' })).toBeVisible();
});
