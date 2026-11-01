// Typed errors for the CLI device-authorization domain (Story MOTIR-1863 · Subtask
// MOTIR-1865). Prisma-free (the lib/apiTokens pattern) so routes can import them
// without pulling in the Prisma client.
//
// The poll errors are modelled on RFC 8628 §3.5 rather than on HTTP: each carries
// the `oauthError` code the CLI branches on, and `POST /api/cli/device/token`
// returns them ALL as HTTP 400 `{ error, error_description }` — the plugin's own
// shape, so a generic RFC 8628 poller works against Motir unchanged. That is why
// they share a base class: the route maps the whole family in one branch and cannot
// forget a state as new ones arrive.
//
// `authorization_pending` and `slow_down` are the NORMAL path, not failures — the
// CLI polls through them for the entire time the human is approving. They are
// errors here only because RFC 8628 makes them so.

/** Base for every state the poll answers with an RFC 8628 error body. */
export abstract class DeviceGrantError extends Error {
  /** The RFC 8628 `error` value the CLI branches on. */
  abstract readonly oauthError: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The grant exists and is still `pending` — nobody has approved yet. The CLI
 * keeps polling at `interval`; it is not shown to the user. */
export class DeviceGrantPendingError extends DeviceGrantError {
  readonly oauthError = 'authorization_pending' as const;
  readonly code = 'DEVICE_GRANT_PENDING' as const;
  constructor() {
    super('Authorization pending');
  }
}

/** Polled again inside the grant's `pollingInterval`. The CLI adds 5s to its
 * interval and keeps polling — never aborts. */
export class DeviceGrantSlowDownError extends DeviceGrantError {
  readonly oauthError = 'slow_down' as const;
  readonly code = 'DEVICE_GRANT_SLOW_DOWN' as const;
  constructor() {
    super('Polling too frequently');
  }
}

/** The human pressed Deny. The row is gone; nothing was minted and nothing is
 * written to the CLI's config. */
export class DeviceGrantDeniedError extends DeviceGrantError {
  readonly oauthError = 'access_denied' as const;
  readonly code = 'DEVICE_GRANT_DENIED' as const;
  constructor() {
    super('Access denied');
  }
}

/** The code aged out before it was approved. The row is deleted on discovery, so
 * an expired grant is never re-pollable. */
export class DeviceGrantExpiredError extends DeviceGrantError {
  readonly oauthError = 'expired_token' as const;
  readonly code = 'DEVICE_GRANT_EXPIRED' as const;
  constructor() {
    super('Device code has expired');
  }
}

/**
 * Unknown `device_code`, a `client_id` that does not match the grant, or a grant
 * already consumed by an earlier poll. A hard error for the CLI — a bug or a
 * tampered request, not something to retry.
 *
 * Consumed-already collapses into this deliberately: after the winning poll the row
 * is gone, so a second poll with the same device code is indistinguishable from an
 * unknown one — which is exactly the answer the single-use contract wants ("the
 * plaintext is returned exactly once").
 */
export class InvalidDeviceGrantError extends DeviceGrantError {
  readonly oauthError = 'invalid_grant' as const;
  readonly code = 'DEVICE_GRANT_INVALID' as const;
  constructor(message = 'Invalid device code') {
    super(message);
  }
}

/**
 * An approved grant reached the mint with no bound workspace — structurally
 * impossible (approval writes the workspace BEFORE flipping the status, under the
 * row lock), so this is a corrupted row or a hand-edited DB, not a user error. The
 * route answers 500 `server_error`: "not your fault, try again."
 */
export class DeviceGrantUnboundError extends Error {
  readonly code = 'DEVICE_GRANT_UNBOUND' as const;
  constructor() {
    super('The approved device grant has no bound workspace or user.');
    this.name = 'DeviceGrantUnboundError';
  }
}

/**
 * The approving session has not CLAIMED the code yet — Better-Auth requires
 * `GET /api/auth/device?user_code=…` (signed in) before approve/deny, because that
 * read is what stamps `userId` onto the row. The `/device` page (Subtask MOTIR-1867)
 * calls it on mount; a POST that skips it is a client-sequencing bug, surfaced as
 * 409 rather than swallowed.
 */
export class DeviceGrantNotClaimedError extends Error {
  readonly code = 'DEVICE_GRANT_NOT_CLAIMED' as const;
  constructor() {
    super('This device code has not been claimed by a verifying session yet.');
    this.name = 'DeviceGrantNotClaimedError';
  }
}

/**
 * The grant was claimed by a DIFFERENT signed-in user than the one approving. Only
 * the session that claimed a code may approve it (the plugin enforces this too, but
 * approval writes Motir's workspace binding FIRST — so the check has to happen
 * before that write, not only inside the plugin's flip). 403.
 */
export class DeviceGrantForbiddenError extends Error {
  readonly code = 'DEVICE_GRANT_FORBIDDEN' as const;
  constructor() {
    super('This device code was claimed by a different session.');
    this.name = 'DeviceGrantForbiddenError';
  }
}

/** The grant is no longer `pending` — already approved, already denied, or expired.
 * Re-approving is not idempotent (a second approval of a consumed grant would be a
 * second credential), so it is refused rather than replayed. */
export class DeviceGrantNotPendingError extends Error {
  readonly code = 'DEVICE_GRANT_NOT_PENDING' as const;
  constructor() {
    super('This device code has already been approved, denied, or has expired.');
    this.name = 'DeviceGrantNotPendingError';
  }
}

/**
 * `motir auth refresh` presented a credential that is not a CLI sign-in
 * (MOTIR-10189): a hand-minted token bound to a project, or a run token. Only the
 * device credential's grant is the product's to set — a bound token's grant is a
 * person's choice and is edited on Settings → Account → API tokens. 422.
 */
export class DeviceUpdateNotCliTokenError extends Error {
  readonly code = 'DEVICE_UPDATE_NOT_CLI_TOKEN' as const;
  constructor() {
    super('Only a CLI sign-in can be refreshed; edit this token’s permissions in Settings.');
    this.name = 'DeviceUpdateNotCliTokenError';
  }
}

/**
 * Approving an UPDATE grant could not update the token (MOTIR-10189) — it is gone,
 * no longer the approver's, or the approval came from inside a staff "View as"
 * session. The grant is DENIED when this is raised, so the terminal's next poll
 * hears `access_denied` and says the token is unchanged. 422.
 */
export class DeviceUpdateRefusedError extends Error {
  readonly code = 'DEVICE_UPDATE_REFUSED' as const;
  constructor(readonly reason: string) {
    super(`The token could not be updated: ${reason}`);
    this.name = 'DeviceUpdateRefusedError';
  }
}

/** A `motir login` approval names no workspace to bind the new credential to. Only
 * an UPDATE grant may omit it — the token it updates already has one. 400. */
export class DeviceGrantWorkspaceRequiredError extends Error {
  readonly code = 'DEVICE_GRANT_WORKSPACE_REQUIRED' as const;
  constructor() {
    super('A workspaceId is required to approve a new CLI sign-in.');
    this.name = 'DeviceGrantWorkspaceRequiredError';
  }
}
