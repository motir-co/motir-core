-- MOTIR-10104 — repair the item links a card's saved body still carries in the
-- PROPOSAL scheme.
--
-- A plan's bodies name a sibling proposal as `[label](motir-ref:planItem:<id>)`,
-- and approve rewrites that token to the card the proposal became,
-- `[label](motir:<workItemId>)` (MOTIR-1418). Two spellings escaped the rewrite and
-- were saved onto committed cards as dead text:
--
--   * `[label](motir-ref:<id>)` — the `planItem:` prefix missing. Approve matched
--     only the canonical token, so it never rewrote these; MOTIR-6494 has refused
--     the shape at the append since 2026-09-26, but never repaired a body already
--     saved (523 cards).
--   * `[label](motir-ref:planItem:<id>)` whose id approve could not resolve when it
--     ran — left inert by design (`rewriteIntraPlanRefs`).
--
-- A re-plan that rewrites one of those bodies starts from text the append warns
-- about, and the planning session cannot know which card each label meant. The
-- server can: `plan_item.work_item_id` of an `add` is the card it created. So every
-- such link whose id is a materialized `add` in the card's own workspace is
-- rewritten to `[label](motir:<that card's id>)`, exactly as approve would have.
--
-- A link whose id resolves to nothing is NEVER guessed at: it is left as it is and
-- reported, one `RAISE NOTICE` per link naming the card, the field and the token,
-- followed by one summary notice. `updatedAt` is not touched — this repairs a
-- rewrite approve owed, it is not an edit of the card.
--
-- One `DO` block, so the file is a single statement (the migration test replays it
-- verbatim through one `$executeRawUnsafe`). Re-running it changes nothing: a
-- repaired link is a `motir:` link and no longer matches.
DO $$
DECLARE
  wi RECORD;
  m TEXT[];
  fields TEXT[] := ARRAY['descriptionMd', 'explanationMd'];
  i INT;
  body TEXT;
  rewritten TEXT;
  token TEXT;
  target TEXT;
  new_description TEXT;
  new_explanation TEXT;
  rewrote_links INT := 0;
  rewrote_cards INT := 0;
  unresolved_links INT := 0;
BEGIN
  FOR wi IN
    SELECT "id", "workspaceId", "identifier", "descriptionMd", "explanationMd"
      FROM "work_item"
     WHERE "descriptionMd" LIKE '%](motir-ref:%' OR "explanationMd" LIKE '%](motir-ref:%'
     ORDER BY "identifier", "id"
  LOOP
    new_description := wi."descriptionMd";
    new_explanation := wi."explanationMd";
    FOR i IN 1 .. 2 LOOP
      body := CASE i WHEN 1 THEN wi."descriptionMd" ELSE wi."explanationMd" END;
      CONTINUE WHEN body IS NULL;
      rewritten := body;
      FOR m IN
        SELECT DISTINCT r
          FROM regexp_matches(body, '\[([^][]*)\]\(motir-ref:(planItem:)?([A-Za-z0-9_-]+)\)', 'g') AS r
      LOOP
        token := '[' || m[1] || '](motir-ref:' || coalesce(m[2], '') || m[3] || ')';
        SELECT p."work_item_id" INTO target
          FROM "plan_item" p
          JOIN "work_item" w ON w."id" = p."work_item_id"
         WHERE p."id" = m[3]
           AND p."op" = 'add'
           AND w."workspaceId" = wi."workspaceId";
        IF target IS NULL THEN
          unresolved_links := unresolved_links + 1;
          RAISE NOTICE 'MOTIR-10104 % %: % resolves to no card — left unchanged',
            wi."identifier", fields[i], token;
        ELSE
          rewrote_links := rewrote_links + 1;
          rewritten := replace(rewritten, token, '[' || m[1] || '](motir:' || target || ')');
        END IF;
      END LOOP;
      IF i = 1 THEN new_description := rewritten; ELSE new_explanation := rewritten; END IF;
    END LOOP;

    IF new_description IS DISTINCT FROM wi."descriptionMd"
       OR new_explanation IS DISTINCT FROM wi."explanationMd" THEN
      rewrote_cards := rewrote_cards + 1;
      UPDATE "work_item"
         SET "descriptionMd" = new_description, "explanationMd" = new_explanation
       WHERE "id" = wi."id";
    END IF;
  END LOOP;

  RAISE NOTICE 'MOTIR-10104 summary: rewrote % link(s) on % card(s); % link(s) resolve to no card',
    rewrote_links, rewrote_cards, unresolved_links;
END $$;
