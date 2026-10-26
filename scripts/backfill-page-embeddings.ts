/**
 * `pnpm db:backfill:page-embeddings` — embed every live page that existed before
 * the page embedding write path shipped (Story MOTIR-9490 · Subtask MOTIR-9573).
 *
 * THE GAP. Since MOTIR-9571 every page save emits `page/embedding.requested`, so
 * a page written from now on is found by meaning. A page written before that has
 * no `page_embedding` row, so a meaning search misses it, and a project where no
 * page has one reads `not-indexed`.
 *
 * ⚠️ IT NEVER RE-IMPLEMENTS THE EMBED. Every page is handed to
 * `pageEmbeddingsService.embedPage` — the job's own entry point — so a SECOND RUN
 * EMBEDS 0: every page it already did reads `unchanged` and costs one read.
 *
 * THE REPORT IS THE POINT: per-outcome counts, then `embedded N of M live pages`,
 * read from the database after the sweep. `embedded 0 of M` is what `not-indexed`
 * means; `M of M` is what lets a miss be read as "nothing similar".
 *
 * CROSS-TENANT BY DEFAULT; `--workspace=<id>` and `--project=<id>` narrow both the
 * sweep and the counts. `--batch-size=<n>` (1..500, default 100) sets the scan's
 * keyset batch.
 *
 * Usage:
 *   pnpm db:backfill:page-embeddings --dry-run          # count only: no seam call, no write
 *   pnpm db:backfill:page-embeddings                    # embed everywhere
 *   pnpm db:backfill:page-embeddings --workspace=<id> --project=<id> [--dry-run]
 *
 * It needs `DATABASE_URL`, plus `MOTIR_AI_URL` and `MOTIR_AI_SERVICE_TOKEN` for a
 * real run (without them it stops on the first page and exits non-zero).
 * RUNNING THIS ON PRODUCTION is an operator step after the deploy, owed as its own
 * `manual` card — not MOTIR-9573's.
 *
 * SIGINT / SIGTERM stop the sweep between two pages and print the PARTIAL report,
 * marked INTERRUPTED, before exiting non-zero. Re-run to resume.
 */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import {
  PAGE_EMBEDDING_BACKFILL_DEFAULT_BATCH,
  PAGE_EMBEDDING_BACKFILL_MAX_BATCH,
  pageEmbeddingBackfillService,
  type PageEmbeddingBackfillProgress,
  type PageEmbeddingBackfillReport,
} from '@/lib/services/pageEmbeddingBackfillService';

const TAG = '[backfill-page-embeddings]';

export interface Args {
  dryRun: boolean;
  workspaceId: string | undefined;
  projectId: string | undefined;
  batchSize: number;
}

function valueOf(arg: string, flag: string): string | undefined {
  const prefix = `${flag}=`;
  return arg.startsWith(prefix) && arg.length > prefix.length
    ? arg.slice(prefix.length)
    : undefined;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    dryRun: false,
    workspaceId: undefined,
    projectId: undefined,
    batchSize: PAGE_EMBEDDING_BACKFILL_DEFAULT_BATCH,
  };
  for (const arg of argv) {
    const workspace = valueOf(arg, '--workspace');
    const project = valueOf(arg, '--project');
    const batch = valueOf(arg, '--batch-size');
    if (arg === '--dry-run') args.dryRun = true;
    else if (workspace !== undefined) args.workspaceId = workspace;
    else if (project !== undefined) args.projectId = project;
    else if (batch !== undefined) {
      const n = Number(batch);
      if (!Number.isInteger(n) || n < 1 || n > PAGE_EMBEDDING_BACKFILL_MAX_BATCH) {
        throw new Error(
          `${TAG} --batch-size must be an integer from 1 to ${PAGE_EMBEDDING_BACKFILL_MAX_BATCH}: ${batch}`,
        );
      }
      args.batchSize = n;
    } else throw new Error(`${TAG} unknown argument: ${arg}`);
  }
  return args;
}

/** Where the script writes — injectable so a test reads the lines it printed. */
export interface Out {
  log: (line: string) => void;
  error: (line: string) => void;
}

const CONSOLE: Out = console;

function describeScope(args: Args): string {
  const parts = [
    args.workspaceId ? `workspace ${args.workspaceId}` : null,
    args.projectId ? `project ${args.projectId}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'every workspace';
}

function printProgress(out: Out, p: PageEmbeddingBackfillProgress): void {
  out.log(`${TAG} progress — visited ${p.visited}, embedded ${p.embedded}, failed ${p.failed}`);
}

function printReport(out: Out, report: PageEmbeddingBackfillReport): void {
  const { embedded, total } = report.embeddedOfTotal;
  if (report.dryRun) {
    out.log(`${TAG} live pages in scope: ${total}; already embedded: ${embedded}.`);
    out.log(`${TAG} a real run would visit ${report.visited} page(s).`);
  } else {
    out.log(
      `${TAG} visited ${report.visited}: ${report.embedded} embedded, ${report.unchanged} unchanged, ` +
        `${report.removed} removed, ${report.notFound} not found, ${report.failed.length} failed.`,
    );
    for (const f of report.failed) {
      out.error(`${TAG}   page ${f.pageId} (workspace ${f.workspaceId}) FAILED — ${f.error}`);
    }
  }
  out.log(`${TAG} embedded ${embedded} of ${total} live pages.`);
}

/** The whole CLI over an argv: returns the exit code. */
export async function run(
  argv: readonly string[],
  opts: { out?: Out; signal?: AbortSignal } = {},
): Promise<number> {
  const out = opts.out ?? CONSOLE;
  const args = parseArgs(argv);

  if (args.dryRun) out.log(`${TAG} DRY RUN — counting only, nothing will be embedded.`);
  out.log(`${TAG} scope: ${describeScope(args)}; batch size ${args.batchSize}.`);

  const report = await pageEmbeddingBackfillService.backfill({
    dryRun: args.dryRun,
    batchSize: args.batchSize,
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    onProgress: (p) => printProgress(out, p),
  });

  if (report.aiNotConfigured) {
    out.error(
      `${TAG} no embedding backend is configured (MOTIR_AI_URL / MOTIR_AI_SERVICE_TOKEN unset) — ` +
        'nothing was embedded.',
    );
    return 1;
  }
  printReport(out, report);
  if (report.interrupted) {
    out.error(
      `${TAG} INTERRUPTED after ${report.visited} page(s). Pages already embedded are kept; ` +
        're-run to resume.',
    );
    return 1;
  }
  if (report.failed.length > 0) {
    out.error(`${TAG} ${report.failed.length} page(s) failed — see above; re-run to retry them.`);
    return 1;
  }
  out.log(`${TAG} done.` + (args.dryRun ? ' Re-run without --dry-run to embed.' : ''));
  return 0;
}

/* v8 ignore start -- the process entry: signal wiring and exit code over `run`,
   which `tests/embeddings/pageEmbeddingBackfill.test.ts` drives directly. */
if (/backfill-page-embeddings\.ts$/.test(process.argv[1] ?? '')) {
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    if (controller.signal.aborted) return;
    console.error(`${TAG} ${signal} received — stopping after the page in flight.`);
    controller.abort();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  run(process.argv.slice(2), { signal: controller.signal })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`${TAG} failed:`, err);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
/* v8 ignore stop */
