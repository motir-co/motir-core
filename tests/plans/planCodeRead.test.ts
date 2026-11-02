import { describe, expect, it } from 'vitest';
import {
  parsePlanCodeRead,
  parsePlanCodeReads,
  PlanCodeReadRefusal,
  PLAN_CODE_READ_COMMITS_MAX,
  PLAN_CODE_READ_FIELD_MAX,
} from '@/lib/plans/planCodeRead';
import { summarizePlanCodeReads } from '@/lib/mcp/tools/getPlanCodeReads';
import type { PlanCodeReadDto } from '@/lib/dto/plans';

// The pure half of a planner session's CODE READS (MOTIR-10122): the parser every
// stored read goes through, and the read-back's summary. The store and the doors
// are proven over Postgres in `tests/integration/plans/planCodeRead.test.ts`.

const SHA = 'ABCDEF0123456789abcdef0123456789abcdef01';
const base = { tool: 'read_file', outcome: 'found' };

describe('parsePlanCodeRead', () => {
  it('keeps what was asked, lower-cases the sha, drops a false dirty, and caps strings', () => {
    const long = 'q'.repeat(PLAN_CODE_READ_FIELD_MAX.query + 5);
    expect(
      parsePlanCodeRead({
        ...base,
        repo: ' acme/web ',
        query: long,
        askedRef: '\u0000main',
        commits: [
          { sha: SHA, dirty: false },
          { repo: 'web', sha: SHA, dirty: true },
        ],
      }),
    ).toEqual({
      tool: 'read_file',
      repo: 'acme/web',
      path: null,
      startLine: null,
      endLine: null,
      askedRef: 'main',
      query: `${'q'.repeat(PLAN_CODE_READ_FIELD_MAX.query - 1)}…`,
      commits: [{ sha: SHA.toLowerCase() }, { repo: 'web', sha: SHA.toLowerCase(), dirty: true }],
      outcome: 'found',
      lines: null,
      hits: null,
      detail: null,
    });
  });

  it('accepts a two-word local tool and a blank optional field as absent', () => {
    expect(parsePlanCodeRead({ ...base, tool: 'git show', path: '   ' })).toMatchObject({
      tool: 'git show',
      path: null,
    });
  });

  it.each([
    ['a non-object read', 'nope', /must be an object\./],
    ['an array read', [], /must be an object\./],
    ['file text', { ...base, text: 'x' }, /never the code/],
    ['file content', { ...base, content: 'x' }, /never the code/],
    ['a non-string field', { ...base, path: 7 }, /\.path must be a string/],
    ['a fractional count', { ...base, lines: 1.5 }, /\.lines must be an integer of at least 0/],
    [
      'a zero line number',
      { ...base, startLine: 0 },
      /\.startLine must be an integer of at least 1/,
    ],
    ['a range ending first', { ...base, startLine: 9, endLine: 3 }, /endLine must not be before/],
    ['a tool sentence', { ...base, tool: 'read the file now' }, /\.tool must name the tool/],
    ['no outcome', { tool: 'Read' }, /\.outcome must be/],
    ['a branch name for a sha', { ...base, commits: [{ sha: 'main' }] }, /never a branch name/],
    ['a numeric sha', { ...base, commits: [{ sha: 1234567 }] }, /never a branch name/],
    ['a non-object commit', { ...base, commits: ['abc1234'] }, /must be an object \{ repo\?/],
    [
      'a non-boolean dirty',
      { ...base, commits: [{ sha: SHA, dirty: 'yes' }] },
      /dirty must be a boolean/,
    ],
    ['commits not a list', { ...base, commits: { sha: SHA } }, /commits must be an array/],
    [
      'too many commits',
      {
        ...base,
        commits: Array.from({ length: PLAN_CODE_READ_COMMITS_MAX + 1 }, () => ({ sha: SHA })),
      },
      /commits must be an array of at most/,
    ],
  ])('refuses %s, naming the field', (_label, raw, message) => {
    expect(() => parsePlanCodeRead(raw, 'codeReads[3]')).toThrow(PlanCodeReadRefusal);
    expect(() => parsePlanCodeRead(raw, 'codeReads[3]')).toThrow(message);
  });

  it('a whole batch is refused when empty, not a list, or any read is bad', () => {
    expect(() => parsePlanCodeReads([])).toThrow(/1 to 50 reads/);
    expect(() => parsePlanCodeReads('x')).toThrow(/1 to 50 reads/);
    expect(() => parsePlanCodeReads([base, { tool: 'Read' }])).toThrow(/codeReads\[1\]\.outcome/);
    expect(parsePlanCodeReads([base])).toHaveLength(1);
  });
});

function dto(over: Partial<PlanCodeReadDto>): PlanCodeReadDto {
  return {
    seq: 1,
    sessionKey: 's',
    tool: 'Glob',
    repo: null,
    path: null,
    startLine: null,
    endLine: null,
    askedRef: null,
    query: null,
    commits: [],
    outcome: 'ok',
    lines: null,
    hits: null,
    detail: null,
    createdAt: '2026-10-30T00:00:00.000Z',
    ...over,
  };
}

describe('summarizePlanCodeReads', () => {
  it('prints an open range, a bare tool, and a step with no target', () => {
    const text = summarizePlanCodeReads({
      planId: 'p',
      reads: [
        dto({ tool: 'Read', repo: 'web', path: 'a.ts', startLine: 5 }),
        dto({ seq: 2, query: '**/*.ts', hits: 12 }),
      ],
      sessions: [
        {
          sessionKey: 's',
          stepKind: 'lay',
          targetRef: null,
          targetTitle: null,
          firstReportedAt: '2026-10-30T00:00:00.000Z',
          updatedAt: '2026-10-30T00:00:00.000Z',
        },
      ],
      nextAfterSeq: null,
    });
    expect(text).toContain('Session s — lay:');
    expect(text).toContain('  #1 Read web a.ts:5- · at no commit resolved · ok');
    expect(text).toContain('  #2 Glob "**/*.ts" · at no commit resolved · ok (12 hits)');
  });

  it('an empty middle page says "on this page"', () => {
    expect(summarizePlanCodeReads({ planId: 'p', reads: [], sessions: [], nextAfterSeq: 5 })).toBe(
      'Plan p: no code reads recorded on this page.',
    );
  });
});
