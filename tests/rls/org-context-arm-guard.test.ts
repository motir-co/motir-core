import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDb } from '../helpers/adminDb';
import { ORG_SERVICE_CONTEXT, contextOnlyReads, scanContexts, schemaMap } from './contextArmScan';
import { armedTables, rlsEnabledTables } from './policyArms';

// The ORG-CONTEXT ARM guard (MOTIR-2959) — the same question one axis over.
//
//   singleton-read-guard      — can this read be bound?         (a `tx` parameter)
//   call-site-guard           — do its callers bind it?         (a `tx` argument)
//   bare-transaction-guard    — what did the transaction bind?  (a `set_config`)
//   system-context-arm-guard  — does a policy read `app.system_admin`?
//   THIS ONE                  — does a policy read `app.organization_id`?
//
// ── Why it exists, and why it is a SECOND guard rather than more sites ──────
// MOTIR-2956: the free-tier 2 GB storage cap silently never fired, for any
// organization, on any tier with a finite cap. `entitlementsService
// .assertWithinStorageCap` opened `withOrgServiceWriteContext`, bound
// `app.organization_id`, and summed `attachment` ⨝ `workspace` — neither of
// which had a policy reading that GUC. The sum came back 0 and 0 is under every
// cap. Above those three lines sat a comment naming that exact failure mode: the
// safeguard and the defect were the same three lines, and every reviewer who
// looked at them saw an author who had understood the risk.
//
// That card SWEPT the family by hand — twelve call sites, one broken, eleven
// written down in `docs/rls-runtime-role-inventory.md`. **A hand sweep is a
// snapshot.** The thirteenth call site, or a JOIN added to an existing
// repository method, restores the class in silence. This guard is the sweep
// re-derived on every run, which is the difference between a document and a
// ratchet.
//
// ⚠️ THE ASSERTION IS PER (TABLE, CONTEXT) AND IT READS `pg_policies`, NOT THE
// MIGRATIONS — `tests/rls/policyArms.ts`, which also records what that inventory
// can and cannot answer.
//
// ⚠️ AND IT ADJUDICATES THE WHOLE QUERY, NOT THE FROM CLAUSE. `notes.html` #269,
// and here it is load-bearing rather than theoretical: `sumSizeByOrganization`
// is `FROM "attachment" JOIN "workspace"`, so arming `attachment` alone would
// have left the sum at zero — the fix reading as applied while changing nothing.
// `the JOIN target is adjudicated too` below proves the guard sees it, by
// reconstructing the arm set as it stood before that migration.

/** Why an org-context read of an UNARMED table is nonetheless acceptable. */
type Verdict =
  /**
   * NOT GATED AFTER ALL — the model is in `policyGatedModels` only because that
   * set OVER-APPROXIMATES on purpose. The table has RLS disabled, so no arm is
   * owed. The reason must carry the MEASUREMENT (`pg_class.relrowsecurity`).
   */
  | 'no-rls'
  /**
   * CONFIRMED blind under `motir_app`, with a card that owns the fix. Empty
   * today and meant to stay that way: this is where a NEW finding lands while
   * its card is in flight, not a parking space.
   */
  | 'blind-carded';

/**
 * ⚠️ EMPTY IS THE HEADLINE, and it is a measurement rather than an aspiration.
 * MOTIR-2956 closed at one broken site out of twelve and armed both of its
 * tables; nothing has been blind since. An entry appearing here without one of
 * the first two dispositions in the failure message below is how this class
 * grows back.
 */
const DELIBERATELY_ORG_ONLY: Record<string, Verdict> = {};

/**
 * The MOTIR-2956 SWEEP, re-derived. One entry per `lib/` + `app/` call site of
 * `withOrgServiceWriteContext` / `bindOrganizationContext`, keyed
 * LINE-INDEPENDENTLY as `file#enclosing` exactly as the sibling guards key
 * theirs — several sites collapse onto one key on purpose (`chargeForMeteredRun`
 * binds three times), because the adjudication is of the METHOD.
 *
 * `tables` is what must carry an `app.organization_id` read arm, and `source`
 * says how it was established:
 *
 * - **`scan`** — the scanner reports exactly these, and the assertion below
 *   holds it to that. Twelve of the thirteen.
 * - **`hand`** — ⚠️ THE INSTRUMENT'S BLIND SPOT, NAMED RATHER THAN INHERITED
 *   (`notes.html` #268 / #273). The walk follows a `tx` into a REPOSITORY method
 *   or a helper it can resolve by NAME; a `tx` handed to a SERVICE method
 *   (`organizationsService.ensureOrgMembership(…, tx)`) is a property-access
 *   callee on an object the scan does not model, so it is stepped over and the
 *   site reports reaching nothing. `workspacesService#addMember` is that site,
 *   and MOTIR-2956's sweep read it by hand. Widening the walk to service objects
 *   would change the `SYSTEM_CONTEXT` axis too and is a card of its own; what is
 *   NOT acceptable is letting the sweep's twelfth verdict disappear because the
 *   machine cannot see it.
 */
const ORG_SWEEP: Record<string, { tables: string[]; source: 'scan' | 'hand'; why: string }> = {
  'lib/repositories/organizationRepository.ts#lockByIdForUpdate': {
    tables: ['organization'],
    source: 'scan',
    why:
      'THE DEFECT MOTIR-3710 FIXED, and the one entry in this sweep that is not a READ. ' +
      'The `SELECT "id" FROM "organization" … FOR UPDATE` that every §4 count cap serializes ' +
      'on matched ZERO rows from `withWorkspaceContext`: Postgres applies the UPDATE policy ' +
      'USING clause to a `FOR UPDATE`, `organization_mutate_active` reads app.organization_id, ' +
      'and that context binds user / workspace / project only — so the lock filtered out ' +
      'silently while `organization_membership_visible` kept the row READABLE. The method now ' +
      'binds the GUC itself, which is why it is a call site here at all. The arm asserted ' +
      'below is `organization_active`; the UPDATE arm the lock needs is not a SELECT policy ' +
      'and so is out of `armedTables` reach — the probe in ' +
      '`tests/entitlementsService.test.ts` is what re-measures THAT, on every run.',
  },
  'lib/services/assignableMembersService.ts#enteringMembers': {
    tables: ['organization_membership'],
    source: 'scan',
    why:
      'the org Owner / Admin rail of the assignee list (Story MOTIR-6169 · MOTIR-6547) — ' +
      'the org managers are read under a bound org, org_membership_visible_active_or_own. ' +
      'Moved out of `list` into a module helper shared with the name-only Visitor list ' +
      '(Story MOTIR-6170 · MOTIR-6646); the read is unchanged',
  },
  'lib/services/projectMembersService.ts#previewAccessModeChange': {
    tables: ['organization_membership'],
    source: 'scan',
    why:
      'the access-change preview keeps the org Owner / Admin off the lose-entry list ' +
      '(MOTIR-6544) — the same org-manager read, org_membership_visible_active_or_own',
  },
  'lib/services/billingPropagationService.ts#setScaledTrackerState': {
    tables: ['organization'],
    source: 'scan',
    why: 'UPDATE + RETURNING on the org row — organization_mutate_active / organization_active',
  },
  'lib/services/billingPropagationService.ts#setAiIncludedSeat': {
    tables: ['organization'],
    source: 'scan',
    why: 'UPDATE + RETURNING on the org row — the same pair',
  },
  'lib/services/billingService.ts#syncScaledTrackerSeatQuantity': {
    tables: ['organization', 'organization_membership'],
    source: 'scan',
    why: 'a `bindOrganizationContext` inside a `withSystemContext` block — organization_active / org_membership_visible_active_or_own',
  },
  'lib/services/ciActionsGateService.ts#syncForOrganization': {
    tables: ['organization'],
    source: 'scan',
    why: 'organization_active',
  },
  'lib/services/ciAllowanceService.ts#getEntitlementState': {
    tables: ['ci_period_charge', 'organization', 'organization_membership'],
    source: 'scan',
    why: 'organization_active / org_membership_visible_active_or_own / ci_period_charge_org_or_system',
  },
  'lib/services/ciAllowanceService.ts#chargeForMeteredRun': {
    tables: ['ci_period_charge', 'organization_membership'],
    source: 'scan',
    why: 'three binds in one method (the charge, the settle, the pending debit) — one adjudication',
  },
  'lib/services/ciAllowanceService.ts#settlePendingDebit': {
    tables: ['ci_period_charge'],
    source: 'scan',
    why: 'ci_period_charge_org_or_system',
  },
  'lib/services/ciMinutesMeterService.ts#isMeta': {
    tables: ['organization'],
    source: 'scan',
    why: 'organization_active',
  },
  'lib/services/ciMinutesMeterService.ts#meterWorkflowRun': {
    tables: ['project_repository', 'workspace'],
    source: 'scan',
    why:
      'THE SEVENTEENTH (MOTIR-4839, bug MOTIR-4835) — CI ATTRIBUTION, and the arm it needs was ' +
      'created by a TENANCY change rather than by a new surface. MOTIR-4669 made a repository ' +
      "ORG-owned, so `project_repository.workspace_id` — the LINKING project's — is routinely a " +
      'DIFFERENT workspace from `github_repo.workspace_id`, which is what this block binds. ' +
      'BOTH tables in the transaction then need an org arm and for different reasons: ' +
      "`project_repository` because `project_repository_active_workspace` matches only the row's " +
      'own workspace (project_repository_org_read, 20260906000000, is the arm), and `workspace` ' +
      "because the ANCHOR row is likewise a sibling's — admitted by workspace_org_service_read " +
      '(20260818010000), the USERLESS arm, which is exactly what a service context is.\n\n' +
      '⚠️ WITHOUT THE BIND IT WAS THE MOTIR-2956 SHAPE: zero rows, no error, and the run fell ' +
      'into \u00a75.4\'s "metered as a cost, charged to nobody" bucket. The existing suites could ' +
      'not fail on it — every fixture in them puts the repo and its link in ONE workspace, where ' +
      'the defect and the fix are indistinguishable — so the arm is what makes it observable and ' +
      '`tests/github/siblingWorkspaceAttribution.test.ts` is what observes it.',
  },
  'lib/services/agentInstanceLapseService.ts#readOrg': {
    tables: ['organization'],
    source: 'scan',
    why: 'the org row read for its flags, its name and its lapse (MOTIR-6921) — organization_active',
  },
  'lib/services/agentInstanceLapseService.ts#recordLapse': {
    tables: ['organization'],
    source: 'scan',
    why: 'UPDATE (set-if-unset) + re-read of the org row — organization_mutate_active / organization_active',
  },
  'lib/services/agentInstanceLapseService.ts#clearLapse': {
    tables: ['organization'],
    source: 'scan',
    why: 'UPDATE + RETURNING on the org row — organization_mutate_active / organization_active',
  },
  'lib/services/agentInstanceLifecycleService.ts#readUnlimitedAgentOrg': {
    tables: ['organization'],
    source: 'scan',
    why: 'the org row read for `isMeta` / `internalBilling` (MOTIR-6926) — organization_active',
  },
  'lib/services/agentInstanceLifecycleService.ts#list': {
    tables: ['organization'],
    source: 'scan',
    why: 'the org row read for the plan-lapse banner date (MOTIR-6921) — organization_active',
  },
  'lib/services/orgPlanReader.ts#readExemption': {
    tables: ['organization'],
    source: 'scan',
    why: 'organization_active',
  },
  'lib/services/ciLiveChargeService.ts#chargeOrganization': {
    tables: ['organization'],
    source: 'scan',
    why: 'organization_active',
  },
  'lib/services/platformFleetStopService.ts#requireOrganization': {
    tables: ['organization'],
    source: 'scan',
    why: 'organization_active',
  },
  'lib/services/platformFleetMonitorService.ts#judgeOrganization': {
    tables: ['ci_period_charge', 'organization'],
    source: 'scan',
    why: 'organization_active / ci_period_charge_org_or_system',
  },
  'lib/services/fleetCeilingService.ts#resolveCiBurstCap': {
    tables: ['organization'],
    source: 'scan',
    why: 'organization_active',
  },
  'lib/services/ciRunnerProvisioningService.ts#recordQueuedJob': {
    tables: ['project_repository', 'workspace'],
    source: 'scan',
    why:
      "THE EIGHTEENTH (MOTIR-4839) — the meter's twin, and it is deliberately IDENTICAL. The " +
      "service's own comment binds it: \"the SAME disposition as the meter's (MOTIR-4648) \u2014 the " +
      'two sites ask one question and must not answer it differently.\" Same two tables, same two ' +
      'arms, same reason; what differs is only the consequence of the zero-row read \u2014 the meter ' +
      'charges nobody, this REFUSES the job.',
  },
  'lib/services/fleetGithubOrgAssignmentService.ts#hasExistingHosting': {
    tables: ['github_repo', 'project_repository', 'workspace'],
    source: 'scan',
    why:
      'MOTIR-8966 — does this organisation already have a repository established in the ' +
      'fallback provisioning org? `project_repository` has no system-admin read arm, so the ' +
      'read binds the tenant in its own transaction: project_repository_org_read, the ' +
      'github_repo owner filter by github_repo_org_read, and the workspace JOIN by ' +
      'workspace_org_service_read.',
  },
  'lib/services/fleetUseCountsService.ts#memberIdsOf': {
    tables: ['organization_membership'],
    source: 'scan',
    why:
      'the per-person count of the Fleet use section (MOTIR-9660): the org`s member ids, ' +
      'read in a transaction of their own under org_membership_visible_active_or_own. The ' +
      'members` live `agent_instance` rows are counted afterwards in the census transaction ' +
      'under the system read arm, never under this bind.',
  },
  'lib/services/entitlementsService.ts#tierForOrg': {
    tables: ['organization'],
    source: 'scan',
    why: 'organization_active',
  },
  'lib/services/entitlementsService.ts#assertWithinStorageCap': {
    tables: ['attachment', 'workspace'],
    source: 'scan',
    why:
      'THE DEFECT MOTIR-2956 FIXED. `sumSizeByOrganization` is FROM "attachment" JOIN ' +
      '"workspace", and BOTH needed the arm — 20260818010000_attachment_org_service_read_arm ' +
      'adds attachment_org_service_read and workspace_org_service_read, FOR SELECT, each ' +
      'guarded on app.user_id being empty so it fires only for the userless service path.',
  },
  'lib/services/organizationRepoService.ts#listInventory': {
    tables: ['github_repo'],
    source: 'scan',
    why:
      "THE SIXTEENTH (MOTIR-4680) — the organisation Git page's one read. It COMPOSES " +
      '`listRepositoryUsage` (adjudicated below, and where the `project_repository` arm is ' +
      'accounted for) and binds the org GUC once more of its own to re-read `github_repo` for ' +
      'the row fields the usage shape does not carry. github_repo_org_read (MOTIR-4677) is the ' +
      'arm. ⚠️ The INDEX-ledger half is deliberately NOT here: `job_run` is read under ' +
      '`withSystemContext`, per workspace, because the ledger is workspace-keyed and an ' +
      "organisation is not — that is the system-context guard's axis, not this one.",
  },
  'lib/services/githubInstallationService.ts#listOrganizationInstallations': {
    tables: ['github_installation', 'github_installation_org_link', 'github_repo'],
    source: 'scan',
    why:
      'MOTIR-4836 — the ORGANISATION`s GitHub connection, for the connection card on ' +
      'Settings → Organisation → Git and for state C on Settings → Account → Git accounts. ' +
      '`github_installation` is the ONE table in this sweep that had NO org arm at all when ' +
      'its call site was written, which is why the defect could not be fixed by binding the ' +
      'GUC: measured on the live deployment, a sibling workspace of the installing one saw 0 ' +
      'installations WITH the organisation bound explicitly, and 7 of that organisation`s ' +
      'repositories in the same transaction. The MOTIR-2956 shape with the worst possible ' +
      'presentation — the zero rendered as `Connect GitHub`, an ACTION, on an account that ' +
      'is already installed. `github_installation_org_read` (20260907200000) is what admits ' +
      'it. `github_repo` is the SECOND table, reported by the scanner and not by the author: ' +
      'each installation`s repositories are read through `listByInstallation` inside the same ' +
      'org-bound transaction, so it is this site`s table too and its arm ' +
      '(`github_repo_org_read`, MOTIR-4677) is what makes the read TOTAL rather than an ' +
      'installation with an empty repo list — the arm-the-JOIN-target-too clause, arriving ' +
      'here as a second statement rather than a join. MOTIR-8223 moved the read onto the ' +
      "organisation's LINK rows (`github_installation_org_link_org_read`, MOTIR-8218), joined to " +
      'the installation (`github_installation_linked_org_read` admits one stamped with another ' +
      'linked organisation), because the stamp names only the first organisation an account ' +
      'was linked to.',
  },
  'lib/services/githubInstallationService.ts#boundInstallationRows': {
    tables: ['github_installation', 'github_installation_org_link'],
    source: 'scan',
    why:
      "MOTIR-8472 / MOTIR-8480 — the migrate wizard's connect step: is any GitHub " +
      'installation bound to the run`s organisation, and which of its repositories may the ' +
      'connect→index gate use? The same union `listOrganizationInstallations` reads (the ' +
      'installations STAMPED with the organisation, plus its `github_installation_org_link` ' +
      'rows joined to their installation), so the same arms admit it: ' +
      '`github_installation_org_read`, `github_installation_org_link_org_read` and ' +
      '`github_installation_linked_org_read`. The organisation is resolved from the actor`s ' +
      'WORKSPACE row in the same transaction, never from the request. Its caller ' +
      '`listOrganizationRepoRows` then reads `github_repo` in that org-bound transaction, which ' +
      '`github_repo_org_read` (MOTIR-4677) admits; the succeeded-index ledger it joins is ' +
      'workspace-keyed and read under the workspace context the transaction already carries.',
  },
  'lib/services/githubAccountDisconnectService.ts#loadOwnLink': {
    tables: [
      'github_installation',
      'github_installation_org_link',
      'github_repo',
      'project_repository',
    ],
    source: 'scan',
    why:
      'MOTIR-8222 — the per-organisation disconnect of one GitHub account, and its preview. ' +
      'The admin-gated, org-bound read loads the installation, THIS organisation`s link row, ' +
      'its repositories under that installation and their project links. Each answers under ' +
      'an org arm: github_installation_org_read / github_installation_linked_org_read (the ' +
      'installation may be stamped with another linked organisation), ' +
      'github_installation_org_link_org_read (MOTIR-8218), github_repo_org_read (MOTIR-4677) ' +
      'and project_repository_org_read (MOTIR-4679). Only the READ is org-bound: the clears ' +
      'are workspace-bound per affected workspace and the deletes run under the system ' +
      'context, the `disconnectFromOrganisation` split.',
  },
  'lib/services/organizationRepoService.ts#listRepositoryUsage': {
    tables: ['github_repo', 'project_repository'],
    source: 'scan',
    why:
      'THE FIFTEENTH (MOTIR-4679) — `Used by N projects`, which asks WHICH PROJECTS across the ' +
      'organisation hold each repository. Both tables answer only under an org arm: ' +
      'github_repo_org_read (MOTIR-4677) and project_repository_org_read (this card, ' +
      "20260906000000). Without the second, `project_repository`'s sole policy is " +
      '`FOR ALL USING (workspace_id = app.workspace_id)` with no system arm — so the read ' +
      'returned ZERO rows and every inventory row would have said "Used by no project yet", ' +
      'which is the MOTIR-2956 shape one table over. The PROJECT rows are read separately, ' +
      'under the system arm `project_workspace_or_system_read` already carries.',
  },
  'lib/services/organizationRepoService.ts#disconnectFromOrganisation': {
    tables: ['github_repo', 'project_repository'],
    source: 'scan',
    why:
      'TWO binds in one method — the repo lookup and the affected-links enumeration — one ' +
      'adjudication, and the same two arms as the read above. ⚠️ Only the READS are org-bound: ' +
      'the org arms are `FOR SELECT` only (permissive policies OR-combine, so widening the ' +
      'write arm would hand a sibling workspace a DELETE it never had), so the clear is one ' +
      "WORKSPACE-bound write per affected workspace. That split is the method's shape, not an " +
      'oversight.',
  },
  'lib/services/organizationRepoService.ts#inProjectOrg': {
    tables: ['github_repo'],
    source: 'hand',
    why:
      'THE FOURTEENTH (MOTIR-4678), and the walk reports NOTHING for it — the bind sits in a ' +
      'helper whose body then invokes a CALLBACK PARAMETER, so the scan sees only the ' +
      '`resolveOrganizationId -> workspaceRepository.findByIdInTx` that runs BEFORE the bind ' +
      'and steps over every statement that runs after it. Declaring `[]` would have recorded ' +
      'the blind spot as a verdict, so this is read by hand.\n\n' +
      'What the bound transaction touches: `github_repo` (listByOrganization — the org-spanning ' +
      'inventory this whole card exists for; findById / findByRepoIdAndProvider on the write ' +
      'paths), `project_repository` (listByProject, the name + claim guards, findLastPosition, ' +
      'create) and `organization_membership` (assertOrgAdmin).\n\n' +
      'ONLY `github_repo` is declared, and the reason is that `bindOrganizationContext` ADDS a ' +
      'GUC rather than replacing one: this site binds it INSIDE a `withWorkspaceContext` ' +
      'transaction, so app.user_id / app.workspace_id / app.project_id are all still set. ' +
      '`project_repository` is workspace-keyed and answers under its own arm; ' +
      '`organization_membership` answers under org_membership_visible_active_or_own, whose ' +
      'app.user_id half is bound. `github_repo` is the one read that genuinely spans the ' +
      "organisation's OTHER workspaces, and MOTIR-4677's github_repo_org_read (FOR SELECT) is " +
      'the arm that admits it — without which the picker returns a SUBSET and looks like a ' +
      'short list rather than a bug.',
  },
  'lib/services/organizationDeletionNotifier.ts#orgSnapshot': {
    tables: ['organization', 'organization_membership'],
    source: 'scan',
    why:
      'MOTIR-6395 — the deletion notices resolve the org and its roster at send time, with no ' +
      'actor: the org by id (organization_active) and every membership with its user ' +
      '(org_membership_visible_active_or_own), both admitted by the bound app.organization_id',
  },
  'lib/services/organizationErasureSweepService.ts#writeTombstone': {
    tables: [
      'organization',
      'organization_content_language_change',
      'organization_deletion_request',
      'organization_membership',
    ],
    source: 'scan',
    why:
      'MOTIR-6400 — the erasure tombstone, with no actor: it reads the org and its roster (the ' +
      'erased notice captures the Owner and Admins first), deletes every membership and (MOTIR-8094) ' +
      'the attributed content-language history, scrubs the org and marks the request erased, all ' +
      'under the bound app.organization_id',
  },
  'lib/services/organizationRetentionPurgeService.ts#runDue': {
    tables: ['organization', 'organization_deletion_request'],
    source: 'scan',
    why:
      'MOTIR-6401 — the seven-year purge, with no actor: it deletes the erased org’s deletion ' +
      'requests and then the tombstone row itself, both admitted by the bound app.organization_id',
  },
  'lib/services/workspacesService.ts#addMember': {
    tables: ['organization_membership'],
    source: 'hand',
    why:
      'the upward org auto-join INSERT, reached through `organizationsService.ensureOrgMembership` ' +
      '— a SERVICE call the walk cannot follow, so the scan reports no in-window model here. ' +
      'org_membership_insert_active_or_bootstrap admits the write; the read arm asserted below ' +
      'is org_membership_visible_active_or_own.',
  },
  'lib/services/workspacesService.ts#guard': {
    tables: ['organization_deletion_request'],
    source: 'scan',
    why:
      'MOTIR-6400 — deleteWorkspaceForOrganizationErasure’s guard binds the org read from the ' +
      'workspace row itself, then locks that org’s open deletion request to assert it is erasing',
  },
  'lib/services/workspacesService.ts#listUserWorkspaces': {
    tables: ['workspace'],
    source: 'scan',
    why:
      "MOTIR-6308 — the org Owner's switcher lists every workspace of the orgs they OWN, member " +
      'or not. Inside one `withUserContext` transaction it re-binds app.organization_id per ' +
      "owned org (the ids come from the actor's own owner rows) and reads " +
      '`workspaceRepository.listByOrganization`. workspace_org_member_read admits it: the org ' +
      'GUC just bound, and an organization_membership row for app.user_id. The two reads before ' +
      'the first bind (the actor’s workspace memberships and owner rows) run under the user ' +
      'context alone and are not org-context reads.',
  },
  'lib/services/workspacesService.ts#isEmptyOrganizationOfMember': {
    tables: ['workspace'],
    source: 'scan',
    why:
      'MOTIR-8777 — whether the org cookie names an org the user belongs to that has NO ' +
      'workspace. Inside one `withUserContext` transaction it reads the actor’s own ' +
      'organization_membership row first (user context alone), and only when that row exists ' +
      'binds app.organization_id to that org and counts its workspaces through ' +
      '`workspaceRepository.countByOrganization`. workspace_org_member_read admits it: the org ' +
      'GUC just bound, and the organization_membership row for app.user_id just read — the same ' +
      'shape as listUserWorkspaces.',
  },
  'lib/services/workspacesService.ts#isOrgManagerTarget': {
    tables: ['organization_membership', 'workspace'],
    source: 'scan',
    why:
      'MOTIR-6463 — a role change refuses a TARGET who is the org Owner or an Admin (a Manager of ' +
      "every workspace by their org role). The target's organization_membership row is another " +
      "person's, admitted only by org_membership_visible_active_or_own's active-org arm, so the " +
      "workspace's own organization (read off the workspace row, never request input) is bound " +
      "first inside the caller's withWorkspaceContext. `workspace` is admitted by workspace_active " +
      '(the workspace GUC is still bound) and by workspace_org_member_read (the actor is a ' +
      'Manager, so a member of the org in every case the check is reached).',
  },
  'lib/services/workspacesService.ts#orgManagersOf': {
    tables: ['organization', 'organization_membership'],
    source: 'scan',
    why:
      "MOTIR-6465 — the Members page draws the org's Owner and Admins locked at Manager (design " +
      "panel 6a) and names the org in their reason. Both reads are of the workspace's OWN " +
      "organization, bound off the workspace row inside the caller's withWorkspaceContext: " +
      'organization_active admits the org row, org_membership_visible_active_or_own the members.',
  },
  'lib/services/workspacesService.ts#assertMayRemoveWorkspace': {
    tables: ['organization_membership'],
    source: 'hand',
    why:
      'MOTIR-6309 — the org-Admin workspace-remove gate. It binds app.organization_id INSIDE ' +
      'a `withWorkspaceContext` transaction (so app.user_id / app.workspace_id stay set), with ' +
      "the org id read off the workspace row itself, then reads the actor's own org membership " +
      'through `assertOrgCapability` — a SERVICE call the walk cannot follow, hence `hand`. ' +
      'org_membership_visible_active_or_own admits that read on both halves (the org GUC it ' +
      'just bound, and app.user_id = the row). It performs no write of its own.',
  },
};

let rlsTables: Set<string>;
let orgArmed: Set<string>;

/**
 * The findings, given an arm set — every (site, table) pair where the table has
 * RLS, carries no arm, and nobody has adjudicated it.
 *
 * Parameterised on `armed` for the two negative proofs below, which reconstruct
 * the arm set as it stood before a migration. A guard that has never been SEEN
 * to fail is not evidence, and the cheapest honest way to see it fail is to take
 * an arm away rather than to break a call site and put it back.
 */
function findings(armed: ReadonlySet<string>): string[] {
  const { tableOf } = schemaMap();
  const out: string[] = [];
  for (const site of scanContexts(ORG_SERVICE_CONTEXT)) {
    for (const model of site.contextOnlyModels) {
      const table = tableOf.get(model);
      if (!table) {
        out.push(`${site.key} :: ${model} — no table in prisma/schema.prisma`);
        continue;
      }
      if (!rlsTables.has(table)) continue; // over-approximation; nothing to be blind to
      if (armed.has(table)) continue;
      if (DELIBERATELY_ORG_ONLY[`${site.key} :: ${model}`]) continue;
      out.push(
        `${site.key} :: ${model} -> "${table}" has RLS and NO app.organization_id read arm ` +
          `(reached via ${site.via.join(', ')})`,
      );
    }
  }
  return out;
}

// WARM THE SCANS ONCE, in a hook with its own budget — the reason every sibling
// guard gives: the compiler-API walk over `lib/` + `app/` + `tests/` is a couple
// of seconds bare, and under `vitest run --coverage` the v8 provider instruments
// it heavily enough to blow the repo's 15 s `testTimeout`, so `pnpm test` is
// green while the coverage lane is red. Both roots are warmed — the fixture tree
// is a SEPARATE cache key, on purpose, so a single unkeyed cache could never
// hand the fixture the real repo's answer.
//
// ⚠️ Do NOT "fix" a recurrence by raising `testTimeout`: that is a global knob
// and this is one expensive fixture.
beforeAll(async () => {
  scanContexts(ORG_SERVICE_CONTEXT);
  scanContexts(ORG_SERVICE_CONTEXT, 'tests/rls/__fixtures__/orgContexts');
  rlsTables = await rlsEnabledTables();
  orgArmed = await armedTables(ORG_SERVICE_CONTEXT.gucs[0]!);
}, 120_000);

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('every org-context read touches a table whose policy set reads app.organization_id', () => {
  it('has no unadjudicated (site, table) pair', () => {
    expect(
      findings(orgArmed),
      'A `withOrgServiceWriteContext` / `bindOrganizationContext` block reads a table whose ' +
        'policies do not read `app.organization_id`. Under `motir_app` that read returns ZERO ' +
        'ROWS and raises NOTHING — which is how the free-tier storage cap stopped being ' +
        'enforced without one line of code looking wrong (MOTIR-2956).\n\n' +
        'The disposition is one of three, and the FIRST is nearly always right:\n' +
        '  1. BIND THE RIGHT THING — if the table is workspace-scoped, the caller wants\n' +
        '     `withWorkspaceServiceContext` / `bindWorkspaceContext`, not the org GUC.\n' +
        '     Additive, widens nothing.\n' +
        '  2. ARM THE TABLE — ONLY when the read genuinely spans the org and there is no\n' +
        '     narrower context. `FOR SELECT` only, and guard it on `app.user_id` being\n' +
        "     EMPTY (the `coalesce(current_setting(…), '') = ''` idiom) so it fires for\n" +
        '     the userless service path and NOT for `withOrgContext`, whose readers are\n' +
        '     member-scoped by design. ⚠️ ARM EVERY TABLE THE QUERY TOUCHES, joins\n' +
        '     included — arming the FROM clause alone leaves the answer at zero, which is\n' +
        '     the fix reading as applied while changing nothing.\n' +
        '  3. ADJUDICATE it here, with the measurement and the card that owns it.\n\n' +
        'Adding an entry to DELIBERATELY_ORG_ONLY without one of the first two is how this ' +
        'class grows back.',
    ).toEqual([]);
  });

  it('has no adjudication left for a pair the scan no longer reports', () => {
    // The mirror, and the half that rots silently: an entry whose site was fixed
    // or deleted keeps a permanent "this is fine" on record for a shape nobody
    // can find any more.
    const { tableOf } = schemaMap();
    const live = new Set(
      scanContexts(ORG_SERVICE_CONTEXT).flatMap((s) =>
        s.contextOnlyModels.map((m) => `${s.key} :: ${m}`),
      ),
    );
    expect(
      Object.keys(DELIBERATELY_ORG_ONLY).filter((k) => !live.has(k)),
      'a verdict for a pair the scan no longer reports — delete it',
    ).toEqual([]);
    const wrong = Object.entries(DELIBERATELY_ORG_ONLY)
      .filter(([k, v]) => v === 'no-rls' && rlsTables.has(tableOf.get(k.split(' :: ')[1]!) ?? ''))
      .map(([k]) => k);
    expect(wrong, 'adjudicated `no-rls`, but the table has RLS enabled').toEqual([]);
  });
});

describe("MOTIR-2956's twelve-row hand sweep, re-derived on every run", () => {
  const runtimeSites = () =>
    scanContexts(ORG_SERVICE_CONTEXT).filter(
      (s) => s.file.startsWith('lib/') || s.file.startsWith('app/'),
    );

  it('every runtime call site carries a verdict — a THIRTEENTH fails here', () => {
    // The ratchet the document could not be. `docs/rls-runtime-role-inventory.md`
    // recorded twelve callers read by hand on 2026-08-17; a caller added since is
    // indistinguishable from a swept one when the record is prose.
    const unswept = [...new Set(runtimeSites().map((s) => s.key))].filter((k) => !ORG_SWEEP[k]);

    expect(
      unswept,
      'A `lib/` or `app/` caller of `withOrgServiceWriteContext` / `bindOrganizationContext` ' +
        'has no entry in ORG_SWEEP.\n\n' +
        'Read the tables its statements TOUCH — joins included — against the policies on ' +
        '`origin/main`, then add the row. This is the step MOTIR-2956 performed by hand for ' +
        'twelve callers; the whole point of this guard is that the thirteenth does not get ' +
        'to skip it.',
    ).toEqual([]);
  });

  it('no swept row survives the call site it was written for', () => {
    const live = new Set(runtimeSites().map((s) => s.key));

    expect(
      Object.keys(ORG_SWEEP).filter((k) => !live.has(k)),
      'a sweep row for a call site the scan no longer reports — the method was renamed, ' +
        'moved or deleted. Delete the row (or re-key it); a verdict nobody can locate is ' +
        'the document rotting again, one file over.',
    ).toEqual([]);
  });

  it('a `scan`-sourced row declares exactly what the scanner reports', () => {
    // What bounds the hand half. Without this, any row could quietly become
    // hand-written and the sweep would drift back into transcription.
    const { tableOf } = schemaMap();
    const byKey = new Map<string, Set<string>>();
    for (const s of runtimeSites()) {
      const set = byKey.get(s.key) ?? new Set<string>();
      for (const m of s.contextOnlyModels) set.add(tableOf.get(m) ?? m);
      byKey.set(s.key, set);
    }

    const drift = Object.entries(ORG_SWEEP)
      .filter(([, v]) => v.source === 'scan')
      .flatMap(([k, v]) => {
        const actual = [...(byKey.get(k) ?? [])].sort();
        const declared = [...v.tables].sort();
        return JSON.stringify(actual) === JSON.stringify(declared)
          ? []
          : [`${k}: declared ${JSON.stringify(declared)}, scan reports ${JSON.stringify(actual)}`];
      });

    expect(
      drift,
      'A row marked `source: "scan"` declares tables the scanner does not report. Either the ' +
        'query changed (update the row) or the walk lost sight of it — and the second is the ' +
        'dangerous one, because a shrinking `tables` list reads exactly like a simplified ' +
        'query. If the walk genuinely cannot see it, mark the row `hand` and say what was ' +
        'read, so the gap is visible instead of absorbed.',
    ).toEqual([]);
  });

  it('every table in the sweep carries an org read arm — the twelve verdicts, re-checked', () => {
    // This is what the document could only assert once. Every ✓ in its table is
    // re-measured against `pg_policies` on every run, so an arm dropped by a
    // later migration turns this red rather than turning a cap off.
    const missing = Object.entries(ORG_SWEEP).flatMap(([key, v]) =>
      v.tables.filter((t) => rlsTables.has(t) && !orgArmed.has(t)).map((t) => `${key} :: "${t}"`),
    );

    expect(
      missing,
      'A table MOTIR-2956 recorded as org-armed no longer carries a permissive SELECT/ALL ' +
        'policy reading `app.organization_id`. Under `motir_app` that caller now reads zero ' +
        'rows and raises nothing.',
    ).toEqual([]);
  });
});

describe('the guard has been SEEN to fail', () => {
  // A guard that has never fired is a guard nobody has evidence for. Both proofs
  // take an ARM AWAY rather than breaking a call site, because the arm set is
  // data and the call sites are the thing under test — and because the two
  // policies below are exactly the ones MOTIR-2956 had to add, so removing them
  // reconstructs the tree as it stood at the defect.

  it('the JOIN target is adjudicated too, not just the FROM clause', async () => {
    // ⚠️ `notes.html` #269, proven rather than asserted. `sumSizeByOrganization`
    // is `FROM "attachment" JOIN "workspace"`. Keep `attachment`'s arm and take
    // `workspace`'s away — the FROM clause armed, the JOIN target not — and the
    // guard must still report the site. An arm inventory that only described the
    // FROM clause would call this healthy, which is precisely how the fix could
    // have shipped while the sum stayed at zero.
    // ⚠️ TWO policy names, not one, since MOTIR-3512. Reconstructing "the arm
    // set as it stood before that migration" means removing EVERY org arm
    // `workspace` has acquired since, and it now has two:
    // `workspace_org_service_read` (userless, MOTIR-2956) and
    // `workspace_org_member_read` (user-bound, MOTIR-3512). Excluding only the
    // first leaves the table armed and the control proves nothing — which is
    // the control working, not a reason to weaken it.
    const withoutJoinArm = await armedTables(ORG_SERVICE_CONTEXT.gucs[0]!, [
      'workspace_org_service_read',
      'workspace_org_member_read',
    ]);
    expect(withoutJoinArm.has('attachment'), 'the FROM clause is still armed').toBe(true);
    expect(withoutJoinArm.has('workspace'), 'the JOIN target is not').toBe(false);

    // ⚠️ SIX members since MOTIR-8966 (five since MOTIR-8777, four since MOTIR-6308, three since MOTIR-4839), not one. The control removes `workspace`'s
    // org arms wholesale, so it reports every swept site that reaches that table
    // under the org context — and CI attribution now does, at both of its sites,
    // for the tenancy reason their sweep entries carry. Their presence here is the
    // control working: it is the same proof for them as for the storage cap, that
    // the JOIN target is adjudicated and not just the FROM clause.
    expect(findings(withoutJoinArm)).toEqual([
      'lib/services/ciMinutesMeterService.ts#meterWorkflowRun :: workspace -> "workspace" ' +
        'has RLS and NO app.organization_id read arm ' +
        '(reached via projectRepoRepository.listByGithubRepoId, workspaceRepository.findByIdInTx)',
      'lib/services/ciRunnerProvisioningService.ts#recordQueuedJob :: workspace -> "workspace" ' +
        'has RLS and NO app.organization_id read arm ' +
        '(reached via projectRepoRepository.listByGithubRepoId, workspaceRepository.findByIdInTx)',
      'lib/services/entitlementsService.ts#assertWithinStorageCap :: workspace -> "workspace" ' +
        'has RLS and NO app.organization_id read arm ' +
        '(reached via attachmentRepository.sumSizeByOrganization)',
      'lib/services/fleetGithubOrgAssignmentService.ts#hasExistingHosting :: workspace -> "workspace" ' +
        'has RLS and NO app.organization_id read arm ' +
        '(reached via projectRepoRepository.hasEstablishedHostedRepoForOrganizationInTx)',
      'lib/services/workspacesService.ts#isOrgManagerTarget :: workspace -> "workspace" ' +
        'has RLS and NO app.organization_id read arm ' +
        '(reached via organizationMembershipRepository.isOrgManagerOfWorkspaceOrg)',
      'lib/services/workspacesService.ts#isEmptyOrganizationOfMember :: workspace -> "workspace" ' +
        'has RLS and NO app.organization_id read arm ' +
        '(reached via organizationMembershipRepository.findByOrgAndUserInTx, ' +
        'workspaceRepository.countByOrganization)',
      'lib/services/workspacesService.ts#listUserWorkspaces :: workspace -> "workspace" ' +
        'has RLS and NO app.organization_id read arm ' +
        '(reached via organizationMembershipRepository.findManagedOrganizationsByUser, ' +
        'workspaceMembershipRepository.findWorkspacesByUser, workspaceRepository.listByOrganization)',
    ]);
  });

  it('a swept call site whose table loses its arm is reported', async () => {
    // The synthetic regression on a site that is NOT the known defect, so the
    // proof is about the mechanism rather than about one query.
    // `ci_period_charge_org_or_system` is the arm three `ciAllowanceService`
    // binds and one test file rely on; without it every one of them is blind.
    const withoutChargeArm = await armedTables(ORG_SERVICE_CONTEXT.gucs[0]!, [
      'ci_period_charge_org_or_system',
    ]);
    const reported = findings(withoutChargeArm).filter((f) => f.includes('ci_period_charge'));

    expect(reported.length).toBeGreaterThan(0);
    expect(
      reported.some((f) => f.startsWith('lib/services/ciAllowanceService.ts#chargeForMeteredRun')),
      'the metered-charge caller goes blind and is named',
    ).toBe(true);
  });
});

describe('the descriptor itself', () => {
  it('rules correctly on a fixture carrying every verdict', () => {
    // THE NEGATIVE CASE, as a permanent test rather than a one-off check, and run
    // against a fixture ROOT so proving the detector works can never leave a stray
    // unbound org context in a real service.
    const root = 'tests/rls/__fixtures__/orgContexts';
    const byEnclosing = new Map(
      scanContexts(ORG_SERVICE_CONTEXT, root).map((s) => [s.enclosing, s]),
    );
    const site = (fn: string) => byEnclosing.get(fn);

    // Pinned INDIVIDUALLY. One `toEqual` over the set would pass for the wrong
    // reason the day the scan returns nothing at all.
    expect(site('orgOnlyRead')?.verdict, 'a plain gated read under the org binding').toBe(
      'context-only',
    );

    // ⚠️ THE JOIN CASE — the shape an arm inventory clears and the query does not.
    expect(site('orgJoinedRead')?.contextOnlyModels, 'an `include` is a join').toEqual([
      'gadget',
      'widget',
    ]);

    expect(site('orgNonGated')?.verdict).toBe('no-gated-statement');
    expect(site('orgViaHelper')?.verdict, 'one hop into a forwarding helper').toBe('context-only');

    // ⚠️ THE `bind` ENTRY'S WINDOW, pinned from BOTH sides — the half that is new
    // in this descriptor. A `bind` binds on an already-open transaction, so its
    // window opens AT THE CALL and runs to the end of the enclosing function:
    // the read above it belongs to the enclosing context, the read below it to
    // this one. A window that opened at the top of the block would report
    // `gadget` as org-bound when the GUC was not yet set — a claim in the
    // dangerous direction, because it reads as coverage.
    expect(
      site('bindsMidBlock')?.contextOnlyModels,
      'only the read AFTER the bind is under `app.organization_id`',
    ).toEqual(['widget']);
    expect(
      site('bindsMidBlock')?.models,
      'and the read before it is still SEEN — reported, just not in the window',
    ).toEqual(['gadget', 'widget']);
    expect(site('bindsAfterEveryRead')?.verdict, 'every gated read sits above the bind').toBe(
      'narrowed',
    );
    expect(site('bindsAfterEveryRead')?.contextOnlyModels).toEqual([]);

    // A user-bound org context is a DIFFERENT descriptor, so it is not reported —
    // the boundary MOTIR-2956 drew, made structural.
    expect(
      byEnclosing.has('orgUserRead'),
      'withOrgContext binds a user too and is `ORG_USER_CONTEXT`',
    ).toBe(false);

    // THE WALL (MOTIR-2910), under a `bind` entry this time.
    expect(
      site('bindsThenUnresolved')?.unresolvedCalls,
      'a tx passed to a callback parameter must be REPORTED, not stepped over',
    ).toEqual(['resolveContext']);
  });

  it('actually finds the sites it is pointed at (a live negative)', () => {
    // A scanner that silently returns nothing passes forever. Pin that it walks
    // the real tree, resolves the schema, and classifies in more than one
    // direction. The floor is an order of magnitude below the population (31 at
    // `7de5856f`) so ordinary movement cannot reach it.
    const all = scanContexts(ORG_SERVICE_CONTEXT);
    expect(all.length).toBeGreaterThan(15);
    expect(contextOnlyReads(ORG_SERVICE_CONTEXT).length).toBeGreaterThan(10);
    expect(all.some((s) => s.verdict === 'narrowed')).toBe(true);
    // Every reported site names a real file and a real enclosing function.
    expect(all.filter((s) => s.enclosing === '<module>')).toEqual([]);
  });
});
