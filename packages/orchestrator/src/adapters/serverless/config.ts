import { OrchestratorNotConfiguredError } from '../../errors';

// WHERE THE SERVERLESS ADAPTER RUNS (Story MOTIR-9793 · MOTIR-9972): Motir's own
// account `motir-hosting-serverless`, reached by assuming ONE scoped role there
// (MOTIR-9970), in one region. The decision of record is MOTIR-5769 §3–§4 (page
// cmvrcywwc00jkhpr1zvvnike8, v1).
//
// ⚠️ EXACTLY TWO VARIABLES, read at call time. The account is the role ARN's own,
// so there is no account argument anywhere on this adapter and no path to a
// customer account (D1): a release can only ever land where the scoped role is.

export const SERVERLESS_ROLE_ARN_ENV = 'MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN';
export const SERVERLESS_REGION_ENV = 'MOTIR_HOSTING_AWS_REGION';

/** The decision page's region for the serverless account. */
export const SERVERLESS_DEFAULT_REGION = 'us-east-1';

/** The app-name prefix of every hosted unit (MOTIR-5769 §4). */
export const SERVERLESS_DEFAULT_APP_PREFIX = 'mh-';

export interface ServerlessHostingConfig {
  /** The scoped role every call is made under. */
  readonly roleArn: string;
  /** The serverless account — the role ARN's own, never configured apart from it. */
  readonly accountId: string;
  readonly region: string;
  readonly appPrefix: string;
}

const ROLE_ARN = /^arn:aws[a-z-]*:iam::(\d{12}):role\/[\w+=,.@/-]+$/;

/** The adapter's configuration, or the typed not-configured error naming the
 *  variable that is unset or malformed. */
export function serverlessHostingConfig(): ServerlessHostingConfig {
  const roleArn = process.env[SERVERLESS_ROLE_ARN_ENV]?.trim();
  if (!roleArn) throw new OrchestratorNotConfiguredError(`set ${SERVERLESS_ROLE_ARN_ENV}`);
  const account = ROLE_ARN.exec(roleArn)?.[1];
  if (!account) {
    throw new OrchestratorNotConfiguredError(`${SERVERLESS_ROLE_ARN_ENV} is not an IAM role ARN`);
  }
  return {
    roleArn,
    accountId: account,
    region: process.env[SERVERLESS_REGION_ENV]?.trim() || SERVERLESS_DEFAULT_REGION,
    appPrefix: SERVERLESS_DEFAULT_APP_PREFIX,
  };
}
