// MOTIR-3631 — the SIGNATURES that tie the SUBPROCESSOR DISCLOSURE to code.
//
// ⚠️ THE PAGE LEFT; THIS FILE DID NOT (MOTIR-4008). `subprocessors.md` and
// `model-providers.md` are published from `motir-marketing` now. **This file is
// the EVIDENCE side and it can only live here** — run against a marketing
// website's dependency tree it would measure nothing and pass forever. So it
// stays, and `tests/legal/egress-manifest-guard.test.ts` reads it against
// `lib/legal/egress-manifest.json` — the committed artifact this application
// SERVES at `/api/legal/egress-manifest` for the other repository to assert its
// page against (`docs/decisions/public-surface-hosts.md` AMENDMENT 2 §E).
//
// What that changes here: **nothing at all.** The four lists, their semantics
// and their reasons are untouched. What changed is the SUBJECT the guard holds
// them against — a manifest in this repository instead of a page that is no
// longer in it.
//
// The page is a published legal representation whose rows are, for the most
// part, facts about this repository: a dependency in `package.json`, an outbound
// host in application code. This module says which fact belongs to which vendor,
// so `tests/legal/subprocessor-list-guard.test.ts` can hold the two together.
//
// ⚠️ THE PAGE IS THE SOURCE OF TRUTH FOR WHAT WE DISCLOSE. This file is the
// source of truth for WHAT COUNTS AS EVIDENCE. When they disagree the guard
// fails and a person decides which was wrong — the guard never edits the page.
//
// After MOTIR-4008 that disagreement surfaces in TWO places rather than one, and
// the split is deliberate: here, when the manifest stops matching this tree (red
// on the pull request that adds the dependency, in the repository that added
// it); and in `motir-marketing`, when the page stops matching the manifest.
// Neither repository blocks on the other's CI — that coupling is what the split
// exists to avoid — so a new vendor turns this red first and the page red next,
// and AMENDMENT 2 §E writes that window down as a cost.
//
// ── ⚠️ THE PAGE DESCRIBES LAUNCH, NOT TODAY ─────────────────────────────────
// Motir is not generally available, so no vendor is receiving customer data
// today and a live/pending split on the page would sort every row into the same
// bucket. The page therefore states the vendor set AS AT GENERAL AVAILABILITY,
// and this registry has to be read the same way: a signature means "this vendor
// will receive data at launch", not "this import exists right now".
//
// The consequence that bit was `inngest`: a dependency in `package.json` that was
// deliberately NOT on the page, because it was being replaced by an in-product
// Postgres queue and would not exist at launch. A signature for it would have
// forced a vendor onto a published legal page purely because a mid-migration
// import had not been deleted yet — the guard demanding a false statement.
// Departing vendors belong in LEAVING_BEFORE_LAUNCH below, which keeps the
// omission deliberate and attributable instead of silent.
//
// ⚠️ THAT ENTRY IS GONE, BY ITS OWN RULE (MOTIR-3418 deleted the dependency), and
// the mechanism is what survives it — see the empty map below.

/** A vendor, and the repository facts that prove it receives data. */
export interface VendorSignature {
  /** The label as it appears in the FIRST bolded span of the page's table row. */
  readonly vendor: string;
  /** Dependency names in `package.json` whose presence means this vendor is live. */
  readonly packages?: readonly string[];
  /** Outbound hosts in `lib/` or `app/` whose presence means this vendor is live. */
  readonly hosts?: readonly string[];
}

/**
 * ⚠️ A SIGNATURE IS EVIDENCE OF EGRESS, NOT OF INTENT.
 *
 * `api.stripe.com` is Stripe's real API host and is listed. `checkout.stripe.com`
 * and `billing.stripe.com` are NOT: they are synthetic session URLs the E2E
 * billing mock returns, and nothing leaves localhost. They live in
 * `NOT_A_VENDOR_HOST` with that reason.
 *
 * The distinction is the whole reason this file exists rather than a regex over
 * hostnames. A host string in the tree is not proof that anything is sent to it,
 * and a guard that assumed otherwise would have flagged Stripe as a live
 * subprocessor on the day the page correctly said it receives nothing.
 */
export const VENDOR_SIGNATURES: readonly VendorSignature[] = [
  { vendor: 'Fly.io', hosts: ['fly.io', 'api.machines.dev'] },
  { vendor: 'Tigris', packages: ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'] },
  { vendor: 'Resend', hosts: ['api.resend.com'] },
  // ⚠️ THE HOST WAS ADDED BY MOTIR-5260, AND IT MOVED OUT OF `NOT_A_VENDOR_HOST`
  // TO GET HERE. `sentry.io` sat in the exclusion list with the reason
  // "operator link to Sentry's issue list; never requested by the server", which
  // was TRUE for as long as the only Sentry in the tree was `@sentry/nextjs`
  // reporting Motir's own errors. The error-monitor integration makes the server
  // call `https://sentry.io/api/0` on a customer's behalf — a grant exchange, a
  // refresh, a health probe — so an access token and an organisation slug now
  // LEAVE for this host, which is exactly what a signature means and exactly
  // what the excuse denied. The operator console link
  // (`lib/services/platformHealthService.ts`) still exists and is still never
  // requested; it is simply no longer the ONLY reason the string is in the tree,
  // and the stronger fact is the one that has to be recorded.
  { vendor: 'Sentry', packages: ['@sentry/nextjs'], hosts: ['sentry.io'] },
  { vendor: 'Google', hosts: ['accounts.google.com', 'oauth2.googleapis.com'] },
  { vendor: 'Plausible', hosts: ['plausible.io'] },
  {
    vendor: 'GitHub',
    hosts: [
      'api.github.com',
      'github.com',
      'codeload.github.com',
      'token.actions.githubusercontent.com',
      'ghcr.io',
    ],
  },
  { vendor: 'GitLab', hosts: ['gitlab.com'] },
  { vendor: 'Atlassian / Jira', hosts: ['api.atlassian.com', 'auth.atlassian.com'] },
  { vendor: 'Linear', hosts: ['api.linear.app', 'linear.app'] },
  { vendor: 'Plane', hosts: ['api.plane.so', 'app.plane.so'] },
  { vendor: 'Stripe', packages: ['stripe'], hosts: ['api.stripe.com'] },
];

/**
 * Hosts that appear in `lib/` or `app/` and are NOT a subprocessor, each with
 * the reason. Every entry is asserted to STILL MATCH something — an entry that
 * stops describing the tree fails the guard rather than rotting here.
 */
export const NOT_A_VENDOR_HOST: Readonly<Record<string, string>> = {
  // Ourselves.
  'motir.co': 'our own domain',
  'www.motir.co': 'our own marketing domain',
  'app.motir.co': 'the hosted service itself',
  'gateway-run.motir.co':
    "our own gateway's run-lane edge (MOTIR-7656), the origin a hosted-run container dials",

  // Synthetic URLs returned by the E2E billing mock. Nothing leaves localhost —
  // see `lib/test-billing-mock.ts`. Stripe's REAL host is in VENDOR_SIGNATURES,
  // so Stripe going live still trips this guard.
  'checkout.stripe.com': 'E2E billing mock fixture; nothing leaves localhost',
  'billing.stripe.com': 'E2E billing mock fixture; nothing leaves localhost',

  // Placeholders in copy, examples and fixtures — never fetched.
  'acme.atlassian.net': 'documentation placeholder in importer copy',
  'your-domain.atlassian.net': 'documentation placeholder in importer copy',
  'example.com': 'RFC 2606 example domain, used in fixtures',
  'example.org': 'RFC 2606 example domain, a canned client-metadata document in the E2E CIMD seam',
  'evil.example': 'negative-case fixture for URL validation',
  'motir.example.com': 'documentation placeholder',
  'device-handoff.invalid': 'RFC 2606 invalid TLD, used in a fixture',
  'preview.invalid':
    'RFC 2606 invalid TLD, the parse base lib/preview/gate.ts resolves a return path against — never fetched (MOTIR-5779)',
  'evil.test':
    'negative-case fixture for URL validation, in comments only — the sibling of `evil.example` above (MOTIR-4114)',
  'placeholder.invalid':
    'RFC 2606 invalid TLD used as a parsing BASE, never fetched — `app/act/route.ts` resolves a relative path against it and reads back only the path (MOTIR-4114)',

  // Documentation we LINK to. A link is rendered for a human to click; the
  // server never requests it, so no data of ours reaches these.
  // A CITATION IN A CODE COMMENT, not a rendered link and not a request. MOTIR-5595's
  // `getRepositoryPermission` names the GitHub documentation page that states the App
  // permission the endpoint requires, so a later reader can check the claim rather than
  // trust it. Nothing resolves the string at runtime.
  'docs.github.com':
    'documentation URL cited in a code comment (MOTIR-5595); never rendered and never requested',
  'docs.claude.com': 'documentation link shown to the user',
  'developers.openai.com': 'documentation link shown to the user',
  'developers.google.com': 'documentation link shown to the user',
  'code.visualstudio.com': 'documentation link shown to the user',
  'cursor.com': 'documentation link shown to the user',
  'modelcontextprotocol.io': 'documentation link shown to the user',

  // Operator CONSOLE links, rendered by `lib/services/platformHealthService.ts`
  // for a human to click through to a vendor's own dashboard. The server never
  // requests them.
  //
  // ⚠️ Each of these vendors IS real, and excusing the console host does NOT
  // excuse the vendor — that is the distinction the whole file exists for. Neon
  // and Sentry are disclosed on the page. What is excused here is the DASHBOARD
  // hostname, which is not where any data of ours goes; their API paths are
  // covered by their own entries. (`app.inngest.com` sat here until MOTIR-3418
  // deleted the last link to it.)
  'console.neon.tech': "operator link to Neon's console; never requested by the server",
  // `sentry.io` WAS here, on exactly that reasoning. MOTIR-5260 falsified it —
  // see the note on Sentry's `VendorSignature` above.

  // Documentation and fixture hosts added by the error-monitor integration
  // (MOTIR-5259 / MOTIR-5260). Neither is ever requested.
  'docs.sentry.io':
    "Sentry's integration-platform documentation, cited in comments in `lib/monitors/` so the adapter's endpoint claims name their source. Comments only — nothing fetches it (the sibling of `evil.test` above)",
  // The OAuth provider (Story MOTIR-6973). `claude.ai` is named in comments as the
  // shape of a redirect an MCP client registers for itself. The server never
  // requests it: after the person presses Approve, THEIR browser carries the code
  // to the redirect the client registered, which is the person's own choice of
  // app, not a vendor of ours.
  'claude.ai':
    'an MCP client’s own OAuth redirect host, cited in comments in `lib/oauth/` and `lib/rateLimit/` (MOTIR-6982). The server never requests it; the person’s browser follows the redirect they approved',
  'fake.invalid':
    'RFC 2606 invalid TLD, used as the issue permalink the FAKE monitor provider returns (`lib/monitors/providers/fake.ts`). The fake calls no `fetch` at all, and its own test asserts the suite opens no socket',
};

/**
 * ⚠️ VENDORS THIS GUARD CANNOT SEE, and why — the boundary, stated so that a
 * green run is not mistaken for a verified page.
 *
 * Each of these is on the page and is real. None of them leaves a trace this
 * guard can read, so their rows are held by the human re-run of the page's own
 * method section and by nothing else.
 */
export interface DepartingVendor {
  /** Why it is absent from the page, and which card removes it. */
  readonly reason: string;
  /**
   * The dependencies whose PRESENCE is the reason this entry still exists. When
   * the last one goes the vendor is simply gone, the entry has nothing left to
   * explain, and the guard says so rather than letting it rot — the same
   * treatment `NOT_A_VENDOR_HOST` gets, and for the same reason: an exclusion
   * nobody can check is indistinguishable from one nobody should trust.
   */
  readonly packages: readonly string[];
}

/**
 * ⚠️ EMPTY, AND THAT IS A RESULT. Inngest was the entry — and the reason the type
 * exists: it was a dependency in `package.json`, deliberately off a published
 * legal page, because the Postgres queue replacing it landed before general
 * availability. MOTIR-3418 deleted the dependency, at which point the guard's own
 * "retires a departing vendor's entry once it has actually gone" assertion went
 * red until the entry came out — which is the mechanism working, not a gap.
 *
 * The SHAPE stays because the situation recurs: a vendor on its way out is absent
 * from the page by DECISION, and a decision recorded here is attributable, where
 * a silent omission is indistinguishable from an oversight.
 */
export const LEAVING_BEFORE_LAUNCH: Readonly<Record<string, DepartingVendor>> = {};

export const INVISIBLE_TO_THIS_GUARD: Readonly<Record<string, string>> = {
  Neon: 'reached over the Postgres wire protocol via DATABASE_URL, not an HTTPS host or an SDK',
  OpenAI: 'reached THROUGH the gateway; motir-core never names it',
  Brave: 'reached THROUGH the gateway; motir-core never names it',
  DeepSeek:
    'reached THROUGH the gateway; motir-core names no DeepSeek model id either: ' +
    "the planner model is a motir-ai platform setting, and hosted-run ids come from motir-ai's " +
    'GET /v1/agent-models',
  // The rest of the planner model set, on the same footing: the gateway holds
  // the channels, so motir-core never names a host or installs an SDK for any of
  // them. Pinned here so a provider cannot quietly drop off a published legal
  // page — the most this guard can do for an upstream it cannot see.
  Anthropic: 'reached THROUGH the gateway; motir-core never names it',
  'Alibaba Cloud': 'reached THROUGH the gateway; motir-core never names it',
  'Zhipu AI': 'reached THROUGH the gateway; motir-core never names it',
  'Moonshot AI': 'reached THROUGH the gateway; motir-core never names it',
  'Spaceship (Spacemail)': 'a mailbox, with no code path at all',
  Stripe:
    'the `stripe` SDK and the checkout, portal, subscription, seat-sync and webhook ' +
    'routes are all in motir-ai; motir-core holds only the E2E billing mock',
};
