import type { Prisma } from '@/generated/prisma/client';
import type { PageStore } from '@motir/pages';
import {
  toLockedPageRow,
  toPageCommentRow,
  toPageRow,
  toPageVersionRow,
  toPageVersionWithBody,
} from '@/lib/mappers/pageMappers';
import { pageCommentRepository } from '@/lib/repositories/pageCommentRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pageVersionRepository } from '@/lib/repositories/pageVersionRepository';
import { pageWorkItemLinkRepository } from '@/lib/repositories/pageWorkItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { diffDerivedLinks } from '@/lib/pages/derivedLinks';

// The `PageStore` ADAPTER (Story MOTIR-5752 · MOTIR-7276; placement MOTIR-5753 ·
// MOTIR-7369), `docs/decisions/pages.md` §2: the package's port bound to ONE
// open transaction over `pageRepository`. It maps and nothing else — every
// query is the repository's, every rule is the package's, and the transaction
// is the page service's.

/** A `PageStore` whose every call runs inside `tx`. */
export function createPageStore(tx: Prisma.TransactionClient): PageStore {
  return {
    async lockPage(pageId) {
      const record = await pageRepository.lockById(pageId, tx);
      return record ? toLockedPageRow(record) : null;
    },

    async findPage(pageId) {
      const record = await pageRepository.findById(pageId, tx);
      return record ? toPageRow(record) : null;
    },

    // The port allows locking more than the named level, and this adapter does:
    // the whole project's page structure, which is what serialises a move
    // against a create or another move (`pageRepository.lockStructure`).
    async lockSiblings(projectId) {
      await pageRepository.lockStructure(projectId, tx);
    },

    async lastSiblingPosition(projectId, parent) {
      return pageRepository.lastPosition(projectId, parent, tx);
    },

    async findFolder(folderId) {
      return pageRepository.findFolderForPlacement(folderId, tx);
    },

    async findSubtree(pageId) {
      return pageRepository.findSubtree(pageId, tx);
    },

    async siblingNeighbours(projectId, parent, beforeId, afterId) {
      return pageRepository.neighbourPositions(projectId, parent, beforeId, afterId, tx);
    },

    async insertPage(row) {
      const record = await pageRepository.insert(
        {
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          title: row.title,
          parentPageId: row.parentPageId,
          folderId: row.folderId,
          position: row.position,
          ancestorPageIds: [...row.ancestorPageIds],
          bodyState: new Uint8Array(row.body.state),
          bodyJson: row.body.json as Prisma.InputJsonValue,
          bodyMarkdown: row.body.markdown,
          bodyText: row.body.text,
          revision: row.body.revision,
          createdById: row.createdById,
          updatedById: row.body.updatedById,
          createdAt: row.createdAt,
          updatedAt: row.body.updatedAt,
        },
        tx,
      );
      return toPageRow(record);
    },

    async updateBody(pageId, body) {
      await pageRepository.updateBody(
        pageId,
        {
          bodyState: new Uint8Array(body.state),
          bodyJson: body.json as Prisma.InputJsonValue,
          bodyMarkdown: body.markdown,
          bodyText: body.text,
          revision: body.revision,
          updatedById: body.updatedById,
          updatedAt: body.updatedAt,
        },
        tx,
      );
    },

    async updateTitle(pageId, title, updatedById) {
      const record = await pageRepository.updateTitle(pageId, title, updatedById, tx);
      return record ? toPageRow(record) : null;
    },

    async updatePlacement(pageId, placement, updatedById) {
      const record = await pageRepository.updatePlacement(
        pageId,
        { ...placement, updatedById },
        tx,
      );
      return toPageRow(record);
    },

    async rebaseDescendants(pageId, newAncestorPageIds) {
      await pageRepository.rebaseDescendants(pageId, newAncestorPageIds, tx);
    },

    // ── Versions (Story MOTIR-5754 · MOTIR-7384) — `page_version`, same `tx`. ──

    async latestVersion(pageId) {
      const record = await pageVersionRepository.findLatest(pageId, tx);
      return record ? toPageVersionRow(record) : null;
    },

    async insertVersion(row) {
      const record = await pageVersionRepository.insert(
        {
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          pageId: row.pageId,
          number: row.number,
          authorId: row.authorId,
          bodyState: new Uint8Array(row.bodyState),
          bodyMarkdown: row.bodyMarkdown,
          startedAt: row.startedAt,
          savedAt: row.savedAt,
          restoredFromVersionId: row.restoredFromVersionId,
          restoredFromNumber: row.restoredFromNumber,
        },
        tx,
      );
      return toPageVersionRow(record);
    },

    async updateVersion(versionId, row) {
      await pageVersionRepository.update(
        versionId,
        {
          bodyState: new Uint8Array(row.bodyState),
          bodyMarkdown: row.bodyMarkdown,
          savedAt: row.savedAt,
        },
        tx,
      );
    },

    async findVersion(pageId, number) {
      const record = await pageVersionRepository.findByPageAndNumber(pageId, number, tx);
      return record ? toPageVersionWithBody(record) : null;
    },

    async findPageWithFrozenVersion(pageIds) {
      return pageVersionRepository.anyFrozenVersion(pageIds, tx);
    },

    async countVersions(pageId) {
      return pageVersionRepository.countByPage(pageId, tx);
    },

    async deleteOldestUnmarkedVersions(pageId, keep) {
      await pageVersionRepository.deleteOldestUnmarked(pageId, keep, tx);
    },

    // The derived link rows (§8.1, MOTIR-7571), rewritten as a DIFF under the
    // save's page lock: only work items of the page's own project are kept — a
    // cross-project or unknown id is dropped silently, archived items stay —
    // and a `manual` row is never read or written.
    async replaceDerivedLinks(pageId, links, actorId) {
      const page = await pageRepository.findById(pageId, tx);
      if (!page) return;
      const inProject = new Set(
        await workItemRepository.findIdsInProject(
          page.projectId,
          [...new Set(links.map((link) => link.workItemId))],
          tx,
        ),
      );
      const named = links.filter((link) => inProject.has(link.workItemId));
      const stored = await pageWorkItemLinkRepository.findDerivedByPage(pageId, tx);
      const diff = diffDerivedLinks(stored, named);
      await pageWorkItemLinkRepository.deleteDerivedByIds(pageId, diff.deleteIds, tx);
      await pageWorkItemLinkRepository.createDerived(
        diff.insert.map((link) => ({
          workspaceId: page.workspaceId,
          projectId: page.projectId,
          pageId,
          workItemId: link.workItemId,
          source: link.source,
          createdById: actorId,
        })),
        tx,
      );
    },

    // ── Archive (Story MOTIR-5755 · MOTIR-7418 port, MOTIR-7420 Postgres). ──

    async setArchived(ids, archivedAt, archiveRootId, archivedById) {
      await pageRepository.setArchived(ids, archivedAt, archiveRootId, archivedById, tx);
    },

    async findArchiveSet(rootId) {
      return pageRepository.findArchiveSet(rootId, tx);
    },

    async deletePages(ids) {
      await pageRepository.deletePages(ids, tx);
    },

    async positionTaken(projectId, parent, position) {
      return pageRepository.positionTaken(projectId, parent, position, tx);
    },

    // ── Comments (Story MOTIR-10866 · MOTIR-10872) — `page_comment`, same `tx`. ──

    async findPageCommentRoots(query) {
      const records = await pageCommentRepository.findRoots(
        {
          pageId: query.pageId,
          status: query.status,
          order: query.order,
          after: query.after ? { at: query.after.at, id: query.after.id } : null,
          limit: query.limit,
        },
        tx,
      );
      return records.map(toPageCommentRow);
    },

    async findPageCommentReplies(rootIds) {
      return (await pageCommentRepository.findReplies(rootIds, tx)).map(toPageCommentRow);
    },

    async countPageCommentRoots(pageId) {
      return pageCommentRepository.countRoots(pageId, tx);
    },

    // The lock and the joined read are two statements in the same transaction:
    // `FOR UPDATE` is raw SQL, and the author/resolver join is the client's.
    async lockPageComment(commentId) {
      if (!(await pageCommentRepository.lockById(commentId, tx))) return null;
      const record = await pageCommentRepository.findById(commentId, tx);
      return record ? toPageCommentRow(record) : null;
    },

    // The read path's by-id read: no row lock, so a reader never waits behind a writer.
    async findPageComment(commentId) {
      const record = await pageCommentRepository.findById(commentId, tx);
      return record ? toPageCommentRow(record) : null;
    },

    async insertPageComment(row) {
      const record = await pageCommentRepository.insert(
        {
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          pageId: row.pageId,
          authorId: row.authorId,
          parentCommentId: row.parentCommentId,
          bodyMd: row.bodyMd,
          createdAt: row.createdAt,
          anchor: row.anchor ? new Uint8Array(row.anchor.bytes) : null,
          anchorQuote: row.anchor ? row.anchor.quote : null,
        },
        tx,
      );
      return toPageCommentRow(record);
    },

    async updatePageCommentBody(commentId, bodyMd, editedAt) {
      return toPageCommentRow(
        await pageCommentRepository.updateBody(commentId, bodyMd, editedAt, tx),
      );
    },

    async deletePageCommentRow(commentId) {
      await pageCommentRepository.delete(commentId, tx);
    },

    async setPageCommentResolved(commentId, resolvedAt, resolvedById) {
      return toPageCommentRow(
        await pageCommentRepository.setResolved(commentId, resolvedAt, resolvedById, tx),
      );
    },
  };
}
