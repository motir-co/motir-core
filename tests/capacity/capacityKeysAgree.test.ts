import { describe, expect, expectTypeOf, it } from 'vitest';
import * as alertKeys from '@/lib/capacity/alertKeys';
import * as client from '@/lib/gateway/capacityClient';

// THE CAPACITY KEY SETS (MOTIR-9611): the gateway client's provider and unit
// lists and the alert store's are one list, so they cannot drift.

describe('the client and the alert store name the same keys', () => {
  it('at runtime', () => {
    expect([...client.CAPACITY_PROVIDERS]).toEqual([...alertKeys.CAPACITY_PROVIDERS]);
    expect([...client.CAPACITY_LIMIT_UNITS]).toEqual([...alertKeys.CAPACITY_LIMIT_UNITS]);
  });

  it('as types', () => {
    expectTypeOf<client.CapacityProvider>().toEqualTypeOf<alertKeys.CapacityProvider>();
    expectTypeOf<client.CapacityLimitUnit>().toEqualTypeOf<alertKeys.CapacityLimitUnit>();
  });
});
