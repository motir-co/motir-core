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
