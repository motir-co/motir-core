import { describe, expect, it } from 'vitest';
import { HostedReleaseCause, HostedReleaseState } from '@/generated/prisma/client';
import {
  applicationHost,
  applicationHostForWorkspaceHostname,
  deriveApplicationSlug,
} from '@/lib/hosting/applicationAddress';
import { deployEligibilityRefusal, isDeployEligible } from '@/lib/hosting/deployEligibility';
import {
  HOSTED_RELEASE_CAUSES,
  HOSTED_RELEASE_STATES,
  isHostedReleaseState,
  isLegalReleaseTransition,
  type HostedReleaseState as State,
} from '@/lib/hosting/vocabulary';
import { refuseApplicationSlug } from '@/lib/publicAddresses/reservedNames';

// The release vocabulary, the deploy-eligibility rule and the application
// address (Story MOTIR-9797 · MOTIR-10026). Pure — no database.

describe('the release vocabulary', () => {
  it('is exactly the six states, pinned to the Prisma enum', () => {
    expect([...HOSTED_RELEASE_STATES]).toEqual([
      'building',
      'releasing',
      'live',
      'failed',
      'replaced',
      'rolled_back',
    ]);
    expect([...HOSTED_RELEASE_STATES].sort()).toEqual(Object.values(HostedReleaseState).sort());
    expect([...HOSTED_RELEASE_CAUSES].sort()).toEqual(Object.values(HostedReleaseCause).sort());
  });

  it('recognises a state', () => {
    expect(isHostedReleaseState('live')).toBe(true);
    expect(isHostedReleaseState('deployed')).toBe(false);
  });

  it('answers every ordered pair of the six states', () => {
    // Written out in full, not derived from the table under test: a pair that
    // is missing here or legal by accident fails.
    const legal = new Set([
      'building>releasing',
      'building>failed',
      'releasing>live',
      'releasing>failed',
      'live>replaced',
      'live>rolled_back',
      'replaced>live',
      'rolled_back>live',
    ]);
    let checked = 0;
    for (const from of HOSTED_RELEASE_STATES) {
      for (const to of HOSTED_RELEASE_STATES) {
        const expected = legal.has(`${from}>${to}`);
        expect(isLegalReleaseTransition(from as State, to as State), `${from} → ${to}`).toBe(
          expected,
        );
        checked += 1;
      }
    }
    expect(checked).toBe(36);
  });

  it('makes failed terminal', () => {
    for (const to of HOSTED_RELEASE_STATES) {
      expect(isLegalReleaseTransition('failed', to)).toBe(false);
    }
  });
});

describe('deploy eligibility', () => {
  const motir = {
    seedSource: 'initialised',
    state: 'created' as const,
    hostingTarget: 'fly' as const,
  };

  it('admits an established Motir repository with a target', () => {
    expect(deployEligibilityRefusal(motir)).toBeNull();
    expect(isDeployEligible({ ...motir, state: 'connected' })).toBe(true);
  });

  it('refuses a customer repository first, whatever else holds', () => {
    expect(
      deployEligibilityRefusal({
        seedSource: 'organization',
        state: 'proposed',
        hostingTarget: null,
      }),
    ).toBe('customer_repository');
  });

  it('refuses a row that is not established', () => {
    for (const state of ['proposed', 'creating', 'skipped', 'failed'] as const) {
      expect(deployEligibilityRefusal({ ...motir, state })).toBe('not_established');
    }
  });

  it('refuses a repository with no target', () => {
    expect(deployEligibilityRefusal({ ...motir, hostingTarget: null })).toBe('no_target');
    expect(isDeployEligible({ ...motir, hostingTarget: null })).toBe(false);
  });
});

describe('the application slug', () => {
  const none = new Set<string>();

  it('derives a DNS-label slug from the repository name', () => {
    expect(deriveApplicationSlug('Shop App', none)).toBe('shop-app');
    expect(deriveApplicationSlug('my_repo.web', none)).toBe('my-repo-web');
    expect(deriveApplicationSlug('--Edge--Case--', none)).toBe('edge-case');
    expect(deriveApplicationSlug('Café', none)).toBe('cafe');
  });

  it('never keeps the reserved separator', () => {
    expect(deriveApplicationSlug('a--b', none)).toBe('a-b');
    expect(deriveApplicationSlug('shop -- acme', none)).toBe('shop-acme');
  });

  it('pads a short name and names an empty one', () => {
    expect(deriveApplicationSlug('ui', none)).toBe('ui-app');
    expect(deriveApplicationSlug('!!!', none)).toBe('app');
  });

  it('cuts a long name to 30 without a trailing hyphen', () => {
    const slug = deriveApplicationSlug(`${'a'.repeat(29)} tail`, none);
    expect(slug).toBe('a'.repeat(29));
    expect(deriveApplicationSlug('x'.repeat(40), none)).toHaveLength(30);
  });

  it('takes the first free -2, -3 on a clash, still within 30', () => {
    expect(deriveApplicationSlug('Shop App', new Set(['shop-app']))).toBe('shop-app-2');
    expect(deriveApplicationSlug('Shop App', new Set(['shop-app', 'shop-app-2']))).toBe(
      'shop-app-3',
    );
    const long = deriveApplicationSlug('x'.repeat(40), new Set(['x'.repeat(30)]));
    expect(long).toBe(`${'x'.repeat(28)}-2`);
  });

  it('always yields a slug the address rule accepts', () => {
    for (const name of ['Shop App', 'ui', '', 'a--b', 'Ünïcødé repo', 'x'.repeat(80)]) {
      expect(refuseApplicationSlug(deriveApplicationSlug(name, none)), name).toBeNull();
    }
  });
});

describe('the application host', () => {
  it('is <slug>--<workspace label>.<base>', () => {
    expect(applicationHost('shop-app', 'acme', 'motir.site')).toBe('shop-app--acme.motir.site');
    expect(applicationHostForWorkspaceHostname('shop-app', 'acme.motir.site')).toBe(
      'shop-app--acme.motir.site',
    );
  });
});
