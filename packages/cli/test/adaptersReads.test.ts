import { describe, expect, it } from 'vitest';
import {
  toActivityAllPage,
  toDispatchRunView,
  toActivityHistoryPage,
  toCommentsPage,
  toProjectList,
  toScopeClaim,
  toWhoami,
  toWorkItemRepairClaim,
} from '../src/adapters/reads.js';

// The READ ADAPTERS as pure functions (Subtask 11.5.4 — MOTIR-2212).
//
// `clientCore.test.ts` drives these through a real socket, which is what proves
// they are wired to the right operations. These are the cases a round trip
// cannot reach: shapes the generated types admit but a healthy server never
// sends, where the question is whether the mapper degrades or throws.

const ME = {
  user: { id: 'u1', name: 'Zhu Yue', email: 'yue@motir.test' },
  workspaceId: 'ws-1',
  permissions: ['project:browse'],
};

describe('the paged-body fallback', () => {
  it('treats an ABSENT `items` as an empty page rather than throwing', () => {
    // The generated envelope types `items` as optional because the page envelope
    // and the item schema compose through `allOf` — so the type admits a body
    // the transport's validator would in fact reject. A mapper that assumed the
    // array would crash on a shape its own signature says is legal.
    expect(toProjectList([{ nextCursor: null } as never])).toEqual({ projects: [] });
    expect(toWhoami(ME, { nextCursor: null } as never)).toMatchObject({ workspace: null });
  });

  it('assembles across pages in the order they were walked', () => {
    const page = (key: string, nextCursor: string | null) => ({
      items: [{ key, name: key, accessLevel: 'open', accessMode: 'workspace', archived: false }],
      nextCursor,
    });
    expect(toProjectList([page('AAA', 'c1'), page('BBB', null)] as never).projects).toEqual([
      { key: 'AAA', name: 'AAA', accessLevel: 'open' },
      { key: 'BBB', name: 'BBB', accessLevel: 'open' },
    ]);
  });
});

describe('the activity reshape', () => {
  const change = (parts: unknown[]) => ({
    type: 'change',
    change: {
      id: 'r1',
      changeKind: 'updated',
      changedAt: '2026-08-01T12:00:00.000Z',
      actor: { userId: 'u2', name: 'Mo' },
      parts,
    },
  });
  const page = (items: unknown[], over: Record<string, unknown> = {}) =>
    ({
      items,
      nextCursor: null,
      totalCount: items.length,
      totalComments: 0,
      totalChanges: 0,
      ...over,
    }) as never;

  it('maps every VALUE type, renaming the issue reference to `identifier`', () => {
    const parts = [
      { kind: 'field', field: 'a', from: { type: 'none' }, to: { type: 'text', text: 'hi' } },
      {
        kind: 'field',
        field: 'b',
        from: { type: 'status', key: 'todo', label: 'To Do' },
        to: { type: 'user', userId: 'u1', name: 'Yue' },
      },
      {
        kind: 'field',
        field: 'c',
        from: { type: 'date', date: '2026-01-01' },
        to: { type: 'sprint', sprintId: 's1', name: 'One' },
      },
      {
        kind: 'field',
        field: 'd',
        from: { type: 'issue', workItemKey: 'PROD-9' },
        to: { type: 'none' },
      },
    ];

    const [entry] = toActivityAllPage(page([change(parts)])).entries;
    const mapped = entry?.type === 'history' ? entry.entry.parts : [];

    // The one RENAME the wire forces: `workItemKey` is what v1 publishes,
    // `identifier` is what `render.ts`'s value renderer reads.
    expect(mapped[3]?.from).toEqual({ type: 'issue', identifier: 'PROD-9' });
    expect(mapped[0]?.to).toEqual({ type: 'text', text: 'hi' });
    expect(mapped[1]?.from).toEqual({ type: 'status', key: 'todo', label: 'To Do' });
    expect(mapped[1]?.to).toEqual({ type: 'user', userId: 'u1', name: 'Yue' });
    expect(mapped[2]?.to).toEqual({ type: 'sprint', sprintId: 's1', name: 'One' });
  });

  it('maps every PART kind, including the ones that carry only their kind', () => {
    const parts = [
      { kind: 'created' },
      { kind: 'fieldEdited', field: 'descriptionMd' },
      {
        kind: 'link',
        op: 'added',
        linkKind: 'blocks',
        target: { type: 'issue', workItemKey: 'P-1' },
      },
      { kind: 'collection', field: 'labels', op: 'removed', items: ['bug'] },
      {
        kind: 'commentDeleted',
        author: { type: 'user', userId: 'u1', name: 'Yue' },
        replyCount: 2,
      },
      { kind: 'generic', key: 'x', from: null, to: 'y' },
    ];

    const [entry] = toActivityAllPage(page([change(parts)])).entries;
    const mapped = entry?.type === 'history' ? entry.entry.parts : [];

    expect(mapped.map((p) => p.kind)).toEqual([
      'created',
      'fieldEdited',
      'link',
      'collection',
      'commentDeleted',
      'generic',
    ]);
    expect(mapped[2]?.target).toEqual({ type: 'issue', identifier: 'P-1' });
    expect(mapped[3]?.items).toEqual(['bug']);
    expect(mapped[4]?.replyCount).toBe(2);
    expect(mapped[5]).toEqual({ kind: 'generic', key: 'x', from: null, to: 'y' });
  });

  it('splits the three VIEWS, and echoes the order the caller asked for', () => {
    const comment = {
      type: 'comment',
      comment: {
        id: 'c1',
        parentCommentId: null,
        authorId: 'u1',
        author: { id: 'u1', name: 'Yue' },
        bodyMd: 'body',
        createdAt: '2026-07-30T12:00:00.000Z',
        editedAt: null,
        mentionedUserIds: [],
        replies: [
          {
            id: 'c2',
            parentCommentId: 'c1',
            authorId: 'u1',
            author: { id: 'u1', name: 'Yue' },
            bodyMd: 'reply',
            createdAt: '2026-07-30T12:01:00.000Z',
            editedAt: null,
            mentionedUserIds: [],
          },
        ],
      },
    };
    const body = page([comment, change([{ kind: 'created' }])], {
      totalComments: 1,
      totalChanges: 1,
    });

    expect(toActivityAllPage(body).entries.map((e) => e.type)).toEqual(['comment', 'history']);
    expect(toActivityAllPage(body)).toMatchObject({ totalComments: 1, totalChanges: 1 });

    // The comments view keeps only comments, and reports the direction the CLI
    // itself requested — `order` is not on the wire.
    const comments = toCommentsPage(body, 'desc');
    expect(comments.threads).toHaveLength(1);
    expect(comments.threads[0]?.replies).toHaveLength(1);
    expect(comments.order).toBe('desc');

    // The history view keeps only changes.
    expect(toActivityHistoryPage(body).entries).toHaveLength(1);
  });

  it('reports ZERO for a per-source total the narrow views do not compute', () => {
    // The wire sends null there — "this view did not count that source" — and
    // the `all` page's footer arithmetic needs a number.
    const body = page([], { totalComments: null, totalChanges: null });
    expect(toActivityAllPage(body)).toMatchObject({ totalComments: 0, totalChanges: 0 });
  });
});

describe('toScopeClaim — the SCOPE claim result (MOTIR-3049)', () => {
  const base = {
    scope: { kind: 'work_item' as const, key: 'PROD-1', sprintId: null, name: 'The story' },
    outcome: 'claimed' as const,
    claimed: true,
    members: [] as never[],
    offender: null,
    shape: null,
    blockers: [] as never[],
  };

  it('re-states every array element by element, never passing a row through', () => {
    // The mapper exists so a field the server adds later cannot arrive in the
    // view model without somebody deciding it should. That is only true if it
    // BUILDS each element rather than spreading it — asserted by handing it a
    // row with an extra field and reading the result back.
    const claim = toScopeClaim({
      ...base,
      members: [
        {
          key: 'PROD-2',
          title: 'Item two',
          status: { key: 'in_progress', category: 'in_progress' },
          surprise: 'should not survive',
        },
      ],
      blockers: [
        {
          item: 'PROD-2',
          blockedBy: 'PROD-99',
          blockerStatus: 'todo',
          blockerSprintId: null,
          surprise: 'nor this',
        },
      ],
    } as never);

    expect(claim.members).toEqual([
      { key: 'PROD-2', title: 'Item two', status: { key: 'in_progress', category: 'in_progress' } },
    ]);
    expect(claim.blockers).toEqual([
      { item: 'PROD-2', blockedBy: 'PROD-99', blockerStatus: 'todo', blockerSprintId: null },
    ]);
  });

  it('maps the OFFENDER’s two nullable actors independently', () => {
    // The MOTIR-2958 shape: a sibling flipped the status without assigning, so
    // `assignee` is null while `transitionedBy` is the only witness. Collapsing
    // the two nullable arms into one would lose the holder's name in exactly
    // the case the field exists for.
    const named = toScopeClaim({
      ...base,
      outcome: 'taken',
      claimed: false,
      offender: {
        key: 'PROD-2',
        title: 'Held',
        status: { key: 'in_progress', category: 'in_progress' },
        assignee: null,
        transitionedBy: { id: 'u2', name: 'Rival' },
        transitionedAt: '2026-08-20T10:00:00.000Z',
      },
    } as never);
    expect(named.offender).toEqual({
      key: 'PROD-2',
      title: 'Held',
      status: { key: 'in_progress', category: 'in_progress' },
      assignee: null,
      transitionedBy: { id: 'u2', name: 'Rival' },
      transitionedAt: '2026-08-20T10:00:00.000Z',
    });

    const assigned = toScopeClaim({
      ...base,
      outcome: 'taken',
      claimed: false,
      offender: {
        key: 'PROD-2',
        title: 'Held',
        status: { key: 'in_progress', category: null },
        assignee: { id: 'u3', name: 'Owner' },
        transitionedBy: null,
        transitionedAt: null,
      },
    } as never);
    expect(assigned.offender?.assignee).toEqual({ id: 'u3', name: 'Owner' });
    expect(assigned.offender?.transitionedBy).toBeNull();
  });

  it('maps the `wrong_shape` detail, and leaves it null on every other outcome', () => {
    const shaped = toScopeClaim({
      ...base,
      outcome: 'wrong_shape',
      claimed: false,
      shape: { child: 'PROD-5', childTitle: 'A container', depth: 2 },
    } as never);
    expect(shaped.shape).toEqual({ child: 'PROD-5', childTitle: 'A container', depth: 2 });
    expect(toScopeClaim(base as never).shape).toBeNull();
    expect(toScopeClaim(base as never).offender).toBeNull();
  });

  it('carries a SPRINT scope’s null key and its sprint id', () => {
    const claim = toScopeClaim({
      ...base,
      scope: { kind: 'sprint', key: null, sprintId: 's1', name: 'Sprint 44' },
    } as never);
    expect(claim.scope).toEqual({ kind: 'sprint', key: null, sprintId: 's1', name: 'Sprint 44' });
  });
});

describe('toWorkItemRepairClaim — the acceptance Re-run class (MOTIR-6502)', () => {
  const base = {
    key: 'PROD-60',
    title: 'Exports list',
    outcome: 'claimed' as const,
    reason: null,
    runTargetKey: null,
    runId: 'run_fix_1',
    holder: { id: 'u1', name: 'Zhu Yue' },
    startedAt: '2026-09-26T10:00:00.000Z',
    pullRequests: [] as never[],
  };

  it('carries the Re-run class and the reviewer’s refusal through, field by field', () => {
    const claim = toWorkItemRepairClaim({
      ...base,
      repairClass: 'acceptance_rerun',
      acceptanceRefusal: {
        reasonMd: 'The empty board should say how to add the first card.',
        decidedByLabel: 'Zhu Yue',
        decidedAt: '2026-09-26T10:00:00.000Z',
        surprise: 'should not survive',
      },
    } as never);

    expect(claim.repairClass).toBe('acceptance_rerun');
    expect(claim.acceptanceRefusal).toEqual({
      reasonMd: 'The empty board should say how to add the first card.',
      decidedByLabel: 'Zhu Yue',
      decidedAt: '2026-09-26T10:00:00.000Z',
    });
  });

  it('a server older than contract 1.43.0 sends neither field — every repair it hands over is a CI one', () => {
    const claim = toWorkItemRepairClaim(base as never);

    expect(claim.repairClass).toBe('ci');
    expect(claim.acceptanceRefusal).toBeNull();
    expect(claim.reviewRefusal).toBeNull();
  });

  it('carries the REVIEW class and its findings through, field by field (MOTIR-6822)', () => {
    const claim = toWorkItemRepairClaim({
      ...base,
      repairClass: 'review',
      acceptanceRefusal: null,
      reviewRefusal: {
        gate: 'agent_review',
        findingsMd: '1. The route has no tenant check.\n2. The empty list drops its header.',
        reviewerName: 'Review agent',
        decidedAt: '2026-09-29T10:00:00.000Z',
        surprise: 'should not survive',
      },
    } as never);

    expect(claim.repairClass).toBe('review');
    expect(claim.reviewRefusal).toEqual({
      gate: 'agent_review',
      findingsMd: '1. The route has no tenant check.\n2. The empty list drops its header.',
      reviewerName: 'Review agent',
      decidedAt: '2026-09-29T10:00:00.000Z',
    });
  });
});

describe('toWorkItemRepairClaim — a member handed over for its BASE (Bug MOTIR-12095)', () => {
  const member = {
    repo: 'acme/motir-core',
    number: 131,
    url: 'https://github.com/acme/motir-core/pull/131',
    headRef: 'subtask/PROD-7-thing',
    baseRef: 'main',
    ci: 'passing' as const,
    failingChecks: [] as string[],
    queueExit: null,
  };
  const body = (pullRequests: unknown[]) =>
    ({
      key: 'PROD-7',
      title: 'Add the thing',
      outcome: 'claimed',
      reason: null,
      runTargetKey: null,
      runId: 'run_fix_1',
      holder: null,
      startedAt: null,
      repairClass: 'ci',
      acceptanceRefusal: null,
      reviewRefusal: null,
      pullRequests,
    }) as never;

  it('carries `conflicted` and `outOfDate` through as the server sends them', () => {
    const claim = toWorkItemRepairClaim(
      body([
        { ...member, conflicted: true, outOfDate: false },
        { ...member, number: 132, conflicted: false, outOfDate: true },
      ]),
    );
    expect(claim.pullRequests.map((pr) => [pr.conflicted, pr.outOfDate])).toEqual([
      [true, false],
      [false, true],
    ]);
  });
});

describe('toDispatchRunView — an adopted hosted REPAIR run (MOTIR-6929)', () => {
  const base = {
    id: 'run-fix',
    status: 'running',
    command: 'fix',
    origin: 'hosted',
    model: 'claude-opus-5-5',
    endedAt: null,
    cards: [{ key: 'ACME-12', position: 1, disposition: 'running' }],
    continues: null,
  };
  const pr = {
    repo: 'acme/web',
    number: 7,
    url: 'https://github.com/acme/web/pull/7',
    branch: 'acme-12-fix',
    baseRef: 'main',
    headSha: 'abc123',
    conflicted: false,
    outOfDate: false,
  };

  it('carries each pull request’s recorded mergeability — why a green one was handed over (Bug MOTIR-12096)', () => {
    const stale = [
      { ...pr, number: 8, branch: 'behind', outOfDate: true },
      { ...pr, number: 9, branch: 'dirty', conflicted: true },
    ];
    const view = toDispatchRunView({
      ...base,
      repair: { repairClass: 'ci', title: 'Export button', pullRequests: stale, findings: null },
    } as never);
    expect(view.repair?.pullRequests.map((p) => [p.branch, p.conflicted, p.outOfDate])).toEqual([
      ['behind', false, true],
      ['dirty', true, false],
    ]);
  });

  it('maps the repair the claim decided — its class, pull requests and findings', () => {
    const findings = {
      gate: 'agent_review',
      gateId: 'g1',
      subjectVersion: 'acme/web#7@abc123',
      findingsMd: 'Handle the empty list.',
      reviewerName: 'Review agent',
    };
    const view = toDispatchRunView({
      ...base,
      repair: { repairClass: 'review', title: 'Export button', pullRequests: [pr], findings },
    } as never);
    expect(view.repair).toEqual({
      repairClass: 'review',
      title: 'Export button',
      pullRequests: [pr],
      findings,
      // A server that records no resume reads as none (MOTIR-9052).
      resume: null,
    });
  });

  it('carries the recorded resume — the agent’s profile, session and whether it can resume', () => {
    const resume = { profile: 'claude', sessionId: 's-1', canResume: true };
    const view = toDispatchRunView({
      ...base,
      repair: { repairClass: 'review', title: 'Export button', pullRequests: [pr], resume },
    } as never);
    expect(view.repair?.resume).toEqual(resume);
  });

  it('carries a repair recorded WITHOUT findings as null findings, never throwing', () => {
    const view = toDispatchRunView({
      ...base,
      repair: { repairClass: 'review', title: 'Export button', pullRequests: [pr], findings: null },
    } as never);
    expect(view.repair?.findings).toBeNull();
    expect(view.repair?.pullRequests).toEqual([pr]);
  });

  it('reads a server older than contract 1.59.0 — no `repair` at all — as null', () => {
    expect(toDispatchRunView(base as never).repair).toBeNull();
  });
});

describe('toDispatchRunView — a review run’s target (MOTIR-11953, contract 1.89.0)', () => {
  const base = {
    id: 'run-review',
    status: 'running',
    command: 'review',
    origin: 'instance',
    model: null,
    endedAt: null,
    cards: [{ key: 'ACME-12', position: 0, disposition: 'running' }],
    continues: null,
    repair: null,
  };

  it('maps the gate and version the run was opened for, a null gate included', () => {
    const review = { gateId: 'g1', subjectVersion: 'acme/web#7@abc123' };
    expect(toDispatchRunView({ ...base, review } as never).review).toEqual(review);
    expect(
      toDispatchRunView({ ...base, review: { ...review, gateId: null } } as never).review,
    ).toEqual({ ...review, gateId: null });
  });

  it('reads a server older than 1.89.0 — no `review` — as null', () => {
    expect(toDispatchRunView(base as never).review).toBeNull();
  });
});
