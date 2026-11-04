// The work item's Pages read (Story MOTIR-7565 · MOTIR-7573) — what crosses the
// service boundary for "which pages link to this work item?" One row per linking
// page, live or unavailable, however many link rows it has
// (`docs/decisions/pages.md` §8.1).

import type { WorkItemRefSummaryDto } from '@/lib/dto/workItems';

/**
 * How a page links to the work item: a chip in its body, an embed, by hand, or
 * a tag in the work item's own Description / Explanation (MOTIR-7696).
 */
export type PageLinkSourceDto = 'mention' | 'embed' | 'manual' | 'description' | 'explanation';

/** Where the page sits, in the page breadcrumb's vocabulary. */
export interface WorkItemPageLinkPlaceDto {
  /** The folder chain its topmost page is filed in, root first; `[]` at the root. */
  folderPath: string[];
  /** Its direct parent page's title; `null` for a top-level page. */
  parentPageTitle: string | null;
}

/**
 * `unavailable`: the page can no longer be opened as a live page (it is
 * archived); its title, place and sources are still what it had (MOTIR-9203). A
 * deleted page has no row at all — the FK cascade takes its link rows.
 */
export type WorkItemPageLinkStateDto = 'live' | 'unavailable';

/** One page linking to the work item. */
export interface WorkItemPageLinkRowDto {
  pageId: string;
  title: string;
  state: WorkItemPageLinkStateDto;
  /** Every way it links, sorted. */
  sources: PageLinkSourceDto[];
  /** ISO-8601, the page's last edit. */
  updatedAt: string;
  place: WorkItemPageLinkPlaceDto;
}

/** One page of the read, newest edit first; `nextCursor` is `null` on the last. */
export interface WorkItemPagesDto {
  rows: WorkItemPageLinkRowDto[];
  nextCursor: string | null;
}

/** The pair a hand-link write answers with (MOTIR-9197); the section's row is the read's to compose. */
export interface PageLinkPairDto {
  pageId: string;
  workItemId: string;
  source: 'manual';
}

/**
 * One hand-linked work item on a page (MOTIR-9198). `summary` is the live chip
 * summary, `{ accessible: false, id }` for an item the reader may not browse, or
 * `null` when the item resolves to nothing — the row is kept either way.
 */
export interface PageWorkItemLinkRowDto {
  workItemId: string;
  /** ISO-8601, when the hand link was made. */
  linkedAt: string;
  summary: WorkItemRefSummaryDto | null;
}

/** One page of a page's hand-linked work items, newest link first. */
export interface PageWorkItemsDto {
  rows: PageWorkItemLinkRowDto[];
  nextCursor: string | null;
  /** Whether this reader may add a hand link (`work_item:edit`); never the authority. */
  canLink: boolean;
}

/**
 * The published decision on one linked page (MOTIR-10315): the version the card's
 * LATEST publication sealed, and when it was published.
 */
export interface WorkItemDecisionMarkDto {
  versionNumber: number;
  /** ISO-8601. */
  publishedAt: string;
}

/** One linked page as `get_work_item` serves it: the Pages row plus its decision mark. */
export interface WorkItemLinkedPageDto extends WorkItemPageLinkRowDto {
  /** Set on the page the card's LATEST publication names; `null` on every other row. */
  decision: WorkItemDecisionMarkDto | null;
}

/** The card's published decision page — its latest publication — wherever it sits in the list. */
export interface WorkItemDecisionPageDto extends WorkItemDecisionMarkDto {
  pageId: string;
  title: string;
}

/**
 * A work item's linked pages for an AGENT read (MOTIR-10315): the first window of
 * the set the card's Pages section shows, in its order, bounded. `hasMore` says
 * the set holds more than `rows`. `decisionPage` names the latest publication
 * even when its page falls outside the window.
 */
export interface WorkItemLinkedPagesDto {
  rows: WorkItemLinkedPageDto[];
  hasMore: boolean;
  decisionPage: WorkItemDecisionPageDto | null;
}
