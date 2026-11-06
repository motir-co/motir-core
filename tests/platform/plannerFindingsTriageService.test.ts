import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import type { PlatformAuditEntry } from '@/lib/platform/context';
import {
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
import type {
  PlannerFindingTriagePatch,
  RawPlannerFinding,
  RawPlannerFindingAudit,
} from '@/lib/ai/motirAiClient';

/**
 * The planner-findings TRIAGE service (Story MOTIR-10353 · MOTIR-10519).
 *
 * motir-ai is stubbed at the client module, the staff gate is a
 * degree-honouring mock, and `withPlatformWrite` is a stub that runs the
 * callback with a recording `record` and mirrors the real one's rule (no row →
 * the write fails). The rows against a real database are the integration gate's.
 */

const client = vi.hoisted(() => ({
  getPlannerFinding: vi.fn(),
  triagePlannerFinding: vi.fn(),
  createLesson: vi.fn(),
}));
const gate = vi.hoisted(() => ({ principal: null as PlatformPrincipal | null }));
const audit = vi.hoisted(() => ({
  rows: [] as PlatformAuditEntry[],
  failAppend: false,
  principals: [] as PlatformPrincipal[],
}));

vi.mock('@/lib/ai/motirAiClient', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/ai/motirAiClient')>('@/lib/ai/motirAiClient');
  return { ...actual, ...client };
});
vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!gate.principal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(gate.principal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return gate.principal;
      },
    ),
  };
});
vi.mock('@/lib/platform/context', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/platform/context')>('@/lib/platform/context');
  return {
    ...actual,
    withPlatformWrite: vi.fn(
      async (
        principal: PlatformPrincipal,
        fn: (tx: unknown, record: (e: PlatformAuditEntry) => Promise<void>) => Promise<unknown>,
      ) => {
        audit.principals.push(principal);
        const pending: PlatformAuditEntry[] = [];
        const result = await fn({}, async (entry) => {
          if (audit.failAppend) throw new Error('append failed');
          pending.push(entry);
        });
        if (pending.length === 0) throw new Error('unaudited');
        audit.rows.push(...pending);
        return result;
      },
    ),
  };
});

const { plannerFindingsTriageService: svc } =
  await import('@/lib/services/plannerFindingsTriageService');

const OPERATOR: PlatformPrincipal = { userId: 'u_op', email: 'op@moooon.net', role: 'operator' };
const FORGED: PlatformPrincipal = { userId: 'u_evil', email: 'x@example.com', role: 'superadmin' };

function finding(over: Partial<RawPlannerFinding> = {}): RawPlannerFinding {
  return {
    id: 'pf_1',
    coreOrganizationId: 'org_1',
    coreWorkspaceId: 'ws_1',
    coreProjectId: 'pj_1',
    aiProjectId: 'aip_1',
    planId: 'plan_1',
    jobId: 'job_1',
    planTitle: 'Plan',
    cardRef: null,
    source: 'in_loop',
    planner: 'hosted',
    authorModel: null,
    authorSessionKey: null,
    baselineBranch: null,
    baselineCommit: null,
    site: 'leaf:MOTIR-1',
    prediction: 'STOPS',
    whatHappened: 'The leaf named a file that does not exist.',
    evidence: 'not found',
    correction: null,
    outcome: 'fixed',
    rule: null,
    attribution: null,
    why: null,
    hostedCell: null,
    planpyCell: null,
    fixDirection: null,
    fingerprint: 'fp_1',
    status: 'new',
    lessonId: null,
    bugKey: null,
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...over,
  };
}

function auditOf(before: Record<string, unknown>, after: Record<string, unknown>) {
  return {
    action: 'ai.planner_finding.triage',
    findingId: 'pf_1',
    actorCoreUserId: 'u_op',
    at: '2026-11-06T00:00:00.000Z',
    before,
    after,
  } satisfies RawPlannerFindingAudit;
}

const CHANGED = auditOf({ status: 'new' }, { status: 'dismissed' });
const FORM = {
  mistakeType: 'regular_planning',
  title: '  Read the path first  ',
  why: ' Missing files stop runs. ',
  howToApply: ' Read every context ref. ',
};

const lastPatch = () =>
  client.triagePlannerFinding.mock.calls.at(-1)?.[1] as PlannerFindingTriagePatch;

beforeEach(() => {
  vi.clearAllMocks();
  gate.principal = OPERATOR;
  audit.rows = [];
  audit.principals = [];
  audit.failAppend = false;
  client.triagePlannerFinding.mockResolvedValue({ finding: finding(), audit: CHANGED });
  client.getPlannerFinding.mockResolvedValue(finding());
  client.createLesson.mockResolvedValue({ id: 'lsn_9' });
});

const methods: [string, () => Promise<unknown>][] = [
  ['setAttribution', () => svc.setAttribution(FORGED, 'pf_1', { attribution: 'code' })],
  ['recordBugKey', () => svc.recordBugKey(FORGED, 'pf_1', 'MOTIR-1')],
  ['dismiss', () => svc.dismiss(FORGED, 'pf_1')],
  ['restore', () => svc.restore(FORGED, 'pf_1')],
  ['promoteToLesson', () => svc.promoteToLesson(FORGED, 'pf_1', FORM)],
];

describe('the gate', () => {
  it.each(methods)('%s refuses a non-staff caller before any motir-ai call', async (_n, call) => {
    gate.principal = null;
    await expect(call()).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(client.getPlannerFinding).not.toHaveBeenCalled();
    expect(client.createLesson).not.toHaveBeenCalled();
    expect(client.triagePlannerFinding).not.toHaveBeenCalled();
    expect(audit.rows).toEqual([]);
  });

  it.each(methods)('%s refuses support staff (below operator)', async (_n, call) => {
    gate.principal = { ...OPERATOR, role: 'support' };
    await expect(call()).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(client.triagePlannerFinding).not.toHaveBeenCalled();
  });

  it('acts as the principal the gate answers, never the argument', async () => {
    await svc.restore(FORGED, 'pf_1');
    expect(client.triagePlannerFinding.mock.calls[0]![2]).toBe('u_op');
    expect(audit.principals).toEqual([OPERATOR]);
  });
});

describe('the plain writes', () => {
  it('setAttribution sends the attribution and only the text given, no status', async () => {
    await svc.setAttribution(FORGED, 'pf_1', {
      attribution: 'corpus',
      why: ' The pack never says it. ',
      hostedCell: '',
      planpyCell: '   ',
      fixDirection: 'Add the rule.',
    });
    expect(client.triagePlannerFinding).toHaveBeenCalledTimes(1);
    expect(lastPatch()).toEqual({
      attribution: 'corpus',
      why: 'The pack never says it.',
      fixDirection: 'Add the rule.',
    });
  });

  it('recordBugKey sends filed_as_bug with the trimmed, upper-cased key', async () => {
    await svc.recordBugKey(FORGED, 'pf_1', '  motir-123 ');
    expect(lastPatch()).toEqual({ status: 'filed_as_bug', bugKey: 'MOTIR-123' });
  });

  it('dismiss sends the note only when one was given', async () => {
    await svc.dismiss(FORGED, 'pf_1', ' Duplicate of fp_2. ');
    expect(lastPatch()).toEqual({ status: 'dismissed', note: 'Duplicate of fp_2.' });
    await svc.dismiss(FORGED, 'pf_1', '   ');
    expect(lastPatch()).toEqual({ status: 'dismissed' });
  });

  it('restore sends status new', async () => {
    const out = await svc.restore(FORGED, 'pf_1');
    expect(lastPatch()).toEqual({ status: 'new' });
    expect(out.finding).toMatchObject({ id: 'pf_1', attribution: 'unattributed' });
  });
});

describe('the audit row', () => {
  const expected = (reason: string) => ({
    action: 'planner_finding.triage',
    targetKind: 'platform',
    targetId: 'pf_1',
    targetLabel: 'leaf:MOTIR-1',
    organizationId: 'org_1',
    reason,
    metadata: { findingId: 'pf_1', before: { status: 'new' }, after: { status: 'dismissed' } },
  });

  it.each([
    [
      'setAttribution',
      () => svc.setAttribution(FORGED, 'pf_1', { attribution: 'model' }),
      /attribution/,
    ],
    ['recordBugKey', () => svc.recordBugKey(FORGED, 'pf_1', 'MOTIR-9'), /bug key/],
    ['dismiss without a note', () => svc.dismiss(FORGED, 'pf_1', '  '), /Dismissed/],
    ['restore', () => svc.restore(FORGED, 'pf_1'), /Restored/],
    ['promoteToLesson', () => svc.promoteToLesson(FORGED, 'pf_1', FORM), /lesson/],
  ])('%s records exactly one entry with a default reason', async (_n, call, reason) => {
    await call();
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toEqual(expected(audit.rows[0]!.reason as string));
    expect(audit.rows[0]!.reason).toMatch(reason);
    expect(audit.rows[0]!.reason).toMatch('/admin/planner-findings');
  });

  it('a dismiss note is the reason', async () => {
    await svc.dismiss(FORGED, 'pf_1', ' Not a planner defect. ');
    expect(audit.rows[0]).toEqual(expected('Not a planner defect.'));
  });
});

describe('unchanged', () => {
  it.each([
    ['a same-value attribution', () => svc.setAttribution(FORGED, 'pf_1', { attribution: 'code' })],
    ['a restore of a finding that is not dismissed', () => svc.restore(FORGED, 'pf_1')],
  ])('%s throws PlannerFindingUnchangedError and leaves no row', async (_n, call) => {
    client.triagePlannerFinding.mockResolvedValueOnce({ finding: finding(), audit: null });
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerFindingUnchangedError);
    expect((err as PlannerFindingUnchangedError).findingId).toBe('pf_1');
    expect(audit.rows).toEqual([]);
  });
});

describe('promoteToLesson', () => {
  it('reads, creates in the finding’s own project, then links the new lesson', async () => {
    const order: string[] = [];
    client.getPlannerFinding.mockImplementationOnce(async () => {
      order.push('get');
      return finding();
    });
    client.createLesson.mockImplementationOnce(async () => {
      order.push('create');
      return { id: 'lsn_9' };
    });
    client.triagePlannerFinding.mockImplementationOnce(async () => {
      order.push('triage');
      return {
        finding: finding({ status: 'promoted_to_lesson', lessonId: 'lsn_9' }),
        audit: CHANGED,
      };
    });
    const out = await svc.promoteToLesson(FORGED, 'pf_1', FORM);
    expect(order).toEqual(['get', 'create', 'triage']);
    expect(client.createLesson).toHaveBeenCalledWith({
      coreOrganizationId: 'org_1',
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
      mistakeType: 'regular_planning',
      title: 'Read the path first',
      body: 'The leaf named a file that does not exist.',
      why: 'Missing files stop runs.',
      howToApply: 'Read every context ref.',
    });
    expect(lastPatch()).toEqual({ status: 'promoted_to_lesson', lessonId: 'lsn_9' });
    expect(out.finding).toMatchObject({ status: 'promoted_to_lesson', lessonId: 'lsn_9' });
  });

  it('a failed create propagates unchanged and writes nothing', async () => {
    const refusal = new MotirAiBadRequestError('near-duplicate');
    client.createLesson.mockRejectedValueOnce(refusal);
    await expect(svc.promoteToLesson(FORGED, 'pf_1', FORM)).rejects.toBe(refusal);
    expect(client.triagePlannerFinding).not.toHaveBeenCalled();
    expect(audit.rows).toEqual([]);
  });

  it('a near-duplicate 409 from the create becomes the conflict naming the existing lesson', async () => {
    client.createLesson.mockRejectedValueOnce(
      new MotirAiBadRequestError('near-duplicate of lsn_3 "Read the path"', 409),
    );
    const err = await svc.promoteToLesson(FORGED, 'pf_1', FORM).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MotirAiConflictError);
    expect((err as MotirAiConflictError).detail).toBe('near-duplicate of lsn_3 "Read the path"');
    expect(client.triagePlannerFinding).not.toHaveBeenCalled();
    expect(audit.rows).toEqual([]);
  });

  it.each([
    [
      'a client error',
      () => client.triagePlannerFinding.mockRejectedValueOnce(new MotirAiUnavailableError('down')),
    ],
    [
      'an unchanged answer',
      () => client.triagePlannerFinding.mockResolvedValueOnce({ finding: finding(), audit: null }),
    ],
    [
      'a failed audit append',
      () => {
        audit.failAppend = true;
      },
    ],
  ])('a link step that fails on %s keeps the lesson and says so', async (_n, arrange) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    arrange();
    const err = await svc.promoteToLesson(FORGED, 'pf_1', FORM).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerFindingLessonNotLinkedError);
    expect(err).toMatchObject({ findingId: 'pf_1', lessonId: 'lsn_9' });
    expect(client.createLesson).toHaveBeenCalledTimes(1);
    expect(audit.rows).toEqual([]);
    expect(error.mock.calls.some((c) => String(c[1]).includes('"lessonId":"lsn_9"'))).toBe(true);
    error.mockRestore();
  });

  it('a finding already promoted is unchanged, with no create and no triage', async () => {
    client.getPlannerFinding.mockResolvedValueOnce(
      finding({ status: 'promoted_to_lesson', lessonId: 'lsn_1' }),
    );
    await expect(svc.promoteToLesson(FORGED, 'pf_1', FORM)).rejects.toBeInstanceOf(
      PlannerFindingUnchangedError,
    );
    expect(client.createLesson).not.toHaveBeenCalled();
    expect(client.triagePlannerFinding).not.toHaveBeenCalled();
  });

  it('an unknown finding throws not-found untouched, with no create', async () => {
    const missing = new PlannerFindingNotFoundError('pf_x');
    client.getPlannerFinding.mockRejectedValueOnce(missing);
    await expect(svc.promoteToLesson(FORGED, 'pf_x', FORM)).rejects.toBe(missing);
    expect(client.createLesson).not.toHaveBeenCalled();
  });
});

describe('validation, before any motir-ai call', () => {
  it.each([
    [
      'an unknown attribution',
      () => svc.setAttribution(FORGED, 'pf_1', { attribution: 'luck' }),
      'attribution',
    ],
    ['a bare word bug key', () => svc.recordBugKey(FORGED, 'pf_1', 'motir'), 'bugKey'],
    ['a digits-only bug key', () => svc.recordBugKey(FORGED, 'pf_1', '123'), 'bugKey'],
    ['an empty bug key', () => svc.recordBugKey(FORGED, 'pf_1', ''), 'bugKey'],
    ['a blank title', () => svc.promoteToLesson(FORGED, 'pf_1', { ...FORM, title: ' ' }), 'title'],
    ['a blank why', () => svc.promoteToLesson(FORGED, 'pf_1', { ...FORM, why: '' }), 'why'],
    [
      'a blank how-to-apply',
      () => svc.promoteToLesson(FORGED, 'pf_1', { ...FORM, howToApply: '\n' }),
      'howToApply',
    ],
    [
      'a blank mistake type',
      () => svc.promoteToLesson(FORGED, 'pf_1', { ...FORM, mistakeType: '' }),
      'mistakeType',
    ],
  ])('%s is refused', async (_n, call, field) => {
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerFindingInvalidError);
    expect((err as PlannerFindingInvalidError).field).toBe(field);
    expect(client.getPlannerFinding).not.toHaveBeenCalled();
    expect(client.createLesson).not.toHaveBeenCalled();
    expect(client.triagePlannerFinding).not.toHaveBeenCalled();
  });
});

describe('the residual case', () => {
  it('logs the applied change once and rethrows when the audit append fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    audit.failAppend = true;
    await expect(svc.dismiss(FORGED, 'pf_1')).rejects.toThrow('append failed');
    expect(error).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(error.mock.calls[0]![1])) as Record<string, unknown>;
    expect(payload).toEqual({
      action: 'planner_finding.triage',
      findingId: 'pf_1',
      actor: 'u_op',
      before: { status: 'new' },
      after: { status: 'dismissed' },
    });
    error.mockRestore();
  });
});

describe('no work item, no bug', () => {
  it('imports only the three motir-ai calls it may make', () => {
    const source = readFileSync('lib/services/plannerFindingsTriageService.ts', 'utf8');
    const block = /import \{([^}]*)\} from '@\/lib\/ai\/motirAiClient'/.exec(source)?.[1] ?? '';
    const values = block
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('type '));
    expect(values.sort()).toEqual(['createLesson', 'getPlannerFinding', 'triagePlannerFinding']);
  });
});
