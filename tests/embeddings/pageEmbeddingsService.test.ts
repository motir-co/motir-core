import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The page semantic index's WRITE PATH on real Postgres (Story MOTIR-9490 ·
// MOTIR-9571). The motir-ai boundary is the ONE seam stubbed — there is no
// gateway in tests and an embedding is a metered external call. Pages are made
// and edited through the shipped `pagesService`, so the text embedded is the
// text a member saved.
vi.mock('@/lib/ai/motirAiClient', () => ({ embedTexts: vi.fn() }));

import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { embedTexts } from '@/lib/ai/motirAiClient';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import { pageEmbeddingsService } from '@/lib/services/pageEmbeddingsService';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { EmbeddingDimensionMismatchError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { truncateAuthTables } from '../helpers/db';
import { captureEventPayloads } from '../helpers/jobs';

const MODEL = 'text-embedding-3-small';

function vector(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === seed % 1536 ? 1 : 0));
}

let cap: { restore: () => void };

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.mocked(embedTexts).mockImplementation(async (input: string[]) => ({
    model: MODEL,
    dimensions: 1536,
    embeddings: input.map((_, i) => vector(i + 1)),
  }));
  // The write doors emit post-commit; nothing here wants the queue.
  cap = captureEventPayloads('page/embedding.requested');
});

afterEach(() => {
  cap.restore();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  workspaceId: string;
  projectId: string;
  ctx: ServiceContext;
}

async function makeFixture(): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: 'page-embed@example.com',
    password: 'hunter2hunter2',
    name: 'Embedder',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Pages', ownerUserId: owner.id });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    name: 'Pages',
    identifier: 'PEM',
  });
  return {
    workspaceId: ws.workspace.id,
    projectId: project.id,
    ctx: { userId: owner.id, workspaceId: ws.workspace.id },
  };
}

async function pageWithBody(f: Fixture, title: string, markdown: string): Promise<string> {
  const page = await pagesService.createPageFromMarkdown(f.ctx, {
    projectId: f.projectId,
    title,
    markdown,
  });
  return page.id;
}

const embed = (f: Fixture, pageId: string) =>
  pageEmbeddingsService.embedPage({ workspaceId: f.workspaceId, pageId });

describe('embedPage', () => {
  it("embeds the page's title and body text and stores one row", async () => {
    const f = await makeFixture();
    const pageId = await pageWithBody(f, 'Release checklist', 'Tag the build.');

    expect(await embed(f, pageId)).toEqual({ embedded: true, model: MODEL });

    const [document] = vi.mocked(embedTexts).mock.calls[0]![0];
    expect(document!.startsWith('Release checklist\n\n')).toBe(true);
    expect(document).toContain('Tag the build.');
    const row = await adminDb.pageEmbedding.findUniqueOrThrow({ where: { pageId } });
    expect(row).toMatchObject({
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      model: MODEL,
      dimensions: 1536,
    });
  });

  it('answers unchanged with no provider call when the text has not moved', async () => {
    const f = await makeFixture();
    const pageId = await pageWithBody(f, 'Stable', 'Same words.');
    await embed(f, pageId);

    expect(await embed(f, pageId)).toEqual({ embedded: false, reason: 'unchanged' });
    expect(embedTexts).toHaveBeenCalledTimes(1);
  });

  it('re-embeds after an edit, replacing the row', async () => {
    const f = await makeFixture();
    const pageId = await pageWithBody(f, 'Before', 'Old body.');
    await embed(f, pageId);
    const first = await adminDb.pageEmbedding.findUniqueOrThrow({ where: { pageId } });

    await pagesService.renamePage(f.ctx, { projectId: f.projectId, pageId, title: 'After' });
    expect(await embed(f, pageId)).toEqual({ embedded: true, model: MODEL });

    const second = await adminDb.pageEmbedding.findUniqueOrThrow({ where: { pageId } });
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(await adminDb.pageEmbedding.count()).toBe(1);
  });

  it('drops the row of an archived page, and re-embeds it once restored', async () => {
    const f = await makeFixture();
    const pageId = await pageWithBody(f, 'Archived soon', 'Body.');
    await embed(f, pageId);

    await pagesService.archivePage(f.ctx, { projectId: f.projectId, pageId });
    expect(await embed(f, pageId)).toEqual({ embedded: false, reason: 'removed' });
    expect(await adminDb.pageEmbedding.count()).toBe(0);
    expect(embedTexts).toHaveBeenCalledTimes(1);

    await pagesService.restorePage(f.ctx, { projectId: f.projectId, pageId });
    expect(await embed(f, pageId)).toEqual({ embedded: true, model: MODEL });
    expect(await adminDb.pageEmbedding.count()).toBe(1);
  });

  it('answers not-found for a deleted page, and for a page of another workspace', async () => {
    const f = await makeFixture();
    expect(await embed(f, 'no-such-page')).toEqual({ embedded: false, reason: 'not-found' });

    const pageId = await pageWithBody(f, 'Mine', 'Body.');
    const outsider = await workspacesService.createWorkspace({
      name: 'Elsewhere',
      ownerUserId: f.ctx.userId,
    });
    expect(
      await pageEmbeddingsService.embedPage({ workspaceId: outsider.workspace.id, pageId }),
    ).toEqual({ embedded: false, reason: 'not-found' });
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('is a no-op value when no motir-ai is configured', async () => {
    const f = await makeFixture();
    const pageId = await pageWithBody(f, 'Self-hosted', 'Body.');
    vi.stubEnv('MOTIR_AI_URL', '');

    expect(await embed(f, pageId)).toEqual({ embedded: false, reason: 'ai-not-configured' });
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('lets a transport failure throw and keeps the existing row', async () => {
    const f = await makeFixture();
    const pageId = await pageWithBody(f, 'Kept', 'Body.');
    await embed(f, pageId);
    const before = await adminDb.pageEmbedding.findUniqueOrThrow({ where: { pageId } });
    await pagesService.renamePage(f.ctx, { projectId: f.projectId, pageId, title: 'Renamed' });
    vi.mocked(embedTexts).mockRejectedValue(new MotirAiUnavailableError('gateway down'));

    await expect(embed(f, pageId)).rejects.toBeInstanceOf(MotirAiUnavailableError);
    const after = await adminDb.pageEmbedding.findUniqueOrThrow({ where: { pageId } });
    expect(after.contentHash).toBe(before.contentHash);
  });

  it('refuses a vector of the wrong length and writes nothing', async () => {
    const f = await makeFixture();
    const pageId = await pageWithBody(f, 'Short vector', 'Body.');
    vi.mocked(embedTexts).mockResolvedValue({
      model: MODEL,
      dimensions: 3,
      embeddings: [[1, 2, 3]],
    });

    await expect(embed(f, pageId)).rejects.toBeInstanceOf(EmbeddingDimensionMismatchError);
    expect(await adminDb.pageEmbedding.count()).toBe(0);
  });

  it('holds no open transaction while the provider call is in flight', async () => {
    const f = await makeFixture();
    const pageId = await pageWithBody(f, 'Staged', 'Body.');
    let openTransactions = -1;
    vi.mocked(embedTexts).mockImplementation(async (input: string[]) => {
      const rows = await adminDb.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS "count"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'idle in transaction'`;
      openTransactions = Number(rows[0]?.count ?? -1);
      return { model: MODEL, dimensions: 1536, embeddings: input.map((_, i) => vector(i + 1)) };
    });

    await embed(f, pageId);

    expect(openTransactions).toBe(0);
  });
});
