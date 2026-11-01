import { loadDecisionIdentity } from '@/lib/approvalGates/decisionApprovalHandler';
import {
  pageDecisionResolver,
  repoFileDecisionResolver,
  type DecisionDocumentContent,
  type DecisionDocumentResolver,
} from '@/lib/approvalGates/decisionDocumentResolver';
import type { DecisionIdentity } from '@/lib/approvalGates/decisionSubject';
import type { DecisionDocumentViewDTO } from '@/lib/dto/decisionDocument';
import { toDecisionDocumentViewDTO } from '@/lib/mappers/decisionDocumentMappers';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { pageVersionRepository } from '@/lib/repositories/pageVersionRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { resolveMarkdownWorkItemRefs } from '@/lib/workItems/resolveWorkItemRefs';
import { repoFileReadService } from './repoFileReadService';

// READ A DECISION DOCUMENT — the one door a surface uses to SHOW what a decision gate
// is asking about (Story MOTIR-4907 · Subtask MOTIR-5676; ADR
// `docs/decisions/approval-gates.md` §8's FIFTH AMENDMENT, clauses 7 and 8).
//
// TWO READS, and the order is the design: the IDENTITY is read on a transaction from
// the capture on the card's pull requests; the CONTENT is then read through the
// active resolver AFTER that transaction has closed, because the production resolver
// calls a Git host and a transaction may not wait on one.
//
// ⚠️ THE RESOLVER IS SWAPPABLE, AND THAT IS THE WHOLE POINT OF IT. Motir stores no
// decision document; a pages domain that later hosts them registers its own resolver
// here, and the gate, its version and its refusals are untouched — they never read
// content. `setDecisionDocumentResolver` is that swap, and the second-resolver test
// is what proves it is the ONLY thing that changes.
//
// ⚠️ IT AUTHORISES NOTHING. It reads under the caller's workspace context, which is
// the tenancy boundary; whether this person may see this CARD is the calling
// surface's question, asked before it gets here (the approval read, the overlay
// route), exactly as for every other gate subject.

let activeResolver: DecisionDocumentResolver = repoFileDecisionResolver((ctx, repoRef, path, ref) =>
  repoFileReadService.readFile(ctx, repoRef, path, ref),
);

// THE PAGE RESOLVER (Story MOTIR-5761 · MOTIR-7433) — a published page version's
// markdown, read under the reader's workspace context. The read is a Motir row, so it
// could run in a transaction; it runs here, beside the file read, so a surface has ONE
// door whichever kind of document the card is asked about.
let activePageResolver: DecisionDocumentResolver = pageDecisionResolver(async (ctx, versionId) =>
  withWorkspaceContext(ctx, async (tx) => {
    const version = await pageVersionRepository.findVersionById(versionId, tx);
    if (!version) return null;
    // What the port's meta line and notices draw (MOTIR-7436): the author, the save time,
    // the freeze, and the page's newest version — above this one means it changed since.
    // Both rows exist whenever the version does: the page's newest version is at least
    // this one, and the author's FK is `Restrict`, so neither read can come back empty.
    const latest = (await pageVersionRepository.findLatest(version.pageId, tx))!;
    const [author] = await userRepository.findByIds([version.authorId], tx);
    return {
      markdown: version.bodyMarkdown,
      authorName: author!.name,
      savedAt: version.savedAt.toISOString(),
      frozen: version.frozenAt !== null,
      latestVersionNumber: latest.number,
    };
  }),
);

/** Register the PAGE resolver, returning the one it replaced — the file seam's twin. */
export function setPageDecisionDocumentResolver(
  resolver: DecisionDocumentResolver,
): DecisionDocumentResolver {
  const previous = activePageResolver;
  activePageResolver = resolver;
  return previous;
}

/**
 * Register the resolver every FILE read goes through, returning the one it replaced so
 * a caller can put it back. The production default reads the repository.
 */
export function setDecisionDocumentResolver(
  resolver: DecisionDocumentResolver,
): DecisionDocumentResolver {
  const previous = activeResolver;
  activeResolver = resolver;
  return previous;
}

/** What a surface gets back: which document the card is asked about, and its text. */
export interface DecisionDocumentRead {
  /** Null when no open pull request delivers the card, or none has been captured. */
  identity: DecisionIdentity | null;
  /** Null exactly when `identity` is. */
  content: DecisionDocumentContent | null;
}

export const decisionDocumentService = {
  async readForWorkItem(workItemId: string, ctx: ServiceContext): Promise<DecisionDocumentRead> {
    const identity = await withWorkspaceContext(ctx, (tx) => loadDecisionIdentity(workItemId, tx));
    if (!identity) return { identity: null, content: null };
    // The resolver is picked by the identity's SOURCE — a page, or a file.
    const resolver = identity.source === 'page' ? activePageResolver : activeResolver;
    return { identity, content: await resolver.resolve(identity, ctx) };
  },

  /**
   * The same read, as the decision PORT draws it (MOTIR-5678) — display-ready, with the
   * file's public host link. `null` when there is nothing to ask about yet.
   *
   * ⚠️ AND WITH THE DOCUMENT'S WORK-ITEM CHIPS RESOLVED (bug MOTIR-10020). The port hands
   * the Markdown to `MarkdownView`, which draws every `[KEY](motir:<id>)` it has no
   * summary for as deleted — so the summaries are read here, for this reader, in one
   * batched read after the content read (never inside its transaction: the file
   * resolver calls the Git host). A document that links nothing pays no ref read.
   */
  async readViewForWorkItem(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<DecisionDocumentViewDTO | null> {
    const read = await this.readForWorkItem(workItemId, ctx);
    const markdown =
      read.content?.outcome === 'page' || read.content?.outcome === 'resolved'
        ? read.content.markdown
        : '';
    const workItemRefs = markdown ? await resolveMarkdownWorkItemRefs(markdown, ctx) : {};
    return toDecisionDocumentViewDTO(read, workItemRefs);
  },
};
