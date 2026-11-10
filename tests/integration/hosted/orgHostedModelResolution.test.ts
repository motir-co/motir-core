import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { orgHostedModelResolutionService } from '@/lib/services/orgHostedModelResolutionService';
import { projectHostedAgentSettingsService as service } from '@/lib/services/projectHostedAgentSettingsService';
import { hostedRunPickerService } from '@/lib/services/hostedRunPickerService';
import { __resetAgentRunCapacityForTests } from '@/lib/services/agentRunCapacityService';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE ORGANISATION LAYER OF HOSTED-MODEL RESOLUTION, over the real Postgres (story
// MOTIR-10838 · MOTIR-10843). motir-ai is the one HTTP seam and serves TWO routes
// here: `/v1/agent-models` (the offer, with the platform review and design-run
// models) and `/v1/admin/orgs/tiers` (the org's tier). Pinned:
//   - the meta org qualifies without asking motir-ai for its tier;
//   - Standard does not qualify, Pro does; a tier motir-ai could not answer reads
//     as not qualifying (the run falls to the platform, never refused);
//   - an org that stored nothing never asks for its tier at all;
//   - a design leaf, and a parent whose every unfinished leaf is a design card,
//     resolve from the design branch; a mixed parent does not;
//   - the picker read and the project room carry the new sources, the design flag
//     and `inheritedFrom`.

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const FABLE = 'claude-fable-5-1';
const GLM = 'glm-5';

const OFFER = {
  models: [
    { id: OPUS, provider: 'anthropic' },
    { id: SONNET, provider: 'anthropic' },
    { id: FABLE, provider: 'anthropic' },
    { id: GLM, provider: 'zai' },
  ],
  default: OPUS,
  defaultsByDifficulty: { trivial: SONNET, low: SONNET, medium: OPUS, high: OPUS },
  reviewAgentDefault: SONNET,
  designRunDefault: SONNET,
};

let tierCalls = 0;
let tierAnswer: { status: number; tierKey: string | null } = { status: 200, tierKey: 'pro' };

function serve() {
  tierCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const reply = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url.endsWith('/v1/admin/orgs/tiers')) {
        tierCalls += 1;
        const { coreOrganizationIds } = JSON.parse(String(init?.body)) as {
          coreOrganizationIds: string[];
        };
        return reply(
          {
            orgs: coreOrganizationIds.map((id) => ({
              coreOrganizationId: id,
              tierKey: tierAnswer.tierKey,
            })),
          },
          tierAnswer.status,
        );
      }
      return reply(OFFER);
    }),
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  __resetAgentRunCapacityForTests();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test/');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  tierAnswer = { status: 200, tierKey: 'pro' };
  serve();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctxFor = (fx: WorkItemFixture) => ({ userId: fx.ownerId, workspaceId: fx.workspaceId });

async function setOrg(
  fx: WorkItemFixture,
  data: {
    isMeta?: boolean;
    hostedModelHigh?: string | null;
    hostedModelLow?: string | null;
    hostedReviewModel?: string | null;
    hostedDesignModel?: string | null;
  },
) {
  await adminDb.organization.update({ where: { id: fx.workspace.organizationId }, data });
}

async function leaf(
  fx: WorkItemFixture,
  difficulty: 'low' | 'high',
  type: 'design' | 'code',
  parentId?: string,
) {
  const item = await createTestWorkItem(fx, {
    kind: parentId ? 'subtask' : 'task',
    title: `${type} ${difficulty}`,
    type,
    parentId: parentId ?? null,
  });
  await adminDb.workItem.update({ where: { id: item.id }, data: { difficulty } });
  return item;
}

describe('orgHostedModelResolutionService.readOrgLayer', () => {
  it('an org that stored nothing has no layer and never asks for its tier', async () => {
    const fx = await makeWorkItemFixture();
    expect(await orgHostedModelResolutionService.readOrgLayer(ctxFor(fx))).toEqual({
      organizationId: fx.workspace.organizationId,
      qualifies: false,
      layer: null,
    });
    expect(tierCalls).toBe(0);
  });

  it('the meta org qualifies without a tier read', async () => {
    const fx = await makeWorkItemFixture();
    await setOrg(fx, { isMeta: true, hostedModelHigh: FABLE, hostedReviewModel: GLM });
    tierAnswer = { status: 200, tierKey: 'free' };
    const read = await orgHostedModelResolutionService.readOrgLayer(ctxFor(fx));
    expect(read.qualifies).toBe(true);
    expect(read.layer).toEqual({
      levels: { trivial: null, low: null, medium: null, high: FABLE },
      review: GLM,
      design: null,
    });
    expect(tierCalls).toBe(0);
  });

  it('Pro qualifies; Standard, no tier and an unanswered tier read do not — the values are kept', async () => {
    const fx = await makeWorkItemFixture();
    await setOrg(fx, { hostedModelHigh: FABLE });
    const cases: [typeof tierAnswer, boolean][] = [
      [{ status: 200, tierKey: 'pro' }, true],
      [{ status: 200, tierKey: 'standard' }, false],
      [{ status: 200, tierKey: null }, false],
      [{ status: 503, tierKey: 'pro' }, false],
    ];
    for (const [answer, qualifies] of cases) {
      tierAnswer = answer;
      const read = await orgHostedModelResolutionService.readOrgLayer(ctxFor(fx));
      expect(read.qualifies).toBe(qualifies);
      expect(read.layer === null).toBe(!qualifies);
    }
    const row = await adminDb.organization.findUniqueOrThrow({
      where: { id: fx.workspace.organizationId },
    });
    expect(row.hostedModelHigh).toBe(FABLE);
  });
});

describe('resolveForWorkItem with the org layer', () => {
  it("a High leaf takes the Pro org's High default; a Standard org falls to the platform", async () => {
    const fx = await makeWorkItemFixture();
    await setOrg(fx, { hostedModelHigh: FABLE });
    const item = await leaf(fx, 'high', 'code');
    expect(await service.resolveForWorkItem(item.id, ctxFor(fx))).toEqual({
      model: FABLE,
      source: 'org_level',
      difficulty: 'high',
      fromLeaves: false,
      design: false,
    });
    tierAnswer = { status: 200, tierKey: 'standard' };
    expect(await service.resolveForWorkItem(item.id, ctxFor(fx))).toMatchObject({
      model: OPUS,
      source: 'platform_level',
    });
  });

  it("the project's override still beats the org default", async () => {
    const fx = await makeWorkItemFixture();
    await setOrg(fx, { hostedModelHigh: FABLE });
    await service.update(fx.projectIdentifier, { high: GLM }, ctxFor(fx));
    const item = await leaf(fx, 'high', 'code');
    expect(await service.resolveForWorkItem(item.id, ctxFor(fx))).toMatchObject({
      model: GLM,
      source: 'override',
    });
  });

  it('a design leaf runs on the org design-run model, ahead of the project override', async () => {
    const fx = await makeWorkItemFixture();
    await setOrg(fx, { hostedDesignModel: FABLE });
    await service.update(fx.projectIdentifier, { low: GLM }, ctxFor(fx));
    const item = await leaf(fx, 'low', 'design');
    expect(await service.resolveForWorkItem(item.id, ctxFor(fx))).toEqual({
      model: FABLE,
      source: 'org_design',
      difficulty: 'low',
      fromLeaves: false,
      design: true,
    });
    // Not qualifying: the PLATFORM design-run model, still ahead of the override.
    tierAnswer = { status: 200, tierKey: 'free' };
    expect(await service.resolveForWorkItem(item.id, ctxFor(fx))).toMatchObject({
      model: SONNET,
      source: 'platform_design',
      design: true,
    });
  });

  it('a parent is a design run only when every unfinished leaf is a design card', async () => {
    const fx = await makeWorkItemFixture();
    await setOrg(fx, { hostedDesignModel: FABLE, hostedModelHigh: GLM });
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story' });
    await leaf(fx, 'low', 'design', story.id);
    await leaf(fx, 'high', 'design', story.id);
    expect(await service.resolveForWorkItem(story.id, ctxFor(fx))).toMatchObject({
      model: FABLE,
      source: 'org_design',
      fromLeaves: true,
      design: true,
    });
    await leaf(fx, 'low', 'code', story.id);
    expect(await service.resolveForWorkItem(story.id, ctxFor(fx))).toMatchObject({
      model: GLM,
      source: 'org_level',
      difficulty: 'high',
      design: false,
    });
    // A FINISHED code leaf does not break the design run.
    await adminDb.workItem.updateMany({
      where: { parentId: story.id, type: 'code' },
      data: { status: 'done' },
    });
    expect(await service.resolveForWorkItem(story.id, ctxFor(fx))).toMatchObject({
      source: 'org_design',
      design: true,
    });
  });
});

describe('the picker read and the project room', () => {
  it('the picker carries the org source and the design flag', async () => {
    const fx = await makeWorkItemFixture();
    await setOrg(fx, { hostedDesignModel: FABLE });
    const item = await leaf(fx, 'high', 'design');
    expect(await hostedRunPickerService.readModels(item.identifier, ctxFor(fx))).toMatchObject({
      state: 'ok',
      resolved: { model: FABLE, source: 'org_design', design: true },
    });
  });

  it('the project room reads a level the org set as inherited from the organisation', async () => {
    const fx = await makeWorkItemFixture();
    await setOrg(fx, { hostedModelHigh: FABLE, hostedModelLow: 'withdrawn-model' });
    const dto = await service.get(fx.projectIdentifier, ctxFor(fx));
    const level = (l: string) => dto.levels.find((x) => x.level === l)!;
    expect(level('high')).toMatchObject({
      platformDefault: FABLE,
      inheritedFrom: 'organization',
      effective: FABLE,
      source: 'org_level',
    });
    // A withdrawn org value is skipped: the platform level shows through.
    expect(level('low')).toMatchObject({
      platformDefault: SONNET,
      inheritedFrom: 'platform',
      source: 'platform_level',
    });
    expect(level('medium')).toMatchObject({ inheritedFrom: 'platform' });
  });
});
