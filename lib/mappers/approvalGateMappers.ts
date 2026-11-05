import type { ApprovalGate } from '@/generated/prisma/client';
import type {
  ApprovalGateDTO,
  ApprovalGateDecisionDTO,
  ApprovalGateSubjectSummaryDTO,
  ApprovalQueueRowDto,
  ApprovalRecordDecidedRowDto,
  ChosenOptionDTO,
  ConfirmedRecordDTO,
  EarlierApprovalDTO,
} from '@/lib/dto/approvalGate';
import { membersOf } from '@/lib/approvalGates/memberVersion';
import { replanOwedOf } from '@/lib/approvalGates/decisionRecord';
import type { AwaitingGateRow, RecordGateRow } from '@/lib/repositories/approvalGateRepository';
import type { ApprovedReviewDTO } from '@/lib/dto/reviewState';

// Prisma row → the wire DTO the decide control / Approvals tab reads (Story
// MOTIR-4778 · Subtask MOTIR-4788, widened by MOTIR-4912 with the ADR §6a AUDIT
// set). The service layer calls this just before returning (CLAUDE.md — services
// never return raw Prisma models). The kind / state / authority / source enums
// are string-literal unions on both sides, so they map straight through; dates
// become ISO strings, matching the work-items / acceptance-evidence DTO
// convention.
//
// ⚠️ THE AUDIT FIELDS ARE MAPPED EXPLICITLY, AND THE MAPPER IS NOT A SPREAD.
// That is what makes this file the boundary it claims to be: adding a column to
// `ApprovalGate` does NOT silently widen the wire shape, and REMOVING one from
// the DTO fails the type-check here rather than dropping quietly out of an API
// response. A `...row` would make the DTO's own declaration decorative.

/**
 * Prisma row → the wire DTO. `subjectBody` is the work item's `descriptionMd` where
 * the caller has it in hand — the one input `replanOwed` is derived from (MOTIR-5956);
 * a caller without it reports none, which is only ever a decided overturn's debt.
 */
export function toApprovalGateDto(
  row: ApprovalGate,
  subjectBody?: string | null,
  /** Whether a refusal of this gate asks for a verdict — `refusalVerdictOfferFor`'s
   *  answer, read by the caller (a database read has no place in a mapper). Absent
   *  means false: only an `awaiting` gate asks, and only its render read computes it. */
  offersRefusalVerdict = false,
): ApprovalGateDTO {
  return {
    id: row.id,
    workItemId: row.workItemId,
    kind: row.kind,
    subjectId: row.subjectId,
    state: row.state,
    decidedById: row.decidedById,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    noteMd: row.noteMd,
    // WHY it was withdrawn, or null on every other state (AMENDMENT 6 Q5). It
    // crosses the wire as it is stored: `unknown` is a real value meaning *the
    // reason was not recorded*, and mapping it to null here would make a row that
    // predates the column indistinguishable from an awaiting one.
    supersededCause: row.supersededCause,
    // The audit set (ADR §6a). Every one is nullable on the row and stays
    // nullable on the wire — a null is "not decided yet", and collapsing one to
    // a placeholder here would be the mapper asserting something the record
    // does not say.
    subjectVersion: row.subjectVersion,
    decidedByLabel: row.decidedByLabel,
    routedToId: row.routedToId,
    decidedUnderAuthority: row.decidedUnderAuthority,
    decisionSource: row.decisionSource,
    outcomeRef: row.outcomeRef,
    // Written only in a Motir-pressed `design_result` refusal's deciding write (MOTIR-6421).
    refusalVerdict: row.refusalVerdict,
    // A decided or withdrawn gate asks nothing, whatever the caller computed (MOTIR-6501).
    offersRefusalVerdict: row.state === 'awaiting' && offersRefusalVerdict,
    // Written only by the choice handler's deciding write, in `ChosenOption`'s shape.
    chosenOption: (row.chosenOption as ChosenOptionDTO | null) ?? null,
    // Written only by the confirmation handler's deciding write (MOTIR-5954).
    confirmedRecord: (row.confirmedRecord as ConfirmedRecordDTO | null) ?? null,
    replanOwed: subjectBody === undefined ? null : replanOwedOf(row, subjectBody),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The approval a re-asked merge gate replaced → the record band's first line (Bug
 * MOTIR-5863). `commits` is counted from THAT row's own `subjectVersion`, never the set now
 * on screen. A row with no decision time is not an approval a reader can be told about, so
 * it maps to null rather than to a line with a hole in it.
 */
export function toEarlierApprovalDto(row: ApprovalGate): EarlierApprovalDTO | null {
  if (!row.decidedAt) return null;
  return {
    decidedByLabel: row.decidedByLabel,
    decidedAt: row.decidedAt.toISOString(),
    commits: membersOf(row.subjectVersion).length,
  };
}

/**
 * One routing-read row → the Approvals tab's wire row (Story MOTIR-4879 ·
 * Subtask MOTIR-4791).
 *
 * The subject summary is resolved per kind by
 * `lib/approvalGates/subjectSummary.ts` and threaded in, rather than read here:
 * a mapper is a pure row→DTO conversion (the same discipline
 * {@link toApprovalGateDto} keeps by being an explicit field list rather than a
 * spread), and resolving a subject is a database read.
 *
 * ⚠️ `state` IS ASSERTED, NOT MAPPED THROUGH, and the narrowing is deliberate:
 * the read's `where` clause pins it to `awaiting`, so the DTO says so in its
 * type. If that predicate is ever widened this line is where the type-check
 * fails, which is the point of narrowing it.
 */
/**
 * ONE decided gate → the Approvals room's decided row (MOTIR-5301). The read
 * selects only the DECISIONS — `approved` / `changes_requested` / `overturned` / a plan's
 * `declined` (MOTIR-6037) — so a row in any other state here
 * is a predicate defect upstream, and this throws rather than drawing it.
 */
export function toApprovalRecordDecidedRowDto(
  row: RecordGateRow,
  subject: ApprovalGateSubjectSummaryDTO | null,
  review: ApprovedReviewDTO | null = null,
): ApprovalRecordDecidedRowDto {
  if (
    row.state !== 'approved' &&
    row.state !== 'changes_requested' &&
    row.state !== 'overturned' &&
    row.state !== 'declined'
  ) {
    throw new Error(`approval gate ${row.id} is ${row.state}, not a decision`);
  }
  if (!row.decidedAt) throw new Error(`approval gate ${row.id} is ${row.state} with no decidedAt`);
  return {
    gateId: row.id,
    kind: row.kind,
    state: row.state,
    decidedAt: row.decidedAt.toISOString(),
    decidedByLabel: row.decidedByLabel,
    decisionSource: row.decisionSource,
    subjectVersion: row.subjectVersion,
    waitingSince: row.createdAt.toISOString(),
    workItem: row.workItem ? pickRowCard(row.workItem) : null,
    subject,
    chosenOption: (row.chosenOption as ChosenOptionDTO | null) ?? null,
    confirmedRecord: (row.confirmedRecord as ConfirmedRecordDTO | null) ?? null,
    // A decline's note is its reason too (MOTIR-6037; optional, ADR §11.4).
    refusalReason:
      row.state === 'changes_requested' || row.state === 'declined' ? row.noteMd : null,
    // Only a refusal carries one (MOTIR-6421); the door writes it on no other state.
    refusalVerdict: row.state === 'changes_requested' ? row.refusalVerdict : null,
    // Only an approved merge carries the review clause (MOTIR-10338); the service reads it.
    review: row.state === 'approved' && row.kind === 'pull_request_approval' ? review : null,
  };
}

export function toApprovalQueueRowDto(
  row: AwaitingGateRow,
  subject: ApprovalGateSubjectSummaryDTO | null,
  canDecide: boolean,
  routedToName: string | null,
): ApprovalQueueRowDto {
  return {
    gateId: row.id,
    kind: row.kind,
    state: 'awaiting',
    canDecide,
    routedToName,
    waitingSince: row.createdAt.toISOString(),
    workItem: row.workItem ? pickRowCard(row.workItem) : null,
    subject,
  };
}

/**
 * The six card fields the queue and record rows carry — or, for a CARD-LESS gate
 * (Story MOTIR-6012 · MOTIR-6034; ADR `approval-gates.md` §11.1), no card at all: the
 * row's `subject` says what it is about, and the caller maps `null` rather than
 * inventing one.
 */
function pickRowCard<
  T extends {
    id: string;
    key: number;
    identifier: string;
    title: string;
    kind: unknown;
    type: unknown;
  },
>(card: T) {
  return {
    id: card.id,
    key: card.key,
    identifier: card.identifier,
    title: card.title,
    kind: card.kind as T['kind'],
    type: card.type as T['type'],
  };
}

/**
 * The wire DTO → the DECISION RECORD a token-authed caller reads (Bug MOTIR-6191).
 *
 * ⚠️ IT PROJECTS {@link ApprovalGateDTO} RATHER THAN THE PRISMA ROW, deliberately.
 * The render DTO is where the audit set is already assembled — `decidedByLabel`
 * surviving its person's departure, the dates as ISO strings, the enums narrowed —
 * so mapping from the row again would be a SECOND derivation of the same facts,
 * and the two would drift on the first column that gains a rule. The consequence
 * worth keeping: the agent-facing record can only ever say what the item page says.
 *
 * ⚠️ AND IT IS FIELD BY FIELD, never a spread, for the reason this file's header
 * gives one level down. A spread would carry the stamp, `canDecide`'s neighbours
 * and the port's `subjectId` onto a public surface the moment somebody widened the
 * render DTO, and nothing anywhere would fail.
 */
export function toApprovalGateDecisionDto(gate: ApprovalGateDTO): ApprovalGateDecisionDTO {
  return {
    id: gate.id,
    kind: gate.kind,
    state: gate.state,
    noteMd: gate.noteMd,
    decidedAt: gate.decidedAt,
    decidedByLabel: gate.decidedByLabel,
    decidedUnderAuthority: gate.decidedUnderAuthority,
    decisionSource: gate.decisionSource,
    subjectVersion: gate.subjectVersion,
    supersededCause: gate.supersededCause,
    outcomeRef: gate.outcomeRef,
    refusalVerdict: gate.refusalVerdict,
    offersRefusalVerdict: gate.offersRefusalVerdict,
    createdAt: gate.createdAt,
    updatedAt: gate.updatedAt,
  };
}
