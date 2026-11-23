import {
  AWS_INDEX_IAM_ROLE,
  AWS_MEMBER_ROLE_NAME,
  AWS_RUNNER_IAM_ROLE,
  AWS_TENANT_DEPLOY_POLICY_PATH,
  AWS_TENANT_DEPLOY_ROLE,
} from '../management';
import type { TenantIam, TenantPolicyDocument } from './clients';
import { databaseStackName } from './database/names';
import { AwsTenantApiError, TenantRoleUnavailableError } from './errors';
import type { TenantClientsFactory } from './factory';
import {
  awsReleaseRunner,
  destroyAwsPreview,
  type AwsReleaseOperationOptions,
} from './hostingAdapter';
import type { TenantAccountContext } from './network';
import { registryNames } from './registry';
import { parseAwsAppRef } from './releaseIds';

// THE TENANT-ACCOUNT HANDOVER CALLS (MOTIR-12130): what the AWS handover saga
// runs, in order, inside an enterprise tenant's account before the account
// leaves Motir's Organization with its production apps still running. No saga,
// state or surface lives here — the saga records progress — so every call is
// look-before-act and answers the same thing when run twice: a saga cut off at
// any step calls it again.
//
//   destroyPreviewStacks      every PREVIEW release and preview database stack,
//                             each preview's database before its release (the
//                             adapter's own single-preview destroy). A stack is
//                             a preview only by PARSING its name; anything that
//                             does not parse is left in place.
//   createHandoverDeployRole  a role the handed-over repositories' own CI can
//                             assume through the account's GitHub OIDC
//                             provider, by their IMMUTABLE ids at the
//                             destination owner — never by `owner/name`, which
//                             trusts whatever repository later holds the name.
//   removeMotirAccess         Motir's roles and grants out, in an order where
//                             each call is still allowed when it runs, ending
//                             with the member access role trusting only the
//                             account's own root and holding no policy.
//
// Nothing here takes, stores, logs or returns an email, a code, a payment
// detail or a credential: the log carries step names and stack or role names.

/** The role the handed-over repositories' CI deploys their production stacks
 *  with. `motir-` so the deploy role, whose grant reaches only `motir-*` roles,
 *  may create it; the path tells it from any role someone else named alike. */
export const HANDOVER_DEPLOY_ROLE = 'motir-handover-deploy';
export const HANDOVER_DEPLOY_ROLE_PATH = '/motir-handover/';
/** Its one inline policy. */
export const HANDOVER_DEPLOY_POLICY = 'motir-handover-deploy';

/** The GitHub OIDC provider `motir-network` creates, and the audience the
 *  registry push roles bind (`registry.yaml`). */
export const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';

const SERVICE_ROLE_PATH = '/aws-service-role/';
const VERSION = '2012-10-17';

/** A preview could not be destroyed; the others were still attempted. Names
 *  app refs and AWS's codes only. */
export class HandoverPreviewDestroyError extends Error {
  readonly code = 'AWS_HANDOVER_PREVIEW_DESTROY_FAILED' as const;
  constructor(
    readonly accountId: string,
    readonly failed: readonly { readonly appRef: string; readonly reason: string }[],
  ) {
    super(
      `Previews in tenant account ${accountId} could not be destroyed: ${failed
        .map((f) => `${f.appRef} (${f.reason})`)
        .join(', ')}.`,
    );
    this.name = 'HandoverPreviewDestroyError';
  }
}

/** A role named `HANDOVER_DEPLOY_ROLE` exists outside the handover's path: it is
 *  not the one this call made, so it is never overwritten. */
export class HandoverRoleConflictError extends Error {
  readonly code = 'AWS_HANDOVER_ROLE_CONFLICT' as const;
  constructor(
    readonly accountId: string,
    readonly roleName: string,
    readonly path: string,
  ) {
    super(
      `Tenant account ${accountId} already has a role ${roleName} at ${path}, which the handover did not make.`,
    );
    this.name = 'HandoverRoleConflictError';
  }
}

/** The handover was given an id that is not one. */
export class HandoverInputInvalidError extends Error {
  readonly code = 'AWS_HANDOVER_INPUT_INVALID' as const;
  constructor(readonly field: string) {
    super(`The handover input ${field} is not valid.`);
    this.name = 'HandoverInputInvalidError';
  }
}

/** One handed-over repository: Motir's id, and GitHub's immutable numeric id,
 *  which survives the transfer. */
export interface HandedOverRepository {
  readonly repositoryId: string;
  readonly githubRepositoryId: string;
}

export interface HandoverDeployRoleInput {
  /** The destination owner's immutable GitHub id — the organisation the
   *  administrator named, where the repositories will be after the transfer. */
  readonly destinationOwnerId: string;
  readonly repositories: readonly HandedOverRepository[];
}

export interface PreviewTeardownResult {
  /** Every Motir stack left in the account, sorted: production and shared
   *  stacks, which a teardown never touches. The same on every call. */
  readonly kept: readonly string[];
}

export interface HandoverDeployRoleResult {
  readonly roleName: string;
  readonly roleArn: string;
}

export interface MotirAccessRemovalResult {
  readonly outcome: 'removed';
  /** The role left behind, trusting only the account's root and holding no
   *  policy: the owner deletes it once they hold root access. */
  readonly memberRole: string;
}

export interface TenantHandoverDeps {
  /** The account's clients on `motir-tenant-deploy`. */
  readonly clientsFor: TenantClientsFactory;
  /** The account's IAM on its member access role: a NEW session on each call
   *  (`createTenantMemberIam`), which is how a closed role is told apart. */
  readonly memberIamFor: (target: { accountId: string; region: string }) => TenantIam;
  /** The tenant accounts' region. */
  readonly region: string;
  /** Motir's management account, whose principals the handover strips from
   *  every trust. */
  readonly managementAccountId: string;
  readonly options?: AwsReleaseOperationOptions;
}

export interface TenantHandover {
  destroyPreviewStacks(accountId: string): Promise<PreviewTeardownResult>;
  createHandoverDeployRole(
    accountId: string,
    input: HandoverDeployRoleInput,
  ): Promise<HandoverDeployRoleResult>;
  removeMotirAccess(accountId: string): Promise<MotirAccessRemovalResult>;
}

/** The app ref a stack name is the PREVIEW release or preview database of, or
 *  null. Only a name that parses is one: a production release, the
 *  application's database, a name that fails to parse are never previews. */
export function previewAppRefOfStack(stackName: string): string | null {
  const release = /^motir-release-(.+)$/.exec(stackName);
  if (release) {
    try {
      return parseAwsAppRef(release[1]!).environment.kind === 'preview' ? release[1]! : null;
    } catch {
      return null;
    }
  }
  const database = /^motir-database-([a-z0-9]+)-pr([1-9][0-9]*)$/.exec(stackName);
  return database ? `mh-${database[1]}-pr${database[2]}` : null;
}

/** The trust of the handover deploy role: the account's GitHub OIDC provider,
 *  the registry roles' audience, and one subject per repository binding its id
 *  and the destination owner's id. */
export function handoverDeployTrust(
  accountId: string,
  input: HandoverDeployRoleInput,
): TenantPolicyDocument {
  return {
    Version: VERSION,
    Statement: [
      {
        Sid: 'HandedOverRepositories',
        Effect: 'Allow',
        Principal: { Federated: `arn:aws:iam::${accountId}:oidc-provider/${GITHUB_OIDC_HOST}` },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: { [`${GITHUB_OIDC_HOST}:aud`]: GITHUB_OIDC_AUDIENCE },
          StringLike: {
            [`${GITHUB_OIDC_HOST}:sub`]: input.repositories.map(
              (r) =>
                `repository_owner_id:${input.destinationOwnerId}:repository_id:${r.githubRepositoryId}:*`,
            ),
          },
        },
      },
    ],
  };
}

/**
 * The handover deploy role's policy: the actions the tenant deploy policies
 * grant over a repository's PRODUCTION release, database and registry stacks,
 * each scoped to the handed-over repositories' own resources in this account.
 * An action AWS authorises only on `*` (registering an ECS task definition, the
 * database and network reads) is left out rather than granted account-wide;
 * the owner widens the role once they hold root. `tests/ciFleet/` holds every
 * action here to the deploy policies' grant.
 */
export function handoverDeployPolicy(
  accountId: string,
  region: string,
  repositoryIds: readonly string[],
): TenantPolicyDocument {
  const at = (service: string, resource: string) =>
    `arn:aws:${service}:${region}:${accountId}:${resource}`;
  const each = (fn: (rid: string, app: string) => string[]) =>
    repositoryIds.flatMap((rid) => fn(rid, `mh-${rid}`));
  return {
    Version: VERSION,
    Statement: [
      {
        Sid: 'ProductionStacks',
        Effect: 'Allow',
        Action: [
          'cloudformation:UpdateStack',
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStackResources',
          'cloudformation:ListStackResources',
          'cloudformation:GetTemplate',
        ],
        Resource: each((rid, app) => [
          at('cloudformation', `stack/motir-release-${app}/*`),
          at('cloudformation', `stack/${databaseStackName(rid)}/*`),
          at('cloudformation', `stack/${registryNames(rid).stackName}/*`),
        ]),
      },
      {
        Sid: 'ProductionFunctions',
        Effect: 'Allow',
        Action: [
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
          'lambda:PublishVersion',
          'lambda:UpdateAlias',
          'lambda:Get*',
          'lambda:List*',
        ],
        Resource: each((_rid, app) => [
          at('lambda', `function:${app}`),
          at('lambda', `function:${app}:*`),
          at('lambda', `function:${app}-front-door`),
          at('lambda', `function:${app}-front-door:*`),
        ]),
      },
      {
        Sid: 'ProductionService',
        Effect: 'Allow',
        Action: ['ecs:UpdateService', 'ecs:Describe*'],
        Resource: each((_rid, app) => [
          at('ecs', `cluster/${app}`),
          at('ecs', `service/${app}/${app}`),
        ]),
      },
      {
        Sid: 'ProductionRegistry',
        Effect: 'Allow',
        Action: [
          'ecr:DescribeRepositories',
          'ecr:ListTagsForResource',
          'ecr:GetRepositoryPolicy',
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
        ],
        Resource: each((rid) => [
          at('ecr', `repository/${registryNames(rid).repositories.production}`),
        ]),
      },
      {
        Sid: 'ProductionLogs',
        Effect: 'Allow',
        Action: ['logs:PutRetentionPolicy'],
        Resource: each((_rid, app) => [
          at('logs', `log-group:/aws/lambda/${app}`),
          at('logs', `log-group:/aws/lambda/${app}-front-door`),
          at('logs', `log-group:/motir/hosting/${app}`),
        ]),
      },
      {
        Sid: 'ProductionRoles',
        Effect: 'Allow',
        Action: ['iam:GetRole', 'iam:PassRole'],
        Resource: each((_rid, app) =>
          ['fn', 'door', 'exec', 'task'].map(
            (suffix) => `arn:aws:iam::${accountId}:role/motir-${app}-${suffix}`,
          ),
        ),
        Condition: {
          StringEqualsIfExists: {
            'iam:PassedToService': ['lambda.amazonaws.com', 'ecs-tasks.amazonaws.com'],
          },
        },
      },
    ],
  };
}

/** The member access role's trust once Motir has gone: the account's own root. */
export function accountRootTrust(accountId: string): TenantPolicyDocument {
  return {
    Version: VERSION,
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${accountId}:root` },
        Action: 'sts:AssumeRole',
      },
    ],
  };
}

/** Does a trust statement's principal name the management account or a Motir
 *  role, in any account? Its condition is not read: only who may assume. */
export function namesMotir(
  statement: Readonly<Record<string, unknown>>,
  managementAccountId: string,
): boolean {
  const principal = JSON.stringify(statement['Principal'] ?? '');
  return (
    principal.includes(`:${managementAccountId}:`) ||
    principal.includes(`"${managementAccountId}"`) ||
    /:role\/(?:[^"]*\/)?motir-/.test(principal)
  );
}

/** Key-order-free equality of two policy documents. */
function sameDocument(a: TenantPolicyDocument | null, b: TenantPolicyDocument): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
          )
        : value;
  return a !== null && JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const RID = /^[a-z0-9]+$/;
const GITHUB_ID = /^[0-9]+$/;

/** The input, checked and in one order, so the same set of repositories always
 *  writes the same documents. */
function checkedInput(input: HandoverDeployRoleInput): HandoverDeployRoleInput {
  if (!GITHUB_ID.test(input.destinationOwnerId)) {
    throw new HandoverInputInvalidError('destinationOwnerId');
  }
  if (input.repositories.length === 0) throw new HandoverInputInvalidError('repositories');
  for (const r of input.repositories) {
    if (!RID.test(r.repositoryId)) throw new HandoverInputInvalidError('repositoryId');
    if (!GITHUB_ID.test(r.githubRepositoryId)) {
      throw new HandoverInputInvalidError('githubRepositoryId');
    }
  }
  const unique = new Map(input.repositories.map((r) => [r.repositoryId, r]));
  return {
    destinationOwnerId: input.destinationOwnerId,
    repositories: [...unique.values()].sort((a, b) => a.repositoryId.localeCompare(b.repositoryId)),
  };
}

const accessDenied = (err: unknown) =>
  (err instanceof TenantRoleUnavailableError && err.awsCode === 'AccessDenied') ||
  (err instanceof AwsTenantApiError && err.awsCode === 'AccessDenied');

const sessionClosed = (err: unknown) =>
  err instanceof TenantRoleUnavailableError && err.awsCode === 'AccessDenied';

const reasonOf = (err: unknown) =>
  err instanceof AwsTenantApiError
    ? err.awsCode
    : err instanceof Error && 'code' in err && typeof err.code === 'string'
      ? err.code
      : 'UnknownError';

export function createTenantHandover(deps: TenantHandoverDeps): TenantHandover {
  const options = deps.options ?? {};
  const log = (step: string, detail: string) => options.log?.({ step, appRef: detail });
  const target = (accountId: string) => ({ accountId, region: deps.region });

  /** Delete a role whole: out of its instance profiles (each deleted), its
   *  inline policies deleted, its managed ones detached, then the role. */
  async function deleteRoleWhole(iam: TenantIam, name: string): Promise<void> {
    if (!(await iam.getRole(name))) return;
    for (const profile of await iam.listInstanceProfilesForRole(name)) {
      await iam.removeRoleFromInstanceProfile(profile, name);
      await iam.deleteInstanceProfile(profile);
    }
    for (const policy of await iam.listRolePolicies(name)) {
      await iam.deleteRolePolicy(name, policy);
    }
    for (const policy of await iam.listAttachedRolePolicies(name)) {
      await iam.detachRolePolicy(name, policy.arn);
    }
    await iam.deleteRole(name);
    log('role deleted', name);
  }

  /** Is Motir closed out of the account: neither the member access role nor
   *  the deploy role can be assumed by a FRESH session? */
  async function closedOut(accountId: string): Promise<boolean> {
    for (const probe of [
      () => deps.memberIamFor(target(accountId)).getRole(AWS_MEMBER_ROLE_NAME),
      () => deps.clientsFor(target(accountId)).iam.getRole(HANDOVER_DEPLOY_ROLE),
    ]) {
      try {
        await probe();
        return false;
      } catch (err) {
        if (!sessionClosed(err)) throw err;
      }
    }
    return true;
  }

  const removed = (): MotirAccessRemovalResult => ({
    outcome: 'removed',
    memberRole: AWS_MEMBER_ROLE_NAME,
  });

  return {
    async destroyPreviewStacks(accountId) {
      const clients = deps.clientsFor(target(accountId));
      const account: TenantAccountContext = {
        // A teardown applies no stack, so the organisation a stack would be
        // tagged with is never read.
        organizationId: '',
        clients,
        runner: awsReleaseRunner(clients, options),
      };
      const stacks = await clients.cloudformation.listStacks();
      const previews = new Set<string>();
      const kept: string[] = [];
      for (const stack of stacks) {
        const appRef = previewAppRefOfStack(stack.name);
        if (appRef) previews.add(appRef);
        else if (stack.name.startsWith('motir-')) kept.push(stack.name);
      }
      const failed: { appRef: string; reason: string }[] = [];
      for (const appRef of [...previews].sort()) {
        try {
          await destroyAwsPreview(account, appRef, options);
          log('preview destroyed', appRef);
        } catch (err) {
          failed.push({ appRef, reason: reasonOf(err) });
        }
      }
      if (failed.length > 0) throw new HandoverPreviewDestroyError(accountId, failed);
      return { kept: kept.sort() };
    },

    async createHandoverDeployRole(accountId, rawInput) {
      const input = checkedInput(rawInput);
      const { iam } = deps.clientsFor(target(accountId));
      const trust = handoverDeployTrust(accountId, input);
      const policy = handoverDeployPolicy(
        accountId,
        deps.region,
        input.repositories.map((r) => r.repositoryId),
      );
      let role = await iam.getRole(HANDOVER_DEPLOY_ROLE);
      if (role && role.path !== HANDOVER_DEPLOY_ROLE_PATH) {
        throw new HandoverRoleConflictError(accountId, HANDOVER_DEPLOY_ROLE, role.path);
      }
      if (!role) {
        await iam.createRole({
          name: HANDOVER_DEPLOY_ROLE,
          path: HANDOVER_DEPLOY_ROLE_PATH,
          trust,
          description: 'Deploys the handed-over repositories to their production stacks.',
          maxSessionSeconds: 3600,
          tags: { 'motir:handover': 'deploy' },
        });
        log('handover deploy role created', HANDOVER_DEPLOY_ROLE);
        role = await iam.getRole(HANDOVER_DEPLOY_ROLE);
      } else if (!sameDocument(role.trust, trust)) {
        await iam.updateAssumeRolePolicy(HANDOVER_DEPLOY_ROLE, trust);
        log('handover deploy role trust replaced', HANDOVER_DEPLOY_ROLE);
      }
      if (
        !sameDocument(await iam.getRolePolicy(HANDOVER_DEPLOY_ROLE, HANDOVER_DEPLOY_POLICY), policy)
      ) {
        await iam.putRolePolicy(HANDOVER_DEPLOY_ROLE, HANDOVER_DEPLOY_POLICY, policy);
        log('handover deploy policy put', HANDOVER_DEPLOY_ROLE);
      }
      return {
        roleName: HANDOVER_DEPLOY_ROLE,
        roleArn:
          role?.arn ??
          `arn:aws:iam::${accountId}:role${HANDOVER_DEPLOY_ROLE_PATH}${HANDOVER_DEPLOY_ROLE}`,
      };
    },

    async removeMotirAccess(accountId) {
      const iam = deps.memberIamFor(target(accountId));
      let stripping = false;
      try {
        // 1–2. Motir's own roles, then the deploy role and its managed
        // policies. The deploy role's policy denies it every action on itself,
        // so this runs on the member access role, which outlives it.
        for (const role of [AWS_RUNNER_IAM_ROLE, AWS_INDEX_IAM_ROLE, AWS_TENANT_DEPLOY_ROLE]) {
          await deleteRoleWhole(iam, role);
        }
        for (const policy of await iam.listPolicies(AWS_TENANT_DEPLOY_POLICY_PATH)) {
          await iam.deletePolicy(policy.arn);
          log('policy deleted', policy.name);
        }
        // 3. Motir out of every other role's trust. A role left trusting no one
        // trusts the account's own root, never an empty document.
        for (const role of await iam.listRoles()) {
          if (role.name === AWS_MEMBER_ROLE_NAME || role.path.startsWith(SERVICE_ROLE_PATH)) {
            continue;
          }
          const statements = role.trust.Statement.filter(
            (st) => !namesMotir(st, deps.managementAccountId),
          );
          if (statements.length === role.trust.Statement.length) continue;
          await iam.updateAssumeRolePolicy(
            role.name,
            statements.length > 0
              ? { Version: role.trust.Version, Statement: statements }
              : accountRootTrust(accountId),
          );
          log('trust stripped', role.name);
        }
        // 4. Last, the member access role itself: its trust to the account's
        // root while the session can still change it, then its policies. The
        // last detach is the session's last act; the role is powerless after.
        const self = await iam.getRole(AWS_MEMBER_ROLE_NAME);
        const rootTrust = accountRootTrust(accountId);
        stripping = true;
        if (self && !sameDocument(self.trust, rootTrust)) {
          await iam.updateAssumeRolePolicy(AWS_MEMBER_ROLE_NAME, rootTrust);
          log('member role trust set to root', AWS_MEMBER_ROLE_NAME);
        }
        for (const policy of await iam.listRolePolicies(AWS_MEMBER_ROLE_NAME)) {
          await iam.deleteRolePolicy(AWS_MEMBER_ROLE_NAME, policy);
        }
        for (const policy of await iam.listAttachedRolePolicies(AWS_MEMBER_ROLE_NAME)) {
          await iam.detachRolePolicy(AWS_MEMBER_ROLE_NAME, policy.arn);
        }
        log('member role stripped', AWS_MEMBER_ROLE_NAME);
        return removed();
      } catch (err) {
        // The member role would not be assumed at all — an earlier call got to
        // step 4 — or a strip call was refused: done only when no fresh session
        // of either role can be had.
        if (
          (sessionClosed(err) || (stripping && accessDenied(err))) &&
          (await closedOut(accountId))
        ) {
          return removed();
        }
        throw err;
      }
    },
  };
}
