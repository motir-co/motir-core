// The typed failures of motir-core's calls to motir-gateway's per-run key API
// (MOTIR-689). Three, because a caller does something different for each:
//
//   - `GatewayRunKeyConfigError` — THIS deployment is missing `MOTIR_GATEWAY_URL`
//     or `MOTIR_RUN_KEY_MINT_SECRET`. Nothing was sent. An operator fixes it.
//   - `GatewayRunKeyRefusedError` — the gateway ANSWERED and said no (a 4xx, or
//     its own `503 run_keys_not_configured`). Its `code` is the gateway's own.
//   - `GatewayRunKeyUnavailableError` — the gateway could not be reached, did not
//     answer within the deadline, or failed (5xx). Retrying may help.

export abstract class GatewayRunKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class GatewayRunKeyConfigError extends GatewayRunKeyError {}

export class GatewayRunKeyRefusedError extends GatewayRunKeyError {
  constructor(
    readonly status: number,
    /** The gateway's own error code, e.g. `run_key_unauthorized`, or `unknown`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class GatewayRunKeyUnavailableError extends GatewayRunKeyError {}

// --- The tenant-app key API (MOTIR-8339) ---
//
// Distinct classes from the run-key three ON PURPOSE: a caller must be able to
// tell an app-key refusal from a run-key one. The meanings are the same:
//
//   - `GatewayAppKeyConfigError` — THIS deployment is missing `MOTIR_GATEWAY_URL`
//     or `MOTIR_APP_KEY_MINT_SECRET`. Nothing was sent.
//   - `GatewayAppKeyRefusedError` — the gateway ANSWERED and said no: a 4xx, or a
//     503 carrying its own JSON refusal (`app_keys_not_configured`). `code` is its own.
//   - `GatewayAppKeyUnavailableError` — unreachable, timed out, any other 5xx, or
//     an answer that is not the contract's shape. Retrying may help.

export abstract class GatewayAppKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class GatewayAppKeyConfigError extends GatewayAppKeyError {}

export class GatewayAppKeyRefusedError extends GatewayAppKeyError {
  constructor(
    readonly status: number,
    /** The gateway's own error code, e.g. `app_key_not_minted`, or `unknown`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class GatewayAppKeyUnavailableError extends GatewayAppKeyError {}
