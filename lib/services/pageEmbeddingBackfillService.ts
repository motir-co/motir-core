import { pageEmbeddingRepository } from '@/lib/repositories/pageEmbeddingRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { pageEmbeddingsService } from './pageEmbeddingsService';

// BACKFILL THE PAGE SEMANTIC INDEX (Story MOTIR-9490 · MOTIR-9573) — embed every
// live page that existed before the write path (MOTIR-9571) shipped.
//
// ── IT NEVER RE-IMPLEMENTS THE EMBED ────────────────────────────────────────
// Each page is handed to `pageEmbeddingsService.embedPage`, the job's own entry
// point: it composes the document, compares the content hash, calls the seam
// outside any transaction and upserts. The hash skip is what makes a second run
// cheap (`unchanged`, no provider call) and the `ON CONFLICT (page_id)` upsert is
// what makes it row-safe. This file decides nothing about a page.
//
// ── CROSS-TENANT, UNDER RLS — BY PROJECT, NOT BY PAGE ───────────────────────
// `page` has NO `app.system_admin` arm (its migration says so), so a page scan
// under `withSystemContext` returns ZERO rows and would report "0 of 0". The
// cross-tenant enumeration is therefore over PROJECTS, under `withSystemContext`
// (`projectRepository.listLiveAcrossWorkspaces`, as the work-item embedding
// sweep does), and each project's pages are scanned and counted inside its own
// workspace context. Pages of an archived project are not in scope: search
// cannot reach them.
//
// ── ONE PAGE AT A TIME, KEYSET BY ID ────────────────────────────────────────
// A failed page is recorded and the sweep goes on. An abort stops between two
// pages and the partial report is returned, marked `interrupted`; a re-run
// resumes because every finished page now reads `unchanged`. `ai-not-configured`
// on the first page stops the run at once: every page would answer the same.

/** Projects read per cross-tenant page of the project scan. */
const PROJECT_PAGE = 200;

export const PAGE_EMBEDDING_BACKFILL_DEFAULT_BATCH = 100;
export const PAGE_EMBEDDING_BACKFILL_MAX_BATCH = 500;

export interface PageEmbeddingBackfillOptions {
  workspaceId?: string;
  projectId?: string;
  batchSize?: number;
  dryRun?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: PageEmbeddingBackfillProgress) => void;
}

export interface PageEmbeddingBackfillProgress {
  visited: number;
  embedded: number;
  failed: number;
}

export interface PageEmbeddingBackfillFailure {
  pageId: string;
  workspaceId: string;
  error: string;
}

export interface PageEmbeddingBackfillReport {
  dryRun: boolean;
  /** Pages handed to `embedPage` — or, dry, that a real run would visit. */
  visited: number;
  embedded: number;
  unchanged: number;
  removed: number;
  notFound: number;
  failed: PageEmbeddingBackfillFailure[];
  /** Live pages in scope with an embedding row (N), and live pages in scope (M). */
  embeddedOfTotal: { embedded: number; total: number };
  interrupted: boolean;
  /** The run stopped on its first page because no embedding backend is configured. */
  aiNotConfigured: boolean;
}

/** The live projects in scope, across tenants, in id order. */
async function projectsInScope(
  scope: Pick<PageEmbeddingBackfillOptions, 'workspaceId' | 'projectId'>,
): Promise<Array<{ id: string; workspaceId: string }>> {
  const out: Array<{ id: string; workspaceId: string }> = [];
  let cursor: string | undefined;
  for (;;) {
    const projects = await withSystemContext((tx) =>
      projectRepository.listLiveAcrossWorkspaces(
        { take: PROJECT_PAGE, ...(cursor ? { cursor } : {}) },
        tx,
      ),
    );
    for (const p of projects) {
      if (scope.workspaceId && p.workspaceId !== scope.workspaceId) continue;
      if (scope.projectId && p.id !== scope.projectId) continue;
      out.push(p);
    }
    if (projects.length < PROJECT_PAGE) return out;
    cursor = projects[projects.length - 1]!.id;
  }
}

/** N of M over the projects in scope, each read in its own workspace. */
async function embeddedOfTotal(
  projects: ReadonlyArray<{ id: string; workspaceId: string }>,
): Promise<{ embedded: number; total: number }> {
  let embedded = 0;
  let total = 0;
  for (const project of projects) {
    const counts = await withWorkspaceServiceContext(project.workspaceId, async (tx) => ({
      total: await pageEmbeddingRepository.countLive({ projectId: project.id }, tx),
      embedded: await pageEmbeddingRepository.countEmbeddedLive({ projectId: project.id }, tx),
    }));
    embedded += counts.embedded;
    total += counts.total;
  }
  return { embedded, total };
}

export const pageEmbeddingBackfillService = {
  async backfill(opts: PageEmbeddingBackfillOptions = {}): Promise<PageEmbeddingBackfillReport> {
    const batchSize = opts.batchSize ?? PAGE_EMBEDDING_BACKFILL_DEFAULT_BATCH;
    const report: PageEmbeddingBackfillReport = {
      dryRun: opts.dryRun ?? false,
      visited: 0,
      embedded: 0,
      unchanged: 0,
      removed: 0,
      notFound: 0,
      failed: [],
      embeddedOfTotal: { embedded: 0, total: 0 },
      interrupted: false,
      aiNotConfigured: false,
    };
    const projects = await projectsInScope(opts);

    if (report.dryRun) {
      report.embeddedOfTotal = await embeddedOfTotal(projects);
      report.visited = report.embeddedOfTotal.total;
      return report;
    }

    const progress = () =>
      opts.onProgress?.({
        visited: report.visited,
        embedded: report.embedded,
        failed: report.failed.length,
      });

    sweep: for (const project of projects) {
      let afterId: string | null = null;
      for (;;) {
        const batch = await withWorkspaceServiceContext(project.workspaceId, (tx) =>
          pageRepository.listLiveIdsAfter(afterId, batchSize, { projectId: project.id }, tx),
        );
        for (const page of batch) {
          if (opts.signal?.aborted) {
            report.interrupted = true;
            break sweep;
          }
          report.visited += 1;
          try {
            const result = await pageEmbeddingsService.embedPage({
              workspaceId: page.workspaceId,
              pageId: page.id,
            });
            if (result.embedded) report.embedded += 1;
            else if (result.reason === 'unchanged') report.unchanged += 1;
            else if (result.reason === 'removed') report.removed += 1;
            else if (result.reason === 'not-found') report.notFound += 1;
            else {
              report.aiNotConfigured = true;
              break sweep;
            }
          } catch (err) {
            report.failed.push({
              pageId: page.id,
              workspaceId: page.workspaceId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        progress();
        if (batch.length < batchSize) break;
        afterId = batch[batch.length - 1]!.id;
      }
    }

    report.embeddedOfTotal = await embeddedOfTotal(projects);
    return report;
  },
};
