import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  openAgentSession,
  publishDesignResult,
  servePublishedMock,
} from './_helpers/design-approval-seed';
import {
  seedWhatToReview,
  TITLES,
  type WhatToReviewSeed,
} from './_helpers/design-what-to-review-seed';
import en from '@/messages/en.json';

// A DESIGN RESULT SHOWS ONLY WHAT TO REVIEW — the story's walk and its ACCEPTANCE
// RECEIPT (Story MOTIR-5488 · Subtask MOTIR-5500).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// An agent publishes a design — the changed mock and its note, nothing else — and
// the person it waits on sees the MOCK first, with the note one link away and no
// screenshot. They approve it, and the work it held up is free. A screenshot is
// turned away at the door, and so is a publish nothing waits on. An old result
// still opens, as files. And on a design card whose pull requests carry the
// decision, the design sits INSIDE the Development block — design, How to test,
// then the pull requests. (Its LAST claim — *with no design approval of its own* —
// was reversed by MOTIR-5652; see the amendment in the Workbench chapter.)
//
// ── WHAT IS REAL ────────────────────────────────────────────────────────────
//
// Every current-format result is published by the REAL tool over `/api/mcp` with
// a token holding `CLI_TOKEN_GRANT`. The two refusals go through the REAL HTTP
// doors with the same token. The earlier-format result and the two pull requests
// are rows (the seed's header says why). The one stub is the mock's bytes at the
// content route, for the sandboxed-frame reason `servePublishedMock` documents.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE — a named landmark, a response armed before its
// action, the decided pill drawn from the action's returned row. The holds are
// `chapter()` / `beat()`'s pacing, taken after each state is proven.

test.describe.configure({ timeout: 300_000 });

const PORT = en.approvalGate.port.label;

/** The live item page's main region — every assertion is scoped to it. */
const main = (page: Page) => page.getByRole('main');

async function openCard(page: Page, key: string, title: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test.describe('a design result shows only what to review', () => {
  let seed: WhatToReviewSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedWhatToReview(`wtr${Date.now().toString(36)}`);
  });

  test('publish a mock and its note, review it, approve it — and watch what is turned away', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5488');
    await servePublishedMock(page);
    const bearer = { Authorization: `Bearer ${seed.token}` };

    await chapter('An agent publishes the changed mock and its note — nothing else', async () => {
      const client = await openAgentSession(seed.token, baseURL!);
      for (const key of [seed.designKey, seed.withPrsKey]) {
        const result = await publishDesignResult(client, key);
        expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
        const payload = result.structuredContent as { evidenceId?: string; assetCount?: number };
        expect(payload.assetCount).toBe(2);
      }
      await client.close();
    });

    await chapter('The card says a decision is owed, and offers one door to it', async () => {
      await signIn(page, seed.reviewerEmail, seed.password);
      await openCard(page, seed.designKey, TITLES.design);

      // ⚠️ SINCE MOTIR-5229 THE ITEM PAGE HANDS THE DECISION OVER. The reviewer
      // may decide this gate, so the card shows the call-to-action band — no port
      // and no verbs — and the design is reviewed full screen, in the overlay the
      // next chapter opens. What this story promised about WHAT TO REVIEW (the
      // mock, the note one link away, no screenshot) is asserted there, on the
      // surface that now shows it.
      // Scoped to the Design result section: while this gate holds a move the
      // status control carries a second door of the same name (MOTIR-5528).
      const section = main(page)
        .locator('[data-surface="card"]')
        .filter({ has: page.getByRole('heading', { level: 2, name: en.designResult.title }) });
      await expect(
        section.getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove }),
      ).toHaveCount(1);
      await expect(main(page).getByRole('group', { name: PORT })).toHaveCount(0);
      await beat();
    });

    await chapter('Approve it from the Workbench, full screen', async () => {
      await page.goto('/workbench?tab=approvals');
      const table = page.getByRole('table', { name: en.workbench.tabs.toApprove });
      const rows = table.getByTestId(/^approval-row-/);
      // ⚠️ AMENDED 2026-09-17 — Bug MOTIR-5652 · Subtask MOTIR-5669, and it is a
      // RECEIPT-LIFECYCLE judgement worth reading before it is copied.
      //
      // This asserted *ONE decision waits: the design card with pull requests
      // raised none (Q8)*. `design-result.md` AMENDMENT 6 Q1 REVERSES Q8: such a
      // card raises a design gate again, and it is the PRIMARY. So both cards now
      // wait, and the second row is the thing this level exists to restore.
      //
      // `acceptance-receipt-lifecycle.md` says an acceptance spec going red on a
      // pull request that did not change its story must be DISPOSITIONED, never
      // edited to match today. This pull request DOES change its story's subject,
      // deliberately and by an approved plan, which is the case that rule is not
      // about — so the assertion is amended in place with this note rather than
      // the spec being promoted or retired. If that reading is wrong, the remedy
      // is a disposition of the whole spec, not a re-edit of this line.
      await expect(rows).toHaveCount(2);
      await expect(rows.filter({ hasText: TITLES.withPrs })).toHaveCount(1);

      await rows
        .first()
        .getByRole('link', { name: /^Review / })
        .click({ position: { x: 8, y: 22 } });
      const dialog = page.getByRole('dialog', {
        name: `${en.workbench.approvals.kind.design_result} for ${seed.designKey}`,
      });
      await expect(dialog).toBeVisible();
      const port = dialog.getByRole('group', { name: PORT });
      await expect(port.locator('iframe').first()).toBeVisible();
      const noteLink = port.getByRole('link', { name: en.designResult.openNote });
      await expect(noteLink).toBeVisible();
      // No inline note and no screenshot — only what there is to review.
      await expect(port.getByRole('img')).toHaveCount(0);
      await expect(port.getByText(en.designResult.earlierFormat)).toHaveCount(0);

      // The link is the AUTHENTICATED content route, which answers with a signed
      // redirect to the note file itself.
      const href = (await noteLink.getAttribute('href'))!;
      expect(href).toMatch(/^\/api\/attachments\/[^/]+\/content$/);
      const res = await page.request.get(href, { maxRedirects: 0 });
      expect(res.status()).toBe(302);
      expect(res.headers()['location']).toContain('design-notes');
      expect(res.headers()['location']).toContain('X-Amz-Signature');
      await beat();

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
    });

    await chapter('The work it held up is ready to start', async () => {
      await openCard(page, seed.dependentKey, TITLES.dependent);
      await expect(main(page).getByText('All blockers resolved')).toBeVisible();
      await expect(main(page).getByText('Blocked', { exact: true })).toHaveCount(0);
      await beat();
    });

    await chapter('A screenshot is turned away at the door', async () => {
      const res = await page.request.post(`/api/work-items/${seed.designKey}/design-evidence`, {
        headers: bearer,
        data: {
          assets: [
            { kind: 'mock', sourcePath: 'design/x/chip.mock.html', pathname: 'x/chip.mock.html' },
            { kind: 'image', sourcePath: 'design/x/chip.png', pathname: 'x/chip.png' },
            { kind: 'note_file', sourcePath: 'design/x/design-notes.md', pathname: 'x/n.md' },
          ],
        },
      });
      expect(res.status()).toBe(422);
      expect((await res.json()).code).toBe('DESIGN_EVIDENCE_IMAGE_RETIRED');
    });

    await chapter('And so is a publish nothing waits on', async () => {
      const res = await page.request.post(
        `/api/work-items/${seed.lonelyKey}/design-evidence/upload-token`,
        {
          headers: bearer,
          data: {
            files: [{ kind: 'mock', sourcePath: 'design/x/s.mock.html', contentType: 'text/html' }],
          },
        },
      );
      expect(res.status()).toBe(409);
      expect((await res.json()).code).toBe('DESIGN_EVIDENCE_NOTHING_WAITS');

      await openCard(page, seed.lonelyKey, TITLES.lonely);
      await expect(main(page).getByText(en.designResult.empty.title)).toBeVisible();
      await beat();
    });

    await chapter('An earlier result still opens — its note and screenshots as files', async () => {
      await openCard(page, seed.olderKey, TITLES.older);
      await expect(main(page).getByText(en.designResult.earlierFormat)).toBeVisible();
      await expect(main(page).getByRole('link', { name: en.designResult.openNote })).toBeVisible();
      await expect(main(page).getByRole('link', { name: en.designResult.openFile })).toHaveCount(2);
      await expect(
        main(page).getByRole('heading', { name: 'Import dialog', exact: true }),
      ).toHaveCount(0);
      await expect(main(page).getByRole('button', { name: /import\.png/ })).toHaveCount(0);
      await beat();
    });

    await chapter(
      'A design card with two pull requests: design, How to test, then the pull requests — one section',
      async () => {
        await openCard(page, seed.withPrsKey, TITLES.withPrs);
        const slots = main(page).getByRole('group', { name: en.designResult.title });
        await expect(slots).toHaveCount(1);
        await expect(slots.first().locator('iframe').first()).toBeVisible();
        await expect(
          slots.first().getByRole('link', { name: en.designResult.openNote }),
        ).toBeVisible();

        const howToTest = main(page).getByRole('group', {
          name: en.github.development.howToTest.title,
        });
        await expect(howToTest).toBeVisible();
        await expect(howToTest.getByRole('heading', { name: 'Click-path' })).toBeVisible();
        const prs = main(page).getByRole('group', {
          name: en.github.development.pullRequestsGroup,
        });
        for (const title of seed.prTitles) await expect(prs.getByText(title)).toBeVisible();

        // ONE section: the slot, How to test and both rows share the Development
        // card, in that order, and there is no Design result section heading.
        const order = await main(page).evaluate(
          (root, names) => {
            const find = (label: string) =>
              root.querySelector(`[role="group"][aria-label="${label}"]`);
            const [a, b, c] = names.map(find);
            const follows = (x: Element | null | undefined, y: Element | null | undefined) =>
              Boolean(x && y && x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
            return follows(a, b) && follows(b, c);
          },
          [
            en.designResult.title,
            en.github.development.howToTest.title,
            en.github.development.pullRequestsGroup,
          ],
        );
        expect(order).toBe(true);
        await expect(
          main(page).getByRole('heading', { level: 2, name: en.designResult.title }),
        ).toHaveCount(0);
        await beat();
      },
    );

    await chapter('An empty design card says when a result is published', async () => {
      await openCard(page, seed.emptyKey, TITLES.empty);
      await expect(main(page).getByText(en.designResult.empty.title)).toBeVisible();
      await expect(main(page).getByText(/only when other work waits on this design/)).toBeVisible();
    });

    await chapter('A mock that does not load says so, and offers a retry', async () => {
      await page.unroute('**/api/attachments/*/content');
      await page.route('**/api/attachments/*/content', (route) =>
        route.fulfill({ status: 404, body: 'gone' }),
      );
      await openCard(page, seed.withPrsKey, TITLES.withPrs);
      await expect(main(page).getByText(en.designResult.frameFailed)).toBeVisible();
      await expect(main(page).getByRole('button', { name: en.designResult.retry })).toBeVisible();
    });
  });
});
