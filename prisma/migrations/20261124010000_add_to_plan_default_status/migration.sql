-- ============================================================
-- Backfill the `to_plan` default-workflow status (MOTIR-12174).
-- ============================================================
-- MOTIR-12174 adds a TENTH status to the default workflow
-- (lib/workflows/defaultWorkflow.ts): `to_plan`, label `To plan`, in the
-- **in_progress** category, immediately after `planning`.
--
-- What is missing without it: a card planned against a decision that was later
-- corrected has nowhere to say so. Its description is out of date, yet it reads
-- To Do and the next run claims it and builds the stale version.
--
-- The **in_progress** category is load-bearing, the same reasoning `planning`
-- (20260807220000), `implemented` (20260819090000) and `approved`
-- (20260911140000) used: both claim doors take only the `todo` category, so a
-- card here leaves the pickable set STRUCTURALLY; and only the `done` category
-- is terminal (`lib/workItems/blockerReadiness.ts`'s `isOpenBlocker`), so it
-- stays open in every count and its dependents stay blocked.
--
-- New projects get it from `seedDefaultWorkflow`. This migration gives it to
-- every EXISTING project — three writes per project, each idempotent, each
-- guarded so a CUSTOM workflow is left alone. It MOVES NO CARD: it adds a state,
-- and the mark that puts cards in it is a separate change.

-- ── 1. The status ───────────────────────────────────────────────────────────
-- Position: `planning.position || 'V'`, which sorts the new status BETWEEN
-- `planning` and `in_review` — the board slot the design settles (slot 6,
-- `design/boards/board--to-plan-status.mock.html` panel 1). DERIVED for each
-- project shape this has to work on:
--
--   • a project BACKFILLED by 20260807220000 + 20260819090000 + 20260911140000
--     (the live moooon/motir project is one) has
--       todo=a0  blocked=a1  in_progress=a2  implemented=a2F  planning=a2V
--       in_review=a3  approved=a3F  done=a4  cancelled=a5
--     →  'a2V' < 'a2VV' < 'a3'                                 ✓
--
--   • a project SEEDED FRESH after 20260819090000 and backfilled by
--     20260911140000 has
--       todo=a0  blocked=a1  in_progress=a2  implemented=a3  planning=a4
--       in_review=a5  approved=a5F  done=a6  cancelled=a7
--     →  'a4' < 'a4V' < 'a5'                                   ✓
--
--   • a project SEEDED FRESH after 20260911140000 has nine sequential keys
--       …implemented=a3  planning=a4  in_review=a5  approved=a6  done=a7
--     →  'a4' < 'a4V' < 'a5'                                   ✓
--
-- Appending a character to `planning`'s key always sorts after it (a strict
-- prefix sorts first), and it sorts before `in_review` because the two keys
-- already differ at an earlier character. 'V' is the midpoint letter the
-- earlier backfills used; it is free here because no shipped backfill appends
-- to `planning`'s key.
--
-- A project seeded fresh AFTER this migration gets ten sequential keys
-- (…planning=a4  to_plan=a5  in_review=a6…) and is skipped by the NOT EXISTS
-- guard below, as it should be.
--
-- The `planning`-key join leaves CUSTOM workflows untouched: a project that
-- renamed or removed `planning` does not match, and gets nothing. Idempotent via
-- the NOT EXISTS guard. Ids are fresh uuids (the columns are plain `text`),
-- mirroring the migrations this one is modelled on.
INSERT INTO "workflow_status" (
  "id", "workspace_id", "project_id", "key", "label", "category",
  "position", "is_initial", "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  pl."workspace_id",
  pl."project_id",
  'to_plan',
  'To plan',
  'in_progress'::"status_category",
  pl."position" || 'V',
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "workflow_status" pl
WHERE pl."key" = 'planning'
  AND NOT EXISTS (
    SELECT 1 FROM "workflow_status" s
    WHERE s."project_id" = pl."project_id" AND s."key" = 'to_plan'
  );

-- ── 2. The five edges ───────────────────────────────────────────────────────
-- TWO in — `todo → to_plan`, `blocked → to_plan`: the mark moves only work
-- nobody has started. THREE out — `to_plan → planning` (a plan naming the card
-- parks it), `to_plan → todo` (a person decides it is fine as written) and
-- `to_plan → cancelled` (cancellation is legal from every non-terminal state).
--
-- ⚠️ DELIBERATELY ABSENT: `to_plan → blocked`, `to_plan → in_progress`,
-- `to_plan → done` (a stale card must not be started or closed without being
-- re-planned), and `planning → to_plan` (a declined plan restores the card by a
-- system write, which skips the edge check).
-- `tests/workflows/to-plan-status.test.ts` asserts the set and the absences.
--
-- Enumerated rather than generated so this file states the same graph
-- `DEFAULT_TRANSITIONS` does. A project missing an endpoint status gets fewer
-- edges: the join finds no row and that pair is skipped.
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
  ('todo', 'to_plan'),
  ('blocked', 'to_plan'),
  ('to_plan', 'planning'),
  ('to_plan', 'todo'),
  ('to_plan', 'cancelled')
) AS edge(from_key, to_key)
JOIN "workflow_status" fs ON fs."key" = edge.from_key
JOIN "workflow_status" ts ON ts."project_id" = fs."project_id" AND ts."key" = edge.to_key
WHERE NOT EXISTS (
  SELECT 1 FROM "workflow_transition" t
  WHERE t."project_id" = fs."project_id"
    AND t."from_status_id" = fs."id"
    AND t."to_status_id" = ts."id"
);

-- ── 3. A board column, on every board that mirrors the default 1:1 ──────────
-- `buildDefaultBoard` projects one column per status, so a NEW project's board
-- carries a To plan column for free. An existing board does not, and
-- `boardsService.getBoard` builds its columns and its total from MAPPED status
-- keys alone — a card moved to `to_plan` would sit in no column.
--
-- ⚠️ Scoped to boards that still look DEFAULT: exactly one column per OTHER
-- status of this project, each mapped to exactly one status. A board an admin
-- merged or split is left alone — this migration cannot know where the column
-- belongs in a layout somebody designed. Such a board keeps working; its owner
-- adds the column when they want it.
INSERT INTO "board_column" (
  "id", "workspace_id", "project_id", "board_id", "name", "position",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  ps."workspace_id",
  ps."project_id",
  b."id",
  'To plan',
  ps."position",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "workflow_status" ps
JOIN "board" b ON b."project_id" = ps."project_id"
WHERE ps."key" = 'to_plan'
  AND (SELECT COUNT(*) FROM "board_column" c WHERE c."board_id" = b."id")
      = (SELECT COUNT(*) FROM "workflow_status" s
         WHERE s."project_id" = ps."project_id" AND s."key" <> 'to_plan')
  AND NOT EXISTS (
    SELECT 1 FROM "board_column" c
    WHERE c."board_id" = b."id"
      AND (SELECT COUNT(*) FROM "board_column_status" m WHERE m."column_id" = c."id") <> 1
  )
  -- Idempotent: nothing to do once this status is mapped on this board.
  AND NOT EXISTS (
    SELECT 1 FROM "board_column_status" m
    WHERE m."board_id" = b."id" AND m."status_id" = ps."id"
  );

INSERT INTO "board_column_status" (
  "id", "workspace_id", "project_id", "board_id", "column_id", "status_id", "created_at"
)
SELECT
  gen_random_uuid()::text,
  c."workspace_id",
  c."project_id",
  c."board_id",
  c."id",
  ps."id",
  CURRENT_TIMESTAMP
FROM "board_column" c
JOIN "workflow_status" ps
  ON ps."project_id" = c."project_id" AND ps."key" = 'to_plan'
WHERE c."name" = 'To plan'
  AND NOT EXISTS (
    SELECT 1 FROM "board_column_status" m WHERE m."column_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "board_column_status" m
    WHERE m."board_id" = c."board_id" AND m."status_id" = ps."id"
  );
