import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { closeOutContainer, ensureRepoPullRequest } from '../src/commands/auto.js';
import {
  deliveredContainerKey,
  sessionPrScope,
  sessionPrTitle,
  type AutoSummary,
  type DispatchRecord,
  type PrReport,
  type RepoSession,
} from '../src/autoLoop.js';
import { ContainerHasOpenChildrenError, CliError } from '../src/errors.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { MotirClient } from '../src/client.js';

// The STORY BINDING (MOTIR-4969) — what a session pull request DELIVERS, and
// when the container it delivers is told it is built.
//
// ── Why every assertion here is keyed on an ARM and not on a command ───────
// The rule this file pins was first written as "a scoped run links the story, an
// unscoped one links per card", and `motir run sprint` falsifies that in one
// line: it IS scoped and its ready set spans parents, so there is no story to
// name. What decides is the parent partition of the set the run CARRIED, which
// `sessionPrTitle` has computed since MOTIR-2422 to decide what to CALL the pull
// request. So the derivation is shared rather than copied, and the tests below
// drive the three arms directly — a per-command test would pass for the lane it
// was written against and say nothing about the one the bug is in.

const OK = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });

function record(over: Partial<DispatchRecord> & { key: string }): DispatchRecord {
  return {
    title: `Item ${over.key}`,
    outcome: 'integrated',
    durationMs: 1000,
    sessionBranch: 'motir/auto-x',
    repo: 'motir-core',
    parentKey: 'PROD-1',
    ...over,
  };
}

function pr(over: Partial<PrReport> = {}): PrReport {
  return {
    repoName: 'motir-core',
    branch: 'motir/auto-x',
    url: 'https://github.test/pull/9001',
    outcome: 'existing',
    ...over,
  };
}

function summaryOf(
  records: DispatchRecord[],
  prs: PrReport[],
  over: Partial<AutoSummary> = {},
): AutoSummary {
  return {
    runId: '20260910-010203',
    records,
    skipped: [],
    planning: [],
    repos: [],
    prs,
    approvals: [],
    lanes: [],
    stopReason: 'drained',
    ...over,
  };
}

interface FakeClient {
  client: MotirClient;
  links: { key: string; url?: string; headRef: string; baseRef: string }[];
  transitions: { key: string; status: string }[];
  /** Every call in ORDER, so an ordering claim is a measurement, not a guess. */
  calls: string[];
}

function fakeClient(
  over: {
    onLink?: (key: string) => Error | null;
    onTransition?: (key: string) => Error | null;
    /** The status the container reads as before the close-out writes. */
    status?: string;
  } = {},
): FakeClient {
  const links: FakeClient['links'] = [];
  const transitions: FakeClient['transitions'] = [];
  const calls: string[] = [];
  const client = {
    getWorkItem: async () => ({ item: { status: over.status ?? 'in_progress' } }),
    linkPullRequest: async (args: FakeClient['links'][number]) => {
      calls.push(`link:${args.key}`);
      links.push(args);
      const err = over.onLink?.(args.key);
      if (err) throw err;
      return undefined;
    },
    transitionStatus: async (args: { key: string; status: string }) => {
      calls.push(`transition:${args.key}:${args.status}`);
      transitions.push(args);
      const err = over.onTransition?.(args.key);
      if (err) throw err;
      return undefined;
    },
  } as unknown as MotirClient;
  return { client, links, transitions, calls };
}

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── the derivation, arm by arm ──────────────────────────────────────────────

describe('sessionPrScope — the three arms of the carried set', () => {
  it('ONE card is the deliverable itself, never its parent', () => {
    // The card is a leaf and its parent describes something much larger than
    // what shipped: naming the story would close it on one of its children.
    expect(sessionPrScope([record({ key: 'PROD-2' })])).toEqual({
      arm: 'one-card',
      key: 'PROD-2',
    });
  });

  it('N cards under ONE parent is that parent', () => {
    expect(
      sessionPrScope([
        record({ key: 'PROD-2' }),
        record({ key: 'PROD-3' }),
        record({ key: 'PROD-4' }),
      ]),
    ).toEqual({ arm: 'shared-parent', key: 'PROD-1' });
  });

  it('N cards under SEVERAL parents names none — the sprint case', () => {
    // ⚠️ THE CASE THE FIRST WORDING GOT WRONG. `motir run sprint` is scoped and
    // spans parents; a rule keyed on the command would have named a story here.
    expect(
      sessionPrScope([
        record({ key: 'PROD-2', parentKey: 'PROD-1' }),
        record({ key: 'PROD-9', parentKey: 'PROD-8' }),
      ]),
    ).toEqual({ arm: 'many-parents' });
  });

  it('a TOP-LEVEL card in the set counts as a distinct answer', () => {
    // A `null` parent is an answer, not a missing one — a set containing a
    // top-level card does not share a parent, so nothing here may name the story
    // the OTHERS happen to sit under.
    expect(
      sessionPrScope([
        record({ key: 'PROD-2', parentKey: 'PROD-1' }),
        record({ key: 'PROD-7', parentKey: null }),
      ]),
    ).toEqual({ arm: 'many-parents' });
    // …and a set of top-level cards alone has no container either.
    expect(
      sessionPrScope([
        record({ key: 'PROD-7', parentKey: null }),
        record({ key: 'PROD-8', parentKey: null }),
      ]),
    ).toEqual({ arm: 'many-parents' });
  });

  it('an EMPTY set delivers nothing', () => {
    expect(sessionPrScope([])).toEqual({ arm: 'many-parents' });
  });

  it('the TITLE and the LINK cannot disagree — one derivation, both consumers', () => {
    // ⚠️ THE POINT OF SHARING IT. The title is the line a reviewer reads first
    // and the link is what moves the tree, so a divergence between them would be
    // invisible in review and consequential at merge.
    const one = [record({ key: 'PROD-2', title: 'Widget' })];
    const story = [record({ key: 'PROD-2' }), record({ key: 'PROD-3' })];
    const spread = [record({ key: 'PROD-2' }), record({ key: 'PROD-9', parentKey: 'PROD-8' })];

    expect(sessionPrTitle('run-1', one)).toBe('PROD-2 Widget');
    expect(sessionPrScope(one)).toMatchObject({ key: 'PROD-2' });

    expect(sessionPrTitle('run-1', story)).toBe('PROD-1 — 2 work items');
    expect(sessionPrScope(story)).toMatchObject({ key: 'PROD-1' });

    expect(sessionPrTitle('run-1', spread)).toBe('Motir auto run run-1 — 2 work items');
    expect(sessionPrScope(spread)).toEqual({ arm: 'many-parents' });
  });
});

// ── the LINK, at creation ───────────────────────────────────────────────────

describe('ensureRepoPullRequest links the container AT CREATION', () => {
  const session: RepoSession = {
    repoName: 'motir-core',
    cwd: '/tmp/motir-core',
    branch: 'motir/auto-x',
    keys: ['PROD-2'],
  };

  function git(over: { existing?: string } = {}): { run: CommandRunner; log: string[] } {
    const log: string[] = [];
    const run: CommandRunner = (bin, args) => {
      log.push(`${bin} ${args.join(' ')}`);
      if (bin === 'git' && args[0] === 'rev-list') return OK('3');
      if (bin === 'gh' && args[1] === 'list') return OK(over.existing ?? '');
      if (bin === 'gh' && args[1] === 'create') return OK('https://github.test/pull/9001');
      return OK('');
    };
    return { run, log };
  }

  it('declares the shared parent on the pull request it just opened', async () => {
    const { run } = git();
    const fake = fakeClient();

    await ensureRepoPullRequest(session, 'run-1', run, {
      client: fake.client,
      carried: [record({ key: 'PROD-2' }), record({ key: 'PROD-3' })],
    });

    // The link's own arguments, which is what the server writes the row from
    // when no webhook delivery has arrived yet — the case this call exists for.
    expect(fake.links).toEqual([
      {
        key: 'PROD-1',
        url: 'https://github.test/pull/9001',
        headRef: 'motir/auto-x',
        baseRef: 'main',
      },
    ]);
  });

  it('declares it on a pull request that ALREADY EXISTS — the arm is known late', async () => {
    // ⚠️ THE CASE "at creation" alone does not reach. A run's FIRST landed card
    // is a set of one, indistinguishable from a leaf run, so the container is
    // only knowable once the second card of the same parent lands — by which
    // time the pull request has existed for a while.
    const { run } = git({ existing: 'https://github.test/pull/9001' });
    const fake = fakeClient();

    await ensureRepoPullRequest(session, 'run-1', run, {
      client: fake.client,
      carried: [record({ key: 'PROD-2' }), record({ key: 'PROD-3' })],
    });

    expect(fake.links.map((l) => l.key)).toEqual(['PROD-1']);
  });

  it('links NOTHING on a one-card run — the agent has already linked that card', async () => {
    const { run } = git();
    const fake = fakeClient();

    await ensureRepoPullRequest(session, 'run-1', run, {
      client: fake.client,
      carried: [record({ key: 'PROD-2' })],
    });

    expect(fake.links).toEqual([]);
  });

  it('links NOTHING when the carried set spans parents — it must not invent a story', async () => {
    const { run } = git();
    const fake = fakeClient();

    await ensureRepoPullRequest(session, 'run-1', run, {
      client: fake.client,
      carried: [record({ key: 'PROD-2' }), record({ key: 'PROD-9', parentKey: 'PROD-8' })],
    });

    expect(fake.links).toEqual([]);
  });

  it('links nothing when the open FAILED — there is no pull request to name', async () => {
    const log: string[] = [];
    const run: CommandRunner = (bin, args) => {
      log.push(`${bin} ${args.join(' ')}`);
      if (bin === 'git' && args[0] === 'rev-list') return OK('3');
      if (bin === 'gh' && args[1] === 'list') return OK('');
      return { exitCode: 1, stdout: '', stderr: 'gh: not found' };
    };
    const fake = fakeClient();

    await ensureRepoPullRequest(session, 'run-1', run, {
      client: fake.client,
      carried: [record({ key: 'PROD-2' }), record({ key: 'PROD-3' })],
    });

    expect(fake.links).toEqual([]);
  });

  it('REPORTS a failing link and lets the run carry on', async () => {
    const { run } = git();
    const fake = fakeClient({ onLink: () => new CliError('the server said no') });

    await expect(
      ensureRepoPullRequest(session, 'run-1', run, {
        client: fake.client,
        carried: [record({ key: 'PROD-2' }), record({ key: 'PROD-3' })],
      }),
    ).resolves.toBeUndefined();
  });
});

// ── the FLIP, at close-out ──────────────────────────────────────────────────

describe('closeOutContainer moves the container to Implemented', () => {
  it('links every repository and flips the container ONCE, to `implemented`', async () => {
    const fake = fakeClient();
    const summary = summaryOf([record({ key: 'PROD-2' }), record({ key: 'PROD-3' })], [pr()]);

    await closeOutContainer(fake.client, summary);

    expect(fake.transitions).toEqual([{ key: 'PROD-1', status: 'implemented' }]);
    expect(fake.links.map((l) => l.key)).toEqual(['PROD-1']);
  });

  it('flips AFTER every link — the order is the rule', async () => {
    const fake = fakeClient();
    const summary = summaryOf(
      [record({ key: 'PROD-2' }), record({ key: 'PROD-3' })],
      [pr({ repoName: 'motir-core' }), pr({ repoName: 'motir-ai', branch: 'motir/auto-x' })],
    );

    await closeOutContainer(fake.client, summary);

    expect(fake.calls).toEqual(['link:PROD-1', 'link:PROD-1', 'transition:PROD-1:implemented']);
  });

  it('a TWO-REPOSITORY container links BOTH pull requests and transitions ONCE', async () => {
    // ⚠️ ASSERTED ON THE CALL COUNTS, because the failure this pins is a
    // per-repository flip attempting the transition twice. A container has one
    // status; the repositories are marked ready together and it moves once after.
    const fake = fakeClient();
    const summary = summaryOf(
      [record({ key: 'PROD-2' }), record({ key: 'PROD-3', repo: 'motir-ai' })],
      [
        pr({ repoName: 'motir-core', url: 'https://github.test/pull/1' }),
        pr({ repoName: 'motir-ai', branch: 'motir/auto-x', url: 'https://github.test/pull/2' }),
      ],
    );

    await closeOutContainer(fake.client, summary);

    expect(fake.links.map((l) => l.url)).toEqual([
      'https://github.test/pull/1',
      'https://github.test/pull/2',
    ]);
    expect(fake.transitions).toHaveLength(1);
  });

  it('does NOTHING on a one-card run', async () => {
    const fake = fakeClient();
    await closeOutContainer(fake.client, summaryOf([record({ key: 'PROD-2' })], [pr()]));
    expect(fake.calls).toEqual([]);
  });

  it('does NOTHING when the carried set spans parents — the sprint arm', async () => {
    // `motir run sprint` reaches here with a set spanning parents: no link, no
    // container flip, and the cards roll up on their own.
    const fake = fakeClient();
    await closeOutContainer(
      fake.client,
      summaryOf(
        [record({ key: 'PROD-2' }), record({ key: 'PROD-9', parentKey: 'PROD-8' })],
        [pr()],
      ),
    );
    expect(fake.calls).toEqual([]);
  });

  it('links but does NOT flip while a child is outstanding', async () => {
    // ⚠️ THE CASCADE THIS PREVENTS. A container that reads Implemented while a
    // child has not been built is Bug MOTIR-3229's shape; the pull request stays
    // a draft for the same reason, and linking a draft is safe because a draft
    // cannot merge.
    const fake = fakeClient();
    const summary = summaryOf(
      [record({ key: 'PROD-2' }), record({ key: 'PROD-3' })],
      [pr({ draft: true })],
    );
    summary.outstanding = { containerKey: 'PROD-1', keys: ['PROD-9'] };

    await closeOutContainer(fake.client, summary);

    expect(fake.links.map((l) => l.key)).toEqual(['PROD-1']);
    expect(fake.transitions).toEqual([]);
  });

  it('does NOT flip while any repository’s pull request is still a DRAFT', async () => {
    // A `gh pr ready` that refused leaves work nobody can review; Implemented
    // would say otherwise. Asserted with TWO repositories, one of them readied,
    // because the failure is a run that reads only the first report.
    const fake = fakeClient();
    const summary = summaryOf(
      [record({ key: 'PROD-2' }), record({ key: 'PROD-3' })],
      [
        pr({ repoName: 'motir-core' }),
        pr({ repoName: 'motir-ai', branch: 'motir/auto-x', draft: true }),
      ],
    );

    await closeOutContainer(fake.client, summary);

    expect(fake.transitions).toEqual([]);
  });

  it('does nothing when no pull request was opened at all', async () => {
    const fake = fakeClient();
    await closeOutContainer(
      fake.client,
      summaryOf(
        [record({ key: 'PROD-2' }), record({ key: 'PROD-3' })],
        [pr({ outcome: 'empty', url: null })],
      ),
    );
    expect(fake.transitions).toEqual([]);
    expect(fake.links).toEqual([]);
  });

  it('is IDEMPOTENT against the webhook — a no-op move is not an error', async () => {
    // MOTIR-4968 writes the same status from the `ready_for_review` delivery.
    // The server answers a move to the status an item already holds without a
    // revision, so whichever of the two arrives second changes nothing — the two
    // are deliberately both written, and neither is a fallback for the other.
    const fake = fakeClient();
    const summary = summaryOf([record({ key: 'PROD-2' }), record({ key: 'PROD-3' })], [pr()]);

    await expect(closeOutContainer(fake.client, summary)).resolves.toBeUndefined();
    await expect(closeOutContainer(fake.client, summary)).resolves.toBeUndefined();

    expect(fake.transitions).toEqual([
      { key: 'PROD-1', status: 'implemented' },
      { key: 'PROD-1', status: 'implemented' },
    ]);
  });

  it('REPORTS the container gate’s refusal rather than dying on it', async () => {
    // The close-out's own open-children gate narrows the window this arrives in;
    // it cannot close it, because a child can be filed between the re-read and
    // the transition. So the refusal is a state the run reports and continues
    // from, exactly as `dispatchOne` treats it.
    const fake = fakeClient({
      onTransition: () => new ContainerHasOpenChildrenError('PROD-1 has open children: PROD-9.'),
    });
    const summary = summaryOf([record({ key: 'PROD-2' }), record({ key: 'PROD-3' })], [pr()]);

    await expect(closeOutContainer(fake.client, summary)).resolves.toBeUndefined();
    expect(fake.transitions).toHaveLength(1);
  });

  it('REPORTS an illegal transition rather than dying on it', async () => {
    // A workflow that does not declare the edge refuses the move. The work is
    // reviewable either way and a summary that aborted over it would hide it.
    const fake = fakeClient({
      onTransition: () =>
        new CliError('In Progress → Implemented is not allowed. Allowed: In Review, Done.'),
    });
    const summary = summaryOf([record({ key: 'PROD-2' }), record({ key: 'PROD-3' })], [pr()]);

    await expect(closeOutContainer(fake.client, summary)).resolves.toBeUndefined();
  });

  it.each(['in_review', 'approved'])(
    'LEAVES a container CI already moved on to %s — never writes it backwards',
    async (status) => {
      // `in_review → implemented` and `approved → implemented` are declared edges
      // since MOTIR-5630 (a merge-queue ejection writes them), so the server would
      // ACCEPT the move. Written blind it would demote a card whose checks are
      // already green, and nothing would promote it again.
      const fake = fakeClient({ status });
      const summary = summaryOf([record({ key: 'PROD-2' }), record({ key: 'PROD-3' })], [pr()]);

      await expect(closeOutContainer(fake.client, summary)).resolves.toBeUndefined();
      expect(fake.transitions).toEqual([]);
    },
  );

  it('counts only cards that LANDED — a failed card does not make a container', async () => {
    // `landedWork` is the predicate everywhere else in the close-out, and it
    // matters here too: a run whose only other card FAILED carried one card, and
    // a one-card run has no container.
    const fake = fakeClient();
    await closeOutContainer(
      fake.client,
      summaryOf([record({ key: 'PROD-2' }), record({ key: 'PROD-3', outcome: 'failed' })], [pr()]),
    );
    expect(fake.calls).toEqual([]);
  });
});

// ── a SCOPED run names its work item up front (MOTIR-10985) ─────────────────
//
// The partition reads `one-card` until a second card lands, so a story run's
// first card used to title the draft for itself and link no story. A scoped run
// knows the story before it starts, and that knowledge wins over the partition —
// while `motir auto` and a sprint scope, which pass none, keep every arm above.

describe('a scoped run’s container decides the title and the link (MOTIR-10985)', () => {
  const STORY = { key: 'PROD-1', title: 'Agents read and add a page’s discussion' };

  it('deliveredContainerKey: the container whatever the partition, else only `shared-parent`', () => {
    expect(deliveredContainerKey([], STORY)).toBe('PROD-1');
    expect(deliveredContainerKey([record({ key: 'PROD-2' })], STORY)).toBe('PROD-1');
    expect(
      deliveredContainerKey(
        [record({ key: 'PROD-2' }), record({ key: 'PROD-9', parentKey: 'PROD-8' })],
        STORY,
      ),
    ).toBe('PROD-1');
    // Without one: today's arms, unchanged.
    expect(deliveredContainerKey([record({ key: 'PROD-2' })])).toBeNull();
    expect(deliveredContainerKey([record({ key: 'PROD-2' }), record({ key: 'PROD-3' })])).toBe(
      'PROD-1',
    );
    expect(
      deliveredContainerKey([
        record({ key: 'PROD-2' }),
        record({ key: 'PROD-9', parentKey: 'PROD-8' }),
      ]),
    ).toBeNull();
  });

  it('sessionPrTitle names the container for none, one or many cards, and fits the budget', () => {
    expect(sessionPrTitle('run-1', [], STORY)).toBe(`PROD-1 ${STORY.title}`);
    expect(sessionPrTitle('run-1', [record({ key: 'PROD-2' })], STORY)).toBe(
      `PROD-1 ${STORY.title}`,
    );
    expect(sessionPrTitle('run-1', [], { key: 'PROD-1', title: '' })).toBe('PROD-1');
    const long = sessionPrTitle('run-1', [], { key: 'PROD-1', title: 'x'.repeat(200) });
    expect(long.length).toBeLessThanOrEqual(72);
    expect(long.startsWith('PROD-1 x')).toBe(true);
    expect(long.endsWith('…')).toBe(true);
    // Without one, the one-card arm still names the card.
    expect(sessionPrTitle('run-1', [record({ key: 'PROD-2' })])).toBe('PROD-2 Item PROD-2');
  });

  it('ensureRepoPullRequest opens a DRAFT titled for the container and links it at the FIRST card', async () => {
    const log: string[] = [];
    const run: CommandRunner = (bin, args) => {
      log.push(`${bin} ${args.join(' ')}`);
      if (bin === 'git' && args[0] === 'rev-list') return OK('3');
      if (bin === 'gh' && args[1] === 'list') return OK('');
      if (bin === 'gh' && args[1] === 'create') return OK('https://github.test/pull/9001');
      return OK('');
    };
    const fake = fakeClient();

    await ensureRepoPullRequest(
      { repoName: 'motir-core', cwd: '/tmp/motir-core', branch: 'motir/auto-x', keys: ['PROD-2'] },
      'run-1',
      run,
      { client: fake.client, carried: [record({ key: 'PROD-2' })], container: STORY },
    );

    const create = log.find((line) => line.startsWith('gh pr create'))!;
    expect(create).toContain('--draft');
    expect(create).toContain(`--title PROD-1 ${STORY.title}`);
    expect(fake.links).toEqual([
      {
        key: 'PROD-1',
        url: 'https://github.test/pull/9001',
        headRef: 'motir/auto-x',
        baseRef: 'main',
      },
    ]);
  });

  it('closeOutContainer links and flips the container on a ONE-card run', async () => {
    const fake = fakeClient();
    const summary = summaryOf([record({ key: 'PROD-2' })], [pr()], { container: STORY });

    await closeOutContainer(fake.client, summary);

    expect(fake.calls).toEqual(['link:PROD-1', 'transition:PROD-1:implemented']);
  });

  it('closeOutContainer names the container in what it reports while it holds it', async () => {
    const fake = fakeClient();
    let stderr = '';
    vi.mocked(process.stderr.write).mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });

    await closeOutContainer(
      fake.client,
      summaryOf([record({ key: 'PROD-2' })], [pr()], {
        container: STORY,
        outstanding: { containerKey: 'PROD-1', keys: ['PROD-3'] },
      }),
    );
    await closeOutContainer(
      fake.client,
      summaryOf([record({ key: 'PROD-2' })], [pr({ draft: true })], { container: STORY }),
    );

    expect(fake.transitions).toEqual([]);
    expect(stderr).toContain('PROD-1 stays as it is: 1 of its children have not landed (PROD-3)');
    expect(stderr).toContain('PROD-1 stays as it is: motir/auto-x is still a draft.');
  });
});
