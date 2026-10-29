-- THE PREVIEW GATE'S CONSUMED ADMISSIONS (Story MOTIR-5766 · Subtask MOTIR-5779).
-- ADDITIVE and in ONE step: table + index + RLS.
--
-- MOTIR-5769 §9: preview-access mints a signed admission that works ONCE, for
-- one host, for 60 seconds. The signature proves who minted it; only a record of
-- the ids already consumed makes it single-use, so the preview host inserts the
-- admission's id here when it sets the gate cookie, and a second insert of the
-- same id is the replay it refuses. A row is worthless once its admission has
-- expired, so the consume path deletes expired rows as it goes.
--
-- RLS: system only. Nothing tenant-facing reads or writes it — the preview host
-- consumes under withSystemContext, because the request carries no Motir
-- session (the gate cookie is the only credential on that host).

-- CreateTable
CREATE TABLE "preview_gate_admission" (
    "jti" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_gate_admission_pkey" PRIMARY KEY ("jti")
);

-- CreateIndex
CREATE INDEX "preview_gate_admission_expires_at_idx" ON "preview_gate_admission"("expires_at");

ALTER TABLE "preview_gate_admission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "preview_gate_admission" FORCE ROW LEVEL SECURITY;

CREATE POLICY "preview_gate_admission_system" ON "preview_gate_admission"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
