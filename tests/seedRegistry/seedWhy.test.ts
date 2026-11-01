import { describe, expect, it } from 'vitest';
import { seedWhy } from '@/lib/seedRegistry/seedWhy';
import { SEED_SOURCE_INITIALISED } from '@/lib/projectRepos/vocabulary';
import { SHIPPED_ENTRIES, seedEntry, seedRow } from '../fixtures/seedRegistryFixtures';

// WHY THIS STARTER (Story MOTIR-704 · MOTIR-712; design MOTIR-705 §1.2), pure:
// every `seedMatch` reads its own sentence, a default is never dressed as a match,
// a person's re-point says so, and the facts tick only what the starter serves.

const SERVERLESS = SHIPPED_ENTRIES[0]!;
const INITIALISED = SHIPPED_ENTRIES[1]!;

const byName = (why: ReturnType<typeof seedWhy>) =>
  Object.fromEntries(why.facts.map((f) => [f.name, f]));

describe('seedWhy — the sentence', () => {
  it('reads a full match as matched, with the stack it matched on', () => {
    const why = seedWhy(seedRow(), SERVERLESS);
    expect(why.kind).toBe('matched');
    expect(byName(why)).toMatchObject({
      hosting: { state: 'hit', value: 'serverless' },
      use: { state: 'hit', value: 'mvp' },
      size: { state: 'hit', value: 'small' },
      stack: { state: 'hit', value: 'nextjs' },
    });
  });

  it('names the soft miss: a use the starter does not serve, then a size', () => {
    const softUse = seedWhy(seedRow({ hostingUseCase: 'planned_product' }), SERVERLESS);
    expect(softUse.kind).toBe('soft_use');
    expect(byName(softUse).use).toMatchObject({ state: 'miss', note: 'not_served' });

    const softSize = seedWhy(seedRow({ hostingSize: 'large' }), SERVERLESS);
    expect(softSize.kind).toBe('soft_size');
    expect(byName(softSize).size).toMatchObject({ state: 'miss', note: 'not_served' });
  });

  it('reads an unset use and size as Not set, never as a miss', () => {
    const why = seedWhy(seedRow({ hostingUseCase: null, hostingSize: null }), SERVERLESS);
    expect(why.kind).toBe('matched');
    expect(byName(why).use).toEqual({ name: 'use', state: 'none', value: null, empty: 'not_set' });
    expect(byName(why).size).toMatchObject({ state: 'none', empty: 'not_set' });
  });

  it('never dresses a default as a match', () => {
    const noStack = seedWhy(seedRow({ seedMatch: 'no_stack_signal' }), SERVERLESS);
    expect(noStack.kind).toBe('no_stack_signal');
    expect(byName(noStack).stack).toMatchObject({ state: 'none', empty: 'not_named' });

    const noTarget = seedWhy(seedRow({ seedMatch: 'no_target', hostingTarget: null }), SERVERLESS);
    expect(noTarget.kind).toBe('no_target');
    expect(byName(noTarget).hosting).toMatchObject({ state: 'none', empty: 'not_set' });
    expect(byName(noTarget).stack).toBeUndefined();
  });

  it('reads no_match, or any row on `initialised`, as no_match with the target unserved', () => {
    const why = seedWhy(seedRow({ seedMatch: 'no_match', hostingTarget: 'aws' }), INITIALISED);
    expect(why.kind).toBe('no_match');
    expect(byName(why).hosting).toMatchObject({
      state: 'miss',
      value: 'aws',
      note: 'no_role_starter',
    });
    expect(
      seedWhy(seedRow(), seedEntry(SEED_SOURCE_INITIALISED, { hostingTargets: [] })).kind,
    ).toBe('no_match');
  });

  it('reads a role the hosting port does not deploy as that role’s own starter', () => {
    const expo = seedEntry('expo-mobile', { role: 'mobile', stack: 'expo', hostingTargets: [] });
    const why = seedWhy(
      seedRow({ role: 'mobile', hostingTarget: null, seedMatch: 'matched' }),
      expo,
    );
    expect(why.kind).toBe('not_deployed');
    expect(byName(why).hosting).toMatchObject({ state: 'none', empty: 'none' });
  });

  it('says a person chose it when the row was re-pointed by hand', () => {
    expect(seedWhy(seedRow({ seedMatch: null }), SERVERLESS).kind).toBe('by_hand');
  });
});
