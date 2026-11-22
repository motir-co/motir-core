// The TENANT-APP KEY DTOs (Story MOTIR-8339), what `tenantAppKeyService` returns.
//
// ⚠️ `key` is the secret itself, returned ONCE by the gateway. A caller hands it
// to the hosted app's server side and never logs, stores in plain text, or sends
// it to a browser.

/** A minted gateway key bound to one motir-core project and its paying org. */
export interface TenantAppKeyDto {
  /** The `sk-…` key. */
  key: string;
  /** The gateway's id for the key — what a per-key revoke (rotation) names. */
  keyId: number;
  projectId: string;
  payingOrganizationId: string;
  expiresAt: Date;
  /** Always `app`: the gateway forces it. */
  lane: string;
}

/** The outcome of a revoke. `0` is a normal answer: nothing live was left. */
export interface TenantAppKeyRevokeDto {
  revoked: number;
}
