-- Bug MOTIR-12011: a `ready` tenant account never re-runs the bootstrap, so the per-minute
-- reconcile re-checks its quota targets itself, once an hour. This records when it last did;
-- null (every existing row) means the check is due on the next pass. Expand-only.
ALTER TABLE "hosting_tenant_account" ADD COLUMN "quotas_checked_at" TIMESTAMP(3);
