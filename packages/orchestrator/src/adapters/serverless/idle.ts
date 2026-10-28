import { OrchestratorApiError } from '../../errors';
import type { ReleaseIdlePolicy } from '../../hosting/types';
import type { ServerlessAwsApi } from './client';
import { SERVERLESS_LIVE_ALIAS } from './names';

// THE IDLE POLICY ON THE SERVERLESS TARGET (MOTIR-9974). `suspend` is Lambda's
// own behaviour and needs nothing. `always_on` is PROVISIONED CONCURRENCY of 1
// on the `live` alias — never `$LATEST`, and never more than 1: a larger warm
// count is a billing decision (MOTIR-9799), not a size this adapter infers.
//
// ⚠️ IT IS THE LAST STEP OF A DEPLOY, after `live` has moved. A failure before
// the move leaves the old release live with its warm state untouched; a warm-up
// failure AFTER the move throws `OrchestratorApiError` and the new release
// STAYS live — undoing the move would hide the cause — and the next deploy or
// a retry re-applies it. Because the setting is on the alias, a rollback (which
// only moves the alias) keeps the warm instance with no step of its own. The
// provider holds the setting; `deploy` re-asserts it every time.

/** The warm instances `always_on` keeps. */
export const SERVERLESS_WARM_INSTANCES = 1;
/** Provisioned concurrency takes minutes to become ready. */
const READY_ATTEMPTS = 150;
const READY_WAIT_MS = 2_000;

export async function applyIdlePolicy(
  api: ServerlessAwsApi,
  functionName: string,
  idle: ReleaseIdlePolicy,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (idle.mode === 'suspend') {
    if (await api.getProvisionedConcurrency(functionName, SERVERLESS_LIVE_ALIAS)) {
      await api.deleteProvisionedConcurrency(functionName, SERVERLESS_LIVE_ALIAS);
    }
    return;
  }
  await api.putProvisionedConcurrency(
    functionName,
    SERVERLESS_LIVE_ALIAS,
    SERVERLESS_WARM_INSTANCES,
  );
  for (let attempt = 1; ; attempt += 1) {
    const status = (await api.getProvisionedConcurrency(functionName, SERVERLESS_LIVE_ALIAS))
      ?.status;
    if (status === 'READY') return;
    if (status === 'FAILED') {
      throw new OrchestratorApiError('aws', null, 'lambda: provisioned concurrency failed');
    }
    if (attempt >= READY_ATTEMPTS) {
      throw new OrchestratorApiError('aws', null, 'lambda: provisioned concurrency not ready');
    }
    await sleep(READY_WAIT_MS);
  }
}
