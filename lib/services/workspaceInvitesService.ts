import { randomBytes } from 'node:crypto';
import type { Prisma, WorkspaceAccessScope } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { resolveRecipientLocale } from '@/lib/services/emailRecipientLocale';
import type {
  AcceptInviteResultDTO,
  InspectInviteResultDTO,
  PendingInviteDTO,
  SendInviteResultDTO,
  ValidateInviteResultDTO,
} from '@/lib/dto/invites';
import {
  toInviteDeliveryState,
  toPendingInviteDTO,
  toValidateInviteResultDTO,
} from '@/lib/mappers/inviteMappers';
import { emailDeliveryRepository } from '@/lib/repositories/emailDeliveryRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { verificationRepository } from '@/lib/repositories/verificationRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { readMembership, readReachRole } from '@/lib/workspaces/membershipGate';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { asAccessScope } from '@/lib/projects/accessMode';
import { WORKSPACE_ROLES, type WorkspaceRole } from '@/lib/workspaces/roles';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { organizationsService } from '@/lib/services/organizationsService';
import { enqueueScaledTrackerSeatSync } from '@/lib/billing/seatSync';
import { isEmailShape } from '@/lib/utils/email';
import {
  AlreadyMemberError,
  InvalidAccessScopeError,
  InvalidEmailError,
  InviteEmailMismatchError,
  InviteExpiredOrMissingError,
  InviteNotAllowedForScopeError,
  InviteProjectInvalidError,
  InviteProjectsRequireLimitedError,
  InviteRateLimitedError,
  InviteScopeForbiddenError,
  InviteTargetAlreadyMemberError,
  NotAMemberError,
} from '@/lib/workspaces/errors';

// Workspace invites service — owns the entire send / validate / accept
// flow. Per CLAUDE.md, this is the layer where:
//   - Multi-row writes happen inside $transaction
//   - Typed domain errors are thrown
//   - Prisma rows are mapped to DTOs before returning
//
// Tokens live in the Verification table (Subtask 1.1.3) with the
// `workspace-invite:` identifier prefix. The `value` column carries
// JSON `{ workspaceId, email, workspaceRole, inviterUserId, accessScope,
// projectIds }` (the last two since Story MOTIR-6169 · MOTIR-6546; a payload
// written before that parses as `full` / `[]`). The existing
// `@@index([identifier])` makes prefix-scoped lookups (validate,
// rate-limit) cheap.

export const INVITE_IDENTIFIER_PREFIX = 'workspace-invite:';
export const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_RATE_LIMIT = {
  windowMs: 60 * 60 * 1000,
  max: 3,
} as const;

const TOKEN_BYTES = 24;

/** The job that sends an invite email; its runs are keyed on the token. */
const EMAIL_SEND_FUNCTION_ID = 'email.send';

/**
 * The most pending invitations the list reads (MOTIR-9995). A safety cap, far
 * above what a workspace holds at once: the rate limit allows three sends per
 * address per hour and each lapses after `INVITE_EXPIRY_MS`.
 */
const PENDING_INVITES_LIMIT = 200;

// The payload's role is `workspaceRole` — the role the membership is created
// with. Until MOTIR-6569 a token also carried the legacy `role` (and one minted
// before MOTIR-6562 carried ONLY that). Every such token lapsed after
// `INVITE_EXPIRY_MS`, so a payload with no `workspaceRole` is refused.
interface InvitePayload {
  workspaceId: string;
  email: string;
  workspaceRole: WorkspaceRole;
  inviterUserId: string;
  /** Full or Limited (Story MOTIR-6169 · MOTIR-6546). */
  accessScope: WorkspaceAccessScope;
  /** The projects a Limited invite joins on accept — empty on a Full one. */
  projectIds: string[];
  /**
   * Who pressed Resend, when this row replaced an earlier invitation
   * (MOTIR-9996). Optional, so every older payload still parses; the inviter
   * above stays the ORIGINAL one.
   */
  resentByUserId?: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function parsePayload(value: string): InvitePayload | null {
  try {
    const parsed = JSON.parse(value) as InvitePayload;
    if (
      typeof parsed.workspaceId !== 'string' ||
      typeof parsed.email !== 'string' ||
      typeof parsed.inviterUserId !== 'string'
    ) {
      return null;
    }
    // A payload naming no workspace role this build recognises — a pre-MOTIR-6562
    // token carrying only the legacy `role`, among others — is not an invite this
    // build can honour.
    if (!(WORKSPACE_ROLES as readonly string[]).includes(parsed.workspaceRole)) return null;
    // An invite sent before MOTIR-6546 carries no scope and no projects: it is a
    // FULL invite naming no project, exactly what every invite meant then.
    return {
      workspaceId: parsed.workspaceId,
      email: parsed.email,
      workspaceRole: parsed.workspaceRole,
      inviterUserId: parsed.inviterUserId,
      accessScope: asAccessScope(parsed.accessScope) ?? 'full',
      projectIds: Array.isArray(parsed.projectIds)
        ? parsed.projectIds.filter((id): id is string => typeof id === 'string')
        : [],
      ...(typeof parsed.resentByUserId === 'string'
        ? { resentByUserId: parsed.resentByUserId }
        : {}),
    };
  } catch {
    return null;
  }
}

function buildInviteAcceptUrl(token: string): string {
  return `${resolveBaseUrlTrimmed()}/invite/accept?token=${encodeURIComponent(token)}`;
}

/**
 * Write a new invitation row for `payload` with a fresh token and a fresh
 * `INVITE_EXPIRY_MS` expiry, returning the token. Shared by `sendInvite` and
 * `resendInvite`; a write, so it takes the caller's transaction.
 */
async function mintInvite(payload: InvitePayload, tx: Prisma.TransactionClient): Promise<string> {
  const token = generateToken();
  await verificationRepository.create(
    {
      identifier: INVITE_IDENTIFIER_PREFIX + token,
      value: JSON.stringify(payload),
      expiresAt: new Date(Date.now() + INVITE_EXPIRY_MS),
    },
    tx,
  );
  return token;
}

async function enqueueInviteEmail(args: {
  workspaceId: string;
  inviterName: string;
  workspaceName: string;
  recipientEmail: string;
  inviterUserId: string;
  token: string;
}): Promise<void> {
  // Enqueue the send (Story 1.6.3) instead of dispatching inline: the
  // provider call moves to the durable `email.send` job (with retries), and
  // sendInvite returns as soon as the event is published. The template still
  // renders in lib/emailTemplates/ — here in the job via emailService — so
  // this service never builds subject/body strings itself. We pass the
  // fully-built accept URL as a template prop; the job stays env-agnostic.
  //
  //   - workspaceId: the inviting workspace (a real, tenanted email).
  //   - idempotencyKey: the invite token (unique per invite) — a retried
  //     send Action dedups to one delivery within the dedup window.
  await sendEvent('email.send', {
    workspaceId: args.workspaceId,
    idempotencyKey: args.token,
    to: args.recipientEmail,
    template: 'workspace-invite',
    data: {
      inviterName: args.inviterName,
      workspaceName: args.workspaceName,
      acceptUrl: buildInviteAcceptUrl(args.token),
      // The RECIPIENT's language: the saved language of the account that holds
      // the invited address, else (no account yet) the inviter's saved
      // language, else English. Never the inviter's request. Rendered
      // off-request in the email.send job, so the locale rides the payload.
      locale: await resolveRecipientLocale({
        email: args.recipientEmail,
        recordedLocale: await resolveRecipientLocale({ userId: args.inviterUserId }),
      }),
    },
  });
}

export const workspaceInvitesService = {
  /**
   * Send an invite. Gates on:
   *   - inviter is a member of the workspace (else NotAMemberError)
   *   - email shape is valid (else InvalidEmailError)
   *   - target email isn't already a workspace member (else
   *     InviteTargetAlreadyMemberError)
   *   - we haven't sent ≥3 invites to (workspaceId, email) in the last
   *     hour (else InviteRateLimitedError)
   *
   * Then creates a Verification row with the token + payload and ENQUEUES
   * the invite email as an `email.send` job (Story 1.6.3). The create +
   * enqueue are NOT atomic — if enqueue fails after the token is created,
   * the user can retry; the wasted token cleans up via expiry. That's the
   * standard trade-off for any "write-then-side-effect" flow. Delivery
   * itself is now durable: once enqueued, the job retries the provider call
   * and lands terminal failures in the jobs dashboard rather than dropping
   * them on the request path.
   */
  async sendInvite(args: {
    inviterUserId: string;
    inviterName: string;
    workspaceId: string;
    targetEmail: string;
    /** Full (the default) or Limited — Story MOTIR-6169 · MOTIR-6546. */
    accessScope?: unknown;
    /** For a Limited invite, the projects the person joins on accept. */
    projectIds?: readonly string[];
  }): Promise<SendInviteResultDTO> {
    const email = normalizeEmail(args.targetEmail);
    if (!isEmailShape(email)) throw new InvalidEmailError();
    const accessScope = args.accessScope === undefined ? 'full' : asAccessScope(args.accessScope);
    if (!accessScope) throw new InvalidAccessScopeError(String(args.accessScope));
    const projectIds = [...new Set(args.projectIds ?? [])];
    if (accessScope === 'full' && projectIds.length > 0) {
      throw new InviteProjectsRequireLimitedError();
    }

    // Inviter must be a workspace member.
    const inviterMembership = await readMembership(args.inviterUserId, args.workspaceId);
    if (!inviterMembership) {
      throw new NotAMemberError(args.inviterUserId, args.workspaceId);
    }

    // THE SCOPE RULES (MOTIR-6546) — the escalation a Limited scope would
    // otherwise open. A Manager (the org Owner and Admins compose in as one) may
    // send any invite; a Full non-Manager only a Full one, as before; a Limited
    // member none at all — a contractor must not bring in a colleague who arrives
    // Full and sees every project they cannot.
    const inviterIsManager =
      (await readReachRole(args.inviterUserId, args.workspaceId)) === 'manager';
    if (!inviterIsManager) {
      if (inviterMembership.accessScope === 'limited') {
        throw new InviteNotAllowedForScopeError(args.inviterUserId, args.workspaceId);
      }
      if (accessScope === 'limited' || projectIds.length > 0) {
        throw new InviteScopeForbiddenError(args.inviterUserId, args.workspaceId);
      }
    }
    if (projectIds.length > 0) {
      // Every named project must be a live project of THIS workspace — read
      // under the workspace binding, so another workspace's project is simply
      // absent and refused like a missing one.
      const found = await withWorkspaceContext(
        { userId: args.inviterUserId, workspaceId: args.workspaceId },
        (tx) => projectRepository.findManyLiveByIds(projectIds, tx),
      );
      const live = new Set(
        found.filter((p) => p.workspaceId === args.workspaceId).map((p) => p.id),
      );
      const bad = projectIds.find((id) => !live.has(id));
      if (bad) throw new InviteProjectInvalidError(bad);
    }

    // Block invites to addresses already in the workspace. Only
    // resolves a membership when the email maps to an existing user
    // — an invite to a brand-new email is fine.
    const existingUser = await userRepository.findByEmail(email);
    if (existingUser) {
      // MOTIR-2527: an unbound read here fails OPEN, not closed — a `null` reads as
      // "not a member yet", so the already-a-member guard stops firing and the invite
      // is sent to someone who is already in the workspace.
      const targetMembership = await readMembership(existingUser.id, args.workspaceId);
      if (targetMembership) {
        throw new InviteTargetAlreadyMemberError(email, args.workspaceId);
      }
    }

    // Rate limit BEFORE writing so a 4th attempt never persists a row
    // and never spams the inbox.
    const recent = await verificationRepository.countByIdentifierPrefixAndValueAndSince({
      identifierPrefix: INVITE_IDENTIFIER_PREFIX,
      valueContainsAll: [args.workspaceId, email],
      since: new Date(Date.now() - INVITE_RATE_LIMIT.windowMs),
    });
    if (recent >= INVITE_RATE_LIMIT.max) {
      throw new InviteRateLimitedError(INVITE_RATE_LIMIT.max);
    }

    // MOTIR-2527: bound, like the gate above it. This read RE-RAISES `NotAMemberError`
    // on a null, so leaving it on the `db` singleton would have handed back exactly the
    // error the gate was fixed to stop producing — a member admitted by the gate and
    // then refused, four statements later, by an invisible `workspace` row
    // (`workspace_active` reads the same per-transaction GUCs).
    const workspace = await withWorkspaceContext(
      { userId: args.inviterUserId, workspaceId: args.workspaceId },
      (tx) => workspaceRepository.findByIdInTx(args.workspaceId, tx),
    );
    if (!workspace) {
      // Race: workspace deleted between the membership check and now.
      // Treat as NotAMember — the inviter no longer has membership.
      throw new NotAMemberError(args.inviterUserId, args.workspaceId);
    }

    const payload: InvitePayload = {
      workspaceId: args.workspaceId,
      email,
      workspaceRole: 'member',
      inviterUserId: args.inviterUserId,
      accessScope,
      projectIds,
    };
    const token = await db.$transaction((tx) => mintInvite(payload, tx));

    await enqueueInviteEmail({
      workspaceId: args.workspaceId,
      inviterName: args.inviterName,
      workspaceName: workspace.name,
      recipientEmail: email,
      inviterUserId: args.inviterUserId,
      token,
    });

    return { ok: true };
  },

  /**
   * Replace a pending invitation with a fresh one (MOTIR-9996): a new token, a
   * new seven-day expiry and a new email, while the earlier link stops working.
   * `inviteId` is the invitation row's id, never the token — the token is the
   * credential.
   *
   * Refusals, in order, each writing nothing: a row that is missing, expired,
   * retired, not an invitation or of another workspace is
   * `InviteExpiredOrMissingError` (one answer, so existence is not leaked);
   * then `sendInvite`'s own gates against the stored payload — membership,
   * the scope rules, already-a-member, and the hourly limit. The limit counts
   * the original and every earlier Resend, because a retired row is kept.
   *
   * The new row and the retire of the old one are one transaction; a retire
   * that finds the row already gone throws there, so two concurrent Resends
   * leave exactly one live link. The email is enqueued after the commit, as in
   * `sendInvite`: if that enqueue fails, the old link is already dead and the
   * new row has no email — it lists as queued or failed, and Resend can be
   * pressed again.
   */
  async resendInvite(args: {
    actorUserId: string;
    actorName: string;
    workspaceId: string;
    inviteId: string;
  }): Promise<SendInviteResultDTO> {
    const row = await verificationRepository.findById(args.inviteId);
    if (
      !row ||
      !row.identifier.startsWith(INVITE_IDENTIFIER_PREFIX) ||
      row.expiresAt.getTime() <= Date.now()
    ) {
      throw new InviteExpiredOrMissingError();
    }
    const stored = parsePayload(row.value);
    if (!stored || stored.workspaceId !== args.workspaceId) {
      throw new InviteExpiredOrMissingError();
    }

    const actorMembership = await readMembership(args.actorUserId, args.workspaceId);
    if (!actorMembership) throw new NotAMemberError(args.actorUserId, args.workspaceId);
    const actorIsManager = (await readReachRole(args.actorUserId, args.workspaceId)) === 'manager';
    if (!actorIsManager) {
      if (actorMembership.accessScope === 'limited') {
        throw new InviteNotAllowedForScopeError(args.actorUserId, args.workspaceId);
      }
      if (stored.accessScope === 'limited' || stored.projectIds.length > 0) {
        throw new InviteScopeForbiddenError(args.actorUserId, args.workspaceId);
      }
    }

    const existingUser = await userRepository.findByEmail(stored.email);
    if (existingUser && (await readMembership(existingUser.id, args.workspaceId))) {
      throw new InviteTargetAlreadyMemberError(stored.email, args.workspaceId);
    }

    const recent = await verificationRepository.countByIdentifierPrefixAndValueAndSince({
      identifierPrefix: INVITE_IDENTIFIER_PREFIX,
      valueContainsAll: [args.workspaceId, stored.email],
      since: new Date(Date.now() - INVITE_RATE_LIMIT.windowMs),
    });
    if (recent >= INVITE_RATE_LIMIT.max) {
      throw new InviteRateLimitedError(INVITE_RATE_LIMIT.max);
    }

    // Bound, for the reason `sendInvite` gives on the same read.
    const workspace = await withWorkspaceContext(
      { userId: args.actorUserId, workspaceId: args.workspaceId },
      (tx) => workspaceRepository.findByIdInTx(args.workspaceId, tx),
    );
    if (!workspace) throw new NotAMemberError(args.actorUserId, args.workspaceId);

    // Bound like the read above, so nothing in the transaction runs dark.
    const token = await withWorkspaceContext(
      { userId: args.actorUserId, workspaceId: args.workspaceId },
      async (tx) => {
        const minted = await mintInvite(
          {
            workspaceId: stored.workspaceId,
            email: stored.email,
            workspaceRole: stored.workspaceRole,
            inviterUserId: stored.inviterUserId,
            accessScope: stored.accessScope,
            projectIds: stored.projectIds,
            resentByUserId: args.actorUserId,
          },
          tx,
        );
        const retired = await verificationRepository.retireUnexpiredByIdentifier(
          row.identifier,
          tx,
        );
        if (retired === 0) throw new InviteExpiredOrMissingError();
        return minted;
      },
    );

    // The email names whoever pressed Resend; the list keeps the original inviter.
    await enqueueInviteEmail({
      workspaceId: args.workspaceId,
      inviterName: args.actorName,
      workspaceName: workspace.name,
      recipientEmail: stored.email,
      inviterUserId: args.actorUserId,
      token,
    });

    return { ok: true };
  },

  /**
   * The workspace's pending invitations, newest first, each with what became of
   * its email (MOTIR-9995). Gated exactly like `sendInvite`'s inviter: a
   * non-member gets `NotAMemberError` and a Limited member
   * `InviteNotAllowedForScopeError`, so the list is shown to precisely the
   * people who may invite — whoever may not invite must not see who was invited.
   *
   * The delivery and failed-send reads run under `withWorkspaceContext`:
   * `email_delivery` is FORCE row-level security, and an unbound read returns a
   * smaller, believable list that would show every invitation as `queued`.
   *
   * `canResend` is decided here so the page never re-derives the scope rules: a
   * Manager may resend any invitation, a Full non-Manager only a Full one.
   */
  async listPendingInvites(args: {
    userId: string;
    workspaceId: string;
  }): Promise<PendingInviteDTO[]> {
    const membership = await readMembership(args.userId, args.workspaceId);
    if (!membership) throw new NotAMemberError(args.userId, args.workspaceId);
    const isManager = (await readReachRole(args.userId, args.workspaceId)) === 'manager';
    if (!isManager && membership.accessScope === 'limited') {
      throw new InviteNotAllowedForScopeError(args.userId, args.workspaceId);
    }

    const rows = await verificationRepository.listPendingByIdentifierPrefixAndValue({
      identifierPrefix: INVITE_IDENTIFIER_PREFIX,
      valueContains: args.workspaceId,
      now: new Date(),
      limit: PENDING_INVITES_LIMIT,
    });
    // The substring filter only narrows; the parsed payload is the proof.
    const pending = rows.flatMap((row) => {
      const payload = parsePayload(row.value);
      if (!payload || payload.workspaceId !== args.workspaceId) return [];
      return [{ row, payload, token: row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length) }];
    });
    if (pending.length === 0) return [];

    const tokens = pending.map((p) => p.token);
    const { deliveries, failedKeys } = await withWorkspaceContext(
      { userId: args.userId, workspaceId: args.workspaceId },
      async (tx) => ({
        deliveries: await emailDeliveryRepository.listByIdempotencyKeys(tokens, tx),
        failedKeys: await jobRunRepository.listFailedKeysByFunctionAndIdempotencyKeys(
          args.workspaceId,
          EMAIL_SEND_FUNCTION_ID,
          tokens,
          tx,
        ),
      }),
    );
    const deliveryByKey = new Map(
      deliveries
        .filter((d) => d.idempotencyKey !== null)
        .map((d) => [d.idempotencyKey as string, d]),
    );
    const failed = new Set(failedKeys);

    const inviterIds = [...new Set(pending.map((p) => p.payload.inviterUserId))];
    const inviters = await Promise.all(inviterIds.map((id) => userRepository.findById(id)));
    const nameById = new Map(inviterIds.map((id, i) => [id, inviters[i]?.name ?? null]));

    return pending.map(({ row, payload, token }) =>
      toPendingInviteDTO({
        id: row.id,
        email: payload.email,
        accessScope: payload.accessScope,
        projectIds: payload.projectIds,
        inviterUserId: payload.inviterUserId,
        inviterName: nameById.get(payload.inviterUserId) ?? null,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        deliveryState: toInviteDeliveryState({
          delivery: deliveryByKey.get(token) ?? null,
          sendFailed: failed.has(token),
        }),
        canResend: isManager || payload.accessScope === 'full',
      }),
    );
  },

  /**
   * Validate a token for the acceptance UI. Returns null on missing OR
   * expired (collapsed so the UI can't accidentally distinguish "I
   * know this token but it expired" from "I don't recognize this
   * token" — both are 404 to the world).
   *
   * Returns the DTO, not the raw payload, so the route can JSON-spread
   * the result directly.
   */
  async validateInvite(token: string): Promise<ValidateInviteResultDTO | null> {
    const row = await verificationRepository.findByIdentifier(INVITE_IDENTIFIER_PREFIX + token);
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;

    const payload = parsePayload(row.value);
    if (!payload) return null;

    // BOUND, and actorless (MOTIR-2777). Both PRE-AUTH inspections below run with no
    // session at all — the person holding the link may not have an account yet — so
    // there is no user context to derive, and `withWorkspaceServiceContext` (the
    // userless helper MOTIR-2685 established) binds the workspace tier alone. Left on
    // the singleton, `workspace_active` sees no GUC, the row is invisible, and every
    // VALID invite renders as an invalid one. This is the same fix the inviter-side
    // read above already carries from MOTIR-2527.
    //
    // The helper's constraint — `workspaceId` must come from the layer above, never
    // from caller input — holds: it is read out of the server-stored verification row
    // this method just validated, not off the request.
    // MOTIR-3077 — bucket B (peer reads), left on `Promise.all` deliberately.
    // Missing, expired and unparseable are all returned above, so this only
    // runs for a token already known good, and `findById` resolves to `null`
    // for a deleted inviter rather than rejecting.
    const [workspace, inviter] = await Promise.all([
      withWorkspaceServiceContext(payload.workspaceId, (tx) =>
        workspaceRepository.findByIdInTx(payload.workspaceId, tx),
      ),
      userRepository.findById(payload.inviterUserId),
    ]);
    if (!workspace) return null;

    return toValidateInviteResultDTO({ workspace, inviter, email: payload.email });
  },

  /**
   * Inspect a token for the acceptance PAGE (not the public GET
   * endpoint). Unlike validateInvite — which collapses missing/expired
   * to null so the world can't distinguish them — this returns a
   * discriminated status so the acceptance page can render the three
   * distinct mockup states:
   *   - 'valid'   → row present, unexpired, payload + workspace resolve
   *   - 'expired' → row present but past expiresAt
   *   - 'used'    → row absent (consumed on a prior accept, or never
   *                 existed — both render as "already used", which is the
   *                 honest framing for a user who reached the page via a
   *                 real link that no longer resolves)
   *
   * This is safe to expose to the signed-in invitee on the gated
   * /invite/accept route; it is NOT mounted as a public endpoint.
   */
  async inspectInvite(token: string): Promise<InspectInviteResultDTO> {
    const row = await verificationRepository.findByIdentifier(INVITE_IDENTIFIER_PREFIX + token);
    if (!row) return { status: 'used' };
    if (row.expiresAt.getTime() <= Date.now()) return { status: 'expired' };

    const payload = parsePayload(row.value);
    if (!payload) return { status: 'used' };

    // Bound + actorless for the reason given on `validateInvite` above; unbound this
    // reported every live invite as 'used'.
    // MOTIR-3077 — bucket B (peer reads), left on `Promise.all` deliberately.
    // Missing, expired and unparseable are all returned above, so this only
    // runs for a token already known good, and `findById` resolves to `null`
    // for a deleted inviter rather than rejecting.
    const [workspace, inviter] = await Promise.all([
      withWorkspaceServiceContext(payload.workspaceId, (tx) =>
        workspaceRepository.findByIdInTx(payload.workspaceId, tx),
      ),
      userRepository.findById(payload.inviterUserId),
    ]);
    if (!workspace) return { status: 'used' };

    const dto = toValidateInviteResultDTO({ workspace, inviter, email: payload.email });
    return { status: 'valid', ...dto };
  },

  /**
   * Accept an invite. Validates the session user's email matches the
   * invite's. In one transaction:
   *   - Create the WorkspaceMembership row
   *   - Delete the Verification row
   *
   * Idempotent: if the user is already a member (AlreadyMemberError
   * from the membership create), we still consume the token so a
   * second-tab accept is a clean no-op.
   */
  async acceptInvite(
    token: string,
    sessionUser: { id: string; email: string },
  ): Promise<AcceptInviteResultDTO> {
    const row = await verificationRepository.findByIdentifier(INVITE_IDENTIFIER_PREFIX + token);
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      throw new InviteExpiredOrMissingError();
    }
    const payload = parsePayload(row.value);
    if (!payload) throw new InviteExpiredOrMissingError();

    const sessionEmail = sessionUser.email.trim().toLowerCase();
    if (sessionEmail !== payload.email) {
      throw new InviteEmailMismatchError(payload.email);
    }

    let organizationId: string | null = null;
    let skippedProjects: string[] = [];
    await db.$transaction(async (tx) => {
      // BIND THE TENANT GUCs (MOTIR-2777). The tenant-root INSERT policies from
      // `20260810001000_tenant_root_insert_policies` admit a membership row on two
      // arms, and arm 1 — "acting inside the active tenant" — was written for THIS
      // caller; its migration comment names the invite path explicitly. Unbound,
      // `current_setting(…, true)` is NULL, the predicate is NULL, and every write
      // below is refused with `new row violates row-level security policy`. Set
      // per-transaction (`set_config(…, true)`), so they die with the transaction —
      // the same shape `insertWorkspaceWithOwner` uses for the bootstrap path.
      //
      // WHY BINDING THE ACTIVE-WORKSPACE GUC IS LEGITIMATE HERE, since a reader will
      // ask: the authority is the INVITATION, and it has already been validated above
      // this transaction — the verification row exists, has not expired, and its email
      // matches the session user's. The bind admits only rows targeting that one
      // workspace, and this transaction does nothing beyond the membership, the
      // upward org-join and consuming the token. It grants no reach the invite does
      // not already carry, and it is NOT the self-join arm the migration deliberately
      // refused (that would key on `app.user_id` and admit any workspace a user can
      // name; this keys on the workspace the invite names).
      await tx.$executeRaw`SELECT set_config('app.user_id', ${sessionUser.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${payload.workspaceId}, true)`;
      try {
        await workspaceMembershipRepository.create(
          {
            userId: sessionUser.id,
            workspaceId: payload.workspaceId,
            // Every invite is minted `member` (`invite` above), so an accepted
            // invite lands as a workspace Member (MOTIR-6462).
            workspaceRole: payload.workspaceRole,
            // The scope rides the SAME insert, so a Limited invitee never exists
            // for a moment as a Full member (MOTIR-6546).
            accessScope: payload.accessScope,
          },
          tx,
        );
      } catch (err) {
        // Idempotency: P2002 on (userId, workspaceId) means the user
        // is already a member. Still consume the token below.
        const isUnique =
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code?: string }).code === 'P2002';
        if (!isUnique) throw err;
      }
      // Story 6.10.4 — the UPWARD membership invariant (6.10.2 §5i): you cannot
      // be in a workspace without being in its org, and the org access gate
      // (organizationsService.resolveWorkspaceAccess) DENIES a workspace member
      // who isn't an org member. Accepting a cross-org invite must therefore
      // also enrol the invitee in the workspace's org, in the SAME transaction —
      // otherwise the post-accept active-workspace resolution can't reach the
      // joined workspace. (Mirrors workspacesService.addMember's auto-join; the
      // invite-accept path creates the membership directly, so it carries the
      // same invariant.) Idempotent on an already-member.
      const workspace = await workspaceRepository.findByIdInTx(payload.workspaceId, tx);
      if (workspace) {
        organizationId = workspace.organizationId;
        // The org tier needs its OWN GUC, and only now can it be bound: the org id
        // is not known until the workspace read above, which itself needed
        // `app.workspace_id` to return anything at all. Unbound, the org-membership
        // INSERT is refused by `org_membership_insert_active_or_bootstrap`.
        //
        // ⚠️ This read failing silently is what made the bug two bugs. With no
        // workspace GUC bound, `findByIdInTx` returned null, `if (workspace)` was
        // false, and the upward org-join was SKIPPED WITHOUT AN ERROR — leaving a
        // workspace member who is not an org member, which is exactly what the
        // 6.10.2 §5i invariant forbids and what `resolveWorkspaceAccess` then reads
        // as no access. A test that only asserts the workspace membership cannot see
        // it, which is why the regression test asserts BOTH rows.
        await tx.$executeRaw`SELECT set_config('app.organization_id', ${workspace.organizationId}, true)`;
        await organizationsService.ensureOrgMembership(
          sessionUser.id,
          workspace.organizationId,
          tx,
        );
      }
      // A Limited invite's projects join in the SAME transaction (MOTIR-6546):
      // there is no window in which the person is a Limited member of nothing. A
      // project archived since the send is skipped and named back; one deleted
      // since has nothing left to name.
      if (payload.projectIds.length > 0) {
        const named = await projectRepository.findManyByIds(payload.projectIds, tx);
        const inWorkspace = named.filter((p) => p.workspaceId === payload.workspaceId);
        const live = inWorkspace.filter((p) => p.archivedAt == null);
        skippedProjects = inWorkspace.filter((p) => p.archivedAt != null).map((p) => p.name);
        await projectMembershipRepository.createManySkipDuplicates(
          live.map((p) => ({
            workspaceId: payload.workspaceId,
            projectId: p.id,
            userId: sessionUser.id,
          })),
          tx,
        );
      }
      await verificationRepository.deleteByIdentifier(INVITE_IDENTIFIER_PREFIX + token, tx);
    });

    // Committed → resync the org's scaled-tracker seat quantity (8.1.12): a new
    // invitee enrolling in the org grows its member count. Best-effort + OUTSIDE
    // the tx (a billing failure must never fail the accept); idempotent absolute
    // set, so it no-ops for an already-member or a non-scaled org.
    if (organizationId) await enqueueScaledTrackerSeatSync(organizationId);

    return { workspaceId: payload.workspaceId, skippedProjects };
  },
};

// Re-export the error type so route handlers can `catch` without
// importing AlreadyMemberError from two places.
export { AlreadyMemberError };
