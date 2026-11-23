import { describe, expect, it } from 'vitest';
import { toDispatchRunRepairDto } from '@/lib/mappers/dispatchRunMappers';

// `toDispatchRunRepairDto` reads a HOSTED `fix` run's `run_opened` data as what it
// repairs (MOTIR-6929). The hosted repair claim writes that JSON
// (`hostedRepairOpenedData`); a LOCAL repair's `run_opened` is the CLI's and records no
// class. Every field is read defensively: an unreadable class reads the whole decision
// as null (never a guess), an unreadable pull request is dropped rather than half-read,
// and unreadable findings read as none.

const FINDINGS_MD = '1. The export drops the header row.\n\n  Fix before merge.  ';

const HOSTED_REVIEW = {
  command: 'fix',
  key: 'ACME-7',
  title: 'Export the list as CSV',
  origin: 'hosted',
  model: 'anthropic/claude',
  repairClass: 'review',
  findings: {
    gate: 'agent_review',
    gateId: 'gate_1',
    subjectVersion: 'acme/web#12@' + 'c'.repeat(40),
    findingsMd: FINDINGS_MD,
    reviewerName: 'Motir review agent',
    decidedByLabel: 'Yue Zhu <yue@example.com>',
    decidedUnderAuthority: 'review_agent',
    decidedAt: '2026-09-29T10:00:00.000Z',
  },
  acceptanceRefusal: null,
  pullRequests: [
    {
      repo: 'acme/web',
      number: 12,
      url: 'https://github.com/acme/web/pull/12',
      branch: 'subtask/acme-7',
      headRef: 'subtask/acme-7',
      baseRef: 'main',
      headSha: 'c'.repeat(40),
      ci: 'passing',
      conflicted: false,
      outOfDate: false,
    },
  ],
};

describe('toDispatchRunRepairDto', () => {
  it('maps a hosted review repair: the class, every pull request on its branch, the findings verbatim', () => {
    expect(toDispatchRunRepairDto(HOSTED_REVIEW)).toEqual({
      repairClass: 'review',
      title: 'Export the list as CSV',
      pullRequests: [
        {
          repo: 'acme/web',
          number: 12,
          url: 'https://github.com/acme/web/pull/12',
          branch: 'subtask/acme-7',
          baseRef: 'main',
          headSha: 'c'.repeat(40),
          conflicted: false,
          outOfDate: false,
        },
      ],
      findings: {
        gate: 'agent_review',
        gateId: 'gate_1',
        subjectVersion: 'acme/web#12@' + 'c'.repeat(40),
        // Never trimmed or re-read.
        findingsMd: FINDINGS_MD,
        reviewerName: 'Motir review agent',
        decidedByLabel: 'Yue Zhu <yue@example.com>',
        decidedUnderAuthority: 'review_agent',
        decidedAt: '2026-09-29T10:00:00.000Z',
      },
      resume: null,
    });
  });

  it.each([null, undefined, {}, { command: 'fix', key: 'ACME-7' }])(
    'a run_opened with no class (%s — a LOCAL repair’s) reads as null',
    (data) => {
      expect(toDispatchRunRepairDto(data)).toBeNull();
    },
  );

  it.each([42, 'deploy', ''])(
    'an unknown class (%s) reads as null, never a guess',
    (repairClass) => {
      expect(toDispatchRunRepairDto({ ...HOSTED_REVIEW, repairClass })).toBeNull();
    },
  );

  it.each(['ci', 'acceptance_rerun'] as const)(
    'the %s class maps with no findings and an empty title when none was recorded',
    (repairClass) => {
      expect(
        toDispatchRunRepairDto({ repairClass, title: '', pullRequests: 'not a list' }),
      ).toEqual({ repairClass, title: null, pullRequests: [], findings: null, resume: null });
    },
  );

  it('falls back to headRef for the branch, and reads a missing base and head as null', () => {
    const dto = toDispatchRunRepairDto({
      repairClass: 'ci',
      pullRequests: [
        { repo: 'acme/api', number: 3, url: 'https://github.com/acme/api/pull/3', headRef: 'x/y' },
      ],
    });
    expect(dto?.pullRequests).toEqual([
      {
        repo: 'acme/api',
        number: 3,
        url: 'https://github.com/acme/api/pull/3',
        branch: 'x/y',
        baseRef: null,
        headSha: null,
        conflicted: false,
        outOfDate: false,
      },
    ]);
  });

  // Bug MOTIR-12096: the claim's mergeability rides its recorded decision, so an adopted
  // repair (hosted, or in the person's own agent) can take the base-merge turn.
  it.each([
    [
      { conflicted: true, outOfDate: false },
      { conflicted: true, outOfDate: false },
    ],
    [
      { conflicted: false, outOfDate: true },
      { conflicted: false, outOfDate: true },
    ],
    [
      { conflicted: true, outOfDate: true },
      { conflicted: true, outOfDate: true },
    ],
  ])('reads the recorded mergeability %o as %o', (recorded, read) => {
    const good = HOSTED_REVIEW.pullRequests[0]!;
    const dto = toDispatchRunRepairDto({
      repairClass: 'ci',
      pullRequests: [{ ...good, ...recorded }],
    });
    expect(dto?.pullRequests[0]).toMatchObject(read);
  });

  it.each([
    ['absent — a run opened before the claim kept it', {}],
    ['not a boolean', { conflicted: 'true', outOfDate: 1 }],
    ['null', { conflicted: null, outOfDate: null }],
  ])('reads mergeability that is %s as neither, never a guess', (_label, recorded) => {
    const { conflicted: _c, outOfDate: _o, ...legacy } = HOSTED_REVIEW.pullRequests[0]!;
    const dto = toDispatchRunRepairDto({
      repairClass: 'ci',
      pullRequests: [{ ...legacy, ...recorded }],
    });
    expect(dto?.pullRequests[0]).toMatchObject({ conflicted: false, outOfDate: false });
  });

  it('drops a pull request it cannot fully read — never hands a container a half-read branch', () => {
    const good = HOSTED_REVIEW.pullRequests[0]!;
    const dto = toDispatchRunRepairDto({
      repairClass: 'review',
      pullRequests: [
        null,
        { ...good, repo: '' },
        { ...good, branch: undefined, headRef: 7 },
        { ...good, url: null },
        { ...good, number: '12' },
        good,
      ],
    });
    expect(dto?.pullRequests.map((p) => p.number)).toEqual([12]);
  });

  it.each([
    ['not an object', 'text'],
    ['an unknown gate', { ...HOSTED_REVIEW.findings, gate: 'design_result' }],
    ['a gate that is not a string', { ...HOSTED_REVIEW.findings, gate: 1 }],
    ['no decidedAt', { ...HOSTED_REVIEW.findings, decidedAt: '' }],
  ])('findings with %s read as none', (_label, findings) => {
    expect(toDispatchRunRepairDto({ ...HOSTED_REVIEW, findings })?.findings).toBeNull();
  });

  it('a person’s refusal keeps its gate; every optional field reads null when unreadable', () => {
    expect(
      toDispatchRunRepairDto({
        ...HOSTED_REVIEW,
        findings: { gate: 'pull_request_approval', decidedAt: '2026-09-29T10:00:00.000Z' },
      })?.findings,
    ).toEqual({
      gate: 'pull_request_approval',
      gateId: null,
      subjectVersion: null,
      findingsMd: null,
      reviewerName: null,
      decidedByLabel: null,
      decidedUnderAuthority: null,
      decidedAt: '2026-09-29T10:00:00.000Z',
    });
  });
});
