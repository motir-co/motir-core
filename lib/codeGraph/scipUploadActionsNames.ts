// THE THREE ACTIONS NAMES A REPOSITORY'S SCIP UPLOAD READS (Story MOTIR-12262 ·
// MOTIR-12339). On a Motir-hosted repository, minting an upload credential writes
// the token as the repository Actions SECRET and the two values a CI job needs beside
// it as repository VARIABLES; the CI recipe's reusable workflow (MOTIR-12341) reads
// them by exactly these names. Revoking the installed credential, and the takeover
// saga before the transfer, delete all three.

/** The repository Actions secret holding the upload token. */
export const SCIP_UPLOAD_TOKEN_SECRET = 'MOTIR_SCIP_UPLOAD_TOKEN';

/** The repository variable holding the code graph's repository id. */
export const CODEGRAPH_REPOSITORY_ID_VARIABLE = 'MOTIR_CODEGRAPH_REPOSITORY_ID';

/** The repository variable holding the code graph's public upload host. */
export const CODEGRAPH_UPLOAD_URL_VARIABLE = 'MOTIR_CODEGRAPH_UPLOAD_URL';

/** Both variables, in the order a mint writes them (and a removal deletes them). */
export const SCIP_UPLOAD_VARIABLES = [
  CODEGRAPH_REPOSITORY_ID_VARIABLE,
  CODEGRAPH_UPLOAD_URL_VARIABLE,
] as const;
