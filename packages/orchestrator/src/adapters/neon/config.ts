import { OrchestratorNotConfiguredError } from '../../errors';

// WHERE THE NEON ADAPTER RUNS (Story MOTIR-9793 · MOTIR-9973): Motir's own Neon
// organisation, reached with its own API key (MOTIR-9970). Two variables, read
// at call time and never at import; an unset one is named, never its value.

export const NEON_API_KEY_ENV = 'MOTIR_HOSTING_NEON_API_KEY';
export const NEON_ORG_ID_ENV = 'MOTIR_HOSTING_NEON_ORG_ID';

export interface NeonDatabaseConfig {
  readonly apiKey: string;
  readonly orgId: string;
  /** Where a new project lives: beside the serverless account (MOTIR-5769 §4). */
  readonly region: string;
}

export const NEON_DEFAULT_REGION = 'aws-us-east-1';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new OrchestratorNotConfiguredError(`set ${name}`);
  return value;
}

export function neonDatabaseConfig(): NeonDatabaseConfig {
  return {
    apiKey: required(NEON_API_KEY_ENV),
    orgId: required(NEON_ORG_ID_ENV),
    region: NEON_DEFAULT_REGION,
  };
}
