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
//   1. THE CERTIFICATE COMES FROM OUR TOPIC'S OWN SNS HOST, over https. The
//      certificate URL travels in the message itself, so a forger who could
//      point it anywhere would simply sign with their own key. The HOST is
//      never taken from the message at all: it is derived from the CONFIGURED
//      topic ARN (`snsHostForTopic`, `sns.<region>.amazonaws.com`, `.com.cn` in
//      the China partition), and the message's URL must name exactly that host
//      and a `SimpleNotificationService-….pem` path, which is all we take
//      from it.
//   2. THE SIGNED STRING IS REBUILT FROM THE FIELDS, in AWS's fixed order, per
//      message type — never taken from the body. A field the order omits
//      (`Subject` on a notification that has none) is omitted, not empty.
//   3. THE CONFIRMATION REQUEST IS OURS, NOT THE MESSAGE'S. We do not GET the
//      `SubscribeURL` a message names — an outbound request to a URL a message
//      chose is the request a forger wants. We call SNS's
//      `ConfirmSubscription` action on our own host, for our own topic, with
//      the message's `Token` as a query value: the request that URL makes,
//      built from parts we chose.
//
// Verification proves AWS SENT the message, not that it came from OUR topic:
// every topic is signed with the same key. The topic check is the service's,
// against `SES_NOTIFICATION_TOPIC_ARN` (`lib/services/sesNotificationService.ts`),
// and it runs BEFORE this module makes any request.
//
// Reference: AWS SNS Developer Guide, "Verifying the signatures of Amazon SNS
// messages" and "Parsing message formats".

/**
 * A topic ARN: `arn:<partition>:sns:<region>:<account>:<name>`. The region is
 * held to AWS's own grammar (`eu-west-1`, `us-gov-west-1`, `cn-north-1`), so
 * the host built from it can only ever be an SNS endpoint.
 */
const TOPIC_ARN =
  /^arn:(aws|aws-cn|aws-us-gov):sns:([a-z]{2}(?:-[a-z]+)+-\d{1,2}):\d{12}:[A-Za-z0-9_-]{1,256}$/;

/** The path SNS serves its signing certificates at. */
const CERTIFICATE_PATH = /^\/SimpleNotificationService-[A-Za-z0-9]{1,64}\.pem$/;

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

/**
 * The SNS host that serves the topic `topicArn`, or null when it is not an SNS
 * topic ARN. Called with the CONFIGURED topic, never a message's: it is what
 * keeps the host of every request this module makes out of the message.
 */
export function snsHostForTopic(topicArn: string): string | null {
  const match = TOPIC_ARN.exec(topicArn);
  if (match === null) return null;
  const [, partition, region] = match;
  return `sns.${region}.amazonaws.com${partition === 'aws-cn' ? '.cn' : ''}`;
}

/**
 * The certificate path of `raw` when it is an https URL on exactly `host`,
 * with no credentials, port, query or fragment and a certificate path — or
 * null. The path is the only part of the message's URL a request uses.
 */
export function snsCertificatePath(raw: string, host: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const ok =
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.hostname === host &&
    CERTIFICATE_PATH.test(url.pathname);
  return ok ? url.pathname : null;
}

async function fetchCertificate(host: string, path: string): Promise<string> {
  // The literal `/` after the host keeps the message's path a PATH: nothing it
  // holds can reach the authority (the path is also held to CERTIFICATE_PATH).
  const url = `https://${host}/${path.slice(1)}`;
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
 * Verify an SNS message's signature against the certificate served by `host` —
 * the configured topic's SNS host (`snsHostForTopic`). Returns on success;
 * throws {@link SnsSignatureError} when the certificate URL is not a
 * certificate on that host, the certificate cannot be fetched, or the
 * signature does not verify.
 *
 * Version 1 signs with SHA1 and version 2 with SHA256 — a topic chooses which
 * (its `SignatureVersion` attribute), and both are still issued.
 */
export async function verifySnsMessage(message: SnsMessage, host: string): Promise<void> {
  const path = snsCertificatePath(message.SigningCertURL, host);
  if (path === null) throw new SnsSignatureError();
  const certificate = await fetchCertificate(host, path);
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
 * Confirm a subscription to `topicArn` on `host` with the message's token —
 * SNS's `ConfirmSubscription` action, which is the request the message's
 * `SubscribeURL` encodes, built here from our own topic and host rather than
 * fetched from wherever the message points.
 */
export async function confirmSnsSubscription(
  message: SnsMessage,
  topicArn: string,
  host: string,
): Promise<void> {
  const token = message.Token;
  if (token === undefined || token === '') throw new SnsSignatureError();
  const query = new URLSearchParams({
    Action: 'ConfirmSubscription',
    TopicArn: topicArn,
    Token: token,
  });
  let res: Response;
  try {
    res = await fetch(`https://${host}/?${query.toString()}`, {
      signal: AbortSignal.timeout(SNS_REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new SnsSubscriptionConfirmError(
      `Confirming the SNS subscription to ${topicArn} failed before a response was received.`,
      { cause },
    );
  }
  if (!res.ok) {
    throw new SnsSubscriptionConfirmError(
      `Confirming the SNS subscription to ${topicArn} was answered HTTP ${res.status}.`,
    );
  }
}
