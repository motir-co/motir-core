import { describe, expect, it } from 'vitest';
import { probeCredentialExpiry } from '@/lib/health/credentialExpiryProbe';
import {
  CREDENTIAL_REGISTRY,
  LEAD_TIME_DAYS,
  type DeclaredCredential,
} from '@/lib/health/credentialRegistry';

// The credential-expiry probe (MOTIR-1933) is a pure function of
// `(registry, env, now)`, so every arm is pinned here with an injected clock and
// environment — no wall clock, no `process.env`.

const BILLING: DeclaredCredential = {
  envVar: 'GITHUB_BILLING_TOKEN',
  name: 'GitHub billing usage token',
  expiresAt: '2027-07-31',
  renewal: 'mint a replacement',
  source: 'MOTIR-1908',
};

const FLY: DeclaredCredential = {
  envVar: 'FLY_DEPLOYMENT_READ_TOKEN',
  name: 'Fly deployment read token',
  expiresAt: '2028-01-01',
  renewal: 'mint a replacement Fly token',
  source: 'MOTIR-7332',
};

const SET = { GITHUB_BILLING_TOKEN: 'ghp_x', FLY_DEPLOYMENT_READ_TOKEN: 'fo1_x' };

describe('probeCredentialExpiry', () => {
  it('is HEALTHY well before the lead time, and records the entry anyway', () => {
    const verdict = probeCredentialExpiry([BILLING], SET, new Date('2026-10-02T09:00:00Z'));

    expect(verdict.verdict).toBe('ok');
    expect(verdict.entries).toHaveLength(1);
    expect(verdict.entries[0]).toMatchObject({ state: 'healthy', daysRemaining: 301 });
    expect(verdict.skipped).toEqual([]);
  });

  it('is EXPIRING inside the lead time, naming the variable and the date', () => {
    const verdict = probeCredentialExpiry([BILLING], SET, new Date('2027-07-05T09:00:00Z'));

    expect(verdict.verdict).toBe('expiring');
    if (verdict.verdict !== 'expiring') throw new Error('unreachable');
    expect(verdict.offenders).toEqual([
      expect.objectContaining({
        envVar: 'GITHUB_BILLING_TOKEN',
        expiresAt: '2027-07-31',
        daysRemaining: 25,
        state: 'expiring',
      }),
    ]);
  });

  it('starts failing exactly LEAD_TIME_DAYS ahead, not a day earlier', () => {
    expect(LEAD_TIME_DAYS).toBe(30);
    const dayBefore = probeCredentialExpiry([BILLING], SET, new Date('2027-06-30T23:59:59Z'));
    const onTheDay = probeCredentialExpiry([BILLING], SET, new Date('2027-07-01T00:00:00Z'));

    expect(dayBefore.verdict).toBe('ok');
    expect(onTheDay.verdict).toBe('expiring');
  });

  it('honours a per-entry lead time', () => {
    const verdict = probeCredentialExpiry(
      [{ ...BILLING, leadTimeDays: 7 }],
      SET,
      new Date('2027-07-05T09:00:00Z'),
    );

    expect(verdict.verdict).toBe('ok');
  });

  it('is EXPIRED on and after the declared day, with a negative distance', () => {
    const onTheDay = probeCredentialExpiry([BILLING], SET, new Date('2027-07-31T00:00:00Z'));
    const after = probeCredentialExpiry([BILLING], SET, new Date('2027-08-10T09:00:00Z'));

    expect(onTheDay.verdict).toBe('expired');
    expect(after.verdict).toBe('expired');
    expect(after.entries[0]!.daysRemaining).toBeLessThan(0);
  });

  it('SKIPS an unset or blank variable rather than failing on it', () => {
    const unset = probeCredentialExpiry([BILLING], {}, new Date('2027-08-10T09:00:00Z'));
    const blank = probeCredentialExpiry(
      [BILLING],
      { GITHUB_BILLING_TOKEN: '  ' },
      new Date('2027-08-10T09:00:00Z'),
    );

    for (const verdict of [unset, blank]) {
      expect(verdict.verdict).toBe('ok');
      expect(verdict.entries).toEqual([]);
      expect(verdict.skipped).toEqual(['GITHUB_BILLING_TOKEN']);
    }
  });

  it('with two credentials, names only the one that fires', () => {
    const verdict = probeCredentialExpiry([BILLING, FLY], SET, new Date('2027-07-05T09:00:00Z'));

    expect(verdict.verdict).toBe('expiring');
    if (verdict.verdict !== 'expiring') throw new Error('unreachable');
    expect(verdict.offenders.map((e) => e.envVar)).toEqual(['GITHUB_BILLING_TOKEN']);
    expect(verdict.entries.map((e) => e.state)).toEqual(['expiring', 'healthy']);
  });

  it('EXPIRED outranks EXPIRING and still carries the expiring ones', () => {
    const verdict = probeCredentialExpiry(
      [BILLING, { ...FLY, expiresAt: '2027-08-20' }],
      SET,
      new Date('2027-08-01T09:00:00Z'),
    );

    expect(verdict.verdict).toBe('expired');
    if (verdict.verdict !== 'expired') throw new Error('unreachable');
    expect(verdict.offenders.map((e) => e.envVar)).toEqual(['GITHUB_BILLING_TOKEN']);
    expect(verdict.expiring.map((e) => e.envVar)).toEqual(['FLY_DEPLOYMENT_READ_TOKEN']);
  });

  it('THROWS on an unparseable date — a registry typo must not read as "never expires"', () => {
    expect(() =>
      probeCredentialExpiry([{ ...BILLING, expiresAt: '2027-31-07' }], SET, new Date()),
    ).toThrow(/not an ISO date/);
  });

  it('never puts a value in the verdict', () => {
    const secret = 'ghp_do-not-leak-1933';
    const verdict = probeCredentialExpiry(
      [BILLING],
      { GITHUB_BILLING_TOKEN: secret },
      new Date('2027-07-05T09:00:00Z'),
    );

    expect(JSON.stringify(verdict)).not.toContain(secret);
  });
});

describe('a credential held outside core (heldIn, MOTIR-9408)', () => {
  const HELD: DeclaredCredential = {
    envVar: 'MOTIR_AI_READ_TOKEN',
    name: 'motir-ai read token',
    expiresAt: '2027-09-15',
    renewal: 'mint a replacement',
    source: 'MOTIR-5208',
    heldIn: 'the motir-meta repository Actions secrets',
  };

  it("is judged on Motir's cloud although core never holds its variable", () => {
    const verdict = probeCredentialExpiry(
      [HELD],
      { MOTIR_CLOUD: 'true' },
      new Date('2027-09-01T09:00:00Z'),
    );

    expect(verdict.verdict).toBe('expiring');
    expect(verdict.entries).toEqual([
      expect.objectContaining({
        envVar: 'MOTIR_AI_READ_TOKEN',
        state: 'expiring',
        daysRemaining: 13,
      }),
    ]);
    expect(verdict.skipped).toEqual([]);
  });

  it('is skipped off the cloud, even when a variable of that name happens to be set', () => {
    for (const cloud of [undefined, '', 'false', '1']) {
      const verdict = probeCredentialExpiry(
        [HELD],
        { MOTIR_CLOUD: cloud, MOTIR_AI_READ_TOKEN: 'github_pat_x' },
        new Date('2027-09-20T09:00:00Z'),
      );
      expect(verdict.verdict).toBe('ok');
      expect(verdict.entries).toEqual([]);
      expect(verdict.skipped).toEqual(['MOTIR_AI_READ_TOKEN']);
    }
  });

  it('leaves an entry core holds judged by its own variable on the cloud', () => {
    const verdict = probeCredentialExpiry(
      [BILLING, HELD],
      { MOTIR_CLOUD: 'true' },
      new Date('2026-10-02T09:00:00Z'),
    );
    expect(verdict.skipped).toEqual(['GITHUB_BILLING_TOKEN']);
    expect(verdict.entries.map((e) => e.envVar)).toEqual(['MOTIR_AI_READ_TOKEN']);
  });
});

describe('CREDENTIAL_REGISTRY', () => {
  it('declares the billing token with a parseable date and a source', () => {
    const billing = CREDENTIAL_REGISTRY.find((c) => c.envVar === 'GITHUB_BILLING_TOKEN');

    expect(billing).toMatchObject({ expiresAt: '2027-07-31' });
    // MOTIR-7332 registers the Fly read token, at the date MOTIR-7331 recorded.
    const flyRead = CREDENTIAL_REGISTRY.find((c) => c.envVar === 'FLY_DEPLOYMENT_READ_TOKEN');
    expect(flyRead).toMatchObject({ expiresAt: '2046-09-27' });
    for (const entry of CREDENTIAL_REGISTRY) {
      expect(entry.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(`${entry.expiresAt}T00:00:00.000Z`))).toBe(false);
      expect(entry.source.length).toBeGreaterThan(0);
      expect(entry.renewal.length).toBeGreaterThan(0);
    }
  });

  // MOTIR-9408's inventory: every credential it marks as expiring on a known
  // date is registered, at the date its source recorded.
  it.each([
    ['GITHUB_BILLING_TOKEN', '2027-07-31', undefined],
    ['GITHUB_ENTERPRISE_ADMIN_TOKEN', '2027-10-23', undefined],
    ['MOTIR_HOSTING_FLY_API_TOKEN', '2027-10-28', undefined],
    ['FLY_CERTS_TOKEN', '2046-08-29', undefined],
    ['FLY_DEPLOYMENT_READ_TOKEN', '2046-09-27', undefined],
    ['MOTIR_AI_READ_TOKEN', '2027-09-15', 'motir-meta'],
    ['MARKETING_DISPATCH_TOKEN', '2027-11-09', 'motir-ai'],
    ['FLY_FLEET_DEPLOY_TOKEN', '2046-07-29', 'motir-ai'],
  ])('registers %s, expiring %s', (envVar, expiresAt, heldIn) => {
    const entry = CREDENTIAL_REGISTRY.find((c) => c.envVar === envVar);
    expect(entry).toMatchObject({ expiresAt });
    if (heldIn === undefined) expect(entry?.heldIn).toBeUndefined();
    else expect(entry?.heldIn).toContain(heldIn);
  });

  it('names each env var once, and no renewal still points at Fly secrets', () => {
    const names = CREDENTIAL_REGISTRY.map((c) => c.envVar);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(8);
    for (const entry of CREDENTIAL_REGISTRY) {
      expect(entry.renewal).not.toContain('fly secrets set');
    }
  });
});
