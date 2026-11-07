import { SesNotificationsNotConfiguredError, SnsTopicNotAllowedError } from '@/lib/ses/errors';
import { confirmSnsSubscription, type SnsMessage } from '@/lib/ses/sns';
import {
  emailSuppressionService,
  type SuppressAddressInput,
} from '@/lib/services/emailSuppressionService';

// The SES notification endpoint's business logic (MOTIR-10565). The route turns
// the POST into a VERIFIED SNS message (`lib/ses/sns.ts`) and hands it here;
// everything after the signature lives in this file (the 4-layer rule).
//
// What arrives: SES publishes the configuration set's bounce and complaint
// events to an SNS topic, and the topic delivers each one here, wrapped in an
// SNS envelope whose `Message` is the SES event as a JSON STRING. The first
// delivery a new subscription makes is a `SubscriptionConfirmation`, which we
// answer by GETting its `SubscribeURL`.
//
// What it does: a PERMANENT bounce or a COMPLAINT suppresses every recipient
// the event names (`emailSuppressionService`). A TRANSIENT or UNDETERMINED
// bounce suppresses nothing — a full mailbox or a greylisting server is a
// reason to try later, not to stop for good, and SES has already retried it.

/** The provider name stored on every row this endpoint writes. */
const PROVIDER = 'ses';

/** What became of one notification — the route returns it, nothing more. */
export type SesNotificationOutcome =
  | { outcome: 'subscription_confirmed' }
  | { outcome: 'suppressed'; reason: 'bounce' | 'complaint'; addresses: string[] }
  /** A bounce SES classified as transient or undetermined. */
  | { outcome: 'not_suppressed'; bounceType: string }
  /** An event type we do not act on, a body that is not an SES event, or an unsubscribe notice. */
  | { outcome: 'ignored' };

interface SesRecipient {
  emailAddress?: unknown;
}

/** The fields we read off an SES event. Everything else in it is ignored. */
interface SesEvent {
  /** Configuration-set event publishing names the type here… */
  eventType?: unknown;
  /** …and identity notifications name it here. Both shapes reach a topic. */
  notificationType?: unknown;
  mail?: { messageId?: unknown } | null;
  bounce?: {
    bounceType?: unknown;
    bounceSubType?: unknown;
    bouncedRecipients?: unknown;
  } | null;
  complaint?: {
    complaintFeedbackType?: unknown;
    complainedRecipients?: unknown;
  } | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function recipientsOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((recipient: SesRecipient | null) => stringOrNull(recipient?.emailAddress))
    .filter((address): address is string => address !== null);
}

function parseSesEvent(raw: string): SesEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as SesEvent) : null;
  } catch {
    return null;
  }
}

/** The topic this deployment subscribes to, read at call time. */
function allowedTopicArn(): string {
  const arn = process.env.SES_NOTIFICATION_TOPIC_ARN?.trim();
  if (!arn) throw new SesNotificationsNotConfiguredError();
  return arn;
}

async function suppressAll(
  reason: 'bounce' | 'complaint',
  addresses: string[],
  detail: string | null,
  providerMessageId: string | null,
): Promise<SesNotificationOutcome> {
  const entries: SuppressAddressInput[] = addresses.map((address) => ({
    address,
    reason,
    provider: PROVIDER,
    detail,
    providerMessageId,
  }));
  const written = await emailSuppressionService.suppress(entries);
  if (written.length === 0) return { outcome: 'ignored' };
  console.warn(
    `[ses-notification] suppressed ${written.length} address(es) after a ${reason}` +
      (providerMessageId ? ` on message ${providerMessageId}` : '') +
      (detail ? ` (${detail})` : ''),
  );
  return { outcome: 'suppressed', reason, addresses: written };
}

export const sesNotificationService = {
  /**
   * Act on one VERIFIED SNS message.
   *
   * Throws {@link SesNotificationsNotConfiguredError} when no topic is
   * configured, {@link SnsTopicNotAllowedError} when the message is from
   * another topic, and `SnsSubscriptionConfirmError` when a confirmation GET
   * fails. Every other branch, including the ones that change nothing, returns
   * an outcome the route answers 2xx: an error would only make SNS retry
   * something no retry can fix.
   */
  async handleMessage(message: SnsMessage): Promise<SesNotificationOutcome> {
    if (message.TopicArn !== allowedTopicArn()) throw new SnsTopicNotAllowedError();

    if (message.Type === 'SubscriptionConfirmation') {
      await confirmSnsSubscription(message);
      console.warn(`[ses-notification] confirmed the subscription to ${message.TopicArn}`);
      return { outcome: 'subscription_confirmed' };
    }
    // Someone unsubscribed the endpoint; there is nothing for us to do but ack.
    if (message.Type !== 'Notification') return { outcome: 'ignored' };

    const event = parseSesEvent(message.Message);
    if (event === null) return { outcome: 'ignored' };
    const type = stringOrNull(event.eventType) ?? stringOrNull(event.notificationType);
    const providerMessageId = stringOrNull(event.mail?.messageId);

    if (type === 'Bounce') {
      const bounceType = stringOrNull(event.bounce?.bounceType) ?? 'Undetermined';
      if (bounceType !== 'Permanent') return { outcome: 'not_suppressed', bounceType };
      return suppressAll(
        'bounce',
        recipientsOf(event.bounce?.bouncedRecipients),
        stringOrNull(event.bounce?.bounceSubType),
        providerMessageId,
      );
    }
    if (type === 'Complaint') {
      return suppressAll(
        'complaint',
        recipientsOf(event.complaint?.complainedRecipients),
        stringOrNull(event.complaint?.complaintFeedbackType),
        providerMessageId,
      );
    }
    return { outcome: 'ignored' };
  },
};
