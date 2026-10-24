import { expect, test } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, startSignedOut } from './_helpers/shell-session';
import {
  expectNoRailLegalRow,
  expectSignUpHasNoLegalNotice,
  readLegalHealth,
} from './_helpers/legal-manifest';

// THE ROUTE IS GONE — the arm where that is OBSERVABLE
// (Story MOTIR-4101 · Subtask MOTIR-4105).
//
// ── ⚠️ WHY THIS FILE EXISTS BESIDE `regression-legal-gone.spec.ts` ──────────
//
// Two shipped mechanisms compete for `/legal` on the application host: the route
// MOTIR-4103 deleted, and MOTIR-3884's redirect to the public site. Which one
// answers is decided by `MOTIR_PUBLIC_SITE_URL`, a process-wide server read —
// `proxy.ts`'s `publicSiteRedirect` returns `null` while the public origin
// EQUALS this application's own, and 308s otherwise. So the two arms are two
// different servers, and no per-test seam can move between them: middleware is
// the one place a `/api/_test` door cannot reach, because it is not the router.
//
// The acceptance lane configures a public origin, so it gets the 308 — the right
// assertion for a deployment like `app.motir.co`, and the one that says *nothing
// served from this repository renders a legal document*. **But it would stay
// green if `app/(public)/legal/` came back tomorrow**, because the redirect fires
// before the router is consulted. A check that cannot go red is not evidence.
//
// This lane sets NO `MOTIR_PUBLIC_SITE_URL` (see `playwright.config.ts` — it is
// the self-host posture the same way `public-selfhost.spec.ts` and
// `billing-selfhost.spec.ts` use it). So no redirect fires, the request reaches
// the router, and a deleted route answers **404**. That is the arm in which the
// DELETION is what is being asserted, and it goes red the moment the directory
// returns. Putting each arm in the lane that can host it — rather than weakening
// one assertion until a single lane fits both — is this card's own instruction.
//
// It also runs on EVERY pull request, where the acceptance lane runs only on the
// PRs that touch it. The regression this guards against is a route group being
// re-created by accident, which is not a thing that announces itself.
//
// ── AND IT IS THE TRUE SELF-HOST STATE FOR THE MANIFEST TOO ─────────────────
//
// `playwright.config.ts` sets no `MOTIR_LEGAL_DOCUMENTS` either, and after this
// story there is no `content/legal/` in the tree to fall back on. That
// combination — no manifest, no documents, no route — is exactly what someone
// who has just installed Motir runs, and until this story it could not be
// exercised at all: a build with no manifest still had the files. The acceptance
// lane reaches the same STATE through its `/api/_test/legal-manifest` door; this
// lane simply IS it, which is the stronger evidence of the two.
//
// ⚠️ NO `@/lib/db` SINGLETON WRITES — `tests/rls/test-singleton-statement-guard`
// ratchets that population down over `tests/e2e/**`. Nothing here seeds: the
// account comes from the shipped sign-up through the browser's own session.

test.describe.configure({ timeout: 120_000 });

const SELF_HOST_EMAIL = 'e2e-legal-gone-selfhost@example.com';

/** Every path the deleted route group used to answer on. */
const DELETED_LEGAL_PATHS = ['/legal', '/legal/terms', '/legal/privacy'];

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('@smoke self-host: /legal is gone from the app host, and sign-up still reads as a finished page', async ({
  page,
}) => {
  // ── 1. MOUNT THE ARM ───────────────────────────────────────────────────────
  // Two things have to be true before a 404 means "deleted", and neither is
  // visible from this file: the server must be up, and the redirect must NOT be
  // configured. `/sign-in` answers 200 for the first. For the second, a path in
  // the SAME redirect set — `/docs`, which this application has never rendered —
  // is the control: with a public origin configured it would 308, so its
  // NOT-being-a-redirect is what proves the legal 404s below are the router
  // answering rather than a redirect that happens to be missing.
  const control = await page.request.get('/sign-in', { maxRedirects: 0 });
  expect(control.status(), 'the application host is up').toBe(200);

  const docs = await page.request.get('/docs', { maxRedirects: 0 });
  expect(
    docs.status(),
    'this lane configures no public origin, so nothing in the moved set redirects',
  ).not.toBe(308);
  expect(
    docs.headers()['location'],
    'a `Location` here would mean the redirect IS configured, and the 404s below would be unproven',
  ).toBeUndefined();

  // ── 2. THE ROUTE IS GONE ───────────────────────────────────────────────────
  // The status code, not a rendered page. With no redirect in front of it, the
  // router is what answers — so this is an assertion about the tree, and it goes
  // red if `app/(public)/legal/` is ever re-created.
  for (const path of DELETED_LEGAL_PATHS) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), `${path} is no longer a route in this application`).toBe(404);
  }

  // ── 3. NOTHING FAULTS ON A BUILD THAT CONFIGURES NOTHING ───────────────────
  // The health route is production code reading the manifest, and it must report
  // the absence rather than fail on it.
  const health = await readLegalHealth(page);
  expect(health.status, 'a self-hosted build reports no legal documents').toBe('unconfigured');
  expect(health.documentCount).toBe(0);

  // ── 4. AND THE SURFACES THAT NAMED THEM STILL READ ─────────────────────────
  // Shared with `regression-legal-gone.spec.ts` so the two cannot drift: the
  // notice is ABSENT rather than re-flowed (`public-surface-hosts.md`
  // AMENDMENT 2 §D), and the card's foot still reads as a foot.
  await startSignedOut(page);
  await page.goto('/sign-up');
  await expectSignUpHasNoLegalNotice(page);

  await signUp(page, SELF_HOST_EMAIL);
  await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 });
  await expectNoRailLegalRow(page);
});
