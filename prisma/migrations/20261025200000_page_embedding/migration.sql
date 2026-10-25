-- The page SEMANTIC INDEX (Story MOTIR-9490 · MOTIR-9570). The page twin of
-- `work_item_embedding` (20260811230000_add_work_item_embedding), and the same
-- contract (`docs/decisions/plan-tree-embeddings.md`): one row per page holding
-- the vector derived from the page's title + `body_text`, shipped in ONE step
-- with its RLS policy so there is never an unguarded window.
--
-- HAND-WRITTEN for the same reasons as the work-item table: Prisma cannot emit
-- an index over the `Unsupported` vector column, and `migrate dev` is
-- interactive. The `vector` extension already exists (the work-item migration
-- created it); `IF NOT EXISTS` keeps a fresh replay order-independent.
--
-- Delete semantics: `page_id` CASCADE (the derivation dies with the page — the
-- PK IS the FK), `workspace_id` and `project_id` CASCADE. All three are Prisma
-- `@relation`s with the same actions, so `migrate diff` reports no drift.
--
-- ABSENCE IS THE SEMANTICS: a page with no row is not a semantic candidate, and
-- is still found by full-text. `embedding` is nullable only because Prisma
-- cannot create a required `Unsupported` column; the writer upserts the row and
-- its vector in one statement.

CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "page_embedding" (
    "page_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "embedded_at" TIMESTAMPTZ(3) NOT NULL,
    "embedding" vector(1536),

    CONSTRAINT "page_embedding_pkey" PRIMARY KEY ("page_id")
);

-- CreateIndex
CREATE INDEX "page_embedding_workspace_id_idx" ON "page_embedding"("workspace_id");

-- CreateIndex
CREATE INDEX "page_embedding_project_id_model_idx" ON "page_embedding"("project_id", "model");

-- AddForeignKey
ALTER TABLE "page_embedding" ADD CONSTRAINT "page_embedding_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_embedding" ADD CONSTRAINT "page_embedding_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_embedding" ADD CONSTRAINT "page_embedding_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security — the SAME pure workspace gate as `work_item_embedding`:
-- one PERMISSIVE FOR ALL policy against `current_setting('app.workspace_id',
-- true)` (an unset GUC yields NULL, so every row is hidden — the safe failure).
-- ENABLE + FORCE so the table owner is subject to it too. The ranking read
-- narrows on `project_id` in the QUERY, through `PAGE_SEARCH_LIVE_IN_PROJECT`.
-- Grants come from the workspace RLS migration's ALTER DEFAULT PRIVILEGES.
ALTER TABLE "page_embedding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "page_embedding" FORCE ROW LEVEL SECURITY;

CREATE POLICY "page_embedding_active_workspace" ON "page_embedding"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- CreateIndex (HAND-WRITTEN — HNSW over the vector with cosine ops, matching the
-- `<=>` the ranking read orders by). It under-returns under a pre-filter; the
-- repository's exact-scan fallback handles that, as for work items.
CREATE INDEX IF NOT EXISTS "page_embedding_embedding_idx"
  ON "page_embedding" USING hnsw ("embedding" vector_cosine_ops);
