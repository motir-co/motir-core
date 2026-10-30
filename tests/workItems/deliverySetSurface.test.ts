import { describe, expect, it } from 'vitest';
import { amendRepoDeliveryWithSet } from '@/lib/workItems/deliverySet';
import { mergePullRequestRows } from '@/components/github/DevelopmentSection';
import type { RepoDelivery } from '@/lib/workItems/repoDelivery';
import type { LinkedPullRequestDto, WorkItemDeliveryDto } from '@/lib/dto/github';

// The DELIVERY SET's two PURE surface rules (Story MOTIR-3655 · MOTIR-3660,
// design `design/work-items/delivery-set.mock.html`):
//
//   1. `amendRepoDeliveryWithSet` — the glyph's amended PREDICATE. A repository
//      reads `delivered` only when neither completion gate holds on it, so the
//      rail can no longer assert finished about a card the gate is refusing to
//      finish. That is the design's CHANGE 1 and the reason MOTIR-3660 stopped.
//   2. `mergePullRequestRows` — which rows the Development section draws while
//      BOTH the singular column and the delivery table are written, and which of
//      them merged onto a base that is not their trunk.
//
// Both are asserted over LISTS rather than through rendered markup: ordering,
// identity and the empty case are what matter here, and asserting them through
// the DOM measures the DOM.

function repo(name: string, state: RepoDelivery['state'], primary = false): RepoDelivery {
  return { repo: name, state, primary };
}

function pr(
  repoLabel: string,
  number: number,
  over: Partial<LinkedPullRequestDto> = {},
): LinkedPullRequestDto {
  return {
    id: `pr-${repoLabel}-${number}`,
    title: `pull ${number}`,
    repo: repoLabel,
    number,
    state: 'open',
    ci: null,
    headSha: null,
    url: `https://github.com/${repoLabel}/pull/${number}`,
    githubReview: null,
    preview: null,
    baseRef: 'main',
    conflicted: false,
    ...over,
  };
}

function delivery(
  repoLabel: string,
  number: number,
  over: Partial<WorkItemDeliveryDto> & { pr?: Partial<LinkedPullRequestDto> } = {},
): WorkItemDeliveryDto {
  const { pr: prOver, ...rest } = over;
  return {
    pullRequest: pr(repoLabel, number, prOver),
    baseRef: 'main',
    defaultBranch: 'main',
    queueExit: null,
    mergeRefusal: null,
    ...rest,
  };
}

describe('the glyph reads DELIVERED only when neither gate holds', () => {
  it('WEAKENS the case the shipped vocabulary got wrong — two pull requests, one repository, one still open', () => {
    // The design's panel 1, and the whole reason MOTIR-3660 stopped rather than
    // drawing itself. `classifyRepoDelivery` says `delivered` because a linked
    // pull request DID merge onto the trunk — truthfully — while
    // `deferred_incomplete_delivery_set` holds the card for the second one.
    const amended = amendRepoDeliveryWithSet(
      [repo('motir-core', 'delivered', true)],
      [
        delivery('moooon/motir-core', 1, { pr: { state: 'merged' } }),
        delivery('moooon/motir-core', 2, { pr: { state: 'open' } }),
      ],
    );

    expect(amended).toEqual([{ repo: 'motir-core', state: 'awaiting', primary: true }]);
  });

  it('leaves the row DELIVERED when every delivery landed on that trunk', () => {
    const amended = amendRepoDeliveryWithSet(
      [repo('motir-core', 'delivered', true)],
      [
        delivery('moooon/motir-core', 1, { pr: { state: 'merged' } }),
        delivery('moooon/motir-core', 2, { pr: { state: 'merged' } }),
      ],
    );

    expect(amended[0]?.state).toBe('delivered');
  });

  it('compares against THAT repository’s own trunk, never a hard-coded main', () => {
    // A self-hoster's trunk is `master` or `trunk`. A hard-coded comparison
    // would call this merge stranded and weaken a row that is finished.
    const amended = amendRepoDeliveryWithSet(
      [repo('motir-ai', 'delivered')],
      [
        delivery('moooon/motir-ai', 7, {
          pr: { state: 'merged' },
          baseRef: 'trunk',
          defaultBranch: 'trunk',
        }),
      ],
    );

    expect(amended[0]?.state).toBe('delivered');
  });

  it('weakens to UNKNOWN — not awaiting — when a merge has no recorded base', () => {
    // The two say different things to a reader: awaiting is work that has not
    // arrived, unknown is a question only an operator can answer.
    const amended = amendRepoDeliveryWithSet(
      [repo('motir-core', 'delivered')],
      [delivery('moooon/motir-core', 1, { pr: { state: 'merged' }, baseRef: null })],
    );

    expect(amended[0]?.state).toBe('unknown');
  });

  it('weakens a STRANDED merge, which today renders identically to a delivered one', () => {
    const amended = amendRepoDeliveryWithSet(
      [repo('motir-core', 'delivered')],
      [delivery('moooon/motir-core', 1, { pr: { state: 'merged' }, baseRef: 'release/1.4' })],
    );

    expect(amended[0]?.state).toBe('awaiting');
  });

  it('NEVER promotes — a repository the classifier held stays held', () => {
    // A delivery is evidence about a pull request; `awaiting`, `unestablished`
    // and `excluded` are claims about the REPOSITORY, and no pull request can
    // overturn them. This is the direction that would close a card early.
    const rows = [
      repo('a', 'awaiting'),
      repo('b', 'unestablished'),
      repo('c', 'excluded'),
      repo('d', 'unknown'),
    ];
    const amended = amendRepoDeliveryWithSet(
      rows,
      rows.map((r, i) => delivery(`moooon/${r.repo}`, i, { pr: { state: 'merged' } })),
    );

    expect(amended.map((r) => r.state)).toEqual([
      'awaiting',
      'unestablished',
      'excluded',
      'unknown',
    ]);
  });

  it('returns the set UNCHANGED when the card has no deliveries — nearly every card', () => {
    const rows = [repo('motir-core', 'delivered', true), repo('motir-ai', 'awaiting')];
    expect(amendRepoDeliveryWithSet(rows, [])).toEqual(rows);
  });

  it('leaves a repository the delivery set says nothing about alone', () => {
    // A card spanning two repositories with a delivery in only one of them: the
    // other keeps whatever the classifier decided.
    const amended = amendRepoDeliveryWithSet(
      [repo('motir-core', 'delivered', true), repo('motir-ai', 'delivered')],
      [delivery('moooon/motir-core', 1, { pr: { state: 'open' } })],
    );

    expect(amended.map((r) => r.state)).toEqual(['awaiting', 'delivered']);
  });
});

describe('the Development rows are the UNION of the two live sources', () => {
  it('draws a delivery the singular column could never have named', () => {
    // A `motir auto` pull request delivers twelve cards; `work_item_id` holds
    // one of them. On the other eleven cards this row exists ONLY in the
    // delivery table, and dropping it is how the surface came to show a card no
    // pull request at all.
    const rows = mergePullRequestRows([], [delivery('moooon/motir-core', 42)]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.number).toBe(42);
  });

  it('draws a column row the delivery table has not been told about', () => {
    // `historicalPullRequestBackfillService` resolves a card by parsing the
    // title and writes only the column. Until MOTIR-3672 retires the parse,
    // those rows exist on one side alone.
    const rows = mergePullRequestRows([pr('moooon/motir-core', 9)], []);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.number).toBe(9);
  });

  it('draws a pull request in BOTH sources exactly ONCE, keeping the column order', () => {
    const rows = mergePullRequestRows(
      [pr('moooon/motir-core', 1), pr('moooon/motir-ai', 2)],
      [delivery('moooon/motir-ai', 2), delivery('moooon/motir-core', 1)],
    );

    expect(rows.map((r) => r.number)).toEqual([1, 2]);
  });

  it('treats a repository-name CASE difference as the same pull request', () => {
    // The two sides are written by different tables and a git host is
    // case-insensitive about repository names. Two rows for one pull request is
    // the surface saying a card is delivered twice.
    const rows = mergePullRequestRows(
      [pr('moooon-B-V/motir-core', 5)],
      [delivery('moooon-b-v/motir-core', 5)],
    );

    expect(rows).toHaveLength(1);
  });

  it('marks a merge onto a base that is NOT the trunk, and nothing else', () => {
    const rows = mergePullRequestRows(
      [],
      [
        delivery('moooon/motir-core', 1, { pr: { state: 'merged' }, baseRef: 'release/1.4' }),
        delivery('moooon/motir-core', 2, { pr: { state: 'merged' } }),
        delivery('moooon/motir-core', 3, { pr: { state: 'open' }, baseRef: 'release/1.4' }),
        delivery('moooon/motir-core', 4, { pr: { state: 'merged' }, baseRef: null }),
      ],
    );

    // Merged onto a side branch — the one new pill.
    expect(rows[0]?.strandedBase).toBe('release/1.4');
    // Merged onto its trunk.
    expect(rows[1]?.strandedBase).toBeNull();
    // Still OPEN. It targets a side branch, but it has delivered nothing at all
    // yet, so "not on trunk" would be the wrong thing to say about it.
    expect(rows[2]?.strandedBase).toBeNull();
    // Merged with NO recorded base. Unknown is not stranded — claiming it landed
    // off-trunk asserts something nobody recorded.
    expect(rows[3]?.strandedBase).toBeNull();
  });

  it('carries the delivery’s base facts onto a row the COLUMN supplied', () => {
    // The DTO has no `baseRef`, so a row that exists on both sides has to take
    // that half from the delivery or the pill could never appear on it.
    const rows = mergePullRequestRows(
      [pr('moooon/motir-core', 1, { state: 'merged' })],
      [delivery('moooon/motir-core', 1, { pr: { state: 'merged' }, baseRef: 'release/1.4' })],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.strandedBase).toBe('release/1.4');
  });
});
