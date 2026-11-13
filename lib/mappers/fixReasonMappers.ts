import type {
  FixBranchDto,
  FixDetailDto,
  FixRepairCommandDto,
  WorkItemFixReasonDto,
} from '@/lib/dto/fixReason';
import type { ReviewFindingsRefDto } from '@/lib/dto/agentReview';
import type { RunDiedReason } from '@/lib/dto/workItemContinue';

// `WorkItem.fixDetail` → its DTO (Story MOTIR-6588 · MOTIR-6600).
//
// The column is JSON, so what comes back from a read is `unknown` to the type system
// however carefully `fixReasonService` wrote it. This is where it is narrowed, once,
// field by field — a missing or mistyped field reads as `null` (or `0` for a count)
// rather than arriving `undefined` in a row that renders it. And it is `null` whenever
// the reason is, whatever the column holds, so a reader can trust the pair.

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

const REPAIRS: ReadonlySet<string> = new Set<FixRepairCommandDto>([
  'fix',
  'run',
  'continue',
  'none',
]);

/** Unknown repair → `fix`, the shipped default for the four pull-request reasons. */
function repair(v: unknown): FixRepairCommandDto {
  return typeof v === 'string' && REPAIRS.has(v) ? (v as FixRepairCommandDto) : 'fix';
}

const DIED_REASONS: ReadonlySet<string> = new Set<RunDiedReason>([
  'lapsed',
  'interrupted',
  'failed',
  'cancelled',
  'stalled',
  'backstop',
]);

function diedReason(v: unknown): RunDiedReason | null {
  return typeof v === 'string' && DIED_REASONS.has(v) ? (v as RunDiedReason) : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** A dead run's branch list — an entry without a branch name is dropped, not guessed. */
function branches(v: unknown): FixBranchDto[] | null {
  if (!Array.isArray(v)) return null;
  return v.flatMap((entry): FixBranchDto[] => {
    const e = entry as { repository?: unknown; branch?: unknown } | null;
    return e && typeof e.branch === 'string'
      ? [{ repository: str(e.repository), branch: e.branch }]
      : [];
  });
}

/** Recorded heads — an entry whose sha is not a string is dropped, not guessed. */
function raisedHeads(v: unknown): Record<string, string> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const heads: Record<string, string> = {};
  for (const [id, sha] of Object.entries(v as Record<string, unknown>)) {
    if (typeof sha === 'string') heads[id] = sha;
  }
  return heads;
}

/**
 * The send-back's review ref — `{ kind: 'record' | 'gate', id }`. Anything else, including
 * a row stored before the field existed, reads as null: no link rather than a wrong one.
 */
function reviewRef(v: unknown): ReviewFindingsRefDto | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as { kind?: unknown; id?: unknown };
  if ((r.kind !== 'record' && r.kind !== 'gate') || typeof r.id !== 'string' || r.id === '') {
    return null;
  }
  return { kind: r.kind, id: r.id };
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

export function toFixDetailDto(
  fixReason: WorkItemFixReasonDto | null,
  raw: unknown,
): FixDetailDto | null {
  if (fixReason === null || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const d = raw as Record<string, unknown>;
  return {
    groupKey: str(d.groupKey),
    repair: repair(d.repair),
    check: str(d.check),
    queueReason: str(d.queueReason),
    base: str(d.base),
    reviewerName: str(d.reviewerName),
    notePreview: str(d.notePreview),
    gate:
      d.gate === 'pull_request_approval' ||
      d.gate === 'acceptance_result' ||
      d.gate === 'agent_review'
        ? d.gate
        : null,
    reviewRef: reviewRef(d.reviewRef),
    lastHeardAt: str(d.lastHeardAt),
    ranByName: str(d.ranByName),
    branch: str(d.branch),
    branches: branches(d.branches),
    pushed: bool(d.pushed),
    continueKey: str(d.continueKey),
    diedReason: diedReason(d.diedReason),
    affected: count(d.affected),
    total: count(d.total),
    fixing: d.fixing === true,
    raisedHeads: raisedHeads(d.raisedHeads),
  };
}
