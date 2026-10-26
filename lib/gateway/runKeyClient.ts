import 'server-only';

import { isPrivateNetworkHost } from '@/lib/ai/containerAiAddress';
import {
  GatewayRunKeyConfigError,
  GatewayRunKeyRefusedError,
  GatewayRunKeyUnavailableError,
} from './errors';

// THE MOTIR-CORE → MOTIR-GATEWAY RUN-KEY CLIENT (MOTIR-689) — a SERVER-ONLY leaf
// primitive, like `lib/ai/motirAiClient.ts`. It mints and revokes the per-run
// model key a hosted agent run holds (`docs/decisions/hosted-agent-run.md` §1,
// §6, §7), over HTTP and nothing else: motir-core never imports the gateway.
//
// The contract is the gateway's (`controller/motir_run_key.go`, and
// `docs/hosted-run-egress.md` §1 there):
//
//   POST   /api/motir/run-keys          {runRef, coreOrganizationId, expiresAt, models?}
//                                       → 201 {key, runRef, coreOrganizationId, expiresAt, lane}
//   DELETE /api/motir/run-keys/:runRef  → 200 {runRef, revoked}
//
// both authorised by `Authorization: Bearer <MOTIR_RUN_KEY_MINT_SECRET>`, and
// refusing with `{ error: { code, message } }`. `expiresAt` is UNIX SECONDS.
//
// ⚠️ `MOTIR_RUN_KEY_MINT_SECRET` IS READ HERE AND NOWHERE ELSE, AT CALL TIME. The
// `server-only` import makes bundling this module into a Client Component a
// build error, so the secret cannot reach a browser; reading at call time lets
// the module import cleanly in a deployment that never runs hosted.

export const MOTIR_GATEWAY_URL_ENV_VAR = 'MOTIR_GATEWAY_URL';
/** The CONTAINER-facing origin (MOTIR-7656) — see {@link gatewayRunUrl}. */
export const MOTIR_GATEWAY_RUN_URL_ENV_VAR = 'MOTIR_GATEWAY_RUN_URL';
export const MOTIR_RUN_KEY_MINT_SECRET_ENV_VAR = 'MOTIR_RUN_KEY_MINT_SECRET';

/** The deadline on one mint or revoke — both are single-row writes at the far end. */
export const GATEWAY_RUN_KEY_TIMEOUT_MS = 15_000;

/**
 * The gateway's ORIGIN for motir-core's OWN calls — mint, revoke, status — as
 * `MOTIR_GATEWAY_URL` names it, trailing slashes removed. In production it is the
 * PRIVATE `http://motir-gateway.flycast`, which no hosted-run container can reach:
 * a container is given {@link gatewayRunUrl} instead (MOTIR-7656,
 * `docs/decisions/hosted-agent-run.md` §9).
 */
export function gatewayBaseUrl(): string {
  return gatewayOrigin(MOTIR_GATEWAY_URL_ENV_VAR);
}

/**
 * The gateway's ORIGIN as a HOSTED-RUN CONTAINER reaches it (MOTIR-7656) — the
 * public run-lane edge, `https://gateway-run.motir.co` in production, named by
 * `MOTIR_GATEWAY_RUN_URL` and handed to the container AS `MOTIR_GATEWAY_URL` (the
 * egress contract's name, which the image's OpenCode config substitutes).
 *
 * ⚠️ THERE IS DELIBERATELY NO FALLBACK TO `MOTIR_GATEWAY_URL`. That fallback IS
 * the defect: motir-core's own origin is private in production, and a container
 * boots in the `motir-fleet` org or on an AWS VM, where it does not resolve —
 * MOTIR-4518's mistake, for the gateway. For the same reason a PRIVATE,
 * network-scoped host (`.flycast`, `.internal`, a ULA literal) is refused here,
 * at mint, rather than discovered as a run whose every model call fails to
 * resolve after the machine has booted.
 */
export function gatewayRunUrl(): string {
  const url = gatewayOrigin(MOTIR_GATEWAY_RUN_URL_ENV_VAR);
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // Left empty — refused just below, with the other unusable shapes.
  }
  if (!host) {
    throw new GatewayRunKeyConfigError(
      `${MOTIR_GATEWAY_RUN_URL_ENV_VAR} is not an absolute http(s) URL with a host`,
    );
  }
  if (isPrivateNetworkHost(host)) {
    throw new GatewayRunKeyConfigError(
      `${MOTIR_GATEWAY_RUN_URL_ENV_VAR} names ${host}, a PRIVATE address no hosted-run ` +
        `container can resolve; it must be the gateway's public run-lane edge (MOTIR-7656)`,
    );
  }
  return url;
}

/**
 * One gateway origin from `envVar`, trailing slashes removed. The egress contract
 * appends `/v1` itself, so a value that already ends in `/v1` is a
 * misconfiguration that would send OpenCode to `/v1/v1/messages`: refused here,
 * loudly, rather than discovered as a run whose every model call 404s.
 */
function gatewayOrigin(envVar: string): string {
  const raw = process.env[envVar]?.trim();
  if (!raw) throw new GatewayRunKeyConfigError(`${envVar} is not set`);
  const url = raw.replace(/\/+$/, '');
  if (/\/v1$/.test(url)) {
    throw new GatewayRunKeyConfigError(
      `${envVar} must be the gateway's origin, without a trailing /v1`,
    );
  }
  return url;
}

function mintSecret(): string {
  const secret = process.env[MOTIR_RUN_KEY_MINT_SECRET_ENV_VAR]?.trim();
  if (!secret) {
    throw new GatewayRunKeyConfigError(`${MOTIR_RUN_KEY_MINT_SECRET_ENV_VAR} is not set`);
  }
  return secret;
}

async function gatewayFetch(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_RUN_KEY_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new GatewayRunKeyUnavailableError(
        `the gateway did not respond within ${GATEWAY_RUN_KEY_TIMEOUT_MS}ms`,
      );
    }
    throw new GatewayRunKeyUnavailableError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Map a non-2xx answer to its typed error. A 5xx is UNAVAILABLE, except the
 *  gateway's own `503 run_keys_not_configured`, which is a definite refusal. */
async function refusal(res: Response): Promise<Error> {
  let code = 'unknown';
  let message = res.statusText || `the gateway answered ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } } | null;
    if (typeof body?.error?.code === 'string') code = body.error.code;
    if (typeof body?.error?.message === 'string') message = body.error.message;
  } catch {
    // not JSON — keep the status line
  }
  if (res.status >= 500 && code !== 'run_keys_not_configured') {
    return new GatewayRunKeyUnavailableError(`${res.status} ${code}: ${message}`);
  }
  return new GatewayRunKeyRefusedError(res.status, code, message);
}

export interface MintGatewayRunKeyInput {
  /** The run's `DispatchRun.id` (§1). */
  runRef: string;
  /** The organization that pays. */
  coreOrganizationId: string;
  expiresAt: Date;
  /** The key's model allow-list — BARE gateway ids, sent exactly as given. */
  models: string[];
}

export interface MintedGatewayRunKey {
  /** The `sk-…` key, returned ONCE by the gateway. */
  key: string;
  runRef: string;
  coreOrganizationId: string;
  expiresAt: Date;
  lane: string;
}

/** POST /api/motir/run-keys. Throws a typed {@link GatewayRunKeyConfigError},
 *  {@link GatewayRunKeyRefusedError} or {@link GatewayRunKeyUnavailableError}. */
export async function mintGatewayRunKey(
  input: MintGatewayRunKeyInput,
): Promise<MintedGatewayRunKey> {
  const url = gatewayBaseUrl();
  const secret = mintSecret();
  const res = await gatewayFetch(`${url}/api/motir/run-keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      runRef: input.runRef,
      coreOrganizationId: input.coreOrganizationId,
      expiresAt: Math.floor(input.expiresAt.getTime() / 1000),
      models: input.models,
    }),
  });
  if (!res.ok) throw await refusal(res);
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown> | null;
  } catch {
    // handled below
  }
  if (!body || typeof body['key'] !== 'string' || body['key'].length === 0) {
    throw new GatewayRunKeyUnavailableError('the gateway minted no key');
  }
  return {
    key: body['key'],
    runRef: typeof body['runRef'] === 'string' ? body['runRef'] : input.runRef,
    coreOrganizationId:
      typeof body['coreOrganizationId'] === 'string'
        ? body['coreOrganizationId']
        : input.coreOrganizationId,
    expiresAt:
      typeof body['expiresAt'] === 'number' ? new Date(body['expiresAt'] * 1000) : input.expiresAt,
    lane: typeof body['lane'] === 'string' ? body['lane'] : 'agent',
  };
}

export interface RevokedGatewayRunKeys {
  runRef: string;
  /** How many keys the gateway disabled. `0` is a normal answer: teardown may run twice. */
  revoked: number;
}

/** DELETE /api/motir/run-keys/:runRef. Throws the same three typed errors. */
export async function revokeGatewayRunKeys(runRef: string): Promise<RevokedGatewayRunKeys> {
  const url = gatewayBaseUrl();
  const secret = mintSecret();
  const res = await gatewayFetch(`${url}/api/motir/run-keys/${encodeURIComponent(runRef)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) throw await refusal(res);
  let revoked = 0;
  try {
    const body = (await res.json()) as { revoked?: unknown } | null;
    if (typeof body?.revoked === 'number') revoked = body.revoked;
  } catch {
    // a 200 with no body still revoked
  }
  return { runRef, revoked };
}
