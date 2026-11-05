import { describe, expect, it } from 'vitest';
import {
  judgeJob,
  judgeWorkflows,
  MAX_ACTION_DEPTH,
  parseActionRef,
  remoteActionKey,
  remoteActionsToRead,
  requestsFleetRunner,
  type ActionLookup,
} from '@/lib/ciFleet/jobCoverage';
import {
  parseWorkflows,
  type ActionMetadata,
  type WorkflowJob,
  type WorkflowSet,
} from '@/lib/ciFleet/workflowJobs';

// MOTIR-10290: a fleet job is judged from its own steps against the pinned image's
// tools, and anything that cannot be judged is never runnable.

const SEAM = "${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}";
const IMAGE = new Set(['bash', 'sh', 'git', 'curl', 'jq', 'docker', 'echo', 'cat']);
const NODE: ActionMetadata = { using: 'node', steps: [] };

const lookupOf =
  (entries: Record<string, ActionMetadata | 'absent'>): ActionLookup =>
  (key) =>
    entries[key];

function job(steps: WorkflowJob['steps'], extra: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    workflow: '.github/workflows/ci.yml',
    jobId: 'test',
    runsOn: SEAM,
    calls: null,
    container: false,
    services: false,
    steps,
    ...extra,
  };
}

const run = (script: string, shell: string | null = null) =>
  ({ kind: 'run', shell, script }) as const;
const uses = (ref: string) => ({ kind: 'uses', uses: ref, with: {} }) as const;
const judge = (j: WorkflowJob, lookup: ActionLookup = () => undefined, local = new Map()) =>
  judgeJob(j, IMAGE, lookup, local);

describe('requestsFleetRunner', () => {
  it('reads the seam expression, the fleet label, a label list and a group object', () => {
    expect(requestsFleetRunner(SEAM)).toBe(true);
    expect(requestsFleetRunner('motir-runner')).toBe(true);
    expect(requestsFleetRunner(['self-hosted', 'motir-runner'])).toBe(true);
    expect(requestsFleetRunner({ group: 'g', labels: ['motir-runner'] })).toBe(true);
    expect(requestsFleetRunner('ubuntu-latest')).toBe(false);
    expect(requestsFleetRunner({ group: 'g' })).toBe(false);
    expect(requestsFleetRunner(null)).toBe(false);
  });
});

describe('parseActionRef', () => {
  it('classifies every kind of uses: reference', () => {
    expect(parseActionRef('./.github/actions/setup/')).toEqual({
      kind: 'local',
      path: '.github/actions/setup',
    });
    expect(parseActionRef('docker://alpine:3')).toEqual({ kind: 'docker', image: 'alpine:3' });
    expect(parseActionRef('${{ matrix.action }}')).toEqual({
      kind: 'dynamic',
      uses: '${{ matrix.action }}',
    });
    expect(parseActionRef('Actions/Checkout@v4')).toEqual({
      kind: 'remote',
      owner: 'Actions',
      repo: 'Checkout',
      path: '',
      ref: 'v4',
      name: 'actions/checkout',
    });
    const nested = parseActionRef('superfly/flyctl-actions/setup-flyctl@master');
    expect(nested).toMatchObject({
      path: 'setup-flyctl',
      name: 'superfly/flyctl-actions/setup-flyctl',
    });
    expect(remoteActionKey(nested as Extract<typeof nested, { kind: 'remote' }>)).toBe(
      'superfly/flyctl-actions/setup-flyctl@master',
    );
    expect(parseActionRef('no-ref/action').kind).toBe('dynamic');
    expect(parseActionRef('lonely@v1').kind).toBe('dynamic');
  });
});

describe('judgeJob', () => {
  it('does not judge a job that never requests the fleet, or a local reusable caller', () => {
    expect(judge(job([run('gh pr list')], { runsOn: 'ubuntu-latest' })).verdict).toBe(
      'github-hosted',
    );
    expect(judge(job([], { calls: './.github/workflows/reuse.yml' })).verdict).toBe(
      'github-hosted',
    );
  });

  it('calls a job runnable when the image holds every command', () => {
    expect(judge(job([run('git status && curl -sf x | jq .')]))).toMatchObject({
      verdict: 'runnable',
      missing: [],
      unjudged: [],
    });
  });

  it('names a NEW EXECUTABLE the image lacks', () => {
    expect(judge(job([run('git status'), run('aws s3 ls')]))).toMatchObject({
      verdict: 'needs-image',
      missing: ['aws'],
    });
  });

  it("needs a step's shell interpreter, and reads only a POSIX shell's body as commands", () => {
    expect(judge(job([run('print(1)', 'python3 {0}')])).missing).toEqual(['python3']);
    expect(judge(job([run('Get-Item x', 'pwsh')])).missing).toEqual(['pwsh']);
    expect(judge(job([run('git x', '/usr/bin/zsh -e {0}')])).missing).toEqual(['zsh']);
  });

  it('counts what an earlier setup action or install provides', () => {
    const lookup = lookupOf({ 'actions/setup-node@v4': NODE, 'pnpm/action-setup@v4': NODE });
    expect(
      judge(
        job([uses('actions/setup-node@v4'), uses('pnpm/action-setup@v4'), run('pnpm i && node x')]),
        lookup,
      ).verdict,
    ).toBe('runnable');
    expect(judge(job([run('node x')]), lookup).missing).toEqual(['node']);
    expect(judge(job([run('pipx install ruff'), run('ruff check')])).missing).toEqual(['pipx']);
  });

  it('needs docker for a docker action, a docker:// step, a container: job and services:', () => {
    const noDocker = new Set(['bash']);
    const docker: ActionMetadata = { using: 'docker', steps: [] };
    expect(
      judgeJob(
        job([uses('acme/scan@v1')]),
        noDocker,
        lookupOf({ 'acme/scan@v1': docker }),
        new Map(),
      ).missing,
    ).toEqual(['docker']);
    expect(
      judgeJob(job([uses('docker://alpine')]), noDocker, () => undefined, new Map()).missing,
    ).toEqual(['docker']);
    expect(
      judgeJob(job([], { services: true }), noDocker, () => undefined, new Map()).missing,
    ).toEqual(['docker']);
    // A container: job's run steps run in ITS image, which is not read.
    const inContainer = job([run('make'), uses('${{ inputs.a }}')], { container: true });
    expect(judgeJob(inContainer, noDocker, () => undefined, new Map())).toMatchObject({
      verdict: 'unverified',
      missing: ['docker'],
      unjudged: ['the computed action ${{ inputs.a }}'],
    });
    expect(judge(job([run('make')], { container: true })).verdict).toBe('runnable');
  });

  it('judges a NEW ACTION by its own steps: local and remote composite actions', () => {
    const local = new Map<string, ActionMetadata>([
      [
        '.github/actions/setup',
        { using: 'composite', steps: [uses('acme/inner@v2'), run('terraform plan')] },
      ],
    ]);
    const lookup = lookupOf({ 'acme/inner@v2': { using: 'composite', steps: [run('helm x')] } });
    expect(judge(job([uses('./.github/actions/setup')]), lookup, local)).toMatchObject({
      verdict: 'needs-image',
      missing: ['helm', 'terraform'],
    });
  });

  it('asks nothing of the image for a builtin its tool list cannot hold', () => {
    expect(
      judge(job([run('[ -n "$x" ] && : ok\n. ./env.sh\n[ -f y ] || gh pr view')]), () => undefined),
    ).toMatchObject({ verdict: 'needs-image', missing: ['gh'] });
    expect(judge(job([run('[ -n "$x" ]')]), () => undefined)).toMatchObject({
      verdict: 'runnable',
    });
  });

  it('never calls runnable what it cannot judge', () => {
    const cases: Array<[WorkflowJob, ActionLookup, string]> = [
      [job([run('"$CLI" deploy')]), () => undefined, 'the computed command $CLI'],
      [job([uses('${{ matrix.a }}')]), () => undefined, 'the computed action ${{ matrix.a }}'],
      [
        job([uses('./.github/actions/gone')]),
        () => undefined,
        './.github/actions/gone, which has no action.yml',
      ],
      [job([uses('acme/x@v1')]), () => undefined, 'acme/x@v1, which was not read'],
      [
        job([uses('acme/x@v1')]),
        lookupOf({ 'acme/x@v1': 'absent' }),
        'acme/x@v1, which has no action.yml',
      ],
      [
        job([uses('acme/x@v1')]),
        lookupOf({ 'acme/x@v1': { using: 'unknown', steps: [] } }),
        'acme/x@v1, whose action kind is not known',
      ],
      [
        job([], { calls: 'acme/shared/.github/workflows/ci.yml@main' }),
        () => undefined,
        'the reusable workflow acme/shared/.github/workflows/ci.yml@main, in another repository',
      ],
    ];
    for (const [j, lookup, reason] of cases) {
      expect(judge(j, lookup)).toMatchObject({ verdict: 'unverified', unjudged: [reason] });
    }
  });

  it('stops following composite actions past the depth limit', () => {
    const entries: Record<string, ActionMetadata> = {};
    for (let i = 0; i <= MAX_ACTION_DEPTH + 1; i++) {
      entries[`acme/a${i}@v1`] = { using: 'composite', steps: [uses(`acme/a${i + 1}@v1`)] };
    }
    const verdict = judge(job([uses('acme/a0@v1')]), lookupOf(entries));
    expect(verdict.verdict).toBe('unverified');
    expect(verdict.unjudged[0]).toContain(`nested more than ${MAX_ACTION_DEPTH}`);
  });

  it('calls a job asking for another operating system cannot-host', () => {
    expect(judge(job([], { runsOn: ['motir-runner', 'macos-14'] }))).toMatchObject({
      verdict: 'cannot-host',
      unjudged: ['it asks for macos-14'],
    });
  });
});

describe('judgeWorkflows and remoteActionsToRead', () => {
  const set: WorkflowSet = parseWorkflows([
    {
      path: '.github/workflows/ci.yml',
      text: [
        'jobs:',
        '  fleet:',
        `    runs-on: "${SEAM}"`,
        '    steps:',
        '      - uses: ./.github/actions/setup',
        '      - uses: acme/top@v1',
        '      - uses: ./.github/actions/setup',
        '  hosted:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: acme/hosted-only@v1',
      ].join('\n'),
    },
    {
      path: '.github/actions/setup/action.yml',
      text: 'runs:\n  using: composite\n  steps:\n    - uses: acme/inner@v1',
    },
    { path: '.github/actions/broken/action.yml', text: 'runs: [x' },
    { path: '.github/workflows/broken.yml', text: 'jobs: [x' },
  ]);

  it("asks only for the fleet jobs' unread actions, one composite level per round", () => {
    const read: Record<string, ActionMetadata | 'absent'> = {};
    const lookup = lookupOf(read);
    expect(remoteActionsToRead(set, lookup).map(remoteActionKey).sort()).toEqual([
      'acme/inner@v1',
      'acme/top@v1',
    ]);
    read['acme/top@v1'] = { using: 'composite', steps: [uses('acme/deeper@v1')] };
    read['acme/inner@v1'] = 'absent';
    expect(remoteActionsToRead(set, lookup).map(remoteActionKey)).toEqual(['acme/deeper@v1']);
    read['acme/deeper@v1'] = NODE;
    expect(remoteActionsToRead(set, lookup)).toEqual([]);

    const judged = judgeWorkflows(set, IMAGE, lookup);
    expect(judged.map((j) => [j.jobId, j.verdict])).toEqual([
      ['fleet', 'unverified'],
      ['hosted', 'github-hosted'],
      ['*', 'unverified'],
    ]);
    expect(judged[0]!.unjudged).toEqual(['acme/inner@v1, which has no action.yml']);
    expect(judged[2]).toMatchObject({
      workflow: '.github/workflows/broken.yml',
      unjudged: ['the workflow file is not valid YAML'],
    });
  });

  it('stops reading past the depth limit', () => {
    const deep: Record<string, ActionMetadata> = {};
    for (let i = 0; i < 10; i++) {
      deep[`acme/d${i}@v1`] = { using: 'composite', steps: [uses(`acme/d${i + 1}@v1`)] };
    }
    const chain = parseWorkflows([
      {
        path: '.github/workflows/x.yml',
        text: `jobs:\n  j:\n    runs-on: motir-runner\n    steps:\n      - uses: acme/d0@v1\n`,
      },
    ]);
    expect(remoteActionsToRead(chain, lookupOf(deep))).toEqual([]);
  });
});
