import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
  streamJob: vi.fn(),
}));
vi.mock('@/lib/ai/tenantOrg', () => ({ resolveTenantOrg: vi.fn() }));
// The tenant languages (MOTIR-8741), mocked for the same reason as the org: a
// SYNTHETIC ProjectContext has no org or user rows behind it. The real reads are
// covered by `planSubmitLanguages.test.ts`.
vi.mock('@/lib/ai/tenantLanguages', () => ({
  resolveTenantLanguages: vi.fn(async () => ({ contentLanguage: 'ja', personLanguage: 'ko' })),
}));
// MOTIR-4604: the plan-edit submits now resolve the PLANNING code context — the
// grant list plus each repo's freshness verdict, reason and in-flight flag. These
// suites are about the ENVELOPE, so `undefined` (no connected repo) keeps every
// assertion below reading exactly as it did.
vi.mock('@/lib/ai/codeContext', () => ({
  resolveProjectCodeContext: vi.fn(),
  resolvePlanningCodeContext: vi.fn(async () => undefined),
}));
// The PROJECT's repository set (MOTIR-3044), mocked beside the workspace grant
// list for the same reason: these cases drive a SYNTHETIC ProjectContext with no
// rows behind it, so the real set read would 404 on the project id and prove
// nothing about the envelope they are here for. The real read is covered against
// Postgres in `tests/ai/projectRepoContext.test.ts`.
vi.mock('@/lib/ai/projectRepoContext', () => ({ resolveProjectRepoContext: vi.fn() }));
// The record-planning-mistakes resolver (MOTIR-3350), mocked for the same reason
// as the two above — it reads the project's settings row, and these cases drive a
// SYNTHETIC ProjectContext with nothing behind it. The real read is covered
// against Postgres in `tests/ai/lessonCapture.test.ts`; here the mock lets each
// case state the SETTING and assert what reaches the envelope.
vi.mock('@/lib/ai/lessonCapture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/lessonCapture')>()),
  resolveRecordPlanningMistakesForJob: vi.fn(),
}));
vi.mock('@/lib/services/plansService');
vi.mock('@/lib/repositories/workItemRepository');
// …and the project gate (MOTIR-2357). These cases drive a SYNTHETIC ProjectContext
// with no rows behind it, so the real `ai:plan` assert would 404 on the project id
// and prove nothing about the job envelope they are here for. The gate itself is
// covered against real Postgres in `tests/integration/ai/planPermissionGate.test.ts`;
// the mock is asserted below so it can never quietly hide the call.
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { assertPermission: vi.fn() },
}));

import { aiPlanEditsService, InvalidTargetError } from '@/lib/services/aiPlanEditsService';
import { submitJob, streamJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { resolvePlanningCodeContext } from '@/lib/ai/codeContext';
import { resolveProjectRepoContext } from '@/lib/ai/projectRepoContext';
import {
  RECORD_PLANNING_MISTAKES_CONTEXT_FIELD,
  resolveRecordPlanningMistakesForJob,
} from '@/lib/ai/lessonCapture';
import { plansService } from '@/lib/services/plansService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { ProjectContext } from '@/lib/projects';
import type { JobStreamEvent, JobContextBag } from '@/lib/ai/types';
import type { PlanDto } from '@/lib/dto/plans';
import type { WorkItem } from '@/generated/prisma/client';

const ctx = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  // `aiGenerateExplanations` is a non-null boolean column defaulting to false —
  // the OFF project, so the submits assert the flag is SENT as `false` rather
  // than omitted (MOTIR-2110).
  // `onboardingRanAt` is STATED rather than omitted: `onboardingContextFor` reads
  // `== null`, so leaving it off would make the `onboarding: true` assertions
  // below rest on an accidental `undefined` instead of on the marker's real
  // "this project has never had a plan approved" value (MOTIR-4736).
  project: {
    id: 'pj_1',
    identifier: 'MOTIR',
    name: 'Motir',
    aiGenerateExplanations: false,
    onboardingRanAt: null,
  },
} as ProjectContext;

/** The same actor on a project that has opted INTO AI-drafted explanations. */
const ctxWithExplanations = {
  ...ctx,
  project: { ...ctx.project, aiGenerateExplanations: true },
} as ProjectContext;

const mockOrg = { organizationId: 'org_1', isMeta: false, internalBilling: false };

function mockWorkItem(overrides: {
  id?: string;
  identifier?: string;
  kind?: string;
  status?: string;
  projectId?: string;
}) {
  return {
    id: overrides.id ?? 'wi_99',
    identifier: overrides.identifier ?? 'MOTIR-1',
    kind: overrides.kind ?? 'bug',
    status: overrides.status ?? 'todo',
    projectId: overrides.projectId ?? 'pj_1',
    title: 'Mocked',
    parentId: null as string | null,
    descriptionMd: null as string | null,
    explanationMd: null as string | null,
    explanationSource: null as string | null,
    priority: 'medium' as const,
    dueDate: null as string | null,
    estimateMinutes: null as number | null,
    storyPoints: null as number | null,
    type: null as string | null,
    executor: null as string | null,
    assigneeId: null as string | null,
    reporterId: null as string | null,
    deletedAt: null as Date | null,
    archivedAt: null as Date | null,
    fractionalIndex: '0000',
    sprintId: null as string | null,
    workflowStatusId: null as string | null,
    sprintRank: null as string | null,
    backlogRank: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as WorkItem;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveTenantOrg).mockResolvedValue(mockOrg);
  vi.mocked(resolvePlanningCodeContext).mockResolvedValue(undefined);
  vi.mocked(resolveProjectRepoContext).mockResolvedValue(undefined);
  // Default ON, which is what an untouched project resolves to (MOTIR-3349).
  vi.mocked(resolveRecordPlanningMistakesForJob).mockResolvedValue(true);
  vi.mocked(plansService.createPlan).mockResolvedValue({ id: 'plan_1' } as PlanDto);
});

function mockSubmitJob() {
  vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_1' });
}

describe('aiPlanEditsService.submitAugment', () => {
  it('submits an augment job with the prompt + tenant + code context', async () => {
    vi.mocked(resolvePlanningCodeContext).mockResolvedValue({
      repos: [
        {
          provider: 'github',
          repoRef: 'o/r',
          defaultBranch: 'main',
          indexed: true,
          // The freshness fields `JobCodeRepoState` requires. This fixture
          // predates them and typechecked only because `tsc --noEmit` does not
          // cover `tests/` — `pnpm typecheck` (the solution build) does.
          indexState: 'indexed',
          refreshInFlight: false,
          indexedAt: null,
          commitsBehind: null,
          indexedSha: null,
          defaultHead: null,
        },
      ],
    });
    mockSubmitJob();

    const out = await aiPlanEditsService.submitAugment('add a login flow', ctx);

    expect(out).toEqual({ jobId: 'job_1', planId: 'plan_1' });
    // The gate runs, and it asks for `ai:plan` on THIS project (MOTIR-2357).
    expect(projectAccessService.assertPermission).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ userId: expect.any(String) }),
      'ai:plan',
    );

    expect(submitJob).toHaveBeenCalledWith(
      'plan',
      {
        organizationId: 'org_1',
        isMeta: false,
        internalBilling: false,
        workspaceId: 'ws_1',
        projectId: 'pj_1',
        projectKey: 'MOTIR',
        contentLanguage: 'ja',
        personLanguage: 'ko',
      },
      expect.objectContaining({ prompt: 'add a login flow', code: expect.any(Object) }),
      { userId: 'user_1' },
    );
  });

  it('submits without code context when none', async () => {
    vi.mocked(resolvePlanningCodeContext).mockResolvedValue(undefined);
    mockSubmitJob();

    const out = await aiPlanEditsService.submitAugment('add a login flow', ctx);

    expect(out).toEqual({ jobId: 'job_1', planId: 'plan_1' });
    const contextArg = vi.mocked(submitJob).mock.calls[0]?.[2] as JobContextBag;
    expect(contextArg.code).toBeUndefined();
  });

  it('passes the META flag', async () => {
    vi.mocked(resolveTenantOrg).mockResolvedValue({
      organizationId: 'org_1',
      isMeta: true,
      internalBilling: false,
    });
    mockSubmitJob();

    await aiPlanEditsService.submitAugment('prompt', ctx);

    expect(submitJob).toHaveBeenCalledWith(
      'plan',
      expect.objectContaining({ isMeta: true }),
      expect.any(Object),
      expect.any(Object),
    );
  });
});

describe('aiPlanEditsService.submitExpand', () => {
  it('submits an expand_item job for a valid container', async () => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', kind: 'story' }),
    );
    mockSubmitJob();

    const out = await aiPlanEditsService.submitExpand('MOTIR-100', ctx);

    expect(out).toEqual({ jobId: 'job_1', planId: 'plan_1' });
    expect(submitJob).toHaveBeenCalledWith(
      'plan',
      expect.objectContaining({ projectKey: 'MOTIR' }),
      expect.objectContaining({ rootItemKey: 'MOTIR-100' }),
      { userId: 'user_1' },
    );
  });

  it('rejects a non-container (subtask)', async () => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-200', kind: 'subtask' }),
    );

    await expect(aiPlanEditsService.submitExpand('MOTIR-200', ctx)).rejects.toThrow(
      InvalidTargetError,
    );
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('rejects a missing item', async () => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(null);

    await expect(aiPlanEditsService.submitExpand('MOTIR-999', ctx)).rejects.toThrow(
      InvalidTargetError,
    );
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('rejects an item from another project', async () => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', kind: 'story', projectId: 'pj_other' }),
    );

    await expect(aiPlanEditsService.submitExpand('MOTIR-100', ctx)).rejects.toThrow(
      InvalidTargetError,
    );
    expect(submitJob).not.toHaveBeenCalled();
  });
});

// ─── The job's Plan (MOTIR-1743) ─────────────────────────────────────────────
// Every plan-edit submit must OPEN a `generating` Plan bound to the job via
// `sourceJobId` — motir-ai's augment / expand_item / replan handlers append their
// output through the 7.21 proposal store, and the core callback seam resolves the
// plan by that jobId. Without it every one of these jobs 404s on its FIRST
// `addProposals` callback. These assert the half the submit tests above never
// covered: the resulting Plan, not just that the job fired.
describe("aiPlanEditsService — opens the job's Plan on submit", () => {
  // `session` (MOTIR-6022; AMENDMENT 17 §4–§5): with no conversation behind the
  // submit, the plan gets a session of the door's own origin — an expand is
  // anchored at its root item.
  const CASES: Array<{
    name: string;
    run: () => Promise<{ jobId: string; planId: string }>;
    session: unknown;
  }> = [
    {
      name: 'submitAugment',
      run: () => aiPlanEditsService.submitAugment('add a login flow', ctx),
      session: { origin: 'generation' },
    },
    {
      name: 'submitContextual',
      run: () => aiPlanEditsService.submitContextual('split this', ['MOTIR-100'], ctx),
      session: { origin: 'generation' },
    },
    {
      name: 'submitExpand',
      run: () => aiPlanEditsService.submitExpand('MOTIR-100', ctx),
      session: { origin: 'expand', targetKeys: ['MOTIR-100'] },
    },
  ];

  beforeEach(() => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', kind: 'story' }),
    );
  });

  for (const c of CASES) {
    it(`${c.name} opens a Plan bound to the submitted job via sourceJobId`, async () => {
      mockSubmitJob();

      const out = await c.run();

      expect(out).toEqual({ jobId: 'job_1', planId: 'plan_1' });
      expect(plansService.createPlan).toHaveBeenCalledTimes(1);
      // `origin: 'user'` (MOTIR-916) — every REQUEST-path submit records a
      // human-initiated plan; only the auto-plan cadence watcher passes
      // `cadence`. Asserted on the call, not just defaulted downstream, so a
      // future submit path can't silently start mislabelling its provenance.
      //
      // `createdById` (MOTIR-2986) rides the SAME decision, and this is the
      // request-path arm of it: somebody clicked, so the acting user IS the
      // requester and is recorded. The cadence arm — where the acting user is a
      // substituted project-owner credential and `createdById` must stay NULL —
      // is asserted in `tests/integration/ai/autoPlanCadence.test.ts`.
      //
      // `authorSource` / `authorHarness` (MOTIR-2996) are the THIRD party and the
      // one that does NOT vary by path: motir-ai writes the tree for every submit
      // this seam serves, so Motir is the author of all of them and the pair is
      // SERVER-SET here rather than read from anything the caller passed. This is
      // what retires the `sourceJobId != null` inference the Plans surface stood
      // on — asserted on the call so a future submit path cannot silently drop it
      // and leave its plans reading as unattributed.
      expect(plansService.createPlan).toHaveBeenCalledWith(
        'pj_1',
        {
          title: null,
          summary: null,
          sourceJobId: 'job_1',
          origin: 'user',
          createdById: ctx.userId,
          authorSource: 'native',
          authorHarness: 'Motir',
          session: c.session,
        },
        ctx,
      );
    });

    it(`${c.name} opens NO Plan when the submit fails (no orphan)`, async () => {
      vi.mocked(submitJob).mockRejectedValue(new Error('motir-ai unreachable'));

      await expect(c.run()).rejects.toThrow('motir-ai unreachable');

      expect(plansService.createPlan).not.toHaveBeenCalled();
    });
  }

  it('submits the job BEFORE opening the plan (so a failed submit leaves no orphan)', async () => {
    mockSubmitJob();

    await aiPlanEditsService.submitAugment('prompt', ctx);

    const submitOrder = vi.mocked(submitJob).mock.invocationCallOrder[0]!;
    const createOrder = vi.mocked(plansService.createPlan).mock.invocationCallOrder[0]!;
    expect(submitOrder).toBeLessThan(createOrder);
  });

  it('submitContextual sends the anchor set with the augment kind', async () => {
    mockSubmitJob();

    await aiPlanEditsService.submitContextual('split this', ['MOTIR-100', 'MOTIR-101'], ctx);

    expect(submitJob).toHaveBeenCalledWith(
      'plan',
      expect.objectContaining({ projectKey: 'MOTIR' }),
      expect.objectContaining({
        prompt: 'split this',
        targetKeys: ['MOTIR-100', 'MOTIR-101'],
      }),
      { userId: 'user_1' },
    );
  });
});

// ─── The composed WHAT on the wire (Story MOTIR-3942 · MOTIR-4172) ──────────
// The service half of the carrier: `planChangeSessionsService.submit` hands the
// requirement to ONE of two arms, and the envelope is the last place in this
// repository where the value is observable.
//
// ⚠️ BOTH ARMS ARE ASSERTED, and that is the point rather than thoroughness. A
// dispatched agent's re-plan is always ANCHORED, so `submitContextual` is the
// arm that runs in production and `submitAugment` is the one that could drop
// the value with nothing noticing.
describe('aiPlanEditsService — the requirement rides both plan-edit submit arms', () => {
  beforeEach(() => {
    vi.mocked(plansService.createPlan).mockResolvedValue({ id: 'plan_req' } as PlanDto);
    vi.mocked(submitJob).mockResolvedValue({ jobId: 'job_req' });
  });

  const requirement = {
    outcome: 'The planner starts knowing the problem.',
    behaviour: 'A submit carrying a requirement lands it on the envelope.',
    scopeEdge: '',
    constraints: 'The producer validates nothing.',
    acceptance: 'It reaches `context.requirement` unchanged.',
    assumptions: '',
  };

  /** The context bag the one `submitJob` call went out with. */
  const sentContext = () =>
    vi.mocked(submitJob).mock.calls[0]![2] as unknown as Record<string, unknown>;

  const arms = [
    {
      name: 'submitAugment',
      run: (r?: typeof requirement) => aiPlanEditsService.submitAugment('prompt', ctx, r),
    },
    {
      name: 'submitContextual',
      run: (r?: typeof requirement) =>
        aiPlanEditsService.submitContextual('prompt', ['MOTIR-100'], ctx, r),
    },
  ] as const;

  for (const arm of arms) {
    it(`${arm.name} carries it through to context.requirement, unchanged`, async () => {
      await arm.run(requirement);
      expect(sentContext().requirement).toEqual(requirement);
    });

    it(`${arm.name} OMITS the key when none is supplied — absence, not null`, async () => {
      await arm.run();
      // The `code` / `repositories` meaning of absence: nobody supplied one.
      // `null` or `{}` would be a supplied-but-empty requirement, a third state
      // neither side has a reading for — and this card's risk is precisely an
      // optional field quietly becoming mandatory.
      expect('requirement' in sentContext()).toBe(false);
      expect(JSON.stringify(sentContext())).not.toContain('requirement');
    });
  }

  it('the value is NOT normalized — the service is a wire, not a validator', async () => {
    // A partial requirement the far side will refuse still goes out as sent: no
    // key is filled in, no empty string is dropped, nothing is trimmed.
    const partial = { outcome: '  ', behaviour: 'only two of six' };
    await aiPlanEditsService.submitContextual('prompt', ['MOTIR-100'], ctx, partial);
    expect(sentContext().requirement).toEqual(partial);
  });
});

// ─── The AI-drafted-explanations opt-in on the wire (MOTIR-2110) ─────────────
// The producer half of a two-repo contract: motir-ai reads the flag ONLY from
// `context.generateExplanations` (never from motir-core config), so a submit
// that omits it silently disables the project's setting on that path — which is
// what a re-plan did, leaving the toggle working on first generation alone.
// Asserted on EVERY plan-edit submit, not just a re-plan one: a contextual turn
// submits as `augment` and motir-ai's scoping module can resolve it INTO a
// re-plan, so a replan-only fix would leave the same hole one path over.
describe('aiPlanEditsService — the generateExplanations opt-in rides every plan-edit envelope', () => {
  const CASES: Array<{
    name: string;
    kind: string;
    run: (c: ProjectContext) => Promise<{ jobId: string; planId: string }>;
  }> = [
    {
      name: 'submitAugment',
      kind: 'plan',
      run: (c) => aiPlanEditsService.submitAugment('add a login flow', c),
    },
    {
      name: 'submitContextual',
      kind: 'plan',
      run: (c) => aiPlanEditsService.submitContextual('split this', ['MOTIR-100'], c),
    },
    {
      name: 'submitExpand',
      kind: 'plan',
      run: (c) => aiPlanEditsService.submitExpand('MOTIR-100', c),
    },
  ];

  beforeEach(() => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', kind: 'story' }),
    );
  });

  for (const c of CASES) {
    it(`${c.name} sends generateExplanations: true for an opted-in project`, async () => {
      mockSubmitJob();

      await c.run(ctxWithExplanations);

      const [kind, , context] = vi.mocked(submitJob).mock.calls[0]!;
      expect(kind).toBe(c.kind);
      expect((context as JobContextBag).generateExplanations).toBe(true);
    });

    it(`${c.name} sends generateExplanations: false — PRESENT, not omitted — when off`, async () => {
      mockSubmitJob();

      await c.run(ctx);

      const context = vi.mocked(submitJob).mock.calls[0]![2] as JobContextBag;
      // Strictly `false`, and the KEY is there: an omission reads as "unset" on
      // the far side, which is exactly the state this bug shipped. Same
      // discipline the `generate_tree` submit already uses for the OFF case.
      expect(context.generateExplanations).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(context, 'generateExplanations')).toBe(true);
    });
  }

  it('reads the flag from the project, never from a caller-supplied context', async () => {
    mockSubmitJob();

    // The submit's own context (`rootItemKey`) is preserved alongside the flag —
    // the field is added to the envelope, it does not replace what the caller
    // built (the `code` hole included).
    vi.mocked(resolvePlanningCodeContext).mockResolvedValue({
      repos: [
        {
          provider: 'github',
          repoRef: 'o/r',
          defaultBranch: 'main',
          indexed: true,
          // The freshness fields `JobCodeRepoState` requires. This fixture
          // predates them and typechecked only because `tsc --noEmit` does not
          // cover `tests/` — `pnpm typecheck` (the solution build) does.
          indexState: 'indexed',
          refreshInFlight: false,
          indexedAt: null,
          commitsBehind: null,
          indexedSha: null,
          defaultHead: null,
        },
      ],
    });
    await aiPlanEditsService.submitExpand('MOTIR-100', ctxWithExplanations);

    const context = vi.mocked(submitJob).mock.calls[0]![2] as JobContextBag;
    expect(context).toMatchObject({
      rootItemKey: 'MOTIR-100',
      generateExplanations: true,
      code: expect.any(Object),
    });
  });
});

describe('aiPlanEditsService.stream*', () => {
  const frames: JobStreamEvent[] = [
    { event: 'status', data: { status: 'running' } },
    { event: 'done', data: { status: 'succeeded' } },
  ];

  it('streamAugment relays the client stream', async () => {
    async function* gen(): AsyncGenerator<JobStreamEvent> {
      for (const f of frames) yield f;
    }
    vi.mocked(streamJob).mockReturnValue(gen());

    const got: JobStreamEvent[] = [];
    for await (const f of aiPlanEditsService.streamAugment('job_1', 'pj_1')) got.push(f);

    expect(streamJob).toHaveBeenCalledWith('job_1', expect.any(String));
    expect(got).toEqual(frames);
  });
});

// ─── The record-planning-mistakes flag on the wire (MOTIR-3350) ──────────────
// The producer half of a cross-repo contract with no shared type: motir-ai reads
// the setting ONLY from `context.recordPlanningMistakes`, so a submit that omits
// it is read on the far side as "old producer" and capture continues — the exact
// failure a project that switched the setting off would experience, silently.
//
// Asserted on EVERY plan-edit submit for the same reason the explanations block
// above is: a contextual turn submits as `augment` and motir-ai's scoping module
// can resolve it INTO a re-plan, so a replan-only site would leave the hole one
// path over.
describe('aiPlanEditsService — the record-planning-mistakes flag rides every plan-edit envelope', () => {
  // The WIRE STRING, written out rather than imported from the module under test.
  // A test that took the key from the code would agree with itself about the name
  // and prove nothing about the contract; motir-ai's fixture spells the same
  // literal (MOTIR-3354).
  const WIRE_KEY = 'recordPlanningMistakes';

  const CASES: Array<{
    name: string;
    kind: string;
    run: (c: ProjectContext) => Promise<{ jobId: string; planId: string }>;
  }> = [
    {
      name: 'submitAugment',
      kind: 'plan',
      run: (c) => aiPlanEditsService.submitAugment('add a login flow', c),
    },
    {
      name: 'submitContextual',
      kind: 'plan',
      run: (c) => aiPlanEditsService.submitContextual('split this', ['MOTIR-100'], c),
    },
    {
      name: 'submitExpand',
      kind: 'plan',
      run: (c) => aiPlanEditsService.submitExpand('MOTIR-100', c),
    },
  ];

  beforeEach(() => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', kind: 'story' }),
    );
  });

  for (const c of CASES) {
    it(`${c.name} sends the flag as true for a project that has it on`, async () => {
      vi.mocked(resolveRecordPlanningMistakesForJob).mockResolvedValue(true);

      await c.run(ctx);

      const [kind, , context] = vi.mocked(submitJob).mock.calls[0]!;
      expect(kind).toBe(c.kind);
      expect((context as Record<string, unknown>)[WIRE_KEY]).toBe(true);
    });

    it(`${c.name} sends the flag as false — PRESENT, not omitted — when the project switched it off`, async () => {
      vi.mocked(resolveRecordPlanningMistakesForJob).mockResolvedValue(false);

      await c.run(ctx);

      const context = vi.mocked(submitJob).mock.calls[0]![2] as Record<string, unknown>;
      // Strictly `false`, and the KEY is present. An omission is not a weaker
      // form of `false` here — it is the OPPOSITE, because the consumer reads an
      // absent field as "the producer predates this contract" and keeps
      // capturing.
      expect(context[WIRE_KEY]).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(context, WIRE_KEY)).toBe(true);
    });

    it(`${c.name} resolves the flag for the SUBMITTING project`, async () => {
      await c.run(ctx);

      expect(resolveRecordPlanningMistakesForJob).toHaveBeenCalledWith('pj_1', {
        userId: 'user_1',
        workspaceId: 'ws_1',
      });
    });
  }

  it('the exported constant IS the wire string — a rename fails here, not in production', () => {
    // The call sites use the constant as a computed key, so this is what ties the
    // one name in the code to the one name on the wire. If someone renames the
    // constant's VALUE, every assertion above still passes (they read the literal)
    // and this one fails, which is the intended blast radius.
    expect(RECORD_PLANNING_MISTAKES_CONTEXT_FIELD).toBe(WIRE_KEY);
  });
});

// ─── ONE PLANNING KIND ON THE WIRE (MOTIR-4304 · ADR §6 step 2) ──────────────
//
// Every planning submit in the product sends `plan`. The five old kinds were
// transport carrying an operation NAME, and after MOTIR-3940 all five routed
// through one walk on the far side — so the kind was a distinction nothing
// consumed, and a second place for the answer to drift.
//
// What replaces it is the CONTEXT, which is why the second suite below matters
// as much as the first: motir-ai resolves the target arm from `context.planId`
// (a plan), `context.rootItemKey` / `context.targetKeys` (a work item), or their
// ABSENCE (the project). If a site's kind changed and its context quietly
// changed with it, the run would land on the wrong grounding and report success.
describe('aiPlanEditsService — every planning submit sends `jobKind: "plan"` (MOTIR-4304)', () => {
  // The five sites this service owns. `aiGenerationService.startGeneration` is
  // the sixth and is asserted where it lives — `tests/ai/codeContext.test.ts`,
  // `tests/ai/projectRepoContext.test.ts` and
  // `tests/api-ai-plan-generate-route.test.ts` all read its submitted kind.
  const SITES: Array<{
    name: string;
    run: (c: ProjectContext) => Promise<unknown>;
    /** The target arm motir-ai must resolve from what this site sends. */
    arm: 'plan' | 'work-item' | 'project';
  }> = [
    {
      name: 'submitAugment',
      arm: 'project',
      run: (c) => aiPlanEditsService.submitAugment('add a login flow', c),
    },
    {
      name: 'submitContextual',
      arm: 'work-item',
      run: (c) => aiPlanEditsService.submitContextual('split this', ['MOTIR-100'], c),
    },
    {
      name: 'submitExpand',
      arm: 'work-item',
      run: (c) => aiPlanEditsService.submitExpand('MOTIR-100', c),
    },
  ];

  beforeEach(() => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', kind: 'story' }),
    );
  });

  for (const site of SITES) {
    it(`${site.name} submits 'plan', and its context still names the ${site.arm} arm`, async () => {
      mockSubmitJob();

      await site.run(ctx);

      const [kind, , context] = vi.mocked(submitJob).mock.calls[0]!;
      expect(kind).toBe('plan');

      // The kind no longer says what the run is about; the context does. Assert
      // the ARM each site names, because that is what the switch made
      // load-bearing.
      const bag = context as JobContextBag & { targetKeys?: unknown };
      const anchored =
        typeof bag.rootItemKey === 'string' ||
        (Array.isArray(bag.targetKeys) && bag.targetKeys.length > 0);
      expect(anchored).toBe(site.arm === 'work-item');
    });
  }

  it('submitRevise submits `plan` AND still sends `context.planId` — the only thing that makes it a revision now', async () => {
    mockSubmitJob();
    vi.mocked(plansService.getPlan).mockResolvedValue({
      id: 'plan_1',
      projectId: 'pj_1',
      status: 'planned',
      items: [],
    } as unknown as Awaited<ReturnType<typeof plansService.getPlan>>);
    vi.mocked(plansService.readRevisionLease).mockResolvedValue(null as never);
    vi.mocked(plansService.acquireRevisionLease).mockResolvedValue(undefined as never);

    await aiPlanEditsService.submitRevise('plan_1', 'split the second story', ctx);

    const [kind, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect(kind).toBe('plan');
    // ⚠️ WITHOUT THIS FIELD A REVISION IS INDISTINGUISHABLE FROM A PROJECT-WIDE
    // PLAN. `readerForPlan` reads `context.planId` FIRST (MOTIR-4301); its silent
    // loss would send the reviewer's correction to `readProjectTarget`, which
    // would propose a fresh tree and call it a revision.
    expect((context as JobContextBag & { planId?: string }).planId).toBe('plan_1');
  });
});

// ⚠️ THE CONTEXT IS BYTE-IDENTICAL APART FROM THE KIND — asserted, not assumed.
//
// The switch is meant to change ONE argument at six call sites. The failure it
// could hide is a field dropped from the bag in passing: every one of these is
// read only on the far side, so a missing one produces a run that succeeds with
// less information, and nothing anywhere goes red. So this pins the WHOLE bag by
// exact equality rather than `toMatchObject` — an extra key fails it too, which
// is the half a partial matcher cannot see.
describe('aiPlanEditsService — the CONTEXT is unchanged by the kind switch (MOTIR-4304)', () => {
  beforeEach(() => {
    vi.mocked(workItemRepository.findByIdentifier).mockResolvedValue(
      mockWorkItem({ identifier: 'MOTIR-100', kind: 'story' }),
    );
  });

  it('an expand submit sends exactly the bag it sent before the switch', async () => {
    mockSubmitJob();
    vi.mocked(resolvePlanningCodeContext).mockResolvedValue({ repos: ['owner/repo'] } as never);
    vi.mocked(resolveProjectRepoContext).mockResolvedValue({ repositories: [] } as never);
    vi.mocked(resolveRecordPlanningMistakesForJob).mockResolvedValue(false);

    await aiPlanEditsService.submitExpand('MOTIR-100', ctxWithExplanations);

    const [kind, , context] = vi.mocked(submitJob).mock.calls[0]!;
    expect(kind).toBe('plan');
    // The pre-switch shape, recorded verbatim. `toEqual` and not
    // `toMatchObject`: a field ADDED here crosses the boundary as much as one
    // removed, and ADR §9 forbids a new wire field in this sequence.
    //
    // ⚠️ AMENDED, TWICE, AND THE PROPERTY IS UNCHANGED — read the describe
    // block's own words: what is pinned is that THE KIND SWITCH (MOTIR-4304)
    // changed no field "in passing". A field added later, deliberately, by a card
    // that says so is not what this guard forbids; a field that vanishes from a
    // refactor still is. `recordPlanningMistakes` was the first such amendment
    // (MOTIR-4343) and `onboarding` is the second (MOTIR-4736). Amending the pin
    // and silently loosening it to `toMatchObject` look similar and are opposite
    // in kind: the exact equality is the whole instrument, and it stays.
    expect(context).toEqual({
      rootItemKey: 'MOTIR-100',
      generateExplanations: true,
      recordPlanningMistakes: false,
      // `true`: the mocked project carries a null `onboardingRanAt` (above).
      onboarding: true,
      code: { repos: ['owner/repo'] },
      repositories: { repositories: [] },
    });
  });

  it('a contextual submit sends its anchor SET, and nothing else moved', async () => {
    mockSubmitJob();
    vi.mocked(resolvePlanningCodeContext).mockResolvedValue(undefined);
    vi.mocked(resolveProjectRepoContext).mockResolvedValue(undefined);
    vi.mocked(resolveRecordPlanningMistakesForJob).mockResolvedValue(true);

    await aiPlanEditsService.submitContextual('split this', ['MOTIR-100', 'MOTIR-101'], ctx);

    const [, , context] = vi.mocked(submitJob).mock.calls[0]!;
    // `code` and `repositories` are spread CONDITIONALLY — absent means "this
    // workspace has none" — so their absence here is the shipped behaviour, not
    // a loss. `generateExplanations` and `recordPlanningMistakes` are never
    // conditional, for the opposite reason: absence would read as a default.
    // `onboarding` joins that second group: absence would send motir-ai back to
    // inferring the answer from an empty tree (MOTIR-4736), so it is sent
    // unconditionally on this shared submit and reaches the contextual path too.
    expect(context).toEqual({
      prompt: 'split this',
      targetKeys: ['MOTIR-100', 'MOTIR-101'],
      generateExplanations: false,
      recordPlanningMistakes: true,
      onboarding: true,
    });
  });
});
