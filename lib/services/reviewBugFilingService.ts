import { motirSystemContext } from '@/lib/ai/serviceAuth';
import { cardUrl } from '@/lib/agentReview/botReviewBody';
import type { ReviewLoggedBugDto } from '@/lib/dto/agentReview';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import type { ReviewOpenBugForPrompt } from '@/lib/dispatch/reviewPromptTemplate';
import { REVIEW_OPEN_BUGS_LISTED_MAX } from '@/lib/dispatch/reviewPromptTemplate';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// A HOSTED REVIEW LOGS A BUG (MOTIR-10513; `hosted-agent-run.md` §8.7, `approval-gates.md`
// §12.17). A review that finds a defect its verdict cannot carry — in code the pull requests
// did not touch, or one that belongs to another card — hands it to Motir on the SAME verdict
// body (`bugs`), and Motir files it here. The review agent holds no Motir credential at all
// (`packages/cli/src/hostedAgent.ts`), and the run token stays bound to the one reviewed
// card: no route is added and no binding widened, because the only card a filing names is
// the reviewed one.
//
// The bound, axis by axis (the shape of `guideBugFilingService`):
//
//   KIND      — `bug`, hard-wired; the entry has no kind field.
//   PROJECT   — the reviewed card's project; the entry has no project field.
//   PLACEMENT — the project's bug destination, never under a card: a defect that would
//               BLOCK the reviewed card is a finding of its verdict, not a bug, so a logged
//               bug has no edge by construction (`log-bug.md` § Placement, the no-edge arm).
//   LINK      — `relates_to` the reviewed card, written with the row, which is also what
//               records the `bug_filed` finding on the review run's open leg.
//   AUTHOR    — Motir, the system account (MOTIR-9329): a machine found it, and the run's
//               attributed user (§8.1) did not.
//   VOLUME    — `REVIEW_BUGS_MAX` per verdict (the route's schema), and the verdict is ONE
//               per run, so one review run files at most that many.
//   DUPLICATE — a title equal (trimmed, case-insensitive) to a not-done bug of the project,
//               or to an earlier entry of the same verdict, is NOT filed: it is answered
//               `already_filed` with that bug's key. A review cannot search Motir, so this
//               is the project-wide check `motir log bug` makes, made for it. The prompt
//               also lists the not-done bugs already linked to the card (`listOpenBugs`).

/** One bug entry of a verdict, as the route's schema has already bounded it. */
export interface ReviewBugInput {
  title: string;
  descriptionMd: string;
}

/** The `Found while` line a review-filed bug opens with. */
export function reviewFoundWhileLine(reviewedKey: string, subjectVersion: string): string {
  return `**Found while:** reviewing ${reviewedKey} at ${subjectVersion} (Motir's review agent)`;
}

/** The placement line: why a review's bug has no edge. */
export const REVIEW_BUG_PLACEMENT_LINE =
  "**Placement:** the project's bug destination (no edge: a defect in the reviewed change is a finding of the verdict, not a bug)";

/** A logged bug's description: the found-while and placement lines, then the agent's body. */
export function reviewBugDescription(
  reviewedKey: string,
  subjectVersion: string,
  bodyMd: string,
): string {
  return `${reviewFoundWhileLine(reviewedKey, subjectVersion)}\n${REVIEW_BUG_PLACEMENT_LINE}\n\n${bodyMd.trim()}`;
}

function normalizedTitle(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * The "Bugs logged by this review" section appended to the findings the verdict records,
 * so the gate's note, the verdict record and the bot's post all name every bug — or the
 * text unchanged when there is none. A link to the card's page, not a `motir:` link: the
 * same text is posted on the pull request, where only a web address resolves.
 */
export function withLoggedBugs(
  text: string | null,
  bugs: readonly ReviewLoggedBugDto[],
): string | null {
  if (bugs.length === 0) return text;
  const lines = bugs.map(
    (b) =>
      `- [${b.key}](${cardUrl(b.key)}) — ${b.title}` +
      (b.outcome === 'already_filed' ? ' (already filed; not logged twice)' : ''),
  );
  const section = `### Bugs logged by this review\n\n${lines.join('\n')}`;
  return text?.trim() ? `${text.trimEnd()}\n\n${section}` : section;
}

export const reviewBugFilingService = {
  /**
   * The not-done bugs linked `relates_to` the reviewed card, at most
   * {@link REVIEW_OPEN_BUGS_LISTED_MAX}, newest link first — what the review prompt lists
   * so the reviewer does not log a defect already filed. Read in the run's workspace.
   */
  async listOpenBugs(
    item: { id: string; projectId: string },
    workspaceId: string,
  ): Promise<ReviewOpenBugForPrompt[]> {
    const terminal = await workflowsService.getTerminalStatusKeys(item.projectId, workspaceId);
    const related = await withWorkspaceServiceContext(workspaceId, (tx) =>
      workItemLinkRepository.findRelatedBugs(item.id, item.projectId, tx),
    );
    const seen = new Set<string>();
    const open: ReviewOpenBugForPrompt[] = [];
    for (const bug of [...related].reverse()) {
      if (seen.has(bug.id) || terminal.has(bug.status)) continue;
      seen.add(bug.id);
      open.push({ key: bug.identifier, title: bug.title, status: bug.status });
    }
    return open.slice(0, REVIEW_OPEN_BUGS_LISTED_MAX);
  },

  /**
   * File a verdict's bugs, in their order, as Motir — see the axis table above. Each entry
   * is answered `filed` (a new bug) or `already_filed` (the not-done bug of the same title,
   * project-wide, or the entry earlier in this list that filed it). No entries ⇒ `[]`, and
   * nothing is read.
   *
   * `workspaceId` is the RUN TOKEN's workspace — the trusted resolution
   * `motirSystemContext` requires — and `item` the reviewed card, already read through the
   * token's card binding.
   */
  async fileReviewBugs(
    item: { id: string; identifier: string; projectId: string },
    bugs: readonly ReviewBugInput[],
    subjectVersion: string,
    ctx: Pick<ServiceContext, 'workspaceId'>,
  ): Promise<ReviewLoggedBugDto[]> {
    if (bugs.length === 0) return [];
    const motir = await motirSystemContext(ctx.workspaceId);
    const terminal = await workflowsService.getTerminalStatusKeys(item.projectId, ctx.workspaceId);
    const { existing, folderId } = await withWorkspaceServiceContext(
      ctx.workspaceId,
      async (tx) => ({
        existing: await workItemRepository.findOpenBugsByTitles(
          item.projectId,
          bugs.map((b) => b.title.trim()),
          [...terminal],
          tx,
        ),
        folderId: (await bugDestinationService.resolve(item.projectId, tx)).folderId,
      }),
    );

    const byTitle = new Map<string, { id: string; identifier: string; title: string }>();
    for (const row of existing) {
      const k = normalizedTitle(row.title);
      if (!byTitle.has(k)) byTitle.set(k, row);
    }

    const logged: ReviewLoggedBugDto[] = [];
    for (const bug of bugs) {
      const title = bug.title.trim();
      const known = byTitle.get(normalizedTitle(title));
      if (known) {
        logged.push({
          key: known.identifier,
          id: known.id,
          title: known.title,
          outcome: 'already_filed',
        });
        continue;
      }
      // ONE create, by Motir, through the same door as filing a bug by hand — its
      // key allocation, its guards and the link in one transaction of its own.
      const created = await workItemsService.createWorkItem(
        {
          projectId: item.projectId,
          kind: 'bug',
          title,
          parentId: null,
          folderId,
          descriptionMd: reviewBugDescription(item.identifier, subjectVersion, bug.descriptionMd),
          links: [{ targetId: item.id, relationship: 'relates_to' as const }],
        },
        motir,
      );
      const row = { id: created.id, identifier: created.identifier, title: created.title };
      byTitle.set(normalizedTitle(title), row);
      logged.push({ key: row.identifier, id: row.id, title: row.title, outcome: 'filed' });
    }
    return logged;
  },
};
