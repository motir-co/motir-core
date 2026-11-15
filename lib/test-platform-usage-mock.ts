import { readFixtureFileSync } from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';
import type { RawProviderReconciliation } from '@/lib/ai/motirAiClient';

/**
 * The motir-ai PLATFORM USAGE boundary, faked for the E2E lanes (Story MOTIR-727 ·
 * MOTIR-735) — the operator console's five reads:
 *
 *   - GET /v1/platform/runs            → the estate's / an org's / a workspace's runs
 *   - GET /v1/platform/usage           → one entity's eight categories + models
 *   - GET /v1/platform/usage/orgs      → the Tenants list + the estate total
 *   - GET /v1/platform/usage/children  → an org's workspaces (+ remainder) / a workspace's projects
 *   - GET /v1/platform/usage/months    → month by month + the all-time row
 *
 * and the Provider bills section's read (Story MOTIR-11350 · MOTIR-11387):
 *
 *   - GET /v1/platform/usage/provider-reconciliation → one month's provider bills
 *     beside Motir's recorded cost, answered VERBATIM from the fixture's
 *     `providerReconciliation[period]` (an empty month when the period has none),
 *     or a 503 problem+json while `providerReconciliationError` is set
 *
 * Answered from a JSON fixture the spec writes (`MOTIR_AI_PLATFORM_FIXTURE_PATH`):
 * the estate as orgs → workspaces → projects, each with a SCALE every figure is
 * derived from, so a spec asserts sums it can predict. Shapes follow motir-ai's
 * `docs/contract.md`. Installed only when `E2E_TEST_PLATFORM_USAGE` is set.
 */

export interface PlatformFixtureProject {
  id: string;
  scale: number;
}
export interface PlatformFixtureWorkspace {
  id: string;
  scale: number;
  projects: PlatformFixtureProject[];
}
export interface PlatformFixtureOrg {
  id: string;
  scale: number;
  workspaces: PlatformFixtureWorkspace[];
}
export interface PlatformFixtureRun {
  kind: 'planning' | 'coding';
  id: string;
  coreOrganizationId: string;
  coreWorkspaceId: string | null;
  coreProjectId: string | null;
  model: string;
  startedAt: string;
  credits: number;
}
export interface PlatformUsageFixture {
  orgs: PlatformFixtureOrg[];
  runs?: PlatformFixtureRun[];
  /**
   * The provider-bill reconciliation body per `YYYY-MM` period, exactly as motir-ai's
   * contract documents the route. A period with no entry answers an empty month.
   */
  providerReconciliation?: Record<string, RawProviderReconciliation>;
  /** When true, the reconciliation route answers a 503 problem+json instead. */
  providerReconciliationError?: boolean;
}

const CHARGED = [
  'planning_tokens',
  'agent_tokens',
  'agent_machine',
  'agent_instance',
  'agent_storage',
  'ci',
  'search',
] as const;
const ALL = [...CHARGED, 'indexing'] as const;
/** Credits per unit of scale, per charged category. */
const RATE: Record<(typeof CHARGED)[number], number> = {
  planning_tokens: 100,
  agent_tokens: 40,
  agent_machine: 12,
  agent_instance: 6,
  agent_storage: 1,
  ci: 2,
  search: 4,
};
/** What a credit cost Motir, in micro-dollars, and indexing's seconds and cost per scale. */
const COST_PER_CREDIT = 4_350;
const INDEXING_SECONDS = 600;
const INDEXING_COST = 90_000;

const json = { headers: { 'content-type': 'application/json' } };

function readFixture(): PlatformUsageFixture {
  const p = process.env['MOTIR_AI_PLATFORM_FIXTURE_PATH'];
  if (!p) return { orgs: [] };
  try {
    return JSON.parse(readFixtureFileSync(p)) as PlatformUsageFixture;
  } catch {
    return { orgs: [] };
  }
}

function pathOnly(p: string): string {
  return p.split('?')[0]!;
}
function query(p: string): URLSearchParams {
  return new URLSearchParams(p.split('?')[1] ?? '');
}

function spendRow(entityId: string, scale: number) {
  const credits = Object.fromEntries(CHARGED.map((c) => [c, RATE[c] * scale])) as Record<
    (typeof CHARGED)[number],
    number
  >;
  const cost = Object.fromEntries(
    ALL.map((c) => [
      c,
      c === 'indexing' ? INDEXING_COST * scale : RATE[c] * scale * COST_PER_CREDIT,
    ]),
  ) as Record<(typeof ALL)[number], number>;
  const chargedCredits = CHARGED.reduce((s, c) => s + credits[c], 0);
  return {
    entityId,
    credits,
    indexingSeconds: INDEXING_SECONDS * scale,
    chargedCredits,
    costMicroUsd: ALL.reduce((s, c) => s + cost[c], 0),
    cost,
  };
}

function categories(scale: number) {
  return ALL.map((category) => ({
    category,
    usageQuantity:
      category === 'indexing'
        ? INDEXING_SECONDS * scale
        : category === 'planning_tokens' || category === 'agent_tokens'
          ? 0
          : RATE[category] * scale * 60,
    inputTokens:
      category === 'planning_tokens' || category === 'agent_tokens'
        ? RATE[category] * scale * 1_000
        : 0,
    outputTokens:
      category === 'planning_tokens' || category === 'agent_tokens'
        ? RATE[category] * scale * 100
        : 0,
    cacheMissTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    credits: category === 'indexing' ? 0 : RATE[category] * scale,
    costMicroUsd:
      category === 'indexing' ? INDEXING_COST * scale : RATE[category] * scale * COST_PER_CREDIT,
  }));
}

/** Each token category split across two models, 3 : 1, so a model row sums to its category. */
function models(scale: number, orgs: number | null) {
  const split = (category: 'planning_tokens' | 'agent_tokens') =>
    [
      ['claude-opus-4-6', 3],
      ['claude-sonnet-4-6', 1],
    ].map(([model, share]) => {
      const part = (n: number) => (n * (share as number)) / 4;
      return {
        model: model as string,
        inputTokens: part(RATE[category] * scale * 1_000),
        outputTokens: part(RATE[category] * scale * 100),
        cacheMissTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        credits: part(RATE[category] * scale),
        costMicroUsd: part(RATE[category] * scale * COST_PER_CREDIT),
        orgs,
      };
    });
  return { planning_tokens: split('planning_tokens'), agent_tokens: split('agent_tokens') };
}

/** The scale of the entity a read names, from the fixture's tree. */
function scaleOf(fixture: PlatformUsageFixture, level: string, entityId: string | null): number {
  if (level === 'platform') return fixture.orgs.reduce((s, o) => s + o.scale, 0);
  for (const o of fixture.orgs) {
    if (level === 'organization' && o.id === entityId) return o.scale;
    for (const w of o.workspaces) {
      if (level === 'workspace' && w.id === entityId) return w.scale;
      for (const p of w.projects) if (level === 'project' && p.id === entityId) return p.scale;
    }
  }
  return 0;
}

function sortValue(row: ReturnType<typeof spendRow>, sort: string): number {
  if (sort === 'charged') return row.chargedCredits;
  if (sort === 'indexing') return row.indexingSeconds;
  if (sort in row.credits) return row.credits[sort as (typeof CHARGED)[number]];
  return row.costMicroUsd;
}

export function installPlatformUsageBoundaryMock(agent: MockAgent): void {
  const origin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (!origin) return;
  const pool = agent.get(origin);

  pool
    .intercept({ path: (p) => pathOnly(p) === '/v1/platform/runs', method: 'GET' })
    .reply((req) => {
      const q = query(req.path);
      const runs = (readFixture().runs ?? [])
        .filter(
          (r) =>
            !q.get('coreOrganizationId') || r.coreOrganizationId === q.get('coreOrganizationId'),
        )
        .filter((r) => !q.get('coreWorkspaceId') || r.coreWorkspaceId === q.get('coreWorkspaceId'))
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        .map((r) => ({
          ...r,
          ref: r.id,
          status: r.kind === 'planning' ? 'succeeded' : null,
          lastActivityAt: r.startedAt,
          inputTokens: r.credits * 1_000,
          outputTokens: r.credits * 100,
        }));
      return {
        statusCode: 200,
        data: {
          items: runs,
          nextCursor: null,
          codingRunsUnattributedExcluded: Boolean(q.get('coreWorkspaceId')),
        },
        responseOptions: json,
      };
    })
    .persist();

  pool
    .intercept({ path: (p) => pathOnly(p) === '/v1/platform/usage/orgs', method: 'GET' })
    .reply((req) => {
      const q = query(req.path);
      const fixture = readFixture();
      const ids = q.has('coreOrganizationIds')
        ? (q.get('coreOrganizationIds') ?? '').split(',')
        : null;
      const sort = q.get('sort') ?? 'cost';
      const items = fixture.orgs
        .filter((o) => !ids || ids.includes(o.id))
        .map((o) => spendRow(o.id, o.scale))
        .sort(
          (a, b) => sortValue(b, sort) - sortValue(a, sort) || (a.entityId < b.entityId ? 1 : -1),
        );
      return {
        statusCode: 200,
        data: {
          period: q.get('period') ?? 'all',
          sort,
          items,
          nextCursor: null,
          estate: spendRow('platform', scaleOf(fixture, 'platform', null)),
        },
        responseOptions: json,
      };
    })
    .persist();

  pool
    .intercept({ path: (p) => pathOnly(p) === '/v1/platform/usage/children', method: 'GET' })
    .reply((req) => {
      const q = query(req.path);
      const fixture = readFixture();
      const level = q.get('level') ?? 'organization';
      const entityId = q.get('entityId');
      const org = fixture.orgs.find((o) => o.id === entityId);
      const ws = fixture.orgs.flatMap((o) => o.workspaces).find((w) => w.id === entityId);
      const items =
        level === 'organization'
          ? (org?.workspaces ?? []).map((w) => spendRow(w.id, w.scale))
          : (ws?.projects ?? []).map((p) => spendRow(p.id, p.scale));
      return {
        statusCode: 200,
        data: {
          period: q.get('period') ?? 'all',
          sort: q.get('sort') ?? 'cost',
          level,
          entityId,
          childLevel: level === 'organization' ? 'workspace' : 'project',
          items: items.sort((a, b) => b.costMicroUsd - a.costMicroUsd),
          nextCursor: null,
          remainder:
            level === 'organization'
              ? { noProject: spendRow('no_project', 1), orgLevel: spendRow('org_level', 1) }
              : null,
        },
        responseOptions: json,
      };
    })
    .persist();

  pool
    .intercept({ path: (p) => pathOnly(p) === '/v1/platform/usage/months', method: 'GET' })
    .reply((req) => {
      const q = query(req.path);
      const scale = scaleOf(readFixture(), q.get('level') ?? 'platform', q.get('entityId'));
      const month = (period: string, s: number) => {
        const row = spendRow('x', s);
        return {
          period,
          categories: Object.fromEntries(
            ALL.map((c) => [
              c,
              {
                credits: c === 'indexing' ? 0 : row.credits[c],
                usageQuantity: c === 'indexing' ? row.indexingSeconds : 0,
                costMicroUsd: row.cost[c],
              },
            ]),
          ),
          spend: {
            chargedCredits: row.chargedCredits,
            chargedCostMicroUsd: row.costMicroUsd - row.cost.indexing,
            costMicroUsdInclIndexing: row.costMicroUsd,
            machineSeconds: s * 1_200,
          },
        };
      };
      const now = new Date();
      const ym = (back: number) =>
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
          .toISOString()
          .slice(0, 7);
      return {
        statusCode: 200,
        data: {
          level: q.get('level'),
          entityId: q.get('entityId') ?? '',
          items: [month(ym(0), scale), month(ym(1), scale)],
          nextCursor: null,
          allTime: month('all', scale * 2),
        },
        responseOptions: json,
      };
    })
    .persist();

  pool
    .intercept({ path: (p) => pathOnly(p) === '/v1/platform/usage', method: 'GET' })
    .reply((req) => {
      const q = query(req.path);
      const fixture = readFixture();
      const level = q.get('level') ?? 'platform';
      const scale = scaleOf(fixture, level, q.get('entityId'));
      const row = spendRow('x', scale);
      return {
        statusCode: 200,
        data: {
          period: q.get('period') ?? q.get('yearMonth'),
          level,
          entityId: q.get('entityId') ?? '',
          categories: categories(scale),
          models: models(scale, level === 'platform' ? fixture.orgs.length : null),
          spend: {
            chargedCredits: row.chargedCredits,
            chargedCostMicroUsd: row.costMicroUsd - row.cost.indexing,
            costMicroUsdInclIndexing: row.costMicroUsd,
            machineSeconds: scale * 1_200,
          },
          orgsWithSpend:
            level === 'platform' ? fixture.orgs.filter((o) => o.scale > 0).length : null,
        },
        responseOptions: json,
      };
    })
    .persist();

  pool
    .intercept({
      path: (p) => pathOnly(p) === '/v1/platform/usage/provider-reconciliation',
      method: 'GET',
    })
    .reply<object>((req) => {
      const period = query(req.path).get('period') ?? '';
      const fixture = readFixture();
      if (fixture.providerReconciliationError) {
        return {
          statusCode: 503,
          data: {
            type: 'about:blank',
            title: 'Service unavailable',
            status: 503,
            code: 'upstream_unavailable',
            detail: 'The provider-bill reconciliation could not be read.',
          },
          responseOptions: { headers: { 'content-type': 'application/problem+json' } },
        };
      }
      const empty: RawProviderReconciliation = {
        period,
        providers: [],
        findings: [],
        unreconciledProviders: [],
      };
      return {
        statusCode: 200,
        data: fixture.providerReconciliation?.[period] ?? empty,
        responseOptions: json,
      };
    })
    .persist();
}
