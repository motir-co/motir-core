import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { activityService } from '@/lib/services/activityService';
import { reviewFindingsService } from '@/lib/services/reviewFindingsService';
import { reviewVerdictRecordService } from '@/lib/services/reviewVerdictRecordService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { HOSTED_REVIEW_HARNESS } from '@/lib/agentReview/reviewState';
import { FINDINGS_EXCERPT_MAX } from '@/lib/agentReview/verdictActivity';
import { ReviewFindingsNotFoundError } from '@/lib/agentReview/errors';
import type { ActivityAgentVerdictPartDto } from '@/lib/dto/activity';
import type { ReviewChecklistRowDto, ReviewFindingsDto } from '@/lib/dto/agentReview';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';
import { setProjectAccess } from '../helpers/projectAccess';

// ONE REVIEW'S FINDINGS AND CHECKLIST, READ BACK (MOTIR-10460; `design/workbench/design-notes.md`
// § 42.1 *What it reads*, § 42.5), against REAL Postgres:
//
//   · a record reads WHOLE — its findings past the activity trail's cap, its stored checklist
//     rows with status and evidence, its submitter, harness and model, and its commits;
//   · a gate-only pass reads its note as the findings, the hosted agent, and no rows;
//   · a reader who cannot see the card — another workspace, or a members-only project they
//     are not in — gets the same 404 as a review that is not the card's;
//   · the card's Activity entry carries the record's stored rows, read from the record.
//
// The session is the one thing stubbed, for the route cases: a route test has no cookie jar.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

import { GET } from '@/app/api/work-items/[id]/review-findings/route';

const V1 =
  'moooon/acme#88@3f2a9c1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,moooon/api#41@9b07de4bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const ROWS: ReviewChecklistRowDto[] = [
  {
    key: 'PROD-1',
    criterion: 'Export downloads every invoice.',
    status: 'met',
    evidence: '`export.test.ts` covers it.',
  },
  {
    key: 'PROD-1',
    criterion: 'Amounts keep two decimals.',
    status: 'not_met',
    evidence: 'de-DE writes 1.234,50.',
  },
  {
    key: 'PROD-2',
    criterion: '50,000 rows in ten seconds.',
    status: 'cannot_tell',
    evidence: null,
  },
];

let fx: WorkItemFixture;

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "approval_gate", "work_item", "notification" RESTART IDENTITY CASCADE',
  );
  spyOnJobDispatch();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function card(f: WorkItemFixture = fx, title = 'Export the invoice list') {
  return workItemsService.createWorkItem({ projectId: f.projectId, kind: 'task', title }, f.ctx);
}

async function record(
  workItemId: string,
  opts: {
    findingsMd?: string | null;
    checklist?: unknown;
    hosted?: boolean;
    verdict?: 'pass' | 'changes_requested';
    version?: string;
  } = {},
  f: WorkItemFixture = fx,
) {
  return withWorkspaceContext(f.ctx, (tx) =>
    reviewVerdictRecordService.record(
      {
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        workItemId,
        gateId: null,
        subjectVersion: opts.version ?? V1,
        verdict: opts.verdict ?? 'pass',
        outcome: 'recorded',
        summaryMd: null,
        findingsMd: opts.findingsMd === undefined ? 'The export works.' : opts.findingsMd,
        checklist: (opts.checklist ?? ROWS) as never,
        submittedById: f.ownerId,
        harness: opts.hosted ? HOSTED_REVIEW_HARNESS : 'Claude Code',
        model: opts.hosted ? 'unknown' : 'claude-opus-5-5',
      },
      tx,
    ),
  );
}

async function agentGate(
  workItemId: string,
  state: 'approved' | 'changes_requested' | 'awaiting',
  kind: 'agent_review' | 'pull_request_approval' = 'agent_review',
) {
  const decidedAt = state === 'awaiting' ? null : new Date('2026-11-05T12:00:00Z');
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId,
      subjectId: workItemId,
      kind,
      state,
      subjectVersion: V1,
      noteMd: state === 'awaiting' ? null : '| Criterion | Result |\n|---|---|\n| Export | Met |',
      decidedAt,
      decidedUnderAuthority: state === 'awaiting' ? null : 'review_agent',
    },
  });
}

function call(key: string, query: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/work-items/${key}/review-findings${query}`), {
    params: Promise.resolve({ id: key }),
  });
}

describe('reviewFindingsService.read — a verdict record', () => {
  it('reads the record whole: every row, the whole findings, who and at which commits', async () => {
    const item = await card();
    const long = `${'A finding. '.repeat(Math.ceil(FINDINGS_EXCERPT_MAX / 11) + 50)}THE END`;
    const rec = await record(item.id, { findingsMd: long });

    const read = await reviewFindingsService.read(
      fx.projectId,
      item.identifier,
      { kind: 'record', id: rec.id },
      fx.ctx,
    );
    expect(read).toMatchObject({
      identifier: item.identifier,
      title: 'Export the invoice list',
      ref: { kind: 'record', id: rec.id },
      verdict: 'pass',
      reviewer: {
        kind: 'own',
        name: fx.owner.name,
        harness: 'Claude Code',
        model: 'claude-opus-5-5',
      },
      subjectVersion: V1,
      commits: [
        { repo: 'moooon/acme', number: 88, headSha: expect.stringMatching(/^3f2a9c1/) },
        { repo: 'moooon/api', number: 41, headSha: expect.stringMatching(/^9b07de4/) },
      ],
      checklist: ROWS,
      findingsRefs: {},
    });
    // NOT the capped excerpt the activity trail keeps.
    expect(read.findingsMd).toBe(long);
    expect(read.findingsMd!.length).toBeGreaterThan(FINDINGS_EXCERPT_MAX);
    expect(new Date(read.at).getTime()).toBe(rec.createdAt.getTime());
  });

  it('a hosted send-back with no findings text and malformed rows reads what is sound', async () => {
    const item = await card();
    const rec = await record(item.id, {
      hosted: true,
      verdict: 'changes_requested',
      findingsMd: '   ',
      checklist: [ROWS[0], { criterion: 'no status' }, 'nope', { criterion: ' ', status: 'met' }],
    });
    const read = await reviewFindingsService.read(
      fx.projectId,
      item.identifier,
      { kind: 'record', id: rec.id },
      fx.ctx,
    );
    expect(read.verdict).toBe('changes_requested');
    expect(read.reviewer).toEqual({ kind: 'hosted', model: null });
    expect(read.findingsMd).toBeNull();
    expect(read.checklist).toEqual([ROWS[0]]);
  });

  it('a submitter who has gone reads as a nameless own agent', async () => {
    const item = await card();
    const rec = await record(item.id);
    await adminDb.reviewVerdictRecord.update({
      where: { id: rec.id },
      data: { submittedById: null },
    });
    const read = await reviewFindingsService.read(
      fx.projectId,
      item.identifier,
      { kind: 'record', id: rec.id },
      fx.ctx,
    );
    expect(read.reviewer).toEqual({
      kind: 'own',
      name: null,
      harness: 'Claude Code',
      model: 'claude-opus-5-5',
    });
  });

  it('a record of ANOTHER card is not this card’s review', async () => {
    const mine = await card();
    const other = await card(fx, 'Another card');
    const rec = await record(other.id);
    await expect(
      reviewFindingsService.read(
        fx.projectId,
        mine.identifier,
        { kind: 'record', id: rec.id },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ReviewFindingsNotFoundError);
  });
});

describe('reviewFindingsService.read — a gate-only pass', () => {
  it('reads the gate’s note as the findings, the hosted agent, and no rows', async () => {
    const item = await card();
    const gate = await agentGate(item.id, 'approved');
    const read = await reviewFindingsService.read(
      fx.projectId,
      item.identifier,
      { kind: 'gate', id: gate.id },
      fx.ctx,
    );
    expect(read).toMatchObject({
      ref: { kind: 'gate', id: gate.id },
      verdict: 'pass',
      reviewer: { kind: 'hosted', model: null },
      at: '2026-11-05T12:00:00.000Z',
      subjectVersion: V1,
      checklist: [],
    });
    expect(read.findingsMd).toContain('| Export | Met |');
    expect(read.commits).toHaveLength(2);
  });

  it('a sent-back gate reads as Asked for changes', async () => {
    const item = await card();
    const gate = await agentGate(item.id, 'changes_requested');
    const read = await reviewFindingsService.read(
      fx.projectId,
      item.identifier,
      { kind: 'gate', id: gate.id },
      fx.ctx,
    );
    expect(read.verdict).toBe('changes_requested');
  });

  it.each([
    ['an undecided review gate', 'awaiting', 'agent_review'],
    ['a gate of another kind', 'approved', 'pull_request_approval'],
  ] as const)('%s is no review to read', async (_label, state, kind) => {
    const item = await card();
    const gate = await agentGate(item.id, state, kind);
    await expect(
      reviewFindingsService.read(
        fx.projectId,
        item.identifier,
        { kind: 'gate', id: gate.id },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ReviewFindingsNotFoundError);
  });

  it('a gate of another card is not this card’s review', async () => {
    const mine = await card();
    const other = await card(fx, 'Another card');
    const gate = await agentGate(other.id, 'approved');
    await expect(
      reviewFindingsService.read(
        fx.projectId,
        mine.identifier,
        { kind: 'gate', id: gate.id },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(ReviewFindingsNotFoundError);
  });
});

describe('GET /api/work-items/[id]/review-findings', () => {
  it('200 — the review, never cached', async () => {
    const item = await card();
    const rec = await record(item.id);
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
    const res = await call(item.identifier, `?kind=record&id=${rec.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as ReviewFindingsDto;
    expect(body.checklist).toEqual(ROWS);
    expect(body.findingsMd).toBe('The export works.');
  });

  it('422 for a missing or unknown kind, or no id', async () => {
    const item = await card();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
    for (const q of ['', '?kind=record', '?kind=nope&id=x', '?kind=gate&id=%20']) {
      const res = await call(item.identifier, q);
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('INVALID_QUERY');
    }
  });

  it('the session gate’s own refusal is returned as it is', async () => {
    requireCompliantWorkspaceContext.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    expect((await call('PROD-1', '?kind=record&id=x')).status).toBe(401);
  });

  it('404 — the same answer for an unknown review, another card’s, another workspace, and a card the reader cannot browse', async () => {
    const item = await card();
    const rec = await record(item.id);
    const other = await card(fx, 'Another card');

    // Another workspace: a member there who asks for this card's review by its key.
    const elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'PROD' });
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: elsewhere.ctx });
    const cross = await call(item.identifier, `?kind=record&id=${rec.id}`);

    // Same workspace, a members-only project the reader is not in.
    const outsider = await createTestUser({ email: 'out@ex.com', name: 'Out Sider' });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: fx.workspaceId });
    await setProjectAccess(adminDb, fx.projectId, 'members');
    requireCompliantWorkspaceContext.mockResolvedValue({
      ok: true,
      ctx: { userId: outsider.id, workspaceId: fx.workspaceId },
    });
    const hidden = await call(item.identifier, `?kind=record&id=${rec.id}`);

    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
    const unknown = await call(item.identifier, '?kind=record&id=cnorecord0000000000000000');
    const wrongCard = await call(other.identifier, `?kind=record&id=${rec.id}`);
    const noProject = await call('NOPE-1', `?kind=record&id=${rec.id}`);

    for (const res of [cross, hidden, unknown, wrongCard, noProject]) {
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ code: 'REVIEW_FINDINGS_NOT_FOUND', error: 'Not found.' });
    }
  });
});

describe('the Activity entry carries the stored checklist rows', () => {
  it('reads the rows from the record; a record with none carries none', async () => {
    const item = await card();
    const withRows = await record(item.id);
    const without = await record(item.id, { checklist: [], version: 'moooon/acme#88@cccc' });

    const page = await activityService.listHistory(item.id, {}, fx.ctx);
    const parts = page.entries
      .flatMap((e) => e.parts)
      .filter((p): p is ActivityAgentVerdictPartDto => p.kind === 'agentVerdict');
    const byId = new Map(parts.map((p) => [p.recordId, p]));
    expect(byId.get(withRows.id)?.checklist).toEqual(ROWS);
    expect(byId.get(without.id)?.checklist).toEqual([]);
  });

  it('a snapshot naming another card’s record shows no rows', async () => {
    const item = await card();
    const other = await card(fx, 'Another card');
    const theirs = await record(other.id);
    const mine = await record(item.id);
    // Point my trail entry at the other card's record — the read holds rows to the card.
    const revision = await adminDb.workItemRevision.findFirstOrThrow({
      where: { workItemId: item.id, changeKind: 'agent_verdict' },
    });
    const diff = revision.diff as { agentVerdict: { from: null; to: Record<string, unknown> } };
    await adminDb.workItemRevision.update({
      where: { id: revision.id },
      data: {
        diff: {
          agentVerdict: { from: null, to: { ...diff.agentVerdict.to, recordId: theirs.id } },
        },
      },
    });
    const page = await activityService.listHistory(item.id, {}, fx.ctx);
    const part = page.entries
      .flatMap((e) => e.parts)
      .find((p): p is ActivityAgentVerdictPartDto => p.kind === 'agentVerdict');
    expect(part?.recordId).toBe(theirs.id);
    expect(part?.checklist).toEqual([]);
    expect(mine.id).not.toBe(theirs.id);
  });
});
