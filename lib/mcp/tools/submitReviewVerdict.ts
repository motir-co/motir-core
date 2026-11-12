import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  ReviewNothingToReviewError,
  ReviewTargetNotRunTargetError,
  ReviewVerdictInvalidError,
  ReviewVerdictLateError,
  ReviewVerdictSecondError,
} from '@/lib/agentReview/errors';
import { presentReviewVerdictResult } from '@/lib/api/v1/workLoop/reviewVerdict';
import {
  REVIEW_FINDINGS_MAX_LENGTH,
  REVIEW_SUMMARY_MAX_LENGTH,
} from '@/lib/dispatch/reviewPromptTemplate';
import {
  REVIEW_CHECKLIST_MAX_ROWS,
  REVIEW_CHECKLIST_STATUSES,
  REVIEW_DOOR_VERDICTS,
  REVIEW_SUBMITTER_FIELD_MAX_LENGTH,
  type ReviewVerdictResultDto,
} from '@/lib/dto/agentReview';
import { reviewVerdictService } from '@/lib/services/reviewVerdictService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { derived } from '../payloads/define';
import { reviewVerdictPayload } from '../payloads/workLoop';
import { toToolError, toolError, toolOk } from '../toolResult';
import { resolveWorkItemByKey, workItemKeyField } from './workItemRef';

// `submit_review_verdict` (Story MOTIR-10327 · MOTIR-10333; `approval-gates.md` §12.11) —
// a person's OWN review agent submits its ONE verdict for a run-target card, with the
// person's own token. The REST twin is `POST /api/v1/work-items/{key}/review-verdict`;
// both answer through `reviewVerdictService.submit` and one presenter, so the payload is
// v1's `ReviewVerdictResult` whole.
//
// A run token never reaches this tool (`verifyMcpToken` refuses it): a hosted review run
// submits through its own REST route. The verdict is recorded under the authority
// `review_agent` and NEVER decides the approve-and-merge gate.

export const SUBMIT_REVIEW_VERDICT_TOOL_NAME = 'submit_review_verdict';

const inputSchema = {
  key: workItemKeyField,
  verdict: z
    .enum(REVIEW_DOOR_VERDICTS)
    .describe('`approved`, or `changes_requested` (then `findingsMd` is required).'),
  subjectVersion: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The delivery-set version reviewed — every pull request as `owner/name#number@headSha`, ' +
        'sorted, comma-joined. A version the card no longer has is recorded as late.',
    ),
  summaryMd: z
    .string()
    .max(REVIEW_SUMMARY_MAX_LENGTH)
    .optional()
    .describe('What the review concluded, in a line or two.'),
  findingsMd: z
    .string()
    .max(REVIEW_FINDINGS_MAX_LENGTH)
    .optional()
    .describe(
      'The findings, Markdown: each naming a file and line, what it breaks and what to change. ' +
        'Required and non-empty on `changes_requested`.',
    ),
  checklist: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(64).optional().describe('The card the criterion is on.'),
        criterion: z
          .string()
          .trim()
          .min(1)
          .describe('The acceptance criterion, as the card says it.'),
        status: z.enum(REVIEW_CHECKLIST_STATUSES),
        evidence: z
          .string()
          .optional()
          .describe('What shows the result — required when `status` is `met`.'),
      }),
    )
    .max(REVIEW_CHECKLIST_MAX_ROWS)
    .optional()
    .describe('One row per acceptance criterion of the run target and its descendants.'),
  harness: z
    .string()
    .trim()
    .min(1)
    .max(REVIEW_SUBMITTER_FIELD_MAX_LENGTH)
    .describe('The harness the review ran in, e.g. "Claude Code".'),
  model: z
    .string()
    .trim()
    .min(1)
    .max(REVIEW_SUBMITTER_FIELD_MAX_LENGTH)
    .describe('The model the review ran on.'),
};

type Args = {
  key: string;
  verdict: (typeof REVIEW_DOOR_VERDICTS)[number];
  subjectVersion: string;
  summaryMd?: string;
  findingsMd?: string;
  checklist?: {
    key?: string;
    criterion: string;
    status: (typeof REVIEW_CHECKLIST_STATUSES)[number];
    evidence?: string;
  }[];
  harness: string;
  model: string;
};

/** Appended to `REVIEW_VERDICT_SECOND` at this door: the one way past a standing send-back. */
export const SECOND_VERDICT_HINT =
  'To overrule a standing send-back at this version, its routed person (the assignee, or the ' +
  'reporter when unassigned) calls `dismiss_review` with a reason; a person still approves the merge.';

/** The prose an agent reads, carrying the same facts as the payload. */
function summarize(dto: ReviewVerdictResultDto): string {
  const what =
    dto.outcome === 'decided'
      ? `decided the review gate ${dto.gateId}`
      : 'was recorded (the project’s review gate is off)';
  const lines = [`${dto.key}: your ${dto.verdict} verdict ${what}, at ${dto.subjectVersion}.`];
  if (dto.verdict === 'changes_requested') {
    lines.push(
      'The card is To fix with your findings; no status moved.' +
        (dto.withdrewApprovalGateIds.length > 0
          ? ' Its approve-and-merge question was withdrawn until a push or a Dismiss.'
          : ''),
    );
  } else {
    lines.push('A person still approves the merge — this verdict never does.');
  }
  return lines.join('\n');
}

export async function runSubmitReviewVerdict(
  args: Args,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const item = await resolveWorkItemByKey(args.key, ctx);
    const dto = await reviewVerdictService.submit(
      item.projectId,
      item.identifier,
      {
        verdict: args.verdict,
        subjectVersion: args.subjectVersion,
        summaryMd: args.summaryMd ?? null,
        findingsMd: args.findingsMd ?? null,
        checklist: (args.checklist ?? []).map((row) => ({
          key: row.key ?? null,
          criterion: row.criterion,
          status: row.status,
          evidence: row.evidence ?? null,
        })),
        harness: args.harness,
        model: args.model,
      },
      ctx,
    );
    return toolOk(summarize(dto), derived(reviewVerdictPayload, presentReviewVerdictResult(dto)));
  } catch (err) {
    // The door's own refusals — each a code and a message the agent acts on in one hop:
    // review the current version, stop (already reviewed), review the named run target,
    // or fix the named field.
    // A second verdict names the way past a send-back the person disagrees with (MOTIR-11092):
    // the routed person dismisses it, which a re-review at the same version cannot do.
    if (err instanceof ReviewVerdictSecondError) {
      return toolError(err.code, `${err.message} ${SECOND_VERDICT_HINT}`);
    }
    if (
      err instanceof ReviewVerdictLateError ||
      err instanceof ReviewTargetNotRunTargetError ||
      err instanceof ReviewNothingToReviewError ||
      err instanceof ReviewVerdictInvalidError
    ) {
      return toolError(err.code, err.message);
    }
    return toToolError(err);
  }
}

export function registerSubmitReviewVerdict(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    SUBMIT_REVIEW_VERDICT_TOOL_NAME,
    {
      title: 'Submit review verdict',
      description:
        'Submit YOUR review agent’s ONE verdict on a RUN-TARGET card — what `motir review` ' +
        'calls after reviewing a card’s pull requests against its acceptance criteria. Needs ' +
        '`work_item:edit` on the card (any teammate, not only the assignee). `verdict` is ' +
        '`approved` or `changes_requested` (`findingsMd` required); `subjectVersion` is the ' +
        'delivery-set version you reviewed; `checklist` judges each criterion (`evidence` ' +
        'required on `met`); `harness` and `model` say what reviewed. With the project’s review ' +
        'gate ON it decides the awaiting agent review (`outcome: decided`); OFF it is stored ' +
        'as the review record (`outcome: recorded`). ⚠️ IT NEVER APPROVES THE MERGE: a person ' +
        'still does. A `changes_requested` puts the card in To fix and withdraws its ' +
        'approve-and-merge question; no status moves. REFUSALS: `REVIEW_VERDICT_LATE` (the ' +
        'card has a newer version — review that) and `REVIEW_VERDICT_SECOND` (already ' +
        'reviewed — stop; to overrule a standing send-back at that version, its routed person ' +
        'calls `dismiss_review`) are each RECORDED and decide nothing; ' +
        '`REVIEW_TARGET_NOT_RUN_TARGET` ' +
        'names the card to review instead; `REVIEW_NOTHING_TO_REVIEW` — it delivers no pull ' +
        'request.',
      inputSchema,
    },
    async (args, extra) => runSubmitReviewVerdict(args as Args, resolveContext(extra)),
  );
}
