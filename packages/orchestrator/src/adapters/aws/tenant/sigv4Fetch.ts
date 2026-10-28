import { createHash, createHmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { defaultChainCredentials } from './sdk';

// A FETCH THAT SIGNS ITS REQUEST WITH SIGV4 for service `lambda` (MOTIR-10011):
// how a caller reaches a function release's URL, whose `AuthType` is `AWS_IAM`
// (MOTIR-5769 §4). The operator deploy check reads a function release's page
// through it. It signs with the default credential chain unless given
// credentials, and nothing it exports names an AWS SDK type, so `lib/` and
// `scripts/` reach it without importing `@aws-sdk/*`.
//
// Reference, read 2026-10-28:
//   https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html

/** Credentials to sign with. */
export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/** A GET or HEAD sent signed; the answer is the plain `Response`. */
export type SigV4Fetch = (
  url: string,
  init?: { method?: 'GET' | 'HEAD'; headers?: Record<string, string> },
) => Promise<Response>;

export interface SigV4FetchOptions {
  readonly region: string;
  /** Absent means the default credential chain. */
  readonly credentials?: () => Promise<SigV4Credentials>;
  /** Absent means the global `fetch`. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

type SourceData = string | ArrayBuffer | ArrayBufferView;

const bytes = (data: SourceData): string | Uint8Array =>
  typeof data === 'string'
    ? data
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);

/** SHA-256 (or its HMAC under a key) in the shape the signer asks for. */
class NodeSha256 {
  private readonly hash;
  constructor(secret?: SourceData) {
    this.hash = secret === undefined ? createHash('sha256') : createHmac('sha256', bytes(secret));
  }
  update(data: SourceData): void {
    this.hash.update(bytes(data));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }
}

export function createSigV4Fetch(options: SigV4FetchOptions): SigV4Fetch {
  const signer = new SignatureV4({
    service: 'lambda',
    region: options.region,
    credentials: options.credentials ?? defaultChainCredentials(options.region),
    sha256: NodeSha256,
  });
  const send = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  return async (url, init = {}) => {
    const target = new URL(url);
    const method = init.method ?? 'GET';
    const signed = await signer.sign({
      method,
      protocol: target.protocol,
      hostname: target.hostname,
      ...(target.port ? { port: Number(target.port) } : {}),
      path: target.pathname,
      query: Object.fromEntries(target.searchParams),
      headers: { ...init.headers, host: target.host },
    });
    // `host` is signed but never sent as a header: the URL carries it.
    const { host: _host, ...headers } = signed.headers;
    return send(url, { method, headers, redirect: 'manual' });
  };
}
