import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// MOTIR-9928: the AWS deploy workflow. Workflow YAML is neither type-checked nor
// executed by any suite, so the properties the card promises are pinned here by
// reading the file: independence from the Fly deploy, OIDC only, the digest
// (never a tag) handed to the deploy, and the first-run `--no-roll` switch.

const WORKFLOWS = join(process.cwd(), '.github/workflows');
const source = readFileSync(join(WORKFLOWS, 'aws-deploy.yml'), 'utf8');

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
interface Job {
  'runs-on': string;
  if?: string;
  needs?: unknown;
  environment?: unknown;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  'timeout-minutes': number;
  env?: Record<string, string>;
  steps: Step[];
}
const workflow = parse(source) as {
  on: { push: { branches: string[] }; workflow_dispatch: unknown };
  jobs: Record<string, Job>;
};
const jobs = Object.entries(workflow.jobs);
const job = workflow.jobs['aws-deploy']!;
const steps = job.steps;

/** The text of the workflow with comments stripped, so prose cannot satisfy or trip a check. */
const code = source
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

function stepIndex(predicate: (s: Step) => boolean): number {
  const i = steps.findIndex(predicate);
  expect(i, 'step not found').toBeGreaterThan(-1);
  return i;
}

describe('the AWS deploy workflow (MOTIR-9928)', () => {
  it('runs on a push to main and on a manual dispatch', () => {
    expect(workflow.on.push.branches).toEqual(['main']);
    expect('workflow_dispatch' in workflow.on).toBe(true);
  });

  it('has exactly one job, holding id-token write and contents read only', () => {
    expect(jobs.map(([id]) => id)).toEqual(['aws-deploy']);
    expect(job.permissions).toEqual({ 'id-token': 'write', contents: 'read' });
  });

  it('skips, rather than fails, until the deploy role variable is set', () => {
    expect(job.if).toBe("vars.AWS_DEPLOY_ROLE_ARN != ''");
  });

  it('is independent of the Fly deploy: no needs, no workflow_run, no reference to ci.yml or flyctl', () => {
    expect(job.needs).toBeUndefined();
    expect('workflow_run' in workflow.on).toBe(false);
    expect(steps.some((s) => s.uses?.startsWith('./.github/workflows/'))).toBe(false);
    expect(code).not.toMatch(/ci\.yml|flyctl|needs:/);
  });

  it('has no environment, a non-cancelling concurrency group and a 60-minute ceiling', () => {
    expect(job.environment).toBeUndefined();
    expect(job.concurrency).toEqual({ group: 'aws-deploy', 'cancel-in-progress': false });
    expect(job['timeout-minutes']).toBe(60);
  });

  it('reads no AWS key or secret: role ARNs, region and prefix come from vars', () => {
    expect(code).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/);
    expect(code).not.toMatch(/secrets\.AWS/);
    expect(job.env).toEqual({
      AWS_REGION: '${{ vars.AWS_REGION }}',
      AWS_DEPLOY_NAME_PREFIX: '${{ vars.AWS_DEPLOY_NAME_PREFIX }}',
    });
  });

  it('builds without the Sentry auth token, so only the Fly build uploads source maps', () => {
    expect(code).not.toContain('SENTRY_AUTH_TOKEN');
  });

  it('assumes the push role, then pushes, then assumes the deploy role in a separate step', () => {
    const roles = steps.filter((s) => s.uses?.startsWith('aws-actions/configure-aws-credentials'));
    expect(roles.map((s) => s.with?.['role-to-assume'])).toEqual([
      '${{ vars.AWS_ECR_PUSH_ROLE_ARN }}',
      '${{ vars.AWS_DEPLOY_ROLE_ARN }}',
    ]);
    const push = stepIndex((s) => s.with?.['role-to-assume'] === roles[0]!.with!['role-to-assume']);
    const build = stepIndex((s) => !!s.uses?.startsWith('docker/build-push-action'));
    const deployRole = stepIndex(
      (s) => s.with?.['role-to-assume'] === roles[1]!.with!['role-to-assume'],
    );
    const deploy = stepIndex((s) => !!s.run?.includes('deploy:aws'));
    expect(push).toBeLessThan(build);
    expect(build).toBeLessThan(deployRole);
    expect(deployRole).toBeLessThan(deploy);
  });

  it('builds the image once and hands the deploy the digest from the push result, validated', () => {
    expect(steps.filter((s) => s.uses?.startsWith('docker/build-push-action'))).toHaveLength(1);
    const take = steps[stepIndex((s) => s.id === 'digest')]!;
    expect(take.env?.PUSHED).toBe('${{ steps.build.outputs.digest }}');
    expect(take.env?.EXISTING).toBe('${{ steps.existing.outputs.digest }}');
    expect(take.run).toContain('^sha256:[a-f0-9]{64}$');
    expect(take.run).toContain('exit 1');
    const deploy = steps[stepIndex((s) => !!s.run?.includes('deploy:aws'))]!;
    expect(deploy.env?.DIGEST).toBe('${{ steps.digest.outputs.digest }}');
    expect(deploy.run).toContain('--digest "$DIGEST"');
  });

  it("tolerates an immutable tag already pushed by reading that commit's image digest", () => {
    const existing = steps[stepIndex((s) => s.id === 'existing')]!;
    expect(existing.run).toContain('aws ecr describe-images');
    expect(existing.run).toContain('imageTag=$GITHUB_SHA');
    const build = steps[stepIndex((s) => s.id === 'build')]!;
    expect(build.if).toBe("steps.existing.outputs.digest == ''");
  });

  it('adds --no-roll only when AWS_DEPLOY_NO_ROLL is true', () => {
    const deploy = steps[stepIndex((s) => !!s.run?.includes('deploy:aws'))]!;
    expect(deploy.env?.NO_ROLL).toBe(
      "${{ vars.AWS_DEPLOY_NO_ROLL == 'true' && '--no-roll' || '' }}",
    );
    expect(deploy.run).toContain('--digest "$DIGEST" $NO_ROLL');
  });

  it('writes the digest and the result line to the job summary', () => {
    expect(code.match(/GITHUB_STEP_SUMMARY/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
