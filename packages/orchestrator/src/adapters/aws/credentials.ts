import { OrchestratorNotConfiguredError } from '../../errors';

// WHERE AN AWS CREDENTIAL IS READ FROM (Story MOTIR-9270 · MOTIR-9278). The
// package reads no environment, so the CALLER hands its environment in — the
// composition root and `fleet-admin` pass the process environment, a test a record.

/** The management credential's env names (MOTIR-9271): an IAM user's key in the
 *  management account and the role it assumes there to create accounts. */
export const AWS_MANAGEMENT_ENV = {
  accessKeyId: 'AWS_ORG_ADMIN_ACCESS_KEY_ID',
  secretAccessKey: 'AWS_ORG_ADMIN_SECRET_ACCESS_KEY',
  roleArn: 'AWS_ORG_ADMIN_ROLE_ARN',
} as const;

export interface AwsManagementCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** The management-account role add-shard assumes (`motir-add-shard`). */
  readonly roleArn: string;
}

/** An access key pair, without a region. */
export interface AwsAccessKey {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, name: string): string {
  return env[name]?.trim() ?? '';
}

/**
 * The management credential, or `OrchestratorNotConfiguredError` naming EVERY
 * missing variable at once.
 */
export function awsManagementCredentials(env: Env): AwsManagementCredentials {
  const values = {
    accessKeyId: read(env, AWS_MANAGEMENT_ENV.accessKeyId),
    secretAccessKey: read(env, AWS_MANAGEMENT_ENV.secretAccessKey),
    roleArn: read(env, AWS_MANAGEMENT_ENV.roleArn),
  };
  const missing = (Object.keys(values) as Array<keyof typeof values>)
    .filter((key) => !values[key])
    .map((key) => AWS_MANAGEMENT_ENV[key]);
  if (missing.length > 0) throw new OrchestratorNotConfiguredError(`set ${missing.join(', ')}`);
  return values;
}

/** The two variables an account's runtime key lives in, under its `credentialRef`. */
export function awsRuntimeKeyEnvNames(prefix: string): {
  accessKeyId: string;
  secretAccessKey: string;
} {
  return { accessKeyId: `${prefix}_ACCESS_KEY_ID`, secretAccessKey: `${prefix}_SECRET_ACCESS_KEY` };
}

/** The account's runtime key under `prefix`, or null when either half is unset. */
export function awsCredentialsFromEnv(prefix: string, env: Env): AwsAccessKey | null {
  const names = awsRuntimeKeyEnvNames(prefix);
  const accessKeyId = read(env, names.accessKeyId);
  const secretAccessKey = read(env, names.secretAccessKey);
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null;
}
