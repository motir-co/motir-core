/**
 * Pure task-definition helpers for the core deploy script (MOTIR-9927): turn a
 * described revision into the input for the next one, with one image changed.
 */
import type { TaskDefinition } from '@aws-sdk/client-ecs';
import type { RegisterTaskDefinitionInput } from './ports';

/** What DescribeTaskDefinition returns that RegisterTaskDefinition does not take. */
export const READ_ONLY_FIELDS = [
  'taskDefinitionArn',
  'revision',
  'status',
  'requiresAttributes',
  'compatibilities',
  'registeredAt',
  'registeredBy',
  'deregisteredAt',
] as const satisfies readonly (keyof TaskDefinition)[];

/**
 * The input that registers `taskDefinition` again with `image` on the container
 * named `container`, every other field copied. Throws when no container has
 * that name, so a renamed container fails the deploy instead of re-registering
 * the old image.
 */
export function cloneWithImage(
  taskDefinition: TaskDefinition,
  container: string,
  image: string,
): RegisterTaskDefinitionInput {
  const copy: Partial<TaskDefinition> = structuredClone(taskDefinition);
  for (const field of READ_ONLY_FIELDS) delete copy[field];
  const containers = copy.containerDefinitions ?? [];
  const target = containers.find((c) => c.name === container);
  if (!target) {
    throw new Error(`task definition ${String(copy.family)} has no container "${container}"`);
  }
  target.image = image;
  return copy as RegisterTaskDefinitionInput;
}

/**
 * The repository part of an image reference: everything before `@<digest>`, or
 * before a `:<tag>` that follows the last `/` (a registry port is not a tag).
 */
export function imageRepository(image: string): string {
  const at = image.indexOf('@');
  if (at >= 0) return image.slice(0, at);
  const colon = image.lastIndexOf(':');
  return colon > image.lastIndexOf('/') ? image.slice(0, colon) : image;
}

/** An ECR repository URI's repository name: the path after the registry host. */
export function ecrRepositoryName(repository: string): string {
  const slash = repository.indexOf('/');
  return slash >= 0 ? repository.slice(slash + 1) : repository;
}

/** The names of the containers whose image is in `repository`. */
export function containersIn(taskDefinition: TaskDefinition, repository: string): string[] {
  return (taskDefinition.containerDefinitions ?? [])
    .filter((c) => c.image !== undefined && imageRepository(c.image) === repository)
    .map((c) => c.name ?? '');
}

/**
 * The environment variable that arms the breach command (`breach/breach.mjs`,
 * docs/monitoring/aws-alarms.md). No revision a service runs in the normal
 * course sets it; only a hand-registered breach revision does (MOTIR-10093).
 */
export const BREACH_GUARD_VARIABLE = 'MOTIR_BREACH_ENABLED';

/** The containers of `taskDefinition` whose environment sets the breach guard, at any value. */
export function breachContainers(taskDefinition: TaskDefinition): string[] {
  return (taskDefinition.containerDefinitions ?? [])
    .filter((c) => c.environment?.some((v) => v.name === BREACH_GUARD_VARIABLE))
    .map((c) => c.name ?? '');
}
