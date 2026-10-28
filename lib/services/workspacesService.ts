import { assertOrgNotClosing } from '@/lib/organizations/closingGuard';
import {
  OrganizationNotErasingError,
  OrganizationSuspendedError,
} from '@/lib/organizations/errors';
import { organizationDeletionRequestRepository } from '@/lib/repositories/organizationDeletionRequestRepository';
import { Prisma, type Workspace, type WorkspaceMembership } from '@/generated/prisma/client';
import type { Locale } from '@/lib/i18n/locales';
import { db } from '@/lib/db';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { publicHostnameReservationRepository } from '@/lib/repositories/publicHostnameReservationRepository';
import {
  hostnameReservationHash,
  reservesItsHostname,
} from '@/lib/publicAddresses/hostnameReservation';
import { addDays, QUARANTINE_DAYS } from '@/lib/publicAddresses/nameHold';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import {
  bindWorkspaceContext,
  withUserContext,
  withWorkspaceContext,
  type TransactionBudget,
} from '@/lib/workspaces/context';
import { composeOwnerReach, readMembership, readReachRole } from '@/lib/workspaces/membershipGate';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { bindOrganizationContext, withOrgContext } from '@/lib/organizations/context';
import { assertOrgCapability } from '@/lib/services/organizationAccessService';
import {
  CUSTOM_WORKSPACE_ROLE_TIER,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from '@/lib/workspaces/roles';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { organizationsService } from '@/lib/services/organizationsService';
import { entitlementsService } from '@/lib/services/entitlementsService';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import { enqueueScaledTrackerSeatSync } from '@/lib/billing/seatSync';
import {
  AccessScopeForbiddenError,
  AlreadyMemberError,
  InvalidAccessScopeError,
  InvalidWorkspaceRoleError,
  LastManagerError,
  LastMemberError,
  NotAMemberError,
  OrgManagedWorkspaceRoleError,
  ScopeNotApplicableError,
  SlugCollisionError,
  WorkspaceMemberNotFoundError,
  WorkspaceNotFoundError,
  WorkspaceNotSoleMemberError,
  WorkspaceRoleForbiddenError,
} from '@/lib/workspaces/errors';
import { RoleDefinitionNotFoundError } from '@/lib/permissions/errors';
import { workspaceRoleDefinitionRepository } from '@/lib/repositories/workspaceRoleDefinitionRepository';
import {
  toCurrentWorkspaceDTO,
  toWorkspaceMemberWithAccessDTO,
  toWorkspaceSummaryDTO,
} from '@/lib/mappers/workspaceMappers';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { asAccessScope } from '@/lib/projects/accessMode';
import type {
  CurrentWorkspaceDTO,
  OrgWorkspacePageDTO,
  OrgWorkspaceRowDTO,
  MemberAddedProjectDTO,
  MemberRoleContextDTO,
  WorkspaceMemberAccessScopeDTO,
  WorkspaceMemberRoleDTO,
  WorkspaceMemberWithAccessDTO,
  WorkspaceSummaryDTO,
} from '@/lib/dto/workspaces';

/** The org Workspaces section's page size (the members roster's, MOTIR-6304). */
const ORG_WORKSPACES_DEFAULT_LIMIT = 10;
const ORG_WORKSPACES_MAX_LIMIT = 100;

// Workspaces service — business logic for the Workspace and
// WorkspaceMembership entities.
//
// `createWorkspace` is the canonical multi-row write: it inserts a
// Workspace AND an owner WorkspaceMembership atomically, and retries on
// slug collisions. `addMember` / `removeMember` / `leaveWorkspace` exist so the invite
// flow (workspaceInvitesService) and the settings UI (1.2.6) have a
// single business-logic entry point instead of poking the membership
// repo directly.
//
// `ensureDefaultWorkspace` (Subtask 1.2.4) is the self-heal backstop for
// the auto-create-on-signup flow: the Better-Auth signup hook is
// best-effort (it runs AFTER the user-insert transaction commits — see
// lib/auth/index.ts), so a signed-in user can transiently have zero
// workspaces. The workspace-context resolver calls this on a zero-
// membership read; it is idempotent and concurrency-safe.
//
// The 1.2.6 settings surface adds `renameWorkspace`, `listMembers`, and
// `getWorkspaceSummary`, plus a last-member guard on Leave and Remove (Remove is
// Manager-gated since MOTIR-6317). Removing a
// workspace is an org-Admin act since MOTIR-6309 (`removeWorkspaceAsOrgAdmin`),
// with account erasure's own entry beside it (`deleteWorkspaceForErasure`). Those workspace-scoped operations run inside
// withWorkspaceContext so the workspace / workspace_membership RLS
// policies see the per-transaction GUCs (app.user_id / app.workspace_id).

const SLUG_MAX_LENGTH = 60;
const SLUG_SUFFIX_LENGTH = 4;
const SLUG_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SLUG_RETRY_ATTEMPTS = 3;

/**
 * The budget the active-WORKSPACE resolver runs under (MOTIR-6253) — raised
 * from Prisma's 5000 ms default because of what the transaction WAITS for,
 * never because of what it does. The same argument as the 2FA gate's
 * `TWO_FACTOR_GATE_TX` (MOTIR-5866) and the active-project resolver's
 * `ACTIVE_PROJECT_RESOLVE_TX` (MOTIR-6254), on the door in front of both:
 * `getWorkspaceContext` runs this for every signed-in page, action and route.
 *
 * It does almost nothing: one `set_config`, then a handful of indexed reads —
 * the cookie-pinned membership, the last-active pointer, the first membership,
 * and the org access gate's three reads for whichever candidate wins. It writes
 * nothing and takes NO lock at all. Production still expired it — four events
 * between 2026-08-30 and 2026-09-24 on `GET /api/workbench/stream`, and the one
 * whose evidence was stored reads *5000 ms, however 30459 ms passed*, refused at
 * the access gate's first read. So the statement BEFORE it had returned ~30 s
 * late, behind a lock or a stall no transaction this small can cause or avoid.
 *
 * ⚠️ THE DEFAULT NEVER SHORTENED THAT WAIT. Prisma does not cancel the statement
 * in flight when the timer fires; it refuses the next statement after the one in
 * flight returns. So the request waited the full 30 s and THEN answered 500. The
 * 5 s default exists to bound how long a transaction holds LOCKS, and this one
 * holds none, so a longer ceiling lengthens nothing but the wait itself.
 *
 * ⚠️ AND IT IS 60 s, NOT THE SIBLINGS' 30 s, BECAUSE THE OBSERVED WAIT WAS OVER
 * 30 s. The two sibling doors sized their ceiling at more than half again their
 * own observed waits (17.7 s, 6.4 s); 30 s here would have failed the one event
 * this budget exists for. 60 s is about twice it. `maxWaitMs` stays Prisma's
 * default — this is about a transaction that STARTED and then waited, not about
 * waiting for a connection to start one.
 */
export const ACTIVE_WORKSPACE_RESOLVE_TX: TransactionBudget = {
  timeoutMs: 60_000,
  maxWaitMs: 2_000,
};

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH);
  return slug || 'workspace';
}

function randomSuffix(): string {
  let out = '';
  for (let i = 0; i < SLUG_SUFFIX_LENGTH; i++) {
    out += SLUG_SUFFIX_ALPHABET[Math.floor(Math.random() * SLUG_SUFFIX_ALPHABET.length)];
  }
  return out;
}

function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// Insert a Workspace + its owner WorkspaceMembership through the given
// transaction client. The slug-collision retry loop lives in the callers
// (each retry needs a FRESH transaction — a P2002 poisons the current one,
// so we can't just catch-and-continue inside a single `tx`).
async function insertWorkspaceWithOwner(
  input: {
    name: string;
    slug: string;
    ownerUserId: string;
    organizationId?: string;
    contentLanguage?: Locale;
  },
  tx: Prisma.TransactionClient,
): Promise<{ workspace: Workspace; membership: WorkspaceMembership }> {
  // Bind the TENANT-BOOTSTRAP context (MOTIR-2512). This is the one write path
  // that establishes a tenant rather than acting inside one, so it cannot use
  // withWorkspaceContext — there is no workspace to bind yet. Under the
  // non-bypass runtime role every statement below is refused without these:
  // the four tenant-root tables have RLS enabled, and until
  // 20260810001000_tenant_root_insert_policies they had no policy admitting
  // INSERT at all.
  //
  // Why the SLUG and not the id: `@default(cuid())` is generated by Prisma, so
  // the row's id does not exist until the INSERT runs. The slug is chosen by
  // the caller, is globally unique on both tenant-root tables, and is therefore
  // the only handle available BEFORE the statement — which is what the
  // bootstrap policies key on, for INSERT and for the SELECT that RETURNING
  // performs.
  //
  // Set per-transaction (`set_config(..., true)`), so it dies with the
  // transaction and cannot leak into the connection's next use. The caller's
  // slug-retry loop opens a FRESH transaction per attempt, which is why this
  // binding lives inside the function rather than around it: each retry rebinds
  // to the slug it is actually attempting.
  await tx.$executeRaw`SELECT set_config('app.user_id', ${input.ownerUserId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.bootstrap_slug', ${input.slug}, true)`;
  if (input.organizationId) {
    // The nest-under-an-existing-org path also READS that org (the workspace
    // cap, the membership check), so it needs the ordinary org context too.
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${input.organizationId}, true)`;
  }

  // Story 6.10: every workspace lives under an Organization (the root tenancy
  // tier — Workspace.organizationId is non-nullable). Two creation shapes:
  //
  //   * 2nd+ workspace under an ACTIVE org (organizationId provided, 6.10.4) —
  //     the workspace nests under the existing org. Only an org Owner or Admin
  //     may do this (MOTIR-6309), so the creator is always already an org
  //     member and the upward invariant (6.10.2 §5i) holds without a join.
  //   * a brand-new account / first workspace (no organizationId) — mints its
  //     OWN default org with the creator as org owner (an org of one / OPC),
  //     the same one-org-per-workspace shape the 6.10.3 migration backfill gives
  //     every pre-existing workspace. The org reuses the workspace's name +
  //     globally-unique slug; the caller's slug-retry loop covers an org.slug
  //     collision exactly as it covers a workspace.slug one.
  //
  // (The copy-on-create config CLONE — making a 2nd workspace open already
  // configured like the source — is its own subtask, 6.10.9, layered on top of
  // this org-aware path; not done here.)
  let organizationId = input.organizationId;
  if (organizationId) {
    // Creating a workspace in an EXISTING organization is an org-Admin act
    // (MOTIR-6309; `role-model.md` §1): the creator must hold `manageWorkspaces`
    // there. Asserted FIRST, inside this transaction and before any insert — a
    // non-member reads the org as absent (404) and a plain Member is refused
    // (403), and neither learns anything about the org's plan from the cap check
    // below. It also retires the upward auto-join this branch used to perform:
    // an actor who passes is by construction already an org member.
    await assertOrgCapability(input.ownerUserId, organizationId, 'manageWorkspaces', tx);
    // No new workspace in an org scheduled for deletion (MOTIR-6396).
    await assertOrgNotClosing(organizationId, tx);
    // §4.4 workspace cap (8.1.11): a 2nd+ workspace under an existing org is
    // gated (free org = exactly 1 workspace). Lock + count inside this tx.
    await entitlementsService.assertWithinWorkspaceCap(organizationId, tx);
  } else {
    // §4.5 org-creation gate (8.1.11): minting a NEW org (the signup / "create
    // workspace under a fresh org" path) is itself an org create — gate it
    // exactly as organizationsService.createOrganization does (the first org is
    // always free; a 2nd+ needs a paid org). Sweep ALL org-creators, not just
    // the explicit createOrganization entry (new-access-gate-sweep-all-creators).
    await entitlementsService.assertCanCreateOrganization(input.ownerUserId, tx);
    // The minted org's content language is seeded from the creator's browser
    // (Story MOTIR-7731 · MOTIR-8093); absent, the column's `en` default holds.
    const organization = await organizationRepository.create(
      { name: input.name, slug: input.slug, contentLanguage: input.contentLanguage },
      tx,
    );
    await organizationMembershipRepository.create(
      {
        organizationId: organization.id,
        userId: input.ownerUserId,
        role: ORGANIZATION_ROLE.owner,
      },
      tx,
    );
    organizationId = organization.id;
  }
  const workspace = await workspaceRepository.create(
    { name: input.name, slug: input.slug, organizationId },
    tx,
  );
  // The workspace creator is its MANAGER (Story MOTIR-6168 · MOTIR-6462 —
  // `role-model.md` left who becomes a new workspace's Manager open; it is the
  // creator, its first and only member). Invited members default to `member`
  // (workspacesService.addMember).
  const membership = await workspaceMembershipRepository.create(
    { userId: input.ownerUserId, workspaceId: workspace.id, workspaceRole: 'manager' },
    tx,
  );
  return { workspace, membership };
}

export interface CreateWorkspaceInput {
  name: string;
  ownerUserId: string;
  /**
   * Story 6.10: when set, the workspace nests under this EXISTING organization
   * (the "create a 2nd+ workspace under the active org" path); the creator
   * must hold `manageWorkspaces` there — an org Owner or Admin (MOTIR-6309) —
   * or the create throws `OrganizationNotFoundError` (a non-member, 404) /
   * `OrgForbiddenError` (a Member, 403). When omitted, a fresh
   * default org is minted with the creator as org owner (the signup / first-
   * workspace OPC path).
   */
  organizationId?: string;
  /**
   * The content language a freshly MINTED org starts with (Story MOTIR-7731 ·
   * MOTIR-8093) — `contentLanguageFromAcceptLanguage` of the creator's request.
   * Ignored when `organizationId` nests the workspace under an existing org,
   * whose language is already set. Omitted ⇒ the column default, `en`.
   */
  contentLanguage?: Locale;
}

export interface CreateWorkspaceResult {
  workspace: Workspace;
  membership: WorkspaceMembership;
}

export interface EnsureDefaultWorkspaceInput {
  userId: string;
  userName: string;
  /** Seeds the minted org's content language — see `CreateWorkspaceInput`. */
  contentLanguage?: Locale;
}

/**
 * The resolved GLOBAL last-active context (Subtask 8.8.27) — the project the
 * user last worked in plus the workspace + org it lives under (project →
 * workspace → org). `resolveLastActiveContext` returns this when the pointer is
 * set AND the project still exists AND the user still passes the workspace
 * access gate; otherwise `null` (so the caller falls through to the
 * first-by-createdAt default).
 */
export interface LastActiveContext {
  projectId: string;
  workspaceId: string;
  organizationId: string;
}

/**
 * The org-Admin door's authorisation (MOTIR-6309): the workspace exists, is the
 * addressed org's when one was addressed, and the actor holds `manageWorkspaces`
 * on it. Runs inside a `withWorkspaceContext` transaction, which binds user /
 * workspace / project only, so it ADDS the org GUC before the capability read —
 * the organization id comes from the workspace row itself, a trusted resolution.
 */
async function assertMayRemoveWorkspace(
  input: { workspaceId: string; actorUserId: string; organizationId?: string },
  tx: Prisma.TransactionClient,
): Promise<void> {
  const organizationId = await workspaceRepository.findOrganizationId(input.workspaceId, tx);
  if (
    !organizationId ||
    (input.organizationId !== undefined && input.organizationId !== organizationId)
  ) {
    throw new WorkspaceNotFoundError(input.workspaceId);
  }
  await bindOrganizationContext(tx, organizationId);
  await assertOrgCapability(input.actorUserId, organizationId, 'manageWorkspaces', tx);
  // A closing org's workspaces are the erasure sweep's to remove (MOTIR-6396).
  await assertOrgNotClosing(organizationId, tx);
}

/**
 * THE ONE WORKSPACE DELETE — shared by the org-Admin door and the erasure entry
 * (MOTIR-6309), never copied. Deletes the workspace and (via onDelete: Cascade)
 * every child row, inside a workspace-scoped transaction so the workspace RLS
 * policy permits it.
 *
 * `guard` is the caller's AUTHORISATION, and it runs in BOTH transactions below:
 * first, so an actor who may not delete is refused before anything is read; and
 * again inside the delete's own transaction, so the decision and the write are
 * one atomic step (a role change or a new member landing in between is seen).
 *
 * TWO things survive the cascade on purpose, and both are written HERE
 * because here is the only place that still sees what is about to be lost:
 * the code-graph offboarding row (§14.3, enqueued post-commit from ids read
 * before the cascade) and the public-hostname RESERVATION (ADR §8, written
 * INSIDE the delete's own transaction — Bug MOTIR-4366).
 */
async function deleteWorkspaceCascade(input: {
  workspaceId: string;
  actorUserId: string;
  guard: (tx: Prisma.TransactionClient) => Promise<void>;
}): Promise<void> {
  // ⚠️ ENUMERATE THE PROJECTS BEFORE THE CASCADE TAKES THEM
  // (MOTIR-2166 · `docs/decisions/code-graph-index-fleet.md` §14.3).
  //
  // This read has to happen HERE, above the delete, and it is the one ordering
  // trap in Decision 10 that is easy to get wrong and impossible to notice
  // afterwards. The other three offboarding triggers leave the project rows
  // standing, so their scope is still readable post-commit; `workspaceRepository
  // .delete` cascades the projects away. Read the list after it and there is
  // nothing to enumerate — the graphs then have no queue row naming them and
  // become permanently unreachable orphans, which is the precise end state §14
  // exists to prevent, produced by the code meant to prevent it.
  //
  // INCLUDING ARCHIVED projects: an archived project's graph still exists (its
  // own archive enqueued a WINDOWED row), and a workspace delete must supersede
  // that with an immediate one. `findByWorkspace` filters archived out, so this
  // deliberately uses the unfiltered read.
  const projectIds = await withWorkspaceContext(
    { userId: input.actorUserId, workspaceId: input.workspaceId },
    async (tx) => {
      await input.guard(tx);
      return projectRepository.findAllIdsByWorkspace(input.workspaceId, tx);
    },
  );

  // ⚠️ RESERVE THE PUBLIC HOSTNAMES IN THE SAME TRANSACTION AS THE DELETE
  // (Bug MOTIR-4366 · `docs/decisions/public-tenant-addresses.md` §8, as
  // amended).
  //
  // `public_address.workspace_id` is `ON DELETE CASCADE`, so this delete frees
  // the workspace's live subdomain AND every label it ever retired back into a
  // GLOBALLY unique namespace — where the next workspace to ask inherits every
  // inbound link the departed one accumulated. §8 says a subdomain is never
  // released, and the mechanism it relies on ("a retired label keeps its row,
  // the row keeps the name") has no answer for the row's owner going away.
  //
  // ⚠️ AND THIS IS THE PATH THAT RUNS IT AUTOMATICALLY.
  // `accountErasureSweepService` deletes a sole-membership workspace THROUGH
  // this function (`deleteWorkspaceForErasure`) on a scheduled job, discharging a GDPR erasure request — so
  // the release needed nobody to decide it, errored nothing, and logged
  // nothing unusual.
  //
  // ONE transaction with the delete, deliberately, and not the two-step the
  // `projectIds` read above is. That read only has to happen BEFORE the
  // cascade; this write has to be ATOMIC with it, because the failure mode it
  // repairs is exactly "the delete committed and the reservation did not".
  //
  // What is stored is a DIGEST, never the hostname: the deletion is often an
  // erasure obligation and a hostname can itself be the personal datum
  // (`jane-smith.<base>`). A claim only ever needs to TEST a candidate, which
  // is the one thing a one-way hash still answers. `custom_domain` rows are
  // excluded — that name belongs to the customer, not to us
  // (`lib/publicAddresses/hostnameReservation.ts`).
  await withWorkspaceContext(
    { userId: input.actorUserId, workspaceId: input.workspaceId },
    async (tx) => {
      await input.guard(tx);
      const addresses = await publicAddressRepository.listForWorkspaceInTx(input.workspaceId, tx);
      const now = new Date();
      await publicHostnameReservationRepository.reserveMany(
        addresses
          .filter((address) => reservesItsHostname(address.kind))
          .map((address) => ({
            hostnameHash: hostnameReservationHash(address.hostname),
            retiredFromWorkspaceId: input.workspaceId,
            expiresAt: addDays(now, QUARANTINE_DAYS),
          })),
        now,
        tx,
      );
      await workspaceRepository.delete(input.workspaceId, tx);
    },
  );

  // POST-COMMIT, BEST-EFFORT — and IMMEDIATE, with no retention window (§14.3).
  // The other three arms leave a surface to undo into, so their window is a real
  // grace period; a hard delete leaves none, and "a grace period the user cannot
  // reach is not a grace period" — a window here would only extend retention.
  //
  // The queue row survives this delete because `code_graph_offboarding` carries
  // NO foreign key to workspace or project. That is the single most important
  // property in the story, and this is the call that depends on it.
  await codeGraphOffboardingService.enqueueQuietly({
    coreWorkspaceId: input.workspaceId,
    coreProjectIds: projectIds,
    reason: 'workspace_deleted',
  });
}

/**
 * Whether `userId` is the Owner or an Admin of the workspace's ORGANIZATION — a
 * Manager of every workspace by their org role, whose workspace role is not a
 * workspace Manager's to change (MOTIR-6463; MOTIR-6456 panel 6a).
 *
 * The target's org membership is ANOTHER person's row, admitted only by the
 * active-org arm of `org_membership_visible_active_or_own`, so the workspace's
 * own organization is bound first — a trusted resolution (the workspace row the
 * caller just read), never request input. The binding outlives this read for the
 * rest of `tx`, which is harmless: it only ever ADDS the org arm.
 */
async function isOrgManagerTarget(
  userId: string,
  workspace: { id: string; organizationId: string },
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  await bindOrganizationContext(tx, workspace.organizationId);
  return organizationMembershipRepository.isOrgManagerOfWorkspaceOrg(userId, workspace.id, tx);
}

/**
 * The organization's Owner and Admins, and its name — what the Members page's
 * locked rows need (MOTIR-6465; MOTIR-6456 panel 6a). Other people's org rows,
 * so the workspace's own organization is bound first, exactly as
 * {@link isOrgManagerTarget} does.
 */
async function orgManagersOf(
  workspace: { organizationId: string },
  tx: Prisma.TransactionClient,
): Promise<{ userIds: string[]; organizationName: string }> {
  await bindOrganizationContext(tx, workspace.organizationId);
  const [userIds, org] = [
    await organizationMembershipRepository.findManagerUserIdsByOrganization(
      workspace.organizationId,
      tx,
    ),
    await organizationRepository.findByIdInTx(workspace.organizationId, tx),
  ];
  return { userIds, organizationName: org?.name ?? '' };
}

/**
 * Delete `userId`'s membership of `workspaceId` behind the last-member guard —
 * the shared tail of a Leave. Returns null when there is no row (idempotent).
 *
 * MOTIR-2527: every read here goes through `tx`, the caller's bound transaction,
 * so the read that GUARDS the delete shares the transaction that performs it.
 * Reading through the `db` singleton made this fail SILENTLY: a null reads as
 * "not a member", which is the idempotent no-op, so Leave returned success
 * having deleted nothing.
 */
async function deleteMembershipGuarded(
  userId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<WorkspaceMembership | null> {
  const existing = await readMembership(userId, workspaceId, tx);
  if (!existing) return null;

  // Lock the workspace's membership rows before counting so two concurrent
  // leaves serialize (lock-before-read-derived-update) — a plain COUNT would
  // let both observe count > 1 and both delete, orphaning the workspace.
  const memberCount = await workspaceMembershipRepository.countByWorkspaceForUpdate(
    workspaceId,
    tx,
  );
  if (memberCount <= 1) throw new LastMemberError(workspaceId);

  return workspaceMembershipRepository.deleteByUserAndWorkspace(userId, workspaceId, tx);
}

export const workspacesService = {
  /**
   * Create a workspace and its owner-membership in a single transaction.
   * The slug is derived from `name`; if that base slug collides on the
   * unique index, we retry with a random 4-char suffix appended. After
   * 3 collisions (which would require astronomically bad luck after the
   * first suffix attempt) we throw SlugCollisionError so the caller
   * surfaces a typed failure rather than a generic Prisma error.
   */
  async createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
    const base = slugify(input.name);
    let lastAttempt = base;

    for (let attempt = 0; attempt < SLUG_RETRY_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      lastAttempt = slug;
      try {
        return await db.$transaction(async (tx) => {
          return insertWorkspaceWithOwner(
            {
              name: input.name,
              slug,
              ownerUserId: input.ownerUserId,
              organizationId: input.organizationId,
              contentLanguage: input.contentLanguage,
            },
            tx,
          );
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          // A slug collision — on either organization.slug or workspace.slug
          // (Story 6.10 reuses the same slug for the auto-created org). The ids
          // were freshly minted, so the membership uniques can't fire here.
          // Retry with a new suffixed slug.
          continue;
        }
        throw err;
      }
    }
    throw new SlugCollisionError(lastAttempt);
  },

  /**
   * Provision a brand-new account's tenancy (Story 6.10.4, the
   * progressive-disclosure / auto-provision principle): an organization (an org
   * of one — OPC) + a default workspace + the owner memberships for both, all in
   * ONE transaction. This is the named entry the signup/onboarding hook calls so
   * every account is an org of one from day one and there is never a tier-less
   * user; it delegates to `createWorkspace` (no `organizationId` → the
   * mint-own-org branch), which already does the atomic org+workspace+memberships
   * insert with the slug-collision retry. The org name defaults from the user and
   * is renameable later (organizationsService.renameOrganization).
   */
  async provisionForNewUser(input: EnsureDefaultWorkspaceInput): Promise<CreateWorkspaceResult> {
    return workspacesService.createWorkspace({
      name: `${input.userName}'s Workspace`,
      ownerUserId: input.userId,
      contentLanguage: input.contentLanguage,
    });
  },

  /**
   * Idempotent self-heal: guarantee the user has at least one workspace,
   * returning their active (first) one. Backstops the best-effort signup
   * hook, which is NOT atomic with the user insert (it runs as a queued
   * after-transaction hook in better-auth 1.6.11 — see lib/auth/index.ts),
   * so a committed user can transiently have zero workspaces.
   *
   * Concurrency: two parallel first-requests (e.g. two browser tabs right
   * after signup) must not each create a default workspace. We serialize
   * on a `SELECT ... FOR UPDATE` lock of the user row inside the same
   * transaction as the membership count + create: the second caller blocks
   * on the lock, then re-reads a non-zero count and returns the first
   * caller's workspace instead of inserting a duplicate.
   *
   * Each slug-collision retry opens a fresh transaction because a P2002
   * poisons the current one. The lock is re-acquired on every attempt; the
   * count re-check inside the lock keeps it idempotent across retries too.
   *
   * ⚠️ The transaction is `withUserContext`, NOT a bare `db.$transaction`
   * (MOTIR-2874). The idempotency check reads `workspace_membership`, whose
   * SELECT policy `membership_visible_active_or_own` admits a row only when
   * `"workspaceId" = app.workspace_id` OR `"userId" = app.user_id`. This path
   * is RESOLVING the workspace, so there is no workspace id to bind — the
   * `_or_own` arm is the one that must fire, and it needs `app.user_id`. Under
   * a bare transaction `countByUser` read 0 for a user who already had
   * memberships (RLS removes rows, it does not raise), the guard failed OPEN,
   * and the self-heal minted a DUPLICATE default workspace. The `FOR UPDATE`
   * lock on the user row serialises the race but cannot see what RLS hid.
   *
   * `insertWorkspaceWithOwner` re-binds `app.user_id` to the same value inside
   * this transaction (it also needs `app.bootstrap_slug`, which it owns because
   * each retry attempts a different slug) — a same-value rebind, so the two
   * bindings compose rather than conflict. Ordering alone would NOT have been
   * enough: that binding happens on the CREATE path, after the count that
   * needed it has already run.
   */
  async ensureDefaultWorkspace(input: EnsureDefaultWorkspaceInput): Promise<CreateWorkspaceResult> {
    const name = `${input.userName}'s Workspace`;
    const base = slugify(name);
    let lastAttempt = base;

    for (let attempt = 0; attempt < SLUG_RETRY_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      lastAttempt = slug;
      try {
        const result = await withUserContext(input.userId, async (tx) => {
          await userRepository.lockById(input.userId, tx);

          const existingCount = await workspaceMembershipRepository.countByUser(input.userId, tx);
          if (existingCount > 0) {
            const first = await workspaceMembershipRepository.findFirstByUserWithWorkspace(
              input.userId,
              tx,
            );
            // existingCount > 0 guarantees a row; the non-null assertion is
            // safe inside the same FOR-UPDATE-locked transaction.
            const { workspace, ...membership } = first!;
            return { workspace, membership };
          }

          return insertWorkspaceWithOwner(
            { name, slug, ownerUserId: input.userId, contentLanguage: input.contentLanguage },
            tx,
          );
        });
        return result;
      } catch (err) {
        if (isUniqueViolation(err)) {
          continue;
        }
        throw err;
      }
    }
    throw new SlugCollisionError(lastAttempt);
  },

  /**
   * Resolve the user's active workspace (cookie-pinned if they belong to
   * it, else their first membership) and return it as the
   * GET /api/workspaces/current DTO. Returns null when the user has no
   * memberships — the route turns that into a 404. Read-only, so the reads
   * run in one transaction purely for snapshot consistency between the
   * membership lookup and its workspace.
   *
   * ⚠️ That transaction is `withUserContext`, NOT a bare `db.$transaction`
   * (MOTIR-2874). It mirrors `resolveActiveWorkspace` below, and for the same
   * reason: both reads are membership RESOLUTION, so no `app.workspace_id`
   * exists yet and the `_or_own` arm of `membership_visible_active_or_own` is
   * what has to admit the row — plus `workspace_membership_visible` on
   * `workspace`, which is also keyed on `app.user_id` and is what makes the
   * `include: { workspace: true }` come back non-null. Unbound, both reads
   * returned nothing under `motir_app` and this method resolved to `null` for
   * every signed-in user, which the route turns into a 404 — the shell asks
   * `GET /api/workspaces/current` before it can render anything, so that is not
   * a degraded feature but a product that does not open.
   */
  async getActiveWorkspace(
    userId: string,
    preferredWorkspaceId: string | null,
  ): Promise<CurrentWorkspaceDTO | null> {
    return withUserContext(userId, async (tx) => {
      if (preferredWorkspaceId) {
        const pinned = await workspaceMembershipRepository.findByUserAndWorkspaceWithWorkspace(
          userId,
          preferredWorkspaceId,
          tx,
        );
        if (pinned) {
          const { workspace, ...membership } = pinned;
          return toCurrentWorkspaceDTO(workspace, membership);
        }
      }

      const first = await workspaceMembershipRepository.findFirstByUserWithWorkspace(userId, tx);
      if (!first) return null;
      const { workspace, ...membership } = first;
      return toCurrentWorkspaceDTO(workspace, membership);
    });
  },

  /**
   * Resolve which workspace a request acts within, returning just its id.
   * This is the business logic behind the workspace-context resolver
   * (lib/workspaces/middleware.ts); the resolver now only parses the
   * session + cookie and delegates here.
   *
   * Resolution order:
   *   1. cookie-pinned workspace, IF the user has a membership in it AND it
   *      passes the org access gate;
   *   2. otherwise the user's first membership (createdAt asc — the
   *      auto-created default from Subtask 1.2.4 lands first) that passes the
   *      org access gate;
   *   3. zero ACCESSIBLE memberships → self-heal via ensureDefaultWorkspace and
   *      return the workspace it guarantees.
   *
   * Story 6.10.4: a candidate must clear the ORG gate
   * (organizationsService.resolveWorkspaceAccess) — org membership gates
   * workspace access, so a stale workspace membership whose org membership was
   * revoked no longer resolves as the active workspace. The gate is passed the
   * withUserContext `tx`; the candidate is always a workspace the user is a
   * member of, so its rows are RLS-visible under the bound user GUC.
   *
   * The membership reads run inside withUserContext so the `app.user_id`
   * GUC is bound first and the RLS membership policies bite even on a
   * non-superuser connection. The self-heal runs OUTSIDE that transaction
   * because ensureDefaultWorkspace owns its own transaction (with a
   * FOR UPDATE lock on the user row); nesting it would deadlock on the
   * same connection.
   *
   * `contentLanguage` seeds the content language of the org that self-heal
   * mints (Story MOTIR-7731 · MOTIR-8093); omitted, it stays `en`.
   *
   * `userName` seeds the default workspace name on the self-heal path;
   * when the caller has no session object on hand it is read off the user
   * row before backfilling.
   *
   * `cookieOrganizationId` is the org cookie (`motir.org`) — the org the user
   * last chose (MOTIR-8777). It is consulted only when no workspace cookie pin
   * wins: if it names an organization the user belongs to that has NO workspace
   * at all, this returns `null` — the user is in that org with no workspace —
   * instead of falling back to (or self-healing) a workspace of ANOTHER org,
   * which would make the shell name that other org and turn the org switch into
   * a no-op. An org that has workspaces keeps the fallback below unchanged.
   */
  async resolveActiveWorkspace(
    userId: string,
    cookieWorkspaceId: string | null,
    userName?: string,
    contentLanguage?: Locale,
    cookieOrganizationId?: string | null,
  ): Promise<string | null> {
    // Set when the cookie names a workspace the user holds NO membership in —
    // the one case a second, workspace-bound read is needed (below).
    let cookieWithoutMembership = false as boolean;
    // Set when the workspace cookie pin resolved — the org cookie is then moot.
    let pinWon = false as boolean;
    // The first SUSPENDED organization a DEFAULT candidate fell in (MOTIR-748).
    // A default (last-active, first-by-createdAt) that lands in a suspended org
    // falls through to the user's next accessible workspace — a member of two
    // orgs is not locked out of both by one suspension. Only when NO workspace
    // is accessible is the suspension raised, and never by self-healing a fresh
    // default workspace past it. A cookie the user PINNED to a suspended org's
    // workspace is an explicit choice, so that refusal is raised as-is.
    let suspended = null as OrganizationSuspendedError | null;
    const passesGate = async (workspaceId: string, tx: Prisma.TransactionClient) => {
      try {
        return (
          (await organizationsService.resolveWorkspaceAccess(userId, workspaceId, tx)) !== null
        );
      } catch (err) {
        if (!(err instanceof OrganizationSuspendedError)) throw err;
        suspended ??= err;
        return false;
      }
    };
    // A transaction that could not START (P2028 `maxWait`, MOTIR-8288) is retried
    // once by `withUserContext` itself, before this body runs (MOTIR-8333).
    const existing = await withUserContext(
      userId,
      async (tx) => {
        if (cookieWorkspaceId) {
          const pinned = await workspaceMembershipRepository.findByUserAndWorkspaceWithWorkspace(
            userId,
            cookieWorkspaceId,
            tx,
          );
          // Not `passesGate`: a suspension of the PINNED workspace's org throws.
          if (
            pinned &&
            (await organizationsService.resolveWorkspaceAccess(userId, pinned.workspaceId, tx))
          ) {
            pinWon = true;
            return pinned.workspaceId;
          }
          cookieWithoutMembership = !pinned;
        }
        // No valid cookie pin. Before the first-by-createdAt default, try the
        // user's GLOBAL last-active project (Subtask 8.8.27): land them back in
        // the workspace of the project they last worked in (cross-device,
        // account-keyed — the Linear "last visited context" standard). The
        // resolver re-checks the access gate, so a since-revoked membership or an
        // archived/deleted project falls through cleanly to the default below.
        try {
          const lastActive = await this.resolveLastActiveContext(userId, tx);
          if (lastActive) return lastActive.workspaceId;
        } catch (err) {
          if (!(err instanceof OrganizationSuspendedError)) throw err;
          suspended ??= err;
        }

        const first = await workspaceMembershipRepository.findFirstByUserWithWorkspace(userId, tx);
        if (first && (await passesGate(first.workspaceId, tx))) {
          return first.workspaceId;
        }
        // Only reached past a SUSPENDED first default: walk the rest of the
        // user's memberships for one whose org is not suspended (the rare path —
        // the common one returned above without this read).
        if (suspended) {
          const all = await workspaceMembershipRepository.findWorkspacesByUser(userId, tx);
          for (const w of all) {
            if (w.id !== first?.workspaceId && (await passesGate(w.id, tx))) return w.id;
          }
        }
        return null;
      },
      ACTIVE_WORKSPACE_RESOLVE_TX,
    );

    // THE ORG OWNER — OR AN ORG ADMIN, SINCE MOTIR-6168 — OPENS A WORKSPACE THEY
    // ARE NOT A MEMBER OF (MOTIR-6308): the
    // switcher lists every workspace of their org, so a cookie may pin one with no
    // membership row. The user-bound transaction above cannot see that workspace
    // (no `workspace_membership_visible` arm, no workspace GUC), so the gate runs
    // in its OWN workspace-bound read — and only in this case, so the common path
    // keeps its one transaction. It admits the Owner and the Admins alone:
    // `resolveWorkspaceAccess` refuses every other non-member.
    if (cookieWorkspaceId && cookieWithoutMembership) {
      const access = await organizationsService.resolveWorkspaceAccess(userId, cookieWorkspaceId);
      if (access?.reachesEveryWorkspace) return cookieWorkspaceId;
    }

    // THE ACTIVE ORG MAY HAVE NO WORKSPACE (MOTIR-8777). No workspace pin won,
    // so everything below would land the user in a workspace of whichever org
    // the default picks — or mint one. When the org cookie names an org the
    // user belongs to that has no workspace, they are in THAT org with no
    // workspace: answer `null`, and the shell shows the org on its own. Read
    // only on this fallback path, so a request with a valid pin pays nothing.
    if (
      !pinWon &&
      cookieOrganizationId &&
      (await this.isEmptyOrganizationOfMember(userId, cookieOrganizationId))
    ) {
      return null;
    }

    if (existing) return existing;
    // Every workspace the user holds sits in a suspended organization: refuse
    // with the suspension, never self-heal a default workspace around it.
    if (suspended) throw suspended;

    const name = userName ?? (await userRepository.findById(userId))?.name ?? 'My';
    const { workspace } = await this.ensureDefaultWorkspace({
      userId,
      userName: name,
      contentLanguage,
    });
    return workspace.id;
  },

  /**
   * Whether `organizationId` names an organization the user is a member of that
   * holds NO workspace at all (MOTIR-8777) — the state a freshly created org is
   * in, and one the org switcher must be able to enter. `false` for a
   * non-member (a stale or forged org cookie), so the caller keeps its default.
   *
   * The count runs under the org GUC, bound only after the membership read has
   * proved the id is the user's own org (`bindOrganizationContext`'s rule): a
   * workspace the user is not a member of is otherwise invisible to them, and
   * an Owner's org with workspaces they joined none of is NOT empty.
   */
  async isEmptyOrganizationOfMember(userId: string, organizationId: string): Promise<boolean> {
    return withUserContext(userId, async (tx) => {
      const membership = await organizationMembershipRepository.findByOrgAndUserInTx(
        organizationId,
        userId,
        tx,
      );
      if (!membership) return false;
      await bindOrganizationContext(tx, organizationId);
      return (await workspaceRepository.countByOrganization(organizationId, tx)) === 0;
    });
  },

  /**
   * Record the user's GLOBAL last-active project (Subtask 8.8.27) — the landing
   * target a fresh session/device resolves to. A single-row last-writer-wins
   * overwrite of `User.lastActiveProjectId`: no read-then-write and no external
   * side effects, so it needs no `FOR UPDATE` (concurrent switches simply settle
   * on whichever commits last — the intended "most recent"). Wrapped in a plain
   * transaction per the one-method-one-transaction rule (no tenant GUC needed —
   * the write is keyed by the user's own id, mirroring `usersService.updateProfile`).
   *
   * The write call sites (the project / workspace / org switch points) are wired
   * in Subtask 8.8.28; this slice ships the method + its unit coverage.
   */
  async recordLastActiveProject(userId: string, projectId: string): Promise<void> {
    await db.$transaction((tx) => userRepository.setLastActiveProject(userId, projectId, tx));
  },

  /**
   * Resolve the user's GLOBAL last-active context (Subtask 8.8.27): the project
   * pointer plus the workspace + org it derives (project → workspace → org).
   * Returns `null` — so the caller falls through to its default — when the
   * pointer is unset, the project no longer exists, or the user no longer passes
   * the workspace access gate (a revoked membership, a cross-org move). A pure
   * read: no writes, no side effects.
   *
   * Takes `tx` because the canonical caller (`resolveActiveWorkspace`) already
   * runs under `withUserContext`, and the access-gate re-check
   * (`organizationsService.resolveWorkspaceAccess`) reuses that bound
   * transaction so the membership rows are RLS-visible in the same snapshot.
   *
   * ⚠️ The `project` read below is RLS-load-bearing (MOTIR-2886). `withUserContext`
   * binds only `app.user_id`, and until `20260817140000` no `project` policy read
   * that GUC — so under the non-bypass `motir_app` role the read returned null,
   * raised nothing, and this method returned null for EVERY user: the landing
   * silently degraded to `resolveActiveWorkspace`'s first-by-createdAt default,
   * and the access gate below was never reached. `project_user_membership_read`
   * admits it, keyed on WORKSPACE membership only, so the ORG-keyed gate below
   * still decides access rather than the policy deciding it invisibly. If this
   * method ever grows a read of another tenant table, check that table's arms for
   * this context first — see `withUserContext`'s sufficiency note.
   */
  async resolveLastActiveContext(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<LastActiveContext | null> {
    const user = await userRepository.findById(userId, tx);
    if (!user?.lastActiveProjectId) return null;

    const project = await projectRepository.findById(user.lastActiveProjectId, tx);
    if (!project) return null;

    const access = await organizationsService.resolveWorkspaceAccess(
      userId,
      project.workspaceId,
      tx,
    );
    if (!access) return null;

    return {
      projectId: project.id,
      workspaceId: project.workspaceId,
      organizationId: access.organizationId,
    };
  },

  async findMembership(userId: string, workspaceId: string): Promise<WorkspaceMembership | null> {
    return readMembership(userId, workspaceId);
  },

  /**
   * Every workspace the user belongs to (the shell switcher, the v1 identity read,
   * the API-token scope list).
   *
   * OPENS the user context rather than merely threading one (MOTIR-2774): unlike the
   * org-tier mirror this had no binding caller at all, so the membership read went out
   * on the singleton and the policy returned nothing. This is the exact shape
   * `organizationsService.listUserOrganizations` uses.
   */
  async listUserWorkspaces(userId: string): Promise<Workspace[]> {
    return withUserContext(userId, async (tx) => {
      const memberOf = await workspaceMembershipRepository.findWorkspacesByUser(userId, tx);
      // THE ORG OWNER AND THE ORG ADMINS SEE EVERY WORKSPACE OF THEIR ORG
      // (MOTIR-6308, widened to Admins by MOTIR-6168): they act in all of them,
      // member or not, so the switcher lists all of them. Anyone else sees
      // exactly their memberships. The workspaces they are a member of come first, in the
      // order they always did; the rest follow by creation.
      //
      // ONE transaction, the org GUC re-bound per owned org: `workspace_org_member_read`
      // admits an org's workspaces off `app.organization_id`, and the ids come from
      // the actor's own owner rows (trusted — `bindOrganizationContext`'s rule).
      const owned = await organizationMembershipRepository.findManagedOrganizationsByUser(
        userId,
        tx,
      );
      if (owned.length === 0) return memberOf;
      const seen = new Set(memberOf.map((w) => w.id));
      const extra: Workspace[] = [];
      for (const org of owned) {
        await bindOrganizationContext(tx, org.id);
        for (const w of await workspaceRepository.listByOrganization(org.id, tx)) {
          if (!seen.has(w.id)) {
            seen.add(w.id);
            extra.push(w);
          }
        }
      }
      return [...memberOf, ...extra];
    });
  },

  /**
   * Add a member to a workspace. Throws AlreadyMemberError when the
   * unique (userId, workspaceId) constraint fires. Wraps the writes in one
   * transaction so the error-translation point stays consistent and the
   * upward auto-join is atomic with the workspace-membership insert.
   *
   * Story 6.10.4 — the UPWARD membership invariant (6.10.2 §5i): you cannot be
   * in a workspace without being in its org, so adding a user to a workspace
   * also ensures their OrganizationMembership (role `member`) in that
   * workspace's org, in the SAME transaction. This is what keeps the org access
   * gate satisfied for every workspace member (an invite-accept that adds a
   * cross-org user to a workspace auto-enrols them in the org).
   */
  async addMember(input: {
    userId: string;
    workspaceId: string;
    /** Defaults to Member — an added person is never a Manager unless asked for. */
    workspaceRole?: WorkspaceRole;
  }): Promise<WorkspaceMembership> {
    let organizationId: string | null = null;
    try {
      // MOTIR-2527: `withWorkspaceContext`, not a bare `db.$transaction`. This is the
      // ONE true RLS denial in the MOTIR-2514 inventory —
      // `new row violates row-level security policy for table "workspace_membership"` —
      // because `membership_insert_active_or_bootstrap` gates the INSERT on
      // `"workspaceId" = current_setting('app.workspace_id')` and nothing bound it.
      // Same root shape as the eleven false denials, one verb over.
      const membership = await withWorkspaceContext(
        { userId: input.userId, workspaceId: input.workspaceId },
        async (tx) => {
          const created = await workspaceMembershipRepository.create(
            {
              userId: input.userId,
              workspaceId: input.workspaceId,
              workspaceRole: input.workspaceRole ?? 'member',
            },
            tx,
          );
          // Upward auto-join: the create succeeded, so the workspace exists; bring
          // the user into its org if they aren't a member already.
          const workspace = await workspaceRepository.findByIdInTx(input.workspaceId, tx);
          if (workspace) {
            organizationId = workspace.organizationId;
            // The org auto-join writes a SECOND tenant-root table, gated by
            // `org_membership_insert_active_or_bootstrap` on `app.organization_id` — a
            // GUC the workspace context does not carry and which is unknowable until
            // the row above is read. Bind it here rather than splitting the atomic
            // upward-membership invariant across two transactions.
            await bindOrganizationContext(tx, workspace.organizationId);
            await organizationsService.ensureOrgMembership(
              input.userId,
              workspace.organizationId,
              tx,
            );
          }
          return created;
        },
      );
      // Committed → resync the org's scaled-tracker seat quantity (8.1.12): the
      // upward auto-join may have grown the org's member count. Best-effort +
      // OUTSIDE the tx (a billing failure must never fail the workspace add);
      // idempotent absolute set, so it no-ops when the user was already an org
      // member or the org isn't scaled.
      if (organizationId) await enqueueScaledTrackerSeatSync(organizationId);
      return membership;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AlreadyMemberError(input.userId, input.workspaceId);
      }
      throw err;
    }
  },

  /**
   * LEAVE a workspace — the actor removes their OWN membership. Returns the
   * deleted row, or null if they were not a member (idempotent Leave). Any
   * member may leave; there is no right to lack (`leaveWorkspaceAction`).
   *
   * Removing ANOTHER person is {@link removeMember}, which is Manager-gated —
   * the two are separate entries so a self-removal can never be mistaken for,
   * or widened into, a removal of somebody else (MOTIR-6317).
   *
   * Enforces the last-member guard: if the leaver is the only remaining
   * membership, throws LastMemberError instead of deleting — a workspace
   * with zero members is unreachable and undeletable through the UI, so
   * the last member must use Delete, not Leave. The guard LOCKS the
   * workspace's membership rows `FOR UPDATE` before counting
   * (countByWorkspaceForUpdate), all in one transaction, so two concurrent
   * leaves of a 2-member workspace serialize — the second blocks, re-counts
   * after the first commits, and is refused — and the workspace can never be
   * orphaned (the lock-before-read-derived-update rule; mirrors the org
   * last-owner guard).
   */
  async leaveWorkspace(input: {
    userId: string;
    workspaceId: string;
  }): Promise<WorkspaceMembership | null> {
    return withWorkspaceContext({ userId: input.userId, workspaceId: input.workspaceId }, (tx) =>
      deleteMembershipGuarded(input.userId, input.workspaceId, tx),
    );
  },

  /**
   * A Manager removes ANOTHER member from the workspace (MOTIR-6317). Returns
   * the deleted row, or null if the target was not a member (idempotent).
   *
   * The ACTOR is required — the transaction's RLS context is the actor's, never
   * the target's, and the actor's role is asserted before the target's row is
   * touched. Before this card the method took only the target, so no role check
   * was possible and any member could remove any other, the Owner included.
   *
   * Refusals, each before anything is written:
   *   * the actor is not in the workspace → NotAMemberError (404), or is not its
   *     Manager → WorkspaceRoleForbiddenError (403). The org Owner and an org
   *     Admin are Managers with or without a membership (`readReachRole`);
   *   * the target is the org Owner or an org Admin → OrgManagedWorkspaceRoleError
   *     (409) — they manage the workspace by their org role, which only the
   *     organization changes, exactly as `setMemberRole` refuses them;
   *   * the removal would leave no Manager → LastManagerError (409) — reachable
   *     only when the actor manages by org role without a membership of their own;
   *   * the target is the last member → LastMemberError.
   *
   * An actor naming THEMSELF is a leave, and takes {@link leaveWorkspace}'s path.
   *
   * Every membership row is locked `FOR UPDATE` before either count is derived
   * (the lock-before-read-derived-update rule), so a removal racing a leave or a
   * role change serialises on the same rows.
   */
  async removeMember(input: {
    actorUserId: string;
    targetUserId: string;
    workspaceId: string;
  }): Promise<WorkspaceMembership | null> {
    if (input.actorUserId === input.targetUserId) {
      return workspacesService.leaveWorkspace({
        userId: input.actorUserId,
        workspaceId: input.workspaceId,
      });
    }
    return withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.workspaceId },
      async (tx) => {
        const actorRole = await readReachRole(input.actorUserId, input.workspaceId, tx);
        if (!actorRole) throw new NotAMemberError(input.actorUserId, input.workspaceId);
        if (actorRole !== 'manager') {
          throw new WorkspaceRoleForbiddenError(input.actorUserId, input.workspaceId);
        }

        const target = await readMembership(input.targetUserId, input.workspaceId, tx);
        // Not a member → idempotent no-op (matches the Leave contract).
        if (!target) return null;

        const workspace = await workspaceRepository.findByIdInTx(input.workspaceId, tx);
        if (!workspace) throw new NotAMemberError(input.actorUserId, input.workspaceId);
        if (await isOrgManagerTarget(input.targetUserId, workspace, tx)) {
          throw new OrgManagedWorkspaceRoleError(input.targetUserId, input.workspaceId);
        }

        // Lock every membership row first, then derive the Manager count under
        // the same locks.
        const memberCount = await workspaceMembershipRepository.countByWorkspaceForUpdate(
          input.workspaceId,
          tx,
        );
        if (memberCount <= 1) throw new LastMemberError(input.workspaceId);
        if (target.workspaceRole === 'manager') {
          const managers = await workspaceMembershipRepository.countManagers(input.workspaceId, tx);
          if (managers <= 1) throw new LastManagerError(input.workspaceId);
        }

        return workspaceMembershipRepository.deleteByUserAndWorkspace(
          input.targetUserId,
          input.workspaceId,
          tx,
        );
      },
    );
  },

  /**
   * Rename a workspace. Any member can rename (single-role v1). Asserts
   * membership, then updates the name inside a workspace-scoped
   * transaction so the workspace RLS policy permits the write. The slug
   * is intentionally NOT regenerated — slugs are stable identifiers; a
   * later Subtask can add slug editing if a URL-facing surface needs it.
   */
  async renameWorkspace(input: {
    workspaceId: string;
    actorUserId: string;
    name: string;
  }): Promise<WorkspaceSummaryDTO> {
    await workspacesService.assertMembership(input.actorUserId, input.workspaceId);
    const trimmed = input.name.trim();
    const workspace = await withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.workspaceId },
      (tx) => workspaceRepository.update(input.workspaceId, { name: trimmed }, tx),
    );
    return toWorkspaceSummaryDTO(workspace);
  },

  /**
   * REMOVE a workspace as an ORG ADMIN — the one interactive door onto deleting
   * a workspace (MOTIR-6309; `role-model.md` §1: creating and removing
   * workspaces is an org-Admin act). The actor needs the `manageWorkspaces`
   * capability on the workspace's organization and NO membership in the
   * workspace itself. Non-member of the org → `OrganizationNotFoundError` (404);
   * a Member → `OrgForbiddenError` (403).
   *
   * `organizationId`, when given (the org-tier route addresses the workspace
   * THROUGH an org), must be the workspace's own org, or the workspace reads as
   * absent (`WorkspaceNotFoundError`, 404) — never removable through another
   * org's URL.
   *
   * The delete itself is {@link deleteWorkspaceCascade}, shared with the erasure
   * entry below; the capability is asserted in BOTH of its transactions, so the
   * refusal is lock-step with the write rather than a check made earlier.
   */
  async removeWorkspaceAsOrgAdmin(input: {
    workspaceId: string;
    actorUserId: string;
    organizationId?: string;
  }): Promise<void> {
    await deleteWorkspaceCascade({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      guard: (tx) => assertMayRemoveWorkspace(input, tx),
    });
  },

  /**
   * One keyset page of the organization's workspaces for the org Workspaces
   * section (MOTIR-6309): each with its member and project counts. Owner and
   * Admin only (`manageWorkspaces`) — a non-member 404s, a Member 403s. NEVER
   * loads every workspace (the at-scale rule): `limit` is clamped and the page
   * carries a `nextCursor`.
   *
   * ⚠️ THE COUNTS ARE READ UNDER A PER-ROW WORKSPACE BINDING, and that is the
   * whole difficulty. `project` and `workspace_membership` admit rows only for
   * the ACTIVE workspace (or, for memberships, the caller's own), so counted
   * under the org context alone they answer ZERO for every workspace the Admin
   * is not in — silently. Each row therefore re-binds `app.workspace_id` to that
   * workspace before its two counts: the ids come from the org-scoped read just
   * above, a trusted resolution, and each binding only narrows to one workspace
   * of the org the actor was just authorised over.
   */
  async listOrganizationWorkspaces(input: {
    organizationId: string;
    actorUserId: string;
    limit?: number;
    cursor?: string | null;
  }): Promise<OrgWorkspacePageDTO> {
    const limit = Math.min(
      Math.max(input.limit ?? ORG_WORKSPACES_DEFAULT_LIMIT, 1),
      ORG_WORKSPACES_MAX_LIMIT,
    );
    return withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      async (tx) => {
        await assertOrgCapability(input.actorUserId, input.organizationId, 'manageWorkspaces', tx);
        const page = await workspaceRepository.listByOrganizationPage(
          input.organizationId,
          limit,
          input.cursor ?? null,
          tx,
        );
        const hasMore = page.length > limit;
        const rows = hasMore ? page.slice(0, limit) : page;
        const total = await workspaceRepository.countByOrganization(input.organizationId, tx);

        const workspaces: OrgWorkspaceRowDTO[] = [];
        for (const workspace of rows) {
          await bindWorkspaceContext(tx, workspace.id);
          const memberCount = await workspaceMembershipRepository.countByWorkspace(
            workspace.id,
            tx,
          );
          const projectCount = await projectRepository.countByWorkspace(workspace.id, tx);
          // Whether the actor is on this workspace's roster — an org Owner / Admin
          // reaches every workspace as its Manager, member or not, and the row
          // says which (MOTIR-6456 panel 6b).
          const viewerIsMember =
            (await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
              input.actorUserId,
              workspace.id,
              tx,
            )) !== null;
          workspaces.push({
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug,
            memberCount,
            projectCount,
            viewerIsMember,
            createdAt: workspace.createdAt.toISOString(),
          });
        }
        return {
          workspaces,
          nextCursor: hasMore ? rows[rows.length - 1]!.id : null,
          total,
        };
      },
    );
  },

  /**
   * Delete a workspace on behalf of ACCOUNT ERASURE — the system entry the
   * sweep takes (MOTIR-6309). Erasure deletes the workspaces the leaving user is
   * the SOLE member of (DECISION 3 of the Data & privacy design), and that user
   * is often a plain org Member, so it cannot go through the Admin door above.
   * It asserts exactly that rule instead: under a lock on the workspace's
   * membership rows, the user's must be the only one. Anything else is
   * `WorkspaceNotSoleMemberError` — a workspace somebody else now shares is not
   * the account's to delete.
   */
  async deleteWorkspaceForErasure(input: { workspaceId: string; userId: string }): Promise<void> {
    await deleteWorkspaceCascade({
      workspaceId: input.workspaceId,
      actorUserId: input.userId,
      guard: async (tx) => {
        const count = await workspaceMembershipRepository.countByWorkspaceForUpdate(
          input.workspaceId,
          tx,
        );
        const own = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
          input.userId,
          input.workspaceId,
          tx,
        );
        if (count !== 1 || !own) {
          throw new WorkspaceNotSoleMemberError(input.userId, input.workspaceId);
        }
      },
    });
  },

  /**
   * The THIRD entry onto {@link deleteWorkspaceCascade} (Story MOTIR-6306 ·
   * MOTIR-6400): an organization's erasure sweep deleting each of its workspaces.
   * It shares the one delete, so both survivals come with it — the code-graph
   * offboarding row and the public-hostname reservation.
   *
   * The guard asserts, under the request row's lock and in BOTH of the delete's
   * transactions, that the deletion request is `erasing` and is the open request
   * of THIS workspace's organization. A cancel cannot land meanwhile: it refuses
   * anything but `scheduled`.
   *
   * `actorUserId` only fills the `app.user_id` binding the cascade's context
   * takes; the authority here is the request, not a person. The sweep passes the
   * Owner who scheduled it.
   */
  async deleteWorkspaceForOrganizationErasure(input: {
    workspaceId: string;
    requestId: string;
    actorUserId: string;
  }): Promise<void> {
    await deleteWorkspaceCascade({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      guard: async (tx) => {
        const organizationId = await workspaceRepository.findOrganizationId(input.workspaceId, tx);
        if (!organizationId) throw new WorkspaceNotFoundError(input.workspaceId);
        // The id comes from the workspace row just read — the trusted resolution
        // `bindOrganizationContext` requires.
        await bindOrganizationContext(tx, organizationId);
        const request =
          await organizationDeletionRequestRepository.findOpenByOrganizationIdForUpdate(
            organizationId,
            tx,
          );
        if (!request || request.id !== input.requestId || request.status !== 'erasing') {
          throw new OrganizationNotErasingError(organizationId);
        }
      },
    });
  },

  /**
   * Fetch a single workspace as a summary DTO, or null if the actor is
   * not a member (or the workspace doesn't exist). Asserts membership
   * first so a non-member can't read a workspace by id — this is the
   * application-layer tenant gate; RLS is the structural backstop. Used
   * by the settings page header / cards.
   */
  async getWorkspaceSummary(
    workspaceId: string,
    actorUserId: string,
  ): Promise<WorkspaceSummaryDTO | null> {
    // MOTIR-2527: ONE bound transaction for both reads. The `workspace` row is gated by
    // `workspace_active` / `workspace_membership_visible`, which read the same GUCs the
    // membership policy does — so binding the gate and then reading the workspace back
    // through the `db` singleton would trade a false "not a member" for a false
    // "workspace does not exist", which this method also renders as `null`.
    const workspace = await withWorkspaceContext(
      { userId: actorUserId, workspaceId },
      async (tx) => {
        // The org Owner reads a workspace they are not a member of (MOTIR-6308).
        const role = await readReachRole(actorUserId, workspaceId, tx);
        if (!role) return null;
        return workspaceRepository.findByIdInTx(workspaceId, tx);
      },
    );
    return workspace ? toWorkspaceSummaryDTO(workspace) : null;
  },

  /**
   * A Manager changes a member's WORKSPACE role (Story MOTIR-6168 · MOTIR-6463) —
   * to Manager, Member or Viewer, or to one of this workspace's custom roles
   * (`roleDefinitionId`, held at the `CUSTOM_WORKSPACE_ROLE_TIER`). The new role
   * is the person's role in every project of the workspace from their next
   * request: permissions resolve per call (`projectAccessService.resolveInputs`),
   * with no cache in front of them.
   *
   * Refusals, each before anything is written:
   *   * an unknown role value → InvalidWorkspaceRoleError (422);
   *   * the actor is not in the workspace → NotAMemberError (404), or is not its
   *     Manager → WorkspaceRoleForbiddenError (403). The org Owner and an org
   *     Admin are Managers with or without a membership (`readReachRole`);
   *   * the target is not a member → WorkspaceMemberNotFoundError (404);
   *   * the target is the org Owner or an org Admin → OrgManagedWorkspaceRoleError
   *     (409) — a Manager of every workspace by their org role, which only the
   *     organization changes (MOTIR-6456 panel 6a);
   *   * a custom role that is not this workspace's → RoleDefinitionNotFoundError
   *     (404, never confirming a foreign id exists);
   *   * the change would leave no Manager → LastManagerError (409).
   *
   * ⚠️ THE LAST-MANAGER GUARD IS A READ-DERIVED WRITE, so the Manager rows are
   * LOCKED (`countManagers` is `SELECT … FOR UPDATE`) before the target is read
   * and the guard decides. Two Managers demoting each other at once serialise on
   * it: the second wakes to committed state, counts one Manager left — the one
   * it is demoting — and is refused with LastManagerError.
   */
  async setMemberRole(input: {
    actorUserId: string;
    workspaceId: string;
    targetUserId: string;
    role: unknown;
    roleDefinitionId?: string | null;
  }): Promise<WorkspaceMemberRoleDTO> {
    const requested =
      typeof input.role === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(input.role)
        ? (input.role as WorkspaceRole)
        : null;
    if (!input.roleDefinitionId && !requested) {
      throw new InvalidWorkspaceRoleError(String(input.role));
    }

    return withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.workspaceId },
      async (tx) => {
        const actorRole = await readReachRole(input.actorUserId, input.workspaceId, tx);
        if (!actorRole) throw new NotAMemberError(input.actorUserId, input.workspaceId);
        if (actorRole !== 'manager') {
          throw new WorkspaceRoleForbiddenError(input.actorUserId, input.workspaceId);
        }

        // Lock the Manager rows BEFORE the reads the guard derives from.
        const managers = await workspaceMembershipRepository.countManagers(input.workspaceId, tx);

        const target = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
          input.targetUserId,
          input.workspaceId,
          tx,
        );
        if (!target) throw new WorkspaceMemberNotFoundError(input.targetUserId, input.workspaceId);

        const workspace = await workspaceRepository.findByIdInTx(input.workspaceId, tx);
        if (!workspace) throw new NotAMemberError(input.actorUserId, input.workspaceId);
        if (await isOrgManagerTarget(input.targetUserId, workspace, tx)) {
          throw new OrgManagedWorkspaceRoleError(input.targetUserId, input.workspaceId);
        }

        let destination: { workspaceRole: WorkspaceRole; roleDefinitionId: string | null };
        let customRole: { id: string; name: string } | null = null;
        if (input.roleDefinitionId) {
          const definition = await workspaceRoleDefinitionRepository.findById(
            input.roleDefinitionId,
            tx,
          );
          if (!definition || definition.workspaceId !== input.workspaceId) {
            throw new RoleDefinitionNotFoundError(input.roleDefinitionId);
          }
          destination = {
            workspaceRole: CUSTOM_WORKSPACE_ROLE_TIER,
            roleDefinitionId: definition.id,
          };
          customRole = { id: definition.id, name: definition.name };
        } else {
          destination = { workspaceRole: requested!, roleDefinitionId: null };
        }

        const targetIsManager = target.workspaceRole === 'manager';
        const remaining = managers - (targetIsManager ? 1 : 0);
        if (targetIsManager && destination.workspaceRole !== 'manager' && remaining < 1) {
          throw new LastManagerError(input.workspaceId);
        }

        await workspaceMembershipRepository.setWorkspaceRole(
          input.targetUserId,
          input.workspaceId,
          destination,
          tx,
        );
        return {
          userId: input.targetUserId,
          workspaceRole: destination.workspaceRole,
          customRole,
        };
      },
    );
  },

  /**
   * Set a member's ACCESS SCOPE — Full or Limited (Story MOTIR-6169 · MOTIR-6545;
   * `role-model.md` Q1). Manager-only, by the SAME gate `setMemberRole` uses
   * (`readReachRole`, so the org Owner or an org Admin qualifies), so the two
   * controls on one Members-page row share one authorisation story.
   *
   * Takes effect in every project of the workspace on the target's next request:
   * the entry rule reads the scope per request and nothing caches it.
   *
   * `limited` on a target whose effective role is Manager — the org Owner and
   * Admins included, member or not — is refused with `ScopeNotApplicableError`:
   * a Manager enters every project, so a stored Limited would be a lie on their
   * row. `full` on such a target is an idempotent no-op.
   *
   * ⚠️ NO LOCK, deliberately. The one read (is the target a Manager?) races only
   * with a concurrent promotion to Manager, and a Limited scope stored on a
   * Manager is harmless because the entry rule never reads it — a lock here
   * would protect nothing.
   */
  async setMemberAccessScope(input: {
    actorUserId: string;
    workspaceId: string;
    targetUserId: string;
    scope: unknown;
  }): Promise<WorkspaceMemberAccessScopeDTO> {
    const scope = asAccessScope(input.scope);
    if (!scope) throw new InvalidAccessScopeError(String(input.scope));

    return withWorkspaceContext(
      { userId: input.actorUserId, workspaceId: input.workspaceId },
      async (tx) => {
        const actorRole = await readReachRole(input.actorUserId, input.workspaceId, tx);
        if (!actorRole) throw new NotAMemberError(input.actorUserId, input.workspaceId);
        if (actorRole !== 'manager') {
          throw new AccessScopeForbiddenError(input.actorUserId, input.workspaceId);
        }

        const workspace = await workspaceRepository.findByIdInTx(input.workspaceId, tx);
        if (!workspace) throw new NotAMemberError(input.actorUserId, input.workspaceId);
        const target = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
          input.targetUserId,
          input.workspaceId,
          tx,
        );
        const targetIsManager =
          (target != null && target.workspaceRole === 'manager') ||
          (await isOrgManagerTarget(input.targetUserId, workspace, tx));
        if (targetIsManager) {
          // A Manager's scope is never read: Limited would be a lie, Full is the
          // truth already — answered without a write.
          if (scope === 'limited') {
            throw new ScopeNotApplicableError(input.targetUserId, input.workspaceId);
          }
          return { userId: input.targetUserId, accessScope: target?.accessScope ?? 'full' };
        }
        if (!target) throw new WorkspaceMemberNotFoundError(input.targetUserId, input.workspaceId);
        if (target.accessScope === scope) {
          return { userId: input.targetUserId, accessScope: scope };
        }
        const updated = await workspaceMembershipRepository.setAccessScope(
          input.targetUserId,
          input.workspaceId,
          scope,
          tx,
        );
        return { userId: updated.userId, accessScope: updated.accessScope };
      },
    );
  },

  /**
   * What the Members page draws its role column with (Story MOTIR-6168 ·
   * MOTIR-6465): whether the viewer may change roles (a Manager — their own
   * role, or the org Owner / an org Admin), which members the ORG makes a
   * Manager (locked rows), the org's name for their reason, and this
   * workspace's custom roles for the picker. The gate is decided HERE, on the
   * server; the client only receives the boolean.
   */
  async getMemberRoleContext(
    workspaceId: string,
    actorUserId: string,
  ): Promise<MemberRoleContextDTO> {
    return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
      const membership = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
        actorUserId,
        workspaceId,
        tx,
      );
      const role = await composeOwnerReach(actorUserId, workspaceId, membership, tx);
      if (!role) throw new NotAMemberError(actorUserId, workspaceId);
      const workspace = await workspaceRepository.findByIdInTx(workspaceId, tx);
      if (!workspace) throw new NotAMemberError(actorUserId, workspaceId);
      const customRoles = await workspaceRoleDefinitionRepository.findManyByWorkspace(
        workspaceId,
        tx,
      );
      const managers = await orgManagersOf(workspace, tx);
      const isManager = role === 'manager';
      // The invite's project picker offers the Manager's projects — every
      // non-archived project, since a Manager enters them all (Story MOTIR-6169 ·
      // MOTIR-6551, design W8). Nobody else can send a Limited invite, so nobody
      // else is handed the list.
      const projects = isManager ? await projectRepository.findByWorkspace(workspaceId, tx) : [];
      return {
        canManageRoles: isManager,
        // Who may invite (design W9, MOTIR-6546's rule): a Manager, or a Full
        // member (Full invites only). A Limited member gets no Invite at all.
        canInvite: isManager || (membership?.accessScope ?? 'full') === 'full',
        inviteProjects: projects.map((p) => ({ id: p.id, name: p.name, identifier: p.identifier })),
        orgManagedUserIds: managers.userIds,
        organizationName: managers.organizationName,
        customRoles: customRoles.map((r) => ({ id: r.id, name: r.name })),
      };
    });
  },

  /**
   * The projects one member was ADDED to — the Members page's "N projects"
   * popover (Story MOTIR-6169 · MOTIR-6551, design W3), read when it opens. Any
   * member may open it (the count is on every row), so the list is narrowed to
   * the projects the VIEWER can enter: a Limited viewer is never told the name
   * of a Members-only project they cannot open.
   */
  async listMemberAddedProjects(
    workspaceId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<MemberAddedProjectDTO[]> {
    const projects = await withWorkspaceContext(
      { userId: actorUserId, workspaceId },
      async (tx) => {
        const role = await readReachRole(actorUserId, workspaceId, tx);
        if (!role) throw new NotAMemberError(actorUserId, workspaceId);
        const added = await projectMembershipRepository.findProjectsByUserInWorkspace(
          targetUserId,
          workspaceId,
          tx,
        );
        return projectAccessService.filterBrowsable(
          added,
          { userId: actorUserId, workspaceId },
          tx,
        );
      },
    );
    return projects.map((p) => ({ id: p.id, name: p.name, identifier: p.identifier }));
  },

  /**
   * List the members of a workspace as DTOs for the settings Members
   * card. Reads inside withWorkspaceContext so the workspace_membership
   * RLS policy exposes the rows (it keys off the per-transaction GUCs).
   */
  async listMembers(
    workspaceId: string,
    actorUserId: string,
  ): Promise<WorkspaceMemberWithAccessDTO[]> {
    // The rows AND each person's added-project count in one context — the count
    // is ONE grouped query for the whole workspace (Story MOTIR-6169 · MOTIR-6545),
    // never a read per row.
    const { rows, added } = await withWorkspaceContext(
      { userId: actorUserId, workspaceId },
      async (tx) => ({
        rows: await workspaceMembershipRepository.findMembersByWorkspace(workspaceId, tx),
        added: await projectMembershipRepository.countProjectsByUserInWorkspace(workspaceId, tx),
      }),
    );
    return rows.map((row) => toWorkspaceMemberWithAccessDTO(row, added.get(row.userId) ?? 0));
  },

  /**
   * Asserts the user can ACCESS the workspace, throwing NotAMemberError
   * otherwise. Convenience for route handlers that want to gate without writing
   * a null-check by hand.
   *
   * Story 6.10.4: this now goes through the ORG access gate
   * (organizationsService.resolveWorkspaceAccess), so "access" means org
   * membership gates workspace access AND the org OWNER reaches every
   * workspace under the org (composed above the 6.4 workspace role; an org
   * Admin reaches by membership since MOTIR-6308). A user with
   * a stale workspace membership but no org membership is DENIED. The gate
   * self-binds withWorkspaceContext so the rows are RLS-visible.
   */
  async assertMembership(userId: string, workspaceId: string): Promise<void> {
    const access = await organizationsService.resolveWorkspaceAccess(userId, workspaceId);
    if (!access) throw new NotAMemberError(userId, workspaceId);
  },

  /**
   * The user's EFFECTIVE workspace role (`manager` | `member` | `viewer`), or null
   * if they have no access. Read-only — used by surfaces that gate an action on
   * the Manager (the jobs dashboard's Replay button, the 2FA policy switch).
   *
   * Story 6.10.4: the role composes the org tier above the workspace role — the
   * org Owner and an org Admin report `manager` on every workspace under the org
   * even with no workspace membership (MOTIR-6168); anyone else reports their own
   * workspace role; a non-org-member (no access) reports null. Callers ask
   * `isWorkspaceManager`.
   */
  async getMemberRole(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    const access = await organizationsService.resolveWorkspaceAccess(userId, workspaceId);
    return access?.effectiveRole ?? null;
  },
};
