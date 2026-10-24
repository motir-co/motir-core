import { test, expect } from './_helpers/promoted-regression';
import { db, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  APP_NAME,
  CALLBACK,
  CLAUDE_CODE,
  CLAUDE_ELSEWHERE,
  HOSTED_CLAUDE,
  answerLoopback,
  appContext,
  authorizeRequest,
  openConnectedApps,
  pressAndReturn,
  registerApp,
  seedDiscoveredClient,
  seedOAuthConnect,
  type DiscoveredClient,
  type OAuthConnectSeed,
} from './_helpers/oauth-connect-seed';
import type { Page } from '@playwright/test';

// CLAUDE SHOWS AS VERIFIED WHEN IT SIGNS IN — THE ACCEPTANCE RECEIPT (Story
// MOTIR-7170 · Subtask MOTIR-7176), built to the verified-by-domain design
// (MOTIR-7172: `design/auth/oauth-consent--verified-client.mock.html` and
// `design/settings/account-settings--connected-apps--verified-client.mock.html`).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// Claude identifies itself with the document claude.ai publishes, and sends a
// signed-out person to Motir. The sign-in card says who is waiting — claude.ai,
// an app calling itself "Claude". After sign-in the consent screen leads with
// claude.ai and its sky "Verified domain" pill; the name "Claude" appears once,
// as what the app calls itself. Connected apps then lists it the same way. An
// app that merely registered itself goes through the same screens and stays
// Unverified, beside it.
//
// ── HOW THE DOCUMENT REACHES THE SERVER ─────────────────────────────────────
//
// The client rows are seeded as the cimd plugin records them
// (`seedDiscoveredClient`), and the plugin's FETCH is answered by the lane's
// `E2E_TEST_CIMD` seam (`lib/test-cimd-mock.ts`), because the plugin re-fetches a
// document its in-memory cache does not hold and its hardened transport refuses
// a local fixture server. The fetch itself, and every refusal, is the
// integration gate's (`tests/integration/oauth/`).
//
// Every assertion waits on a role, a URL or text; `beat()` only holds the frame
// for a person to read. The verified pill is asserted MOUNTED before any copy
// next to it, so no case can pass by rendering nothing.

let seed: OAuthConnectSeed;

test.beforeEach(async () => {
  await resetDatabase();
  seed = await seedOAuthConnect(`verified-${Date.now().toString(36)}@example.com`);
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** The consent screen's App asking block, for a verified app. */
async function expectVerifiedConsent(page: Page, client: DiscoveredClient): Promise<void> {
  await page.waitForURL(/\/oauth\/consent\?/);
  await expect(page.getByRole('button', { name: 'Approve and connect' })).toBeVisible();
  const main = page.getByRole('main');
  await expect(main.getByText('Verified domain', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: `Connect ${client.host} to Motir?` }),
  ).toBeVisible();
  await expect(
    main.getByText(
      `Calls itself “${client.name}” — a name it chose. Motir checked that ${client.host} publishes it.`,
    ),
  ).toBeVisible();
  await expect(main.getByText('Unverified', { exact: true })).toHaveCount(0);
}

/** Pick the target workspace in the consent picker, which names the app by `app`. */
async function pickTarget(page: Page, app: string): Promise<void> {
  const picker = page.getByRole('combobox', { name: `Workspace ${app} can act in` });
  await picker.click();
  await page.getByRole('option', { name: seed.targetLabel }).click();
  await expect(picker).toContainText(seed.targetWorkspaceName);
}

async function signInOnCard(page: Page): Promise<void> {
  await page.getByRole('main').getByPlaceholder('Email address').fill(seed.email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('main').getByPlaceholder('Password').fill(seed.password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

test('Claude signs in verified as claude.ai, and an app that registered itself stays Unverified', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7170');
  test.setTimeout(300_000);
  const callback = HOSTED_CLAUDE.redirectUris[0]!;
  await seedDiscoveredClient(HOSTED_CLAUDE);
  await answerLoopback(page, callback);
  await answerLoopback(page);

  const pending = authorizeRequest(HOSTED_CLAUDE.clientId, { redirectUri: callback });

  await chapter(
    'Claude sends a signed-out person to Motir — the sign-in card names claude.ai',
    async () => {
      await page.goto(pending.url);
      await page.waitForURL(/\/sign-in/);
      const banner = page.getByRole('main').getByText('Connecting an app').locator('..');
      await expect(banner).toContainText(
        'claude.ai, an app calling itself “Claude” — you’ll pick a workspace and approve next.',
      );
      await expect(banner.locator('b')).toHaveText('claude.ai');
      await beat();
      await signInOnCard(page);
    },
  );

  await chapter('Consent leads with claude.ai and its Verified domain pill', async () => {
    await expectVerifiedConsent(page, HOSTED_CLAUDE);
    await beat();
    await pickTarget(page, 'claude.ai');
    const back = await pressAndReturn(page, 'Approve and connect', callback);
    expect(back.searchParams.get('state')).toBe(pending.state);
    expect(back.searchParams.get('code')).toBeTruthy();
  });

  await chapter('An app that registered itself asks too — and stays Unverified', async () => {
    const app = await appContext();
    const clientId = await registerApp(app);
    const pending = authorizeRequest(clientId);
    await page.goto(pending.url);
    await page.waitForURL(/\/oauth\/consent\?/);
    await expect(page.getByRole('button', { name: 'Approve and connect' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: `Connect ${APP_NAME} to Motir?` }),
    ).toBeVisible();
    await expect(page.getByRole('main').getByText('Unverified', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByText('Verified domain')).toHaveCount(0);
    await beat();
    await pickTarget(page, APP_NAME);
    await pressAndReturn(page, 'Approve and connect', CALLBACK);
    await app.dispose();
  });

  await chapter(
    'Connected apps lists claude.ai as verified, beside the Unverified app',
    async () => {
      await openConnectedApps(page);
      const rows = page.getByRole('main').getByTestId('connected-app-row');
      await expect(rows).toHaveCount(2);
      const verified = rows.filter({ hasText: 'Verified domain' });
      await expect(verified).toHaveCount(1);
      await expect(verified).toContainText('claude.ai');
      await expect(verified).toContainText('Calls itself “Claude”');
      const unverified = rows.filter({ hasText: 'Unverified' });
      await expect(unverified).toHaveCount(1);
      await expect(unverified).toContainText(APP_NAME);
      await verified.scrollIntoViewIfNeeded();
      await beat();
    },
  );
});

test('a document calling itself “Claude” from another host reads as THAT host', async ({
  page,
}) => {
  await seedDiscoveredClient(CLAUDE_ELSEWHERE);
  await signIn(page, seed.email, seed.password);
  const pending = authorizeRequest(CLAUDE_ELSEWHERE.clientId, {
    redirectUri: CLAUDE_ELSEWHERE.redirectUris[0]!,
  });
  await page.goto(pending.url);
  await expectVerifiedConsent(page, CLAUDE_ELSEWHERE);
  await expect(page.getByRole('heading', { name: /claude\.ai/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Connect Claude to Motir?' })).toHaveCount(0);
});

test('Claude Code verifies as claude.ai and returns to this computer', async ({ page }) => {
  await seedDiscoveredClient(CLAUDE_CODE);
  await signIn(page, seed.email, seed.password);
  // Its document lists `http://127.0.0.1/callback`; the app listens on a port of
  // its own, which a loopback redirect is matched without (RFC 8252).
  const pending = authorizeRequest(CLAUDE_CODE.clientId);
  await page.goto(pending.url);
  await expectVerifiedConsent(page, CLAUDE_CODE);
  await expect(page.getByRole('main').getByText('localhost', { exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByText(/An app on this computer/)).toBeVisible();
});

test('Revoke names the app and its verified host, and removes the row', async ({ page }) => {
  await seedDiscoveredClient(HOSTED_CLAUDE);
  const callback = HOSTED_CLAUDE.redirectUris[0]!;
  await signIn(page, seed.email, seed.password);
  await answerLoopback(page, callback);
  const pending = authorizeRequest(HOSTED_CLAUDE.clientId, { redirectUri: callback });
  await page.goto(pending.url);
  await expectVerifiedConsent(page, HOSTED_CLAUDE);
  await pickTarget(page, 'claude.ai');
  await pressAndReturn(page, 'Approve and connect', callback);

  await openConnectedApps(page);
  const row = page.getByRole('main').getByTestId('connected-app-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByText('Verified domain')).toBeVisible();
  await page
    .getByRole('button', { name: `Revoke claude.ai in ${seed.targetWorkspaceName}` })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('heading', { name: 'Revoke “Claude” from claude.ai?' }),
  ).toBeVisible();
  await expect(dialog).toContainText('claude.ai, the app calling itself Claude, loses access');
  const revoked = page.waitForResponse(
    (r) => r.url().includes('/api/account/oauth-connections/') && r.request().method() === 'DELETE',
  );
  await dialog.getByRole('button', { name: 'Revoke access' }).click();
  expect((await revoked).status()).toBe(204);
  await expect(page.getByRole('main').getByTestId('connected-app-row')).toHaveCount(0);
});
