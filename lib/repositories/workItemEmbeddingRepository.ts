import { Prisma, type WorkItemEmbedding } from '@/generated/prisma/client';

// Single-Prisma-op leaves for the plan-tree semantic-search sidecar (Story
// MOTIR-2694 · Subtask MOTIR-2696, per `docs/decisions/plan-tree-embeddings.md`
// §4/§5). No business logic here — the compose → hash → skip-or-embed → upsert
// orchestration lives in `workItemEmbeddingsService`.
//
// ⚠️ `embedding` is `Unsupported("vector(1536)")`, so the typed Prisma client can
// neither read, write nor order by it — the same constraint `motir-ai`'s
// `lessonRepository` works under, and this file mirrors its shape:
//   - the typed columns are read with the normal client,
//   - the row (typed columns AND the vector, together) is written with
//     `$executeRaw`,
//   - similarity ranking is a `$queryRaw` with the `<=>` cosine operator.
// In every one of those the vector crosses as its pgvector TEXT LITERAL
// (`[0.1,0.2,…]`), BOUND AS A PARAMETER and cast to `vector` — never
// string-concatenated into the SQL.
//
// Every method takes the caller's `tx`, because every one of them must run
// inside a workspace context: the table's RLS policy reads
// `current_setting('app.workspace_id')`, which is bound by
// `withWorkspaceContext` / `withWorkspaceServiceContext` on the transaction.
// Outside one, the predicate is NULL and the table is simply empty — a silent
// wrong answer, which is why there is no `db`-singleton convenience overload
// here.

/** The pinned vector dimension — `text-embedding-3-small` at N = 1536. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * pgvector's own default `hnsw.ef_search`. Used as the floor so this code can
 * only ever WIDEN the search, never narrow it below the server's default.
 */
const HNSW_EF_SEARCH_DEFAULT = 40;

/**
 * How many index candidates to collect per requested result. Four is a
 * deliberately mild widening: it makes the approximate pass return a full page
 * in the ordinary case (so the exact fallback below stays rare) without turning
 * every query into a near-exhaustive scan. It is a COST knob, not a correctness
 * one — correctness is the fallback's job, so this number can be tuned later
 * without anything depending on its value.
 */
const HNSW_EF_SEARCH_PER_RESULT = 4;

/** pgvector's own ceiling for `hnsw.ef_search`. */
const HNSW_EF_SEARCH_MAX = 1000;

/** The `hnsw.ef_search` to use for a page of `limit` results. */
export function efSearchForLimit(limit: number): number {
  return Math.min(
    HNSW_EF_SEARCH_MAX,
    Math.max(HNSW_EF_SEARCH_DEFAULT, limit * HNSW_EF_SEARCH_PER_RESULT),
  );
}

/** A work item's embedded row as the typed client can see it (no vector). */
export type WorkItemEmbeddingRow = WorkItemEmbedding;

export interface UpsertEmbeddingInput {
  workItemId: string;
  workspaceId: string;
  projectId: string;
  model: string;
  dimensions: number;
  contentHash: string;
  embeddedAt: Date;
  embedding: number[];
}

/** One row of the backfill scan. The two failure columns are present only when
 *  the scan was asked for them (`withFailureState`). */
export interface BackfillScanRow {
  id: string;
  title: string;
  descriptionMd: string | null;
  contentHash: string | null;
  embeddingFailedHash?: string | null;
  embeddingFailedAttempts?: number | null;
}

/** One ranked row — the item's identity plus its cosine DISTANCE to the query. */
export interface WorkItemEmbeddingRankRow {
  workItemId: string;
  identifier: string;
  title: string;
  /** Cosine distance (`<=>`), lower = more similar. Converted to a SIMILARITY
   *  score exactly once, at the DTO boundary, by the endpoint that returns it. */
  distance: number;
}

export interface RankByEmbeddingInput {
  projectId: string;
  /** The model to rank IN — a hard filter (ADR §6.1), never a label: rows
   *  embedded with a different model are not comparable to this query's vector. */
  model: string;
  queryEmbedding: number[];
  limit: number;
}

/** The pgvector text literal for a vector, to be BOUND and cast — never inlined. */
function vectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

export const workItemEmbeddingRepository = {
  /**
   * Write (or replace) an item's embedding — the typed columns AND the vector in
   * ONE statement, so a row without a vector is never created and "the row
   * exists" is exactly "this item is a candidate" (ADR §4).
   *
   * `ON CONFLICT (work_item_id) DO UPDATE` makes the job idempotent at the
   * database: a retried job, or two jobs racing after two rapid edits, converge
   * on one row rather than erroring on the PK. `$executeRaw` (not the typed
   * client) because the vector column is `Unsupported`.
   */
  async upsert(input: UpsertEmbeddingInput, tx: Prisma.TransactionClient): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO "work_item_embedding" (
        "work_item_id", "workspace_id", "project_id", "model", "dimensions",
        "content_hash", "embedded_at", "embedding"
      ) VALUES (
        ${input.workItemId}, ${input.workspaceId}, ${input.projectId}, ${input.model},
        ${input.dimensions}, ${input.contentHash}, ${input.embeddedAt},
        ${vectorLiteral(input.embedding)}::vector
      )
      ON CONFLICT ("work_item_id") DO UPDATE SET
        "workspace_id" = EXCLUDED."workspace_id",
        "project_id"   = EXCLUDED."project_id",
        "model"        = EXCLUDED."model",
        "dimensions"   = EXCLUDED."dimensions",
        "content_hash" = EXCLUDED."content_hash",
        "embedded_at"  = EXCLUDED."embedded_at",
        "embedding"    = EXCLUDED."embedding"`;
  },

  /** The stored derivation for one item, or null when it is not a candidate yet. */
  async findByWorkItemId(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemEmbeddingRow | null> {
    return tx.workItemEmbedding.findUnique({ where: { workItemId } });
  },

  /**
   * How many of a project's items are RANKABLE for this model — the numerator of
   * ADR §6.1's `coverage`, and the number the under-return fallback compares its
   * result count against.
   *
   * ⚠️ ITS PREDICATE MUST STAY IDENTICAL TO {@link rankByEmbedding}'s, down to the
   * archived join — hence the duplication instead of a plain count on this table
   * alone. The fallback fires when the ranking returns fewer rows than this
   * number, so a count that is merely CLOSE is worse than useless: counting
   * archived items here (whose rows are kept, ADR §5, but which never rank) would
   * make every query in a project with one archived item under-return by
   * definition, and the exact re-run would fire on every single call.
   */
  async countRankable(
    projectId: string,
    model: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS "count"
      FROM "work_item_embedding" e
      JOIN "work_item" w ON w."id" = e."work_item_id"
      WHERE e."project_id" = ${projectId}
        AND e."model" = ${model}
        AND e."embedding" IS NOT NULL
        AND w."archivedAt" IS NULL`;
    /* istanbul ignore next -- an aggregate with no GROUP BY always returns exactly
       one row, so the `?? 0` arm is unreachable; it exists only to satisfy the
       index signature's `T | undefined`. */
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * One page of a project's work items with the embedding state each one
   * currently has — the backfill's scan.
   *
   * It returns EVERY item rather than pre-filtering to the ones that need work,
   * because "needs embedding" is a comparison against a hash the SERVICE
   * computes (the composed document is a pure function this layer has no
   * business knowing). So the SQL supplies the facts — the two source fields and
   * the stored `content_hash`, null when there is no row — and the service
   * decides. That keeps the repository a single Prisma op with no business
   * logic (the 4-layer rule) and keeps ONE definition of the document in
   * `lib/workItems/embeddingDocument.ts`.
   *
   * Archived items are INCLUDED by default: their embeddings are kept (ADR §5) so
   * un-archiving restores candidacy without a re-embed, and an archived item
   * that was never embedded would otherwise be a permanent hole that
   * un-archiving could not fill. The ranking read is where archived items are
   * excluded, not here. The operator backfill keeps that behaviour; the
   * scheduled sweep passes `excludeArchived` because it spends a metered call
   * per item and an archived item never ranks.
   *
   * `withFailureState` adds the two poison-item columns (`embeddingFailedHash`,
   * `embeddingFailedAttempts`) so the sweep can skip an item it has given up on.
   * Off by default, which keeps every existing caller's rows exactly as they were.
   *
   * Keyset-paged on `id` (`afterId` exclusive, ordered ascending) rather than
   * OFFSET: the backfill WRITES as it goes, and an offset page over a set the
   * writer is changing skips rows.
   */
  async listForBackfill(
    input: {
      projectId: string;
      afterId: string | null;
      limit: number;
      excludeArchived?: boolean;
      withFailureState?: boolean;
    },
    tx: Prisma.TransactionClient,
  ): Promise<BackfillScanRow[]> {
    const after = input.afterId === null ? Prisma.empty : Prisma.sql`AND w."id" > ${input.afterId}`;
    const live = input.excludeArchived ? Prisma.sql`AND w."archivedAt" IS NULL` : Prisma.empty;
    const failure = input.withFailureState
      ? Prisma.sql`, w."embedding_failed_hash" AS "embeddingFailedHash", w."embedding_failed_attempts" AS "embeddingFailedAttempts"`
      : Prisma.empty;
    return tx.$queryRaw<BackfillScanRow[]>(Prisma.sql`
      SELECT w."id", w."title", w."descriptionMd", e."content_hash" AS "contentHash"${failure}
      FROM "work_item" w
      LEFT JOIN "work_item_embedding" e ON e."work_item_id" = w."id"
      WHERE w."projectId" = ${input.projectId}
        ${live}
        ${after}
      ORDER BY w."id" ASC
      LIMIT ${input.limit}`);
  },

  /**
   * Record that the provider refused this item's document: remember WHICH
   * document (`hash`) and how many runs have refused it. The count is
   * incremented when the stored failed hash is the same document and restarts at
   * 1 for any other — so an edited item is a fresh item with no cleanup. Raw SQL
   * on purpose: it bumps no `updatedAt` and goes through no work-item event.
   */
  async recordEmbeddingFailure(
    input: { workItemId: string; hash: string },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      UPDATE "work_item" SET
        "embedding_failed_attempts" = CASE
          WHEN "embedding_failed_hash" = ${input.hash}
          THEN COALESCE("embedding_failed_attempts", 0) + 1
          ELSE 1
        END,
        "embedding_failed_hash" = ${input.hash}
      WHERE "id" = ${input.workItemId}`;
  },

  /**
   * Forget the poison-item bookkeeping of items that have now embedded. The
   * `IS NOT NULL` guard makes the common case — an item that never failed — write
   * nothing at all, rather than rewriting NULL over NULL for every embed.
   */
  async clearEmbeddingFailures(
    workItemIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (workItemIds.length === 0) return 0;
    return tx.$executeRaw(Prisma.sql`
      UPDATE "work_item" SET
        "embedding_failed_hash" = NULL,
        "embedding_failed_attempts" = NULL
      WHERE "id" IN (${Prisma.join(workItemIds)})
        AND ("embedding_failed_hash" IS NOT NULL OR "embedding_failed_attempts" IS NOT NULL)`);
  },

  /**
   * Rank a project's embedded items against a query vector, nearest first.
   *
   * ONE `$queryRaw`, top-N, no unbounded load and no in-app brute force. The
   * `model` filter is applied BEFORE the ordering because two vectors from
   * different models are not comparable (ADR §6.1). Archived items are excluded
   * from RESULTS while their rows are kept (ADR §5).
   *
   * ⚠️ TWO STAGES, AND THE SPLIT IS LOAD-BEARING — the ADR's ordering is
   * `distance ASC, identifier ASC`, and a SECOND sort key makes the ANN index
   * unable to serve the ordering at all. Measured on pgvector 0.8.6: with both
   * keys in one `ORDER BY`, Postgres plans a full `Sort` and never touches
   * `work_item_embedding_embedding_idx` — not when the alternatives are disabled,
   * not with incremental sort enabled, not at any table size. That would make the
   * ADR's own reason for the index ("without it the `<=>` ORDER BY is a
   * brute-force scan") false of this query, and would ship an index that costs
   * every write and serves no read.
   *
   * So the DISTANCE ordering and the LIMIT live in the inner query, which the
   * index CAN serve, and the identifier tiebreak is applied by the outer sort
   * over at most `limit` rows. Both filters — including `archivedAt` — stay
   * INSIDE, so an archived row can never occupy a slot in the page.
   *
   * ⚠️ And this is the approximate pass: an index the planner can use is an index
   * that can under-return under the pre-filter. See {@link disableOrderedIndexScan}.
   */
  async rankByEmbedding(
    input: RankByEmbeddingInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemEmbeddingRankRow[]> {
    const query = vectorLiteral(input.queryEmbedding);
    return tx.$queryRaw<WorkItemEmbeddingRankRow[]>(Prisma.sql`
      SELECT c."workItemId", c."identifier", c."title", c."distance"
      FROM (
        SELECT e."work_item_id" AS "workItemId",
               w."identifier",
               w."title",
               (e."embedding" <=> ${query}::vector) AS "distance"
        FROM "work_item_embedding" e
        JOIN "work_item" w ON w."id" = e."work_item_id"
        WHERE e."project_id" = ${input.projectId}
          AND e."model" = ${input.model}
          AND e."embedding" IS NOT NULL
          AND w."archivedAt" IS NULL
        ORDER BY e."embedding" <=> ${query}::vector ASC
        LIMIT ${input.limit}
      ) c
      ORDER BY c."distance" ASC, c."identifier" ASC`);
  },

  /**
   * Widen this transaction's HNSW candidate pool.
   *
   * `SET LOCAL`, so it dies with the transaction and cannot leak onto the next
   * borrower of the pooled connection. `hnsw.ef_search` is a two-part GUC name,
   * so Postgres accepts it as a placeholder even in a session that has not yet
   * loaded pgvector's library, and the extension adopts the value when it does.
   *
   * `SET` takes no bind parameters, so the value is INTERPOLATED — and is
   * therefore clamped to an integer in pgvector's own accepted range first, so
   * the interpolated text is provably a number whatever a caller passes.
   */
  async setEfSearch(efSearch: number, tx: Prisma.TransactionClient): Promise<number> {
    const value = Math.min(
      HNSW_EF_SEARCH_MAX,
      Math.max(HNSW_EF_SEARCH_DEFAULT, Math.trunc(Number(efSearch)) || HNSW_EF_SEARCH_DEFAULT),
    );
    return tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${value}`);
  },

  /**
   * Take the ordered-index path away from the planner for the rest of this
   * transaction, so the NEXT {@link rankByEmbedding} is an EXACT scan.
   *
   * ⚠️ THIS IS THE PINNED MITIGATION FOR HNSW'S PRE-FILTER UNDER-RETURN (ADR
   * Consequences). An approximate index scan collects its candidates BEFORE
   * `project_id` and `model` are applied, so a small project inside a large
   * table can come back with fewer than `limit` rows — the ranking silently
   * loses real candidates, which is the exact failure GATE 1 already had and
   * this whole story exists to remove. `setEfSearch` above makes that rarer; it
   * cannot make it impossible.
   *
   * The service therefore compares what the approximate pass returned against
   * what the project actually holds (`countRankable`) and, when it under-returns,
   * calls this and re-runs the SAME query. Without the ordered index the planner
   * must scan and sort, which is exact by construction — so the guarantee is
   * "never fewer than `min(limit, rankable)` rows", at any table size.
   *
   * **Why this rather than `hnsw.iterative_scan`**, which the ADR names first:
   * iterative scans need pgvector 0.8+, and setting an undefined GUC in a
   * session where pgvector IS loaded is an ERROR, not a no-op. motir-core is
   * open-core and self-hostable, so pinning the guarantee to a version floor
   * would mean either a version probe on every query or a hard failure on an
   * older build — for a feature that is otherwise pure storage. `enable_indexscan`
   * is core Postgres, present everywhere, and gives a STRONGER guarantee than
   * `relaxed_order` does. The cost is one extra query in the rare case the cheap
   * pass came up short, paid only then.
   *
   * (This is NOT a guess about availability: production is Amazon RDS for
   * PostgreSQL 18, whose pgvector is 0.8.x, and the CI/dev image is
   * `pgvector/pgvector:pg18` — iterative scans WOULD work on both. The point is that neither is the whole audience for
   * an open-source repo, and a guarantee that holds on every build costs nothing
   * more than one that holds on most.)
   */
  async disableOrderedIndexScan(tx: Prisma.TransactionClient): Promise<number> {
    return tx.$executeRaw`SET LOCAL enable_indexscan = off`;
  },
};
