// The card comment a run's discrepancy record leaves (Story MOTIR-8651 · MOTIR-8655,
// decision page MOTIR-8654). PURE: points in, markdown out — no I/O, no clock.
//
// The comment is the record's TEXT. The `discrepancy_recorded` finding on the run carries
// only a pointer to it, so a customer's words stay in the card's own tenant.
//
// ⚠️ TWO KINDS OF ENTRY, ONE COMMENT (MOTIR-10000). A POINT is the plan being WRONG about
// the HOW (a build-through); a DECISION is the plan being SILENT and the run deciding by the
// repository's conventions, then industry best practice. Each gets its own section, so a
// reader never takes a decision for a defect of the plan; a record with only decisions keeps
// the build-through header out of the comment entirely.
//
// ⚠️ THE COMMENT IS THE VIEW, NOT THE RECORD (MOTIR-11361). The record is
// `run_discrepancy_record` + its entries, written beside this comment in one transaction.
// `parseDiscrepancyComment` below is the composer's INVERSE, and exists only for the
// backfill of comments written before that table: it accepts a body exactly when composing
// what it parsed gives the body back, so an edited comment that no longer reads as a record
// is reported, never guessed at.

/** One point of a discrepancy: what the plan asked · what was built · why. */
export interface RunDiscrepancyPoint {
  planAsked: string;
  built: string;
  why: string;
}

/** One decision the run made where the plan was silent: what it said · what was chosen · why. */
export interface RunDecisionPoint {
  /** What the card or plan said about it — "nothing" when it was silent. */
  planSaid: string;
  chose: string;
  /** The convention or the best practice the choice follows. */
  why: string;
  /** The options considered and not taken, when the run named any. */
  alternatives?: string | null;
}

const POINT_HEADER = '**Built through a plan that was wrong about the HOW**';
const DECISION_HEADER = '**Decided by the run where the plan was silent**';
const POINT_LABELS = ['- **Plan asked:** ', '- **Built:** ', '- **Why:** '] as const;
const DECISION_LABELS = ['- **Plan said:** ', '- **Chose:** ', '- **Why:** '] as const;
const ALTERNATIVES_LABEL = '- **Alternatives considered:** ';

/** The two lines a discrepancy comment can start with — how the backfill finds one. */
export const DISCREPANCY_COMMENT_HEADERS: readonly string[] = [POINT_HEADER, DECISION_HEADER];

function discrepancyLines(points: readonly RunDiscrepancyPoint[]): string[] {
  const lines: string[] = [
    `${POINT_HEADER} — ${points.length} ` +
      `${points.length === 1 ? 'discrepancy' : 'discrepancies'}. The card's outcome and ` +
      'acceptance criteria were met; the route to them differs from the plan.',
    '',
  ];
  points.forEach((point, index) => {
    lines.push(
      `**${index + 1}.**`,
      `${POINT_LABELS[0]}${point.planAsked}`,
      `${POINT_LABELS[1]}${point.built}`,
      `${POINT_LABELS[2]}${point.why}`,
      '',
    );
  });
  return lines;
}

function decisionLines(decisions: readonly RunDecisionPoint[]): string[] {
  const lines: string[] = [
    `${DECISION_HEADER} — ${decisions.length} ` +
      `${decisions.length === 1 ? 'decision' : 'decisions'}, each by the repository's ` +
      'conventions first, then industry best practice.',
    '',
  ];
  decisions.forEach((decision, index) => {
    lines.push(
      `**${index + 1}.**`,
      `${DECISION_LABELS[0]}${decision.planSaid}`,
      `${DECISION_LABELS[1]}${decision.chose}`,
      `${DECISION_LABELS[2]}${decision.why}`,
    );
    if (decision.alternatives) lines.push(`${ALTERNATIVES_LABEL}${decision.alternatives}`);
    lines.push('');
  });
  return lines;
}

/**
 * Compose the comment body — one numbered block per point, then one per decision, each in the
 * order given. Either list may be empty, never both (the service refuses that first).
 */
export function composeDiscrepancyComment(
  points: readonly RunDiscrepancyPoint[],
  decisions: readonly RunDecisionPoint[] = [],
): string {
  const lines: string[] = [];
  if (points.length > 0) lines.push(...discrepancyLines(points));
  if (decisions.length > 0) lines.push(...decisionLines(decisions));
  return lines.join('\n').trimEnd();
}

// ── The inverse — for the MOTIR-11361 backfill only ───────────────────────────

/** What a discrepancy comment holds, read back out of its markdown. */
export interface ParsedDiscrepancyComment {
  points: RunDiscrepancyPoint[];
  decisions: RunDecisionPoint[];
}

const POINT_HEADER_RE = /^\*\*Built through a plan that was wrong about the HOW\*\* — (\d+) /;
const DECISION_HEADER_RE = /^\*\*Decided by the run where the plan was silent\*\* — (\d+) /;

/** A cursor over the comment's lines. */
interface Cursor {
  lines: readonly string[];
  at: number;
}

/** The first index at or after `from` (and before `end`) whose line starts with `prefix`. */
function nextStartingWith(c: Cursor, prefix: string, end: number): number {
  for (let i = c.at; i < end; i += 1) if (c.lines[i]!.startsWith(prefix)) return i;
  return -1;
}

/**
 * Where block `n` (1-based) of a section starts: the line `**n.**` right after a blank
 * line, at or after the cursor. `-1` when there is none before `end`.
 */
function nextBlock(c: Cursor, n: number, end: number): number {
  for (let i = c.at; i < end; i += 1) {
    if (c.lines[i] === `**${n}.**` && c.lines[i - 1] === '') return i;
  }
  return -1;
}

/**
 * One labelled field's value: from after its label to the line before `stop`, joined.
 * `stop` is the next marker's index; a block's last field also drops the blank separator.
 */
function fieldValue(c: Cursor, labelAt: number, label: string, stop: number): string {
  const first = c.lines[labelAt]!.slice(label.length);
  return [first, ...c.lines.slice(labelAt + 1, stop)].join('\n').trimEnd();
}

/**
 * Read `count` numbered blocks from `[start, end)`, each with `labels` in order and, when
 * `optional` is given, that label as an optional last field. Null when a marker is missing.
 */
function readBlocks(
  c: Cursor,
  count: number,
  labels: readonly string[],
  end: number,
  optional?: string,
): string[][] | null {
  const blocks: string[][] = [];
  for (let n = 1; n <= count; n += 1) {
    if (c.lines[c.at] !== `**${n}.**`) return null;
    c.at += 1;
    const blockEnd = n < count ? nextBlock({ lines: c.lines, at: c.at }, n + 1, end) : end;
    if (blockEnd < 0) return null;
    const starts: number[] = [];
    for (const label of labels) {
      const at = nextStartingWith(c, label, blockEnd);
      if (at < 0) return null;
      starts.push(at);
      c.at = at + 1;
    }
    const optionalAt = optional ? nextStartingWith(c, optional, blockEnd) : -1;
    const marks = optionalAt >= 0 ? [...starts, optionalAt] : starts;
    const all = optionalAt >= 0 ? [...labels, optional!] : labels;
    blocks.push(
      marks.map((at, i) =>
        fieldValue(c, at, all[i]!, i + 1 < marks.length ? marks[i + 1]! : blockEnd),
      ),
    );
    c.at = blockEnd;
  }
  return blocks;
}

/** The points section's blocks as points. */
function toPoints(blocks: string[][]): RunDiscrepancyPoint[] {
  return blocks.map(([planAsked, built, why]) => ({
    planAsked: planAsked!,
    built: built!,
    why: why!,
  }));
}

/** The decisions section's blocks as decisions; `alternatives` only when the block had one. */
function toDecisions(blocks: string[][]): RunDecisionPoint[] {
  return blocks.map(([planSaid, chose, why, alternatives]) => ({
    planSaid: planSaid!,
    chose: chose!,
    why: why!,
    ...(alternatives !== undefined ? { alternatives } : {}),
  }));
}

/**
 * Read a discrepancy comment back into its points and decisions, or `null` when the body is
 * not one — never a partial answer. Accepted exactly when `composeDiscrepancyComment` of the
 * result gives `bodyMd` back byte for byte, so a comment someone edited out of the record's
 * shape (or one that never was a record) is refused rather than half-read.
 */
export function parseDiscrepancyComment(bodyMd: string): ParsedDiscrepancyComment | null {
  const lines = bodyMd.split('\n');
  const c: Cursor = { lines, at: 0 };
  const pointMatch = POINT_HEADER_RE.exec(lines[0] ?? '');
  let decisionAt = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i - 1] === '' && DECISION_HEADER_RE.test(lines[i]!)) {
      decisionAt = i;
      break;
    }
  }
  if (!pointMatch && !DECISION_HEADER_RE.test(lines[0] ?? '')) return null;
  if (!pointMatch) decisionAt = 0;

  let points: RunDiscrepancyPoint[] = [];
  if (pointMatch) {
    const end = decisionAt >= 0 ? decisionAt : lines.length;
    c.at = 2;
    const blocks = readBlocks(c, Number(pointMatch[1]), POINT_LABELS, end);
    if (!blocks) return null;
    points = toPoints(blocks);
  }
  let decisions: RunDecisionPoint[] = [];
  if (decisionAt >= 0) {
    const decisionMatch = DECISION_HEADER_RE.exec(lines[decisionAt]!)!;
    c.at = decisionAt + 2;
    const blocks = readBlocks(
      c,
      Number(decisionMatch[1]),
      DECISION_LABELS,
      lines.length,
      ALTERNATIVES_LABEL,
    );
    if (!blocks) return null;
    decisions = toDecisions(blocks);
  }
  if (points.length === 0 && decisions.length === 0) return null;
  return composeDiscrepancyComment(points, decisions) === bodyMd ? { points, decisions } : null;
}
