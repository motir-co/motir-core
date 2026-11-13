// ── The sections INPUT of a plan proposal, at EVERY plan write door ───────────
// (Story MOTIR-9023 · Subtask MOTIR-9030; `docs/decisions/` — sections are a
// WRITE interface over the free-text `descriptionMd`.)
//
// A planner may send a proposal's sections as one optional typed `sections`
// object beside `descriptionMd`. This is the ONE implementation of what a door
// does with it: check the sections against the registry for the proposal's
// MERGED kind × type, refuse a missing / unknown / invalid section BY NAME,
// render them, and hand back the `descriptionMd` the door stores. The `sections`
// object itself is never persisted — nothing structured is stored, and
// `PlanItemProposedFields` gains no key. The append, the deepen, the revise, the
// correction and the internal PATCH all call {@link applySectionsInput}, so the
// transports cannot disagree about a rule.
//
// A write that sends no `sections` never reaches this module's rules: it stores
// `descriptionMd` as sent, byte for byte, exactly as before (rule 4 of the
// card). {@link hasSectionsInput} is the question a door asks first.
//
// PURE: no DB, no Prisma client, no `tx`. The CALLER owns the read of the
// current body and the lock that makes read-merge-render-write atomic (the plan
// row lock `editAddProposal` already takes). Every refusal is an
// `InvalidProposalError` — a 422 `INVALID_PROPOSAL` on every door.

import { ISSUE_TYPES, type IssueType } from '@/lib/issues/parentRules';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import { isManualReadyItem } from '@/lib/dto/ready';
import type { ExecutorDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import { InvalidProposalError } from '@/lib/plans/errors';
import { renderSections } from '@/lib/workItems/sections/render';
import { parseSections } from '@/lib/workItems/sections/parse';
import {
  checkSections,
  type SectionType,
  type WorkItemSections,
} from '@/lib/workItems/sections/registry';

/** True when a door's input carries a `sections` key at all (present and not
 *  `undefined`). An explicit `null` counts as sent so it is refused by name
 *  rather than silently read as "no sections". */
export function hasSectionsInput(input: { sections?: unknown } | null | undefined): boolean {
  return input?.sections !== undefined;
}

export interface ApplySectionsArgs {
  /** The `sections` value as it arrived. */
  sections: unknown;
  /** The `descriptionMd` the SAME call sent — `undefined` when it sent none. */
  descriptionMd: string | null | undefined;
  /** The stored body before this call; `undefined`/`null` on an `add` that has
   *  none yet. Only an edit has one. */
  currentBody: string | null | undefined;
  /** The MERGED kind — the cell is judged on what the item will BE. */
  kind: string;
  /** The MERGED type. */
  type: string | null | undefined;
  /** The card's EFFECTIVE executor after this write — the explicit one, else the
   *  one seeded from the type (`resolveExecutor`). With the type it decides
   *  whether a PERSON does the card, which refuses a sent `steps` section
   *  (MOTIR-11161). `undefined` / `null` reads as no executor. */
  executor?: string | null;
  /** How the proposal is named in a plan-door refusal (`proposalLabel(...)`).
   *  The work-item doors raise their own typed errors and never read it. */
  label: string;
}

/**
 * The structured answer of {@link resolveSectionsInput}: the body to store, or
 * the refusal in the two shapes the two door families need. `detail` is the whole
 * sentence (no label), which the plan doors prefix with the proposal's label;
 * `missing` / `unknown` / `invalid` are the same findings by name, which the
 * work-item doors carry on `InvalidSectionsError`.
 */
export type SectionsOutcome =
  | { ok: true; body: string }
  | {
      ok: false;
      /** `conflict` — `sections` beside `descriptionMd`; `shape` — not an object,
       *  or a kind / type the registry has no cell for; `sections` — a missing,
       *  unknown or invalid section. */
      reason: 'conflict' | 'shape' | 'sections';
      detail: string;
      missing: string[];
      unknown: string[];
      invalid: { section: string; message: string }[];
    };

/**
 * Why a sent `steps` section is refused on a person's card (MOTIR-11161). A
 * person's card — `executor: human`, or `type: manual`, the product's own test
 * ({@link isManualReadyItem}) — is worked from its to-do list: the list is what
 * the person ticks and the reviewer reads, so a `## Steps` section beside it is a
 * second copy of the procedure that drifts from it. Both planners are told the
 * steps live in the list alone, and the deploy section set offered them a
 * `steps` section too; the door, which every body write passes, settles it.
 */
export const PERSON_CARD_STEPS_REFUSAL =
  "a person's card keeps its steps in `todos`, one row per operation — not in a `## Steps` section";

/**
 * True when this write SENDS a `steps` section on a person's card. Only a sent,
 * non-null value counts: an explicit `null` clears the section (the way out of
 * a stored `## Steps`), and a `## Steps` the stored body already carries is
 * merged like any legacy text, so an edit that does not resend it still lands.
 */
function sendsStepsOnPersonsCard(
  sent: Record<string, unknown>,
  type: string | null,
  executor: string | null | undefined,
): boolean {
  if (sent.steps === undefined || sent.steps === null) return false;
  return isManualReadyItem({
    type: type as WorkItemTypeDto | null,
    executor: (executor ?? null) as ExecutorDto | null,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refuse(
  reason: 'conflict' | 'shape',
  detail: string,
): Extract<SectionsOutcome, { ok: false }> {
  return { ok: false, reason, detail, missing: [], unknown: [], invalid: [] };
}

/**
 * Resolve a sections input into the `descriptionMd` to store, or say why not.
 * The ONE implementation of the rules; {@link applySectionsInput} (plan doors,
 * `InvalidProposalError`) and the work-item doors (`InvalidSectionsError`) both
 * read it, so one partial `sections` behaves alike on both families.
 *
 *  1. `sections` + no `descriptionMd`, no stored body → check, render.
 *  2. `sections` + no `descriptionMd`, a stored body (an edit) → SPARSE at the
 *     section key: the stored body is PARSED, the sent sections merged over the
 *     result (an omitted section is kept, an explicit `null` clears it, a list
 *     REPLACES the list), then checked and rendered. Text the parser could not
 *     place rides through in `framing` / `otherSections`, so none is lost.
 *  3. `sections` + `descriptionMd` → refused naming both keys.
 *  4. A `steps` section SENT on a person's card (`executor: human` or `type:
 *     manual`) → refused by name, pointing at `todos` (MOTIR-11161). An agent's
 *     card keeps `steps` wherever its cell defines it.
 */
export function resolveSectionsInput(args: ApplySectionsArgs): SectionsOutcome {
  if (!isPlainObject(args.sections)) {
    return refuse(
      'shape',
      `\`sections\` must be an object of named sections (see get_section_sets), not ${
        args.sections === null
          ? 'null'
          : Array.isArray(args.sections)
            ? 'a list'
            : typeof args.sections
      }.`,
    );
  }
  if (args.descriptionMd !== undefined) {
    return refuse(
      'conflict',
      'send `sections` or `descriptionMd`, not both — the body is rendered from the ' +
        'sections, and two sources would contradict each other.',
    );
  }

  const kind = args.kind;
  if (!(ISSUE_TYPES as readonly string[]).includes(kind)) {
    return refuse(
      'shape',
      `\`sections\` cannot be checked for kind '${kind}'. Legal kinds: ${ISSUE_TYPES.join(', ')}.`,
    );
  }
  const type = args.type ?? null;
  if (type !== null && !(WORK_ITEM_TYPES as readonly string[]).includes(type)) {
    return refuse(
      'shape',
      `\`sections\` cannot be checked for type '${type}'. Legal types: ${WORK_ITEM_TYPES.join(', ')}.`,
    );
  }
  const issueKind = kind as IssueType;
  const sectionType = type as SectionType;

  const sent = args.sections;
  const hasBody = typeof args.currentBody === 'string' && args.currentBody.trim().length > 0;
  const parsed = hasBody ? parseSections(args.currentBody, issueKind, sectionType) : null;

  const merged: Record<string, unknown> = { ...(parsed?.sections ?? {}) };
  for (const [key, value] of Object.entries(sent)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }

  // An EDIT of a stored body keeps its legacy shape legal; a new card (no body)
  // is held to the current required set (MOTIR-10206).
  const check = checkSections(issueKind, sectionType, merged, { acceptLegacy: hasBody });
  // A person's card refuses a SENT `steps` by name, whatever the cell says of it
  // — defined (deploy, verification) or not (manual, review…) — so the one
  // finding replaces the cell's own `unknown` / `invalid` reading of it.
  const personSteps = sendsStepsOnPersonsCard(sent, type, args.executor);
  const unknown = personSteps ? check.unknown.filter((s) => s !== 'steps') : [...check.unknown];
  const problems: string[] = [];
  if (check.missing.length > 0) {
    problems.push(`missing required section(s): ${check.missing.join(', ')}`);
  }
  if (unknown.length > 0) {
    problems.push(
      `section(s) not defined for a ${kind}${type ? ` of type ${type}` : ''}: ${unknown.join(', ')}`,
    );
  }
  const invalid = check.invalid
    .filter((i) => !(personSteps && i.section === 'steps'))
    .map((i) => ({ section: i.section, message: i.message }));
  if (personSteps) invalid.unshift({ section: 'steps', message: PERSON_CARD_STEPS_REFUSAL });
  // A section the stored body carries but the parser could not read into its
  // shape is never silently fixed: unless the caller resends it, it is named.
  for (const i of parsed?.invalid ?? []) {
    if (!(i.section in sent) && !check.missing.includes(i.section)) {
      invalid.push({ section: i.section, message: `${i.message} in the stored body — resend it` });
    }
  }
  if (invalid.length > 0) {
    problems.push(
      `invalid section(s): ${invalid.map((i) => `${i.section} (${i.message})`).join(', ')}`,
    );
  }
  if (problems.length > 0) {
    return {
      ok: false,
      reason: 'sections',
      detail: `sections ${problems.join('; ')}.`,
      missing: [...check.missing],
      unknown,
      invalid,
    };
  }

  return { ok: true, body: renderSections(issueKind, sectionType, merged as WorkItemSections) };
}

/** The plan doors' form: the same resolution, refused as `InvalidProposalError`. */
export function applySectionsInput(args: ApplySectionsArgs): string {
  const outcome = resolveSectionsInput(args);
  if (!outcome.ok) throw new InvalidProposalError(`${args.label}: ${outcome.detail}`);
  return outcome.body;
}
