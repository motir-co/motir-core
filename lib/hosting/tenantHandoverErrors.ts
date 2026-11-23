import type { TenantHandoverStep } from '@/lib/ciFleet/hostingTenantAccounts';

// THE TAKEOVER HANDOVER'S TYPED ERRORS (Story MOTIR-9800 · MOTIR-12131) — what
// `tenantAccountHandoverService` and the single-repository takeover guard throw,
// and what `tenantHandoverErrorResponse.ts` maps to status codes. No message here
// carries an email address, a one-time code, a credential or a raw AWS payload:
// each names ids, step names and codes only.

/** A takeover of ONE AWS-target repository while the organisation's tenant
 *  account holds others: the account is one per organisation and leaves with
 *  all of them, so they are handed over together (MOTIR-12131). Names the
 *  others so the room can say which. */
export class SharedTenantAccountError extends Error {
  readonly code = 'TAKEOVER_SHARED_AWS_ACCOUNT' as const;
  constructor(
    readonly rowId: string,
    readonly repositories: readonly string[],
  ) {
    super(
      `This repository shares its organisation's AWS account with ${repositories.join(', ')}; ` +
        'hand the account over to take them over together.',
    );
    this.name = 'SharedTenantAccountError';
  }
}

/** No handover the caller may see: no such account, or one that is not the
 *  organisation's own, or an organisation the caller is not in (→ 404). */
export class TenantHandoverNotFoundError extends Error {
  readonly code = 'TENANT_HANDOVER_NOT_FOUND' as const;
  constructor(readonly ref: string) {
    super(`No AWS account handover ${ref} in this organisation.`);
    this.name = 'TenantHandoverNotFoundError';
  }
}

/** A member of the organisation who is not one of its admins (→ 403). */
export class TenantHandoverNotAdminError extends Error {
  readonly code = 'TENANT_HANDOVER_ADMIN_ONLY' as const;
  constructor(readonly organizationId: string) {
    super('Only an organisation admin can hand its AWS account over.');
    this.name = 'TenantHandoverNotAdminError';
  }
}

/** The organisation has no `ready` tenant account to hand over (→ 409). */
export class TenantAccountNotReadyError extends Error {
  readonly code = 'TENANT_ACCOUNT_NOT_READY' as const;
  constructor(
    readonly organizationId: string,
    readonly state: string | null,
  ) {
    super(`The organisation's AWS account is not ready to hand over (${state ?? 'none'}).`);
    this.name = 'TenantAccountNotReadyError';
  }
}

/** A second start of a handover already under way or finished (→ 409). */
export class TenantHandoverAlreadyStartedError extends Error {
  readonly code = 'TENANT_HANDOVER_ALREADY_STARTED' as const;
  constructor(
    readonly tenantAccountId: string,
    readonly state: string,
  ) {
    super(`This AWS account's handover has already started (${state}).`);
    this.name = 'TenantHandoverAlreadyStartedError';
  }
}

/** The owner the administrator named is malformed (→ 400). */
export class TenantHandoverInputError extends Error {
  readonly code = 'TENANT_HANDOVER_INPUT_INVALID' as const;
  constructor(readonly field: 'ownerEmail' | 'githubOwner' | 'code') {
    super(`The handover's ${field} is not valid.`);
    this.name = 'TenantHandoverInputError';
  }
}

/** A person's answer to a step that is not waiting on them (→ 409). */
export class HandoverStepNotWaitingError extends Error {
  readonly code = 'HANDOVER_STEP_NOT_WAITING' as const;
  constructor(
    readonly tenantAccountId: string,
    readonly expected: readonly TenantHandoverStep[],
    readonly current: { step: TenantHandoverStep; status: string } | null,
  ) {
    super(
      `The handover is not waiting on ${expected.join(' or ')}` +
        (current ? ` (it is at ${current.step}, ${current.status}).` : ' (it is complete).'),
    );
    this.name = 'HandoverStepNotWaitingError';
  }
}

/** A retry of a handover with no failed step (→ 409). */
export class HandoverNothingToRetryError extends Error {
  readonly code = 'HANDOVER_NOTHING_TO_RETRY' as const;
  constructor(
    readonly tenantAccountId: string,
    readonly current: { step: TenantHandoverStep; status: string } | null,
  ) {
    super(
      current
        ? `The handover has no failed step to retry (it is at ${current.step}, ${current.status}).`
        : 'The handover is complete; there is nothing to retry.',
    );
    this.name = 'HandoverNothingToRetryError';
  }
}

/** AWS refused the one-time code: wrong, expired or for another update
 *  (→ 422). Carries AWS's error code only, never the code typed. */
export class HandoverEmailCodeRefusedError extends Error {
  readonly code = 'HANDOVER_EMAIL_CODE_REFUSED' as const;
  constructor(readonly awsReason: string) {
    super(`AWS refused the code (${awsReason}). Check the latest email and try again.`);
    this.name = 'HandoverEmailCodeRefusedError';
  }
}

/** A step asked to run before the step it depends on is `done` — the order
 *  guarantees, checked rather than trusted to the array order. */
export class HandoverStepOutOfOrderError extends Error {
  readonly code = 'HANDOVER_STEP_OUT_OF_ORDER' as const;
  constructor(
    readonly step: TenantHandoverStep,
    readonly requires: TenantHandoverStep,
  ) {
    super(`The ${step} step needs ${requires} done first.`);
    this.name = 'HandoverStepOutOfOrderError';
  }
}

/** The admin who started the handover no longer exists, and the transfers need
 *  a person with a GitHub identity to act as. */
export class HandoverActorMissingError extends Error {
  readonly code = 'HANDOVER_ACTOR_MISSING' as const;
  constructor(readonly tenantAccountId: string) {
    super('The admin who started this handover no longer exists; start it again as an admin.');
    this.name = 'HandoverActorMissingError';
  }
}

/** A handed-over repository has no realized GitHub repository, so the deploy
 *  role has no repository id to trust. */
export class HandoverRepositoryNotRealizedError extends Error {
  readonly code = 'HANDOVER_REPOSITORY_NOT_REALIZED' as const;
  constructor(readonly rowId: string) {
    super(`Repository ${rowId} has no GitHub repository to hand over.`);
    this.name = 'HandoverRepositoryNotRealizedError';
  }
}
