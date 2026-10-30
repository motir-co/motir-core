// The names production enablement writes into a Motir repository, and the org
// gate it reads (Story MOTIR-9797 · MOTIR-10027). Fixed by the confirmed hosting
// ADR, MOTIR-5769 (page cmvrcywwc00jkhpr1zvvnike8, version 1) §4 and §11; this
// module invents none of them. It is the ONE list the starter's
// production-image workflow (MOTIR-10029) and its guard tests read, so the
// workflow and the writer cannot drift apart.

/** The GitHub environment the production deploy credential lives in. Its
 *  deployment-branch rule admits {@link PRODUCTION_BRANCH} only. */
export const PRODUCTION_ENVIRONMENT = 'production';

/** The only branch whose workflow runs may read the production environment. */
export const PRODUCTION_BRANCH = 'main';

/** The environment secret: a Fly deploy token scoped to the one production app. */
export const PRODUCTION_PUSH_TOKEN_SECRET = 'MOTIR_FLY_PRODUCTION_PUSH_TOKEN';

/** The repository variable naming the production image repository,
 *  `registry.fly.io/mh-<rid>`. */
export const PRODUCTION_IMAGE_VARIABLE = 'MOTIR_HOSTING_IMAGE_PRODUCTION';

/** The repository variable naming the hosting target. Every build workflow is
 *  gated on it being set, so enablement writes it LAST. */
export const HOSTING_TARGET_VARIABLE = 'MOTIR_HOSTING_TARGET';

/** The ORG variable that switches hosting builds on (`on`). Written by the
 *  org-scope writer (`lib/github/actionsVariables.ts`), never by enablement. */
export const HOSTING_BUILD_ORG_VARIABLE = 'MOTIR_HOSTING_BUILD';

/** The starter workflow that builds and pushes the production image on a push
 *  to {@link PRODUCTION_BRANCH} (MOTIR-10029, `.github/workflows/production-image.yml`'s
 *  `name:`). Its completed run is what starts a merge release (MOTIR-10031). */
export const PRODUCTION_IMAGE_WORKFLOW = 'production-image';

/** Fly's registry host: the production image is `<registry>/<app>`. */
export const PRODUCTION_REGISTRY_HOST = 'registry.fly.io';

/** A deploy token lives 90 days (the Fly adapter's `DEPLOY_TOKEN_EXPIRY`), and is
 *  re-minted once fewer than 14 remain — i.e. once it is older than 76 days. */
export const PRODUCTION_TOKEN_REMINT_AFTER_DAYS = 76;
