// The container shape's typed errors (MOTIR-10009). Like the seam's, none
// carries an AWS message, a service event or a variable's value: each names the
// operation and the service. A stack that ends failed is the seam's
// `StackFailedError`; a suspend idle policy is the port's
// `IdlePolicyUnsupportedError`; a variable no task can carry is the function
// shape's `ReleaseVariableInvalidError`.

/** A rollback was asked for with no earlier revision to roll back to. */
export class NoPreviousTaskDefinitionError extends Error {
  readonly code = 'AWS_NO_PREVIOUS_TASK_DEFINITION' as const;
  constructor(readonly service: string) {
    super(`Service ${service} has no previous task definition to roll back to.`);
    this.name = 'NoPreviousTaskDefinitionError';
  }
}

/** A rollout did not finish healthy within its bound. */
export class ContainerRolloutTimeoutError extends Error {
  readonly code = 'AWS_CONTAINER_ROLLOUT_TIMEOUT' as const;
  constructor(
    readonly operation: string,
    readonly service: string,
  ) {
    super(`The ${operation} of service ${service} did not finish healthy in time.`);
    this.name = 'ContainerRolloutTimeoutError';
  }
}

/** ECS gave up a rollout (its circuit breaker), or the service is gone. */
export class ContainerRolloutFailedError extends Error {
  readonly code = 'AWS_CONTAINER_ROLLOUT_FAILED' as const;
  constructor(
    readonly operation: string,
    readonly service: string,
  ) {
    super(`The ${operation} of service ${service} failed.`);
    this.name = 'ContainerRolloutFailedError';
  }
}
