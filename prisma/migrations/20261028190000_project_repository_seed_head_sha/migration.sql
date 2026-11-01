-- The default-branch head a Motir-created repository had when seeding finished
-- (MOTIR-4589). A created repository is not indexed until its default branch
-- moves past this commit: before that its code graph is the template's graph.
-- Nullable, no backfill: a null keeps today's behaviour (index on creation).

-- AlterTable
ALTER TABLE "project_repository" ADD COLUMN "seed_head_sha" TEXT;
