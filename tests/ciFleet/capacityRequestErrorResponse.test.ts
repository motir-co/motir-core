import { describe, expect, it } from 'vitest';
import { mapFleetCapacityRequestError } from '@/lib/ciFleet/capacityRequestErrorResponse';
import {
  FleetCapacityRequestNotFoundError,
  FleetCapacityRequestNotOwnedError,
  FleetCapacityRequestOpenError,
  FleetPoolValueInvalidError,
} from '@/lib/ciFleet/errors';

// The Request more capacity route's error map (Story MOTIR-9368 · MOTIR-9662),
// topped up for MOTIR-9664's coverage lane: each typed error's status and body,
// and that no body carries the AWS account id or shard id its message names.

const ACCOUNT = '123456789012';
const SHARD = 'cmshard000000000000000000';

async function mapped(err: unknown) {
  const res = mapFleetCapacityRequestError(err);
  if (!res) return null;
  const text = await res.text();
  expect(text).not.toContain(ACCOUNT);
  expect(text).not.toContain(SHARD);
  return { status: res.status, body: JSON.parse(text) as unknown };
}

describe('mapFleetCapacityRequestError', () => {
  it('maps each typed error by code, never by message', async () => {
    expect(await mapped(new FleetPoolValueInvalidError('desiredVcpu', 0))).toEqual({
      status: 400,
      body: { code: 'FLEET_POOL_VALUE_INVALID', field: 'desiredVcpu' },
    });
    expect(await mapped(new FleetCapacityRequestNotOwnedError(SHARD))).toEqual({
      status: 404,
      body: { code: 'FLEET_CAPACITY_REQUEST_NOT_OWNED' },
    });
    expect(await mapped(new FleetCapacityRequestOpenError(ACCOUNT, 'req-1'))).toEqual({
      status: 409,
      body: { code: 'FLEET_CAPACITY_REQUEST_OPEN', requestId: 'req-1' },
    });
    expect(await mapped(new FleetCapacityRequestNotFoundError('req-2'))).toEqual({
      status: 404,
      body: { code: 'FLEET_CAPACITY_REQUEST_NOT_FOUND' },
    });
  });

  it('returns null for anything else, so the route rethrows', async () => {
    expect(await mapped(new Error('boom'))).toBeNull();
    expect(await mapped('a string')).toBeNull();
  });
});
