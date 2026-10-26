import 'server-only';

import {
  GatewayRunKeyConfigError,
  GatewayRunKeyRefusedError,
  GatewayRunKeyUnavailableError,
} from '@/lib/gateway/errors';
import { gatewayRunUrl, mintGatewayRunKey, revokeGatewayRunKeys } from '@/lib/gateway/runKeyClient';
import { HostedRunKeyNotMintedError } from '@/lib/hostedRuns/errors';
import { hostedRunDeadline } from '@/lib/hostedRuns/limits';

// THE HOSTED RUN'S GATEWAY WIRING (MOTIR-689) — the two calls on motir-core's
// side that turn a booted container into a billed, bounded run
// (`docs/decisions/hosted-agent-run.md` §1, §5, §6, §7):
//
//   - `mintRunKey`   — at PROVISION, before the container boots. A failure is a
//     typed {@link HostedRunKeyNotMintedError}, and the start path (MOTIR-690)
//     fails the run on it WITHOUT booting: no container, no spend.
//   - `revokeRunKey` — at EVERY terminal state, called by the end path
//     (MOTIR-6450). It never throws: a revoke that failed is a RESULT the end path
//     logs against the run, and the key's own expiry is the backstop.
//
// ⚠️ THE MODEL IS PASSED THROUGH EXACTLY AS GIVEN. It arrives as the BARE gateway
// id the start path already validated against motir-ai's offered list (§7), and
// it goes onto the key's `models` allow-list bare, because the gateway compares
// the request's bare id against that list. The `anthropic/` prefix OpenCode's
// `--model` flag needs is added in exactly one place, `toOpenCodeModel`, and
// never here — a prefixed allow-list would get every model call refused `403`.
//
// ⚠️ THIS SERVICE BOOTS NOTHING, READS NO DATABASE AND BILLS NOTHING. The caller
// resolves the paying organization once (it needs it for the container's
// attribution too) and hands it in; the gateway and motir-ai do the billing.

/** The run a key is minted FOR — the three facts the mint needs. */
export interface HostedRunKeySubject {
  /** `DispatchRun.id` — the key's `runRef`, and motir-ai's `coreRunId` (§1). */
  id: string;
  /** The dispatching project's organization — the one that pays. */
  organizationId: string;
  /** When the run opened; its timeout (§5) is counted from here. */
  startedAt: Date;
}

/**
 * What the orchestration hands the container as its ONLY LLM configuration, in
 * the shape the gateway's egress contract (`docs/hosted-run-egress.md` §2)
 * documents: the gateway's origin and the per-run key, as the two environment
 * variables OpenCode's configuration substitutes (`{env:MOTIR_GATEWAY_URL}/v1`,
 * `{env:MOTIR_RUN_KEY}`). No provider key, and no other model credential.
 */
export interface HostedRunLlmConfig {
  runRef: string;
  /** The one model the key may call — bare, as minted. */
  model: string;
  expiresAt: Date;
  containerEnv: {
    MOTIR_GATEWAY_URL: string;
    MOTIR_RUN_KEY: string;
  };
}

/** The outcome of a revoke — never a throw. */
export type HostedRunKeyRevokeResult =
  | { ok: true; runRef: string; revoked: number }
  | {
      ok: false;
      runRef: string;
      reason: 'not_configured' | 'refused' | 'unavailable';
      message: string;
    };

function notMinted(err: unknown): HostedRunKeyNotMintedError {
  if (err instanceof GatewayRunKeyConfigError) {
    return new HostedRunKeyNotMintedError('not_configured', err.message);
  }
  if (err instanceof GatewayRunKeyRefusedError) {
    return new HostedRunKeyNotMintedError(
      'refused',
      `the gateway refused the run key (${err.status} ${err.code}): ${err.message}`,
      err.code,
    );
  }
  if (err instanceof GatewayRunKeyUnavailableError) {
    return new HostedRunKeyNotMintedError('unavailable', err.message);
  }
  return new HostedRunKeyNotMintedError(
    'unavailable',
    err instanceof Error ? err.message : String(err),
  );
}

export const hostedRunKeyService = {
  /**
   * Mint the run's per-run key for exactly `model`, expiring at the run's timeout
   * (§5), billed to `run.organizationId` in the agent lane.
   *
   * Throws {@link HostedRunKeyNotMintedError} on every failure — including a run
   * already past its timeout — so the caller has one thing to catch before boot.
   */
  async mintRunKey(
    run: HostedRunKeySubject,
    model: string,
    now: Date = new Date(),
  ): Promise<HostedRunLlmConfig> {
    if (model.length === 0) {
      throw new HostedRunKeyNotMintedError('invalid_request', 'a run key needs a model');
    }
    const expiresAt = hostedRunDeadline(run.startedAt);
    if (expiresAt.getTime() <= now.getTime()) {
      throw new HostedRunKeyNotMintedError(
        'invalid_request',
        `run ${run.id} is past its timeout; no key is minted for it`,
      );
    }
    try {
      // motir(MOTIR-7656): the PUBLIC run-lane edge, never motir-core's own private
      // origin — the container boots outside `moooon`. Read BEFORE the mint, so a
      // misconfigured origin mints no key that nothing will ever use.
      const containerGatewayUrl = gatewayRunUrl();
      const minted = await mintGatewayRunKey({
        runRef: run.id,
        coreOrganizationId: run.organizationId,
        expiresAt,
        models: [model],
      });
      return {
        runRef: run.id,
        model,
        expiresAt,
        containerEnv: {
          MOTIR_GATEWAY_URL: containerGatewayUrl,
          MOTIR_RUN_KEY: minted.key,
        },
      };
    } catch (err) {
      throw notMinted(err);
    }
  },

  /**
   * Revoke every key bound to the run. Idempotent at the gateway (a second call
   * answers `revoked: 0`), and TOTAL here: a failure is returned, never thrown,
   * so the end path can record it and carry on tearing the run down.
   */
  async revokeRunKey(dispatchRunId: string): Promise<HostedRunKeyRevokeResult> {
    try {
      const result = await revokeGatewayRunKeys(dispatchRunId);
      return { ok: true, runRef: dispatchRunId, revoked: result.revoked };
    } catch (err) {
      const reason =
        err instanceof GatewayRunKeyConfigError
          ? 'not_configured'
          : err instanceof GatewayRunKeyRefusedError
            ? 'refused'
            : 'unavailable';
      return {
        ok: false,
        runRef: dispatchRunId,
        reason,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
