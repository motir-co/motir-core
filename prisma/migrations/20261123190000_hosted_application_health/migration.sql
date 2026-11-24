-- MOTIR-12106: a hosted application's HEALTH and its CRASH EVENTS.
--
-- `hosted_application_health` holds ONE state per application — the deploy
-- port's runtime read and the manifest's health-check probe combined by
-- `combineHealthState` — written by the per-minute prober
-- (`system.production-health-probe`). It also caches the health-check path,
-- read from the current release's manifest once per release change.
--
-- `hosted_application_event` holds the crash events: a process that exited or
-- was killed for memory, or a health check that failed twice. One row per
-- transition: `(application_id, transition_key)` is unique, so a retried or
-- concurrent prober run writes it once. Up to 50 last log lines ride with it,
-- already MASKED by the logs read; nothing else of a log is stored.
--
-- TENANCY: `workspace_id` with a cascading FK and an index on BOTH tables,
-- ENABLE + FORCE ROW LEVEL SECURITY, and one `FOR ALL` policy each on
-- `app.workspace_id`. No system arm: the prober writes under the row's own
-- workspace (`withWorkspaceServiceContext`). Additive only.

-- CreateEnum
CREATE TYPE "hosted_health_state" AS ENUM ('healthy', 'unhealthy', 'suspended', 'crashed', 'deploying');

-- CreateEnum
CREATE TYPE "hosted_health_condition" AS ENUM ('probe_unreachable');

-- CreateEnum
CREATE TYPE "hosted_application_event_kind" AS ENUM ('crashed', 'health_check_failed');

-- CreateTable
CREATE TABLE "hosted_application_health" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "state" "hosted_health_state" NOT NULL,
    "since" TIMESTAMPTZ(3) NOT NULL,
    "condition" "hosted_health_condition",
    "consecutive_probe_failures" INTEGER NOT NULL DEFAULT 0,
    "probed_release_id" TEXT,
    "health_check_path" TEXT,
    "last_probed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hosted_application_health_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hosted_application_event" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "release_id" TEXT,
    "kind" "hosted_application_event_kind" NOT NULL,
    "reason" TEXT NOT NULL,
    "exit_code" INTEGER,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "last_log_lines" JSONB NOT NULL DEFAULT '[]',
    "transition_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hosted_application_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hosted_application_health_application_id_key" ON "hosted_application_health"("application_id");

-- CreateIndex
CREATE INDEX "hosted_application_health_workspace_id_idx" ON "hosted_application_health"("workspace_id");

-- CreateIndex
CREATE INDEX "hosted_application_event_application_id_occurred_at_idx" ON "hosted_application_event"("application_id", "occurred_at");

-- CreateIndex
CREATE INDEX "hosted_application_event_workspace_id_idx" ON "hosted_application_event"("workspace_id");

-- CreateIndex
CREATE INDEX "hosted_application_event_release_id_idx" ON "hosted_application_event"("release_id");

-- CreateIndex
CREATE UNIQUE INDEX "hosted_application_event_application_id_transition_key_key" ON "hosted_application_event"("application_id", "transition_key");

-- AddForeignKey
ALTER TABLE "hosted_application_health" ADD CONSTRAINT "hosted_application_health_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_application_health" ADD CONSTRAINT "hosted_application_health_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "hosted_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_application_event" ADD CONSTRAINT "hosted_application_event_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_application_event" ADD CONSTRAINT "hosted_application_event_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "hosted_application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hosted_application_event" ADD CONSTRAINT "hosted_application_event_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "hosted_release"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security
ALTER TABLE "hosted_application_health" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hosted_application_health" FORCE ROW LEVEL SECURITY;

CREATE POLICY "hosted_application_health_active_workspace" ON "hosted_application_health"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "hosted_application_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hosted_application_event" FORCE ROW LEVEL SECURITY;

CREATE POLICY "hosted_application_event_active_workspace" ON "hosted_application_event"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
