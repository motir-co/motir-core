import { describe, expect, it } from 'vitest';
import { isTigrisHost, readSmokeEnv, SMOKE_ENV_VARIABLES, SmokeEnvError } from './env';

// The cutover smoke lane's input guard (Story MOTIR-9712 · MOTIR-10076). The lane
// itself runs only against a deployed stack, so this is the part CI can check.

const ALL_SET = {
  SMOKE_BASE_URL: 'https://app.motir.co/',
  SMOKE_EMAIL: 'smoke@motir.co',
  SMOKE_PASSWORD: 'not-a-real-password',
  SMOKE_ITEM_KEY: 'motir-42',
  SMOKE_PROJECT_NAME: 'Motir',
  SMOKE_PRIVATE_STORE_HOST: 'motir-core-private.s3.eu-central-1.amazonaws.com',
  SMOKE_PUBLIC_ASSET_ORIGIN: 'https://assets.motir.co/',
};

describe('readSmokeEnv', () => {
  it('reads every variable when all are set, normalising the origins and the key', () => {
    expect(readSmokeEnv(ALL_SET)).toEqual({
      baseUrl: 'https://app.motir.co',
      email: 'smoke@motir.co',
      password: 'not-a-real-password',
      itemKey: 'MOTIR-42',
      projectName: 'Motir',
      privateStoreHost: 'motir-core-private.s3.eu-central-1.amazonaws.com',
      publicAssetOrigin: 'https://assets.motir.co',
    });
  });

  it('names EVERY missing variable in one error, with no fallback', () => {
    const err = (() => {
      try {
        readSmokeEnv({ SMOKE_EMAIL: 'smoke@motir.co', SMOKE_ITEM_KEY: '   ' });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(SmokeEnvError);
    const missing = SMOKE_ENV_VARIABLES.filter((name) => name !== 'SMOKE_EMAIL');
    expect((err as Error).message).toContain(`missing ${missing.join(', ')}`);
    expect((err as Error).message).not.toContain('localhost');
  });

  it('refuses an empty environment', () => {
    expect(() => readSmokeEnv({})).toThrowError(/missing SMOKE_BASE_URL, SMOKE_EMAIL/);
  });

  it('refuses a non-URL or plain-http origin and a store "host" that is a URL', () => {
    expect(() =>
      readSmokeEnv({
        ...ALL_SET,
        SMOKE_BASE_URL: 'http://app.motir.co',
        SMOKE_PUBLIC_ASSET_ORIGIN: 'assets.motir.co',
        SMOKE_PRIVATE_STORE_HOST: 'https://bucket.s3.amazonaws.com',
      }),
    ).toThrowError(
      /SMOKE_BASE_URL must be https[\s\S]*SMOKE_PUBLIC_ASSET_ORIGIN is not a URL[\s\S]*bare host name/,
    );
  });
});

describe('isTigrisHost', () => {
  it.each([
    ['bucket.storage.tigris.dev', true],
    ['storage.tigris.io', true],
    ['motir.t3.storage.dev', true],
    ['assets.motir.co', false],
    ['motir-core-private.s3.eu-central-1.amazonaws.com', false],
    ['nottigris.dev', false],
  ])('%s → %s', (host, expected) => {
    expect(isTigrisHost(host)).toBe(expected);
  });
});
