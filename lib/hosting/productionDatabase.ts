import type { HostingTarget } from '@/generated/prisma/client';
import { ProductionDatabaseKindUnsupportedError } from '@/lib/hosting/errors';

// What an application's PRODUCTION database is (Story MOTIR-9797 · MOTIR-10028).
// The hosting ADR (MOTIR-5769 §6) pairs the serverless and Fly targets with the
// same database kind — a long-lived serverless Postgres project per application —
// and gives the AWS target a managed database of its own, provisioned by its
// adapter story rather than here. No I/O: the service decides, this names.

/** The reserved name the release receives the pooled connection string under. */
export const PRODUCTION_DATABASE_ENV_NAME = 'DATABASE_URL';

export type ProductionDatabaseKind = 'serverless_postgres';

/** The database kind a target runs on, or the typed refusal for one this story
 *  does not provision. */
export function databaseKindForTarget(target: HostingTarget): ProductionDatabaseKind {
  if (target === 'serverless' || target === 'fly') return 'serverless_postgres';
  throw new ProductionDatabaseKindUnsupportedError(target);
}
