import { describe, expect, it } from 'vitest';
import { POLL_INTERVAL_MS } from '@/scripts/aws-deploy/migrateRun';
import {
  REBASE_ATTEMPTS,
  findCoreServices,
  rollBack,
  rollServices,
  type RollRecord,
} from '@/scripts/aws-deploy/rollingDeploy';
import {
  CLUSTER,
  CORE_REPO,
  DEPLOY_ROLE,
  DIGEST,
  FakeDeployAws,
  OPERATOR,
  OLD_DIGEST,
  OTHER_REPO,
  completesAfter,
  container,
  taskDefinition,
} from './fakeDeployAws';

// MOTIR-9927 — only core's services roll, each onto a revision with only the
// image changed, and a failure puts every one back on what it ran before.

const IMAGE = `${CORE_REPO}@${DIGEST}`;
const MINUTE = 60_000;

function fleet() {
  const aws = new FakeDeployAws();
  const previous = {
    web: aws.addService('web', CORE_REPO),
    worker: aws.addService('worker', CORE_REPO, completesAfter(3)),
    relay: aws.addService('relay', CORE_REPO),
    ai: aws.addService('ai', OTHER_REPO),
  };
  return { aws, previous };
}

const noLog = () => undefined;

describe('findCoreServices', () => {
  it('keeps the services running the core repository and records their revision', async () => {
    const { aws, previous } = fleet();
    const found = await findCoreServices(aws, CLUSTER, CORE_REPO);
    expect(found).toEqual([
      { name: 'web', previousTaskDefinition: previous.web, containers: ['web'] },
      { name: 'worker', previousTaskDefinition: previous.worker, containers: ['worker'] },
      { name: 'relay', previousTaskDefinition: previous.relay, containers: ['relay'] },
    ]);
  });

  it('refuses a core service on a breach revision, naming it and the container (MOTIR-10093)', async () => {
    const { aws } = fleet();
    aws.addBreachRevision('worker');
    await expect(findCoreServices(aws, CLUSTER, CORE_REPO)).rejects.toThrow(
      'the service worker runs motir-prod-core-worker:9, whose worker container sets ' +
        'MOTIR_BREACH_ENABLED: a breach run holds it.',
    );
    expect(aws.registered).toEqual([]);
  });

  it('leaves a breach revision of a service that runs another image to that service', async () => {
    const { aws } = fleet();
    aws.addBreachRevision('ai');
    expect((await findCoreServices(aws, CLUSTER, CORE_REPO)).map((s) => s.name)).toEqual([
      'web',
      'worker',
      'relay',
    ]);
  });

  it('returns none for an empty cluster without describing anything', async () => {
    const aws = new FakeDeployAws();
    expect(await findCoreServices(aws, CLUSTER, CORE_REPO)).toEqual([]);
    expect(aws.methods()).toEqual(['listServices']);
  });

  it('skips a described service with no name or task definition', async () => {
    const aws = new FakeDeployAws();
    aws.listServices = () => Promise.resolve(['arn:x']);
    aws.describeServices = () => Promise.resolve([{ serviceName: 'half' }, {}]);
    expect(await findCoreServices(aws, CLUSTER, CORE_REPO)).toEqual([]);
  });
});

describe('rollServices', () => {
  it('registers each core service with only the image changed, updates all, then waits', async () => {
    const { aws, previous } = fleet();
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, noLog);
    expect(outcome.ok).toBe(true);
    expect(outcome.services.map((s) => [s.name, s.rolloutState])).toEqual([
      ['web', 'COMPLETED'],
      ['worker', 'COMPLETED'],
      ['relay', 'COMPLETED'],
    ]);
    expect(aws.registered.map((r) => r.containerDefinitions?.[0]?.image)).toEqual([
      IMAGE,
      IMAGE,
      IMAGE,
    ]);
    expect(aws.registered.map((r) => r.family)).toEqual([
      'motir-prod-core-web',
      'motir-prod-core-worker',
      'motir-prod-core-relay',
    ]);
    const updates = aws.calls.filter(([m]) => m === 'updateService').map(([, , name]) => name);
    expect(updates).toEqual(['web', 'worker', 'relay']);
    expect(aws.calls.some(([m, , name]) => m === 'updateService' && name === 'ai')).toBe(false);
    expect(aws.services.get('ai')).toBe(previous.ai);
    // All three updated before the first wait.
    const methods = aws.methods();
    expect(methods.lastIndexOf('updateService')).toBeLessThan(
      methods.lastIndexOf('describeServices'),
    );
    expect(aws.now()).toBe(3 * POLL_INTERVAL_MS);
  });

  it('sets the image on every core container of a service', async () => {
    const aws = new FakeDeployAws();
    const arn = aws.addDefinition(
      taskDefinition('motir-prod-core-pair', 2, [
        container('a', `${CORE_REPO}@${OLD_DIGEST}`),
        container('b', `${CORE_REPO}@${OLD_DIGEST}`),
        container('c', `${OTHER_REPO}@${OLD_DIGEST}`),
      ]),
    );
    aws.services.set('pair', arn);
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    await rollServices(aws, CLUSTER, services, IMAGE, MINUTE, noLog);
    expect(aws.registered[0]?.containerDefinitions?.map((c) => c.image)).toEqual([
      IMAGE,
      IMAGE,
      `${OTHER_REPO}@${OLD_DIGEST}`,
    ]);
  });

  it('reports FAILED as soon as one service fails', async () => {
    const { aws } = fleet();
    aws.rollouts.set('web', (_p, rolledTo) => ({ primary: rolledTo, state: 'FAILED' }));
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, noLog);
    expect(outcome.ok).toBe(false);
    expect(outcome.services.find((s) => s.name === 'web')?.rolloutState).toBe('FAILED');
  });

  it('treats a circuit-breaker rollback (old revision primary) as FAILED, not COMPLETED', async () => {
    const { aws } = fleet();
    aws.rollouts.set('relay', (_p, _to, previous) => ({ primary: previous, state: 'COMPLETED' }));
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, noLog);
    expect(outcome.ok).toBe(false);
    expect(outcome.services.find((s) => s.name === 'relay')?.rolloutState).toBe('FAILED');
  });

  it('times out the services still in progress at the deadline', async () => {
    const { aws } = fleet();
    aws.rollouts.set('worker', (_p, rolledTo) => ({ primary: rolledTo, state: 'IN_PROGRESS' }));
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, 2 * MINUTE, noLog);
    expect(outcome.ok).toBe(false);
    expect(outcome.services.map((s) => s.rolloutState)).toEqual([
      'COMPLETED',
      'TIMED_OUT',
      'COMPLETED',
    ]);
  });

  it('reads a service missing from the description as FAILED', async () => {
    const { aws } = fleet();
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    // Present for the read before each register, gone from the rollout's reads.
    const describe = aws.describeServices.bind(aws);
    aws.describeServices = (cluster, names) =>
      aws.methods().filter((m) => m === 'updateService').length === services.length
        ? Promise.resolve([])
        : describe(cluster, names);
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, MINUTE, noLog);
    expect(outcome.services.every((s) => s.rolloutState === 'FAILED')).toBe(true);
  });

  it('throws naming a service the cluster no longer has at its register, registering nothing for it', async () => {
    const { aws } = fleet();
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    aws.services.delete('worker');
    const updated = new Map<string, RollRecord>();
    await expect(
      rollServices(aws, CLUSTER, services, IMAGE, MINUTE, noLog, updated),
    ).rejects.toThrow('cluster motir-prod-core no longer has the service worker');
    expect(aws.registered.map((r) => r.family)).toEqual(['motir-prod-core-web']);
    expect([...updated.keys()]).toEqual(['web']);
  });
});

describe('rollBack', () => {
  it('returns every updated service to its recorded revision, skipping one already there', async () => {
    const { aws, previous } = fleet();
    aws.rollouts.set('relay', (_p, _to, prev) => ({ primary: prev, state: 'COMPLETED' }));
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const updated = new Map<string, RollRecord>();
    await rollServices(aws, CLUSTER, services, IMAGE, MINUTE, noLog, updated);
    const before = aws.calls.length;
    const log: string[] = [];
    await rollBack(aws, CLUSTER, services, updated, (l) => log.push(l));
    const rollbacks = aws.calls.slice(before).filter(([m]) => m === 'updateService');
    expect(rollbacks.map(([, , name, td]) => [name, td])).toEqual([
      ['web', previous.web],
      ['worker', previous.worker],
    ]);
    expect(log).toContain(`rollback: relay already runs ${previous.relay}`);
    expect(aws.services.get('web')).toBe(previous.web);
  });

  it('records each update it issues in the map it is handed', async () => {
    const { aws } = fleet();
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const updated = new Map<string, RollRecord>();
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, MINUTE, noLog, updated);
    expect([...updated]).toEqual(
      outcome.services.map((s) => [
        s.name,
        { base: s.base, clonedFrom: s.clonedFrom, rolledTo: s.taskDefinition },
      ]),
    );
  });
});

// MOTIR-10117 — a motir-infra deploy that updates a service while the roll waits
// makes ITS revision primary. That is neither this deploy's revision nor the one
// the service ran before, and forcing the previous one back would undo it.
describe('a roll superseded by another deployer', () => {
  const CDK_REVISION = 'arn:aws:ecs:us-east-1:111122223333:task-definition/motir-prod-core-web:17';

  function superseded() {
    const { aws, previous } = fleet();
    aws.rollouts.set('web', () => ({ primary: CDK_REVISION, state: 'IN_PROGRESS' }));
    return { aws, previous };
  }

  it('names the service SUPERSEDED and stops waiting', async () => {
    const { aws } = superseded();
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, noLog);
    expect(outcome.ok).toBe(false);
    expect(outcome.services.map((s) => [s.name, s.rolloutState])).toEqual([
      ['web', 'SUPERSEDED'],
      ['worker', 'IN_PROGRESS'],
      ['relay', 'IN_PROGRESS'],
    ]);
    expect(aws.now()).toBe(0);
  });

  it('issues no updateService for the superseded service, and rolls back the rest', async () => {
    const { aws, previous } = superseded();
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const updated = new Map<string, RollRecord>();
    await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, noLog, updated);
    const before = aws.calls.length;
    const log: string[] = [];
    await rollBack(aws, CLUSTER, services, updated, (l) => log.push(l));
    const rollbacks = aws.calls.slice(before).filter(([m]) => m === 'updateService');
    expect(rollbacks.map(([, , name, td]) => [name, td])).toEqual([
      ['worker', previous.worker],
      ['relay', previous.relay],
    ]);
    expect(log).toContain(
      `rollback: web left on ${CDK_REVISION}, which another deployer put there after this ` +
        `deploy rolled it to ${String(updated.get('web')?.rolledTo)}`,
    );
  });

  it('leaves a service it never updated on whatever runs there now', async () => {
    const { aws, previous } = fleet();
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    aws.services.set('relay', CDK_REVISION);
    const log: string[] = [];
    await rollBack(aws, CLUSTER, services, new Map(), (l) => log.push(l));
    expect(aws.methods()).not.toContain('updateService');
    expect(log).toEqual([
      `rollback: web already runs ${previous.web}`,
      `rollback: worker already runs ${previous.worker}`,
      `rollback: relay left on ${CDK_REVISION}, which another deployer put there after this deploy`,
    ]);
  });
});

// MOTIR-11235 — findCoreServices reads each service BEFORE the migrate runs. A
// motir-infra stack update that lands during the migrate registers and rolls a
// revision of its own (the CDK one), and cloning the old read would roll the
// services back over it with every run green. Each service is read again right
// before its register, and the revision it runs then is the one cloned.
describe('a service another deployer moved before the roll', () => {
  const GUARD = { name: 'MOTIR_HOSTING_GUARD_IMAGE', value: 'registry.fly.io/guard@sha256:e9' };

  const cdkRevision = (aws: FakeDeployAws, name: string, revision: number) =>
    aws.addCdkRevision(name, revision, [GUARD]);

  it('clones the revision the service runs at its register, with only the image changed', async () => {
    const { aws, previous } = fleet();
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const cdk = cdkRevision(aws, 'worker', 8);
    const log: string[] = [];
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, (l) =>
      log.push(l),
    );
    expect(outcome.ok).toBe(true);
    const worker = aws.registered.find((r) => r.family === 'motir-prod-core-worker');
    const expected = structuredClone(await aws.describeTaskDefinition(cdk))
      .containerDefinitions?.[0];
    expect(worker?.containerDefinitions).toEqual([{ ...expected, image: IMAGE }]);
    expect(worker?.containerDefinitions?.[0]?.environment).toEqual([GUARD]);
    const rolledWorker = outcome.services.find((s) => s.name === 'worker');
    expect(rolledWorker).toMatchObject({ base: cdk, rolloutState: 'COMPLETED' });
    expect(rolledWorker?.taskDefinition).toContain('motir-prod-core-worker:9');
    // The one update worker gets is onto the CDK clone, never one of the stale read.
    const updates = aws.calls.filter(([m, , n]) => m === 'updateService' && n === 'worker');
    expect(updates.map(([, , , td]) => td)).toEqual([rolledWorker?.taskDefinition]);
    expect(log).toContain(
      `roll: worker moved from ${previous.worker} to ${cdk} after the deploy read it; ` +
        `${String(rolledWorker?.taskDefinition)} is cloned from ${cdk}`,
    );
    // The services the other deployer left alone are cloned from what step 2 read.
    expect(outcome.services.find((s) => s.name === 'web')?.base).toBe(previous.web);
  });

  it('reads, registers and updates each service in turn, before the first wait', async () => {
    const { aws } = fleet();
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const before = aws.calls.length;
    await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, noLog);
    const steps = aws.calls
      .slice(before, before + 15)
      .map(([m, , n]) => (m === 'updateService' ? `update ${String(n)}` : m));
    expect(steps).toEqual([
      'describeServices',
      'describeTaskDefinition',
      'describeTaskDefinition',
      'registerTaskDefinition',
      'update web',
      'describeServices',
      'describeTaskDefinition',
      'describeTaskDefinition',
      'registerTaskDefinition',
      'update worker',
      'describeServices',
      'describeTaskDefinition',
      'describeTaskDefinition',
      'registerTaskDefinition',
      'update relay',
    ]);
  });

  it('rolls a rebased service back to the revision the other deployer put there', async () => {
    const { aws, previous } = fleet();
    aws.rollouts.set('web', (_p, rolledTo) => ({ primary: rolledTo, state: 'FAILED' }));
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const cdk = cdkRevision(aws, 'worker', 8);
    const updated = new Map<string, RollRecord>();
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, noLog, updated);
    expect(outcome.ok).toBe(false);
    const before = aws.calls.length;
    await rollBack(aws, CLUSTER, services, updated, noLog);
    const rollbacks = aws.calls.slice(before).filter(([m]) => m === 'updateService');
    expect(rollbacks.map(([, , name, td]) => [name, td])).toEqual([
      ['web', previous.web],
      ['worker', cdk],
      ['relay', previous.relay],
    ]);
    expect(aws.services.get('worker')).toBe(cdk);
  });

  it('reads a circuit-breaker rollback onto the rebased revision as FAILED', async () => {
    const { aws } = fleet();
    aws.rollouts.set('worker', (_p, _to, current) => ({ primary: current, state: 'COMPLETED' }));
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    cdkRevision(aws, 'worker', 8);
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, noLog);
    expect(outcome.services.find((s) => s.name === 'worker')?.rolloutState).toBe('FAILED');
  });

  it('refuses a live revision that sets the breach guard, registering nothing for it', async () => {
    const { aws } = fleet();
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    aws.addBreachRevision('relay');
    await expect(rollServices(aws, CLUSTER, services, IMAGE, MINUTE, noLog)).rejects.toThrow(
      'the service relay runs motir-prod-core-relay:9, whose relay container sets ' +
        'MOTIR_BREACH_ENABLED: a breach run holds it. It was not rolled, nor any service ' +
        'after it; point the service back',
    );
    expect(aws.registered.map((r) => r.family)).toEqual([
      'motir-prod-core-web',
      'motir-prod-core-worker',
    ]);
  });

  it('reads again when another deployer registers in the family between its read and register', async () => {
    const { aws } = fleet();
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const register = aws.registerTaskDefinition.bind(aws);
    let cdk = '';
    aws.registerTaskDefinition = (input) => {
      // CloudFormation registers worker:8 and moves the service onto it just
      // before this deploy's first worker register lands.
      if (input.family === 'motir-prod-core-worker' && !cdk) cdk = cdkRevision(aws, 'worker', 8);
      return register(input);
    };
    const log: string[] = [];
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, (l) =>
      log.push(l),
    );
    expect(outcome.ok).toBe(true);
    const workers = aws.registered.filter((r) => r.family === 'motir-prod-core-worker');
    expect(workers.map((w) => w.containerDefinitions?.[0]?.environment)).toEqual([
      undefined,
      [GUARD],
    ]);
    const rolledWorker = outcome.services.find((s) => s.name === 'worker');
    expect(rolledWorker).toMatchObject({ base: cdk, rolloutState: 'COMPLETED' });
    expect(rolledWorker?.taskDefinition).toContain('motir-prod-core-worker:10');
    const updates = aws.calls.filter(([m, , n]) => m === 'updateService' && n === 'worker');
    expect(updates.map(([, , , td]) => td)).toEqual([rolledWorker?.taskDefinition]);
    expect(log).toContain(
      'roll: another deployer registered a motir-prod-core-worker revision after ' +
        "motir-prod-core-worker:7, beside this deploy's " +
        'arn:aws:ecs:us-east-1:111122223333:task-definition/motir-prod-core-worker:9; ' +
        'reading worker again',
    );
    expect(aws.now()).toBeGreaterThanOrEqual(POLL_INTERVAL_MS);
  });

  it(`gives up after ${String(REBASE_ATTEMPTS)} reads when the family keeps moving, updating nothing for it`, async () => {
    const { aws } = fleet();
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const register = aws.registerTaskDefinition.bind(aws);
    let next = 8;
    aws.registerTaskDefinition = (input) => {
      if (input.family === 'motir-prod-core-worker') {
        cdkRevision(aws, 'worker', next);
        next += 2;
      }
      return register(input);
    };
    const updated = new Map<string, RollRecord>();
    await expect(
      rollServices(aws, CLUSTER, services, IMAGE, MINUTE, noLog, updated),
    ).rejects.toThrow(
      'another deployer kept registering motir-prod-core-worker revisions while this deploy ' +
        `registered worker's (${String(REBASE_ATTEMPTS)} attempts, last ` +
        'arn:aws:ecs:us-east-1:111122223333:task-definition/motir-prod-core-worker:13)',
    );
    expect(aws.calls.some(([m, , n]) => m === 'updateService' && n === 'worker')).toBe(false);
    expect([...updated.keys()]).toEqual(['web']);
  });
});

// MOTIR-11235 — the clone source is the newest revision CloudFormation registered,
// not the one the service runs. Production on 2026-11-13: worker ran :277, the
// core deploy's clone of a stale read, without the pin CloudFormation's :276 had.
describe('the clone source is the infra baseline', () => {
  const GUARD = { name: 'MOTIR_HOSTING_GUARD_IMAGE', value: 'registry.fly.io/guard@sha256:e9' };

  /** worker:8 is CloudFormation's, with the pin; the service runs worker:9, registered by `by`. */
  function lostPin(by: string) {
    const { aws, previous } = fleet();
    const cdk = aws.addCdkRevision('worker', 8, [GUARD]);
    const stale = aws.addDefinition({
      ...taskDefinition('motir-prod-core-worker', 9, [
        container('worker', `${CORE_REPO}@${OLD_DIGEST}`),
      ]),
      registeredBy: by,
    });
    aws.services.set('worker', stale);
    return { aws, previous, cdk, stale };
  }

  it('restores an infra field a stale clone lost: worker rolls onto the CloudFormation revision', async () => {
    const { aws, cdk, stale } = lostPin(DEPLOY_ROLE);
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const log: string[] = [];
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, (l) =>
      log.push(l),
    );
    expect(outcome.ok).toBe(true);
    const worker = aws.registered.find((r) => r.family === 'motir-prod-core-worker');
    expect(worker?.containerDefinitions?.[0]).toMatchObject({ image: IMAGE, environment: [GUARD] });
    const rolled = outcome.services.find((s) => s.name === 'worker');
    expect(rolled).toMatchObject({ base: stale, clonedFrom: cdk, rolloutState: 'COMPLETED' });
    expect(log).toContain(
      `roll: worker runs ${stale}; ${String(rolled?.taskDefinition)} is cloned from ${cdk}`,
    );
  });

  it('rolls such a service back to what it ran, not to the baseline', async () => {
    const { aws, stale } = lostPin(DEPLOY_ROLE);
    aws.rollouts.set('worker', (_p, rolledTo) => ({ primary: rolledTo, state: 'FAILED' }));
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const updated = new Map<string, RollRecord>();
    await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, noLog, updated);
    await rollBack(aws, CLUSTER, services, updated, noLog);
    expect(aws.services.get('worker')).toBe(stale);
  });

  it('replaces a revision a person registered by hand with the baseline', async () => {
    const { aws, cdk } = lostPin(OPERATOR);
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, noLog);
    expect(outcome.services.find((s) => s.name === 'worker')?.clonedFrom).toBe(cdk);
  });

  it('clones the revision the service runs when no baseline can be read, saying so', async () => {
    const { aws, previous } = fleet();
    // relay:7 is the only revision; the deploy registered relay:9, and relay:8 is gone.
    const own = aws.addDefinition({
      ...taskDefinition('motir-prod-core-relay', 9, [
        container('relay', `${CORE_REPO}@${OLD_DIGEST}`),
      ]),
      registeredBy: DEPLOY_ROLE,
    });
    aws.services.set('relay', own);
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    const log: string[] = [];
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, 20 * MINUTE, (l) =>
      log.push(l),
    );
    expect(outcome.services.find((s) => s.name === 'relay')).toMatchObject({
      base: own,
      clonedFrom: own,
    });
    expect(log).toContain('baseline: could not read motir-prod-core-relay:8 (no such)');
    expect(log).toContain(
      'roll: relay is cloned from the revision it runs, motir-prod-core-relay:9',
    );
    expect(outcome.services.find((s) => s.name === 'web')?.clonedFrom).toBe(previous.web);
  });
});
