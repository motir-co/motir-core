// Browser-driven session helpers shared by the shell a11y + keyboard specs
// (Subtask 1.5.5). Both specs need a *real signed-in browser page* — axe runs
// against the rendered DOM and the keyboard spec drives focus through it — so
// unlike work-item-setup.ts (which signs up over HTTP for speed), these go
// through the actual sign-up + create-project UI.

// Load the job registry in THIS process — see the file for why the emit path
// cannot do it itself here.
import './job-registry';
import { expect, type Locator, type Page } from '@playwright/test';
import { AUTHED_LANDING_PATH, ONBOARDING_ENTRY_PATH } from '@/lib/navigation/landing';
import { isLandedWorkbenchUrl } from './workbench-landing';

export const SHELL_PASSWORD = 'shell-a11y-spec-pass-123';

// ⚠️ ONE LANDING FOR BOTH CREDENTIAL FLOWS — sign-IN and sign-UP alike settle
// here, so there is a single answer to "where does authenticating put me".
//
// Sign-in moved to the landing first (Story MOTIR-2649 · MOTIR-2654) and
// sign-up stayed on `/dashboard` for a season, because a brand-new account has
// nothing waiting on it and the landing's My-work empty state pointed at
// `/ready`, which needs a project. MOTIR-2761 closed that: the page resolves the
// ACTIVE PROJECT and renders the shipped create-first door when there is none,
// so the project-less first screen is the same one `/dashboard` used to give.
// MOTIR-2921 then moved sign-up (`docs/decisions/home-scope.md` §2.3 — the
// record keeps its filename and its argument; only the ADDRESS moved, to
// `/workbench`, by Story MOTIR-4777).
//
// `tests/e2e/auth-post-auth-landing.spec.ts` pins BOTH flows against this
// constant — that is what stops them diverging again unnoticed.
//
// Since MOTIR-3373 it is the APP's constant, re-exported rather than retyped:
// the specs then assert against the value the product actually ships, so a
// destination change is a red spec instead of two constants that agree by
// coincidence until they do not.
export const POST_AUTH_LANDING = AUTHED_LANDING_PATH;

/**
 * ── Why the URL reading right did not mean sign-in had FINISHED ──
 *
 * (The route named below was `/dashboard` when this was measured; MOTIR-2654
 * and MOTIR-2921 have since moved both flows to `/workbench`. The mechanism is the
 * landing route's, not that route's, so the paths are left as observed.)
 *
 * Signing in used to start TWO navigations to the landing route. The page ran
 * its own `router.push(callbackURL)` soft navigation, and — because the request
 * carried a `callbackURL` — Better-Auth answered with `{ redirect: true, url }`
 * (`api/routes/sign-in.mjs`) and its CLIENT redirect plugin assigned
 * `window.location.href = url` (`client/fetch-plugins.mjs`), a full DOCUMENT
 * navigation to the same place.
 *
 * `waitForURL('**​/dashboard')` resolves on whichever of the two commits, and
 * MEASURED here both orders occur: with the document fast it commits first
 * (117 ms) and the soft one follows; with it slower the soft one commits first
 * and the document request is aborted ~5 ms later. When those few milliseconds
 * fall the wrong side of the caller's next `page.goto`, the document navigation
 * commits into it instead and takes it down:
 *
 *     Error: page.goto: Navigation to "http://localhost:3200/items" is
 *     interrupted by another navigation to "http://localhost:3200/dashboard"
 *
 * Three occurrences, three different specs, two lanes, all on innocent diffs
 * (MOTIR-2645). The tell is the phrase `interrupted by another navigation`, not
 * the duration: bare, the `goto` fails in seconds; wrapped in a
 * `toPass({ timeout: 90_000 })` it reads as a 90-second hang.
 *
 * **No wait here could have closed that**, which is why the fix is not in this
 * file alone: the losing navigation is aborted at the winner's commit, so at
 * almost every instant there is nothing left to wait FOR — and the one window
 * where there is, is a few milliseconds wide. So the SECOND navigation was
 * removed at its source: `app/(auth)/sign-in/page.tsx` dropped its
 * `router.push` and leaves the document load the redirect plugin performs as
 * the only one. That is what makes a `page.goto` straight after `signIn` safe
 * by CONSTRUCTION, and `tests/e2e/auth-post-auth-landing.spec.ts` pins that
 * there is exactly one. (It had to be the SOFT one that went: the saved
 * appearance is server-applied to the root layout's `<html>`, which an RSC
 * navigation cannot rewrite — `tests/e2e/appearance-sync.spec.ts` fails if a
 * returning user reaches the dashboard without a fresh document render.)
 *
 * What these helpers add is the second half: they return on a RENDERED landing
 * page rather than on a URL that merely reads right — an authoritative signal,
 * never an interval (the coding convention § E2E forbids a sleep as synchronisation, and
 * this race got worse under load, which is exactly where a tuned sleep would
 * fail).
 *
 * ⚠️ ONE SETTLE NO LONGER SERVES BOTH FLOWS (MOTIR-4876). It used to, because
 * both landed on `/workbench` and `workbench-page` was carried by BOTH of that
 * page's branches — "the create-first door a fresh sign-up sees and the list an
 * existing account sees". Neither half of that sentence survives: there is no
 * create-first branch (MOTIR-4872), and a REGISTRATION now lands on the
 * onboarding entrance (MOTIR-4871) because a brand-new account is already
 * inside a seeded project and has not described it yet.
 *
 * So sign-IN settles on the landing and sign-UP settles on the entrance and
 * then GOES to the landing — see `signUp`'s own note for why that navigation is
 * in the helper rather than in eighty-eight callers.
 */
/** The screen the re-consent gate holds a reader on (`lib/legal/reconsentGate.ts`). */
const RECONSENT_PATH = '/re-consent';

async function settleOnWorkbench(page: Page): Promise<void> {
  // ⚠️ WAIT FOR EITHER DESTINATION FIRST, then act. Reading `page.url()` before
  // this would race the sign-in navigation the caller just triggered: mid-flight
  // the URL is still the credential form, the hold would read as absent, and the
  // wait below would hang on `/re-consent` exactly as it did before this fix.
  // Waiting on the SET of settled destinations is the authoritative signal, and
  // it is still never a sleep (the coding convention § E2E).
  //
  // ⚠️ AND THE LANDING IS SETTLED ONLY ONCE IT NAMES A TAB (MOTIR-5221). The bare
  // `/workbench` is a resolver that forwards to To approve, else In progress, else
  // To do, so a URL reading `/workbench` is the entrance, not the arrival. Both
  // waits ask for the RESOLVED address (`isLandedWorkbenchUrl`), and then for the
  // rendered page — still an authoritative signal, never a sleep.
  await page.waitForURL(
    (url) => url.pathname.startsWith(RECONSENT_PATH) || isLandedWorkbenchUrl(url),
    { timeout: 30_000 },
  );
  await clearReconsentHold(page);
  await page.waitForURL(isLandedWorkbenchUrl, { timeout: 30_000 });
  await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 });
}

/**
 * THE RE-CONSENT HOLD, cleared the way a person clears it (Bug MOTIR-3713).
 *
 * ── Why this is here at all ────────────────────────────────────────────────
 * `app/(authed)/layout.tsx` holds a signed-in reader at `/re-consent` when their
 * accepted version of the Terms, the Privacy Policy or the Acceptable Use Policy
 * is materially behind what is published (MOTIR-1135). A user created through
 * the SIGN-UP flow has acceptance recorded by better-auth's
 * `databaseHooks.user.create.after`, so `signUp` never meets the screen. Every
 * seeded user is created by `usersService.createUser` instead — bypassing that
 * hook — so `signIn` always does, and twenty-one acceptance specs died on the
 * `waitForURL` below with no explanation of why.
 *
 * ── Why HERE, and not by seeding acceptance ───────────────────────────────
 * The seeded users come from **forty-odd** `_helpers/*-seed.ts` modules, each
 * calling `usersService.createUser` directly. Stamping acceptance in each is
 * forty edits that the forty-first seed silently reopens — the failure mode this
 * repository's own source guards keep warning about. `settleOnWorkbench` is the one
 * door both flows already pass through.
 *
 * ⚠️ AND IT CLEARS THE HOLD BY DRIVING THE REAL SCREEN, which is the point. The
 * cheap fixes — recording acceptance behind the product's back, or exempting the
 * E2E origin in the gate — would make the lane green by making the gate
 * unreachable, so the next regression in it would be invisible. Clicking the
 * button a person clicks means every one of these specs exercises the interstitial
 * on its way past, and a gate that stops clearing fails here loudly.
 *
 * ⚠️ A NO-OP OFF-CLOUD, AND THAT IS WHY ONLY ONE LANE WAS RED. The gate opens
 * with `if (!isMotirCloud()) return null`, so it fires in the acceptance lane
 * (`MOTIR_CLOUD=true`) and not in the main one — which is the whole reason
 * `playwright.config.ts`'s bulk legs stayed green while every acceptance shard
 * failed, and why reading the two lanes as disagreeing about the same code would
 * have been the wrong conclusion.
 *
 * Also a no-op for `signUp` and for any already-accepted user: the URL check
 * answers immediately when the hold is not there, so nothing waits on a screen
 * that never appears.
 */
async function clearReconsentHold(page: Page): Promise<void> {
  // Its CALLER has already waited for one of the two destinations, so this read
  // is of a settled URL rather than of one mid-navigation — which is the whole
  // reason the wait is up there and not in here.
  if (!new URL(page.url()).pathname.startsWith(RECONSENT_PATH)) return;

  // The button's own words carry the scope — one document, two, or all three —
  // so the label is matched as the alternation the copy actually ships rather
  // than as a guess at which count this run produced.
  await page.getByRole('button', { name: /^Agree (and|to both and|to all and) continue$/ }).click();

  // The agreement is a Server Action that redirects; the caller's own
  // `waitForURL` is what settles it, so nothing is awaited twice here.
}

// Sign up a fresh user → auto-workspace, zero projects → lands on the
// Workbench, whose no-project branch is the shipped "create your first project" door
// (MOTIR-2761); `createFirstProject` below drives it from there.
//
// SINGLE deterministic submit, not a click-wait-reclick retry loop: the E2E
// dev server runs with E2E_DISABLE_RATE_LIMIT=1, so there is no 429 to retry
// around, and a blind re-click races a first sign-up that already succeeded —
// the second submit on the now-existing account clears the just-set session
// and the next protected nav bounces to /sign-in (observed flake, Subtask
// 1.5.5). One click + a generous wait is both correct and reliable.
// The Better-Auth session cookies (the library prefixes every one of them), as
// opposed to the per-device tier cookies `workspace_id` / `motir.org`, which are
// deliberately KEPT below.
const SESSION_COOKIE_MARKER = 'better-auth';

/**
 * The credential form's email box, found by ROLE rather than by placeholder.
 *
 * A placeholder lookup also matches hidden elements. When the first load's
 * server render and client render disagree, React re-renders the card and a
 * hidden copy of the server's input can stay in the DOM beside the live one,
 * so `getByPlaceholder('Email address')` resolves to two elements and fails
 * strict mode (merge-queue run 37821281731, `regression-choice-gate.spec.ts`).
 * The accessibility tree excludes the hidden copy, so `getByRole` finds one.
 */
export function emailBox(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Email address', exact: true });
}

/**
 * Drop the SESSION, keep everything else — the state a person is in when they
 * arrive at a credential form.
 *
 * ⚠️ Required since MOTIR-3372: `/sign-in` and `/sign-up` are server shells that
 * REDIRECT a reader who is already signed in (to `?next=`, else `/workbench`), so a
 * spec that authenticates as a second identity mid-test no longer reaches the
 * form at all — `emailBox(page).fill(…)` times out on a page
 * that has already navigated to `/workbench`. That is the product behaving correctly:
 * a credential form is for somebody who needs credentials, and switching
 * accounts means leaving the first one, exactly as it does in the browser.
 *
 * It drops ONLY the session so the switch stays behaviour-identical to what
 * these specs did before: Better-Auth already replaced the session cookie on the
 * second sign-up, while the per-device `workspace_id` / `motir.org` cookies
 * survived. Clearing everything would change what those specs exercise.
 * (`shell-flows.spec.ts` does the mirror-image trick for the same reason.)
 */
export async function startSignedOut(page: Page): Promise<void> {
  const cookies = await page.context().cookies();
  if (!cookies.some((c) => c.name.includes(SESSION_COOKIE_MARKER))) return;
  const keep = cookies.filter((c) => !c.name.includes(SESSION_COOKIE_MARKER));
  await page.context().clearCookies();
  if (keep.length) await page.context().addCookies(keep);
}

/**
 * Create an account and END UP IN THE APP, on the landing.
 *
 * ⚠️ THE DESTINATION MOVED AND THIS HELPER'S CONTRACT DID NOT (MOTIR-4876). A
 * registration now lands on the onboarding entrance (MOTIR-4871), not on the
 * landing. This settles there and then navigates on, so the ~85 specs whose
 * `signUp` means "give me an authenticated session in the app" keep working
 * without each one learning about a journey they are not testing.
 *
 * **That is a contract, not a paper-over.** The entrance is the registration
 * JOURNEY, and a journey deserves specs that assert it rather than eighty-five
 * that pass through it — so it has its own helper, `signUpToOnboarding` below,
 * and `onboarding-fresh.spec.ts` is where the landing itself is asserted. What
 * would have been a paper-over is making this settle on the entrance and
 * calling the difference invisible.
 */
export async function signUp(page: Page, email: string): Promise<void> {
  await signUpToOnboarding(page, email);
  // `goto` follows the resolver's redirect inside the one navigation, so it
  // resolves on the landed tab; the URL wait says so rather than assuming it.
  await page.goto(POST_AUTH_LANDING);
  await page.waitForURL(isLandedWorkbenchUrl, { timeout: 30_000 });
  await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 });
}

/**
 * Create an account and STOP where the registration actually lands — the
 * onboarding entrance (MOTIR-4871).
 *
 * For the specs that are about the first-run journey itself. Everything else
 * wants `signUp`.
 */
export async function signUpToOnboarding(page: Page, email: string): Promise<void> {
  await startSignedOut(page);
  await page.goto('/sign-up');
  await emailBox(page).fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(SHELL_PASSWORD);
  await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
  await settleOnOnboardingEntrance(page);
}

/**
 * The registration twin of `settleOnWorkbench` — same authoritative-signal
 * discipline, different destination, and the re-consent hold still cleared the
 * way a person clears it.
 */
async function settleOnOnboardingEntrance(page: Page): Promise<void> {
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith(RECONSENT_PATH) || url.pathname.startsWith(ONBOARDING_ENTRY_PATH),
    { timeout: 30_000 },
  );
  await clearReconsentHold(page);
  await page.waitForURL(`**${ONBOARDING_ENTRY_PATH}`, { timeout: 30_000 });
}

// Sign IN an EXISTING user (vs. signUp's fresh account) through the real
// sign-in UI — the two-step email→password flow, both steps submitted with the
// "Continue" button (Subtask 3.5.1). Used by the at-scale board specs to sign in
// as the server-seeded board-seed owner, who is created via usersService (not
// signed up), then land on the project board. Lands on the default `/workbench` —
// the same place `signUp` lands (MOTIR-2654, then MOTIR-2921); callers that
// need a different surface `goto` it afterwards, which is safe because sign-in
// performs exactly ONE navigation (MOTIR-2645).
/**
 * The no-project landing (Story MOTIR-6169 · MOTIR-6548): where a reader who can
 * enter none of the workspace's projects settles — the Workbench forwards them
 * there. The same two waits as `settleOnWorkbench`, on that address and its
 * shell's heading.
 */
async function settleOnNoProject(page: Page): Promise<void> {
  const landed = (url: URL) => url.pathname === '/no-project';
  await page.waitForURL((url) => url.pathname.startsWith(RECONSENT_PATH) || landed(url), {
    timeout: 30_000,
  });
  await clearReconsentHold(page);
  await page.waitForURL(landed, { timeout: 30_000 });
  // `getByRole` — the accessibility tree excludes a hidden, still-mounted
  // previous subtree, where a page-rooted `getByTestId` would match both.
  await expect(page.getByRole('heading', { name: /not in a project yet/i })).toBeVisible({
    timeout: 30_000,
  });
}

export async function signIn(
  page: Page,
  email: string,
  password: string,
  options: { landing?: 'workbench' | 'no-project' } = {},
): Promise<void> {
  await startSignedOut(page);
  await page.goto('/sign-in');
  await emailBox(page).fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  if (options.landing === 'no-project') await settleOnNoProject(page);
  else await settleOnWorkbench(page);
}

/**
 * Leave the caller in an ACTIVE PROJECT NAMED `name`.
 *
 * ⚠️ THE DOOR MOVED AND THE NAME KEPT ITS PROMISE (MOTIR-4876). This used to
 * drive the `ProjectsEmptyState` CTA — "the same component wherever it is
 * reached, `/workbench`'s no-project branch and `/dashboard`'s alike". Neither
 * exists: the screen is retired (MOTIR-4872) and there is no projectless
 * reader to show it to (MOTIR-4870), so a fresh account already HAS a project
 * named after its workspace.
 *
 * It now creates one through the switcher's create door and pins it active,
 * which is what every caller was actually asking for — an active project whose
 * name they chose. The seeded default remains in the workspace beside it, so a
 * spec asserting a project COUNT rather than the ACTIVE project is the one
 * shape to re-read; none did at the time of writing.
 *
 * The name is kept: eighty-eight files reach these helpers, and renaming a
 * helper whose behaviour is unchanged from the caller's side would be churn
 * with no reader served.
 */
export async function createFirstProject(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Switch project' }).click();
  await page.getByRole('button', { name: 'Create project' }).first().click();
  await expect(page.getByRole('heading', { name: 'Create project' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Project name' }).fill(name);
  await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
  await expect(page.getByText('Project created', { exact: true }).first()).toBeVisible({
    timeout: 5_000,
  });
}

// Create an additional named workspace via the ALWAYS-PRESENT org control's
// "New workspace" entry and switch to it (the new workspace becomes active —
// ⚠️ WITH A SEEDED DEFAULT PROJECT since MOTIR-4870, not "with zero projects"
// as this said; a workspace is one of the three doors into the projectless
// state the story closed). Story 6.10.5's progressive disclosure HIDES the
// workspace switcher at one workspace, so "New workspace" lives in the org menu
// — the org control is the create path at any workspace count. Mirrors the
// helper in workspace-flows.spec.ts; lifted here so the shell journey spec can
// stand up two workspaces with distinct projects for the cmd-k switch path.
export async function createWorkspace(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Organization menu' }).click();
  await page.getByRole('button', { name: /New workspace/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Workspace name').fill(name);
  await dialog.getByRole('button', { name: 'New workspace', exact: true }).click();
  // Creating a second workspace reveals the switcher, which reflects the new
  // (now-active) workspace.
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(name);
}
