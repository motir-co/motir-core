import { describe, expect, it } from 'vitest';
import {
  SeedEntryIsDefaultError,
  SeedPromotionManifestRefusedError,
  SeedPromotionSourceRefusedError,
  SeedRegistryInvalidFieldError,
} from '@/lib/seedRegistry/errors';
import { seedRegistryErrorResponse } from '@/lib/seedRegistry/routeErrors';

// The seed-registry routes' error BODIES (MOTIR-710, widened by MOTIR-712): the
// console renders its own sentence for every refusal, so each body carries the
// typed facts that sentence needs — never only English to parse.

async function body(err: unknown) {
  const res = seedRegistryErrorResponse(err);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('seedRegistryErrorResponse', () => {
  it('names an invalid manifest field AND what is wrong with it', async () => {
    const { status, json } = await body(
      new SeedPromotionManifestRefusedError(
        'invalid',
        'motir.hosting.json',
        'port',
        null,
        'port must be a positive integer.',
        'must be a positive integer',
      ),
    );
    expect(status).toBe(422);
    expect(json).toMatchObject({
      code: 'SEED_PROMOTION_MANIFEST_REFUSED',
      refusal: 'invalid',
      field: 'port',
      reason: 'must be a positive integer',
      declared: [],
    });
  });

  it('lists the targets a manifest DOES declare when one is missing', async () => {
    const { json } = await body(
      new SeedPromotionManifestRefusedError(
        'target_not_declared',
        'motir.hosting.json',
        'targets',
        'aws',
        'it does not list "aws".',
        null,
        ['fly', 'serverless'],
      ),
    );
    expect(json).toMatchObject({ target: 'aws', declared: ['fly', 'serverless'], reason: null });
  });

  it('carries the refused value of an out-of-list field', async () => {
    const { status, json } = await body(
      new SeedRegistryInvalidFieldError('sizes', 'huge', 'is not a known sizes value.'),
    );
    expect(status).toBe(422);
    expect(json).toMatchObject({
      code: 'SEED_REGISTRY_INVALID_FIELD',
      field: 'sizes',
      value: 'huge',
    });
  });

  it('keeps the source refusal typed, 404 only for a missing row', async () => {
    expect((await body(new SeedPromotionSourceRefusedError('not_found', 'r', 'gone'))).status).toBe(
      404,
    );
    const taken = await body(new SeedPromotionSourceRefusedError('taken_over', 'r', 'leaving'));
    expect(taken.status).toBe(422);
    expect(taken.json.refusal).toBe('taken_over');
    expect((await body(new SeedEntryIsDefaultError('initialised', 'any'))).status).toBe(409);
  });
});
