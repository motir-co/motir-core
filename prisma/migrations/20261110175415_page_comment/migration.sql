-- PAGE COMMENTS — a page's discussion (Epic MOTIR-5749 · Story MOTIR-10866 · MOTIR-10871).
--
-- One table every story of the epic stores page comments in. A ROOT starts a
-- thread, a REPLY points at its root (one level deep), the thread's resolved
-- state lives on the root, and two NULLABLE columns hold the inline anchor
-- `docs/decisions/pages.md` §8.3 fixes (a pair of Yjs relative positions as
-- bytes, plus the quoted text). This story leaves both NULL; the inline story
-- fills them through its own codec and adds no migration. It follows
-- `20261002200000_page_version` clause for clause: the same FK actions, a
-- SECURITY DEFINER tenancy backstop, the same RLS pair.
--
-- WHAT THIS MIGRATION DOES
--   1. `page_comment` — the table and its FKs (every one a Prisma `@relation`,
--      both sides, same actions).
--   2. The indexes: the page cascade, a thread's replies, the workspace, and two
--      hand-written PARTIAL indexes for the Open and Resolved root lists.
--   3. The CHECKs: resolution only on a root, a resolver only with a time, the
--      anchor pair both-or-neither, and an anchor only on a root.
--   4. The cotenancy trigger: a comment shares its page's workspace and project,
--      and a reply's parent is a ROOT on the SAME page.
--   5. RLS — the `page` pair.
--
-- One deploy, no expand/contract and no backfill: the table is additive and
-- nothing reads it before the package that ships on the same story branch.

-- 1. The table ------------------------------------------------------------------
--
-- `resolved_at` is TIMESTAMPTZ(3), as `page.archived_at` is: a state timestamp a
-- reader sees ("Resolved by Bo · 2 hours ago"). `anchor` holds the two encoded
-- relative positions as ONE byte string; how they are packed is the inline
-- story's codec, and this migration takes no position on it.
CREATE TABLE "page_comment" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "parent_comment_id" TEXT,
    "body_md" TEXT NOT NULL,
    "edited_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_id" TEXT,
    "anchor" BYTEA,
    "anchor_quote" TEXT,

    CONSTRAINT "page_comment_pkey" PRIMARY KEY ("id")
);

-- ON DELETE, one FK at a time:
--   * workspace_id / project_id  CASCADE — the `page` choice.
--   * page_id  CASCADE — a permanent page delete takes its discussion in the
--     same statement (pages.md §7).
--   * author_id  RESTRICT — durable attribution, as `page_version.author_id`
--     and the work-item `comment.author_id`.
--   * resolved_by_id  SET NULL — deleting a user never fails because they once
--     resolved a thread; the thread stays resolved (`resolved_at` decides it).
--   * parent_comment_id  CASCADE — deleting a root deletes its replies.
ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "page_comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. The indexes ------------------------------------------------------------------
--
-- The panel lists one page's ROOTS, open or resolved, cursor-paged; replies are
-- read per root. Declared in the schema:
CREATE INDEX "page_comment_page_id_idx" ON "page_comment"("page_id");

-- A thread's replies, oldest first; also serves the self-cascade.
CREATE INDEX "page_comment_parent_comment_id_created_at_idx" ON "page_comment"("parent_comment_id", "created_at");

-- As every tenant table carries.
CREATE INDEX "page_comment_workspace_id_idx" ON "page_comment"("workspace_id");

-- Hand-written PARTIAL indexes, NOT declared in the schema (Prisma cannot express
-- a `WHERE`). Neither column list matches an `@@index`, so the drift check
-- ignores both (the house rule on partial indexes). The Open list's keyset is
-- (created_at, id) over the page's unresolved roots; the Resolved list's is
-- (resolved_at, id) over its resolved roots. Either direction scans the btree.
CREATE INDEX "page_comment_open_roots_idx" ON "page_comment"("page_id", "created_at", "id")
  WHERE "parent_comment_id" IS NULL AND "resolved_at" IS NULL;

CREATE INDEX "page_comment_resolved_roots_idx" ON "page_comment"("page_id", "resolved_at", "id")
  WHERE "parent_comment_id" IS NULL AND "resolved_at" IS NOT NULL;

-- 3. The CHECKs -------------------------------------------------------------------
--
-- Resolved is a state of the THREAD, so only a root carries it.
ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_resolved_only_on_root" CHECK ("resolved_at" IS NULL OR "parent_comment_id" IS NULL);

-- Who resolved it is meaningless without when; the reverse (a time with no
-- resolver) is the SET NULL outcome and is allowed.
ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_resolver_needs_time" CHECK ("resolved_by_id" IS NULL OR "resolved_at" IS NOT NULL);

-- The anchor is one thing in two columns: both set, or neither.
ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_anchor_pairing" CHECK (("anchor" IS NULL) = ("anchor_quote" IS NULL));

-- An inline thread is anchored at its root; a reply inherits the root's place.
ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_anchor_only_on_root" CHECK ("anchor" IS NULL OR "parent_comment_id" IS NULL);

-- 4. The cotenancy trigger ----------------------------------------------------------
--
-- SECURITY DEFINER with `search_path` pinned, for the reason the page migration
-- gives: the row a tenancy check reads may lie OUTSIDE the invoking RLS context,
-- so as SECURITY INVOKER the lookup reads NULL for exactly the write it exists
-- to refuse. The body reads by primary key and returns nothing; the only
-- observable outputs are the RAISEs. `@motir/pages` refuses a reply to a reply
-- first (with a typed error); this is the database's backstop.
CREATE OR REPLACE FUNCTION enforce_page_comment_cotenancy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  page_workspace text;
  page_project   text;
  parent_page    text;
  parent_parent  text;
  parent_found   boolean;
BEGIN
  SELECT p."workspace_id", p."project_id"
    INTO page_workspace, page_project
    FROM "page" p
   WHERE p."id" = NEW."page_id";

  -- Missing: defer to the foreign key, which gives the clearer error.
  IF page_workspace IS NOT NULL THEN
    IF page_workspace <> NEW."workspace_id" THEN
      RAISE EXCEPTION 'PAGE_COMMENT_CROSS_WORKSPACE: page % lives in workspace %, not % — a comment belongs to its page''s workspace',
        NEW."page_id", page_workspace, NEW."workspace_id"
        USING ERRCODE = '23514';
    END IF;
    IF page_project <> NEW."project_id" THEN
      RAISE EXCEPTION 'PAGE_COMMENT_CROSS_PROJECT: page % lives in project %, not % — a comment belongs to its page''s project',
        NEW."page_id", page_project, NEW."project_id"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."parent_comment_id" IS NOT NULL THEN
    SELECT c."page_id", c."parent_comment_id", true
      INTO parent_page, parent_parent, parent_found
      FROM "page_comment" c
     WHERE c."id" = NEW."parent_comment_id";

    -- Missing: defer to the foreign key.
    IF parent_found THEN
      IF parent_page <> NEW."page_id" THEN
        RAISE EXCEPTION 'PAGE_COMMENT_REPLY_CROSS_PAGE: comment % belongs to page %, not % — a reply stays on its thread''s page',
          NEW."parent_comment_id", parent_page, NEW."page_id"
          USING ERRCODE = '23514';
      END IF;
      IF parent_parent IS NOT NULL THEN
        RAISE EXCEPTION 'PAGE_COMMENT_REPLY_DEPTH: comment % is itself a reply — a thread is one level deep',
          NEW."parent_comment_id"
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_page_comment_cotenancy
  BEFORE INSERT OR UPDATE OF "page_id", "workspace_id", "project_id", "parent_comment_id" ON "page_comment"
  FOR EACH ROW EXECUTE FUNCTION enforce_page_comment_cotenancy();

-- 5. RLS on page_comment ---------------------------------------------------------
--
-- The `page` pair: PERMISSIVE FOR ALL on the row's own `workspace_id` (USING +
-- WITH CHECK), and RESTRICTIVE FOR SELECT narrowing to `app.project_id` when it
-- is set — a reader bound to one project sees only that project's page
-- comments, as it sees only that project's versions and links. Both compare a
-- column to a setting; no per-row subquery. The workspace RLS migration's
-- `ALTER DEFAULT PRIVILEGES` grants the app role on every new table.
ALTER TABLE "page_comment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "page_comment" FORCE ROW LEVEL SECURITY;

CREATE POLICY "page_comment_active_workspace" ON "page_comment"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

CREATE POLICY "page_comment_project_narrow" ON "page_comment"
  AS RESTRICTIVE
  FOR SELECT
  USING (
    coalesce(current_setting('app.project_id', true), '') = ''
    OR "project_id" = current_setting('app.project_id', true)
  );
