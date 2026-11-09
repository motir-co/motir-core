-- MOTIR-10801: an agent instance's region is the placement's, written with its
-- handle. Create no longer asks the Fly lane for a default region, so a row waits
-- for room with no region. Every existing row keeps its value; no data changes.
ALTER TABLE "agent_instance" ALTER COLUMN "region" DROP NOT NULL;
