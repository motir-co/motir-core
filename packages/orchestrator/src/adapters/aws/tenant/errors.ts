import { OrchestratorApiError } from '../../../errors';

// The tenant seam's typed errors (MOTIR-10004). None carries an AWS message, a
// credential or a template body: each names the operation, the resource and
// AWS's error CODE, never more.

/** An AWS call in a tenant account was refused or could not be made. */
export class AwsTenantApiError extends OrchestratorApiError {
  constructor(
    readonly service: string,
    readonly awsCode: string,
    status: number | null,
  ) {
    super('aws', status, `${service} ${awsCode}`);
    this.name = 'AwsTenantApiError';
  }
}

/** The tenant account's deploy role could not be assumed. */
export class TenantRoleUnavailableError extends Error {
  readonly code = 'AWS_TENANT_ROLE_UNAVAILABLE' as const;
  constructor(
    readonly accountId: string,
    readonly awsCode: string,
  ) {
    super(`The deploy role in tenant account ${accountId} could not be assumed (${awsCode}).`);
    this.name = 'TenantRoleUnavailableError';
  }
}

/** A stack was asked for without `motir:organization` or `motir:repository`. */
export class StackTagsRequiredError extends Error {
  readonly code = 'AWS_STACK_TAGS_REQUIRED' as const;
  constructor(
    readonly stackName: string,
    readonly missing: readonly string[],
  ) {
    super(`Stack ${stackName} needs the tag(s) ${missing.join(', ')}.`);
    this.name = 'StackTagsRequiredError';
  }
}

/** A stack name outside the `motir-` prefix, or `shared` on a stack that is not
 *  the account's network. */
export class StackNameRefusedError extends Error {
  readonly code = 'AWS_STACK_NAME_REFUSED' as const;
  constructor(
    readonly stackName: string,
    readonly reason: string,
  ) {
    super(`Stack ${stackName} is refused: ${reason}.`);
    this.name = 'StackNameRefusedError';
  }
}

/** A stack ended, or sits, in a state the runner does not recover from. */
export class StackFailedError extends Error {
  readonly code = 'AWS_STACK_FAILED' as const;
  constructor(
    readonly stackName: string,
    readonly status: string,
  ) {
    super(`Stack ${stackName} is in ${status}.`);
    this.name = 'StackFailedError';
  }
}

/** A stack did not reach a terminal state in time. */
export class StackWaitTimeoutError extends Error {
  readonly code = 'AWS_STACK_WAIT_TIMEOUT' as const;
  constructor(
    readonly stackName: string,
    readonly status: string,
  ) {
    super(`Stack ${stackName} was still ${status} when the wait ended.`);
    this.name = 'StackWaitTimeoutError';
  }
}
