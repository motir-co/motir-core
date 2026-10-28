import { describe, expect, it } from 'vitest';
import { LOG_TAIL_LINES, POLL_INTERVAL_MS, runMigrate } from '@/scripts/aws-deploy/migrateRun';
import {
  CORE_REPO,
  DIGEST,
  FakeDeployAws,
  TARGET,
  container,
  migrateExits,
  taskDefinition,
} from './fakeDeployAws';

// MOTIR-9927 — the migrate task: registered from the digest, run once in the
// target, and only a container exit of 0 passes.

const IMAGE = `${CORE_REPO}@${DIGEST}`;
const MINUTE = 60_000;

async function run(aws: FakeDeployAws, timeoutMs = 20 * MINUTE) {
  const log: string[] = [];
  const result = await runMigrate(aws, TARGET, IMAGE, timeoutMs, (l) => log.push(l));
  return { result, log };
}

describe('runMigrate', () => {
  it('registers the latest revision with the digest image and runs it once in the target, no public IP', async () => {
    const aws = new FakeDeployAws();
    const { result } = await run(aws);
    expect(result).toEqual({ ok: true, taskArn: expect.stringContaining('/abc123'), exitCode: 0 });
    expect(aws.registered).toHaveLength(1);
    expect(aws.registered[0]?.containerDefinitions?.[0]?.image).toBe(IMAGE);
    expect(aws.registered[0]?.family).toBe(TARGET.migrateFamily);
    const runs = aws.calls.filter(([m]) => m === 'runTask');
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]?.[1] ?? '{}')).toEqual({
      cluster: TARGET.cluster,
      taskDefinition: expect.stringContaining(`${TARGET.migrateFamily}:4`),
      launchType: 'FARGATE',
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: TARGET.subnets,
          securityGroups: TARGET.securityGroups,
          assignPublicIp: 'DISABLED',
        },
      },
    });
  });

  it('polls every 15 seconds until the task stops', async () => {
    const aws = new FakeDeployAws();
    aws.migrate = migrateExits(0, 3);
    const { result } = await run(aws);
    expect(result.ok).toBe(true);
    expect(aws.methods().filter((m) => m === 'describeTask')).toHaveLength(4);
    expect(aws.now()).toBe(3 * POLL_INTERVAL_MS);
  });

  it('fails on a non-zero exit and prints the last 50 log lines of the migrate stream', async () => {
    const aws = new FakeDeployAws();
    aws.migrate = migrateExits(1);
    aws.logLines.push(...Array.from({ length: 80 }, (_, i) => `line ${String(i)}`));
    const { result, log } = await run(aws);
    expect(result).toEqual({
      ok: false,
      taskArn: expect.any(String),
      exitCode: 1,
      reason: 'exited 1',
    });
    const tail = aws.calls.find(([m]) => m === 'tailLog');
    expect(tail).toEqual([
      'tailLog',
      '/motir-prod/core/migrate',
      'migrate/migrate/abc123',
      String(LOG_TAIL_LINES),
    ]);
    expect(log).toContain('  line 30');
    expect(log).toContain('  line 79');
    expect(log).not.toContain('  line 29');
  });

  it('reports a task that stopped without running, with its reasons', async () => {
    const aws = new FakeDeployAws();
    aws.migrate = () => ({
      lastStatus: 'STOPPED',
      stoppedReason: 'ResourceInitializationError: unable to pull secrets',
      containers: [{ name: 'migrate', reason: 'CannotPullContainerError' }],
    });
    const { result } = await run(aws);
    expect(result).toEqual({
      ok: false,
      taskArn: expect.any(String),
      exitCode: null,
      reason:
        'never ran: ResourceInitializationError: unable to pull secrets; CannotPullContainerError',
    });
  });

  it('says so when a task that never ran gave no reason', async () => {
    const aws = new FakeDeployAws();
    aws.migrate = () => ({ lastStatus: 'STOPPED' });
    const { result } = await run(aws);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toBe('never ran: no reason given');
  });

  it('stops the task when the wait passes the timeout', async () => {
    const aws = new FakeDeployAws();
    aws.migrate = () => ({ lastStatus: 'RUNNING' });
    const { result } = await run(aws, 2 * MINUTE);
    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      reason: 'timed out; the task was stopped',
    });
    expect(aws.calls.filter(([m]) => m === 'stopTask')).toHaveLength(1);
    expect(aws.now()).toBeGreaterThanOrEqual(2 * MINUTE);
  });

  it('notes a definition with no awslogs options instead of tailing', async () => {
    const aws = new FakeDeployAws();
    const bare = { ...container('migrate', `${CORE_REPO}@x`), logConfiguration: undefined };
    aws.addDefinition(taskDefinition(TARGET.migrateFamily, 3, [bare]));
    aws.migrate = migrateExits(2);
    const { log } = await run(aws);
    expect(aws.methods()).not.toContain('tailLog');
    expect(log.join('\n')).toMatch(/names no awslogs group/);
  });

  it('still fails cleanly when the log stream cannot be read', async () => {
    const aws = new FakeDeployAws();
    aws.migrate = migrateExits(1);
    aws.tailLog = () =>
      Promise.reject(Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' }));
    const { result, log } = await run(aws);
    expect(result.ok).toBe(false);
    expect(log.join('\n')).toMatch(/could not read .*: ResourceNotFoundException/);
  });

  it('names a non-Error log failure generically', async () => {
    const aws = new FakeDeployAws();
    aws.migrate = migrateExits(1);
    aws.tailLog = () => Promise.reject('nope' as unknown as Error);
    const { log } = await run(aws);
    expect(log.join('\n')).toMatch(/could not read .*: error$/);
  });
});
