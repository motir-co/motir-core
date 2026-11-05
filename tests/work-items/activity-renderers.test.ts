import { describe, expect, it } from 'vitest';
import {
  buildEntryParts,
  collectDiffRefs,
  dispositionFor,
  emptyDiffRefs,
  isDisplayableRevision,
  isRegisteredDiffKey,
  SUPPRESSED_DIFF_KEYS,
  type DisplayResolvers,
} from '@/lib/activity/renderers';

// Subtask 5.5.1 — the registry's DEFENSIVE branches, exercised as pure
// functions (renderers do no I/O by contract). A diff value is
// attacker-shaped here: it round-trips a JSON column and is written by call
// sites this module doesn't own, so every malformed shape must degrade to
// the generic part — never throw, never silently vanish (mistake #29). The
// happy paths over REAL service-produced diffs live in
// tests/integration/work-items/activity.test.ts; this file walks the
// fallback lattice the integration suite can't reach through real writes.

const resolvers: DisplayResolvers = {
  user: (id) => ({ type: 'user', userId: id, name: `user:${id}`, image: null }),
  status: (key) => ({ type: 'status', key, label: `label:${key}` }),
  sprint: (id) => ({ type: 'sprint', sprintId: id, name: `sprint:${id}` }),
  issue: (id) => ({ type: 'issue', workItemId: id, identifier: `PROD-${id}` }),
  folder: (id) => ({ type: 'text', text: `folder:${id}` }),
};

function parts(changeKind: string, diff: unknown) {
  return buildEntryParts(changeKind, diff, resolvers);
}

describe('anchors and non-object diffs', () => {
  it('created / archived render their anchor regardless of the diff', () => {
    expect(parts('created', { title: { from: null, to: 'X' } })).toEqual([{ kind: 'created' }]);
    expect(parts('archived', null)).toEqual([{ kind: 'archived' }]);
  });

  it('a non-object diff renders nothing and is not displayable', () => {
    expect(parts('updated', null)).toEqual([]);
    expect(parts('updated', [1, 2])).toEqual([]);
    expect(isDisplayableRevision('updated', 'scalar')).toBe(false);
    expect(isDisplayableRevision('updated', {})).toBe(false);
    expect(isDisplayableRevision('created', null)).toBe(true);
  });
});

describe('scalar / date / resolved fields — malformed cells', () => {
  it('a text field whose value is not a { from, to } cell degrades to generic', () => {
    expect(parts('updated', { title: 'plain' })).toEqual([
      { kind: 'generic', key: 'title', from: null, to: 'plain' },
    ]);
    // missing `to` → not a cell either
    expect(parts('updated', { priority: { from: 'low' } })).toEqual([
      { kind: 'generic', key: 'priority', from: null, to: '{"from":"low"}' },
    ]);
  });

  it('non-string scalars stringify; booleans and numbers included', () => {
    expect(parts('updated', { estimateMinutes: { from: false, to: 42 } })).toEqual([
      {
        kind: 'field',
        field: 'estimateMinutes',
        from: { type: 'text', text: 'false' },
        to: { type: 'text', text: '42' },
      },
    ]);
  });

  it('a date field tolerates a non-string present side and a non-cell value', () => {
    expect(parts('updated', { dueDate: { from: 123, to: '2026-01-01T00:00:00.000Z' } })).toEqual([
      {
        kind: 'field',
        field: 'dueDate',
        from: { type: 'text', text: '123' },
        to: { type: 'date', date: '2026-01-01T00:00:00.000Z' },
      },
    ]);
    expect(parts('updated', { archivedAt: 'oops' })).toEqual([
      { kind: 'generic', key: 'archivedAt', from: null, to: 'oops' },
    ]);
  });

  it('a resolved field renders non-string sides as text and non-cells as generic', () => {
    expect(parts('updated', { assigneeId: { from: 7, to: 'u1' } })).toEqual([
      {
        kind: 'field',
        field: 'assigneeId',
        from: { type: 'text', text: '7' },
        to: { type: 'user', userId: 'u1', name: 'user:u1', image: null },
      },
    ]);
    expect(parts('updated', { status: [1] })).toEqual([
      { kind: 'generic', key: 'status', from: null, to: '[1]' },
    ]);
  });

  it('bounds pathological values: long strings truncate, circular objects stringify safely', () => {
    const long = 'x'.repeat(300);
    const [longPart] = parts('updated', { title: { from: null, to: long } });
    expect(longPart).toMatchObject({ kind: 'field', to: { type: 'text' } });
    const text = (longPart as { to: { text: string } }).to.text;
    expect(text).toHaveLength(201);
    expect(text.endsWith('…')).toBe(true);

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(parts('updated', { frob: { from: circular, to: null } })).toEqual([
      { kind: 'generic', key: 'frob', from: '', to: null },
    ]);
  });
});

describe('links — malformed and partial shapes', () => {
  it('a non-record value and an array-less record degrade to generic', () => {
    expect(parts('updated', { links: 5 })).toEqual([
      { kind: 'generic', key: 'links', from: null, to: '5' },
    ]);
    expect(parts('updated', { links: {} })).toEqual([
      { kind: 'generic', key: 'links', from: null, to: '{}' },
    ]);
  });

  it('renders both added and removed; bad elements fall back per element', () => {
    expect(
      parts('updated', {
        links: {
          added: [{ toId: 'a', kind: 'duplicates' }, 'junk'],
          removed: [{ toId: 'b', kind: 99 }],
        },
      }),
    ).toEqual([
      {
        kind: 'link',
        op: 'added',
        linkKind: 'duplicates',
        target: { type: 'issue', workItemId: 'a', identifier: 'PROD-a' },
      },
      { kind: 'generic', key: 'links', from: null, to: 'junk' },
      {
        kind: 'link',
        op: 'removed',
        linkKind: 'relates_to', // non-string kind → the safe default
        target: { type: 'issue', workItemId: 'b', identifier: 'PROD-b' },
      },
    ]);
  });
});

describe('comment deletions — malformed shapes', () => {
  it('a cell without an authorId (or no cell at all) degrades to generic', () => {
    expect(parts('comment_deleted', { comment: { from: null, to: null } })).toEqual([
      { kind: 'generic', key: 'comment', from: null, to: null },
    ]);
    expect(parts('comment_deleted', { comment: 5 })).toEqual([
      { kind: 'generic', key: 'comment', from: null, to: '5' },
    ]);
  });

  it('a missing replyCount defaults to 0', () => {
    expect(parts('comment_deleted', { comment: { from: { authorId: 'u9' }, to: null } })).toEqual([
      {
        kind: 'commentDeleted',
        author: { type: 'user', userId: 'u9', name: 'user:u9', image: null },
        replyCount: 0,
      },
    ]);
  });
});

describe('collections — malformed shapes and label extraction', () => {
  it('non-records and empty add/remove arrays degrade to generic', () => {
    expect(parts('updated', { labels: 5 })).toEqual([
      { kind: 'generic', key: 'labels', from: null, to: '5' },
    ]);
    expect(parts('updated', { components: { added: [] } })).toEqual([
      { kind: 'generic', key: 'components', from: null, to: '{"added":[]}' },
    ]);
  });

  it('elements label by name/title/label, then the bounded string form', () => {
    expect(
      parts('updated', {
        attachments: {
          added: [{ name: 'spec.pdf' }, { title: 'T' }, { label: 'L' }, { other: 1 }, undefined],
        },
      }),
    ).toEqual([
      {
        kind: 'collection',
        field: 'attachments',
        op: 'added',
        items: ['spec.pdf', 'T', 'L', '{"other":1}', ''],
      },
    ]);
  });
});

describe('registry totality plumbing', () => {
  it('suppressed keys produce no parts and only they are skipped in mixed diffs', () => {
    const diff = {
      position: { from: 'a', to: 'b' },
      title: { from: 'A', to: 'B' },
    };
    expect(parts('updated', diff)).toEqual([
      {
        kind: 'field',
        field: 'title',
        from: { type: 'text', text: 'A' },
        to: { type: 'text', text: 'B' },
      },
    ]);
    for (const key of SUPPRESSED_DIFF_KEYS) {
      expect(dispositionFor(key).disposition).toBe('suppressed');
    }
  });

  it('prefix keys are registered; unknown keys are not (but still render)', () => {
    expect(isRegisteredDiffKey('customFields.severity')).toBe(true);
    expect(isRegisteredDiffKey('title')).toBe(true);
    expect(isRegisteredDiffKey('zzz-unknown')).toBe(false);
    expect(dispositionFor('zzz-unknown').disposition).toBe('renderable');
    expect(parts('updated', { 'customFields.sev': { from: null, to: 'High' } })).toEqual([
      {
        kind: 'field',
        field: 'customFields.sev',
        from: { type: 'none' },
        to: { type: 'text', text: 'High' },
      },
    ]);
  });

  it('collectDiffRefs gathers only renderable, well-formed refs and skips anchors', () => {
    const refs = emptyDiffRefs();
    collectDiffRefs('created', { assigneeId: { from: null, to: 'u1' } }, refs);
    expect(refs.users.size).toBe(0); // anchor kinds collect nothing

    collectDiffRefs('updated', null, refs);
    collectDiffRefs(
      'updated',
      {
        assigneeId: { from: 'u1', to: 7 },
        status: 'malformed',
        sprintId: { from: null, to: 's1' },
        parentId: { from: 'w1', to: 'w2' },
        links: { added: [{ toId: 'w3' }, 'junk'], removed: 'nope' },
        position: { from: 'a', to: 'b' },
      },
      refs,
    );
    collectDiffRefs('comment_deleted', { comment: { from: { authorId: 'u2' }, to: null } }, refs);
    collectDiffRefs('comment_deleted', { comment: { from: null, to: null } }, refs);

    expect([...refs.users].sort()).toEqual(['u1', 'u2']);
    expect([...refs.statuses]).toEqual([]); // malformed cell → nothing gathered
    expect([...refs.sprints]).toEqual(['s1']);
    expect([...refs.issues].sort()).toEqual(['w1', 'w2', 'w3']);
  });
});

// MOTIR-10338 — an agent verdict's snapshot, written beside its record.
describe('the agentVerdict snapshot', () => {
  const snapshot = {
    recordId: 'rec-1',
    verdict: 'changes_requested',
    outcome: 'decided',
    hosted: false,
    harness: 'Claude Code',
    model: 'claude-opus-5-5',
    subjectVersion: 'moooon/acme#1@abc',
    findingsExcerpt: 'The finding.',
    notifiedUserId: 'u-2',
  };

  it('renders a well-formed snapshot as one verdict part, resolving the notified person', () => {
    expect(parts('agent_verdict', { agentVerdict: { from: null, to: snapshot } })).toEqual([
      {
        kind: 'agentVerdict',
        recordId: 'rec-1',
        verdict: 'changes_requested',
        outcome: 'decided',
        hosted: false,
        harness: 'Claude Code',
        model: 'claude-opus-5-5',
        subjectVersion: 'moooon/acme#1@abc',
        findingsExcerpt: 'The finding.',
        notified: { type: 'user', userId: 'u-2', name: 'user:u-2', image: null },
      },
    ]);
    const refs = emptyDiffRefs();
    collectDiffRefs('agent_verdict', { agentVerdict: { from: null, to: snapshot } }, refs);
    expect([...refs.users]).toEqual(['u-2']);
  });

  it('missing optional fields read as empty, not as a crash', () => {
    const [part] = parts('agent_verdict', {
      agentVerdict: {
        from: null,
        to: { recordId: 'r', verdict: 'pass', outcome: 'late', subjectVersion: 'v' },
      },
    });
    expect(part).toMatchObject({
      kind: 'agentVerdict',
      hosted: false,
      harness: '',
      model: '',
      findingsExcerpt: null,
      notified: null,
    });
    const refs = emptyDiffRefs();
    collectDiffRefs('agent_verdict', { agentVerdict: { from: null, to: 'nope' } }, refs);
    expect(refs.users.size).toBe(0);
  });

  it.each([
    ['not an object', 'nope'],
    ['no record id', { ...snapshot, recordId: 7 }],
    ['an unknown verdict', { ...snapshot, verdict: 'maybe' }],
    ['an unknown outcome', { ...snapshot, outcome: 'eventually' }],
    ['no version', { ...snapshot, subjectVersion: null }],
  ])('a malformed snapshot (%s) degrades to the generic part', (_label, to) => {
    const [part] = parts('agent_verdict', { agentVerdict: { from: null, to } });
    expect(part?.kind).toBe('generic');
  });
});
