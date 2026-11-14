import type { TaskDefinition } from '@aws-sdk/client-ecs';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_SEARCH_DEPTH,
  infraBaseline,
  isInfraRevision,
  revisionName,
} from '@/scripts/aws-deploy/infraBaseline';
import {
  CLOUDFORMATION,
  CORE_REPO,
  DEPLOY_ROLE,
  FakeDeployAws,
  OLD_DIGEST,
  OPERATOR,
  container,
  taskDefinition,
} from './fakeDeployAws';

// MOTIR-11235 — a core service's next revision is cloned from the newest one
// motir-infra's CloudFormation registered, so an infra change the deploy
// overlapped is never overwritten and the image is the only field it owns.

const FAMILY = 'motir-prod-core-worker';

function revision(n: number, registeredBy: string, status = 'ACTIVE'): TaskDefinition {
  return {
    ...taskDefinition(FAMILY, n, [container('worker', `${CORE_REPO}@${OLD_DIGEST}`)]),
    registeredBy,
    status: status as never,
  };
}

/** A family whose revisions 1..n are registered by `by(n)`; returns the newest. */
function family(aws: FakeDeployAws, top: number, by: (n: number) => TaskDefinition) {
  for (let n = 1; n <= top; n++) aws.addDefinition(by(n));
  return aws.describeTaskDefinition(FAMILY);
}

describe('isInfraRevision', () => {
  it('holds for an ACTIVE revision CloudFormation registered, and nothing else', () => {
    expect(isInfraRevision(revision(1, CLOUDFORMATION))).toBe(true);
    expect(isInfraRevision(revision(1, CLOUDFORMATION, 'INACTIVE'))).toBe(false);
    expect(isInfraRevision(revision(1, DEPLOY_ROLE))).toBe(false);
    expect(isInfraRevision(revision(1, OPERATOR))).toBe(false);
    expect(isInfraRevision({ ...revision(1, CLOUDFORMATION), registeredBy: undefined })).toBe(
      false,
    );
  });
});

describe('revisionName', () => {
  it('names a revision family:revision', () => {
    expect(revisionName(revision(276, CLOUDFORMATION))).toBe(`${FAMILY}:276`);
  });
});

describe('infraBaseline', () => {
  it('returns the newest revision itself when CloudFormation registered it, reading nothing', async () => {
    const aws = new FakeDeployAws();
    const newest = await family(aws, 3, (n) => revision(n, CLOUDFORMATION));
    const before = aws.calls.length;
    expect(await infraBaseline(aws, newest, () => undefined)).toBe(newest);
    expect(aws.calls.length).toBe(before);
  });

  it('walks down past the deploy and a person to the newest CloudFormation revision', async () => {
    // The production shape of 2026-11-13: :276 CloudFormation's, with the pin;
    // :277 the core deploy's clone of the stale read; then a hand revision.
    const aws = new FakeDeployAws();
    const newest = await family(aws, 278, (n) =>
      revision(n, n === 278 ? OPERATOR : n === 277 ? DEPLOY_ROLE : CLOUDFORMATION),
    );
    const before = aws.calls.length;
    const found = await infraBaseline(aws, newest, () => undefined);
    expect(found?.revision).toBe(276);
    expect(aws.calls.slice(before)).toEqual([
      ['describeTaskDefinition', `${FAMILY}:277`],
      ['describeTaskDefinition', `${FAMILY}:276`],
    ]);
  });

  it('skips a CloudFormation revision that is no longer ACTIVE', async () => {
    const aws = new FakeDeployAws();
    const newest = await family(aws, 4, (n) =>
      n === 4
        ? revision(n, DEPLOY_ROLE)
        : revision(n, CLOUDFORMATION, n === 3 ? 'INACTIVE' : 'ACTIVE'),
    );
    expect((await infraBaseline(aws, newest, () => undefined))?.revision).toBe(2);
  });

  it(`gives up after ${String(BASELINE_SEARCH_DEPTH)} revisions, saying which it searched`, async () => {
    const aws = new FakeDeployAws();
    const top = BASELINE_SEARCH_DEPTH + 5;
    const newest = await family(aws, top, (n) =>
      revision(n, n === 1 ? CLOUDFORMATION : DEPLOY_ROLE),
    );
    const before = aws.calls.length;
    const log: string[] = [];
    expect(await infraBaseline(aws, newest, (l) => log.push(l))).toBeNull();
    expect(aws.calls.length - before).toBe(BASELINE_SEARCH_DEPTH);
    expect(log).toEqual([
      `baseline: no ACTIVE ${FAMILY} revision from ${FAMILY}:5 to ${FAMILY}:${String(top)} ` +
        'was registered by CloudFormation',
    ]);
  });

  it('stops at revision 1 in a short family', async () => {
    const aws = new FakeDeployAws();
    const newest = await family(aws, 3, () => revision(1, DEPLOY_ROLE));
    const log: string[] = [];
    // `family` registered three copies of revision 1 here; the newest is 1.
    expect(await infraBaseline(aws, newest, (l) => log.push(l))).toBeNull();
    expect(log).toEqual([
      `baseline: no ACTIVE ${FAMILY} revision from ${FAMILY}:1 to ${FAMILY}:1 ` +
        'was registered by CloudFormation',
    ]);
  });

  it('stops and says why when a revision cannot be read', async () => {
    const aws = new FakeDeployAws();
    aws.addDefinition(revision(5, CLOUDFORMATION));
    aws.addDefinition(revision(7, DEPLOY_ROLE));
    const log: string[] = [];
    const newest = await aws.describeTaskDefinition(FAMILY);
    expect(await infraBaseline(aws, newest, (l) => log.push(l))).toBeNull();
    expect(log).toEqual([`baseline: could not read ${FAMILY}:6 (no such)`]);
  });

  it('names an unknown error when a read rejects with a non-Error', async () => {
    const aws = new FakeDeployAws();
    aws.describeTaskDefinition = () => Promise.reject('boom' as unknown as Error);
    const log: string[] = [];
    expect(await infraBaseline(aws, revision(3, DEPLOY_ROLE), (l) => log.push(l))).toBeNull();
    expect(log).toEqual([`baseline: could not read ${FAMILY}:2 (unknown error)`]);
  });
});
