import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { checkSuitePayload, postSignedWebhook, pullRequestPayload } from './_helpers/github-seed';
import { linkPr } from './_helpers/pr-link';
import {
  FIX_REPO,
  headShaFor,
  seedRepairFix,
  type RepairCard,
  type RepairFixSeed,
} from './_helpers/repair-fix-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// HAND A RED PULL REQUEST TO AN AGENT — `motir fix <key>` — THE ACCEPTANCE RECEIPT
// (Story MOTIR-5460 · Subtask MOTIR-5468).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// A card is Implemented and its pull request's checks are red. The Development block
// says which pull request is failing and offers ONE command, `motir fix <key>`, which
// copies exactly. Somebody else's agent claims the repair first: the block now says WHO
// is fixing it and offers no command, and a second claim is refused naming that person.
// The fix is pushed, the checks go green, and the card moves itself to In Review — the
// callout is gone. Then the offer and the "who" read in Chinese.
//
// ── THE SEAMS THIS LANE USES ────────────────────────────────────────────────
//
//   * The pull request, its RED check and its GREEN check — SIGNED deliveries to the
//     real `/api/github/webhook` route (`github-seed.ts`: `postSignedWebhook` with
//     `pullRequestPayload` / `checkSuitePayload`). The red verdict the block reads and
//     the In Review the walk asserts are both the CI feedback path's own writes; no
//     check row and no status is written by this file.
//   * The link — the real link door (`pr-link.ts`).
//   * The claim — the shipped `POST /api/v1/work-items/{key}/repair`, called with each
//     person's own project-bound token (`repair-fix-seed.ts` mints them).
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE: a webhook's own response and `result` body, the claim's
// response, a v1 read of the card's status, or the rendered part after a reload. No timed
// wait anywhere in this file; the holds are `chapter()` / `beat()`'s, taken after the
// assertion.
//
// ⚠️ THE 12xxx BLOCK IS THIS SPEC'S (`tests/e2e-pull-request-number-blocks.test.ts`).

test.describe.configure({ timeout: 300_000 });
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const PRS = { en: { number: 12101 }, zh: { number: 12201 } } as const;
type Locale = keyof typeof PRS;

const REPO_NAME = `${FIX_REPO.owner}/${FIX_REPO.name}`;
const headRefFor = (card: RepairCard) => `fix/${card.identifier.toLowerCase()}`;
/** A pull request as the fix part names it: `owner/name · #n`. */
const prName = (locale: Locale) => `${REPO_NAME} · #${PRS[locale].number}`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A rich message with its tags read as the rendered text reads them: `<b>` keeps its
 *  children, `<prs>` becomes the pull request, `<when>` becomes ANY relative time. */
function richPattern(template: string, vars: Record<string, string>): RegExp {
  const parts = template.split(/<when><\/when>/);
  const literal = (s: string) =>
    escape(
      s
        .replace(/<\/?b>/g, '')
        .replace(/<prs><\/prs>/g, vars['prs'] ?? '')
        .replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? ''),
    );
  return new RegExp(parts.map(literal).join('.+'));
}

/** The Development block's fix part — a labelled group. */
const fixPart = (page: Page, messages: typeof en = en): Locator =>
  page.getByRole('group', { name: messages.github.development.fix.aria.part, exact: true });

/** The detail rail's Status field card (the `approval-gate-repaint.spec.ts` precedent). */
const statusCard = (page: Page): Locator =>
  page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });

/** A request context that speaks as ONE person's token, with no browser session. */
async function asToken(
  playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } },
  baseURL: string,
  token: string,
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

interface ClaimBody {
  key: string;
  outcome: 'claimed' | 'mine' | 'taken' | 'not_repairable';
  reason: string | null;
  holder: { id: string; name: string | null } | null;
  pullRequests: Array<{ repo: string; number: number; ci: string; failingChecks: string[] }>;
}

async function claimRepair(api: APIRequestContext, key: string): Promise<ClaimBody> {
  const res = await api.post(`/api/v1/work-items/${key}/repair`);
  const text = await res.text();
  expect(res.status(), `repair ${key} → ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text) as ClaimBody;
}

/** One signed delivery; asserts the route answered and what the sync reported. */
async function deliver(
  page: Page,
  event: 'pull_request' | 'check_suite',
  payload: Record<string, unknown>,
  expected: Record<string, unknown>,
): Promise<void> {
  const res = await postSignedWebhook(page.request, event, payload);
  const body = await res.text();
  expect(res.status(), `${event} → ${body.slice(0, 400)}`).toBe(200);
  expect((JSON.parse(body) as { result: Record<string, unknown> }).result).toMatchObject(expected);
}

/** Link, open and fail a card's pull request — the path a run and its red CI walk. */
async function deliverRed(page: Page, card: RepairCard, locale: Locale): Promise<void> {
  const number = PRS[locale].number;
  const headRef = headRefFor(card);
  await linkPr(page, { workItemId: card.id, repo: FIX_REPO, number, headRef });
  await deliver(
    page,
    'pull_request',
    pullRequestPayload({
      action: 'opened',
      number,
      title: card.title,
      headRef,
      state: 'open',
      merged: false,
      repo: FIX_REPO,
    }),
    { event: 'pull_request', outcome: 'transitioned', toStatus: 'implemented' },
  );
  await deliver(
    page,
    'check_suite',
    checkSuitePayload({
      conclusion: 'failure',
      headSha: headShaFor(number, 1),
      prNumber: number,
      headBranch: headRef,
      repo: FIX_REPO,
    }),
    { event: 'ci', outcome: 'failed', ciState: 'failing' },
  );
}

/** The card's status as the v1 read reports it — committed state, not the page. */
async function statusOf(api: APIRequestContext, key: string): Promise<string> {
  const res = await api.get(`/api/v1/work-items/${key}`);
  expect(res.status(), `read ${key}`).toBe(200);
  return ((await res.json()) as { status: string }).status;
}

test.describe('hand a red pull request to an agent — motir fix', () => {
  let seed: RepairFixSeed;

  test.beforeEach(async ({ page }) => {
    // Pull-request numbers are a namespace shared across the lane; the reset makes this
    // spec independent of what ran before it (MOTIR-3248).
    await resetDatabase();
    seed = await seedRepairFix(Date.now().toString(36));
    await signIn(page, seed.ada.email, seed.password);
    await deliverRed(page, seed.en, 'en');
    await deliverRed(page, seed.zh, 'zh');
  });

  test('a red card offers motir fix, names who is fixing it, and leaves once the checks go green', async ({
    page,
    playwright,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-5460');
    const fix = en.github.development.fix;
    const key = seed.en.identifier;
    const command = `motir fix ${key}`;
    const adaApi = await asToken(playwright, baseURL!, seed.ada.token);
    const benApi = await asToken(playwright, baseURL!, seed.ben.token);

    await chapter('The checks are red: the card offers one command', async () => {
      expect(await statusOf(adaApi, key)).toBe('implemented');
      await page.goto(`/items/${key}`);
      const part = fixPart(page);
      await expect(part).toHaveAttribute('data-state', 'offer', { timeout: FIRST_PAINT_MS });
      await expect(part.getByRole('heading', { level: 4, name: fix.title })).toBeVisible();
      await expect(part).toContainText(richPattern(fix.failingOn, { prs: prName('en') }));
      await expect(part.getByText(command, { exact: true })).toBeVisible();
      await expect(statusCard(page)).toContainText('Implemented');
      // For the camera: the part sits below the fold. The assertions above already hold.
      await part.scrollIntoViewIfNeeded();
    });
    await beat();

    await chapter('Copy puts exactly the command on the clipboard', async () => {
      const copy = fixPart(page).getByRole('button', {
        name: en.github.development.howToTest.code.copyAria,
        exact: true,
      });
      await copy.click();
      // The control's own state, set only after `writeText` resolved.
      await expect(copy).toHaveAttribute('data-state', 'copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
    });
    await beat();

    await chapter('Ben’s agent claims the repair', async () => {
      const claim = await claimRepair(benApi, key);
      expect(claim.outcome).toBe('claimed');
      expect(claim.holder?.name).toBe(seed.ben.name);
      expect(claim.pullRequests).toEqual([
        expect.objectContaining({ repo: REPO_NAME, number: PRS.en.number, ci: 'failing' }),
      ]);
    });

    await chapter('Ada reloads: Ben is fixing it, and there is no command to run', async () => {
      await page.reload();
      const part = fixPart(page);
      await expect(part).toHaveAttribute('data-state', 'in_progress', {
        timeout: FIRST_PAINT_MS,
      });
      await expect(part).toContainText(richPattern(fix.fixing.by, { name: seed.ben.name }));
      await expect(part.getByText(fix.fixing.pill, { exact: true })).toBeVisible();
      await expect(part.getByRole('button', { name: /copy/i })).toHaveCount(0);
      await expect(part.getByText(command, { exact: true })).toHaveCount(0);
      await part.scrollIntoViewIfNeeded();
    });
    await beat();

    await chapter('A second claim is refused, naming Ben', async () => {
      const claim = await claimRepair(adaApi, key);
      expect(claim.outcome).toBe('taken');
      expect(claim.holder?.name).toBe(seed.ben.name);
      // A rival is handed no branches.
      expect(claim.pullRequests).toEqual([]);
    });

    await chapter('The fix is pushed and the checks go green: the card is In Review', async () => {
      // Still Implemented until the green verdict is recorded — the claim moved nothing.
      expect(await statusOf(adaApi, key)).toBe('implemented');
      await deliver(
        page,
        'check_suite',
        checkSuitePayload({
          conclusion: 'success',
          headSha: headShaFor(PRS.en.number, 2),
          prNumber: PRS.en.number,
          headBranch: headRefFor(seed.en),
          repo: FIX_REPO,
        }),
        { event: 'ci', outcome: 'verified', ciState: 'passing' },
      );
      expect(await statusOf(adaApi, key)).toBe('in_review');
      await page.reload();
      await expect(statusCard(page)).toContainText('In Review', { timeout: FIRST_PAINT_MS });
      await expect(fixPart(page)).toHaveCount(0);
      await beat();
      // For the camera: the Development block, its pull request green and no fix part.
      await page
        .getByRole('heading', { level: 2, name: en.github.development.title, exact: true })
        .scrollIntoViewIfNeeded();
    });
    await beat();

    await chapter('In Chinese: the offer on a second red card, then who is fixing it', async () => {
      const zfix = zh.github.development.fix;
      const zkey = seed.zh.identifier;
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await page.goto(`/items/${zkey}`);
      const part = fixPart(page, zh as unknown as typeof en);
      await expect(part).toHaveAttribute('data-state', 'offer', { timeout: FIRST_PAINT_MS });
      await expect(part.getByRole('heading', { level: 4, name: zfix.title })).toBeVisible();
      await expect(part).toContainText(richPattern(zfix.failingOn, { prs: prName('zh') }));
      await expect(part).toContainText(zfix.lead);
      await expect(part.getByText(`motir fix ${zkey}`, { exact: true })).toBeVisible();
      await expect(
        part.getByRole('button', { name: zh.github.development.howToTest.code.copyAria }),
      ).toBeVisible();
      await part.scrollIntoViewIfNeeded();
      await beat();

      const claim = await claimRepair(benApi, zkey);
      expect(claim.outcome).toBe('claimed');
      await page.reload();
      await expect(part).toHaveAttribute('data-state', 'in_progress', {
        timeout: FIRST_PAINT_MS,
      });
      await expect(part).toContainText(richPattern(zfix.fixing.by, { name: seed.ben.name }));
      await expect(part.getByText(zfix.fixing.pill, { exact: true })).toBeVisible();
      await expect(
        part.getByRole('button', { name: zh.github.development.howToTest.code.copyAria }),
      ).toHaveCount(0);
      await part.scrollIntoViewIfNeeded();
    });
    await beat();

    await adaApi.dispose();
    await benApi.dispose();
  });
});
