import type { DeployReleaseInput } from '../../hosting/types';

// A release's Lambda environment (MOTIR-5769 §4): the Web Adapter's variables,
// which carry the manifest's port and health check, plus the release's pairs.
//
// Lambda caps a function's variables at 4 KB in aggregate. Above it EVERY pair
// moves to one Secrets Manager secret and the function keeps only a pointer to
// it — all of them rather than the overflow, so where a value lives never turns
// on its neighbours' sizes.

/** Lambda's aggregate limit on a function's environment variables. */
export const LAMBDA_ENV_LIMIT_BYTES = 4096;

/** The variable naming the overflow secret, when there is one. */
export const SERVERLESS_ENV_SECRET_VAR = 'MOTIR_HOSTING_ENV_SECRET';

export interface LambdaEnvironment {
  /** What the function's configuration carries. */
  readonly variables: Record<string, string>;
  /** The pairs as the secret's JSON value, or null when they fit. */
  readonly overflow: string | null;
}

/** The Lambda Web Adapter's settings for a release. */
export function webAdapterVariables(input: DeployReleaseInput): Record<string, string> {
  return {
    AWS_LWA_PORT: String(input.runtime.port),
    AWS_LWA_READINESS_CHECK_PATH: input.runtime.healthCheck.path,
    AWS_LWA_INVOKE_MODE: 'response_stream',
  };
}

function aggregateBytes(variables: Record<string, string>): number {
  return Object.entries(variables).reduce(
    (sum, [name, value]) => sum + Buffer.byteLength(name) + Buffer.byteLength(value),
    0,
  );
}

export function lambdaEnvironment(
  input: DeployReleaseInput,
  secretName: string,
): LambdaEnvironment {
  const adapter = webAdapterVariables(input);
  const pairs = Object.fromEntries(input.env.map((pair) => [pair.name, pair.value]));
  const inline = { ...pairs, ...adapter };
  if (aggregateBytes(inline) <= LAMBDA_ENV_LIMIT_BYTES)
    return { variables: inline, overflow: null };
  return {
    variables: { ...adapter, [SERVERLESS_ENV_SECRET_VAR]: secretName },
    overflow: JSON.stringify(pairs),
  };
}
