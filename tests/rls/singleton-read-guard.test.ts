import { describe, expect, it } from 'vitest';
import { scanSingletonReads } from './singletonReadScan';

// The singleton-read GUARD (MOTIR-2784).
//
// `singletonReadScan.ts` enumerates every repository method that reads the
// `@/lib/db` singleton, with no `tx ?? db` fallback, against a policy-gated table.
// Such a read runs outside any bound transaction, so the RLS policy sees NULL and
// it returns ZERO ROWS WITHOUT RAISING — the caller then reports "missing" for a
// row that exists. The class has been found FOUR times (MOTIR-2569, MOTIR-2685,
// MOTIR-2774's three sites, and this card's two), every time by accident, from a
// suite run under TEST_DB_APP_ROLE=1 rather than from anyone reading the code.
//
// This test is the thing that makes the fifth cheap. The SCANNER does not decide whether
// a site is a bug — that needs the call sites, which is why the verdicts live here and
// not in it. It asserts instead that **every site has been LOOKED AT**: the scanned set
// must equal the keys below, so adding a new singleton read of a tenant table fails the
// build until its author writes down which verdict it earns.
//
// Same division of labour as `tenant-root-creation-rls.test.ts`'s
// `DELIBERATELY_UNGUARDED` map — the machine enumerates, a human adjudicates, and
// an unadjudicated addition is a red build rather than a silent one.
//
// ⚠️ TWO RATCHETS MEASURED DIFFERENT THINGS, AND CONFLATING THEM WOULD HAVE READ AS
// REPAIR. This is the one part of MOTIR-2789/2796 worth carrying forward, because the
// next person to add a ratchet here will face the same choice.
//
// The adjudication pass located every call site of all 69 unreviewed reads and inspected
// each enclosing service method for a context wrapper. `UNREVIEWED_CEILING` fell 69 -> 8
// in that single commit — and the product got no more correct, because what the pass
// produced was 55 reads now KNOWN to be broken under `motir_app` rather than unknown.
// `reportsService.ts` and `savedFiltersService.ts` carried ZERO context wrappers in the
// whole file; `boardsService.ts` and `workItemsService.ts` had them only around WRITE
// paths. That is the shape of an entire READ surface which had never needed a binding,
// because CI and production both ran a BYPASSRLS role.
//
// So a SECOND ratchet was added — `UNBOUND_READ_PATH_CEILING` — precisely so the
// knowledge number could not be quoted as the correctness number. `unreviewed` measures
// whether anyone LOOKED, and can be lowered by writing a verdict. The unbound count
// measured whether the reads WORK, and could only be lowered by a service actually
// binding them.
//
// MOTIR-2796 drove that second count 55 -> 0, so MOTIR-2814 retired it: a ratchet with
// no members is a number that invites editing, where a set-equality assertion cannot be
// nudged. The `unbound-read-path` verdict is gone with it. What replaces it is stricter,
// not weaker — a NEW unbound read of a policy-gated table has no verdict to earn, so the
// set-equality test below fails until it is bound or explained. Its sibling
// `tests/rls/call-site-guard.test.ts` holds the other axis (a bindable read whose caller
// passes nothing) and carries its own two ratchets, both at their floor.
//
// `public` remains the one verdict that cannot be earned by reading code: it is the claim
// that MOTIR-2684's public policy ARM admits the row, and only a suite passing under the
// app role can settle it. MOTIR-2833 earned the last eight of that kind, so the
// `unreviewed` population is EMPTY and the verdict has been removed from the union.
//
// ⚠️ AND EARNING THEM PROVED HALF OF THEM BROKEN — the argument for insisting on a run.
// The plan predicted all eight would come back `public`, reasoning that they all target
// `project` / `work_item`, the two armed tables. Four of them JOIN a table that had no arm
// (`workflow_status`; and `workspace` -> `organization` for the project square), and under
// RLS an unadmitted join returns zero rows and raises nothing — so the prediction was not
// merely optimistic, it was pointing at the defect. A read is admitted only if EVERY table
// it touches is admitted. See the note above VERDICTS, MOTIR-2856, and `notes.html` #269.
//
// `UNREVIEWED_CEILING` may fall, never rise, and is now at 0. Rewriting a ceiling upward
// to make a build pass is the one edit this file exists to prevent.
//
// (It earned its keep before it shipped: the first run of this guard failed on four
// sites its own author had missed while transcribing the list by hand, and on two
// stale entries for reads the same card had just bound. A hand-maintained list of
// seventy-five is wrong the moment it is written; that is the argument for having
// the machine hold the enumeration and the human hold only the verdicts.)

/** Why a singleton read of a policy-gated table is acceptable — or is not yet judged. */
type Verdict =
  /** Fixed: the read now takes the transaction its caller had already bound. */
  | 'bound'
  /** No tenant exists at read time; there is nothing to bind. */
  | 'pre-auth'
  /**
   * The only caller is a `scripts/` maintenance tool, which runs on the
   * OPERATOR's connection (the migration/owner role), not the request-path
   * `motir_app` role. Nothing to bind and nothing to fix — but see the note on
   * `stampOnboardingRan` below, because the boundary is narrower than it looks.
   */
  | 'operator-script'
  /**
   * No production caller at all: the read survives only because tests still call
   * it. Under the app role it returns zero rows, so any test using it as an
   * EXISTENCE check passes VACUOUSLY. Retire the read and move the tests to
   * `adminDb` — the MOTIR-2775 disposition.
   */
  | 'test-only'
  /**
   * The read runs UNBOUND on purpose, and a PUBLIC POLICY ARM admits its rows.
   *
   * ⚠️ THE ONE VERDICT THAT CANNOT BE EARNED BY READING CODE — this file's header
   * says so, and it was true until MOTIR-2811. It is the claim that a specific
   * policy admits the row with NO GUC bound, so it needs the policy to exist and
   * a test to have watched it work. Both halves are named in the reason.
   */
  | 'public';
// `unreviewed` — "enumerated, not yet adjudicated" — lived here and is GONE
// (MOTIR-2833). It was always documented as "only ever to be REMOVED from this
// file", and with the population empty the union is the stronger statement: there
// is no longer a value an author can reach for to defer a judgement, so a new
// unbound read must earn one of the five real verdicts or fail the build. The
// ceiling below survives at 0 as the runtime half of the same guarantee.

const VERDICTS: Record<string, readonly [Verdict, string]> = {
  // ── the PUBLIC ADDRESS surface (Story MOTIR-3878) ─────────────────────────
  // Eight unbound reads, all on the ANONYMOUS host-resolution path, and every
  // one of them earns the `public` verdict the hard way: the policy exists AND a
  // test has watched it work with no GUC bound.
  //
  // The policies: `public_address_public_read` (20260903010000_add_public_address)
  // admits an address row only when what it POINTS AT is public — its own
  // project for a custom domain, or a workspace holding at least one public
  // project for a subdomain. `project_public_read` (20260811230000) and
  // `workspace_public_project_read` (20260815200000) admit the two rows it then
  // joins to. All three are SELECT-only arms gated on an UNSET `app.workspace_id`,
  // so none of them widens an ordinary bound tenant read.
  //
  // The tests that watched them: `tests/publicAddresses/publicAddressRepository.test.ts`
  // (the arm proved in BOTH directions under `SET LOCAL ROLE motir_app` —
  // admits a public project's address, refuses a private one's, and follows the
  // project when its access level changes) and
  // `tests/publicAddresses/publicHostResolution.test.ts` (the same properties
  // through the service, including a workspace with no public project).
  //
  // ⚠️ These reads are unbound BECAUSE binding would presume the answer: the
  // whole question host resolution asks is WHICH TENANT a hostname belongs to.
  'publicAddressRepository.ts#findByHostname': [
    'public',
    'public_address_public_read (20260903010000) · publicAddressRepository.test "the public read arm" (5 cases, both directions under SET LOCAL ROLE motir_app) + publicHostResolution.test',
  ],
  'publicAddressRepository.ts#findLiveSubdomainForWorkspacePublic': [
    'public',
    'public_address_public_read (20260903010000) · publicHostResolution.test "a retired subdomain reports where to redirect" — the alias hop',
  ],
  'publicAddressRepository.ts#listForWorkspace': [
    'public',
    'public_address_public_read (20260903010000) · publicHostResolution.test "addressesForProject — the ADR §7 default rule" (6 cases)',
  ],
  'publicAddressRepository.ts#listForWorkspaces': [
    'public',
    'public_address_public_read (20260903010000) · publicHostResolution.test "primaryHostsForProjects — the batched crawl read" (3 cases)',
  ],
  'projectRepository.ts#listPublicByWorkspace': [
    'public',
    'project_public_read (20260811230000) · publicHostResolution.test "a workspace subdomain lists that workspace\u2019s public projects" + "a subdomain whose workspace holds NO public project"',
  ],
  'projectRepository.ts#findPublicByIdInternal': [
    'public',
    'project_public_read (20260811230000) · publicHostResolution.test "a customer domain whose project is not public" — the policy supplies the access-mode filter this read deliberately omits',
  ],
  'projectRepository.ts#findWorkspaceNameForPublic': [
    'public',
    'workspace_public_project_read (20260815200000) · publicHostResolution.test "a subdomain whose workspace holds NO public project"',
  ],
  'projectRepository.ts#listPrimaryAddressIds': [
    'public',
    'project_public_read (20260811230000) · publicHostResolution.test "primaryHostsForProjects … agrees with addressesForProject"',
  ],

  // ── pre-auth: the readiness probe ──────────────────────────────────────────
  // The readiness probe's warm-up (Bug MOTIR-8231): a raw `SELECT 1` that names no
  // table, so no policy can gate it — the scanner flags it only because it cannot
  // read a raw query's tables. Its one caller is Fly's health checker, with no tenant.
  'databaseConnectionRepository.ts#ping': [
    'pre-auth',
    "SELECT 1 reads no table; the caller is Fly's unauthenticated health check",
  ],

  // ── pre-auth: the shared rate limiter ─────────────────────────────────────
  // The surfaces it protects — sign-in, sign-up, password reset, public writes —
  // are limited BEFORE any workspace is known, which is why the table is in
  // `tenant-root-creation-rls.test.ts`'s DELIBERATELY_UNGUARDED map and reasoned
  // out in docs/decisions/production-service-stack.md §7. Every caller component
  // in `key` is SHA-256 hashed, so there is no tenant content to scope.
  'rateLimitCounterRepository.ts#countAllUnsafe': ['pre-auth', 'no tenant exists at write time'],
  'rateLimitCounterRepository.ts#findCountUnsafe': ['pre-auth', 'no tenant exists at write time'],

  // ── operator-script (2) ───────────────────────────────────────────────────
  // `scripts/stampOnboardingRan.ts` is the sole caller of both. It searches for a
  // project key ACROSS workspaces — that is the point, since it refuses an
  // ambiguous match rather than guessing — so there is no single tenant to bind
  // and no policy arm for a cross-tenant search (nor should there be).
  //
  // ⚠️ THE VERDICT IS NO LONGER CONDITIONAL. It used to carry a caveat: the
  // script's header claimed non-bypass safety it did not have, so under
  // `motir_app` these returned nothing and it reported the project missing.
  // MOTIR-2813 closed that two ways — the header now scopes its claim to the
  // WRITE, and `assertOperatorConnection()` reads `pg_roles.rolbypassrls` and
  // refuses LOUDLY rather than answering wrongly. `workspaceRepository.findBySlug`
  // left this list entirely: the `--workspace` arm binds `app.bootstrap_slug`
  // (`withBootstrapSlugContext`) and now works under EITHER role.
  'projectRepository.ts#findBySlug': [
    'operator-script',
    'stampOnboardingRan — cross-tenant search, refused loudly under motir_app',
  ],

  // ── test-only (0) — RETIRED, not adjudicated ──────────────────────────────
  // MOTIR-2812 DELETED all three: `workItemRepository.findReadyCandidates`,
  // `workspaceMembershipRepository.findByUserAndWorkspace` and
  // `projectRepository.listPublicDirectory`. Each had zero production callers
  // across `app`, `lib`, `scripts` AND `packages`, and each was a live
  // vacuous-pass risk — under `motir_app` they returned nothing, so a test using
  // one as an EXISTENCE check did not go red, it went quietly meaningless.
  //
  // Deleting a site is a legitimate way to leave this list (the MOTIR-2775
  // precedent). No entry replaces them: a read that no longer exists needs no
  // verdict, and `tests/permissions/membershipGateRouting.test.ts` is now a
  // TOMBSTONE that fails the build if the sharpest of the three comes back.

  // ── public (1) ────────────────────────────────────────────────────────────
  // The project square's demand counts, read by an anonymous visitor across many
  // projects in many workspaces. There is no workspace to bind — inventing one
  // would presume the answer the page computes — so MOTIR-2811 gave the table a
  // public SELECT arm instead of a `tx`. The FIRST verdict of this kind: the
  // header's "a `public` verdict today would be a guess wearing a citation" held
  // until the arm and its tests existed together.
  'publicRequestVoteRepository.ts#sumUpvotesByProjects': [
    'public',
    'public_request_vote_public_project_read (20260813210000) · publicProjectAccess.test',
  ],

  // ── public (8) — the last of the `unreviewed` population (MOTIR-2833) ──────
  // These eight were the whole of the `unreviewed` set. Each verdict below names the
  // policy ARM it rests on AND the suite run that watched the arm work, because a
  // `public` verdict is a claim about the DATABASE's behaviour and nothing you can read
  // off the repository settles it.
  //
  // ⚠️ THE PLAN-TIME PREDICTION WAS WRONG FOR HALF OF THEM, AND THE REASON IS WORTH
  // KEEPING. The card carried this: "Against `pg_policies`, ONLY `project` and
  // `work_item` carry public arms … The reads below all target `project` or `work_item`,
  // which is why they are plausibly `public` rather than plausibly broken."
  //
  // They do TARGET those two tables. FOUR of them JOIN a third — and the sentence above
  // names it. `workflow_status` had no arm, so the three roadmap/dedupe reads that join it
  // returned zero rows and raised nothing; `listPublicDirectoryRanked` failed the same way
  // through `workspace` -> `organization`, two tables the prediction did not mention at
  // all. A read is admitted only if EVERY table it touches is admitted: the join is part
  // of the predicate, and a policy-arm inventory describes the FROM clause, not the query.
  // MOTIR-2856 added the three missing arms; `notes.html` #269 records the reasoning error.
  //
  // The control that makes the diagnosis a measurement rather than a story:
  // `findPublicRoadmapByStatus` joins only armed tables and PASSED under `motir_app` in the
  // same run in which its three neighbours failed — once its fixture project was actually
  // public, which is the OTHER half of what was wrong (MOTIR-2857).

  // -- reads admitted by a single-table arm ----------------------------------
  // `project_public_read` is an UNGATED `"access_mode" = 'public'` SELECT arm — no
  // `app.workspace_id` test — so an unbound cross-tenant list of public projects is
  // admitted, which is exactly what these two need and why neither ever needed a fix.
  'projectRepository.ts#findPublicByIdentifier': [
    'public',
    'project_public_read (20260811230000) · publicProjects suite — every read service resolves through it (resolvePublicProject)',
  ],
  'projectRepository.ts#listPublic': [
    'public',
    'project_public_read (20260811230000) · publicAccessAndProjection.test "listPublicForSitemap … CROSS-TENANT" (added by MOTIR-2833 — the read had NO test at all)',
  ],
  'projectRepository.ts#listPublicIndexPage': [
    'public',
    'project_public_read (20260811230000) · publicAccessAndProjection.test "listPublicIndex pages every PUBLIC project CROSS-TENANT" (MOTIR-4111 — the crawl index motir.co walks; unbound for the same reason as the sitemap read above, a crawler belongs to no workspace)',
  ],
  // The unbound `work_item` arm is GATED on there being no bound workspace, which is
  // precisely the public path. Both of these touch `work_item` and nothing else.
  'workItemRepository.ts#maxActivityByProjects': [
    'public',
    'work_item_public_project_read (20260811230000) · projectSquareDirectory.test "public demand stats"',
  ],
  'workItemRepository.ts#findPublicRoadmapByStatus': [
    'public',
    'work_item_public_project_read + public_request_vote_public_project_read (20260811230000, 20260813210000) · publicRoadmap.test findPublicRoadmapByStatus (3 cases)',
  ],

  // -- reads that needed MOTIR-2856's arms before the verdict was true --------
  // Each of these was BROKEN under `motir_app` when this card opened. The verdict is
  // `public` as of the arms landing, and the cited run is the one that proves it.
  'workItemRepository.ts#findPublicRoadmapSubmitted': [
    'public',
    'work_item_public_project_read + workflow_status_public_project_read + public_request_vote_public_project_read (20260811230000, 20260815200000, 20260813210000) · publicRoadmap.test findPublicRoadmapSubmitted (3 cases)',
  ],
  'workItemRepository.ts#countPublicRoadmapSubmitted': [
    'public',
    'work_item_public_project_read + workflow_status_public_project_read (20260811230000, 20260815200000) · publicRoadmap.test countPublicRoadmapSubmitted',
  ],
  'workItemRepository.ts#findPublicRequestMatches': [
    'public',
    'work_item_public_project_read + workflow_status_public_project_read + public_request_vote_public_project_read (20260811230000, 20260815200000, 20260813210000) · publicSubmit.test findDuplicateRequests',
  ],
  'projectRepository.ts#listPublicDirectoryRanked': [
    'public',
    'project_public_read + workspace_public_project_read + organization_public_project_read (20260811230000, 20260815200000) · projectSquare suite (directory, ranking, search, guarantees)',
  ],
  // ── the HOSTED-RUN OFFER (Story MOTIR-7521 · MOTIR-7526) ─────────────────
  // The run-model list narrows every tenant's hosted-run offer, so it is read
  // on customer paths with no platform flag bound. Both tables' SELECT arm is
  // `USING (true)` — platform reference data — and their writes stay behind
  // `app.platform_staff`.
  // ── the FLEET ORG CI setting (Story MOTIR-8699 · MOTIR-8714) ───────────
  // The console's state read runs outside any platform transaction (a platform
  // context cannot open without auditing). The table's SELECT arm is
  // `USING (true)`; its writes stay behind `app.platform_staff`.
  'platformFleetOrgCiRepository.ts#find': [
    'public',
    'platform_fleet_org_ci_read (20261015300000) · platformFleetOrgCiRead.test "the fleet org CI state read" (under SET LOCAL ROLE motir_app, nothing bound)',
  ],
  // ── a FLEET KIND's Fly↔AWS switch (MOTIR-9503) ─────────────────────────
  // Placement reads the agent hoster's switch on every new instance, from a
  // tenant's create path with no platform flag bound, and the console reads it
  // outside any platform transaction. The table's SELECT arm is `USING (true)`;
  // its writes stay behind `app.platform_staff`.
  'platformFleetKindSwitchRepository.ts#find': [
    'public',
    'platform_fleet_kind_switch_read (20261025090000) · platformFleetKindSwitchRead.test "the fleet kind switch read" (under SET LOCAL ROLE motir_app, nothing bound)',
  ],
  'platformRunModelRepository.ts#findListedModelsForOffer': [
    'public',
    'platform_run_model_read + platform_run_model_list_read (20261004120000) · platformRunModelOfferRead.test "the offer read" (under SET LOCAL ROLE motir_app, nothing bound)',
  ],
  // ── the IDEA STORE (Story MOTIR-7662 · MOTIR-7672 / MOTIR-7671) ──────────
  // The public routes read with NO GUC bound — an anonymous visitor has no
  // tenant and no platform standing — and so do the staff reads outside a write
  // (the console list, one idea, the vocabulary, the run log). Every table's
  // SELECT arm is `USING (true)`: the ideas are Motir's own published content,
  // the platform run-model list's posture. Writes stay behind
  // `app.platform_staff`, which the same test proves refuses an unbound write.
  'ideaPublicRepository.ts#listActive': [
    'public',
    'idea_read + idea_evidence_read + idea_tag_read + idea_tag_assignment_read + idea_research_run_read (20261007100000_idea_store) + idea_translation_read + idea_evidence_translation_read + idea_tag_translation_read (20261009200000_idea_translations) · ideaStoreRlsRead.test "the unbound read" + "the translation tables" (under SET LOCAL ROLE motir_app, nothing bound)',
  ],
  'ideaPublicRepository.ts#categoryCounts': [
    'public',
    'idea_read + idea_evidence_read + idea_tag_read + idea_tag_assignment_read + idea_research_run_read (20261007100000_idea_store) · ideaStoreRlsRead.test "the unbound read" (under SET LOCAL ROLE motir_app, nothing bound)',
  ],
  'ideaPublicRepository.ts#tagCounts': [
    'public',
    'idea_read + idea_evidence_read + idea_tag_read + idea_tag_assignment_read + idea_research_run_read (20261007100000_idea_store) + idea_translation_read + idea_evidence_translation_read + idea_tag_translation_read (20261009200000_idea_translations) · ideaStoreRlsRead.test "the unbound read" + "the translation tables" (under SET LOCAL ROLE motir_app, nothing bound)',
  ],
  'ideaPublicRepository.ts#findActiveBySlug': [
    'public',
    'idea_read + idea_evidence_read + idea_tag_read + idea_tag_assignment_read + idea_research_run_read (20261007100000_idea_store) + idea_translation_read + idea_evidence_translation_read + idea_tag_translation_read (20261009200000_idea_translations) · ideaStoreRlsRead.test "the unbound read" + "the translation tables" (under SET LOCAL ROLE motir_app, nothing bound)',
  ],
  'ideaRepository.ts#findBySlugForStaff': [
    'public',
    'idea_read + idea_evidence_read + idea_tag_read + idea_tag_assignment_read + idea_research_run_read (20261007100000_idea_store) + idea_translation_read + idea_evidence_translation_read + idea_tag_translation_read (20261009200000_idea_translations) · ideaStoreRlsRead.test "the unbound read" + "the translation tables" (under SET LOCAL ROLE motir_app, nothing bound)',
  ],
  'ideaRepository.ts#findAllForStaff': [
    'public',
    'idea_read + idea_evidence_read + idea_tag_read + idea_tag_assignment_read + idea_research_run_read (20261007100000_idea_store) + idea_translation_read + idea_evidence_translation_read + idea_tag_translation_read (20261009200000_idea_translations) · ideaStoreRlsRead.test "the unbound read" + "the translation tables" (under SET LOCAL ROLE motir_app, nothing bound)',
  ],
  'ideaTagRepository.ts#listAll': [
    'public',
    'idea_read + idea_evidence_read + idea_tag_read + idea_tag_assignment_read + idea_research_run_read (20261007100000_idea_store) + idea_translation_read + idea_evidence_translation_read + idea_tag_translation_read (20261009200000_idea_translations) · ideaStoreRlsRead.test "the unbound read" + "the translation tables" (under SET LOCAL ROLE motir_app, nothing bound)',
  ],
  'ideaResearchRunRepository.ts#listRecent': [
    'public',
    'idea_read + idea_evidence_read + idea_tag_read + idea_tag_assignment_read + idea_research_run_read (20261007100000_idea_store) · ideaStoreRlsRead.test "the unbound read" (under SET LOCAL ROLE motir_app, nothing bound)',
  ],
};

/**
 * The ratchet, now AT ITS FLOOR. Every enumerated singleton read of a policy-gated
 * table carries a real verdict; none is deferred.
 *
 * ⚠️ This number may only ever go DOWN, and it cannot go down further. Since
 * MOTIR-2833 the `Verdict` union has no `'unreviewed'` member either, so the state
 * is unreachable by TYPE as well as by count — re-entering it takes an explicit
 * type change, which is the point. If this assertion ever fails, someone has cast
 * their way past the union; adjudicate the site, never raise the ceiling.
 */
const UNREVIEWED_CEILING = 0;
// 70 -> 69: MOTIR-2789 made `workspaceRepository.findById` bindable and bound the public
// board/stats reads that were its callers.
// 69 -> 8: MOTIR-2789 adjudicated the rest. NOT by fixing 61 reads — by locating every
// call site, finding that none binds a context, and saying so in a verdict that names the
// owning service. The eight that remain are the public-surface reads, which need a green
// public-projects suite before a `public` verdict is honest rather than assumed.
//
// ⚠️ READ THIS BEFORE CELEBRATING THE DROP. 69 -> 8 was a gain in KNOWLEDGE, not in
// correctness — see the two-ratchets note in this file's header, which is the whole
// reason a second ratchet existed. Reporting the unreviewed count alone would have
// misrepresented that commit.
//
// 8 -> 0: MOTIR-2833 earned the last eight, and this drop is the OPPOSITE of the 69 -> 8
// one above — it is correctness, not just knowledge, because half of it was paid for in
// policy. FOUR of the eight were BROKEN when the card opened: three roadmap/dedupe reads
// join `workflow_status` and `listPublicDirectoryRanked` joins `workspace` -> `organization`,
// none of which carried a public arm, so each returned zero rows and raised nothing.
// MOTIR-2856 added the three arms; MOTIR-2857 fixed the two test defects that had hidden
// the whole class (app-role setup writes in `tests/projectSquare`, and a `publicRoadmap`
// fixture that was never made public); MOTIR-2833 added the missing `listPublic` test and
// wrote the verdicts. The other four were always correct and are now SAID to be, with a run.
//
// 73 -> 70: MOTIR-2775 RETIRED three zero-caller org-tier singleton reads
// (`organizationRepository.findById` / `findBySlug`,
// `organizationMembershipRepository.findByOrgAndUser`) rather than adjudicating them.
// Deleting a site is a legitimate way to lower this number — the point of the ratchet is
// that the count of UNJUDGED reads falls, and a read that no longer exists needs no
// verdict. Lowered in the same commit as the deletion, which is what the guard asks for.

// ── The retired second ratchet (MOTIR-2814) ─────────────────────────────────
// `UNBOUND_READ_PATH_CEILING` lived here and measured the reads confirmed BROKEN under
// `motir_app`. MOTIR-2796 walked it 55 -> 0 across fifteen cards — savedFilters,
// reports, sprints + estimation, boards, `findByIds` and its 13 call sites, activity,
// workItems (link edges, then trees/search/decorations), plan validity + staleness, the
// nine single-read services, migrate-onboarding, and a public SELECT arm for
// `public_request_vote`. With the class empty the constant is gone: the set-equality test
// above is the stronger guard, because a new unbound read has no verdict to earn and
// fails the build outright rather than fitting under a ceiling.
//
// ⚠️ The constant sat STALE at 14 for the last four of those cards. Their messages each
// claimed a step (14 -> 11 -> 3 -> 1 -> 0); the VERDICTS entries were duly removed, but
// the literal was not edited, and `0 <= 14` passes silently. That is the failure mode a
// ceiling has and a set-equality assertion does not, and it is a second reason this one
// is retired rather than pinned at zero.

describe('singleton reads of policy-gated tables are all accounted for', () => {
  it('every scanned site has a verdict, and every verdict names a real site', () => {
    const scanned = scanSingletonReads()
      .map((r) => r.key)
      .sort();
    const declared = Object.keys(VERDICTS).sort();

    const undeclared = scanned.filter((k) => !declared.includes(k));
    const stale = declared.filter((k) => !scanned.includes(k));

    // Two separate messages, because the two failures need opposite fixes.
    expect(
      undeclared,
      'A repository method reads the `@/lib/db` singleton against a policy-gated ' +
        'table and is not in VERDICTS. Under the non-bypass role that read returns ' +
        'ZERO ROWS AND RAISES NOTHING. Decide which it is — pass the caller`s `tx` ' +
        '(`bound`), or add an entry saying why it needs no tenant — and add it here.',
    ).toEqual([]);
    expect(
      stale,
      'VERDICTS names a site the scanner no longer finds. If you bound or deleted ' +
        'the read, delete its entry too — a stale allowlist hides the next one.',
    ).toEqual([]);
  });

  it('the unreviewed count only ever falls, and is now at its floor', () => {
    // `'unreviewed'` is no longer a member of `Verdict` (MOTIR-2833), so this
    // comparison is deliberately widened to `string`: the TYPE now refuses the
    // value, and this is the runtime backstop for the one way past it — an
    // author casting a verdict in. Without the widening TS rejects the compare
    // as having no overlap, which would quietly delete the check.
    const unreviewed = Object.entries(VERDICTS)
      .filter(([, [verdict]]) => (verdict as string) === 'unreviewed')
      .map(([key]) => key);

    expect(
      unreviewed.length,
      `${unreviewed.length} sites are still unreviewed (ceiling ${UNREVIEWED_CEILING}). ` +
        'The ceiling is at its floor and `unreviewed` is gone from the Verdict union, so ' +
        'reaching this means a site was cast past the type. Adjudicate it — never raise ' +
        'the ceiling.',
    ).toBeLessThanOrEqual(UNREVIEWED_CEILING);
  });

  it('every verdict cites the evidence its kind requires', () => {
    // The reason string is the only place a verdict's grounds live, and a `public`
    // verdict is a claim about the DATABASE — so it must name the policy ARM and the
    // RUN that watched it work. This is the check that would have made MOTIR-2833's
    // predicted-but-unearned verdicts impossible to write down: four of the eight were
    // broken at the time, and no run existed to cite for any of them.
    const publicVerdicts = Object.entries(VERDICTS).filter(([, [verdict]]) => verdict === 'public');

    // A floor, so deleting the population cannot make this pass vacuously.
    expect(publicVerdicts.length).toBeGreaterThanOrEqual(9);

    for (const [key, [, reason]] of publicVerdicts) {
      expect(reason, `${key}: a \`public\` verdict must name the policy arm it rests on`).toMatch(
        /_(read|public_project_read)\b/,
      );
      expect(
        reason,
        `${key}: a \`public\` verdict must cite the run that settles it — a migration ` +
          'number alone is the policy EXISTING, not the policy WORKING',
      ).toMatch(/·/);
    }
  });

  it('the scanner rules correctly on a fixture with all five shapes', () => {
    // THE NEGATIVE CASE, as a permanent test rather than a one-off manual check.
    // A guard is only worth its allowlist if its detector is exercised in BOTH
    // directions, so the fixture carries one of each shape and this pins the verdict
    // on all five. Run against a fixture ROOT rather than by editing a real
    // repository, so proving the guard works can never leave a stray read behind.
    const root = 'tests/rls/__fixtures__/scanner';
    const keys = scanSingletonReads(root)
      .map((r) => r.key)
      .sort();

    expect(keys).toEqual([
      // (1) unbound read of a workspace-scoped model, (7) the same through the
      // narrowed `dbRead` client, and (4) raw SQL.
      'fixtureRepository.ts#findWidgetUnbound',
      'fixtureRepository.ts#findWidgetUnboundViaDbRead',
      'fixtureRepository.ts#rawUnbound',
    ]);

    // Spelled out individually, because `toEqual` above passing for the wrong
    // reason (an empty scan, a broken schema parse) is the failure mode that would
    // make this whole file decorative.
    expect(keys, 'a `tx ?? db` read is bindable, not unbound').not.toContain(
      'fixtureRepository.ts#findWidgetBindable',
    );
    expect(keys, 'a non-tenant model has no policy to be blind to').not.toContain(
      'fixtureRepository.ts#findGlobalSetting',
    );
    expect(keys, '$transaction is not a read').not.toContain('fixtureRepository.ts#notARead');
    // MOTIR-4295, both directions. `dbRead` is `db` under a narrower TYPE, so the
    // scanner must read it exactly as it reads `db`: a fallback through it is
    // bindable, and a BARE read off it is unbound. Keying on one name only would
    // have gone quiet on 247 swept call sites without a single assertion failing.
    expect(keys, 'a `tx ?? dbRead` read is bindable, not unbound').not.toContain(
      'fixtureRepository.ts#findWidgetBindableViaDbRead',
    );
  });

  it('the scanner actually finds the reads it is pointed at (a live negative)', () => {
    // A guard whose scanner silently returns nothing passes forever. Pin that it
    // resolves the schema, walks the repositories, and finds a known site.
    const scanned = scanSingletonReads();
    // A floor, not a target: it exists so a scanner that silently returns nothing
    // fails instead of passing forever. It moves DOWN as reads become bindable —
    // 51 before MOTIR-2807, 19 after MOTIR-2809 — so it is kept comfortably below
    // the live count rather than pinned to it, and lowered when a card takes the
    // population past it.
    expect(scanned.length).toBeGreaterThan(10);
    // A KNOWN site, chosen because it SURVIVES this story by design:
    // `rateLimitCounterRepository.countAllUnsafe` carries the `pre-auth` verdict
    // (no tenant exists at read time), so nothing will bind it away. Two earlier
    // canaries — `quickSearch`, then `matchesAutomationCondition` — were each
    // bound by the very next card, which is the wrong property for a canary.
    expect(scanned.map((r) => r.key)).toContain('rateLimitCounterRepository.ts#countAllUnsafe');
    // And that the `tx ?? db` fallback is genuinely excluded — `findStatuses` uses it,
    // so if this ever appears the scanner has stopped distinguishing bindable reads
    // from unbound ones and every verdict above is meaningless.
    expect(scanned.map((r) => r.key)).not.toContain('workflowsRepository.ts#findStatuses');
  });
});
