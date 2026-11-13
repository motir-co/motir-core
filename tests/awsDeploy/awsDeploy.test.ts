import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DIGEST_PATTERN,
  USAGE,
  entry,
  processIo,
  imageDigestParameterName,
  main,
  parseDeployArgs,
} from '@/scripts/aws-deploy/awsDeploy';
import { GRANTED_ACTIONS, type DeployAws } from '@/scripts/aws-deploy/ports';
import {
  CLUSTER,
  CORE_REPO,
  DATABASE_URL,
  DIGEST,
  FakeDeployAws,
  OLD_DIGEST,
  OTHER_REPO,
  PREFIX,
  SECRET_ARN,
  completesAfter,
  migrateExits,
} from './fakeDeployAws';

// MOTIR-9927 — the deploy's ORDER is the product: verify, migrate, roll, and
// record the digest last; any failure leaves the services on what they ran and
// the digest unwritten.

const ENV = { AWS_REGION: 'us-east-1', AWS_DEPLOY_NAME_PREFIX: PREFIX };
const DIGEST_PARAM = imageDigestParameterName(PREFIX);
const CHANGES = ['registerTaskDefinition', 'runTask', 'updateService', 'putParameter'];

/** Every action issued across this file, held to the grant at the end. */
const issued = new Set<string>();

async function deploy(aws: FakeDeployAws, argv: string[] = ['--digest', DIGEST], env = ENV) {
  const out: string[] = [];
  const err: string[] = [];
  const regions: string[] = [];
  const code = await main(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l) }, (r) => {
    regions.push(r);
    return aws;
  });
  for (const action of aws.actions()) issued.add(action);
  const both = [...out, ...err].join('\n');
  expect(both).not.toContain(DATABASE_URL);
  expect(both).not.toContain(SECRET_ARN);
  expect(both).not.toContain('hunter2');
  return {
    code,
    out,
    err,
    regions,
    result: out.length ? (JSON.parse(out[0] ?? '{}') as Record<string, unknown>) : null,
  };
}

function coreFleet() {
  const aws = new FakeDeployAws();
  const previous = {
    web: aws.addService('web', CORE_REPO),
    worker: aws.addService('worker', CORE_REPO, completesAfter(2)),
    relay: aws.addService('relay', CORE_REPO),
    ai: aws.addService('ai', OTHER_REPO),
  };
  return { aws, previous };
}

describe('a successful deploy', () => {
  it('migrates, rolls the three core services, then records the digest, and prints one JSON line', async () => {
    const { aws, previous } = coreFleet();
    const { code, out, result, regions } = await deploy(aws);
    expect(code).toBe(0);
    expect(regions).toEqual(['us-east-1']);
    expect(out).toHaveLength(1);
    expect(result).toEqual({
      digest: DIGEST,
      migrate: { taskArn: expect.stringContaining('/abc123'), exitCode: 0 },
      services: [
        {
          name: 'web',
          taskDefinition: expect.stringContaining('motir-prod-core-web:8'),
          base: previous.web,
          clonedFrom: previous.web,
          rolloutState: 'COMPLETED',
        },
        {
          name: 'worker',
          taskDefinition: expect.stringContaining('motir-prod-core-worker:8'),
          base: previous.worker,
          clonedFrom: previous.worker,
          rolloutState: 'COMPLETED',
        },
        {
          name: 'relay',
          taskDefinition: expect.stringContaining('motir-prod-core-relay:8'),
          base: previous.relay,
          clonedFrom: previous.relay,
          rolloutState: 'COMPLETED',
        },
      ],
      pins: [],
      recorded: true,
    });
    expect(aws.params.get(DIGEST_PARAM)).toBe(DIGEST);
    expect(aws.services.get('ai')).toBe(previous.ai);
  });

  it('runs the migrate task before any service changes, and writes the digest after the last wait', async () => {
    const { aws } = coreFleet();
    await deploy(aws);
    const methods = aws.methods();
    const firstUpdate = methods.indexOf('updateService');
    // The services are only READ before the migrate task (MOTIR-10093), and changed after it.
    expect(methods.indexOf('listServices')).toBeLessThan(methods.indexOf('runTask'));
    expect(methods.lastIndexOf('registerTaskDefinition')).toBeGreaterThan(
      methods.indexOf('runTask'),
    );
    expect(methods.lastIndexOf('describeTask')).toBeLessThan(firstUpdate);
    expect(methods.indexOf('putParameter')).toBe(methods.length - 1);
    expect(methods.lastIndexOf('describeServices')).toBeLessThan(methods.indexOf('putParameter'));
    expect(methods.filter((m) => m === 'putParameter')).toHaveLength(1);
  });
});

describe('refusals before anything changes', () => {
  it.each([
    ['a short digest', `sha256:${'a'.repeat(63)}`],
    ['an uppercase digest', `sha256:${'A'.repeat(64)}`],
    ['a tag', 'latest'],
  ])('refuses %s without a single AWS call', async (_case, digest) => {
    const { aws } = coreFleet();
    const { code, err } = await deploy(aws, ['--digest', digest]);
    expect(code).toBe(1);
    expect(aws.calls).toEqual([]);
    expect(err).toEqual([`error: --digest must match ${DIGEST_PATTERN.source}`]);
  });

  it('refuses an image ECR does not hold before registering, running or updating anything', async () => {
    const { aws } = coreFleet();
    const missing = `sha256:${'b'.repeat(64)}`;
    const { code, err, result } = await deploy(aws, ['--digest', missing]);
    expect(code).toBe(1);
    expect(aws.methods().filter((m) => CHANGES.includes(m))).toEqual([]);
    expect(aws.calls.find(([m]) => m === 'imageExists')).toEqual([
      'imageExists',
      'motir-prod/motir-core',
      missing,
    ]);
    expect(err.at(-1)).toBe(`error: Error: ${CORE_REPO} has no image ${missing}`);
    expect(result).toMatchObject({ migrate: null, recorded: false });
  });

  it.each([
    ['no digest', [], ENV],
    ['an unknown flag', ['--digest', DIGEST, '--force'], ENV],
    ['a positional', [DIGEST], ENV],
    ['a zero timeout', ['--digest', DIGEST, '--timeout-minutes', '0'], ENV],
    ['a fractional timeout', ['--digest', DIGEST, '--timeout-minutes', '1.5'], ENV],
    ['no region', ['--digest', DIGEST], { AWS_DEPLOY_NAME_PREFIX: PREFIX }],
    ['no name prefix', ['--digest', DIGEST], { AWS_REGION: 'us-east-1' }],
  ])('prints the usage for %s', async (_case, argv, env) => {
    const aws = new FakeDeployAws();
    const { code, err } = await deploy(aws, argv, env as typeof ENV);
    expect(code).toBe(1);
    expect(err).toEqual([USAGE]);
    expect(aws.calls).toEqual([]);
  });

  it.each([
    ['is empty', undefined, /deploy-target is empty/],
    [
      'has no cluster',
      JSON.stringify({ migrateFamily: 'f', migrateContainer: 'c', region: 'r' }),
      /has no cluster/,
    ],
    [
      'has no subnets',
      JSON.stringify({ cluster: 'c', migrateFamily: 'f', migrateContainer: 'c', region: 'r' }),
      /has no subnets/,
    ],
  ])('fails when the deploy target %s', async (_case, value, message) => {
    const aws = new FakeDeployAws();
    if (value === undefined) aws.params.delete(`/${PREFIX}/core/deploy-target`);
    else aws.params.set(`/${PREFIX}/core/deploy-target`, value);
    const { code, err } = await deploy(aws);
    expect(code).toBe(1);
    expect(err.at(-1)).toMatch(message);
    expect(aws.methods().filter((m) => CHANGES.includes(m))).toEqual([]);
  });

  it('fails when the migrate task definition has no migrate container image', async () => {
    const aws = new FakeDeployAws();
    aws.addDefinition({
      family: 'motir-prod-core-migrate',
      taskDefinitionArn: 'arn:m:1',
      containerDefinitions: [],
    });
    const { code, err } = await deploy(aws);
    expect(code).toBe(1);
    expect(err.at(-1)).toMatch(/motir-prod-core-migrate has no migrate image/);
  });
});

describe('a failed migrate', () => {
  it.each([
    [
      'a non-zero exit',
      (aws: FakeDeployAws) => (aws.migrate = migrateExits(3)),
      /migrate exited 3/,
    ],
    [
      'a task that never ran',
      (aws: FakeDeployAws) =>
        (aws.migrate = () => ({
          lastStatus: 'STOPPED',
          stoppedReason: 'EssentialContainerExited',
        })),
      /migrate never ran: EssentialContainerExited/,
    ],
    [
      'a timeout',
      (aws: FakeDeployAws) => (aws.migrate = () => ({ lastStatus: 'RUNNING' })),
      /migrate timed out/,
    ],
  ])('on %s changes no service and records nothing', async (_case, arrange, message) => {
    const { aws } = coreFleet();
    arrange(aws);
    aws.logLines.push('Applying migration 20261028_x', `connect ${'ok'}`);
    const { code, err, result } = await deploy(aws, ['--digest', DIGEST, '--timeout-minutes', '1']);
    expect(code).toBe(1);
    expect(aws.methods()).not.toContain('updateService');
    expect(aws.methods()).not.toContain('putParameter');
    expect(aws.registered.map((r) => r.family)).not.toContain('motir-prod-core-worker');
    expect(aws.params.get(DIGEST_PARAM)).toBe(OLD_DIGEST);
    expect(err.at(-1)).toMatch(message);
    expect(err).toContain('  Applying migration 20261028_x');
    expect(result).toMatchObject({ recorded: false, services: [] });
  });
});

describe('a failed roll', () => {
  it('rolls every updated service back when one reports FAILED, and records nothing', async () => {
    const { aws, previous } = coreFleet();
    aws.rollouts.set('worker', (_p, to) => ({ primary: to, state: 'FAILED' }));
    const { code, err, result } = await deploy(aws);
    expect(code).toBe(1);
    expect(aws.methods()).not.toContain('putParameter');
    expect(aws.params.get(DIGEST_PARAM)).toBe(OLD_DIGEST);
    expect(aws.services.get('web')).toBe(previous.web);
    expect(aws.services.get('worker')).toBe(previous.worker);
    expect(aws.services.get('relay')).toBe(previous.relay);
    expect(err.at(-1)).toMatch(/every service is back on its previous revision/);
    expect(result).toMatchObject({ recorded: false });
  });

  it('rolls every service back when the wait times out, completed ones included', async () => {
    const { aws, previous } = coreFleet();
    aws.rollouts.set('worker', (_p, to) => ({ primary: to, state: 'IN_PROGRESS' }));
    const { code, result } = await deploy(aws, ['--digest', DIGEST, '--timeout-minutes', '1']);
    expect(code).toBe(1);
    const updates = aws.calls.filter(([m]) => m === 'updateService').map(([, , n, td]) => [n, td]);
    expect(updates.slice(3)).toEqual([
      ['web', previous.web],
      ['worker', previous.worker],
      ['relay', previous.relay],
    ]);
    expect((result?.services as { rolloutState: string }[]).map((s) => s.rolloutState)).toEqual([
      'COMPLETED',
      'TIMED_OUT',
      'COMPLETED',
    ]);
    expect(aws.methods()).not.toContain('putParameter');
  });

  it('skips a service the circuit breaker already returned', async () => {
    const { aws, previous } = coreFleet();
    aws.rollouts.set('relay', (_p, _to, prev) => ({ primary: prev, state: 'COMPLETED' }));
    const { code, err } = await deploy(aws);
    expect(code).toBe(1);
    expect(err).toContain(`rollback: relay already runs ${previous.relay}`);
    expect(aws.methods()).not.toContain('putParameter');
  });

  it('rolls back what it updated when an update is refused part-way', async () => {
    const { aws, previous } = coreFleet();
    aws.failUpdateOf = 'worker';
    const { code, err } = await deploy(aws);
    expect(code).toBe(1);
    expect(err).toContain('roll: update worker refused');
    expect(aws.services.get('web')).toBe(previous.web);
    expect(aws.methods()).not.toContain('putParameter');
  });

  it('leaves a service another deployer moved mid-roll where it is, names it, and records nothing (MOTIR-10117)', async () => {
    const { aws, previous } = coreFleet();
    const cdkRevision = previous.web.replace(/:7$/, ':17');
    aws.rollouts.set('web', () => ({ primary: cdkRevision, state: 'IN_PROGRESS' }));
    const { code, err, result } = await deploy(aws);
    expect(code).toBe(1);
    const rollbacks = aws.calls
      .filter(([m]) => m === 'updateService')
      .slice(3)
      .map(([, , n, td]) => [n, td]);
    expect(rollbacks).toEqual([
      ['worker', previous.worker],
      ['relay', previous.relay],
    ]);
    expect(err).toContain(
      `rollback: web left on ${cdkRevision}, which another deployer put there after this ` +
        'deploy rolled it to arn:aws:ecs:us-east-1:111122223333:task-definition/motir-prod-core-web:8',
    );
    expect(err.at(-1)).toBe(
      'error: the roll was superseded: another deployer moved web to a revision of its own ' +
        'while this deploy waited, and it was left there; every other service is back on its ' +
        'previous revision. Re-run the deploy once the other deploy has finished',
    );
    expect((result?.services as { rolloutState: string }[])[0]?.rolloutState).toBe('SUPERSEDED');
    expect(result).toMatchObject({ recorded: false });
    expect(aws.methods()).not.toContain('putParameter');
  });

  it('refuses before migrating or changing any service when no service runs the core image', async () => {
    const aws = new FakeDeployAws();
    aws.addService('ai', OTHER_REPO);
    const { code, err } = await deploy(aws);
    expect(code).toBe(1);
    expect(aws.methods().filter((m) => CHANGES.includes(m))).toEqual([]);
    expect(aws.methods()).not.toContain('putParameter');
    expect(err.at(-1)).toBe(
      `error: no service in cluster ${CLUSTER} runs ${CORE_REPO}; pass --no-roll for the first deploy`,
    );
  });
});

describe('a deploy during a breach run (MOTIR-10093)', () => {
  it('refuses before migrating, registering or rolling anything, and records nothing', async () => {
    const { aws } = coreFleet();
    const breach = aws.addBreachRevision('worker');
    const { code, err, result } = await deploy(aws);
    expect(code).toBe(1);
    expect(aws.methods().filter((m) => CHANGES.includes(m))).toEqual([]);
    expect(aws.registered).toEqual([]);
    expect(aws.services.get('worker')).toBe(breach);
    expect(aws.params.get(DIGEST_PARAM)).toBe(OLD_DIGEST);
    expect(err.at(-1)).toBe(
      'error: Error: the service worker runs motir-prod-core-worker:9, whose worker container ' +
        'sets MOTIR_BREACH_ENABLED: a breach run holds it. Nothing was migrated, registered or ' +
        'rolled; point the service back at its own revision once the breach ends, then deploy again',
    );
    expect(result).toMatchObject({ migrate: null, services: [], recorded: false });
  });

  it('deploys once the service is back on its own revision', async () => {
    const { aws, previous } = coreFleet();
    aws.addBreachRevision('worker');
    aws.services.set('worker', previous.worker);
    const { code } = await deploy(aws);
    expect(code).toBe(0);
    expect(aws.registered.flatMap((r) => r.containerDefinitions ?? [])).not.toContainEqual(
      expect.objectContaining({ environment: expect.anything() }),
    );
  });

  it('is not consulted with --no-roll, which touches no service', async () => {
    const { aws } = coreFleet();
    aws.addBreachRevision('worker');
    const { code } = await deploy(aws, ['--digest', DIGEST, '--no-roll']);
    expect(code).toBe(0);
    expect(aws.methods()).not.toContain('listServices');
  });
});

// MOTIR-11235 — the reproduction: a motir-infra deploy lands while the migrate
// runs (CloudFormation registers worker:8 with a new environment value and moves
// worker onto it), and another begins right after it. The deploy waits for the
// stack, then clones the revision each service runs at its roll, so the services
// end on the infra environment with only the image changed.
describe('a motir-infra update that overlaps the deploy (MOTIR-11235)', () => {
  const GUARD = { name: 'MOTIR_HOSTING_GUARD_IMAGE', value: 'registry.fly.io/guard@sha256:e9' };

  it('keeps the infra change made during the migrate, on every service it touched', async () => {
    const { aws, previous } = coreFleet();
    let cdk = '';
    aws.migrate = (poll) => {
      if (poll === 0) cdk = aws.addCdkRevision('worker', 8, [GUARD]);
      return migrateExits(0)(poll);
    };
    const { code, result, err } = await deploy(aws);
    expect(code).toBe(0);
    const services = result?.services as { name: string; base: string; taskDefinition: string }[];
    expect(services.map((s) => [s.name, s.base])).toEqual([
      ['web', previous.web],
      ['worker', cdk],
      ['relay', previous.relay],
    ]);
    const worker = services.find((s) => s.name === 'worker');
    const updates = aws.calls.filter(([m, , n]) => m === 'updateService' && n === 'worker');
    expect(updates.map(([, , , td]) => td)).toEqual([worker?.taskDefinition]);
    const running = await aws.describeTaskDefinition(worker?.taskDefinition ?? '');
    expect(running.containerDefinitions?.[0]).toMatchObject({
      image: `${CORE_REPO}@${DIGEST}`,
      environment: [GUARD],
    });
    expect(err).toContain(
      `roll: worker moved from ${previous.worker} to ${cdk} after the deploy read it; ` +
        `${String(worker?.taskDefinition)} is cloned from ${cdk}`,
    );
  });

  it('waits for a services stack update still running after the migrate, then rolls onto it', async () => {
    const { aws, previous } = coreFleet();
    let cdk = '';
    aws.stack = (read) => {
      // The update registers and rolls web:8 while the deploy waits on it.
      if (read === 1) cdk = aws.addCdkRevision('web', 8, [GUARD]);
      return { state: 'granted', value: read < 2 ? 'UPDATE_IN_PROGRESS' : 'UPDATE_COMPLETE' };
    };
    const { code, result, err } = await deploy(aws);
    expect(code).toBe(0);
    expect(aws.calls.filter(([m]) => m === 'stackStatus')).toEqual([
      ['stackStatus', 'motir-prod-services'],
      ['stackStatus', 'motir-prod-services'],
      ['stackStatus', 'motir-prod-services'],
    ]);
    // Nothing is registered for a service, or updated, while the stack is busy.
    const methods = aws.methods();
    expect(methods.lastIndexOf('stackStatus')).toBeLessThan(methods.indexOf('updateService'));
    const services = result?.services as { name: string; base: string }[];
    expect(services.find((s) => s.name === 'web')?.base).toBe(cdk);
    expect(services.find((s) => s.name === 'worker')?.base).toBe(previous.worker);
    expect(err).toContain(
      'stack: waiting for motir-prod-services (UPDATE_IN_PROGRESS) to finish before the roll',
    );
  });
});

describe('--no-roll', () => {
  it('verifies, migrates and records, touching no service', async () => {
    const aws = new FakeDeployAws();
    const { code, result } = await deploy(aws, ['--digest', DIGEST, '--no-roll']);
    expect(code).toBe(0);
    expect(aws.methods()).not.toContain('listServices');
    expect(aws.methods()).not.toContain('updateService');
    expect(aws.methods().at(-1)).toBe('putParameter');
    expect(aws.params.get(DIGEST_PARAM)).toBe(DIGEST);
    expect(result).toMatchObject({ services: [], recorded: true, migrate: { exitCode: 0 } });
  });

  it('records nothing when the migrate task fails', async () => {
    const aws = new FakeDeployAws();
    aws.migrate = migrateExits(1);
    const { code } = await deploy(aws, ['--digest', DIGEST, '--no-roll']);
    expect(code).toBe(1);
    expect(aws.methods()).not.toContain('putParameter');
  });
});

describe('the grant and the credentials', () => {
  it('reports a non-Error throw generically', async () => {
    const aws = new FakeDeployAws();
    aws.getParameter = () => Promise.reject('boom' as unknown as Error);
    const { code, err } = await deploy(aws);
    expect(code).toBe(1);
    expect(err.at(-1)).toBe('error: unknown error');
  });

  it('reads only AWS_REGION and AWS_DEPLOY_NAME_PREFIX from the environment', async () => {
    const read = new Set<string>();
    const env = new Proxy({ ...ENV } as Record<string, string>, {
      get: (target, name) => {
        if (typeof name === 'string') read.add(name);
        return target[name as string];
      },
    });
    await deploy(new FakeDeployAws(), ['--digest', DIGEST, '--no-roll'], env as typeof ENV);
    expect([...read].sort()).toEqual(['AWS_DEPLOY_NAME_PREFIX', 'AWS_REGION']);
  });

  it('issues only granted actions in every test above', () => {
    expect(issued.size).toBeGreaterThan(8);
    for (const action of issued) expect(GRANTED_ACTIONS).toContain(action);
  });

  it('gives no SDK client a credentials option and reads no key variable', () => {
    const source = readFileSync('scripts/aws-deploy/ports.ts', 'utf8');
    expect(source).not.toMatch(/credentials\s*:/);
    expect(source).not.toMatch(
      /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|process\.env/,
    );
    for (const match of source.matchAll(/new (\w+Client)\(([^)]*)\)/g)) {
      expect(match[2]).toBe('{ region }');
    }
  });

  it('holds the granted list to the deploy role in motir-infra (MOTIR-9924)', () => {
    // The role's statements, less ecr:BatchGetImage (ECS pulls) and iam:PassRole (ECS checks).
    expect([...GRANTED_ACTIONS].sort()).toEqual(
      [
        'ecr:DescribeImages',
        'ecs:DescribeServices',
        'ecs:DescribeTaskDefinition',
        'ecs:DescribeTasks',
        'ecs:ListServices',
        'ecs:RegisterTaskDefinition',
        'ecs:RunTask',
        'ecs:StopTask',
        'ecs:UpdateService',
        'logs:GetLogEvents',
        // The image pins (MOTIR-10883): motir-infra's `WriteImagePins` statement.
        'secretsmanager:GetSecretValue',
        'secretsmanager:PutSecretValue',
        'ssm:GetParameter',
        'ssm:PutParameter',
        // The stack wait after the migrate (MOTIR-11235): motir-infra's `ReadServicesStack`.
        'cloudformation:DescribeStacks',
      ].sort(),
    );
  });

  it('builds the production ports for the region without touching AWS', async () => {
    const { awsSdkPorts } = await import('@/scripts/aws-deploy/ports');
    const ports: DeployAws = awsSdkPorts('us-east-1');
    expect(typeof ports.runTask).toBe('function');
    expect(ports.now()).toBeGreaterThan(0);
    await ports.sleep(0);
  });
});

describe('parseDeployArgs', () => {
  it('defaults the timeout to 20 minutes and --no-roll to false', () => {
    expect(parseDeployArgs(['--digest', DIGEST])).toEqual({
      digest: DIGEST,
      timeoutMs: 20 * 60_000,
      noRoll: false,
      pinsDir: null,
    });
    expect(parseDeployArgs(['--digest', DIGEST, '--timeout-minutes', '5', '--no-roll'])).toEqual({
      digest: DIGEST,
      timeoutMs: 5 * 60_000,
      noRoll: true,
      pinsDir: null,
    });
    expect(parseDeployArgs(['--digest', DIGEST, '--pins', 'infra/image-pins'])).toMatchObject({
      pinsDir: 'infra/image-pins',
    });
  });
});

describe('the script entry', () => {
  it('prints the usage to stderr and exits 1 with no flags, writing the JSON line to stdout otherwise', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const exit = vi.fn();
      await entry([], exit);
      expect(exit).toHaveBeenCalledWith(1);
      expect(stderr).toHaveBeenCalledWith(`${USAGE}\n`);
      processIo.out('{}');
      expect(stdout).toHaveBeenCalledWith('{}\n');
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it('exits through process.exit by default', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await entry([]);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      stderr.mockRestore();
      exit.mockRestore();
    }
  });
});
