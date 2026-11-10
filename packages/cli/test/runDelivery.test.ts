import { describe, expect, it } from 'vitest';
import type { WorkItemDelivery } from '../src/client.js';
import { pushedButUnlinked, renderNoLinkedPullRequest } from '../src/dispatch.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import {
  declareRunDelivery,
  repositoryOfPullRequestUrl,
  type DeclareRunDeliveryInput,
} from '../src/runDelivery.js';
import { prViewJson } from './fakePullRequest.js';

// THE RUN DECLARES ITS OWN DELIVERY (MOTIR-10877) — `runDelivery.ts` alone, with every seam
// scripted: the `gh` / `git` runner, the client's delivery read and link, and the reporter's
// events and How to test publish. The command-level order (link < How to test < Implemented)
// is pinned in `agentMode.test.ts`; this file pins what each input leads to.

const BRANCH = 'subtask/PROD-7-add-the-thing';
const SHA = 'abc1234def5678abc1234def5678abc1234def56';
const WEB = 'https://github.com/acme/web/pull/7';
const API = 'https://github.com/acme/api/pull/3';

const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail: CommandResult = { exitCode: 1, stdout: '', stderr: 'no' };

interface Harness {
  input: DeclareRunDeliveryInput;
  links: unknown[];
  events: { kind: string; data?: unknown }[];
  published: { key: string; body: unknown }[];
  commands: string[];
  reads: number;
}

function harness(
  over: Partial<DeclareRunDeliveryInput> & {
    /** `gh pr view <ref>` answers, by ref; anything missing fails. */
    prs?: Record<string, string>;
    lsRemote?: Record<string, string>;
    deliveries?: WorkItemDelivery[] | 'unreadable';
    linkRefusal?: string;
    publishAnswer?: boolean | 'absent';
  } = {},
): Harness {
  const h: Harness = {
    links: [],
    events: [],
    published: [],
    commands: [],
    reads: 0,
    input: undefined as never,
  };
  const run: CommandRunner = (bin, args) => {
    h.commands.push(`${bin} ${args.join(' ')}`);
    if (bin === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      const answer = over.prs?.[args[2]!];
      return answer === undefined ? fail : ok(answer);
    }
    if (bin === 'git' && args[0] === 'ls-remote') {
      const answer = over.lsRemote?.[args.slice(1).join(' ')];
      return answer === undefined ? fail : ok(answer);
    }
    return fail;
  };
  const publishAnswer = over.publishAnswer ?? true;
  h.input = {
    key: 'PROD-7',
    dispatch: { workBranch: BRANCH, targetRepoDefaultBranch: 'main' },
    targets: [{ targetRepo: 'web', cwd: '/work', repoPath: null }],
    pullRequests: [],
    howToTest: null,
    client: {
      getWorkItem: async () => {
        h.reads += 1;
        if (over.deliveries === 'unreadable') throw new Error('500');
        return { item: {}, deliveries: over.deliveries ?? [] } as never;
      },
      linkPullRequest: async (args) => {
        h.links.push(args);
        if (over.linkRefusal) throw new Error(over.linkRefusal);
      },
    },
    reporter: {
      event: (e) => h.events.push({ kind: e.kind, data: e.data }),
      ...(publishAnswer === 'absent'
        ? {}
        : {
            publishHowToTest: async (key: string, body: unknown) => {
              h.published.push({ key, body });
              return publishAnswer;
            },
          }),
    },
    run,
    ...over,
  } as DeclareRunDeliveryInput;
  return h;
}

describe('repositoryOfPullRequestUrl', () => {
  it('reads owner/name off a GitHub pull request URL, and nothing else', () => {
    expect(repositoryOfPullRequestUrl(WEB)).toBe('acme/web');
    expect(repositoryOfPullRequestUrl('https://github.com/acme/web/issues/7')).toBeNull();
    expect(repositoryOfPullRequestUrl('https://gitlab.com/acme/web/pull/7')).toBeNull();
  });
});

describe('declareRunDelivery — finding and linking the pull request', () => {
  it('links the work branch’s open pull request and says so, with no delivery read', async () => {
    const h = harness({ prs: { [BRANCH]: prViewJson(BRANCH, WEB, SHA) } });
    const delivery = await declareRunDelivery(h.input);

    expect(delivery).toEqual({
      linked: [{ repository: 'acme/web', url: WEB, headSha: SHA }],
      unlinked: [],
      howToTest: 'none',
    });
    expect(h.links).toEqual([{ key: 'PROD-7', url: WEB, headRef: BRANCH, baseRef: 'main' }]);
    expect(h.events).toEqual([
      {
        kind: 'delivery_linked',
        data: { url: WEB, repository: 'acme/web', branch: BRANCH, by: 'run' },
      },
    ]);
    // A run that links what it found never reads the card's deliveries.
    expect(h.reads).toBe(0);
  });

  it('takes the URL the agent reported, matched to each repository by name', async () => {
    const h = harness({
      targets: [
        { targetRepo: 'web', cwd: '/web', repoPath: null },
        { targetRepo: 'api', cwd: '/api', repoPath: '/api-repo' },
      ],
      dispatch: {
        workBranch: BRANCH,
        targetRepos: [
          { name: 'web', defaultBranch: 'main' },
          { name: 'api', defaultBranch: 'develop' },
        ] as never,
        targetRepoDefaultBranch: 'main',
      },
      pullRequests: [API, WEB],
      prs: {
        [WEB]: prViewJson(BRANCH, WEB, SHA),
        // `gh` cannot read this one: the run links the reported URL on what it knows.
      },
      lsRemote: { [`origin refs/heads/${BRANCH}`]: `${SHA}\trefs/heads/${BRANCH}` },
    });
    const delivery = await declareRunDelivery(h.input);

    expect(delivery.linked).toEqual([
      { repository: 'acme/web', url: WEB, headSha: SHA },
      { repository: 'acme/api', url: API, headSha: SHA },
    ]);
    expect(h.links).toEqual([
      { key: 'PROD-7', url: WEB, headRef: BRANCH, baseRef: 'main' },
      { key: 'PROD-7', url: API, headRef: BRANCH, baseRef: 'develop' },
    ]);
    // The api repository was read in its own checkout.
    expect(h.commands).toContain(
      `gh pr view ${API} --json url,state,headRefName,headRefOid,baseRefName`,
    );
  });

  it('an unpinned card (no repository name) takes the first URL the agent reported', async () => {
    const h = harness({
      targets: [{ targetRepo: null, cwd: '/work', repoPath: null }],
      pullRequests: [WEB],
      prs: { [WEB]: prViewJson(BRANCH, WEB, SHA) },
    });
    expect((await declareRunDelivery(h.input)).linked).toEqual([
      { repository: 'acme/web', url: WEB, headSha: SHA },
    ]);
  });

  it('with no work branch, looks on every remote branch naming the card', async () => {
    const other = 'subtask/PROD-7-retry';
    const h = harness({
      dispatch: { workBranch: null, targetRepoDefaultBranch: null },
      lsRemote: {
        '--heads origin *PROD-7*': `abc\trefs/heads/${BRANCH}\ndef\trefs/heads/${other}\n`,
      },
      prs: { [other]: prViewJson(other, WEB, SHA) },
    });
    const delivery = await declareRunDelivery(h.input);
    expect(delivery.linked).toEqual([{ repository: 'acme/web', url: WEB, headSha: SHA }]);
    expect(h.links).toEqual([{ key: 'PROD-7', url: WEB, headRef: other, baseRef: 'main' }]);
  });

  it('a continue’s per-repository branch wins over the dispatch’s work branch', async () => {
    const theirs = 'subtask/PROD-7-the-dead-run';
    const h = harness({
      branches: [{ repository: 'web', workBranch: theirs }],
      prs: { [theirs]: prViewJson(theirs, WEB, SHA) },
    });
    await declareRunDelivery(h.input);
    expect(h.links).toEqual([{ key: 'PROD-7', url: WEB, headRef: theirs, baseRef: 'main' }]);
  });

  it('a CLOSED pull request, or one gh answers malformed, delivers nothing', async () => {
    for (const answer of [
      JSON.stringify({ ...JSON.parse(prViewJson(BRANCH, WEB)), state: 'CLOSED' }),
      'not json',
      'null',
      JSON.stringify({ url: 'https://example.com/x', state: 'OPEN' }),
      JSON.stringify({ url: WEB, state: 'OPEN', headRefName: BRANCH }),
    ]) {
      const h = harness({ prs: { [BRANCH]: answer } });
      const delivery = await declareRunDelivery(h.input);
      expect(delivery.linked, answer).toEqual([]);
      expect(delivery.unlinked, answer).toEqual([
        {
          repository: 'web',
          branch: BRANCH,
          reason: `no open pull request was found for ${BRANCH}`,
        },
      ]);
      expect(h.links).toEqual([]);
    }
  });

  it('a pull request gh reads with no head commit is still linked, with none', async () => {
    const h = harness({ prs: { [BRANCH]: prViewJson(BRANCH, WEB, '') } });
    expect((await declareRunDelivery(h.input)).linked).toEqual([
      { repository: 'acme/web', url: WEB, headSha: null },
    ]);
  });
});

describe('declareRunDelivery — what it could not link', () => {
  it('names the branch it found no pull request on', async () => {
    const h = harness();
    const delivery = await declareRunDelivery(h.input);
    expect(delivery.unlinked).toEqual([
      { repository: 'web', branch: BRANCH, reason: `no open pull request was found for ${BRANCH}` },
    ]);
    expect(h.events).toEqual([]);
  });

  it('says when the run names no branch to look on', async () => {
    const h = harness({
      dispatch: { workBranch: null, targetRepoDefaultBranch: null },
    });
    expect((await declareRunDelivery(h.input)).unlinked).toEqual([
      {
        repository: 'web',
        branch: null,
        reason: 'the run names no work branch to find a pull request on',
      },
    ]);
  });

  it('with no work branch, names the remote branches it looked on', async () => {
    const h = harness({
      dispatch: { workBranch: null, targetRepoDefaultBranch: null },
      lsRemote: { '--heads origin *PROD-7*': `abc\trefs/heads/${BRANCH}\n` },
    });
    expect((await declareRunDelivery(h.input)).unlinked).toEqual([
      { repository: 'web', branch: BRANCH, reason: `no open pull request was found for ${BRANCH}` },
    ]);
  });

  it('a pull request the agent linked ITSELF counts as linked, with no second call', async () => {
    const h = harness({
      deliveries: [
        { repo: 'acme/web', url: WEB, state: 'open' } as WorkItemDelivery,
        { repo: 'acme/api', url: API, state: 'closed' } as WorkItemDelivery,
      ],
      lsRemote: { [`origin refs/heads/${BRANCH}`]: `${SHA}\trefs/heads/${BRANCH}` },
    });
    const delivery = await declareRunDelivery(h.input);
    expect(delivery.linked).toEqual([{ repository: 'acme/web', url: WEB, headSha: SHA }]);
    expect(h.links).toEqual([]);
    expect(h.events).toEqual([
      { kind: 'delivery_linked', data: { url: WEB, repository: 'acme/web', by: 'agent' } },
    ]);
  });

  it('an unreadable card reads as no deliveries, and a bad remote head as none', async () => {
    const h = harness({
      deliveries: 'unreadable',
      lsRemote: { [`origin refs/heads/${BRANCH}`]: 'not-a-sha' },
    });
    expect((await declareRunDelivery(h.input)).unlinked).toHaveLength(1);
  });

  it('a reported URL with no branch to read its head from is not linked', async () => {
    const h = harness({
      dispatch: { workBranch: null, targetRepoDefaultBranch: null },
      pullRequests: [WEB],
    });
    expect((await declareRunDelivery(h.input)).unlinked).toEqual([
      {
        repository: 'acme/web',
        branch: null,
        reason: `the head branch of ${WEB} could not be read`,
      },
    ]);
    expect(h.links).toEqual([]);
  });

  it('a REFUSED link is unlinked, naming why — unless the card already delivers it', async () => {
    const refused = harness({
      prs: { [BRANCH]: prViewJson(BRANCH, WEB, SHA) },
      linkRefusal: 'the repository is not connected',
    });
    expect((await declareRunDelivery(refused.input)).unlinked).toEqual([
      {
        repository: 'acme/web',
        branch: BRANCH,
        reason: `linking ${WEB} was refused: the repository is not connected`,
      },
    ]);
    expect(refused.events).toEqual([]);

    const already = harness({
      prs: { [BRANCH]: prViewJson(BRANCH, WEB, SHA) },
      linkRefusal: '409',
      deliveries: [{ repo: 'acme/web', url: WEB, state: 'open' } as WorkItemDelivery],
    });
    expect((await declareRunDelivery(already.input)).linked).toEqual([
      { repository: 'acme/web', url: WEB, headSha: SHA },
    ]);
  });

  it('a non-Error refusal is still named', async () => {
    const h = harness({ prs: { [BRANCH]: prViewJson(BRANCH, WEB, SHA) } });
    h.input.client.linkPullRequest = async () => {
      throw 'gone';
    };
    expect((await declareRunDelivery(h.input)).unlinked[0]?.reason).toBe(
      `linking ${WEB} was refused: gone`,
    );
  });

  it('a run with no targets delivers nothing and fails nothing', async () => {
    const h = harness({ targets: [] });
    expect(await declareRunDelivery(h.input)).toEqual({
      linked: [],
      unlinked: [],
      howToTest: 'none',
    });
  });
});

describe('declareRunDelivery — the How to test', () => {
  const HOW = { bodyMd: '## Locally', previewPath: '/items/PROD-7' };

  it('publishes it after the link, with each linked repository’s head', async () => {
    const h = harness({ prs: { [BRANCH]: prViewJson(BRANCH, WEB, SHA) }, howToTest: HOW });
    expect((await declareRunDelivery(h.input)).howToTest).toBe('published');
    expect(h.published).toEqual([
      {
        key: 'PROD-7',
        body: {
          bodyMd: '## Locally',
          previewPath: '/items/PROD-7',
          repos: [{ repo: 'acme/web', commitSha: SHA }],
        },
      },
    ]);
  });

  it('leaves out a repository whose head it could not read, and a missing preview path', async () => {
    const h = harness({
      prs: { [BRANCH]: prViewJson(BRANCH, WEB, '') },
      howToTest: { bodyMd: '## Locally', previewPath: null },
    });
    await declareRunDelivery(h.input);
    expect(h.published[0]?.body).toEqual({ bodyMd: '## Locally', repos: [] });
  });

  it('reports a refused publish, and publishes nothing without a body or a reporter door', async () => {
    const refused = harness({ howToTest: HOW, publishAnswer: false });
    expect((await declareRunDelivery(refused.input)).howToTest).toBe('refused');

    const absent = harness({ howToTest: HOW, publishAnswer: 'absent' });
    expect((await declareRunDelivery(absent.input)).howToTest).toBe('none');

    const none = harness();
    expect((await declareRunDelivery(none.input)).howToTest).toBe('none');
    expect(none.published).toEqual([]);
  });
});

describe('pushedButUnlinked — what the leg is told', () => {
  const unlinked = [{ repository: 'web', branch: BRANCH, reason: 'no open pull request' }];

  it('holds a run whose work reached the remote and linked nothing', () => {
    expect(
      pushedButUnlinked({
        kind: 'succeeded',
        remote: 'pushed',
        delivery: { linked: [], unlinked, howToTest: 'none' },
      } as never),
    ).toBe(true);
  });

  it('never holds a linked run, an unknown push, or a run with no delivery', () => {
    const linked = {
      linked: [{ repository: 'acme/web', url: WEB, headSha: null }],
      unlinked: [],
      howToTest: 'none',
    };
    expect(
      pushedButUnlinked({ kind: 'succeeded', remote: 'pushed', delivery: linked } as never),
    ).toBe(false);
    expect(
      pushedButUnlinked({
        kind: 'succeeded',
        remote: 'unknown',
        delivery: { linked: [], unlinked, howToTest: 'none' },
      } as never),
    ).toBe(false);
    expect(
      pushedButUnlinked({ kind: 'succeeded', remote: 'pushed', delivery: null } as never),
    ).toBe(false);
    expect(pushedButUnlinked({})).toBe(false);
  });

  it('renders each branch it could not link, with the reason', () => {
    const text = renderNoLinkedPullRequest('PROD-7', [
      ...unlinked,
      { repository: null, branch: null, reason: 'the run names no work branch' },
    ]);
    expect(text).toContain('PROD-7');
    expect(text).toContain(BRANCH);
    expect(text).toContain('no open pull request');
    expect(text).toContain('the run names no work branch');
  });
});
