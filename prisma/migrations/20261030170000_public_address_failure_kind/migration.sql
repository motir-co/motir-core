-- MOTIR-9526 — which customer-side proof a live customer domain lost.
--
-- The certificate sweep now re-proves ownership (the `_motir-verify` TXT) and
-- pointing (Fly's `configured`) on issued domains, and records WHICH one broke
-- so the Custom domains pane can name the record to restore. `failure_reason`
-- stays the free text it displays.
--
-- It also stores the certificate's expiry as the platform reports it
-- (`certificate_expires_at`), which the pane draws on an issued row.
--
-- Additive and nullable: existing rows stay NULL on both, which reads as "no
-- kind" (an issuance failure, or no failure) and "no known expiry". No RLS
-- change: both columns ride the existing `public_address` policies.
--
-- Rollback: ALTER TABLE "public_address" DROP COLUMN "certificate_expires_at";
--           ALTER TABLE "public_address" DROP COLUMN "failure_kind";
--           DROP TYPE "PublicAddressFailureKind";

CREATE TYPE "PublicAddressFailureKind" AS ENUM ('txt_lost', 'pointing_lost', 'certificate_lost');

ALTER TABLE "public_address" ADD COLUMN "failure_kind" "PublicAddressFailureKind";

ALTER TABLE "public_address" ADD COLUMN "certificate_expires_at" TIMESTAMP(3);
