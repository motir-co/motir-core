import { describe, expect, it } from 'vitest';
import type { FleetInventoryJob, FleetInventoryRepo } from '@/lib/ciFleet/fleetJobInventoryTypes';
import {
  jobsNotRecorded,
  judgeStructure,
  recordedJobsMoved,
} from '@/lib/ciFleet/inventoryStaleness';
import { workflowFingerprint, workflowStructure } from '@/lib/ciFleet/workflowFingerprint';

// MOTIR-10211: an entry stays current when a job is ADDED on a runner the
// repository already used with tools it already used, and goes stale for a new
// runner, action, executable or shell, or for a RECORDED job moving to another
// runner — the move a repository-wide set of runners cannot see.

const MAIN = '.github/workflows/main.yml';
const SEAM = "${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}";

/** motir-infra's `main.yml` at b5221db3f, in miniature: checks and deploy on the seam. */
function mainYml(extraJobs = '', deployRunsOn = SEAM): string {
  return `
on: [push]
jobs:
  checks:
    runs-on: ${SEAM}
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test
  deploy:
    needs: checks
    runs-on: ${deployRunsOn}
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v6
      - run: pnpm -s exec cdk deploy
  hosted:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm lint
${extraJobs}`;
}

/** The `verify` job motir-infra#7 added: the seam, and only deploy's tools. */
const VERIFY = `  verify:
    needs: deploy
    runs-on: ${SEAM}
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v6
      - run: pnpm -s verify:deployed
`;

function job(jobId: string, runsOn: unknown, extra: Partial<FleetInventoryJob> = {}) {
  return {
    jobId,
    runsOn,
    triggers: ['push'],
    verdict: 'runnable',
    missing: [],
    evidence: null,
    ...extra,
  } satisfies FleetInventoryJob;
}

function entry(text: string, fingerprint: string | undefined = undefined): FleetInventoryRepo {
  return {
    repoRef: 'acme/infra',
    ref: 'main',
    sha: 'measured',
    visibility: 'private',
    measuredAt: '2026-10-27T00:00:00Z',
    imageDockerfileSha: 'df',
    structureFingerprint: fingerprint ?? workflowFingerprint([{ path: MAIN, text }]),
    jobCount: 3,
    workflows: [
      {
        path: MAIN,
        jobs: [job('checks', SEAM), job('deploy', SEAM), job('hosted', 'ubuntu-latest')],
      },
    ],
  };
}

const at = (text: string) => [{ path: MAIN, text }];

describe('judgeStructure', () => {
  const measured = entry(mainYml());

  it('is current for the same workflows', () => {
    expect(judgeStructure(measured, at(mainYml()))).toEqual({ current: true, addedJobs: [] });
  });

  it('is current for a job added on a known runner with known tools, and names it', () => {
    expect(judgeStructure(measured, at(mainYml(VERIFY)))).toEqual({
      current: true,
      addedJobs: [`${MAIN}#verify`],
    });
  });

  it('is current when a recorded job is removed', () => {
    const withExtra = mainYml(VERIFY);
    const recorded = entry(withExtra);
    recorded.workflows[0]!.jobs.push(job('verify', SEAM));
    const withoutVerify = withExtra.replace(VERIFY, '');
    expect(judgeStructure(recorded, at(withoutVerify))).toEqual({ current: true, addedJobs: [] });
  });

  it('is stale for a job added on a new runner', () => {
    const mac = `  mac:\n    runs-on: macos-latest\n    steps:\n      - run: pnpm test\n`;
    expect(judgeStructure(measured, at(mainYml(mac)))).toMatchObject({
      current: false,
      reason: 'digest_moved',
      addedJobs: [`${MAIN}#mac`],
    });
  });

  it.each([
    ['action', `      - uses: docker/setup-qemu-action@v3\n`],
    ['executable', `      - run: gh pr list\n`],
    ['shell', `      - run: print(1)\n        shell: python3 {0}\n`],
  ])('is stale for an added job that brings a new %s', (_, step) => {
    expect(judgeStructure(measured, at(mainYml(`${VERIFY}${step}`)))).toMatchObject({
      current: false,
      reason: 'digest_moved',
    });
  });

  // The move the flat set cannot see: `hosted` keeps both runners in use, so the
  // digest is unchanged while `deploy` leaves the seam.
  it('is stale for a recorded job moving between two runners the repository already uses', () => {
    const verdict = judgeStructure(measured, at(mainYml('', 'ubuntu-latest')));
    expect(workflowFingerprint(at(mainYml('', 'ubuntu-latest')))).toBe(
      measured.structureFingerprint,
    );
    expect(verdict).toEqual({
      current: false,
      reason: 'job_moved',
      movedJobs: [`${MAIN}#deploy`],
      addedJobs: [],
    });
  });

  it('is stale with no recorded fingerprint, as before MOTIR-8870', () => {
    const noFp = { ...measured, structureFingerprint: undefined };
    expect(judgeStructure(noFp, at(mainYml()))).toMatchObject({
      current: false,
      reason: 'no_fingerprint',
    });
  });

  it('is stale for a head that is not valid YAML', () => {
    expect(judgeStructure(measured, at('jobs: [unclosed'))).toEqual({
      current: false,
      reason: 'invalid_yaml',
      movedJobs: [],
      addedJobs: [],
    });
  });

  it('ignores files that are not workflows or composite actions', () => {
    expect(judgeStructure(measured, [...at(mainYml()), { path: 'README.md', text: 'gh' }])).toEqual(
      { current: true, addedJobs: [] },
    );
  });
});

describe('recordedJobsMoved', () => {
  const CI = '.github/workflows/ci.yml';
  const caller = (target: string) =>
    `jobs:\n  image:\n    uses: ${target}\n  build:\n    runs-on: [self-hosted, x]\n    steps:\n      - run: ls\n`;
  const recorded: FleetInventoryRepo = {
    ...entry(mainYml()),
    workflows: [
      {
        path: CI,
        jobs: [
          // A caller's recorded runsOn is its CALLEE's runners, never YAML.
          job('image', ['ubuntu-latest'], { calls: './.github/workflows/image.yml' }),
          job('build', ['self-hosted', 'x']),
        ],
      },
    ],
  };

  it('compares a caller job on its call alone, whatever its recorded runners', () => {
    const head = workflowStructure([
      { path: CI, text: caller('./.github/workflows/image.yml@v2') },
    ]);
    expect(recordedJobsMoved(recorded, head)).toEqual([]);
  });

  it('reports a caller job that calls another workflow', () => {
    const head = workflowStructure([{ path: CI, text: caller('./.github/workflows/other.yml') }]);
    expect(recordedJobsMoved(recorded, head)).toEqual([`${CI}#image`]);
  });

  it('reports a runner job that became a caller', () => {
    const text = `jobs:\n  image:\n    uses: ./.github/workflows/image.yml\n  build:\n    uses: ./.github/workflows/build.yml\n`;
    expect(recordedJobsMoved(recorded, workflowStructure([{ path: CI, text }]))).toEqual([
      `${CI}#build`,
    ]);
  });

  it('compares a list runner by value, not by identity', () => {
    const head = workflowStructure([{ path: CI, text: caller('./.github/workflows/image.yml') }]);
    expect(recordedJobsMoved(recorded, head)).toEqual([]);
    expect(jobsNotRecorded(recorded, head)).toEqual([]);
  });
});
