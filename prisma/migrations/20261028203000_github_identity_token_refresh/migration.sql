-- ===========================================================================
-- github_identity — keep what an EXPIRING user token needs (Bug MOTIR-10021).
--
-- Motir Integration issues user-to-server tokens that expire after eight hours
-- (MOTIR-6522 turned "Expire user authorization tokens" on), each with a
-- rotating refresh token. The identity stored only the access token, so every
-- member's sign-in died eight hours after they linked it. These columns let
-- `githubIdentityService.getLiveToken` renew it: the encrypted refresh token,
-- both expiries, the single-flight renewal lease, and the mark a refused
-- refresh leaves until the member reconnects.
--
-- All nullable: every existing row has no refresh token and keeps today's
-- behaviour (its token is returned as stored). The table's RLS policies are
-- row policies and need no change.
-- ===========================================================================

ALTER TABLE "github_identity"
  ADD COLUMN "refresh_token_encrypted" TEXT,
  ADD COLUMN "token_expires_at" TIMESTAMP(3),
  ADD COLUMN "refresh_token_expires_at" TIMESTAMP(3),
  ADD COLUMN "refresh_lease_until" TIMESTAMP(3),
  ADD COLUMN "refresh_refused_at" TIMESTAMP(3);
