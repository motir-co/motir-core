import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signUp, startSignedOut, POST_AUTH_LANDING } from './_helpers/shell-session';
import { RECONSENT_DOCUMENT_SLUGS } from '@/lib/legal/consent';
import {
  E2E_LEGAL_DOCUMENTS,
  e2eLegalUrl,
  expectNoRailLegalRow,
  expectRailLegalRow,
  expectSignUpHasNoLegalNotice,
  expectSignUpNamesTheDocuments,
  readLegalHealth,
  setLegalManifest,
} from './_helpers/legal-manifest';
import { isLandedWorkbenchUrl } from './_helpers/workbench-landing';

// `/legal` IS GONE FROM THE APPLICATION HOST — AND THE JOURNEY DID NOT BREAK
// (Story MOTIR-4101 · Subtask MOTIR-4105).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// This story's deliverable is an ABSENCE, and an absence is the hardest thing to
// accept from a diff: the deletion pull request shows files removed and asks the
// reader to take on trust that nothing downstream of them mattered. This is the
// receipt that turns that into something watchable. Nothing this repository
// serves renders a legal document any more — and sign up, see the links, be held
// when the terms change, agree, carry on still works with the documents on
// another host entirely.
//
// The clip ends on the UNCONFIGURED arm deliberately. The receipt's subject is
// the absence, and the last thing a reviewer should see is the state every
// self-hoster runs in: no manifest, no documents in the tree, and a sign-up card
// that still reads as a finished page.
//
// ── ⚠️ THE ARMS ARE PROPERTIES OF THE SERVER, AND EACH IS MOUNTED FIRST ─────
//
// `MOTIR_LEGAL_DOCUMENTS`, `MOTIR_PUBLIC_SITE_URL` and `MOTIR_CLOUD` are
// process-wide, server-side reads. None has a per-test override or a client seam
// a `page.route()` stub can reach, so a spec written in a lane that does not set
// them does not go red — it passes on unfixed code, permanently. The failure
// mode is a green tick. So every arm below is MOUNTED and CHECKED through
// PRODUCTION code before anything is asserted about it:
//
//   * the REDIRECT arm — `playwright.acceptance.config.ts` sets
//     `MOTIR_PUBLIC_SITE_URL: 'https://public.motir.e2e'` on the webServer, and
//     `MOTIR_BASE_URL` is this lane's own origin. `proxy.ts`'s
//     `publicSiteRedirect` returns `null` while those two are EQUAL, so an
//     unconfigured lane would answer chapter 1 with a 404 and the chapter would
//     be asserting a different mechanism under the same words. It is mounted by
//     its own control: `/sign-in` answers 200 on the same server, so the 308 is
//     a fact about the `legal` segment and not about a host that redirects
//     everything.
//   * the CLOUD arm — the same config sets `MOTIR_CLOUD: 'true'`. Without it
//     `lib/legal/reconsentGate.ts` returns `null` on its first line and chapter
//     4 would assert a hold the build cannot perform. It is checked by the hold
//     itself: the chapter's first assertion is that the reader IS at
//     `/re-consent`.
//   * the MANIFEST arm — flipped mid-recording through
//     `/api/_test/legal-manifest`, which works because `lib/legal/documents.ts`
//     deliberately keeps no module cache and reads `process.env` through a
//     computed key at the moment of the call. Both states are read back from the
//     SHIPPED `/api/health/legal` route before the chapter that depends on them.
//
// ── ⚠️ WHAT CHAPTER 1 PROVES, AND WHAT IT DOES NOT ──────────────────────────
//
// It proves the sentence this story actually makes: **on a configured
// deployment, nothing served from this repository renders a legal document** —
// `/legal` and `/legal/terms` leave for the public host before any route is
// consulted.
//
// It does NOT prove the ROUTE WAS DELETED, and saying so is the point of this
// paragraph rather than a caveat buried in a review comment. `proxy.ts` 308s the
// `legal` segment whether or not `app/(public)/legal/` exists, so this assertion
// would stay green if the directory came back tomorrow. A check that cannot go
// red is not evidence. The deletion has two other witnesses, and they are the
// falsifiable ones:
//
//   1. `tests/e2e/legal-gone-selfhost.spec.ts`, in the MAIN lane, which sets no
//      `MOTIR_PUBLIC_SITE_URL` — so no redirect fires, the request reaches the
//      router, and `/legal` answers **404**. That is the arm where the deletion
//      is observable over HTTP, and it is why this card's step 1 lives in two
//      lanes rather than being weakened to fit one.
//   2. The BUILD's own route manifest (`.next/app-path-routes-manifest.json`),
//      quoted in the pull-request body, which carries no `app/(public)/legal`
//      entry.
//
// ── WHAT THIS SPEC DELIBERATELY DOES NOT WALK ───────────────────────────────
//
// **`motir.co/legal` in a browser.** MOTIR-3886's, whose step 4 already opens a
// legal document from the public site's own footer. A second cross-origin
// harness here would duplicate it — and the configured host in this lane
// (`public.motir.e2e`) resolves NOWHERE on purpose, which is what makes chapter
// 2's error state real.
//
// **The 301/308 rule itself.** MOTIR-3884's, covered at unit level by
// `tests/navigation/public-redirect.test.ts`. What is asserted here is only that
// it REACHES the legal paths first on a running server.
//
// **The manifest seam's unit-level behaviour**, and **the DEPLOYED manifest** —
// this story's vitest gate and its live-gate confirmation respectively. An E2E
// against a local build cannot read the deployment.
//
// ── INHERITED vs NEW (this card's own criterion) ────────────────────────────
//
// Chapters 2–5 walk the same surfaces as `regression-legal-manifest.spec.ts`
// (MOTIR-4015). Rather than copy its assertions — which drift one edit at a time
// while both files stay green, each asserting its own copy — the shared
// sentences live in `_helpers/legal-manifest.ts` and BOTH specs call them. What
// is new here is chapter 1, the ORDER (that spec shows the manifest arriving;
// this one shows the documents leaving and ends on the absence), and the fact
// that the unconfigured arm now runs against a tree with no `content/legal/` in
// it at all — a state no lane could exercise before this story.

// A PACED recording, not a race: five chapters, each holding after its own
// assertions land. The lane's per-test default is not generous enough for a walk
// that signs up twice against a production build.
test.describe.configure({ timeout: 300_000 });

/** The hosted reader — created while the manifest is configured. */
const HOSTED_EMAIL = 'acceptance-legal-gone-hosted@example.com';
/** The self-hoster — created after the manifest is taken away again. */
const SELF_HOST_EMAIL = 'acceptance-legal-gone-selfhost@example.com';

/** A MAJOR behind the published `2.0.0` — the state a real revision produces. */
const STALE_VERSION = '0.9.0';

const RECONSENT_PATH = '/re-consent';

/** The public origin this lane configures — `playwright.acceptance.config.ts`. */
const PUBLIC_ORIGIN = 'https://public.motir.e2e';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

async function userId(email: string): Promise<string> {
  const user = await adminDb.user.findUnique({ where: { email } });
  expect(user, `the account ${email} exists after sign-up`).not.toBeNull();
  return user!.id;
}

/**
 * Put this account materially BEHIND, the way a published revision would.
 *
 * The rows are REWRITTEN rather than deleted: deleting them produces a
 * never-accepted reader, which is a different state with a different arm of the
 * interstitial. What this walks is the reader who agreed to an EARLIER version.
 */
async function makeStale(id: string): Promise<void> {
  const updated = await adminDb.legalAcceptance.updateMany({
    where: { userId: id },
    data: { version: STALE_VERSION },
  });
  // Not vacuous: if sign-up ever stops recording acceptance this would update
  // zero rows and the hold below would fire for the WRONG reason, quietly
  // turning the chapter into a test of a different state.
  expect(updated.count, 'sign-up recorded acceptance to make stale').toBe(
    RECONSENT_DOCUMENT_SLUGS.length,
  );
}

/** Every settled destination the authed entry can produce, so nothing races. */
async function enterTheApp(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(POST_AUTH_LANDING);
  await page.waitForURL(
    (url) => url.pathname.startsWith(RECONSENT_PATH) || url.pathname.endsWith(POST_AUTH_LANDING),
    { timeout: 30_000 },
  );
}

test('the legal documents have left this repository, and the journey that needed them has not', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask — whoever publishes
  // reads this sidecar ahead of anything derived from the branch or the PR.
  acceptanceStory('MOTIR-4101');

  await chapter('Nothing on the application host serves a legal document', async () => {
    // ── THE BACKDROP ────────────────────────────────────────────────────────
    // The status codes below are read with `page.request`, not by navigating:
    // the configured host resolves nowhere by design, so a browser sent after
    // the redirect would show a DNS failure rather than the fact being asserted.
    // The sign-up card is what is ON SCREEN, because it is the surface that used
    // to carry same-host `/legal` links and is the one a reviewer knows.
    await startSignedOut(page);
    await page.goto('/sign-up');
    await expect(page.getByPlaceholder('Email address')).toBeVisible();

    // ── MOUNT THE REDIRECT ARM, WITH ITS CONTROL ────────────────────────────
    // `/sign-in` is served by this application and is NOT one of
    // `PUBLIC_REDIRECT_SEGMENTS`. Its 200 is what makes every 308 below a fact
    // about the `legal` segment rather than about a host that redirects
    // everything — and it is also the proof the server is up at all.
    const control = await page.request.get('/sign-in', { maxRedirects: 0 });
    expect(control.status(), 'the application host itself still answers').toBe(200);

    // ── THE STATUS CODE, READ RATHER THAN GUESSED ───────────────────────────
    // Two shipped mechanisms compete for `/legal` on this host: the route that
    // MOTIR-4103 deleted, and MOTIR-3884's redirect. On any deployment with a
    // public origin configured — which is what app.motir.co is — the redirect
    // wins, in `proxy.ts` before the router is reached. So the answer is a 308,
    // and asserting a guessed 404 here would have failed on a correct
    // arrangement. The `Location` is asserted because the status alone does not
    // say the document left for the RIGHT host.
    for (const path of ['/legal', '/legal/terms']) {
      const response = await page.request.get(path, { maxRedirects: 0 });
      expect(response.status(), `${path} is not served from this repository`).toBe(308);
      expect(response.headers()['location'], `${path} leaves for the public host`).toBe(
        `${PUBLIC_ORIGIN}${path}`,
      );
    }
    await beat();
  });

  await chapter('The operator has published the documents somewhere else', async () => {
    // ── MOUNT THE CONFIGURED ARM ────────────────────────────────────────────
    // One PUT moves the running server, exactly as `fly secrets set` plus a
    // restart would. The answer comes back through the loader itself, so a
    // manifest the server REFUSED reads back `faulted` rather than as a 200 that
    // hid it.
    const set = await setLegalManifest(page, E2E_LEGAL_DOCUMENTS);
    expect(set.status, 'the server accepted the manifest').toBe('configured');
    const health = await readLegalHealth(page);
    expect(health.status, 'the SERVER reports the documents').toBe('configured');
    expect(health.documentCount).toBe(E2E_LEGAL_DOCUMENTS.length);

    await startSignedOut(page);
    await page.goto('/sign-up');
    await expectSignUpNamesTheDocuments(page);

    // ── THE ERROR STATE, AND IT IS THE ONE THAT ACTUALLY HAPPENS ────────────
    // `public.motir.e2e` resolves NOWHERE. A configured document whose URL is
    // unreachable must not stop sign-up rendering — the link's target is another
    // host's problem and never a reason the form cannot be used. The proof is
    // that the page is complete and the form still advances: nothing above
    // followed a single one of those hrefs.
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
    await beat();
  });

  await chapter('Signed in, the rail points off this host too', async () => {
    await signUp(page, HOSTED_EMAIL);
    await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 });
    await expectRailLegalRow(page);
    await beat();
  });

  await chapter('A reader whose Terms moved is held, agrees, and is not asked again', async () => {
    const id = await userId(HOSTED_EMAIL);
    await makeStale(id);
    await enterTheApp(page);

    // The cloud arm's mount check: off-cloud, `reconsentGate` returns null on
    // its first line and this reader would sail through.
    expect(
      new URL(page.url()).pathname,
      'a materially behind reader was not held — is MOTIR_CLOUD set on this lane?',
    ).toContain(RECONSENT_PATH);

    const agree = page.getByRole('button', {
      name: /^Agree (and|to both and|to all and) continue$/,
    });
    await expect(agree).toBeVisible();

    for (const slug of RECONSENT_DOCUMENT_SLUGS) {
      const published = E2E_LEGAL_DOCUMENTS.find((document) => document.slug === slug)!;
      // The delta chip — what makes this a NOTICE rather than a formality.
      await expect(
        page.getByText(`${STALE_VERSION} → ${published.version}`).first(),
        `${slug}'s version delta is not on the screen`,
      ).toBeVisible();
      // And the way to read what changed — the operator's URL, and NOT a path on
      // this host, which is the whole of what this story changed about it.
      await expect(page.locator(`a[href="${published.url}"]`)).toBeVisible();
      await expect(
        page.locator(`a[href="/legal/${slug}"]`),
        `${slug} is no longer offered from this application`,
      ).toHaveCount(0);
    }

    // ⚠️ THE FOURTH DOCUMENT IS NOT ON THIS SCREEN — an assertion about the GATE
    // rather than about the copy. `subprocessors` is configured and published;
    // re-consent is asked for three named documents, and a gate that held people
    // over "everything in the manifest" would be a different and much worse
    // promise.
    await expect(page.locator(`a[href="${e2eLegalUrl('subprocessors')}"]`)).toHaveCount(0);
    await beat();

    // ── THE TERMINAL ACT ────────────────────────────────────────────────────
    await agree.click();
    await page.waitForURL(isLandedWorkbenchUrl, { timeout: 30_000 });
    await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 });

    // ⚠️ READ THE RECORD BACK, not just the redirect. Being let through proves
    // the gate re-read; it does not prove a row was written, and the row is the
    // evidence Motir would have to produce if anyone asked whether this person
    // agreed to these terms.
    const rows = await adminDb.legalAcceptance.findMany({
      where: { userId: id },
      orderBy: [{ documentSlug: 'asc' }, { version: 'asc' }],
    });
    expect(rows.length, 'the old rows survived beside the new ones').toBe(
      RECONSENT_DOCUMENT_SLUGS.length * 2,
    );
    for (const slug of RECONSENT_DOCUMENT_SLUGS) {
      const published = E2E_LEGAL_DOCUMENTS.find((document) => document.slug === slug)!;
      expect(
        rows
          .filter((row) => row.documentSlug === slug)
          .map((row) => row.version)
          .sort(),
        `${slug}'s acceptance history`,
      ).toEqual([STALE_VERSION, published.version].sort());
    }

    // The prompt does not recur.
    await enterTheApp(page);
    expect(new URL(page.url()).pathname, 'the interstitial came back').toContain(POST_AUTH_LANDING);
    await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 });
    await beat();
  });

  await chapter('And a build that configures nothing has nothing to say', async () => {
    // ── MOUNT THE UNCONFIGURED ARM ──────────────────────────────────────────
    // This is the state every self-hoster runs in, and after this story it is
    // the state of a build with neither a manifest NOR any documents in the tree
    // — which no earlier lane could exercise, because `content/legal/` was still
    // there. Read back through the shipped health route: "the door unset it" is
    // a claim about this request, and `unconfigured` is an answer from the
    // server's own loader.
    const cleared = await setLegalManifest(page, null);
    expect(cleared.status, 'the door unset the manifest').toBe('unconfigured');
    const health = await readLegalHealth(page);
    expect(health.status, 'the SERVER reports no legal documents').toBe('unconfigured');
    expect(health.documentCount).toBe(0);

    await startSignedOut(page);
    await page.goto('/sign-up');
    // ⚠️ ABSENT, NOT RE-FLOWED (`public-surface-hosts.md` AMENDMENT 2 §D): a
    // sentence entirely about two documents becomes FALSE rather than merely
    // weaker when they do not exist.
    await expectSignUpHasNoLegalNotice(page);
    await beat();

    await signUp(page, SELF_HOST_EMAIL);
    await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 });
    await expectNoRailLegalRow(page);

    // ── AND NOTHING 500s ────────────────────────────────────────────────────
    // The shell rendered, so the pages a person meets are fine. These are the
    // three surfaces that READ the manifest and are not already asserted above,
    // on a build where it is unset AND the documents are not in the tree:
    // `/settings/account` renders under `app/(authed)/layout.tsx`, which calls
    // BOTH `legalIndexUrl()` and `resolveReconsentHold()` on every authed page;
    // `/re-consent` is the gate's own screen, where `listLegalDocuments()`
    // answers `[]` and it must hold nobody rather than fault on an empty set;
    // and the health route is the loader reporting on itself.
    for (const path of ['/api/health/legal', '/settings/account', '/re-consent']) {
      const response = await page.request.get(path);
      expect(response.status(), `${path} did not fault on an unconfigured build`).toBeLessThan(500);
    }
    await beat();
  });
});
