import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { projectsService } from '@/lib/services/projectsService';
import { projectLessonsService } from '@/lib/services/projectLessonsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ProjectLessonDTO } from '@/lib/dto/projectLessons';
import {
  LESSON_PHASES,
  LESSON_PHASE_REFUSAL,
  canonicalizeLessonPhases,
  preprocessLessonPhases,
} from '@/lib/lessons/phaseAxis';
import { LESSON_KINDS } from '@/lib/lessons/kindAxis';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `add_lesson` (Story MOTIR-3331 · Subtask MOTIR-3361) — record a lesson for a
// project, so future plans for it are given the lesson. A thin adapter over
// `projectLessonsService.addLesson` (MOTIR-3360), following `addComment.ts`
// exactly: resolve the context, call the service, `toolOk` / `toToolError`. NO
// business logic here — the permission check, the project resolution and the
// tenant scoping all belong to the service, so the next caller inherits them.
//
// ⚠️ THE DESCRIPTIONS ARE THE DELIVERABLE, not the plumbing. A tool description
// is the ENTIRE briefing the calling agent gets: no onboarding, no docs it will
// read, no second chance. "Add a lesson to the project's lesson library" would
// fill the store with restatements of what just happened, one-off incidents and
// things already in the plan — and a store nobody can tell signal from noise in
// is the thing this epic exists to prevent. So the text below is written for a
// model that has never seen this product, and it is reviewed as WRITING.
//
// ⚠️ THE SCHEMA IS DELIBERATELY LEFT STRICT. Since MOTIR-3342 (#2241),
// `lib/mcp/strictInput.ts` rewrites every tool's `inputSchema` to `strict` at
// the registration seam, so an unknown key is REFUSED BY NAME instead of
// silently dropped. `.passthrough()` and `.catchall()` are exempt from that
// rewrite — declaring either here would opt this tool back out of the guard,
// quietly, and `scope` is exactly the key that would then find its way through.
// There is no such argument, and that is the contract, not an oversight: a
// lesson that applies to every project is Motir's own curated corpus and is
// added by migration.
//
// ⚠️ NOT `log_planning_mistake`. That is motir-ai's INTERNAL tool, called by the
// planner during a run, and it is untouched by this. This is the agent-facing
// door on motir-core's MCP surface.

export const ADD_LESSON_TOOL_NAME = 'add_lesson';

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
const MISTAKE_TYPES = ['onboarding_planning', 'regular_planning', 'planning_craft'] as const;

const inputSchema = {
  projectKey: projectKeyField,
  title: z
    .string()
    .min(1)
    .describe(
      'The takeaway, in one line — the thing a planner should do differently, not a headline for ' +
        'an incident. "Pin the target repository on every card that ships code" is a lesson; ' +
        '"Repository problems in the billing epic" is a label for one.',
    ),
  body: z
    .string()
    .min(1)
    .describe(
      'What goes wrong, stated so it is recognisable the NEXT time rather than recounted from ' +
        'the last. Describe the situation and the failure, not the specific work items it ' +
        'happened to involve.',
    ),
  why: z
    .string()
    .min(1)
    .describe(
      'Why it matters — the cost of getting it wrong. This is the one field that may carry the ' +
        'specifics of your own case (what it cost, when, on which work), because it is what ' +
        'justifies the rule rather than what a future plan is matched against.',
    ),
  howToApply: z
    .string()
    .min(1)
    .describe(
      'The actionable rule, addressed to a future planner in the second person: "Before sealing ' +
        'a card that ships code, set its target repository." Not a restatement of the body — if ' +
        'this field reads like the body, the lesson has no rule in it.',
    ),
  mistakeType: z
    .enum(MISTAKE_TYPES)
    .default('regular_planning')
    .describe(
      'Which kind of planning this lesson is for: "regular_planning" (planning an existing ' +
        'project — the usual answer), "onboarding_planning" (drafting a project\'s first tree), ' +
        'or "planning_craft" (how to plan well, whatever is being planned).',
    ),
  kinds: z
    .array(z.enum(LESSON_KINDS))
    .optional()
    .describe(
      'WHICH LEVEL this lesson is about — a work-item KIND, or "project" / "onboarding" for a ' +
        'mistake made laying a project\'s top level ("onboarding" when that plan is carved from ' +
        'the direction docs) — and one of the three axes that decide when a future plan is shown ' +
        'it. A mistake made LAYING a level is filed under the level laid under, not the kind of ' +
        'its children. LEAVING IT OUT MEANS "every kind" — occasionally right, and ' +
        'usually the reason a lesson turns up in plans it has nothing to do with. Say what you ' +
        'mean on each axis rather than skipping it.',
    ),
  types: z
    .array(z.enum(LESSON_TYPES))
    .optional()
    .describe(
      'WHICH WORK TYPES this lesson is about (code, design, test, …). Leaving it out means ' +
        '"every type". Under-claiming is as wrong as over-claiming: a lesson typed only "code" ' +
        'stops reaching the chore work it also applies to.',
    ),
  phases: z
    .preprocess(
      preprocessLessonPhases,
      z.array(z.enum([...LESSON_PHASES], { message: LESSON_PHASE_REFUSAL })),
    )
    .optional()
    .describe(
      'WHICH PLANNING PHASE this lesson is about: "lay" (laying a level\'s children — shape, ' +
        'edges, coverage) or "author" (writing one card\'s body — criteria, sizing, claims). ' +
        'Leaving it out means both. The retired spellings "skeleton" and "deepen" are still ' +
        'accepted and read as "lay" and "author"; they are removed in a later release.',
    ),
  subject: z
    .string()
    .optional()
    .describe(
      'WHICH SUBJECT MATTER this lesson is about — the FOURTH routing axis, mirroring the ' +
        "rule-pack selector's fourth coordinate so the two corpora stay reachable by one " +
        'question. Leaving it out means "every subject", and that is the right answer far more ' +
        'often than the vocabulary suggests: a WRONG subject is worse than none, because it makes ' +
        'the lesson unreachable from every card it actually applies to, while an untagged one ' +
        'still reaches all of them. ⚠️ SCALAR, unlike the three axes above — a lesson carries ONE ' +
        'subject or none, never a list, and a payload sending several is REFUSED rather than ' +
        'coerced (a card wanting two subjects is a SPLIT signal, so a lesson captured from one ' +
        'cannot inherit a multiplicity its source never had). A lesson that genuinely applies ' +
        'across subjects carries NONE — it is more general than either, which is what omitting ' +
        'this says. MEMBERSHIP IS NOT VALIDATED: the vocabulary is the rule-pack file set, so a ' +
        'well-formed unrecognised member is accepted and simply never matches a subject-narrowed ' +
        'query. Shape only: a lowercase slug.',
    ),
  sourceRef: z
    .string()
    .optional()
    .describe(
      'Where this lesson came from — a work-item key, a runbook name, a ticket. Also the ' +
        'idempotency key: adding the same lesson again with the same sourceRef returns the ' +
        'existing one instead of a duplicate.',
    ),
};

/** Compact human-readable summary of a newly-recorded lesson. */
function summarize(projectKey: string, lesson: ProjectLessonDTO): string {
  const axes = [
    lesson.kinds.length > 0 ? `kinds ${lesson.kinds.join('/')}` : null,
    lesson.types.length > 0 ? `types ${lesson.types.join('/')}` : null,
    lesson.phases.length > 0 ? `phases ${lesson.phases.join('/')}` : null,
    // SCALAR, so the test is presence rather than length — and an absent one is
    // omitted entirely, which is what makes the fallback below read correctly.
    lesson.subject ? `subject ${lesson.subject}` : null,
  ].filter(Boolean);
  const routing = axes.length > 0 ? axes.join(' · ') : 'applies to every card';
  return [
    `Recorded a lesson for ${projectKey} (${routing}) · id ${lesson.id}.`,
    lesson.title,
    'Future plans for this project will be given it.',
  ].join('\n');
}

/** The adapter: resolve the project by key, then record the lesson. */
export async function runAddLesson(
  args: {
    projectKey: string;
    title: string;
    body: string;
    why: string;
    howToApply: string;
    mistakeType: (typeof MISTAKE_TYPES)[number];
    kinds?: (typeof LESSON_KINDS)[number][];
    types?: (typeof LESSON_TYPES)[number][];
    phases?: string[];
    // SCALAR — one value or none. The schema above types it `z.string()`, so a
    // caller sending an array is refused by zod before this runs.
    subject?: string;
    sourceRef?: string;
  },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);
    const lesson = await projectLessonsService.addLesson(project.id, ctx, {
      mistakeType: args.mistakeType,
      title: args.title,
      body: args.body,
      why: args.why,
      howToApply: args.howToApply,
      ...(args.kinds ? { kinds: args.kinds } : {}),
      ...(args.types ? { types: args.types } : {}),
      // Canonicalised at the boundary, so a caller still sending `skeleton` /
      // `deepen` is STORED as `lay` / `author` rather than round-tripping a
      // retired word into the column (MOTIR-4775).
      ...(args.phases ? { phases: canonicalizeLessonPhases(args.phases) } : {}),
      // TRIMMED, and an empty/whitespace-only value is the UNCONSTRAINED case
      // rather than a member named "" that could never match anything.
      ...(args.subject && args.subject.trim().length > 0 ? { subject: args.subject.trim() } : {}),
      ...(args.sourceRef ? { sourceRef: args.sourceRef } : {}),
    });
    return toolOk(
      summarize(project.identifier, lesson),
      // EXEMPT: no `/api/v1` operation returns a lesson, so there is no shared
      // resource schema to derive from (see `payloads/exemptions.ts`). The
      // payload carries what a calling agent can act on — the id to reference
      // it by, and the axes AS STORED, so an agent can see that an axis it left
      // out came back empty and means "everything".
      exempt(ADD_LESSON_TOOL_NAME, {
        id: lesson.id,
        title: lesson.title,
        kinds: lesson.kinds,
        types: lesson.types,
        phases: lesson.phases,
        subject: lesson.subject,
        sourceRef: lesson.sourceRef,
      }),
    );
  } catch (err) {
    // Everything propagates as the service raised it — including the upstream's
    // near-duplicate refusal, which NAMES the existing lesson's id and title.
    // Flattening that into "could not create" would turn the one actionable
    // answer this tool can give into a dead end.
    return toToolError(err);
  }
}

export function registerAddLesson(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    ADD_LESSON_TOOL_NAME,
    {
      title: 'Add lesson',
      description:
        'Record a LESSON for this project: something that went wrong when planning it and will go ' +
        'wrong again, so that later plans for this project are given the lesson before they are ' +
        'drafted. Write it as a standing instruction to a future planner, not as a report about ' +
        'what just happened. ' +
        'It belongs to THIS project only — it is never shared with any other project, and it is ' +
        'not a way to change how Motir plans in general. ' +
        'The four routing axes (kinds, types, phases, subject) decide which future plans are shown it; ' +
        'leaving an axis out means "applies to everything on that axis", which is occasionally ' +
        'right and usually means the lesson surfaces where it does not belong. ' +
        'DO NOT add one for: a one-off that will not recur; something an existing lesson already ' +
        "covers (read the project's lessons first); or a defect in the product, which is a bug " +
        'report rather than a lesson. A near-duplicate is refused, naming the lesson that already ' +
        "covers it. Requires permission to change this project's lesson library.",
      inputSchema,
    },
    async (args, extra) => runAddLesson(args, resolveContext(extra)),
  );
}
