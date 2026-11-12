import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeCredentialExpiry } from '@/lib/health/credentialExpiryProbe';
import {
  CREDENTIAL_REGISTRY,
  LEAD_TIME_DAYS,
  type DeclaredCredential,
} from '@/lib/health/credentialRegistry';
import { credentialExpiryService } from '@/lib/services/credentialExpiryService';
import {
  judgeCredentials,
  platformCredentialsService,
} from '@/lib/services/platformCredentialsService';

// THE CREDENTIALS READ (MOTIR-9408, design MOTIR-11084). `judgeCredentials` is
// pure over the probe's verdict, so each case builds the verdict with the
// SHIPPED probe at a fixed clock — the day counts are the ones the page shows.

const NOW = new Date('2026-11-12T09:14:00.000Z');

function cred(envVar: string, expiresAt: string, over: Partial<DeclaredCredential> = {}) {
  return {
    envVar,
    name: `${envVar} name`,
    expiresAt,
    renewal: `renew ${envVar}`,
    source: `MOTIR-1 for ${envVar}`,
    ...over,
  } satisfies DeclaredCredential;
}

const MIXED: DeclaredCredential[] = [
  cred('HEALTHY_LATE', '2046-09-27'),
  cred('HEALTHY_SOON', '2027-07-31'),
  cred('EXPIRING', '2026-11-24'),
  cred('EXPIRED', '2026-11-09'),
  cred('UNSET_LATE', '2028-01-01'),
  cred('UNSET_SOON', '2027-01-01', { leadTimeDays: 10 }),
  cred('EXPIRING_SOONER', '2026-11-20', { leadTimeDays: 14 }),
];
const ENV = {
  HEALTHY_LATE: 'x',
  HEALTHY_SOON: 'x',
  EXPIRING: 'x',
  EXPIRED: 'x',
  EXPIRING_SOONER: 'x',
};

describe('judgeCredentials', () => {
  it('orders expired, expiring, not set, healthy — soonest expiry first in each', () => {
    const view = judgeCredentials(MIXED, probeCredentialExpiry(MIXED, ENV, NOW));
    expect(view.rows.map((r) => r.envVar)).toEqual([
      'EXPIRED',
      'EXPIRING_SOONER',
      'EXPIRING',
      'UNSET_SOON',
      'UNSET_LATE',
      'HEALTHY_SOON',
      'HEALTHY_LATE',
    ]);
    expect(view.counts).toEqual({ expired: 1, expiring: 2, notSet: 2, healthy: 2 });
    expect(view.overall).toBe('expired');
    expect(view.checkedAt).toBe(NOW.toISOString());
  });

  it('gives a not-set row its registry text, its lead time and no number', () => {
    const view = judgeCredentials(MIXED, probeCredentialExpiry(MIXED, ENV, NOW));
    const unset = view.rows.find((r) => r.envVar === 'UNSET_SOON');
    expect(unset).toEqual({
      envVar: 'UNSET_SOON',
      name: 'UNSET_SOON name',
      expiresAt: '2027-01-01',
      state: 'notSet',
      daysRemaining: null,
      leadTimeDays: 10,
      warnsFrom: '2026-12-22',
      renewal: 'renew UNSET_SOON',
      source: 'MOTIR-1 for UNSET_SOON',
    });
  });

  it('carries the day count and the warn-from date of a judged row', () => {
    const view = judgeCredentials(MIXED, probeCredentialExpiry(MIXED, ENV, NOW));
    const byVar = Object.fromEntries(view.rows.map((r) => [r.envVar, r]));
    expect(byVar.EXPIRED).toMatchObject({ state: 'expired', daysRemaining: -3 });
    expect(byVar.EXPIRING).toMatchObject({
      state: 'expiring',
      daysRemaining: 11,
      leadTimeDays: LEAD_TIME_DAYS,
    });
    expect(byVar.EXPIRING_SOONER).toMatchObject({ leadTimeDays: 14, warnsFrom: '2026-11-06' });
    expect(byVar.HEALTHY_SOON).toMatchObject({
      state: 'healthy',
      daysRemaining: 260,
      warnsFrom: '2027-07-01',
    });
  });

  it('keeps the registry order between two rows of one group and one date', () => {
    const registry = [cred('FIRST', '2030-01-01'), cred('SECOND', '2030-01-01')];
    const rows = judgeCredentials(registry, probeCredentialExpiry(registry, {}, NOW)).rows;
    expect(rows.map((r) => r.envVar)).toEqual(['FIRST', 'SECOND']);
  });

  it('reads expiring when nothing has expired', () => {
    const registry = MIXED.filter((c) => c.envVar !== 'EXPIRED');
    const view = judgeCredentials(registry, probeCredentialExpiry(registry, ENV, NOW));
    expect(view.overall).toBe('expiring');
  });

  it('reads ok only when at least one credential was judged', () => {
    const registry = [cred('A', '2030-01-01'), cred('B', '2031-01-01')];
    expect(
      judgeCredentials(registry, probeCredentialExpiry(registry, { A: 'x' }, NOW)).overall,
    ).toBe('ok');
    const none = judgeCredentials(registry, probeCredentialExpiry(registry, {}, NOW));
    expect(none.overall).toBe('noneSet');
    expect(none.counts).toEqual({ expired: 0, expiring: 0, notSet: 2, healthy: 0 });
  });

  it('reads empty for a registry with no entry', () => {
    const view = judgeCredentials([], probeCredentialExpiry([], {}, NOW));
    expect(view).toMatchObject({ status: 'ok', overall: 'empty', rows: [] });
  });

  it('drops a skipped name the registry does not know rather than inventing a row', () => {
    const view = judgeCredentials([], {
      verdict: 'ok',
      checkedAt: NOW.toISOString(),
      entries: [],
      skipped: ['GHOST'],
    });
    expect(view.rows).toEqual([]);
  });

  it('never carries a value, whatever the environment holds', () => {
    const secret = 'ghp_SECRET_VALUE_never_rendered';
    const registry = [cred('TOKEN', '2030-01-01')];
    const view = judgeCredentials(
      registry,
      probeCredentialExpiry(registry, { TOKEN: secret }, NOW),
    );
    expect(JSON.stringify(view)).not.toContain(secret);
  });
});

describe('platformCredentialsService.read', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('judges the real registry through the daily check’s own service', () => {
    const check = vi.spyOn(credentialExpiryService, 'check');
    const view = platformCredentialsService.read(NOW);
    expect(check).toHaveBeenCalledWith(NOW);
    expect(view.status).toBe('ok');
    if (view.status !== 'ok') return;
    expect(view.rows.map((r) => r.envVar).sort()).toEqual(
      CREDENTIAL_REGISTRY.map((c) => c.envVar).sort(),
    );
  });

  it('answers failed with the thrown message, listing nothing', () => {
    vi.spyOn(credentialExpiryService, 'check').mockImplementation(() => {
      throw new Error('credential registry: expiresAt "25-11-2026" is not an ISO date');
    });
    expect(platformCredentialsService.read(NOW)).toEqual({
      status: 'failed',
      checkedAt: NOW.toISOString(),
      message: 'credential registry: expiresAt "25-11-2026" is not an ISO date',
    });
  });

  it('answers failed for a thrown non-Error too', () => {
    vi.spyOn(credentialExpiryService, 'check').mockImplementation(() => {
      throw 'boom';
    });
    expect(platformCredentialsService.read(NOW)).toMatchObject({
      status: 'failed',
      message: 'boom',
    });
  });
});
