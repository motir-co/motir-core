import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MotirAiBadRequestError,
  MotirAiCodeGraphRefusedError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';
import {
  listCodeGraphUploadCredentials,
  mintCodeGraphUploadCredential,
  revokeCodeGraphUploadCredential,
} from '@/lib/ai/motirAiClient';

// The SCIP UPLOAD-CREDENTIAL clients (MOTIR-12339 · story MOTIR-12262), against
// motir-ai's three routes (motir-ai `docs/contract.md`, MOTIR-12337). Every answer is
// validated, never cast; a refusal keeps its motir-ai code; no thrown error repeats
// the token a mint answered.

const SCOPE = { coreOrganizationId: 'org_1', repoRef: 'motir-projects/acme-web' };
const TOKEN = 'cgk_bearer_secret_value_1234567890';

const MINTED = {
  credentialId: 'cred_1',
  name: 'GitHub Actions',
  displayPrefix: 'cgk_bearer_s',
  token: TOKEN,
  repositoryId: 'cgr_1',
  uploadUrl: 'https://codegraph.example.test',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function problem(code: string, status: number): Response {
  return jsonResponse(
    { type: `https://motir.co/errors/${code}`, title: code, status, code },
    status,
  );
}

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callOf = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls[0] as unknown as [string, RequestInit];

beforeEach(() => {
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.example.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('mintCodeGraphUploadCredential', () => {
  it('POSTs the scope and name with the service token and answers every field', async () => {
    const fetchMock = stubFetch(() => jsonResponse(MINTED, 201));
    await expect(
      mintCodeGraphUploadCredential({ ...SCOPE, name: 'GitHub Actions' }),
    ).resolves.toEqual(MINTED);
    const [url, init] = callOf(fetchMock);
    expect(url).toBe('https://ai.example.test/v1/code-graph/upload-credentials');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer svc-token');
    expect(JSON.parse(String(init.body))).toEqual({ ...SCOPE, name: 'GitHub Actions' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['credentialId', 'name', 'displayPrefix', 'token', 'repositoryId', 'uploadUrl'])(
    'refuses an answer with no %s, without repeating the token',
    async (field) => {
      stubFetch(() => jsonResponse({ ...MINTED, [field]: '' }, 201));
      const err = await mintCodeGraphUploadCredential({ ...SCOPE, name: 'n' }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MotirAiUnavailableError);
      expect((err as Error).message).toContain(`'${field}'`);
      expect((err as Error).message).not.toContain(TOKEN);
    },
  );

  it.each([['not json'], ['[]'], ['null']])('refuses a non-object body %s', async (raw) => {
    stubFetch(() => new Response(raw, { status: 201 }));
    await expect(mintCodeGraphUploadCredential({ ...SCOPE, name: 'n' })).rejects.toThrow(
      /malformed 'body'/,
    );
  });

  it.each([
    ['codegraph_repository_not_registered', 409],
    ['upload_credential_limit_reached', 409],
  ] as const)('keeps the %s code on its own class', async (code, status) => {
    stubFetch(() => problem(code, status));
    const err = await mintCodeGraphUploadCredential({ ...SCOPE, name: 'n' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MotirAiCodeGraphRefusedError);
    expect(err).toBeInstanceOf(MotirAiBadRequestError);
    expect((err as MotirAiCodeGraphRefusedError).problemCode).toBe(code);
    expect((err as MotirAiCodeGraphRefusedError).httpStatus).toBe(409);
  });

  it('makes codegraph_unavailable an unavailable error', async () => {
    stubFetch(() => problem('codegraph_unavailable', 503));
    await expect(mintCodeGraphUploadCredential({ ...SCOPE, name: 'n' })).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });
});

describe('listCodeGraphUploadCredentials', () => {
  const ROW = {
    credentialId: 'cred_1',
    name: 'GitHub Actions',
    displayPrefix: 'cgk_bearer_s',
    createdAt: '2026-11-28T00:00:00.000Z',
    revokedAt: null,
  };

  it('GETs with the scope as a query and answers the rows', async () => {
    const revoked = { ...ROW, credentialId: 'cred_2', revokedAt: '2026-11-28T01:00:00.000Z' };
    const fetchMock = stubFetch(() =>
      jsonResponse({ repositoryId: 'cgr_1', credentials: [ROW, revoked] }),
    );
    await expect(listCodeGraphUploadCredentials(SCOPE)).resolves.toEqual([ROW, revoked]);
    const [url, init] = callOf(fetchMock);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/v1/code-graph/upload-credentials');
    expect(Object.fromEntries(parsed.searchParams)).toEqual(SCOPE);
    expect(init.method).toBe('GET');
  });

  it.each([
    [{ repositoryId: 'cgr_1' }, "'credentials'"],
    [{ credentials: ['x'] }, "'credentials.0'"],
    [{ credentials: [[]] }, "'credentials.0'"],
    [{ credentials: [{ ...ROW, revokedAt: 5 }] }, "'credentials.0.revokedAt'"],
    [{ credentials: [{ ...ROW, createdAt: undefined }] }, "'createdAt'"],
  ])('refuses a malformed listing %j', async (body, field) => {
    stubFetch(() => jsonResponse(body));
    await expect(listCodeGraphUploadCredentials(SCOPE)).rejects.toThrow(field);
  });

  it('maps a refusal through the problem taxonomy', async () => {
    stubFetch(() => problem('codegraph_repository_not_registered', 409));
    await expect(listCodeGraphUploadCredentials(SCOPE)).rejects.toBeInstanceOf(
      MotirAiCodeGraphRefusedError,
    );
  });
});

describe('revokeCodeGraphUploadCredential', () => {
  it('POSTs to the encoded id with the scope and answers revoked', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ credentialId: 'a/b', revoked: true }));
    await expect(
      revokeCodeGraphUploadCredential({ ...SCOPE, credentialId: 'a/b' }),
    ).resolves.toEqual({ credentialId: 'a/b', revoked: true });
    const [url, init] = callOf(fetchMock);
    expect(url).toBe('https://ai.example.test/v1/code-graph/upload-credentials/a%2Fb/revoke');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(SCOPE);
  });

  it('answers a repeat as revoked false', async () => {
    stubFetch(() => jsonResponse({ credentialId: 'c', revoked: false }));
    await expect(revokeCodeGraphUploadCredential({ ...SCOPE, credentialId: 'c' })).resolves.toEqual(
      {
        credentialId: 'c',
        revoked: false,
      },
    );
  });

  it.each([
    [{ credentialId: 'c', revoked: 'yes' }, "'revoked'"],
    [{ revoked: true }, "'credentialId'"],
  ])('refuses a malformed answer %j', async (body, field) => {
    stubFetch(() => jsonResponse(body));
    await expect(revokeCodeGraphUploadCredential({ ...SCOPE, credentialId: 'c' })).rejects.toThrow(
      field,
    );
  });

  it('maps codegraph_unavailable to an unavailable error', async () => {
    stubFetch(() => problem('codegraph_unavailable', 503));
    await expect(
      revokeCodeGraphUploadCredential({ ...SCOPE, credentialId: 'c' }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});
