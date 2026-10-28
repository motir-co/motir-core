import { OrchestratorNotConfiguredError } from '../../errors';

// WHERE AN AWS CREDENTIAL IS READ FROM (Story MOTIR-9270 · MOTIR-9278). The
// package reads no environment, so the CALLER hands its environment in — the
// composition root and `fleet-admin` pass the process environment, a test a record.

/** The management credential's env names (MOTIR-9271): an IAM user's key in the
 *  management account and the role it assumes there to create accounts. The key
 *  is optional (MOTIR-9839): without it the role is assumed from the AWS SDK's
 *  default credential chain — the task role once core runs on AWS. */
export const AWS_MANAGEMENT_ENV = {
  accessKeyId: 'AWS_ORG_ADMIN_ACCESS_KEY_ID',
  secretAccessKey: 'AWS_ORG_ADMIN_SECRET_ACCESS_KEY',
  roleArn: 'AWS_ORG_ADMIN_ROLE_ARN',
} as const;

export interface AwsManagementCredentials {
  /** The management IAM user's key; both halves, or neither for the default chain. */
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  /** The management-account role add-shard assumes (`motir-add-shard`). */
  readonly roleArn: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string {
  return env[name]?.trim() ?? '';
}

/**
 * The management variables that must be set for `env`: the role ARN always, and
 * the key's two halves once either is — a half-set key is a mistake, not a
 * request for the default chain.
 */
export function awsManagementRequiredEnv(env: Env): string[] {
  const keyNames = [AWS_MANAGEMENT_ENV.accessKeyId, AWS_MANAGEMENT_ENV.secretAccessKey];
  const keySet = keyNames.some((name) => read(env, name));
  return [...(keySet ? keyNames : []), AWS_MANAGEMENT_ENV.roleArn];
}

/**
 * The management credential, or `OrchestratorNotConfiguredError` naming EVERY
 * missing variable at once. With neither key variable set it carries the role
 * ARN alone, and the role is assumed from the SDK's default credential chain.
 */
export function awsManagementCredentials(env: Env): AwsManagementCredentials {
  const missing = awsManagementRequiredEnv(env).filter((name) => !read(env, name));
  if (missing.length > 0) throw new OrchestratorNotConfiguredError(`set ${missing.join(', ')}`);
  const roleArn = read(env, AWS_MANAGEMENT_ENV.roleArn);
  const accessKeyId = read(env, AWS_MANAGEMENT_ENV.accessKeyId);
  if (!accessKeyId) return { roleArn };
  return { accessKeyId, secretAccessKey: read(env, AWS_MANAGEMENT_ENV.secretAccessKey), roleArn };
}
