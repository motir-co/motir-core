/**
 * The revision a core service's next one is cloned from (MOTIR-11235): the
 * newest revision of its family that motir-infra's CloudFormation registered —
 * the CDK template as deployed — rather than whichever revision the service
 * happens to run.
 *
 * Cloning the live revision copied whatever was on it. A deploy that read the
 * service before a motir-infra update rolled it put the older revision back
 * (MOTIR-11235, after MOTIR-10117 and MOTIR-10436), and CloudFormation, which
 * still records its own revision, never noticed: every later deploy then
 * cloned the loss forward. Cloned from the CloudFormation revision instead,
 * every infra-owned field — environment, secrets, sizes, roles, sidecars — is
 * the template's by construction, and only the image is this deploy's. A
 * revision a person registers by hand (a breach revision, MOTIR-10093) is never
 * a source either.
 *
 * The walk reads revisions downward from the family's newest, with the
 * `ecs:DescribeTaskDefinition` the role already holds. It stops at the first
 * ACTIVE revision CloudFormation registered. When none is found within
 * `BASELINE_SEARCH_DEPTH` revisions, or a read fails, it says why and the
 * caller clones the live revision, as before.
 */
import type { TaskDefinition } from '@aws-sdk/client-ecs';
import type { DeployAws } from './ports';
import type { DeployLog } from './migrateRun';

/** How many revisions below the family's newest the walk reads at most. */
export const BASELINE_SEARCH_DEPTH = 100;

/**
 * The session CloudFormation's service role runs as: a revision registered by
 * a stack update reads `…:assumed-role/cdk-…-cfn-exec-role-…/AWSCloudFormation`
 * in `registeredBy`. The core deploy registers as its own role's session, and a
 * person as theirs.
 */
export const CLOUDFORMATION_SESSION = '/AWSCloudFormation';

/** Whether CloudFormation registered `definition`, and it is still ACTIVE. */
export function isInfraRevision(definition: TaskDefinition): boolean {
  return (
    definition.status === 'ACTIVE' &&
    (definition.registeredBy?.endsWith(CLOUDFORMATION_SESSION) ?? false)
  );
}

/** A revision's name: `family:revision`. */
export const revisionName = (definition: TaskDefinition) =>
  `${String(definition.family)}:${String(definition.revision)}`;

/** One revision of `family`, or why it could not be read. */
async function readRevision(
  aws: DeployAws,
  family: string,
  revision: number,
): Promise<TaskDefinition | { unreadable: string }> {
  try {
    return await aws.describeTaskDefinition(`${family}:${String(revision)}`);
  } catch (err) {
    return { unreadable: err instanceof Error ? err.message : 'unknown error' };
  }
}

/**
 * The newest ACTIVE revision of `newest`'s family that CloudFormation
 * registered, at or below `newest`; `null` when there is none within
 * `BASELINE_SEARCH_DEPTH` or a read fails, which `log` says.
 */
export async function infraBaseline(
  aws: DeployAws,
  newest: TaskDefinition,
  log: DeployLog,
): Promise<TaskDefinition | null> {
  if (isInfraRevision(newest)) return newest;
  const family = String(newest.family);
  const top = Number(newest.revision);
  const bottom = Math.max(1, top - BASELINE_SEARCH_DEPTH);
  for (let revision = top - 1; revision >= bottom; revision--) {
    const read = await readRevision(aws, family, revision);
    if ('unreadable' in read) {
      log(`baseline: could not read ${family}:${String(revision)} (${read.unreadable})`);
      return null;
    }
    if (isInfraRevision(read)) return read;
  }
  log(
    `baseline: no ACTIVE ${family} revision from ${family}:${String(bottom)} to ` +
      `${family}:${String(top)} was registered by CloudFormation`,
  );
  return null;
}
