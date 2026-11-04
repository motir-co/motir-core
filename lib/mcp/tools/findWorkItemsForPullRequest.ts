import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { resolveCoordinate } from '@/lib/github/pullRequestCoordinate';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import type { PullRequestDeliveriesDto, PullRequestNotLinkedReason } from '@/lib/dto/github';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';

// `find_work_items_for_pull_request` (MOTIR-10331, Story MOTIR-10327 R5b) — the
// reverse of `link_pull_request`: given a pull request, the cards it delivers.
//
// The `motir review` skill starts from a pull-request URL as often as from a key,
// and what it needs from the URL is the CARDS — their acceptance criteria are the
// checklist. Without this it would parse keys out of the pull request's title,
// branch and commits and confirm each against the card's deliveries, which is the
// fallback the skill keeps for a server without the tool.
//
// ── What it reads, and what it does not ──────────────────────────────────────
// The `work_item_delivery` rows, and nothing else. A key in the title is a label;
// an INHERITED delivery is reached by walking the tree from the card returned.
//
// ── Three answers that are not errors ────────────────────────────────────────
// `not_linked` carries ONE reason — `repository_not_connected`,
// `pull_request_unknown` or `no_deliveries` — so a caller can tell "this pull
// request delivers nothing" from "Motir does not know this pull request", and
// none of them says anything about another workspace (`githubPullRequestService`).
//
// ── The permission ───────────────────────────────────────────────────────────
// `work_item:edit`: the only use of the answer is to submit a review verdict for
// those cards, which needs the same key. The service asserts it on the project of
// every card it returns; the MCP gate asserts the token carries it.
//
// GitHub only: a URL on another host is refused, deliberately narrower than the
// host-agnostic coordinate parser (GitLab is MOTIR-5593's).

export const FIND_WORK_ITEMS_FOR_PULL_REQUEST_TOOL_NAME = 'find_work_items_for_pull_request';

const GITHUB_HOST = 'github.com';

const EXPECTED_FORM = '"https://github.com/<owner>/<repo>/pull/<number>"';

const inputSchema = {
  url: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The pull request as its GitHub URL, e.g. "https://github.com/acme/web/pull/2291" — the ' +
        'line `gh pr create` prints, or the address in a browser.',
    ),
};

/** Parse the URL into a GitHub coordinate, or say what the caller must send instead. */
export function parseGithubPullRequestUrl(
  url: string,
): { ok: true; owner: string; name: string; number: number } | { ok: false; message: string } {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { ok: false, message: `\`url\` is not a URL. Expected ${EXPECTED_FORM}.` };
  }
  if (host !== GITHUB_HOST && host !== `www.${GITHUB_HOST}`) {
    return {
      ok: false,
      message:
        `\`url\` is on ${host}, and only GitHub pull requests are looked up. Expected ` +
        `${EXPECTED_FORM}.`,
    };
  }
  const coordinate = resolveCoordinate({ url });
  if (!coordinate.ok) {
    return {
      ok: false,
      message: `\`url\` is not a pull-request URL. Expected ${EXPECTED_FORM}.`,
    };
  }
  return coordinate;
}

const NOT_LINKED_TEXT: Record<PullRequestNotLinkedReason, string> = {
  repository_not_connected:
    'Its repository is not connected to Motir in this organisation, so Motir knows no card it ' +
    'delivers.',
  pull_request_unknown:
    'Its repository is connected, but Motir has no record of this pull request: it was never ' +
    'linked to a card, and no webhook has delivered it.',
  no_deliveries:
    'Motir knows the pull request, and it delivers no card in this workspace. Nothing links it: ' +
    'a key in its title, branch or body is not a link.',
};

/** The prose an agent reads, carrying the same facts as the structured payload. */
function summarize(answer: PullRequestDeliveriesDto): string {
  if (answer.outcome === 'not_linked') {
    return [
      `${answer.pullRequest} — NOT LINKED (${answer.reason}).`,
      NOT_LINKED_TEXT[answer.reason],
      'Stop here: there are no cards to review against. Linking is `link_pull_request`, and it ' +
        'is not this tool’s to do.',
    ].join('\n');
  }
  const count = answer.workItems.length;
  return [
    `${answer.pullRequest} delivers ${count} card${count === 1 ? '' : 's'}:`,
    ...answer.workItems.map(
      (item) => `  ${item.key}  [${item.kind} · ${item.status}]  ${item.title}`,
    ),
    'A card these deliver through a PARENT is not listed on its own: walk each card’s tree ' +
      '(`get_work_item`) for its children.',
  ].join('\n');
}

export async function runFindWorkItemsForPullRequest(
  args: { url: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const coordinate = parseGithubPullRequestUrl(args.url);
    if (!coordinate.ok) return toolError('INVALID_PULL_REQUEST_REF', coordinate.message);

    const answer = await githubPullRequestService.findWorkItemsForPullRequest(
      { owner: coordinate.owner, name: coordinate.name, number: coordinate.number },
      ctx,
    );
    return toolOk(summarize(answer), exempt(FIND_WORK_ITEMS_FOR_PULL_REQUEST_TOOL_NAME, answer));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerFindWorkItemsForPullRequest(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    FIND_WORK_ITEMS_FOR_PULL_REQUEST_TOOL_NAME,
    {
      title: 'Find work items for pull request',
      description:
        'The cards a GitHub pull request DELIVERS — the reverse of `link_pull_request`. Give the ' +
        'pull request as its URL. A pull request may deliver several cards, so the answer is a ' +
        'list: each card’s `key`, `title`, `kind`, `status` and `projectKey`. ⚠️ ONLY A LINK ' +
        'COUNTS: a card is delivered when a `link_pull_request` (or the item page) recorded it; ' +
        'a key in the title, branch or body is a label and is not read. A card delivered ' +
        'THROUGH a parent is not listed on its own — walk the returned card’s tree for it. ' +
        '⚠️ `not_linked` IS AN ANSWER, NOT AN ERROR, with one `reason`: ' +
        '`repository_not_connected` (no repository by that name is connected to Motir here), ' +
        '`pull_request_unknown` (the repository is connected, but Motir has no record of the ' +
        'pull request) or `no_deliveries` (the pull request is known and delivers no card in ' +
        'this workspace). Stop on it: there is nothing to review against. A URL that is not a ' +
        'GitHub pull request is refused. Needs `work_item:edit` on every card it returns, ' +
        'because the answer exists to submit a review verdict for them. Read-only: it creates, ' +
        'links and changes nothing.',
      inputSchema,
    },
    async (args, extra) => runFindWorkItemsForPullRequest(args, resolveContext(extra)),
  );
}
