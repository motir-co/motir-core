// Typed errors of Motir-hosted PREVIEWS (Story MOTIR-5766). The decision of
// record is MOTIR-5769 (page cmvrcywwc00jkhpr1zvvnike8, version 1). Kept free of
// Prisma and of any provider type. The suggested HTTP mapping is on each class.

/**
 * This deployment cannot run previews: a variable they need is unset, or no
 * adapter for the preview's provider is configured. Named, never its value, and
 * raised at CALL time — a deployment without previews still boots (the
 * `appAuth.ts` / `ciMetering/config.ts` contract). → 503
 */
export class PreviewHostingNotConfiguredError extends Error {
  readonly code = 'PREVIEW_HOSTING_NOT_CONFIGURED' as const;
  constructor(readonly missing: string) {
    super(`Previews are not configured on this deployment: ${missing}.`);
    this.name = 'PreviewHostingNotConfiguredError';
  }
}

/** A value a preview host is built from cannot make a DNS name — a pull
 *  request number that is not a positive integer, or a preview domain that is
 *  not lowercase DNS labels. A caller's bug, never a person's input. → 500 */
export class PreviewHostInvalidError extends Error {
  readonly code = 'PREVIEW_HOST_INVALID' as const;
  constructor(readonly reason: string) {
    super(`Cannot build a preview host: ${reason}.`);
    this.name = 'PreviewHostInvalidError';
  }
}

/** The steps that switch a repository's previews off (MOTIR-5775), in order. */
export type PreviewDisableStep =
  | 'revoke_push_credentials'
  | 'delete_push_secret'
  | 'delete_variables'
  | 'clear_record';

/**
 * Switching a repository's previews off did not finish: `step` names the one
 * that failed. The takeover saga reports it as ITS step failure and does not
 * transfer, because once the repository leaves Motir's org nothing here can reach
 * its Actions configuration again. Carries the cause's message, never a
 * credential. → 502
 */
export class PreviewDisableError extends Error {
  readonly code = 'PREVIEW_DISABLE_FAILED' as const;
  constructor(
    readonly step: PreviewDisableStep,
    detail: string,
  ) {
    super(`Could not switch previews off (${step}): ${detail}`);
    this.name = 'PreviewDisableError';
  }
}
