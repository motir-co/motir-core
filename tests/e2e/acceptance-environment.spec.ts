// Acceptance E2E — a Motir repository's environment, set in Motir (Story MOTIR-9795 · Subtask
// MOTIR-9968).
//
// THE RECORDED WALK (one test, chaptered) is the story's recipe steps 1–6 as an administrator sees
// them: open Environment on the repository Motir hosts, add a plain GREETING and a secret API_KEY
// in Production, add a Preview GREETING and find Production unchanged, be refused DATABASE_URL,
// PORT and a MOTIR_ name inline, then reload and find the secret shown only as Set — with no
// Environment response carrying its value. Two further tests, unchaptered so they publish nothing,
// read the room as a member (read-only) and prove a customer repository has no room.
//
// THE RECEIPT IS CI's. This repository's acceptance lane carries
// `./.github/actions/upload-acceptance-video` (`.github/workflows/acceptance-tests.yml`), so a green
// pull-request run publishes this walk as MOTIR-9795's acceptance video; no MCP publish is made.
//
// WHY THIS LANE. The room mounts in any lane; the acceptance lane is the one that records and
// publishes a story's video, and its webServer is given the environment secrets' own key
// (`ENVIRONMENT_CONFIG_ENCRYPTION_KEY`, playwright.acceptance.config.ts), without which a secret
// cannot be sealed.
//
// ── What is real ────────────────────────────────────────────────────────────
// Everything below the browser: the four environment routes, the service, Postgres, and the
// secret's encryption. The seed builds only the actors and the two repositories through the real
// services (`environment-seed.ts`); every entry is created by the screen.
//
// THE REFUSAL. The room refuses a reserved name BEFORE it sends anything (its client check runs
// the same `isReservedEnvironmentName` the service does), so a reserved name produces no request
// from the page. The spec therefore asserts the inline refusal and that NO write left the page, and
// then sends the same PUT under the same session to prove the route itself answers 422
// `reserved_environment_name`: two layers, both observed.
//
// DETERMINISM (the coding convention § E2E): every save arms `page.waitForResponse` for its PUT
// before the click and awaits status and body before the next step; tab switches and the reload
// wait for their GET. `beat()` / `chapter()` are pacing only. No `waitForTimeout`.
import type { Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedEnvironmentRoom, type EnvironmentSeed } from './_helpers/environment-seed';
import en from '@/messages/en.json';

const t = en.settings.environment;
const ROOM = '/settings/project/environment';
const SECRET = 's3cret-9795-acceptance';

// The recorded walk is paced for the video; it runs about a minute.
test.describe.configure({ timeout: 240_000 });

let seed: EnvironmentSeed;

test.beforeEach(async () => {
  await resetDatabase();
  seed = await seedEnvironmentRoom(`${Date.now()}`);
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ── The wire ──────────────────────────────────────────────────────────────────

const API = /\/api\/projects\/[^/]+\/repositories\/[^/]+\/environments\/[^/]+\//;
const isEnvironmentApi = (res: Response) => API.test(new URL(res.url()).pathname);

interface Captured {
  method: string;
  path: string;
  status: number;
  body: string;
}

/** Every Environment API response from now on, with its body. */
function captureEnvironmentResponses(page: Page): Captured[] {
  const captured: Captured[] = [];
  page.on('response', async (res) => {
    if (!isEnvironmentApi(res)) return;
    const body = res.status() === 204 ? '' : await res.text().catch(() => '');
    captured.push({
      method: res.request().method(),
      path: new URL(res.url()).pathname,
      status: res.status(),
      body,
    });
  });
  return captured;
}

const entriesGet = (page: Page, environment: string) =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname.endsWith(`/environments/${environment}/entries`),
  );

const entryPut = (page: Page, environment: string, name: string) =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'PUT' &&
      new URL(res.url()).pathname.endsWith(`/environments/${environment}/entries/${name}`),
  );

// ── The room ──────────────────────────────────────────────────────────────────

const addRow = (page: Page) => page.getByRole('main').getByTestId('environment-add');
const entry = (page: Page, name: string) =>
  page.locator(`[data-testid="environment-entry"][data-name="${name}"]`);

async function openRoom(page: Page, query = ''): Promise<void> {
  const loaded = entriesGet(page, 'production');
  await page.goto(`${ROOM}${query}`);
  expect((await loaded).status()).toBe(200);
}

async function openTab(page: Page, label: string, environment: string): Promise<void> {
  const loaded = entriesGet(page, environment);
  await page.getByRole('tab', { name: label }).click();
  expect((await loaded).status()).toBe(200);
  await expect(page.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
}

/** Type a name and value, set the Secret switch, Save, and await the PUT. */
async function addEntry(
  page: Page,
  environment: string,
  name: string,
  value: string,
  secret: boolean,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const row = addRow(page);
  await row.getByRole('textbox', { name: t.column.name }).fill(name);
  const switchEl = row.getByRole('switch', { name: t.add.secret });
  if ((await switchEl.getAttribute('aria-checked')) !== String(secret)) await switchEl.click();
  await expect(switchEl).toHaveAttribute('aria-checked', String(secret));
  await row.getByLabel(t.column.value, { exact: true }).fill(value);
  const saved = entryPut(page, environment, name);
  await row.getByRole('button', { name: t.add.save }).click();
  const res = await saved;
  return { status: res.status(), body: (await res.json()) as Record<string, unknown> };
}

/** The secret in no text node, input value or attribute of the page. */
async function expectSecretNowhereInPage(page: Page, secret: string): Promise<void> {
  const found = await page.evaluate((needle) => {
    const hits: string[] = [];
    if (document.body.innerText.includes(needle)) hits.push('text');
    for (const el of Array.from(document.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        if (attr.value.includes(needle)) hits.push(`${el.tagName}@${attr.name}`);
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (el.value.includes(needle)) hits.push(`${el.tagName}.value`);
      }
    }
    return hits;
  }, secret);
  expect(found).toEqual([]);
}

// ═══ The recorded walk ═══════════════════════════════════════════════════════

test('an administrator sets a production secret and a preview value; the secret shows only as Set, and reserved names are refused', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9795');
  await signIn(page, seed.adminEmail, seed.password);
  const wire = captureEnvironmentResponses(page);

  await chapter('Open Environment on the repository Motir hosts', async () => {
    await openRoom(page);
    await expect(page.getByRole('heading', { level: 1, name: t.title })).toBeVisible();
    await expect(page.getByRole('combobox', { name: t.repositoryLabel })).toContainText(
      seed.motirRepoName,
    );
    const tabs = page.getByRole('tablist', { name: t.tablistLabel }).getByRole('tab');
    await expect(tabs).toHaveText([t.tab.production, t.tab.preview]);
    // No Release tab for a project that is not live, in a train (MOTIR-7137 · MOTIR-7136).
    await expect(page.getByRole('tab', { name: t.tab.release })).toHaveCount(0);
    await expect(page.getByRole('note')).toHaveCount(0);
  });

  await chapter('Add a plain GREETING in Production', async () => {
    const res = await addEntry(page, 'production', 'GREETING', 'hello-prod', false);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      outcome: 'created',
      entry: { name: 'GREETING', isSecret: false, value: 'hello-prod' },
    });
    await expect(entry(page, 'GREETING')).toContainText('hello-prod');
    await expect(
      entry(page, 'GREETING').getByRole('button', { name: 'Edit GREETING' }),
    ).toBeEnabled();
    await beat();
  });

  await chapter('Add the secret API_KEY in Production', async () => {
    const res = await addEntry(page, 'production', 'API_KEY', SECRET, true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      outcome: 'created',
      entry: { name: 'API_KEY', isSecret: true, value: null },
    });
    const row = entry(page, 'API_KEY');
    await expect(row).toContainText(t.set);
    await expect(row.getByRole('button', { name: 'Replace API_KEY' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Delete API_KEY' })).toBeVisible();
    // The add row is cleared, so the secret is not left sitting in a field.
    await expect(addRow(page).getByRole('textbox', { name: t.column.name })).toHaveValue('');
    await expect(addRow(page).getByLabel(t.column.value, { exact: true })).toHaveValue('');
    await expectSecretNowhereInPage(page, SECRET);
    await beat();
  });

  await chapter('Add GREETING in Preview — Production keeps its own', async () => {
    await openTab(page, t.tab.preview, 'preview');
    const res = await addEntry(page, 'preview', 'GREETING', 'hello-preview', false);
    expect(res.status).toBe(200);
    await expect(entry(page, 'GREETING')).toContainText('hello-preview');
    await beat();
    await openTab(page, t.tab.production, 'production');
    await expect(entry(page, 'GREETING')).toContainText('hello-prod');
    await expect(entry(page, 'GREETING')).not.toContainText('hello-preview');
    await beat();
  });

  await chapter('DATABASE_URL, PORT and MOTIR_ names are refused inline', async () => {
    const before = wire.filter((r) => r.method === 'PUT').length;
    const refuse = async (name: string) => {
      const row = addRow(page);
      const nameBox = row.getByRole('textbox', { name: t.column.name });
      await nameBox.fill(name);
      await row.getByLabel(t.column.value, { exact: true }).fill('nope');
      await row.getByRole('button', { name: t.add.save }).click();
      const alert = page.getByRole('main').getByTestId('environment-add-error');
      await expect(alert).toHaveRole('alert');
      await expect(alert).toContainText(name);
      await expect(nameBox).toBeFocused();
      await expect(entry(page, name)).toHaveCount(0);
      await beat();
    };
    await refuse('DATABASE_URL');
    await openTab(page, t.tab.preview, 'preview');
    await refuse('PORT');
    await refuse('MOTIR_ANYTHING');
    // The room refused before sending: no write left the page for any of them…
    expect(wire.filter((r) => r.method === 'PUT').length).toBe(before);
    // …and the route itself refuses the same write, under the same session.
    for (const [environment, name] of [
      ['production', 'DATABASE_URL'],
      ['preview', 'PORT'],
      ['preview', 'MOTIR_ANYTHING'],
    ] as const) {
      const res = await page.request.put(
        `/api/projects/${seed.projectKey}/repositories/${seed.motirRepoId}/environments/${environment}/entries/${name}`,
        { data: { value: 'nope', isSecret: false } },
      );
      expect(res.status()).toBe(422);
      expect(((await res.json()) as { error: { code: string; name: string } }).error).toMatchObject(
        { code: 'reserved_environment_name', name },
      );
    }
    expect(await adminDb.environmentConfigEntry.count()).toBe(3);
  });

  await chapter(
    'After a reload the secret is still only Set, on the page and on the wire',
    async () => {
      // The room keeps its tab in the address, so back to Production first: the
      // reload then re-reads the environment the secret lives in.
      await openTab(page, t.tab.production, 'production');
      await expect(page).toHaveURL(/environment=production/);
      const reloaded = entriesGet(page, 'production');
      await page.reload();
      const res = await reloaded;
      expect(res.status()).toBe(200);
      const listed = (await res.json()) as Array<{
        name: string;
        isSecret: boolean;
        value: unknown;
      }>;
      expect(listed).toContainEqual(
        expect.objectContaining({ name: 'API_KEY', isSecret: true, value: null }),
      );
      await expect(entry(page, 'API_KEY')).toContainText(t.set);
      await expect(
        entry(page, 'API_KEY').getByRole('button', { name: 'Replace API_KEY' }),
      ).toBeVisible();
      await expectSecretNowhereInPage(page, SECRET);

      // The capture is not empty — a GET and a PUT at least — and no body carries the
      // secret or a sealed value.
      expect(wire.some((r) => r.method === 'GET' && r.path.endsWith('/entries'))).toBe(true);
      expect(wire.some((r) => r.method === 'PUT')).toBe(true);
      const [stored] = await adminDb.environmentConfigEntry.findMany({
        where: { name: 'API_KEY' },
      });
      expect(stored!.value.startsWith('v1.')).toBe(true);
      for (const r of wire) {
        expect(r.body, `${r.method} ${r.path}`).not.toContain(SECRET);
        expect(r.body, `${r.method} ${r.path}`).not.toContain(stored!.value);
        expect(r.body, `${r.method} ${r.path}`).not.toContain('v1.');
      }
      await beat();
    },
  );
});

// ═══ Unrecorded ══════════════════════════════════════════════════════════════

test('a member without administration rights reads the room, read-only', async ({ page }) => {
  // The administrator's values, created through the screen's own route.
  await signIn(page, seed.adminEmail, seed.password);
  for (const [name, value, isSecret] of [
    ['GREETING', 'hello-prod', false],
    ['API_KEY', SECRET, true],
  ] as const) {
    const res = await page.request.put(
      `/api/projects/${seed.projectKey}/repositories/${seed.motirRepoId}/environments/production/entries/${name}`,
      { data: { value, isSecret } },
    );
    expect(res.status()).toBe(200);
  }

  await signIn(page, seed.memberEmail, seed.password);
  await openRoom(page);
  await expect(page.getByRole('note')).toHaveText(t.readOnly.note);
  await expect(entry(page, 'GREETING')).toContainText('hello-prod');
  await expect(entry(page, 'API_KEY')).toContainText(t.set);
  await expectSecretNowhereInPage(page, SECRET);
  for (const name of ['Edit GREETING', 'Delete GREETING', 'Replace API_KEY', 'Delete API_KEY']) {
    await expect(page.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
  }
  const save = addRow(page).getByRole('button', { name: t.add.save });
  await expect(save).toHaveAttribute('aria-disabled', 'true');
  await expect(addRow(page).getByRole('textbox', { name: t.column.name })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await save.hover();
  await expect(page.getByRole('tooltip')).toHaveText(t.readOnly.tooltip);
});

test('a customer repository is not offered, and its address answers not-found', async ({
  page,
}) => {
  await signIn(page, seed.adminEmail, seed.password);
  await openRoom(page);
  await page.getByRole('combobox', { name: t.repositoryLabel }).click();
  const options = page.getByRole('option');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText(seed.motirRepoName);
  await expect(page.getByRole('listbox')).not.toContainText(seed.customerRepoName);
  await page.keyboard.press('Escape');

  await page.goto(`${ROOM}?repository=${seed.customerRepoId}`);
  await expect(page.getByRole('main').getByTestId('environment-not-found')).toContainText(
    t.notFound.title,
  );
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('link', { name: t.notFound.back })).toHaveAttribute('href', ROOM);
});
