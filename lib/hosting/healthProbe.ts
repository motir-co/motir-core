import type { FakeHostingControls, HostingDeployTarget } from '@motir/orchestrator';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { selectedOrchestratorProvider } from '@/lib/orchestrator/provider';
import type { ProbeResult } from './healthState';

// THE HEALTH-CHECK PROBE (Story MOTIR-9799 · MOTIR-12106): one GET of the
// manifest's health-check path on an application's production address, as the
// per-minute prober makes it. 2xx and 3xx are a pass — redirects are NOT
// followed, so a 3xx is the app's own answer, not wherever it points — any
// other status a failure, ten seconds without an answer a timeout, and no
// connection at all (DNS, refused, TLS) `unreachable`, which the rule keeps
// apart from the app's own state.
//
// ⚠️ THE LANE SEAM. With `MOTIR_FLEET_ORCHESTRATOR=fake` the probe reads the
// fake hosting store by app ref instead of making the request: an acceptance
// lane's production addresses do not resolve. A fake health of `unhealthy`
// answers a 503, anything else a 200. Production never sets that variable, and
// nothing about the address or the response body is kept either way.

/** How long the probe waits for an answer. */
export const HEALTH_PROBE_TIMEOUT_MS = 10_000;

export interface HealthProbeTarget {
  /** The production host, without scheme. */
  readonly productionAddress: string;
  /** The manifest's `healthCheck.path`, starting with `/`. */
  readonly path: string;
  /** For the lane seam: the release's target and app. */
  readonly target: HostingDeployTarget;
  readonly appRef: string;
}

export interface HealthProbeDeps {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function fakeProbe(target: HostingDeployTarget, appRef: string): ProbeResult {
  const port = getHostingDeployPort(target) as ReturnType<typeof getHostingDeployPort> &
    FakeHostingControls;
  return port.app(appRef)?.health === 'unhealthy'
    ? { kind: 'failed', status: 503 }
    : { kind: 'ok', status: 200 };
}

const isTimeout = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

/** One GET of the health-check path; never throws. */
export async function probeHealthCheck(
  probe: HealthProbeTarget,
  deps: HealthProbeDeps = {},
): Promise<ProbeResult> {
  if (selectedOrchestratorProvider() === 'fake') return fakeProbe(probe.target, probe.appRef);
  const url = new URL(probe.path, `https://${probe.productionAddress}`);
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(url, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(deps.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS),
    });
    // The body is never read; release the connection.
    await res.body?.cancel().catch(() => undefined);
    return res.status >= 200 && res.status < 400
      ? { kind: 'ok', status: res.status }
      : { kind: 'failed', status: res.status };
  } catch (error) {
    return isTimeout(error) ? { kind: 'timeout' } : { kind: 'unreachable' };
  }
}
