-- ===========================================================================
-- THE FOUR STARTER ENTRIES (Story MOTIR-704 · MOTIR-9813; decision MOTIR-706
-- v2 §3.4, page cmvsezd8800eihnoikhllqqev).
--
-- The registry shipped with two seeds (`20261028200000_seed_registry`). This
-- registers the four templates that now exist: the Fly and AWS web starters
-- (whose `motir.hosting.json` names exactly their one target, MOTIR-9809) and the
-- two non-web foundations (MOTIR-6414), which carry no hosting targets because
-- only a `web` row is deployed (706 §3.2).
--
-- An UPSERT by key, so it is idempotent and adopts an entry an operator may have
-- registered by hand under the same key: the catalogue fields take 706 §3.4's
-- values, while `id`, `status` and the promotion fields are left as found — a
-- retired entry stays retired. A row already holding these values is not
-- written at all, so a re-run changes no row. The two shipped rows are not
-- named, so not touched.
-- ===========================================================================

INSERT INTO "seed_registry_entry" (
  "id", "key", "legacy_keys", "role", "stack", "label", "template_owner", "template_repo",
  "use_cases", "sizes", "hosting_targets", "status", "updated_at"
) VALUES (
  'seed_nextjs_prisma_fly_starter',
  'nextjs-prisma-fly-starter',
  ARRAY[]::TEXT[],
  'web',
  'nextjs',
  'Next.js · Fly',
  'motir-co',
  'nextjs-prisma-fly-starter',
  ARRAY['mvp', 'planned_product']::"hosting_use_case"[],
  ARRAY['small', 'medium', 'large']::"hosting_size"[],
  ARRAY['fly']::"hosting_target"[],
  'active',
  CURRENT_TIMESTAMP
), (
  'seed_nextjs_prisma_aws_starter',
  'nextjs-prisma-aws-starter',
  ARRAY[]::TEXT[],
  'web',
  'nextjs',
  'Next.js · AWS',
  'motir-co',
  'nextjs-prisma-aws-starter',
  ARRAY['planned_product']::"hosting_use_case"[],
  ARRAY['small', 'medium', 'large']::"hosting_size"[],
  ARRAY['aws']::"hosting_target"[],
  'active',
  CURRENT_TIMESTAMP
), (
  'seed_expo_mobile_foundation',
  'expo-mobile-foundation',
  ARRAY[]::TEXT[],
  'mobile',
  'expo',
  'Expo · mobile',
  'motir-co',
  'expo-mobile-foundation',
  ARRAY['internal_tool', 'mvp', 'planned_product']::"hosting_use_case"[],
  ARRAY['small', 'medium', 'large']::"hosting_size"[],
  ARRAY[]::"hosting_target"[],
  'active',
  CURRENT_TIMESTAMP
), (
  'seed_spring_api_foundation',
  'spring-api-foundation',
  ARRAY[]::TEXT[],
  'api',
  'spring',
  'Spring · API',
  'motir-co',
  'spring-api-foundation',
  ARRAY['internal_tool', 'mvp', 'planned_product']::"hosting_use_case"[],
  ARRAY['small', 'medium', 'large']::"hosting_size"[],
  ARRAY[]::"hosting_target"[],
  'active',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO UPDATE SET
  "role"            = EXCLUDED."role",
  "stack"           = EXCLUDED."stack",
  "label"           = EXCLUDED."label",
  "template_owner"  = EXCLUDED."template_owner",
  "template_repo"   = EXCLUDED."template_repo",
  "use_cases"       = EXCLUDED."use_cases",
  "sizes"           = EXCLUDED."sizes",
  "hosting_targets" = EXCLUDED."hosting_targets",
  "updated_at"      = CURRENT_TIMESTAMP
WHERE (
  "seed_registry_entry"."role", "seed_registry_entry"."stack", "seed_registry_entry"."label",
  "seed_registry_entry"."template_owner", "seed_registry_entry"."template_repo",
  "seed_registry_entry"."use_cases", "seed_registry_entry"."sizes",
  "seed_registry_entry"."hosting_targets"
) IS DISTINCT FROM (
  EXCLUDED."role", EXCLUDED."stack", EXCLUDED."label",
  EXCLUDED."template_owner", EXCLUDED."template_repo",
  EXCLUDED."use_cases", EXCLUDED."sizes",
  EXCLUDED."hosting_targets"
);
