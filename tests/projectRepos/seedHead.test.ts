import { describe, expect, it } from 'vitest';
import { isOnlyItsSeed, NO_COMMIT_BEYOND_TEMPLATE } from '@/lib/projectRepos/seedHead';

// The one predicate behind "a created repository is not indexed until it has a
// commit of its own" (MOTIR-4589). Unknown is never a reason to withhold an
// index, so every case where the seed is not KNOWN answers false.

const SEED = 'a'.repeat(40);
const created = (seedHeadSha: string | null = SEED) => ({ state: 'created', seedHeadSha });

describe('isOnlyItsSeed', () => {
  it('holds a created repository whose head is still its seed head', () => {
    expect(isOnlyItsSeed([created()], SEED)).toBe(true);
  });

  it('holds it when no default-branch push has been observed since creation', () => {
    expect(isOnlyItsSeed([created()], null)).toBe(true);
  });

  it('releases it once the default branch moves past the seed', () => {
    expect(isOnlyItsSeed([created()], 'b'.repeat(40))).toBe(false);
  });

  it('never holds a repository with no recorded seed head (created before MOTIR-4589)', () => {
    expect(isOnlyItsSeed([created(null)], null)).toBe(false);
  });

  it('never holds a repository someone CONNECTED, even beside a created row', () => {
    expect(isOnlyItsSeed([{ state: 'connected', seedHeadSha: null }], null)).toBe(false);
    expect(isOnlyItsSeed([created(), { state: 'connected', seedHeadSha: null }], SEED)).toBe(false);
  });

  it('never holds a repository no row realizes', () => {
    expect(isOnlyItsSeed([], null)).toBe(false);
  });

  it('names its verdict as an index skip reason, distinct from a failure', () => {
    expect(NO_COMMIT_BEYOND_TEMPLATE).toBe('no_commit_beyond_template');
  });
});
