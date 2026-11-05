// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { ActivityEntryRow } from '@/app/(authed)/items/[key]/_components/ActivityEntryRow';
import {
  REGISTERED_DIFF_KEYS,
  buildEntryParts,
  type DisplayResolvers,
} from '@/lib/activity/renderers';
import type { ActivityEntryDto, ActivityEntryPartDto } from '@/lib/dto/activity';

// The History row NAMES the field that changed (MOTIR-6113). `ActivityEntryRow`
// resolves a part's field through a hand-written key → message map, and a key
// missing from it rendered the raw diff key — "Mo changed the executor",
// "changed the targetRepo" — while the localized strings sat unread in the
// catalog. The map is written by hand beside the renderer REGISTRY, so this file
// holds it to that registry: every registered key whose row carries a field name
// must render a catalog label, in both locales.

afterEach(cleanup);

const resolvers: DisplayResolvers = {
  user: (id) => ({ type: 'user', userId: id, name: 'Ann', image: null }),
  status: (key) => ({ type: 'text', text: key }),
  sprint: (id) => ({ type: 'sprint', sprintId: id, name: 'Sprint 4' }),
  issue: (id) => ({ type: 'issue', workItemId: id, identifier: 'MOTIR-2' }),
  folder: (id) => ({ type: 'text', text: id }),
  reviewChecklist: () => [],
};

/** A diff value of the shape the key's renderer reads. */
function sampleValue(key: string): unknown {
  if (['todos', 'attachments', 'labels', 'components'].includes(key)) {
    return { added: [{ name: 'one' }] };
  }
  // The hand-made page links (MOTIR-9197): `{ pageId, title }` per element.
  if (key === 'pageLinks') return { added: [{ pageId: 'p1', title: 'Runbook' }] };
  if (key === 'links') return { added: [{ toId: 'w2', kind: 'blocks' }] };
  return { from: 'a', to: 'b' };
}

/** Parts whose sentence carries a field NAME. `sprintId` reads "moved this work
 * item to Sprint 4" and `attachments` "attached one" — neither names a field. */
function namedFieldParts(key: string): ActivityEntryPartDto[] {
  return buildEntryParts('updated', { [key]: sampleValue(key) }, resolvers).filter(
    (p) =>
      (p.kind === 'field' || p.kind === 'fieldEdited' || p.kind === 'collection') &&
      p.field !== 'sprintId' &&
      p.field !== 'attachments',
  );
}

function entryFor(part: ActivityEntryPartDto): ActivityEntryDto {
  return {
    id: 'r1',
    workItemId: 'w1',
    changeKind: 'updated',
    changedAt: '2026-09-23T10:00:00.000Z',
    actor: { userId: 'u1', name: 'Mo', image: null },
    parts: [part],
  };
}

/** The sentence's field chunk: the first medium-weight span (the actor is
 * semibold, and the value line renders below the sentence). */
function renderedFieldName(part: ActivityEntryPartDto, messages: Record<string, unknown>) {
  const { container } = renderWithIntl(
    <ActivityEntryRow entry={entryFor(part)} part={part} statusCategories={{}} />,
    { messages, locale: messages === enMessages ? 'en' : 'zh' },
  );
  const text = container.querySelector('span.font-medium')?.textContent ?? '';
  cleanup();
  return text;
}

describe('ActivityEntryRow — the changed field is named by its label (MOTIR-6113)', () => {
  it.each([
    ['type', 'Work type', '工作类型'],
    ['executor', 'Executor', '执行者'],
    ['targetRepo', 'Target repo', '目标仓库'],
    ['targetRepos', 'Repositories', '仓库'],
    ['folderId', 'Folder', '文件夹'],
    ['todos', 'Step', '步骤'],
    // The hand-made page links (MOTIR-9197).
    ['pageLinks', 'Page', '页面'],
    // The obsolescence mark and its note (MOTIR-6579).
    ['obsolescence', 'Obsolescence', '失效状态'],
    ['obsolescenceNoteMd', 'Obsolescence note', '失效说明'],
  ])('%s reads "%s" / "%s", never the diff key', (key, en, zh) => {
    const [part] = namedFieldParts(key);
    expect(part).toBeDefined();
    expect(renderedFieldName(part!, enMessages)).toBe(en);
    expect(renderedFieldName(part!, zhMessages)).toBe(zh);
  });

  it('a hand-linked page reads as one collection part naming the page title', () => {
    const parts = buildEntryParts(
      'updated',
      { pageLinks: { added: [{ pageId: 'p1', title: 'Runbook' }] } },
      resolvers,
    );
    expect(parts).toEqual([
      { kind: 'collection', field: 'pageLinks', op: 'added', items: ['Runbook'] },
    ]);
  });

  it('fields that were already named are unchanged', () => {
    const [points] = namedFieldParts('storyPoints');
    const [labels] = namedFieldParts('labels');
    expect(renderedFieldName(points!, enMessages)).toBe('Story points');
    expect(renderedFieldName(labels!, enMessages)).toBe('Label');
    expect(renderedFieldName(labels!, zhMessages)).toBe('标签');
  });

  it('every registered key whose row names a field renders a catalog label in en and zh', () => {
    const unnamed: string[] = [];
    for (const key of REGISTERED_DIFF_KEYS) {
      for (const part of namedFieldParts(key)) {
        const en = renderedFieldName(part, enMessages);
        const zh = renderedFieldName(part, zhMessages);
        // A raw key fails both: it is the key verbatim in en, and Latin in zh.
        if (!en || en === key || !zh || /[A-Za-z]/.test(zh))
          unnamed.push(`${key} (en "${en}", zh "${zh}")`);
      }
    }
    expect(unnamed).toEqual([]);
  });
});
