-- ============================================================
-- Backfill the two default edges OUT of `todo` that a delivering pull request
-- needs (MOTIR-12202).
-- ============================================================
-- The default workflow (lib/workflows/defaultWorkflow.ts, `DEFAULT_TRANSITIONS`)
-- gains two edges and NO status:
--
--   • `todo → implemented` — linking (or opening) an open, non-draft pull request
--     on a card that still reads To Do records it as built, as it does from In
--     Progress (`changeRequestStatusSync`'s OPENED lifecycle);
--   • `todo → in_review`   — the CI-green latch (`ciPromotion`), when that pull
--     request's whole set is green, takes the card straight to review and raises
--     its approve-to-merge question.
--
-- Without them both moves were refused as undeclared hops — silently, as
-- `illegal_transition` — and so was the merge's `→ done`, which left a delivered
-- card at To Do after its code shipped (MOTIR-12189). With them, the merge
-- completes the card through the existing `implemented → done` / `in_review → done`.
--
-- New projects get the edges from `seedDefaultWorkflow`, which iterates the
-- constant. This migration gives every EXISTING project the same two.
--
-- ⚠️ EDGES ONLY — no status and no board column: `todo`, `implemented` and
-- `in_review` all exist already.
--
-- ⚠️ PER EDGE, joined on status KEY. Each edge is added to every project whose
-- workflow has BOTH of its endpoints (`todo` and the target) and does not already
-- declare it — the pattern of 20260819090000_add_implemented_default_status's
-- step 2. A project that renamed or removed one endpoint gets no row for that
-- edge, which is what leaves a CUSTOM workflow's graph alone; unlike the ejection
-- backfill (20260916180000) the two edges are independent of each other, so a
-- project carrying only one target still gets the edge into it.
--
-- Idempotent: a second run finds every edge and inserts zero rows. Ids are fresh
-- uuids (the columns are plain `text`), mirroring the migrations this one is
-- modelled on. `tests/workflows/todo-delivery-edges.test.ts` runs this file
-- against seeded projects (a default one, a custom one with a renamed target, and
-- one already holding an edge) and runs it twice.
INSERT INTO "workflow_transition" (
  "id", "workspace_id", "project_id", "from_status_id", "to_status_id", "created_at"
)
SELECT
  gen_random_uuid()::text,
  fs."workspace_id",
  fs."project_id",
  fs."id",
  ts."id",
  CURRENT_TIMESTAMP
FROM (VALUES
  ('todo', 'implemented'),
  ('todo', 'in_review')
) AS edge(from_key, to_key)
JOIN "workflow_status" fs ON fs."key" = edge.from_key
JOIN "workflow_status" ts ON ts."project_id" = fs."project_id" AND ts."key" = edge.to_key
WHERE NOT EXISTS (
  SELECT 1 FROM "workflow_transition" t
  WHERE t."project_id" = fs."project_id"
    AND t."from_status_id" = fs."id"
    AND t."to_status_id" = ts."id"
);
