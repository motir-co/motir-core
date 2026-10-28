// THE DECISION PORT'S READ (Story MOTIR-4907 · Subtask MOTIR-5678;
// `design/github/design-notes.md` §27) — what the Development frame draws as a decision
// card's PRIMARY question: the document, or the reason it cannot be shown.
//
// ⚠️ READ ON THE SERVER, HANDED OVER DISPLAY-READY. The content comes through the
// decision document resolver (`decisionDocumentService`), which calls the Git host with
// the organisation's credential; the browser receives the Markdown and a public link to
// the file, never a host API address or a token.

import type { WorkItemRefMap } from '@/lib/dto/workItems';

/** Why the port cannot show a document — the capture's reasons and the read's
 *  (`DecisionDocumentReadReason`), restated here so a client component imports no
 *  service module. */
export type DecisionDocumentViewReason =
  | 'none'
  | 'several'
  | 'unreadable'
  | 'gone_at_head'
  | 'too_large'
  | 'host_unreachable'
  | 'not_connected';

export type DecisionDocumentViewDTO =
  | {
      outcome: 'resolved';
      /** `owner/name` of the pull request carrying the document. */
      repo: string;
      number: number;
      path: string;
      /** The document's git blob — what the gate asks about (clause 4). */
      blobSha: string;
      /** The head the capture was read at; null when the host named none. */
      headSha: string | null;
      markdown: string;
      /**
       * The live summaries of the work items `markdown` links (bug MOTIR-10020), resolved
       * for the reader — without them every `[KEY](motir:<id>)` chip draws as deleted.
       * `{}` when the document links none.
       */
      workItemRefs: WorkItemRefMap;
      /** The file on the host, at the head it was read at — a page link, not an API. */
      hostUrl: string;
    }
  /**
   * A published PAGE version (Story MOTIR-5761 · MOTIR-7433): its text, number and
   * title, and the page's address. The port draws it per the delta mocks (MOTIR-7436).
   */
  | {
      outcome: 'page';
      pageId: string;
      versionId: string;
      versionNumber: number;
      title: string;
      markdown: string;
      /**
       * The live summaries of the work items `markdown` links (bug MOTIR-10020), resolved
       * for the reader — without them every `[KEY](motir:<id>)` chip draws as deleted.
       * `{}` when the document links none.
       */
      workItemRefs: WorkItemRefMap;
      /** The page in Motir — `/pages/<id>`. */
      pageUrl: string;
      /** The published VERSION's view — `/pages/<id>?version=<n>` (Open page). */
      versionUrl: string;
      /** The History compare view for that version (Compare with current). */
      compareUrl: string;
      authorName: string | null;
      /** ISO-8601 — when the version was last saved. */
      savedAt: string | null;
      /** Frozen by an approval (the Frozen chip). */
      frozen: boolean;
      /** The page has versions after the published one (the changed-since notice). */
      changedSince: boolean;
    }
  | {
      outcome: 'unresolvable';
      reason: DecisionDocumentViewReason;
      repo: string;
      number: number;
      headSha: string | null;
      /** The one document's path when the capture found one and only the READ failed
       *  (`gone_at_head`, `too_large`, `host_unreachable`, `not_connected`); else null. */
      path: string | null;
      /** For `several`: every document, so the port can name them. Empty otherwise. */
      paths: string[];
      /** The document's host link when a path is known (a `too_large` read), else null. */
      hostUrl: string | null;
    };
