import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlannerFindingRowDTO } from '@/lib/dto/plannerFindings';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import {
  MissingAuditReasonError,
  NotPlatformStaffError,
  PlannerFindingInvalidError,
  PlannerFindingLessonNotLinkedError,
  PlannerFindingUnchangedError,
} from '@/lib/platform/errors';
import {
  MotirAiBadRequestError,
  MotirAiConflictError,
  MotirAiUnavailableError,
  PlannerFindingNotFoundError,
} from '@/lib/ai/errors';
import type { RawPlannerFinding } from '@/lib/ai/motirAiClient';

/**
 * The planner-findings triage SERVER ACTIONS (Story MOTIR-10353 · MOTIR-10520).
 *
 * The service, the staff gate and `revalidatePath` are stubbed; the actions are
 * transport only, so what is asserted is the gate, the one service call and its
 * arguments, the result mapping and the revalidation. One case runs the REAL
 * promote with motir-ai stubbed at the client, to show a near-duplicate lesson
 * refusal reaches the control as DUPLICATE_LESSON with no PATCH and no audit row.
 */

const gate = vi.hoisted(() => ({ principal: null as PlatformPrincipal | null }));
const nav = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const svc = vi.hoisted(() => ({
  setAttribution: vi.fn(),
  recordBugKey: vi.fn(),
  dismiss: vi.fn(),
  restore: vi.fn(),
  promoteToLesson: vi.fn(),
  realPromote: false,
}));
const client = vi.hoisted(() => ({
  getPlannerFinding: vi.fn(),
  triagePlannerFinding: vi.fn(),
  createLesson: vi.fn(),
}));
const writes = vi.hoisted(() => ({ withPlatformWrite: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: nav.revalidatePath }));
vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(async (minimum: 'support' | 'operator' | 'superadmin') => {
      if (!gate.principal || !actual.platformRoleAtLeast(gate.principal.role, minimum)) {
        throw new NotPlatformStaffError();
      }
      return gate.principal;
    }),
  };
});
vi.mock('@/lib/ai/motirAiClient', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/ai/motirAiClient')>('@/lib/ai/motirAiClient');
  return { ...actual, ...client };
});
vi.mock('@/lib/platform/context', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/platform/context')>('@/lib/platform/context');
  return { ...actual, withPlatformWrite: writes.withPlatformWrite };
});
vi.mock('@/lib/services/plannerFindingsTriageService', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/services/plannerFindingsTriageService')
  >('@/lib/services/plannerFindingsTriageService');
  return {
    ...actual,
    plannerFindingsTriageService: {
      setAttribution: svc.setAttribution,
      recordBugKey: svc.recordBugKey,
      dismiss: svc.dismiss,
      restore: svc.restore,
      promoteToLesson: (...args: Parameters<typeof svc.promoteToLesson>) =>
        svc.realPromote
          ? actual.plannerFindingsTriageService.promoteToLesson(
              ...(args as Parameters<typeof actual.plannerFindingsTriageService.promoteToLesson>),
            )
          : svc.promoteToLesson(...args),
    },
  };
});

const actions = await import('@/app/(admin)/admin/planner-findings/actions');

const OPERATOR: PlatformPrincipal = { userId: 'u_op', email: 'op@moooon.net', role: 'operator' };
const SUPPORT: PlatformPrincipal = { userId: 'u_sp', email: 'sp@moooon.net', role: 'support' };

const FINDING: PlannerFindingRowDTO = {
  id: 'pf_1',
  source: 'in_loop',
  planner: 'hosted',
  attribution: 'code',
  outcome: 'fixed',
  prediction: 'STOPS',
  site: 'leaf:MOTIR-12',
  planId: 'plan_1',
  planTitle: 'Plan one',
  status: 'new',
  fingerprint: 'fp_1',
  lessonId: null,
  bugKey: null,
  createdAt: '2026-11-01T10:00:00.000Z',
};

const FORM = { mistakeType: 'context', title: 'Read the path', why: 'w', howToApply: 'h' };
const ATTRIBUTION = { attribution: 'code', why: 'The walker skipped it.' };

type Act = {
  name: string;
  method: keyof Omit<typeof svc, 'realPromote'>;
  run: () => Promise<Awaited<ReturnType<typeof actions.restorePlannerFindingAction>>>;
  args: unknown[];
};

const ACTS: Act[] = [
  {
    name: 'setPlannerFindingAttributionAction',
    method: 'setAttribution',
    run: () => actions.setPlannerFindingAttributionAction('pf_1', ATTRIBUTION),
    args: ['pf_1', ATTRIBUTION],
  },
  {
    name: 'recordPlannerFindingBugKeyAction',
    method: 'recordBugKey',
    run: () => actions.recordPlannerFindingBugKeyAction('pf_1', ' motir-42 '),
    args: ['pf_1', ' motir-42 '],
  },
  {
    name: 'dismissPlannerFindingAction',
    method: 'dismiss',
    run: () => actions.dismissPlannerFindingAction('pf_1', '  Duplicate. '),
    args: ['pf_1', '  Duplicate. '],
  },
  {
    name: 'restorePlannerFindingAction',
    method: 'restore',
    run: () => actions.restorePlannerFindingAction('pf_1'),
    args: ['pf_1'],
  },
  {
    name: 'promotePlannerFindingAction',
    method: 'promoteToLesson',
    run: () => actions.promotePlannerFindingAction('pf_1', FORM),
    args: ['pf_1', FORM],
  },
];

const LAYOUT = ['/admin/planner-findings', 'layout'];

beforeEach(() => {
  vi.clearAllMocks();
  gate.principal = OPERATOR;
  svc.realPromote = false;
  for (const act of ACTS) svc[act.method].mockResolvedValue({ finding: FINDING });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the action file', () => {
  it("is a 'use server' file exporting only the five actions", () => {
    const source = readFileSync('app/(admin)/admin/planner-findings/actions.ts', 'utf8');
    expect(source.startsWith("'use server';")).toBe(true);
    expect(Object.keys(actions).sort()).toEqual(ACTS.map((a) => a.name).sort());
    // Transport only: no client call, repository or audit helper of its own.
    expect(source).not.toMatch(/motirAiClient|repositories|withPlatformWrite|recordAudit/);
  });
});

describe.each(ACTS)('$name', (act) => {
  it('gates, calls its one service method with the arguments unchanged, answers the finding', async () => {
    const result = await act.run();
    expect(result).toEqual({ ok: true, finding: FINDING });
    expect(svc[act.method]).toHaveBeenCalledTimes(1);
    expect(svc[act.method]).toHaveBeenCalledWith(OPERATOR, ...act.args);
    for (const other of ACTS) {
      if (other.method !== act.method) expect(svc[other.method]).not.toHaveBeenCalled();
    }
    expect(nav.revalidatePath).toHaveBeenCalledTimes(1);
    expect(nav.revalidatePath).toHaveBeenCalledWith(...LAYOUT);
  });

  it('refuses a caller who is not signed in as staff, touching nothing', async () => {
    gate.principal = null;
    expect(await act.run()).toEqual({ ok: false, code: 'NOT_PERMITTED' });
    expect(svc[act.method]).not.toHaveBeenCalled();
    expect(nav.revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses support staff, who are below operator', async () => {
    gate.principal = SUPPORT;
    expect(await act.run()).toEqual({ ok: false, code: 'NOT_PERMITTED' });
    expect(svc[act.method]).not.toHaveBeenCalled();
    expect(nav.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('the refusal mapping', () => {
  const dismiss = () => actions.dismissPlannerFindingAction('pf_1');

  it.each([
    [
      'PlannerFindingNotFoundError',
      new PlannerFindingNotFoundError('pf_1'),
      { code: 'GONE' },
      true,
    ],
    [
      'PlannerFindingUnchangedError',
      new PlannerFindingUnchangedError('pf_1'),
      { code: 'UNCHANGED' },
      true,
    ],
    [
      'PlannerFindingInvalidError',
      new PlannerFindingInvalidError('bad', 'bugKey'),
      { code: 'INVALID' },
      false,
    ],
    ['MotirAiBadRequestError', new MotirAiBadRequestError('bad'), { code: 'INVALID' }, false],
    [
      'PlannerFindingLessonNotLinkedError',
      new PlannerFindingLessonNotLinkedError('pf_1', 'lsn_9'),
      { code: 'LESSON_NOT_LINKED', lessonId: 'lsn_9' },
      true,
    ],
    [
      'MotirAiConflictError',
      new MotirAiConflictError('near-duplicate of lsn_3 "Read the path"'),
      { code: 'DUPLICATE_LESSON', detail: 'near-duplicate of lsn_3 "Read the path"' },
      false,
    ],
    [
      'MotirAiUnavailableError',
      new MotirAiUnavailableError('down'),
      { code: 'UNAVAILABLE' },
      false,
    ],
    ['MissingAuditReasonError', new MissingAuditReasonError('x'), { code: 'FAILED' }, false],
    ['a plain Error', new Error('boom'), { code: 'FAILED' }, false],
    [
      'NotPlatformStaffError from the service',
      new NotPlatformStaffError(),
      { code: 'NOT_PERMITTED' },
      false,
    ],
  ] as const)('%s → its code', async (_name, err, expected, revalidates) => {
    svc.dismiss.mockRejectedValueOnce(err);
    expect(await dismiss()).toEqual({ ok: false, ...expected });
    if (revalidates) expect(nav.revalidatePath).toHaveBeenCalledWith(...LAYOUT);
    else expect(nav.revalidatePath).not.toHaveBeenCalled();
  });

  it('logs an UNAVAILABLE and a FAILED with the finding id', async () => {
    svc.restore.mockRejectedValueOnce(new MotirAiUnavailableError('down'));
    await actions.restorePlannerFindingAction('pf_7');
    svc.restore.mockRejectedValueOnce(new Error('boom'));
    await actions.restorePlannerFindingAction('pf_8');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('could not reach motir-ai'),
      { findingId: 'pf_7' },
      expect.any(MotirAiUnavailableError),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      { findingId: 'pf_8' },
      expect.any(Error),
    );
  });
});

describe('promotePlannerFindingAction', () => {
  it('answers LESSON_NOT_LINKED with the lesson id and never retries', async () => {
    svc.promoteToLesson.mockRejectedValueOnce(
      new PlannerFindingLessonNotLinkedError('pf_1', 'lsn_9'),
    );
    expect(await actions.promotePlannerFindingAction('pf_1', FORM)).toEqual({
      ok: false,
      code: 'LESSON_NOT_LINKED',
      lessonId: 'lsn_9',
    });
    expect(svc.promoteToLesson).toHaveBeenCalledTimes(1);
    expect(client.createLesson).not.toHaveBeenCalled();
    expect(client.triagePlannerFinding).not.toHaveBeenCalled();
  });

  it('a near-duplicate lesson from the real promote is DUPLICATE_LESSON, no PATCH, no audit row', async () => {
    svc.realPromote = true;
    const raw = {
      id: 'pf_1',
      coreOrganizationId: 'org_1',
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
      aiProjectId: 'aip_1',
      status: 'new',
      lessonId: null,
      whatHappened: 'The leaf named a file that does not exist.',
    } as unknown as RawPlannerFinding;
    client.getPlannerFinding.mockResolvedValue(raw);
    client.createLesson.mockRejectedValue(new MotirAiConflictError('near-duplicate of lsn_3'));

    expect(await actions.promotePlannerFindingAction('pf_1', FORM)).toEqual({
      ok: false,
      code: 'DUPLICATE_LESSON',
      detail: 'near-duplicate of lsn_3',
    });
    expect(client.createLesson).toHaveBeenCalledTimes(1);
    expect(client.triagePlannerFinding).not.toHaveBeenCalled();
    expect(writes.withPlatformWrite).not.toHaveBeenCalled();
    expect(nav.revalidatePath).not.toHaveBeenCalled();
  });
});
