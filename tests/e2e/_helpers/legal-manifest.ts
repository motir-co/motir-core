import { expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import type { LegalDocument } from '@/lib/legal/documents';

// THE E2E LEGAL MANIFEST — the CONFIGURED arm of MOTIR-3909, in one place
// (Subtask MOTIR-4015).
//
// Two lanes read this and they must agree, which is why it is a module rather
// than a literal in each config:
//
//   * `playwright.cloud.config.ts` sets it on the webServer AND on the runner
//     process, because `cloud-legal-reconsent.spec.ts` calls
//     `listLegalDocuments()` itself to learn the published versions — and a
//     runner reading a DIFFERENT manifest from the server would compare the
//     screen against versions the screen never had.
//   * `regression-legal-manifest.spec.ts` PUTs it through `/api/_test/legal-manifest`
//     mid-recording, because that lane's job is to show the transition.
//
// ⚠️ THE HOST IS DELIBERATELY UNREACHABLE. `public.motir.e2e` resolves nowhere,
// and both lanes already point `MOTIR_PUBLIC_SITE_URL` at it for the same
// reason (see either config's comment on the redirect). That is not a shortcut
// around a mock — it IS the error state this story owes: a configured document
// whose URL nobody can fetch must not stop sign-up rendering, because the
// link's target is another host's problem. Every assertion here reads the
// `href`; none follows it.

/** The base every configured URL hangs off — what `legalIndexUrl()` derives. */
export const E2E_LEGAL_BASE = 'https://public.motir.e2e/legal';

/**
 * Four documents, and the fourth is load-bearing.
 *
 * Three of them are `RECONSENT_DOCUMENT_SLUGS`, so the gate has its full set.
 * `subprocessors` is NOT one, and it is here so the manifest is not accidentally
 * congruent with the re-consent set: a reader held over three documents while a
 * fourth is published proves the gate reads its own list rather than "everything
 * configured", which is the shape a manifest-sourced loader makes easy to get
 * wrong.
 */
export const E2E_LEGAL_DOCUMENTS: LegalDocument[] = [
  {
    slug: 'terms',
    title: 'Terms of Service',
    version: '2.0.0',
    effectiveDate: '2026-09-01',
    changeSummary: 'The documents moved to their own host.',
    url: `${E2E_LEGAL_BASE}/terms`,
  },
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    version: '2.0.0',
    effectiveDate: '2026-09-01',
    changeSummary: null,
    url: `${E2E_LEGAL_BASE}/privacy`,
  },
  {
    slug: 'acceptable-use',
    title: 'Acceptable Use Policy',
    version: '2.0.0',
    effectiveDate: null,
    changeSummary: null,
    url: `${E2E_LEGAL_BASE}/acceptable-use`,
  },
  {
    slug: 'subprocessors',
    title: 'Subprocessors',
    version: '1.4.0',
    effectiveDate: null,
    changeSummary: null,
    url: `${E2E_LEGAL_BASE}/subprocessors`,
  },
];

/** The value the environment variable actually holds. */
export const E2E_LEGAL_DOCUMENTS_JSON = JSON.stringify(E2E_LEGAL_DOCUMENTS);

/** The configured URL for one slug — the `href` every surface must carry. */
export function e2eLegalUrl(slug: string): string {
  const document = E2E_LEGAL_DOCUMENTS.find((entry) => entry.slug === slug);
  if (!document) throw new Error(`no e2e legal fixture for "${slug}"`);
  return document.url;
}

/** What `/api/health/legal` and the `_test` door both answer with. */
export interface LegalManifestReport {
  status: 'unconfigured' | 'configured' | 'faulted';
  /** The door's answer — the slugs the loader accepted. */
  slugs?: string[];
  /** The health route's answer — it publishes a COUNT, not the slugs. */
  documentCount?: number;
}

/**
 * Move the RUNNING SERVER onto the configured arm (or, with `null`, back off
 * it) and return what its own loader makes of the result.
 *
 * The door is described in `app/api/_test/legal-manifest/route.ts`; the short
 * version is that the manifest is a process-wide server read with no per-request
 * seam, so this is the only thing that can change the arm without changing the
 * origin. Callers ASSERT the returned status — a spec that sets the manifest and
 * does not check it landed is a spec that passes when the door silently does
 * nothing.
 */
export async function setLegalManifest(
  target: Page | APIRequestContext,
  manifest: LegalDocument[] | null,
): Promise<LegalManifestReport> {
  const request = 'request' in target ? target.request : target;
  const response = await request.put('/api/_test/legal-manifest', {
    data: { manifest },
  });
  if (!response.ok()) {
    throw new Error(
      `/api/_test/legal-manifest answered ${response.status()} — is E2E_PROD_HARNESS set on this lane?`,
    );
  }
  return (await response.json()) as LegalManifestReport;
}

/** The shipped health route's answer — the mount check, through production code. */
export async function readLegalHealth(
  target: Page | APIRequestContext,
): Promise<LegalManifestReport> {
  const request = 'request' in target ? target.request : target;
  const response = await request.get('/api/health/legal');
  return (await response.json()) as LegalManifestReport;
}

// ── THE SHARED SURFACE ASSERTIONS (Subtask MOTIR-4105) ───────────────────────
//
// Two acceptance specs now walk the same three surfaces — `acceptance-legal-
// manifest.spec.ts` (MOTIR-4015, the manifest arriving) and
// `regression-legal-gone.spec.ts` (MOTIR-4105, the documents leaving) — and a
// third asserts the self-host arm in the main lane. The assertions themselves
// are the same sentences about the same DOM, so they live here once.
//
// ⚠️ THIS IS NOT TIDINESS, IT IS THE CARD'S OWN CRITERION. MOTIR-4105 asks that
// the two specs "are not silently divergent copies": copied assertions drift
// one edit at a time, and the drift is invisible because both files stay green
// — each is asserting its own copy. Extracted, a change to what the sign-up
// notice must say reaches every lane that walks it, or fails to compile.
//
// What is NOT extracted: the mount checks, the chapter prose, and anything a
// spec asserts about ITS OWN arm. Those are the parts that are supposed to
// differ, and folding them in here would hide the difference the specs exist to
// record.

/**
 * Sign-up NAMES both documents, and each link leaves this application.
 *
 * The element AND the attribute, both — a cross-origin `next/link` renders an
 * `<a>` that looks identical in a snapshot and behaves differently, and a
 * pre-manifest build rendered a same-host PATH here that reads the same to
 * every assertion except this one.
 */
export async function expectSignUpNamesTheDocuments(page: Page): Promise<void> {
  await expect(page.getByText(/you agree to our/i)).toBeVisible();
  for (const [name, slug] of [
    [/^Terms of Service/, 'terms'],
    [/^Privacy Policy/, 'privacy'],
  ] as const) {
    const link = page.getByRole('link', { name });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', e2eLegalUrl(slug));
    expect(await link.evaluate((element) => element.tagName), `${slug} is a plain anchor`).toBe(
      'A',
    );
  }
}

/**
 * The notice is ABSENT, not re-flowed (`public-surface-hosts.md` AMENDMENT 2 §D).
 *
 * `legal.signUpNotice` is a sentence entirely ABOUT two documents; rendered
 * without them it is not a weaker notice, it is a FALSE one, so `LegalNotice`
 * returns null. Asserting only "it carries no anchor" would pass on the exact
 * fragment the decision exists to avoid, which is why the text assertions come
 * first and the anchor assertion last.
 *
 * The final two assertions are the CONTROL: the card's foot must still read as
 * a foot. The notice carried the `border-t` and the `pt-4`, so its removal takes
 * a hairline as well as a sentence, and "the paragraph is gone" and "the page
 * did not render" are otherwise the same observation.
 */
export async function expectSignUpHasNoLegalNotice(page: Page): Promise<void> {
  // By role, not placeholder: see `emailBox` in shell-session.ts.
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toBeVisible();
  await expect(page.getByText(/you agree to our/i)).toHaveCount(0);
  await expect(page.getByText(/Terms of Service/i)).toHaveCount(0);
  await expect(page.locator('a[href*="legal"]')).toHaveCount(0);
  await expect(page.getByText(/Already have an account\?/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
}

/**
 * The Help menu offers a Legal documents door onto the configured INDEX —
 * derived from the documents' shared base, not a fifth configuration value
 * and not a path on this host.
 *
 * ⚠️ RE-HOMED OFF THE RAIL (MOTIR-4239) — the door opens the shell's Help
 * menu (rail footer at `≥ md`, the default viewport this lane runs at) and
 * reads the row from inside it, then closes the menu again so it does not
 * leak state into whatever the caller does next.
 */
export async function expectRailLegalRow(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Help' }).click();
  const legal = page.getByRole('link', { name: 'Legal documents', exact: true });
  await expect(legal).toBeVisible();
  await expect(legal).toHaveAttribute('href', E2E_LEGAL_BASE);
  await page.keyboard.press('Escape');
}

/**
 * The Help menu has NO Legal documents row — with Docs beside it as the
 * control.
 *
 * ⚠️ THE CONTROL IS LOAD-BEARING AND IT IS ALSO CONDITIONAL NOW. `lib/docs/
 * links.ts` resolves the Docs row from an operator's absolute `MOTIR_DOCS_URL`
 * and renders nothing when it is unset, so this helper only works in a lane
 * that configures one. Both lanes that call it do (see either config). Without
 * it, "no Legal documents row" and "no menu" are the same observation.
 */
export async function expectNoRailLegalRow(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Help' }).click();
  await expect(page.getByRole('link', { name: 'Docs', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Legal documents', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
}
