-- MOTIR-9827: a plan edge carries its reason, and approve writes it onto the link.
ALTER TABLE "plan_item" ADD COLUMN "edge_reasons" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "work_item_link" ADD COLUMN "reason" TEXT;
