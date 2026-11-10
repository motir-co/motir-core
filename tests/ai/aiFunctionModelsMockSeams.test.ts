import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import {
  fetchOrgTiers,
  getAgentModels,
  getOrgPlannerModelOverrides,
  getPlannerModelSettings,
  getRunModelDefaults,
  setOrgPlannerModelOverride,
  setPlannerFunctionModel,
  setRunModelDefault,
} from '@/lib/ai/motirAiClient';
import {
  MotirAiUnavailableError,
  OrgModelChoiceNotQualifiedError,
  PlannerModelNotOfferedError,
  PlannerModelUnreachableError,
  RunModelDefaultNotOfferedError,
} from '@/lib/ai/errors';
import {
  installPlannerModelBoundaryMock,
  type PlannerModelFixture,
} from '@/lib/test-planner-model-mock';
import { installHostedRunMock, type HostedRunFixture } from '@/lib/test-hosted-run-mock';
import { tierQualifies, type OrgTierFixture } from '@/lib/test-org-tier-fixture';

// The E2E seams' PER-FUNCTION model routes (Story MOTIR-10838 · MOTIR-10849),
// driven through the REAL motir-ai client: the planner-model seam's Guide / Debug /
// Ask defaults and one org's overrides, and the hosted-run seam's run-model-defaults
// write, its unavailable switch and the org tier read. A drift between a seam and
// the client's parsers or error mapping fails here rather than in a browser.

const dir = mkdtempSync(path.join(tmpdir(), 'ai-function-models-seams-'));
const plannerPath = path.join(dir, 'planner.json');
const hostedPath = path.join(dir, 'hosted.json');
const tierPath = path.join(dir, 'tiers.json');
let previous: Dispatcher;

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const GLM = 'glm-5.2';
const PRO_ORG = 'org_pro';
const STANDARD_ORG = 'org_standard';

const PLANNER: PlannerModelFixture = {
  settings: (['customer', 'meta', 'internal'] as const).map((audience) => ({
    audience,
    model: OPUS,
  })),
  offered: [
    { id: OPUS, provider: 'anthropic' },
    { id: SONNET, provider: 'anthropic' },
    { id: GLM, provider: 'z-ai' },
  ],
  unreachable: { [GLM]: 'the gateway did not answer' },
};

const HOSTED: HostedRunFixture = {
  models: {
    ids: [OPUS, SONNET],
    default: OPUS,
    defaultsByDifficulty: { trivial: SONNET, low: SONNET, medium: OPUS, high: OPUS },
  },
};

const write = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v));
const read = <T>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T;

beforeAll(() => {
  process.env['MOTIR_AI_URL'] = 'https://ai.mock.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  process.env['MOTIR_AI_PLANNER_MODEL_FIXTURE_PATH'] = plannerPath;
  process.env['MOTIR_HOSTED_RUN_FIXTURE_PATH'] = hostedPath;
  process.env['MOTIR_AI_ORG_TIER_FIXTURE_PATH'] = tierPath;
  process.env['E2E_TEST_HOSTED_RUN'] = '1';
  process.env['E2E_PROD_HARNESS'] = '1';
  previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  installPlannerModelBoundaryMock(agent);
  installHostedRunMock(agent);
  setGlobalDispatcher(agent);
});

afterAll(() => {
  setGlobalDispatcher(previous);
  for (const key of [
    'MOTIR_AI_PLANNER_MODEL_FIXTURE_PATH',
    'MOTIR_HOSTED_RUN_FIXTURE_PATH',
    'MOTIR_AI_ORG_TIER_FIXTURE_PATH',
    'E2E_TEST_HOSTED_RUN',
    'E2E_PROD_HARNESS',
  ]) {
    delete process.env[key];
  }
});

beforeEach(() => {
  write(plannerPath, structuredClone(PLANNER));
  write(hostedPath, structuredClone(HOSTED));
  write(tierPath, {
    tiers: { [PRO_ORG]: 'pro', [STANDARD_ORG]: 'standard' },
  } satisfies OrgTierFixture);
});

describe('the planner-model seam: the platform Guide, Debug and Ask defaults', () => {
  it('reads all three as following the audience, then stores a write with its actor', async () => {
    const before = await getPlannerModelSettings();
    expect(before.functions).toEqual(
      ['guide', 'debug', 'ask'].map((fn) => ({
        function: fn,
        model: null,
        offered: null,
        updatedAt: null,
        updatedByCoreUserId: null,
      })),
    );

    const written = await setPlannerFunctionModel({
      function: 'debug',
      model: SONNET,
      actorCoreUserId: 'u_staff',
    });
    expect(written).toMatchObject({ function: 'debug', previousModel: null, model: SONNET });
    expect(read<PlannerModelFixture>(plannerPath).functions?.debug).toMatchObject({
      model: SONNET,
      updatedByCoreUserId: 'u_staff',
    });
    const after = await getPlannerModelSettings();
    expect(after.functions?.find((f) => f.function === 'debug')).toMatchObject({
      model: SONNET,
      offered: true,
      updatedByCoreUserId: 'u_staff',
    });

    const cleared = await setPlannerFunctionModel({
      function: 'debug',
      model: null,
      actorCoreUserId: 'u_staff',
    });
    expect(cleared).toMatchObject({ previousModel: SONNET, model: null });
    expect(read<PlannerModelFixture>(plannerPath).functions?.debug).toBeUndefined();
  });

  it('refuses a model not offered and one whose probe fails, writing nothing', async () => {
    await expect(
      setPlannerFunctionModel({ function: 'guide', model: 'qwen-4', actorCoreUserId: 'u' }),
    ).rejects.toBeInstanceOf(PlannerModelNotOfferedError);
    await expect(
      setPlannerFunctionModel({ function: 'guide', model: GLM, actorCoreUserId: 'u' }),
    ).rejects.toMatchObject({
      constructor: PlannerModelUnreachableError,
      reason: 'the gateway did not answer',
    });
    expect(read<PlannerModelFixture>(plannerPath).functions).toBeUndefined();
  });

  it('a stored default withdrawn from the planning list reads offered false', async () => {
    write(plannerPath, {
      ...structuredClone(PLANNER),
      functions: { ask: { model: SONNET } },
      list: [{ model: OPUS }],
    } satisfies PlannerModelFixture);
    const { functions } = await getPlannerModelSettings();
    expect(functions?.find((f) => f.function === 'ask')).toMatchObject({
      model: SONNET,
      offered: false,
    });
  });
});

describe('the planner-model seam: one organisation’s overrides', () => {
  it('a Pro org qualifies, writes an override with its actor, and it applies', async () => {
    const before = await getOrgPlannerModelOverrides(PRO_ORG);
    expect(before).toMatchObject({ known: true, qualifies: true });
    expect(before.overrides.map((o) => o.function)).toEqual(['planning', 'guide', 'debug', 'ask']);
    expect(before.effective.find((e) => e.function === 'guide')).toEqual({
      function: 'guide',
      model: OPUS,
      source: 'audience',
    });

    const written = await setOrgPlannerModelOverride(PRO_ORG, {
      function: 'guide',
      model: SONNET,
      actorCoreUserId: 'u_owner',
    });
    expect(written).toMatchObject({ function: 'guide', previousModel: null, model: SONNET });
    expect(read<PlannerModelFixture>(plannerPath).orgOverrides?.[PRO_ORG]?.guide).toMatchObject({
      model: SONNET,
      updatedByCoreUserId: 'u_owner',
    });
    const after = await getOrgPlannerModelOverrides(PRO_ORG);
    expect(after.overrides.find((o) => o.function === 'guide')).toMatchObject({
      model: SONNET,
      offered: true,
      applies: true,
      updatedByCoreUserId: 'u_owner',
    });
    expect(after.effective.find((e) => e.function === 'guide')).toEqual({
      function: 'guide',
      model: SONNET,
      source: 'org',
    });
  });

  it('a platform function default is what an org without an override inherits', async () => {
    write(plannerPath, {
      ...structuredClone(PLANNER),
      functions: { debug: { model: SONNET } },
    } satisfies PlannerModelFixture);
    const { effective } = await getOrgPlannerModelOverrides(PRO_ORG);
    expect(effective.find((e) => e.function === 'debug')).toEqual({
      function: 'debug',
      model: SONNET,
      source: 'function_default',
    });
  });

  it('a Standard org reads its kept choice as not applying and is refused a write', async () => {
    write(plannerPath, {
      ...structuredClone(PLANNER),
      orgOverrides: { [STANDARD_ORG]: { guide: { model: SONNET } } },
    } satisfies PlannerModelFixture);
    const read1 = await getOrgPlannerModelOverrides(STANDARD_ORG);
    expect(read1.qualifies).toBe(false);
    expect(read1.overrides.find((o) => o.function === 'guide')).toMatchObject({
      model: SONNET,
      applies: false,
    });
    expect(read1.effective.find((e) => e.function === 'guide')?.source).toBe('audience');
    await expect(
      setOrgPlannerModelOverride(STANDARD_ORG, {
        function: 'guide',
        model: OPUS,
        actorCoreUserId: 'u',
      }),
    ).rejects.toBeInstanceOf(OrgModelChoiceNotQualifiedError);
    expect(read<PlannerModelFixture>(plannerPath).orgOverrides?.[STANDARD_ORG]?.guide?.model).toBe(
      SONNET,
    );
  });

  it('a stored override withdrawn from the list stops applying; an unseen org has no tier', async () => {
    write(plannerPath, {
      ...structuredClone(PLANNER),
      list: [{ model: OPUS }],
      orgOverrides: { [PRO_ORG]: { guide: { model: SONNET } } },
    } satisfies PlannerModelFixture);
    const { overrides } = await getOrgPlannerModelOverrides(PRO_ORG);
    expect(overrides.find((o) => o.function === 'guide')).toMatchObject({
      offered: false,
      applies: false,
    });
    expect((await getOrgPlannerModelOverrides('org_unseen')).qualifies).toBe(false);
    expect(tierQualifies(null)).toBe(false);
    expect(tierQualifies('')).toBe(false);
    expect(tierQualifies('max')).toBe(true);
  });

  it('unavailable answers 503 to both reads and writes', async () => {
    write(plannerPath, { ...structuredClone(PLANNER), unavailable: true });
    await expect(getOrgPlannerModelOverrides(PRO_ORG)).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
    await expect(
      setOrgPlannerModelOverride(PRO_ORG, { function: 'ask', model: OPUS, actorCoreUserId: 'u' }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
    await expect(
      setPlannerFunctionModel({ function: 'ask', model: OPUS, actorCoreUserId: 'u' }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

describe('the hosted-run seam: run-model defaults, the tier read and unavailable', () => {
  it('a default write lands in the offer a run resolves from, audited from → to', async () => {
    const written = await setRunModelDefault({
      key: 'review',
      model: SONNET,
      actorCoreUserId: 'u_staff',
      allowedModels: [OPUS, SONNET],
    });
    expect(written.setting).toMatchObject({ key: 'review', model: SONNET, offered: true });
    expect(written.audit).toMatchObject({
      action: 'ai.run_model_default.set',
      actorCoreUserId: 'u_staff',
      key: 'review',
      before: { model: null },
      after: { model: SONNET },
    });
    expect(await getAgentModels()).toMatchObject({ reviewAgentDefault: SONNET });

    await setRunModelDefault({ key: 'high', model: SONNET, actorCoreUserId: 'u_staff' });
    await setRunModelDefault({ key: 'design', model: OPUS, actorCoreUserId: 'u_staff' });
    const stored = read<HostedRunFixture>(hostedPath);
    expect(stored.models?.defaultsByDifficulty?.high).toBe(SONNET);
    expect(stored.models?.designRunDefault).toBe(OPUS);
    const { settings } = await getRunModelDefaults();
    expect(settings.map((s) => [s.key, s.model, s.updatedByCoreUserId])).toEqual([
      ['trivial', SONNET, null],
      ['low', SONNET, null],
      ['medium', OPUS, null],
      ['high', SONNET, 'u_staff'],
      ['review', SONNET, 'u_staff'],
      ['design', OPUS, 'u_staff'],
    ]);
  });

  it('a no-op answers audit null; a model outside the offer or the list is refused', async () => {
    const same = await setRunModelDefault({ key: 'medium', model: OPUS, actorCoreUserId: 'u' });
    expect(same.audit).toBeNull();
    await expect(
      setRunModelDefault({ key: 'review', model: 'qwen-4', actorCoreUserId: 'u' }),
    ).rejects.toBeInstanceOf(RunModelDefaultNotOfferedError);
    await expect(
      setRunModelDefault({
        key: 'review',
        model: SONNET,
        actorCoreUserId: 'u',
        allowedModels: [OPUS],
      }),
    ).rejects.toBeInstanceOf(RunModelDefaultNotOfferedError);
    expect(read<HostedRunFixture>(hostedPath).models?.reviewAgentDefault).toBeUndefined();
  });

  it('the tier read answers from the shared tier fixture, null for an unnamed org', async () => {
    const tiers = await fetchOrgTiers([PRO_ORG, STANDARD_ORG, 'org_unseen']);
    expect(Object.fromEntries(tiers ?? [])).toEqual({
      [PRO_ORG]: 'pro',
      [STANDARD_ORG]: 'standard',
      org_unseen: null,
    });
    write(tierPath, { tiers: { [STANDARD_ORG]: 'pro' } });
    expect((await fetchOrgTiers([STANDARD_ORG]))?.get(STANDARD_ORG)).toBe('pro');
  });

  it('unavailable: the offer reads unavailable, the defaults throw, the write refuses, the tier read is null', async () => {
    write(hostedPath, { ...structuredClone(HOSTED), unavailable: true });
    await expect(getRunModelDefaults()).rejects.toBeInstanceOf(MotirAiUnavailableError);
    await expect(
      setRunModelDefault({ key: 'review', model: SONNET, actorCoreUserId: 'u' }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
    expect(await fetchOrgTiers([PRO_ORG])).toBeNull();
    // The offer degrades rather than throws: the picker's unavailable face.
    expect(await getAgentModels()).toMatchObject({ state: 'unavailable' });
  });
});
