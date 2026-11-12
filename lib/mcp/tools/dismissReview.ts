import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  ReviewDismissalForbiddenError,
  ReviewDismissalReasonRequiredError,
  ReviewDismissalStaleError,
  ReviewSendBackAlreadyDismissedError,
  ReviewSendBackNotStandingError,
} from '@/lib/agentReview/errors';
import { presentReviewDismissalResult } from '@/lib/api/v1/workLoop/reviewDismissal';
import {
  REVIEW_DISMISSAL_REASON_MAX_LENGTH,
  type ReviewDismissalResultDto,
} from '@/lib/dto/agentReview';
import {
  currentDeliverySetVersion,
  reviewDismissalService,
} from '@/lib/services/reviewDismissalService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { derived } from '../payloads/define';
import { reviewDismissalPayload } from '../payloads/workLoop';
import { toToolError, toolError, toolOk } from '../toolResult';
import { resolveWorkItemByKey, workItemKeyField } from './workItemRef';

// `dismiss_review` (MOTIR-11092; `approval-gates.md` §12.15) — the routed person's OWN agent
// dismisses the review agent's standing send-back on a card, with the person's own token and
// a reason. The counterpart of `submit_review_verdict`: a second verdict at the same version
// is refused `REVIEW_VERDICT_SECOND`, so overruling a send-back the person disagrees with
// needed the card's Dismiss button until this tool.
//
// The REST twin is `POST /api/v1/work-items/{key}/review-dismissal`; both answer through
// `reviewDismissalService.dismiss` and one presenter, so the payload is v1's
// `ReviewDismissalResult` whole, and the service's rules — the routed person only, a
// required reason, the current version only — are the tool's, unchanged. A run token never
// reaches this tool (`verifyMcpToken` refuses it), so no review or coding run can dismiss
// the review of its own work.

export const DISMISS_REVIEW_TOOL_NAME = 'dismiss_review';

const inputSchema = {
  key: workItemKeyField,
  reason: z
    .string()
    .describe(
      `Why the review is dismissed — required, 1–${REVIEW_DISMISSAL_REASON_MAX_LENGTH} ` +
        'characters once trimmed. Stored on the dismissal and shown on the card’s History.',
    ),
  subjectVersion: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'The delivery-set version whose send-back you are dismissing — every pull request as ' +
        '`owner/name#number@headSha`, sorted, comma-joined. Omit it to dismiss at the card’s ' +
        'CURRENT version. Name the version you read when you want a push since then to refuse ' +
        'with `REVIEW_DISMISSAL_STALE` rather than dismiss a send-back you have not seen.',
    ),
};

type Args = { key: string; reason: string; subjectVersion?: string };

/** The prose an agent reads, carrying the same facts as the payload. */
function summarize(dto: ReviewDismissalResultDto): string {
  const asked =
    dto.approvalGateId === null
      ? 'no approve-and-merge gate was raised'
      : `approve-and-merge is asked again (${dto.approvalGateId})`;
  return [
    `${dto.key}: the agent’s send-back at ${dto.subjectVersion} is dismissed; ${asked}.`,
    'A person still approves the merge — a dismissal never does.',
  ].join('\n');
}

/** The stale refusal, naming the card's current version so the agent retries in one hop. */
function staleMessage(err: ReviewDismissalStaleError): string {
  return err.currentVersion === null
    ? `${err.message} The card delivers no pull request now, so there is nothing to dismiss.`
    : `${err.message} The card’s current version is ${err.currentVersion} — dismiss at that ` +
        'version once you have read its send-back, or omit `subjectVersion`.';
}

export async function runDismissReview(args: Args, ctx: ServiceContext): Promise<CallToolResult> {
  try {
    const item = await resolveWorkItemByKey(args.key, ctx);
    // No version named ⇒ the card's current one, read the way the service computes it. A
    // card delivering nothing has none, and the service answers that as stale.
    const subjectVersion =
      args.subjectVersion ?? (await currentDeliverySetVersion(item.id, ctx)) ?? '';
    const dto = await reviewDismissalService.dismiss(
      item.projectId,
      item.identifier,
      { subjectVersion, reasonMd: args.reason },
      ctx,
    );
    return toolOk(
      summarize(dto),
      derived(reviewDismissalPayload, presentReviewDismissalResult(dto)),
    );
  } catch (err) {
    if (err instanceof ReviewDismissalStaleError) return toolError(err.code, staleMessage(err));
    // The door's own refusals — each a code and a message the agent acts on in one hop.
    if (
      err instanceof ReviewDismissalForbiddenError ||
      err instanceof ReviewDismissalReasonRequiredError ||
      err instanceof ReviewSendBackNotStandingError ||
      err instanceof ReviewSendBackAlreadyDismissedError
    ) {
      return toolError(err.code, err.message);
    }
    return toToolError(err);
  }
}

export function registerDismissReview(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    DISMISS_REVIEW_TOOL_NAME,
    {
      title: 'Dismiss the review',
      description:
        'Dismiss the review agent’s STANDING send-back on a card — the `changes_requested` that ' +
        'put it in To fix — so approve-and-merge is asked again at the same version. It is the ' +
        'ROUTED PERSON’s own act: only the card’s assignee (its reporter when it has no ' +
        'assignee), or someone who may decide any approval, may make it, through their own ' +
        'agent. `reason` is REQUIRED (at most 2000 characters) and is stored on the dismissal ' +
        'and on the card’s History. `subjectVersion` is optional: omitted, the card’s current ' +
        'version is dismissed. ⚠️ IT NEVER APPROVES OR MERGES: it only clears the send-back, and ' +
        'a person still approves the merge. The send-back stays on record; no status moves. ' +
        'This is the way past a send-back you disagree with — `submit_review_verdict` refuses ' +
        'a second verdict at the same version. REFUSALS, each writing nothing: ' +
        '`REVIEW_DISMISSAL_FORBIDDEN` (you are not the routed person), `REASON_REQUIRED`, ' +
        '`REVIEW_DISMISSAL_STALE` (a push moved the version — the message names the current ' +
        'one), `NO_STANDING_REVIEW_SENDBACK` (no send-back stands at the current version), ' +
        '`REVIEW_SENDBACK_ALREADY_DISMISSED`.',
      inputSchema,
    },
    async (args, extra) => runDismissReview(args as Args, resolveContext(extra)),
  );
}
