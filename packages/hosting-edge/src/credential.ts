// The credential the edge presents to an upstream (MOTIR-10127), total over
// `OriginCredentialKind` (`packages/orchestrator/src/hosting/types.ts`):
//
//   - `origin_secret` — `X-Motir-Origin-Secret`, derived per app;
//   - `none`          — no credential header at all;
//   - `aws_sigv4`     — UNSUPPORTED: signing needs a tenant-account credential
//     the edge does not hold, so the caller answers the Unavailable page rather
//     than an unsigned forward the origin would refuse anyway.
//
// ⚠️ A COPY, AND A TEST HOLDS IT TO THE ORIGINAL. `deriveOriginSecret` lives in
// `packages/orchestrator/src/hosting/originSecret.ts`, which the deploying
// adapter uses to set the guard's secret. The image copies only `package.json`
// and `src`, so it cannot import that package; `tests/hosting/edgeForwarder.test.ts`
// asserts this copy equals the original for the same key and appRef. If the two
// ever disagree, every forward to a Fly-hosted app is refused 403 by its guard.

import { createHmac } from 'node:crypto';

export type CredentialKind = 'origin_secret' | 'aws_sigv4' | 'none';

/** The header a forwarder sends and the guard checks. */
export const ORIGIN_SECRET_HEADER = 'X-Motir-Origin-Secret';

/** Hex HMAC-SHA256 of `"origin:" + appRef` under `key` — `deriveOriginSecret`. */
export function deriveOriginSecret(key: string, appRef: string): string {
  return createHmac('sha256', key).update(`origin:${appRef}`).digest('hex');
}

/** The kinds this edge can present; anything else is not forwarded. */
export function canPresent(kind: CredentialKind): kind is 'origin_secret' | 'none' {
  switch (kind) {
    case 'origin_secret':
    case 'none':
      return true;
    case 'aws_sigv4':
      return false;
  }
}

/** The header pairs that carry the credential to the upstream. */
export function credentialHeaders(
  kind: 'origin_secret' | 'none',
  key: string,
  appRef: string,
): string[] {
  switch (kind) {
    case 'origin_secret':
      return [ORIGIN_SECRET_HEADER, deriveOriginSecret(key, appRef)];
    case 'none':
      return [];
  }
}
