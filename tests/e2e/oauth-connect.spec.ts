import { expect, test } from '@playwright/test';
import { db, resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  APP_NAME,
  CALLBACK,
  answerLoopback,
  appContext,
  authorizeRequest,
  openConnectedApps,
  openConsent,
  pickWorkspace,
  pressAndReturn,
  registerApp,
  seedOAuthConnect,
  type OAuthConnectSeed,
} from './_helpers/oauth-connect-seed';

// SIGN IN WITH MOTIR FROM CLAUDE — the cases the receipt does not record (Story
// MOTIR-6973 · Subtask MOTIR-6988). The recorded happy path, connect → read →
// revoke, is `regression-oauth-connect.spec.ts`; the protocol's edges (refresh,
// `plain` PKCE, membership removal, PAT parity) are the integration gate in
// `tests/integration/oauth/`.
//
// Every wait is an authoritative signal: the consent route's response, the
// browser's arrival at the app's loopback address, the refused page's heading,
// the Connected apps list as the server rendered it.
//
// Two of the card's cases are held where the behaviour actually lives:
//
//   * A WRONG `resource` is refused back to the app with `invalid_target`, not on
//     Motir's refused page. The app's redirect is one it registered, so RFC 6749
//     §4.1.2.1 sends the error to it (`lib/auth/mcpOAuthPolicy.ts`, MOTIR-6982).
//     The refused page is for the requests that have NO trustworthy address to
//     answer — an unregistered redirect — and that case is asserted here too.
//   * Connected apps' ERROR state follows a failed SERVER read (the section is
//     seeded by the tokens page's own read, not by a browser fetch), so a
//     browser interception cannot reach it. Its rendering and its Try again are
//     covered in `tests/components/connected-apps-section.test.tsx`.

test.describe.configure({ timeout: 120_000 });

let seed: OAuthConnectSeed;

test.beforeEach(async () => {
  await resetDatabase();
  seed = await seedOAuthConnect(`oauth-connect-${Date.now().toString(36)}@example.com`);
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('a narrowed grant: one project, less than the default, shown that way in Connected apps', async ({
  page,
}) => {
  const app = await appContext();
  await signIn(page, seed.email, seed.password);
  await answerLoopback(page);
  const clientId = await registerApp(app);
  await openConsent(page, authorizeRequest(clientId));

  await pickWorkspace(page, seed.targetLabel);
  await page.getByRole('button', { name: 'One project' }).click();
  await expect(page.getByRole('combobox', { name: 'Project' })).toContainText(
    seed.targetProjectKey,
  );
  const comments = page.getByRole('switch', { name: 'Add comments' });
  await expect(comments).toHaveAttribute('aria-checked', 'true');
  await comments.click();
  await expect(comments).toHaveAttribute('aria-checked', 'false');
  const back = await pressAndReturn(page, 'Approve and connect');
  expect(back.searchParams.get('code')).toBeTruthy();

  await openConnectedApps(page);
  const row = page.getByRole('main').getByTestId('connected-app-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(seed.targetProjectName);
  await expect(row).toContainText('Custom');
  await expect(row).not.toContainText('All projects');
  await row.getByRole('button', { name: `Show scopes for ${APP_NAME}` }).click();
  await expect(page.locator('li[data-permission="comment:add"]').first()).toHaveAttribute(
    'data-granted',
    'false',
  );
  await expect(page.locator('li[data-permission="project:browse"]').first()).toHaveAttribute(
    'data-granted',
    'true',
  );
  await app.dispose();
});

test('Deny sends the app access_denied, and nothing is connected', async ({ page }) => {
  const app = await appContext();
  await signIn(page, seed.email, seed.password);
  await answerLoopback(page);
  const clientId = await registerApp(app);
  const pending = authorizeRequest(clientId);
  await openConsent(page, pending);

  const back = await pressAndReturn(page, 'Deny');
  expect(back.searchParams.get('error')).toBe('access_denied');
  expect(back.searchParams.get('state')).toBe(pending.state);
  expect(back.searchParams.get('code')).toBeNull();

  await openConnectedApps(page);
  await expect(page.getByTestId('connected-app-row')).toHaveCount(0);
  await expect(page.getByText(/No apps connected/).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'How to add Motir to Claude' })).toHaveAttribute(
    'href',
    'https://motir.co/docs/mcp',
  );
  await app.dispose();
});

test('signed out, the request goes through sign-in and comes back to the same consent', async ({
  page,
}) => {
  const app = await appContext();
  const clientId = await registerApp(app);
  const pending = authorizeRequest(clientId);

  await page.goto(pending.url);
  await page.waitForURL(/\/sign-in/);
  await page.getByRole('main').getByPlaceholder('Email address').fill(seed.email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('main').getByPlaceholder('Password').fill(seed.password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await page.waitForURL(/\/oauth\/consent\?/);
  await expect(page.getByRole('button', { name: 'Approve and connect' })).toBeVisible();
  await expect(page.getByRole('heading', { name: `Connect ${APP_NAME} to Motir?` })).toBeVisible();
  // The same request: Approve answers the state the app sent before sign-in.
  await answerLoopback(page);
  const back = await pressAndReturn(page, 'Approve and connect');
  expect(back.searchParams.get('state')).toBe(pending.state);
  await app.dispose();
});

test('a bad request never reaches consent: a wrong resource goes back to the app, an unregistered redirect stays on Motir', async ({
  page,
}) => {
  const app = await appContext();
  await signIn(page, seed.email, seed.password);
  await answerLoopback(page);
  const clientId = await registerApp(app);

  // A server redirect: read it off the response rather than following it (the
  // loopback stand-in answers navigations, not a 302's target). The request
  // carries the person's session, so this is exactly what the browser receives.
  const wrong = authorizeRequest(clientId, { resource: 'https://elsewhere.example/api/mcp' });
  const res = await page.request.get(wrong.url, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  const refused = new URL(res.headers()['location']!);
  expect(`${refused.origin}${refused.pathname}`).toBe(CALLBACK);
  expect(refused.searchParams.get('error')).toBe('invalid_target');
  expect(refused.searchParams.get('state')).toBe(wrong.state);
  expect(refused.searchParams.get('code')).toBeNull();

  const unregistered = authorizeRequest(clientId).url.replace(
    encodeURIComponent(CALLBACK),
    encodeURIComponent('https://attacker.example/cb'),
  );
  await page.goto(unregistered);
  await page.waitForURL(/\/oauth\/error\?/);
  await expect(
    page.getByRole('heading', { name: 'This connection request can’t be used' }),
  ).toBeVisible();
  await expect(page.getByRole('main').getByText('attacker.example')).toBeVisible();
  expect(new URL(page.url()).host).not.toBe('attacker.example');

  await openConnectedApps(page);
  await expect(page.getByTestId('connected-app-row')).toHaveCount(0);
  await app.dispose();
});
