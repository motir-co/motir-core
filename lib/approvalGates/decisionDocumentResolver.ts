import type {
  DecisionIdentity,
  PageDecisionIdentity,
  RepoFileDecisionIdentity,
  DecisionUnresolvableReason,
} from '@/lib/approvalGates/decisionSubject';
import type { RepoFileServiceResult } from '@/lib/services/repoFileReadService';

// THE DECISION DOCUMENT RESOLVER — the seam a pages domain later replaces (Story
// MOTIR-4907 · Subtask MOTIR-5676; ADR `docs/decisions/approval-gates.md` §8's
// FIFTH AMENDMENT, clause 8, and §1's MOTIR-4911 amendment: *the subject is a
// document with a resolver*).
//
// ⚠️ MOTIR STORES NO DECISION DOCUMENT, and this interface is why that costs
// nothing later. Today the one implementation reads the file at the pull
// request's head through the core-owned repository read. When decision documents
// move into pages (Epic MOTIR-5746), that is a NEW RESOLVER and a new renderer —
// never a migration on the gate table, which is the one table an audit trusts.
//
// ⚠️ IT IS CALLED OUTSIDE EVERY TRANSACTION, by a surface about to SHOW the
// document. The gate itself never needs content: its version and its refusals
// read the captured identity (`decisionSubject.ts`), so a host that is down makes
// a document unreadable on screen without ever holding a gate's lock.

/** Why a document could not be shown — the capture's reasons plus the read's. */
export type DecisionDocumentReadReason =
  | DecisionUnresolvableReason
  /** The file is not at the captured head any more (a force-push, a deleted ref). */
  | 'gone_at_head'
  /** The file is larger than the read will return. */
  | 'too_large'
  /** The host did not answer, refused the credential, or cannot be used. */
  | 'host_unreachable'
  /** The repository is not connected to this organisation. */
  | 'not_connected';

export type DecisionDocumentContent =
  | { outcome: 'resolved'; repo: string; path: string; blobSha: string; markdown: string }
  /** A published page version's text (MOTIR-7433) — the second resolver's answer. */
  | {
      outcome: 'page';
      pageId: string;
      versionId: string;
      versionNumber: number;
      title: string;
      markdown: string;
      /** The version's author and when it was last saved (ISO-8601) — the port's meta line
       *  (MOTIR-7436). Null when the read does not say. */
      authorName: string | null;
      savedAt: string | null;
      /** Frozen by an approval — the port's Frozen chip. */
      frozen: boolean;
      /** The page's NEWEST version number now; above `versionNumber` means the page
       *  changed after it was published (the port's changed-since notice). */
      latestVersionNumber: number | null;
    }
  | { outcome: 'unresolvable'; reason: DecisionDocumentReadReason };

/** Who is reading — the tenancy the core-owned read enforces. */
export interface DecisionDocumentReadContext {
  userId: string;
  workspaceId: string;
}

/** The seam. One method, and everything it can answer is named. */
export interface DecisionDocumentResolver {
  resolve(
    identity: DecisionIdentity,
    ctx: DecisionDocumentReadContext,
  ): Promise<DecisionDocumentContent>;
}

/** The read the production resolver makes — injected so the mapping is testable
 *  without a host, and so this module stays free of the service layer's imports. */
export type RepoFileRead = (
  ctx: DecisionDocumentReadContext,
  repoRef: string,
  path: string,
  ref: string,
) => Promise<RepoFileServiceResult>;

/**
 * Map the core-owned read's NAMED outcomes onto a document's. TOTAL over
 * `RepoFileServiceResult` — the `never` below fails the build when that union
 * grows a member nobody has mapped.
 */
export function contentFromRead(
  identity: Extract<RepoFileDecisionIdentity, { resolvable: true }>,
  result: RepoFileServiceResult,
): DecisionDocumentContent {
  switch (result.outcome) {
    case 'found':
      return {
        outcome: 'resolved',
        repo: identity.repo,
        path: identity.path,
        blobSha: identity.blobSha,
        markdown: result.text,
      };
    case 'not_found':
    case 'ref_not_found':
      return { outcome: 'unresolvable', reason: 'gone_at_head' };
    case 'too_large':
      return { outcome: 'unresolvable', reason: 'too_large' };
    case 'unauthorized':
    case 'unreachable':
    case 'provider_unavailable':
      return { outcome: 'unresolvable', reason: 'host_unreachable' };
    case 'repo_not_connected':
      return { outcome: 'unresolvable', reason: 'not_connected' };
    case 'invalid_path':
    // A decision document is Markdown; a binary blob at its path is not one,
    // and there is nothing to show (MOTIR-7873).
    case 'binary':
    // A directory at the path is not a document either (MOTIR-9868).
    case 'directory':
      return { outcome: 'unresolvable', reason: 'unreadable' };
    default: {
      const unmapped: never = result;
      throw new Error(`unmapped repository read outcome: ${JSON.stringify(unmapped)}`);
    }
  }
}

/**
 * The PRODUCTION resolver — the file at the pull request's captured HEAD.
 *
 * ⚠️ THE HEAD, NOT THE DEFAULT BRANCH. The document is in an unmerged pull request;
 * read at the default branch it would be `not_found` for every decision a person is
 * being asked about. A capture that named no head is `unreadable` rather than a
 * guess.
 */
export function repoFileDecisionResolver(read: RepoFileRead): DecisionDocumentResolver {
  return {
    async resolve(identity, ctx) {
      // A page is the page resolver's (`decisionPageResolver.ts`); the service picks by
      // `source`, so this arm is a guard for a direct caller, never a read.
      if (identity.source === 'page') return { outcome: 'unresolvable', reason: 'unreadable' };
      if (!identity.resolvable) return { outcome: 'unresolvable', reason: identity.reason };
      if (!identity.headSha) return { outcome: 'unresolvable', reason: 'unreadable' };
      return contentFromRead(
        identity,
        await read(ctx, identity.repo, identity.path, identity.headSha),
      );
    },
  };
}

/** What the page read answers: the version's text, plus what the port's meta line and
 *  notices draw (MOTIR-7436) — optional, so a read that knows only the text still works. */
export interface PageVersionReadResult {
  markdown: string;
  authorName?: string | null;
  savedAt?: string | null;
  frozen?: boolean;
  latestVersionNumber?: number | null;
}

/** The read the page resolver makes — injected, as the file one's is. `null` when the
 *  version row is gone. */
export type PageVersionRead = (
  ctx: DecisionDocumentReadContext,
  versionId: string,
) => Promise<PageVersionReadResult | null>;

/**
 * The SECOND resolver — a published page version's markdown (Story MOTIR-5761 ·
 * MOTIR-7433). The version is sealed, so what it reads is exactly what was published;
 * a row that is gone (only a project delete takes it, past the publication's FK) is
 * `gone_at_head`, the file arm's own "not there any more".
 */
export function pageDecisionResolver(read: PageVersionRead): DecisionDocumentResolver {
  return {
    async resolve(identity, ctx) {
      if (identity.source !== 'page') return { outcome: 'unresolvable', reason: 'unreadable' };
      return contentFromPage(identity, await read(ctx, identity.versionId));
    },
  };
}

/** A page version's read → a document's content. */
export function contentFromPage(
  identity: PageDecisionIdentity,
  version: PageVersionReadResult | null,
): DecisionDocumentContent {
  if (!version) return { outcome: 'unresolvable', reason: 'gone_at_head' };
  return {
    outcome: 'page',
    pageId: identity.pageId,
    versionId: identity.versionId,
    versionNumber: identity.versionNumber,
    title: identity.title,
    markdown: version.markdown,
    authorName: version.authorName ?? null,
    savedAt: version.savedAt ?? null,
    frozen: version.frozen ?? false,
    latestVersionNumber: version.latestVersionNumber ?? null,
  };
}
