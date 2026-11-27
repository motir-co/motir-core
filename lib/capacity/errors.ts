// Typed refusals of the capacity alert state (Story MOTIR-9539 · MOTIR-9609).
// The doors map each to a response; none carries a person's identifier.

export class CapacityAlertShareInvalidError extends Error {
  constructor(readonly value: unknown) {
    super('The alert share must be a whole number from 1 to 100.');
    this.name = 'CapacityAlertShareInvalidError';
  }
}

export class CapacityAlertShareUnchangedError extends Error {
  constructor(readonly percent: number) {
    super(`The alert share is already ${percent} %.`);
    this.name = 'CapacityAlertShareUnchangedError';
  }
}

export class CapacityAlertKeyInvalidError extends Error {
  constructor(readonly field: 'provider' | 'model' | 'limitUnit') {
    super(`A capacity alert key has an invalid ${field}.`);
    this.name = 'CapacityAlertKeyInvalidError';
  }
}

/**
 * A provider model's limit is at or over the alert share (MOTIR-9611). Sent to
 * Sentry by `alertCapacityLimitOverShare`, once per raise; the message names the
 * provider, model and limit in plain words and nothing about any tenant.
 */
export class CapacityLimitOverShareError extends Error {
  constructor(
    readonly provider: string,
    readonly model: string,
    readonly unit: string,
    /** The share used, or `null` for a limit of 0 with usage above it. */
    readonly sharePercent: number | null,
    readonly alertSharePercent: number,
  ) {
    const used =
      sharePercent === null
        ? 'is above a limit of 0'
        : `is at ${Math.round(sharePercent)}% of its limit`;
    super(
      `${provider} / ${model}: ${UNIT_WORDS[unit] ?? unit} ${used} (alert share ${alertSharePercent}%)`,
    );
    this.name = 'CapacityLimitOverShareError';
  }
}

/**
 * The gateway's connections in use reached the saturation share of created
 * machines × hard limit (MOTIR-9675, design D6). Sent to Sentry by
 * `alertGatewaySaturationOverShare`, once per raise.
 */
export class GatewaySaturationOverShareError extends Error {
  constructor(
    readonly connectionsInUse: number,
    readonly capacityConnections: number,
    readonly sharePercent: number,
    readonly alertPercent: number,
  ) {
    super(
      `motir-gateway: ${connectionsInUse} connections in use is ${Math.round(sharePercent)}% of ` +
        `${capacityConnections} (created machines × hard limit; alert at ${alertPercent}%)`,
    );
    this.name = 'GatewaySaturationOverShareError';
  }
}

const UNIT_WORDS: Record<string, string> = {
  max_concurrency: 'concurrency',
  rpm: 'requests per minute',
  input_tpm: 'input tokens per minute',
  output_tpm: 'output tokens per minute',
  tpm: 'tokens per minute',
  tpd: 'tokens per day',
};

/** The codes core refuses a limit edit with before it reaches the gateway — the
 *  gateway's own §4 vocabulary, so the screen reads one set of codes. */
export type CapacityLimitEditInvalidCode =
  | 'capacity_unknown_provider'
  | 'capacity_invalid_body'
  | 'capacity_empty_edit'
  | 'capacity_invalid_value';

/** A limit edit refused by core's validation (MOTIR-9613); `field` is the
 *  gateway's snake_case key at fault, when there is one. */
export class CapacityLimitEditInvalidError extends Error {
  constructor(
    readonly code: CapacityLimitEditInvalidCode,
    readonly field: string | null = null,
  ) {
    super(`capacity limit edit refused: ${code}${field ? ` (${field})` : ''}`);
    this.name = 'CapacityLimitEditInvalidError';
  }
}
