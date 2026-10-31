// The edge forwarder's configuration (MOTIR-10127): three variables, each the
// name the rest of the project already reads, and the port the app listens on.
//
//   - MOTIR_BASE_URL — where the host contract lives (`lib/baseUrl.ts`'s name);
//   - MOTIR_EDGE_CONTRACT_TOKEN — the bearer the contract's own check compares
//     (`lib/publicAddresses/edgeContractToken.ts`);
//   - MOTIR_HOSTING_ORIGIN_SECRET_KEY — the key each app's origin secret is
//     derived from (`lib/orchestrator/hosting.ts`). Without it the image does not
//     start; with a wrong one every forward to a Fly-hosted app is refused 403 by
//     that app's guard.

/** The port the container listens on; the Fly app's internal port. */
export const EDGE_PORT = 8080;

export const EDGE_ENV = {
  baseUrl: 'MOTIR_BASE_URL',
  contractToken: 'MOTIR_EDGE_CONTRACT_TOKEN',
  originSecretKey: 'MOTIR_HOSTING_ORIGIN_SECRET_KEY',
} as const;

export interface EdgeConfig {
  /** The contract's origin, without a trailing slash. */
  readonly baseUrl: string;
  readonly contractToken: string;
  readonly originSecretKey: string;
}

/** A variable the edge cannot start without is unset or unusable. */
export class EdgeConfigError extends Error {
  // A declared field, not a parameter property: the image runs this file with
  // Node's type stripping, which accepts only erasable syntax.
  readonly variable: string;
  constructor(variable: string, reason: string) {
    super(`${variable} ${reason}; refusing to start.`);
    this.name = 'EdgeConfigError';
    this.variable = variable;
  }
}

/** The edge's configuration from its environment, or the error naming the
 *  first variable that is missing, blank or unusable. */
export function readEdgeConfig(env: Record<string, string | undefined>): EdgeConfig {
  const read = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new EdgeConfigError(name, 'is not set');
    return value;
  };
  const rawBase = read(EDGE_ENV.baseUrl);
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    throw new EdgeConfigError(EDGE_ENV.baseUrl, `is not a URL (${rawBase})`);
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new EdgeConfigError(EDGE_ENV.baseUrl, `is not an http(s) URL (${rawBase})`);
  }
  return {
    baseUrl: base.origin,
    contractToken: read(EDGE_ENV.contractToken),
    originSecretKey: read(EDGE_ENV.originSecretKey),
  };
}
