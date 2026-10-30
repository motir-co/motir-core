import { Hash } from '@smithy/hash-node';
import { SignatureV4 } from '@smithy/signature-v4';
import {
  serverlessCredentialProvider,
  type AwsCredentialIdentityProvider,
  type ServerlessClientDeps,
} from './client';
import { serverlessHostingConfig, type ServerlessHostingConfig } from './config';

// THE ORIGIN CREDENTIAL OF THE SERVERLESS TARGET (MOTIR-9972). A release's
// upstream is a Lambda function URL with `AuthType AWS_IAM`, so `describe` reports
// `originCredential: 'aws_sigv4'` and the adapter owns the one way to satisfy it:
// a request signed with SigV4 for the `lambda` service under the scoped role.
// The operator deploy check and any forwarder reach the address through this,
// without importing an AWS type — it takes a URL and a plain init, and answers
// plain headers.

export interface FunctionUrlRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Signed as it is: the payload hash covers these exact bytes. The preview
   *  gate (MOTIR-5779) forwards a buffered request body as bytes. */
  readonly body?: string | Uint8Array;
}

/** What to hand `fetch`: the method, the signed headers and the body. */
export interface SignedFunctionUrlRequest {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string | Uint8Array;
}

export interface SignFunctionUrlOptions extends ServerlessClientDeps {
  /** Absent means `serverlessHostingConfig()`, read now. */
  readonly config?: Pick<ServerlessHostingConfig, 'roleArn' | 'region'>;
  /** Already-resolved credentials, e.g. one provider shared across requests. */
  readonly credentials?: AwsCredentialIdentityProvider;
}

/** `<id>.lambda-url.<region>.on.aws` → `<region>`. */
function regionOfFunctionUrl(hostname: string): string | null {
  return /^[^.]+\.lambda-url\.([a-z0-9-]+)\.on\.aws$/.exec(hostname)?.[1] ?? null;
}

export async function signFunctionUrlRequest(
  url: string,
  init: FunctionUrlRequestInit = {},
  options: SignFunctionUrlOptions = {},
): Promise<SignedFunctionUrlRequest> {
  const config = options.config ?? serverlessHostingConfig();
  const target = new URL(url);
  const signer = new SignatureV4({
    service: 'lambda',
    region: regionOfFunctionUrl(target.hostname) ?? config.region,
    credentials: options.credentials ?? serverlessCredentialProvider(config, options),
    sha256: Hash.bind(null, 'sha256'),
  });
  const method = (init.method ?? 'GET').toUpperCase();
  const query: Record<string, string> = {};
  target.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  const signed = await signer.sign(
    {
      method,
      protocol: target.protocol,
      hostname: target.hostname,
      path: target.pathname,
      query,
      headers: { ...init.headers, host: target.host },
      ...(init.body !== undefined ? { body: init.body } : {}),
    },
    ...(options.now ? [{ signingDate: options.now() }] : []),
  );
  return {
    method,
    headers: { ...(signed.headers as Record<string, string>) },
    ...(init.body !== undefined ? { body: init.body } : {}),
  };
}
