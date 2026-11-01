import { describe, expect, it } from 'vitest';
import {
  PREVIEW_CREDENTIAL_RENEW_MS,
  PREVIEW_STARTER_SEED_SOURCES,
  mayHoldPreviewCredential,
  previewCredentialDue,
  previewIneligibility,
  type PreviewSubject,
} from '@/lib/preview/enablement';
import {
  SEED_SOURCE_EXPO_MOBILE_FOUNDATION,
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_ORGANIZATION,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';

// Which repositories get previews (MOTIR-5775): Motir-created web starters with a
// hosting target and no takeover — and, for switching them off, every row that
// could ever have been switched on.

const ELIGIBLE: PreviewSubject = {
  seedSource: SEED_SOURCE_PLATFORM_STARTER,
  state: 'created',
  hostingTarget: 'fly',
  takeoverState: null,
  githubRepo: { owner: 'motir-projects' },
};

describe('previewIneligibility', () => {
  it('accepts a Motir-created web starter with a target, under every web starter key', () => {
    for (const seedSource of PREVIEW_STARTER_SEED_SOURCES) {
      expect(previewIneligibility({ ...ELIGIBLE, seedSource })).toBeNull();
    }
  });

  it.each([
    [{ state: 'connected' as const }, 'not_motir_created'],
    [{ seedSource: SEED_SOURCE_ORGANIZATION, state: 'connected' as const }, 'not_motir_created'],
    [{ seedSource: SEED_SOURCE_INITIALISED }, 'not_a_web_starter'],
    [{ seedSource: SEED_SOURCE_EXPO_MOBILE_FOUNDATION }, 'not_a_web_starter'],
    [{ hostingTarget: null }, 'no_hosting_target'],
    [{ githubRepo: null }, 'not_realized'],
    [{ takeoverState: 'requested' as const }, 'takeover_started'],
  ])('refuses %o as %s', (patch, reason) => {
    expect(previewIneligibility({ ...ELIGIBLE, ...patch })).toBe(reason);
  });
});

describe('mayHoldPreviewCredential', () => {
  it('is true for an eligible row and one whose takeover has begun, false otherwise', () => {
    expect(mayHoldPreviewCredential(ELIGIBLE)).toBe(true);
    expect(mayHoldPreviewCredential({ ...ELIGIBLE, takeoverState: 'requested' })).toBe(true);
    expect(mayHoldPreviewCredential({ ...ELIGIBLE, hostingTarget: null })).toBe(false);
    expect(mayHoldPreviewCredential({ ...ELIGIBLE, state: 'connected' })).toBe(false);
  });
});

describe('previewCredentialDue', () => {
  const now = new Date('2026-10-29T00:00:00.000Z');
  it('is due with under 14 days left, not with more, and never for a federated credential', () => {
    expect(
      previewCredentialDue(new Date(now.getTime() + PREVIEW_CREDENTIAL_RENEW_MS - 1), now),
    ).toBe(true);
    expect(previewCredentialDue(new Date(now.getTime() + PREVIEW_CREDENTIAL_RENEW_MS), now)).toBe(
      false,
    );
    expect(previewCredentialDue(null, now)).toBe(false);
  });
});
