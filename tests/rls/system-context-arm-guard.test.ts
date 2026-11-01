import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDb } from '../helpers/adminDb';
import { SYSTEM_CONTEXT, contextOnlyReads, scanContexts, schemaMap } from './contextArmScan';
import { armedTables, rlsEnabledTables } from './policyArms';

// The SYSTEM-CONTEXT ARM guard (MOTIR-2880) — the FOURTH axis, and the first one
// that asks a question about the DATABASE rather than about the code.
//
//   singleton-read-guard   — can this read be bound?          (a `tx` parameter)
//   call-site-guard        — do its callers bind it?          (a `tx` argument)
//   bare-transaction-guard — what did the transaction bind?   (a `set_config`)
//   THIS ONE               — does any POLICY read what it bound?
//
// Every site below answers YES to the first three. `withSystemContext` opens a
// transaction, binds `app.system_admin`, and hands a `tx` to every read beneath
// it — textbook, by all three sibling instruments. And `app.system_admin` is read
// by a policy ARM that exists PER TABLE: at the commit this landed, 26 of the 69
// RLS-protected tables carry one on a permissive SELECT/ALL policy and 43 do not.
// A read of one of the 43 inside a system context returns ZERO ROWS AND RAISES
// NOTHING, so `parentStatusRollupService` answered `no_parent` for every item,
// `changeRequestStatusSync` stopped driving any card's status, and
// `ciFleetCostMeterService` reported a cost of zero — none of it visible, none of
// it logged, all of it green under three scanners.
//
// ⚠️ THE ASSERTION IS PER (TABLE, CONTEXT) AND IT READS `pg_policies`, NOT THE
// MIGRATIONS. The arm is a property of the DEPLOYED policy set, so the migration
// files are a claim about it and the catalog is the fact (`notes.html` #248, the
// same distinction one layer down). Reading the catalog also means a policy
// dropped by hand, or an arm a later migration removes, turns this red on the
// next run rather than at the next incident.
//
// ⚠️ AND IT ADJUDICATES THE WHOLE QUERY, NOT THE FROM CLAUSE. `notes.html` #269.
// Both sites this card could NOT fix by binding were found through a JOIN and
// would have been cleared by an arm inventory: `projectRepository#findLivePairs`
// reads the armed `project` and dies on its `workspace: { is: {} }` relation
// filter; `ciContainerPeriodCostRepository#sumForPeriodByMetaSplit` reads the
// armed `ci_container_period_cost` and dies on `JOIN "organization"`. So
// `contextArmScan` resolves relation keys and raw-SQL join targets, and the
// assertion below runs over every table the query touches.
//
// The division of labour is the one MOTIR-2784 established and the three sibling
// guards keep: the machine enumerates, a human adjudicates, and a site nobody has
// ruled on fails the build.
//
// ── ⚠️ THE SCANNER IS NO LONGER THIS GUARD'S ALONE (MOTIR-2959) ─────────────
// `systemContextScan.ts` is now `contextArmScan.ts`, and the GUC it asks about
// is a {@link ContextDescriptor} parameter rather than a constant — because the
// question was never specific to `app.system_admin`, and the same class has
// since been found on the org binding (MOTIR-2956, the free-tier storage cap).
// `org-context-arm-guard.test.ts` is the second consumer and
// `other-context-arm-guard.test.ts` the third.
//
// **Nothing in THIS file's verdicts moved, and that was checked rather than
// hoped.** Running the pre-rename scanner and `scanContexts(SYSTEM_CONTEXT)`
// side by side over `origin/main` @ `7de5856f` returns the same 166 sites and
// the same 14 fixture sites, field for field — file, line, enclosing, key,
// verdict, models, raw, via and unresolvedCalls. Two names changed and no
// judgement did: the verdict `system-only` reads `context-only` and
// `binds-tenant` reads `narrowed`, because on a descriptor that binds an org id
// neither of the old words means anything.

/** Why a system-only read of an UNARMED table is nonetheless acceptable. */
type Verdict =
  /**
   * NOT GATED AFTER ALL — the model is in `policyGatedModels` only because that
   * set OVER-APPROXIMATES on purpose (a `workspaceId` column, or a historical
   * `CREATE POLICY` the migration sweep never subtracts). The table has RLS
   * disabled, so no arm is owed.
   *
   * ⚠️ The reason must carry the MEASUREMENT — `pg_class.relrowsecurity` — because
   * that is the authority and the schema heuristic is not.
   */
  | 'no-rls'
  /**
   * CONFIRMED blind under `motir_app`, with a card that owns the fix. Empty today
   * and meant to stay that way: this is where a NEW finding lands while its card
   * is in flight, not a parking space.
   */
  | 'blind-carded';

/**
 * One entry per (FILE#ENCLOSING, model), matching the sibling guards' choice of a
 * LINE-INDEPENDENT key: a system context that moves down its file is the same
 * adjudication, and keying on the line would make every unrelated edit a
 * re-review.
 *
 * ⚠️ EMPTY IS THE HEADLINE, and it is a measurement rather than an aspiration.
 * MOTIR-2872's class 1 opened with 88 system-context sites of which TEN reached a
 * table with no arm. Eight were fixed by BINDING the tenant — the disposition
 * that widens nothing — and two, which are cross-tenant by design and have no
 * single tenant to bind, by a `FOR SELECT` arm on `workspace` and `organization`
 * (`20260817120000_system_admin_read_arms_workspace_organization`). Ten to zero,
 * with no entry left here.
 */
const DELIBERATELY_SYSTEM_ONLY: Record<string, Verdict> = {};

/**
 * Sites whose walk hit a WALL — a `tx` handed to a callee the scan cannot resolve
 * by name — with the hand-adjudication that stands in for the walk (MOTIR-2910).
 *
 * ⚠️ AN ENTRY HERE IS NOT A SUPPRESSION. `DELIBERATELY_SYSTEM_ONLY` records
 * "this blind read is fine"; this records "the INSTRUMENT could not see, and a
 * human went and looked." The value is what they found, so a reviewer can check
 * the reading rather than trust the silence.
 *
 * Both entries are the shared change-request consumers, and the indirection is
 * the same in both: the provider supplies its resolver as a `resolveContext`
 * parameter, which is the seam that lets GitHub and GitLab share one state
 * machine. That is good design and it is opaque to a name-resolving walk.
 */
const WALLED_SITES: Record<string, string> = {
  // Re-keyed by MOTIR-5699: the body moved into `syncOnce` behind a wrapper that
  // runs the ready-flip re-ask; the transaction and its `resolveContext` are unchanged.
  'lib/services/changeRequestStatusSync.ts#syncOnce':
    'resolveContext ∈ { resolveGithubChangeRequestContext, resolveGitlabChangeRequestContext }. ' +
    'GitHub: github_installation + github_repo (both armed), THEN resolveBoundMember → ' +
    'github_identity (armed) + workspace_membership (NOT armed) — THE DEFECT, and the ' +
    'reason this map exists. Fixed by binding the tenant inside the resolver the moment ' +
    'the repo row supplies it (MOTIR-2910), not by arming workspace_membership. ' +
    'GitLab: github_repo + its installation relation only — no membership read, clean.',
  'lib/services/changeRequestCiFeedback.ts#applyOneCiDelivery':
    'resolveContext ∈ { resolveGithubCiContext, resolveGitlabCiContext }. Read in full ' +
    'for MOTIR-2910: both reach github_installation and github_repo and nothing else, ' +
    'both armed, and neither resolves an author — the CI path attributes to no member. ' +
    'CLEAN, and recorded so the next reader does not have to re-read them. (The block ' +
    'moved from applyCiStatusFeedback into applyOneCiDelivery behind the MOTIR-6788 ' +
    'concurrency gate, which passes resolveContext through unchanged; the two callers ' +
    'are still githubWebhookService.handleCiStatus and gitlabWebhookService.handlePipeline.)',
  'lib/services/repoDeploymentService.ts#record':
    'resolveRepo ∈ { the inline resolvers in githubWebhookService.handleDeploymentStatus ' +
    '(MOTIR-5329) and gitlabWebhookService.handleDeployment (MOTIR-5332) }. Read in full: ' +
    'GitHub — githubInstallationRepository.findByInstallationId + ' +
    'githubRepoRepository.findByInstallationAndRepoId; GitLab — ' +
    'githubRepoRepository.findByRepoIdAndProvider with its installation relation. ' +
    'github_installation and github_repo, both armed, and nothing else. The write that follows is ' +
    'repo_deployment, whose repo_deployment_workspace_or_system policy carries the arm. ' +
    'No member, no work item, no tenant-only table. CLEAN.',
  'lib/services/ciPreviewUsageMeterService.ts#writeSlices':
    'build ∈ { the three inline closures in the same file: accrueRelease, recordBranchUsage ' +
    '(which recordDeletedBranch reaches too) and recordDestroyedApp } (MOTIR-5777). Read in full: each calls only ' +
    'previewUsageRepository.lastSliceEnd and .sumQuantity — aggregates over preview_usage, ' +
    'whose preview_usage_system policy carries the arm — and builds slices in memory. The ' +
    'block itself also locks preview_deployment (preview_deployment_workspace_or_system, ' +
    'armed) and inserts into preview_usage. No member, no work item, no tenant-only table. CLEAN.',
  'lib/services/mergeQueueExitService.ts#recordExit':
    'write ∈ { the local `write` closure in the same method } — one implementation, ' +
    'read in full (MOTIR-5632). The system arm is taken ONLY when the workspace has no ' +
    'owner, and its first statement is bindWorkspaceContext(tx, found.workspaceId) — the ' +
    'tenant Phase 1 resolved from the armed github_installation + github_repo rows — so ' +
    'everything write reads runs tenant-bound: github_pull_request (find + lock + clear ' +
    'queue ref), github_pull_request_queue_exit (find by delivery + create; its policy ' +
    'carries the arm), and resolveDeliveredWorkItems (work_item_delivery → work_item). ' +
    'With no owner there is no actor, so every card is skipped as no_actor and no gate, ' +
    'work item or status write is reached. CLEAN.',
  'lib/services/fleetShardControlsService.ts#change':
    'write ∈ { the three closures setCeiling, disable and enable pass } — read in full ' +
    '(MOTIR-8972). After lockByNameForUpdateInTx (fleet_shard), setCeiling calls ' +
    'shardAdmissionCeiling (pure) and setAdmissionCeilingOverrideInTx; disable and enable ' +
    'call updateState. Every statement is on fleet_shard, whose fleet_shard_system_only ' +
    'policy IS the system arm. No tenant table. CLEAN.',
  'lib/services/fleetShardHeadroomService.ts#readAccountHeadroom':
    'peak ∈ PEAK_ON_SHARD = { ci_runner: ciRunnerPeak } — read in full (MOTIR-8969). ' +
    'ciRunnerPeak reads ci_runner_provisioning_intent, whose ' +
    'ci_runner_provisioning_intent_workspace_or_system policy carries the arm. The ' +
    'fleet-wide read is cross-tenant by design. CLEAN.',
  'lib/services/fleetShardHeadroomService.ts#run':
    'peak ∈ PEAK_ON_SHARD = { ci_runner: ciRunnerPeak } — the same readAccounts walk as ' +
    'readAccountHeadroom: ci_runner_provisioning_intent, armed. CLEAN.',
};

let rlsTables: Set<string>;
let systemArmed: Set<string>;

// WARM THE SCAN ONCE, in a hook with its own budget — the reason
// `call-site-guard.test.ts` and `bare-transaction-guard.test.ts` both give: the
// compiler-API walk over `lib/` + `app/` is a few seconds bare, and under
// `vitest run --coverage` the v8 provider instruments it heavily enough to blow
// the repo's 15 s `testTimeout`, so `pnpm test` is green while the coverage lane
// is red. Both roots are warmed — the fixture tree is a SEPARATE cache key, on
// purpose, so a single unkeyed cache could never hand the fixture the real
// repo's answer.
//
// ⚠️ Do NOT "fix" a recurrence by raising `testTimeout`: that is a global knob
// and this is one expensive fixture.
beforeAll(async () => {
  scanContexts(SYSTEM_CONTEXT);
  scanContexts(SYSTEM_CONTEXT, 'tests/rls/__fixtures__/systemContexts');
  rlsTables = await rlsEnabledTables();
  // The arm inventory moved to `policyArms.ts` when MOTIR-2959 made the GUC a
  // parameter; the question it asks is the one this guard has always asked, and
  // tightening the match from `%system_admin%` to the
  // `current_setting('app.system_admin'` reference returns the SAME 29 tables on
  // `origin/main` @ `7de5856f`. No verdict below is re-derived.
  systemArmed = await armedTables(SYSTEM_CONTEXT.gucs[0]!);
}, 120_000);

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('every system-context read touches a table whose policy set reads app.system_admin', () => {
  it('has no unadjudicated (site, table) pair', () => {
    const { tableOf } = schemaMap();
    const findings: string[] = [];

    for (const site of scanContexts(SYSTEM_CONTEXT)) {
      for (const model of site.contextOnlyModels) {
        const table = tableOf.get(model);
        if (!table) {
          findings.push(`${site.key} :: ${model} — no table in prisma/schema.prisma`);
          continue;
        }
        if (!rlsTables.has(table)) continue; // over-approximation; nothing to be blind to
        if (systemArmed.has(table)) continue;
        if (DELIBERATELY_SYSTEM_ONLY[`${site.key} :: ${model}`]) continue;
        findings.push(
          `${site.key} :: ${model} -> "${table}" has RLS and NO system_admin read arm ` +
            `(reached via ${site.via.join(', ')})`,
        );
      }
    }

    expect(
      findings,
      'A `withSystemContext` block reads a table whose policies do not read ' +
        '`app.system_admin`. Under `motir_app` that read returns ZERO ROWS and raises ' +
        'NOTHING.\n\n' +
        'The disposition is one of three, and the FIRST is nearly always right:\n' +
        '  1. BIND the tenant — `bindWorkspaceContext(tx, id)` /\n' +
        '     `bindOrganizationContext(tx, id)` the moment the id is known, or move the\n' +
        '     whole block to `withWorkspaceServiceContext`. Additive, widens nothing.\n' +
        '  2. ARM the table — ONLY when the read is cross-tenant BY DESIGN and there is\n' +
        '     no single tenant to bind. `FOR SELECT` only: the tenant-root WRITE\n' +
        '     refusal (MOTIR-2865) is load-bearing.\n' +
        '  3. ADJUDICATE it here, with the measurement and the card that owns it.\n\n' +
        'Adding an entry to DELIBERATELY_SYSTEM_ONLY without one of the first two is ' +
        'how this class grew back.',
    ).toEqual([]);
  });

  it('has no adjudication left for a pair the scan no longer reports', () => {
    // The mirror of the assertion above, and the half that rots silently: an
    // entry whose site was fixed or deleted keeps a permanent "this is fine" on
    // record for a shape nobody can find any more.
    const { tableOf } = schemaMap();
    const live = new Set(
      scanContexts(SYSTEM_CONTEXT).flatMap((s) =>
        s.contextOnlyModels.map((m) => `${s.key} :: ${m}`),
      ),
    );
    const stale = Object.keys(DELIBERATELY_SYSTEM_ONLY).filter((k) => !live.has(k));
    expect(stale, 'a verdict for a pair the scan no longer reports — delete it').toEqual([]);
    // …and a verdict of `no-rls` that is no longer true.
    const wrong = Object.entries(DELIBERATELY_SYSTEM_ONLY)
      .filter(([k, v]) => v === 'no-rls' && rlsTables.has(tableOf.get(k.split(' :: ')[1]!) ?? ''))
      .map(([k]) => k);
    expect(wrong, 'adjudicated `no-rls`, but the table has RLS enabled').toEqual([]);
  });

  it('the two un-bindable sites are ARMED, not adjudicated away', () => {
    // The pair this card could not fix by binding, pinned BY NAME. They are the
    // reason two policies were added, so the day someone reverts an arm the
    // failure names the read rather than appearing as an anonymous count.
    expect(systemArmed.has('workspace'), 'workspace — projectRepository#findLivePairs').toBe(true);
    expect(
      systemArmed.has('organization'),
      'organization — ciContainerPeriodCostRepository#sumForPeriodByMetaSplit',
    ).toBe(true);
  });

  it('MOTIR-2910 site 1 — `github_identity` carries a MEMBER read arm, and only a read arm', () => {
    // Pinned BY NAME, the way `workspace` and `organization` are above, and for
    // the same reason: the day someone reverts this the failure should name the
    // read that goes blind rather than surface as an anonymous count.
    //
    // ⚠️ It is NOT in `systemArmed` and must not be — that set is the
    // `system_admin` arm, and this is a WORKSPACE-MEMBER arm. The team grid's
    // caller is already correctly bound to its own tenant; what it cannot reach
    // is other users' rows INSIDE that tenant, which no binding fixes and
    // `app.system_admin` would fix far too widely (it would hand one workspace's
    // grid sight of every workspace's GitHub identities).
    return adminDb.$queryRaw<{ policyname: string; cmd: string; permissive: string }[]>`
        SELECT policyname, cmd, permissive
          FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'github_identity'
      `.then((rows) => {
      const member = rows.filter((r) => r.policyname === 'github_identity_workspace_member_read');
      expect(
        member.map((r) => `${r.cmd}/${r.permissive}`),
        'github_identity — projectRepoAccessService#listTeamAccess reads co-members` logins',
      ).toEqual(['SELECT/PERMISSIVE']);

      // ⚠️ THE OVERSHOOT THIS CARD WAS MOST LIKELY TO MAKE. The row carries
      // `access_token_encrypted`, a live OAuth credential, and RLS admits a ROW
      // rather than a column list — so the ONE thing that must never happen here
      // is a write verb reaching it. `FOR ALL` on this table would let a member
      // overwrite a co-member's stored token with a value they control. The
      // column split itself lives in the repository (`findLoginsByUserIds`
      // selects two columns) and is pinned in `projectRepoTeamAccess.test.ts`;
      // this is the half `pg_policies` can answer.
      expect(
        rows
          .filter((r) => r.policyname !== 'github_identity_owner_or_system')
          .filter((r) => r.cmd !== 'SELECT')
          .map((r) => `${r.policyname} (${r.cmd})`),
        'a NON-owner policy on github_identity now covers a write verb — a member ' +
          'must never be able to write a co-member`s OAuth binding',
      ).toEqual([]);
    });
  });

  it('MOTIR-2910 site 2 — `workspace_membership` is still UNARMED, so the bind is load-bearing', () => {
    // The mirror pin. Site 2 was fixed by BINDING the tenant inside
    // `resolveGithubChangeRequestContext`, which is the disposition that widens
    // nothing — and the alternative someone will reach for when it next goes red
    // is arming this table, which would hand every system context sight of every
    // workspace's membership rows. Asserting the absence is what makes the bind
    // the only answer that keeps this suite green.
    expect(
      systemArmed.has('workspace_membership'),
      'workspace_membership must NOT get a system_admin arm — githubWebhookService#' +
        'resolveGithubChangeRequestContext binds repo.workspaceId instead (MOTIR-2910)',
    ).toBe(false);
  });

  it('the arms are READ-only — no system arm was added to a tenant-root WRITE policy', () => {
    // MOTIR-2865 found the ABSENCE of a system arm on the tenant-root write
    // policies doing useful work: a caller reaching for `withSystemContext` on a
    // membership INSERT is REFUSED rather than over-permitted. Arming a read is
    // how this card fixed two sites; arming a write would trade a visible bug for
    // an invisible hole, so it is asserted against rather than merely avoided.
    return adminDb.$queryRaw<{ tablename: string; policyname: string; cmd: string }[]>`
        SELECT tablename, policyname, cmd
          FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename IN ('workspace', 'organization', 'workspace_membership',
                             'organization_membership')
           AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
           AND (coalesce(qual, '') LIKE '%system_admin%'
                OR coalesce(with_check, '') LIKE '%system_admin%')
      `.then((rows) => {
      expect(
        rows.map((r) => `${r.tablename}.${r.policyname} (${r.cmd})`),
        'a tenant-root WRITE policy now reads app.system_admin — see MOTIR-2865',
      ).toEqual([]);
    });
  });
});

describe('the scanner itself', () => {
  it('rules correctly on a fixture carrying every verdict', () => {
    // THE NEGATIVE CASE, as a permanent test rather than a one-off check, and run
    // against a fixture ROOT so proving the detector works can never leave a stray
    // unbound system context in a real service.
    const root = 'tests/rls/__fixtures__/systemContexts';
    const byEnclosing = new Map(scanContexts(SYSTEM_CONTEXT, root).map((s) => [s.enclosing, s]));
    const site = (fn: string) => byEnclosing.get(fn);

    // Pinned INDIVIDUALLY. One `toEqual` over the set would pass for the wrong
    // reason the day the scan returns nothing at all.
    expect(site('systemOnlyRead')?.verdict, 'a plain gated read under the flag').toBe(
      'context-only',
    );

    // ⚠️ THE JOIN CASES — the three shapes an arm inventory clears and the query
    // does not. Each must report the JOINED model too, not only the FROM clause.
    expect(site('systemOnlyJoinedRead')?.contextOnlyModels, 'an `include` is a join').toEqual([
      'gadget',
      'widget',
    ]);
    expect(
      site('systemOnlyRelationFilterRead')?.contextOnlyModels,
      'a relation FILTER is a join — this is `findLivePairs`',
    ).toEqual(['gadget', 'widget']);
    expect(
      site('systemOnlyRawJoin')?.contextOnlyModels,
      'a raw-SQL JOIN is a join — this is `sumForPeriodByMetaSplit`',
    ).toEqual(['gadget', 'widget']);

    // The binding, and its POSITION.
    expect(site('bindsBeforeRead')?.verdict, 'bound before the read').toBe('narrowed');
    expect(
      site('bindsAfterRead')?.verdict,
      'a binding AFTER the read cannot retroactively bind it — a whole-site boolean ' +
        'gets this wrong, and every site this card fixed binds MID-BLOCK',
    ).toBe('context-only');
    expect(
      site('discoversThenBinds')?.contextOnlyModels,
      'the connection-tier read before the bind is system-only BY DESIGN; only the ' +
        'tenant read after it is bound',
    ).toEqual([]);

    // Nothing gated to be blind to.
    expect(site('systemNonGated')?.verdict).toBe('no-gated-statement');

    // One hop into a same-file helper.
    expect(site('systemOnlyViaHelper')?.verdict, 'one hop into a forwarding helper').toBe(
      'context-only',
    );

    // A tenant-bound context is not a system context, so it is not reported.
    expect(byEnclosing.has('bound'), 'withWorkspaceServiceContext is not a system context').toBe(
      false,
    );

    // THE DEPTH, pinned from both sides. Two hops is IN reach — that is where the
    // `sweepRepo` -> `applyOne` -> `resolveChangeRequestWorkItem` miss lived, and
    // finding it is why the walk is recursive at all. Four is OUT, so the bound is
    // a decision rather than an accident of how deep the tree happened to go.
    expect(site('systemTwoHops')?.verdict, 'two hops — the real miss lived here').toBe(
      'context-only',
    );
    expect(site('systemThreeHops')?.verdict, 'three hops — the last one in reach').toBe(
      'context-only',
    );
    expect(
      site('systemFourHops')?.verdict,
      'four hops is out of reach by design — if this changed, MAX_HELPER_HOPS moved',
    ).toBe('no-gated-statement');

    // Mutual recursion terminates and still reports what it reaches. Without the
    // visited set the bounded walk would be finite but would re-enter `ping` on
    // every level, which is the shape that turns a scan into a hang.
    expect(site('systemMutualRecursion')?.verdict, 'ping/pong terminates').toBe('context-only');

    // THE WALL (MOTIR-2910). A `tx` handed to a function-typed PARAMETER is a
    // callee the walk cannot resolve by name, so everything below it is unread.
    // Both halves are pinned: the site NAMES the unresolved call, and its verdict
    // is still `narrowed` — because the point is that a green verdict here is
    // computed over a partial walk, which is exactly what made the real instance
    // invisible. A future change that starts resolving these will fail this and
    // should: the adjudication below would then be describing a solved problem.
    expect(
      site('systemUnresolvedCallback')?.unresolvedCalls,
      'a tx passed to a callback parameter must be REPORTED, not stepped over',
    ).toEqual(['resolveContext']);
    expect(
      site('systemUnresolvedCallback')?.verdict,
      'and the partial walk still reads green — the reason the field exists',
    ).toBe('narrowed');
  });

  it('every site whose walk hit a WALL is adjudicated', () => {
    // The mirror of `DELIBERATELY_SYSTEM_ONLY`, for the axis the scan cannot
    // decide at all (MOTIR-2910). A site that hands its `tx` to an unresolvable
    // callee has a verdict computed over PART of its block, so the verdict is not
    // evidence — someone has to have read the callee. Two exist, both the shared
    // change-request consumers, both taking the provider's resolver as a
    // parameter; every entry names what was read by hand and what it found.
    const findings = scanContexts(SYSTEM_CONTEXT)
      .filter((s) => s.unresolvedCalls.length > 0)
      .filter((s) => !WALLED_SITES[s.key])
      .map((s) => `${s.key} — unresolved: ${s.unresolvedCalls.join(', ')}`);

    expect(
      findings,
      'A `withSystemContext` block hands its transaction to a callee this scan ' +
        'cannot resolve by name, so its verdict covers only the part of the block ' +
        'the walk could read.\n\n' +
        'This is NOT a finding to silence — it is the shape that hid MOTIR-2910 ' +
        "(`resolveGithubChangeRequestContext`'s unbound `workspace_membership` read " +
        'sat behind exactly this indirection while the site reported `narrowed`).\n\n' +
        'To clear it: READ every implementation that can be passed for that ' +
        'parameter, adjudicate each against the arm rules above, and record the ' +
        'result in WALLED_SITES.',
    ).toEqual([]);
  });

  it('has no WALLED_SITES adjudication for a site the scan no longer reports', () => {
    // Same rot as the `DELIBERATELY_SYSTEM_ONLY` mirror: an entry whose
    // indirection was refactored away keeps a permanent "someone read this" on
    // record for a shape nobody can find.
    const live = new Set(
      scanContexts(SYSTEM_CONTEXT)
        .filter((s) => s.unresolvedCalls.length > 0)
        .map((s) => s.key),
    );
    expect(
      Object.keys(WALLED_SITES).filter((k) => !live.has(k)),
      'a hand-read verdict for a wall the scan no longer hits — delete it',
    ).toEqual([]);
  });

  it('actually finds the sites it is pointed at (a live negative)', () => {
    // A scanner that silently returns nothing passes forever. Pin that it walks the
    // real tree, resolves the schema, and classifies in more than one direction.
    const all = scanContexts(SYSTEM_CONTEXT);
    expect(all.length).toBeGreaterThan(50);
    expect(all.some((s) => s.verdict === 'narrowed')).toBe(true);
    expect(contextOnlyReads(SYSTEM_CONTEXT).length).toBeGreaterThan(0);
    // Every reported site names a real file and a real enclosing function.
    expect(all.filter((s) => s.enclosing === '<module>')).toEqual([]);
  });
});
