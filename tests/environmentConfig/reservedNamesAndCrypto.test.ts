// MOTIR-9960 — the two pure primitives every environment-configuration card
// shares: the reserved-name rule and the secret-value encryption instance.
import { afterEach, describe, expect, it } from 'vitest';
import { AppEnvironment, EnvironmentConfigAction } from '@/generated/prisma/client';
import {
  ENVIRONMENT_CONFIG_KEY_ENV,
  environmentConfigCrypto,
} from '@/lib/environmentConfig/crypto';
import { ReservedEnvironmentNameError } from '@/lib/environmentConfig/errors';
import { isReservedEnvironmentName } from '@/lib/environmentConfig/reservedNames';
import { ENVIRONMENT_CONFIG_ACTIONS, ENVIRONMENTS } from '@/lib/environmentConfig/vocabulary';

const KEY = 'a'.repeat(64);
const saved = {
  own: process.env[ENVIRONMENT_CONFIG_KEY_ENV],
  github: process.env.GITHUB_TOKEN_ENCRYPTION_KEY,
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore(ENVIRONMENT_CONFIG_KEY_ENV, saved.own);
  restore('GITHUB_TOKEN_ENCRYPTION_KEY', saved.github);
});

describe('the environment vocabulary', () => {
  it('matches the Prisma enums value for value', () => {
    expect([...ENVIRONMENTS].sort()).toEqual(Object.values(AppEnvironment).sort());
    expect([...ENVIRONMENT_CONFIG_ACTIONS].sort()).toEqual(
      Object.values(EnvironmentConfigAction).sort(),
    );
  });
});

describe('isReservedEnvironmentName', () => {
  it.each(['PORT', 'DATABASE_URL', 'MOTIR_ANYTHING', 'MOTIR_'])('reserves %s', (name) => {
    expect(isReservedEnvironmentName(name)).toBe(true);
  });

  it.each(['GREETING', 'API_KEY', 'PORTAL', 'MY_MOTIR_X', 'port', 'motir_x', ' PORT'])(
    'leaves %s free — exact, case-sensitive, no normalisation',
    (name) => {
      expect(isReservedEnvironmentName(name)).toBe(false);
    },
  );
});

describe('ReservedEnvironmentNameError', () => {
  it('carries the name and says it', () => {
    const err = new ReservedEnvironmentNameError('DATABASE_URL');
    expect(err).toBeInstanceOf(Error);
    expect(err.reservedName).toBe('DATABASE_URL');
    expect(err.code).toBe('ENVIRONMENT_NAME_RESERVED');
    expect(err.message).toContain('DATABASE_URL');
  });
});

describe('environmentConfigCrypto', () => {
  it('reads its own key name and no other', () => {
    expect(ENVIRONMENT_CONFIG_KEY_ENV).toBe('ENVIRONMENT_CONFIG_ENCRYPTION_KEY');
  });

  it('does not fall back to the GitHub key: encrypting throws naming its own key', () => {
    delete process.env[ENVIRONMENT_CONFIG_KEY_ENV];
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY = KEY;
    expect(() => environmentConfigCrypto.encryptToken('hello')).toThrow(
      /ENVIRONMENT_CONFIG_ENCRYPTION_KEY/,
    );
  });

  it('round-trips a value through the v1 form with the key set', () => {
    process.env[ENVIRONMENT_CONFIG_KEY_ENV] = KEY;
    const sealed = environmentConfigCrypto.encryptToken('s3cret-value');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(sealed).not.toContain('s3cret-value');
    expect(environmentConfigCrypto.decryptToken(sealed)).toBe('s3cret-value');
  });

  it('cannot decrypt under a different key', () => {
    process.env[ENVIRONMENT_CONFIG_KEY_ENV] = KEY;
    const sealed = environmentConfigCrypto.encryptToken('s3cret-value');
    process.env[ENVIRONMENT_CONFIG_KEY_ENV] = 'b'.repeat(64);
    expect(() => environmentConfigCrypto.decryptToken(sealed)).toThrow();
  });
});
