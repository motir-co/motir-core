import {
  rebaseAncestorIds,
  type Clock,
  type DerivedPageLink,
  type FolderRef,
  type NeighbourPositions,
  type PagePlacementWrite,
  type SubtreePage,
  type LockedPageRow,
  type PageBodyWrite,
  type PageInsert,
  type PagePlacement,
  type PageRow,
  type PageStore,
  type PageVersionInsert,
  type PageVersionRow,
  type PageVersionUpdate,
  type PageVersionWithBody,
  type PageCommentCounts,
  type PageCommentInsert,
  type PageCommentPerson,
  type PageCommentRootsQuery,
  type PageCommentRow,
} from '../../src';

/** A stored page in the fake: the row plus its body columns. */
export interface MemoryPage extends LockedPageRow {
  readonly bodyJson: unknown;
  readonly bodyMarkdown: string;
  readonly bodyText: string;
}

/** Whether a LIVE page sits at `parent` — the level reads never see an archived page. */
const sameParent = (page: PageRow, parent: PagePlacement): boolean =>
  page.archivedAt === null &&
  (parent.kind === 'root'
    ? page.parentPageId === null && page.folderId === null
    : parent.kind === 'folder'
      ? page.folderId === parent.folderId
      : page.parentPageId === parent.pageId);

/**
 * An in-memory `PageStore` that records every call, so a test can assert what a
 * procedure did NOT reach as well as what it wrote.
 */
export class MemoryPageStore implements PageStore {
  readonly pages = new Map<string, MemoryPage>();
  readonly folders = new Map<string, FolderRef>();
  /** Every stored version, in insertion order, across pages. */
  versions: PageVersionWithBody[] = [];
  /** Every stored page comment, by id. */
  readonly comments = new Map<string, PageCommentRow>();
  /** The people a comment can name; an unknown id reads as `{ id, name: id }`. */
  readonly people = new Map<string, PageCommentPerson>();
  readonly calls: { method: keyof PageStore; args: unknown[] }[] = [];
  private nextId = 0;

  called(method: keyof PageStore): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  private record(method: keyof PageStore, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  async lockPage(pageId: string): Promise<LockedPageRow | null> {
    this.record('lockPage', pageId);
    return this.pages.get(pageId) ?? null;
  }

  async findPage(pageId: string): Promise<PageRow | null> {
    this.record('findPage', pageId);
    return this.pages.get(pageId) ?? null;
  }

  async lockSiblings(projectId: string, parent: PagePlacement): Promise<void> {
    this.record('lockSiblings', projectId, parent);
  }

  async lastSiblingPosition(projectId: string, parent: PagePlacement): Promise<string | null> {
    this.record('lastSiblingPosition', projectId, parent);
    const positions = [...this.pages.values()]
      .filter((page) => page.projectId === projectId && sameParent(page, parent))
      .map((page) => page.position)
      .sort();
    return positions.at(-1) ?? null;
  }

  /** Adds a folder a placement can name. */
  addFolder(id: string, projectId: string): FolderRef {
    const folder = { id, projectId };
    this.folders.set(id, folder);
    return folder;
  }

  /** One level's pages in `(position, id)` order. */
  level(projectId: string, parent: PagePlacement): MemoryPage[] {
    return [...this.pages.values()]
      .filter((page) => page.projectId === projectId && sameParent(page, parent))
      .sort((a, b) =>
        a.position !== b.position ? (a.position < b.position ? -1 : 1) : a.id < b.id ? -1 : 1,
      );
  }

  async findFolder(folderId: string): Promise<FolderRef | null> {
    this.record('findFolder', folderId);
    return this.folders.get(folderId) ?? null;
  }

  async findSubtree(pageId: string): Promise<SubtreePage[]> {
    this.record('findSubtree', pageId);
    return [...this.pages.values()]
      .filter((page) => page.ancestorPageIds.includes(pageId))
      .map(toSubtreePage);
  }

  async siblingNeighbours(
    projectId: string,
    parent: PagePlacement,
    beforeId: string | null,
    afterId: string | null,
  ): Promise<NeighbourPositions> {
    this.record('siblingNeighbours', projectId, parent, beforeId, afterId);
    const level = this.level(projectId, parent);
    const at = (id: string) => level.findIndex((page) => page.id === id);
    if (beforeId !== null && afterId !== null) {
      return { before: level[at(beforeId)]!.position, after: level[at(afterId)]!.position };
    }
    if (beforeId !== null) {
      const i = at(beforeId);
      return { before: level[i]!.position, after: level[i + 1]?.position ?? null };
    }
    if (afterId !== null) {
      const i = at(afterId);
      return { before: level[i - 1]?.position ?? null, after: level[i]!.position };
    }
    return { before: level.at(-1)?.position ?? null, after: null };
  }

  async updatePlacement(
    pageId: string,
    placement: PagePlacementWrite,
    updatedById: string,
  ): Promise<PageRow> {
    this.record('updatePlacement', pageId, placement, updatedById);
    const page = this.pages.get(pageId)!;
    const moved = { ...page, ...placement, updatedById };
    this.pages.set(pageId, moved);
    return moved;
  }

  async rebaseDescendants(pageId: string, newAncestorPageIds: readonly string[]): Promise<void> {
    this.record('rebaseDescendants', pageId, newAncestorPageIds);
    for (const page of [...this.pages.values()]) {
      if (!page.ancestorPageIds.includes(pageId)) continue;
      this.pages.set(page.id, {
        ...page,
        ancestorPageIds: rebaseAncestorIds(page.ancestorPageIds, pageId, newAncestorPageIds),
      });
    }
  }

  async insertPage(row: PageInsert): Promise<PageRow> {
    this.record('insertPage', row);
    this.nextId += 1;
    const page: MemoryPage = {
      id: `page-${this.nextId}`,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      title: row.title,
      parentPageId: row.parentPageId,
      folderId: row.folderId,
      position: row.position,
      ancestorPageIds: row.ancestorPageIds,
      revision: row.body.revision,
      createdById: row.createdById,
      updatedById: row.body.updatedById,
      createdAt: row.createdAt,
      updatedAt: row.body.updatedAt,
      archivedAt: null,
      archiveRootId: null,
      archivedById: null,
      bodyState: row.body.state,
      bodyJson: row.body.json,
      bodyMarkdown: row.body.markdown,
      bodyText: row.body.text,
    };
    this.pages.set(page.id, page);
    return page;
  }

  async updateBody(pageId: string, body: PageBodyWrite): Promise<void> {
    this.record('updateBody', pageId, body);
    const page = this.pages.get(pageId)!;
    this.pages.set(pageId, {
      ...page,
      bodyState: body.state,
      bodyJson: body.json,
      bodyMarkdown: body.markdown,
      bodyText: body.text,
      revision: body.revision,
      updatedById: body.updatedById,
      updatedAt: body.updatedAt,
    });
  }

  async updateTitle(pageId: string, title: string, updatedById: string): Promise<PageRow | null> {
    this.record('updateTitle', pageId, title, updatedById);
    const page = this.pages.get(pageId);
    if (!page) return null;
    const renamed = { ...page, title, updatedById };
    this.pages.set(pageId, renamed);
    return renamed;
  }

  /** A page's versions, oldest first. */
  versionsOf(pageId: string): PageVersionWithBody[] {
    return this.versions.filter((v) => v.pageId === pageId).sort((a, b) => a.number - b.number);
  }

  async latestVersion(pageId: string): Promise<PageVersionRow | null> {
    this.record('latestVersion', pageId);
    return this.versionsOf(pageId).at(-1) ?? null;
  }

  async insertVersion(row: PageVersionInsert): Promise<PageVersionRow> {
    this.record('insertVersion', row);
    if (this.versions.some((v) => v.pageId === row.pageId && v.number === row.number)) {
      throw new Error(`unique (page_id, number) violated: ${row.pageId} v${row.number}`);
    }
    this.nextId += 1;
    const version: PageVersionWithBody = {
      id: `version-${this.nextId}`,
      ...row,
      sealedAt: null,
      frozenAt: null,
    };
    this.versions.push(version);
    return version;
  }

  async updateVersion(versionId: string, row: PageVersionUpdate): Promise<void> {
    this.record('updateVersion', versionId, row);
    this.versions = this.versions.map((v) => (v.id === versionId ? { ...v, ...row } : v));
  }

  async findVersion(pageId: string, number: number): Promise<PageVersionWithBody | null> {
    this.record('findVersion', pageId, number);
    return this.versions.find((v) => v.pageId === pageId && v.number === number) ?? null;
  }

  async countVersions(pageId: string): Promise<number> {
    this.record('countVersions', pageId);
    return this.versionsOf(pageId).length;
  }

  async findPageWithFrozenVersion(pageIds: readonly string[]): Promise<string | null> {
    this.record('findPageWithFrozenVersion', pageIds);
    const ids = new Set(pageIds);
    return this.versions.find((v) => ids.has(v.pageId) && v.frozenAt !== null)?.pageId ?? null;
  }

  /** Stamps the marks on a version, as the gate services do (test helper). */
  markVersion(versionId: string, marks: { sealedAt?: Date; frozenAt?: Date }): void {
    this.versions = this.versions.map((v) => (v.id === versionId ? { ...v, ...marks } : v));
  }

  async deleteOldestUnmarkedVersions(pageId: string, keep: number): Promise<void> {
    this.record('deleteOldestUnmarkedVersions', pageId, keep);
    const own = this.versionsOf(pageId);
    const excess = Math.max(0, own.length - keep);
    const newest = own.at(-1)?.id;
    const unmarked = own.filter(
      (v) => v.sealedAt === null && v.frozenAt === null && v.id !== newest,
    );
    const doomed = new Set(unmarked.slice(0, excess).map((v) => v.id));
    // ON DELETE SET NULL on `restored_from_version_id`, as the table does.
    this.versions = this.versions
      .filter((v) => !doomed.has(v.id))
      .map((v) =>
        v.restoredFromVersionId !== null && doomed.has(v.restoredFromVersionId)
          ? { ...v, restoredFromVersionId: null }
          : v,
      );
  }

  async replaceDerivedLinks(
    pageId: string,
    links: readonly DerivedPageLink[],
    actorId: string,
  ): Promise<void> {
    this.record('replaceDerivedLinks', pageId, links, actorId);
  }

  async setArchived(
    ids: readonly string[],
    archivedAt: Date | null,
    archiveRootId: string | null,
    archivedById: string | null,
  ): Promise<void> {
    this.record('setArchived', ids, archivedAt, archiveRootId, archivedById);
    // `page_archive_pairing`, as the table holds it.
    if ((archivedAt === null) !== (archiveRootId === null)) {
      throw new Error('page_archive_pairing violated');
    }
    for (const id of ids) {
      const page = this.pages.get(id)!;
      this.pages.set(id, { ...page, archivedAt, archiveRootId, archivedById });
    }
  }

  async findArchiveSet(rootId: string): Promise<SubtreePage[]> {
    this.record('findArchiveSet', rootId);
    return [...this.pages.values()]
      .filter((page) => page.archiveRootId === rootId)
      .map(toSubtreePage);
  }

  async deletePages(ids: readonly string[]): Promise<void> {
    this.record('deletePages', ids);
    const doomed = new Set(ids);
    // ONE statement: `parent_page_id NO ACTION` is checked at its END, so a
    // survivor still pointing into the deleted set fails the whole delete.
    for (const page of this.pages.values()) {
      if (!doomed.has(page.id) && page.parentPageId !== null && doomed.has(page.parentPageId)) {
        throw new Error(
          `page_parent_page_id_fkey violated: ${page.id} still references ${page.parentPageId}`,
        );
      }
    }
    for (const id of ids) this.pages.delete(id);
    // `page_version` cascades with its page.
    this.versions = this.versions.filter((v) => !doomed.has(v.pageId));
    // So does `page_comment`.
    for (const row of [...this.comments.values()]) {
      if (doomed.has(row.pageId)) this.comments.delete(row.id);
    }
  }

  async positionTaken(
    projectId: string,
    parent: PagePlacement,
    position: string,
  ): Promise<boolean> {
    this.record('positionTaken', projectId, parent, position);
    return this.level(projectId, parent).some((page) => page.position === position);
  }

  // ── Comments (MOTIR-10872) ──────────────────────────────────────────────

  /** Registers a person a comment can name. */
  addPerson(id: string, name: string, image: string | null = null): PageCommentPerson {
    const person = { id, name, image };
    this.people.set(id, person);
    return person;
  }

  private person(id: string): PageCommentPerson {
    return this.people.get(id) ?? { id, name: id, image: null };
  }

  /** A stored comment with its people re-joined, as a read returns it. */
  private joined(row: PageCommentRow): PageCommentRow {
    return {
      ...row,
      author: this.person(row.authorId),
      resolvedBy: row.resolvedById === null ? null : this.person(row.resolvedById),
    };
  }

  async findPageCommentRoots(query: PageCommentRootsQuery): Promise<PageCommentRow[]> {
    this.record('findPageCommentRoots', query);
    const keyOf = (row: PageCommentRow) =>
      query.status === 'open' ? row.createdAt.getTime() : row.resolvedAt!.getTime();
    const cmp = (a: PageCommentRow, b: PageCommentRow) => {
      const d = keyOf(a) - keyOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return query.order === 'asc' ? d : -d;
    };
    const after = query.after;
    return [...this.comments.values()]
      .filter(
        (row) =>
          row.pageId === query.pageId &&
          row.parentCommentId === null &&
          (query.status === 'open') === (row.resolvedAt === null),
      )
      .filter((row) => {
        if (after === null) return true;
        const d =
          keyOf(row) - after.at.getTime() || (row.id < after.id ? -1 : row.id > after.id ? 1 : 0);
        return query.order === 'asc' ? d > 0 : d < 0;
      })
      .sort(cmp)
      .slice(0, query.limit)
      .map((row) => this.joined(row));
  }

  async findPageCommentReplies(rootIds: readonly string[]): Promise<PageCommentRow[]> {
    this.record('findPageCommentReplies', rootIds);
    const roots = new Set(rootIds);
    return [...this.comments.values()]
      .filter((row) => row.parentCommentId !== null && roots.has(row.parentCommentId))
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((row) => this.joined(row));
  }

  async countPageCommentRoots(pageId: string): Promise<PageCommentCounts> {
    this.record('countPageCommentRoots', pageId);
    const roots = [...this.comments.values()].filter(
      (row) => row.pageId === pageId && row.parentCommentId === null,
    );
    const open = roots.filter((row) => row.resolvedAt === null).length;
    return { open, resolved: roots.length - open };
  }

  async lockPageComment(commentId: string): Promise<PageCommentRow | null> {
    this.record('lockPageComment', commentId);
    const row = this.comments.get(commentId);
    return row ? this.joined(row) : null;
  }

  async findPageComment(commentId: string): Promise<PageCommentRow | null> {
    this.record('findPageComment', commentId);
    const row = this.comments.get(commentId);
    return row ? this.joined(row) : null;
  }

  async insertPageComment(row: PageCommentInsert): Promise<PageCommentRow> {
    this.record('insertPageComment', row);
    this.nextId += 1;
    const stored: PageCommentRow = {
      id: `comment-${this.nextId.toString().padStart(4, '0')}`,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      pageId: row.pageId,
      parentCommentId: row.parentCommentId,
      authorId: row.authorId,
      author: this.person(row.authorId),
      bodyMd: row.bodyMd,
      editedAt: null,
      createdAt: row.createdAt,
      resolvedAt: null,
      resolvedById: null,
      resolvedBy: null,
      anchor: row.anchor ? new Uint8Array(row.anchor.bytes) : null,
      anchorQuote: row.anchor ? row.anchor.quote : null,
    };
    this.comments.set(stored.id, stored);
    return this.joined(stored);
  }

  async updatePageCommentBody(
    commentId: string,
    bodyMd: string,
    editedAt: Date,
  ): Promise<PageCommentRow> {
    this.record('updatePageCommentBody', commentId, bodyMd, editedAt);
    const next = { ...this.comments.get(commentId)!, bodyMd, editedAt };
    this.comments.set(commentId, next);
    return this.joined(next);
  }

  async deletePageCommentRow(commentId: string): Promise<void> {
    this.record('deletePageCommentRow', commentId);
    // `parent_comment_id` cascades: a root's replies go with it.
    for (const row of [...this.comments.values()]) {
      if (row.parentCommentId === commentId) this.comments.delete(row.id);
    }
    this.comments.delete(commentId);
  }

  async setPageCommentResolved(
    commentId: string,
    resolvedAt: Date | null,
    resolvedById: string | null,
  ): Promise<PageCommentRow> {
    this.record('setPageCommentResolved', commentId, resolvedAt, resolvedById);
    const next = { ...this.comments.get(commentId)!, resolvedAt, resolvedById };
    this.comments.set(commentId, next);
    return this.joined(next);
  }
}

const toSubtreePage = (page: PageRow): SubtreePage => ({
  id: page.id,
  ancestorPageIds: page.ancestorPageIds,
  archivedAt: page.archivedAt,
  archiveRootId: page.archiveRootId,
});

/** A clock that returns a fixed instant, advanced by hand. */
export class FixedClock implements Clock {
  constructor(public current = new Date('2026-10-01T12:00:00Z')) {}
  now(): Date {
    return this.current;
  }
}
