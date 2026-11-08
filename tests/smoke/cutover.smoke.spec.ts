import { expect, test, type APIResponse, type Browser, type Page } from '@playwright/test';
import { isTigrisHost, readSmokeEnv } from './env';

// The cutover smoke walk (Story MOTIR-9712 · MOTIR-10076), run by
// `pnpm test:smoke:cutover` against the deployed origin the run names.
//
// It checks what only a deployment can get wrong: an attachment reaching the
// PRIVATE store through its presigned GET, the avatar and project image loading
// from the PUBLIC asset origin (never Tigris), and a new upload landing and
// reading back. It imports nothing from the app or from the E2E harness and
// intercepts no request. Its ONE write — a run-stamped PNG — is deleted through
// the panel in `afterAll`, whether the walk passed or failed.

const env = readSmokeEnv();
const STAMP = `cutover-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const UPLOAD_NAME = `${STAMP}.png`;
// A 1×1 transparent PNG — the smallest file the attachment allowlist takes.
const UPLOAD_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const CONTENT_PATH = /\/api\/attachments\/([^/?#]+)\/content(?:[?#]|$)/;

test.describe.configure({ mode: 'serial' });

let page: Page;
/** The item's internal id, learned from the upload's own request. */
let workItemId: string | null = null;
/** The run-stamped attachment, once the upload has answered. */
let uploadedId: string | null = null;
/**
 * Every attachment id the page has requested a content route for, in order,
 * from the context's first navigation on (MOTIR-10589). Recorded by a listener
 * armed before anything loads, because the request that names an existing
 * attachment usually comes from the item page's LOAD — an image card's
 * thumbnail — and a later click then shows that same URL from the document's
 * memory cache without asking the network again. A wait armed at the click
 * therefore never resolves on exactly the page this walk checks.
 */
const requestedContentIds: string[] = [];

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  page = await (await browser.newContext()).newPage();
  page.on('request', (req) => {
    const id = CONTENT_PATH.exec(req.url())?.[1];
    if (id && !requestedContentIds.includes(id)) requestedContentIds.push(id);
  });
});

test.afterAll(async () => {
  try {
    if (uploadedId) await deleteUploadThroughPanel();
  } finally {
    await page.context().close();
  }
});

/** The attachments file list (`ul[aria-label="Attachments"]`). */
const fileList = () => page.getByRole('list', { name: 'Attachments' });

/** Open the item page and wait for its heading. */
async function openItem(): Promise<void> {
  await page.goto(`/items/${env.itemKey}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/**
 * GET an attachment's content route with the session, not following the
 * redirect, and assert it presigns onto the private store; returns the
 * followed GET.
 */
async function readThroughPrivateStore(attachmentId: string): Promise<APIResponse> {
  const route = await page.request.get(`/api/attachments/${attachmentId}/content`, {
    maxRedirects: 0,
  });
  expect(route.status(), `content route for ${attachmentId}`).toBe(302);
  const location = route.headers()['location'] ?? '';
  const target = new URL(location, env.baseUrl);
  expect(target.hostname, `presigned GET ${location}`).toBe(env.privateStoreHost);
  expect(target.searchParams.has('X-Amz-Signature'), `presigned GET ${location}`).toBe(true);
  const followed = await page.request.get(target.toString());
  expect(followed.status(), `followed GET ${target.host}`).toBe(200);
  return followed;
}

/** Assert a rendered image loaded from the public asset origin, never Tigris. */
async function expectPublicAsset(what: string, img: ReturnType<Page['locator']>): Promise<void> {
  await expect(img, `${what} renders an image`).toBeVisible();
  const src = await img.evaluate(
    (el) => (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src,
  );
  const origin = new URL(src).origin;
  expect(isTigrisHost(new URL(src).hostname), `${what} loads from Tigris: ${src}`).toBe(false);
  expect(origin, `${what} src ${src}`).toBe(env.publicAssetOrigin);
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
      message: `${what} did not load: ${src}`,
    })
    .toBeGreaterThan(0);
}

/** Open the native chooser via the Attach button, retrying a click hydration swallowed. */
async function pickFile(): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Attach', exact: true });
  for (let attempt = 0; ; attempt++) {
    const chooser = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => null),
      trigger.click(),
    ]).then(([c]) => c);
    if (chooser) {
      await chooser.setFiles({ name: UPLOAD_NAME, mimeType: 'image/png', buffer: UPLOAD_BYTES });
      return;
    }
    if (attempt >= 4) throw new Error('filechooser never opened (5 swallowed clicks)');
  }
}

/**
 * The confirm popover the row's trash button opens (Radix renders it as
 * `role="dialog"`), picked by the file name its question carries. A bare
 * page-wide `Delete` also matches every comment's own Delete button on the
 * fixture item, a strict-mode violation that left the upload behind
 * (MOTIR-10590).
 */
const confirmDialog = () => page.getByRole('dialog').filter({ hasText: UPLOAD_NAME });

/** Delete the run-stamped file through the panel's own control, awaiting the DELETE. */
async function deleteUploadThroughPanel(): Promise<void> {
  await openItem();
  const row = fileList().getByRole('listitem').filter({ hasText: UPLOAD_NAME });
  await row.getByRole('button', { name: `Delete ${UPLOAD_NAME}` }).click();
  const deleted = page.waitForResponse(
    (res) =>
      res.request().method() === 'DELETE' && res.url().endsWith(`/api/attachments/${uploadedId}`),
  );
  await confirmDialog().getByRole('button', { name: 'Delete', exact: true }).click();
  expect((await deleted).ok(), `DELETE ${UPLOAD_NAME}`).toBe(true);
  uploadedId = null;
  if (workItemId) {
    const left = await page.request.get(`/api/work-items/${workItemId}/attachments`);
    expect(left.ok()).toBe(true);
    const { attachments } = (await left.json()) as { attachments: { filename: string }[] };
    expect(attachments.filter((a) => a.filename === UPLOAD_NAME)).toEqual([]);
  }
}

test('signs in through the real sign-in form', async () => {
  await page.goto('/sign-in');
  await page.getByRole('textbox', { name: 'Email address' }).fill(env.email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(env.password);
  const signIn = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().includes('/api/auth/sign-in/email'),
  );
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect((await signIn).status(), 'POST /api/auth/sign-in/email').toBe(200);
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(env.baseUrl);
});

test('the work item renders with its comments and attachments', async () => {
  await openItem();
  await expect(
    page.getByRole('list', { name: 'Comments' }).getByRole('listitem').first(),
  ).toBeVisible();
  await expect(fileList().getByRole('listitem').first()).toBeVisible();
});

test('an existing attachment reads back through a presigned GET on the private store', async () => {
  // The attachment's id is learned from the content route the PAGE asked for,
  // without reading the database. An image card asks for it on load; a card
  // with no thumbnail asks only when it is opened (a preview or a download), so
  // the click is made only when the load asked for nothing. The listener has
  // been recording since before the first navigation, so a request that lands
  // at any moment — before this test, or between the check and the click — is
  // counted, and the poll below never waits on a request that already happened.
  if (requestedContentIds.length === 0) {
    await fileList().getByRole('listitem').first().getByRole('button').first().click();
    await expect
      .poll(() => requestedContentIds.length, {
        message: 'opening the first attachment requested no /api/attachments/<id>/content',
      })
      .toBeGreaterThan(0);
    await page.keyboard.press('Escape');
  }
  const attachmentId = requestedContentIds[0]!;

  // The read itself goes through `page.request` — the page's cookies, and NO
  // browser cache — so the 302 onto the private store and the presigned 200 are
  // asked for afresh on every run, however often the page has shown the file.
  const followed = await readThroughPrivateStore(attachmentId);
  expect((await followed.body()).length, 'attachment body').toBeGreaterThan(0);
});

test('the avatar loads from the public asset origin', async () => {
  await expectPublicAsset(
    'the avatar',
    page.getByRole('button', { name: 'Account menu' }).locator('img'),
  );
});

test('the project image loads from the public asset origin', async () => {
  await page.getByRole('button', { name: 'Switch project' }).click();
  const row = page.getByRole('button', { name: env.projectName, exact: true });
  await expectPublicAsset(`the image of project "${env.projectName}"`, row.locator('img'));
  await page.keyboard.press('Escape');
});

test('a new attachment lands and reads back the bytes that were uploaded', async () => {
  await openItem();
  const uploaded = page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' && /\/api\/work-items\/[^/]+\/attachments$/.test(res.url()),
  );
  await pickFile();
  const response = await uploaded;
  workItemId = /\/api\/work-items\/([^/]+)\/attachments$/.exec(response.url())![1]!;
  expect(response.ok(), `upload POST ${response.status()}`).toBe(true);
  uploadedId = ((await response.json()) as { id: string }).id;

  await expect(fileList().getByRole('listitem').filter({ hasText: UPLOAD_NAME })).toBeVisible();
  const followed = await readThroughPrivateStore(uploadedId);
  expect(Buffer.compare(await followed.body(), UPLOAD_BYTES), 'bytes read back').toBe(0);
});
