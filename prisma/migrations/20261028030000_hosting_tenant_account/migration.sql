-- An organisation's ONE AWS hosting account (Story MOTIR-9792 · MOTIR-9939): the
-- enterprise tenant's account in Motir's AWS Organization. Never a `fleet_shard`
-- row and no key to one. Ids, a state, counts and times only — no credential and
-- no member email.

-- CreateTable
CREATE TABLE "hosting_tenant_account" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "aws_account_id" TEXT,
    "state" TEXT NOT NULL DEFAULT 'requested',
    "refused_count" INTEGER NOT NULL DEFAULT 0,
    "last_refused_at" TIMESTAMP(3),
    "ou_id" TEXT,
    "region" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "hosting_tenant_account_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hosting_tenant_account_state_check" CHECK ("state" IN ('requested', 'creating', 'bootstrapping', 'ready', 'refused'))
);

-- CreateIndex
CREATE UNIQUE INDEX "hosting_tenant_account_organization_id_key" ON "hosting_tenant_account"("organization_id");

-- AddForeignKey
ALTER TABLE "hosting_tenant_account" ADD CONSTRAINT "hosting_tenant_account_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Platform-only, as `fleet_shard`: `app.system_admin` and nothing else.
-- ===========================================================================
ALTER TABLE "hosting_tenant_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hosting_tenant_account" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hosting_tenant_account_system_only" ON "hosting_tenant_account"
  FOR ALL
  USING (current_setting('app.system_admin', true) = 'true')
  WITH CHECK (current_setting('app.system_admin', true) = 'true');
