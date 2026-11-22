-- THE DEFERRED CODEQL MOVE's cross-process claim (MOTIR-12034): one row per
-- GitHub repository holding the single-flight lease a runner boot takes before it
-- moves that repository's CodeQL default setup onto the fleet label, and the
-- landed move it remembers for the recheck window. Ten boots of one CI run each
-- PATCHed motir-ai's default setup within 0.6 s and left it broken on GitHub; a
-- lease in process memory could not have stopped them, because each boot ran on
-- its own worker. ADDITIVE: a new table, nothing existing changes, nothing seeded.

-- CreateTable
CREATE TABLE "fleet_code_scanning_move" (
    "org" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "held_until" TIMESTAMP(3) NOT NULL,
    "holder" TEXT NOT NULL,
    "on_fleet_until" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fleet_code_scanning_move_pkey" PRIMARY KEY ("org","repo")
);

-- ===========================================================================
-- Platform-only, as `fleet_growth_pass_lease`: `app.system_admin` and nothing
-- else. A row holds a repository name and two times — Motir's own fleet
-- bookkeeping, no tenant's data — and the boot path that writes it runs under
-- `withSystemContext`.
-- ===========================================================================
ALTER TABLE "fleet_code_scanning_move" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fleet_code_scanning_move" FORCE ROW LEVEL SECURITY;
CREATE POLICY "fleet_code_scanning_move_system_only" ON "fleet_code_scanning_move"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
