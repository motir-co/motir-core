-- THE GITHUB WEBHOOK INBOX (Bug MOTIR-10425).
--
-- One row per verified GitHub App delivery, written before
-- `/api/github/webhook` answers. The route used to process the delivery inline
-- and answer afterwards; GitHub waits ten seconds for the response headers and
-- does not redeliver a failed delivery on its own, so a `check_suite completed`
-- that queued behind the CI-feedback gate for longer than that was lost, and the
-- card it would have promoted waited for the reconcile tick.
--
-- The route now persists the delivery here and answers 202; the
-- `system.github-webhook-delivery` job processes it, keyed on
-- `(delivery_id, generation)`, and the inbox sweep re-enqueues a row whose
-- enqueue was lost and prunes processed rows past the retention window.
--
-- The body is cleared once a delivery is processed (a motir-core push alone
-- produces hundreds of check deliveries of several KB each); a processed row is
-- kept for its outcome and never re-run.
--
-- Platform bookkeeping with no workspace, like `github_runner_call_event`: a
-- delivery is about an App installation and may reach any tenant or none, so
-- RLS admits `app.system_admin` only.

CREATE TYPE "github_webhook_delivery_state" AS ENUM ('received', 'processed', 'failed');

CREATE TABLE "github_webhook_delivery" (
  "id"           TEXT NOT NULL,
  "delivery_id"  TEXT NOT NULL,
  "event"        TEXT NOT NULL,
  "payload"      JSONB,
  "state"        "github_webhook_delivery_state" NOT NULL DEFAULT 'received',
  "attempts"     INTEGER NOT NULL DEFAULT 0,
  "generation"   INTEGER NOT NULL DEFAULT 0,
  "last_error"   TEXT,
  "result"       JSONB,
  "received_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  "updated_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "github_webhook_delivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "github_webhook_delivery_delivery_id_key"
  ON "github_webhook_delivery"("delivery_id");
CREATE INDEX "github_webhook_delivery_state_received_at_idx"
  ON "github_webhook_delivery"("state", "received_at");

ALTER TABLE "github_webhook_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_webhook_delivery" FORCE ROW LEVEL SECURITY;

CREATE POLICY "github_webhook_delivery_system_only" ON "github_webhook_delivery"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
