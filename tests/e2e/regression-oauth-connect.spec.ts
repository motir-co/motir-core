import { test, expect } from './_helpers/promoted-regression';
import { db, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  APP_NAME,
  answerLoopback,
  appContext,
  authorizeRequest,
  callTool,
  exchangeCode,
  openConnectedApps,
  openConsent,
  pickWorkspace,
  pressAndReturn,
  registerApp,
  seedOAuthConnect,
  type OAuthConnectSeed,
} from './_helpers/oauth-connect-seed';

// SIGN IN WITH MOTIR FROM CLAUDE — THE ACCEPTANCE RECEIPT (Story MOTIR-6973 ·
// Subtask MOTIR-6988). The story's verification recipe, in a real browser
// against a real database, recorded and PACED for a person to watch.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// An MCP app (the spec plays it, over plain HTTP with no browser session)
// registers itself and sends the person to Motir. The consent screen says who
// is asking — self-registered, so Unverified — and where it will send them back.
// The person, who belongs to two workspaces, picks the SECOND one, keeps All
// projects, and approves. The browser lands on the app's loopback address with
// a code; the app exchanges it and lists projects, and gets only that
// workspace's project. Then Settings → Account shows the connection, used a
// moment ago, and Revoke cuts it off: the app's next call is refused.
//
// The pacing holds (`beat()`) sit on what a reviewer must read: the consent
// screen before Approve, the connected state, the row before Revoke, and the
// empty list after. Every other wait is an authoritative signal — the consent
// route's response, the redirect, the list read, the 401. The unrecorded cases
// (Deny, a narrowed grant, signed out, a bad request, the empty and error
// states) are `oauth-connect.spec.ts`.

let seed: OAuthConnectSeed;

test.beforeEach(async () => {
  await resetDatabase();
  seed = await seedOAuthConnect(`oauth-accept-${Date.now().toString(36)}@example.com`);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('an app connects to the workspace the person picks, reads only there, and Revoke cuts it off', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6973');
  test.setTimeout(300_000);
  const app = await appContext();
  let accessToken = '';

  await chapter('Signed in as a person with two workspaces', async () => {
    await signIn(page, seed.email, seed.password);
    await answerLoopback(page);
  });

  await chapter(`${APP_NAME} asks to connect — the consent screen says who and where`, async () => {
    const clientId = await registerApp(app);
    const pending = authorizeRequest(clientId);
    await openConsent(page, pending);
    await expect(
      page.getByRole('heading', { name: `Connect ${APP_NAME} to Motir?` }),
    ).toBeVisible();
    await expect(page.getByText('Unverified').first()).toBeVisible();
    await expect(page.getByRole('main').getByText(/An app on this computer/)).toBeVisible();
    await beat();

    const picker = page.getByRole('combobox', { name: `Workspace ${APP_NAME} can act in` });
    await picker.click();
    await expect(page.getByRole('option', { name: seed.homeLabel })).toBeVisible();
    await expect(page.getByRole('option', { name: seed.targetLabel })).toBeVisible();
    await page.keyboard.press('Escape');
    // The trigger is a toggle: a click while the menu is still open SHUTS it, so
    // wait on the closed state before pickWorkspace opens it again (MOTIR-7345).
    await expect(picker).toHaveAttribute('aria-expanded', 'false');
    await pickWorkspace(page, seed.targetLabel);
    await expect(page.getByRole('button', { name: 'All projects' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await beat();

    const back = await pressAndReturn(page, 'Approve and connect');
    expect(back.searchParams.get('state')).toBe(pending.state);
    const code = back.searchParams.get('code');
    expect(code).toBeTruthy();
    await expect(page.getByRole('heading', { name: `Back in ${APP_NAME}` })).toBeVisible();
    await beat();
    accessToken = await exchangeCode(app, clientId, code!, pending.verifier);
  });

  await chapter(`${APP_NAME} reads — and sees only the workspace it was given`, async () => {
    const listed = await callTool(accessToken, 'list_projects');
    expect(listed.kind).toBe('ok');
    const text = listed.kind === 'ok' ? listed.text : '';
    expect(text).toContain(seed.targetProjectKey);
    expect(text).not.toContain(seed.homeProjectKey);
  });

  await chapter('Settings → Account shows the connection, used a moment ago', async () => {
    await openConnectedApps(page);
    const row = page.getByRole('main').getByTestId('connected-app-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(APP_NAME);
    await expect(row).toContainText(seed.targetWorkspaceName);
    await expect(row).toContainText('All projects');
    await expect(row).not.toContainText('Never');
    await row.scrollIntoViewIfNeeded();
    await beat();
  });

  await chapter('Revoke — the row goes, and the app’s next call is refused', async () => {
    await page
      .getByRole('button', { name: `Revoke ${APP_NAME} in ${seed.targetWorkspaceName}` })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: `Revoke “${APP_NAME}”?` })).toBeVisible();
    await beat();
    const revoked = page.waitForResponse(
      (r) =>
        r.url().includes('/api/account/oauth-connections/') && r.request().method() === 'DELETE',
    );
    await dialog.getByRole('button', { name: 'Revoke access' }).click();
    expect((await revoked).status()).toBe(204);
    await expect(page.getByRole('main').getByTestId('connected-app-row')).toHaveCount(0);
    await expect(page.getByText(/No apps connected/).first()).toBeVisible();
    expect((await callTool(accessToken, 'list_projects')).kind).toBe('unauthorized');
    await beat();
  });

  await app.dispose();
});
