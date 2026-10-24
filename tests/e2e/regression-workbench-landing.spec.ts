import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { servePrivateObjectStore } from './_helpers/object-store';
import { openAgentSession, publishDesignResult } from './_helpers/design-approval-seed';
import { seedApprovalsTab, type ApprovalsTabSeed } from './_helpers/approvals-tab-seed';
import { homeService } from '@/lib/services/homeService';
import { workItemsService } from '@/lib/services/workItemsService';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// YOU LAND ON WHAT IS WAITING ON YOU — END TO END, AND THE ACCEPTANCE RECEIPT
// FOR IT (Story MOTIR-5213 · Subtask MOTIR-5220).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The first screen after sign-in, three times. The Workbench no longer opens on a
// fixed tab: it RESOLVES — To approve if a decision is waiting on you, else In
// progress if anything of yours is moving, else To do, even when To do is empty
// (`design/workbench/design-notes.md` § 21). So the clip is three arrivals by the
// same person, each after the world has changed under them, and the strip reading
// left to right in the same order the landing decides.
//
// ── THE FIXTURE, AND WHY IT IS ONE PERSON IN THREE STATES ───────────────────
//
// The cascade reads COUNTS, so each state has to move `homeService.tabCounts`
// rather than merely create rows — and each is read back through that very
// service BEFORE the landing is asserted, so a red rung says "the fixture did not
// take" rather than "the cascade is wrong".
//
//   · RUNG 1 — a design card assigned to the reviewer is PUBLISHED for real, over
//     `/api/mcp` with the CLI grant, exactly as `acceptance-approvals-tab.spec.ts`
//     does. The `awaiting` gate is created by the product at publish, routed to
//     the reviewer. Their design card is also IN PROGRESS — so rung 1 is proven
//     against a reader who would otherwise land on In progress.
//   · RUNG 2 — that gate is marked `superseded`: nothing awaits them any more,
//     and the card they are working on is still moving. (A direct state write,
//     and a stated one: DECIDING a gate is the full-screen story's flow and its
//     E2E, not this story's.)
//   · RUNG 3 — the card is cancelled through the product's own status write.
//     Nothing awaits, nothing moves, nothing is waiting to be started: the TERMINAL
//     rung, on an empty To do.
//
// ⚠️ THIS STORY HAS NO DESTRUCTIVE ACTION, and none is invented: it re-orders tabs
// and decides where a request lands. What carries the equivalent risk is asserted
// instead — the terminal rung (a landing that failed to resolve is a blank front
// door) and an unknown `?tab=` (a 404 on the product's entrance).
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE — the rendered `workbench-page`, the resolved
// address, `aria-current`. The only holds are the recorder's pacing, taken after
// the state is already proven. No `waitForTimeout` anywhere.

test.describe.configure({ timeout: 240_000 });

// To fix joined second in the strip with Story MOTIR-6588 (design § 30). This
// receipt's own claim — the strip reads in the order the landing decides — is
// unchanged; the strip it reads has one more tab. To resume joined third with Story
// MOTIR-7701 (design § 35) on the same terms, and Planning joined second with Story
// MOTIR-7820 (MOTIR-7831), on the same terms again.
const TAB_IDS = [
  'approvals',
  'planning',
  'to-fix',
  'to-resume',
  'in-progress',
  'todo',
  'finished',
  'watching',
] as const;

async function countsFor(seed: ApprovalsTabSeed) {
  return homeService.tabCounts({
    userId: seed.reviewerId,
    workspaceId: seed.workspaceId,
    projectId: seed.projectId,
  });
}

type Locale = 'en' | 'zh';
const CATALOG = { en, zh } as const;

/**
 * The tab strip, by its accessible name in the active locale. Every tab lookup is
 * scoped to it rather than rooted at `page`: the accessibility tree excludes the
 * streamed and outgoing copies React keeps mounted mid-navigation (MOTIR-5037).
 */
function strip(page: Page, locale: Locale) {
  return page.getByRole('navigation', { name: CATALOG[locale].workbench.tabs.label });
}

/** Landed on `tab`: the resolved address, the rendered page, and the strip saying so. */
async function expectLandedOn(
  page: Page,
  tab: (typeof TAB_IDS)[number],
  locale: Locale = 'en',
): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`/workbench\\?tab=${tab}$`));
  await expect(
    page.getByRole('heading', { name: CATALOG[locale].workbench.heading, level: 1 }),
  ).toBeVisible();
  const tabs = strip(page, locale);
  await expect(tabs.getByTestId(`workbench-tab-${tab}`)).toHaveAttribute('aria-current', 'page');
  // …and on NO other tab — a strip that marked two would pass the line above.
  for (const other of TAB_IDS.filter((t) => t !== tab)) {
    await expect(tabs.getByTestId(`workbench-tab-${other}`)).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  }
}

async function useLocale(page: Page, baseURL: string, locale: 'en' | 'zh'): Promise<void> {
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: locale, url: baseURL }]);
}

test.describe('the Workbench opens on what is waiting on you', () => {
  let seed: ApprovalsTabSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedApprovalsTab(`l${Date.now().toString(36)}`);
  });

  test('three arrivals land To approve, then In progress, then To do — and an address always wins', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    // The receipt belongs to the STORY, not to this subtask.
    acceptanceStory('MOTIR-5213');
    await servePrivateObjectStore(page);

    // ── RUNG 1 — a decision is waiting on you ─────────────────────────────────
    const client = await openAgentSession(seed.token, baseURL!);
    const published = await publishDesignResult(client, seed.designKey);
    expect(published.isError ?? false).toBe(false);
    const rung1 = await countsFor(seed);
    expect(rung1.approvals, 'the published gate is routed to the reviewer').toBe(1);
    expect(rung1.inProgress, 'their design card is moving too').toBeGreaterThan(0);

    await chapter('A design is waiting on you — sign in, and you land on To approve', async () => {
      await signIn(page, seed.reviewerEmail, seed.password);
      await expectLandedOn(page, 'approvals');
    });
    await beat();

    await chapter('The strip reads in the same order the landing decides', async () => {
      const order = await strip(page, 'en')
        .locator('[data-testid^="workbench-tab-"]')
        .evaluateAll((tabs) => tabs.map((t) => t.getAttribute('data-testid')));
      expect(order).toEqual(TAB_IDS.map((t) => `workbench-tab-${t}`));
    });
    await beat();

    await chapter('In Chinese, the same landing', async () => {
      await useLocale(page, baseURL!, 'zh');
      await page.goto('/workbench');
      await expectLandedOn(page, 'approvals', 'zh');
      // Through the catalogue's own strings, never a transliteration typed here.
      const labels = zh.workbench.tabs;
      const tabs = strip(page, 'zh');
      await expect(tabs.getByTestId('workbench-tab-approvals')).toContainText(labels.toApprove);
      await expect(tabs.getByTestId('workbench-tab-in-progress')).toContainText(labels.inProgress);
      await expect(tabs.getByTestId('workbench-tab-todo')).toContainText(labels.toDo);
      await useLocale(page, baseURL!, 'en');
    });
    await beat();

    // ── RUNG 2 — nothing waits on you, but your work is moving ────────────────
    await adminDb.approvalGate.updateMany({
      where: { workItemId: seed.designId, state: 'awaiting' },
      data: { state: 'superseded' },
    });
    const rung2 = await countsFor(seed);
    expect(rung2.approvals).toBe(0);
    expect(rung2.inProgress).toBeGreaterThan(0);

    await chapter(
      'Nothing waiting any more — sign in again, and you land on In progress',
      async () => {
        await signIn(page, seed.reviewerEmail, seed.password);
        await expectLandedOn(page, 'in-progress');
      },
    );
    await beat();

    // ── RUNG 3 — nothing waits, nothing moves: the TERMINAL ───────────────────
    await workItemsService.updateStatus(seed.designId, 'cancelled', {
      userId: seed.reviewerId,
      workspaceId: seed.workspaceId,
    });
    const rung3 = await countsFor(seed);
    expect(rung3.approvals).toBe(0);
    expect(rung3.inProgress).toBe(0);
    expect(rung3.toDo, 'To do is EMPTY too — the terminal rung is unconditional').toBe(0);

    await chapter('Nothing waiting, nothing moving — you still land somewhere: To do', async () => {
      await signIn(page, seed.reviewerEmail, seed.password);
      await expectLandedOn(page, 'todo');
      // The one empty state that carries a way forward.
      await expect(page.getByRole('heading', { name: 'Nothing to start' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Find something to start' })).toHaveAttribute(
        'href',
        '/ready',
      );
    });
    await beat();

    // ── An explicit address always wins ───────────────────────────────────────
    await chapter('Ask for To approve by its address, and you get it — even empty', async () => {
      await page.goto('/workbench?tab=approvals');
      await expectLandedOn(page, 'approvals');
      await expect(
        page.getByRole('heading', { name: en.workbench.empty.approvals.title }),
      ).toBeVisible();

      // A typo in the address is not a dead end: it falls into the cascade.
      const typo = await page.goto('/workbench?tab=nonsense');
      expect(typo?.status()).toBe(200);
      await expectLandedOn(page, 'todo');
    });
    await beat();

    await chapter('And the same, in Chinese', async () => {
      await useLocale(page, baseURL!, 'zh');
      await page.goto('/workbench?tab=approvals');
      await expectLandedOn(page, 'approvals', 'zh');
      await expect(
        page.getByRole('heading', { name: zh.workbench.empty.approvals.title }),
      ).toBeVisible();
      await page.goto('/workbench?tab=nonsense');
      await expectLandedOn(page, 'todo', 'zh');
    });
  });
});
