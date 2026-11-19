import { describe, expect, it } from 'vitest';
import { derivePrCiState, liveRowsAtLatestSha, type PrCheckRunSlice } from '@/lib/github/prCiState';

// Story 7.10 · MOTIR-1579 — the per-PR CI derivation behind the Development
// surface's CI pill. Pure unit: precedence (failing > running > passing) at
// the LATEST recorded sha, the sha window itself, and the null cases (no rows
// / no known conclusion → NO pill, absence of CI is not a state).
//
// MOTIR-3209 added the second window: within the latest sha, only the workflow
// RUNS that have not been replaced. The cases below carry the row fields that
// rule reads — every one of them the no-run-identity shape (`checkSuiteId: ''`,
// one check name), which is a single group and so derives exactly what it did
// before. The supersession cases proper are the last block.

function run(
  commitSha: string,
  conclusion: string,
  createdAt: string,
  suite = '',
  checkName = 'check',
): PrCheckRunSlice {
  return {
    commitSha,
    conclusion,
    createdAt: new Date(createdAt),
    checkName,
    checkSuiteId: suite,
    conclusionAt: null,
  };
}

describe('derivePrCiState (MOTIR-1579)', () => {
  it('returns null for no rows (no CI pill — absence is not a state)', () => {
    expect(derivePrCiState([])).toBeNull();
  });

  it('all success at the head sha → passing', () => {
    expect(
      derivePrCiState([
        run('sha1', 'success', '2026-07-01T10:00:00Z'),
        run('sha1', 'success', '2026-07-01T10:01:00Z'),
      ]),
    ).toBe('passing');
  });

  it('any failure wins over pending AND success (failing > running > passing)', () => {
    expect(
      derivePrCiState([
        run('sha1', 'success', '2026-07-01T10:00:00Z'),
        run('sha1', 'pending', '2026-07-01T10:01:00Z'),
        run('sha1', 'failure', '2026-07-01T10:02:00Z'),
      ]),
    ).toBe('failing');
  });

  it('pending wins over success (a half-finished suite is running, not passing)', () => {
    expect(
      derivePrCiState([
        run('sha1', 'success', '2026-07-01T10:00:00Z'),
        run('sha1', 'pending', '2026-07-01T10:01:00Z'),
      ]),
    ).toBe('running');
  });

  it("derives at the LATEST sha only — an old sha's failure never haunts a new push", () => {
    expect(
      derivePrCiState([
        run('shaOld', 'failure', '2026-07-01T10:00:00Z'),
        run('shaNew', 'pending', '2026-07-01T11:00:00Z'),
      ]),
    ).toBe('running');
  });

  it('the sha window keys on first sighting (createdAt) — a re-run on an old sha never outranks a newer push', () => {
    // The old sha's row was UPDATED after the new push (a re-run refreshes
    // updatedAt, not createdAt) — createdAt ordering keeps shaNew the head.
    expect(
      derivePrCiState([
        run('shaNew', 'success', '2026-07-01T11:00:00Z'),
        run('shaOld', 'failure', '2026-07-01T10:00:00Z'),
      ]),
    ).toBe('passing');
  });

  it('a NEW row for an OLD sha does not move the head — the sha first seen LAST is the head (MOTIR-5604)', () => {
    // A check name the old commit had not reported before arrives after the push:
    // the ingestion INSERTS it, so it is the newest row in the table. The head is
    // still the commit that was first sighted most recently.
    const rows = [
      run('shaOld', 'success', '2026-07-01T10:00:00Z', '', 'ci'),
      run('shaNew', 'success', '2026-07-01T11:00:00Z', '', 'ci'),
      run('shaOld', 'failure', '2026-07-01T11:30:00Z', '', 'late-check'),
    ];
    expect(derivePrCiState(rows)).toBe('passing');
    expect(liveRowsAtLatestSha(rows).map((r) => r.commitSha)).toEqual(['shaNew']);
  });

  it('rows with no known conclusion at the head sha → null', () => {
    expect(derivePrCiState([run('sha1', 'neutral', '2026-07-01T10:00:00Z')])).toBeNull();
  });
});

describe('within the head sha, a REPLACED run does not vote (MOTIR-3209)', () => {
  it("a cancelled run's phantom matrix name cannot outlive the run that replaced it", () => {
    // The PR #2192 shape: run A is cancelled before its matrix expands, so it
    // reports the literal template — a name run B can never overwrite, because
    // B's leg is called `Vitest (1/3)`. B re-reports `TypeScript`, which is what
    // identifies it as the same workflow, so all of A is retired.
    expect(
      derivePrCiState([
        run('sha1', 'failure', '2026-08-20T02:05:30Z', 'A', 'TypeScript'),
        run('sha1', 'failure', '2026-08-20T02:06:24Z', 'A', 'Vitest (${{ matrix.shard }})'),
        run('sha1', 'success', '2026-08-20T02:06:10Z', 'B', 'TypeScript'),
        run('sha1', 'success', '2026-08-20T02:26:00Z', 'B', 'Vitest (1/3)'),
      ]),
    ).toBe('passing');
  });

  it('supersedes per WORKFLOW, not per sha — an unrelated suite keeps its vote', () => {
    // CodeQL shares no check name with CI, so a CI re-run cannot hide it.
    expect(
      derivePrCiState([
        run('sha1', 'failure', '2026-08-20T02:05:30Z', 'ci-a', 'TypeScript'),
        run('sha1', 'failure', '2026-08-20T02:05:31Z', 'codeql', 'Analyze'),
        run('sha1', 'success', '2026-08-20T02:06:10Z', 'ci-b', 'TypeScript'),
      ]),
    ).toBe('failing');
  });

  it('orders runs by the HOST’s suite id, not by when the webhook reached us', () => {
    // The cancelled run's rows are recorded LAST here — a webhook backlog, which
    // is ordinary — and it is still the older run, because the host minted its
    // suite id first. Ordering on `createdAt` would hand the verdict straight
    // back to the run this rule exists to retire.
    expect(
      derivePrCiState([
        run('sha1', 'success', '2026-08-20T02:06:10Z', '87626227873', 'TypeScript'),
        run('sha1', 'failure', '2026-08-20T02:09:00Z', '87626130152', 'TypeScript'),
      ]),
    ).toBe('passing');
  });

  it('a run replaced while still PENDING stops making the PR look busy', () => {
    expect(
      derivePrCiState([
        run('sha1', 'pending', '2026-08-20T02:05:30Z', 'A', 'TypeScript'),
        run('sha1', 'success', '2026-08-20T02:06:10Z', 'B', 'TypeScript'),
      ]),
    ).toBe('passing');
  });

  it('rows with NO run identity are one group — today’s answer, unchanged', () => {
    // What every row written before the column existed degrades to, and what a
    // legacy commit-`status` event still produces.
    expect(
      derivePrCiState([
        run('sha1', 'failure', '2026-07-01T10:00:00Z', '', 'lint'),
        run('sha1', 'success', '2026-07-01T10:01:00Z', '', 'build'),
      ]),
    ).toBe('failing');
  });

  it('a real run REPLACES the no-identity group when it re-reports one of its names', () => {
    // The migration boundary on a live pull request: rows recorded before the
    // column existed, then the same workflow reporting again with its suite.
    expect(
      derivePrCiState([
        run('sha1', 'failure', '2026-07-01T10:00:00Z', '', 'TypeScript'),
        run('sha1', 'success', '2026-07-01T10:05:00Z', 'B', 'TypeScript'),
      ]),
    ).toBe('passing');
  });
});
