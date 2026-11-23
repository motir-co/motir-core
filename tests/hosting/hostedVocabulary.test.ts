import { describe, expect, it } from 'vitest';
import {
  HostedApplicationState,
  HostedReleaseCause,
  HostedReleaseState,
} from '@/generated/prisma/client';
import {
  applicationHost,
  applicationHostForWorkspaceHostname,
  deriveApplicationSlug,
} from '@/lib/hosting/applicationAddress';
import {
  deployEligibilityRefusal,
  isDeployEligible,
  type DeployEligibilityFacts,
  type DeployEligibilityRefusal,
} from '@/lib/hosting/deployEligibility';
import {
  HOSTED_RELEASE_CAUSES,
  HOSTED_APPLICATION_EXPORT_KINDS,
  HOSTED_APPLICATION_STATES,
  HOSTED_RELEASE_STATES,
  isHostedApplicationExportKind,
  isHostedApplicationState,
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

describe('the application handover vocabulary (MOTIR-9800)', () => {
  it('is exactly the four application states, pinned to the Prisma enum', () => {
    expect([...HOSTED_APPLICATION_STATES]).toEqual([
      'live',
      'handing_over',
      'grace',
      'handed_over',
    ]);
    expect([...HOSTED_APPLICATION_STATES].sort()).toEqual(
      Object.values(HostedApplicationState).sort(),
    );
    expect(isHostedApplicationState('grace')).toBe(true);
    expect(isHostedApplicationState('stopped')).toBe(false);
  });

  it('knows the two export kinds', () => {
    expect([...HOSTED_APPLICATION_EXPORT_KINDS]).toEqual(['on_demand', 'final']);
    expect(isHostedApplicationExportKind('final')).toBe(true);
    expect(isHostedApplicationExportKind('nightly')).toBe(false);
  });
});

describe('deploy eligibility', () => {
  const motir: DeployEligibilityFacts = {
    seedSource: 'initialised',
    state: 'created',
    hostingTarget: 'fly',
    takeoverState: null,
    takeoverTransferredAt: null,
    applicationState: null,
  };

  it('admits an established Motir repository with a target', () => {
    expect(deployEligibilityRefusal(motir)).toBeNull();
    expect(isDeployEligible({ ...motir, state: 'connected' })).toBe(true);
  });

  it('refuses a customer repository first, whatever else holds', () => {
    expect(
      deployEligibilityRefusal({
        ...motir,
        seedSource: 'organization',
        state: 'proposed',
        hostingTarget: null,
        takeoverState: 'done',
        applicationState: 'grace',
      }),
    ).toBe('customer_repository');
  });

  // MOTIR-12127: the takeover's release freeze. Each row is one fact set and the
  // answer it must get; every other fact is the plain eligible Motir row.
  it.each<[string, Partial<DeployEligibilityFacts>, DeployEligibilityRefusal | null]>([
    ['a live application with no takeover', { applicationState: 'live' }, null],
    ['a takeover requested, not yet moved', { takeoverState: 'requested' }, null],
    ['a transfer pending', { takeoverState: 'transfer_pending' }, null],
    ['a takeover that failed before the move', { takeoverState: 'failed' }, null],
    ['a repository awaiting reinstall', { takeoverState: 'awaiting_reinstall' }, 'taken_over'],
    ['a takeover done', { takeoverState: 'done' }, 'taken_over'],
    [
      'a takeover that failed AFTER the move',
      { takeoverState: 'failed', takeoverTransferredAt: new Date('2026-11-20T10:00:00Z') },
      'taken_over',
    ],
    ['an application handing over', { applicationState: 'handing_over' }, 'taken_over'],
    ['an application in grace', { applicationState: 'grace' }, 'taken_over'],
    ['an application handed over', { applicationState: 'handed_over' }, 'taken_over'],
    [
      'a taken-over row that is also not established',
      { takeoverState: 'done', state: 'proposed', hostingTarget: null },
      'taken_over',
    ],
  ])('%s', (_label, facts, expected) => {
    expect(deployEligibilityRefusal({ ...motir, ...facts })).toBe(expected);
    expect(isDeployEligible({ ...motir, ...facts })).toBe(expected === null);
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
