import { InvalidProposalError } from '@/lib/plans/errors';
import type { AppendFold } from '@/lib/plans/mergeModifyPatch';

// THE EDGE REASON (MOTIR-9827). A `blocked_by` a planner draws says, in one short
// line, what the waiting card CONSUMES from its blocker — "consumes: the
// `AWS_ORG_ADMIN_*` secrets", "consumes: the AMI id the workflow publishes". A
// bare ref kept that reason in the model's head, so a reviewer could not see why
// a card waits, the author sessions on both ends could not write a hand-off
// against it, and no check could tell a real dependency from a wrong one.
//
// On the wire an edge list entry is EITHER a bare ref (still accepted, for the
// committed callers outside the planners) OR `{ ref, reason }`. The doors split
// the list here into the `string[]` every downstream reader already handles and a
// `ref → reason` map, which the plan item stores beside its refs (`edgeReasons`)
// and approve writes onto the link it creates (`work_item_link.reason`).

/** The most characters a reason may carry after trimming — one line, short by rule. */
export const EDGE_REASON_MAX = 120;

/** One entry of an edge list as a door accepts it. */
export type EdgeRefInput = string | { ref: string; reason?: string | null };

/** A ref → reason map; a ref with no entry was drawn without a reason. */
export type EdgeReasons = Record<string, string>;

/** Trim a reason and hold it to one line of at most {@link EDGE_REASON_MAX}, or refuse it by name. */
export function normalizeEdgeReason(reason: string, ref: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new InvalidProposalError(
      `The reason on the edge to ${ref} is blank. Say in one short line what the waiting card consumes from it, or send the bare ref.`,
    );
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new InvalidProposalError(
      `The reason on the edge to ${ref} spans more than one line. A reason is ONE short line: what the waiting card consumes from it.`,
    );
  }
  if (trimmed.length > EDGE_REASON_MAX) {
    throw new InvalidProposalError(
      `The reason on the edge to ${ref} is ${trimmed.length} characters; at most ${EDGE_REASON_MAX} are allowed. Name only what the waiting card consumes.`,
    );
  }
  return trimmed;
}

/**
 * Split an edge list into its refs and their reasons. A bare string is a ref with
 * no reason; an object must carry a string `ref`, and its `reason`, when present,
 * is normalized by {@link normalizeEdgeReason}. Anything else is refused.
 */
export function splitEdgeList(list: readonly unknown[]): { refs: string[]; reasons: EdgeReasons } {
  const refs: string[] = [];
  const reasons: EdgeReasons = {};
  for (const entry of list) {
    if (typeof entry === 'string') {
      refs.push(entry);
      continue;
    }
    const ref = (entry as { ref?: unknown } | null)?.ref;
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new InvalidProposalError(
        'An edge list entry is a ref string or `{ ref, reason }`, and `ref` must be a non-empty string.',
      );
    }
    refs.push(ref);
    const reason = (entry as { reason?: unknown }).reason;
    if (reason === undefined || reason === null) continue;
    if (typeof reason !== 'string') {
      throw new InvalidProposalError(`The reason on the edge to ${ref} must be a string.`);
    }
    reasons[ref] = normalizeEdgeReason(reason, ref);
  }
  return { refs, reasons };
}

/** Keep only the reasons whose ref is still one of `refs`. */
export function pickEdgeReasons(
  reasons: EdgeReasons | null | undefined,
  refs: readonly string[],
): EdgeReasons {
  const picked: EdgeReasons = {};
  for (const ref of refs) {
    const reason = reasons?.[ref];
    if (typeof reason === 'string') picked[ref] = reason;
  }
  return picked;
}

/** Read a stored `edgeReasons` column back, dropping anything that is not a string entry. */
export function readEdgeReasons(value: unknown): EdgeReasons {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: EdgeReasons = {};
  for (const [ref, reason] of Object.entries(value as Record<string, unknown>)) {
    if (typeof reason === 'string') out[ref] = reason;
  }
  return out;
}

interface WireProposal {
  op?: unknown;
  blockedByRefs?: unknown;
  patch?: unknown;
  edgeReasons?: unknown;
}

/**
 * Normalize ONE proposal as a door received it: its `blockedByRefs` (an `add`)
 * and its `patch.blockedByAdd` (a `modify`) become plain ref lists, and the
 * reasons they carried land on `edgeReasons`. A proposal with no object entries
 * is returned with the same refs and an `edgeReasons` of whatever it already had.
 * Idempotent, so the service may run it on what a door already normalized.
 */
export function normalizeProposalEdges<T extends object>(proposal: T): T {
  const p = proposal as WireProposal;
  const reasons: EdgeReasons = { ...readEdgeReasons(p.edgeReasons) };
  const next: Record<string, unknown> = { ...(proposal as Record<string, unknown>) };
  if (Array.isArray(p.blockedByRefs)) {
    const split = splitEdgeList(p.blockedByRefs);
    next.blockedByRefs = split.refs;
    Object.assign(reasons, split.reasons);
  }
  const patch = p.patch as { blockedByAdd?: unknown } | null | undefined;
  if (patch && typeof patch === 'object' && Array.isArray(patch.blockedByAdd)) {
    const split = splitEdgeList(patch.blockedByAdd);
    next.patch = { ...patch, blockedByAdd: split.refs };
    Object.assign(reasons, split.reasons);
  }
  for (const [ref, reason] of Object.entries(reasons))
    reasons[ref] = normalizeEdgeReason(reason, ref);
  next.edgeReasons = reasons;
  return next as T;
}

/** The refs a proposal's reasons may key: an `add`'s blockers, a `modify`'s added blockers. */
export function proposalEdgeRefs(proposal: {
  op: string;
  blockedByRefs?: readonly string[] | null;
  patch?: { blockedByAdd?: readonly string[] | null } | null;
}): string[] {
  return proposal.op === 'modify'
    ? [...(proposal.patch?.blockedByAdd ?? [])]
    : [...(proposal.blockedByRefs ?? [])];
}

/**
 * Refuse a reason keyed by a ref the proposal does not draw — a reason is the
 * explanation of ONE edge, never a free-floating note.
 */
export function assertEdgeReasonsKeyed(
  proposal: {
    op: string;
    blockedByRefs?: readonly string[] | null;
    patch?: { blockedByAdd?: readonly string[] | null } | null;
    edgeReasons?: EdgeReasons | null;
  },
  label: string,
): void {
  const refs = new Set(proposalEdgeRefs(proposal));
  for (const ref of Object.keys(proposal.edgeReasons ?? {})) {
    if (!refs.has(ref)) {
      throw new InvalidProposalError(
        `${label}: a reason is given for the edge to ${ref}, which this proposal does not draw. ` +
          (proposal.op === 'modify'
            ? 'A `modify` explains the edges of its `patch.blockedByAdd`.'
            : 'An `add` explains the edges of its `blockedByRefs`.'),
      );
    }
  }
}

/**
 * The reasons each row of an append ends with, folded the way the patches fold
 * (`foldAppend`, AMENDMENT 18 §2): a `modify` merged into an earlier one — in the
 * plan or in the batch — UNIONS its reasons into that row's, the later reason
 * winning per ref. Each result is then held to the refs the row finally draws, so
 * a blocker the merge cancelled carries no reason.
 */
export function foldEdgeReasons(
  existing: ReadonlyArray<{ id: string; edgeReasons?: unknown }>,
  proposals: ReadonlyArray<{ edgeReasons?: EdgeReasons | null }>,
  fold: Pick<AppendFold, 'dispositions'>,
): { forInsert: Map<number, EdgeReasons>; forExisting: Map<string, EdgeReasons> } {
  const forInsert = new Map<number, EdgeReasons>();
  const forExisting = new Map<string, EdgeReasons>();
  const existingById = new Map(existing.map((row) => [row.id, row]));
  proposals.forEach((p, index) => {
    const own = p.edgeReasons ?? {};
    const disposition = fold.dispositions[index]!;
    if (disposition.kind === 'insert') {
      forInsert.set(index, { ...own });
    } else if (disposition.kind === 'mergeBatch') {
      forInsert.set(disposition.index, { ...(forInsert.get(disposition.index) ?? {}), ...own });
    } else {
      const base =
        forExisting.get(disposition.rowId) ??
        readEdgeReasons(existingById.get(disposition.rowId)?.edgeReasons);
      forExisting.set(disposition.rowId, { ...base, ...own });
    }
  });
  return { forInsert, forExisting };
}

/**
 * Normalize a CORRECTION as a door received it. A correction REPLACES
 * `blockedByRefs` and a `modify`'s `patch`, so when it carries either, its
 * reasons are replaced with them: `edgeReasons` is set to what the new lists
 * carried (merged over any `edgeReasons` sent beside them). A correction that
 * touches neither leaves `edgeReasons` as sent.
 */
export function normalizeCorrectionEdges<
  T extends { blockedByRefs?: unknown; patch?: unknown; edgeReasons?: unknown },
>(input: T): T {
  const replacesEdges =
    Array.isArray(input.blockedByRefs) ||
    (input.patch !== undefined && input.patch !== null && typeof input.patch === 'object');
  if (!replacesEdges) return input;
  return normalizeProposalEdges(input);
}
