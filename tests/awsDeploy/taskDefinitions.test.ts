import { describe, expect, it } from 'vitest';
import {
  BREACH_GUARD_VARIABLE,
  READ_ONLY_FIELDS,
  breachContainers,
  cloneWithImage,
  containersIn,
  ecrRepositoryName,
  imageRepository,
} from '@/scripts/aws-deploy/taskDefinitions';
import {
  CORE_REPO,
  DIGEST,
  OLD_DIGEST,
  OTHER_REPO,
  container,
  taskDefinition,
} from './fakeDeployAws';

// MOTIR-9927 — the next revision is the described one with ONE image changed.

const described = () =>
  taskDefinition('motir-prod-core-web', 7, [
    container('web', `${CORE_REPO}@${OLD_DIGEST}`),
    container('sidecar', `${OTHER_REPO}:1.2.3`),
  ]);

describe('cloneWithImage', () => {
  it('strips every read-only field and changes only the named container image', () => {
    const before = described();
    const input = cloneWithImage(before, 'web', `${CORE_REPO}@${DIGEST}`);
    for (const field of READ_ONLY_FIELDS) expect(input).not.toHaveProperty(field);
    const { containerDefinitions: beforeContainers, ...beforeRest } = before;
    const { containerDefinitions: afterContainers, ...afterRest } = input;
    for (const field of READ_ONLY_FIELDS) delete (beforeRest as Record<string, unknown>)[field];
    expect(afterRest).toEqual(beforeRest);
    expect(afterContainers?.[0]).toEqual({
      ...beforeContainers?.[0],
      image: `${CORE_REPO}@${DIGEST}`,
    });
    expect(afterContainers?.[1]).toEqual(beforeContainers?.[1]);
  });

  it('leaves the described definition untouched', () => {
    const before = described();
    cloneWithImage(before, 'web', `${CORE_REPO}@${DIGEST}`);
    expect(before).toEqual(described());
  });

  it('throws naming the family when no container has the name', () => {
    expect(() => cloneWithImage(described(), 'migrate', 'x')).toThrow(
      /motir-prod-core-web has no container "migrate"/,
    );
  });

  it('throws for a definition with no containers', () => {
    expect(() => cloneWithImage({ family: 'empty' }, 'web', 'x')).toThrow(/has no container/);
  });
});

describe('imageRepository', () => {
  it.each([
    [`${CORE_REPO}@${DIGEST}`, CORE_REPO],
    [`${CORE_REPO}:latest`, CORE_REPO],
    [CORE_REPO, CORE_REPO],
    ['localhost:5000/motir-core', 'localhost:5000/motir-core'],
    ['localhost:5000/motir-core:v1', 'localhost:5000/motir-core'],
  ])('%s → %s', (image, repository) => {
    expect(imageRepository(image)).toBe(repository);
  });
});

describe('ecrRepositoryName', () => {
  it('drops the registry host', () => {
    expect(ecrRepositoryName(CORE_REPO)).toBe('motir-prod/motir-core');
    expect(ecrRepositoryName('motir-core')).toBe('motir-core');
  });
});

describe('containersIn', () => {
  it('names only the containers whose image is in the repository', () => {
    expect(containersIn(described(), CORE_REPO)).toEqual(['web']);
    expect(containersIn(described(), OTHER_REPO)).toEqual(['sidecar']);
    expect(containersIn({ containerDefinitions: [{ name: 'x' }] }, CORE_REPO)).toEqual([]);
    expect(containersIn({}, CORE_REPO)).toEqual([]);
  });
});

describe('breachContainers', () => {
  it('names the containers that set the breach guard, at any value', () => {
    expect(breachContainers(described())).toEqual([]);
    expect(breachContainers({})).toEqual([]);
    const armed = described();
    const [web, sidecar] = armed.containerDefinitions ?? [];
    if (web) web.environment = [{ name: 'MONITORING_CLOUDWATCH_SERVICE', value: 'web' }];
    expect(breachContainers(armed)).toEqual([]);
    if (sidecar) sidecar.environment = [{ name: BREACH_GUARD_VARIABLE, value: 'false' }];
    expect(breachContainers(armed)).toEqual(['sidecar']);
    expect(
      breachContainers({
        containerDefinitions: [{ environment: [{ name: BREACH_GUARD_VARIABLE }] }],
      }),
    ).toEqual(['']);
  });
});
