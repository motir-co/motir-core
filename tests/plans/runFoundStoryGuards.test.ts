import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { REGISTERED_DIFF_KEYS, isRegisteredDiffKey } from '@/lib/activity/renderers';
import {
  assembleDispatchPrompt,
  FULL_FINDINGS_POLICY,
  type DispatchPromptSource,
} from '@/lib/dispatch/promptTemplate';
import { REPORT_UNBUILDABLE_TARGET_TOOL_NAME } from '@/lib/mcp/tools/reportUnbuildableTarget';
import {
  APPROVED_SHAPE_IGNORED_KEYS,
  APPROVED_SHAPE_KEYS,
  isCustomFieldKey,
} from '@/lib/plans/approvedShapeChange';

// THE STORY GATE'S ARCHITECTURE / CONTRACT GUARDS (Story MOTIR-5544 · Subtask
// MOTIR-6232) — the guarantees a coverage percentage cannot see. No database.
//
// The CLI-grant guard (criterion 6) is NOT repeated here: it is asserted off
// `CLI_TOKEN_GRANT` itself in `tests/mcp/get-approved-shape-verdict.test.ts`
// (no `ai:view_plan`; the verdict tool maps to it and is refused) and in
// `tests/mcp/report-unbuildable-target.test.ts` (`work_item:edit` carried; the
// report tool maps to it and is reachable), and over the REAL `/api/mcp` in
// `tests/integration/plans/runFoundStoryGate.test.ts`.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

// ═════════════════════════════════════════════════════════════════════════════
// Criterion 7 — the change predicate's key sets are EXHAUSTIVE
// ═════════════════════════════════════════════════════════════════════════════
//
// A key in NEITHER set is silently IGNORED by `classifyRevision` (the safe side
// for a predicate that files bugs) — which is exactly why a field added later
// must fail HERE instead: ignored-by-default would turn an edited card into
// "unchanged" and file a planning bug the planner never earned.
//
// The population is DERIVED, not typed out, from two sources that already fail
// on their own when a field is added:
//
//   1. `REGISTERED_DIFF_KEYS` — every key a revision writer emits.
//      `tests/work-items/activity-registry-totality.test.ts` statically scans
//      every `recordRevision` call site and fails when a writer emits a key the
//      registry does not hold, so a new writer key reaches this list by force.
//   2. `Prisma.WorkItemScalarFieldEnum` — every column of `work_item`, so a new
//      COLUMN fails here before any writer emits it.

/** Columns no revision writer records. Each is checked below to be really unwritten. */
const NEVER_A_REVISION_KEY: Record<string, string> = {
  id: 'the row identity',
  workspaceId: 'the tenant — a card never moves workspace',
  createdAt: 'written once, by the created row itself',
  updatedAt: 'bookkeeping on every write',
  planningSource: 'provenance of the plan that wrote the card, set at creation',
  planningHarness: 'provenance, set at creation',
  planningModel: 'provenance, set at creation',
  implementationSource: 'provenance of the run that built it',
  implementationHarness: 'provenance of the run that built it',
  implementationModel: 'provenance of the run that built it',
  subject: 'a plan-session anchor, not the card’s shape',
  initRepositoryName:
    'the repository an init card creates, written once from its plan proposal, never a revision (MOTIR-11051)',
  triagedAt: 'intake bookkeeping',
  snoozedUntil: 'intake bookkeeping',
  submittedByUserId: 'intake provenance',
  publicChildrenHidden: 'a public-page display toggle',
  sessionBranch: 'a dispatch run’s branch',
  ciState: 'written by the CI webhook',
  fixReason: 'recomputed by fixReasonService from the delivery set, never a revision (MOTIR-6600)',
  fixDetail: 'written with fixReason by the same recompute, never a revision (MOTIR-6600)',
  completedAt: 'derived from the status category',
  resumeState:
    'derived from the latest run’s end by resumeStateService, never a revision (MOTIR-7707)',
  resumeRunId: 'written with resumeState by the same derivation, never a revision (MOTIR-7707)',
  resumeDetail:
    'the gated run’s delivery-set snapshot, written by the same derivation, never a revision (MOTIR-10308)',
  titleLanguage: 'recorded with the title by its writer, never a revision (MOTIR-8096)',
  descriptionLanguage: 'recorded with the description by its writer, never a revision (MOTIR-8096)',
  explanationLanguage: 'recorded with the explanation by its writer, never a revision (MOTIR-8096)',
  embeddingFailedHash:
    'the embedding sweep’s poison-item bookkeeping, written by raw SQL, never a revision (MOTIR-8227)',
  embeddingFailedAttempts:
    'written with embeddingFailedHash by the same sweep, never a revision (MOTIR-8227)',
};

type Disposition = 'shape' | 'ignored' | 'unclassified' | 'both';

function dispositionOf(key: string): Disposition {
  const shape = APPROVED_SHAPE_KEYS.has(key);
  const ignored = APPROVED_SHAPE_IGNORED_KEYS.has(key) || isCustomFieldKey(key);
  if (shape && ignored) return 'both';
  if (shape) return 'shape';
  if (ignored) return 'ignored';
  return 'unclassified';
}

/** The keys of `population` not classified in exactly one set. */
function misclassified(population: readonly string[]): string[] {
  return population.filter((key) => {
    const d = dispositionOf(key);
    return d === 'unclassified' || d === 'both';
  });
}

describe('the change predicate is EXHAUSTIVE over the fields a revision can carry (criterion 7)', () => {
  it('every key a revision writer emits (the activity registry) is in exactly one set', () => {
    expect(REGISTERED_DIFF_KEYS.length).toBeGreaterThan(20);
    expect(misclassified(REGISTERED_DIFF_KEYS)).toEqual([]);
    // The dynamic custom-field family the registry matches by prefix.
    expect(isRegisteredDiffKey('customFields.risk')).toBe(true);
    expect(dispositionOf('customFields.risk')).toBe('ignored');
  });

  it('every work_item column is classified, or declared never written to a revision', () => {
    const columns = Object.keys(Prisma.WorkItemScalarFieldEnum);
    const undecided = columns.filter(
      (column) =>
        !(column in NEVER_A_REVISION_KEY) &&
        dispositionOf(column) !== 'shape' &&
        dispositionOf(column) !== 'ignored',
    );
    expect(undecided, 'a new work_item column needs a disposition').toEqual([]);
    // No column is declared both classified and unwritten.
    for (const column of Object.keys(NEVER_A_REVISION_KEY)) {
      expect(columns, `${column} is still a work_item column`).toContain(column);
      expect(dispositionOf(column), `${column} is declared unwritten`).toBe('unclassified');
    }
  });

  it('the "never written" declaration is TRUE — no revision writer emits one of those columns', () => {
    for (const column of Object.keys(NEVER_A_REVISION_KEY)) {
      expect(isRegisteredDiffKey(column), `${column} is written by a revision writer`).toBe(false);
    }
  });

  it('FAILS when a new field is added to neither set — the guard is not vacuous', () => {
    const added = [...REGISTERED_DIFF_KEYS, 'acceptanceCriteriaMd'];
    expect(misclassified(added)).toEqual(['acceptanceCriteriaMd']);
    // …and a key placed in BOTH sets is caught too.
    expect(dispositionOf('title')).toBe('shape');
    expect(dispositionOf('status')).toBe('ignored');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Criterion 8 — no Prisma client call outside a repository, on the story's files
// ═════════════════════════════════════════════════════════════════════════════

const STORY_NON_REPOSITORY_FILES = [
  'lib/services/plansService.ts',
  'lib/services/runFoundReportService.ts',
  'lib/plans/approvedShapeChange.ts',
  'lib/plans/runFoundPlanningBug.ts',
  'lib/mcp/tools/getApprovedShapeVerdict.ts',
  'lib/mcp/tools/reportUnbuildableTarget.ts',
] as const;

/**
 * The source with its comments removed, strings kept. A comment QUOTING a Prisma
 * error (`plansService` carries two, from before this story) is not a call.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
    i += 1;
  }
  return out;
}

/** The Prisma-client reaches a non-repository file must not make. */
const CLIENT_CALL_TELLS: readonly RegExp[] = [
  /\bprisma\./,
  /\b(?:db|dbRead|adminDb)\.\$?[A-Za-z]/,
  /\btx\.[a-z][A-Za-z]*\.(?:find|create|update|delete|upsert|count|aggregate|groupBy)/,
  /\$(?:queryRaw|executeRaw)/,
  /from '@\/lib\/db'/,
];

describe('no Prisma client call outside a repository, on the files this story adds (criterion 8)', () => {
  it.each(STORY_NON_REPOSITORY_FILES)('%s', (file) => {
    const code = stripComments(read(file));
    for (const tell of CLIENT_CALL_TELLS) {
      const hit = code.split('\n').find((line) => tell.test(line));
      expect(hit, `${file} matches ${tell}`).toBeUndefined();
    }
  });

  it('the stripper keeps code and drops only comments — the guard is not vacuous', () => {
    const code = stripComments(
      [
        '// a quoted `prisma.planItem.create()` error',
        '/* db.workItem.findMany() */',
        "const url = 'http://example.test'; await db.workItem.findMany();",
      ].join('\n'),
    );
    expect(code).not.toMatch(/prisma\./);
    expect(code).toContain("'http://example.test'");
    expect(CLIENT_CALL_TELLS.some((tell) => tell.test(code))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Criterion 5 — the RENDERED dispatch prompt classifies nothing, and reports once
// ═════════════════════════════════════════════════════════════════════════════

/** A `code` work item, rendered with the given findings policy. */
function render(replan: boolean): string {
  const source: DispatchPromptSource = {
    key: 'PROD-42',
    title: 'Wire the ledger read',
    kind: 'subtask',
    type: 'code',
    executor: 'coding_agent',
    difficulty: null,
    priority: 'high',
    storyPoints: 3,
    estimateMinutes: 60,
    descriptionMd: 'Read the ledger.\n\n## Acceptance criteria\n\n- It reads.',
    blockerKeys: [],
    openDependentKeys: [],
    errorEvidence: [],
    parent: { key: 'PROD-40', title: 'Ledger' },
    projectName: 'Motir',
    projectKey: 'PROD',
    targetRepo: 'motir-core',
    sessionBranch: null,
    findingsPolicy: { ...FULL_FINDINGS_POLICY, replan, autoApproveReplan: false },
    // The prompt a CLI that posts the self-report is handed (MOTIR-8810).
    runnerPostsAgentReport: true,
  };
  return assembleDispatchPrompt(source).prompt;
}

/**
 * The STOP branch of THE CARD IS WRONG, from its sub-heading up to FOUND A DEFECT.
 *
 * Since MOTIR-8658 the block opens with the WHAT test and BUILD THROUGH, which carry words this
 * guard keeps out of the runner's STOP text (the test is quoted verbatim, and says "unchanged").
 * The guard's claim is about the STOP branch, so it starts there; the two branches before it are
 * asserted in `tests/dispatch/promptTemplate.test.ts`.
 */
function cardIsWrongBlock(prompt: string): string {
  // The branch itself, inside REPORTING THE OUTCOME — the heading is also named
  // in passing earlier in the prompt ("see THE CARD IS WRONG below").
  const outcome = prompt.indexOf('REPORTING THE OUTCOME');
  expect(outcome, 'the prompt carries REPORTING THE OUTCOME').toBeGreaterThan(-1);
  const start = prompt.indexOf('STOP — the WHAT itself breaks', outcome);
  expect(start, 'the prompt carries the STOP branch of THE CARD IS WRONG').toBeGreaterThan(-1);
  const end = prompt.indexOf('FOUND A DEFECT', start);
  return prompt.slice(start, end === -1 ? undefined : end);
}

const flat = (text: string) => text.replace(/\s+/g, ' ');

/** Q3's instruction (`docs/decisions/run-findings-protocol.md`). */
const NOT_WHY_PLANNED = /describe what is wrong with the CARD, not why it was planned that way/i;

/**
 * The block's ONE legitimate use of "classify" is Q3's own NEGATION, carried by
 * the re-plan lane since before this story. Removed before the vocabulary check,
 * so the check still fails on any OTHER use.
 */
const Q3_NEGATION = /you are not asked to classify the mistake/i;

const CLASSIFICATION_VOCABULARY = [
  /verdict/i,
  /unchanged/i,
  /\bnative\b/i,
  /planning bug/i,
  /classify/i,
];

describe('the RENDERED dispatch prompt (criterion 5)', () => {
  it.each([
    { lane: 're-planning ON', replan: true },
    { lane: 're-planning OFF', replan: false },
  ])(
    '$lane: exactly ONE report_unbuildable_target step, in the card-is-wrong block',
    ({ replan }) => {
      const prompt = render(replan);
      expect(prompt.split(REPORT_UNBUILDABLE_TARGET_TOOL_NAME)).toHaveLength(2);
      const block = cardIsWrongBlock(prompt);
      expect(block.split(REPORT_UNBUILDABLE_TARGET_TOOL_NAME)).toHaveLength(2);
      expect(flat(block)).toMatch(
        /4\. Report it\. If the environment variable MOTIR_AGENT_REPORT is set, .* report it with the report_unbuildable_target tool: projectKey: PROD targetKey: PROD-42/,
      );
    },
  );

  it.each([
    { lane: 're-planning ON', replan: true },
    { lane: 're-planning OFF', replan: false },
  ])(
    '$lane: the card-is-wrong block carries none of the classification vocabulary',
    ({ replan }) => {
      const block = flat(cardIsWrongBlock(render(replan))).replace(Q3_NEGATION, '');
      for (const word of CLASSIFICATION_VOCABULARY) {
        expect(block, `the block says ${word}`).not.toMatch(word);
      }
    },
  );

  it('re-planning ON: Q3’s instruction — describe the CARD, not why it was planned that way', () => {
    const block = flat(cardIsWrongBlock(render(true)));
    expect(block).toMatch(NOT_WHY_PLANNED);
    expect(block).toMatch(Q3_NEGATION);
  });

  // The re-planning-OFF lane carries Q3's instruction too (MOTIR-6287's criterion 4,
  // closed on the MOTIR-6232 run): step 5's "Your comment is the whole report" says
  // what that comment describes.
  it('re-planning OFF: Q3’s instruction is carried', () => {
    expect(flat(cardIsWrongBlock(render(false)))).toMatch(NOT_WHY_PLANNED);
  });
});
