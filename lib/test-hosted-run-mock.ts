// Node-only boundary mock for a HOSTED AGENT RUN's three outbound seams, for E2E
// (Story MOTIR-683 · MOTIR-6452).
//
// `hostedRunService.start`/`endHostedRun` make real HTTP calls to three services
// the E2E acceptance lane cannot reach: the GATEWAY (mint/revoke the run's model
// key), motir-ai (the offered-model list, the credit pre-flight, the run's usage
// and its machine-time charge) and GitHub (the repo-level installation read
// `repositoriesForItems` makes before it will call a repository writable). The
// shape mirrors `tests/hostedRuns/hostedRunStart.test.ts`'s own `fetch` stub
// exactly — same statuses, same bodies — because that suite is the CONTRACT
// these clients are already held to; this seam is the same contract answered
// over the shared undici `MockAgent` instead of `vi.stubGlobal('fetch', …)`, so
// the E2E lane exercises the real client code the vitest suite already proved.
//
// An undici intercept installed by instrumentation.ts (AND, for the two calls a
// hosted run's SUPERVISION makes from the job-worker process — the stall/cancel
// end path's gateway revoke and machine-time charge — by `job-worker-process.ts`
// too) behind `E2E_TEST_HOSTED_RUN=1`, dormant everywhere else, exactly the shape
// `test-code-graph-mock.ts` and `test-billing-mock.ts` already use.
//
// ⚠️ THE MODEL LIST MUST CHANGE MID-TEST (the "withdrawn" case), so — unlike
// `test-code-graph-mock.ts`'s in-process arm functions — this seam is FIXTURE-
// FILE-BACKED like `test-billing-mock.ts`: the spec runs in a THIRD process (the
// Playwright runner) that shares no memory with either the webServer or the
// worker, so steering has to cross a process boundary, and a file re-read on
// every request is how every sibling seam already does that.
//
// TWO FILES:
//   * MOTIR_HOSTED_RUN_FIXTURE_PATH — the spec WRITES, this mock READS, re-read
//     on every request: the offered models (and default), the credit pre-flight
//     verdict, the repo-installation answer and the run's usage totals.
//   * MOTIR_HOSTED_RUN_JOURNAL_PATH — this mock WRITES (JSONL), the spec READS:
//     proof each stub answered, and what it was asked — the gateway mint's
//     `models`, the gateway revoke's `runRef`, the machine debit's figures.

import {
  appendFixtureFileSync,
  readFixtureFileSync,
  writeFixtureFileSync,
} from '@/lib/test-fixture-file';
import type { MockAgent } from 'undici';
import { recordAgentDebit } from '@/lib/test-billing-mock';
import { orgTierOf } from '@/lib/test-org-tier-fixture';

const GITHUB_ORIGIN = 'https://api.github.com';

/** The bare gateway model id the fixture offers by default, absent any spec
 *  configuration — mirrors `hostedRunStart.test.ts`'s own `MODEL` default. */
const DEFAULT_MODEL_ID = 'e2e-hosted-model';

export interface HostedRunModelsFixture {
  /** A non-200 status makes the picker read `unavailable`. */
  status?: number;
  /** Bare gateway ids offered; `[]` is the legitimate EMPTY state. */
  ids?: string[];
  /** The preselected id. Defaults to `ids[0]`. */
  default?: string | null;
  /** motir-ai's platform default per leaf difficulty (Story MOTIR-6989 ·
   *  MOTIR-6998). Omitted → the field is absent from the answer, exactly as an
   *  older motir-ai serves it (every level null); a missing level is null. */
  defaultsByDifficulty?: Partial<Record<'trivial' | 'low' | 'medium' | 'high', string | null>>;
  /** Each id's PROVIDER, as motir-ai's entry carries it (MOTIR-7211: a DeepSeek row
   *  beside the Claude ones). An id not named here is `anthropic`, so a fixture
   *  that predates the field answers exactly as it did. */
  providers?: Record<string, string>;
  /** The platform review-agent and design-run models (story MOTIR-10838 ·
   *  MOTIR-10843). Omitted → the field is absent, as an older motir-ai serves it. */
  reviewAgentDefault?: string | null;
  designRunDefault?: string | null;
}

export interface HostedRunUsageFixture {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  credits: number;
  machineCredits?: number;
  machineSeconds?: number;
  totalCredits?: number;
}

/** What the spec tells this seam to answer. Re-read on every request. */
export interface HostedRunFixture {
  models?: HostedRunModelsFixture;
  /** `'unanswerable'` drives the "could not ask" path (a 503, never `mayRun`). */
  mayRun?: boolean | 'unanswerable';
  /** `owner/name` → the `GET .../installation` status override. Default 200. */
  installation?: Record<string, number>;
  /** The run's usage/cost totals `getAgentRunUsage` answers. Omitted → a fixed,
   *  always-present default (never the legitimate-but-untestable 404 "no usage
   *  yet" — the happy path always has a cost block to read). */
  usage?: HostedRunUsageFixture;
  /** motir-ai is down for the MODEL reads and writes (story MOTIR-10838 ·
   *  MOTIR-10849): the offer, the run-model defaults and the org tier read answer
   *  503, so every surface that reads them shows its unavailable face. The credit,
   *  usage and machine-time calls are untouched. */
  unavailable?: boolean;
  /** Who last wrote each run-side default through `PUT /v1/admin/run-model-defaults`,
   *  and when — written by that PUT. The VALUES live in `models` (the four levels in
   *  `defaultsByDifficulty`, `reviewAgentDefault`, `designRunDefault`), so the offer
   *  a run resolves from and the console row can never disagree. */
  runModelDefaultsChanged?: Partial<
    Record<RunModelDefaultFixtureKey, { updatedAt: string; updatedByCoreUserId: string | null }>
  >;
}

/** The six run-side default keys, in motir-ai's order. */
const RUN_MODEL_DEFAULT_KEYS = ['trivial', 'low', 'medium', 'high', 'review', 'design'] as const;
type RunModelDefaultFixtureKey = (typeof RUN_MODEL_DEFAULT_KEYS)[number];
type Level = 'trivial' | 'low' | 'medium' | 'high';

/** A run-side default's stored value, read from the offer it lives in. */
function runDefaultOf(
  models: HostedRunModelsFixture | undefined,
  key: RunModelDefaultFixtureKey,
): string | null {
  if (key === 'review') return models?.reviewAgentDefault ?? null;
  if (key === 'design') return models?.designRunDefault ?? null;
  return models?.defaultsByDifficulty?.[key] ?? null;
}

const UNSET_AT = '1970-01-01T00:00:00.000Z';

/** The `unavailable` switch's answer: motir-ai's 503 problem, status included, so
 *  the client reads it as an outage rather than a refusal. */
const UNAVAILABLE = (): MockReply => ({
  statusCode: 503,
  data: {
    type: 'about:blank',
    code: 'upstream_unavailable',
    title: 'upstream_unavailable',
    status: 503,
    detail: 'motir-ai is down',
  },
  responseOptions: { headers: { 'content-type': 'application/problem+json' } },
});

const DEFAULT_USAGE: Required<HostedRunUsageFixture> = {
  inputTokens: 18_400,
  outputTokens: 5_120,
  cacheReadTokens: 2_048,
  cacheWriteTokens: 512,
  credits: 14,
  machineCredits: 3,
  machineSeconds: 240,
  totalCredits: 17,
};

function fixturePath(): string | null {
  const raw = process.env['MOTIR_HOSTED_RUN_FIXTURE_PATH'];
  return raw !== undefined && raw !== '' ? raw : null;
}

function writeFixture(fixture: HostedRunFixture): void {
  const path = fixturePath();
  if (path) writeFixtureFileSync(path, JSON.stringify(fixture));
}

function readFixture(): HostedRunFixture {
  const path = fixturePath();
  if (!path) return {};
  try {
    return JSON.parse(readFixtureFileSync(path)) as HostedRunFixture;
  } catch {
    // No file yet, or a half-written one — the same "declared nothing yet"
    // reading every sibling fixture gives a torn read.
    return {};
  }
}

/** One outbound call this seam answered — the journal's line shape (JSONL). */
export type HostedRunJournalEntry =
  | { type: 'gateway_mint'; runRef: string; coreOrganizationId: string; models: string[] }
  | { type: 'gateway_revoke'; runRef: string }
  | {
      type: 'machine_debit';
      coreRunId: string;
      credits: number;
      billableSeconds: number;
      externalRef: string;
    }
  | { type: 'github_installation'; repository: string };

function journal(entry: HostedRunJournalEntry): void {
  const path = process.env['MOTIR_HOSTED_RUN_JOURNAL_PATH'];
  if (!path) return;
  try {
    appendFixtureFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch {
    /* the journal is evidence, not behaviour — never fail a request over it */
  }
}

interface MockReply {
  statusCode: number;
  data: object | string;
  responseOptions: { headers: Record<string, string> };
}
interface MockRequest {
  path: string;
  method: string;
  body?: unknown;
}

const reply = (statusCode: number, data: object | string): MockReply => ({
  statusCode,
  data,
  responseOptions: { headers: { 'content-type': 'application/json' } },
});

function parseBody(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'string' || body.length === 0) return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True only when both this seam's flag AND the E2E production harness are set
 *  (mirrors `codeGraphMockEnabled()` — the E2E-only gate every sibling uses). */
export function hostedRunMockEnabled(): boolean {
  return process.env['E2E_TEST_HOSTED_RUN'] === '1' && process.env['E2E_PROD_HARNESS'] === '1';
}

export function installHostedRunMock(agent: MockAgent): void {
  if (!hostedRunMockEnabled()) return;

  // ── The gateway: mint + revoke the run's model key ──────────────────────
  const gatewayUrl = process.env['MOTIR_GATEWAY_URL'];
  if (gatewayUrl) {
    const pool = agent.get(new URL(gatewayUrl).origin);
    pool
      .intercept({ path: '/api/motir/run-keys', method: 'POST' })
      .reply((req: MockRequest): MockReply => {
        const body = parseBody(req.body) ?? {};
        const runRef = typeof body['runRef'] === 'string' ? body['runRef'] : '';
        const coreOrganizationId =
          typeof body['coreOrganizationId'] === 'string' ? body['coreOrganizationId'] : '';
        const models = Array.isArray(body['models']) ? (body['models'] as string[]) : [];
        journal({ type: 'gateway_mint', runRef, coreOrganizationId, models });
        return reply(201, {
          key: 'sk-e2e-run-key-secret',
          runRef,
          coreOrganizationId,
          expiresAt: body['expiresAt'],
          lane: 'agent',
        });
      })
      .persist();
    pool
      .intercept({ path: (p) => p.startsWith('/api/motir/run-keys/'), method: 'DELETE' })
      .reply((req: MockRequest): MockReply => {
        const runRef = decodeURIComponent(req.path.split('/').pop() ?? '');
        journal({ type: 'gateway_revoke', runRef });
        return reply(200, { runRef, revoked: 1 });
      })
      .persist();
  }

  // ── motir-ai: the offered models, the credit pre-flight and the run's usage ─
  const aiUrl = process.env['MOTIR_AI_URL'];
  if (aiUrl) {
    const pool = agent.get(new URL(aiUrl).origin);
    pool
      .intercept({ path: '/v1/agent-models', method: 'GET' })
      .reply((): MockReply => {
        const fixture = readFixture();
        if (fixture.unavailable) return UNAVAILABLE();
        const fx = fixture.models;
        const status = fx?.status ?? 200;
        if (status !== 200) return reply(status, { code: 'internal_error' });
        const ids = fx?.ids ?? [DEFAULT_MODEL_ID];
        const defaultId = fx?.default !== undefined ? fx.default : (ids[0] ?? null);
        return reply(200, {
          models: ids.map((id) => ({ id, provider: fx?.providers?.[id] ?? 'anthropic' })),
          default: defaultId,
          ...(fx?.defaultsByDifficulty !== undefined
            ? { defaultsByDifficulty: fx.defaultsByDifficulty }
            : {}),
          ...(fx?.reviewAgentDefault !== undefined
            ? { reviewAgentDefault: fx.reviewAgentDefault }
            : {}),
          ...(fx?.designRunDefault !== undefined ? { designRunDefault: fx.designRunDefault } : {}),
        });
      })
      .persist();
    // The console's run-side defaults read (MOTIR-10844) and write (MOTIR-10849),
    // from the same fixture: the four levels ARE the offer's per-difficulty
    // defaults, review and design ARE `reviewAgentDefault` / `designRunDefault`, so
    // a console save is what the next run resolves from. The run-model list's
    // remove reads it, so a spec that removes run models stays green.
    const runDefaultsRow = (fixture: HostedRunFixture, key: RunModelDefaultFixtureKey) => {
      const ids = fixture.models?.ids ?? [DEFAULT_MODEL_ID];
      const model = runDefaultOf(fixture.models, key);
      const changed = fixture.runModelDefaultsChanged?.[key];
      return {
        key,
        model,
        offered: model === null ? null : ids.includes(model),
        effectiveModel: model !== null && ids.includes(model) ? model : null,
        updatedAt: changed?.updatedAt ?? UNSET_AT,
        updatedByCoreUserId: changed?.updatedByCoreUserId ?? null,
      };
    };
    pool
      .intercept({ path: '/v1/admin/run-model-defaults', method: 'GET' })
      .reply((): MockReply => {
        const fixture = readFixture();
        if (fixture.unavailable) return UNAVAILABLE();
        const fx = fixture.models;
        const status = fx?.status ?? 200;
        if (status !== 200) return reply(status, { code: 'internal_error' });
        const ids = fx?.ids ?? [DEFAULT_MODEL_ID];
        return reply(200, {
          settings: RUN_MODEL_DEFAULT_KEYS.map((key) => runDefaultsRow(fixture, key)),
          models: ids.map((id) => ({ id, provider: fx?.providers?.[id] ?? 'anthropic' })),
        });
      })
      .persist();
    pool
      .intercept({ path: '/v1/admin/run-model-defaults', method: 'PUT' })
      .reply((req: MockRequest): MockReply => {
        const fixture = readFixture();
        if (fixture.unavailable) return UNAVAILABLE();
        const body = parseBody(req.body) ?? {};
        const key = body['key'] as RunModelDefaultFixtureKey;
        const model = body['model'];
        const actor = typeof body['actorCoreUserId'] === 'string' ? body['actorCoreUserId'] : null;
        const problem = (detail: string) =>
          reply(400, {
            type: 'about:blank',
            code: 'validation_error',
            title: 'validation_error',
            status: 400,
            detail,
          });
        if (!RUN_MODEL_DEFAULT_KEYS.includes(key) || !actor) {
          return problem('expected { key, model, actorCoreUserId }');
        }
        if (model !== null && typeof model !== 'string')
          return problem('model must be a string or null');
        const ids = fixture.models?.ids ?? [DEFAULT_MODEL_ID];
        const allowed = Array.isArray(body['allowedModels'])
          ? (body['allowedModels'] as string[])
          : null;
        if (model !== null && (!ids.includes(model) || (allowed && !allowed.includes(model)))) {
          return problem(`model "${model}" is not offered for hosted runs`);
        }
        const before = runDefaultOf(fixture.models, key);
        if (before === model) {
          return reply(200, { setting: runDefaultsRow(fixture, key), audit: null });
        }
        const models: HostedRunModelsFixture = { ...(fixture.models ?? {}) };
        if (key === 'review') models.reviewAgentDefault = model;
        else if (key === 'design') models.designRunDefault = model;
        else
          models.defaultsByDifficulty = { ...models.defaultsByDifficulty, [key as Level]: model };
        const at = new Date().toISOString();
        const next: HostedRunFixture = {
          ...fixture,
          models,
          runModelDefaultsChanged: {
            ...fixture.runModelDefaultsChanged,
            [key]: { updatedAt: at, updatedByCoreUserId: actor },
          },
        };
        writeFixture(next);
        return reply(200, {
          setting: runDefaultsRow(next, key),
          audit: {
            action: 'ai.run_model_default.set',
            actorCoreUserId: actor,
            at,
            key,
            before: { model: before },
            after: { model },
          },
        });
      })
      .persist();
    // motir-core's org TIER read (`POST /v1/admin/orgs/tiers`), from the tier fixture the
    // planner-model seam's org override read also answers from — so the room and
    // the run-side resolver cannot disagree (`lib/test-org-tier-fixture.ts`). No
    // earlier seam claims this path.
    pool
      .intercept({ path: '/v1/admin/orgs/tiers', method: 'POST' })
      .reply((req: MockRequest): MockReply => {
        if (readFixture().unavailable) return UNAVAILABLE();
        const body = parseBody(req.body) ?? {};
        const ids = Array.isArray(body['coreOrganizationIds'])
          ? (body['coreOrganizationIds'] as unknown[]).filter(
              (v): v is string => typeof v === 'string',
            )
          : [];
        return reply(200, {
          orgs: ids.map((coreOrganizationId) => ({
            coreOrganizationId,
            tierKey: orgTierOf(coreOrganizationId),
          })),
        });
      })
      .persist();
    pool
      .intercept({ path: '/v1/credits/agent-run-check', method: 'POST' })
      .reply((req: MockRequest): MockReply => {
        const mayRun = readFixture().mayRun ?? true;
        if (mayRun === 'unanswerable') return reply(503, { code: 'internal_error' });
        const body = parseBody(req.body) ?? {};
        return reply(200, {
          coreOrganizationId: body['coreOrganizationId'],
          balanceCredits: mayRun ? 250 : 0,
          hasCredits: mayRun,
          mayRun,
        });
      })
      .persist();
    pool
      .intercept({ path: (p) => /^\/v1\/agent-runs\/[^/]+\/usage$/.test(p), method: 'GET' })
      .reply((): MockReply => {
        const usage = { ...DEFAULT_USAGE, ...readFixture().usage };
        return reply(200, usage);
      })
      .persist();
    pool
      .intercept({ path: '/v1/credits/agent-machine', method: 'POST' })
      .reply((req: MockRequest): MockReply => {
        const body = parseBody(req.body) ?? {};
        const coreRunId = typeof body['coreRunId'] === 'string' ? body['coreRunId'] : '';
        const credits = typeof body['credits'] === 'number' ? body['credits'] : 0;
        const billableSeconds =
          typeof body['billableSeconds'] === 'number' ? body['billableSeconds'] : 0;
        const externalRef = typeof body['externalRef'] === 'string' ? body['externalRef'] : '';
        journal({ type: 'machine_debit', coreRunId, credits, billableSeconds, externalRef });
        // An agent INSTANCE's machine time also lands on the billing fixture's
        // ledger, so the Agents line reads what was charged (MOTIR-6924).
        if (typeof body['instanceIntervalId'] === 'string') {
          recordAgentDebit(
            String(body['coreOrganizationId'] ?? ''),
            'machine',
            credits,
            externalRef,
          );
        }
        return reply(200, { idempotent: false });
      })
      .persist();
  }

  // ── GitHub: the repo-level installation read `repositoriesForItems` makes ──
  // before it will call a repository writable. Narrow (a specific 3-segment
  // path GitHub itself defines), so it never shadows `test-github-repos-mock`'s
  // or `test-github-merge-mock`'s own broader `/repos/{owner}/{name}` intercepts
  // — those match exactly 2 segments and never this one.
  const pool = agent.get(GITHUB_ORIGIN);
  pool
    .intercept({ path: (p) => /^\/repos\/[^/]+\/[^/]+\/installation$/.test(p), method: 'GET' })
    .reply((req: MockRequest): MockReply => {
      const m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(req.path);
      const repository = m?.[1] ?? '';
      const status = readFixture().installation?.[repository] ?? 200;
      journal({ type: 'github_installation', repository });
      if (status !== 200) return reply(status, {});
      const owner = repository.split('/')[0];
      return reply(200, {
        id: 42,
        account: { login: owner },
        permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
        suspended_at: null,
        html_url: `https://github.com/organizations/${owner}/settings/installations/42`,
      });
    })
    .persist();
}
