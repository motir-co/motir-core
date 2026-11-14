import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSET_PREFIX_ENV,
  DEPLOYMENT_ID_ENV,
  normalizeAssetPrefix,
  normalizeDeploymentId,
  versionSkewConfig,
} from '@/lib/build/versionSkew';

// MOTIR-11241: a tab left open across a deploy keeps working. The production
// IMAGE build serves `/_next/static` from static.motir.co and stamps the commit
// SHA as Next's `deploymentId`; every other build keeps today's behaviour.

const SHA = '61b7757c3d1e2f4a5b6c7d8e9f0a1b2c3d4e5f60';
const ORIGIN = 'https://static.motir.co';

describe('versionSkewConfig', () => {
  it('sets both keys for a production build that received both values', () => {
    expect(
      versionSkewConfig({
        NODE_ENV: 'production',
        [ASSET_PREFIX_ENV]: ORIGIN,
        [DEPLOYMENT_ID_ENV]: SHA,
      }),
    ).toEqual({ assetPrefix: ORIGIN, deploymentId: SHA });
  });

  it('sets neither outside a production build, even with the values present', () => {
    for (const NODE_ENV of ['development', 'test', undefined]) {
      expect(
        versionSkewConfig({ NODE_ENV, [ASSET_PREFIX_ENV]: ORIGIN, [DEPLOYMENT_ID_ENV]: SHA }),
      ).toEqual({});
    }
  });

  it('sets neither for a production build with no values (CI, E2E, a self-hosted image)', () => {
    expect(versionSkewConfig({ NODE_ENV: 'production' })).toEqual({});
    expect(
      versionSkewConfig({ NODE_ENV: 'production', [ASSET_PREFIX_ENV]: '', [DEPLOYMENT_ID_ENV]: '  ' }),
    ).toEqual({});
  });

  it('sets each key independently of the other', () => {
    expect(versionSkewConfig({ NODE_ENV: 'production', [DEPLOYMENT_ID_ENV]: SHA })).toEqual({
      deploymentId: SHA,
    });
    expect(versionSkewConfig({ NODE_ENV: 'production', [ASSET_PREFIX_ENV]: ORIGIN })).toEqual({
      assetPrefix: ORIGIN,
    });
  });

  it('trims the values and the prefix’s trailing slash', () => {
    expect(
      versionSkewConfig({
        NODE_ENV: 'production',
        [ASSET_PREFIX_ENV]: ` ${ORIGIN}/ `,
        [DEPLOYMENT_ID_ENV]: ` ${SHA}\n`,
      }),
    ).toEqual({ assetPrefix: ORIGIN, deploymentId: SHA });
  });

  it('fails the build on a malformed value rather than shipping it', () => {
    expect(() =>
      versionSkewConfig({ NODE_ENV: 'production', [ASSET_PREFIX_ENV]: 'static.motir.co' }),
    ).toThrow(/absolute https/);
    expect(() =>
      versionSkewConfig({ NODE_ENV: 'production', [DEPLOYMENT_ID_ENV]: 'a b' }),
    ).toThrow(/deploymentId/);
  });

  it('reads process.env when called with no argument', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(ASSET_PREFIX_ENV, ORIGIN);
    vi.stubEnv(DEPLOYMENT_ID_ENV, SHA);
    expect(versionSkewConfig()).toEqual({ assetPrefix: ORIGIN, deploymentId: SHA });
  });
});

describe('normalizeAssetPrefix', () => {
  it('keeps an origin and an origin with a path, without the trailing slash', () => {
    expect(normalizeAssetPrefix('https://static.motir.co')).toBe(ORIGIN);
    expect(normalizeAssetPrefix('https://static.motir.co///')).toBe(ORIGIN);
    expect(normalizeAssetPrefix('https://cdn.example.com/core/')).toBe(
      'https://cdn.example.com/core',
    );
  });

  it.each([
    ['not a URL', '/_next', /absolute https/],
    ['plain http', 'http://static.motir.co', /https:\/\/ URL/],
    ['a query', 'https://static.motir.co/?v=1', /bare origin/],
    ['a fragment', 'https://static.motir.co/#x', /bare origin/],
    ['credentials', 'https://u:p@static.motir.co', /bare origin/],
  ])('refuses %s', (_label, raw, message) => {
    expect(() => normalizeAssetPrefix(raw)).toThrow(message);
  });
});

describe('normalizeDeploymentId', () => {
  it('accepts a commit SHA and refuses header-unsafe text', () => {
    expect(normalizeDeploymentId(SHA)).toBe(SHA);
    expect(() => normalizeDeploymentId('a/b')).toThrow(/A-Za-z0-9/);
    expect(() => normalizeDeploymentId('x'.repeat(65))).toThrow(/1–64/);
  });
});

describe('next.config.ts (MOTIR-11241)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function resolvedConfig(): Promise<{ assetPrefix?: string; deploymentId?: string }> {
    vi.resetModules();
    const { default: config } = (await import('../../next.config')) as {
      default: { assetPrefix?: string; deploymentId?: string };
    };
    return config;
  }

  it('carries assetPrefix and deploymentId for a production build with the values present', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(ASSET_PREFIX_ENV, ORIGIN);
    vi.stubEnv(DEPLOYMENT_ID_ENV, SHA);
    const config = await resolvedConfig();
    expect(config.assetPrefix).toBe(ORIGIN);
    expect(config.deploymentId).toBe(SHA);
  });

  it('carries neither for a production build without the values', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(ASSET_PREFIX_ENV, '');
    vi.stubEnv(DEPLOYMENT_ID_ENV, '');
    const config = await resolvedConfig();
    expect(config.assetPrefix).toBeUndefined();
    expect(config.deploymentId).toBeUndefined();
  });

  it('carries neither outside a production build', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv(ASSET_PREFIX_ENV, ORIGIN);
    vi.stubEnv(DEPLOYMENT_ID_ENV, SHA);
    const config = await resolvedConfig();
    expect(config.assetPrefix).toBeUndefined();
    expect(config.deploymentId).toBeUndefined();
  });
});
