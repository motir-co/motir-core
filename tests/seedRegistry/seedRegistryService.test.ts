import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { SeedRegistryEntryInput } from '@/lib/dto/seedRegistry';
import { HOSTING_TARGETS } from '@/lib/hosting/vocabulary';
import {
  PROJECT_REPO_ROLES,
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_LEGACY_PLATFORM_STARTER,
  SEED_SOURCE_PLATFORM_STARTER,
  defaultSeedSourceForRole,
  isOrganizationSeedSource,
} from '@/lib/projectRepos/vocabulary';
import { roleDefaultSeedKey } from '@/lib/seedRegistry/defaults';
import {
  SeedEntryRetiredError,
  SeedEntryUnknownError,
  SeedRegistryEntryNotFoundError,
  SeedRegistryInvalidFieldError,
  SeedRegistryKeyTakenError,
} from '@/lib/seedRegistry/errors';
import { seedRegistryService } from '@/lib/services/seedRegistryService';
import { adminDb } from '../helpers/adminDb';
import { ORIGINAL_SEED_KEYS, withOnlyOriginalSeeds } from '../helpers/seedRegistryShipped';

// The SEED REGISTRY (Story MOTIR-704 · MOTIR-708; decision MOTIR-706 v2) over
// real Postgres. The registry is migration-seeded platform data that no
// truncate reaches. This file proves the registry's own reads and writes, and
// registers the starters itself, so it sets MOTIR-9813's four shipped starter
// entries aside: every test starts from exactly the two original seeds and
// removes what it registered. What the migrations ship is
// `tests/projectRepos/seedRegistryEntries.test.ts`.

withOnlyOriginalSeeds();

afterEach(async () => {
  await adminDb.seedRegistryEntry.deleteMany({ where: { key: { notIn: ORIGINAL_SEED_KEYS } } });
  await adminDb.seedRegistryEntry.updateMany({ data: { status: 'active' } });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A write as the operator action makes it: inside the caller's transaction. */
function write<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return adminDb.$transaction(fn);
}

function entry(over: Partial<SeedRegistryEntryInput> = {}): SeedRegistryEntryInput {
  return {
    key: 'nextjs-prisma-fly-starter',
    role: 'web',
    stack: 'nextjs',
    label: 'Next.js · Fly',
    source: { owner: 'motir-co', repo: 'nextjs-prisma-fly-starter' },
    useCases: ['mvp', 'planned_product'],
    sizes: ['small', 'medium', 'large'],
    hostingTargets: ['fly'],
    ...over,
  };
}

const count = () => adminDb.seedRegistryEntry.count();

describe('the two original seeds', () => {
  it('holds exactly the two original seeds', async () => {
    const { items, nextCursor } = await seedRegistryService.list();
    expect(items.map((e) => e.key)).toEqual([
      SEED_SOURCE_INITIALISED,
      SEED_SOURCE_PLATFORM_STARTER,
    ]);
    expect(nextCursor).toBeNull();
  });

  it('lists the platform starter as 706 3.4 fixes it, under its renamed key', async () => {
    expect(await seedRegistryService.getByKey(SEED_SOURCE_PLATFORM_STARTER)).toMatchObject({
      key: 'nextjs-prisma-serverless-starter',
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
  });

  it('lists `initialised` as any role, any stack, every use case and size, no target', async () => {
    expect(await seedRegistryService.getByKey(SEED_SOURCE_INITIALISED)).toMatchObject({
      role: 'any',
      stack: 'any',
      source: 'initialised',
      useCases: ['internal_tool', 'mvp', 'planned_product'],
      sizes: ['small', 'medium', 'large'],
      hostingTargets: [],
    });
  });
});

describe('getByKey', () => {
  it('finds an entry by a LEGACY key too', async () => {
    expect((await seedRegistryService.getByKey(SEED_SOURCE_LEGACY_PLATFORM_STARTER)).key).toBe(
      SEED_SOURCE_PLATFORM_STARTER,
    );
  });

  it('refuses an unknown key with the typed error', async () => {
    await expect(seedRegistryService.getByKey('nope')).rejects.toBeInstanceOf(
      SeedRegistryEntryNotFoundError,
    );
  });
});

describe('resolveForEstablish', () => {
  it('answers the CURRENT key and the template for a legacy key', async () => {
    await expect(
      seedRegistryService.resolveForEstablish(SEED_SOURCE_LEGACY_PLATFORM_STARTER),
    ).resolves.toEqual({
      key: SEED_SOURCE_PLATFORM_STARTER,
      source: { owner: 'motir-co', repo: 'nextjs-prisma-serverless-starter' },
    });
  });

  it('answers the initialised source for `initialised`', async () => {
    await expect(seedRegistryService.resolveForEstablish(SEED_SOURCE_INITIALISED)).resolves.toEqual(
      {
        key: SEED_SOURCE_INITIALISED,
        source: 'initialised',
      },
    );
  });

  it('refuses an unknown key, naming it — never a fallback', async () => {
    const err = await seedRegistryService.resolveForEstablish('ghost').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeedEntryUnknownError);
    expect((err as SeedEntryUnknownError).reason).toContain('"ghost"');
  });

  it('refuses a retired entry, naming it', async () => {
    await write((tx) => seedRegistryService.create(entry({ status: 'retired' }), tx));
    const err = await seedRegistryService
      .resolveForEstablish('nextjs-prisma-fly-starter')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeedEntryRetiredError);
    expect((err as SeedEntryRetiredError).reason).toContain('nextjs-prisma-fly-starter');
  });
});

describe('list', () => {
  async function registerThree() {
    await write(async (tx) => {
      await seedRegistryService.create(entry(), tx);
      await seedRegistryService.create(
        entry({
          key: 'nextjs-prisma-aws-starter',
          label: 'Next.js · AWS',
          source: { owner: 'motir-co', repo: 'nextjs-prisma-aws-starter' },
          useCases: ['planned_product'],
          hostingTargets: ['aws'],
        }),
        tx,
      );
      await seedRegistryService.create(
        entry({
          key: 'expo-mobile-foundation',
          role: 'mobile',
          stack: 'expo',
          label: 'Expo',
          source: { owner: 'motir-co', repo: 'expo-mobile-foundation' },
          useCases: ['internal_tool', 'mvp', 'planned_product'],
          hostingTargets: [],
          status: 'retired',
        }),
        tx,
      );
    });
  }

  it('a TARGET filter excludes an entry whose hostingTargets does not contain it', async () => {
    await registerThree();
    const { items } = await seedRegistryService.list({ hostingTarget: 'fly' });
    expect(items.map((e) => e.key)).toEqual(['nextjs-prisma-fly-starter']);
    expect(items.map((e) => e.key)).not.toContain('nextjs-prisma-aws-starter');
    expect(items.map((e) => e.key)).not.toContain(SEED_SOURCE_PLATFORM_STARTER);
  });

  it('filters by role, stack, status and use case, and returns the serves-lists', async () => {
    await registerThree();
    const keys = async (filter: Parameters<typeof seedRegistryService.list>[0]) =>
      (await seedRegistryService.list(filter)).items.map((e) => e.key);

    expect(await keys({ role: 'web' })).toEqual([
      'nextjs-prisma-aws-starter',
      'nextjs-prisma-fly-starter',
      SEED_SOURCE_PLATFORM_STARTER,
    ]);
    expect(await keys({ stack: 'expo' })).toEqual(['expo-mobile-foundation']);
    expect(await keys({ status: 'retired' })).toEqual(['expo-mobile-foundation']);
    expect(await keys({ useCase: 'internal_tool', role: 'web' })).toEqual([
      SEED_SOURCE_PLATFORM_STARTER,
    ]);
    const [aws] = (await seedRegistryService.list({ hostingTarget: 'aws' })).items;
    expect(aws).toMatchObject({
      useCases: ['planned_product'],
      sizes: ['small', 'medium', 'large'],
      hostingTargets: ['aws'],
    });
  });

  it('paginates by key with a cursor', async () => {
    await registerThree();
    const first = await seedRegistryService.list({}, { limit: 2 });
    expect(first.items.map((e) => e.key)).toEqual([
      'expo-mobile-foundation',
      SEED_SOURCE_INITIALISED,
    ]);
    expect(first.nextCursor).toBe(SEED_SOURCE_INITIALISED);
    const second = await seedRegistryService.list({}, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((e) => e.key)).toEqual([
      'nextjs-prisma-aws-starter',
      'nextjs-prisma-fly-starter',
    ]);
    const third = await seedRegistryService.list({}, { limit: 2, cursor: second.nextCursor });
    expect(third).toEqual({
      items: [expect.objectContaining({ key: SEED_SOURCE_PLATFORM_STARTER })],
      nextCursor: null,
    });
  });

  it.each([
    ['hostingTarget', { hostingTarget: 'vercel' }, 'vercel'],
    ['useCase', { useCase: 'prototype' }, 'prototype'],
    ['role', { role: 'backend' as never }, 'backend'],
    ['status', { status: 'gone' as never }, 'gone'],
  ])('refuses a %s filter outside its vocabulary', async (field, filter, value) => {
    await expect(seedRegistryService.list(filter)).rejects.toMatchObject({
      code: 'SEED_REGISTRY_INVALID_FIELD',
      field,
      value,
    });
  });

  it.each([0, 101, 1.5])('refuses a page size of %s', async (limit) => {
    await expect(seedRegistryService.list({}, { limit })).rejects.toMatchObject({
      field: 'limit',
    });
  });
});

describe('create / update — the vocabulary-checked write path', () => {
  it('creates an entry and answers it as the DTO', async () => {
    const created = await write((tx) =>
      seedRegistryService.create(
        entry({
          promotedFrom: 'motir-co/acme@abc123',
          promotedBy: 'user_1',
          promotedAt: new Date('2026-10-28T00:00:00Z'),
        }),
        tx,
      ),
    );
    expect(created).toMatchObject({
      key: 'nextjs-prisma-fly-starter',
      source: { owner: 'motir-co', repo: 'nextjs-prisma-fly-starter' },
      hostingTargets: ['fly'],
      status: 'active',
      promotedFrom: 'motir-co/acme@abc123',
      promotedBy: 'user_1',
      promotedAt: '2026-10-28T00:00:00.000Z',
    });
  });

  it.each([
    ['useCase', { useCases: ['mvp', 'prototype'] }, 'prototype'],
    ['size', { sizes: ['enterprise'] }, 'enterprise'],
    ['size', { sizes: ['long_running'] }, 'long_running'],
    ['hostingTarget', { hostingTargets: ['vercel'] }, 'vercel'],
    ['role', { role: 'backend' as never }, 'backend'],
    ['status', { status: 'paused' as never }, 'paused'],
    ['stack', { stack: 'Next JS' }, 'Next JS'],
    ['key', { key: 'Bad Key' }, 'Bad Key'],
    ['legacyKeys', { legacyKeys: ['nextjs-prisma-fly-starter'] }, 'nextjs-prisma-fly-starter'],
    ['source.owner', { source: { owner: 'motir co', repo: 'x' } }, 'motir co'],
    ['label', { label: '   ' }, '   '],
    ['role', { role: 'any' as const }, 'any'],
    ['stack', { stack: 'any' }, 'any'],
  ])(
    'refuses a bad %s, naming the field and the value, and writes nothing',
    async (field, over, value) => {
      const before = await count();
      const err = await write((tx) => seedRegistryService.create(entry(over), tx)).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SeedRegistryInvalidFieldError);
      expect(err).toMatchObject({ field, value });
      expect((err as Error).message).toContain(value);
      expect(await count()).toBe(before);
    },
  );

  it('accepts `any` role and stack for an initialised source', async () => {
    const created = await write((tx) =>
      seedRegistryService.create(
        entry({
          key: 'bare',
          role: 'any',
          stack: 'any',
          source: 'initialised',
          hostingTargets: [],
        }),
        tx,
      ),
    );
    expect(created).toMatchObject({ role: 'any', stack: 'any', source: 'initialised' });
  });

  it('refuses a key another entry holds — as its key or as a legacy key', async () => {
    for (const key of [SEED_SOURCE_PLATFORM_STARTER, SEED_SOURCE_LEGACY_PLATFORM_STARTER]) {
      await expect(
        write((tx) => seedRegistryService.create(entry({ key }), tx)),
      ).rejects.toBeInstanceOf(SeedRegistryKeyTakenError);
    }
    await expect(
      write((tx) =>
        seedRegistryService.create(entry({ legacyKeys: [SEED_SOURCE_INITIALISED] }), tx),
      ),
    ).rejects.toBeInstanceOf(SeedRegistryKeyTakenError);
    expect(await count()).toBe(2);
  });

  it('de-duplicates a serves-list', async () => {
    const created = await write((tx) =>
      seedRegistryService.create(entry({ sizes: ['small', 'small'] }), tx),
    );
    expect(created.sizes).toEqual(['small']);
  });

  it('updates the serves-lists and the status, keeping the rest', async () => {
    await write((tx) => seedRegistryService.create(entry(), tx));
    const updated = await write((tx) =>
      seedRegistryService.update(
        'nextjs-prisma-fly-starter',
        { sizes: ['medium'], status: 'retired' },
        tx,
      ),
    );
    expect(updated).toMatchObject({
      sizes: ['medium'],
      status: 'retired',
      useCases: ['mvp', 'planned_product'],
      hostingTargets: ['fly'],
    });
  });

  it('keeps an entry’s promotion provenance through an update', async () => {
    await write((tx) =>
      seedRegistryService.create(
        entry({ promotedBy: 'user_1', promotedAt: new Date('2026-10-01T00:00:00Z') }),
        tx,
      ),
    );
    const updated = await write((tx) =>
      seedRegistryService.update('nextjs-prisma-fly-starter', { label: 'Fly' }, tx),
    );
    expect(updated).toMatchObject({ promotedBy: 'user_1', promotedAt: '2026-10-01T00:00:00.000Z' });
  });

  it('refuses an update outside the vocabulary and writes nothing', async () => {
    const err = await write((tx) =>
      seedRegistryService.update(SEED_SOURCE_PLATFORM_STARTER, { hostingTargets: ['heroku'] }, tx),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ field: 'hostingTarget', value: 'heroku' });
    expect(
      (await seedRegistryService.getByKey(SEED_SOURCE_PLATFORM_STARTER)).hostingTargets,
    ).toEqual(['serverless']);
  });

  it('refuses an update of an unknown entry, and a legacy key another entry holds', async () => {
    await expect(
      write((tx) => seedRegistryService.update('ghost', { label: 'x' }, tx)),
    ).rejects.toBeInstanceOf(SeedRegistryEntryNotFoundError);
    await expect(
      write((tx) =>
        seedRegistryService.update(
          SEED_SOURCE_INITIALISED,
          { legacyKeys: [SEED_SOURCE_LEGACY_PLATFORM_STARTER] },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(SeedRegistryKeyTakenError);
  });
});

describe('defaultSeedSourceForRole — the registry is the default map (706 3.8)', () => {
  it('answers each of the six roles from the shipped registry', async () => {
    const answers = Object.fromEntries(
      await Promise.all(
        PROJECT_REPO_ROLES.map(async (role) => [
          role,
          await seedRegistryService.defaultSeedSourceForRole(role),
        ]),
      ),
    );
    expect(answers).toEqual({
      web: SEED_SOURCE_PLATFORM_STARTER,
      api: SEED_SOURCE_INITIALISED,
      mobile: SEED_SOURCE_INITIALISED,
      shared: SEED_SOURCE_INITIALISED,
      infra: SEED_SOURCE_INITIALISED,
      other: SEED_SOURCE_INITIALISED,
    });
    // The pure, client-safe map agrees with the read on the shipped registry.
    for (const role of PROJECT_REPO_ROLES) {
      expect(defaultSeedSourceForRole(role)).toBe(answers[role]);
    }
  });

  it('answers a role’s registered target-less foundation once one exists', async () => {
    await write((tx) =>
      seedRegistryService.create(
        entry({
          key: 'expo-mobile-foundation',
          role: 'mobile',
          stack: 'expo',
          source: { owner: 'motir-co', repo: 'expo-mobile-foundation' },
          hostingTargets: [],
        }),
        tx,
      ),
    );
    expect(await seedRegistryService.defaultSeedSourceForRole('mobile')).toBe(
      'expo-mobile-foundation',
    );
    // A web entry never displaces the fixed web default.
    await write((tx) => seedRegistryService.create(entry(), tx));
    expect(await seedRegistryService.defaultSeedSourceForRole('web')).toBe(
      SEED_SOURCE_PLATFORM_STARTER,
    );
  });

  it('keeps `isOrganizationSeedSource` meaning exactly what it did', () => {
    expect(isOrganizationSeedSource('organization')).toBe(true);
    expect(isOrganizationSeedSource(SEED_SOURCE_PLATFORM_STARTER)).toBe(false);
    expect(isOrganizationSeedSource(SEED_SOURCE_INITIALISED)).toBe(false);
  });
});

describe('roleDefaultSeedKey — the rule, pure', () => {
  const base = {
    status: 'active' as const,
    promotedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  const mobile = (key: string, over: Partial<typeof base> & { hostingTargets?: never[] } = {}) => ({
    ...base,
    key,
    role: 'mobile' as const,
    hostingTargets: [] as (typeof HOSTING_TARGETS)[number][],
    ...over,
  });

  it('prefers the most recently promoted, then created, then the key', () => {
    expect(
      roleDefaultSeedKey('mobile', [
        mobile('b-old', { createdAt: '2026-09-01T00:00:00.000Z' }),
        mobile('a-promoted', { promotedAt: '2026-10-20T00:00:00.000Z' } as never),
        mobile('c-new', { createdAt: '2026-10-10T00:00:00.000Z' }),
      ]),
    ).toBe('a-promoted');
    expect(roleDefaultSeedKey('mobile', [mobile('z'), mobile('y')])).toBe('y');
  });

  it('skips a retired entry and an entry with hosting targets', () => {
    expect(
      roleDefaultSeedKey('mobile', [
        mobile('retired', { status: 'retired' } as never),
        { ...mobile('deployed'), hostingTargets: ['fly'] },
      ]),
    ).toBe(SEED_SOURCE_INITIALISED);
  });

  it('falls back to `initialised` for web when the platform starter is not active', () => {
    expect(roleDefaultSeedKey('web', [])).toBe(SEED_SOURCE_INITIALISED);
  });
});

describe('matchSeedEntry over the live registry (MOTIR-709)', () => {
  it('answers the shipped registry as 706 v2 §3.5 does', async () => {
    expect(await seedRegistryService.matchSeedEntry({ role: 'web' })).toEqual({
      key: SEED_SOURCE_PLATFORM_STARTER,
      result: 'no_target',
    });
    expect(
      await seedRegistryService.matchSeedEntry({ role: 'web', hostingTarget: 'serverless' }),
    ).toEqual({ key: SEED_SOURCE_PLATFORM_STARTER, result: 'no_stack_signal' });
    expect(await seedRegistryService.matchSeedEntry({ role: 'web', hostingTarget: 'fly' })).toEqual(
      { key: SEED_SOURCE_INITIALISED, result: 'no_match' },
    );
    expect(await seedRegistryService.matchSeedEntry({ role: 'api' })).toEqual({
      key: SEED_SOURCE_INITIALISED,
      result: 'no_match',
    });
  });

  it('picks up a registered starter, and drops it again once retired', async () => {
    await write((tx) => seedRegistryService.create(entry(), tx));
    expect(await seedRegistryService.matchSeedEntry({ role: 'web', hostingTarget: 'fly' })).toEqual(
      { key: 'nextjs-prisma-fly-starter', result: 'no_stack_signal' },
    );
    expect(
      await seedRegistryService.matchSeedEntry({
        role: 'web',
        stack: 'nextjs',
        hostingTarget: 'fly',
      }),
    ).toEqual({ key: 'nextjs-prisma-fly-starter', result: 'matched' });

    await write((tx) =>
      seedRegistryService.update('nextjs-prisma-fly-starter', { status: 'retired' }, tx),
    );
    expect(
      (await seedRegistryService.matchSeedEntry({ role: 'web', hostingTarget: 'fly' })).key,
    ).toBe(SEED_SOURCE_INITIALISED);
  });

  it('answers each target’s new-app starter from the registry', async () => {
    const before = await seedRegistryService.starterByHostingTarget();
    expect(Object.keys(before).sort()).toEqual([...HOSTING_TARGETS].sort());
    expect(before).toMatchObject({
      serverless: SEED_SOURCE_PLATFORM_STARTER,
      fly: SEED_SOURCE_INITIALISED,
      aws: SEED_SOURCE_INITIALISED,
    });

    await write((tx) => seedRegistryService.create(entry(), tx));
    expect((await seedRegistryService.starterByHostingTarget()).fly).toBe(
      'nextjs-prisma-fly-starter',
    );
    expect(await seedRegistryService.seedSourceForHostingTarget('fly')).toBe(
      'nextjs-prisma-fly-starter',
    );
  });
});

describe('listCompatible — what a row may be re-pointed to (MOTIR-709)', () => {
  const keys = async (row: Parameters<typeof seedRegistryService.listCompatible>[0]) =>
    (await seedRegistryService.listCompatible(row)).items.map((e) => e.key);

  it('lists the role’s entries passing the target, and `initialised` for every row', async () => {
    await write(async (tx) => {
      await seedRegistryService.create(entry(), tx);
      await seedRegistryService.create(
        entry({
          key: 'hono-api-starter',
          role: 'api',
          stack: 'hono',
          label: 'Hono API',
          source: { owner: 'motir-co', repo: 'hono-api-starter' },
          hostingTargets: [],
        }),
        tx,
      );
      await seedRegistryService.create(
        entry({ key: 'retired-web', label: 'Old', status: 'retired', hostingTargets: [] }),
        tx,
      );
    });

    expect(await keys({ role: 'web', hostingTarget: null })).toEqual([
      SEED_SOURCE_INITIALISED,
      'nextjs-prisma-fly-starter',
      SEED_SOURCE_PLATFORM_STARTER,
    ]);
    expect(await keys({ role: 'web', hostingTarget: 'fly' })).toEqual([
      SEED_SOURCE_INITIALISED,
      'nextjs-prisma-fly-starter',
    ]);
    expect(await keys({ role: 'web', hostingTarget: 'aws' })).toEqual([SEED_SOURCE_INITIALISED]);
    expect(await keys({ role: 'api', hostingTarget: null })).toEqual([
      'hono-api-starter',
      SEED_SOURCE_INITIALISED,
    ]);
    expect(await keys({ role: 'mobile', hostingTarget: null })).toEqual([SEED_SOURCE_INITIALISED]);
  });

  it('paginates by key with a cursor', async () => {
    const first = await seedRegistryService.listCompatible(
      { role: 'web', hostingTarget: null },
      { limit: 1 },
    );
    expect(first.items.map((e) => e.key)).toEqual([SEED_SOURCE_INITIALISED]);
    expect(first.nextCursor).toBe(SEED_SOURCE_INITIALISED);
    const second = await seedRegistryService.listCompatible(
      { role: 'web', hostingTarget: null },
      { limit: 1, cursor: first.nextCursor! },
    );
    expect(second.items.map((e) => e.key)).toEqual([SEED_SOURCE_PLATFORM_STARTER]);
    expect(second.nextCursor).toBeNull();
  });
});

describe('the table’s RLS (platform reference data)', () => {
  async function asAppRole<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return fn(tx);
    });
  }

  it('ADMITS a read with nothing bound', async () => {
    const keys = await asAppRole((tx) =>
      tx.seedRegistryEntry.findMany({ select: { key: true }, orderBy: { key: 'asc' } }),
    );
    expect(keys.map((k) => k.key)).toEqual([SEED_SOURCE_INITIALISED, SEED_SOURCE_PLATFORM_STARTER]);
  });

  it('REFUSES a write with nothing bound, and admits it under platform standing', async () => {
    await expect(asAppRole((tx) => seedRegistryService.create(entry(), tx))).rejects.toThrow();
    expect(await count()).toBe(2);

    await asAppRole(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.platform_staff', 'true', true)`);
      return seedRegistryService.create(entry(), tx);
    });
    expect(await count()).toBe(3);
  });
});
