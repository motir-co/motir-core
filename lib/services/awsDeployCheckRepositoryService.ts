import { motirSystemContext } from '@/lib/ai/serviceAuth';
import type { ReleaseShape } from '@motir/orchestrator';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import {
  projectRepoCreationService,
  type ProjectRepoCreationOutcome,
} from '@/lib/services/projectRepoCreationService';
import { hostedRepositoryRemovalService } from '@/lib/services/hostedRepositoryRemovalService';
import { withSystemContext } from '@/lib/workspaces/context';

// THE AWS DEPLOY CHECK'S OWN REPOSITORY (bug MOTIR-12243).
//
// The AWS hosting adapter deploys the tenant app OF a repository row: it reads the
// row's organisation, refuses a customer (`organization`-seeded) row, and binds the
// push roles' trust to the row's GitHub ids. The Fly and serverless checks deploy a
// synthetic app with no row behind it; the AWS check cannot, and every row a
// production organisation holds is a customer row. So the check makes its own
// Motir-created repository, one per shape, through the SAME door Motir uses to
// create a Motir-hosted repository (`projectRepoCreationService`), and `destroy`
// removes it through the same door the Repositories room's delete calls
// (`hostedRepositoryRemovalService`).
//
// The actor is the Motir system account bound to the project's workspace
// (`motirSystemContext`, MOTIR-9329): the check is operator tooling run from a
// worker task, with no person signed in, and the system account is the identity
// Motir already writes into a tenant's tree as. Nothing here re-derives a rule of
// the two doors — name rules, seed compatibility, the paid-plan gate, the hosted
// GitHub organisation, the claim and the delete sequence all stay where they ship.

/** Every repository the check creates is named this plus its shape, and `destroy`
 *  removes no row whose name does not start with it. */
export const AWS_DEPLOY_CHECK_REPOSITORY_PREFIX = 'motir-deploy-check-aws-';

/** The check's repository name for a shape: one per shape, so the function and
 *  container runs never share an app, and a re-run finds the row it made. */
export function awsDeployCheckRepositoryName(shape: ReleaseShape): string {
  return `${AWS_DEPLOY_CHECK_REPOSITORY_PREFIX}${shape}`;
}

/** `--project` names no project of `--organization`, or names more than one. */
export class DeployCheckProjectNotFoundError extends Error {
  readonly code = 'DEPLOY_CHECK_PROJECT_NOT_FOUND' as const;
  constructor(
    readonly projectKey: string,
    readonly organizationId: string,
    readonly matches: number,
  ) {
    super(
      matches === 0
        ? `Organisation ${organizationId} has no project keyed ${projectKey}.`
        : `Organisation ${organizationId} has ${matches} projects keyed ${projectKey}; ` +
            'the check cannot tell which to create its repository in.',
    );
    this.name = 'DeployCheckProjectNotFoundError';
  }
}

export interface AwsDeployCheckRepositoryArgs {
  organizationId: string;
  projectKey: string;
  shape: ReleaseShape;
}

export interface AwsDeployCheckRepository {
  /** The row's id — what every later step takes as `--repository`. */
  repositoryId: string;
  name: string;
  /** The creation door's own outcome: `created` the first time, `already_settled`
   *  on a re-run, `adopted` when a failed row was retried, `failed` otherwise. */
  outcome: ProjectRepoCreationOutcome;
  state: string;
  /** `owner/name` of the GitHub repository, or null when none was realized. */
  githubRepository: string | null;
  failureCode: string | null;
  failureReason: string | null;
}

/** What `destroy` did with the repository it was given. */
export type AwsDeployCheckRepositoryRemoval =
  /** The row was the check's own and is gone, its GitHub repository with it. */
  | 'removed'
  /** No such row: never created, or already removed by an earlier run. */
  | 'absent'
  /** The row is not one the check created; it is left alone. */
  | 'kept';

/** The one project keyed `projectKey` in the organisation, read across
 *  workspaces under the system context. */
async function projectOf(organizationId: string, projectKey: string) {
  const matches = await withSystemContext(async (tx) => {
    const projects = await projectRepository.findAllByIdentifier(projectKey, tx);
    const inOrganization = [];
    for (const project of projects) {
      const workspace = await workspaceRepository.findByIdInTx(project.workspaceId, tx);
      if (workspace?.organizationId === organizationId) inOrganization.push(project);
    }
    return inOrganization;
  });
  if (matches.length !== 1) {
    throw new DeployCheckProjectNotFoundError(projectKey, organizationId, matches.length);
  }
  return matches[0]!;
}

export const awsDeployCheckRepositoryService = {
  /**
   * The check's repository for a shape, created when absent. Idempotent: the
   * creation door finds the row by name, so a re-run answers the same id
   * (`already_settled`) and never leaves a second repository behind.
   *
   * With no starter key the base is EMPTY (`initialised`): a Motir-created row,
   * which the AWS adapter hosts, realized as a real GitHub repository in Motir's
   * hosted organisation, whose ids the push roles' trust binds.
   */
  async ensure(args: AwsDeployCheckRepositoryArgs): Promise<AwsDeployCheckRepository> {
    const project = await projectOf(args.organizationId, args.projectKey);
    const ctx = await motirSystemContext(project.workspaceId);
    const result = await projectRepoCreationService.createProjectRepositoryFromStarter(
      {
        projectKey: project.identifier,
        name: awsDeployCheckRepositoryName(args.shape),
        role: 'other',
      },
      ctx,
    );
    return {
      repositoryId: result.row.id,
      name: result.row.name,
      outcome: result.outcome,
      state: result.row.state,
      githubRepository: result.row.realizedRepo?.repoRef ?? null,
      failureCode: result.establish.failureCode,
      failureReason: result.establish.failureReason ?? result.row.failureReason,
    };
  },

  /**
   * Remove the check's repository: its previews, any production app, the GitHub
   * repository and the row, through the Repositories room's own delete. A row
   * whose name is not the check's is KEPT, so `destroy` handed a real
   * repository's id never deletes it.
   */
  async remove(repositoryId: string): Promise<AwsDeployCheckRepositoryRemoval> {
    const row = await withSystemContext((tx) =>
      projectRepoRepository.findDeployFactsInTx(repositoryId, tx),
    );
    if (!row) return 'absent';
    if (!row.name.startsWith(AWS_DEPLOY_CHECK_REPOSITORY_PREFIX)) return 'kept';
    await hostedRepositoryRemovalService.remove(
      repositoryId,
      await motirSystemContext(row.workspaceId),
    );
    return 'removed';
  },
};
