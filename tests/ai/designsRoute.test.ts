import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkWaitOn } from '../helpers/designWaits';
import { shaFor } from '../helpers/commitShaFixtures';

// MOTIR-10239 — the planner's APPROVED-DESIGN read through the REAL route
// handler, on a real Postgres: both §4 grants, the 400s, the list and the single
// card, the token's OWN project as the only scope (two workspaces, two projects),
// every absence as a NAMED outcome at 200, and that the list mints no link.
//
// The object store is the one mocked external, as `designAccessService.test.ts`
// mocks it — a STORE, so a publish's authoritative `head` reads what was put.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(async (pathname: string, bytes: Buffer, contentType: string) => {
    store.set(pathname, { contentType, size: bytes.byteLength });
    return { pathname };
  }),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://store.example/${pathname}?sig=x`),
  deleteAttachmentBlob: vi.fn(async () => {}),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { GET } = await import('@/app/api/internal/ai/designs/route');
const { designAccessService } = await import('@/lib/services/designAccessService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { workflowsService } = await import('@/lib/services/workflowsService');
const { projectsService } = await import('@/lib/services/projectsService');

const SERVICE_SECRET = 'core-callback-secret-test';

let fx: WorkItemFixture;
let token: string;

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  token = tokenFor(fx.ctx, fx.projectId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function tokenFor(ctx: ServiceContext, projectId: string): string {
  return mintJobToken({ userId: ctx.userId, workspaceId: ctx.workspaceId, projectId });
}

function get(query = '', opts: { bearer?: string; token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  const bearer = 'bearer' in opts ? opts.bearer : SERVICE_SECRET;
  const tok = 'token' in opts ? opts.token : token;
  if (bearer !== undefined) headers['authorization'] = `Bearer ${bearer}`;
  if (tok !== undefined) headers['x-motir-job-token'] = tok;
  return GET(new Request(`http://core/api/internal/ai/designs${query}`, { headers }));
}

const resultOf = async (res: Response) => {
  expect(res.status).toBe(200);
  return (await res.json()).result;
};

// ─── fixtures (designAccessService.test.ts's) ───────────────────────────────

async function parentStory(f: WorkItemFixture): Promise<string> {
  const story = await workItemsService.createWorkItem(
    { projectId: f.projectId, kind: 'story', title: 'The story these cards hang under' },
    f.ctx,
  );
  return story.id;
}

async function designCard(f: WorkItemFixture, title = 'Draw the frame'): Promise<WorkItem> {
  const card = await workItemsService.createWorkItem(
    {
      projectId: f.projectId,
      kind: 'subtask',
      parentId: await parentStory(f),
      title,
      type: 'design',
    },
    f.ctx,
  );
  await workItemsService.updateStatus(card.id, 'in_progress', f.ctx);
  await workItemsService.updateStatus(card.id, 'in_review', f.ctx);
  return adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
}

async function publish(f: WorkItemFixture, card: WorkItem, label: string): Promise<string> {
  const prefix = designPrefix(f.workspaceId, card.id);
  const assets = [
    {
      kind: 'mock' as const,
      sourcePath: `design/${label}/frame.mock.html`,
      pathname: `${prefix}${label}.mock.html`,
    },
    {
      kind: 'note_file' as const,
      sourcePath: `design/${label}/design-notes.md`,
      pathname: `${prefix}${label}.md`,
    },
  ];
  for (const asset of assets) {
    store.set(asset.pathname, {
      contentType: asset.kind === 'mock' ? 'text/html' : 'text/markdown',
      size: 64,
    });
  }
  const result = await designEvidenceService.recordFromPathnames(
    { workItemId: card.id, assets, commitSha: shaFor(label) },
    f.ctx,
  );
  return result.id;
}

async function approve(f: WorkItemFixture, evidenceId: string): Promise<void> {
  const gate = await adminDb.approvalGate.findFirstOrThrow({
    where: { subjectId: evidenceId, kind: 'design_result', state: 'awaiting' },
  });
  await approvalGatesService.decide(
    { stamp: DECIDED_WITHOUT_A_READER, gateId: gate.id, decision: 'approve', source: 'ui' },
    f.ctx,
  );
}

/** A design card of `f`'s project, approved with one published version. */
async function approvedDesign(f: WorkItemFixture, label: string, title = `Surface ${label}`) {
  const card = await designCard(f, title);
  await makeWorkWaitOn(card.id, f, { title: `Build ${label}` });
  const evidenceId = await publish(f, card, label);
  await approve(f, evidenceId);
  return { card, evidenceId };
}

describe('GET /api/internal/ai/designs — auth and validation', () => {
  it('401 for a missing / wrong bearer and a missing / tampered / expired job token', async () => {
    const noBearer = await get('', { bearer: undefined });
    expect(noBearer.status).toBe(401);
    expect(await noBearer.json()).toMatchObject({ code: 'service_unauthorized' });
    expect((await get('', { bearer: 'wrong' })).status).toBe(401);
    const noToken = await get('', { token: undefined });
    expect(noToken.status).toBe(401);
    expect(await noToken.json()).toMatchObject({ code: 'token_invalid' });
    expect((await get('', { token: 'not-a-real-token' })).status).toBe(401);
    vi.useFakeTimers();
    try {
      const minted = tokenFor(fx.ctx, fx.projectId);
      vi.setSystemTime(Date.now() + 24 * 3_600_000);
      expect((await get('', { token: minted })).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('400 validation_error for a blank key, a limit outside 1–100, and a malformed cursor', async () => {
    for (const q of [
      '?key=',
      '?key=%20',
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?limit=1.5',
      '?cursor=garbage',
    ]) {
      const res = await get(q);
      expect(res.status, q).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'validation_error' });
    }
  });
});

describe('GET /api/internal/ai/designs — the list', () => {
  it('lists approved designs newest first with a cursor, filters, and equals the service page', async () => {
    const made = [];
    for (const label of ['s0', 's1', 's2']) made.push(await approvedDesign(fx, label));

    const first = await resultOf(await get('?limit=2'));
    expect(first.outcome).toBe('ok');
    expect(first.designs).toHaveLength(2);
    expect(first.designs[0].designCardKey).toBe(made[2]!.card.identifier);
    expect(first.nextCursor).toEqual(expect.any(String));
    const { outcome: _o, ...page } = first;
    expect(page).toEqual(
      JSON.parse(
        JSON.stringify(
          await designAccessService.listApprovedDesigns(fx.projectIdentifier, { limit: 2 }, fx.ctx),
        ),
      ),
    );

    const second = await resultOf(await get(`?limit=2&cursor=${first.nextCursor}`));
    expect(second.designs.map((d: { designCardKey: string }) => d.designCardKey)).toEqual([
      made[0]!.card.identifier,
    ]);
    expect(second.nextCursor).toBeNull();

    const byTitle = await resultOf(await get('?query=surface%20s1'));
    expect(byTitle.designs.map((d: { designCardKey: string }) => d.designCardKey)).toEqual([
      made[1]!.card.identifier,
    ]);
    const byPath = await resultOf(await get('?pathPrefix=design%2Fs2%2F'));
    expect(byPath.designs.map((d: { designCardKey: string }) => d.designCardKey)).toEqual([
      made[2]!.card.identifier,
    ]);
  });

  it('mints no link and writes nothing', async () => {
    await approvedDesign(fx, 's0');
    const before = await adminDb.designEvidence.count();
    const body = await (await get()).text();
    expect(body).not.toContain('store.example');
    expect(body).not.toContain('"url"');
    expect(body).not.toContain('expiresAt');
    expect(await adminDb.designEvidence.count()).toBe(before);
  });

  it('never lists another project’s or workspace’s designs', async () => {
    const sibling = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    const siblingFx = { ...fx, projectId: sibling.id, projectIdentifier: sibling.identifier };
    await approvedDesign(siblingFx, 'sib');
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    await approvedDesign(rival, 'riv');

    expect(await resultOf(await get())).toEqual({ outcome: 'ok', designs: [], nextCursor: null });
  });

  it('a project with no approved designs, and one with no done status, are an empty ok', async () => {
    expect(await resultOf(await get())).toEqual({ outcome: 'ok', designs: [], nextCursor: null });
    await approvedDesign(fx, 's0');
    vi.spyOn(workflowsService, 'resolveStatusKey').mockResolvedValue(null);
    expect(await resultOf(await get())).toEqual({ outcome: 'ok', designs: [], nextCursor: null });
  });

  it('a short page that still carries a cursor is returned with the cursor intact', async () => {
    vi.spyOn(designAccessService, 'listApprovedDesigns').mockResolvedValueOnce({
      designs: [],
      nextCursor: '17',
    });
    expect(await resultOf(await get('?query=x'))).toEqual({
      outcome: 'ok',
      designs: [],
      nextCursor: '17',
    });
  });

  it('a token whose user cannot browse the project gets not_found', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const crossed = mintJobToken({
      userId: rival.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect(await resultOf(await get('', { token: crossed }))).toEqual({ outcome: 'not_found' });
  });
});

describe('GET /api/internal/ai/designs?key= — one design card', () => {
  it('an approved design carries its assets, each with a short-lived link', async () => {
    const { card, evidenceId } = await approvedDesign(fx, 'v1');
    const result = await resultOf(await get(`?key=${card.identifier.toLowerCase()}`));
    expect(result).toMatchObject({
      outcome: 'ok',
      verdict: 'approved',
      designCardKey: card.identifier,
      design: { evidenceId, commitSha: shaFor('v1') },
    });
    expect(result.design.assets).toHaveLength(2);
    for (const asset of result.design.assets) {
      expect(asset.state).toBe('available');
      expect(asset.url).toMatch(/^https:\/\/store\.example\//);
      expect(asset.expiresAt).toEqual(expect.any(String));
    }
  });

  it('a reclaimed asset stays in the answer, unlinked', async () => {
    const { card, evidenceId } = await approvedDesign(fx, 'v1');
    vi.spyOn(designAccessService, 'downloadLinks').mockResolvedValueOnce([]);
    const result = await resultOf(await get(`?key=${card.identifier}`));
    expect(result.design.evidenceId).toBe(evidenceId);
    expect(result.design.assets.every((a: { url?: string }) => a.url === undefined)).toBe(true);
  });

  it('any other card is not_approved with its named reason', async () => {
    const inReview = await designCard(fx, 'Still in review');
    expect(await resultOf(await get(`?key=${inReview.identifier}`))).toMatchObject({
      outcome: 'ok',
      verdict: 'not_approved',
      reason: 'not_done',
    });
    const neverDrawn = await designCard(fx, 'Never drawn');
    await adminDb.workItem.update({ where: { id: neverDrawn.id }, data: { status: 'done' } });
    expect(await resultOf(await get(`?key=${neverDrawn.identifier}`))).toMatchObject({
      verdict: 'not_approved',
      reason: 'no_result',
    });
    const code = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Code', type: 'code' },
      fx.ctx,
    );
    expect(await resultOf(await get(`?key=${code.identifier}`))).toMatchObject({
      verdict: 'not_approved',
      reason: 'not_a_design_card',
    });
  });

  it('an unknown key, another project’s card and another workspace’s card all answer not_found', async () => {
    const sibling = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Other',
      identifier: 'OTH',
    });
    const siblingFx = { ...fx, projectId: sibling.id, projectIdentifier: sibling.identifier };
    const { card: siblingCard } = await approvedDesign(siblingFx, 'sib');
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const { card: rivalCard } = await approvedDesign(rival, 'riv');

    const bodies = [];
    for (const key of [
      `${fx.projectIdentifier}-99999`,
      'NOPE-1',
      'nodash',
      siblingCard.identifier,
      rivalCard.identifier,
    ]) {
      const res = await get(`?key=${key}`);
      expect(res.status, key).toBe(200);
      bodies.push(await res.text());
    }
    for (const body of bodies)
      expect(body).toBe(JSON.stringify({ result: { outcome: 'not_found' } }));
    expect(bodies.join('')).not.toContain('store.example');
  });

  it('a card the token’s user cannot browse answers not_found', async () => {
    const { card } = await approvedDesign(fx, 'v1');
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const crossed = mintJobToken({
      userId: rival.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect(await resultOf(await get(`?key=${card.identifier}`, { token: crossed }))).toEqual({
      outcome: 'not_found',
    });
  });

  it('an unexpected failure is rethrown, not dressed as an outcome', async () => {
    vi.spyOn(designAccessService, 'listApprovedDesigns').mockRejectedValueOnce(
      new Error('db down'),
    );
    await expect(get()).rejects.toThrow('db down');
  });

  it('carries no credential-shaped field besides the link URLs', async () => {
    const { card } = await approvedDesign(fx, 'v1');
    const body = await (await get(`?key=${card.identifier}`)).text();
    expect(body).not.toContain(SERVICE_SECRET);
    expect(body).not.toContain(token);
    expect(body).not.toContain('token-for:');
    expect(body).not.toMatch(/"(token|secret|password|authorization)"/i);
  });
});
