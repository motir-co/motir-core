-- ===========================================================================
-- project_repository — the PREVIEW ENABLEMENT record (Story MOTIR-5766 ·
-- MOTIR-5775, decision MOTIR-5769 §11).
--
-- Three nullable columns, no backfill: a NULL is "never enabled", which is the
-- truth for every existing row until `pnpm previews:enable-backfill` (or the next
-- establishment) enables it. No index: the backfill reads the whole hosted set,
-- which is one row per Motir-created web repository.
-- ===========================================================================

ALTER TABLE "project_repository"
  ADD COLUMN "preview_push_namespace" TEXT,
  ADD COLUMN "preview_enabled_at" TIMESTAMP(3),
  ADD COLUMN "preview_credential_expires_at" TIMESTAMP(3);
