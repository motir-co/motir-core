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

  // 80: the 20-minute stack wait of MOTIR-10436 on top of the deploy's 60.
  it('has no environment, a non-cancelling concurrency group and an 80-minute ceiling', () => {
    expect(job.environment).toBeUndefined();
    expect(job.concurrency).toEqual({ group: 'aws-deploy', 'cancel-in-progress': false });
    expect(job['timeout-minutes']).toBe(80);
  });

  it('reads no AWS key or secret: role ARNs, region and prefix come from vars', () => {
    expect(code).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/);
    expect(code).not.toMatch(/secrets\.AWS/);
    expect(job.env).toEqual({
      AWS_REGION: '${{ vars.AWS_REGION }}',
      AWS_DEPLOY_NAME_PREFIX: '${{ vars.AWS_DEPLOY_NAME_PREFIX }}',
    });
  });

  // MOTIR-11059: the guards the retired Fly job carried. The secret checks refuse
  // before any AWS session or image build; the Sentry release check reads the
  // build's result after the roll, so a Sentry outage cannot hold a release back.
  it('refuses on a missing monitoring secret or salt before it assumes a role or builds', () => {
    const monitoring = stepIndex(
      (s) => s.name === 'Assert the monitoring build-time secrets are present',
    );
    const salt = stepIndex((s) => s.name === 'Assert the Server Action salt is pinned');
    const firstRole = stepIndex(
      (s) => !!s.uses?.startsWith('aws-actions/configure-aws-credentials'),
    );
    const build = stepIndex((s) => s.id === 'build');
    expect([monitoring, salt]).toEqual([0, 1]);
    expect(salt).toBeLessThan(firstRole);
    expect(salt).toBeLessThan(build);
    expect(steps[monitoring]!.if).toBeUndefined();
    expect(steps[salt]!.if).toBeUndefined();
  });

  it('checks the Sentry release last, after the roll, on every run that reaches it', () => {
    const check = stepIndex((s) => s.name === 'Assert Sentry received this release');
    const deploy = stepIndex((s) => !!s.run?.includes('deploy:aws'));
    expect(check).toBe(steps.length - 1);
    expect(check).toBeGreaterThan(deploy);
    expect(steps[check]!.if).toBeUndefined();
  });

  it('hands the Sentry auth token to the build only as a BuildKit secret', () => {
    const build = steps[stepIndex((s) => s.id === 'build')]!;
    expect(build.with?.['secrets']).toContain('SENTRY_AUTH_TOKEN=${{ secrets.SENTRY_AUTH_TOKEN }}');
    expect(build.with?.['build-args']).not.toContain('SENTRY_AUTH_TOKEN');
  });

  it('assumes the push role, then pushes, then assumes the deploy role in a separate step', () => {
    const roles = steps.filter((s) => s.uses?.startsWith('aws-actions/configure-aws-credentials'));
    expect(roles.map((s) => s.with?.['role-to-assume'])).toEqual([
      '${{ vars.AWS_ECR_PUSH_ROLE_ARN }}',
      '${{ vars.AWS_DEPLOY_ROLE_ARN }}',
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

  // MOTIR-10436. The check needs the deploy role's credentials, so it runs after they
  // are assumed, and the deploy may run only on its answer. The check can wait 20
  // minutes of an hour-long session, so the roll takes a fresh one.
  it('rolls only on the answer of the check it runs just before, in a fresh session', () => {
    const gate = stepIndex((s) => s.id === 'gate');
    const deploy = stepIndex((s) => !!s.run?.includes('deploy:aws'));
    const deployRole = stepIndex(
      (s) => s.with?.['role-to-assume'] === '${{ vars.AWS_DEPLOY_ROLE_ARN }}',
    );
    expect(gate).toBeGreaterThan(deployRole);
    expect(deploy).toBe(gate + 2);
    expect(steps[gate]!.run).toBe('bash scripts/aws-deploy/deploy-gate.sh');
    expect(steps[gate]!.env?.['DEPLOY_STACKS']).toBe('${{ vars.AWS_DEPLOY_NAME_PREFIX }}-services');
    const fresh = steps[gate + 1]!;
    expect(fresh.uses).toMatch(/^aws-actions\/configure-aws-credentials@/);
    expect(fresh.with?.['role-to-assume']).toBe('${{ vars.AWS_DEPLOY_ROLE_ARN }}');
    expect(fresh.if).toBe("steps.gate.outputs.deploy == 'true'");
    expect(steps[deploy]!.if).toBe("steps.gate.outputs.deploy == 'true'");
  });

  it('adds --no-roll only when AWS_DEPLOY_NO_ROLL is true', () => {
    const deploy = steps[stepIndex((s) => !!s.run?.includes('deploy:aws'))]!;
    expect(deploy.env?.NO_ROLL).toBe(
      "${{ vars.AWS_DEPLOY_NO_ROLL == 'true' && '--no-roll' || '' }}",
    );
    expect(deploy.run).toContain('--digest "$DIGEST" $NO_ROLL');
  });

  // MOTIR-10883: the deploy writes every image pin in `infra/image-pins/` into its
  // secret before it rolls, from THIS commit's checkout, so a merged pin pull
  // request is applied by its own deploy and a revert by the revert's.
  it('hands the deploy the checked-in image pins, on the gated roll step, from this commit', () => {
    const deploy = steps[stepIndex((s) => !!s.run?.includes('deploy:aws'))]!;
    expect(deploy.run).toContain('--pins infra/image-pins');
    expect(deploy.if).toBe("steps.gate.outputs.deploy == 'true'");
    const checkout = steps[stepIndex((s) => !!s.uses?.startsWith('actions/checkout@'))]!;
    expect(checkout.with?.ref).toBeUndefined();
    expect(code.match(/deploy:aws/g)).toHaveLength(1);
  });

  it('writes the digest and the result line to the job summary', () => {
    expect(code.match(/GITHUB_STEP_SUMMARY/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
