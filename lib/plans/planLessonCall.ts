// A planner session's LESSON CALLS, as a value (MOTIR-10191): the caps both write
// doors enforce and the one parser every stored call goes through. Pure: no I/O.
//
// A check of a plan needs to tell three defects apart when a card was written
// against a recorded lesson: the session never searched, it searched with a
// query that missed the lesson, or it was SHOWN the lesson and wrote against it
// anyway. This log is what separates them — every `search_lessons` call with its
// query, filters and the ids it returned in rank order; every `reinforce_lesson` /
// `add_lesson` with its lesson, occurrence ref and outcome; and, for the hosted
// planner, the ids composed into the session's prompt in code (`injected`).
//
// ⚠️ IDS ONLY — NEVER A LESSON'S TEXT. A lesson is read back from the store by its
// id; a call naming a lesson's `title`, `body`, `why` or `howToApply` is refused,
// and every string is capped, so a planner that pasted a lesson into a field
// would store a truncated label, not the lesson.

/** The most calls one report may carry. ZERO is legal: it marks the session recorded. */
export const PLAN_LESSON_CALL_BATCH_MAX = 50;
/** The most lesson ids one call may name — a search's ranked list or an injection. */
export const PLAN_LESSON_CALL_IDS_MAX = 50;
/** The most rows one page of the read-back carries, and its default. */
export const PLAN_LESSON_CALL_PAGE_MAX = 500;

/** The four things a session can do with the corpus. */
export const PLAN_LESSON_CALL_KINDS = ['search', 'reinforce', 'add', 'injected'] as const;
export type PlanLessonCallKind = (typeof PLAN_LESSON_CALL_KINDS)[number];

/** The longest value kept per field, in code points. */
export const PLAN_LESSON_CALL_FIELD_MAX = {
  query: 1000,
  occurrenceRef: 300,
  outcome: 60,
  detail: 200,
  subject: 100,
  axis: 40,
} as const;

/** The filters a `search_lessons` call narrowed by — each absent when the call left it open. */
export interface PlanLessonCallFilters {
  kinds?: string[];
  types?: string[];
  phases?: string[];
  subject?: string;
  limit?: number;
}

/** One call, as parsed and ready to store (`planId`, `sessionKey`, `seq` are the store's). */
export interface PlanLessonCallFields {
  kind: PlanLessonCallKind;
  query: string | null;
  filters: PlanLessonCallFilters;
  /** A search's results in RANK order, or the ids injected; `[]` for reinforce / add. */
  lessonIds: string[];
  /** The lesson a reinforce named, or the one an add created. */
  lessonId: string | null;
  occurrenceRef: string | null;
  outcome: string;
  /** Whether a reinforce / add counted: `false` is the idempotent "already recorded". */
  counted: boolean | null;
  detail: string | null;
}

/** A call the door refused, and why — the whole report is refused, nothing written. */
export class PlanLessonCallRefusal extends Error {}

const LESSON_ID = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,99}$/;
const AXIS_VALUE = /^[a-z][a-z0-9_-]*$/;
const OUTCOME = /^[a-z][a-z0-9_-]*$/;
const CONTROL = /\p{Cc}/gu;
const LESSON_TEXT_FIELDS = ['title', 'body', 'why', 'howToApply', 'text', 'content'] as const;

type Raw = Record<string, unknown>;

function cap(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

function isObject(raw: unknown): raw is Raw {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw);
}

/** An optional one-line string, trimmed, controls dropped and capped; `null` when absent or blank. */
function optionalText(value: unknown, max: number, at: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new PlanLessonCallRefusal(`${at} must be a string.`);
  const text = value.replace(CONTROL, ' ').trim();
  return text.length === 0 ? null : cap(text, max);
}

function lessonIdOf(value: unknown, at: string): string {
  if (typeof value !== 'string' || !LESSON_ID.test(value.trim())) {
    throw new PlanLessonCallRefusal(
      `${at} must be a lesson id (the \`id\` search_lessons returns).`,
    );
  }
  return value.trim();
}

function parseLessonIds(raw: unknown, at: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > PLAN_LESSON_CALL_IDS_MAX) {
    throw new PlanLessonCallRefusal(
      `${at} must be an array of at most ${PLAN_LESSON_CALL_IDS_MAX} lesson ids.`,
    );
  }
  return raw.map((id, i) => lessonIdOf(id, `${at}[${i}]`));
}

function parseAxis(raw: unknown, at: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > 20) {
    throw new PlanLessonCallRefusal(`${at} must be an array of at most 20 axis values.`);
  }
  const values = raw.map((v, i) => {
    const text = optionalText(v, PLAN_LESSON_CALL_FIELD_MAX.axis, `${at}[${i}]`);
    if (text === null || !AXIS_VALUE.test(text)) {
      throw new PlanLessonCallRefusal(`${at}[${i}] must be an axis value, e.g. "story" or "lay".`);
    }
    return text;
  });
  return values.length > 0 ? values : undefined;
}

function parseFilters(raw: unknown, at: string): PlanLessonCallFilters {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) {
    throw new PlanLessonCallRefusal(
      `${at} must be an object { kinds?, types?, phases?, subject?, limit? }.`,
    );
  }
  const kinds = parseAxis(raw.kinds, `${at}.kinds`);
  const types = parseAxis(raw.types, `${at}.types`);
  const phases = parseAxis(raw.phases, `${at}.phases`);
  const subject = optionalText(raw.subject, PLAN_LESSON_CALL_FIELD_MAX.subject, `${at}.subject`);
  const limit = raw.limit;
  if (
    limit !== undefined &&
    limit !== null &&
    (!Number.isSafeInteger(limit) || (limit as number) < 1)
  ) {
    throw new PlanLessonCallRefusal(`${at}.limit must be a positive integer.`);
  }
  return {
    ...(kinds ? { kinds } : {}),
    ...(types ? { types } : {}),
    ...(phases ? { phases } : {}),
    ...(subject !== null ? { subject } : {}),
    ...(typeof limit === 'number' ? { limit } : {}),
  };
}

function parseKind(raw: unknown, at: string): PlanLessonCallKind {
  if (typeof raw === 'string' && (PLAN_LESSON_CALL_KINDS as readonly string[]).includes(raw)) {
    return raw as PlanLessonCallKind;
  }
  throw new PlanLessonCallRefusal(
    `${at}.kind must be one of: ${PLAN_LESSON_CALL_KINDS.join(', ')}.`,
  );
}

function parseOutcome(raw: unknown, at: string): string {
  const value = optionalText(raw, PLAN_LESSON_CALL_FIELD_MAX.outcome, `${at}.outcome`);
  if (value === null || !OUTCOME.test(value)) {
    throw new PlanLessonCallRefusal(
      `${at}.outcome must be the call's outcome code, e.g. "matched", "nothing-matched" or "counted".`,
    );
  }
  return value;
}

/** The fields a kind may not carry — a search names no lesson, a reinforce no query. */
function assertShape(fields: PlanLessonCallFields, at: string): void {
  const ranked = fields.kind === 'search' || fields.kind === 'injected';
  if (!ranked && fields.lessonIds.length > 0) {
    throw new PlanLessonCallRefusal(
      `${at}.lessonIds is a search's or an injection's; send lessonId.`,
    );
  }
  if (
    ranked &&
    (fields.lessonId !== null || fields.occurrenceRef !== null || fields.counted !== null)
  ) {
    throw new PlanLessonCallRefusal(
      `${at} is a ${fields.kind}: it names its lessons in lessonIds, with no lessonId, occurrenceRef or counted.`,
    );
  }
  if (
    fields.kind !== 'search' &&
    (fields.query !== null || Object.keys(fields.filters).length > 0)
  ) {
    throw new PlanLessonCallRefusal(`${at}.query and filters belong to a search only.`);
  }
}

/** Parse ONE call, or throw {@link PlanLessonCallRefusal} naming the field. */
export function parsePlanLessonCall(raw: unknown, at = 'lessonCalls[0]'): PlanLessonCallFields {
  if (!isObject(raw)) throw new PlanLessonCallRefusal(`${at} must be an object.`);
  const carried = LESSON_TEXT_FIELDS.find((key) => key in raw);
  if (carried !== undefined) {
    throw new PlanLessonCallRefusal(
      `${at} carries a lesson's \`${carried}\`; the log records lesson ids, never their text.`,
    );
  }
  if (raw.counted !== undefined && raw.counted !== null && typeof raw.counted !== 'boolean') {
    throw new PlanLessonCallRefusal(`${at}.counted must be a boolean.`);
  }
  const fields: PlanLessonCallFields = {
    kind: parseKind(raw.kind, at),
    query: optionalText(raw.query, PLAN_LESSON_CALL_FIELD_MAX.query, `${at}.query`),
    filters: parseFilters(raw.filters, `${at}.filters`),
    lessonIds: parseLessonIds(raw.lessonIds, `${at}.lessonIds`),
    lessonId:
      raw.lessonId === undefined || raw.lessonId === null
        ? null
        : lessonIdOf(raw.lessonId, `${at}.lessonId`),
    occurrenceRef: optionalText(
      raw.occurrenceRef,
      PLAN_LESSON_CALL_FIELD_MAX.occurrenceRef,
      `${at}.occurrenceRef`,
    ),
    outcome: parseOutcome(raw.outcome, at),
    counted: typeof raw.counted === 'boolean' ? raw.counted : null,
    detail: optionalText(raw.detail, PLAN_LESSON_CALL_FIELD_MAX.detail, `${at}.detail`),
  };
  assertShape(fields, at);
  return fields;
}

/**
 * Parse a whole report: 0 to {@link PLAN_LESSON_CALL_BATCH_MAX} calls, every one
 * valid. An EMPTY array is a report too — it says the session was recorded and
 * made no lesson call, which is what lets a reader tell "never searched" from
 * "not recorded".
 */
export function parsePlanLessonCalls(raw: unknown): PlanLessonCallFields[] {
  if (!Array.isArray(raw) || raw.length > PLAN_LESSON_CALL_BATCH_MAX) {
    throw new PlanLessonCallRefusal(
      `\`lessonCalls\` is 0 to ${PLAN_LESSON_CALL_BATCH_MAX} calls — nothing was recorded.`,
    );
  }
  return raw.map((r, i) => parsePlanLessonCall(r, `lessonCalls[${i}]`));
}
