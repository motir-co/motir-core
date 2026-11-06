import { createHash } from 'node:crypto';
import type { PlanItem, Prisma } from '@/generated/prisma/client';
import type { StampInputs } from '@/lib/approvalGates/stamp';
import { planItemRepository } from '@/lib/repositories/planItemRepository';

// THE PLAN GATE'S SUBJECT VERSION — a digest of the PROPOSAL SET (Story MOTIR-6012 ·
// Subtask MOTIR-6035; ADR `docs/decisions/approval-gates.md` §11.3).
//
// ⚠️ THE ONLY DEFINITION IN THE REPO, and it sits beside `stamp.ts` for the reason that
// file gives for itself: the render read (`approvalGatesService.getForPlan`) and the
// decide door (through `planApprovalGateHandler.subjectVersion`) both call it, and two
// implementations would be two answers to *did this change?*.
//
// ⚠️ ITS INPUTS ARE ENUMERATED BY §11.3 AND NOTHING ELSE. Every `PlanItem` of the plan,
// sorted by id (byte order), each as exactly `{ id, op, workItemId, parentRef,
// blockedByRefs, proposedFields, patch, baseRevision }`. The CONTENT is hashed because a
// deepen or a correction rewrites a proposal in place — an id-only digest would not move
// over a corrected proposal, which is the case the stamp exists to catch. EXCLUDED on
// purpose: `createdAt`, `workspaceId`, `planId`, and the plan's `title`, `summary` and
// `status` (the status is a precondition the handler refuses on, not content).
//
// ⚠️ ONE ADDITIVE INPUT (MOTIR-6630): an `add`'s `supersedesRefs`, hashed ONLY when
// non-empty. It is structural content exactly as `blockedByRefs` is — a correction
// that replaces it must move the version — and omitting it when empty keeps every
// digest computed before the column existed byte-identical, so no `plan.v2.` is owed.
//
// ⚠️ ONE EXCLUDED KEY (MOTIR-10491): `authorFinished` inside an `add`'s
// `proposedFields`, whatever its value. It is planner state — whether an author
// session finished the card — and never reaches the work item a reviewer approves
// (`NOT_A_CARD_FIELD`). Hashing it would move a `planned` plan's version on a
// write no card shows, and a reader pressing Approve would be refused
// `APPROVAL_GATE_STALE_SUBJECT` for nothing. A row with no such key hashes exactly
// as it did before, so — as for `supersedesRefs` — no `plan.v2.` is owed.
//
// ⚠️ DERIVED, NEVER STORED. A revision leaves the plan `planned` and the gate `awaiting`
// (§11.5c), so the version moves IN PLACE: it is recomputed each time it is asked for.

/** The version prefix — a later change to the inputs is `plan.v2.`, never a silent edit. */
export const PLAN_DIGEST_PREFIX = 'plan.v1.';

/** The columns of a proposal the digest reads — exactly §11.3's list. */
export type PlanDigestRow = Pick<
  PlanItem,
  | 'id'
  | 'op'
  | 'workItemId'
  | 'parentRef'
  | 'blockedByRefs'
  | 'proposedFields'
  | 'patch'
  | 'baseRevision'
> & { supersedesRefs?: readonly string[] };

/**
 * `JSON.stringify` over a copy in which every OBJECT's keys are sorted by UTF-16 code
 * unit order, recursively, with no whitespace. `null` stays `null` (a database NULL is
 * never an omitted key) and array order is kept as stored.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalCopy(value));
}

function canonicalCopy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCopy);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // `Array.prototype.sort` with no comparator orders by UTF-16 code units.
    for (const key of Object.keys(source).sort()) out[key] = canonicalCopy(source[key]);
    return out;
  }
  return value;
}

/** Byte-string order of two ids (UTF-8), as §11.3 names it — not locale order. */
function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The key the digest leaves out of every row's `proposedFields` (see the header). */
const DIGEST_EXCLUDED_PROPOSED_FIELDS = ['authorFinished'] as const;

/** `proposedFields` as the digest reads it: the stored object minus the excluded keys. */
function digestProposedFields(fields: PlanDigestRow['proposedFields']): unknown {
  if (fields === null || fields === undefined) return null;
  if (typeof fields !== 'object' || Array.isArray(fields)) return fields;
  const source = fields as Record<string, unknown>;
  if (!DIGEST_EXCLUDED_PROPOSED_FIELDS.some((k) => Object.hasOwn(source, k))) return fields;
  const out: Record<string, unknown> = { ...source };
  for (const key of DIGEST_EXCLUDED_PROPOSED_FIELDS) delete out[key];
  return out;
}

/** THE DIGEST of one plan's proposal set — pure, so a golden fixture can pin it. */
export function planProposalDigest(rows: readonly PlanDigestRow[]): string {
  const proposals = [...rows]
    .sort((a, b) => byBytes(a.id, b.id))
    .map((row) => ({
      id: row.id,
      op: row.op,
      workItemId: row.workItemId ?? null,
      parentRef: row.parentRef ?? null,
      blockedByRefs: row.blockedByRefs,
      proposedFields: digestProposedFields(row.proposedFields),
      patch: row.patch ?? null,
      baseRevision: row.baseRevision ?? null,
      ...(row.supersedesRefs && row.supersedesRefs.length > 0
        ? { supersedesRefs: row.supersedesRefs }
        : {}),
    }));
  return (
    PLAN_DIGEST_PREFIX + createHash('sha256').update(canonicalJson({ proposals })).digest('hex')
  );
}

/** The plan's CURRENT subject version, read in the caller's transaction. */
export async function planSubjectVersion(
  planId: string,
  tx: Prisma.TransactionClient,
): Promise<string> {
  return planProposalDigest(await planItemRepository.findByPlan(planId, tx));
}

/**
 * The stamp's inputs for a plan gate (§11.3): the digest as the subject, and nothing
 * else — a plan gate has no companion merge gate and no card body.
 */
export function planGateStampInputs(subjectVersion: string | null): StampInputs {
  return { subjectVersion, companionSubjectVersion: null, descriptionMd: null };
}
