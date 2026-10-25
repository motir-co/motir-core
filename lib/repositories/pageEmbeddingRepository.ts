import { Prisma, type PageEmbedding } from '@/generated/prisma/client';
import { PAGE_SEARCH_LIVE_IN_PROJECT } from '@/lib/repositories/pageRepository';
import { efSearchForLimit } from '@/lib/repositories/workItemEmbeddingRepository';

// The vector width and the ef_search sizing are the work-item index's, shared
// rather than restated: both tables hold the same model's vectors.
export { EMBEDDING_DIMENSIONS } from '@/lib/repositories/workItemEmbeddingRepository';

// Single-Prisma-op leaves for the page semantic index (Story MOTIR-9490 ·
// MOTIR-9570). The page twin of `workItemEmbeddingRepository`, under the same
// constraints, which that file's header explains in full:
//   - `embedding` is `Unsupported("vector(1536)")`, so the row is written with
//     `$executeRaw` and ranked with `$queryRaw`, the vector BOUND as its
//     pgvector text literal and cast to `vector` — never concatenated;
//   - every method takes the caller's `tx`, because the table's RLS policy reads
//     `app.workspace_id` from the transaction, and outside a workspace context
//     the table is silently empty.
//
// No business logic here: composing the page document, hashing it and deciding
// skip-or-embed is `pageEmbeddingsService`'s.
//
// ⚠️ THE PROJECT AND ARCHIVED RESTRICTION OF EVERY READ IS
// `PAGE_SEARCH_LIVE_IN_PROJECT` — the one predicate page search reads inside
// (MOTIR-9551). The ranking and both counts join `page p` and interpolate it;
// none of them writes a project or archived check of its own.

/** A page's embedded row as the typed client can see it (no vector). */
export type PageEmbeddingRow = PageEmbedding;

export interface UpsertPageEmbeddingInput {
  pageId: string;
  workspaceId: string;
  projectId: string;
  model: string;
  dimensions: number;
  contentHash: string;
  embeddedAt: Date;
  embedding: number[];
}

/** One ranked row — the page's id plus its cosine DISTANCE to the query. */
export interface PageEmbeddingRankRow {
  pageId: string;
  /** Cosine distance (`<=>`), lower = more similar. */
  distance: number;
}

export interface RankPagesByEmbeddingInput {
  projectId: string;
  /** The model to rank IN — a hard filter: other models' vectors are not comparable. */
  model: string;
  queryEmbedding: number[];
  limit: number;
}

/** The pgvector text literal for a vector, to be BOUND and cast — never inlined. */
function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

/** The rows a ranking may read: an embedded row of `model` on a live page of the project. */
function rankable(projectId: string, model: string): Prisma.Sql {
  return Prisma.sql`${PAGE_SEARCH_LIVE_IN_PROJECT(projectId)}
        AND e."model" = ${model}
        AND e."embedding" IS NOT NULL`;
}

export const pageEmbeddingRepository = {
  /**
   * Write (or replace) a page's embedding — the typed columns AND the vector in
   * ONE statement, so a row without a vector is never created. `ON CONFLICT
   * (page_id) DO UPDATE` makes a retried or raced write converge on one row.
   */
  async upsert(input: UpsertPageEmbeddingInput, tx: Prisma.TransactionClient): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO "page_embedding" (
        "page_id", "workspace_id", "project_id", "model", "dimensions",
        "content_hash", "embedded_at", "embedding"
      ) VALUES (
        ${input.pageId}, ${input.workspaceId}, ${input.projectId}, ${input.model},
        ${input.dimensions}, ${input.contentHash}, ${input.embeddedAt},
        ${vectorLiteral(input.embedding)}::vector
      )
      ON CONFLICT ("page_id") DO UPDATE SET
        "workspace_id" = EXCLUDED."workspace_id",
        "project_id"   = EXCLUDED."project_id",
        "model"        = EXCLUDED."model",
        "dimensions"   = EXCLUDED."dimensions",
        "content_hash" = EXCLUDED."content_hash",
        "embedded_at"  = EXCLUDED."embedded_at",
        "embedding"    = EXCLUDED."embedding"`;
  },

  /** The stored derivation for one page (no vector), or null when it has none. */
  async findByPageId(
    pageId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PageEmbeddingRow | null> {
    return tx.pageEmbedding.findUnique({ where: { pageId } });
  },

  /** Drop a page's embedding. Answers how many rows went (0 or 1). */
  async deleteByPageId(pageId: string, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.pageEmbedding.deleteMany({ where: { pageId } });
    return count;
  },

  /**
   * How many of a project's pages are RANKABLE for this model — exactly the rows
   * {@link rankByEmbedding} could return. The under-return fallback compares the
   * ranking's row count against it, so its predicate is the ranking's own
   * (`rankable`), archived join included.
   */
  async countRankable(
    projectId: string,
    model: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS "count"
      FROM "page_embedding" e
      JOIN "page" p ON p."id" = e."page_id"
      WHERE ${rankable(projectId, model)}`;
    /* istanbul ignore next -- an aggregate with no GROUP BY always returns one row. */
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * How many of a project's LIVE pages have an embedding row for `model`, and how
   * many live pages it has in all — the backfill's "embedded N of M" and the
   * `not-indexed` decision. One query, so the two numbers describe one moment.
   */
  async countEmbeddedByProject(
    projectId: string,
    model: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ embedded: number; total: number }> {
    const rows = await tx.$queryRaw<{ embedded: bigint; total: bigint }[]>`
      SELECT COUNT(e."page_id")::bigint AS "embedded", COUNT(*)::bigint AS "total"
      FROM "page" p
      LEFT JOIN "page_embedding" e
        ON e."page_id" = p."id" AND e."model" = ${model} AND e."embedding" IS NOT NULL
      WHERE ${PAGE_SEARCH_LIVE_IN_PROJECT(projectId)}`;
    /* istanbul ignore next -- an aggregate with no GROUP BY always returns one row. */
    const row = rows[0] ?? { embedded: BigInt(0), total: BigInt(0) };
    return { embedded: Number(row.embedded), total: Number(row.total) };
  },

  /**
   * Rank a project's live, embedded pages against a query vector, nearest first,
   * at most `limit`. TWO STAGES, as `workItemEmbeddingRepository.rankByEmbedding`
   * explains: the distance ordering and the LIMIT in the inner query, which the
   * HNSW index can serve, and the id tiebreak outside over at most `limit` rows.
   * Every filter — the live-in-project predicate included — stays INSIDE, so an
   * archived page can never occupy a slot.
   */
  async rankByEmbedding(
    input: RankPagesByEmbeddingInput,
    tx: Prisma.TransactionClient,
  ): Promise<PageEmbeddingRankRow[]> {
    const query = vectorLiteral(input.queryEmbedding);
    const rows = await tx.$queryRaw<PageEmbeddingRankRow[]>(Prisma.sql`
      SELECT c."pageId", c."distance"
      FROM (
        SELECT e."page_id" AS "pageId",
               (e."embedding" <=> ${query}::vector)::float8 AS "distance"
        FROM "page_embedding" e
        JOIN "page" p ON p."id" = e."page_id"
        WHERE ${rankable(input.projectId, input.model)}
        ORDER BY e."embedding" <=> ${query}::vector ASC
        LIMIT ${input.limit}
      ) c
      ORDER BY c."distance" ASC, c."pageId" ASC`);
    return rows.map((row) => ({ pageId: row.pageId, distance: Number(row.distance) }));
  },

  /**
   * Widen this transaction's HNSW candidate pool for a page of `limit` results
   * (`SET LOCAL`, so it dies with the transaction). `SET` takes no bind
   * parameters, so the value is interpolated — and it is `efSearchForLimit` of an
   * integer, provably a number inside pgvector's accepted range.
   */
  async setEfSearchForLimit(limit: number, tx: Prisma.TransactionClient): Promise<number> {
    const value = efSearchForLimit(Math.max(1, Math.trunc(Number(limit)) || 1));
    return tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${value}`);
  },

  /** Disable the ordered index path for this transaction, so the next ranking is EXACT. */
  async disableOrderedIndexScan(tx: Prisma.TransactionClient): Promise<number> {
    return tx.$executeRaw`SET LOCAL enable_indexscan = off`;
  },
};
