import 'server-only';

import { GatewayRunKeyConfigError } from './errors';
import { gatewayBaseUrl } from './runKeyClient';
import { MOTIR_GATEWAY_CAPACITY_TOKEN_ENV_VAR } from './capacityClient';

// THE MOTIR-CORE → MOTIR-GATEWAY MODEL SERVING CLIENT (MOTIR-11280) — a
// SERVER-ONLY leaf primitive, the twin of `./capacityClient.ts`. Some models are
// sold by more than one provider (GLM-5.3 by Z.ai, its maker, and by Alibaba).
// They are always CHARGED at the original provider's price; this client reads
// which provider's channel SERVES each one and saves a platform admin's choice.
//
// The contract is the gateway's (`docs/motir-model-serving-api.md` there):
//
//   GET /api/motir/model-serving          → 200 {success, readAt, data: Entry[]}
//   PUT /api/motir/model-serving/:model   {provider: string | null, actor?}
//                                         → 200 {success, data: Entry}
//
// authorised exactly like the capacity API (an admin gateway user's access token,
// `MOTIR_GATEWAY_CAPACITY_TOKEN`), refusing with
// `{ success: false, error: { code, field?, offerings? } }`.
//
// The parser copies a FIXED field list and never spreads the wire object, so a
// field the gateway adds later never reaches a screen. The READ never throws; the
// WRITE throws one of the three typed errors below.

/** The gateway's own read bound is a database read; 3 s, as the capacity client. */
export const GATEWAY_MODEL_SERVING_TIMEOUT_MS = 3_000;

export interface UsdPerMTok {
  prompt: number;
  /** `null` when the price row sets no output price. */
  completion: number | null;
  /** Absent on the wire when the row sets none. */
  cacheRead: number | null;
}

export interface PriceSource {
  url: string;
  /** `YYYY-MM-DD`, as the price file records it. */
  readDate: string;
}

export interface ModelServingOffering {
  provider: string;
  channelId: number;
  channelName: string;
  channelType: number;
  enabled: boolean;
  /** What this provider charges Motir; `null` when the price file has no row for it. */
  cost: UsdPerMTok | null;
  costSource: PriceSource | null;
}

export interface ModelServingEntry {
  model: string;
  /** `""` when the price file has no row for the model. */
  originProvider: string;
  charged: UsdPerMTok;
  priceSource: PriceSource;
  selected: string | null;
  selectedBy: string | null;
  selectedAt: Date | null;
  /** The provider serving the next request; `""` when every channel is off. */
  effective: string;
  offerings: ModelServingOffering[];
}

export type ModelServingUnavailableReason =
  | 'not_configured'
  | 'auth_refused'
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'bad_response';

export type ModelServingRead =
  | { outcome: 'answered'; readAt: Date; entries: ModelServingEntry[] }
  | { outcome: 'unavailable'; reason: ModelServingUnavailableReason };

// ── typed write failures ────────────────────────────────────────────────────

export abstract class GatewayModelServingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** This deployment is missing `MOTIR_GATEWAY_URL` or the token. Nothing was sent. */
export class GatewayModelServingConfigError extends GatewayModelServingError {}

/** The gateway answered and said no; nothing changed. */
export class GatewayModelServingRefusedError extends GatewayModelServingError {
  constructor(
    readonly status: number,
    /** The gateway's code, e.g. `model_serving_unknown_provider`, or `unknown`. */
    readonly code: string,
    readonly field: string | null,
    /** For an unknown provider: the providers that DO serve the model. */
    readonly offerings: string[],
  ) {
    super(`the gateway refused the model serving change: ${status} ${code}`);
  }
}

/** No answer in time, a network failure, or an unreadable answer. */
export class GatewayModelServingUnavailableError extends GatewayModelServingError {}

// ── the wire → domain parser ────────────────────────────────────────────────

class BadModelServingResponse extends Error {}

type Wire = Record<string, unknown>;

function obj(value: unknown): Wire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadModelServingResponse('expected an object');
  }
  return value as Wire;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new BadModelServingResponse('expected a string');
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function price(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BadModelServingResponse('expected a non-negative number');
  }
  return value;
}

function nullablePrice(value: unknown): number | null {
  return value === null || value === undefined ? null : price(value);
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BadModelServingResponse('expected an integer');
  }
  return value;
}

function parseDate(value: unknown): Date {
  const date = new Date(text(value));
  if (Number.isNaN(date.getTime())) throw new BadModelServingResponse('not a timestamp');
  return date;
}

function parseUsd(value: unknown): UsdPerMTok {
  const wire = obj(value);
  return {
    prompt: price(wire['prompt']),
    completion: nullablePrice(wire['completion']),
    cacheRead: nullablePrice(wire['cacheRead']),
  };
}

function parseSource(value: unknown): PriceSource {
  const wire = obj(value);
  return { url: text(wire['url']), readDate: text(wire['readDate']) };
}

function parseOffering(value: unknown): ModelServingOffering {
  const wire = obj(value);
  if (typeof wire['enabled'] !== 'boolean') throw new BadModelServingResponse('enabled');
  return {
    provider: text(wire['provider']),
    channelId: integer(wire['channelId']),
    channelName: text(wire['channelName']),
    channelType: integer(wire['channelType']),
    enabled: wire['enabled'],
    cost: wire['costUSDPerMTok'] == null ? null : parseUsd(wire['costUSDPerMTok']),
    costSource: wire['costSource'] == null ? null : parseSource(wire['costSource']),
  };
}

export function parseModelServingEntry(value: unknown): ModelServingEntry {
  const wire = obj(value);
  if (!Array.isArray(wire['offerings'])) throw new BadModelServingResponse('offerings');
  return {
    model: text(wire['model']),
    originProvider: text(wire['originProvider']),
    charged: parseUsd(wire['chargedUSDPerMTok']),
    priceSource: parseSource(wire['priceSource']),
    selected: nullableText(wire['selected']),
    selectedBy: nullableText(wire['selectedBy']),
    selectedAt: wire['selectedAt'] == null ? null : parseDate(wire['selectedAt']),
    effective: text(wire['effective']),
    offerings: wire['offerings'].map(parseOffering),
  };
}

function parseRead(body: unknown): Extract<ModelServingRead, { outcome: 'answered' }> {
  const wire = obj(body);
  if (wire['success'] !== true || !Array.isArray(wire['data'])) {
    throw new BadModelServingResponse('not a model serving read');
  }
  return {
    outcome: 'answered',
    readAt: parseDate(wire['readAt']),
    entries: wire['data'].map(parseModelServingEntry),
  };
}

// ── transport ───────────────────────────────────────────────────────────────

interface Target {
  url: string;
  token: string;
}

function target(): Target | null {
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

async function send(t: Target, path: string, init: RequestInit): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_MODEL_SERVING_TIMEOUT_MS);
  try {
    const res = await fetch(`${t.url}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${t.token}`,
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    return { ok: true, res };
  } catch {
    // The rejection's text is never carried on: it could echo the request.
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

const SERVING_PATH = '/api/motir/model-serving';

/** GET /api/motir/model-serving. NEVER throws: every failure is an `unavailable` value. */
export async function readGatewayModelServing(): Promise<ModelServingRead> {
  const t = target();
  if (!t) return { outcome: 'unavailable', reason: 'not_configured' };
  const sent = await send(t, SERVING_PATH, { method: 'GET' });
  if (!sent.ok) return { outcome: 'unavailable', reason: sent.reason };
  const { res } = sent;
  if (!res.ok) {
    return {
      outcome: 'unavailable',
      reason: res.status === 401 || res.status === 403 ? 'auth_refused' : 'server_error',
    };
  }
  try {
    return parseRead(await res.json());
  } catch {
    return { outcome: 'unavailable', reason: 'bad_response' };
  }
}

/**
 * PUT /api/motir/model-serving/:model. `provider: null` clears the choice, so
 * the original provider serves the model again. `actor` is who made the change,
 * recorded beside it on the gateway. Throws a typed {@link GatewayModelServingError}.
 */
export async function writeGatewayModelServing(
  model: string,
  provider: string | null,
  actor: string,
): Promise<ModelServingEntry> {
  const t = target();
  if (!t) {
    throw new GatewayModelServingConfigError(
      `MOTIR_GATEWAY_URL or ${MOTIR_GATEWAY_CAPACITY_TOKEN_ENV_VAR} is not set`,
    );
  }
  const sent = await send(t, `${SERVING_PATH}/${encodeURIComponent(model)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, actor: actor.slice(0, 191) }),
  });
  if (!sent.ok) {
    throw new GatewayModelServingUnavailableError(
      sent.reason === 'timeout'
        ? `the gateway did not respond within ${GATEWAY_MODEL_SERVING_TIMEOUT_MS}ms`
        : 'the gateway could not be reached',
    );
  }
  const { res } = sent;
  if (!res.ok) {
    const body = (await jsonBody(res)) as
      | { error?: { code?: unknown; field?: unknown; offerings?: unknown } }
      | undefined;
    const code = typeof body?.error?.code === 'string' ? body.error.code : 'unknown';
    if (res.status >= 500 && code !== 'model_serving_store_error') {
      throw new GatewayModelServingUnavailableError(`the gateway answered ${res.status} ${code}`);
    }
    const field = typeof body?.error?.field === 'string' ? body.error.field : null;
    const offerings = Array.isArray(body?.error?.offerings)
      ? body.error.offerings.filter((o): o is string => typeof o === 'string')
      : [];
    throw new GatewayModelServingRefusedError(res.status, code, field, offerings);
  }
  try {
    return parseModelServingEntry(obj(await res.json())['data']);
  } catch {
    throw new GatewayModelServingUnavailableError('the gateway answered an unreadable entry');
  }
}
