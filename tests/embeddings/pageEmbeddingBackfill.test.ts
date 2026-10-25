import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE PAGE EMBEDDING BACKFILL (Story MOTIR-9490 · MOTIR-9573) —
// `pnpm db:backfill:page-embeddings`, driven through `run` with an injected `Out`
// against a REAL Postgres. The motir-ai client is the one seam stubbed.
vi.mock('@/lib/ai/motirAiClient', () => ({ embedTexts: vi.fn() }));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { db } from '@/lib/db';
import { embedTexts } from '@/lib/ai/motirAiClient';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pageEmbeddingBackfillService } from '@/lib/services/pageEmbeddingBackfillService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { captureEventPayloads } from '../helpers/jobs';
import { parseArgs, run, type Out } from '../../scripts/backfill-page-embeddings';

const MODEL = 'text-embedding-3-small';

let fx: WorkItemFixture;
let other: WorkItemFixture;
let cap: { restore: () => void };

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.mocked(embedTexts).mockImplementation(async (input: string[]) => ({
    model: MODEL,
    dimensions: 1536,
    embeddings: input.map(() => Array.from({ length: 1536 }, (_, i) => (i === 3 ? 1 : 0))),
  }));
  // Pages are seeded through the shipped door; its post-commit emits go nowhere.
  cap = captureEventPayloads('page/embedding.requested');
  fx = await makeWorkItemFixture({ identifier: 'PBF' });
  other = await makeWorkItemFixture({ name: 'Beta', identifier: 'PBO' });
});

afterEach(() => {
  cap.restore();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(embedTexts).mockReset();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedPages(f: WorkItemFixture, count: number, projectId = f.projectId) {
  const ids: string[] = [];
  const { pagesService } = await import('@/lib/services/pagesService');
  for (let i = 0; i < count; i++) {
    const page = await pagesService.createPageFromMarkdown(f.ctx, {
      projectId,
      title: `Page ${i}`,
      markdown: `Body ${i}`,
    });
    ids.push(page.id);
  }
  return ids;
}

function capture(): Out & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, log: (l) => lines.push(l), error: (l) => errors.push(l) };
}

const rows = () => adminDb.pageEmbedding.count();

describe('pnpm db:backfill:page-embeddings', () => {
  it('embeds every live page once and reports N of N', async () => {
    await seedPages(fx, 3);
    const out = capture();

    expect(await run(['--workspace=' + fx.workspaceId], { out })).toBe(0);

    expect(embedTexts).toHaveBeenCalledTimes(3);
    expect(await rows()).toBe(3);
    expect(out.lines).toContain('[backfill-page-embeddings] embedded 3 of 3 live pages.');
  });

  it('is a no-op on a second run: no provider call, no new row, still N of N', async () => {
    await seedPages(fx, 3);
    await run([], { out: capture() });
    vi.mocked(embedTexts).mockClear();
    const out = capture();

    expect(await run([], { out })).toBe(0);

    expect(embedTexts).not.toHaveBeenCalled();
    expect(await rows()).toBe(3);
    expect(out.lines.join('\n')).toContain('0 embedded, 3 unchanged');
    expect(out.lines).toContain('[backfill-page-embeddings] embedded 3 of 3 live pages.');
  });

  it('visits every live page once, in id order, batch by batch, never an archived one', async () => {
    const ids = await seedPages(fx, 7);
    const archived = ids[2]!;
    await adminDb.page.update({
      where: { id: archived },
      data: { archivedAt: new Date(), archiveRootId: archived },
    });
    const scan = vi.spyOn(pageRepository, 'listLiveIdsAfter');
    const visited: string[] = [];
    vi.mocked(embedTexts).mockImplementation(async (input: string[]) => ({
      model: MODEL,
      dimensions: 1536,
      embeddings: input.map(() => Array.from({ length: 1536 }, (_, i) => (i === 1 ? 1 : 0))),
    }));
    const { pageEmbeddingsService } = await import('@/lib/services/pageEmbeddingsService');
    const embed = vi.spyOn(pageEmbeddingsService, 'embedPage');

    expect(await run(['--batch-size=2', `--project=${fx.projectId}`], { out: capture() })).toBe(0);

    visited.push(...embed.mock.calls.map((c) => c[0].pageId));
    const live = ids.filter((id) => id !== archived).sort();
    expect(visited).toEqual(live);
    expect(scan.mock.calls.length).toBe(4); // 2 + 2 + 2 + 0
    for (const call of scan.mock.calls) expect(call[1]).toBe(2);
    expect(await adminDb.pageEmbedding.findUnique({ where: { pageId: archived } })).toBeNull();
  });

  it('stops between two pages on abort, and a re-run completes the rest', async () => {
    await seedPages(fx, 4);
    const controller = new AbortController();
    vi.mocked(embedTexts).mockImplementation(async (input: string[]) => {
      if (vi.mocked(embedTexts).mock.calls.length === 2) controller.abort();
      return {
        model: MODEL,
        dimensions: 1536,
        embeddings: input.map(() => Array.from({ length: 1536 }, (_, i) => (i === 5 ? 1 : 0))),
      };
    });
    const out = capture();

    expect(await run([], { out, signal: controller.signal })).toBe(1);
    expect(await rows()).toBe(2);
    expect(out.errors.join('\n')).toContain('INTERRUPTED after 2 page(s)');
    expect(out.lines).toContain('[backfill-page-embeddings] embedded 2 of 4 live pages.');

    const resumed = capture();
    expect(await run([], { out: resumed })).toBe(0);
    expect(resumed.lines).toContain('[backfill-page-embeddings] embedded 4 of 4 live pages.');
  });

  it('reports embedded 0 of M for a project with pages and no rows, on a dry run that writes nothing', async () => {
    await seedPages(fx, 2);
    const out = capture();

    expect(await run(['--dry-run'], { out })).toBe(0);

    expect(embedTexts).not.toHaveBeenCalled();
    expect(await rows()).toBe(0);
    expect(out.lines).toContain(
      '[backfill-page-embeddings] live pages in scope: 2; already embedded: 0.',
    );
    expect(out.lines).toContain('[backfill-page-embeddings] a real run would visit 2 page(s).');
    expect(out.lines).toContain('[backfill-page-embeddings] embedded 0 of 2 live pages.');
  });

  it('restricts the sweep and the counts to --workspace and --project', async () => {
    await seedPages(fx, 2);
    await seedPages(other, 3);
    const second = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'PB2',
    });
    await seedPages(fx, 1, second.id);

    const byWorkspace = capture();
    await run([`--workspace=${other.workspaceId}`], { out: byWorkspace });
    expect(byWorkspace.lines).toContain('[backfill-page-embeddings] embedded 3 of 3 live pages.');
    expect(await adminDb.pageEmbedding.count({ where: { workspaceId: fx.workspaceId } })).toBe(0);

    const byProject = capture();
    await run([`--project=${second.id}`], { out: byProject });
    expect(byProject.lines).toContain('[backfill-page-embeddings] embedded 1 of 1 live pages.');
    expect(await adminDb.pageEmbedding.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('records a transport failure on one page, embeds the others and exits non-zero', async () => {
    const ids = await seedPages(fx, 3);
    let call = 0;
    vi.mocked(embedTexts).mockImplementation(async (input: string[]) => {
      call += 1;
      if (call === 2) throw new MotirAiUnavailableError('gateway down');
      return {
        model: MODEL,
        dimensions: 1536,
        embeddings: input.map(() => Array.from({ length: 1536 }, (_, i) => (i === 6 ? 1 : 0))),
      };
    });

    const report = await pageEmbeddingBackfillService.backfill({});

    expect(report.embedded).toBe(2);
    expect(report.failed).toHaveLength(1);
    expect([...ids].sort()).toContain(report.failed[0]!.pageId);
    expect(report.embeddedOfTotal).toEqual({ embedded: 2, total: 3 });

    vi.mocked(embedTexts).mockRejectedValue(new MotirAiUnavailableError('gateway down'));
    const out = capture();
    expect(await run([], { out })).toBe(1);
    expect(out.errors.join('\n')).toContain('FAILED — ');
  });

  it('stops on the first page when no embedding backend is configured', async () => {
    await seedPages(fx, 3);
    vi.stubEnv('MOTIR_AI_URL', '');
    const out = capture();

    expect(await run([], { out })).toBe(1);

    expect(embedTexts).not.toHaveBeenCalled();
    expect(out.errors.join('\n')).toMatch(/no embedding backend is configured/);
    const report = await pageEmbeddingBackfillService.backfill({});
    expect(report.visited).toBe(1);
    expect(report.aiNotConfigured).toBe(true);
  });
});

describe('parseArgs', () => {
  it('reads every flag and defaults the batch to 100', () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      workspaceId: undefined,
      projectId: undefined,
      batchSize: 100,
    });
    expect(parseArgs(['--dry-run', '--workspace=w', '--project=p', '--batch-size=500'])).toEqual({
      dryRun: true,
      workspaceId: 'w',
      projectId: 'p',
      batchSize: 500,
    });
  });

  it('rejects an unknown argument and a batch size outside 1..500, by name', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument: --nope/);
    for (const bad of ['0', '501', '2.5', 'x']) {
      expect(() => parseArgs([`--batch-size=${bad}`])).toThrow(/--batch-size must be/);
    }
  });

  it('is exposed as pnpm db:backfill:page-embeddings', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['db:backfill:page-embeddings']).toContain(
      'scripts/backfill-page-embeddings.ts',
    );
  });
});

describe('the backfill service', () => {
  it('opens no transaction around embedPage and imports no repository into a repository', () => {
    const source = readFileSync(
      path.join(__dirname, '../../lib/services/pageEmbeddingBackfillService.ts'),
      'utf8',
    );
    // `embedPage` is awaited at the top level of the sweep, never inside a context callback.
    expect(source).toMatch(/\n\s+const result = await pageEmbeddingsService\.embedPage\(/);
    expect(source).not.toMatch(/\(tx\)[^]*?pageEmbeddingsService\.embedPage[^]*?\)\s*\)/);
    expect(source).not.toMatch(/\$transaction/);
  });
});
