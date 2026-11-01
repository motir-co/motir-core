import { PRODUCTION_REGISTRY_HOST } from '@/lib/hosting/productionEnablementNames';

// The one place a production image reference is built (Story MOTIR-9797 ·
// MOTIR-10031). Production enablement writes `productionImageRepository` into
// the repository's `MOTIR_HOSTING_IMAGE_PRODUCTION` variable, the starter's
// production-image workflow pushes `<that>:<commit sha>`, and a merge release
// asks for exactly `productionArtifactRef` — so the three cannot drift.

/** The production image repository of a production app, `registry.fly.io/<app>`. */
export function productionImageRepository(appName: string): string {
  return `${PRODUCTION_REGISTRY_HOST}/${appName}`;
}

/** The image the production-image workflow pushed for one commit. */
export function productionArtifactRef(appName: string, commitSha: string): string {
  return `${productionImageRepository(appName)}:${commitSha}`;
}
