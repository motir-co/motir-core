// The GAPS a planner's author sessions raised, as a value (MOTIR-10176): the caps
// both write doors enforce and the one parser every stored gap goes through.
// Pure: no I/O.
//
// ⚠️ WHY A GAP IS ON THE PLAN AT ALL. A gap is work an author session found that no
// card covers, and the level's ONE amend session is the only session that can turn
// it into a card. Both planners used to keep their gaps in the walk's memory, so a
// walk that died and was resumed lost every gap raised before the death: the amend
// never saw it and the briefing said none was raised. A gap is therefore declared
// on the plan the moment it is raised, and marked once its level's amend has run,
// so a resumed walk can hand the amend exactly the gaps it has not answered.
//
// ⚠️ THE PLANNER NAMES EACH GAP (`id`). The raise and the amend that answers it are
// two calls, often from two different jobs (a resume is a new job), so the gap
// needs an identity both can name. A repeated `raise` of the same id is a no-op —
// a report that timed out and was sent again must not record the gap twice.
//
// ⚠️ REFS ARE THE PLANNER'S OWN SPELLING. `level`, `raisedBy` and the answer's
// `refs` are stored as sent (`planItem:<id>`, a committed key or id): the gap is
// read back by the planner that wrote it, which resolves its own spellings, and
// core checks nothing against them.

/** The most entries one call may carry. */
export const PLAN_GAP_BATCH_MAX = 50;
/** The most refs one answer may name. */
export const PLAN_GAP_REFS_MAX = 50;

/** The longest value kept per field, in code points. */
export const PLAN_GAP_FIELD_MAX = {
  id: 200,
  level: 200,
  raisedBy: 200,
  what: 4000,
  decision: 2000,
  after: 200,
  before: 200,
  note: 2000,
  ref: 200,
  open: 2000,
} as const;

/** A gap being RAISED: an author session found work no card covers. */
export interface PlanGapRaise {
  op: 'raise';
  id: string;
  level: string | null;
  raisedBy: string | null;
  what: string;
  decision: string | null;
  after: string | null;
  before: string | null;
  note: string | null;
  /**
   * Raised AFTER its level's amend had already run — no amend will answer it, so
   * it is stored as amended and a resume never hands it to one.
   */
  amended: boolean;
}

/** A gap its level's AMEND has been handed: answered by `refs`, or not answered. */
export interface PlanGapAmend {
  op: 'amend';
  id: string;
  /** The cards the amend named for this gap; empty when it answered nothing. */
  refs: string[];
  /** The part of the gap those refs leave uncovered; null when they cover it all. */
  open: string | null;
}

export type PlanGapEntry = PlanGapRaise | PlanGapAmend;

/** A gap entry the door refused, and why — the whole call is refused, nothing written. */
export class PlanGapRefusal extends Error {}

const CONTROL = /\p{Cc}/gu;
const CONTROL_BUT_NEWLINE = /(?!\n)\p{Cc}/gu;

type Raw = Record<string, unknown>;

function cap(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

/** An optional string, trimmed, controls dropped and capped; `null` when absent or blank. */
function optionalText(
  raw: Raw,
  key: Exclude<keyof typeof PLAN_GAP_FIELD_MAX, 'ref'>,
  at: string,
  { multiline = false }: { multiline?: boolean } = {},
): string | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new PlanGapRefusal(`${at}.${key} must be a string.`);
  // A gap's words may run over lines; only the control characters that are not
  // line breaks are dropped from them.
  const text = (
    multiline
      ? value.replace(/\r\n?/g, '\n').replace(CONTROL_BUT_NEWLINE, ' ')
      : value.replace(CONTROL, ' ')
  ).trim();
  return text.length === 0 ? null : cap(text, PLAN_GAP_FIELD_MAX[key]);
}

function requiredText(raw: Raw, key: 'id' | 'what', at: string): string {
  const value = optionalText(raw, key, at, { multiline: key === 'what' });
  if (value === null) {
    throw new PlanGapRefusal(
      key === 'id'
        ? `${at}.id is required — the planner's own id for the gap, which its amend names.`
        : `${at}.what is required — the uncovered work, in the session's own words.`,
    );
  }
  return value;
}

function parseRefs(raw: unknown, at: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > PLAN_GAP_REFS_MAX) {
    throw new PlanGapRefusal(`${at}.refs must be an array of at most ${PLAN_GAP_REFS_MAX} refs.`);
  }
  const refs: string[] = [];
  for (const [i, r] of raw.entries()) {
    if (typeof r !== 'string' || r.trim().length === 0) {
      throw new PlanGapRefusal(`${at}.refs[${i}] must be a non-empty string.`);
    }
    const ref = cap(r.replace(CONTROL, ' ').trim(), PLAN_GAP_FIELD_MAX.ref);
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/** Parse ONE entry, or throw {@link PlanGapRefusal} naming the field. */
export function parsePlanGapEntry(raw: unknown, at = 'gaps[0]'): PlanGapEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlanGapRefusal(`${at} must be an object.`);
  }
  const r = raw as Raw;
  if (r.op === 'amend') {
    return {
      op: 'amend',
      id: requiredText(r, 'id', at),
      refs: parseRefs(r.refs, at),
      open: optionalText(r, 'open', at, { multiline: true }),
    };
  }
  if (r.op !== 'raise') throw new PlanGapRefusal(`${at}.op must be one of: raise, amend.`);
  if (r.amended !== undefined && typeof r.amended !== 'boolean') {
    throw new PlanGapRefusal(`${at}.amended must be a boolean.`);
  }
  return {
    op: 'raise',
    id: requiredText(r, 'id', at),
    level: optionalText(r, 'level', at),
    raisedBy: optionalText(r, 'raisedBy', at),
    what: requiredText(r, 'what', at),
    decision: optionalText(r, 'decision', at, { multiline: true }),
    after: optionalText(r, 'after', at),
    before: optionalText(r, 'before', at),
    note: optionalText(r, 'note', at, { multiline: true }),
    amended: r.amended === true,
  };
}

/** Parse a whole call's batch: 1 to {@link PLAN_GAP_BATCH_MAX} entries, every one valid. */
export function parsePlanGapEntries(raw: unknown): PlanGapEntry[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PLAN_GAP_BATCH_MAX) {
    throw new PlanGapRefusal(
      `\`gaps\` is 1 to ${PLAN_GAP_BATCH_MAX} entries — nothing was recorded.`,
    );
  }
  return raw.map((r, i) => parsePlanGapEntry(r, `gaps[${i}]`));
}
