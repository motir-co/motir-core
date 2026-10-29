import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { parseHostingManifest } from '@/lib/hosting/manifest';
import {
  SEED_SOURCE_AWS_STARTER,
  SEED_SOURCE_EXPO_MOBILE_FOUNDATION,
  SEED_SOURCE_FLY_STARTER,
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
  SEED_SOURCE_SPRING_API_FOUNDATION,
} from '@/lib/projectRepos/vocabulary';
import { seedRegistryService } from '@/lib/services/seedRegistryService';
import { adminDb } from '../helpers/adminDb';
import { SHIPPED_SEED_KEYS } from '../helpers/seedRegistryShipped';

// THE SHIPPED REGISTRY (Story MOTIR-704 · MOTIR-9813; decision MOTIR-706 v2 §3.4,
// page cmvsezd8800eihnoikhllqqev) as the migrations leave it, read from the real
// test database. What is proved: the four starter entries carry 706 §3.4's values;
// every web entry's hosting targets are a subset of its starter's manifest
// targets, parsed by the shipped parser from verbatim copies of the starters'
// `motir.hosting.json` (`tests/fixtures/hosting-manifests/SOURCE.md` names the
// commits); the two original seeds are untouched; and each role's default is the
// foundation 706 3.8 names. The live repositories are checked by
// `scripts/seed-registry/verify-starter-manifests.ts`.

const FIXTURES = join(__dirname, '../fixtures/hosting-manifests');
const manifest = (name: string) =>
  parseHostingManifest(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));

/** Which manifest fixture each web entry's template ships. */
const MANIFEST_OF: Record<string, string> = {
  [SEED_SOURCE_PLATFORM_STARTER]: 'serverless',
  [SEED_SOURCE_FLY_STARTER]: 'fly',
  [SEED_SOURCE_AWS_STARTER]: 'aws',
};

const ALL_SIZES = ['small', 'medium', 'large'];
const ALL_USE_CASES = ['internal_tool', 'mvp', 'planned_product'];

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the hosting manifest fixtures', () => {
  it.each([
    ['serverless', ['serverless']],
    ['fly', ['fly']],
    ['aws', ['aws']],
  ])('%s parses with the shipped parser and declares exactly its one target', (name, targets) => {
    expect(manifest(name).targets).toEqual(targets);
  });
});

describe('the four starter entries', () => {
  it.each([
    [
      SEED_SOURCE_FLY_STARTER,
      'web',
      'nextjs',
      'Next.js · Fly',
      ['mvp', 'planned_product'],
      ['fly'],
    ],
    [SEED_SOURCE_AWS_STARTER, 'web', 'nextjs', 'Next.js · AWS', ['planned_product'], ['aws']],
    [SEED_SOURCE_EXPO_MOBILE_FOUNDATION, 'mobile', 'expo', 'Expo · mobile', ALL_USE_CASES, []],
    [SEED_SOURCE_SPRING_API_FOUNDATION, 'api', 'spring', 'Spring · API', ALL_USE_CASES, []],
  ])(
    '%s is a %s/%s entry as 706 §3.4 fixes it',
    async (key, role, stack, label, useCases, targets) => {
      expect(await seedRegistryService.getByKey(key)).toMatchObject({
        key,
        legacyKeys: [],
        role,
        stack,
        label,
        source: { owner: 'motir-co', repo: key },
        useCases,
        sizes: ALL_SIZES,
        hostingTargets: targets,
        status: 'active',
        promotedFrom: null,
      });
    },
  );

  it('every web entry deploys only to targets its starter’s manifest declares', async () => {
    const web = (await seedRegistryService.listAllEntries()).filter((e) => e.role === 'web');
    expect(web.map((e) => e.key).sort()).toEqual(Object.keys(MANIFEST_OF).sort());
    for (const entry of web) {
      const declared = manifest(MANIFEST_OF[entry.key]!).targets;
      expect(entry.hostingTargets.length).toBeGreaterThan(0);
      for (const target of entry.hostingTargets) expect(declared).toContain(target);
    }
  });

  it('a non-web foundation deploys nowhere (706 3.2)', async () => {
    for (const key of [SEED_SOURCE_EXPO_MOBILE_FOUNDATION, SEED_SOURCE_SPRING_API_FOUNDATION]) {
      expect((await seedRegistryService.getByKey(key)).hostingTargets).toEqual([]);
    }
  });
});

describe('the registry as the migrations ship it', () => {
  it('holds exactly the six shipped entries', async () => {
    const keys = (await seedRegistryService.listAllEntries()).map((e) => e.key);
    expect(keys.sort()).toEqual([...SHIPPED_SEED_KEYS].sort());
  });

  it('leaves the two original seeds as 20261028200000_seed_registry wrote them', async () => {
    expect(await seedRegistryService.getByKey(SEED_SOURCE_PLATFORM_STARTER)).toMatchObject({
      legacyKeys: ['nextjs-prisma-vercel-starter'],
      role: 'web',
      stack: 'nextjs',
      label: 'Next.js · serverless',
      source: { owner: 'motir-co', repo: 'nextjs-prisma-serverless-starter' },
      useCases: ['internal_tool', 'mvp'],
      sizes: ['small'],
      hostingTargets: ['serverless'],
      status: 'active',
    });
    expect(await seedRegistryService.getByKey(SEED_SOURCE_INITIALISED)).toMatchObject({
      role: 'any',
      stack: 'any',
      label: 'Initialised repository',
      source: 'initialised',
      useCases: ALL_USE_CASES,
      sizes: ALL_SIZES,
      hostingTargets: [],
      status: 'active',
    });
  });

  it.each([
    ['web', SEED_SOURCE_PLATFORM_STARTER],
    ['mobile', SEED_SOURCE_EXPO_MOBILE_FOUNDATION],
    ['api', SEED_SOURCE_SPRING_API_FOUNDATION],
    ['infra', SEED_SOURCE_INITIALISED],
  ] as const)('defaults a %s row to %s (706 3.8)', async (role, key) => {
    expect(await seedRegistryService.defaultSeedSourceForRole(role)).toBe(key);
  });
});
