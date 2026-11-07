import { createSign, generateKeyPairSync } from 'node:crypto';
import { vi } from 'vitest';
import { snsStringToSign, type SnsMessage } from '@/lib/ses/sns';

// Signed SNS messages for the SES notification tests (MOTIR-10565). A real RSA
// key pair signs each message exactly the way SNS does — over the canonical
// string `lib/ses/sns.ts` rebuilds — and `stubSnsFetch` serves its PUBLIC key
// as the signing certificate, so verification runs for real end to end.

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const SIGNING_PUBLIC_PEM = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** Another key: a message signed with it must not verify against the served one. */
const forger = generateKeyPairSync('rsa', { modulusLength: 2048 });

export const TOPIC_ARN = 'arn:aws:sns:eu-west-1:123456789012:motir-ses-events';
export const CERT_URL =
  'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0000000000000000000000.pem';
export const SUBSCRIBE_URL =
  'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=t';

let counter = 0;

/** Sign a message (version 1 = SHA1, version 2 = SHA256) with the served key, or the forger's. */
export function signed(
  fields: Partial<SnsMessage> & Pick<SnsMessage, 'Type' | 'Message'>,
  { forge = false }: { forge?: boolean } = {},
): SnsMessage {
  counter += 1;
  const message: SnsMessage = {
    MessageId: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    TopicArn: TOPIC_ARN,
    Timestamp: '2026-11-07T14:00:00.000Z',
    SignatureVersion: '2',
    SigningCertURL: CERT_URL,
    Signature: '',
    ...(fields.Type === 'Notification' ? {} : { SubscribeURL: SUBSCRIBE_URL, Token: 'token-1' }),
    ...fields,
  };
  const algorithm = message.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
  message.Signature = createSign(algorithm)
    .update(snsStringToSign(message), 'utf8')
    .sign(forge ? forger.privateKey : keys.privateKey, 'base64');
  return message;
}

/** A Notification carrying an SES event, the way a configuration set publishes it. */
export function sesNotification(event: Record<string, unknown>, over: Partial<SnsMessage> = {}) {
  return signed({ Type: 'Notification', Message: JSON.stringify(event), ...over });
}

export function permanentBounce(addresses: string[], subType = 'General') {
  return {
    eventType: 'Bounce',
    mail: { messageId: 'ses-message-1' },
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: subType,
      bouncedRecipients: addresses.map((emailAddress) => ({ emailAddress })),
    },
  };
}

export function complaint(addresses: string[], feedbackType?: string) {
  return {
    eventType: 'Complaint',
    mail: { messageId: 'ses-message-2' },
    complaint: {
      ...(feedbackType === undefined ? {} : { complaintFeedbackType: feedbackType }),
      complainedRecipients: addresses.map((emailAddress) => ({ emailAddress })),
    },
  };
}

/**
 * Stub global fetch: the certificate URL serves the public key, the subscribe
 * URL answers `subscribeStatus`. Returns the mock so a test can read its calls.
 */
export function stubSnsFetch({ subscribeStatus = 200 }: { subscribeStatus?: number } = {}) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === CERT_URL) return new Response(SIGNING_PUBLIC_PEM, { status: 200 });
    if (url === SUBSCRIBE_URL)
      return new Response('<ConfirmSubscriptionResponse/>', { status: subscribeStatus });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
