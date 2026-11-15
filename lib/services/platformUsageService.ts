import 'server-only';

import type { Organization, Prisma } from '@/generated/prisma/client';
import {
  getPlatformUsageOrgs,
  type RawPlatformUsageOrgs,
  type RawSpendRow,
  type SpendListSort,
} from '@/lib/ai/motirAiClient';
import type { PlatformTenantListDTO, PlatformTenantSpendRowDTO } from '@/lib/dto/platform';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { SPEND_CATEGORIES } from '@/lib/platform/spend';
import { platformOrganizationRepository } from '@/lib/repositories/platformOrganizationRepository';

/**
 * The console's SPEND LISTS (Story MOTIR-727 · MOTIR-7287) — motir-ai's platform
 * rollup holds the figures, motir-core holds the names; this joins them under the
 * audited platform read.
 *
 * ⚠️ THE ROLLUP IS NOT THE LIST OF ORGANIZATIONS (MOTIR-8978). motir-ai holds a row
 * only for an organization that spent something in the period, so a list built
 * from its rows alone loses every organization that spent nothing — the new
 * customer, the test org, the stuck signup an operator most needs to reach. The
 * list is therefore TWO runs: motir-ai's spend rows in `sort` order, then the
 * ZERO-SPEND TAIL — the organizations in motir-core's own table motir-ai has no
 * row for, newest first, at zero. `decodeTenantCursor` says how a view resumes.
 *
 * ⚠️ ONE AUDIT ROW PER VIEW, AND NO HTTP INSIDE THE TRANSACTION. motir-ai's request
 * deadline (30 s) outlives an interactive transaction (5 s), so the remote read
 * never runs inside `withPlatformRead`. That leaves these orders:
 *   - NO FILTER, spend run: read motir-ai first, then ONE audited read names the
 *     rows (and, on the run's last page, reads the tail's candidates).
 *   - NO FILTER, tail: ONE audited read lists candidates, then motir-ai says which
 *     of them it has rows for.
 *   - A FILTER: ONE audited read resolves the name/slug to organizations — whose
 *     names it then already holds — and motir-ai is read narrowed to their ids.
 *     The filter narrows BEFORE the remote read, never after a page of it.
 * motir-ai unreachable is `unavailable: true`, never a throw; the view is audited
 * either way.
 */

/** One page of the Tenants list. */
export const TENANT_LIST_PAGE = 50;
/** How many organizations a filter may resolve to; past it, the operator narrows it. */
export const TENANT_FILTER_LIMIT = 200;
/** The filter's shortest useful query, as the org lookup it replaces had it. */
export const TENANT_FILTER_MIN_LENGTH = 2;

export const TENANT_LIST_SORTS: readonly SpendListSort[] = ['cost', 'charged', ...SPEND_CATEGORIES];

export function parseTenantSort(raw: string | null | undefined): SpendListSort {
  return TENANT_LIST_SORTS.includes(raw as SpendListSort) ? (raw as SpendListSort) : 'cost';
}

type Named = Pick<Organization, 'id' | 'name' | 'slug' | 'isMeta' | 'internalBilling'>;
/** An organization as the zero-spend tail keysets it: `(createdAt desc, id desc)`. */
type Keyed = Named & Pick<Organization, 'createdAt'>;
type OrgKey = { createdAt: Date; id: string };

/** The most organizations one view's zero-spend tail examines. */
export const TENANT_ZERO_SPEND_SCAN = 200;
/** motir-ai's largest page (`PLATFORM_USAGE_MAX_LIMIT`), so one presence read answers a batch whole. */
const REMOTE_MAX_LIMIT = 100;

/**
 * WHERE A VIEW RESUMES (MOTIR-8978). The list is two runs end to end: the SPEND
 * run — motir-ai's rows, sorted by `sort` under motir-ai's own keyset — then the
 * ZERO-SPEND TAIL, every organization motir-ai has no row for, newest first. A
 * page may straddle the seam. The cursor says which run, and where in it:
 *   - `s.<motir-ai cursor>` — inside the spend run;
 *   - `z.` — the tail's start; `z.<key>` — the tail after an organization.
 * A cursor with neither prefix is one motir-ai issued before the tail existed,
 * read as the spend run's; a tail key that does not decode reads as the start of
 * the list, never as an error page.
 */
type TenantCursor =
  | { phase: 'spend'; remote: string | null }
  | { phase: 'zero'; after: OrgKey | null };

function encodeTailCursor(after: OrgKey | null): string {
  if (!after) return 'z.';
  return `z.${Buffer.from(`${after.createdAt.toISOString()}|${after.id}`).toString('base64url')}`;
}

function decodeTailKey(raw: string): OrgKey | null | undefined {
  if (raw === '') return null;
  const parts = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (parts.length !== 2) return undefined;
  const [iso, id] = parts as [string, string];
  const createdAt = new Date(iso);
  if (!id || Number.isNaN(createdAt.getTime())) return undefined;
  return { createdAt, id };
}

export function decodeTenantCursor(raw: string | null | undefined): TenantCursor {
  if (!raw) return { phase: 'spend', remote: null };
  if (raw.startsWith('s.')) return { phase: 'spend', remote: raw.slice(2) || null };
  if (!raw.startsWith('z.')) return { phase: 'spend', remote: raw };
  const after = decodeTailKey(raw.slice(2));
  return after === undefined ? { phase: 'spend', remote: null } : { phase: 'zero', after };
}

const keyOf = (o: Keyed): OrgKey => ({ createdAt: o.createdAt, id: o.id });

/** Is `o` past `after` in `(createdAt desc, id desc)`? */
function isPast(o: Keyed, after: OrgKey | null): boolean {
  if (!after) return true;
  const t = o.createdAt.getTime() - after.createdAt.getTime();
  return t < 0 || (t === 0 && o.id < after.id);
}

/** A spend row of zeros — an organization motir-ai's rollup holds nothing for. */
export function zeroSpendRow(entityId: string): RawSpendRow {
  const charged = SPEND_CATEGORIES.filter((c) => c !== 'indexing');
  return {
    entityId,
    credits: Object.fromEntries(charged.map((c) => [c, 0])) as RawSpendRow['credits'],
    indexingSeconds: 0,
    chargedCredits: 0,
    costMicroUsd: 0,
    cost: Object.fromEntries(SPEND_CATEGORIES.map((c) => [c, 0])) as RawSpendRow['cost'],
  };
}

function toRow(row: RawSpendRow, org: Named | null): PlatformTenantSpendRowDTO {
  return {
    organization: org
      ? {
          id: org.id,
          name: org.name,
          slug: org.slug,
          isMeta: org.isMeta,
          internalBilling: org.internalBilling,
        }
      : row.entityId === 'platform'
        ? null
        : {
            id: row.entityId,
            name: row.entityId,
            slug: null,
            isMeta: false,
            internalBilling: false,
          },
    credits: row.credits,
    indexingSeconds: row.indexingSeconds,
    chargedCredits: row.chargedCredits,
    costMicroUsd: row.costMicroUsd,
  };
}

async function readOrgs(
  query: Parameters<typeof getPlatformUsageOrgs>[0],
): Promise<RawPlatformUsageOrgs | null> {
  try {
    return await getPlatformUsageOrgs(query);
  } catch {
    return null;
  }
}

type ListInput = { period: string; sort: SpendListSort };

/** One view's zero-spend tail: the rows, where the next view resumes, and the estate if it read one. */
type Tail = {
  rows: PlatformTenantSpendRowDTO[];
  nextCursor: string | null;
  estate: RawSpendRow | null;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * THE ZERO-SPEND TAIL (MOTIR-8978): up to `want` of `candidates` — in their
 * `(createdAt desc, id desc)` order — that motir-ai's rollup holds no row for.
 * Whether a candidate has a row is asked of motir-ai, narrowed to the batch's ids
 * with a page wide enough to answer the batch whole; a candidate WITH a row is
 * skipped, because the spend run lists it. Batches are read only until the page
 * is full and one more zero-spend candidate proves the tail goes on, so a tail
 * that has ended answers `nextCursor: null` instead of an empty next page.
 * `needEstate` makes an empty candidate list still read motir-ai once, for the
 * estate total. `null` is motir-ai unreachable.
 */
async function readZeroSpendTail(
  input: ListInput,
  candidates: { orgs: Keyed[]; more: boolean; after: OrgKey | null },
  want: number,
  needEstate: boolean,
): Promise<Tail | null> {
  const batches = chunk(candidates.orgs, REMOTE_MAX_LIMIT);
  if (batches.length === 0 && needEstate) batches.push([]);
  const picked: Keyed[] = [];
  let estate: RawSpendRow | null = null;
  let after = candidates.after;
  for (const batch of batches) {
    const ids = batch.map((o) => o.id);
    const page = await readOrgs({
      ...input,
      limit: REMOTE_MAX_LIMIT,
      cursor: null,
      coreOrganizationIds: ids,
    });
    if (!page) return null;
    estate ??= page.estate;
    const spent = new Set(page.items.map((r) => r.entityId));
    for (const org of batch) {
      if (spent.has(org.id)) {
        if (picked.length < want) after = keyOf(org);
        continue;
      }
      if (picked.length === want) return finishTail(picked, encodeTailCursor(after), estate);
      picked.push(org);
      after = keyOf(org);
    }
  }
  return finishTail(picked, candidates.more ? encodeTailCursor(after) : null, estate);
}

function finishTail(picked: Keyed[], nextCursor: string | null, estate: RawSpendRow | null): Tail {
  return { rows: picked.map((o) => toRow(zeroSpendRow(o.id), o)), nextCursor, estate };
}

const UNAVAILABLE: ListBody = { estate: null, rows: [], nextCursor: null, unavailable: true };

export const platformUsageService = {
  /**
   * The Tenants list (design D10): the estate total over ALL organizations, then
   * one row per organization for `period` — every organization, those that spent
   * nothing included (MOTIR-8978) — the spenders sorted by `sort` under motir-ai's
   * keyset, then the zero-spend tail newest first.
   */
  async listTenants(
    principal: PlatformPrincipal,
    input: { period: string; sort: SpendListSort; filter?: string | null; cursor?: string | null },
  ): Promise<PlatformTenantListDTO> {
    await requirePlatformStaff('support');
    const filter = (input.filter ?? '').trim();
    const filtering = filter.length >= TENANT_FILTER_MIN_LENGTH;
    const base = { period: input.period, sort: input.sort, filter: filtering ? filter : '' };
    const cursor = decodeTenantCursor(input.cursor);
    const audit = {
      action: 'estate.read' as const,
      targetKind: 'platform' as const,
      targetLabel: `tenants ${input.period}${filtering ? ` "${filter}"` : ''}`,
    };
    const list = { period: input.period, sort: input.sort };
    return filtering
      ? { ...base, ...(await listFiltered(principal, audit, list, filter, cursor)) }
      : { ...base, filterCapped: false, ...(await listAll(principal, audit, list, cursor)) };
  },
};

type Audit = Parameters<typeof withPlatformRead>[1];
type ListBody = Omit<PlatformTenantListDTO, 'period' | 'sort' | 'filter' | 'filterCapped'>;

/**
 * A spend page, then — where it is the spend run's LAST — the head of the
 * zero-spend tail filling the rest of it. A tail motir-ai fails to answer leaves
 * the spend rows standing and resumes at the tail's start.
 */
async function withTailFill(
  input: ListInput,
  page: RawPlatformUsageOrgs,
  byId: Map<string, Named>,
  candidates: { orgs: Keyed[]; more: boolean },
): Promise<ListBody> {
  const rows = page.items.map((r) => toRow(r, byId.get(r.entityId) ?? null));
  const estate = toRow(page.estate, null);
  if (page.nextCursor)
    return { estate, rows, nextCursor: `s.${page.nextCursor}`, unavailable: false };
  const tail = await readZeroSpendTail(
    input,
    { ...candidates, after: null },
    Math.max(TENANT_LIST_PAGE - rows.length, 0),
    false,
  );
  if (!tail) return { estate, rows, nextCursor: encodeTailCursor(null), unavailable: false };
  return { estate, rows: [...rows, ...tail.rows], nextCursor: tail.nextCursor, unavailable: false };
}

/** A tail-only view: the zero-spend run after `after`, with motir-ai's estate. */
async function tailView(
  input: ListInput,
  candidates: { orgs: Keyed[]; more: boolean; after: OrgKey | null },
): Promise<ListBody> {
  const tail = await readZeroSpendTail(input, candidates, TENANT_LIST_PAGE, true);
  if (!tail?.estate) return UNAVAILABLE;
  return {
    estate: toRow(tail.estate, null),
    rows: tail.rows,
    nextCursor: tail.nextCursor,
    unavailable: false,
  };
}

/**
 * The FILTERED list. The filter narrows FIRST — one audited read of motir-core's
 * own table — and every organization it matched is listed: the ones motir-ai has
 * a row for in its spend order, then the rest at zero (MOTIR-8978 — a matched
 * organization is never dropped for having spent nothing).
 */
async function listFiltered(
  principal: PlatformPrincipal,
  audit: Audit,
  input: ListInput,
  filter: string,
  cursor: TenantCursor,
): Promise<ListBody & { filterCapped: boolean }> {
  const matches = await withPlatformRead(principal, audit, (tx) =>
    platformOrganizationRepository.searchOrganizations(filter, TENANT_FILTER_LIMIT + 1, tx),
  );
  const filterCapped = matches.length > TENANT_FILTER_LIMIT;
  const kept = matches.slice(0, TENANT_FILTER_LIMIT);
  if (cursor.phase === 'zero') {
    const orgs = kept.filter((o) => isPast(o, cursor.after));
    return { filterCapped, ...(await tailView(input, { orgs, more: false, after: cursor.after })) };
  }
  const page = await readOrgs({
    ...input,
    limit: TENANT_LIST_PAGE,
    cursor: cursor.remote,
    coreOrganizationIds: kept.map((o) => o.id),
  });
  if (!page) return { filterCapped, ...UNAVAILABLE };
  const byId = new Map<string, Named>(kept.map((o) => [o.id, o]));
  return { filterCapped, ...(await withTailFill(input, page, byId, { orgs: kept, more: false })) };
}

/**
 * The UNFILTERED list. In the spend run motir-ai is read first and ONE audited
 * read names its rows — and, on the run's last page, reads the head of the
 * zero-spend tail in the same transaction. In the tail, the audited read comes
 * first and motir-ai answers which of those organizations it has rows for.
 */
async function listAll(
  principal: PlatformPrincipal,
  audit: Audit,
  input: ListInput,
  cursor: TenantCursor,
): Promise<ListBody> {
  const scan = (after: OrgKey | null, tx: Prisma.TransactionClient) =>
    platformOrganizationRepository
      .listOrganizationsAfter(after, TENANT_ZERO_SPEND_SCAN + 1, tx)
      .then((rows) => ({
        orgs: rows.slice(0, TENANT_ZERO_SPEND_SCAN),
        more: rows.length > TENANT_ZERO_SPEND_SCAN,
      }));
  if (cursor.phase === 'zero') {
    const candidates = await withPlatformRead(principal, audit, (tx) => scan(cursor.after, tx));
    return tailView(input, { ...candidates, after: cursor.after });
  }
  const page = await readOrgs({ ...input, limit: TENANT_LIST_PAGE, cursor: cursor.remote });
  const [orgs, candidates] = await withPlatformRead(
    principal,
    audit,
    async (tx) =>
      [
        await platformOrganizationRepository.findOrganizationsByIds(
          page ? page.items.map((r) => r.entityId) : [],
          tx,
        ),
        page && !page.nextCursor ? await scan(null, tx) : { orgs: [], more: false },
      ] as const,
  );
  if (!page) return UNAVAILABLE;
  const byId = new Map<string, Named>(orgs.map((o) => [o.id, o]));
  return withTailFill(input, page, byId, candidates);
}
