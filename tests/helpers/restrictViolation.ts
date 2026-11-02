import { expect } from 'vitest';
import { Prisma } from '@/generated/prisma/client';

// A delete blocked by an `ON DELETE RESTRICT` foreign key, as the database the
// suite runs on reports it (MOTIR-10221).
//
// PostgreSQL 18, which production and CI run, reports a RESTRICT violation with
// its own SQLSTATE, `23001 restrict_violation`. 16 reported every foreign-key
// violation as `23503 foreign_key_violation`. `@prisma/adapter-pg` 7.9 maps only
// 23503 to `P2003`, so on 18 the same delete arrives as the generic `P2039`
// ("Database error") with the SQLSTATE in the driver-adapter cause. That cause is
// what this helper asserts, so the suites that pin a RESTRICT backstop state the
// fact the database reports rather than a client error code that depends on the
// adapter version. adapter-pg 7.10 maps 23001 to a `RestrictViolation` kind of
// its own; a Prisma upgrade updates this one file.
//
// Application code that still expects `P2003` from a RESTRICT delete is filed as
// MOTIR-10227.

/** The SQLSTATE a Prisma driver-adapter error carries, when it carries one. */
export function driverSqlState(err: unknown): string | undefined {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const adapterError = (err.meta as { driverAdapterError?: { cause?: { originalCode?: unknown } } })
    ?.driverAdapterError;
  const code = adapterError?.cause?.originalCode;
  return typeof code === 'string' ? code : undefined;
}

/** Assert `run` rejects because a RESTRICT foreign key blocked the delete. */
export async function expectRestrictViolation(run: Promise<unknown>): Promise<void> {
  const caught = await run.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  expect(driverSqlState(caught)).toBe('23001');
}
