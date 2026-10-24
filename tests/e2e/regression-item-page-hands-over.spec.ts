import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn, startSignedOut } from './_helpers/shell-session';
import {
  openAgentSession,
  publishDesignResult,
  seedDesignApproval,
  servePublishedMock,
  type DesignApprovalSeed,
} from './_helpers/design-approval-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// THE ITEM PAGE HANDS THE DECISION OVER — the story's walk AND its acceptance
// receipt (Story MOTIR-5215 · Subtask MOTIR-5231).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Somebody opens a card and sees that a decision is owed. The card does not ask
// them to approve a design inside a page column: it says what is waiting and
// offers ONE control. That control opens the same full-screen surface the
// To-approve queue opens. They decide there, close, and the card underneath has
// already caught up — the decided record and the status, with no reload. And a
// project admin who was never routed the gate gets the same door.
//
// ── WHAT ONLY AN E2E CAN PROVE ──────────────────────────────────────────────
//
// 1. THE REPAINT CROSSES A COMPONENT BOUNDARY. The decision is made in a
//    component mounted in the authed shell; the section and the status rail it
//    moves are the item page's. Whether the overlay's refresh and its
//    in-browser announcement both land is a property of a real navigation, so
//    the section and the rail are read IN THE SAME PAGE STATE after the close.
// 2. AUTHORITY, NOT ROUTING, OPENS THE DOOR. A gate is routed to one person and
//    pressable by three (`docs/decisions/approval-gates.md` §2 as amended by
//    MOTIR-4911). The admin walk needs a second identity against one gate.
//
// ── SITS BESIDE `design-approval.spec.ts`, NOT INSIDE IT ─────────────────────
//
// That spec is MOTIR-4778's walk (a published design waits, the routed reviewer
// approves, the blocked card becomes ready), re-scoped through the overlay by
// MOTIR-5229, and `approval-gate-repaint.spec.ts` is MOTIR-5118's repaint guard.
// This receipt's subject is the DOOR: the band, its one control, the admin arm,
// the reader with no door, and the walk in `zh`. It asserts the repaint only as
// the reader experiences it on close — the rail-and-record pair — and does not
// re-assert the dependent card's readiness, which is the other spec's claim.
//
// ⚠️ WHAT IS PUBLISHED FOR REAL: the design under test, through
// `publish_design_result` over `/api/mcp`. No `awaiting` gate is hand-written.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE — a rendered landmark, the named dialog (named
// only once its read answers), the decide action's own response, the URL. The
// holds are `chapter()`'s pacing, taken after each state is proven.

test.describe.configure({ timeout: 300_000 });

/** The core-fields rail's Status card (the `approval-gate-repaint.spec.ts` scope). */
function statusCard(page: Page, editStatus: string) {
  return page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: editStatus }) });
}

/** The Design result section card — the ONE container, found by its ONE label. */
function designSection(page: Page, title: string) {
  return page
    .getByRole('main')
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('heading', { level: 2, name: title }) });
}

async function publish(seed: DesignApprovalSeed, baseURL: string): Promise<void> {
  const client = await openAgentSession(seed.token, baseURL);
  const result = await publishDesignResult(client, seed.designKey);
  expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
  await client.close();
}

const onTheCard = (key: string) => (url: URL) =>
  url.pathname === `/items/${key}` && !url.searchParams.has('approval');

test.describe('the item page hands the decision over', () => {
  let seed: DesignApprovalSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedDesignApproval(`ho${Date.now().toString(36)}`);
  });

  test.afterEach(async ({ page }) => {
    // The decided record mounts a fresh mock frame as the walk ends; its route
    // must not throw during teardown (see `approval-gate-repaint.spec.ts`).
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('a card with a decision owed offers one door; decide full screen and the card has caught up', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5215');
    await servePublishedMock(page);
    await publish(seed, baseURL!);

    const section = designSection(page, en.designResult.title);
    const door = section.getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove });
    const dialog = page.getByRole('dialog', {
      name: `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`,
    });

    await chapter('A reader who may look but not decide sees the state, and no door', async () => {
      await signIn(page, seed.readerEmail, seed.password);
      await page.goto(`/items/${seed.designKey}`);
      await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible();

      // State `B`, flush in the section: the design and who it waits on.
      await expect(section.getByRole('group', { name: en.approvalGate.port.label })).toBeVisible();
      await expect(section.getByText('Waiting on Robin Vale.')).toBeVisible();
      await expect(door).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    });
    await beat();

    await chapter('The person it waits on: what is waiting, and ONE control', async () => {
      await startSignedOut(page);
      await signIn(page, seed.reviewerEmail, seed.password);
      await page.goto(`/items/${seed.designKey}`);
      await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible();

      await expect(
        section.getByText(en.approvalGate.state.awaitingYou, { exact: true }),
      ).toBeVisible();
      await expect(section.getByText(en.approvalGate.cta.body)).toBeVisible();
      // The meta line: the subject's version (or the plain form a result with no
      // version carries), then how long the question has waited.
      await expect(section.getByText(/ · asked .+ ago$/)).toBeVisible();
      // EXACTLY ONE control, counted rather than named — and it is the door.
      await expect(section.locator('a, button')).toHaveCount(1);
      await expect(door).toBeVisible();
      // One container, one label: the section's title is the only one.
      await expect(section.getByText(en.designResult.title, { exact: true })).toHaveCount(1);
    });
    await beat();

    await chapter('Review & approve opens the same full-screen surface over the card', async () => {
      await door.click();
      await expect(dialog).toBeVisible();
      // Band 2 at full size — the design itself, not merely a dialog.
      const port = dialog.getByRole('group', { name: en.approvalGate.port.label });
      await expect(port.locator('iframe').first()).toBeVisible();
      await expect(page).toHaveURL((url) => url.searchParams.get('approval') === seed.designKey);
      // The card is still behind it: the page never left. (The modal hides the page
      // from the accessibility tree, so the address is the honest witness here.)
      expect(new URL(page.url()).pathname).toBe(`/items/${seed.designKey}`);
    });
    await beat();

    await chapter('Approve it there, close — and the card has repainted in place', async () => {
      await dialog.getByRole('button', { name: en.approvalGate.verb.approve, exact: true }).click();
      await expect(dialog.getByText(en.approvalGate.confirm.title)).toBeVisible();
      const decided = page.waitForResponse(
        (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
      );
      await dialog.getByRole('button', { name: 'Yes, Approve' }).click();
      expect((await decided).status()).toBe(200);
      await expect(dialog.getByText(en.approvalGate.state.approved, { exact: true })).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(onTheCard(seed.designKey));

      // ⚠️ THE SAME PAGE STATE, NO RELOAD: the section's decided record and the
      // rail's status, read together. Separately they would pass on exactly the
      // inconsistency MOTIR-5118 was about.
      await expect(
        section.getByText(en.approvalGate.state.approved, { exact: true }),
      ).toBeVisible();
      await expect(section.getByText(en.approvalGate.record.filesKept)).toBeVisible();
      await expect(
        statusCard(page, 'Edit Status').getByText('Done', { exact: true }),
      ).toBeVisible();
    });
    await beat();

    await chapter('And nowhere else on the card to approve from', async () => {
      await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Request changes' })).toHaveCount(0);
      await expect(
        page.getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove }),
      ).toHaveCount(0);
    });
  });

  test('a project admin who was never routed the gate gets the same band and the same door', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5215');
    await servePublishedMock(page);
    await publish(seed, baseURL!);

    const section = designSection(page, en.designResult.title);
    const dialog = page.getByRole('dialog', {
      name: `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`,
    });

    await chapter('The admin: routed to someone else, and may decide it too', async () => {
      await signIn(page, seed.adminEmail, seed.password);
      await page.goto(`/items/${seed.designKey}`);
      await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible();

      // The sentence names the routed recipient — routing picks the WORDS…
      await expect(section).toContainText(
        'Waiting on Robin Vale — you can decide it too. Review it full screen first.',
      );
      // …and authority picks the DOOR, which is the same one.
      await expect(section.locator('a, button')).toHaveCount(1);
      await section
        .getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove })
        .click();
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole('group', { name: en.approvalGate.port.label }).locator('iframe').first(),
      ).toBeVisible();
    });
    await beat();

    await chapter('The admin approves through it', async () => {
      await dialog.getByRole('button', { name: en.approvalGate.verb.approve, exact: true }).click();
      const decided = page.waitForResponse(
        (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
      );
      await dialog.getByRole('button', { name: 'Yes, Approve' }).click();
      expect((await decided).status()).toBe(200);
      await expect(dialog.getByText(en.approvalGate.state.approved, { exact: true })).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(
        section.getByText(en.approvalGate.state.approved, { exact: true }),
      ).toBeVisible();
      await expect(
        statusCard(page, 'Edit Status').getByText('Done', { exact: true }),
      ).toBeVisible();
    });
  });

  test('the same door, in Chinese', async ({ page, baseURL, chapter, beat, acceptanceStory }) => {
    acceptanceStory('MOTIR-5215');
    await servePublishedMock(page);
    await publish(seed, baseURL!);

    await signIn(page, seed.reviewerEmail, seed.password);
    // The suite's own locale switch (`workbench.spec.ts`).
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: page.url() }]);

    const section = designSection(page, zh.designResult.title);
    const door = section.getByRole('link', { name: zh.approvalGate.statusHeld.reviewAndApprove });
    const dialog = page.getByRole('dialog', {
      name: `${seed.designKey} 的${zh.workbench.approvals.kind.design_result}`,
    });

    await chapter('设计结果 — 等待你处理, and one control: 审阅并批准', async () => {
      await page.goto(`/items/${seed.designKey}`);
      await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible();
      await expect(
        section.getByText(zh.approvalGate.state.awaitingYou, { exact: true }),
      ).toBeVisible();
      await expect(section.getByText(zh.approvalGate.cta.body)).toBeVisible();
      await expect(section.getByText(/ · .+发起$/)).toBeVisible();
      await expect(section.locator('a, button')).toHaveCount(1);
      await expect(door).toBeVisible();
    });
    await beat();

    await chapter('批准 in the overlay, and the card has caught up', async () => {
      await door.click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: zh.approvalGate.verb.approve, exact: true }).click();
      await expect(dialog.getByText(zh.approvalGate.confirm.title)).toBeVisible();
      const decided = page.waitForResponse(
        (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
      );
      await dialog
        .getByRole('button', {
          name: zh.approvalGate.confirm.proceed.replace('{verb}', zh.approvalGate.verb.approve),
        })
        .click();
      expect((await decided).status()).toBe(200);
      await expect(dialog.getByText(zh.approvalGate.state.approved, { exact: true })).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(
        section.getByText(zh.approvalGate.state.approved, { exact: true }),
      ).toBeVisible();
      await expect(section.getByText(zh.approvalGate.record.filesKept)).toBeVisible();
      await expect(door).toHaveCount(0);
    });
  });
});
