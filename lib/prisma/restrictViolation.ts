import { sqlStateOf } from './sqlstate';

/** Prisma's error code for a foreign-key violation. */
export const PRISMA_FOREIGN_KEY_VIOLATION = 'P2003';

/** PostgreSQL's SQLSTATE `restrict_violation` — what 18 reports for `ON DELETE RESTRICT`. */
export const POSTGRES_RESTRICT_VIOLATION = '23001';

/** The driver-adapter kind adapter-pg >= 7.10 gives a `23001`. */
const ADAPTER_RESTRICT_KIND = 'RestrictViolation';

/**
 * Whether `err` is a DELETE (or key UPDATE) refused because a row still
 * references it through an `ON DELETE RESTRICT` foreign key — wherever the
 * server and the client of the day put it.
 *
 * ── Why this is one function and not a code check (MOTIR-10227) ──────────────
 * The obvious read is `err.code === 'P2003'`, and it stopped being true when the
 * server moved, not when the client did. Three shapes have now been MEASURED for
 * the same refused delete:
 *
 *   PostgreSQL <= 17, any adapter   SQLSTATE 23503   err.code 'P2003'
 *   PostgreSQL 18, adapter-pg 7.9   SQLSTATE 23001   err.code 'P2039'
 *                                   err.meta.driverAdapterError.cause
 *                                     = { kind: 'postgres', code: '23001', originalCode: '23001' }
 *   PostgreSQL 18, adapter-pg 7.10  SQLSTATE 23001   err.code 'P2003'
 *                                   err.meta.driverAdapterError.cause
 *                                     = { kind: 'RestrictViolation', originalCode: '23001' }
 *
 * PostgreSQL 18 reports a RESTRICT violation as `23001 restrict_violation`, where
 * every earlier major reported `23503 foreign_key_violation` for it. adapter-pg
 * 7.9 maps only `23503` to a foreign-key violation, so on 18 the `23001` falls to
 * its default arm and Prisma surfaces it as the catch-all `P2039`. A backstop
 * matching `P2003` alone therefore let the refusal escape as a raw database error
 * — a 500 where the service owed its typed error. 7.10 maps `23001` back to
 * `P2003`, which is why the kind is read as well: the next client restores the
 * old code, and a reader keyed on the SQLSTATE alone would be right only by luck.
 *
 * A `P2003` is accepted whatever its SQLSTATE. On 17 and earlier a RESTRICT and a
 * NO ACTION refusal are both `23503` and cannot be told apart, so a caller asking
 * "was this delete refused by a reference?" gets `true` for either. Ask it only of
 * a DELETE or a key UPDATE: an INSERT whose parent is missing is also a `P2003`,
 * and it is not a RESTRICT violation.
 *
 * ⚠️ SO IT READS ALL THREE SHAPES, AND IT IS THE ONLY PLACE THAT DOES — the twin of
 * `uniqueViolation.ts` for `P2002` and `sqlstate.ts` for the SQLSTATE. A new
 * hand-written `code === 'P2003'` around a RESTRICT delete is the defect this file
 * exists to prevent.
 *
 * It narrows STRUCTURALLY rather than on `Prisma.PrismaClientKnownRequestError`,
 * so a module that must stay importable without a Prisma runtime can use it.
 */
export function isRestrictViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: unknown }).code === PRISMA_FOREIGN_KEY_VIOLATION) return true;
  if (sqlStateOf(err) === POSTGRES_RESTRICT_VIOLATION) return true;
  return adapterKindOf(err) === ADAPTER_RESTRICT_KIND;
}

/** The driver adapter's `kind` for the error, when Prisma kept the driver's own error. */
function adapterKindOf(err: object): string | undefined {
  const meta = (err as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const adapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError;
  if (typeof adapterError !== 'object' || adapterError === null) return undefined;
  const cause = (adapterError as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;
  const kind = (cause as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : undefined;
}
