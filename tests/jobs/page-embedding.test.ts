import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';

// The page embedding JOB, driven from the SHIPPED write path (Story MOTIR-9490 ·
// MOTIR-9571). A real `pagesService` save emits `page/embedding.requested`, and
// the REAL job function runs over that exact payload — so the event the write
// path emits is proven to be the event the job consumes.
//
// Real Postgres; the one boundary seam stubbed is the motir-ai client.

vi.mock('@/lib/ai/motirAiClient', () => ({ embedTexts: vi.fn() }));

import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { embedTexts } from '@/lib/ai/motirAiClient';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import { pageEmbeddingRequested } from '@/lib/jobs/definitions/pageEmbedding';
import { parseEventExpression } from '@/lib/jobs/engine/eventExpression';
import type { PageEmbeddingRequestedData } from '@/lib/jobs/types';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { truncateAuthTables } from '../helpers/db';
import { captureEventPayloads } from '../helpers/jobs';

const MODEL = 'text-embedding-3-small';

let cap: { events: PageEmbeddingRequestedData[]; restore: () => void };

beforeEach(async () => {
  await truncateAuthTables();
  vi.clearAllMocks();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.mocked(embedTexts).mockImplementation(async (input: string[]) => ({
    model: MODEL,
    dimensions: 1536,
    embeddings: input.map(() => Array.from({ length: 1536 }, (_, i) => (i === 7 ? 1 : 0))),
  }));
  cap = captureEventPayloads<PageEmbeddingRequestedData>('page/embedding.requested');
});

afterEach(() => {
  cap.restore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeCtx(): Promise<{ ctx: ServiceContext; projectId: string }> {
  const owner = await usersService.createUser({
    email: 'page-job@example.com',
    password: 'hunter2hunter2',
    name: 'Job',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Pages', ownerUserId: owner.id });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    name: 'Pages',
    identifier: 'PJB',
  });
  return { ctx: { userId: owner.id, workspaceId: ws.workspace.id }, projectId: project.id };
}

/** Create a page through the shipped door and return the ONE event it emitted. */
async function createAndCapture(title: string): Promise<{ data: PageEmbeddingRequestedData }> {
  const { ctx, projectId } = await makeCtx();
  const from = cap.events.length;
  await pagesService.createPageFromMarkdown(ctx, { projectId, title, markdown: 'Body.' });
  const emitted = cap.events.slice(from);
  expect(emitted).toHaveLength(1);
  return { data: emitted[0]! };
}

const run = (data: PageEmbeddingRequestedData) =>
  new JobTestEngine({
    function: pageEmbeddingRequested,
    events: [{ name: 'page/embedding.requested', data }],
  }).execute();

describe('pageEmbeddingRequested', () => {
  it('embeds the page named by the event the shipped save emitted', async () => {
    const { data } = await createAndCapture('Runbook');

    const { result } = await run(data);

    expect(result).toEqual({ embedded: true, model: MODEL });
    const row = await adminDb.pageEmbedding.findUnique({ where: { pageId: data.pageId } });
    expect(row?.model).toBe(MODEL);
  });

  it('is idempotent across a redelivery of the SAME event', async () => {
    const { data } = await createAndCapture('Once');

    await run(data);
    const second = await run(data);

    expect(second.result).toEqual({ embedded: false, reason: 'unchanged' });
    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(await adminDb.pageEmbedding.count()).toBe(1);
  });

  it('lets a provider outage FAIL, so the retry budget can absorb it', async () => {
    const { data } = await createAndCapture('Unlucky');
    vi.mocked(embedTexts).mockRejectedValue(new MotirAiUnavailableError('gateway down'));

    const { error } = await run(data);

    expect(error).toBeTruthy();
    expect(await adminDb.pageEmbedding.count()).toBe(0);
  });

  it('is debounced per page, so a typing burst becomes one run', () => {
    expect(pageEmbeddingRequested.retryPolicy).toBe('idempotent');
    expect(pageEmbeddingRequested.debounce).toEqual({
      key: 'event.data.pageId',
      period: '30s',
      timeout: '5m',
    });
    expect(
      parseEventExpression(
        'page/embedding.requested',
        'debounce.key',
        pageEmbeddingRequested.debounce!.key,
      ),
    ).toHaveLength(1);
  });
});
