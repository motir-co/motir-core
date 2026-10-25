-- MOTIR-9456 (Story MOTIR-9362): at most ONE READY spare per fleet kind.
--
-- A data rule, not a convention: the growth job (MOTIR-9461) promotes "the
-- kind's spare" and must be able to rely on there being one. Only an `active`
-- spare counts — an unready one (`provisioning`, its quota raise pending or
-- denied) does not, because growth creates the next account when no spare is
-- ready, and that account is written as a spare too.
--
-- Partial, so raw SQL: Prisma's DSL cannot express a WHERE-filtered index. Its
-- column list `(fleet_kind)` is not the `@@index([fleetKind, role, state])`
-- column list, so `migrate dev` pairs nothing with it (the partial-index rule).
CREATE UNIQUE INDEX "fleet_shard_one_ready_spare_per_kind"
  ON "fleet_shard" ("fleet_kind")
  WHERE "role" = 'spare' AND "state" = 'active';
