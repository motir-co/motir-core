// The HAND-OFFS AND RENAMES a planner's author sessions registered, as a value
// (MOTIR-11085): the caps both write doors enforce and the one parser every stored
// registration goes through. Pure: no I/O.
//
// ⚠️ WHY A REGISTRATION IS ON THE PLAN AT ALL. Once every author of a laid level
// writes at once (MOTIR-11064), an author that must hand work to a card waiting on
// its own — or change a name the level's boundaries settled, because the code
// forces it — REGISTERS it, and the level's ONE amend applies it after the level's
// authors end. The hosted planner used to keep its registrations only in the walk's
// memory, so a walk that died after a registration and before its level's amend was
// resumed from the plan alone and the amend never applied it: the same loss raised
// gaps had before `planRaisedGap.ts` (MOTIR-10176). A registration is therefore
// declared on the plan the moment it is made, and stamped once its level's amend has
// been handed it, so a resumed walk hands the amend exactly the ones it has not.
//
// ⚠️ THE PLANNER NAMES EACH REGISTRATION (`id`). The register and the relay that
// settles it are two calls, often from two different jobs (a resume is a new job), so
// the registration needs an identity both can name. A repeated `register` of the same
// id is a no-op — a report that timed out and was sent again must not record it twice.
//
// ⚠️ REFS AND WORDS ARE THE PLANNER'S OWN. `session`, `level`, `receiver` and the
// hand-off's `reason` are stored as sent: the registration is read back by the planner
// that wrote it, which resolves its own spellings and owns its own vocabulary, so core
// checks only the SHAPE a resume needs — which kind it is, and that kind's fields.

/** The most entries one call may carry. */
export const PLAN_REGISTRATION_BATCH_MAX = 50;

/** The two kinds of registration — what the amend applies differs by kind. */
export const PLAN_REGISTRATION_KINDS = ['hand_off', 'rename'] as const;
export type PlanRegistrationKind = (typeof PLAN_REGISTRATION_KINDS)[number];

/** How a level's amend settled a registration it was handed. */
export const PLAN_REGISTRATION_OUTCOMES = ['applied', 'raised_as_gap', 'unsettled'] as const;
export type PlanRegistrationOutcome = (typeof PLAN_REGISTRATION_OUTCOMES)[number];

/** The longest value kept per field, in code points. */
export const PLAN_REGISTRATION_FIELD_MAX = {
  id: 200,
  session: 200,
  level: 200,
  receiver: 200,
  what: 4000,
  reason: 200,
  from: 500,
  to: 500,
  codeFact: 2000,
  outcomeReason: 2000,
} as const;

type Field = keyof typeof PLAN_REGISTRATION_FIELD_MAX;

/** A registration being MADE: an author session handed work on, or was forced to rename. */
export interface PlanRegistrationRegister {
  op: 'register';
  id: string;
  kind: PlanRegistrationKind;
  /** The card whose author session registered it. */
  session: string;
  /** The level it was registered on — the card's parent ref; null at the top level. */
  level: string | null;
  /** `hand_off`: the card that takes the work. */
  receiver: string | null;
  /** `hand_off`: what is handed on. */
  what: string | null;
  /** `hand_off`: why it is handed on, in the planner's vocabulary. */
  reason: string | null;
  /** `rename`: the name as the level's boundaries settled it. */
  from: string | null;
  /** `rename`: the name the code forces. */
  to: string | null;
  /** `rename`: the code fact that forces it. */
  codeFact: string | null;
  /**
   * Registered AFTER its level's amend had already been handed the level's
   * registrations — no amend will apply it, so it is stored as relayed and a resume
   * never hands it to one.
   */
  relayed: boolean;
}

/** A registration its level's amend was handed, with how the amend settled it. */
export interface PlanRegistrationRelay {
  op: 'relay';
  id: string;
  outcome: PlanRegistrationOutcome;
  /** The amend's one-line reason, or why it raised the hand-off as a gap. */
  reason: string | null;
}

export type PlanRegistrationEntry = PlanRegistrationRegister | PlanRegistrationRelay;

/** A registration entry the door refused, and why — the whole call is refused, nothing written. */
export class PlanRegistrationRefusal extends Error {}

const CONTROL = /\p{Cc}/gu;
const CONTROL_BUT_NEWLINE = /(?!\n)\p{Cc}/gu;

/** Fields whose words may run over lines; every other field is one line. */
const MULTILINE: ReadonlySet<Field> = new Set(['what', 'codeFact', 'outcomeReason']);

type Raw = Record<string, unknown>;

function cap(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

/** An optional string, trimmed, controls dropped and capped; `null` when absent or blank. */
function optionalText(raw: Raw, key: string, field: Field, at: string): string | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string')
    throw new PlanRegistrationRefusal(`${at}.${key} must be a string.`);
  const text = (
    MULTILINE.has(field)
      ? value.replace(/\r\n?/g, '\n').replace(CONTROL_BUT_NEWLINE, ' ')
      : value.replace(CONTROL, ' ')
  ).trim();
  return text.length === 0 ? null : cap(text, PLAN_REGISTRATION_FIELD_MAX[field]);
}

/** A string the entry cannot be stored without — refused, naming it, when absent. */
function requiredText(raw: Raw, field: Field, at: string, why: string): string {
  const value = optionalText(raw, field, field, at);
  if (value === null) throw new PlanRegistrationRefusal(`${at}.${field} is required — ${why}.`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function parseRelay(r: Raw, at: string): PlanRegistrationRelay {
  if (!oneOf(r.outcome, PLAN_REGISTRATION_OUTCOMES)) {
    throw new PlanRegistrationRefusal(
      `${at}.outcome must be one of: ${PLAN_REGISTRATION_OUTCOMES.join(', ')}.`,
    );
  }
  return {
    op: 'relay',
    id: requiredText(
      r,
      'id',
      at,
      "the planner's own id for the registration, which its relay names",
    ),
    outcome: r.outcome,
    reason: optionalText(r, 'reason', 'outcomeReason', at),
  };
}

function parseRegister(r: Raw, at: string): PlanRegistrationRegister {
  if (!oneOf(r.kind, PLAN_REGISTRATION_KINDS)) {
    throw new PlanRegistrationRefusal(
      `${at}.kind must be one of: ${PLAN_REGISTRATION_KINDS.join(', ')}.`,
    );
  }
  if (r.relayed !== undefined && typeof r.relayed !== 'boolean') {
    throw new PlanRegistrationRefusal(`${at}.relayed must be a boolean.`);
  }
  const handOff = r.kind === 'hand_off';
  const need = (field: Field, why: string): string | null => requiredText(r, field, at, why);
  return {
    op: 'register',
    id: requiredText(
      r,
      'id',
      at,
      "the planner's own id for the registration, which its relay names",
    ),
    kind: r.kind,
    session: requiredText(r, 'session', at, 'the card whose author session registered it'),
    level: optionalText(r, 'level', 'level', at),
    receiver: handOff ? need('receiver', 'a hand-off names the card that takes the work') : null,
    what: handOff ? need('what', 'a hand-off says what is handed on') : null,
    reason: handOff ? need('reason', 'a hand-off says why it is handed on') : null,
    from: handOff ? null : need('from', 'a rename names the settled name it changes'),
    to: handOff ? null : need('to', 'a rename names the name the code forces'),
    codeFact: handOff ? null : need('codeFact', 'a rename names the code fact that forces it'),
    relayed: r.relayed === true,
  };
}

/** Parse ONE entry, or throw {@link PlanRegistrationRefusal} naming the field. */
export function parsePlanRegistrationEntry(
  raw: unknown,
  at = 'registrations[0]',
): PlanRegistrationEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlanRegistrationRefusal(`${at} must be an object.`);
  }
  const r = raw as Raw;
  if (r.op === 'relay') return parseRelay(r, at);
  if (r.op !== 'register') {
    throw new PlanRegistrationRefusal(`${at}.op must be one of: register, relay.`);
  }
  return parseRegister(r, at);
}

/** Parse a whole call's batch: 1 to {@link PLAN_REGISTRATION_BATCH_MAX} entries, every one valid. */
export function parsePlanRegistrationEntries(raw: unknown): PlanRegistrationEntry[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PLAN_REGISTRATION_BATCH_MAX) {
    throw new PlanRegistrationRefusal(
      `\`registrations\` is 1 to ${PLAN_REGISTRATION_BATCH_MAX} entries — nothing was recorded.`,
    );
  }
  return raw.map((r, i) => parsePlanRegistrationEntry(r, `registrations[${i}]`));
}
