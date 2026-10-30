import { timingSafeEqual } from 'node:crypto';

// THE EDGE'S BEARER ON THE HOST CONTRACT — ADR MOTIR-9521 §3.
//
// `GET /api/public/hosts/{host}` answers anyone, but the `upstream` of an
// `application` outcome goes only to `motir-edge`, which presents
// `Authorization: Bearer <MOTIR_EDGE_CONTRACT_TOKEN>`. Unset, nobody is the
// edge: every caller gets the anonymous answer.

export const EDGE_CONTRACT_TOKEN_ENV = 'MOTIR_EDGE_CONTRACT_TOKEN';

/** Whether an `Authorization` header carries the edge's token. Constant-time. */
export function isEdgeContractCaller(authorization: string | null): boolean {
  const expected = process.env[EDGE_CONTRACT_TOKEN_ENV]?.trim();
  if (!expected || !authorization) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return false;
  const given = Buffer.from(match[1]!.trim());
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}
