import type { PageUnresolvedItemLinkDto } from '@/lib/dto/pages';

// The line `create_page` / `update_page` add when the saved body holds a `motir:`
// link that names no card (bug MOTIR-11281). The body is still saved — a dead link
// is the author's text, not a refusal — but it renders as a deleted chip and links
// the page to nothing, so the agent is told which links, and what a working one is.

/** `''` when every item link resolved; otherwise one sentence naming each dead link. */
export function unresolvedItemLinksNotice(links: readonly PageUnresolvedItemLinkDto[]): string {
  if (links.length === 0) return '';
  return (
    `\n⚠️ ${links.length} work-item link(s) name no card you can see and draw as deleted: ` +
    `${links.map((l) => l.link).join(', ')}. A work-item link is [KEY](motir:<work item id>) ` +
    '(a key in place of the id is resolved for you); correct these and save again.'
  );
}
