import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  plannerFindingsService,
  type RecordPlannerFindingInput,
} from '@/lib/services/plannerFindingsService';
import type { RecordedPlannerFindingDTO } from '@/lib/dto/plannerFindings';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `record_planner_finding` (Story MOTIR-10354 · Subtask MOTIR-10387) — record
// ONE planner defect, found while checking a plan, as ONE finding in motir-ai's
// findings store, beside the hosted planner's own findings.
//
// A thin adapter over `plannerFindingsService.recordFinding`, in the shape of
// `addLesson.ts` / `reinforceLesson.ts` with one difference: it does NOT resolve
// the project itself. The service takes `projectKey` as the caller typed it and
// owns the resolution, the `ai:plan` gate, the `planId` marker and the baseline
// split, so every caller inherits them.
//
// ⚠️ NO `source` ARGUMENT, and the schema is strict, so naming one is refused by
// name. The service always writes `check_plan`; an `in_loop` row is the hosted
// planner's own review stage and never comes through here.
//
// ⚠️ ONE CALL, NO RETRY. The create route has no idempotency key, so a second
// attempt after a failure could store a second row for one defect.

export const RECORD_PLANNER_FINDING_TOOL_NAME = 'record_planner_finding';

// The closed vocabularies, mirrored from motir-ai's Prisma enums (Story
// MOTIR-10348). Typed against the service input so a drift is a compile error.
export const FINDING_PLANNERS = ['hosted', 'plan_py'] as const satisfies readonly NonNullable<
  RecordPlannerFindingInput['planner']
>[];
export const FINDING_PREDICTIONS = [
  'STOPS',
  'SETTLES',
  'THRU',
] as const satisfies readonly NonNullable<RecordPlannerFindingInput['prediction']>[];
export const FINDING_OUTCOMES = [
  'fixed',
  'reported',
  'fix_failed',
] as const satisfies readonly NonNullable<RecordPlannerFindingInput['outcome']>[];
export const FINDING_ATTRIBUTIONS = [
  'code',
  'corpus',
  'model',
  'unattributed',
] as const satisfies readonly NonNullable<RecordPlannerFindingInput['attribution']>[];

const requiredText = (describe: string) => z.string().min(1).describe(describe);
const optionalText = (describe: string) => z.string().optional().describe(describe);

const inputSchema = {
  projectKey: projectKeyField,
  planId: optionalText(
    'The plan the finding is about, as TEXT — a plan id, a session id, or nothing. It is never ' +
      'looked up: an id that is no plan in Motir (a plan.py run, a plan already decided or gone) is ' +
      'accepted and stored as given, because a finding outlives its plan.',
  ),
  planTitle: optionalText("The plan's title, as text, for a reader of the finding."),
  cardRef: optionalText(
    'The card the defect sits on, as text — a plan item id (`planItem:…`) or a work-item key ' +
      '(`MOTIR-123`).',
  ),
  planner: z
    .enum(FINDING_PLANNERS)
    .describe(
      'Which planner wrote the plan: "hosted" (Motir\'s own planner) or "plan_py" (the local planner).',
    ),
  site: requiredText(
    'WHERE the defect is — the card and the part of it (a criterion, an edge, a field). Repeats of ' +
      'one defect are grouped by site and attribution, so name it the same way each time.',
  ),
  prediction: z
    .enum(FINDING_PREDICTIONS)
    .describe(
      'What the runner would do at that site: "STOPS" (it cannot build the card), "SETTLES" (it ' +
        'builds with a recorded deviation) or "THRU" (it builds straight through).',
    ),
  whatHappened: requiredText('What is wrong, in a sentence or two.'),
  evidence: requiredText(
    'What shows it — a `path:line` at a commit, a quoted criterion, a command and its output.',
  ),
  correction: optionalText('The correction that was made or proposed, when there is one.'),
  outcome: z
    .enum(FINDING_OUTCOMES)
    .describe(
      'What was done about it: "fixed" (repaired in the plan), "reported" (only reported) or ' +
        '"fix_failed" (a repair was attempted and failed).',
    ),
  attribution: z
    .enum(FINDING_ATTRIBUTIONS)
    .optional()
    .describe(
      'Whose fault it was: "code" (the planner\'s code), "corpus" (its rule packs), "model" (the ' +
        'planning model) or "unattributed" (nobody could tell). Omitted reads as unattributed.',
    ),
  why: optionalText('Why you attribute it that way.'),
  hostedCell: optionalText('Where in the hosted planner the defect comes from, when you know.'),
  planpyCell: optionalText('Where in plan.py the defect comes from, when you know.'),
  fixDirection: optionalText('Which way a fix to the planner should go, when you know.'),
  authorModel: optionalText('The model that wrote the plan, when you know it.'),
  authorSessionKey: optionalText('The planning session that wrote the plan, when you know it.'),
  baseline: z
    .object({
      branch: optionalText('The branch the code was read at.'),
      commit: optionalText('The commit the code was read at.'),
    })
    .strict()
    .optional()
    .describe('The branch and commit the code was read at when the defect was judged.'),
};

const DESCRIPTION =
  'Record ONE planner defect — something wrong with a plan that you found while checking it — as ' +
  "ONE finding in Motir's findings store, beside the findings the hosted planner records about its " +
  'own plans. One call records one defect: make one call per defect, never one call for several.\n\n' +
  'WHERE IT GOES. A row that only platform admins can read; they triage it into a lesson, a bug or ' +
  'nothing. No tool reads findings back, so the result naming the stored id is your record that ' +
  'it was written.\n\n' +
  'WHAT IT NEVER DOES. It never files a bug and never adds or changes a lesson — it only records ' +
  'the finding. There is no source argument: the row is always written as a check_plan finding.\n\n' +
  '⚠️ NOT IDEMPOTENT. A repeat call writes a second row. Call it once per defect, and do not retry ' +
  'blindly after an error: a refusal names the field or the upstream reason, so fix that first.\n\n' +
  'PERMISSION. It needs the planning permission on the project, not lesson management: reporting a ' +
  'defect does not need the right to change the lessons that steer the planner.';

/** Compact human-readable summary of the stored finding; the id leads. */
function summarize(projectKey: string, finding: RecordedPlannerFindingDTO): string {
  return [
    `Recorded planner finding ${finding.id} for ${projectKey.trim().toUpperCase()}.`,
    `Source ${finding.source} · status ${finding.status} · fingerprint ${finding.fingerprint}.`,
    'Only platform admins can read it. One call is one finding: do not call again for this defect.',
  ].join('\n');
}

type RecordPlannerFindingArgs = { projectKey: string } & RecordPlannerFindingInput;

/** The adapter: hand the finding to the service, which resolves and gates. */
export async function runRecordPlannerFinding(
  args: RecordPlannerFindingArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const { projectKey, ...input } = args;
  try {
    const finding = await plannerFindingsService.recordFinding(projectKey, ctx, input);
    return toolOk(
      summarize(projectKey, finding),
      // EXEMPT: the findings store lives in motir-ai and no `/api/v1` operation
      // returns a finding, so there is no shared resource schema to derive from.
      exempt(RECORD_PLANNER_FINDING_TOOL_NAME, {
        id: finding.id,
        source: finding.source,
        fingerprint: finding.fingerprint,
        status: finding.status,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerRecordPlannerFinding(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    RECORD_PLANNER_FINDING_TOOL_NAME,
    {
      title: 'Record a planner finding',
      description: DESCRIPTION,
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runRecordPlannerFinding(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
