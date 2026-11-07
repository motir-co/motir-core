-- THE EMAIL SUPPRESSION LIST (MOTIR-10565).
--
-- Production moves from Resend to Amazon SES (Story MOTIR-10562). SES reports
-- what became of a message through its configuration set's event destination:
-- bounce and complaint events, published to an SNS topic that delivers them to
-- `POST /api/ses/webhook`. A PERMANENT bounce (the address does not exist) or a
-- COMPLAINT (the recipient marked the mail as spam) adds the address here, and
-- every send reads this table first and skips a suppressed recipient.
--
-- Why a list of our own rather than only SES's account-level one: the check
-- runs in `emailService` before ANY provider is called, so a suppressed address
-- is skipped under every provider and the skip is logged where an operator can
-- see it; SES's own list would drop the send silently on its side, and only for
-- SES.
--
-- `address` is stored normalised (trimmed, lower-cased) and is UNIQUE — that
-- unique index IS the index on the address the send-path lookup probes, and it
-- makes a second event for the same address an update of its row.
--
-- Platform bookkeeping with no workspace, like `github_webhook_delivery`: an
-- address bounces for the provider account, and the same person may belong to
-- many workspaces or none. RLS admits `app.system_admin` only — the context the
-- `email.send` job and the notification webhook both run under.

CREATE TYPE "email_suppression_reason" AS ENUM ('bounce', 'complaint');

CREATE TABLE "email_suppression" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "reason" "email_suppression_reason" NOT NULL,
    "provider" TEXT NOT NULL,
    "detail" TEXT,
    "provider_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_suppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_suppression_address_key" ON "email_suppression"("address");

ALTER TABLE "email_suppression" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_suppression" FORCE ROW LEVEL SECURITY;

CREATE POLICY "email_suppression_system_only" ON "email_suppression"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
