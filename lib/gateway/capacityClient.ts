import 'server-only';

import {
  CAPACITY_LIMIT_UNITS,
  type CapacityLimitUnit,
  type CapacityProvider,
  isCapacityProvider,
} from '@/lib/capacity/alertKeys';
import { GatewayRunKeyConfigError } from './errors';
import {
  GatewayCapacityConfigError,
  GatewayCapacityRefusedError,
  GatewayCapacityUnavailableError,
  type GatewayCapacityErrorCode,
  toGatewayCapacityErrorCode,
} from './capacityErrors';
import { gatewayBaseUrl } from './runKeyClient';

// THE MOTIR-CORE → MOTIR-GATEWAY CAPACITY CLIENT (MOTIR-9608) — a SERVER-ONLY leaf
// primitive, like `./runKeyClient.ts`. It reads every provider model's limits and
// live lane usage, and edits one model's limits, planning share and tier note,
// over HTTP and nothing else: motir-core never imports the gateway.
//
// The contract is the gateway's (`docs/motir-capacity-api.md` there):
//
//   GET /api/motir/capacity                      → 200 {success, read_at, counter_store, entries}
//   PUT /api/motir/capacity/limits/:provider/:model {any subset of the editable keys}
//                                                → 200 {success, data: <row + updated_at>}
//
// both authorised by `Authorization: Bearer <an admin gateway user's access token>`,
// refusing with `{ success: false, error: { code, field? } }`.
//
// THREE DISTINCTIONS THIS MODULE HOLDS, because mixing up any one shows a wrong
// number as live:
//   - a missing number is not 0 — a non-`set` limit has no `value` at all, and a
//     lane that could not be read is `null`;
//   - a DEGRADED answer (the counter store down, contract §5) is still `answered`,
//     with its limits; only no answer at all is `unavailable`;
//   - a credential refusal (`auth_refused`) is kept apart from a transport failure,
//     so an operator can tell a wrong token from a gateway that is down.
//
// ⚠️ `MOTIR_GATEWAY_CAPACITY_TOKEN` IS READ HERE AND NOWHERE ELSE, AT CALL TIME. The
// `server-only` import makes bundling this module into a Client Component a build
// error. The parser copies a FIXED field list and never spreads the wire object, so
// a field the gateway adds later never reaches a screen.

export const MOTIR_GATEWAY_CAPACITY_TOKEN_ENV_VAR = 'MOTIR_GATEWAY_CAPACITY_TOKEN';

/** Three times the gateway's own 1000 ms read bound (contract §5). The read is
 *  polled from a screen, so it does not get the run-key client's 15 s. */
export const GATEWAY_CAPACITY_TIMEOUT_MS = 3_000;

// The provider and unit sets live in `lib/capacity/alertKeys.ts`, so the client
// and the alert state share one list.
export {
  CAPACITY_LIMIT_UNITS,
  CAPACITY_PROVIDERS,
  type CapacityLimitUnit,
  type CapacityProvider,
} from '@/lib/capacity/alertKeys';

/** A limit. Only a `set` limit carries a number; the other two have none to read as 0. */
export type CapacityLimit =
  | { status: 'set'; value: number }
  | { status: 'unknown' }
  | { status: 'not_applicable' };

export interface LaneUsage {
  inFlight: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
  tokensPerDay: number;
  rateLimited429: { minute: number; day: number };
}

export interface ProviderHint {
  remainingRequests: number | null;
  remainingTokens: number | null;
  remainingInputTokens: number | null;
  remainingOutputTokens: number | null;
  requestsReset: string | null;
  tokensReset: string | null;
  retryAfterSeconds: number | null;
  observedAt: string;
}

interface CapacityRowBase {
  provider: CapacityProvider;
  model: string;
  tierNote: string;
  /** Why a limit is unknown; may be empty. */
  unknownNote: string;
  planningSharePercent: number;
  limits: Record<CapacityLimitUnit, CapacityLimit>;
}

export interface CapacityEntry extends CapacityRowBase {
  /** `null` when that lane's numbers could not be read (contract §5). */
  lanes: { planning: LaneUsage | null; agent: LaneUsage | null };
  providerHint: ProviderHint | null;
}

/** A row as the edit stored it: no lanes, and when it was written. */
export interface StoredCapacityRow extends CapacityRowBase {
  updatedAt: Date;
}

export type CapacityUnavailableReason =
  | 'not_configured'
  | 'auth_refused'
  | 'config_unavailable'
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'bad_response';

export type CapacityRead =
  | {
      outcome: 'answered';
      readAt: Date;
      counterStore: { state: 'live' | 'unavailable'; scope: 'shared' | 'instance' };
      entries: CapacityEntry[];
    }
  | { outcome: 'unavailable'; reason: CapacityUnavailableReason; code?: GatewayCapacityErrorCode };

/** One model's edit. An absent key is untouched; a `null` limit means "unknown". */
export interface CapacityLimitsEdit {
  maxConcurrency?: number | null;
  rpm?: number | null;
  inputTpm?: number | null;
  outputTpm?: number | null;
  tpm?: number | null;
  tpd?: number | null;
  planningSharePercent?: number;
  tierNote?: string;
}

/** Each edit key and its wire (snake_case) name, in the contract's order. */
export const CAPACITY_EDIT_KEYS: ReadonlyArray<[keyof CapacityLimitsEdit, string]> = [
  ['maxConcurrency', 'max_concurrency'],
  ['rpm', 'rpm'],
  ['inputTpm', 'input_tpm'],
  ['outputTpm', 'output_tpm'],
  ['tpm', 'tpm'],
  ['tpd', 'tpd'],
  ['planningSharePercent', 'planning_share_percent'],
  ['tierNote', 'tier_note'],
];

// ── the wire → domain parser ────────────────────────────────────────────────

/** Thrown inside the parser only; the read turns it into `bad_response`. */
class BadCapacityResponse extends Error {}

type Wire = Record<string, unknown>;

function obj(value: unknown): Wire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadCapacityResponse('expected an object');
  }
  return value as Wire;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BadCapacityResponse('expected a non-negative integer');
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new BadCapacityResponse('expected a string');
  return value;
}

function nullableCount(value: unknown): number | null {
  return value === null || value === undefined ? null : count(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function parseLimit(value: unknown): CapacityLimit {
  const wire = obj(value);
  switch (wire['status']) {
    case 'set':
      return { status: 'set', value: count(wire['value']) };
    case 'unknown':
      return { status: 'unknown' };
    case 'not_applicable':
      return { status: 'not_applicable' };
    default:
      throw new BadCapacityResponse('unknown limit status');
  }
}

function parseLimits(value: unknown): Record<CapacityLimitUnit, CapacityLimit> {
  const wire = obj(value);
  const limits = {} as Record<CapacityLimitUnit, CapacityLimit>;
  for (const unit of CAPACITY_LIMIT_UNITS) limits[unit] = parseLimit(wire[unit]);
  return limits;
}

function parseLane(value: unknown): LaneUsage | null {
  if (value === null || value === undefined) return null;
  const wire = obj(value);
  const rateLimited = obj(wire['rate_limited_429']);
  return {
    inFlight: count(wire['in_flight']),
    requestsPerMinute: count(wire['requests_per_minute']),
    tokensPerMinute: count(wire['tokens_per_minute']),
    tokensPerDay: count(wire['tokens_per_day']),
    rateLimited429: { minute: count(rateLimited['minute']), day: count(rateLimited['day']) },
  };
}

function parseHint(value: unknown): ProviderHint | null {
  if (value === null || value === undefined) return null;
  const wire = obj(value);
  return {
    remainingRequests: nullableCount(wire['remaining_requests']),
    remainingTokens: nullableCount(wire['remaining_tokens']),
    remainingInputTokens: nullableCount(wire['remaining_input_tokens']),
    remainingOutputTokens: nullableCount(wire['remaining_output_tokens']),
    requestsReset: nullableText(wire['requests_reset']),
    tokensReset: nullableText(wire['tokens_reset']),
    retryAfterSeconds: nullableCount(wire['retry_after_seconds']),
    observedAt: text(wire['observed_at']),
  };
}

function parseRowBase(wire: Wire, provider: CapacityProvider): CapacityRowBase {
  const share = count(wire['planning_share_percent']);
  if (share > 100) throw new BadCapacityResponse('planning share above 100');
  return {
    provider,
    model: text(wire['model']),
    tierNote: text(wire['tier_note']),
    unknownNote: text(wire['unknown_note'] ?? ''),
    planningSharePercent: share,
    limits: parseLimits(wire['limits']),
  };
}

/** One read entry, or `null` for a provider this story does not cover. */
function parseEntry(value: unknown): CapacityEntry | null {
  const wire = obj(value);
  if (!isCapacityProvider(wire['provider'])) return null;
  const lanes = obj(wire['lanes']);
  return {
    ...parseRowBase(wire, wire['provider']),
    lanes: { planning: parseLane(lanes['planning']), agent: parseLane(lanes['agent']) },
    providerHint: parseHint(wire['provider_hint']),
  };
}

function parseDate(value: unknown): Date {
  const date = new Date(text(value));
  if (Number.isNaN(date.getTime())) throw new BadCapacityResponse('not a timestamp');
  return date;
}

function parseRead(body: unknown): Extract<CapacityRead, { outcome: 'answered' }> {
  const wire = obj(body);
  if (wire['success'] !== true || !Array.isArray(wire['entries'])) {
    throw new BadCapacityResponse('not a capacity read');
  }
  const store = obj(wire['counter_store']);
  const state = store['state'];
  const scope = store['scope'];
  if (
    (state !== 'live' && state !== 'unavailable') ||
    (scope !== 'shared' && scope !== 'instance')
  ) {
    throw new BadCapacityResponse('unknown counter store state');
  }
  return {
    outcome: 'answered',
    readAt: parseDate(wire['read_at']),
    counterStore: { state, scope },
    entries: wire['entries'].map(parseEntry).filter((e): e is CapacityEntry => e !== null),
  };
}

function parseStoredRow(body: unknown): StoredCapacityRow {
  const data = obj(obj(body)['data']);
  if (!isCapacityProvider(data['provider'])) throw new BadCapacityResponse('unknown provider');
  return { ...parseRowBase(data, data['provider']), updatedAt: parseDate(data['updated_at']) };
}

// ── transport ───────────────────────────────────────────────────────────────

interface CapacityTarget {
  url: string;
  token: string;
}

/** The origin and token, or `null` when either is unset (nothing is then sent). */
function capacityTarget(): CapacityTarget | null {
  const token = process.env[MOTIR_GATEWAY_CAPACITY_TOKEN_ENV_VAR]?.trim();
  if (!token) return null;
  try {
    return { url: gatewayBaseUrl(), token };
  } catch (err) {
    if (err instanceof GatewayRunKeyConfigError) return null;
    throw err;
  }
}

type FetchOutcome = { ok: true; res: Response } | { ok: false; reason: 'timeout' | 'network' };

async function capacityFetch(
  target: CapacityTarget,
  path: string,
  init: RequestInit,
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_CAPACITY_TIMEOUT_MS);
  try {
    const res = await fetch(`${target.url}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Authorization: `Bearer ${target.token}`,
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    return { ok: true, res };
  } catch {
    // The rejection's own text is never carried on: it could echo the request.
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

async function jsonBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** The gateway's `error.code` and `error.field` from a refusal body. */
async function refusalOf(
  res: Response,
): Promise<{ code: GatewayCapacityErrorCode; field: string | null }> {
  const body = (await jsonBody(res)) as { error?: { code?: unknown; field?: unknown } } | undefined;
  const field = body?.error?.field;
  return {
    code: toGatewayCapacityErrorCode(body?.error?.code),
    field: typeof field === 'string' ? field : null,
  };
}

/** GET /api/motir/capacity. NEVER throws: every failure is an `unavailable` value. */
export async function readGatewayCapacity(): Promise<CapacityRead> {
  const target = capacityTarget();
  if (!target) return { outcome: 'unavailable', reason: 'not_configured' };
  const sent = await capacityFetch(target, '/api/motir/capacity', { method: 'GET' });
  if (!sent.ok) return { outcome: 'unavailable', reason: sent.reason };
  const { res } = sent;
  if (!res.ok) {
    const { code } = await refusalOf(res);
    if (res.status === 401 || res.status === 403) {
      return { outcome: 'unavailable', reason: 'auth_refused', code };
    }
    if (res.status === 500 && code === 'capacity_config_unavailable') {
      return { outcome: 'unavailable', reason: 'config_unavailable', code };
    }
    return { outcome: 'unavailable', reason: 'server_error', code };
  }
  try {
    return parseRead(await res.json());
  } catch {
    return { outcome: 'unavailable', reason: 'bad_response' };
  }
}

/** The wire body: only the keys present, in the contract's snake_case. */
export function capacityEditBody(edit: CapacityLimitsEdit): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, wire] of CAPACITY_EDIT_KEYS) {
    if (edit[key] !== undefined) body[wire] = edit[key];
  }
  return body;
}

/** PUT /api/motir/capacity/limits/:provider/:model. Throws a typed
 *  {@link GatewayCapacityConfigError}, {@link GatewayCapacityRefusedError} or
 *  {@link GatewayCapacityUnavailableError}. */
export async function writeGatewayCapacityLimits(
  provider: string,
  model: string,
  edit: CapacityLimitsEdit,
): Promise<StoredCapacityRow> {
  const target = capacityTarget();
  if (!target) {
    throw new GatewayCapacityConfigError(
      `MOTIR_GATEWAY_URL or ${MOTIR_GATEWAY_CAPACITY_TOKEN_ENV_VAR} is not set`,
    );
  }
  const path = `/api/motir/capacity/limits/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`;
  const sent = await capacityFetch(target, path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(capacityEditBody(edit)),
  });
  if (!sent.ok) {
    throw new GatewayCapacityUnavailableError(
      sent.reason === 'timeout'
        ? `the gateway did not respond within ${GATEWAY_CAPACITY_TIMEOUT_MS}ms`
        : 'the gateway could not be reached',
    );
  }
  const { res } = sent;
  if (!res.ok) {
    const { code, field } = await refusalOf(res);
    if (res.status >= 500 && code !== 'capacity_store_error') {
      throw new GatewayCapacityUnavailableError(`the gateway answered ${res.status} ${code}`);
    }
    throw new GatewayCapacityRefusedError(res.status, code, field);
  }
  try {
    return parseStoredRow(await res.json());
  } catch {
    throw new GatewayCapacityUnavailableError('the gateway answered an unreadable row');
  }
}
