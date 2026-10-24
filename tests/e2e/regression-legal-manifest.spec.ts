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

// THE LEGAL MANIFEST, END TO END — AND THE ACCEPTANCE RECEIPT FOR IT
// (Story MOTIR-3909 · Subtask MOTIR-4015).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// This story takes moooon B.V.'s contract text out of a GPL-3.0 repository and
// replaces it with configuration. Almost everything it changes is invisible to a
// type checker: the links are strings, the gate is an environment variable, and
// the state that matters most is an ABSENCE. So the clip shows the two builds
// side by side in one recording — a self-hoster who configured nothing, then the
// same deployment after an operator supplies four documents — because the thing
// being accepted is what a person is SHOWN.
//
// ── ⚠️ THE ARMS ARE PROPERTIES OF THE SERVER, AND BOTH ARE ASSERTED ─────────
//
// `MOTIR_LEGAL_DOCUMENTS` and `MOTIR_CLOUD` are process-wide, server-side reads.
// There is no per-test override and no client seam a `page.route()` stub can
// reach, so a spec written in a lane that does not set them does not go red — it
// passes on unfixed code, permanently. The failure mode is a green tick, which is
// why every arm below is MOUNTED and CHECKED before anything is asserted about
// it, and the check goes through PRODUCTION code:
//
//   * the CLOUD arm — `playwright.acceptance.config.ts` sets `MOTIR_CLOUD: 'true'`
//     on the webServer (and on the runner process at config scope). Without it
//     `lib/legal/reconsentGate.ts` returns `null` on its first line and chapter 6
//     would assert a hold the build cannot perform. It is checked by the hold
//     itself: the chapter's first assertion is that the reader IS at `/re-consent`.
//   * the MANIFEST arm — this lane sets NO `MOTIR_LEGAL_DOCUMENTS`, which is
//     exactly the self-hoster's posture, and chapters 1–2 run against it. Chapter
//     3 then configures the RUNNING SERVER through `/api/_test/legal-manifest`,
//     which works because `lib/legal/documents.ts` deliberately keeps no module
//     cache and reads `process.env` through a computed key at the moment of the
//     call. Both states are read back from the SHIPPED `/api/health/legal` route
//     before the chapter that depends on them.
//
// A second `webServer` on a second port would also give two arms, and was
// rejected: the receipt is one recording a human watches, and a clip that jumps
// origins mid-way shows two builds rather than one build changing. The door's own
// header (`app/api/_test/legal-manifest/route.ts`) carries that argument in full.
//
// ── WHAT THIS SPEC DELIBERATELY DOES NOT WALK ───────────────────────────────
//
// **`motir.co/legal` in a browser.** That is MOTIR-3886's, whose step 4 already
// reads *"Open Docs, then a legal document from the footer — each stays on the
// public host"* under an acceptance criterion covering steps 1–8. Standing up a
// second cross-origin harness here would duplicate it.
//
// **`/legal` on the app host answering 404.** That belongs to MOTIR-4105, in the
// deletion story: the route is still in this tree when MOTIR-3909 merges, so
// *the route is gone* is not a claim this story can make. It was NOT softened
// into *"nothing links to it"*, which is a different and weaker sentence.
//
// **The deployed manifest.** MOTIR-4012 reads that back from the platform; an
// E2E against a local build cannot.

// A PACED recording, not a race: six chapters, each holding after its own
// assertions land. The lane's per-test default is not generous enough for a walk
// that signs up twice against a production build.
test.describe.configure({ timeout: 300_000 });

/** The self-hoster's account — created on a build with no legal documents. */
const SELF_HOST_EMAIL = 'acceptance-legal-selfhost@example.com';
/** The hosted reader — created after the operator configures the manifest. */
const HOSTED_EMAIL = 'acceptance-legal-hosted@example.com';

/** A MAJOR behind the published `2.0.0` — the state a real revision produces. */
const STALE_VERSION = '0.9.0';

const RECONSENT_PATH = '/re-consent';

test.beforeEach(async () => {
  await resetDatabase();
});

// The manifest is a PROCESS-WIDE server read, and this spec leaves it configured.
// Every later spec on the same lane server would then meet the re-consent gate
// on sign-in, so put the server back to the unconfigured arm it started from.
test.afterEach(async ({ request }) => {
  const cleared = await setLegalManifest(request, null);
  expect(cleared.status, 'the manifest is unset for the specs that follow').toBe('unconfigured');
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
 * interstitial. What this story is about is the reader who agreed to an EARLIER
 * version — the one whose row has to survive beside the new one, because the
 * agreement happened.
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

test('the legal documents come from configuration — absent when none is set, linked when one is', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask — the uploader reads
  // this sidecar ahead of anything derived from the branch or the PR.
  acceptanceStory('MOTIR-3909');

  await chapter('A self-hosted build has published no legal documents', async () => {
    // ── MOUNT THE UNCONFIGURED ARM ──────────────────────────────────────────
    // The lane sets no `MOTIR_LEGAL_DOCUMENTS`, so this is already the state;
    // the explicit `null` makes the spec idempotent under `reuseExistingServer`,
    // where a previous run left the server configured. Then it is READ BACK
    // through the shipped health route, because "the lane sets nothing" is a
    // claim about a config file and `unconfigured` is an answer from the server.
    const cleared = await setLegalManifest(page, null);
    expect(cleared.status, 'the door unset the manifest').toBe('unconfigured');
    const health = await readLegalHealth(page);
    expect(health.status, 'the SERVER reports no legal documents').toBe('unconfigured');
    expect(health.documentCount).toBe(0);

    await startSignedOut(page);
    await page.goto('/sign-up');

    // The card is on screen, the paragraph is ABSENT rather than unlinked, and
    // the card's foot still reads as a foot. ⚠️ SHARED WITH
    // `regression-legal-gone.spec.ts` (MOTIR-4105) — these sentences are about
    // the same DOM in two lanes, and copied assertions drift one edit at a time
    // while both files stay green, each asserting its own copy. The helper's own
    // header carries the reasoning each assertion encodes.
    await expectSignUpHasNoLegalNotice(page);
    await beat();
  });

  await chapter('Signed in, the rail offers no Legal door', async () => {
    await signUp(page, SELF_HOST_EMAIL);
    await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 });

    // The CONTROL for the absence is the Docs row beside it — shared with
    // MOTIR-4105's specs, see the helper.
    await expectNoRailLegalRow(page);
    await beat();
  });

  await chapter('The operator configures four documents', async () => {
    // ── MOUNT THE CONFIGURED ARM ────────────────────────────────────────────
    // One PUT moves the running server, exactly as `fly secrets set` plus a
    // restart would. The answer comes back through `legalManifestState()`, so it
    // is the server's own loader agreeing — a manifest it refused would read
    // back `faulted` here rather than as a 200 that hid it.
    const set = await setLegalManifest(page, E2E_LEGAL_DOCUMENTS);
    expect(set.status, 'the server accepted the manifest').toBe('configured');
    expect(set.slugs).toEqual(E2E_LEGAL_DOCUMENTS.map((document) => document.slug));

    const health = await readLegalHealth(page);
    expect(health.status).toBe('configured');
    expect(health.documentCount).toBe(E2E_LEGAL_DOCUMENTS.length);
    await beat();
  });

  await chapter('Sign-up names the documents, and the links leave the application', async () => {
    await startSignedOut(page);
    await page.goto('/sign-up');
    // ⚠️ THE ELEMENT AND THE ATTRIBUTE, BOTH — shared with MOTIR-4105's specs,
    // see the helper for why each half is load-bearing.
    await expectSignUpNamesTheDocuments(page);

    // ── THE ERROR STATE, AND IT IS THE ONE THAT ACTUALLY HAPPENS ────────────
    // `public.motir.e2e` resolves NOWHERE — that is deliberate, and it is why
    // this chapter is also the error case. A configured document whose URL is
    // unreachable must not stop sign-up rendering, because the link's target is
    // another host's problem and never a reason the form cannot be used. The
    // proof is that the page is complete and the form still advances: nothing
    // above followed a single one of those hrefs.
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
    await beat();
  });

  await chapter('The rail gains a Legal door onto the configured index', async () => {
    await signUp(page, HOSTED_EMAIL);
    await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 });

    // The INDEX, derived from the documents' shared base — not a fifth
    // configuration value, and not a path on this host. Shared with MOTIR-4105's
    // spec, see the helper.
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
      // And the way to read what changed — the operator's URL, not a local path.
      await expect(page.locator(`a[href="${published.url}"]`)).toBeVisible();
    }

    // ⚠️ THE FOURTH DOCUMENT IS NOT ON THIS SCREEN, and that is an assertion
    // about the gate rather than about the copy. `subprocessors` is configured
    // and published; re-consent is asked for three named documents, and a gate
    // that held people over "everything in the manifest" would be a different
    // and much worse promise. The manifest is deliberately not congruent with
    // the re-consent set so this can be checked at all.
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
});
