import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  decodeInstallState,
  decodeInstallStateResult,
  encodeInstallState,
} from '@/lib/github/installState';

// Story 7.10 · MOTIR-1588 — the signed install-state token carried through the
// GitHub App install round-trip. Pure crypto (HMAC over BETTER_AUTH_SECRET); no
// I/O. `nowSeconds` is injectable so expiry is deterministic.

const SECRET = 'test-better-auth-secret-abcdef0123456789';
const NOW = 1_700_000_000;

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('encode/decode round-trip', () => {
  it('recovers the workspaceId + userId from a freshly-signed token', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    expect(decodeInstallState(token, NOW + 10)).toEqual({ workspaceId: 'ws_1', userId: 'usr_1' });
  });
});

describe('rejections', () => {
  it('rejects an EXPIRED token (past its 10-minute TTL)', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    expect(decodeInstallState(token, NOW + 601)).toBeNull(); // TTL is 600s
    expect(decodeInstallState(token, NOW + 599)).not.toBeNull();
  });

  it('rejects a TAMPERED payload (signature no longer matches)', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    const [payload, sig] = token.split('.');
    // Re-encode a different workspace but keep the original signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({ w: 'ws_ATTACKER', u: 'usr_1', exp: NOW + 600 }),
    ).toString('base64url');
    expect(decodeInstallState(`${forgedPayload}.${sig}`, NOW + 10)).toBeNull();
    // sanity: the untampered token still verifies
    expect(decodeInstallState(`${payload}.${sig}`, NOW + 10)).not.toBeNull();
  });

  it('rejects a token signed with a DIFFERENT secret', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    vi.stubEnv('BETTER_AUTH_SECRET', 'a-completely-different-secret');
    expect(decodeInstallState(token, NOW + 10)).toBeNull();
  });

  it('rejects malformed input (no signature, garbage)', () => {
    expect(decodeInstallState('', NOW)).toBeNull();
    expect(decodeInstallState('nosignature', NOW)).toBeNull();
    expect(decodeInstallState('not.base64url.payload', NOW)).toBeNull();
  });
});

// MOTIR-3755 — the caller needs to tell an EXPIRED state from a broken one: the
// first means "start again from Settings", the second means the token cannot be
// trusted. `decodeInstallState` keeps returning `null` for both.
describe('decodeInstallStateResult names WHY it rejected', () => {
  it('reports a verified token as ok, carrying the same state', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    expect(decodeInstallStateResult(token, NOW + 10)).toEqual({
      ok: true,
      issuedAt: NOW,
      state: { workspaceId: 'ws_1', userId: 'usr_1' },
    });
  });

  it('reports EXPIRED past the TTL, and not before it', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    expect(decodeInstallStateResult(token, NOW + 601)).toEqual({ ok: false, reason: 'expired' });
    expect(decodeInstallStateResult(token, NOW + 599).ok).toBe(true);
  });

  it('reports MALFORMED for a tampered payload, a foreign secret, and garbage', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    const [, sig] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ w: 'ws_ATTACKER', u: 'usr_1', exp: NOW + 600 }),
    ).toString('base64url');
    expect(decodeInstallStateResult(`${forgedPayload}.${sig}`, NOW + 10)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(decodeInstallStateResult('not.base64url.payload', NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });

    vi.stubEnv('BETTER_AUTH_SECRET', 'a-completely-different-secret');
    expect(decodeInstallStateResult(token, NOW + 10)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('will not call an UNSIGNED expired-looking payload expired', () => {
    // The benign banner must not be reachable from a string nobody signed: a
    // payload that fails the signature is malformed, whatever its `exp` says.
    const unsigned = Buffer.from(JSON.stringify({ w: 'ws_1', u: 'usr_1', exp: NOW - 1 })).toString(
      'base64url',
    );
    expect(decodeInstallStateResult(`${unsigned}.notasignature`, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

// Story MOTIR-8241 · MOTIR-8471 — the starting step's own address rides inside
// the signed envelope (payload key `c`), so an install started on the onboarding
// Connect step can come back to the address it left from.
describe('the return context', () => {
  const CONTEXT = {
    via: 'onboard_existing_project',
    steps: 'connect,index,discovery',
    backKind: 'work-item',
    backItem: 'MOTIR-12',
  };

  /** Sign an arbitrary payload exactly as the encoder does, so a test can put a
   *  shape the encoder would never write INSIDE a valid signature. */
  function signRaw(payload: object): string {
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', SECRET)
      .update(`github-install-state.v1.${b64}`)
      .digest('base64url');
    return `${b64}.${sig}`;
  }

  it('round-trips a context', () => {
    const token = encodeInstallState(
      {
        workspaceId: 'ws_1',
        userId: 'usr_1',
        origin: 'onboardingMigrateConnect',
        context: CONTEXT,
      },
      NOW,
    );
    expect(decodeInstallStateResult(token, NOW + 10)).toEqual({
      ok: true,
      issuedAt: NOW,
      state: {
        workspaceId: 'ws_1',
        userId: 'usr_1',
        origin: 'onboardingMigrateConnect',
        context: CONTEXT,
      },
    });
  });

  it('OMITS an empty context, so the token is byte-identical to one minted without the field', () => {
    const without = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    for (const context of [{}, { via: '' }, { nope: 'x' } as object]) {
      expect(encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1', context }, NOW)).toBe(
        without,
      );
    }
    expect(decodeInstallState(without, NOW + 10)).toStrictEqual({
      workspaceId: 'ws_1',
      userId: 'usr_1',
    });
  });

  it('DROPS an unreadable value rather than rejecting the token', () => {
    const token = signRaw({
      w: 'ws_1',
      u: 'usr_1',
      exp: NOW + 600,
      c: { via: 42, steps: 'x'.repeat(201), backKind: 'project', stray: 'kept?' },
    });
    expect(decodeInstallState(token, NOW + 10)).toEqual({
      workspaceId: 'ws_1',
      userId: 'usr_1',
      context: { backKind: 'project' },
    });
    // A context of the wrong shape altogether decodes to none.
    for (const c of ['a string', ['an', 'array'], null]) {
      expect(
        decodeInstallState(signRaw({ w: 'ws_1', u: 'usr_1', exp: NOW + 600, c }), NOW),
      ).toEqual({ workspaceId: 'ws_1', userId: 'usr_1' });
    }
  });

  it('a TAMPERED context fails the whole token as malformed', () => {
    const token = encodeInstallState(
      { workspaceId: 'ws_1', userId: 'usr_1', context: { backKind: 'project' } },
      NOW,
    );
    const [payloadB64, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    payload.c = { backKind: 'work-item', backItem: 'ATTACKER-1' };
    const forged = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(decodeInstallStateResult(`${forged}.${sig}`, NOW + 10)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('an EXPIRED token still yields its origin and context — the target, never the binding', () => {
    const token = encodeInstallState(
      {
        workspaceId: 'ws_1',
        userId: 'usr_1',
        origin: 'onboardingMigrateConnect',
        context: CONTEXT,
      },
      NOW,
    );
    expect(decodeInstallStateResult(token, NOW + 601)).toEqual({
      ok: false,
      reason: 'expired',
      origin: 'onboardingMigrateConnect',
      context: CONTEXT,
    });
    // The bare decoder still refuses it: nothing may bind from an expired state.
    expect(decodeInstallState(token, NOW + 601)).toBeNull();
  });

  it('an EXPIRED token with neither carries no extra key', () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    expect(decodeInstallStateResult(token, NOW + 601)).toStrictEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

// MOTIR-9828 — the Repositories room's `Connect a new one` names its PROJECT, so
// the setup handler can link what the round trip connected into it.
describe('the install state carries the project key', () => {
  it('round-trips `projectKey` with the room origin, and reports when it was minted', () => {
    const token = encodeInstallState(
      {
        workspaceId: 'ws_1',
        userId: 'usr_1',
        organizationId: 'org_1',
        origin: 'projectRepositories',
        projectKey: 'MOTIR',
      },
      NOW,
    );
    expect(decodeInstallStateResult(token, NOW + 10)).toEqual({
      ok: true,
      issuedAt: NOW,
      state: {
        workspaceId: 'ws_1',
        userId: 'usr_1',
        organizationId: 'org_1',
        origin: 'projectRepositories',
        projectKey: 'MOTIR',
      },
    });
  });

  it('OMITS an absent or over-long key, so the token is byte-identical to one minted without it', () => {
    const without = encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1' }, NOW);
    for (const projectKey of ['', 'X'.repeat(65)]) {
      expect(encodeInstallState({ workspaceId: 'ws_1', userId: 'usr_1', projectKey }, NOW)).toBe(
        without,
      );
    }
  });

  it('a forged project key fails the signature', () => {
    const token = encodeInstallState(
      { workspaceId: 'ws_1', userId: 'usr_1', projectKey: 'MOTIR' },
      NOW,
    );
    const [payloadB64, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    payload.p = 'OTHER';
    const forged = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(decodeInstallStateResult(`${forged}.${sig}`, NOW + 10)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
