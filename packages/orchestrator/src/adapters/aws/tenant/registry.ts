import type { DeployCredential } from '../../../hosting/types';
import { readTenantStackTemplate } from '../tenantStacks';
import type { StackRunner } from './stackRunner';
import { TAG_ORGANIZATION, TAG_REPOSITORY } from './stackRunner';

// THE ARTIFACT REGISTRY of a repository in its tenant account (MOTIR-10006), to
// MOTIR-5769 §4: ECR in the tenant's own account, two repositories per
// repository, two GitHub-OIDC push roles, no static secret. Everything AWS-side
// is `registry.yaml`, applied through the seam's stack runner — no ECR
// repository or role is ever created by a direct call — so a repeat is a no
// change and a cut-off run resumes into the one stack.
//
// Production and preview are SEPARATE repositories behind SEPARATE roles: a
// pull request's credential can never overwrite production's image.

/** A repository id is a lowercase cuid; anything else could escape its prefix. */
const REPOSITORY_ID = /^[a-z0-9]+$/;
const NUMERIC_ID = /^[0-9]+$/;

export type RegistryEnvironment = 'preview' | 'production';

export interface RegistryNames {
  readonly stackName: string;
  readonly repositories: Readonly<Record<RegistryEnvironment, string>>;
  readonly pushRoles: Readonly<Record<RegistryEnvironment, string>>;
}

/** The tenant account a registry lives in. */
export interface RegistryAccount {
  readonly accountId: string;
  readonly region: string;
}

/** The GitHub repository's immutable ids, numeric strings. */
export interface GithubRepositoryIds {
  readonly githubRepositoryId: string;
  readonly githubOwnerId: string;
}

/** From the Motir repository row id to its GitHub ids — the adapter wires the
 *  real one (`ProjectRepo.githubRepoId`). Null when the row has none. */
export type GithubRepositoryIdLookup = (
  repositoryId: string,
) => Promise<GithubRepositoryIds | null>;

/** A name part that is not a lowercase alphanumeric repository id. */
export class RegistryNameInvalidError extends Error {
  readonly code = 'AWS_REGISTRY_NAME_INVALID' as const;
  constructor(readonly value: string) {
    super(`"${value}" is not a registry repository id or push namespace.`);
    this.name = 'RegistryNameInvalidError';
  }
}

/** The lookup gave no GitHub ids for the repository, or ids that are not numeric. */
export class GithubRepositoryIdsMissingError extends Error {
  readonly code = 'AWS_REGISTRY_GITHUB_IDS_MISSING' as const;
  constructor(readonly repositoryId: string) {
    super(`Repository ${repositoryId} has no numeric GitHub repository and owner ids.`);
    this.name = 'GithubRepositoryIdsMissingError';
  }
}

/** The registry stack of the namespace's repository does not exist yet. */
export class RegistryNotReadyError extends Error {
  readonly code = 'AWS_REGISTRY_NOT_READY' as const;
  constructor(readonly stackName: string) {
    super(`The registry stack ${stackName} does not exist yet.`);
    this.name = 'RegistryNotReadyError';
  }
}

/** What the deploy role needs for CloudFormation to create, update and delete
 *  the registry stack's resources — read by the deploy-role permissions card.
 *  No `ecr:GetAuthorizationToken`: only the push roles hold it. */
export const AWS_REGISTRY_DEPLOY_ACTIONS: readonly string[] = [
  'ecr:CreateRepository',
  'ecr:DeleteRepository',
  'ecr:DescribeRepositories',
  'ecr:PutImageScanningConfiguration',
  'ecr:TagResource',
  'ecr:UntagResource',
  'ecr:ListTagsForResource',
  'iam:CreateRole',
  'iam:DeleteRole',
  'iam:GetRole',
  'iam:UpdateAssumeRolePolicy',
  'iam:PutRolePolicy',
  'iam:GetRolePolicy',
  'iam:DeleteRolePolicy',
  'iam:TagRole',
  'iam:UntagRole',
  'iam:ListRolePolicies',
  'iam:ListAttachedRolePolicies',
];

function checkedRepositoryId(repositoryId: string): string {
  if (!REPOSITORY_ID.test(repositoryId)) throw new RegistryNameInvalidError(repositoryId);
  return repositoryId;
}

/** Every name of a repository's registry. */
export function registryNames(repositoryId: string): RegistryNames {
  const rid = checkedRepositoryId(repositoryId);
  return {
    stackName: `motir-registry-${rid}`,
    repositories: { preview: `mh/${rid}/preview`, production: `mh/${rid}/production` },
    pushRoles: { preview: `mh-${rid}-preview-push`, production: `mh-${rid}-production-push` },
  };
}

/** The push namespace of an environment: its ECR repository's name. */
export function registryPushNamespace(
  repositoryId: string,
  environment: RegistryEnvironment,
): string {
  return registryNames(repositoryId).repositories[environment];
}

/** A push namespace back into its repository id and environment. */
export function parseRegistryPushNamespace(pushNamespace: string): {
  repositoryId: string;
  environment: RegistryEnvironment;
} {
  const match = /^mh\/([a-z0-9]+)\/(preview|production)$/.exec(pushNamespace);
  if (!match) throw new RegistryNameInvalidError(pushNamespace);
  return { repositoryId: match[1]!, environment: match[2] as RegistryEnvironment };
}

export interface EnsureRegistryInput {
  readonly runner: StackRunner;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly lookup: GithubRepositoryIdLookup;
}

export interface RegistryRecord {
  readonly names: RegistryNames;
  /** The repository URIs and push-role ARNs, from the stack's outputs. */
  readonly outputs: Readonly<Record<string, string>>;
}

/** The repository's registry stack, applied once. */
export async function ensureRegistry(input: EnsureRegistryInput): Promise<RegistryRecord> {
  const names = registryNames(input.repositoryId);
  const ids = await input.lookup(input.repositoryId);
  if (!ids || !NUMERIC_ID.test(ids.githubRepositoryId) || !NUMERIC_ID.test(ids.githubOwnerId)) {
    throw new GithubRepositoryIdsMissingError(input.repositoryId);
  }
  const { outputs } = await input.runner.applyStack({
    stackName: names.stackName,
    template: readTenantStackTemplate('registry.yaml'),
    parameters: {
      OrganizationId: input.organizationId,
      RepositoryId: input.repositoryId,
      GithubRepositoryId: ids.githubRepositoryId,
      GithubOwnerId: ids.githubOwnerId,
    },
    tags: { [TAG_ORGANIZATION]: input.organizationId, [TAG_REPOSITORY]: input.repositoryId },
  });
  return { names, outputs };
}

/** The image Lambda or ECS pulls: by digest when there is one, else by tag. */
export function registryImageReference(input: {
  readonly account: RegistryAccount;
  readonly repositoryName: string;
  readonly digest?: string;
  readonly tag?: string;
}): string {
  const host = `${input.account.accountId}.dkr.ecr.${input.account.region}.amazonaws.com`;
  const suffix = input.digest ? `@${input.digest}` : `:${input.tag ?? 'latest'}`;
  return `${host}/${input.repositoryName}${suffix}`;
}

/** The federated push credential for a namespace: the ARN of the ONE role that
 *  may push to it, read from the registry stack. Nothing secret. */
export async function registryDeployCredential(input: {
  readonly runner: StackRunner;
  readonly pushNamespace: string;
}): Promise<DeployCredential> {
  const { repositoryId, environment } = parseRegistryPushNamespace(input.pushNamespace);
  const { stackName } = registryNames(repositoryId);
  const stack = await input.runner.describeStack(stackName);
  const output = environment === 'preview' ? 'PreviewPushRoleArn' : 'ProductionPushRoleArn';
  const subject = stack?.outputs[output];
  if (!subject) throw new RegistryNotReadyError(stackName);
  return { kind: 'federated', pushNamespace: input.pushNamespace, subject };
}
