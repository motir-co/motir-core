import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RUN_DISCREPANCY_FIELD_MAX, RUN_DISCREPANCY_POINTS_MAX } from '@/lib/dispatchRuns/errors';
import {
  runDiscrepancyService,
  type RecordDiscrepancyResult,
} from '@/lib/services/runDiscrepancyService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { workItemKeyField } from './workItemRef';

// `record_run_discrepancy` (Story MOTIR-8651 · Subtask MOTIR-8657) — the door a runner calls
// ONCE, after it BUILT THROUGH a card whose plan was wrong only about the HOW and before it
// opens its pull request, to record each discrepancy: what the plan asked · what was built ·
// why. The accepted record is the decision page MOTIR-8654, *A run builds through a wrong HOW —
// the discrepancy record*.
//
// This is a TRANSPORT over ONE service call, `runDiscrepancyService.recordDiscrepancy`, which
// owns the bounds, the card comment, the leg, the one-record-per-leg rule and the finding.
// Nothing here decides, reads or writes anything of its own. The bounds (1–20 points, each
// field 1–2000 characters) are the SERVICE's, not the schema's: a schema-level refusal would
// reach the runner as a generic input-validation error, where the service's
// `RUN_DISCREPANCY_INVALID` names the point and the field.
//
// ⚠️ THE ANSWER IS AN ACKNOWLEDGEMENT — `{ commentId, recorded }` — and nothing else.
// `recorded` says whether the card had an open leg on a running dispatch run, so a finding was
// written; `false` is not an error (the comment is still on the card).
//
// ⚠️ `work_item:edit`, which `CLI_TOKEN_GRANT` ALREADY holds — the grant is not widened, so a
// sandboxed `motir run` agent and a `motir-run` skill session (a workspace PAT) both reach it.
// And it is NOT a `report_action` event: the ingest refuses a client-reported finding on
// purpose (`run-findings-protocol.md` Q5), so the server writes this one from a real act.
//
// ⚠️ IT ALSO CARRIES THE RUN'S DECISIONS (MOTIR-10000). A run never asks the user about the
// implementation; what the plan left open it decides — the repository's conventions first,
// then industry best practice — and records here as `decisions`, in the SAME one call as any
// build-through points (one record per leg). `points` became optional for that; a call with
// neither is the service's `RUN_DISCREPANCY_INVALID`, like an empty list always was.

export const RECORD_RUN_DISCREPANCY_TOOL_NAME = 'record_run_discrepancy';

const pointSchema = z.object({
  planAsked: z.string().describe('What the plan asked for — the route it laid out.'),
  built: z.string().describe('What you built instead — the route you actually took.'),
  why: z
    .string()
    .describe(
      'Why the plan could not be built as written. If the point describes something that is ' +
        'STILL BROKEN after the card is done, file it as a bug and cite its key here.',
    ),
});

const decisionSchema = z.object({
  planSaid: z
    .string()
    .describe('What the card or its plan said about this detail — "nothing" when it was silent.'),
  chose: z.string().describe('What you decided and built.'),
  why: z
    .string()
    .describe(
      "Why — the repository's convention you followed or, where it is silent, the established " +
        'industry best practice for the stack. Never "it was the simplest".',
    ),
  alternatives: z
    .string()
    .optional()
    .describe('The options you considered and did not take, and why not.'),
});

const inputSchema = {
  key: workItemKeyField.describe(
    'The card you built through (e.g. "ACME-7") — on a parent run, the CHILD you were working.',
  ),
  points: z
    .array(pointSchema)
    .optional()
    .describe(
      `Every discrepancy you found, in ONE call — 1–${RUN_DISCREPANCY_POINTS_MAX} points, each ` +
        `field 1–${RUN_DISCREPANCY_FIELD_MAX} characters once trimmed. Omit it when the record ` +
        'carries only decisions.',
    ),
  decisions: z
    .array(decisionSchema)
    .optional()
    .describe(
      'Every decision you made where the card left the HOW open, in the SAME one call — up to ' +
        `${RUN_DISCREPANCY_POINTS_MAX}, each field 1–${RUN_DISCREPANCY_FIELD_MAX} characters ` +
        'once trimmed.',
    ),
};

type RecordRunDiscrepancyArgs = {
  key: string;
  points?: z.infer<typeof pointSchema>[];
  decisions?: z.infer<typeof decisionSchema>[];
};

function acknowledgementText(
  key: string,
  result: RecordDiscrepancyResult,
  withDecisions: boolean,
): string {
  const state = withDecisions
    ? 'what you built differently and the decisions you made'
    : 'what you built differently';
  return result.recorded
    ? `Discrepancy recorded on ${key} and on its run. Open your pull request next, and say in its ` +
        `description ${state}.`
    : `Discrepancy written as a comment on ${key}, which has no open dispatch leg, so nothing was ` +
        `recorded on a run. Open your pull request next, and say in its description ${state}.`;
}

/** The adapter: one service call, the acknowledgement back as-is. */
export async function runRecordRunDiscrepancy(
  args: RecordRunDiscrepancyArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const result = await runDiscrepancyService.recordDiscrepancy(
    { key: args.key, points: args.points ?? [], decisions: args.decisions ?? [] },
    ctx,
  );
  return toolOk(
    acknowledgementText(args.key.trim().toUpperCase(), result, (args.decisions ?? []).length > 0),
    exempt(RECORD_RUN_DISCREPANCY_TOOL_NAME, {
      commentId: result.commentId,
      recorded: result.recorded,
    }),
  );
}

export function registerRecordRunDiscrepancy(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    RECORD_RUN_DISCREPANCY_TOOL_NAME,
    {
      title: 'Record what you built differently from the plan',
      description:
        'Record the discrepancies of a card you BUILT THROUGH — one whose plan was wrong only ' +
        'about the HOW (a false precondition you worked around, existing code you adapted, a ' +
        'planned route you could not follow) while its outcome and acceptance criteria stayed ' +
        'reachable. Call it ONCE, after you build and before you open the pull request, with ' +
        '`key` and EVERY point as `{ planAsked, built, why }`. It writes ONE comment on the ' +
        'card listing the points and, when the card has an open dispatch leg, one record on ' +
        'its run. It returns only `{ commentId, recorded }`, where `recorded` says whether a ' +
        'run was recorded on — `false` is not an error, the comment is still written. A second ' +
        'call on the same leg is refused with `DISCREPANCY_ALREADY_RECORDED` and writes ' +
        'nothing. The SAME call also records the DECISIONS you made where the card left the HOW ' +
        "open — never ask the user; decide by the repository's conventions, then industry best " +
        'practice — as `decisions`, each `{ planSaid, chose, why, alternatives? }`, beside the ' +
        'points or alone (omit `points` then); the comment lists them in their own section. A ' +
        'record with neither, more than ' +
        `${RUN_DISCREPANCY_POINTS_MAX} of either, or a field over ${RUN_DISCREPANCY_FIELD_MAX} ` +
        'characters is refused with `RUN_DISCREPANCY_INVALID`. If the WHAT itself cannot be ' +
        'built, do not use this: stop and use `report_unbuildable_target`. Requires ' +
        '`work_item:edit`.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runRecordRunDiscrepancy(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
