import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';

// THE INDEX-FLEET PREFLIGHT'S ECR LOGIN (MOTIR-11277) — the registry credential
// `verifyIndexFleetBootable` probes an ECR-hosted indexer image with.
//
// Since MOTIR-10123 the AWS deployment's `MOTIR_INDEXER_IMAGE` names a digest in
// core's own `motir/indexer` ECR repository. ECR answers an anonymous manifest
// GET with `401 · WWW-Authenticate: Basic …` whether or not the digest exists, so
// an anonymous probe can say nothing about the image — the daily health check
// read `indeterminate` every morning from 2026-11-11 until it dead-lettered. The
// index VM itself pulls after `aws ecr get-login-password | docker login
// --username AWS` (`indexUserData.ts` `ecrLoginLines`); this is the same login,
// asked through the SDK so the probe authenticates exactly as the pull does.
//
// It lives beside `ecrImagesReader.ts` for the reason that file does
// (`tests/ciFleet/awsSdkBoundary.test.ts` registers the directory): the caller
// sees a plain username/password pair and is tested offline.
//
// ⚠️ NO CREDENTIALS ARE PASSED. The client resolves them through the SDK's
// default chain, which on ECS is the calling task's role; motir-infra grants
// the worker `ecr:GetAuthorizationToken` (no resource-level form, so `*`) and
// `ecr:BatchGetImage` on the indexer repository — the manifest GET is
// authorised as `BatchGetImage`. The REGION and the registry come from the image
// reference's host, so the token is minted for the registry the pin names.
//
// ⚠️ THE TOKEN IS NEVER LOGGED, CACHED OR RETURNED IN AN ERROR. It is a 12-hour
// pull credential for every repository the role can read; it lives for one probe.

/** A private ECR registry host: `<account>.dkr.ecr.<region>.amazonaws.com`
 *  (`.com.cn` in the China partition). The same shape `indexUserData.ts`
 *  recognises for the VM's own login. */
const ECR_REGISTRY_HOST =
  /^(\d{12})\.dkr\.ecr\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com(?:\.cn)?$/;

/** The ECR registry a host names. */
export interface EcrRegistry {
  /** The registry host, as the image reference spells it. */
  host: string;
  /** The AWS account that owns the registry. */
  registryId: string;
  region: string;
}

/** A Basic credential for one ECR registry — `AWS` and the token's password. */
export interface EcrBasicCredential {
  username: string;
  password: string;
}

export interface EcrRegistryCredentialReader {
  /** A pull credential for the registry. Throws when ECR does not issue one
   *  (no permission, no credentials, a transport failure, a malformed answer). */
  credentialFor(registry: EcrRegistry): Promise<EcrBasicCredential>;
}

/** The registry, account and region a registry HOST names, or null when the
 *  host is not a private ECR registry (`registry.fly.io`, `ghcr.io`, …). */
export function parseEcrRegistryHost(host: string): EcrRegistry | null {
  const match = ECR_REGISTRY_HOST.exec(host.trim());
  if (!match) return null;
  return { host: host.trim(), registryId: match[1]!, region: match[2]! };
}

/**
 * The `user:password` pair an ECR authorization token decodes to.
 *
 * ECR documents the token as base64 of `AWS:<password>`; it is split at the
 * FIRST colon because only the username is fixed — a password is opaque.
 * Throws, naming neither half, when the token is not that shape.
 */
export function decodeEcrAuthorizationToken(token: string): EcrBasicCredential {
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0 || colon === decoded.length - 1) {
    throw new Error('ECR returned an authorization token that is not a user:password pair');
  }
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** The reader over the default credential chain, one client per region asked. */
export function createEcrRegistryCredentialReader(): EcrRegistryCredentialReader {
  const clients = new Map<string, ECRClient>();
  const clientFor = (region: string): ECRClient => {
    let client = clients.get(region);
    if (!client) {
      client = new ECRClient({ region });
      clients.set(region, client);
    }
    return client;
  };
  return {
    async credentialFor({ region }) {
      // ⚠️ NO `registryIds`: the field is deprecated and ignored — a token is
      // valid for every registry the caller's role may read in that region.
      const answer = await clientFor(region).send(new GetAuthorizationTokenCommand({}));
      const token = answer.authorizationData?.[0]?.authorizationToken;
      if (!token) throw new Error('ECR returned no authorization token');
      return decodeEcrAuthorizationToken(token);
    },
  };
}
