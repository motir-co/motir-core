import type {
  RawPlatformRunsPage,
  RawProviderReconciliation,
  RawPlatformUsage,
  RawPlatformUsageChildren,
  RawPlatformUsageMonths,
  RawPlatformUsageOrgs,
  RawSpendRow,
} from '@/lib/ai/motirAiClient';

/**
 * motir-ai's platform reads AS RECORDED — the response bodies of the routes Story
 * MOTIR-727's console reads, shaped exactly as motir-ai's `docs/contract.md`
 * documents them (§ `GET /v1/platform/usage`, `/usage/children`, `/usage/orgs`,
 * `/usage/months`, `GET /v1/platform/runs`) and its DTOs declare
 * (`src/services/platformUsageRollupService.ts`, `platformRunsService.ts`).
 *
 * TYPED with motir-core's own `Raw*` client types on purpose: a field motir-core
 * stops declaring, or declares differently, fails the typecheck here before a
 * seam test even runs. The org / workspace / project ids are placeholders a test
 * rewrites onto its own fixture rows (`withIds`).
 */

export const ORG = '__ORG__';
export const WS = '__WS__';
export const PROJECT = '__PROJECT__';

const category = (
  c: RawPlatformUsage['categories'][number]['category'],
  over: Partial<RawPlatformUsage['categories'][number]> = {},
) => ({
  category: c,
  usageQuantity: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheMissTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  credits: 0,
  costMicroUsd: 0,
  ...over,
});

/** `GET /v1/platform/usage?period=2026-09&level=organization&entityId=…` — all eight categories. */
export const USAGE: RawPlatformUsage = {
  period: '2026-09',
  level: 'organization',
  entityId: ORG,
  categories: [
    category('planning_tokens', {
      inputTokens: 4_100_000,
      outputTokens: 620_000,
      cacheMissTokens: 4_100_000,
      credits: 11_920,
      costMicroUsd: 41_200_000,
    }),
    category('agent_tokens', {
      inputTokens: 1_800_000,
      outputTokens: 240_000,
      cacheReadTokens: 900_000,
      credits: 4_480,
      costMicroUsd: 19_500_000,
    }),
    category('agent_machine', { usageQuantity: 74_400, credits: 1_240, costMicroUsd: 2_350_000 }),
    category('agent_instance', { usageQuantity: 37_200, credits: 620, costMicroUsd: 1_180_000 }),
    category('agent_storage', { usageQuantity: 7_776_000, credits: 90, costMicroUsd: 690_000 }),
    category('ci', { usageQuantity: 20_400, credits: 68, costMicroUsd: 645_000 }),
    category('search', { usageQuantity: 410, credits: 410, costMicroUsd: 2_050_000 }),
    // MOTIR-12167 — production hosting: credits only (none in this recorded month).
    category('hosting_production'),
    category('indexing', { usageQuantity: 57_600, costMicroUsd: 6_200_000 }),
  ],
  models: {
    planning_tokens: [
      {
        model: 'claude-opus-4-6',
        inputTokens: 2_200_000,
        outputTokens: 310_000,
        cacheMissTokens: 2_200_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        credits: 6_400,
        costMicroUsd: 24_900_000,
        orgs: null,
      },
      {
        model: 'claude-sonnet-4-6',
        inputTokens: 1_900_000,
        outputTokens: 310_000,
        cacheMissTokens: 1_900_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        credits: 5_520,
        costMicroUsd: 16_300_000,
        orgs: null,
      },
    ],
    agent_tokens: [
      {
        model: 'claude-opus-4-6',
        inputTokens: 1_800_000,
        outputTokens: 240_000,
        cacheMissTokens: 900_000,
        cacheReadTokens: 900_000,
        cacheWriteTokens: 0,
        credits: 4_480,
        costMicroUsd: 19_500_000,
        orgs: null,
      },
    ],
  },
  spend: {
    chargedCredits: 18_828,
    chargedCostMicroUsd: 67_615_000,
    costMicroUsdInclIndexing: 73_815_000,
    machineSeconds: 189_600,
  },
  orgsWithSpend: null,
};

const row = (entityId: string, scale: number): RawSpendRow => ({
  entityId,
  credits: {
    planning_tokens: 100 * scale,
    agent_tokens: 40 * scale,
    agent_machine: 12 * scale,
    agent_instance: 6 * scale,
    agent_storage: 1 * scale,
    ci: 2 * scale,
    search: 4 * scale,
    // MOTIR-12167 — production hosting: credits only, no Motir cost on the rollup.
    hosting_production: 0,
  },
  indexingSeconds: 600 * scale,
  chargedCredits: 165 * scale,
  costMicroUsd: 1_000_000 * scale,
  cost: {
    planning_tokens: 400_000 * scale,
    agent_tokens: 200_000 * scale,
    agent_machine: 100_000 * scale,
    agent_instance: 50_000 * scale,
    agent_storage: 20_000 * scale,
    ci: 30_000 * scale,
    search: 100_000 * scale,
    hosting_production: 0,
    indexing: 100_000 * scale,
  },
});

/** `GET /v1/platform/usage/children?level=organization&entityId=…` — with both remainder rows. */
export const CHILDREN: RawPlatformUsageChildren = {
  period: '2026-09',
  sort: 'cost',
  level: 'organization',
  entityId: ORG,
  childLevel: 'workspace',
  items: [row(WS, 3)],
  nextCursor: null,
  remainder: { noProject: row('no_project', 1), orgLevel: row('org_level', 2) },
};

/** `GET /v1/platform/usage/orgs?period=2026-09` — the Tenants list, its estate total over ALL orgs. */
export const ORGS: RawPlatformUsageOrgs = {
  period: '2026-09',
  sort: 'cost',
  items: [row(ORG, 3)],
  nextCursor: 'eyJ2IjoiMTA5MzAwMDAwIiwiZSI6Im9yZ19hYmMifQ',
  estate: row('platform', 10),
};

const month = (period: string, scale: number): RawPlatformUsageMonths['items'][number] => {
  const r = row('x', scale);
  return {
    period,
    categories: {
      planning_tokens: {
        credits: r.credits.planning_tokens,
        usageQuantity: 0,
        costMicroUsd: r.cost.planning_tokens,
      },
      agent_tokens: {
        credits: r.credits.agent_tokens,
        usageQuantity: 0,
        costMicroUsd: r.cost.agent_tokens,
      },
      agent_machine: {
        credits: r.credits.agent_machine,
        usageQuantity: 720 * scale,
        costMicroUsd: r.cost.agent_machine,
      },
      agent_instance: {
        credits: r.credits.agent_instance,
        usageQuantity: 360 * scale,
        costMicroUsd: r.cost.agent_instance,
      },
      agent_storage: {
        credits: r.credits.agent_storage,
        usageQuantity: 86_400 * scale,
        costMicroUsd: r.cost.agent_storage,
      },
      ci: { credits: r.credits.ci, usageQuantity: 120 * scale, costMicroUsd: r.cost.ci },
      search: { credits: r.credits.search, usageQuantity: 4 * scale, costMicroUsd: r.cost.search },
      hosting_production: {
        credits: r.credits.hosting_production,
        usageQuantity: 0,
        costMicroUsd: r.cost.hosting_production,
      },
      indexing: { credits: 0, usageQuantity: r.indexingSeconds, costMicroUsd: r.cost.indexing },
    },
    spend: {
      chargedCredits: r.chargedCredits,
      chargedCostMicroUsd: r.costMicroUsd - r.cost.indexing,
      costMicroUsdInclIndexing: r.costMicroUsd,
      machineSeconds: 1_200 * scale,
    },
  };
};

/** `GET /v1/platform/usage/months?level=organization&entityId=…` — newest first, then the all-time row. */
export const MONTHS: RawPlatformUsageMonths = {
  level: 'organization',
  entityId: ORG,
  items: [month('2026-09', 2), month('2026-08', 1)],
  nextCursor: '2026-08',
  allTime: month('all', 3),
};

/** `GET /v1/platform/runs?coreOrganizationId=…` — one hosted run (attributed), one planning run (org-level). */
export const RUNS: RawPlatformRunsPage = {
  items: [
    {
      kind: 'coding',
      id: 'clr_run_2',
      ref: 'cmrun_2',
      coreOrganizationId: ORG,
      coreWorkspaceId: WS,
      coreProjectId: PROJECT,
      model: 'claude-opus-4-6',
      status: null,
      startedAt: '2026-09-30T10:00:00.000Z',
      lastActivityAt: '2026-09-30T10:42:00.000Z',
      inputTokens: 51_000,
      outputTokens: 7_200,
      credits: 96,
    },
    {
      kind: 'planning',
      id: 'clr_run_1',
      ref: 'job_1',
      coreOrganizationId: ORG,
      coreWorkspaceId: null,
      coreProjectId: null,
      model: 'claude-sonnet-4-6',
      status: 'succeeded',
      startedAt: '2026-09-29T08:00:00.000Z',
      lastActivityAt: '2026-09-29T08:03:00.000Z',
      inputTokens: 12_000,
      outputTokens: 2_100,
      credits: 14,
    },
  ],
  nextCursor: 'eyJ0IjoiMjAyNi0wOS0yOVQwODowMDowMC4wMDBaIiwiaSI6ImNscl9ydW5fMSJ9',
  codingRunsUnattributedExcluded: false,
};

/** Rewrite the placeholder ids onto a test's own org / workspace / project. */
export function withIds<T>(body: T, ids: { org: string; ws: string; project: string }): T {
  return JSON.parse(
    JSON.stringify(body)
      .replaceAll(ORG, ids.org)
      .replaceAll(WS, ids.ws)
      .replaceAll(PROJECT, ids.project),
  ) as T;
}

/**
 * `GET /v1/platform/usage/provider-reconciliation?period=2026-09` — the contract's
 * own example (§ provider-reconciliation, MOTIR-11374), extended so every source,
 * status and differing side appears once: a reconciled API day past tolerance and
 * broken down by model, a closed day with no record, a failed read, a balance
 * snapshot, an export, a provider with no tolerance row, and a provider with no
 * bill source.
 */
export const PROVIDER_RECONCILIATION: RawProviderReconciliation = {
  period: '2026-09',
  providers: [
    {
      provider: 'anthropic',
      relativeTolerance: 0.05,
      absoluteToleranceMicroUsd: 500_000,
      days: [
        {
          day: '2026-09-01',
          recordedMicroUsd: 2_000_000,
          billedMicroUsd: 3_000_000,
          source: 'api',
          status: 'reconciled',
          readAt: '2026-09-02T03:00:00.000Z',
          gapMicroUsd: 1_000_000,
          pastTolerance: true,
          perModel: [
            {
              model: 'claude-a',
              recordedMicroUsd: 1_500_000,
              billedMicroUsd: 2_500_000,
              gapMicroUsd: 1_000_000,
            },
            {
              model: 'claude-b',
              recordedMicroUsd: 500_000,
              billedMicroUsd: 500_000,
              gapMicroUsd: 0,
            },
          ],
          estimatedRowCount: 3,
        },
        {
          day: '2026-09-02',
          recordedMicroUsd: null,
          billedMicroUsd: null,
          source: 'none',
          status: 'failed',
          readAt: null,
          gapMicroUsd: null,
          pastTolerance: false,
          perModel: [],
          estimatedRowCount: null,
        },
      ],
    },
    {
      provider: 'deepseek',
      relativeTolerance: 0.1,
      absoluteToleranceMicroUsd: 500_000,
      days: [
        {
          day: '2026-09-01',
          recordedMicroUsd: 900_000,
          billedMicroUsd: 910_000,
          source: 'balance_snapshot',
          status: 'reconciled',
          readAt: '2026-09-02T00:05:00.000Z',
          gapMicroUsd: 10_000,
          pastTolerance: false,
          perModel: [],
          estimatedRowCount: null,
        },
        {
          day: '2026-09-02',
          recordedMicroUsd: 800_000,
          billedMicroUsd: null,
          source: 'none',
          status: 'failed',
          readAt: '2026-09-03T03:00:00.000Z',
          gapMicroUsd: null,
          pastTolerance: false,
          perModel: [],
          estimatedRowCount: null,
        },
      ],
    },
    {
      provider: 'igate-export',
      relativeTolerance: null,
      absoluteToleranceMicroUsd: null,
      days: [
        {
          day: '2026-09-01',
          recordedMicroUsd: 100_000,
          billedMicroUsd: 100_000,
          source: 'export',
          status: 'reconciled',
          readAt: '2026-09-05T10:00:00.000Z',
          gapMicroUsd: 0,
          pastTolerance: false,
          perModel: [],
          estimatedRowCount: null,
        },
      ],
    },
    {
      provider: 'moonshotai',
      relativeTolerance: 0.05,
      absoluteToleranceMicroUsd: 500_000,
      days: [
        {
          day: '2026-09-01',
          recordedMicroUsd: 300_000,
          billedMicroUsd: null,
          source: 'none',
          status: 'unreconciled',
          readAt: null,
          gapMicroUsd: null,
          pastTolerance: false,
          perModel: [],
          estimatedRowCount: null,
        },
      ],
    },
  ],
  findings: [
    {
      provider: 'anthropic',
      day: '2026-09-01',
      recordedMicroUsd: 2_000_000,
      billedMicroUsd: 3_000_000,
      gapMicroUsd: 1_000_000,
      models: [
        {
          model: 'claude-a',
          recordedMicroUsd: 1_500_000,
          billedMicroUsd: 2_500_000,
          gapMicroUsd: 1_000_000,
        },
      ],
      estimatedRowCount: 3,
      differingSide: 'motir-ai',
    },
    {
      provider: 'openai',
      day: '2026-09-01',
      recordedMicroUsd: 1_000_000,
      billedMicroUsd: 2_000_000,
      gapMicroUsd: 1_000_000,
      models: [],
      estimatedRowCount: null,
      differingSide: null,
    },
  ],
  unreconciledProviders: ['moonshotai'],
};

/**
 * motir-core's OUTGOING bodies, as motir-ai's contract documents each request — the
 * exact key set of every body motir-core sends, optional keys marked.
 */
export const OUTGOING = {
  /** `POST /v1/platform/meter`, one settled fleet container. */
  meterContainer: {
    required: [
      'kind',
      'containerUsageId',
      'coreOrganizationId',
      'workload',
      'billableSeconds',
      'costUsd',
      'settledAt',
    ],
    optional: ['coreWorkspaceId', 'coreProjectId'],
    workloads: ['agent', 'agent_instance', 'ci', 'index'],
  },
  /** `POST /v1/platform/meter`, one UTC day of an agent instance's storage. */
  meterStorage: {
    required: ['kind', 'instanceId', 'coreOrganizationId', 'day', 'gbSeconds', 'costUsd'],
    optional: [],
  },
  /** `POST /v1/credits/agent-machine` on the `coreRunId` path, with the run's attribution (MOTIR-7238). */
  agentMachineRun: {
    required: ['coreOrganizationId', 'coreRunId', 'credits', 'billableSeconds', 'externalRef'],
    optional: ['reason', 'coreWorkspaceId', 'coreProjectId'],
  },
} as const;
