// The Repositories room's SCIP upload credentials (Story MOTIR-12262 · MOTIR-12339).
// The fields are motir-ai's (MOTIR-12337); `installedInActions` and `installFailed`
// are motir-core's, about the repository's own Actions on a Motir-hosted row.

/** One credential of a repository, as the room lists it. Never its token. */
export interface ScipUploadCredentialDto {
  credentialId: string;
  name: string;
  /** The token's first characters, safe to show. */
  displayPrefix: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601, or null while the credential is live. */
  revokedAt: string | null;
  /** True on the ONE credential Motir installed in a hosted repository's Actions;
   *  false on every credential of an imported repository. */
  installedInActions: boolean;
}

/** A credential just minted — the only answer that carries its token, ONCE. */
export interface MintedScipUploadCredentialDto extends ScipUploadCredentialDto {
  token: string;
  /** The code graph's repository id, the CI job's second value. */
  repositoryId: string;
  /** The code graph's public upload host, the CI job's third value. */
  uploadUrl: string;
  /** True when, on a hosted repository, a GitHub write failed after the code graph
   *  issued the credential: the credential exists and the person still has the
   *  token. Always false on an imported repository. */
  installFailed: boolean;
}

/** A revoke's answer. `revoked: false` is a repeat. */
export interface RevokedScipUploadCredentialDto {
  credentialId: string;
  revoked: boolean;
}
