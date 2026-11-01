-- The SEED REGISTRY (Story MOTIR-704 · MOTIR-708; decision MOTIR-706, page
-- cmvsezd8800eihnoikhllqqev, version 2, which amends
-- `docs/decisions/project-repository-set.md` §2).
--
-- A Motir-created `project_repository` row's `seed_source` is the KEY of one of
-- these entries (or one of its `legacy_keys`). An entry names the GitHub template
-- repository `/generate` copies (`template_owner` / `template_repo`), or neither
-- for the `initialised` seed (`auto_init`), and says what it serves: use cases,
-- sizes and hosting targets, from the same Postgres enums the row and the
-- hosting manifest use (`lib/hosting/vocabulary.ts`), so the three cannot drift.
--
-- ── NO WORKSPACE, AND WHY THE RLS LOOKS LIKE THIS ──────────────────────────
-- Unlike every `project_*` table, this one has NO `workspace_id` and NO tenant
-- policy: it is Motir's catalogue, shared by every workspace, and every
-- workspace's establish reads it. A tenancy predicate would hide the whole
-- catalogue from exactly the callers that seed from it.
--   · READ is unconditional — nothing in a row is a tenant's (a key, a template
--     coordinate, the serves-lists, an operator id).
--   · WRITE is `app.platform_staff` only (MOTIR-706 3.6: promote and retire are
--     a Motir operator's act, behind `requirePlatformStaff('operator')`, inside
--     an audited platform transaction). No tenant role can change what another
--     tenant's repositories start from.
-- The same shape as `platform_run_model`. ONE `FOR ALL` write arm, so UPDATE and
-- DELETE have a permissive policy. Grants: the add_workspace_rls migration's
-- ALTER DEFAULT PRIVILEGES covers every new table.
--
-- ── THE SEED ROWS ───────────────────────────────────────────────────────────
-- Exactly the two shipped seeds (706 3.4's first and last rows). The Fly and AWS
-- web starters and the Expo and Spring foundations are registered by MOTIR-9813
-- once their template repositories exist; nothing else is seeded here.
--   · `nextjs-prisma-serverless-starter`, the platform starter RENAMED (706 3.7,
--     k2) from `nextjs-prisma-vercel-starter`, which it keeps as a legacy key so
--     a row written by an instance still on the old code resolves in the window.
--   · `initialised`: any role, any stack, the fallback.
-- `ON CONFLICT DO NOTHING` keeps a re-run harmless.
--
-- ── NO FOREIGN KEY ──────────────────────────────────────────────────────────
-- `promoted_by` is the operator's user id as provenance TEXT, the
-- `platform_audit_log.actor_user_id` posture: an FK to "user" would put this
-- catalogue inside every `TRUNCATE "user" CASCADE` and every account erasure,
-- and an entry's provenance must outlive the account that promoted it.

-- CreateEnum
CREATE TYPE "seed_registry_entry_status" AS ENUM ('active', 'retired');

-- CreateTable
CREATE TABLE "seed_registry_entry" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "legacy_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "role" "project_repo_role",
    "stack" TEXT,
    "label" TEXT NOT NULL,
    "template_owner" TEXT,
    "template_repo" TEXT,
    "use_cases" "hosting_use_case"[],
    "sizes" "hosting_size"[],
    "hosting_targets" "hosting_target"[],
    "status" "seed_registry_entry_status" NOT NULL DEFAULT 'active',
    "promoted_from" TEXT,
    "promoted_by" TEXT,
    "promoted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seed_registry_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seed_registry_entry_key_key" ON "seed_registry_entry"("key");

-- CreateIndex
CREATE INDEX "seed_registry_entry_role_status_idx" ON "seed_registry_entry"("role", "status");

-- CreateIndex
CREATE INDEX "seed_registry_entry_legacy_keys_idx" ON "seed_registry_entry" USING GIN ("legacy_keys");



-- A template is named by BOTH halves of its coordinate, or by neither
-- (`initialised`): never an owner with no repository.
ALTER TABLE "seed_registry_entry" ADD CONSTRAINT "seed_registry_entry_template_pair_check"
  CHECK (("template_owner" IS NULL) = ("template_repo" IS NULL));

-- ===========================================================================
-- Row-level security — seed_registry_entry
-- ===========================================================================
ALTER TABLE "seed_registry_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "seed_registry_entry" FORCE ROW LEVEL SECURITY;

CREATE POLICY "seed_registry_entry_read" ON "seed_registry_entry"
  FOR SELECT
  USING (true);

CREATE POLICY "seed_registry_entry_platform_staff" ON "seed_registry_entry"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');

-- ===========================================================================
-- The two shipped seeds
-- ===========================================================================
INSERT INTO "seed_registry_entry" (
  "id", "key", "legacy_keys", "role", "stack", "label", "template_owner", "template_repo",
  "use_cases", "sizes", "hosting_targets", "status", "updated_at"
) VALUES (
  'seed_nextjs_prisma_serverless_starter',
  'nextjs-prisma-serverless-starter',
  ARRAY['nextjs-prisma-vercel-starter']::TEXT[],
  'web',
  'nextjs',
  'Next.js · serverless',
  'motir-co',
  'nextjs-prisma-serverless-starter',
  ARRAY['internal_tool', 'mvp']::"hosting_use_case"[],
  ARRAY['small']::"hosting_size"[],
  ARRAY['serverless']::"hosting_target"[],
  'active',
  CURRENT_TIMESTAMP
), (
  'seed_initialised',
  'initialised',
  ARRAY[]::TEXT[],
  NULL,
  NULL,
  'Initialised repository',
  NULL,
  NULL,
  ARRAY['internal_tool', 'mvp', 'planned_product']::"hosting_use_case"[],
  ARRAY['small', 'medium', 'large']::"hosting_size"[],
  ARRAY[]::"hosting_target"[],
  'active',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
