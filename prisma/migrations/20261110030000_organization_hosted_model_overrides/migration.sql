-- The organisation's own run-side models (story MOTIR-10838 · MOTIR-10843): per
-- leaf difficulty, the hosted review and the design run. Additive and nullable —
-- NULL inherits the platform default — so every existing org resolves exactly as
-- before. The `organization` table's RLS policies are unchanged.
ALTER TABLE "organization"
  ADD COLUMN "hosted_model_trivial" TEXT,
  ADD COLUMN "hosted_model_low" TEXT,
  ADD COLUMN "hosted_model_medium" TEXT,
  ADD COLUMN "hosted_model_high" TEXT,
  ADD COLUMN "hosted_review_model" TEXT,
  ADD COLUMN "hosted_design_model" TEXT;
