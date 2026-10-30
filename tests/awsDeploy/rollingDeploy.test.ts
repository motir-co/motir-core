import { describe, expect, it } from 'vitest';
import { POLL_INTERVAL_MS } from '@/scripts/aws-deploy/migrateRun';
import { findCoreServices, rollBack, rollServices } from '@/scripts/aws-deploy/rollingDeploy';
import {
  CLUSTER,
  CORE_REPO,
  DIGEST,
  FakeDeployAws,
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
    aws.describeServices = () => Promise.resolve([]);
    const outcome = await rollServices(aws, CLUSTER, services, IMAGE, MINUTE, noLog);
    expect(outcome.services.every((s) => s.rolloutState === 'FAILED')).toBe(true);
  });
});

describe('rollBack', () => {
  it('returns every updated service to its recorded revision, skipping one already there', async () => {
    const { aws, previous } = fleet();
    aws.rollouts.set('relay', (_p, _to, prev) => ({ primary: prev, state: 'COMPLETED' }));
    const services = await findCoreServices(aws, CLUSTER, CORE_REPO);
    await rollServices(aws, CLUSTER, services, IMAGE, MINUTE, noLog);
    const before = aws.calls.length;
    const log: string[] = [];
    await rollBack(aws, CLUSTER, services, (l) => log.push(l));
    const rollbacks = aws.calls.slice(before).filter(([m]) => m === 'updateService');
    expect(rollbacks.map(([, , name, td]) => [name, td])).toEqual([
      ['web', previous.web],
      ['worker', previous.worker],
    ]);
    expect(log).toContain(`rollback: relay already runs ${previous.relay}`);
    expect(aws.services.get('web')).toBe(previous.web);
  });
});
