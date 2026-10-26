import 'server-only';

import { MOTIR_GATEWAY_URL_ENV_VAR, gatewayBaseUrl } from './runKeyClient';
import { GatewayStatusMalformedError } from './statusErrors';

// THE MOTIR-CORE → MOTIR-GATEWAY STATUS CLIENT (MOTIR-742) — a SERVER-ONLY leaf
// primitive beside `runKeyClient.ts`, and the one read the operator console's
// Gateway card makes.
//
// The contract is the gateway's own, unauthenticated, and already shipped
// (motir-gateway `router/api.go` → `controller/misc.go` `GetStatus`):
//
//   GET /api/status → 200 {success: true, message, data: {version, start_time, …}}
//
// where `start_time` is UNIX SECONDS (`common.StartTime = time.Now().Unix()`).
// The rest of `data` is the gateway's login-page configuration and is ignored on
// purpose: the console needs *is it answering, how fast, which build*, not a copy
// of the gateway's settings.
//
// ⚠️ IT THROWS ON EVERY ANSWER THAT IS NOT A CLEAN ONE — a non-2xx, a body that
// is not JSON, `success !== true`, a missing version, a timeout. The service's
// `probe()` is the single place a throw becomes `unreachable`, so a half-read here
// cannot turn into a card that shows a latency for a gateway that said no.
//
// ⚠️ AND IT SAYS WHICH KIND OF NO (MOTIR-9641). An answer that arrived and was
// rejected — a non-2xx, a body that is not JSON, a body `parseStatus` refuses —
// throws `GatewayStatusMalformedError` carrying WHY; a deadline or a network
// failure throws a plain error. The card tells "did not answer" apart from
// "answered, but wrongly", because the two send an operator to different places.
//
// ⚠️ GET ONLY, NO CREDENTIAL. The mint secret is `runKeyClient.ts`'s and stays
// there (`tests/hostedRuns/hostedRunKeyBoundary.test.ts` pins one reader); this
// endpoint needs none, and a probe has no business carrying one.

/**
 * The deadline on one status read.
 *
 * Three seconds, which is the whole budget the card can spend before an operator
 * looking at the board during an incident is better served by "no answer" than
 * by a spinner. It is three times the slow threshold the service judges against,
 * so a gateway that is merely slow is still MEASURED as slow rather than reported
 * as down.
 */
export const GATEWAY_STATUS_TIMEOUT_MS = 3_000;

/** One clean answer from the gateway's status endpoint. */
export interface GatewayStatus {
  /** Wall-clock ms from sending the request to having the parsed body. */
  latencyMs: number;
  /** The gateway's build version, e.g. `v0.18.3`. */
  version: string;
  /** ISO-8601 — when the gateway process started. */
  startTime: string;
}

/** The thing the service reads through — the real client or the E2E fake. */
export interface GatewayStatusReader {
  /** Is there a gateway to ask on this deployment at all? */
  configured(): boolean;
  /** One status read. Throws on anything but a clean answer. */
  read(): Promise<GatewayStatus>;
  /** Where the card links out to, or null when there is no honest page. */
  statusUrl(): string | null;
}

/**
 * Is `MOTIR_GATEWAY_URL` set? A deployment without one runs no gateway, which is
 * a configuration fact and not an outage — the card says `notConfigured` rather
 * than `noAnswer`.
 */
export function gatewayStatusConfigured(): boolean {
  return Boolean(process.env[MOTIR_GATEWAY_URL_ENV_VAR]?.trim());
}

/**
 * The URL the status read hits — also the card's link-out, because the endpoint
 * the probe reads IS the honest "Gateway status" page: it names no hosting
 * provider (the boundary `tests/ciFleet/orchestratorPortBoundary.test.ts` keeps)
 * and shows an operator exactly what the card measured.
 */
export function gatewayStatusUrl(): string {
  return `${gatewayBaseUrl()}/api/status`;
}

export async function readGatewayStatus(): Promise<GatewayStatus> {
  const url = gatewayStatusUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_STATUS_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new GatewayStatusMalformedError(
        'httpStatus',
        `gateway status answered ${res.status}`,
        res.status,
      );
    }
    const body = parseStatus(await readJson(res));
    return { latencyMs: Date.now() - startedAt, ...body };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`gateway status did not answer within ${GATEWAY_STATUS_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The real binding. */
export const httpGatewayStatusReader: GatewayStatusReader = {
  configured: gatewayStatusConfigured,
  read: readGatewayStatus,
  statusUrl: () => (gatewayStatusConfigured() ? gatewayStatusUrl() : null),
};

/**
 * The body as JSON. Reading the body is still part of the answer arriving, so a
 * deadline that fires mid-body rethrows as itself and the caller's abort check
 * reports it as no answer; only a body that arrived and is not JSON is rejected.
 */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayStatusMalformedError(
      'notJson',
      'gateway status answered a body that is not JSON',
    );
  }
}

function parseStatus(json: unknown): Omit<GatewayStatus, 'latencyMs'> {
  if (!isRecord(json) || json['success'] !== true) {
    throw new GatewayStatusMalformedError('noSuccess', 'gateway status did not report success');
  }
  const data = json['data'];
  if (!isRecord(data)) {
    throw new GatewayStatusMalformedError('noData', 'gateway status carried no data');
  }
  const version = data['version'];
  const startSeconds = data['start_time'];
  if (typeof version !== 'string' || version.length === 0) {
    throw new GatewayStatusMalformedError('noVersion', 'gateway status carried no version');
  }
  if (typeof startSeconds !== 'number' || !Number.isFinite(startSeconds) || startSeconds <= 0) {
    throw new GatewayStatusMalformedError('noStartTime', 'gateway status carried no start time');
  }
  return { version, startTime: new Date(startSeconds * 1000).toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
