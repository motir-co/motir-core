// The S3-compatible object-store client (MOTIR-2389) — the ONE place the
// provider's SDK is configured, so `lib/blob/uploader.ts` stays a set of
// object operations and this file owns endpoint/credential/bucket policy.
//
// Provider: Tigris (Fly's S3-compatible store), per
// `docs/decisions/application-hosting.md` Q2, with a static key; or Amazon S3
// on AWS, with no key and no endpoint, signing as the task role (MOTIR-9925).
// Nothing here is Tigris-specific beyond the endpoint value — the API is S3,
// which is also what a self-hoster is most likely to have
// (`attachment-access-control.md` Amendment 2).
//
// TWO BUCKETS, not one bucket with per-object ACLs: a PUBLIC bucket for
// avatars/public assets (directly fetchable, CDN-cacheable) and a PRIVATE one
// for content (presigned GET only, through the authenticated content route).
// The split is structural so it cannot be got wrong one object at a time.
//
// ⚠️ Every env read below is LAZY — inside the accessor, never at module
// scope. Importing this module must not require configuration: several suites
// `importOriginal` the uploader to stub one function while keeping the rest,
// and `next build` traces the module without any secret present.

import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

/** Env var names, in one place — `MOTIR-2386` sets exactly these as Fly secrets. */
export const S3_ENV = {
  endpoint: 'MOTIR_S3_ENDPOINT',
  region: 'MOTIR_S3_REGION',
  accessKeyId: 'MOTIR_S3_ACCESS_KEY_ID',
  secretAccessKey: 'MOTIR_S3_SECRET_ACCESS_KEY',
  privateBucket: 'MOTIR_S3_PRIVATE_BUCKET',
  publicBucket: 'MOTIR_S3_PUBLIC_BUCKET',
  publicBaseUrl: 'MOTIR_S3_PUBLIC_BASE_URL',
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set — the blob store is unconfigured. See .env.example (MOTIR-2389).`,
    );
  }
  return value;
}

let cached: { client: S3Client; key: string } | null = null;

/**
 * An E2E-only transport, installed at boot by `instrumentation.ts`.
 *
 * ⚠️ TWO things about this are load-bearing, and both were learned the hard way.
 *
 * **It is installed at the SDK's transport, not at undici.** Every other E2E
 * seam intercepts an undici `MockAgent`, which cannot reach this one: undici's
 * global dispatcher governs `fetch`, and the AWS SDK's default Node transport is
 * `node:https`. `@vercel/blob` used `fetch`, so intercepting it worked; the swap
 * silently moved the traffic to a layer the interceptor does not see, and the
 * suite's uploads left as real DNS lookups.
 *
 * **It is held on `globalThis`, not in a module variable.** Next.js loads
 * `instrumentation.ts` in a DIFFERENT module graph from the route handlers, so
 * a module-level `let` set at instrumentation is simply not the same binding the
 * routes read — the boot log says "installed" and the routes still hit the
 * network. A `Symbol.for` key is process-global and crosses that boundary, which
 * is the same reason the other seams reach for `setGlobalDispatcher`.
 *
 * Typed loosely and set by injection, so this production module never imports
 * the test one; unset in every real deployment.
 */
const TRANSPORT_KEY = Symbol.for('motir.blob.e2eObjectStoreTransport');

type TransportHolder = { [TRANSPORT_KEY]?: unknown };

function e2eTransport(): unknown {
  return (globalThis as TransportHolder)[TRANSPORT_KEY] ?? null;
}

/**
 * Install an in-process transport for the object store (E2E only). Called from
 * `instrumentation.ts` behind `E2E_TEST_BLOB=1`, before any handler runs.
 */
export function installObjectStoreTransport(handler: unknown): void {
  (globalThis as TransportHolder)[TRANSPORT_KEY] = handler;
  cached = null;
}

/**
 * The shared S3 client, built on first use and re-built if the configuration
 * changes (which only happens in tests — the cache key covers the credential
 * mode, the endpoint, the region and the transport, so a suite that re-points
 * the env gets a client for the NEW configuration rather than a stale one).
 *
 * TWO credential modes:
 *   - **Keys** (Tigris, a self-hosted MinIO): `MOTIR_S3_ACCESS_KEY_ID` and
 *     `MOTIR_S3_SECRET_ACCESS_KEY` both set — signed with that static pair.
 *   - **Chain** (AWS): both unset — no `credentials` option at all, so the SDK's
 *     default chain resolves them (on Fargate, the ECS task role; locally,
 *     `AWS_PROFILE` or the `AWS_*` variables). Presigned URLs then carry the
 *     session token and stop working when that session expires.
 *   Exactly ONE of the pair set is a mistake, not a request for the chain, and
 *   throws naming the missing one.
 *
 * `MOTIR_S3_ENDPOINT` is optional. Set, it is used with `forcePathStyle`: every
 * request on ONE host with the bucket in the PATH, which is what lets the E2E
 * transport (and a self-hosted MinIO) work without per-bucket wiring; the region
 * defaults to `auto`, Tigris being region-less. Unset, the SDK addresses the
 * regional AWS endpoint, and the region is `MOTIR_S3_REGION` or the chain's
 * (`AWS_REGION`) — never `auto`, which is no AWS region.
 */
export function s3Client(): S3Client {
  const endpoint = process.env[S3_ENV.endpoint] || undefined;
  const accessKeyId = process.env[S3_ENV.accessKeyId] || undefined;
  const secretAccessKey = process.env[S3_ENV.secretAccessKey] || undefined;
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    const missing = accessKeyId ? S3_ENV.secretAccessKey : S3_ENV.accessKeyId;
    throw new Error(
      `${missing} is not set but its pair is — set both (a static key) or neither (the AWS credential chain). See .env.example.`,
    );
  }
  const region = process.env[S3_ENV.region] || (endpoint ? 'auto' : undefined);
  const transport = e2eTransport();
  const credentialKey =
    accessKeyId && secretAccessKey ? `${accessKeyId}|${secretAccessKey}` : 'chain';
  const key = `${endpoint ?? 'aws'}|${region ?? ''}|${credentialKey}|${transport ? 'e2e' : 'net'}`;

  if (cached && cached.key === key) return cached.client;
  const client = new S3Client({
    ...(region ? { region } : {}),
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    ...(transport ? { requestHandler: transport as S3ClientConfig['requestHandler'] } : {}),
  });
  cached = { client, key };
  return client;
}

/** Test seam: drop the memoized client AND any installed transport, so the next
 *  call re-reads the env and goes back to the real one. */
export function resetS3ClientForTests(): void {
  cached = null;
  delete (globalThis as TransportHolder)[TRANSPORT_KEY];
}

/** The PRIVATE bucket — content attachments, acceptance video + trace. */
export function privateBucket(): string {
  return required(S3_ENV.privateBucket);
}

/** The PUBLIC bucket — avatars and other public assets. */
export function publicBucket(): string {
  return required(S3_ENV.publicBucket);
}

/**
 * The public bucket's directly-fetchable origin, with any trailing slash
 * trimmed — the prefix every public asset URL is built from, and the prefix
 * `isOwnAvatarBlobUrl` recognises one by.
 */
export function publicBaseUrl(): string {
  return required(S3_ENV.publicBaseUrl).replace(/\/+$/, '');
}

// A public asset's URL → its object KEY (the avatar GC needs a key, but
// `User.image` stores a full URL) lives in `lib/blob/referencedUrls.ts` as
// `publicAssetKeyFromUrl` — beside the avatar GATE that must agree with it,
// and dependency-free so it stays bundle-safe.
