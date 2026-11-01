// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { DecisionDocumentSlot } from '@/components/github/DecisionDocumentSlot';
import type { DecisionDocumentViewDTO } from '@/lib/dto/decisionDocument';
import type { WorkItemRefMap, WorkItemRefSummaryDto } from '@/lib/dto/workItems';

// Bug MOTIR-10020 — a decision document shown at its gate drew every work-item link
// struck through as "This work item no longer exists": both `MarkdownView`s in the
// decision slot were handed no ref map, so every chip took the deleted state. The DTO
// now carries the reader's `workItemRefs` on both arms that draw Markdown, and the
// slot renders the document with them.

afterEach(cleanup);

const LIVE: WorkItemRefSummaryDto = {
  accessible: true,
  id: 'wi_live',
  identifier: 'MOTIR-706',
  title: 'The seed registry',
  kind: 'subtask',
  archived: false,
  status: { key: 'done', label: 'Done', category: 'done' },
  type: null,
  assignee: null,
};
const HIDDEN: WorkItemRefSummaryDto = { accessible: false, id: 'wi_hidden' };

const MARKDOWN = [
  '# Decision',
  '',
  'Settles [MOTIR-706](motir:wi_live), retires [MOTIR-1](motir:wi_gone),',
  'and hands work to [MOTIR-42](motir:wi_hidden).',
].join('\n');

const REFS: WorkItemRefMap = { wi_live: LIVE, wi_hidden: HIDDEN };

const PAGE: DecisionDocumentViewDTO = {
  outcome: 'page',
  pageId: 'page-1',
  versionId: 'version-1',
  versionNumber: 1,
  title: 'Seed registry',
  markdown: MARKDOWN,
  workItemRefs: REFS,
  pageUrl: '/pages/page-1',
  versionUrl: '/pages/page-1?version=1',
  compareUrl: '/pages/page-1?history=open&version=1',
  authorName: 'Mo',
  savedAt: '2026-10-28T18:00:00.000Z',
  frozen: false,
  changedSince: false,
};

const FILE: DecisionDocumentViewDTO = {
  outcome: 'resolved',
  repo: 'acme/web',
  number: 7,
  path: 'docs/decisions/seed-registry.md',
  blobSha: 'blob-1',
  headSha: 'head-1',
  markdown: MARKDOWN,
  workItemRefs: REFS,
  hostUrl: 'https://github.com/acme/web/blob/head-1/docs/decisions/seed-registry.md',
};

function chipFor(root: HTMLElement, key: string): Element {
  const chip = Array.from(root.querySelectorAll('.wi-chip')).find((el) =>
    el.querySelector('.wi-key')?.textContent?.includes(key),
  );
  expect(chip, `a chip for ${key}`).toBeTruthy();
  return chip!;
}

describe.each([
  ['a published page version (the page arm)', PAGE],
  ['a repository file (the resolved arm)', FILE],
])('the decision slot over %s (MOTIR-10020)', (_, document) => {
  it('draws a link to a live card as a live chip — key, title and status dot', () => {
    const { container } = renderWithIntl(<DecisionDocumentSlot document={document} />);
    const live = chipFor(container, 'MOTIR-706');
    expect(live.classList.contains('is-deleted')).toBe(false);
    expect(live.textContent).toContain('The seed registry');
    expect(live.querySelector('.wi-dot.s-done')).toBeTruthy();
  });

  it('still draws a link to a card that is really gone struck through', () => {
    const { container } = renderWithIntl(<DecisionDocumentSlot document={document} />);
    expect(chipFor(container, 'MOTIR-1').classList.contains('is-deleted')).toBe(true);
  });

  it('draws a card the reader cannot view as the no-access chip, with no title', () => {
    const { container } = renderWithIntl(<DecisionDocumentSlot document={document} />);
    const hidden = chipFor(container, 'MOTIR-42');
    expect(hidden.classList.contains('is-noaccess')).toBe(true);
    expect(hidden.classList.contains('is-deleted')).toBe(false);
  });
});
