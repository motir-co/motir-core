-- MOTIR-10315 — link every published decision page to its card.
--
-- `decisionPageService.publish` now writes the pair's hand link (`manual`) in the
-- same transaction as the publication, so the card's Pages section — and
-- `get_work_item`, which reads the same set — shows the decision page. Every
-- publication made before that left the card with no link, so a follow-up on a
-- settled decision read a card with no page at all. This writes the link the
-- publish now writes, for each (card, page) pair any publication names.
--
-- One row per pair, whatever number of publications or versions it holds:
-- `DISTINCT ON` takes the pair's FIRST publication, whose publisher and time become
-- the link's `created_by_id` and `created_at` — who linked it, and when.
--
-- A pair already linked by hand keeps its row (`ON CONFLICT … DO NOTHING` on the
-- table's `(page_id, work_item_id, source)` key), and a pair linked by mention or
-- embed gains the `manual` row beside it, which the Pages section groups into the
-- ONE entry it already shows. No revision is written and `updated_at` is not
-- touched: this records a link the publish owed, it is not an edit of the card.
--
-- IDEMPOTENT BY CONSTRUCTION: a second run finds every pair already linked and
-- inserts nothing. One statement, so the migration test replays it verbatim
-- (`tests/decisionPageLinkBackfill.test.ts`).
INSERT INTO "page_work_item_link"
  ("id", "workspace_id", "project_id", "page_id", "work_item_id", "source", "created_by_id", "created_at")
SELECT gen_random_uuid()::text,
       first."workspace_id",
       first."project_id",
       first."page_id",
       first."work_item_id",
       'manual'::"page_work_item_link_source",
       first."published_by_id",
       first."published_at"
  FROM (
    SELECT DISTINCT ON (pub."work_item_id", pub."page_id")
           pub."workspace_id",
           pub."project_id",
           pub."page_id",
           pub."work_item_id",
           pub."published_by_id",
           pub."published_at"
      FROM "decision_page_publication" pub
     ORDER BY pub."work_item_id", pub."page_id", pub."published_at" ASC, pub."id" ASC
  ) AS first
ON CONFLICT ("page_id", "work_item_id", "source") DO NOTHING;
