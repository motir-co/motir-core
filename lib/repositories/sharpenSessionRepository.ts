import {
  Prisma,
  type SharpenEndReason,
  type SharpenScopeKind,
  type SharpenSession,
  type SharpenSessionStatus,
} from '@/generated/prisma/client';

// Single Prisma operations on the `sharpen_session` table (Task MOTIR-1101 ·
// Subtask MOTIR-8182). Writes require `tx`; every read takes the bound `tx`
// too, because the session store is read only inside the door's workspace
// transactions and an unbound read under the runtime role matches nothing. No
// business logic, no transactions, no DTO mapping — those belong to the Sharpen
// door's service (MOTIR-8181). The JSON columns are OPAQUE here: the service
// owns their shape and the mapper types them.
//
// RLS gates every row on `app.workspace_id`; the `workspaceId` argument on the
// reads is the belt-and-braces app-level scope, so an id from another tenant
// resolves to null (→ 404), never to a row.

/** The fields a session is created with. */
export interface SharpenSessionCreate {
  workspaceId: string;
  projectId: string;
  createdById: string;
  scopeKind: SharpenScopeKind;
  planId?: string | null;
  planChangeSessionId?: string | null;
}

/**
 * The session's RUNNING STATE, as the door writes it after a turn — every field
 * optional, `null` clears a nullable one. The JSON values are stored as given.
 */
export interface SharpenSessionStatePatch {
  status?: SharpenSessionStatus;
  endReason?: SharpenEndReason | null;
  pendingQuestion?: unknown;
  settled?: unknown;
  assumptions?: unknown;
  writeBack?: unknown;
  lastActivityAt?: Date;
}

/** Which target an open-session read is about. */
export type SharpenTargetRef = { planId: string } | { planChangeSessionId: string };

function nullableJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function toUpdate(patch: SharpenSessionStatePatch): Prisma.SharpenSessionUncheckedUpdateInput {
  const data: Prisma.SharpenSessionUncheckedUpdateInput = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.endReason !== undefined) data.endReason = patch.endReason;
  if (patch.pendingQuestion !== undefined)
    data.pendingQuestion = nullableJson(patch.pendingQuestion);
  if (patch.settled !== undefined) data.settled = patch.settled as Prisma.InputJsonValue;
  if (patch.assumptions !== undefined)
    data.assumptions = patch.assumptions as Prisma.InputJsonValue;
  if (patch.writeBack !== undefined) data.writeBack = nullableJson(patch.writeBack);
  if (patch.lastActivityAt !== undefined) data.lastActivityAt = patch.lastActivityAt;
  return data;
}

export const sharpenSessionRepository = {
  /** Open a session. A second OPEN session for the same person and target
   *  fails the partial unique index (P2002) — the open-race backstop. */
  async create(data: SharpenSessionCreate, tx: Prisma.TransactionClient): Promise<SharpenSession> {
    return tx.sharpenSession.create({
      data: {
        workspaceId: data.workspaceId,
        projectId: data.projectId,
        createdById: data.createdById,
        scopeKind: data.scopeKind,
        planId: data.planId ?? null,
        planChangeSessionId: data.planChangeSessionId ?? null,
      },
    });
  },

  /** One session BY ID, scoped to a project and workspace — null for an id of
   *  another project or tenant, so the caller refuses rather than writes. */
  async findByIdInProject(
    id: string,
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<SharpenSession | null> {
    return tx.sharpenSession.findFirst({ where: { id, projectId, workspaceId } });
  },

  /** Take the session's row lock (`SELECT … FOR UPDATE`), serializing a turn's
   *  append and state write against a concurrent one on the same session.
   *  Returns the id, or null when there is no such row in this workspace. */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "sharpen_session" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /** This person's OPEN session on a target, or null — the resume read. At most
   *  one exists (the partial unique indexes). Another person's session on the
   *  same target is never returned. */
  async findOpenForUser(
    target: SharpenTargetRef,
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<SharpenSession | null> {
    return tx.sharpenSession.findFirst({
      where: { ...target, workspaceId, createdById: userId, status: 'open' },
    });
  },

  /** This person's LATEST session on a conversation, open or ended, or null —
   *  the settled read the plan submit carries into the run (MOTIR-9314). */
  async findLatestByConversation(
    planChangeSessionId: string,
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<SharpenSession | null> {
    return tx.sharpenSession.findFirst({
      where: { planChangeSessionId, workspaceId, createdById: userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** Write the session's running state. */
  async updateState(
    id: string,
    patch: SharpenSessionStatePatch,
    tx: Prisma.TransactionClient,
  ): Promise<SharpenSession> {
    return tx.sharpenSession.update({ where: { id }, data: toUpdate(patch) });
  },
};
