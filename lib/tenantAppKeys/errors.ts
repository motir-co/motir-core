// Typed errors for TENANT-APP KEYS (Story MOTIR-8339).
//
// Kept in their own file, like every other domain's, so a later caller (a route,
// a publish step) can map them without importing the service. A mint and a revoke
// fail with different classes because a caller answers them differently: a key
// that was never minted leaves nothing behind, a key that was not revoked does.

/** Why an app key could not be minted or revoked. */
export type TenantAppKeyFailureReason =
  /** The request was refused before anything was sent (an empty id, a past expiry). */
  | 'invalid_request'
  /** This deployment lacks `MOTIR_GATEWAY_URL` or `MOTIR_APP_KEY_MINT_SECRET`. */
  | 'not_configured'
  /** The gateway answered and refused — `gatewayCode` is its own code. */
  | 'refused'
  /** The gateway could not be reached, timed out, failed, or answered off-contract. */
  | 'unavailable';

abstract class TenantAppKeyError extends Error {
  constructor(
    readonly reason: TenantAppKeyFailureReason,
    message: string,
    /** The gateway's own refusal code, when it answered one. */
    readonly gatewayCode: string | null = null,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A tenant-app key was NOT minted. Nothing exists to revoke. */
export class TenantAppKeyNotMintedError extends TenantAppKeyError {}

/** A tenant-app key (or a project's keys) was NOT revoked; it may still be live
 *  until its own expiry. */
export class TenantAppKeyNotRevokedError extends TenantAppKeyError {}
