import { createHash } from 'node:crypto';

// THE ONE READER OF A DECISION'S BODY (Story MOTIR-5871 · Subtask MOTIR-5954; ADR
// `docs/decisions/approval-gates.md` §1's MOTIR-5952 amendment, points 2–3).
//
// A `type: decision` + `executor: human` work item holds a decision the planner
// settled WITH the person, in its own `descriptionMd`, in the canonical structure
// the planner's rule teaches and the port renders:
//
//   ## Decision
//   <the direction agreed in the conversation>
//   ## What changed
//   **Change:** <workflow · more requirement · less requirement>
//   <what the approved plan said before, and what it says now>
//   ## Supersedes
//   <work-item keys — never empty>
//   ## Resulting direction
//   <the epic's direction in full after this decision>
//
// This module turns that text into the `decision_confirmation` gate's SUBJECT — or
// into the closed set of reasons it cannot be one. A body that does not parse
// raises NO gate (point 3), so the defect is what the item page renders instead.
//
// ⚠️ PURE. No database, no clock, no randomness: the same body always yields the
// same answer and the same `subjectVersion`, which is what makes the version a
// STAMP a stale press can be refused against (MOTIR-5232). The keys under
// `## Supersedes` are NOT resolved here — a removed work item is exactly what a
// LESS-requirement decision supersedes, so an unresolvable key is not a defect.

/** The three changes that earn a decision work item (point 2's table), and nothing else. */
export const DECISION_CHANGES = ['workflow', 'more_requirement', 'less_requirement'] as const;
export type DecisionChange = (typeof DECISION_CHANGES)[number];

const CHANGE_BY_WORDS: Record<string, DecisionChange> = {
  workflow: 'workflow',
  'more requirement': 'more_requirement',
  'less requirement': 'less_requirement',
};

/** A defect is ONE of these — the closed set point 3 fixes, in section order. */
export type DecisionDefect =
  | { reason: 'no_decision_section' }
  | { reason: 'no_change_section' }
  | { reason: 'unknown_change'; value: string }
  | { reason: 'no_supersedes_section' }
  | { reason: 'empty_supersedes' }
  | { reason: 'no_resulting_direction' };

export type DecisionDefectReason = DecisionDefect['reason'];

/** The four sections as the port shows them. */
export interface DecisionSections {
  decisionMd: string;
  /** The `**Change:**` values, in the order written, de-duplicated. */
  changes: DecisionChange[];
  /** `## What changed` with the `**Change:**` line removed — the before/after prose. */
  whatChangedMd: string;
  /** Every work-item key `## Supersedes` names, in the order written, de-duplicated. */
  supersedes: string[];
  /** `## Supersedes` as authored, so a key's surrounding words survive. */
  supersedesMd: string;
  resultingDirectionMd: string;
}

export interface ParsedDecision extends DecisionSections {
  ok: true;
  /** A hash of the four sections — the gate's stamp. */
  subjectVersion: string;
}

/**
 * What a DEFECTIVE body still says, as far as it parses — so the defect state can
 * show the sections read-only beside the reason. Never a subject: nothing here can
 * be confirmed.
 */
export type DecisionDraft = DecisionSections;

export interface DefectiveDecision {
  ok: false;
  /** The ONE defect — the first met, in section order (point 3). */
  defect: DecisionDefect;
  draft: DecisionDraft;
}

export type DecisionParse = ParsedDecision | DefectiveDecision;

const SECTION = {
  decision: 'decision',
  whatChanged: 'what changed',
  supersedes: 'supersedes',
  resulting: 'resulting direction',
} as const;

/** A work-item key: a project key, a dash, a number (`MOTIR-42`, `ACME2-7`). */
const WORK_ITEM_KEY = /\b[A-Z][A-Z0-9]*-\d+\b/g;

/** Normalise line endings and trailing whitespace, so a CRLF body hashes like an LF one. */
function normalise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
}

/** The `##` sections, first occurrence of each heading winning; text before the first is dropped. */
function sectionsByHeading(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (heading !== null && !out.has(heading)) out.set(heading, body.join('\n').trim());
  };
  for (const line of text.split('\n')) {
    const match = /^##(?!#)\s*(.*)$/.exec(line);
    if (match) {
      flush();
      heading = (match[1] ?? '').trim().toLowerCase();
      body = [];
    } else if (heading !== null) {
      body.push(line);
    }
  }
  flush();
  return out;
}

/** `**Change:** value` on its own line — the value, and the body with that line removed. */
function takeChangeLine(body: string): { value: string | null; rest: string } {
  const pattern = /^\*\*Change:\*\*\s*(.*)$/i;
  const lines = body.split('\n');
  const index = lines.findIndex((line) => pattern.test(line.trim()));
  if (index === -1) return { value: null, rest: body };
  const value = (pattern.exec((lines[index] ?? '').trim())?.[1] ?? '').trim();
  lines.splice(index, 1);
  return { value, rest: lines.join('\n').trim() };
}

/**
 * The change values: one or more, separated by `·` or a comma (point 2's
 * DEVIATION — one re-plan routinely drops a story AND re-orders what remains).
 * Returns the first value it cannot read as `unknown`.
 */
function readChanges(value: string): { changes: DecisionChange[]; unknown: string | null } {
  const changes: DecisionChange[] = [];
  for (const raw of value.split(/[·,]/)) {
    const words = raw
      .toLowerCase()
      .replace(/[_\s]+/g, ' ')
      .trim();
    if (words === '') continue;
    const change = CHANGE_BY_WORDS[words];
    if (change === undefined) return { changes, unknown: raw.trim() };
    if (!changes.includes(change)) changes.push(change);
  }
  return { changes, unknown: null };
}

/** Every work-item key in a section, in order, de-duplicated. */
export function supersededKeys(supersedesMd: string): string[] {
  return [...new Set(supersedesMd.match(WORK_ITEM_KEY) ?? [])];
}

/**
 * Parse a decision work item's `descriptionMd` into its subject, or into the ONE
 * reason it cannot be one.
 */
export function parseDecisionRecord(descriptionMd: string | null | undefined): DecisionParse {
  const sections = sectionsByHeading(normalise(descriptionMd ?? ''));
  const decisionMd = sections.get(SECTION.decision) ?? '';
  const whatChanged = sections.get(SECTION.whatChanged);
  const supersedesMd = sections.get(SECTION.supersedes);
  const resultingDirectionMd = sections.get(SECTION.resulting) ?? '';

  const changeLine = whatChanged === undefined ? null : takeChangeLine(whatChanged);
  const read =
    changeLine?.value == null ? { changes: [], unknown: null } : readChanges(changeLine.value);
  const supersedes = supersededKeys(supersedesMd ?? '');

  const draft: DecisionDraft = {
    decisionMd,
    changes: read.changes,
    whatChangedMd: changeLine?.rest ?? whatChanged ?? '',
    supersedes,
    supersedesMd: supersedesMd ?? '',
    resultingDirectionMd,
  };

  const defect = firstDefect({
    decisionMd,
    changeValue: changeLine?.value ?? null,
    changes: read.changes,
    unknownChange: read.unknown,
    supersedesPresent: supersedesMd !== undefined,
    supersedes,
    resultingDirectionMd,
  });
  if (defect) return { ok: false, defect, draft };

  return {
    ok: true,
    ...draft,
    subjectVersion: decisionSubjectVersion([
      decisionMd,
      whatChanged ?? '',
      supersedesMd ?? '',
      resultingDirectionMd,
    ]),
  };
}

function firstDefect(args: {
  decisionMd: string;
  changeValue: string | null;
  changes: DecisionChange[];
  unknownChange: string | null;
  supersedesPresent: boolean;
  supersedes: string[];
  resultingDirectionMd: string;
}): DecisionDefect | null {
  if (args.decisionMd === '') return { reason: 'no_decision_section' };
  if (args.changeValue === null) return { reason: 'no_change_section' };
  if (args.unknownChange !== null) return { reason: 'unknown_change', value: args.unknownChange };
  if (args.changes.length === 0) return { reason: 'unknown_change', value: args.changeValue };
  if (!args.supersedesPresent) return { reason: 'no_supersedes_section' };
  if (args.supersedes.length === 0) return { reason: 'empty_supersedes' };
  if (args.resultingDirectionMd === '') return { reason: 'no_resulting_direction' };
  return null;
}

/**
 * The stamp: a hash of the four sections, each whitespace-normalised. Anything
 * outside them — a closing note, a typo — does not move it, so it does not retire
 * a pending confirmation; changing the decision does.
 */
function decisionSubjectVersion(sections: string[]): string {
  const normalised = sections.map((section) => section.replace(/\s+/g, ' ').trim());
  return createHash('sha256')
    .update(['decision', ...normalised].join('\u0000'))
    .digest('hex');
}

/**
 * THE RE-PLAN AN OVERTURN OWES (MOTIR-5956; ADR §1's MOTIR-5952 amendment, point 7)
 * — DERIVED, never stored: an overturned `decision_confirmation` gate plus the keys
 * its subject's `## Supersedes` names. Read from the draft when the body no longer
 * parses, so an edit after the overturn never erases the debt. Null on every other
 * gate.
 */
export function replanOwedOf(
  gate: { kind: string; state: string },
  descriptionMd: string | null | undefined,
): { keys: string[] } | null {
  if (gate.kind !== 'decision_confirmation' || gate.state !== 'overturned') return null;
  const parse = parseDecisionRecord(descriptionMd);
  return { keys: parse.ok ? parse.supersedes : parse.draft.supersedes };
}

/**
 * The gate that DECIDES a decision work item, by who holds it: a `human` decision is
 * confirmed at `decision_confirmation`, a `coding_agent` one (the planner's own
 * record, published as a page) is approved at `decision_approval`.
 */
export type DecisionGateKind = 'decision_confirmation' | 'decision_approval';

/**
 * A decision as the AI boundary carries it (MOTIR-5958; widened to the planner's own
 * decisions by MOTIR-10146) — from its latest deciding gate, or none. `approved`
 * reads `confirmed`; `changes_requested` (a `decision_approval` sent back, still owed
 * a new version) reads `awaiting`; `superseded` (a withdrawn question) and no gate at
 * all read `none`. `decidedAt` is set only on a decision somebody made; the owed
 * re-plan and the person's note only on an overturn, which only a
 * `decision_confirmation` can be.
 */
export function aiDecisionBlockOf(row: {
  descriptionMd: string | null;
  kind: DecisionGateKind;
  state: string | null;
  decidedAt: Date | null;
  noteMd: string | null;
}): {
  kind: DecisionGateKind;
  state: 'awaiting' | 'confirmed' | 'overturned' | 'none';
  decidedAt: string | null;
  replanOwed: string[] | null;
  noteMd: string | null;
} {
  const state = aiDecisionStateOf(row.state);
  const decided = state === 'confirmed' || state === 'overturned';
  const overturned = state === 'overturned';
  return {
    kind: row.kind,
    state,
    decidedAt: decided && row.decidedAt ? row.decidedAt.toISOString() : null,
    replanOwed: overturned
      ? (replanOwedOf({ kind: row.kind, state }, row.descriptionMd)?.keys ?? [])
      : null,
    noteMd: overturned ? (row.noteMd ?? null) : null,
  };
}

function aiDecisionStateOf(state: string | null): 'awaiting' | 'confirmed' | 'overturned' | 'none' {
  switch (state) {
    case 'approved':
      return 'confirmed';
    case 'overturned':
    case 'awaiting':
      return state;
    case 'changes_requested':
      return 'awaiting';
    default:
      return 'none';
  }
}

/** The row-scale summary of a decision's body (MOTIR-5954) — null when it does not parse. */
export function decisionConfirmationSummaryOf(descriptionMd: string | null): {
  decision: string;
  changes: DecisionChange[];
  supersedesCount: number;
} | null {
  const parse = parseDecisionRecord(descriptionMd);
  if (!parse.ok) return null;
  return {
    decision: parse.decisionMd.split('\n')[0]?.trim() ?? '',
    changes: parse.changes,
    supersedesCount: parse.supersedes.length,
  };
}
