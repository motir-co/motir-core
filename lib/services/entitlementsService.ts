import type { Prisma } from '@/generated/prisma/client';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { withUserContext } from '@/lib/workspaces/context';
import { isCloudBilling } from '@/lib/billing/availability';
import { entitlementsFor, pmTierForOrg, type PmTier } from '@/lib/billing/entitlements';
import { CapLockUnavailableError, EntitlementExceededError } from '@/lib/billing/errors';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';

// The §4 PM-core entitlement-cap ENFORCEMENT service (Story 8.1.11) — the
// gating + counting half (the pure tier→limits policy is `lib/billing/
// entitlements.ts`). It is called by the create paths (work item / project /
// workspace / org) and the upload path, and is INERT off-cloud: every method
// returns early when `isCloudBilling()` is false, so a self-hosted (GPL-3.0)
// build has every cap lifted (ADR §6 — billing + caps are cloud-only).
//
// ── How a cap is enforced (the warm-pool TOCTOU contract) ──────────────────
// A cap is a read-then-write guard: count, compare, then create. Two concurrent
// creates with no shared lock both observe `count = limit - 1`, both pass, and
// both insert → an off-by-one overage (warm-pool TOCTOU, CLAUDE.md §
// lock-before-read-derived). So every count-cap LOCKS THE ORG ROW `FOR UPDATE`
// first (`organizationRepository.lockByIdForUpdate`) — the single shared row all
// of an org's creates contend on — then counts under the lock. The second racer
// blocks until the first commits, re-counts, and correctly sees the limit. The
// caller MUST run the assert INSIDE the same transaction as the create it guards.
//
// ⚠️ AND §4.5 IS NOT A COUNT CAP — IT LOCKS THE ACTOR, NOT AN ORG (MOTIR-3717).
// The paragraph above says "every count-cap locks the ORG ROW", and the
// org-CREATION gate is the one member of this file that is not a count cap over
// an org. It counts the ACTOR's owner/admin orgs, and the window it fails in is
// the one where that set is EMPTY — the first org, which every account passes
// through exactly once, on signup, at the moment a person is most likely to
// double-submit. `SELECT … FOR UPDATE` over zero rows locks nothing, so the
// symmetric repair does not transfer: §4.5 anchors on the actor's `user` row
// instead (`lockActorRowOrRefuse`), which exists before their first org does.
// Reading "every cap locks the org row" as covering §4.5 is how it went
// unserialized past MOTIR-3710's sweep of its three siblings.
//
// ⚠️ AND THE LOCK'S RESULT IS READ — `lockOrgRowOrRefuse`, NOT a bare call
// (MOTIR-3710). The paragraph above described a contract this file did not
// enforce: `lockByIdForUpdate` matched ZERO rows under `withWorkspaceContext`
// (the `organization` UPDATE policy reads `app.organization_id`, which that
// context never bound), returned `false` to say exactly that, and NOBODY READ
// IT. Every racer fell through together and the guard degraded to a plain
// read-then-write — while every signal reported success: this comment, a
// dedicated real-concurrency test, three RLS scanners. Two things changed and
// BOTH are load-bearing: the repository now binds the GUC that admits the row,
// and every cap here REFUSES when the lock matched nothing. A cap that cannot
// serialize is not a cap.
//
// ── How an org's tier is resolved ──────────────────────────────────────────
// `pmTierForOrg` resolves from the org's full cap context: the META org
// (`Organization.isMeta` — moooon B.V.) short-circuits to the internal `meta`
// tier (every cap lifted); any other org keys off `scaledTrackerSubscription`
// (§4 — NOT the AI PlanTier): an ACTIVE subscription is `scaled` (caps lifted),
// anything else is `free`. A missing/hidden org collapses to `free` (safe
// default: caps apply). Resolving here means every cap below — and any future
// cap — honours the meta exemption through this one chokepoint.

/**
 * Take the org-row lock the count caps serialize on, and REFUSE if it matched
 * nothing (MOTIR-3710). `lockByIdForUpdate` has always returned whether it
 * locked a row; this is the caller that reads it.
 *
 * `false` means one of two things and neither is survivable for a cap: the org
 * row is gone, or this transaction's context cannot be admitted to lock it. In
 * both, the `count → compare → create` below would run UNSERIALIZED, which is a
 * revenue control failing open with no error, no log line and no metric. Throw
 * instead — a 500 on one create is a bad minute; a free org quietly past its
 * ceiling is a bad quarter nobody measures.
 */
async function lockOrgRowOrRefuse(
  organizationId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (!(await organizationRepository.lockByIdForUpdate(organizationId, tx))) {
    throw new CapLockUnavailableError('organization', organizationId);
  }
}

/**
 * Take the ACTOR-row lock the §4.5 org-creation gate serializes on, and REFUSE
 * if it matched nothing (MOTIR-3717).
 *
 * ⚠️ WHY A DIFFERENT ANCHOR, AND WHY `lockOrgRowOrRefuse` CANNOT BE REUSED. The
 * three count caps above lock the `organization` row because that is the single
 * shared row all of one org's creates contend on. §4.5 has no such row: it
 * counts the ACTOR's owner/admin memberships, and the bypass window is exactly
 * the one where that set is EMPTY (`orgs.length === 0`, the always-free first
 * org). You cannot lock a set that has no rows — every racer falls through the
 * predicate together — so the anchor has to be a row that EXISTS before the
 * first organization does. The actor's own `user` row is that row, and it is
 * already the row `workspacesService.ensureDefaultWorkspace` serializes its
 * zero-membership check-then-create on (Story 1.2.4); this gate is the sibling
 * that never did.
 *
 * ⚠️ AND THE CONTEXT ADMITS IT, MEASURED RATHER THAN ASSUMED. MOTIR-3710's
 * finding is that Postgres applies the UPDATE policy's `USING` clause to a
 * `SELECT … FOR UPDATE` and filters non-qualifying rows out SILENTLY, so a
 * readable row can be unlockable. It does not bite here: `user` has RLS
 * DISABLED (`relrowsecurity = false`), so no policy can filter this lock. That
 * is a fact about the deployed schema, not about this code, which is why
 * `tests/entitlementsService.test.ts` re-measures it on every run inside the
 * gate's own bootstrap context rather than reading it off a migration.
 *
 * `null` means the user row is gone — the actor was deleted mid-transaction —
 * and a gate that cannot serialize must refuse rather than admit.
 */
async function lockActorRowOrRefuse(
  actorUserId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if ((await userRepository.lockById(actorUserId, tx)) === null) {
    throw new CapLockUnavailableError('user', actorUserId);
  }
}

async function tierForOrgInTx(
  organizationId: string,
  tx: Prisma.TransactionClient,
): Promise<PmTier> {
  return pmTierForOrg(await organizationRepository.findCapContextInTx(organizationId, tx));
}

async function tierForOrg(organizationId: string): Promise<PmTier> {
  // ⚠️ A GATE, not a list, and the ORG tier rather than the workspace one:
  // `organization_active` keys on `app.organization_id`. Unbound the row was
  // invisible and `pmTierForOrg` fell through to its default tier — so the cap
  // decision was made on missing context rather than refused. `withOrgServiceWriteContext`
  // is the userless org binding (this helper takes no actor).
  const context = await withOrgServiceWriteContext(organizationId, (tx) =>
    organizationRepository.findCapContext(organizationId, tx),
  );
  return pmTierForOrg(context);
}

function isScaledActive(sub: ScaledTrackerSubscription | null): boolean {
  return sub?.status === 'active';
}

/**
 * The §4.5 org-creation predicate over the orgs a user owns or admins. None ⇒
 * the first org, always free. Otherwise one of them must be scaled-active OR the
 * META org (moooon B.V.) — meta is treated as paid so its owners and admins can
 * freely spin up orgs/workspaces. The exemption is documented intent, so
 * MOTIR-8779 kept it and pinned it with a test; lifting it is the owner's call.
 */
function organizationCreationAllowed(
  orgs: ReadonlyArray<{ scaledTrackerSubscription: Prisma.JsonValue | null; isMeta: boolean }>,
): boolean {
  if (orgs.length === 0) return true;
  return orgs.some(
    (o) =>
      o.isMeta ||
      isScaledActive((o.scaledTrackerSubscription as ScaledTrackerSubscription | null) ?? null),
  );
}

export const entitlementsService = {
  /**
   * §4.1 — block the create of a work item that would push the org past its
   * work-item cap. Counts ALL work items in the org (archived AND active — §4:
   * archiving does NOT free room). MUST be called inside the create transaction,
   * before `workItemRepository.create`, so the org lock serializes concurrent
   * creates (the required real-concurrency contract).
   */
  async assertWithinWorkItemCap(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!isCloudBilling()) return;
    await lockOrgRowOrRefuse(organizationId, tx);
    const { maxWorkItems } = entitlementsFor(await tierForOrgInTx(organizationId, tx));
    if (maxWorkItems === null) return;
    const current = await workItemRepository.countByOrganization(organizationId, tx);
    if (current >= maxWorkItems) {
      throw new EntitlementExceededError('work_items', { limit: maxWorkItems, usage: current });
    }
  },

  /** §4.2 — block the create of a project past the org's project cap. */
  async assertWithinProjectCap(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!isCloudBilling()) return;
    await lockOrgRowOrRefuse(organizationId, tx);
    const { maxProjects } = entitlementsFor(await tierForOrgInTx(organizationId, tx));
    if (maxProjects === null) return;
    const current = await projectRepository.countByOrganization(organizationId, tx);
    if (current >= maxProjects) {
      throw new EntitlementExceededError('projects', { limit: maxProjects, usage: current });
    }
  },

  /**
   * Block the create of a CUSTOM DOMAIN past the org's cap (Story MOTIR-3878 ·
   * `docs/decisions/public-tenant-addresses.md` §9).
   *
   * ⚠️ THE CALLER MUST RUN THIS INSIDE THE SAME TRANSACTION AS THE CREATE IT
   * GUARDS — the same contract every sibling cap states, and for the same
   * reason: the org row is locked here, and a lock released before the write it
   * protects is not a lock. The lifecycle service (MOTIR-4216) is that caller.
   *
   * The TENANT SUBDOMAIN is not capped and never reaches this method: it is free
   * on every tier (§9), so gating it here would be a cap the ADR does not have.
   *
   * `free: 0` means this refuses the FIRST domain rather than the sixth, which
   * is deliberate — it makes `EntitlementExceededError('custom_domains', …)` the
   * upgrade prompt's trigger instead of an empty state the pane special-cases.
   */
  async assertCanAddCustomDomain(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!isCloudBilling()) return;
    await lockOrgRowOrRefuse(organizationId, tx);
    const { maxCustomDomains } = entitlementsFor(await tierForOrgInTx(organizationId, tx));
    if (maxCustomDomains === null) return;
    const current = await publicAddressRepository.countCustomDomainsByOrganization(
      organizationId,
      tx,
    );
    if (current >= maxCustomDomains) {
      throw new EntitlementExceededError('custom_domains', {
        limit: maxCustomDomains,
        usage: current,
      });
    }
  },

  /**
   * How many customer domains the org's tier allows — `null` when there is no
   * cap (an unlimited tier, or a build without cloud billing, where
   * {@link assertCanAddCustomDomain} never refuses). A READ for the Custom
   * domains pane (MOTIR-9529), so it can show the upsell and the `N of M` count
   * before a click. Advice only: the add still runs the locked assert.
   */
  async customDomainCap(organizationId: string): Promise<number | null> {
    if (!isCloudBilling()) return null;
    return entitlementsFor(await tierForOrg(organizationId)).maxCustomDomains;
  },

  /** §4.4 — block the create of a workspace past the org's workspace cap. */
  async assertWithinWorkspaceCap(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!isCloudBilling()) return;
    await lockOrgRowOrRefuse(organizationId, tx);
    const { maxWorkspaces } = entitlementsFor(await tierForOrgInTx(organizationId, tx));
    if (maxWorkspaces === null) return;
    const current = await workspaceRepository.countByOrganization(organizationId, tx);
    if (current >= maxWorkspaces) {
      throw new EntitlementExceededError('workspaces', { limit: maxWorkspaces, usage: current });
    }
  },

  /**
   * §4.5 — the org-CREATION gate. A user's FIRST org is always free (they
   * own/admin none yet). Creating a 2nd+ org requires the user to own/admin ≥1
   * org with an ACTIVE scaled-tracker subscription — otherwise a free account
   * could spin up N free orgs to dodge the per-org caps. Called inside the create
   * tx (covers both `organizationsService.createOrganization` AND the
   * mint-own-org branch of `workspacesService.insertWorkspaceWithOwner`).
   *
   * MUST be called inside the create transaction: the ACTOR-row lock it takes
   * first is what serializes two concurrent creates, and it only serializes them
   * for as long as that transaction is open (MOTIR-3717).
   */
  async assertCanCreateOrganization(
    actorUserId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (!isCloudBilling()) return;
    // ⚠️ SERIALIZE FIRST — the count below is read-derived and the create it
    // guards happens in this same transaction. Without the lock two concurrent
    // FIRST creates both read `orgs.length === 0`, both take the always-free
    // early return, and one account ends up holding two free-tier allowances
    // (MOTIR-3717).
    await lockActorRowOrRefuse(actorUserId, tx);
    const orgs = await organizationMembershipRepository.findOwnerAdminOrgsWithSubscription(
      actorUserId,
      tx,
    );
    if (!organizationCreationAllowed(orgs)) {
      throw new EntitlementExceededError('organizations', { limit: orgs.length });
    }
  },

  /**
   * §4.5, READ-ONLY — would `assertCanCreateOrganization` let this account
   * create an organization right now? The shell asks this to decide whether the
   * org menu offers "Create organization" (MOTIR-8779). It used to infer the
   * answer from how many orgs the account BELONGS to (the row only appeared at
   * ≥2), so an invited Member of one org — who owns none and is therefore
   * entitled to their first one free — had no door to it at all.
   *
   * The SAME predicate the gate applies, over the same read, so the menu and the
   * create cannot disagree about who may create. It takes no lock: it answers a
   * render, and the create re-asks under the actor-row lock (MOTIR-3717), so a
   * stale `true` costs a typed refusal, never a second free org.
   */
  async canCreateOrganization(actorUserId: string): Promise<boolean> {
    if (!isCloudBilling()) return true;
    const orgs = await withUserContext(actorUserId, (tx) =>
      organizationMembershipRepository.findOwnerAdminOrgsWithSubscription(actorUserId, tx),
    );
    return organizationCreationAllowed(orgs);
  },

  /**
   * §4.3a — the tier-derived PER-FILE upload limit in bytes. The 10 MB per-file
   * size is an OPERATIONAL BASELINE on EVERY build (it predates billing —
   * Subtask 2.3.7, `MAX_UPLOAD_BYTES`); what §4 adds on cloud is the SCALED
   * UPGRADE to 100 MB. So off-cloud (and on cloud `free`) this is the 10 MB
   * baseline; a cloud `scaled` org gets 100 MB. (Distinct from the count +
   * total-storage caps, which are purely commercial and FULLY lifted off-cloud.)
   * A read-only path (no create tx); resolves the org's tier via the db singleton.
   */
  async resolvePerFileLimitBytes(organizationId: string): Promise<number> {
    if (!isCloudBilling()) return entitlementsFor('free').maxUploadBytes;
    return entitlementsFor(await tierForOrg(organizationId)).maxUploadBytes;
  },

  /**
   * §4.3b — block an upload that would push the org past its TOTAL storage cap
   * (free 2 GB / scaled 100 GB). Sums `Attachment.sizeBytes` across the org and
   * rejects when `current + incoming > limit`. No FOR UPDATE — §4: a single-file
   * race overage is benign (storage, not money). Read-only path (no create tx).
   */
  async assertWithinStorageCap(organizationId: string, incomingBytes: number): Promise<void> {
    if (!isCloudBilling()) return;
    const { maxTotalStorageBytes } = entitlementsFor(await tierForOrg(organizationId));
    if (maxTotalStorageBytes === null) return;
    // Bound to the ORG (MOTIR-2846, CORRECTED by MOTIR-2956). Unbound the sum
    // is 0 and this cap silently stops enforcing — that hazard was named right
    // and then not avoided, because the binding named a GUC the tables do not
    // read. `attachment_workspace_or_system_admin` has two arms, `app.workspace_id`
    // and `app.system_admin`; the ORG arms this call needs did not exist until
    // 20260818010000_attachment_org_service_read_arm added them — one on
    // `attachment` AND one on `workspace`, because the sum JOINs both and a read
    // is admitted only if EVERY table it touches is (`notes.html` #269).
    //
    // Both arms require `app.user_id` to be UNSET, which is exactly what this
    // userless helper binds; do not swap it for `withOrgContext` (which binds an
    // acting user) or the arms stop firing and the sum silently returns to 0.
    const current = await withOrgServiceWriteContext(organizationId, (tx) =>
      attachmentRepository.sumSizeByOrganization(organizationId, tx),
    );
    if (current + incomingBytes > maxTotalStorageBytes) {
      throw new EntitlementExceededError('storage', {
        limit: maxTotalStorageBytes,
        usage: current,
      });
    }
  },
};
