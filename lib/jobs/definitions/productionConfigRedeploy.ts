import {
  CONFIG_REDEPLOY_DEBOUNCE,
  CONFIG_REDEPLOY_MAX_ATTEMPTS,
  CONFIG_REDEPLOY_SETTLE_MS,
  type RunProductionRedeployOutcome,
} from '@/lib/services/productionConfigRedeployService';
import { defineJob } from '../defineJob';
import type { EnvironmentConfigChangedData } from '../types';

// A PRODUCTION CONFIG CHANGE REDEPLOYS THE CURRENT RELEASE (Story MOTIR-9797 ·
// MOTIR-10032) — the first consumer of `environment.config.changed`, under its
// own id so the preview and release listeners can join the same event later.
// The decision is all in `productionConfigRedeployService`; this file is the
// trigger, the coalescing and the wait.
//
// ⚠️ THE COALESCING IS THE ENGINE'S DEBOUNCE, keyed on the repository AND the
// environment: a burst of saves to one repository's production configuration
// becomes ONE run with the latest event once 30 s pass quietly (never more than
// 5 minutes after the first save). The environment is in the key so a preview
// save cannot become the "latest event" of a production burst and swallow it.
//
// ⚠️ WHY IT WAITS. While another release of the application is building or
// releasing the service answers `deferred_in_progress`; the job sleeps durably
// for the settle delay and asks again, up to `CONFIG_REDEPLOY_MAX_ATTEMPTS`
// tries, and the last answers `gave_up_in_progress` so the loop always ends.
// Every try is its own memoized step, so a redeploy that ran is never repeated
// on resume. `retryPolicy: 'none'`: a failed redeploy is a failed release the
// service recorded, and is not made right by starting it again.

export const productionConfigRedeploy = defineJob(
  {
    id: 'hosting/production-config-redeploy',
    trigger: 'environment.config.changed',
    retryPolicy: 'none',
    debounce: {
      key: "event.data.projectRepositoryId + '/' + event.data.environment",
      ...CONFIG_REDEPLOY_DEBOUNCE,
    },
  },
  async (ctx, services) => {
    const data = ctx.event.data as EnvironmentConfigChangedData;
    if (!services.productionConfigRedeploy.isProductionChange(data)) {
      return { outcome: 'ignored_environment' as const };
    }
    let result: RunProductionRedeployOutcome = { outcome: 'deferred_in_progress' };
    for (let attempt = 0; attempt < CONFIG_REDEPLOY_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await ctx.step.sleep(`in-progress-wait-${attempt}`, CONFIG_REDEPLOY_SETTLE_MS);
      }
      result = await ctx.step.run(`config-redeploy-${attempt}`, () =>
        services.productionConfigRedeploy.runProductionRedeploy({
          projectRepositoryId: data.projectRepositoryId,
          attempt,
        }),
      );
      if (result.outcome !== 'deferred_in_progress') break;
    }
    return result;
  },
);
