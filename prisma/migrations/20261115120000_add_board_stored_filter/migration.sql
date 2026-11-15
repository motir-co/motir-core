-- Board stored filter (MOTIR-10560 · MOTIR-11330). A board can carry its OWN
-- filter, set by a board admin and applied for every reader.
--
-- `board.filter` is a nullable JSONB holding the stored `FilterEnvelope`
-- (`{ v, c, f }`) saved filters already persist in `saved_filter.ast_envelope`,
-- written and read through the one codec in `lib/filters/ast.ts`. NULL means
-- "no stored filter": every existing board reads NULL after this migration and
-- shows exactly what it showed before, so there is NO default and NO backfill.
--
-- NO new table and NO RLS change: the column lives on the already-ENABLE+FORCE
-- RLS `board` table (20260606120000_add_boards_and_rls), so tenant isolation is
-- inherited. No index (the column is read per board row, never searched) and no
-- CHECK on the JSON shape (the write path validates through the codec).

-- AlterTable
ALTER TABLE "board" ADD COLUMN "filter" JSONB;
