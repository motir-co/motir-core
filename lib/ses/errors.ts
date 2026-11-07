// Typed errors for the SES notification endpoint (MOTIR-10565). The route maps
// each one to a status; the service and the SNS leaf throw them. Shaped like
// `lib/resend/errors.ts`, the sibling webhook's taxonomy, so an operator meets
// the same contract on both endpoints.

/**
 * `SES_NOTIFICATION_TOPIC_ARN` is not configured on this deployment. Read at
 * CALL time, so a self-hosted instance that never wires SES cannot reach the
 * endpoint rather than failing its boot. A server MISCONFIG (→ 500), distinct
 * from a bad signature (→ 401): without the topic we cannot tell OUR topic's
 * notifications from anyone else's, and every SNS message is signed by AWS
 * whoever owns the topic that sent it.
 */
export class SesNotificationsNotConfiguredError extends Error {
  readonly code = 'SES_NOTIFICATIONS_NOT_CONFIGURED' as const;
  constructor() {
    super('SES notifications are not configured. Set SES_NOTIFICATION_TOPIC_ARN.');
    this.name = 'SesNotificationsNotConfiguredError';
  }
}

/**
 * The message is not a well-formed SNS message, its signing certificate is not
 * served from an SNS host, or its signature does not verify (→ 401). Carries no
 * detail: the endpoint is public by necessity, and there is nothing to hand an
 * attacker probing it.
 */
export class SnsSignatureError extends Error {
  readonly code = 'SES_NOTIFICATION_INVALID_SIGNATURE' as const;
  constructor() {
    super('SNS message signature verification failed.');
    this.name = 'SnsSignatureError';
  }
}

/**
 * A genuinely signed SNS message from a topic that is not ours (→ 403). SNS
 * signs every topic's messages with the same AWS key, so a valid signature
 * proves only that AWS sent it. Anyone can create a topic and subscribe this
 * URL; without this check we would confirm that subscription and then suppress
 * whatever addresses its owner published.
 */
export class SnsTopicNotAllowedError extends Error {
  readonly code = 'SES_NOTIFICATION_TOPIC_NOT_ALLOWED' as const;
  constructor() {
    super('SNS message is from a topic this deployment does not subscribe to.');
    this.name = 'SnsTopicNotAllowedError';
  }
}

/**
 * Confirming a subscription failed: SNS answered the `SubscribeURL` with a
 * non-2xx, or the request never got an answer (→ 502). SNS does not repeat a
 * confirmation request on its own, so this is logged loudly for an operator to
 * re-request it from the console.
 */
export class SnsSubscriptionConfirmError extends Error {
  readonly code = 'SES_NOTIFICATION_SUBSCRIPTION_CONFIRM_FAILED' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SnsSubscriptionConfirmError';
  }
}
