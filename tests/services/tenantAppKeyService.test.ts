import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as client from '@/lib/gateway/appKeyClient';
import {
  GatewayAppKeyConfigError,
  GatewayAppKeyInvalidInputError,
  GatewayAppKeyRefusedError,
  GatewayAppKeyUnavailableError,
} from '@/lib/gateway/errors';
import { tenantAppKeyService } from '@/lib/services/tenantAppKeyService';
import {
  TenantAppKeyNotMintedError,
  TenantAppKeyNotRevokedError,
} from '@/lib/tenantAppKeys/errors';

// TENANT-APP KEYS (MOTIR-8339) — the service over the gateway client. `fetch` is
// the seam for the request shape; the client is spied on only to drive each
// typed gateway error through the service's mapping.

const GATEWAY = 'https://gateway.test';
const SECRET = 'app-key-mint-secret-value-of-enough-length';
const NOW = new Date('2026-11-22T12:00:00.000Z');
const LATER = new Date('2026-11-23T12:00:00.000Z');
const INPUT = {
  projectId: 'proj_1',
  payingOrganizationId: 'org_1',
  expiresAt: LATER,
  quota: 250_000,
  models: ['m-1'],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubEnv('MOTIR_GATEWAY_URL', GATEWAY);
  vi.stubEnv('MOTIR_APP_KEY_MINT_SECRET', SECRET);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('mintAppKey', () => {
  it('mints for the project and its paying org and returns the DTO', async () => {
    const fetchMock = vi.fn(async () =>
      json(
        {
          key: 'sk-app-1',
          keyId: 9,
          projectRef: 'proj_1',
          coreOrganizationId: 'org_1',
          expiresAt: Math.floor(LATER.getTime() / 1000),
          lane: 'app',
        },
        201,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(tenantAppKeyService.mintAppKey(INPUT, NOW)).resolves.toEqual({
      key: 'sk-app-1',
      keyId: 9,
      projectId: 'proj_1',
      payingOrganizationId: 'org_1',
      expiresAt: LATER,
      lane: 'app',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GATEWAY}/api/motir/app-keys`);
    expect(JSON.parse(String(init.body))).toEqual({
      projectRef: 'proj_1',
      coreOrganizationId: 'org_1',
      expiresAt: Math.floor(LATER.getTime() / 1000),
      quota: 250_000,
      models: ['m-1'],
    });
  });

  it('passes quota and models unchanged', async () => {
    const spy = vi.spyOn(client, 'mintGatewayAppKey').mockResolvedValue({
      key: 'sk',
      keyId: 1,
      projectRef: 'proj_1',
      coreOrganizationId: 'org_1',
      expiresAt: LATER,
      lane: 'app',
    });
    await tenantAppKeyService.mintAppKey({ ...INPUT, quota: 7, models: ['a', 'b'] }, NOW);
    expect(spy).toHaveBeenCalledWith({
      projectRef: 'proj_1',
      coreOrganizationId: 'org_1',
      expiresAt: LATER,
      quota: 7,
      models: ['a', 'b'],
    });
  });

  it.each([
    ['an empty project id', { projectId: ' ' }],
    ['an empty org id', { payingOrganizationId: '' }],
    ['an expiry equal to now', { expiresAt: NOW }],
    ['an expiry in the past', { expiresAt: new Date(NOW.getTime() - 1) }],
    ['quota 0', { quota: 0 }],
    ['quota -1', { quota: -1 }],
    ['quota 1.5', { quota: 1.5 }],
    ['quota NaN', { quota: Number.NaN }],
    ['a quota past the safe integers', { quota: Number.MAX_SAFE_INTEGER + 1 }],
    ['models []', { models: [] }],
    ["a model ''", { models: [''] }],
    ["a model '  '", { models: ['  '] }],
    ["a model 'a,b'", { models: ['a,b'] }],
  ])('refuses %s as invalid_request with no request', async (_name, patch) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await tenantAppKeyService.mintAppKey({ ...INPUT, ...patch }, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(TenantAppKeyNotMintedError);
    expect(err).toMatchObject({ reason: 'invalid_request', gatewayCode: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('defaults now to the current time', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      tenantAppKeyService.mintAppKey({ ...INPUT, expiresAt: new Date(Date.now() - 1000) }),
    ).rejects.toMatchObject({ reason: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['not_configured', new GatewayAppKeyConfigError('MOTIR_APP_KEY_MINT_SECRET is not set'), null],
    [
      'refused',
      new GatewayAppKeyRefusedError(400, 'app_key_not_minted', 'bad'),
      'app_key_not_minted',
    ],
    ['invalid_request', new GatewayAppKeyInvalidInputError('quota must be positive'), null],
    ['unavailable', new GatewayAppKeyUnavailableError('down'), null],
    ['unavailable', new Error('surprise'), null],
    ['unavailable', 'a thrown string', null],
  ])('maps a gateway failure to reason %s', async (reason, thrown, code) => {
    vi.spyOn(client, 'mintGatewayAppKey').mockRejectedValue(thrown);
    const err = await tenantAppKeyService.mintAppKey(INPUT, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(TenantAppKeyNotMintedError);
    expect(err).toMatchObject({ reason, gatewayCode: code, name: 'TenantAppKeyNotMintedError' });
  });

  it('surfaces the gateway refusing a mint as refused, not a raw HTTP failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ error: { code: 'app_key_not_minted', message: 'models is required' } }, 400),
      ),
    );
    const err = await tenantAppKeyService.mintAppKey(INPUT, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(TenantAppKeyNotMintedError);
    expect(err).toMatchObject({ reason: 'refused', gatewayCode: 'app_key_not_minted' });
  });

  it('fails closed as not_configured with no request when the secret is unset', async () => {
    vi.stubEnv('MOTIR_APP_KEY_MINT_SECRET', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(tenantAppKeyService.mintAppKey(INPUT, NOW)).rejects.toMatchObject({
      reason: 'not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('revokeAppKeys', () => {
  it('revokes one key by its id', async () => {
    const fetchMock = vi.fn(async () => json({ keyId: 9, revoked: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(tenantAppKeyService.revokeAppKeys({ keyId: 9 })).resolves.toEqual({ revoked: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GATEWAY}/api/motir/app-keys/9`);
    expect(init.method).toBe('DELETE');
  });

  it('revokes every key of a project, and a repeat answering 0 is not an error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ projectRef: 'proj_1', revoked: 2 }))
      .mockResolvedValueOnce(json({ projectRef: 'proj_1', revoked: 0 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(tenantAppKeyService.revokeAppKeys({ projectId: 'proj_1' })).resolves.toEqual({
      revoked: 2,
    });
    await expect(tenantAppKeyService.revokeAppKeys({ projectId: 'proj_1' })).resolves.toEqual({
      revoked: 0,
    });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      `${GATEWAY}/api/motir/app-keys?projectRef=proj_1`,
    );
  });

  it.each([
    ['not_configured', new GatewayAppKeyConfigError('unset'), null],
    [
      'refused',
      new GatewayAppKeyRefusedError(401, 'app_key_unauthorized', 'no'),
      'app_key_unauthorized',
    ],
    ['invalid_request', new GatewayAppKeyInvalidInputError('quota must be positive'), null],
    ['unavailable', new GatewayAppKeyUnavailableError('down'), null],
    ['unavailable', new Error('surprise'), null],
  ])('maps a gateway failure to reason %s', async (reason, thrown, code) => {
    vi.spyOn(client, 'revokeGatewayAppKey').mockRejectedValue(thrown);
    vi.spyOn(client, 'revokeGatewayAppKeysForProject').mockRejectedValue(thrown);
    for (const target of [{ keyId: 1 }, { projectId: 'p' }]) {
      const err = await tenantAppKeyService.revokeAppKeys(target).catch((e) => e);
      expect(err).toBeInstanceOf(TenantAppKeyNotRevokedError);
      expect(err).toMatchObject({ reason, gatewayCode: code });
    }
  });
});

describe('the service and the client keep the key to themselves', () => {
  const ROOT = join(__dirname, '..', '..');
  it.each(['lib/gateway/appKeyClient.ts', 'lib/services/tenantAppKeyService.ts'])(
    '%s logs nothing and reads no database',
    (path) => {
      const text = readFileSync(join(ROOT, path), 'utf8');
      expect(text.startsWith("import 'server-only';")).toBe(true);
      expect(text).not.toMatch(/console\.|logger\.|from '@\/lib\/log/);
      expect(text).not.toMatch(/from '@\/lib\/db'/);
    },
  );
});
