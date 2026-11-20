import { GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { OrchestratorApiError } from '../../errors';
import {
  defaultServerlessClientFactory,
  serverlessCredentialProvider,
  toApiError,
  type AwsCredentialIdentityProvider,
  type ServerlessClientDeps,
} from './client';
import { serverlessHostingConfig, type ServerlessHostingConfig } from './config';

// THE SERVERLESS ACCOUNT'S IMAGE REGISTRY LOGIN (MOTIR-11847). Whoever pushes a
// release image into `mh/*` signs in as the SCOPED ROLE, like every other call
// into the serverless account: its policy grants the push actions on
// `repository/mh/*` and `ecr:GetAuthorizationToken`, and nothing else is let in.
// A login taken from the caller's ambient credentials is a different principal —
// an operator's own user in the management account — which the repositories
// carry no policy for, so its push is refused (MOTIR-9977, 2026-11-19).
//
// The password is a short-lived registry token. It is answered to the caller to
// hand to `docker login --password-stdin`, never printed, and never part of an
// error: a failure carries the ECR error code only.

/** What `docker login` takes for the serverless account's registry. */
export interface ServerlessRegistryLogin {
  /** The registry host, `<account>.dkr.ecr.<region>.amazonaws.com`. */
  readonly registry: string;
  readonly username: string;
  readonly password: string;
}

export interface ServerlessRegistryLoginOptions extends ServerlessClientDeps {
  /** Absent means `serverlessHostingConfig()`, read now. */
  readonly config?: Pick<ServerlessHostingConfig, 'roleArn' | 'region'>;
  /** The scoped role's credentials, already resolved; absent means assumed here. */
  readonly credentials?: AwsCredentialIdentityProvider;
}

interface AuthorizationData {
  authorizationToken?: unknown;
  proxyEndpoint?: unknown;
}

function invalid(detail: string): OrchestratorApiError {
  return new OrchestratorApiError('aws', null, `ecr: GetAuthorizationToken ${detail}`);
}

/** `AWS:<password>`, base64-encoded, split at its first colon. */
function decodeToken(token: unknown): { username: string; password: string } {
  if (typeof token !== 'string' || !token) throw invalid('returned no token');
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0 || colon === decoded.length - 1) throw invalid('returned an unreadable token');
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** `https://<host>` → `<host>`. */
function registryHost(endpoint: unknown): string {
  if (typeof endpoint !== 'string' || !endpoint) throw invalid('returned no registry endpoint');
  return endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * A login for the serverless account's registry, with the token requested
 * under the scoped role of `MOTIR_HOSTING_AWS_SERVERLESS_ROLE_ARN` — never under
 * the caller's own credentials, which only ever ASSUME that role.
 */
export async function serverlessRegistryLogin(
  options: ServerlessRegistryLoginOptions = {},
): Promise<ServerlessRegistryLogin> {
  const config = options.config ?? serverlessHostingConfig();
  const factory = options.clientFactory ?? defaultServerlessClientFactory;
  const ecr = factory('ecr', {
    region: config.region,
    credentials: options.credentials ?? serverlessCredentialProvider(config, options),
  });
  let response: unknown;
  try {
    response = await ecr.send(new GetAuthorizationTokenCommand({}));
  } catch (err) {
    throw toApiError('ecr', err);
  }
  const data = (response as { authorizationData?: AuthorizationData[] }).authorizationData?.[0];
  if (!data) throw invalid('returned no authorization data');
  return { registry: registryHost(data.proxyEndpoint), ...decodeToken(data.authorizationToken) };
}
