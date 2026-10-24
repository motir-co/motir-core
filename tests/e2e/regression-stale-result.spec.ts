import type { Locator, Page } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  openAgentSession,
  publishDesignResult,
  seedDesignApproval,
  servePublishedMock,
  type DesignApprovalSeed,
} from './_helpers/design-approval-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// A STALE RESULT CANNOT BE APPROVED, END TO END — AND THE ACCEPTANCE RECEIPT FOR IT
// (Story MOTIR-5232 · Subtask MOTIR-5237; design
// `design/work-items/approval-control--stale-refusal.mock.html`).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A person opens a design waiting on them, reads it full screen, and presses
// Approve some minutes later — while somebody else changed what they were deciding
// about. Twice:
//
//   1. THE DESIGN IS REPUBLISHED. That question is WITHDRAWN (§6b's supersede, which
//      shipped before this story) and the press is refused as withdrawn. Reloading
//      the same address opens the NEW question.
//   2. THE ACCEPTANCE CRITERIA ARE EDITED, and nothing is republished. **This is the
//      phase that fails against the product before this story:** the question is
//      still live, so nothing superseded it, and the approval used to land against
//      criteria the reader never saw. Now it is refused as STALE, in place, naming
//      the acceptance criteria, with ONE control.
//   3. RECOVERY. *Show the current version* re-reads in place, and the very next
//      Approve LANDS. The second press is the assertion, not the refusal: a control
//      that brought new bytes and kept the old stamp would refuse for ever.
//
// ⚠️ PHASE 1 IS WITHDRAWN, NOT STALE, AND THAT IS THE STORY'S OWN RULE. The card
// sketched phase 1 as a stale refusal; the story's criterion *"a republish still
// produces APPROVAL_GATE_SUPERSEDED, distinct from the new refusal"* is the one the
// door implements, because the state refusals run first. Recorded on MOTIR-5237.
//
// ── TWO IDENTITIES ──────────────────────────────────────────────────────────
//
// Every change comes from SOMEBODY ELSE — the seeded agent, over `/api/mcp` with a
// `CLI_TOKEN_GRANT` bearer — while the reviewer's render sits untouched. A change
// made through the page under test would have re-rendered the thing it claims went
// stale. The gate is PUBLISHED for real, and the republish is the same real call
// again; no `awaiting` gate is hand-seeded.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE — the named dialog, the decide action's response,
// the alert's text, the state pill. The holds are `chapter()`'s pacing, taken after
// each state is proven.

test.describe.configure({ timeout: 300_000 });

type Messages = typeof en;

/** The decide server action's POST — the one authoritative signal a press settled. */
const decideResponse = (page: Page) =>
  page.waitForResponse(
    (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
  );

/** Press Approve, then the confirm step's proceed — the frame's two-step approve. */
async function approve(page: Page, dialog: Locator, m: Messages): Promise<void> {
  await dialog.getByRole('button', { name: m.approvalGate.verb.approve, exact: true }).click();
  await expect(dialog.getByText(m.approvalGate.confirm.title)).toBeVisible();
  const decided = decideResponse(page);
  await dialog
    .getByRole('button', {
      name: m.approvalGate.confirm.proceed.replace('{verb}', m.approvalGate.verb.approve),
    })
    .click();
  expect((await decided).status()).toBe(200);
}

/** The design card's own address, with the overlay open on its design gate. */
const overlayAt = (key: string) => `/items/${key}?approval=${key}&approvalKind=design_result`;

async function republish(client: Client, key: string): Promise<void> {
  const published = await publishDesignResult(client, key);
  expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
}

async function editCriteria(client: Client, key: string, line: string): Promise<void> {
  const edited = await client.callTool({
    name: 'update_work_item',
    arguments: { key, descriptionMd: `## Acceptance criteria\n\n- ${line}` },
  });
  expect(edited.isError ?? false, JSON.stringify(edited.content)).toBe(false);
}

test.describe('a stale result cannot be approved', () => {
  let seed: DesignApprovalSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedDesignApproval(`st${Date.now().toString(36)}`);
  });

  for (const [locale, m] of [
    ['en', en],
    ['zh', zh as unknown as Messages],
  ] as const) {
    test(`held open, changed underneath twice, refused both times, then approved (${locale})`, async ({
      page,
      baseURL,
      chapter,
      beat,
      acceptanceStory,
    }) => {
      acceptanceStory('MOTIR-5232');
      await servePublishedMock(page);

      // The OTHER identity — an agent session, never the reviewer's page.
      const agent = await openAgentSession(seed.token, baseURL!);
      await republish(agent, seed.designKey);

      const dialog = page.getByRole('dialog', {
        name:
          locale === 'en'
            ? `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`
            : `${seed.designKey} 的${zh.workbench.approvals.kind.design_result}`,
      });
      const stale = m.approvalGate.refusal.stale;

      await chapter('The reviewer opens the design full screen, and leaves it open', async () => {
        await signIn(page, seed.reviewerEmail, seed.password);
        if (locale === 'zh') {
          await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: page.url() }]);
        }
        await page.goto(overlayAt(seed.designKey));
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByRole('button', { name: m.approvalGate.verb.approve, exact: true }),
        ).toBeEnabled();
      });
      await beat();

      await chapter(
        'Phase 1 — somebody republishes the design; the press is WITHDRAWN',
        async () => {
          await republish(agent, seed.designKey);
          await approve(page, dialog, m);
          const refusal = dialog.getByRole('alert');
          await expect(refusal).toContainText(m.approvalGate.withdrawn.cause.republished);
          // A withdrawn question has nothing for the reader to take: no control.
          await expect(refusal.getByRole('button', { name: stale.control })).toHaveCount(0);
          await expect(dialog).toBeVisible();
        },
      );
      await beat();

      await chapter('Reloading the same address opens the NEW question', async () => {
        await page.reload();
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        await expect(
          dialog.getByRole('button', { name: m.approvalGate.verb.approve, exact: true }),
        ).toBeEnabled();
      });
      await beat();

      await chapter(
        'Phase 2 — somebody edits the ACCEPTANCE CRITERIA; the press is refused as STALE',
        async () => {
          await editCriteria(agent, seed.designKey, 'the frame is drawn, and in zh too');
          await approve(page, dialog, m);
          const refusal = dialog.getByRole('alert');
          await expect(refusal).toContainText(stale.criteria);
          await expect(refusal).toContainText(stale.next);
          await expect(refusal.getByRole('button', { name: stale.control })).toBeVisible();
          // Pressing again would be refused again — the verbs wait for the re-read.
          await expect(
            dialog.getByRole('button', { name: m.approvalGate.verb.approve, exact: true }),
          ).toBeDisabled();
          // Refused IN PLACE: the overlay is still open on the same address.
          await expect(page).toHaveURL(
            (url) => url.searchParams.get('approval') === seed.designKey,
          );
        },
      );
      await beat();

      await chapter('Phase 3 — Show the current version, and the next Approve LANDS', async () => {
        await dialog.getByRole('alert').getByRole('button', { name: stale.control }).click();
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        await expect(
          dialog.getByRole('button', { name: m.approvalGate.verb.approve, exact: true }),
        ).toBeEnabled();
        await approve(page, dialog, m);
        await expect(
          dialog.getByText(m.approvalGate.state.approved, { exact: true }),
        ).toBeVisible();
        await expect(dialog.getByRole('alert')).toHaveCount(0);
      });

      await agent.close();
    });
  }
});
