import { describe, expect, it } from 'vitest';
import { POLL_INTERVAL_MS } from '@/scripts/aws-deploy/migrateRun';
import {
  isStackBusy,
  servicesStackName,
  waitForServicesStack,
} from '@/scripts/aws-deploy/stackWait';
import { FakeDeployAws, PREFIX } from './fakeDeployAws';

// MOTIR-11235 — the roll does not start while motir-infra updates the services
// stack: an update that began during the migrate registers and rolls revisions
// of its own, and a roll racing it overwrites them. A status the deploy cannot
// read, or a stack still busy at the deadline, never stops the deploy.

const STACK = servicesStackName(PREFIX);
const MINUTE = 60_000;

/** A stack that reads `busy` for `polls` reads, then UPDATE_COMPLETE. */
const settlesAfter =
  (polls: number, busy = 'UPDATE_IN_PROGRESS') =>
  (read: number) =>
    ({ state: 'granted', value: read < polls ? busy : 'UPDATE_COMPLETE' }) as const;

describe('servicesStackName', () => {
  it('is the stack motir-infra names for the prefix, as the workflow gate reads it', () => {
    expect(STACK).toBe('motir-prod-services');
  });
});

describe('isStackBusy', () => {
  it('reads every *_IN_PROGRESS status as busy, and nothing else', () => {
    for (const status of [
      'UPDATE_IN_PROGRESS',
      'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
      'UPDATE_ROLLBACK_IN_PROGRESS',
      'CREATE_IN_PROGRESS',
    ]) {
      expect(isStackBusy(status)).toBe(true);
    }
    for (const status of ['UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'CREATE_COMPLETE']) {
      expect(isStackBusy(status)).toBe(false);
    }
    expect(isStackBusy(undefined)).toBe(false);
  });
});

describe('waitForServicesStack', () => {
  it('returns at once on a settled stack, reading it once and sleeping never', async () => {
    const aws = new FakeDeployAws();
    const log: string[] = [];
    expect(await waitForServicesStack(aws, STACK, MINUTE, (l) => log.push(l))).toBe(true);
    expect(aws.calls).toEqual([['stackStatus', STACK]]);
    expect(aws.now()).toBe(0);
    expect(log).toEqual([]);
  });

  it('waits a poll at a time while the stack updates, then lets the roll go', async () => {
    const aws = new FakeDeployAws();
    aws.stack = settlesAfter(2);
    const log: string[] = [];
    expect(await waitForServicesStack(aws, STACK, 20 * MINUTE, (l) => log.push(l))).toBe(true);
    expect(aws.stackReads).toBe(3);
    expect(aws.now()).toBe(2 * POLL_INTERVAL_MS);
    expect(log).toEqual([
      `stack: waiting for ${STACK} (UPDATE_IN_PROGRESS) to finish before the roll`,
      `stack: waiting for ${STACK} (UPDATE_IN_PROGRESS) to finish before the roll`,
    ]);
  });

  it('rolls anyway, saying so, when the stack is still busy at the deadline', async () => {
    const aws = new FakeDeployAws();
    aws.stack = settlesAfter(Infinity, 'UPDATE_ROLLBACK_IN_PROGRESS');
    const log: string[] = [];
    expect(await waitForServicesStack(aws, STACK, MINUTE, (l) => log.push(l))).toBe(false);
    expect(aws.now()).toBe(MINUTE);
    expect(log.at(-1)).toBe(
      `stack: ${STACK} is still UPDATE_ROLLBACK_IN_PROGRESS at the deadline; rolling anyway`,
    );
  });

  it('lets the roll go on a stack that does not exist', async () => {
    const aws = new FakeDeployAws();
    aws.stack = () => ({ state: 'granted', value: undefined });
    expect(await waitForServicesStack(aws, STACK, MINUTE, () => undefined)).toBe(true);
  });

  it('rolls without waiting when the role may not read the stack', async () => {
    const aws = new FakeDeployAws();
    aws.stack = () => ({ state: 'not_granted' });
    const log: string[] = [];
    expect(await waitForServicesStack(aws, STACK, MINUTE, (l) => log.push(l))).toBe(false);
    expect(log).toEqual([
      `stack: could not read ${STACK}, rolling without waiting for it: the deploy role may not read it`,
    ]);
  });

  it('rolls without waiting when the read fails, naming the error', async () => {
    const aws = new FakeDeployAws();
    aws.stackStatus = () => {
      const err = new Error('Rate exceeded');
      err.name = 'Throttling';
      return Promise.reject(err);
    };
    const log: string[] = [];
    expect(await waitForServicesStack(aws, STACK, MINUTE, (l) => log.push(l))).toBe(false);
    expect(log).toEqual([
      `stack: could not read ${STACK}, rolling without waiting for it: Throttling: Rate exceeded`,
    ]);
  });

  it('names an unknown error when the read rejects with a non-Error', async () => {
    const aws = new FakeDeployAws();
    aws.stackStatus = () => Promise.reject('boom' as unknown as Error);
    const log: string[] = [];
    await waitForServicesStack(aws, STACK, MINUTE, (l) => log.push(l));
    expect(log).toEqual([
      `stack: could not read ${STACK}, rolling without waiting for it: unknown error`,
    ]);
  });
});
