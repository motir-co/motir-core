import { createHmac } from 'node:crypto';

// The ORIGIN SECRET of a hosted app (MOTIR-9947), to the decision of record
// MOTIR-5769 §4 (page cmvrcywwc00jkhpr1zvvnike8, v1): every release is reached
// only through an upstream that refuses a request without it. On Fly the guard
// container in the release's Machine checks it as `X-Motir-Origin-Secret`.
//
// DERIVED, never stored: one key (`MOTIR_HOSTING_ORIGIN_SECRET_KEY`) and the
// app's name give the secret, so the adapter that deploys the guard and every
// forwarder that calls through it (the preview gate, the public-production
// router) compute the same value from this ONE function. Rotating the key
// re-derives every app's secret at its next deploy.

/** The header a forwarder sends and the guard checks. */
export const ORIGIN_SECRET_HEADER = 'X-Motir-Origin-Secret';

/** Hex HMAC-SHA256 of `"origin:" + appRef` under `key`. */
export function deriveOriginSecret(key: string, appRef: string): string {
  return createHmac('sha256', key).update(`origin:${appRef}`).digest('hex');
}
