import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { resolveCoordinate as resolveCoordinateImpl } from '@/lib/github/pullRequestCoordinate';
import { resolveWorkItemByKey, workItemKeyField } from './workItemRef';

// `link_pull_request` (Story MOTIR-3525 · Subtask MOTIR-3526) — the door an
// executing agent has never had: DECLARE which work item a pull request belongs
// to, at the moment the answer is certain.
//
// ── What this replaces, and what it does NOT ───────────────────────────────
// Until this tool the only way an agent could say which card its pull request
// delivered was to put `MOTIR-<n>` in the branch or the title and hope
// `resolveChangeRequestWorkItem` parsed it back out. That guess is wrong in both
// directions and both have been measured on live cards: a title that drops the
// key is invisible to the completion gate, so a card is held open by work that
// shipped; a title that merely MENTIONS a key closes that card whether or not it
// delivered it.
//
// ⚠️ AMENDED (MOTIR-3674, story MOTIR-3672): **THE PARSE IS RETIRED.** This
// paragraph used to end *"the parse is NOT retired and this tool does not touch
// it — it stays as the FALLBACK for a pull request opened outside a run"*, and
// that conservatism is what MOTIR-3672 revisited. The parse is not a weaker
// version of this tool; it answers a DIFFERENT question — *this text mentions
// this card*, not *this pull request delivers this card* — so keeping it as a
// fallback kept the wrong answer available on exactly the path nobody watches.
// An explicit link is now the ONLY association a pull request has, at both call
// sites (the live delivery and the historical backfill), and a pull request
// nobody links carries a FAILING CHECK rather than a silent guess
// (`docs/decisions/unlinked-pull-request-check.md`).
//
// ── The model was already right; only the door was missing ────────────────
// A stored link was already the link, and `syncChangeRequestStatus` already
// PREFERRED a sticky link over the parse
// (`lib/services/changeRequestStatusSync.ts`). Since MOTIR-3674 there is nothing
// to prefer it over: the sync reads the stored link and stops, and a row the
// parse linked historically is honoured exactly as an explicit one is. (Where
// that link is STORED has since moved: `work_item_delivery` is the whole of it,
// and MOTIR-3757 dropped the `github_pull_request` column that used to hold it.
// A `linked_manually` flag recorded HOW a link was made and was part of neither
// question by the end; MOTIR-4894 retired it.) Motir
// simply never gave the one actor who knows the answer a way to write it down: a
// human can, from the detail page's "+ Link pull request" picker; the agent that
// just ran `gh pr create` could not.
//
// ── Why not just expose the picker's service ──────────────────────────────
// The picker resolves an INGESTED pull request by Motir's internal cuid. An
// agent has neither — it is the FIRST party to know the pull request exists,
// ahead of GitHub's own webhook, and it addresses it the way the world does: a
// repository and a number. So this tool takes `(owner/name, number)` and writes
// the row when there is none yet. `githubPullRequestService
// .linkPullRequestByCoordinates` carries the whole argument for why the two arms
// are asymmetric; nothing is re-implemented here.
//
// ── ⚠️ THE PERMISSION, AND WHY IT IS A CRITERION AND NOT A LINE TO REMEMBER ─
// This tool asserts `work_item:edit` — linking a pull request to a card is
// editing that card — and `CLI_TOKEN_GRANT` ALREADY CARRIES IT, so it is NOT
// widened by this card. That is worth stating rather than assuming, because the
// opposite failure ships GREEN: the tool registers, every suite passes against a
// workspace PAT, and the one caller the feature exists for gets a refusal it
// reads as an outage. That has happened twice on this constant — MOTIR-3058 and
// MOTIR-3051.

export const LINK_PULL_REQUEST_TOOL_NAME = 'link_pull_request';

/**
 * ⚠️ `resolveCoordinate` MOVED to `lib/github/pullRequestCoordinate.ts`
 * (MOTIR-5048) and is RE-EXPORTED here so this module's own importers —
 * `unlinkPullRequest.ts` — are unchanged.
 *
 * It moved because there are two doors onto the coordinate now: this tool and
 * `POST /api/v1/work-items/{key}/pull-requests`. A v1 route may not import from
 * `@/lib/mcp/` (the planning story gate enforces it), and the alternative —
 * re-deriving the parse in the v1 layer — is the one shape that must not be
 * copied: a key parse that drifts yields a 404 the caller sees, while a
 * coordinate parse that drifts links the WRONG pull request under a success
 * response. So the parser went DOWN to a leaf both transports may import,
 * rather than sideways into a second copy.
 */
export { resolveCoordinate, type Coordinate } from '@/lib/github/pullRequestCoordinate';

const inputSchema = {
  key: workItemKeyField,
  repository: z
    .string()
    .trim()
    .optional()
    .describe(
      'The repository as "owner/name", exactly as it is connected in Motir (case-insensitive). ' +
        'Give this WITH `number`, or give `url` instead — not neither.',
    ),
  number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The pull-request number, e.g. 2291. Give this with `repository`.'),
  url: z
    .string()
    .trim()
    .optional()
    .describe(
      'The full pull-request URL, e.g. "https://github.com/acme/web/pull/2291" — the line ' +
        '`gh pr create` prints, so it can be passed through verbatim. An alternative to ' +
        '`repository` + `number`, never a supplement: if both are given they must agree.',
    ),
  headRef: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The branch the pull request is FROM, e.g. "subtask/ACME-7-widget". Used only when no ' +
        'webhook delivery has arrived yet and this call is what creates the row; once a ' +
        'delivery has landed, the delivery is authoritative and this is ignored.',
    ),
  baseRef: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The branch the pull request TARGETS, e.g. "main". Same rule as `headRef`: it seeds the ' +
        'row when there is none, and a later delivery overwrites it.',
    ),
  title: z
    .string()
    .trim()
    .optional()
    .describe(
      'The pull request’s title, for the row this call may have to create. Optional — the ' +
        'first webhook delivery supplies the real one either way.',
    ),
};

/** The adapter: resolve the item + the coordinate, then declare the link. */
export async function runLinkPullRequest(
  args: {
    key: string;
    repository?: string;
    number?: number;
    url?: string;
    headRef: string;
    baseRef: string;
    title?: string;
  },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const coordinate = resolveCoordinateImpl(args);
    // A TOOL error, not a throw: the agent can fix this in one hop, and an
    // opaque internal error would tell it nothing about which argument is wrong.
    if (!coordinate.ok) return toolError('INVALID_PULL_REQUEST_REF', coordinate.message);

    const item = await resolveWorkItemByKey(args.key, ctx);
    const result = await githubPullRequestService.linkPullRequestByCoordinates(
      {
        workItemId: item.id,
        projectId: item.projectId,
        owner: coordinate.owner,
        name: coordinate.name,
        number: coordinate.number,
        headRef: args.headRef,
        baseRef: args.baseRef,
        title: args.title ?? null,
      },
      ctx,
    );

    const where = `${result.link.repo}#${result.link.number}`;
    const note = result.created
      ? ' (no delivery had arrived yet — the row was created by this call)'
      : '';
    return toolOk(
      `Linked ${where} to ${item.identifier}${note}.`,
      exempt(LINK_PULL_REQUEST_TOOL_NAME, {
        key: item.identifier,
        created: result.created,
        pullRequest: { ...result.link },
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerLinkPullRequest(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    LINK_PULL_REQUEST_TOOL_NAME,
    {
      title: 'Link pull request',
      description:
        'Declare which work item a pull request delivers — call it IMMEDIATELY after opening ' +
        'the pull request, once per work item it delivers. You know the answer with certainty ' +
        'at that moment; nothing else does. The link is what the completion gate and the status ' +
        'sync read, so a merge moves the card whether or not any title ever named it. ' +
        '⚠️ IT IS A SET, NOT A SLOT. Calling this again naming a DIFFERENT work item ADDS a ' +
        'second link; it does not move the first, and nothing is silently unlinked. One pull ' +
        'request may deliver several work items and one work item may be delivered by several ' +
        'pull requests — the item page’s Development panel lists them. A link made by mistake ' +
        'is retracted with `unlink_pull_request`, which is the only thing that removes one. ' +
        'ONE pull request delivering a parent and its children links the PARENT — once per ' +
        'repository — and NEVER a child: the merge cascades DOWN to the children on its own, and ' +
        'the approval gates read the same set, so a child linked without its parent is asked to ' +
        'approve and merge the whole story’s pull request. A child linked beside the parent ' +
        'raises nothing and owes no repair; a child linked without it is repaired by linking ' +
        'the parent. ' +
        'Address the pull request as `repository` ("owner/name") + `number`, or as the `url` ' +
        '`gh pr create` printed. It works BEFORE GitHub’s webhook has delivered anything — ' +
        'that is the case it exists for — writing the row from the `headRef` / `baseRef` / ' +
        '`title` you supply; a later delivery refreshes those and leaves the links alone. ' +
        'Putting the key in the branch is still worth doing for a human reading a branch list, ' +
        'but it is a label now, not the mechanism. The repository is resolved across your ' +
        'ORGANISATION, so any of its workspaces can link a pull request on a repository it ' +
        'connected. Honors the same access checks as the UI: an unknown repository, another ' +
        'organisation’s repository, and an unknown item key are all refused.',
      inputSchema,
    },
    async (args, extra) => runLinkPullRequest(args, resolveContext(extra)),
  );
}
