import { describe, expect, it } from 'vitest';
import { toLinkedPullRequestDto } from '@/lib/mappers/githubMappers';

// THE LINKED PULL REQUEST'S `ci` IS READ AT ITS `headSha` (Bug MOTIR-11932).
//
// The DTO carries two fields about one commit: `headSha` (the stored host head,
// `pullRequestHead`) and `ci`. `ci` used to be `derivePrCiState` over every check row —
// the verdict at the NEWEST CHECK-ROW sha — so for the minutes between a push and the new
// commit's first check row the pair read `{ ci: 'failing', headSha: <new> }` with the
// PREVIOUS commit's red (motir-codegraph#42 @ 6a3c980, 2026-11-20). The Development pill,
// the v1 delivery set and the CLI's CI watch all read that pair. `ci` is now
// `prCiStateAtHead`: `null` until something reports at the stored head.

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

let seq = 0;
function check(commitSha: string, conclusion: string, checkName = 'CI complete') {
  seq += 1;
  const at = new Date(Date.UTC(2026, 10, 20, 15, 0, seq));
  return {
    id: `c${seq}`,
    pullRequestId: 'pr-1',
    commitSha,
    checkName,
    conclusion,
    status: conclusion === 'pending' ? 'in_progress' : 'completed',
    checkSuiteId: '',
    createdAt: at,
    updatedAt: at,
    conclusionAt: at,
  };
}

function row(headSha: string | null, checkRuns: ReturnType<typeof check>[]) {
  return {
    id: 'pr-1',
    title: 'A change',
    headRef: 'subtask/x',
    baseRef: 'main',
    number: 42,
    state: 'open',
    merged: false,
    mergeOutcomeRef: null,
    headSha,
    mergeableState: null,
    mergeableStateHeadSha: null,
    mergeOutcomeRef: null,
    repo: { owner: 'acme', name: 'web' },
    checkRuns,
  } as unknown as Parameters<typeof toLinkedPullRequestDto>[0];
}

const pair = (r: ReturnType<typeof row>) => {
  const dto = toLinkedPullRequestDto(r);
  return { ci: dto.ci, headSha: dto.headSha };
};

describe('LinkedPullRequestDto.ci at the stored head (MOTIR-11932)', () => {
  it("a pushed head with no check rows is `null`, not the previous commit's red", () => {
    // The card's reproduction, as a unit: rows only at the old commit, head moved on.
    expect(pair(row(NEW, [check(OLD, 'failure')]))).toEqual({ ci: null, headSha: NEW });
  });

  it("…nor the previous commit's green", () => {
    expect(pair(row(NEW, [check(OLD, 'success'), check(OLD, 'success', 'Lint')]))).toEqual({
      ci: null,
      headSha: NEW,
    });
  });

  it.each([
    ['failing', 'failure'],
    ['running', 'pending'],
    ['passing', 'success'],
  ])('reads `%s` once a row exists at the head, whatever the older commit said', (ci, at) => {
    const older = at === 'failure' ? 'success' : 'failure';
    expect(pair(row(NEW, [check(OLD, older), check(NEW, at)]))).toEqual({ ci, headSha: NEW });
  });

  it("the head's own verdict is judged over the head's rows only", () => {
    // A red OLD row must not leak into a head where one check passed and one runs.
    expect(
      pair(row(NEW, [check(OLD, 'failure'), check(NEW, 'success'), check(NEW, 'pending', 'E2E')])),
    ).toEqual({ ci: 'running', headSha: NEW });
  });

  it('a row with no stored head keeps the old fallback — the newest check-row sha', () => {
    expect(pair(row(null, [check(OLD, 'failure'), check(NEW, 'success')]))).toEqual({
      ci: 'passing',
      headSha: NEW,
    });
    expect(pair(row(null, [check(OLD, 'success'), check(NEW, 'failure')]))).toEqual({
      ci: 'failing',
      headSha: NEW,
    });
  });

  it('no rows and no stored head is `null` for both', () => {
    expect(pair(row(null, []))).toEqual({ ci: null, headSha: null });
  });
});
