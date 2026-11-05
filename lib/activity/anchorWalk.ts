import type { ActivityAllEntryDto, ActivityAllPageDto } from '@/lib/dto/activity';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// THE ANCHOR WALK (MOTIR-10463). A verdict link lands on `?activity=all#agent-verdict-<id>`,
// and the All tab server-renders only its FIRST page, newest first. An older entry is not on
// that page, so the address names an element that does not exist yet: nothing scrolls and
// the findings stay closed. The URL fragment never reaches the server, so the server cannot
// widen its read for it; the tab walks the next pages in the browser until the anchored entry
// arrives, and only then shows them — so the feed stays one unbroken, ordered run of entries
// and the entry opens itself in place (`AgentVerdictActivityRow` reads the same hash).
//
// The walk is BOUNDED. A link to a record the card does not hold (a deleted verdict, a typo,
// another card's id) must not read the whole trail, and a card with a very long trail must
// not fire an unbounded stream of requests on arrival. Past the bound, and on any failed
// read, the walk gives up and the tab keeps the page it drew — the page as it is without
// the walk, with no error.
//
// ⚠️ CLIENT-SAFE. Imported by the All tab, so it imports nothing server-only.

/** Pages the walk may read past the server-rendered first one (20 entries each). */
export const MAX_ANCHOR_WALK_PAGES = 25;

/** Does a loaded window already draw this verdict record's Activity entry? */
export function entriesDrawAgentVerdict(
  entries: readonly ActivityAllEntryDto[],
  recordId: string,
): boolean {
  return entries.some(
    (entry) =>
      entry.type === 'history' &&
      entry.entry.parts.some((part) => part.kind === 'agentVerdict' && part.recordId === recordId),
  );
}

/** What a walk that REACHED its record hands back: the pages to append, in read order. */
export interface AnchorWalkReached {
  entries: ActivityAllEntryDto[];
  nextCursor: string | null;
  totalComments: number;
  totalChanges: number;
  workItemRefs: WorkItemRefMap;
}

/**
 * Read pages from `cursor` until one draws `recordId`'s entry, at most `maxPages` reads.
 * Returns everything read up to and including that page, or null when the trail ends, the
 * bound is reached or a read fails first — the caller then keeps the window it has.
 */
export async function walkToAgentVerdict({
  recordId,
  cursor,
  fetchPage,
  maxPages = MAX_ANCHOR_WALK_PAGES,
}: {
  recordId: string;
  cursor: string;
  fetchPage: (cursor: string) => Promise<ActivityAllPageDto>;
  maxPages?: number;
}): Promise<AnchorWalkReached | null> {
  const entries: ActivityAllEntryDto[] = [];
  let workItemRefs: WorkItemRefMap = {};
  let next: string | null = cursor;
  for (let read = 0; next !== null && read < maxPages; read += 1) {
    let page: ActivityAllPageDto;
    try {
      page = await fetchPage(next);
    } catch {
      return null;
    }
    entries.push(...page.entries);
    workItemRefs = { ...workItemRefs, ...(page.workItemRefs ?? {}) };
    next = page.nextCursor;
    if (entriesDrawAgentVerdict(page.entries, recordId)) {
      return {
        entries,
        nextCursor: next,
        totalComments: page.totalComments,
        totalChanges: page.totalChanges,
        workItemRefs,
      };
    }
  }
  return null;
}
