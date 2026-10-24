import type { APIRequestContext, Page } from '@playwright/test';

// THE E2E DOCS URL — the other configured row in the Help menu
// (Story MOTIR-4237 · Subtask MOTIR-4241).
//
// `lib/docs/links.ts` resolves the menu's `Docs` row from an operator's
// absolute `MOTIR_DOCS_URL` and renders nothing when it is unset. Every
// Playwright lane in this repository CONFIGURES one — the main lane and the
// cloud lane at `https://public.motir.e2e/docs`, the acceptance lane at
// `https://motir.co/docs` — because `regression-legal-manifest.spec.ts` reads
// the Docs row as the CONTROL for Legal's absence, and a lane with no docs url
// leaves that control unmounted.
//
// So the UNCONFIGURED arm is unreachable from any spec without moving the
// running server, which is what `/api/_test/docs-url` is for. Its own header
// carries the argument; this module is the client side of it, sitting beside
// `legal-manifest.ts` so a spec that walks BOTH of the menu's configured rows
// reaches for two helpers of the same shape.

/** What the door answers with, on both verbs. */
export interface DocsUrlReport {
  /** What the SHIPPED resolver makes of the current environment. */
  configured: string | null;
}

/**
 * READ the arm without changing it — the mount check.
 *
 * A spec calls this BEFORE asserting anything about the configured row, so the
 * assertion is made against the arm the lane really has rather than the one its
 * config file claims. (Under `reuseExistingServer` a previous run can have left
 * the server on the other arm; this is what notices.)
 */
export async function readDocsUrl(target: Page | APIRequestContext): Promise<DocsUrlReport> {
  const request = 'request' in target ? target.request : target;
  const response = await request.get('/api/_test/docs-url');
  if (!response.ok()) {
    throw new Error(
      `/api/_test/docs-url answered ${response.status()} — is E2E_PROD_HARNESS set on this lane?`,
    );
  }
  return (await response.json()) as DocsUrlReport;
}

/**
 * Move the RUNNING SERVER onto the configured arm (or, with `null`, back off
 * it) and return what its own resolver makes of the result.
 *
 * Callers ASSERT the returned `configured` — a spec that sets the url and does
 * not check it landed is a spec that passes when the door silently does
 * nothing, and this door has a second way to answer `null` on a 200: the
 * resolver REFUSES a relative or non-http value rather than rendering a link
 * that 404s.
 */
export async function setDocsUrl(
  target: Page | APIRequestContext,
  url: string | null,
): Promise<DocsUrlReport> {
  const request = 'request' in target ? target.request : target;
  const response = await request.put('/api/_test/docs-url', { data: { url } });
  if (!response.ok()) {
    throw new Error(
      `/api/_test/docs-url answered ${response.status()} — is E2E_PROD_HARNESS set on this lane?`,
    );
  }
  return (await response.json()) as DocsUrlReport;
}
