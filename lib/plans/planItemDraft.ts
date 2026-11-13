// An author session's IN-FLIGHT CARD, as a value (Story MOTIR-11190 · MOTIR-11199):
// the caps the plan-step door enforces and the one parser every stored draft goes
// through. Pure: no I/O.
//
// ⚠️ A DRAFT IS NEVER THE CARD. It is the partial title, description and
// explanation the model has written so far while its `author` tool call streams,
// held on the session's `plan_step` row BESIDE the proposal. Only the completed
// tool call writes the proposal, and every refusal that gates that write still
// applies to it; nothing here reads or writes a `PlanItem`.
//
// ⚠️ EACH REPORT IS WHOLE, NOT A DELTA. A report carries the text so far of each
// field it names and REPLACES the session's previous draft; an absent field means
// the model has not started it yet. `seq` orders the reports of one session, so a
// late report never overwrites a newer one.

/** The longest partial title kept, in characters — far above any real title. */
export const PLAN_ITEM_DRAFT_TITLE_MAX = 1_000;
/** The longest partial description or explanation kept, in characters. */
export const PLAN_ITEM_DRAFT_BODY_MAX = 200_000;

/**
 * Why a draft was refused. `shape` is a body the door must refuse as malformed
 * (400); `cap` is a well-formed draft with a field over its cap (422).
 */
export class PlanItemDraftRefusal extends Error {
  constructor(
    message: string,
    readonly reason: 'shape' | 'cap',
  ) {
    super(message);
    this.name = 'PlanItemDraftRefusal';
  }
}

/** One parsed draft report. */
export interface PlanItemDraftInput {
  /** `planItem:<id>` — must equal the session's current `author` step target. */
  target: string;
  /** Strictly increasing per session, integer ≥ 1. */
  seq: number;
  title?: string;
  descriptionMd?: string;
  explanationMd?: string;
}

const TEXT_FIELDS = [
  ['title', PLAN_ITEM_DRAFT_TITLE_MAX],
  ['descriptionMd', PLAN_ITEM_DRAFT_BODY_MAX],
  ['explanationMd', PLAN_ITEM_DRAFT_BODY_MAX],
] as const;

/** Parse one `itemDraft` body, or throw {@link PlanItemDraftRefusal} naming the field. */
export function parsePlanItemDraft(raw: unknown): PlanItemDraftInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlanItemDraftRefusal('`itemDraft` must be an object.', 'shape');
  }
  const v = raw as Record<string, unknown>;
  if (typeof v.target !== 'string' || v.target.trim() === '') {
    throw new PlanItemDraftRefusal('`itemDraft.target` must be a `planItem:<id>` ref.', 'shape');
  }
  if (!Number.isInteger(v.seq) || (v.seq as number) < 1) {
    throw new PlanItemDraftRefusal('`itemDraft.seq` must be an integer of at least 1.', 'shape');
  }
  const out: PlanItemDraftInput = { target: v.target, seq: v.seq as number };
  let present = 0;
  for (const [key] of TEXT_FIELDS) {
    const value = v[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw new PlanItemDraftRefusal(`\`itemDraft.${key}\` must be a string.`, 'shape');
    }
    present += 1;
  }
  if (present === 0) {
    throw new PlanItemDraftRefusal(
      '`itemDraft` carries at least one of `title`, `descriptionMd` or `explanationMd`.',
      'shape',
    );
  }
  for (const [key, max] of TEXT_FIELDS) {
    const value = v[key] as string | undefined;
    if (value === undefined) continue;
    if (value.length > max) {
      throw new PlanItemDraftRefusal(
        `\`itemDraft.${key}\` is ${value.length} characters; the most kept is ${max}.`,
        'cap',
      );
    }
    out[key] = value;
  }
  return out;
}
