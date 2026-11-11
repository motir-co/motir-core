-- An unavailable AI provider resumes a planning conversation by itself ONCE (MOTIR-10968).
-- When that resume happened; null until it does, and never cleared.
ALTER TABLE "plan_change_session" ADD COLUMN "provider_auto_resumed_at" TIMESTAMP(3);
