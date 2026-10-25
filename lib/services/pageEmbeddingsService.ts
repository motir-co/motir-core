import 'server-only';

import { embedTexts } from '@/lib/ai/motirAiClient';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { composePageEmbeddingDocument, hashEmbeddingDocument } from '@/lib/pages/embeddingDocument';
import {
  EMBEDDING_DIMENSIONS,
  pageEmbeddingRepository,
} from '@/lib/repositories/pageEmbeddingRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { motirAiConfigured } from '@/lib/services/workItemEmbeddingsService';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { EmbeddingDimensionMismatchError } from '@/lib/workItems/errors';

// The page semantic index's WRITE PATH (Story MOTIR-9490 · MOTIR-9571) — the page
// twin of `workItemEmbeddingsService.embedWorkItem`, under the same rules
// (`docs/decisions/plan-tree-embeddings.md` §6.3):
//
// ⚠️ THE EXTERNAL CALL IS NEVER INSIDE A TRANSACTION. `embedPage` is staged
// read-tx → `embedTexts` → write-tx, so a gateway that hangs holds no row lock,
// and an outage degrades a page to "not yet a semantic candidate" — it is still
// found by full-text — rather than failing the save that triggered it. That save
// committed long before this runs: the write doors only EMIT, post-commit.
//
// THE JOB RE-READS BEFORE IT EMBEDS. The event carries a page id and no text, so
// rapid edits converge on the page's CURRENT text whichever order their jobs run
// in, and the content hash makes every surplus job one cheap read.
//
// AN ARCHIVED PAGE LOSES ITS ROW HERE, not inside the archive transaction: the
// archive stays a local write, and this re-read is the single place that decides
// present-or-absent. The ranking read already refuses archived pages
// (`PAGE_SEARCH_LIVE_IN_PROJECT`), so the moment before this job runs cannot leak
// an archived hit. A restore emits again, and the page is re-embedded.

/** Why `embedPage` wrote no vector. Every one is a VALUE, never an error. */
export type PageEmbeddingSkipReason =
  /** No motir-ai configured (a self-hosted open-core deployment). */
  | 'ai-not-configured'
  /** The page was deleted between the emit and this read. */
  | 'not-found'
  /** The stored hash already matches the page's current document. */
  | 'unchanged'
  /** The page is archived, so its row was dropped. */
  | 'removed';

export type EmbedPageResult =
  | { embedded: true; model: string }
  | { embedded: false; reason: PageEmbeddingSkipReason };

export const pageEmbeddingsService = {
  /**
   * Derive and store ONE page's embedding — the `page/embedding.requested` job's
   * entry point. Idempotent: an unchanged page answers `unchanged` with no
   * provider call. Throws only on a transport failure (so the job's retry budget
   * absorbs an outage, leaving any existing row as it was) and on a vector of the
   * wrong length (`EmbeddingDimensionMismatchError`, which writes nothing).
   *
   * Only the HASH is compared before the call, as for work items: a row written
   * under another model reads as unchanged, and a model swap is the visible,
   * rolling gap the ranking's model filter makes it (refilled by an operational
   * sweep, never silently mixed).
   */
  async embedPage(input: { workspaceId: string; pageId: string }): Promise<EmbedPageResult> {
    if (!motirAiConfigured()) return { embedded: false, reason: 'ai-not-configured' };

    // ── Stage 1: READ (short transaction, workspace GUC bound for RLS) ────────
    const pending = await withWorkspaceServiceContext(input.workspaceId, async (tx) => {
      const page = await pageRepository.findEmbeddingSourceById(input.pageId, tx);
      if (!page || page.workspaceId !== input.workspaceId) return { kind: 'not-found' as const };
      if (page.archivedAt !== null) {
        await pageEmbeddingRepository.deleteByPageId(page.id, tx);
        return { kind: 'removed' as const };
      }
      const document = composePageEmbeddingDocument({
        title: page.title,
        bodyText: page.bodyText,
      });
      const contentHash = hashEmbeddingDocument(document);
      const existing = await pageEmbeddingRepository.findByPageId(page.id, tx);
      if (existing?.contentHash === contentHash) return { kind: 'unchanged' as const };
      return { kind: 'stale' as const, projectId: page.projectId, document, contentHash };
    });
    if (pending.kind !== 'stale') return { embedded: false, reason: pending.kind };

    // ── Stage 2: the EXTERNAL call — deliberately between the transactions ────
    const batch = await embedTexts([pending.document]);
    const vector = batch.embeddings[0];
    if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingDimensionMismatchError(
        EMBEDDING_DIMENSIONS,
        vector?.length ?? 0,
        batch.model,
      );
    }

    // ── Stage 3: WRITE (short transaction) ───────────────────────────────────
    // Not re-read: a page edited again while the vector was in flight has its own
    // job queued, which overwrites this row with the newer text.
    await withWorkspaceServiceContext(input.workspaceId, (tx) =>
      pageEmbeddingRepository.upsert(
        {
          pageId: input.pageId,
          workspaceId: input.workspaceId,
          projectId: pending.projectId,
          model: batch.model,
          dimensions: vector.length,
          contentHash: pending.contentHash,
          embeddedAt: new Date(),
          embedding: vector,
        },
        tx,
      ),
    );
    return { embedded: true, model: batch.model };
  },

  /**
   * Ask for the embedding of each of `pageIds` to be brought up to date — one
   * `page/embedding.requested` per distinct id. Called by every page write door
   * AFTER its transaction has committed, so a rolled-back save emits nothing.
   * Best-effort like every post-commit emit: a dropped event is healed by the
   * page's next save or by the backfill.
   */
  async requestEmbeddings(workspaceId: string, pageIds: readonly string[]): Promise<void> {
    for (const pageId of new Set(pageIds)) {
      await sendEvent('page/embedding.requested', { workspaceId, pageId });
    }
  },
};
