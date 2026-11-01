import type { HostingEnvironment } from '../../../../hosting/types';
import { readTenantStackTemplate } from '../../tenantStacks';
import { ensureTenantNetwork, stackOutput, type TenantAccountContext } from '../network';
import { TAG_ORGANIZATION, TAG_REPOSITORY } from '../stackRunner';
import {
  buildDatabaseUrl,
  deletePreviewSecretStack,
  ensurePreviewSecretStack,
  readGeneratedPassword,
  writeDatabaseUrl,
} from './connectionSecret';
import { createSqlRunner, type SqlRunner } from './dataApi';
import {
  DATABASE_URL_VARIABLE,
  MAIN_DATABASE,
  databaseStackName,
  environmentDatabaseNames,
  quoteIdentifier,
} from './names';

// THE APPLICATION DATABASE in the tenant account (MOTIR-10007), to MOTIR-5769
// §4: one Aurora PostgreSQL Serverless v2 cluster per application, production on
// its main database and each preview on a database of its own, each owned by a
// login role of its own. Every AWS resource is a stack's (`database.yaml`, and a
// `preview-database.yaml` per preview); this module only runs SQL through the
// Data API and reads and writes secret VALUES.
//
// The order makes every step look-before-act, so a run cut off anywhere resumes:
// the secret (a stack output) → its generated password → the role (create, or
// set its password to the secret's) → the database (create owned by the role,
// or hand production's main database to it) → the URL written into the secret.
//
// What leaves this module is a secret's ARN and the variable name `DATABASE_URL`
// — never the URL, never the password.

export * from './names';
export * from './dataApi';
export * from './connectionSecret';

export interface TenantDatabaseOptions {
  /** The Data API's resume backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The application's database stack's outputs. */
export interface ApplicationDatabase {
  readonly stackName: string;
  readonly clusterArn: string;
  readonly endpoint: string;
  readonly masterSecretArn: string;
  readonly databaseName: string;
  readonly productionSecretArn: string;
}

/** What a release is given: a secret's ARN, and the variable to read it into. */
export interface EnvironmentDatabaseReference {
  readonly secretArn: string;
  readonly variable: typeof DATABASE_URL_VARIABLE;
}

/** The network, then the application's database stack. */
export async function ensureApplicationDatabase(
  account: TenantAccountContext,
  input: { readonly repositoryId: string },
): Promise<ApplicationDatabase> {
  const stackName = databaseStackName(input.repositoryId);
  const network = await ensureTenantNetwork(account);
  const { outputs } = await account.runner.applyStack({
    stackName,
    template: readTenantStackTemplate('database.yaml'),
    parameters: {
      OrganizationId: account.organizationId,
      RepositoryId: input.repositoryId,
      PrivateSubnetIds: network.privateSubnetIds.join(','),
      DatabaseSecurityGroupId: network.databaseSecurityGroupId,
    },
    tags: { [TAG_ORGANIZATION]: account.organizationId, [TAG_REPOSITORY]: input.repositoryId },
  });
  const read = (output: string) => stackOutput(stackName, outputs, output);
  return {
    stackName,
    clusterArn: read('ClusterArn'),
    endpoint: read('ClusterEndpoint'),
    masterSecretArn: read('MasterSecretArn'),
    databaseName: read('DatabaseName'),
    productionSecretArn: read('ProductionConnectionSecretArn'),
  };
}

function sqlOn(
  account: TenantAccountContext,
  app: Pick<ApplicationDatabase, 'clusterArn' | 'masterSecretArn'>,
  options: TenantDatabaseOptions,
): SqlRunner {
  return createSqlRunner(
    account.clients.rdsData,
    { clusterArn: app.clusterArn, masterSecretArn: app.masterSecretArn, database: MAIN_DATABASE },
    options.sleep,
  );
}

const exists = async (sql: SqlRunner, operation: string, query: string, name: string) =>
  (await sql.run(operation, query, { name })).length > 0;

/** An environment's database, its owning role and its connection secret. */
export async function ensureEnvironmentDatabase(
  account: TenantAccountContext,
  input: { readonly repositoryId: string; readonly environment: HostingEnvironment },
  options: TenantDatabaseOptions = {},
): Promise<EnvironmentDatabaseReference> {
  const names = environmentDatabaseNames(input.repositoryId, input.environment);
  const app = await ensureApplicationDatabase(account, input);
  const secrets = account.clients.secretsManager;

  // (a) The secret, and the password CloudFormation generated into it.
  const secretArn =
    input.environment.kind === 'preview'
      ? await ensurePreviewSecretStack({
          runner: account.runner,
          stackName: names.previewStackName!,
          organizationId: account.organizationId,
          repositoryId: input.repositoryId,
          pullRequest: input.environment.pullRequest,
        })
      : app.productionSecretArn;
  const password = await readGeneratedPassword(secrets, secretArn);

  // (b) The role, with the secret's password.
  const sql = sqlOn(account, app, options);
  const role = quoteIdentifier(names.role);
  const verb = (await exists(
    sql,
    'find role',
    'SELECT 1 FROM pg_roles WHERE rolname = :name',
    names.role,
  ))
    ? 'ALTER'
    : 'CREATE';
  await sql.run(
    `${verb.toLowerCase()} role`,
    `${verb} ROLE ${role} WITH LOGIN PASSWORD '${password}'`,
  );
  // The master must be a member to make the role a database's owner.
  await sql.run('grant role', `GRANT ${role} TO CURRENT_USER`);

  // (c) The database, owned by the role.
  const database = quoteIdentifier(names.database);
  if (input.environment.kind === 'production') {
    await sql.run('own database', `ALTER DATABASE ${database} OWNER TO ${role}`);
  } else if (
    !(await exists(
      sql,
      'find database',
      'SELECT 1 FROM pg_database WHERE datname = :name',
      names.database,
    ))
  ) {
    await sql.run('create database', `CREATE DATABASE ${database} OWNER ${role}`);
  }

  // (d) The URL, into the secret.
  await writeDatabaseUrl(
    secrets,
    secretArn,
    buildDatabaseUrl({
      role: names.role,
      password,
      endpoint: app.endpoint,
      database: names.database,
    }),
  );
  return { secretArn, variable: DATABASE_URL_VARIABLE };
}

/** Drop a preview's database and role, then its secret stack. What is already
 *  gone is not an error; production's database is never touched. */
export async function dropPreviewDatabase(
  account: TenantAccountContext,
  input: { readonly repositoryId: string; readonly pullRequest: number },
  options: TenantDatabaseOptions = {},
): Promise<void> {
  const names = environmentDatabaseNames(input.repositoryId, {
    kind: 'preview',
    pullRequest: input.pullRequest,
  });
  const appStack = await account.runner.describeStack(databaseStackName(input.repositoryId));
  if (appStack) {
    const sql = sqlOn(
      account,
      {
        clusterArn: stackOutput(
          databaseStackName(input.repositoryId),
          appStack.outputs,
          'ClusterArn',
        ),
        masterSecretArn: stackOutput(
          databaseStackName(input.repositoryId),
          appStack.outputs,
          'MasterSecretArn',
        ),
      },
      options,
    );
    // FORCE: a connection the preview left open must not block the drop. Each
    // DDL statement runs on its own — DROP DATABASE cannot run in a transaction.
    await sql.run(
      'drop database',
      `DROP DATABASE IF EXISTS ${quoteIdentifier(names.database)} WITH (FORCE)`,
    );
    await sql.run('drop role', `DROP ROLE IF EXISTS ${quoteIdentifier(names.role)}`);
  }
  await deletePreviewSecretStack(account.runner, names.previewStackName!);
}

/** Delete the application's database stack; nothing to do when it is gone. The
 *  network stack is never deleted here. */
export async function destroyApplicationDatabase(
  account: TenantAccountContext,
  input: { readonly repositoryId: string },
): Promise<void> {
  await account.runner.deleteStack(databaseStackName(input.repositoryId));
}
