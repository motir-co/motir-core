import type { DecisionDocumentViewDTO } from '@/lib/dto/decisionDocument';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import type { DecisionDocumentRead } from '@/lib/services/decisionDocumentService';

// The decision port's read → its DTO (Story MOTIR-4907 · Subtask MOTIR-5678). Called by
// `decisionDocumentService.readViewForWorkItem` just before returning.

/** The file on the host at a ref — the same public page `githubMappers` links a pull
 *  request to, never an API address. */
export function decisionDocumentHostUrl(repo: string, ref: string, path: string): string {
  return `https://github.com/${repo}/blob/${ref}/${path}`;
}

/** `null` exactly when the card has nothing to ask about yet — no captured open pull
 *  request — which the port draws as no decision slot at all. `workItemRefs` is the
 *  reader's resolution of the document's `motir:` links (bug MOTIR-10020), carried on
 *  the two arms that draw Markdown. */
export function toDecisionDocumentViewDTO(
  read: DecisionDocumentRead,
  workItemRefs: WorkItemRefMap,
): DecisionDocumentViewDTO | null {
  const { identity, content } = read;
  if (!identity || !content) return null;
  if (identity.source === 'page') {
    if (content.outcome === 'page') {
      return {
        outcome: 'page',
        pageId: content.pageId,
        versionId: content.versionId,
        versionNumber: content.versionNumber,
        title: content.title,
        markdown: content.markdown,
        workItemRefs,
        pageUrl: `/pages/${content.pageId}`,
        versionUrl: `/pages/${content.pageId}?version=${content.versionNumber}`,
        compareUrl: `/pages/${content.pageId}?history=open&version=${content.versionNumber}`,
        authorName: content.authorName,
        savedAt: content.savedAt,
        frozen: content.frozen,
        changedSince:
          content.latestVersionNumber !== null &&
          content.latestVersionNumber > content.versionNumber,
      };
    }
    // A page version that cannot be read: there is no pull request to name, and the
    // page itself is the only link worth offering.
    return {
      outcome: 'unresolvable',
      reason: content.outcome === 'unresolvable' ? content.reason : 'unreadable',
      repo: '',
      number: 0,
      headSha: null,
      path: null,
      paths: [],
      hostUrl: `/pages/${identity.pageId}`,
    };
  }
  if (identity.resolvable && content.outcome === 'resolved') {
    return {
      outcome: 'resolved',
      repo: identity.repo,
      number: identity.number,
      path: identity.path,
      blobSha: identity.blobSha,
      headSha: identity.headSha,
      markdown: content.markdown,
      workItemRefs,
      hostUrl: decisionDocumentHostUrl(
        identity.repo,
        identity.headSha ?? identity.blobSha,
        identity.path,
      ),
    };
  }
  const reason = content.outcome === 'unresolvable' ? content.reason : 'unreadable';
  return {
    outcome: 'unresolvable',
    reason,
    repo: identity.repo,
    number: identity.number,
    headSha: identity.headSha,
    path: identity.resolvable ? identity.path : null,
    paths: identity.resolvable ? [] : identity.paths,
    // A document that EXISTS but cannot be shown here (`too_large`) is still one the
    // reviewer can open on the host — the copy says so.
    hostUrl: identity.resolvable
      ? decisionDocumentHostUrl(identity.repo, identity.headSha ?? identity.blobSha, identity.path)
      : null,
  };
}
