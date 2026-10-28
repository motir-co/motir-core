import type {
  HostingSize as PrismaHostingSize,
  HostingTarget as PrismaHostingTarget,
  HostingUseCase as PrismaHostingUseCase,
  Prisma,
  ProjectRepoRole,
} from '@/generated/prisma/client';
import {
  SEED_REGISTRY_ANY,
  SEED_REGISTRY_INITIALISED_SOURCE,
  type ResolvedSeedDto,
  type SeedRegistryEntryDto,
  type SeedRegistryEntryInput,
  type SeedRegistryEntryListDto,
  type SeedRegistryEntryPatch,
  type SeedRegistryEntryStatusDto,
  type SeedRegistryListFilter,
  type SeedRegistryPage,
} from '@/lib/dto/seedRegistry';
import { isHostingSize, isHostingTarget, isHostingUseCase } from '@/lib/hosting/vocabulary';
import { toSeedRegistryEntryDto } from '@/lib/mappers/seedRegistryMappers';
import { isProjectRepoRole } from '@/lib/projectRepos/vocabulary';
import {
  seedRegistryEntryRepository,
  type SeedRegistryEntryData,
} from '@/lib/repositories/seedRegistryEntryRepository';
import { roleDefaultSeedKey } from '@/lib/seedRegistry/defaults';
import {
  SeedEntryRetiredError,
  SeedEntryUnknownError,
  SeedRegistryEntryNotFoundError,
  SeedRegistryInvalidFieldError,
  SeedRegistryKeyTakenError,
} from '@/lib/seedRegistry/errors';

// The SEED REGISTRY service (Story MOTIR-704 · MOTIR-708; decision MOTIR-706 v2,
// page cmvsezd8800eihnoikhllqqev). Three readers and one writer:
//
//   · `resolveForEstablish` — what a row's `seedSource` seeds from. Establish
//     reads the KEY only: target, use case and size were matched when the key
//     was chosen (MOTIR-709), so nothing is re-matched here.
//   · `list` / `getByKey` — the read MOTIR-709 matches through and MOTIR-705 /
//     712 render.
//   · `defaultSeedSourceForRole` — 706 3.8's default map, read from the registry.
//   · `create` / `update` — the vocabulary-checked write path. It takes the
//     caller's `tx` because the table's write arm is `app.platform_staff`: the
//     caller is MOTIR-710's audited operator action (or MOTIR-9813's
//     registration), which owns the transaction, the guard and the audit row.
//
// ⚠️ THE VOCABULARIES ARE IMPORTED, NEVER RETYPED (706 3.2): use cases, sizes and
// hosting targets come from `lib/hosting/vocabulary.ts`, the same module the row
// (`setHosting`) and the manifest parser read, and the role from ADR §1.1's list.
// Checking a NON-EMPTY `hostingTargets` against the starter's own manifest (the
// subset rule) needs that template's `motir.hosting.json`; it is the caller's
// check (MOTIR-9813, MOTIR-710), made before it calls `create` / `update`.

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
const LABEL_MAX = 120;
const KEY_MAX = 100;
/** A registry key: lowercase, digits and hyphens — it is stored on every row. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** A lowercase stack name (`nextjs`, `expo`, `spring`). */
const STACK_PATTERN = /^[a-z0-9][a-z0-9.+-]*$/;
/** A GitHub owner or repository name. */
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STATUSES: readonly SeedRegistryEntryStatusDto[] = ['active', 'retired'];

export const seedRegistryService = {
  /**
   * Resolve a row's `seedSource` for establish. A current or legacy key of an
   * ACTIVE entry answers that entry's current key and its source; an unknown key
   * or a retired entry throws the typed failure the establish step records on
   * the row. Never a fallback to `initialised`: a repository created from a
   * guessed default is a real artifact nobody chose.
   */
  async resolveForEstablish(seedSource: string): Promise<ResolvedSeedDto> {
    const row = await seedRegistryEntryRepository.findByKeyOrLegacyKey(seedSource);
    if (!row) throw new SeedEntryUnknownError(seedSource);
    if (row.status !== 'active') throw new SeedEntryRetiredError(seedSource);
    const entry = toSeedRegistryEntryDto(row);
    return { key: entry.key, source: entry.source };
  },

  /** One entry by its current or a legacy key. */
  async getByKey(key: string): Promise<SeedRegistryEntryDto> {
    const row = await seedRegistryEntryRepository.findByKeyOrLegacyKey(key);
    if (!row) throw new SeedRegistryEntryNotFoundError(key);
    return toSeedRegistryEntryDto(row);
  },

  /**
   * One page of entries, by key. Filters by role, stack, status, a hosting target
   * the entry's `hostingTargets` contains and a use case its `useCases` contains;
   * a filter value outside its vocabulary is refused rather than answered empty.
   */
  async list(
    filter: SeedRegistryListFilter = {},
    page: SeedRegistryPage = {},
  ): Promise<SeedRegistryEntryListDto> {
    const limit = pageSize(page.limit);
    const rows = await seedRegistryEntryRepository.list(
      {
        role: filter.role === undefined ? undefined : checkRole(filter.role),
        stack: filter.stack,
        status: filter.status === undefined ? undefined : checkStatus(filter.status),
        hostingTarget:
          filter.hostingTarget === undefined
            ? undefined
            : checkList('hostingTarget', [filter.hostingTarget], isHostingTarget)[0],
        useCase:
          filter.useCase === undefined
            ? undefined
            : checkList('useCase', [filter.useCase], isHostingUseCase)[0],
      },
      { take: limit + 1, afterKey: page.cursor ?? null },
    );
    const items = rows.slice(0, limit).map(toSeedRegistryEntryDto);
    return {
      items,
      nextCursor: rows.length > limit ? (items[items.length - 1]?.key ?? null) : null,
    };
  },

  /**
   * The registry's default `seedSource` for a role — decision MOTIR-706 v2, 3.8
   * (page cmvsezd8800eihnoikhllqqev): `web` → `nextjs-prisma-serverless-starter`,
   * every other role → its newest active target-less entry, else `initialised`.
   * The rule is `roleDefaultSeedKey`; this is it applied to the live registry.
   */
  async defaultSeedSourceForRole(role: ProjectRepoRole): Promise<string> {
    const active = await seedRegistryEntryRepository.listActive();
    return roleDefaultSeedKey(role, active.map(toSeedRegistryEntryDto));
  },

  /**
   * Add an entry. Every vocabulary-checked field is refused BEFORE anything is
   * written, with the field and the value; a key (or legacy key) another entry
   * already holds, as either, is refused too, so a stored `seedSource` resolves
   * to at most one entry. `tx` is the caller's audited platform transaction.
   */
  async create(
    input: SeedRegistryEntryInput,
    tx: Prisma.TransactionClient,
  ): Promise<SeedRegistryEntryDto> {
    const data = checkEntry(input);
    await assertKeysFree([data.key, ...data.legacyKeys], null, tx);
    return toSeedRegistryEntryDto(await seedRegistryEntryRepository.create(data, tx));
  },

  /** Change an entry. The key never changes (a rename is a legacy key plus a new
   *  entry's worth of thought, 706 3.7); everything else is re-checked whole. */
  async update(
    key: string,
    patch: SeedRegistryEntryPatch,
    tx: Prisma.TransactionClient,
  ): Promise<SeedRegistryEntryDto> {
    const current = await seedRegistryEntryRepository.findByKeyInTx(key, tx);
    if (!current) throw new SeedRegistryEntryNotFoundError(key);
    const merged = { ...toSeedRegistryEntryDto(current), ...patch, key };
    const { key: _key, ...data } = checkEntry({
      ...merged,
      promotedAt:
        patch.promotedAt !== undefined
          ? patch.promotedAt
          : merged.promotedAt === null
            ? null
            : new Date(merged.promotedAt),
    });
    await assertKeysFree(data.legacyKeys, current.id, tx);
    return toSeedRegistryEntryDto(await seedRegistryEntryRepository.update(current.id, data, tx));
  },
};

// ── Validation ──────────────────────────────────────────────────────────────

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw new SeedRegistryInvalidFieldError('limit', String(limit), `must be 1–${MAX_PAGE}.`);
  }
  return limit;
}

function checkRole(role: string): ProjectRepoRole {
  if (!isProjectRepoRole(role)) {
    throw new SeedRegistryInvalidFieldError('role', role, 'is not a repository role.');
  }
  return role;
}

function checkStatus(status: string): SeedRegistryEntryStatusDto {
  if (!(STATUSES as readonly string[]).includes(status)) {
    throw new SeedRegistryInvalidFieldError('status', status, 'is not active or retired.');
  }
  return status as SeedRegistryEntryStatusDto;
}

/** Every value must be in its closed list; the stored list is de-duplicated. */
function checkList<T extends string>(
  field: string,
  values: readonly string[],
  isMember: (value: string) => value is T,
): T[] {
  for (const value of values) {
    if (!isMember(value)) {
      throw new SeedRegistryInvalidFieldError(field, value, `is not a known ${field} value.`);
    }
  }
  return [...new Set(values)] as T[];
}

function checkKey(field: string, key: string): string {
  if (key.length === 0 || key.length > KEY_MAX || !KEY_PATTERN.test(key)) {
    throw new SeedRegistryInvalidFieldError(
      field,
      key,
      `must be lowercase letters, digits and hyphens, at most ${KEY_MAX} characters.`,
    );
  }
  return key;
}

function checkEntry(input: SeedRegistryEntryInput): SeedRegistryEntryData {
  const key = checkKey('key', input.key);
  const legacyKeys = [...new Set((input.legacyKeys ?? []).map((k) => checkKey('legacyKeys', k)))];
  if (legacyKeys.includes(key)) {
    throw new SeedRegistryInvalidFieldError('legacyKeys', key, 'repeats the entry’s own key.');
  }

  const source = input.source;
  const initialised = source === SEED_REGISTRY_INITIALISED_SOURCE;
  if (!initialised) {
    for (const [field, value] of [
      ['source.owner', source.owner],
      ['source.repo', source.repo],
    ] as const) {
      if (!GITHUB_NAME_PATTERN.test(value)) {
        throw new SeedRegistryInvalidFieldError(field, value, 'is not a GitHub name.');
      }
    }
  }

  // `any` is the `initialised` entry's alone (706 3.1): a template is always one
  // role's and one stack's.
  const role = input.role === SEED_REGISTRY_ANY ? null : checkRole(input.role);
  if (role === null && !initialised) {
    throw new SeedRegistryInvalidFieldError(
      'role',
      input.role,
      'is only for the initialised seed.',
    );
  }
  const stack = input.stack === SEED_REGISTRY_ANY ? null : input.stack;
  if (stack !== null && !STACK_PATTERN.test(stack)) {
    throw new SeedRegistryInvalidFieldError('stack', stack, 'must be a lowercase stack name.');
  }
  if (stack === null && !initialised) {
    throw new SeedRegistryInvalidFieldError(
      'stack',
      input.stack,
      'is only for the initialised seed.',
    );
  }

  const label = input.label.trim();
  if (label.length === 0 || label.length > LABEL_MAX) {
    throw new SeedRegistryInvalidFieldError(
      'label',
      input.label,
      `must be 1–${LABEL_MAX} characters.`,
    );
  }

  return {
    key,
    legacyKeys,
    role,
    stack,
    label,
    templateOwner: initialised ? null : source.owner,
    templateRepo: initialised ? null : source.repo,
    useCases: checkList('useCase', input.useCases, isHostingUseCase) as PrismaHostingUseCase[],
    sizes: checkList('size', input.sizes, isHostingSize) as PrismaHostingSize[],
    hostingTargets: checkList(
      'hostingTarget',
      input.hostingTargets,
      isHostingTarget,
    ) as PrismaHostingTarget[],
    status: checkStatus(input.status ?? 'active'),
    promotedFrom: input.promotedFrom ?? null,
    promotedBy: input.promotedBy ?? null,
    promotedAt: input.promotedAt ?? null,
  };
}

/** No OTHER entry may hold any of `keys`, as its key or a legacy key. */
async function assertKeysFree(
  keys: string[],
  ownId: string | null,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (keys.length === 0) return;
  const holders = await seedRegistryEntryRepository.findHoldingAnyKey(keys, tx);
  const clash = holders.find((holder) => holder.id !== ownId);
  if (clash) {
    throw new SeedRegistryKeyTakenError(keys.find((k) => k === clash.key) ?? keys[0]!);
  }
}
