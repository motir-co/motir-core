/**
 * `fleet-admin`'s POOL commands (Story MOTIR-9362 · MOTIR-9463), beside
 * add-shard and the account controls:
 *
 *   request-quota --name <account> [--name <account> …] --vcpu <n>
 *     [--code L-1216C47A] --operator <email>
 *   pool-status [--kind <fleet kind>]
 *   growth-events --kind <fleet kind> [--limit <n>]
 *
 * A printer over the services: `request-quota` files through
 * `fleetQuotaRaiseService.fileRaises`, the other two read
 * `fleetPoolStatusService`. Every line printed passes through `scrubSecrets`
 * last — the services print no secret, and AWS's own reason text is scrubbed
 * all the same.
 */
import { parseArgs } from 'node:util';
import { FleetShardProvisioningRefusedError } from '@/lib/ciFleet/errors';
import type {
  FleetGrowthEventViewDTO,
  FleetPoolKindStatusDTO,
  FleetQuotaRaiseOutcomeDTO,
} from '@/lib/dto/fleetPools';
import { scrubSecrets } from '@/lib/fleetShards/scrubSecrets';
import {
  fleetPoolStatusService,
  type FleetPoolStatusDeps,
} from '@/lib/services/fleetPoolStatusService';
import {
  fleetQuotaRaiseService,
  type FleetQuotaRaiseDeps,
} from '@/lib/services/fleetQuotaRaiseService';

/** Where the command writes, as `fleetAdmin.ts`'s `FleetAdminIo`. */
export interface PoolCommandIo {
  out(line: string): void;
  err(line: string): void;
}

/** The services' seams, for a test: the AWS behind `request-quota`, the clock,
 *  switch and usage behind `pool-status`. Production passes none. */
export interface FleetAdminPoolDeps {
  raise?: FleetQuotaRaiseDeps;
  status?: FleetPoolStatusDeps;
}

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const DEFAULT_EVENT_LIMIT = 20;

/** An io that scrubs every line before it leaves. */
function scrubbed(io: PoolCommandIo): PoolCommandIo {
  return { out: (line) => io.out(scrubSecrets(line)), err: (line) => io.err(scrubSecrets(line)) };
}

function positiveInteger(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value <= 0) {
    throw new FleetShardProvisioningRefusedError([`${flag} must be a positive whole number`]);
  }
  return value;
}

const dash = (value: string | number | null | undefined) =>
  value === null || value === undefined ? '-' : String(value);

// ── Formatting (pure) ────────────────────────────────────────────────────────

export function formatRaiseOutcome(o: FleetQuotaRaiseOutcomeDTO): string {
  if (!o.ok) return `${o.name}  failed: ${o.failure}`;
  const r = o.request;
  return (
    `${o.name}  desired ${r.desiredValue}  request ${r.awsRequestId}  ${r.status}` +
    `${o.reused ? '  (already open)' : ''}`
  );
}

export function formatPoolStatus(kind: FleetPoolKindStatusDTO): string[] {
  if (!kind.onPool) return [`${kind.fleetKind}: fly (no growth)`];
  const lines = [`${kind.fleetKind}: aws  growth ${kind.growthInFlight ? 'in flight' : 'idle'}`];
  lines.push('  shared accounts (granted vCPU as stored):');
  if (kind.accounts.length === 0) lines.push('    none');
  for (const a of kind.accounts) {
    lines.push(
      `    ${a.name}  ${a.state}  granted ${dash(a.grantedVcpu)} (read ${dash(a.grantedReadAt)})` +
        `  in use ${dash(a.usedVcpu)}  ${a.percent === null ? '-' : `${a.percent}%`}` +
        `  to 70% ${dash(a.toThreshold)}`,
    );
  }
  lines.push('  spare:');
  if (kind.spares.length === 0) lines.push('    none');
  for (const s of kind.spares) {
    lines.push(`    ${s.name}  spare  ${s.state}  quota ${dash(s.vcpuQuota)}`);
  }
  lines.push('  quota requests:');
  if (kind.requests.length === 0) lines.push('    none');
  for (const r of kind.requests) {
    lines.push(
      `    ${r.account}  ${r.quotaCode}  desired ${r.desiredValue}  request ${r.awsRequestId}` +
        `  ${r.status}  granted ${dash(r.grantedValue)}  last read ${dash(r.lastReadAt)}`,
    );
  }
  return lines;
}

export function formatGrowthEvent(e: FleetGrowthEventViewDTO): string {
  const touched = [
    e.spareAccount ? `spare ${e.spareAccount}` : null,
    e.newAccount ? `new ${e.newAccount}` : null,
  ].filter(Boolean);
  return (
    `${e.createdAt}  ${dash(e.triggeringAccount)}  ${e.vcpuInUse}/${e.grantedQuota} vCPU` +
    `  ${e.outcome}  ${touched.length > 0 ? touched.join(', ') : '-'}` +
    `${e.reason ? `  ${e.reason}` : ''}`
  );
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function requestQuota(
  args: string[],
  rawIo: PoolCommandIo,
  deps: FleetAdminPoolDeps = {},
): Promise<number> {
  const io = scrubbed(rawIo);
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string', multiple: true },
      vcpu: { type: 'string' },
      code: { type: 'string' },
      operator: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const outcomes = await fleetQuotaRaiseService.fileRaises(
    {
      names: values.name ?? [],
      desiredVcpu: positiveInteger(values.vcpu, '--vcpu'),
      ...(values.code ? { quotaCode: values.code } : {}),
      operatorEmail: values.operator ?? '',
    },
    deps.raise,
  );
  for (const outcome of outcomes) io.out(formatRaiseOutcome(outcome));
  return outcomes.every((o) => o.ok) ? EXIT_OK : EXIT_ERROR;
}

export async function poolStatus(
  args: string[],
  rawIo: PoolCommandIo,
  deps: FleetAdminPoolDeps = {},
): Promise<number> {
  const io = scrubbed(rawIo);
  const { values } = parseArgs({
    args,
    options: { kind: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  const kinds = await fleetPoolStatusService.getPoolStatus(values.kind, deps.status);
  for (const kind of kinds) for (const line of formatPoolStatus(kind)) io.out(line);
  return EXIT_OK;
}

export async function growthEvents(args: string[], rawIo: PoolCommandIo): Promise<number> {
  const io = scrubbed(rawIo);
  const { values } = parseArgs({
    args,
    options: { kind: { type: 'string' }, limit: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.kind) throw new FleetShardProvisioningRefusedError(['--kind is required']);
  const limit = values.limit ? positiveInteger(values.limit, '--limit') : DEFAULT_EVENT_LIMIT;
  const events = await fleetPoolStatusService.listGrowthEvents(values.kind, limit);
  if (events.length === 0) io.out(`${values.kind}: no growth events`);
  for (const event of events) io.out(formatGrowthEvent(event));
  return EXIT_OK;
}
