// The typed failures of motir-core's WRITE to motir-gateway's capacity API
// (MOTIR-9608; motir-gateway `docs/motir-capacity-api.md` §4, §7). The same three
// classes as the run-key client (`./errors.ts`), because a caller does something
// different for each:
//
//   - `GatewayCapacityConfigError` — THIS deployment is missing `MOTIR_GATEWAY_URL`
//     or `MOTIR_GATEWAY_CAPACITY_TOKEN`. Nothing was sent. An operator fixes it.
//   - `GatewayCapacityRefusedError` — the gateway ANSWERED and said no. Its `code`
//     is the gateway's own and `field` names the key at fault when it has one.
//     `capacity_store_error` (a 500) is a refusal too: the gateway says the row is
//     unchanged, so the edit definitely did not happen.
//   - `GatewayCapacityUnavailableError` — no answer within the deadline, a network
//     failure, or any other 5xx. Retrying may help.
//
// The READ never throws these: it answers a degraded or failed read as a value
// (`CapacityRead` in `./capacityClient.ts`). No message carries the token or a
// submitted value.

/** The contract's §7 error codes, plus `unknown` for an answer that names none. */
export type GatewayCapacityErrorCode =
  | 'capacity_auth_missing'
  | 'capacity_auth_invalid'
  | 'capacity_auth_forbidden'
  | 'capacity_config_unavailable'
  | 'capacity_unknown_provider'
  | 'capacity_unknown_model'
  | 'capacity_invalid_body'
  | 'capacity_empty_edit'
  | 'capacity_invalid_value'
  | 'capacity_store_error'
  | 'unknown';

const KNOWN_CODES: ReadonlySet<string> = new Set<GatewayCapacityErrorCode>([
  'capacity_auth_missing',
  'capacity_auth_invalid',
  'capacity_auth_forbidden',
  'capacity_config_unavailable',
  'capacity_unknown_provider',
  'capacity_unknown_model',
  'capacity_invalid_body',
  'capacity_empty_edit',
  'capacity_invalid_value',
  'capacity_store_error',
]);

/** Narrow a wire code to the union; anything else reads `unknown`. */
export function toGatewayCapacityErrorCode(code: unknown): GatewayCapacityErrorCode {
  return typeof code === 'string' && KNOWN_CODES.has(code)
    ? (code as GatewayCapacityErrorCode)
    : 'unknown';
}

export abstract class GatewayCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class GatewayCapacityConfigError extends GatewayCapacityError {}

export class GatewayCapacityRefusedError extends GatewayCapacityError {
  constructor(
    readonly status: number,
    readonly code: GatewayCapacityErrorCode,
    /** The wire key at fault (e.g. `planning_share_percent`), when the gateway named one. */
    readonly field: string | null,
  ) {
    super(`the gateway refused the capacity edit: ${status} ${code}${field ? ` (${field})` : ''}`);
  }
}

export class GatewayCapacityUnavailableError extends GatewayCapacityError {}
