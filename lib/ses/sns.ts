import { createVerify } from 'node:crypto';
import { SnsSignatureError, SnsSubscriptionConfirmError } from './errors';

// Amazon SNS HTTP(S) delivery (MOTIR-10565) — the leaf the SES notification
// route calls to turn a POST body into a TRUSTED message. SES publishes its
// bounce and complaint events to an SNS topic; the topic delivers each one to
// `POST /api/ses/webhook` as a JSON document that SNS signed.
//
// ⚠️ THE SCHEME IS SNS's, AND IT IS NEITHER GITHUB's NOR SVIX's. There is no
// shared secret. Every message carries an RSA signature over a canonical string
// built from its own fields, and the URL of the X.509 certificate whose key
// verifies it. Three rules make that safe, and each one closes a real attack:
//
//   1. THE CERTIFICATE URL MUST BE AN SNS HOST, over https. The URL travels in
//      the message itself, so a forger who could point it anywhere would simply
//      sign with their own key. AWS publishes the pattern:
//      `sns.<region>.amazonaws.com` (`.com.cn` in the China partitions).
//   2. THE SIGNED STRING IS REBUILT FROM THE FIELDS, in AWS's fixed order, per
//      message type — never taken from the body. A field the order omits
//      (`Subject` on a notification that has none) is omitted, not empty.
//   3. THE SUBSCRIBE URL IS HELD TO THE SAME HOST RULE before we GET it. The
//      confirmation is an outbound request to a URL a message named; checked
//      only by signature, it would still be a request to wherever AWS's signer
//      was asked to point it.
//
// Verification proves AWS SENT the message, not that it came from OUR topic:
// every topic is signed with the same key. The topic check is the service's,
// against `SES_NOTIFICATION_TOPIC_ARN` (`lib/services/sesNotificationService.ts`).
//
// Reference: AWS SNS Developer Guide, "Verifying the signatures of Amazon SNS
// messages" and "Parsing message formats".

/** SNS's own host, per partition. */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** How long a certificate or confirmation request may take before it is a failure. */
const SNS_REQUEST_TIMEOUT_MS = 5_000;

/** Certificates rotate rarely; a small cache keeps one fetch per URL per process. */
const CERTIFICATE_CACHE_LIMIT = 16;
const certificateCache = new Map<string, string>();

export type SnsMessageType =
  | 'Notification'
  | 'SubscriptionConfirmation'
  | 'UnsubscribeConfirmation';

/** The fields of an SNS HTTP delivery this module reads and verifies. */
export interface SnsMessage {
  Type: SnsMessageType;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1' | '2';
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  /** Present on the two confirmation types only. */
  SubscribeURL?: string;
  Token?: string;
}

const MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'Notification',
  'SubscriptionConfirmation',
  'UnsubscribeConfirmation',
]);

/** The fields every type signs, in AWS's canonical order. */
const SIGNED_FIELDS: Readonly<Record<SnsMessageType, readonly (keyof SnsMessage)[]>> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
  UnsubscribeConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * Read a parsed body as an SNS message, or throw {@link SnsSignatureError}. A
 * body missing a field its type signs cannot be verified, so it is refused the
 * way a bad signature is — not passed on half-read.
 */
export function parseSnsMessage(body: unknown): SnsMessage {
  if (body === null || typeof body !== 'object') throw new SnsSignatureError();
  const fields = body as Record<string, unknown>;
  const type = fields['Type'];
  if (typeof type !== 'string' || !MESSAGE_TYPES.has(type)) throw new SnsSignatureError();
  const version = fields['SignatureVersion'];
  if (version !== '1' && version !== '2') throw new SnsSignatureError();

  const required = ['MessageId', 'TopicArn', 'Message', 'Timestamp', 'Signature', 'SigningCertURL'];
  if (type !== 'Notification') required.push('SubscribeURL', 'Token');
  if (!required.every((name) => isNonEmptyString(fields[name]))) throw new SnsSignatureError();
  if (fields['Subject'] !== undefined && typeof fields['Subject'] !== 'string') {
    throw new SnsSignatureError();
  }
  return fields as unknown as SnsMessage;
}

/** The canonical string SNS signed: `Key\nValue\n` for each signed field present. */
export function snsStringToSign(message: SnsMessage): string {
  return SIGNED_FIELDS[message.Type]
    .filter((field) => message[field] !== undefined)
    .map((field) => `${field}\n${String(message[field])}\n`)
    .join('');
}

/** True when `raw` is an https URL on an SNS host, with no credentials or port. */
export function isSnsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    SNS_HOST.test(url.hostname)
  );
}

/** True when `raw` names a signing certificate on an SNS host. */
export function isSnsCertificateUrl(raw: string): boolean {
  return isSnsUrl(raw) && new URL(raw).pathname.endsWith('.pem');
}

async function fetchCertificate(url: string): Promise<string> {
  const cached = certificateCache.get(url);
  if (cached !== undefined) return cached;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(SNS_REQUEST_TIMEOUT_MS) });
  } catch {
    throw new SnsSignatureError();
  }
  if (!res.ok) throw new SnsSignatureError();
  const pem = await res.text();
  if (certificateCache.size >= CERTIFICATE_CACHE_LIMIT) certificateCache.clear();
  certificateCache.set(url, pem);
  return pem;
}

/** Drop every cached certificate. Tests only — a process never needs to. */
export function clearSnsCertificateCache(): void {
  certificateCache.clear();
}

/**
 * Verify an SNS message's signature. Returns on success; throws
 * {@link SnsSignatureError} when the certificate URL is not an SNS host, the
 * certificate cannot be fetched, or the signature does not verify.
 *
 * Version 1 signs with SHA1 and version 2 with SHA256 — a topic chooses which
 * (its `SignatureVersion` attribute), and both are still issued.
 */
export async function verifySnsMessage(message: SnsMessage): Promise<void> {
  if (!isSnsCertificateUrl(message.SigningCertURL)) throw new SnsSignatureError();
  const certificate = await fetchCertificate(message.SigningCertURL);
  const algorithm = message.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
  let valid: boolean;
  try {
    valid = createVerify(algorithm)
      .update(snsStringToSign(message), 'utf8')
      .verify(certificate, message.Signature, 'base64');
  } catch {
    // A body that is not a certificate or a key at all is a verification failure.
    valid = false;
  }
  if (!valid) throw new SnsSignatureError();
}

/**
 * Confirm a subscription by GETting the `SubscribeURL` SNS sent. The URL is
 * held to the SNS host rule first: it came out of a message, and an outbound
 * request to wherever a message says is the request a forger wants.
 */
export async function confirmSnsSubscription(message: SnsMessage): Promise<void> {
  const subscribeUrl = message.SubscribeURL;
  if (subscribeUrl === undefined || !isSnsUrl(subscribeUrl)) throw new SnsSignatureError();
  let res: Response;
  try {
    res = await fetch(subscribeUrl, { signal: AbortSignal.timeout(SNS_REQUEST_TIMEOUT_MS) });
  } catch (cause) {
    throw new SnsSubscriptionConfirmError(
      `Confirming the SNS subscription to ${message.TopicArn} failed before a response was received.`,
      { cause },
    );
  }
  if (!res.ok) {
    throw new SnsSubscriptionConfirmError(
      `Confirming the SNS subscription to ${message.TopicArn} was answered HTTP ${res.status}.`,
    );
  }
}
