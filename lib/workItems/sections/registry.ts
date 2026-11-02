import { z } from 'zod';
import { ISSUE_TYPES, type IssueType } from '@/lib/issues/parentRules';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';

// THE SECTION-SET REGISTRY (Story MOTIR-9023 · Subtask MOTIR-9026; the approved
// decision page of MOTIR-9024).
//
// A work item's `descriptionMd` stays the ONE stored body, always free text. A
// "section" is an INTERFACE over that body: an agent may hand a door typed
// sections, the door checks them against the set for the card's kind × type and
// RENDERS them into the body, and a parser reads a stored body back into
// sections on request. NOTHING in this module is a storage shape: no column, no
// JSON persistence, no Prisma. It is the one place a section's name, value
// shape, required flag and heading are written down, so the renderer, the
// parser, the doors and validation cannot disagree (the `parentRules.ts`
// precedent: one pure module owns the matrix and everyone reads it).
//
// PURE + deterministic. Imports nothing from services, repositories, Prisma, the
// app or the UI.

/** A value shape, kept as plain data so `describeSectionSets()` can serve it and
 *  the zod schema is DERIVED from it — one source, no copy to drift. */
type Field = { type: 'string'; optional?: boolean } | { type: 'enum'; values: readonly string[] };
export type SectionShape =
  | { type: 'string' }
  | { type: 'stringList' }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'objectList'; fields: Record<string, Field>; min?: number }
  | { type: 'object'; fields: Record<string, Field> };

/** The canonical order sections are emitted in: the unheaded `framing`, the
 *  per-type prose and typed extras, then the boundary, the criteria and the
 *  refs, then a decision's writing brief, with `otherSections` (every heading no
 *  section defines) last. The brief follows the refs because that is where it
 *  stood while it travelled as `otherSections`, so a body written then
 *  re-renders in the same order; `alternatives` and `consumers` (MOTIR-10206)
 *  slot between its four original headings, which no stored body carried. */
export const SECTION_ORDER = [
  'framing',
  'question',
  'why',
  'options',
  'choiceOptions',
  'recommendation',
  'states',
  'cases',
  'tier',
  'strings',
  'reproduction',
  'deliverables',
  'approach',
  'outline',
  'home',
  'steps',
  'postDeployVerification',
  'rollback',
  'verificationRecipe',
  'assumptions',
  'gates',
  'scopeBoundary',
  'acceptanceCriteria',
  'contextRefs',
  'decisionBrief',
  'alternatives',
  'whatChanged',
  'consumers',
  'supersedes',
  'resultingDirection',
  'otherSections',
] as const;

export type SectionName = (typeof SECTION_ORDER)[number];

interface CatalogueEntry {
  /** The heading the section renders under; `null` for the unheaded opening. */
  heading: string | null;
  shape: SectionShape;
}

const str: SectionShape = { type: 'string' };
const list: SectionShape = { type: 'stringList' };

/** One entry per section. `options` (a legacy decision's) and `choiceOptions` (a
 *  choice's) share the `## Options` heading because they never share a set.
 *  `decisionBrief` · `alternatives` · `whatChanged` · `consumers` · `supersedes` ·
 *  `resultingDirection` are the six headings of a decision's writing brief
 *  (`motir-meta` `plan-rules/type-decision.md`; MOTIR-9211, MOTIR-10206). */
export const SECTION_CATALOGUE: Record<SectionName, CatalogueEntry> = {
  framing: { heading: null, shape: str },
  question: { heading: 'Question', shape: str },
  why: {
    heading: 'Why this is a choice',
    shape: {
      type: 'object',
      fields: {
        situation: {
          type: 'enum',
          values: ['contradicts_your_decision', 'better_than_your_decision', 'two_workflows'],
        },
        youSaid: { type: 'string', optional: true },
        evidence: { type: 'string' },
      },
    },
  },
  options: {
    heading: 'Options',
    shape: {
      type: 'objectList',
      fields: {
        label: { type: 'string' },
        cost: { type: 'string' },
        forecloses: { type: 'string' },
      },
    },
  },
  choiceOptions: {
    heading: 'Options',
    shape: {
      type: 'objectList',
      min: 2,
      fields: {
        label: { type: 'string' },
        bestFor: { type: 'string' },
        why: { type: 'string', optional: true },
      },
    },
  },
  recommendation: { heading: 'Recommendation', shape: str },
  states: { heading: 'States', shape: list },
  cases: {
    heading: 'Cases',
    shape: {
      type: 'objectList',
      fields: { condition: { type: 'string' }, expected: { type: 'string' } },
    },
  },
  tier: { heading: 'Tier', shape: { type: 'enum', values: ['unit', 'integration', 'e2e'] } },
  strings: {
    heading: 'Strings',
    shape: {
      type: 'objectList',
      fields: { key: { type: 'string' }, locale: { type: 'string' }, says: { type: 'string' } },
    },
  },
  reproduction: { heading: 'Reproduction', shape: str },
  deliverables: { heading: 'Deliverables', shape: str },
  approach: { heading: 'Approach', shape: str },
  outline: { heading: 'Outline', shape: str },
  home: { heading: 'Home', shape: str },
  steps: { heading: 'Steps', shape: str },
  postDeployVerification: { heading: 'Post-deploy verification', shape: str },
  rollback: { heading: 'Rollback', shape: str },
  verificationRecipe: { heading: 'Verification recipe', shape: str },
  assumptions: { heading: 'Assumptions', shape: list },
  gates: { heading: 'What this choice gates', shape: str },
  scopeBoundary: { heading: 'Scope BOUNDARY', shape: str },
  acceptanceCriteria: { heading: 'Acceptance criteria', shape: list },
  contextRefs: {
    heading: 'Context refs',
    shape: { type: 'objectList', fields: { ref: { type: 'string' }, why: { type: 'string' } } },
  },
  decisionBrief: { heading: 'Decision', shape: str },
  alternatives: { heading: 'Alternatives considered', shape: list },
  whatChanged: { heading: 'What changed', shape: str },
  consumers: { heading: 'Consumed by', shape: list },
  supersedes: { heading: 'Supersedes', shape: str },
  resultingDirection: { heading: 'Resulting direction', shape: str },
  otherSections: {
    heading: null,
    shape: {
      type: 'objectList',
      fields: { heading: { type: 'string' }, body: { type: 'string' } },
    },
  },
};

/** What a type adds to the leaf core. Total over `WorkItemTypeDto`: a new member
 *  without an entry is a compile error, never a silent default. */
interface TypeExtras {
  required: readonly SectionName[];
  optional: readonly SectionName[];
  /** A LEGACY shape a STORED body may still carry: a body holding every section
   *  of it reads complete, so a committed card written before the type's
   *  required set changed is not reported missing. Honoured only when the caller
   *  asks (`checkSections`' `acceptLegacy`): a read of a stored body, never a new
   *  card's write. */
  legacy?: readonly SectionName[];
}
const TYPE_EXTRAS: Record<WorkItemTypeDto, TypeExtras> = {
  code: { required: [], optional: ['deliverables', 'approach'] },
  design: { required: ['states'], optional: ['approach'] },
  test: { required: ['cases', 'tier'], optional: ['approach'] },
  content: { required: [], optional: ['outline', 'home'] },
  copy: { required: ['strings'], optional: [] },
  translate: { required: [], optional: [] },
  research: { required: [], optional: ['approach'] },
  review: { required: [], optional: [] },
  verification: { required: [], optional: ['steps'] },
  // A decision is the WRITE-UP of a decision already made in planning, never an
  // open question (MOTIR-10206): its writing brief is required. The retired
  // RESEARCHED shape's question, options and recommendation stay readable as
  // optional sections, and a stored body carrying all three still reads complete.
  decision: {
    required: [
      'decisionBrief',
      'alternatives',
      'whatChanged',
      'consumers',
      'supersedes',
      'resultingDirection',
    ],
    optional: ['question', 'options', 'recommendation'],
    legacy: ['question', 'options', 'recommendation'],
  },
  choice: { required: ['question', 'why', 'choiceOptions', 'gates'], optional: [] },
  deploy: { required: [], optional: ['steps', 'postDeployVerification', 'rollback'] },
  manual: { required: [], optional: [] },
  legal: { required: [], optional: ['approach'] },
  chore: { required: [], optional: ['deliverables'] },
};

export type SectionType = WorkItemTypeDto | null;

export interface SectionSet {
  kind: IssueType;
  type: SectionType;
  /** Every section the cell defines, in canonical order. */
  sections: readonly SectionName[];
  /** The subset that must be present and non-empty. */
  required: readonly SectionName[];
  /** A legacy shape a stored body may carry in place of the type's required
   *  extras, in canonical order; empty when the type has none. */
  legacy: readonly SectionName[];
}

/** The value of one section, as an input / parsed-view type. Never persisted. */
export type WorkItemSections = Partial<{
  framing: string;
  question: string;
  why: { situation: string; youSaid?: string; evidence: string };
  options: { label: string; cost: string; forecloses: string }[];
  choiceOptions: { label: string; bestFor: string; why?: string }[];
  recommendation: string;
  states: string[];
  cases: { condition: string; expected: string }[];
  tier: 'unit' | 'integration' | 'e2e';
  strings: { key: string; locale: string; says: string }[];
  reproduction: string;
  deliverables: string;
  approach: string;
  outline: string;
  home: string;
  steps: string;
  postDeployVerification: string;
  rollback: string;
  verificationRecipe: string;
  assumptions: string[];
  gates: string;
  scopeBoundary: string;
  acceptanceCriteria: string[];
  contextRefs: { ref: string; why: string }[];
  decisionBrief: string;
  alternatives: string[];
  whatChanged: string;
  consumers: string[];
  supersedes: string;
  resultingDirection: string;
  otherSections: { heading: string; body: string }[];
}>;

export interface SectionCheck {
  missing: string[];
  unknown: string[];
  invalid: { section: string; message: string }[];
}

const LEAF_CORE_REQUIRED: readonly SectionName[] = [
  'framing',
  'scopeBoundary',
  'acceptanceCriteria',
  'contextRefs',
];

function assertNever(value: never): never {
  throw new Error(`Unhandled work item kind: ${String(value)}`);
}

function setFor(
  kind: IssueType,
  type: SectionType,
): { required: SectionName[]; optional: SectionName[]; legacy?: readonly SectionName[] } {
  switch (kind) {
    case 'epic':
      return { required: ['framing', 'scopeBoundary'], optional: ['contextRefs', 'assumptions'] };
    case 'story':
      // A story carries no type: `type` is ignored.
      return {
        required: [
          'framing',
          'scopeBoundary',
          'acceptanceCriteria',
          'verificationRecipe',
          'contextRefs',
        ],
        optional: ['assumptions'],
      };
    case 'task':
    case 'subtask':
    case 'bug': {
      const extras = type ? TYPE_EXTRAS[type] : { required: [], optional: [] };
      const required = [...LEAF_CORE_REQUIRED, ...extras.required];
      if (kind === 'bug') required.push('reproduction');
      return { required, optional: ['assumptions', ...extras.optional], legacy: extras.legacy };
    }
    default:
      return assertNever(kind);
  }
}

/** The set for one kind × type cell. TOTAL over the imported enumerations. */
export function sectionSetFor(kind: IssueType, type: SectionType): SectionSet {
  const { required, optional, legacy = [] } = setFor(kind, type);
  const wanted = new Set<SectionName>([...required, ...optional, 'otherSections']);
  const sections = SECTION_ORDER.filter((name) => wanted.has(name));
  const requiredSet = new Set(required);
  const legacySet = new Set(legacy);
  return {
    kind,
    type: kind === 'story' || kind === 'epic' ? null : type,
    sections,
    required: SECTION_ORDER.filter((name) => requiredSet.has(name)),
    legacy: SECTION_ORDER.filter((name) => legacySet.has(name)),
  };
}

function fieldSchema(field: Field): z.ZodType {
  const base: z.ZodType =
    field.type === 'enum'
      ? z.enum(field.values as [string, ...string[]])
      : z.string().trim().min(1);
  return field.type === 'string' && field.optional ? base.optional() : base;
}

function shapeSchema(shape: SectionShape): z.ZodType {
  switch (shape.type) {
    case 'string':
      return z.string().trim().min(1);
    case 'stringList':
      return z.array(z.string().trim().min(1)).min(1);
    case 'enum':
      return z.enum(shape.values as [string, ...string[]]);
    case 'object':
      return z.strictObject(
        Object.fromEntries(Object.entries(shape.fields).map(([k, f]) => [k, fieldSchema(f)])),
      );
    case 'objectList':
      return z
        .array(
          z.strictObject(
            Object.fromEntries(Object.entries(shape.fields).map(([k, f]) => [k, fieldSchema(f)])),
          ),
        )
        .min(shape.min ?? 1);
  }
}

/** A STRICT zod object for the cell, used to check a sections INPUT on write. A
 *  key the cell does not define is refused and the refusal names it. */
export function sectionsSchemaFor(kind: IssueType, type: SectionType) {
  const set = sectionSetFor(kind, type);
  const required = new Set<string>(set.required);
  const shape: Record<string, z.ZodType> = {};
  for (const name of set.sections) {
    // `otherSections` is the named-prose home for headings nothing defines; it
    // may legitimately carry an empty body, so its entries are not trimmed-min.
    const base =
      name === 'otherSections'
        ? z.array(z.strictObject({ heading: z.string().trim().min(1), body: z.string() }))
        : shapeSchema(SECTION_CATALOGUE[name].shape);
    shape[name] = required.has(name) ? base : base.optional();
  }
  return z.strictObject(shape);
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export interface CheckSectionsOptions {
  /** Read a STORED body: one carrying every section of its type's legacy shape
   *  is complete, so only the leaf core and the kind's own sections can be
   *  missing. A new card's write never sets it. */
  acceptLegacy?: boolean;
}

/** Check a sections value against its cell and answer by section NAME. Never
 *  throws. The same check serves a door's sections input and the parser's read
 *  of a stored body. */
export function checkSections(
  kind: IssueType,
  type: SectionType,
  value: unknown,
  options: CheckSectionsOptions = {},
): SectionCheck {
  const set = sectionSetFor(kind, type);
  const input =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const defined = new Set<string>(set.sections);
  const unknown = Object.keys(input).filter((key) => !defined.has(key));
  const legacyHeld =
    options.acceptLegacy === true &&
    set.legacy.length > 0 &&
    set.legacy.every((name) => !isEmpty(input[name]));
  const typeRequired = new Set<SectionName>(
    type && (kind === 'task' || kind === 'subtask' || kind === 'bug')
      ? TYPE_EXTRAS[type].required
      : [],
  );
  const missing = set.required.filter(
    (name) => isEmpty(input[name]) && !(legacyHeld && typeRequired.has(name)),
  );
  const invalid: SectionCheck['invalid'] = [];
  for (const name of set.sections) {
    if (isEmpty(input[name]) && name !== 'otherSections') continue;
    if (input[name] === undefined) continue;
    const schema =
      name === 'otherSections'
        ? sectionsSchemaFor(kind, type).shape.otherSections
        : shapeSchema(SECTION_CATALOGUE[name].shape);
    const result = schema?.safeParse(input[name]);
    if (result && !result.success) {
      invalid.push({ section: name, message: result.error.issues[0]?.message ?? 'Invalid value' });
    }
  }
  return { missing: [...missing], unknown, invalid };
}

export const SECTION_SETS_VERSION = 'sections-v1';

export interface SectionSetsDescriptor {
  version: string;
  sections: Record<string, { heading: string | null; shape: SectionShape }>;
  sets: { kind: IssueType; type: SectionType; sections: { name: string; required: boolean }[] }[];
}

/** A JSON-serialisable descriptor of every cell, in a stable order — what the
 *  serve card serves, so the registry stays the one source. */
export function describeSectionSets(): SectionSetsDescriptor {
  const sets: SectionSetsDescriptor['sets'] = [];
  for (const kind of ISSUE_TYPES) {
    for (const type of [null, ...WORK_ITEM_TYPES] as SectionType[]) {
      const set = sectionSetFor(kind, type);
      const required = new Set<string>(set.required);
      sets.push({
        kind,
        type,
        sections: set.sections.map((name) => ({ name, required: required.has(name) })),
      });
    }
  }
  return {
    version: SECTION_SETS_VERSION,
    sections: Object.fromEntries(
      SECTION_ORDER.map((name) => [
        name,
        { heading: SECTION_CATALOGUE[name].heading, shape: SECTION_CATALOGUE[name].shape },
      ]),
    ),
    sets,
  };
}
