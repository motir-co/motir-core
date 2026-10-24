import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { servePrivateObjectStore } from './_helpers/object-store';
import { openAgentSession, publishDesignResult } from './_helpers/design-approval-seed';
import { seedApprovalsTab, type ApprovalsTabSeed } from './_helpers/approvals-tab-seed';
import { boardViewportWidth, columnByStatus, getBoard, pointerDragForMove } from './_helpers/board';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// A GATE OWNS ITS SUBJECT'S STATUS, END TO END — AND THE ACCEPTANCE RECEIPT FOR IT
// (Story MOTIR-4887 · Subtask MOTIR-5531).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A design card is waiting on a person's approval. Before, it could simply be
// dragged to Done and the approval never happened. Now every place a person moves
// a card SAYS the move is held — right on the status control, with a button into
// the full-screen approval — and the one move the approval performs is locked,
// while every other move stays open. Approving moves the card; a person can
// still reopen it afterwards.
//
// ── WHAT ONLY AN E2E CAN PROVE ──────────────────────────────────────────────
//
// The DRAG. dnd-kit is not driven in happy-dom anywhere in this suite, so the
// board's refusal-on-the-card — the card returning, the line under it, no toast —
// is asserted here and nowhere else (MOTIR-5529 records the split). The rest is
// the assembled walk a person accepts the story on: item page → board → quick
// view → overlay → Done → reopen, the look-only reader, and `zh`.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE — the move's response status, the decide
// action's response, the database's status, the dialog's name. The holds are
// `chapter()` / `beat()` pacing, taken after each state is proven.

test.describe.configure({ timeout: 300_000 });

/** A catalog sentence with its `{value}` slots filled and its `<strong>` markup
 *  removed — what a person reads. Asserted against the catalog, never retyped. */
function sentence(message: string, values: Record<string, string>): string {
  return message
    .replace(/<\/?strong>/g, '')
    .replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? '');
}

/** The item page's Status field card — the rail card whose edit chevron is
 *  "Edit Status"; the held line must sit INSIDE it. Role-rooted, then walked up to
 *  the card that owns the chevron (the rail's FieldCard). */
function statusCard(page: Page): Locator {
  return page
    .getByRole('main')
    .locator('div')
    .filter({
      has: page.getByRole('button', { name: `Edit ${en.issueViews.status}`, exact: true }),
    })
    .filter({ has: page.getByRole('status') })
    .last();
}

async function publishFor(seed: ApprovalsTabSeed, baseURL: string, key: string): Promise<void> {
  const client = await openAgentSession(seed.token, baseURL);
  const published = await publishDesignResult(client, key);
  expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
  await client.close();
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id }, select: { status: true } }))
    .status;
}

test.describe('a pending approval holds the move it performs, and says so where the move is made', () => {
  let seed: ApprovalsTabSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedApprovalsTab(`gg${Date.now().toString(36)}`);
  });

  test('the status control says it, the board refuses on the card, approving moves it, and a person can reopen it', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-4887');
    await servePrivateObjectStore(page);
    await publishFor(seed, baseURL!, seed.designKey);
    await page.setViewportSize(boardViewportWidth());

    const decisionNoun = en.approvalGate.statusHeld.decisionNoun.design_result;
    const heldDone = sentence(en.approvalGate.statusHeld.decision, {
      status: 'Done',
      decision: decisionNoun,
    });
    const overlayHref = (href: string | null) => {
      const url = new URL(href ?? '', 'http://x');
      return (
        url.searchParams.get('approval') === seed.designKey &&
        url.searchParams.get('approvalKind') === 'design_result'
      );
    };

    await chapter(
      'The design card says, on its status, that Done is waiting on an approval',
      async () => {
        await signIn(page, seed.reviewerEmail, seed.password);
        await page.goto(`/items/${seed.designKey}`);
        const card = statusCard(page);
        // WITHOUT opening the dropdown: the message and the door are in the field.
        await expect(card.getByRole('status')).toContainText(heldDone);
        const door = card.getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove });
        await expect(door).toBeVisible();
        expect(overlayHref(await door.getAttribute('href'))).toBe(true);
      },
    );
    await beat();

    await chapter(
      'Done is locked in the dropdown; In Progress, Blocked and Cancelled stay offered',
      async () => {
        await page
          .getByRole('main')
          .getByRole('button', { name: `Edit ${en.issueViews.status}`, exact: true })
          .click();
        await page
          .getByRole('main')
          .getByRole('combobox', { name: en.issueViews.status, exact: true })
          .click();
        const done = page.getByRole('option', { name: /Done/ });
        await expect(done).toHaveAttribute('aria-disabled', 'true');
        await expect(done).toContainText(en.approvalGate.statusHeld.needsApproval);
        for (const offered of ['Blocked', 'Cancelled']) {
          await expect(
            page.getByRole('option', { name: offered, exact: true }),
          ).not.toHaveAttribute('aria-disabled', 'true');
        }
        await beat();
        await page.keyboard.press('Escape');
      },
    );

    const board = await getBoard(page.request);
    // ⚠️ IN REVIEW, because the PUBLISH put it there (Bug MOTIR-6009): a design
    // card has no pull request, so the publish writes the status in the
    // transaction that raises the gate. The refusal under test is unchanged —
    // the gate owns `done`, whichever status the card is dragged FROM.
    const heldColumn = columnByStatus(board, 'in_review');
    const doneColumn = columnByStatus(board, 'done');
    const columns = page.getByRole('group', { name: en.boards.boardLabel });
    const boardCard = () => columns.getByTestId(`board-card-${seed.designKey}`);

    await chapter(
      'On the board, dragging it to Done returns it — and the card says why',
      async () => {
        await page.goto('/boards');
        await expect(columns).toBeVisible({ timeout: 30_000 });
        const move = await pointerDragForMove(
          page,
          boardCard(),
          columns.getByTestId(`board-column-${doneColumn.id}`),
        );
        expect(move.status()).toBe(409);
        expect(((await move.json()) as { code: string }).code).toBe('APPROVAL_GATE_PENDING');

        // It is back in the column it came from, and the held line is ON the
        // card — not a toast.
        await expect(
          columns
            .getByTestId(`board-column-${heldColumn.id}`)
            .getByTestId(`board-card-${seed.designKey}`),
        ).toBeVisible();
        const onCard = boardCard().locator('xpath=..').getByRole('status');
        await expect(onCard).toContainText(heldDone);
        expect(
          overlayHref(
            await onCard
              .getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove })
              .getAttribute('href'),
          ),
        ).toBe(true);
        await expect(
          page.getByRole('status').filter({ hasText: en.boards.moveRejectedTitle }),
        ).toHaveCount(0);
        expect(await statusOf(seed.designId)).toBe('in_review');
      },
    );
    await beat();

    await chapter(
      'The quick view says the same, and its button opens the approval full screen',
      async () => {
        await page.keyboard.press('Escape');
        const read = page.waitForResponse(
          (r) => /\/api\/work-items\/peek\?/.test(r.url()) && r.request().method() === 'GET',
        );
        await boardCard().click();
        expect((await read).status()).toBe(200);
        const peek = page.getByRole('dialog');
        await expect(peek.getByRole('status').filter({ hasText: heldDone })).toBeVisible();
        await beat();

        await peek.getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove }).click();
        await expect(
          page.getByRole('dialog', {
            name: `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`,
          }),
        ).toBeVisible();
      },
    );
    await beat();

    await chapter('Approving it there moves the card to Done on its own', async () => {
      const overlay = page.getByRole('dialog', {
        name: `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`,
      });
      await overlay
        .getByRole('button', { name: en.approvalGate.verb.approve, exact: true })
        .click();
      const decided = page.waitForResponse(
        (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
      );
      await overlay.getByRole('button', { name: 'Yes, Approve' }).click();
      expect((await decided).status()).toBe(200);
      await expect
        .poll(() => statusOf(seed.designId), { timeout: 30_000, message: 'approval writes Done' })
        .toBe('done');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      // Closing strips the overlay's parameters with a client navigation; a
      // `goto` that lands inside it is aborted (MOTIR-9411: the recording
      // lane's hold always outlasted it).
      await expect(overlay).toHaveCount(0);
      await page.waitForURL((url) => !url.searchParams.has('approval'));
    });
    await beat();

    await chapter('The approval already happened, so a person can reopen it by hand', async () => {
      // The app can still be finishing its own navigation from the approval (a
      // refresh after the decision), and a `goto` that lands inside it is
      // aborted. Retried until the item page is the one that stays.
      await expect(async () => {
        await page.goto(`/items/${seed.designKey}`);
        await expect(page).toHaveURL(new RegExp(`/items/${seed.designKey}(\\?|$)`));
      }).toPass({ timeout: 30_000 });
      // Nothing is held any more: the approval was decided, so no held line renders.
      await expect(
        page.getByRole('main').getByRole('status').filter({ hasText: heldDone }),
      ).toHaveCount(0);
      await page
        .getByRole('main')
        .getByRole('button', { name: `Edit ${en.issueViews.status}`, exact: true })
        .click();
      await page
        .getByRole('main')
        .getByRole('combobox', { name: en.issueViews.status, exact: true })
        .click();
      const moved = page.waitForResponse(
        (r) => r.request().method() === 'POST' && Boolean(r.request().headers()['next-action']),
      );
      await page.getByRole('option', { name: 'In Progress', exact: true }).click();
      expect((await moved).status()).toBe(200);
      await expect
        .poll(() => statusOf(seed.designId), { timeout: 30_000, message: 'the reopen commits' })
        .toBe('in_progress');
    });
  });

  test('a reader who may see the decision but not make it is told whose it is, with no button', async ({
    page,
    baseURL,
    chapter,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-4887');
    await servePrivateObjectStore(page);
    const viewerCard = await adminDb.workItem.findUniqueOrThrow({
      where: { id: seed.viewerDesignId },
      select: { identifier: true },
    });
    const viewer = await adminDb.user.findFirstOrThrow({
      where: { email: seed.viewerEmail },
      select: { name: true },
    });
    await publishFor(seed, baseURL!, viewerCard.identifier);

    await chapter(
      'The viewer reads the held line, naming the person it waits on, and no door',
      async () => {
        await signIn(page, seed.viewerEmail, seed.password);
        await page.goto(`/items/${viewerCard.identifier}`);
        const held = page.getByRole('main').getByRole('status').filter({ hasText: 'Done' });
        await expect(held).toContainText(
          sentence(en.approvalGate.statusHeld.decisionSeeOnly, {
            status: 'Done',
            decision: en.approvalGate.statusHeld.decisionNoun.design_result,
            name: viewer.name ?? '',
          }),
        );
        await expect(
          held.getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove }),
        ).toHaveCount(0);
      },
    );
  });

  test('the status control says it in Chinese', async ({
    page,
    baseURL,
    chapter,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-4887');
    await servePrivateObjectStore(page);
    await publishFor(seed, baseURL!, seed.designKey);

    await signIn(page, seed.reviewerEmail, seed.password);
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: page.url() }]);

    await chapter('无法直接将状态改为「完成」— and the button, in Chinese', async () => {
      await page.goto(`/items/${seed.designKey}`);
      const held = page
        .getByRole('main')
        .getByRole('status')
        .filter({ hasText: zh.approvalGate.statusHeld.decisionNoun.design_result });
      await expect(held).toBeVisible();
      const text = (await held.textContent()) ?? '';
      const [before] = zh.approvalGate.statusHeld.decision.split('<strong>');
      expect(text).toContain(before!);
      await expect(
        held.getByRole('link', { name: zh.approvalGate.statusHeld.reviewAndApprove }),
      ).toBeVisible();
      await expect(held.getByRole('link', { name: 'Review & approve' })).toHaveCount(0);
    });
  });
});
