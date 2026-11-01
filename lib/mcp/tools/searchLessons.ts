import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { projectsService } from '@/lib/services/projectsService';
import { projectLessonsService } from '@/lib/services/projectLessonsService';
import { enforceAiRateLimit } from '@/lib/rateLimit/aiGuard';
import { RATE_LIMITED_CODE } from '@/lib/rateLimit/guard';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { LessonSearchResult } from '@/lib/dto/projectLessons';
import {
  LESSON_PHASES,
  LESSON_PHASE_REFUSAL,
  canonicalizeLessonPhases,
  preprocessLessonPhases,
} from '@/lib/lessons/phaseAxis';
import { LESSON_KINDS } from '@/lib/lessons/kindAxis';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `search_lessons` (Story MOTIR-3466 · Subtask MOTIR-3480) — READ the lesson
// corpus by meaning. The pull half of the loop whose write half `add_lesson.ts`
// ships beside this file, and a thin adapter over
// `projectLessonsService.searchLessons` (MOTIR-3478): resolve the context, spend
// the allowance, call the service, `toolOk` / `toToolError`. No business logic
// here — the permission check, the project resolution and the scope predicate
// all belong below, so the next caller inherits them.
//
// ⚠️ THE DESCRIPTION IS THE DELIVERABLE, and more so here than on most tools,
// because it is the only briefing the calling agent gets and because this tool
// FAILS SOFTLY WHEN MISUSED. The retrieval arithmetic is:
//
//     WHERE  … kinds/types/phases overlap …      ← chooses the candidate POOL
//       AND  (subject IS NULL OR subject = $s)    ← the SCALAR fourth axis
//     ORDER BY "embedding" <=> query ASC         ← chooses which few arrive
//     LIMIT  n
//
// ⚠️ THE FOURTH AXIS IS NOT AN OVERLAP — it is scalar, and its clause admits the
// UNTAGGED row as well as the matching one. A lesson with no subject is more
// general than any subject, so narrowing must not exclude it; the three set
// axes get the same treatment for the same reason, via their own empty-set arm.
//
// The axes only cut the pool. **The query TEXT does the remaining selection**,
// so a weak query returns n near-arbitrary rows out of a correctly-filtered
// slice — which reads as the mechanism working while it hands back noise. An
// agent that gets noise concludes the corpus is thin, not that its question was.
// Hence: "narrow by axis, THEN ask a real question", and an explanation of what
// a lesson IS, so the caller writes in the register the rows are stored in.
//
// ⚠️ PROSE, NOT IDENTIFIERS — deliberately unlike `search_work_items_semantic`,
// which returns `key` / `title` / `score` and tells the caller to read each one
// through `get_work_item`. That rule (`docs/decisions/plan-tree-embeddings.md`
// §2) governs claims ABOUT THE PRODUCT, which must trace to a keyed read: a
// small cosine distance is not evidence that two cards are the same work. A
// lesson makes no claim about the product. It is guidance written to be read,
// the same rows already reach the hosted planner as prose by injection, and
// withholding the text here would mean an agent may read a lesson the harness
// picked and may not read one it picked itself. This EXTENDS the no-RAG stance
// rather than reversing it — `motir-ai`'s `retrievalTools.ts` records it in full.

export const SEARCH_LESSONS_TOOL_NAME = 'search_lessons';

/** The store's routing-axis vocabularies, mirrored from motir-ai's enums. The
 *  KIND axis lives in `lib/lessons/kindAxis.ts` (MOTIR-5622), shared with the
 *  other lesson tool so the two cannot disagree. */
const LESSON_TYPES = [
  'code',
  'design',
  'test',
  'content',
  'copy',
  'translate',
  'research',
  'review',
  'verification',
  'decision',
  'choice',
  'deploy',
  'manual',
  'legal',
  'chore',
] as const;

const LIMIT_DEFAULT = 8;
const LIMIT_MAX = 50;

const inputSchema = {
  projectKey: projectKeyField,
  query: z
    .string()
    .min(1)
    .describe(
      'Your question, in TAKEAWAY register — the action you are about to take and the SHAPE of ' +
        'what could go wrong, in the words a lesson would be written in: "counting a population ' +
        'from a working tree instead of a ref". NOT the card\'s title ("board filter at scale"), ' +
        'which queries the wrong register and ranks by accident. This text is what decides which ' +
        'lessons arrive, so it is worth a sentence rather than a phrase. A card with more than ' +
        'one distinct risk deserves more than one search: one call returns a handful, and one ' +
        'query cannot rank for three different failure shapes.',
    ),
  kinds: z
    .array(z.enum(LESSON_KINDS))
    .optional()
    .describe(
      'The LEVEL this search is about: the work-item KIND you are writing or laying under, or ' +
        '"project" / "onboarding" when laying a project\'s top level ("onboarding" for a first ' +
        'plan carved from the direction docs). Laying a level narrows on the target you lay ' +
        'under, not the kind of its children. Omitting it leaves the axis UNCONSTRAINED, ' +
        'which is often right — a lesson tagged with no kind reaches every query either way.',
    ),
  types: z
    .array(z.enum(LESSON_TYPES))
    .optional()
    .describe(
      'The work TYPE(s) this search is about (code, design, test, …). Omitting it leaves the ' +
        'axis unconstrained.',
    ),
  phases: z
    .preprocess(
      preprocessLessonPhases,
      z.array(z.enum([...LESSON_PHASES], { message: LESSON_PHASE_REFUSAL })),
    )
    .optional()
    .describe(
      'Which part of a card you are writing: "lay" (laying a level\'s children — shape, ' +
        'edges, coverage) or "author" (writing a body — criteria, sizing, claims). The retired ' +
        'spellings "skeleton" and "deepen" are still accepted and read as "lay" and ' +
        '"author"; they are removed in a later release. The ' +
        'coordinate only you can supply.',
    ),
  subject: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'WHICH SUBJECT MATTER this search is about — the FOURTH routing axis, the same one ' +
        '`add_lesson` records a lesson against (`data`, `jobs`, `llm`, `mcp`, …). SCALAR: one ' +
        'subject or none, never a list, because a lesson has one. Narrowing on it returns the ' +
        'lessons carrying that subject AND the lessons carrying none — an untagged lesson is ' +
        'MORE general than either subject, so it still reaches every query. Omitting it leaves ' +
        'the axis unconstrained. MEMBERSHIP IS NOT VALIDATED, exactly as on the write side: an ' +
        'unrecognised value is accepted and simply matches no subject-tagged row, so a typo ' +
        'narrows to the untagged lessons rather than erroring.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIMIT_MAX)
    .optional()
    .describe(`How many lessons to return, nearest first. Default ${LIMIT_DEFAULT}.`),
};

/**
 * The messages for the two empty outcomes.
 *
 * ⚠️ THEY ARE DIFFERENT SENTENCES BECAUSE THEY ARE OPPOSITE ANSWERS. "Nothing
 * matched" means the corpus was consulted and has nothing — proceed. "The corpus
 * could not be reached" means it was NOT consulted and the caller is working
 * blind. Rendering the second as the first is a search that reports "nothing
 * exists" truthfully and wrongly, and the agent proceeds believing it checked.
 */
export const NO_LESSON_MATCHED_MESSAGE =
  'No recorded lesson matches that question on those axes. That is a normal answer — the corpus ' +
  'is a record of mistakes actually made, not a checklist. Proceed with the rules you already ' +
  'have. (If you narrowed on several axes, try again with fewer.)';

export const LESSON_CORPUS_UNAVAILABLE_MESSAGE =
  'The lesson corpus could NOT BE REACHED, so this is not an answer about what it contains. ' +
  'Do not read it as "no lessons apply" — nothing was searched. Proceed with the rules you ' +
  'already have, and say in your report that the corpus was unavailable.';

/** Render the hit list: `title` → `howToApply`, plus the axes each row is tagged on. */
export function summarizeLessonSearch(result: LessonSearchResult): string {
  if (result.outcome === 'unavailable') return LESSON_CORPUS_UNAVAILABLE_MESSAGE;
  if (result.outcome === 'nothing-matched') return NO_LESSON_MATCHED_MESSAGE;
  const rows = result.lessons.map((l, i) => {
    const axes = [
      l.kinds.length > 0 ? `kinds: ${l.kinds.join('/')}` : null,
      l.types.length > 0 ? `types: ${l.types.join('/')}` : null,
      l.phases.length > 0 ? `phases: ${l.phases.join('/')}` : null,
      // The fourth axis earns its place in the tag for the same reason as the
      // three above: on a subject-narrowed search the result set legitimately
      // MIXES rows carrying the subject with rows carrying none, and the tag is
      // the only thing that says which is which.
      l.subject ? `subject: ${l.subject}` : null,
    ].filter((x): x is string => x !== null);
    // The axis tag is what lets a caller see WHY a row came back and re-narrow.
    const tag = axes.length > 0 ? ` [${axes.join(' · ')}]` : ' [unconstrained]';
    // The id rides the PROSE as well as the payload (MOTIR-10191): it is what
    // `reinforce_lesson` takes, and a driver that sees only a result's text — a
    // `claude -p` stream — records the ids a session was shown from it.
    return `${i + 1}. ${l.title}${tag} (${l.scope}) · id ${l.id}\n   ${l.body}\n   → ${l.howToApply}`;
  });
  return [
    `${result.lessons.length} recorded lesson(s), nearest first. Each is a mistake made before; APPLY it.`,
    ...rows,
  ].join('\n');
}

/** The adapter: resolve the project, spend the AI allowance, then search. */
export async function runSearchLessons(
  args: {
    projectKey: string;
    query: string;
    kinds?: (typeof LESSON_KINDS)[number][];
    types?: (typeof LESSON_TYPES)[number][];
    phases?: string[];
    subject?: string;
    limit?: number;
  },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);

    // The money gate, AFTER the browse gate the line above applies and BEFORE
    // the upstream call — the same placement and the same reasoning as
    // `search_work_items_semantic`: each query costs a provider embedding, and a
    // caller who cannot browse the project must never spend the owner's budget
    // on a refusal. A refusal is a tool error rather than a 429 because by the
    // time a tool callback runs the JSON-RPC response is already committed to
    // 200.
    const refusal = await enforceAiRateLimit(ctx, 'ai:chat');
    if (refusal) {
      const retryAfter = refusal.headers.get('Retry-After');
      return toolError(
        RATE_LIMITED_CODE,
        `Too many AI requests. "${SEARCH_LESSONS_TOOL_NAME}" embeds your query through Motir's ` +
          `AI backend and draws the same allowance as the planning chat. Retry in ${retryAfter} ` +
          'seconds.',
      );
    }

    const result = await projectLessonsService.searchLessons(project.id, ctx, {
      query: args.query,
      // Spread, so an axis the caller omitted stays ABSENT all the way down: the
      // upstream SQL omits an absent axis's clause and renders an empty one as a
      // filter that matches nothing.
      ...(args.kinds ? { kinds: args.kinds } : {}),
      ...(args.types ? { types: args.types } : {}),
      // Canonicalised at the boundary (MOTIR-4775): a caller still sending
      // `skeleton` / `deepen` searches as `lay` / `author`, so the upstream
      // only ever sees the current vocabulary.
      ...(args.phases ? { phases: canonicalizeLessonPhases(args.phases) } : {}),
      // The scalar fourth axis (MOTIR-5621). Same spread, same reason — and the
      // zod schema's `.trim().min(1)` is what keeps a whitespace-only value from
      // reaching here as a truthy string that narrows to nothing.
      ...(args.subject ? { subject: args.subject } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });

    return toolOk(
      summarizeLessonSearch(result),
      // EXEMPT: no `/api/v1` operation returns a lesson, so there is no shared
      // resource schema to derive from. The payload carries `outcome` so a
      // caller reading structurally — not just the prose — can still tell the
      // two empty answers apart.
      exempt(SEARCH_LESSONS_TOOL_NAME, {
        outcome: result.outcome,
        lessons: result.lessons,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerSearchLessons(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    SEARCH_LESSONS_TOOL_NAME,
    {
      title: 'Search lessons by meaning',
      description:
        'WHAT HAS GONE WRONG HERE BEFORE? Search the recorded LESSONS — mistakes actually made, ' +
        'each with what to do about it — by MEANING, before you plan or build. You get the ' +
        "shared corpus AND this project's own lessons in one answer. " +
        'TWO STEPS, and the second is the one that decides what you get: (1) NARROW by the card ' +
        'you are working on — its `kinds`, its `types`, the `phases` you are in (`lay` ' +
        "while laying a level's children, `author` while writing a body), and the `subject` " +
        'matter it is about; (2) ASK A REAL ' +
        'QUESTION in `query`. ⚠️ The axes only choose the candidate POOL; the query TEXT then ' +
        'chooses which few arrive. So a vague query returns a handful of near-arbitrary rows out ' +
        'of a correctly-filtered slice — which reads as the mechanism working while it hands you ' +
        'noise. Narrow by axis, THEN ask a real question. ' +
        'A LESSON IS A TAKEAWAY, not a feature: it is stored as "a count taken from a working ' +
        'tree is not a property of the ref", never as "board filter at scale". Write your query ' +
        'in that register — the action you are about to take and the shape of what could go ' +
        'wrong — or it will rank against the wrong words. ' +
        "Returns each lesson's TEXT (title, what happened, how to apply it), because a lesson is " +
        'guidance to read rather than a candidate to look up. ' +
        '⚠️ An empty result is not one thing — read `outcome`: `nothing-matched` means the ' +
        'corpus was searched and has nothing (an answer, and a normal one), while `unavailable` ' +
        'means it could NOT BE REACHED and is NOT evidence that nothing applies. ' +
        "⚠️ COSTS AN AI CALL: it embeds your query through Motir's AI backend and draws the " +
        'same per-minute allowance as the planning chat, so do not call it in a tight loop. ' +
        "Honors the same access checks as the UI; requires permission to read this project's " +
        'lessons.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runSearchLessons(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
