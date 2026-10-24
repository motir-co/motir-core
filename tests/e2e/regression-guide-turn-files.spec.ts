import { readFileSync, writeFileSync } from 'node:fs';
import type { Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { servePrivateObjectStore } from './_helpers/object-store';
import {
  seedAiAugmentReplan,
  markProjectOnboarded,
  type AiAugmentReplanSeed,
} from './_helpers/ai-augment-replan-seed';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import type { AiJobsFixture, GuideJobOutcome } from '@/lib/test-ai-jobs-mock';

// ACCEPTANCE — Files on a guide turn (Story MOTIR-7471 · MOTIR-7488). The
// receipt a person watches to accept the story, walking its Verification:
//
//   1. Mid-walk at step 2, a screenshot and a log go on the turn with the words
//      "Done, see the screenshot and the log". Both upload to the card, the act
//      line reads "Reading your 2 files and KEY…", the reply says what they show,
//      and step 2 ticks.
//   2. A PDF is accepted and attached; the reply says it cannot read it.
//   3. A file type the card does not take, and an oversize file, are refused at
//      the composer: nothing uploads and nothing is sent.
//   4. The card's Attachments panel lists all three files, uploaded by the person.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// motir-ai is mocked UNDER the routes by `lib/test-ai-jobs-mock.ts` (the lane's
// `E2E_TEST_AI_JOBS=1` intercept) and the object store by `lib/test-blob-mock.ts`
// (`E2E_TEST_BLOB=1`), so the real upload route → attachment row → guide door →
// job → settle → landing chain runs. The browser's reads of the private store
// (the sent screenshot's thumbnail) are served by `servePrivateObjectStore`.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every step waits on the AUTHORITATIVE signal (CLAUDE.md): each upload's 201,
// the guide door's 200, the settle whose BODY says `guided`, and for a tick or
// an attachment the row read back from Postgres. The act line is a transient,
// so it is asserted while the settle is HELD at the network — never raced.

test.describe.configure({ timeout: 180_000 });

const JOBS_FIXTURE =
  process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-ai-jobs-fixture.json';

function readJobsFixture(): AiJobsFixture {
  try {
    return JSON.parse(readFileSync(JOBS_FIXTURE, 'utf8')) as AiJobsFixture;
  } catch {
    return {};
  }
}

/** APPEND the next guide job's answer, keeping what the mock has recorded. */
function queueGuide(outcome: GuideJobOutcome): void {
  const f = readJobsFixture();
  f.guide = [...(f.guide ?? []), outcome];
  writeFileSync(JOBS_FIXTURE, JSON.stringify(f, null, 2));
}
const queueTurn = (messageMd: string, actions: unknown[]) =>
  queueGuide({ guideTurn: { messageMd, actions } });

const guideSubmits = () =>
  (readJobsFixture().submitted ?? []).filter((s) => s.kind === 'guide_work_item');

// ── Files ───────────────────────────────────────────────────────────────────

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const SCREENSHOT = { name: 'dns-console.png', mimeType: 'image/png', buffer: PNG_1X1 };
const LOG = {
  name: 'verify-log.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('checking CNAME mail.acme.dev\nverified: true\n'),
};
const PDF = {
  name: 'registrar-invoice.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
};
const EXE = {
  name: 'setup.exe',
  mimeType: 'application/x-msdownload',
  buffer: Buffer.from('MZ'),
};
/** One byte over the 10 MiB cap (`MAX_UPLOAD_BYTES`). */
const OVERSIZE = {
  name: 'screen-recording.png',
  mimeType: 'image/png',
  buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
};

// ── Locators ────────────────────────────────────────────────────────────────

const door = (page: Page) => page.getByRole('button', { name: /Guide me through/ });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const overlay = (page: Page) => page.getByRole('dialog');
const canvas = (page: Page) => overlay(page).getByTestId('guide-canvas');
const rows = (page: Page) => canvas(page).getByTestId('guide-row');
const composer = (page: Page) => rail(page).getByPlaceholder('Tell Motir AI how the step went…');
const attachInput = (page: Page) => rail(page).getByTestId('guide-attach-input');
const trayChips = (page: Page) => rail(page).getByTestId('guide-file-chip');
const sentFiles = (page: Page) => rail(page).getByTestId('guide-turn-files');

// ── Authoritative signals ───────────────────────────────────────────────────

const isPost = (r: Response, pathname: string) =>
  new URL(r.url()).pathname === pathname && r.request().method() === 'POST';

const guideDoor = (page: Page) => page.waitForResponse((r) => isPost(r, '/api/ai/guide'));
const guideSettled = (page: Page) => page.waitForResponse((r) => isPost(r, '/api/ai/guide/settle'));

/** Resolve once `n` responses matching `pred` have arrived (armed BEFORE the action). */
function responses(page: Page, pred: (r: Response) => boolean, n: number): Promise<Response[]> {
  return new Promise((resolve) => {
    const got: Response[] = [];
    const onResponse = (r: Response) => {
      if (!pred(r)) return;
      got.push(r);
      if (got.length === n) {
        page.off('response', onResponse);
        resolve(got);
      }
    };
    page.on('response', onResponse);
  });
}

async function landed(res: Promise<Response>): Promise<void> {
  const r = await res;
  const body = (await r.json()) as { outcome?: string };
  expect(r.status(), JSON.stringify(body)).toBe(200);
  expect(body.outcome, JSON.stringify(body)).toBe('guided');
}

/**
 * Hold the NEXT settle at the network until `release()` — so the "reading"
 * act line, which shows only while the job runs, can be asserted against a
 * state that cannot end under it.
 */
async function holdNextSettle(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  // `times: 1` retires the handler after this one request — unrouting it while
  // the request is held would hand that request on before the gate opens.
  await page.route(
    '**/api/ai/guide/settle',
    async (route) => {
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  return release;
}

const storedRows = (workItemId: string) =>
  adminDb.workItemTodo.findMany({ where: { workItemId }, orderBy: { position: 'asc' } });
const doneFlags = async (workItemId: string) =>
  (await storedRows(workItemId)).map((r) => r.doneAt !== null);
const storedAttachments = (workItemId: string) =>
  adminDb.attachment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });

async function openItemPage(page: Page, key: string): Promise<void> {
  await page.goto(`/items/${key}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
}

let seed: AiAugmentReplanSeed;

test.beforeEach(async () => {
  await resetDatabase();
  writeFileSync(JOBS_FIXTURE, JSON.stringify({}, null, 2));
  seed = await seedAiAugmentReplan(`guide-files-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('Files on a guide turn — a screenshot ticks a step, a PDF is kept, all on the card', async ({
  page,
  context,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7471');
  await servePrivateObjectStore(context);

  const card = await workItemsService.createWorkItem(
    {
      projectId: seed.projectId,
      kind: 'task',
      title: 'Verify the sending domain',
      type: 'manual',
      executor: 'human',
    },
    seed.ctx,
  );
  const ids: string[] = [];
  for (const text of [
    'Sign in to the DNS console',
    'Add the CNAME record and run the verifier',
    'Send a test email',
  ]) {
    ids.push((await workItemTodosService.addTodo(card.id, { text }, seed.ctx)).todo.id);
  }
  const [s1, s2, s3] = ids as [string, string, string];
  await workItemTodosService.setTodoDone(s1, true, seed.ctx);
  const uploadPath = `/api/work-items/${card.id}/attachments`;

  await signIn(page, seed.email, seed.password);

  await chapter('The guide composer takes files', async () => {
    await openItemPage(page, card.identifier);
    queueTurn('Step 1 is done. Step 2: add the CNAME record, then run the verifier.', [
      { type: 'current_step', rowId: s2 },
    ]);
    const opened = guideDoor(page);
    const settled = guideSettled(page);
    await door(page).click();
    expect((await opened).status()).toBe(200);
    await landed(settled);
    await page.waitForURL((url) => url.searchParams.get('plan') === 'guide');
    await expect(rail(page)).toBeVisible({ timeout: 60_000 });
    await expect(rows(page).nth(1)).toHaveAttribute('data-current', 'true');
    // The target search AND the paperclip sit side by side in the field.
    await expect(rail(page).getByTestId('planning-target-trigger')).toBeVisible();
    await expect(rail(page).getByRole('button', { name: 'Attach files' })).toBeVisible();
    await beat();
  });

  await chapter('A screenshot and a log confirm step 2', async () => {
    await attachInput(page).setInputFiles([SCREENSHOT, LOG]);
    await expect(trayChips(page)).toHaveCount(2);
    await expect(trayChips(page).nth(0)).toContainText('dns-console.png');
    await expect(trayChips(page).nth(1)).toContainText('verify-log.txt');
    await composer(page).fill('Done, see the screenshot and the log.');
    await beat();

    queueTurn(
      'The screenshot shows the CNAME record saved for mail.acme.dev, and the log ends with `verified: true`. Step 2 is done — next, send a test email.',
      [
        { type: 'tick', rowId: s2 },
        { type: 'current_step', rowId: s3 },
      ],
    );
    const release = await holdNextSettle(page);
    const uploads = responses(page, (r) => isPost(r, uploadPath), 2);
    const opened = guideDoor(page);
    const settled = guideSettled(page);
    await page.getByRole('button', { name: 'Send' }).click();

    // Both files land on the card BEFORE the turn is sent.
    expect((await uploads).map((r) => r.status())).toEqual([201, 201]);
    expect((await opened).status()).toBe(200);

    // While Motir AI reads (the settle is held), the act line names the files,
    // and the sent turn carries its two file chips.
    await expect(rail(page).getByTestId('guide-progress-line')).toContainText(
      `Reading your 2 files and ${card.identifier}`,
    );
    await expect(sentFiles(page).last().getByTestId('guide-turn-file')).toHaveCount(2);
    await expect(sentFiles(page).last()).toContainText('dns-console.png');
    await expect(sentFiles(page).last()).toContainText('verify-log.txt');
    await beat();

    release();
    await landed(settled);
    await expect.poll(() => doneFlags(card.id)).toEqual([true, true, false]);
    await expect(rows(page).nth(1)).toHaveAttribute('data-todo-done', 'true');
    await expect(rows(page).nth(2)).toHaveAttribute('data-current', 'true');
    await expect(rail(page).getByTestId('guide-turn').last()).toContainText('verified: true');
    await expect(rail(page).getByTestId('guide-progress-line')).toBeEmpty();
    await beat();
  });

  await chapter('A PDF is attached, and Motir AI says it cannot read it', async () => {
    await attachInput(page).setInputFiles([PDF]);
    await expect(trayChips(page)).toHaveCount(1);
    await composer(page).fill('Here is the registrar invoice too.');
    queueTurn(
      'I can’t read PDFs, so I haven’t opened registrar-invoice.pdf — it is on the card for the team. Step 3 is next: send a test email.',
      [{ type: 'current_step', rowId: s3 }],
    );
    const uploads = responses(page, (r) => isPost(r, uploadPath), 1);
    const opened = guideDoor(page);
    const settled = guideSettled(page);
    await page.getByRole('button', { name: 'Send' }).click();
    expect((await uploads).map((r) => r.status())).toEqual([201]);
    expect((await opened).status()).toBe(200);
    await landed(settled);
    await expect(sentFiles(page).last()).toContainText('registrar-invoice.pdf');
    await expect(rail(page).getByTestId('guide-turn').last()).toContainText('I can’t read PDFs');
    await expect(trayChips(page)).toHaveCount(0);
    await beat();
  });

  await chapter('A file the card does not take is refused, and nothing is sent', async () => {
    const submitsBefore = guideSubmits().length;
    let uploadsSeen = 0;
    const countUploads = (r: Response) => {
      if (isPost(r, uploadPath)) uploadsSeen += 1;
    };
    page.on('response', countUploads);

    await attachInput(page).setInputFiles([EXE, OVERSIZE]);
    const refusals = rail(page).getByTestId('guide-file-refusal');
    await expect(refusals).toHaveCount(2);
    await expect(refusals.nth(0)).toContainText('setup.exe');
    await expect(refusals.nth(0)).toContainText("That file type isn't supported.");
    await expect(refusals.nth(1)).toContainText('screen-recording.png');
    await expect(refusals.nth(1)).toContainText('File is too large');
    // Neither queued, so there is nothing for Send to carry.
    await expect(trayChips(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    page.off('response', countUploads);
    expect(uploadsSeen).toBe(0);
    expect(guideSubmits()).toHaveLength(submitsBefore);
    expect(await storedAttachments(card.id)).toHaveLength(3);
    await beat();
  });

  await chapter('All three files are on the card', async () => {
    await page.keyboard.press('Escape');
    await page.waitForURL((url) => !url.searchParams.has('plan'));
    await openItemPage(page, card.identifier);
    const stored = await storedAttachments(card.id);
    expect(stored.map((a) => a.originalFilename)).toEqual([
      'dns-console.png',
      'verify-log.txt',
      'registrar-invoice.pdf',
    ]);
    expect(stored.every((a) => a.uploaderUserId === seed.ctx.userId)).toBe(true);
    const panel = page.getByRole('list', { name: 'Attachments' });
    for (const name of ['dns-console.png', 'verify-log.txt', 'registrar-invoice.pdf']) {
      await expect(panel.getByText(name).first()).toBeVisible();
    }
    await panel.scrollIntoViewIfNeeded();
    await beat();
  });
});
