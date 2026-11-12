import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { ProjectContext } from '@/lib/projects';
import { triageService } from '@/lib/services/triageService';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardsService } from '@/lib/services/boardsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A TRIAGE BUG IS A CONVERSATION TARGET (Story MOTIR-7042 · MOTIR-7047 —
// `docs/decisions/conversation-turn-intent.md` AMENDMENT 1, A1.2), against a REAL
// Postgres and under the access policy these reads actually run under: `@/lib/db`
// connects as the NON-BYPASS app role (`motir_app`, asserted below), so every
// `withWorkspaceServiceContext` read here is subject to the same row policies
// production's is. Fixtures write through `adminDb`; the code under test does not.
//
// The claim A1.2 makes, and this file proves rather than restates: the KEYED
// read a conversation anchor resolves through (`getWorkItemWithAncestors` /
// `getWorkItemByIdentifier`) already includes triage rows — only LIST reads
// exclude them — so no new repository read was added. And anchoring one does not
// relax the exclusion anywhere else: the same key stays out of `/items` and the
// board.
//
// Only `getSession` / `getActiveProject` and the motir-ai HTTP boundary are mocked.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'job-1' }));
const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: (...args: unknown[]) => getJobMock(...(args as [])),
  streamJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { GET: planningAnchor } = await import('@/app/api/work-items/planning-anchor/route');
const { POST: ask } = await import('@/app/api/ai/ask/route');
const { POST: settle } = await import('@/app/api/ai/ask/settle/route');

const BASE = 'http://localhost:3000';
const anchorReq = (key: string) =>
  new Request(`${BASE}/api/work-items/planning-anchor?key=${encodeURIComponent(key)}`);
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

let fx: WorkItemFixture;
/** The triage bug under test — reported through the SHIPPED intake. */
let triaged: { id: string; identifier: string };
/** Its normal twin, the control every list read must still show. */
let normal: { id: string; identifier: string };

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockReset();
  let n = 0;
  submitJobMock.mockImplementation(async (...args: unknown[]) => ({
    jobId: `job-${String(args[0])}-${++n}`,
  }));
  getJobMock.mockReset();
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'test-service-token');

  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
  // Through the SERVICE, as the triage intake is, so the twins differ ONLY by the
  // triage marker (same kind, same initial workflow status, no parent).
  normal = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'bug',
      title: 'Export hangs (planned)',
      parentId: null,
      descriptionMd: null,
    },
    fx.ctx,
  );
  triaged = await triageService.createSubmission(
    {
      projectKey: fx.projectIdentifier,
      kind: 'bug',
      title: 'Saving a comment drops the mention',
      descriptionMd: 'Type @someone, save — the mention is gone.',
    },
    fx.ctx,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the substrate', () => {
  it('the code under test connects as the NON-BYPASS app role, and the bug IS in triage', async () => {
    // Probed through the SAME bound context the services open (not a bare
    // statement on the singleton), so this is the role the code under test runs as.
    const [{ role }] = await withWorkspaceContext(
      fx.ctx,
      (tx) => tx.$queryRaw<[{ role: string }]>`SELECT current_user::text AS role`,
    );
    expect(role).toBe('motir_app');
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: triaged.id } });
    expect(row.triagedAt).not.toBeNull();
    expect(row.kind).toBe('bug');
  });
});

describe('a triage bug resolves where a conversation anchors', () => {
  it('the planning-anchor route (a `work-item` launch) resolves it', async () => {
    const res = await planningAnchor(anchorReq(triaged.identifier));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      anchor: {
        id: triaged.id,
        identifier: triaged.identifier,
        title: 'Saving a comment drops the mention',
        kind: 'bug',
      },
      // Parentless — a triage item has no lineage until it is promoted.
      ancestors: [],
      // And childless, so the surface opens on its own level (MOTIR-7621).
      hasChildren: false,
      // And unfiled — a triage item sits in no folder, so no folder crumbs.
      folders: [],
    });
  });

  it('the keyed service reads resolve it directly — no new read was needed', async () => {
    const lineage = await workItemsService.getWorkItemWithAncestors(
      fx.projectId,
      triaged.identifier,
      fx.ctx,
    );
    expect(lineage.item.id).toBe(triaged.id);
    const byKey = await workItemsService.getWorkItemByIdentifier(
      fx.projectId,
      triaged.identifier,
      fx.ctx,
    );
    expect(byKey.id).toBe(triaged.id);
  });

  it('the ask door takes it as `anchorKey` and forwards it to `ask_project` — the only job', async () => {
    const submitted = await ask(
      post('/api/ai/ask', { body: 'This is the bug I just filed', anchorKey: triaged.identifier }),
    );
    expect(submitted.status).toBe(200);
    const { jobId } = (await submitted.json()) as { jobId: string };
    expect(submitJobMock.mock.calls[0]![0]).toBe('ask_project');
    expect(submitJobMock.mock.calls[0]![2]).toEqual({
      prompt: 'This is the bug I just filed',
      anchorKey: triaged.identifier,
    });

    // The turn is ANSWERED (AMENDMENT 5 · MOTIR-9231): no `debug_bug` follows it.
    getJobMock.mockResolvedValue({
      status: 'succeeded',
      result: {
        ask: { intent: 'ask', answer: 'It is the sanitizer.', citations: [triaged.identifier] },
      },
    });
    const settled = await settle(post('/api/ai/ask/settle', { jobId }));
    expect(settled.status).toBe(200);
    await expect(settled.json()).resolves.toMatchObject({ outcome: 'answered' });
    expect(submitJobMock.mock.calls.map((c) => c[0])).toEqual(['ask_project']);

    // …and it is still a triage bug: anchoring and answering promote nothing.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: triaged.id } });
    expect(row.triagedAt).not.toBeNull();
  });

  it("another project's triage bug is the no-existence-leak 404 at both doors", async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const foreign = await triageService.createSubmission(
      { projectKey: other.projectIdentifier, kind: 'bug', title: 'Not yours' },
      other.ctx,
    );

    const anchored = await planningAnchor(anchorReq(foreign.identifier));
    expect(anchored.status).toBe(404);
    const asked = await ask(post('/api/ai/ask', { body: 'why?', anchorKey: foreign.identifier }));
    expect(asked.status).toBe(404);
    await expect(asked.json()).resolves.toEqual({
      code: 'NOT_FOUND',
      error: 'Work item not available.',
    });
    expect(submitJobMock).not.toHaveBeenCalled();
  });
});

describe('…and stays out of every LIST read', () => {
  const SORT = { column: 'key', direction: 'asc' } as const;

  it('absent from the /items list and tree reads, while its planned twin is present', async () => {
    const list = await workItemsService.getProjectIssuesList(fx.projectId, { sort: SORT }, fx.ctx);
    const listIds = list.items.map((i) => i.id);
    expect(listIds).toContain(normal.id);
    expect(listIds).not.toContain(triaged.id);

    const roots = await workItemsService.listRootIssues(fx.projectId, { sort: SORT }, fx.ctx);
    const rootIds = roots.rows.map((r) => r.id);
    expect(rootIds).toContain(normal.id);
    expect(rootIds).not.toContain(triaged.id);
  });

  it('absent from the board, while its planned twin is present', async () => {
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const cardIds = board.columns.flatMap((col) => col.cards.map((c) => c.id));
    expect(cardIds).toContain(normal.id);
    expect(cardIds).not.toContain(triaged.id);
  });

  it('still absent after it has been anchored and debugged', async () => {
    const { jobId } = (await (
      await ask(post('/api/ai/ask', { body: 'Mentions vanish', anchorKey: triaged.identifier }))
    ).json()) as { jobId: string };
    getJobMock.mockResolvedValue({
      status: 'succeeded',
      result: { ask: { intent: 'debug', answer: null, citations: [] } },
    });
    await settle(post('/api/ai/ask/settle', { jobId }));

    const list = await workItemsService.getProjectIssuesList(fx.projectId, { sort: SORT }, fx.ctx);
    expect(list.items.map((i) => i.id)).not.toContain(triaged.id);
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    expect(board.columns.flatMap((col) => col.cards.map((c) => c.id))).not.toContain(triaged.id);
  });
});
