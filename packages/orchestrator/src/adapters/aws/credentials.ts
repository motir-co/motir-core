import { OrchestratorNotConfiguredError } from '../../errors';

// WHERE AN AWS CREDENTIAL IS READ FROM (Story MOTIR-9270 · MOTIR-9278). The
// package reads no environment, so the CALLER hands its environment in — the
// composition root and `fleet-admin` pass the process environment, a test a record.

/** The management credential's env name (MOTIR-9271): the management-account
 *  role add-shard assumes to create accounts. There is no key variable
 *  (MOTIR-10302): the role is always assumed from the AWS SDK's default
 *  credential chain — the task role on AWS, an instance role, or an operator's
 *  SSO profile; an install that really needs a long-lived key sets the SDK's own
 *  `AWS_ACCESS_KEY_ID`, which the chain reads. */
export const AWS_MANAGEMENT_ENV = {
  roleArn: 'AWS_ORG_ADMIN_ROLE_ARN',
} as const;

export interface AwsManagementCredentials {
  /** The management-account role add-shard assumes (`motir-add-shard`). */
  readonly roleArn: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string {
  return env[name]?.trim() ?? '';
}

/** The management variables that must be set: the role ARN, and nothing else. */
export function awsManagementRequiredEnv(): string[] {
  return [AWS_MANAGEMENT_ENV.roleArn];
}

/**
 * The management credential — the role ARN, assumed from the SDK's default
 * credential chain — or `OrchestratorNotConfiguredError` naming the variable.
 */
export function awsManagementCredentials(env: Env): AwsManagementCredentials {
  const roleArn = read(env, AWS_MANAGEMENT_ENV.roleArn);
  if (!roleArn) throw new OrchestratorNotConfiguredError(`set ${AWS_MANAGEMENT_ENV.roleArn}`);
  return { roleArn };
}
