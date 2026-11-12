import { hostname } from 'node:os';
import { hostInstanceId } from '@/lib/deployment/identity';

// WHICH RELAY PROCESS HOLDS A CONNECTION ROW (MOTIR-6959). On Fargate it is the
// task id (MOTIR-10962), which a container restarted inside the same task keeps —
// so a relay that comes back after a crash closes its own leftovers on boot. Off
// Fargate (local, tests, a self-host) it is hostname + pid: unique per process, so
// two relays on one host never touch each other's rows. A restarted process then
// has a new id and its predecessor's rows are left to the sweep.
//
// The host's own variables are read by `hostInstanceId` in
// `lib/deployment/identity.ts` — the one file outside the adapters allowed to name
// them (`tests/ciFleet/orchestratorPortBoundary.test.ts`) — not here.

/** The host's instance id (`hostInstanceId`, the task id on Fargate), or `<hostname>-<pid>` when none. Read at call time. */
export function relayMachineId(
  env: Readonly<Record<string, string | undefined>> = process.env,
  host: () => string = hostname,
  pid: number = process.pid,
): string {
  return hostInstanceId(env) ?? `${host()}-${pid}`;
}
