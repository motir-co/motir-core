import { describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import {
  isRestrictViolation,
  POSTGRES_RESTRICT_VIOLATION,
  PRISMA_FOREIGN_KEY_VIOLATION,
} from '@/lib/prisma/restrictViolation';

// `isRestrictViolation` — the ONE reader of a delete refused by an
// `ON DELETE RESTRICT` foreign key (MOTIR-10227). Every shape the server and the
// client have been measured to produce is handed to it here as data, so the next
// move of either breaks this file rather than silently retiring the backstop that
// asks it. The live refusal is asserted end to end by
// `tests/custom-fields/definitionsService.test.ts`, on whichever server CI runs.

function known(
  code: string,
  meta: Record<string, unknown> | undefined,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('refused', {
    code,
    clientVersion: 'test',
    meta,
  });
}

function adapterMeta(cause: Record<string, unknown>): Record<string, unknown> {
  return { modelName: 'CustomFieldOption', driverAdapterError: { cause } };
}

describe('isRestrictViolation — every shape a refused delete has carried', () => {
  it('reads PostgreSQL <= 17: the RESTRICT refusal is a 23503, which every adapter maps to P2003', () => {
    expect(
      isRestrictViolation(
        known(
          PRISMA_FOREIGN_KEY_VIOLATION,
          adapterMeta({
            originalCode: '23503',
            originalMessage:
              'update or delete on table "custom_field_option" violates foreign key constraint',
            kind: 'ForeignKeyConstraintViolation',
            constraint: { index: 'custom_field_value_value_option_id_fkey' },
          }),
        ),
      ),
    ).toBe(true);
  });

  it('reads PostgreSQL 18 under adapter-pg 7.9: a 23001 that falls to the catch-all P2039', () => {
    expect(
      isRestrictViolation(
        known(
          'P2039',
          adapterMeta({
            originalCode: POSTGRES_RESTRICT_VIOLATION,
            originalMessage:
              'update or delete on table "custom_field_option" violates RESTRICT setting of foreign key constraint',
            kind: 'postgres',
            code: POSTGRES_RESTRICT_VIOLATION,
            severity: 'ERROR',
          }),
        ),
      ),
    ).toBe(true);
  });

  it('reads PostgreSQL 18 under adapter-pg 7.10: the RestrictViolation kind, mapped back to P2003', () => {
    expect(
      isRestrictViolation(
        known(
          PRISMA_FOREIGN_KEY_VIOLATION,
          adapterMeta({ originalCode: POSTGRES_RESTRICT_VIOLATION, kind: 'RestrictViolation' }),
        ),
      ),
    ).toBe(true);
  });

  it('reads the RestrictViolation kind on its own, with no SQLSTATE and no P2003', () => {
    expect(isRestrictViolation(known('P2039', adapterMeta({ kind: 'RestrictViolation' })))).toBe(
      true,
    );
  });

  it('reads the 23001 SQLSTATE through the flat shape too (prisma <= 7.8)', () => {
    expect(
      isRestrictViolation(
        Object.assign(new Error('refused'), { cause: { code: POSTGRES_RESTRICT_VIOLATION } }),
      ),
    ).toBe(true);
  });

  it('narrows structurally — a plain object carrying P2003 is read without a Prisma runtime', () => {
    expect(isRestrictViolation({ code: PRISMA_FOREIGN_KEY_VIOLATION })).toBe(true);
  });

  it('answers false for another database error under the catch-all P2039', () => {
    expect(
      isRestrictViolation(known('P2039', adapterMeta({ kind: 'postgres', code: '23514' }))),
    ).toBe(false);
  });

  it('answers false for a unique violation and for a P2039 that kept no driver error', () => {
    expect(
      isRestrictViolation(
        known('P2002', adapterMeta({ originalCode: '23505', kind: 'UniqueConstraintViolation' })),
      ),
    ).toBe(false);
    expect(isRestrictViolation(known('P2039', undefined))).toBe(false);
    expect(isRestrictViolation(known('P2039', { driverAdapterError: null }))).toBe(false);
    expect(isRestrictViolation(known('P2039', { driverAdapterError: { cause: null } }))).toBe(
      false,
    );
    expect(
      isRestrictViolation(known('P2039', { driverAdapterError: { cause: { kind: 7 } } })),
    ).toBe(false);
  });

  it('answers false for anything that is not an error object', () => {
    expect(isRestrictViolation(null)).toBe(false);
    expect(isRestrictViolation(undefined)).toBe(false);
    expect(isRestrictViolation('P2003')).toBe(false);
    expect(isRestrictViolation(new Error('boom'))).toBe(false);
  });
});
