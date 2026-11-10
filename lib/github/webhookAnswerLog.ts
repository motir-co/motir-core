// One log line for every non-2xx answer the GitHub webhook route gives (MOTIR-10804).
//
// A delivery the route turns away — a bad signature (401), an unconfigured secret (500),
// a malformed body or a missing delivery id (400), a sender that hung up (499) — never
// reaches the webhook inbox, so without this line it is indistinguishable from one GitHub
// never sent. GitHub does not retry a failed delivery; a person redelivers it from the
// App's Recent Deliveries BY ITS ID, so the id is what the line exists to carry.
//
// ⚠️ THE LINE NEVER CARRIES THE PAYLOAD OR THE SIGNATURE. The body of a refused delivery
// is unauthenticated input and may hold repository data; the signature is an HMAC over
// it. Only the headers GitHub sets to identify a delivery, and the body's LENGTH, are
// written.
//
// The fields are one JSON object after a fixed prefix, so a CloudWatch Logs Insights
// query can filter on the prefix and `parse` the object:
//   filter @message like '[github-webhook] non-2xx answer'
//   | parse @message '[github-webhook] non-2xx answer *' as answer

export const WEBHOOK_ANSWER_LOG_PREFIX = '[github-webhook] non-2xx answer';

/** What one non-2xx answer is logged with. */
export interface WebhookAnswerLogFields {
  /** The HTTP status the route answered. */
  status: number;
  /** The machine code in the answer's body. */
  code: string;
  /** The delivery's request headers — only `x-github-delivery` and `x-github-event` are read. */
  headers: Headers;
  /** The raw body's length in UTF-8 bytes, or `null` when the body was never read. */
  bodyBytes: number | null;
}

/** The single log line for a non-2xx webhook answer — payload- and signature-free. */
export function formatWebhookAnswerLog(fields: WebhookAnswerLogFields): string {
  const line = {
    status: fields.status,
    code: fields.code,
    deliveryId: fields.headers.get('x-github-delivery'),
    event: fields.headers.get('x-github-event'),
    bodyBytes: fields.bodyBytes,
  };
  return `${WEBHOOK_ANSWER_LOG_PREFIX} ${JSON.stringify(line)}`;
}

/** Writes the line — `console.error` for a 5xx (a server fault), `console.warn` otherwise. */
export function logWebhookAnswer(fields: WebhookAnswerLogFields): void {
  const line = formatWebhookAnswerLog(fields);
  if (fields.status >= 500) console.error(line);
  else console.warn(line);
}

/** The UTF-8 byte length of a raw body — what GitHub's `Content-Length` counted. */
export function bodyByteLength(rawBody: string): number {
  return Buffer.byteLength(rawBody, 'utf8');
}
