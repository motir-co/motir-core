import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { linkPr } from './_helpers/pr-link';
import { approvalSentence } from './_helpers/approval-sentence';
import {
  API_REPO,
  WEB_REPO,
  headShaFor,
  seedApproveAndMerge,
  type ApproveAndMergeSeed,
  type SeedRepo,
  type SeededCard,
} from './_helpers/approve-and-merge-seed';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// DECIDE APPROVE-AND-MERGE FULL SCREEN — THE ACCEPTANCE RECEIPT
// (Story MOTIR-5437 · Subtask MOTIR-5442).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Most cards end in code, so the decision most often waiting in Motir is *approve
// and merge these pull requests*. This is that decision getting the full-screen
// review a design already gets: the reader clicks the ROW, and both pull requests
// and the run's How to test fill the screen. They copy a command, scroll a long
// body with the verbs still on the bottom edge, press Esc — and they are back on
// the same tab, at the same page, with the row still waiting.
//
// ── WHAT ONLY AN E2E CAN PROVE ──────────────────────────────────────────────
//
// The CLIPBOARD (a real browser write, read back), the RETURN (the overlay's open
// state IS the address and its close is a `shallowPush`, so the list underneath was
// never re-rendered), the SCROLL (band 2 owns it, and band 3's verbs stay in the
// viewport at the bottom), and the MODIFIED CLICK, which must keep the row's real
// href and leave the overlay shut.
//
// ── SITS BESIDE `acceptance-approve-and-merge.spec.ts`, NOT INSIDE IT ───────
//
// That spec is MOTIR-4909's receipt: the gate itself, pressed on the ITEM PAGE,
// through merging, queueing, a refusal and a retry. This one is MOTIR-5437's: the
// same gate READ full screen from the queue. **Nothing is approved here** — the
// deciding press belongs to 4909 and 4882 to assert end to end, and this walk
// asserts that the verbs are present, reachable, and withheld from a reader who
// may see but not decide.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE — the dialog's settled name (which the read alone
// can produce), a role, the copy control's own `data-state`, the URL, a scrollTop.
// No timed wait anywhere; the holds are `chapter()` / `beat()`'s pacing.
//
// ⚠️ THE 11xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 420_000 });
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

type Messages = typeof en;
const ZH = zh as unknown as Messages;

// ⚠️ NESTED `{ number: n }`, as the sibling receipt writes it: the number-block
// guard extracts a delivery by the KEY a number travels under
// (`tests/e2e-pull-request-number-blocks.test.ts`), and a spec that reaches the
// payload builders but yields no number is a FAILURE naming this file.
const PRS = {
  en: { web: { number: 11101 }, api: { number: 11102 } },
  zh: { web: { number: 11201 }, api: { number: 11202 } },
} as const;

type Delivery = { web: { number: number }; api: { number: number } };

/** The first fenced command of the How to test body — the one the walk copies. */
const SEED_COMMAND = 'pnpm exec playwright test tests/e2e/approve-to-merge.spec.ts';

/** Two fenced commands, and a body long enough that band 2 has to scroll. */
const HOW_TO_TEST_BODY = [
  '## Precondition',
  '',
  'Sign in as the reviewer the decision is routed to, with the story in review.',
  '',
  '## Locally',
  '',
  '```bash',
  SEED_COMMAND,
  '```',
  '',
  '```sh',
  'pnpm dev',
  '```',
  '',
  '## Click-path',
  '',
  ...Array.from(
    { length: 40 },
    (_, i) => `${i + 1}. Send a request with one key and read the answer's rate-limit headers.`,
  ),
].join('\n');

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

/** A pull request as every surface names it: `owner/name · #n`. */
const prName = (repo: SeedRepo, number: number) => `${repo.owner}/${repo.name} · #${number}`;
const headRefFor = (card: SeededCard, number: number) =>
  `ovmerge/${card.identifier.toLowerCase()}-${number}`;

/**
 * The card's Pull-requests row in the To-approve table.
 *
 * ⚠️ FILTERED BY ITS DECIDE CONTROL, not by the kind label. Each pull request of the
 * set also has its own `pull_request_merge` row (design-notes § 23 keeps Panel 7's
 * row for that kind), and in zh those rows' subject line CONTAINS the kind label —
 * the sibling receipt hit exactly that on CI run 34979375067. Only the
 * approve-and-merge row is renderable, so only it carries a *Review* button.
 */
const rowFor = (page: Page, card: SeededCard, m: Messages = en): Locator =>
  page
    .getByRole('table', { name: m.workbench.tabs.toApprove })
    .getByTestId(/^approval-row-/)
    .filter({ hasText: card.identifier })
    .filter({ has: page.getByRole('button', { name: m.workbench.approvals.review, exact: true }) });

/** The whole-row door — the `<a href="/items/<key>">` stretched behind the cells. */
const doorOf = (row: Locator, card: SeededCard, m: Messages = en): Locator =>
  row.getByRole('link', {
    name: fill(m.workbench.approvals.reviewRow, {
      key: card.identifier,
      sentence: approvalSentence(m, 'pull_request_approval', card.title),
    }),
    exact: true,
  });

/**
 * The overlay, by its SETTLED accessible name.
 *
 * The name is composed from the read's own work item, so it cannot appear before the
 * read answers — which is what makes finding it the authoritative wait rather than a
 * race against the loading frame.
 */
const overlayFor = (page: Page, card: SeededCard, m: Messages = en): Locator =>
  page.getByRole('dialog', {
    name: fill(m.approvalOverlay.dialogTitle, {
      kind: m.approvalGate.pullRequestApproval.kindLabel,
      key: card.identifier,
    }),
    exact: true,
  });

/** Band 2 — the port. Every content assertion is rooted here, so a copy of the same
 *  text elsewhere on the page cannot satisfy one. */
const portOf = (dialog: Locator, m: Messages = en): Locator =>
  dialog.getByRole('group', { name: m.approvalGate.port.label, exact: true });

/**
 * Click the row's door at its LEFT EDGE.
 *
 * Dead centre lands on the work-item cell's link, which sits on `z-10` above the door
 * precisely so it survives — `issue-list-flow.spec.ts` takes the same offset for the
 * same reason.
 */
const ROW_DOOR = { position: { x: 8, y: 22 } } as const;

/** Press a copy control and return what reached the clipboard. The wait is the
 *  control's own `data-state="copied"`, which it sets only after `writeText` resolved. */
async function copyVia(page: Page, control: Locator): Promise<string> {
  await control.click();
  await expect(control).toHaveAttribute('data-state', 'copied');
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Open both pull requests of a card, link them, and turn both green — the path a run
 *  and its CI walk, through the real webhook and the real link door. Each delivery's
 *  own response is the signal the next reads on. */
async function deliverGreen(page: Page, card: SeededCard, prs: Delivery): Promise<void> {
  const set = [
    [WEB_REPO, prs.web.number],
    [API_REPO, prs.api.number],
  ] as const;
  for (const [repo, number] of set) {
    const headRef = headRefFor(card, number);
    const opened = await postSignedWebhook(
      page.request,
      'pull_request',
      pullRequestPayload({
        action: 'opened',
        number,
        title: `${card.title} — ${repo.name}`,
        headRef,
        state: 'open',
        merged: false,
        repo,
      }),
    );
    expect(opened.status(), `open ${prName(repo, number)}`).toBe(200);
    await linkPr(page, { workItemId: card.id, repo, number, headRef });
  }
  for (const [repo, number] of set) {
    const green = await postSignedWebhook(
      page.request,
      'check_suite',
      checkSuitePayload({
        conclusion: 'success',
        headSha: headShaFor(number),
        prNumber: number,
        headBranch: headRefFor(card, number),
        repo,
      }),
    );
    expect(green.status(), `green ${prName(repo, number)}`).toBe(200);
  }
}

/** The run's How to test, on the card, at the heads its own pull requests are on.
 *  The seed publishes a short one on the first card; this replaces it with a body
 *  that has commands to copy and enough length to scroll. */
async function publishHowToTest(
  seed: ApproveAndMergeSeed,
  card: SeededCard,
  prs: Delivery,
): Promise<void> {
  const owner = await adminDb.user.findFirstOrThrow({ where: { email: seed.ownerEmail } });
  const repoRow = (providerRepoId: string) =>
    adminDb.githubRepo.findFirstOrThrow({ where: { repoId: providerRepoId } });
  const web = await repoRow(WEB_REPO.providerRepoId);
  const api = await repoRow(API_REPO.providerRepoId);
  await testInstructionsService.publish(
    {
      workItemId: card.id,
      bodyMd: HOW_TO_TEST_BODY,
      repos: [
        { repoId: web.id, commitSha: headShaFor(prs.web.number) },
        { repoId: api.id, commitSha: headShaFor(prs.api.number) },
      ],
    },
    { userId: owner.id, workspaceId: seed.workspaceId },
  );
}

test.describe('read a pull-request decision full screen, from the queue', () => {
  let seed: ApproveAndMergeSeed;

  test.beforeEach(async ({ page }) => {
    await resetDatabase();
    seed = await seedApproveAndMerge(`ovm${Date.now().toString(36)}`);
    await signIn(page, seed.ownerEmail, seed.password);
    await deliverGreen(page, seed.merged, PRS.en);
    await deliverGreen(page, seed.zh, PRS.zh);
    await publishHowToTest(seed, seed.merged, PRS.en);
    await publishHowToTest(seed, seed.zh, PRS.zh);
  });

  test('the row opens both pull requests and How to test at full size; a command copies, the verbs stay reachable, and Esc returns to the same page of the same tab', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5437');
    const pra = en.approvalGate.pullRequestApproval;
    const howToTest = en.github.development.howToTest;

    await chapter('A pull-request decision is waiting in To approve', async () => {
      await page.goto('/workbench?tab=approvals');
      const row = rowFor(page, seed.merged);
      await expect(row).toHaveCount(1, { timeout: 60_000 });
      // The kind reads as ITSELF — the row names the set, and says nothing about
      // a kind not being built.
      await expect(
        row.getByText(approvalSentence(en, 'pull_request_approval', seed.merged.title), {
          exact: true,
        }),
      ).toBeVisible();
      // The SET is named by its repositories (MOTIR-5999, design-notes § 28): no host
      // numbering in the visible text, and every `owner/name · #n` in the cell's title.
      const set = row.getByText(
        fill(en.workbench.approvals.pullRequest.repos, {
          repos: `${API_REPO.name}${en.workbench.approvals.pullRequest.separator}${WEB_REPO.name}`,
        }),
        { exact: true },
      );
      await expect(set).toBeVisible();
      await expect(set).toHaveAttribute(
        'title',
        `${prName(API_REPO, PRS.en.api.number)}, ${prName(WEB_REPO, PRS.en.web.number)}`,
      );
      await expect(row.getByText(en.workbench.approvals.notBuiltYet)).toHaveCount(0);
    });
    await beat();

    await chapter('One plain click on the row, and it opens FULL SCREEN', async () => {
      await doorOf(rowFor(page, seed.merged), seed.merged).click(ROW_DOOR);
      const dialog = overlayFor(page, seed.merged);
      await expect(dialog).toHaveCount(1, { timeout: 60_000 });
      // The overlay's open state IS the address — which is what makes it deep
      // linkable, and what Esc has to unwind.
      await expect(page).toHaveURL(
        new RegExp(`approval=${seed.merged.identifier}&approvalKind=pull_request_approval`),
      );

      const port = portOf(dialog);
      await expect(port).toHaveCount(1);
      // ONE frame over the WHOLE set: both pull-request rows and the run's own
      // How to test, in band 2 together.
      for (const [repo, number] of [
        [WEB_REPO, PRS.en.web.number],
        [API_REPO, PRS.en.api.number],
      ] as const) {
        await expect(port.locator('li').filter({ hasText: prName(repo, number) })).toHaveCount(1);
      }
      await expect(port.getByRole('group', { name: howToTest.title, exact: true })).toHaveCount(1);
      await expect(port.getByRole('heading', { name: 'Click-path' })).toBeVisible();
      // Band 3 names the consequence over the whole set, and offers ONE verb to
      // do it with — not one per pull request.
      await expect(
        dialog.getByText(
          fill(pra.consequence.named, {
            prs: fill(pra.list.pair, {
              a: prName(API_REPO, PRS.en.api.number),
              b: prName(WEB_REPO, PRS.en.web.number),
            }),
            key: seed.merged.identifier,
          }),
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        dialog.getByRole('button', { name: pra.verb.approveAndMerge, exact: true }),
      ).toHaveCount(1);
    });
    await beat();

    await chapter('A command copies with one press', async () => {
      const block = portOf(overlayFor(page, seed.merged))
        .locator('.motir-code-block')
        .filter({ hasText: SEED_COMMAND });
      await expect(block).toHaveCount(1);
      // Exactly what the author fenced: no trailing newline, no prompt character,
      // nothing the reader would have to strip before running it.
      expect(
        await copyVia(page, block.getByRole('button', { name: howToTest.code.copyAria })),
      ).toBe(SEED_COMMAND);
    });
    await beat();

    await chapter('A long How to test scrolls, and the verbs stay reachable', async () => {
      const dialog = overlayFor(page, seed.merged);
      const port = portOf(dialog);
      const approve = dialog.getByRole('button', { name: pra.verb.approveAndMerge, exact: true });
      // Band 2 owns the scroll and band 3 sits on the bottom edge (§ 24's fill
      // form), so a body taller than the viewport never takes the decision off
      // screen — the failure the whole frame is arranged to prevent.
      expect(
        await port.evaluate((el) => el.scrollHeight > el.clientHeight + 4),
        'the body is taller than the port',
      ).toBe(true);
      await port.hover();
      await page.mouse.wheel(0, 2_400);
      await expect.poll(() => port.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await expect(approve).toBeInViewport();
    });
    await beat();

    await chapter('Esc puts you back on exactly the page you left', async () => {
      await page.keyboard.press('Escape');
      await expect(overlayFor(page, seed.merged)).toHaveCount(0);
      await expect(page).toHaveURL(/\/workbench\?tab=approvals$/);
      // The row is still there, still waiting: nothing was decided here.
      await expect(rowFor(page, seed.merged)).toHaveCount(1);
    });
    await beat();

    await chapter('A modified click keeps the row’s real href instead', async () => {
      const door = doorOf(rowFor(page, seed.merged), seed.merged);
      await expect(door).toHaveAttribute('href', `/items/${seed.merged.identifier}`);
      // The app-owned half of the contract. The new tab itself is the browser's
      // native handling of a modified click on an `<a href>` — not app code, and
      // not deterministic to observe in headless chromium, so it is not asserted
      // (`issue-list-flow.spec.ts` records the same disposition). It does open one
      // here, and Playwright records it as a SECOND clip in the output directory —
      // the receipt is the main page's `video.webm`, never `video-1.webm`.
      await door.click({ ...ROW_DOOR, modifiers: ['ControlOrMeta'] });
      await expect(overlayFor(page, seed.merged)).toHaveCount(0);
      await expect(page).not.toHaveURL(/[?&]approval=/);
    });
    await beat();

    await chapter('A reader who may see but not decide gets the subject, no verbs', async () => {
      // The card's REPORTER: somebody who can see the decision and is not the one
      // it is routed to — the authority is the assignee's.
      await page.context().clearCookies();
      await signIn(page, seed.bystanderEmail, seed.password);
      await page.goto(
        `/workbench?tab=approvals&approval=${seed.merged.identifier}&approvalKind=pull_request_approval`,
      );
      const dialog = overlayFor(page, seed.merged);
      await expect(dialog).toHaveCount(1, { timeout: 60_000 });
      const port = portOf(dialog);
      await expect(
        port.locator('li').filter({ hasText: prName(WEB_REPO, PRS.en.web.number) }),
      ).toHaveCount(1);
      await expect(port.getByRole('group', { name: howToTest.title, exact: true })).toHaveCount(1);
      await expect(
        dialog.getByText(fill(en.approvalGate.waitingOn, { name: seed.ownerName })),
      ).toBeVisible();
      for (const verb of [pra.verb.approveAndMerge, en.approvalGate.verb.requestChanges]) {
        await expect(dialog.getByRole('button', { name: verb, exact: true })).toHaveCount(0);
      }
    });
    await beat();

    await chapter('The same walk in Chinese', async () => {
      const zpra = ZH.approvalGate.pullRequestApproval;
      await page.context().clearCookies();
      await signIn(page, seed.ownerEmail, seed.password);
      // Against the SITE ROOT: Playwright derives a cookie's path from the url's
      // directory, so a cookie set from a deeper page never reaches `/workbench`
      // — the sibling receipt walked its tab in English for exactly that reason.
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await page.goto('/workbench?tab=approvals');
      const row = rowFor(page, seed.zh, ZH);
      await expect(row).toHaveCount(1, { timeout: 60_000 });
      await doorOf(row, seed.zh, ZH).click(ROW_DOOR);

      const dialog = overlayFor(page, seed.zh, ZH);
      await expect(dialog).toHaveCount(1, { timeout: 60_000 });
      const port = portOf(dialog, ZH);
      await expect(
        port.locator('li').filter({ hasText: prName(WEB_REPO, PRS.zh.web.number) }),
      ).toHaveCount(1);
      await expect(
        port.getByRole('group', { name: ZH.github.development.howToTest.title, exact: true }),
      ).toHaveCount(1);
      await expect(
        dialog.getByRole('button', { name: zpra.verb.approveAndMerge, exact: true }),
      ).toHaveCount(1);
    });
  });
});
