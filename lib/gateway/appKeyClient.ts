import 'server-only';

import {
  GatewayAppKeyConfigError,
  GatewayAppKeyInvalidInputError,
  GatewayAppKeyRefusedError,
  GatewayAppKeyUnavailableError,
  GatewayRunKeyConfigError,
} from './errors';
import { GATEWAY_RUN_KEY_TIMEOUT_MS, gatewayBaseUrl } from './runKeyClient';

// THE MOTIR-CORE → MOTIR-GATEWAY TENANT-APP KEY CLIENT (MOTIR-8339) — a
// SERVER-ONLY leaf primitive beside `./runKeyClient.ts`. It mints and revokes the
// gateway key a hosted tenant app holds: bound to ONE motir-core project and the
// ONE organization that pays, on the `app` lane, over HTTP and nothing else.
//
// The contract is the gateway's (`controller/motir_app_key.go` there):
//
//   POST   /api/motir/app-keys                   {projectRef, coreOrganizationId, expiresAt, quota, models}
//                                                → 201 {key, keyId, projectRef, coreOrganizationId, expiresAt, lane}
//   DELETE /api/motir/app-keys/:keyId            → 200 {keyId, revoked}
//   DELETE /api/motir/app-keys?projectRef=<ref>  → 200 {projectRef, revoked}
//
// authorised by `Authorization: Bearer <MOTIR_APP_KEY_MINT_SECRET>` and refusing
// with `{ error: { code, message } }`. `expiresAt` is UNIX SECONDS.
//
// ⚠️ THE LIMITS ARE REQUIRED (MOTIR-8341). Every key carries a finite `quota` (a
// positive integer in the gateway's own quota units) and a non-empty `models`
// allow-list, and the gateway refuses a mint without either. Nothing here picks a
// default for either: the caller chooses the values and converts the units. A
// value the gateway would refuse is refused HERE with no request
// (`GatewayAppKeyInvalidInputError`), by the gateway's own rules.
//
// ⚠️ `MOTIR_APP_KEY_MINT_SECRET` IS READ HERE AND NOWHERE ELSE, AT CALL TIME, and
// it is NOT the run-key secret: a leak of one must never open the other. Either
// env var unset ⇒ a config error and NO request.
//
// ⚠️ A 503 IS CLASSIFIED BY SHAPE, NOT BY CODE NAME. A 503 whose body is the
// gateway's own JSON refusal (a string `error.code`) is a definite REFUSAL — the
// gateway is up and says app keys are not configured. A 503 without one (a load
// balancer's page) and every other 5xx are UNAVAILABLE.

export const MOTIR_APP_KEY_MINT_SECRET_ENV_VAR = 'MOTIR_APP_KEY_MINT_SECRET';

function appKeyBaseUrl(): string {
  try {
    return gatewayBaseUrl();
  } catch (err) {
    if (err instanceof GatewayRunKeyConfigError) throw new GatewayAppKeyConfigError(err.message);
    throw err;
  }
}

function appKeyMintSecret(): string {
  const secret = process.env[MOTIR_APP_KEY_MINT_SECRET_ENV_VAR]?.trim();
  if (!secret) {
    throw new GatewayAppKeyConfigError(`${MOTIR_APP_KEY_MINT_SECRET_ENV_VAR} is not set`);
  }
  return secret;
}

/** Both reads, BEFORE any request: a deployment missing either sends nothing. */
function appKeyTarget(): { url: string; secret: string } {
  return { url: appKeyBaseUrl(), secret: appKeyMintSecret() };
}

async function gatewayFetch(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_RUN_KEY_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new GatewayAppKeyUnavailableError(
        `the gateway did not respond within ${GATEWAY_RUN_KEY_TIMEOUT_MS}ms`,
      );
    }
    throw new GatewayAppKeyUnavailableError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Map a non-2xx answer to its typed error — see the 503 rule above. */
async function refusal(res: Response): Promise<Error> {
  let code: string | null = null;
  let message = res.statusText || `the gateway answered ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } } | null;
    if (typeof body?.error?.code === 'string') code = body.error.code;
    if (typeof body?.error?.message === 'string') message = body.error.message;
  } catch {
    // not JSON — keep the status line
  }
  const gatewayRefused = res.status < 500 || (res.status === 503 && code !== null);
  if (!gatewayRefused) {
    return new GatewayAppKeyUnavailableError(`${res.status} ${code ?? 'unknown'}: ${message}`);
  }
  return new GatewayAppKeyRefusedError(res.status, code ?? 'unknown', message);
}

async function jsonBody(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function revokedCount(body: Record<string, unknown> | null): number {
  return typeof body?.['revoked'] === 'number' ? body['revoked'] : 0;
}

export interface MintGatewayAppKeyInput {
  /** The motir-core project id the key is bound to. */
  projectRef: string;
  /** The organization that pays for the key's usage. */
  coreOrganizationId: string;
  /** Required: there is no never-expiring app key. */
  expiresAt: Date;
  /** Required: the key's spend ceiling, a positive safe integer in gateway quota units. */
  quota: number;
  /** Required and non-empty: the key's model allow-list — BARE gateway ids. */
  models: string[];
}

/**
 * Why the gateway would refuse these limits, or `null` when it would accept them.
 * The rules are the gateway's own (`MotirAppKeyMint.validate`): a positive integer
 * quota, a non-empty list, and no model name that is blank or holds a comma (the
 * gateway stores the list comma-joined).
 */
export function appKeyLimitsProblem(quota: number, models: readonly string[]): string | null {
  if (!Number.isSafeInteger(quota) || quota <= 0) {
    return `quota must be a positive safe integer, got ${String(quota)}`;
  }
  if (models.length === 0) return 'models must name at least one model';
  const bad = models.find((m) => m.trim() === '' || m.includes(','));
  if (bad !== undefined) return `${JSON.stringify(bad)} is not a model name`;
  return null;
}

export interface MintedGatewayAppKey {
  /** The `sk-…` key, returned ONCE by the gateway. */
  key: string;
  /** The gateway's token row id — what a per-key revoke (rotation) names. */
  keyId: number;
  projectRef: string;
  coreOrganizationId: string;
  expiresAt: Date;
  lane: string;
}

/** POST /api/motir/app-keys. Throws a typed {@link GatewayAppKeyInvalidInputError}
 *  (nothing sent), {@link GatewayAppKeyConfigError}, {@link GatewayAppKeyRefusedError}
 *  or {@link GatewayAppKeyUnavailableError}. */
export async function mintGatewayAppKey(
  input: MintGatewayAppKeyInput,
): Promise<MintedGatewayAppKey> {
  const problem = appKeyLimitsProblem(input.quota, input.models);
  if (problem !== null) throw new GatewayAppKeyInvalidInputError(problem);
  const { url, secret } = appKeyTarget();
  const res = await gatewayFetch(`${url}/api/motir/app-keys`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      projectRef: input.projectRef,
      coreOrganizationId: input.coreOrganizationId,
      expiresAt: Math.floor(input.expiresAt.getTime() / 1000),
      quota: input.quota,
      models: input.models,
    }),
  });
  if (!res.ok) throw await refusal(res);
  const body = await jsonBody(res);
  const key = body?.['key'];
  const keyId = body?.['keyId'];
  if (typeof key !== 'string' || key.length === 0 || typeof keyId !== 'number') {
    throw new GatewayAppKeyUnavailableError('the gateway minted no key');
  }
  const expiresAt = body?.['expiresAt'];
  return {
    key,
    keyId,
    projectRef: typeof body?.['projectRef'] === 'string' ? body['projectRef'] : input.projectRef,
    coreOrganizationId:
      typeof body?.['coreOrganizationId'] === 'string'
        ? body['coreOrganizationId']
        : input.coreOrganizationId,
    expiresAt: typeof expiresAt === 'number' ? new Date(expiresAt * 1000) : input.expiresAt,
    lane: typeof body?.['lane'] === 'string' ? body['lane'] : 'app',
  };
}

export interface RevokedGatewayAppKey {
  keyId: number;
  /** `0` is a normal answer: the key was already revoked. */
  revoked: number;
}

/** DELETE /api/motir/app-keys/:keyId. Throws the same three typed errors. */
export async function revokeGatewayAppKey(keyId: number): Promise<RevokedGatewayAppKey> {
  const { url, secret } = appKeyTarget();
  const res = await gatewayFetch(`${url}/api/motir/app-keys/${encodeURIComponent(String(keyId))}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) throw await refusal(res);
  return { keyId, revoked: revokedCount(await jsonBody(res)) };
}

export interface RevokedGatewayAppKeysForProject {
  projectRef: string;
  /** How many live keys the gateway disabled. `0` is a normal answer. */
  revoked: number;
}

/** DELETE /api/motir/app-keys?projectRef=. Throws the same three typed errors. */
export async function revokeGatewayAppKeysForProject(
  projectRef: string,
): Promise<RevokedGatewayAppKeysForProject> {
  const { url, secret } = appKeyTarget();
  const query = new URLSearchParams({ projectRef }).toString();
  const res = await gatewayFetch(`${url}/api/motir/app-keys?${query}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!res.ok) throw await refusal(res);
  return { projectRef, revoked: revokedCount(await jsonBody(res)) };
}
