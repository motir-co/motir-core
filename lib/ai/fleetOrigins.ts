import 'server-only';

import { isPrivateNetworkHost } from './containerAiAddress';

// THE THREE FLEET ORIGINS, PREFLIGHTED (Story MOTIR-9714 · MOTIR-10750).
//
// A fleet machine is handed three Motir addresses: core's public origin
// (`MOTIR_BASE_URL`), motir-ai's container-facing origin
// (`MOTIR_AI_CONTAINER_URL`) and the gateway's run-lane origin
// (`MOTIR_GATEWAY_RUN_URL`). Each has been wrong before — unset for days
// (MOTIR-4916), a private name the fleet could not resolve (MOTIR-4518) — and
// each time the machines booted normally and failed late with every check green.
// The services stack in motir-infra publishes all three as outputs; this
// preflight checks core's values against what a fleet machine can use.
//
// Per origin, the same discipline `containerAiAddress.ts` applies to motir-ai's:
//   · UNSET (or blank)       → `unconfigured`, loud. For MOTIR_BASE_URL the
//     variable itself is read: `resolveBaseUrl()` falls back to localhost, so
//     an unset value reads as a good one everywhere else.
//   · MALFORMED, or a host that is private or Fly-owned → `private_address`, a
//     DEFINITE verdict decided from the value's shape, needing no probe.
//   · PUBLIC and answering    → `reachable`.
//   · PUBLIC, no good answer  → `indeterminate`: a statement about core's own
//     probe, never about the address, and never loud on its own.

/** One origin a fleet machine is handed: its key, core's variable and the stack output it equals. */
export interface FleetOriginSpec {
  readonly origin: 'core' | 'aiContainer' | 'gatewayRun';
  readonly variable: 'MOTIR_BASE_URL' | 'MOTIR_AI_CONTAINER_URL' | 'MOTIR_GATEWAY_RUN_URL';
  /** The motir-infra services stack output the variable must equal (MOTIR-10748). */
  readonly output: 'CoreOrigin' | 'AiContainerOrigin' | 'GatewayRunOrigin';
  /** What the probe asks for: each origin's own unauthenticated health route. */
  readonly healthPath: string;
}

/**
 * The three origins, the variable core reads each from and the stack output it
 * must equal. Health paths are the ones each service's load balancer already
 * checks: core's readiness route, motir-ai's `/health`, and the run-lane edge's
 * own nginx `/healthz`, which answers without reaching the gateway.
 */
export const FLEET_ORIGINS: readonly FleetOriginSpec[] = [
  {
    origin: 'core',
    variable: 'MOTIR_BASE_URL',
    output: 'CoreOrigin',
    healthPath: '/api/health/ready',
  },
  {
    origin: 'aiContainer',
    variable: 'MOTIR_AI_CONTAINER_URL',
    output: 'AiContainerOrigin',
    healthPath: '/health',
  },
  {
    origin: 'gatewayRun',
    variable: 'MOTIR_GATEWAY_RUN_URL',
    output: 'GatewayRunOrigin',
    healthPath: '/healthz',
  },
];

type OriginBase = Pick<FleetOriginSpec, 'origin' | 'variable' | 'output'>;

/** What the preflight concluded about one origin. */
export type FleetOriginReading = OriginBase &
  /** This deployment runs no fleet kind that is handed this origin. */
  (| { verdict: 'not_applicable'; detail: string }
    | { verdict: 'unconfigured'; detail: string }
    | { verdict: 'private_address'; address: string; detail: string }
    | { verdict: 'reachable'; address: string; path: string; status: number }
    | { verdict: 'indeterminate'; address: string; path: string; detail: string }
  );

/** The readings that are DEFINITE failures — the ones the daily health check raises. */
export type FleetOriginFailure = Extract<
  FleetOriginReading,
  { verdict: 'unconfigured' | 'private_address' }
>;

/** What the preflight concluded about all three origins. */
export type FleetOriginsVerdict =
  /** Nothing to check — this deployment boots no real fleet machine. */
  | { verdict: 'not_applicable'; detail: string }
  /** At least one origin is a DEFINITE failure. LOUD. */
  | { verdict: 'failed'; readings: FleetOriginReading[]; failures: FleetOriginFailure[] }
  /** No definite failure, and at least one probe could not get an answer. */
  | { verdict: 'indeterminate'; readings: FleetOriginReading[]; detail: string }
  /** Every origin is public and answered. */
  | { verdict: 'ok'; readings: FleetOriginReading[] };

/** Short: this runs inside a daily health check, not a request. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * The STRUCTURAL half, with no network access: the reading decided from the
 * value's shape alone, or the normalised origin to probe when it is public.
 */
export function classifyFleetOrigin(
  spec: FleetOriginSpec,
  raw: string | undefined,
): FleetOriginFailure | { address: string } {
  const base: OriginBase = { origin: spec.origin, variable: spec.variable, output: spec.output };
  const value = raw?.trim();
  if (!value) {
    return {
      ...base,
      verdict: 'unconfigured',
      detail: `${spec.variable} is not set, so no fleet machine can be handed this origin.`,
    };
  }
  const address = value.replace(/\/+$/, '');
  const refuse = (detail: string): FleetOriginFailure => ({
    ...base,
    verdict: 'private_address',
    address: value,
    detail,
  });
  let url: URL | null = null;
  try {
    url = new URL(address);
  } catch {
    // Left null — refused just below with the other unusable shapes.
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) {
    return refuse(`${spec.variable} is not an absolute http(s) URL with a host.`);
  }
  if (spec.origin === 'gatewayRun' && /\/v1$/.test(address)) {
    return refuse(
      `${spec.variable} ends in /v1; the run lane appends /v1 itself, so every model call ` +
        `would go to /v1/v1.`,
    );
  }
  if (isPrivateNetworkHost(url.hostname)) {
    return refuse(
      `${url.hostname} is a private or Fly-owned host, not an origin Motir publishes: a fleet ` +
        `machine on its pool account cannot use it, however well it resolves from motir-core.`,
    );
  }
  return { address };
}

async function probe(
  spec: FleetOriginSpec,
  address: string,
  fetchImpl: typeof fetch,
): Promise<FleetOriginReading> {
  const base: OriginBase = { origin: spec.origin, variable: spec.variable, output: spec.output };
  const path = spec.healthPath;
  try {
    const res = await fetchImpl(`${address}${path}`, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        ...base,
        verdict: 'indeterminate',
        address,
        path,
        detail: `${address}${path} answered ${res.status}.`,
      };
    }
    return { ...base, verdict: 'reachable', address, path, status: res.status };
  } catch (err) {
    // A transport failure is a statement about this probe's network, not the address.
    return {
      ...base,
      verdict: 'indeterminate',
      address,
      path,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** One origin's reading: its shape first, then — only for a public value — the probe. */
async function readOrigin(
  spec: FleetOriginSpec,
  applies: boolean,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
): Promise<FleetOriginReading> {
  if (!applies) {
    return {
      origin: spec.origin,
      variable: spec.variable,
      output: spec.output,
      verdict: 'not_applicable',
      detail: `this deployment runs no fleet kind that is handed ${spec.variable}`,
    };
  }
  const structural = classifyFleetOrigin(spec, env[spec.variable]);
  if ('verdict' in structural) return structural;
  return probe(spec, structural.address, fetchImpl);
}

/**
 * CAN EVERY ADDRESS THIS DEPLOYMENT HANDS A FLEET MACHINE ACTUALLY WORK?
 *
 * NEVER THROWS — the caller is a health check. `env` and `fetchImpl` are
 * injected so the test drives every arm with no environment and no network.
 *
 * `applies` says which origins this deployment hands a machine at all: core's
 * origin is owed wherever real machines boot, motir-ai's only where it indexes
 * and the gateway's only where it runs hosted agents. An origin left out of it
 * applies. One that does not is read `not_applicable` and never fails.
 */
export async function verifyFleetOrigins(args: {
  isConfigured: boolean;
  applies?: Partial<Record<FleetOriginSpec['origin'], boolean>>;
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
}): Promise<FleetOriginsVerdict> {
  if (!args.isConfigured) {
    return {
      verdict: 'not_applicable',
      detail: 'this deployment boots no real fleet machine',
    };
  }
  const env = args.env ?? process.env;
  const fetchImpl = args.fetchImpl ?? fetch;
  const readings = await Promise.all(
    FLEET_ORIGINS.map((spec) =>
      readOrigin(spec, args.applies?.[spec.origin] ?? true, env, fetchImpl),
    ),
  );
  const failures = readings.filter(
    (r): r is FleetOriginFailure => r.verdict === 'unconfigured' || r.verdict === 'private_address',
  );
  if (failures.length > 0) return { verdict: 'failed', readings, failures };
  const unanswered = readings.filter(
    (r): r is Extract<FleetOriginReading, { verdict: 'indeterminate' }> =>
      r.verdict === 'indeterminate',
  );
  if (unanswered.length > 0) {
    return {
      verdict: 'indeterminate',
      readings,
      detail: unanswered.map((r) => `${r.variable} ${r.address}${r.path}: ${r.detail}`).join('; '),
    };
  }
  return { verdict: 'ok', readings };
}
