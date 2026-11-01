import { describe, expect, it } from 'vitest';
import type { SeedRegistryEntryDto } from '@/lib/dto/seedRegistry';
import { matchSeedEntry, seedEntryFitsRow } from '@/lib/projectRepos/seedMatching';
import {
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';

// THE SEED MATCHING (Story MOTIR-704 · MOTIR-709; decision MOTIR-706 v2 §3.5),
// pure: role and target are HARD, stack is hard only when a signal names one,
// use case then size are SOFT, ties go to the most recently promoted, and no
// candidate is `initialised` with `no_match` — never a guess.

type Entry = Pick<
  SeedRegistryEntryDto,
  | 'key'
  | 'role'
  | 'stack'
  | 'status'
  | 'useCases'
  | 'sizes'
  | 'hostingTargets'
  | 'promotedAt'
  | 'createdAt'
>;

function entry(key: string, over: Partial<Entry> = {}): Entry {
  return {
    key,
    role: 'web',
    stack: 'nextjs',
    status: 'active',
    useCases: ['mvp'],
    sizes: ['small'],
    hostingTargets: ['fly'],
    promotedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

const SHIPPED: Entry[] = [
  entry(SEED_SOURCE_PLATFORM_STARTER, {
    useCases: ['internal_tool', 'mvp'],
    hostingTargets: ['serverless'],
  }),
  entry(SEED_SOURCE_INITIALISED, {
    role: 'any',
    stack: 'any',
    useCases: ['internal_tool', 'mvp', 'planned_product'],
    sizes: ['small', 'medium', 'large'],
    hostingTargets: [],
  }),
];

describe('matchSeedEntry — hard filters', () => {
  it('picks the most recently PROMOTED of two equal entries for the row’s target', () => {
    const entries = [
      entry('older', { promotedAt: '2026-10-02T00:00:00.000Z' }),
      entry('newer', { promotedAt: '2026-10-20T00:00:00.000Z' }),
      entry('created-later', { createdAt: '2026-10-10T00:00:00.000Z' }),
    ];
    expect(
      matchSeedEntry(
        { role: 'web', stack: 'nextjs', hostingTarget: 'fly', useCase: 'mvp', size: 'small' },
        entries,
      ),
    ).toEqual({ key: 'newer', result: 'matched' });
  });

  it('falls back to createdAt, then the key, when nothing was promoted', () => {
    expect(
      matchSeedEntry({ role: 'web', hostingTarget: 'fly' }, [
        entry('b', { createdAt: '2026-10-05T00:00:00.000Z' }),
        entry('a', { createdAt: '2026-10-05T00:00:00.000Z' }),
        entry('c', { createdAt: '2026-09-01T00:00:00.000Z' }),
      ]).key,
    ).toBe('a');
  });

  it('never proposes an entry that cannot deploy to the row’s target, even the only one of its role and stack', () => {
    const onlyServerless = [entry('serverless-only', { hostingTargets: ['serverless'] })];
    expect(
      matchSeedEntry({ role: 'web', stack: 'nextjs', hostingTarget: 'aws' }, onlyServerless),
    ).toEqual({ key: SEED_SOURCE_INITIALISED, result: 'no_match' });
    // …and takes another compatible entry when there is one.
    expect(
      matchSeedEntry({ role: 'web', hostingTarget: 'aws' }, [
        ...onlyServerless,
        entry('aws-one', { hostingTargets: ['aws'] }),
      ]).key,
    ).toBe('aws-one');
  });

  it('matches a row with no target (a non-web role) only against target-less entries', () => {
    const entries = [
      entry('deployed-mobile', { role: 'mobile', stack: 'expo', hostingTargets: ['fly'] }),
      entry('expo-mobile-foundation', { role: 'mobile', stack: 'expo', hostingTargets: [] }),
    ];
    expect(matchSeedEntry({ role: 'mobile' }, entries)).toEqual({
      key: 'expo-mobile-foundation',
      result: 'no_stack_signal',
    });
    expect(matchSeedEntry({ role: 'mobile' }, [entries[0]!])).toEqual({
      key: SEED_SOURCE_INITIALISED,
      result: 'no_match',
    });
  });

  it('never proposes a retired entry or one of another role', () => {
    expect(
      matchSeedEntry({ role: 'web', hostingTarget: 'fly' }, [
        entry('retired', { status: 'retired' }),
        entry('api-one', { role: 'api' }),
      ]),
    ).toEqual({ key: SEED_SOURCE_INITIALISED, result: 'no_match' });
  });

  it('filters by stack only when a signal names one', () => {
    const entries = [
      entry('next'),
      entry('remix', { stack: 'remix', createdAt: '2026-10-20T00:00:00.000Z' }),
    ];
    expect(matchSeedEntry({ role: 'web', hostingTarget: 'fly', stack: 'nextjs' }, entries)).toEqual(
      { key: 'next', result: 'matched' },
    );
    // No signal: not filtered, never guessed — and the result says so.
    expect(matchSeedEntry({ role: 'web', hostingTarget: 'fly' }, entries)).toEqual({
      key: 'remix',
      result: 'no_stack_signal',
    });
    expect(matchSeedEntry({ role: 'web', hostingTarget: 'fly', stack: 'spring' }, entries)).toEqual(
      { key: SEED_SOURCE_INITIALISED, result: 'no_match' },
    );
  });

  it('gives a web row with NO target the role default, recorded as `no_target`', () => {
    expect(matchSeedEntry({ role: 'web' }, SHIPPED)).toEqual({
      key: SEED_SOURCE_PLATFORM_STARTER,
      result: 'no_target',
    });
  });

  it('answers the shipped registry per target: serverless has a starter, Fly and AWS none yet', () => {
    expect(matchSeedEntry({ role: 'web', hostingTarget: 'serverless' }, SHIPPED)).toEqual({
      key: SEED_SOURCE_PLATFORM_STARTER,
      result: 'no_stack_signal',
    });
    for (const hostingTarget of ['fly', 'aws'] as const) {
      expect(matchSeedEntry({ role: 'web', hostingTarget }, SHIPPED)).toEqual({
        key: SEED_SOURCE_INITIALISED,
        result: 'no_match',
      });
    }
    expect(matchSeedEntry({ role: 'api' }, SHIPPED)).toEqual({
      key: SEED_SOURCE_INITIALISED,
      result: 'no_match',
    });
  });
});

describe('matchSeedEntry — soft preferences order, never exclude', () => {
  const both = entry('both', { useCases: ['internal_tool'], sizes: ['small'] });
  const useCaseOnly = entry('use-case-only', {
    useCases: ['internal_tool'],
    sizes: ['large'],
    promotedAt: '2026-10-25T00:00:00.000Z',
  });
  const neither = entry('neither', {
    useCases: ['planned_product'],
    sizes: ['large'],
    promotedAt: '2026-10-27T00:00:00.000Z',
  });
  const input = {
    role: 'web',
    hostingTarget: 'fly',
    useCase: 'internal_tool',
    size: 'small',
  } as const;

  it('prefers use case AND size, then use case, then any', () => {
    expect(matchSeedEntry(input, [neither, useCaseOnly, both]).key).toBe('both');
    expect(matchSeedEntry(input, [neither, useCaseOnly]).key).toBe('use-case-only');
  });

  it('still gives an internal-tool row a target-compatible entry when none lists `internal_tool`', () => {
    expect(matchSeedEntry(input, [neither])).toEqual({ key: 'neither', result: 'no_stack_signal' });
  });

  it('skips a step whose input is null', () => {
    expect(
      matchSeedEntry({ role: 'web', hostingTarget: 'fly', size: 'large' }, [both, neither]).key,
    ).toBe('neither');
  });
});

describe('seedEntryFitsRow — the hard filter a re-point is held to', () => {
  it('admits the row’s role at the row’s target, and `initialised` for every row', () => {
    const fly = entry('fly-one');
    const initialised = SHIPPED[1]!;
    expect(seedEntryFitsRow(fly, { role: 'web', hostingTarget: 'fly' })).toBe(true);
    expect(seedEntryFitsRow(fly, { role: 'web', hostingTarget: 'aws' })).toBe(false);
    expect(seedEntryFitsRow(fly, { role: 'web', hostingTarget: null })).toBe(true);
    expect(seedEntryFitsRow(fly, { role: 'api', hostingTarget: null })).toBe(false);
    expect(seedEntryFitsRow(initialised, { role: 'api', hostingTarget: null })).toBe(true);
    expect(seedEntryFitsRow(initialised, { role: 'web', hostingTarget: 'fly' })).toBe(true);
    expect(
      seedEntryFitsRow({ ...fly, status: 'retired' }, { role: 'web', hostingTarget: 'fly' }),
    ).toBe(false);
  });
});

describe('the matching module', () => {
  it('carries no starter key as a string literal in its source', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile('lib/projectRepos/seedMatching.ts', 'utf8');
    expect(source).not.toMatch(
      /['"`](nextjs-prisma-(?:vercel|serverless)-starter|initialised|blank)['"`]/,
    );
  });
});
