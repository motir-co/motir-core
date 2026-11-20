import {
  awsManagementCredentials,
  convergeServerlessRoles,
  createAwsManagementApi,
  serverlessHostingConfig,
  type AwsManagementApi,
  type ConvergeServerlessRolesDeps,
  type ServerlessHostingConfig,
  type ServerlessRoleConvergence,
} from '@motir/orchestrator';

// CONVERGE THE SERVERLESS HOSTING ACCOUNT'S TWO IAM ROLES (MOTIR-11921) — the
// composition behind `fleet-admin hosting-serverless converge-roles`, the
// serverless twin of the tenant deploy-policy converge (MOTIR-10005).
//
// The account is the scoped role's own (`MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN`),
// and the converge runs as that account's member access role, assumed from
// Motir's management role (`AWS_ORG_ADMIN_ROLE_ARN`) — never as the scoped role,
// which holds no IAM action. The definitions are `@motir/orchestrator`'s
// `serverlessRoleDefinitions`; this file only finds the account and the session.
// Nothing returned carries a credential.

export interface ServerlessHostingRolesInput {
  /** Who may assume the deploy role: the management role and the operator. */
  readonly trustPrincipals: readonly string[];
  /** Read and report only. */
  readonly dryRun: boolean;
}

export interface ServerlessHostingRolesDeps {
  readonly config?: Pick<ServerlessHostingConfig, 'accountId' | 'region'>;
  readonly management?: Pick<AwsManagementApi, 'assumeMemberRole'>;
  readonly converge?: ConvergeServerlessRolesDeps;
}

export interface ServerlessHostingRolesResult {
  readonly accountId: string;
  readonly roles: ServerlessRoleConvergence[];
}

export const serverlessHostingRolesService = {
  async converge(
    input: ServerlessHostingRolesInput,
    deps: ServerlessHostingRolesDeps = {},
  ): Promise<ServerlessHostingRolesResult> {
    const { accountId, region } = deps.config ?? serverlessHostingConfig();
    const management =
      deps.management ?? createAwsManagementApi(awsManagementCredentials(process.env));
    const session = await management.assumeMemberRole(accountId);
    const roles = await convergeServerlessRoles(
      {
        accountId,
        region,
        deployTrustPrincipals: input.trustPrincipals,
        dryRun: input.dryRun,
        credentials: {
          accessKeyId: session.accessKeyId,
          secretAccessKey: session.secretAccessKey,
          sessionToken: session.sessionToken,
        },
      },
      deps.converge,
    );
    return { accountId, roles };
  },
};
