import { readTenantStackTemplate } from '../../tenantStacks';
import type { TenantSecretsManager } from '../clients';
import { AwsTenantApiError } from '../errors';
import { stackOutput } from '../network';
import { TAG_ORGANIZATION, TAG_REPOSITORY, type StackRunner } from '../stackRunner';

// An environment's CONNECTION SECRET (MOTIR-10007). The secret is always a
// stack's resource — production's in the database stack, a preview's in its own
// `preview-database.yaml` stack — created holding a generated `password`; this
// module reads that password and writes the assembled URL beside it under `url`.
// Values are never returned, logged or put into an error.

/** The secret's value is not the JSON the templates generate. */
export class ConnectionSecretUnreadableError extends Error {
  readonly code = 'AWS_CONNECTION_SECRET_UNREADABLE' as const;
  constructor(
    readonly secretArn: string,
    readonly reason: string,
  ) {
    super(`The connection secret ${secretArn} could not be read (${reason}).`);
    this.name = 'ConnectionSecretUnreadableError';
  }
}

/** The secret's JSON fields. */
interface ConnectionSecretValue {
  password?: unknown;
  url?: unknown;
  [key: string]: unknown;
}

/** Secrets Manager failures, by AWS code only. */
async function secretCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const code = err instanceof AwsTenantApiError ? err.awsCode : 'UnknownError';
    throw new AwsTenantApiError('secretsmanager', `${operation}:${code}`, null);
  }
}

/** The preview's secret stack, applied (create or reuse — an existing secret's
 *  generated password is never regenerated); answers the secret's ARN. */
export async function ensurePreviewSecretStack(input: {
  readonly runner: StackRunner;
  readonly stackName: string;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly pullRequest: number;
}): Promise<string> {
  const { outputs } = await input.runner.applyStack({
    stackName: input.stackName,
    template: readTenantStackTemplate('preview-database.yaml'),
    parameters: {
      OrganizationId: input.organizationId,
      RepositoryId: input.repositoryId,
      PullRequestNumber: String(input.pullRequest),
    },
    tags: { [TAG_ORGANIZATION]: input.organizationId, [TAG_REPOSITORY]: input.repositoryId },
  });
  return stackOutput(input.stackName, outputs, 'PreviewSecretArn');
}

/** Delete the preview's secret stack; nothing to do when it is gone. */
export async function deletePreviewSecretStack(
  runner: StackRunner,
  stackName: string,
): Promise<void> {
  await runner.deleteStack(stackName);
}

async function readSecret(
  secrets: TenantSecretsManager,
  secretArn: string,
): Promise<ConnectionSecretValue> {
  const raw = await secretCall('GetSecretValue', () => secrets.getSecretValue(secretArn));
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ConnectionSecretUnreadableError(secretArn, 'not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConnectionSecretUnreadableError(secretArn, 'not an object');
  }
  return value as ConnectionSecretValue;
}

/** The password CloudFormation generated into the secret. Alphanumeric only
 *  (the templates exclude punctuation), so it is safe as a SQL literal. */
export async function readGeneratedPassword(
  secrets: TenantSecretsManager,
  secretArn: string,
): Promise<string> {
  const { password } = await readSecret(secrets, secretArn);
  if (typeof password !== 'string' || !/^[A-Za-z0-9]{16,}$/.test(password)) {
    throw new ConnectionSecretUnreadableError(secretArn, 'no generated password');
  }
  return password;
}

/** `postgres://role:password@endpoint:5432/database?sslmode=require`. */
export function buildDatabaseUrl(input: {
  readonly role: string;
  readonly password: string;
  readonly endpoint: string;
  readonly database: string;
}): string {
  return `postgres://${input.role}:${input.password}@${input.endpoint}:5432/${input.database}?sslmode=require`;
}

/** Write the URL beside the password — only when it differs, so a repeat
 *  writes nothing. */
export async function writeDatabaseUrl(
  secrets: TenantSecretsManager,
  secretArn: string,
  url: string,
): Promise<void> {
  const current = await readSecret(secrets, secretArn);
  if (current.url === url) return;
  await secretCall('PutSecretValue', () =>
    secrets.putSecretValue(secretArn, JSON.stringify({ ...current, url })),
  );
}
