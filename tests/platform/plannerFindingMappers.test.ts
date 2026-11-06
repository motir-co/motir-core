import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLANNER_FINDING_ATTRIBUTIONS,
  PLANNER_FINDING_OUTCOMES,
  PLANNER_FINDING_PLANNERS,
  PLANNER_FINDING_PREDICTIONS,
  PLANNER_FINDING_SOURCES,
  PLANNER_FINDING_STATUSES,
  type RawPlannerFinding,
  type RawPlannerFindingAudit,
  type RawPlannerFindingGroupPage,
  type RawPlannerFindingPage,
} from '@/lib/ai/motirAiClient';
import {
  PLANNER_FINDING_ATTRIBUTION_VALUES,
  PLANNER_FINDING_OUTCOME_VALUES,
  PLANNER_FINDING_PLANNER_VALUES,
  PLANNER_FINDING_PREDICTION_VALUES,
  PLANNER_FINDING_SOURCE_VALUES,
  PLANNER_FINDING_STATUS_VALUES,
  type PlannerFindingCostDTO,
} from '@/lib/dto/plannerFindings';
import {
  toPlannerFindingAuditMetadata,
  toPlannerFindingDetailDTO,
  toPlannerFindingGroupListDTO,
  toPlannerFindingGroupRowDTO,
  toPlannerFindingListDTO,
  toPlannerFindingRowDTO,
  toPlannerFindingTriagePatch,
} from '@/lib/mappers/plannerFindingMappers';
import { isPlatformAuditAction, PLATFORM_AUDIT_READ_ACTIONS } from '@/lib/platform/auditActions';

// Story MOTIR-10353 · MOTIR-10517 — the planner-finding DTOs and mappers, and
// the `planner_finding.triage` audit action they feed.

const RAW: RawPlannerFinding = {
  id: 'pf_1',
  coreOrganizationId: 'org_1',
  coreWorkspaceId: 'ws_1',
  coreProjectId: 'pj_1',
  aiProjectId: 'aip_1',
  planId: 'plan_1',
  jobId: 'job_1',
  planTitle: 'Plan one',
  cardRef: 'MOTIR-12',
  source: 'in_loop',
  planner: 'hosted',
  authorModel: 'model-a',
  authorSessionKey: 'sess_1',
  baselineBranch: 'main',
  baselineCommit: 'abc123',
  site: 'leaf:MOTIR-12',
  prediction: 'STOPS',
  whatHappened: 'The leaf named a file that does not exist.',
  evidence: 'read_file answered not found',
  correction: 'Name the real file.',
  outcome: 'fixed',
  rule: 'context-refs-exist',
  attribution: 'corpus',
  why: 'The pack never says to read the path.',
  hostedCell: 'leaf.code',
  planpyCell: 'leaf/code',
  fixDirection: 'Add the read rule to the pack.',
  fingerprint: 'fp_1',
  status: 'new',
  lessonId: null,
  bugKey: null,
  triageNote: null,
  triagedBy: null,
  triagedAt: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

describe('planner_finding.triage audit action', () => {
  it('is a write in the closed vocabulary', () => {
    expect(isPlatformAuditAction('planner_finding.triage')).toBe(true);
    expect(PLATFORM_AUDIT_READ_ACTIONS).not.toContain('planner_finding.triage');
  });
});

describe('the DTO value sets', () => {
  it.each([
    ['source', PLANNER_FINDING_SOURCE_VALUES, PLANNER_FINDING_SOURCES],
    ['planner', PLANNER_FINDING_PLANNER_VALUES, PLANNER_FINDING_PLANNERS],
    ['prediction', PLANNER_FINDING_PREDICTION_VALUES, PLANNER_FINDING_PREDICTIONS],
    ['outcome', PLANNER_FINDING_OUTCOME_VALUES, PLANNER_FINDING_OUTCOMES],
    ['attribution', PLANNER_FINDING_ATTRIBUTION_VALUES, PLANNER_FINDING_ATTRIBUTIONS],
    ['status', PLANNER_FINDING_STATUS_VALUES, PLANNER_FINDING_STATUSES],
  ] as const)('%s equals the client set member for member', (_name, dto, client) => {
    expect([...dto]).toEqual([...client]);
  });

  it('the DTO file stays importable from a client component', () => {
    const source = readFileSync('lib/dto/plannerFindings.ts', 'utf8');
    expect(source).not.toMatch(/import\s+['"]server-only['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/lib\/ai\/motirAiClient['"]/);
  });
});

describe('toPlannerFindingRowDTO', () => {
  it('maps the row fields and keeps the wire strings', () => {
    expect(toPlannerFindingRowDTO(RAW)).toEqual({
      id: 'pf_1',
      source: 'in_loop',
      planner: 'hosted',
      attribution: 'corpus',
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
    });
  });

  it('reads a NULL attribution as unattributed', () => {
    expect(toPlannerFindingRowDTO({ ...RAW, attribution: null }).attribution).toBe('unattributed');
  });

  it('passes an unrecognised source or status through unchanged', () => {
    const raw = {
      ...RAW,
      source: 'future_source',
      status: 'archived',
    } as unknown as RawPlannerFinding;
    const row = toPlannerFindingRowDTO(raw);
    expect(row.source).toBe('future_source');
    expect(row.status).toBe('archived');
  });
});

describe('toPlannerFindingDetailDTO', () => {
  const COST: PlannerFindingCostDTO = {
    findingsMade: 3,
    findingsFixed: 2,
    lines: [
      {
        stage: 'review',
        model: 'model-a',
        inputTokens: 100,
        outputTokens: 20,
        sessions: 1,
        costMicroUsd: null,
      },
    ],
  };

  it('adds the detail fields and carries the given cost exactly', () => {
    const detail = toPlannerFindingDetailDTO(
      { ...RAW, triageNote: 'n', triagedBy: 'user_1', triagedAt: '2026-11-02T00:00:00.000Z' },
      COST,
    );
    expect(detail).toMatchObject({
      id: 'pf_1',
      attribution: 'corpus',
      whatHappened: RAW.whatHappened,
      evidence: RAW.evidence,
      correction: RAW.correction,
      rule: RAW.rule,
      why: RAW.why,
      hostedCell: RAW.hostedCell,
      planpyCell: RAW.planpyCell,
      fixDirection: RAW.fixDirection,
      cardRef: 'MOTIR-12',
      coreProjectId: 'pj_1',
      authorModel: 'model-a',
      baselineBranch: 'main',
      baselineCommit: 'abc123',
      triageNote: 'n',
      triagedBy: 'user_1',
      triagedAt: '2026-11-02T00:00:00.000Z',
    });
    expect(detail.cost).toBe(COST);
  });

  it('keeps a null cost null, never a zero-valued object', () => {
    expect(toPlannerFindingDetailDTO(RAW, null).cost).toBeNull();
  });
});

describe('groups and pages', () => {
  it('counts distinct plans and keeps the raw finding count', () => {
    const group = toPlannerFindingGroupRowDTO({
      fingerprint: 'fp_1',
      count: 3,
      planIds: ['plan_1', 'plan_2', 'plan_1'],
      latest: { ...RAW, attribution: null },
    });
    expect(group).toMatchObject({ fingerprint: 'fp_1', findingCount: 3, planCount: 2 });
    expect(group.latest.attribution).toBe('unattributed');
  });

  it('maps a last page: nextCursor null, retention passed through', () => {
    const page: RawPlannerFindingPage = {
      findings: [RAW, { ...RAW, id: 'pf_2' }],
      nextCursor: null,
      retention: { days: 90, cutoff: '2026-08-08T00:00:00.000Z' },
    };
    const dto = toPlannerFindingListDTO(page);
    expect(dto.findings.map((f) => f.id)).toEqual(['pf_1', 'pf_2']);
    expect(dto.nextCursor).toBeNull();
    expect(dto.retention).toEqual({ days: 90, cutoff: '2026-08-08T00:00:00.000Z' });
  });

  it('maps a grouped page with a cursor and a null retention cutoff', () => {
    const page: RawPlannerFindingGroupPage = {
      groups: [{ fingerprint: 'fp_1', count: 1, planIds: ['plan_1'], latest: RAW }],
      nextCursor: 'cursor_2',
      retention: { days: 90, cutoff: null },
    };
    const dto = toPlannerFindingGroupListDTO(page);
    expect(dto.groups).toHaveLength(1);
    expect(dto.groups[0]).toMatchObject({ findingCount: 1, planCount: 1 });
    expect(dto.nextCursor).toBe('cursor_2');
    expect(dto.retention).toEqual({ days: 90, cutoff: null });
  });
});

describe('toPlannerFindingTriagePatch', () => {
  it('attribution sends the attribution and the text it was given, no status', () => {
    expect(
      toPlannerFindingTriagePatch({
        kind: 'attribution',
        attribution: 'code',
        why: 'The walker skipped it.',
        hostedCell: 'leaf.code',
      }),
    ).toEqual({ attribution: 'code', why: 'The walker skipped it.', hostedCell: 'leaf.code' });
  });

  it('attribution omits blank optionals rather than sending an empty string', () => {
    expect(
      toPlannerFindingTriagePatch({
        kind: 'attribution',
        attribution: 'model',
        why: '',
        planpyCell: '  ',
        fixDirection: 'Tighten the prompt.',
      }),
    ).toEqual({ attribution: 'model', fixDirection: 'Tighten the prompt.' });
  });

  it('promote sends the promoted status with the lesson id only', () => {
    expect(toPlannerFindingTriagePatch({ kind: 'promote', lessonId: 'lsn_1' })).toEqual({
      status: 'promoted_to_lesson',
      lessonId: 'lsn_1',
    });
  });

  it('bug sends the filed status with the bug key only', () => {
    expect(toPlannerFindingTriagePatch({ kind: 'bug', bugKey: 'MOTIR-42' })).toEqual({
      status: 'filed_as_bug',
      bugKey: 'MOTIR-42',
    });
  });

  it('dismiss sends the note only when one was given', () => {
    expect(toPlannerFindingTriagePatch({ kind: 'dismiss', note: 'Duplicate.' })).toEqual({
      status: 'dismissed',
      note: 'Duplicate.',
    });
    expect(toPlannerFindingTriagePatch({ kind: 'dismiss' })).toEqual({ status: 'dismissed' });
  });

  it('restore sends status new and nothing else', () => {
    expect(toPlannerFindingTriagePatch({ kind: 'restore' })).toEqual({ status: 'new' });
  });
});

describe('toPlannerFindingAuditMetadata', () => {
  const AUDIT: RawPlannerFindingAudit = {
    action: 'ai.planner_finding.triage',
    findingId: 'pf_1',
    actorCoreUserId: 'user_1',
    at: '2026-11-02T00:00:00.000Z',
    before: { status: 'new', lessonId: null },
    after: { status: 'promoted_to_lesson', lessonId: 'lsn_1' },
  };

  it('copies before and after unchanged', () => {
    expect(toPlannerFindingAuditMetadata(AUDIT)).toEqual({
      findingId: 'pf_1',
      before: { status: 'new', lessonId: null },
      after: { status: 'promoted_to_lesson', lessonId: 'lsn_1' },
    });
  });

  it('maps a side that is not an object to an empty object', () => {
    const odd = { ...AUDIT, before: null, after: ['x'] } as unknown as RawPlannerFindingAudit;
    expect(toPlannerFindingAuditMetadata(odd)).toEqual({
      findingId: 'pf_1',
      before: {},
      after: {},
    });
  });
});
