-- ===========================================================================
-- Clear the leaf-only `type` / `executor` from every EPIC and STORY (MOTIR-11838)
-- ===========================================================================
-- WHY THIS EXISTS. An epic or story is a container: only the leaf kinds (task,
-- subtask, bug) may carry a `type` or an `executor` — the rule
-- `workItemsService.assertTypeKindConsistent` enforces on every service write.
-- Plan approval's `materialize` writes the created row directly, bypassing that
-- service, and copied a proposal's `executor` (and `type`) onto every `add`
-- whatever its kind. A container stored that way could then not be edited at
-- all: `updateWorkItem` re-checks the card's state after every patch with the
-- stored executor carried over, so a re-parent, a rename or any other edit was
-- refused TYPE_NOT_ALLOWED_ON_KIND — for a field the item page does not show
-- on a story or epic, so the person could neither see nor clear it.
--
-- The code fix drops both fields on a container at materialize from now on;
-- this repairs the rows written before it.
--
-- THE PREDICATE. `kind IN ('epic', 'story')` is exactly the complement of
-- `TYPEABLE_KINDS` (lib/issues/executorDefaults.ts), and only a row still
-- carrying one of the two values is touched, so a clean row is not rewritten.
-- `difficulty` is not cleared here: every write door, approve included, already
-- refuses it on a container (`difficulty_on_container`).
--
-- NOT TENANT-GUARDED, deliberately: the bad value is the product's own bug on
-- any deployment that approved such a plan, and clearing it invents nothing. On
-- a fresh / CI / preview database the predicate matches zero rows.
--
-- IDEMPOTENT BY CONSTRUCTION: the write nulls both columns, which takes every
-- matched row out of its own predicate, so a second apply touches zero rows.
--
-- Reports the blast radius as a NOTICE so the release log carries the number.
-- Covered by tests/integration/migrations/clear-container-type-executor.test.ts.
-- ===========================================================================
DO $$
DECLARE
  cleared_rows bigint;
BEGIN
  UPDATE "work_item"
     SET "type" = NULL,
         "executor" = NULL
   WHERE "kind" IN ('epic', 'story')
     AND ("type" IS NOT NULL OR "executor" IS NOT NULL);

  GET DIAGNOSTICS cleared_rows = ROW_COUNT;
  RAISE NOTICE 'MOTIR-11838: cleared a leaf-only type/executor from % epic/story work_item row(s)', cleared_rows;
END
$$;
