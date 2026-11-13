// Email-sending abstraction.
//
// Every caller in motir-core uses `sendEmail(...)` from this module. No
// caller imports a vendor SDK directly. That makes "which mailer to run in
// production" a per-project planner decision (Layer 2 — pre-plan work for
// each Motir-planned project), not a starter-baked assumption (Layer 1).
//
// v1 of motir-core ships THREE dev-grade providers:
//   - 'console' (default) — prints emails to stdout so dev/test flows can
//     grep the reset link. Tests in tests/password-reset.test.ts capture
//     it via a console.log spy.
//   - 'file'              — appends each email as a JSON line to the file
//     at EMAIL_OUTBOX_PATH (default /tmp/motir-test-emails.jsonl). Used
//     by the Playwright E2E suite, which can't reliably tap the dev
//     server's stdout from a separate test process. Dev/test only — the
//     file is unauthenticated, so this MUST NOT be selected in
//     production. Choosing it in NODE_ENV=production throws at module
//     load with a clear message.
//   - 'postmark' — a stub that throws a loud not-yet-implemented error if
//     selected. Real provider wiring is planner work for each Motir-planned
//     project's pre-plan phase.
//
// and ONE production provider (MOTIR-1127):
//   - 'resend'  — POSTs to the Resend HTTP API with the send-only key in
//     RESEND_API_KEY and the sender identity in EMAIL_FROM. Selected in
//     production via EMAIL_PROVIDER=resend; self-hosters leave it unset (or
//     point EMAIL_PROVIDER at their own arm) and nothing about their deploy
//     changes.
//
// and its successor (MOTIR-10565):
//   - 'ses'     — sends through Amazon SES (SESv2 `SendEmail`) with the SDK's
//     default credential chain (the ECS task role), the region in AWS_REGION,
//     the sender in EMAIL_FROM and the configuration set — which publishes the
//     bounce and complaint events `POST /api/ses/webhook` suppresses — in
//     SES_CONFIGURATION_SET. `resend` stays until production has switched.
//
// The provider is resolved eagerly at module-import time (see the
// `sendEmail` export at the bottom). An unknown EMAIL_PROVIDER value —
// or a 'resend' selection missing its credentials — therefore crashes the
// app at boot with a clear message, not on the first email two days into a
// deploy.

import { appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isE2EProdHarness } from '@/lib/e2eProdHarness';
import { createSesTransport, type SesTransport } from '@/lib/ses/sesClient';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * The per-send dedup key the `email.send` job already carries (the reset
   * token, the invite token). A provider that supports request-level
   * idempotency passes it through, so a job RETRY of the same send cannot
   * double-deliver AT THE PROVIDER — the engine's event-level dedup only
   * collapses duplicate EVENTS, not a retried attempt of one accepted event
   * whose response was lost in flight. Optional: the dev providers ignore it.
   */
  idempotencyKey?: string;
  /**
   * Extra headers to put on the wire, from the template's `RenderedEmail`
   * (Story 8.9 · Subtask 8.9.7). The only shipped use is the follower digest's
   * `List-Unsubscribe` pair. Providers that cannot carry custom headers ignore
   * them; the dev providers print them.
   */
  headers?: Record<string, string>;
}

/**
 * What a provider reports back about an ACCEPTED send.
 *
 * `providerMessageId` is the handle the provider gave the message — Resend's
 * `{ id }`. It is the ONLY key a later delivery event (`email.delivered`,
 * `email.bounced`) can be joined back to the send that produced it, which is
 * why it is kept rather than discarded (MOTIR-3513). It is NULLABLE on
 * purpose, and null is never an error:
 *   - the dev providers ('console', 'file') issue no id at all;
 *   - a real 2xx whose body does not parse, or carries no `id`, is still a
 *     message the provider has ACCEPTED. Turning that into a throw would
 *     re-deliver an already-accepted email on the job's next attempt.
 */
export interface EmailSendResult {
  providerMessageId: string | null;
}

/** The result a provider with no message-id concept returns. */
const NO_PROVIDER_MESSAGE_ID: EmailSendResult = { providerMessageId: null };

export type SendEmail = (msg: EmailMessage) => Promise<EmailSendResult>;

/**
 * How a failed send should be treated by the caller's retry machinery.
 * `transient` — the provider or the network blipped; the same request is
 * worth repeating. `permanent` — the provider rejected the request itself
 * (bad address, unverified domain, restricted key); repeating it changes
 * nothing, so the retry budget is only a delay before the dead-letter.
 * `quota_exhausted` — the provider's sending QUOTA for the day (or month) is
 * spent (MOTIR-5873). It clears only when the provider's window rolls over,
 * hours away, so the transient schedule's minutes-apart retries are each just
 * another request against an exhausted quota. It is the one kind that is NOT
 * retryable: the send dead-letters on its first attempt, under its own code.
 */
export type EmailFailureKind = 'transient' | 'permanent' | 'quota_exhausted';

/** The `code` a permanent failure carries onto the job's dead-letter row. */
export const EMAIL_PERMANENT_FAILURE_CODE = 'EMAIL_PERMANENT_FAILURE';
/** The `code` a transient failure carries onto the job's dead-letter row. */
export const EMAIL_TRANSIENT_FAILURE_CODE = 'EMAIL_TRANSIENT_FAILURE';
/** The `code` a spent provider quota carries onto the job's dead-letter row. */
export const EMAIL_QUOTA_EXHAUSTED_CODE = 'EMAIL_QUOTA_EXHAUSTED';

const FAILURE_CODE: Record<EmailFailureKind, string> = {
  transient: EMAIL_TRANSIENT_FAILURE_CODE,
  permanent: EMAIL_PERMANENT_FAILURE_CODE,
  quota_exhausted: EMAIL_QUOTA_EXHAUSTED_CODE,
};

/** How the dead-letter message names the kind — what an operator reads first. */
const FAILURE_PHRASE: Record<EmailFailureKind, string> = {
  transient: 'failed transiently',
  permanent: 'failed permanently',
  quota_exhausted: 'was refused because the provider quota is exhausted (not retried)',
};

/**
 * A provider send that failed, classified.
 *
 * Every kind THROWS: `lib/email.ts` is deliberately runtime-agnostic (the
 * ESLint boundary in `eslint.config.mjs` forbids it the Inngest SDK), so it
 * cannot reach for `NonRetriableError` and does not try to. What it does
 * instead is make the classification READABLE where an operator actually
 * meets it: `defineJob`'s `serializeFailure` copies `message`, `stack` and a
 * string `code` onto the `job_run_dlq` row, so a permanent failure
 * dead-letters as `EMAIL_PERMANENT_FAILURE` naming the status, the provider's
 * own error name and its message — not as an anonymous `fetch failed`.
 */
export class EmailDeliveryError extends Error {
  /** Retry-worthiness of this failure. */
  readonly kind: EmailFailureKind;
  /** Stable machine code — lands on the dead-letter row's `failure.code`. */
  readonly code: string;
  /** The provider's HTTP status, when the failure came back as a response. */
  readonly status: number | undefined;
  /** The provider's own error name (Resend's `name` field), when it sent one. */
  readonly providerErrorName: string | undefined;
  /**
   * `false` tells the job worker to dead-letter NOW instead of spending the
   * rest of the retry budget (`isNonRetryableFailure`, lib/jobs/engine/worker.ts).
   * A property rather than a class the engine imports, because this module may
   * not reach the engine (the ESLint boundary above) and the engine may not
   * know about email. Only `quota_exhausted` sets it: a `permanent` failure
   * keeps its existing budget, which this card deliberately does not change.
   */
  readonly retryable: boolean;

  constructor(
    kind: EmailFailureKind,
    message: string,
    details: { status?: number; providerErrorName?: string; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'EmailDeliveryError';
    this.kind = kind;
    this.code = FAILURE_CODE[kind];
    this.retryable = kind !== 'quota_exhausted';
    this.status = details.status;
    this.providerErrorName = details.providerErrorName;
  }
}

// Strips HTML tags from a body for the plain-text fallback. Intentionally
// dumb — the console provider prints whichever body the caller passed; this
// only kicks in when a caller skipped `text`. Real providers should be given
// both an html and a text body by the caller, so this fallback is mostly a
// dev-console nicety.
//
// The strips repeat until nothing changes, because one pass over
// `<scr<script></script>ipt>` leaves a `<script>` behind (MOTIR-7816), and the
// entities decode in ONE pass, so `&amp;lt;` becomes `&lt;` and not `<`.
export function htmlToText(html: string): string {
  const withoutBlocks = stripUntilStable(html, /<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi);
  // Surface anchor hrefs inline ("text (url)") so reset links remain
  // grep-able when a caller passes only html. Critical for the
  // console-provider's "tests can read the link off stdout" promise.
  const withLinks = withoutBlocks.replace(
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, inner) => `${stripUntilStable(String(inner), /<[^>]+>/g).trim()} (${href})`,
  );
  return stripUntilStable(withLinks, /<[^>]+>/g)
    .replace(/&(nbsp|amp|lt|gt);/g, (_, name: string) => HTML_ENTITIES[name] ?? '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const HTML_ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>' };

function stripUntilStable(input: string, pattern: RegExp): string {
  let previous: string;
  let current = input;
  do {
    previous = current;
    current = current.replace(pattern, '');
  } while (current !== previous);
  return current;
}

const consoleProvider: SendEmail = async (msg) => {
  const body = msg.text ?? htmlToText(msg.html);
  // The reset link MUST appear unredacted so dev/test flows can grep it.
  // (Better-Auth's password-reset flow puts the token in the URL body of
  // the email; tests in tests/password-reset.test.ts capture this stdout.)
  // eslint-disable-next-line no-console -- console is the entire point of this provider
  console.log(`[EMAIL] To: ${msg.to} Subject: ${msg.subject}\n${body}`);
  return NO_PROVIDER_MESSAGE_ID;
};

function unimplementedProvider(name: string): SendEmail {
  return async () => {
    throw new Error(
      `Email provider '${name}' is not yet implemented in motir-core. ` +
        `Production providers are planner work for each Motir-planned project's ` +
        `pre-plan phase — see lib/email.ts and the Story 1.1 decisions log. ` +
        `Set EMAIL_PROVIDER=console for local dev.`,
    );
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The production provider: Resend (MOTIR-1127).
//
// Provisioned by MOTIR-1123: the `motir.co` sending domain is authenticated
// (SPF + DKIM + DMARC) in Resend's us-east-1 region, and the three values
// below are Fly secrets on the `motir-core` app — RESEND_API_KEY (send-only
// scope), EMAIL_FROM, EMAIL_PROVIDER. Nothing here is hardcoded to that
// vendor account: a self-hoster points the same three env vars at their own
// Resend workspace, or leaves EMAIL_PROVIDER unset and keeps 'console'.
//
// Talked to over plain `fetch`, not the vendor SDK. The API is one POST with
// a JSON body; an SDK would add a dependency, a second retry layer competing
// with Inngest's, and a mocking surface, for nothing.
//
// SEND-ONLY BY DESIGN. The provisioned key is scoped to sending: a GET to
// /emails/{id} comes back 401 `restricted_api_key` (observed on the live key,
// recorded on MOTIR-1123). So this module POSTs and never reads back — the
// message id in the 200 response is the only receipt we get, and the job's
// own ledger row is where delivery is recorded.
// ─────────────────────────────────────────────────────────────────────────

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Resend rejects a key outside 1–256 chars with 400 `invalid_idempotency_key`. */
const RESEND_IDEMPOTENCY_KEY_MAX_LENGTH = 256;

/** Resend error names on 409 that a retry CAN clear (the key is mid-flight). */
const RESEND_RETRYABLE_CONFLICTS = new Set(['concurrent_idempotent_requests']);

/**
 * Resend error names on 429 that mean the account's sending QUOTA is spent,
 * not that we are sending too fast. Both come back on the same status as
 * `rate_limit_exceeded`, so the NAME is the only thing that tells them apart.
 * `daily_quota_exceeded` is the one production has actually returned (277
 * dead letters, 2026-09-14..15, MOTIR-5844); `monthly_quota_exceeded` is its
 * documented sibling and clears on an even longer clock.
 */
const RESEND_QUOTA_EXHAUSTED = new Set(['daily_quota_exceeded', 'monthly_quota_exceeded']);

/**
 * Where to set each production arm's variables, for its boot refusal. Resend's
 * secrets, like SES's settings, run on ECS, where the task definition's
 * environment and secrets (from AWS Secrets Manager) carry them.
 */
const PROVIDER_ENV_HINT: Record<'resend' | 'ses', (name: string) => string> = {
  resend: (name) =>
    `Set it on the deployment alongside RESEND_API_KEY and EMAIL_FROM ` +
    `(on ECS: ${name} in the task definition's secrets, from AWS Secrets Manager; locally: .env.local). `,
  ses: () =>
    `Set it on the deployment alongside AWS_REGION, EMAIL_FROM and SES_CONFIGURATION_SET ` +
    `(on ECS: the task definition's environment; locally: .env.local). `,
};

/**
 * Read a required env var or throw a message that says what to set and where.
 * Called during provider RESOLUTION, which is module load (see `sendEmail`
 * below) — so a production deploy that selects `resend` or `ses` without its
 * configuration fails at boot, loudly, instead of on the first password reset.
 */
function requireEmailEnv(provider: 'resend' | 'ses', name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `EMAIL_PROVIDER='${provider}' requires ${name}, which is unset or empty. ` +
        PROVIDER_ENV_HINT[provider](name) +
        `Set EMAIL_PROVIDER=console for local dev if you don't want to send real email.`,
    );
  }
  return value;
}

/**
 * The value for Resend's `Idempotency-Key` header, derived from the SAME key
 * the `email.send` event carries — so a job retry of an already-accepted send
 * is deduped at the provider, not just at Inngest's event boundary.
 *
 * Two guards, both about the 1–256-char limit rather than about secrecy: an
 * absent/blank key means "no header" (the dev providers and any future
 * non-job caller pass nothing), and an over-long key is folded to its SHA-256
 * hex. Folding keeps the mapping stable and collision-free in practice, so
 * two retries of one send still agree on a key — which is the whole point.
 * Truncating instead would make two DIFFERENT long keys collide and silently
 * drop a real email as a duplicate.
 */
export function resendIdempotencyKey(key: string | undefined): string | undefined {
  const trimmed = key?.trim();
  if (trimmed === undefined || trimmed === '') return undefined;
  if (trimmed.length <= RESEND_IDEMPOTENCY_KEY_MAX_LENGTH) return trimmed;
  return createHash('sha256').update(trimmed).digest('hex');
}

/** Resend's error envelope, as much of it as we depend on. */
interface ResendErrorBody {
  name?: unknown;
  message?: unknown;
}

/**
 * Classify a non-2xx response. Quota: a 429 whose NAME says the account's
 * quota is spent — checked first, because it shares the status with a plain
 * rate limit and must not fall into that arm. Transient: 408, every other 429
 * and every 5xx (the provider or the hop between us is unhealthy), plus the
 * 409 that says our own key is still in flight. Everything else the provider
 * returned is a considered rejection of THIS request — a malformed address,
 * an unverified sender domain, a key without send scope — and repeating it
 * just delays the dead-letter.
 */
export function classifyResendStatus(
  status: number,
  providerErrorName: string | undefined,
): EmailFailureKind {
  if (
    status === 429 &&
    providerErrorName !== undefined &&
    RESEND_QUOTA_EXHAUSTED.has(providerErrorName)
  ) {
    return 'quota_exhausted' as const;
  }
  if (status >= 500) return 'transient' as const;
  if (status === 429 || status === 408) return 'transient' as const;
  if (
    status === 409 &&
    providerErrorName !== undefined &&
    RESEND_RETRYABLE_CONFLICTS.has(providerErrorName)
  ) {
    return 'transient' as const;
  }
  return 'permanent' as const;
}

/** Best-effort read of the error envelope; a non-JSON body must not mask the status. */
async function readResendError(res: Response): Promise<ResendErrorBody> {
  try {
    const raw = await res.text();
    if (raw.trim() === '') return {};
    return JSON.parse(raw) as ResendErrorBody;
  } catch {
    return {};
  }
}

// Read Resend's message id out of an ACCEPTED response.
//
// Guarded exactly the way `readResendError` guards the failure body, and for a
// sharper reason: by the time we are here the provider has already taken the
// message. A body that is empty, unparseable, or carries no string `id` is a
// SUCCESSFUL send we simply have no handle for — so it yields null and the
// delivery row records the send with a null id. It must never throw: the send
// path is shared by nine transactional flows, and a parse error escaping here
// would fail a job whose email is already on its way and re-deliver it on the
// retry.
async function readResendMessageId(res: Response): Promise<string | null> {
  try {
    const raw = await res.text();
    if (raw.trim() === '') return null;
    const body = JSON.parse(raw) as { id?: unknown };
    return typeof body.id === 'string' && body.id !== '' ? body.id : null;
  } catch {
    return null;
  }
}

function resendProvider(): SendEmail {
  // Eager: both reads happen at resolution, so the boot fails, not the send.
  const apiKey = requireEmailEnv('resend', 'RESEND_API_KEY');
  const from = requireEmailEnv('resend', 'EMAIL_FROM');

  return async (msg) => {
    const idempotencyKey = resendIdempotencyKey(msg.idempotencyKey);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    // Only send the header when we actually have a key — an empty one is a 400.
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;

    let res: Response;
    try {
      res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          // Always send a text part: templates hand-write one (CLAUDE.md), and
          // the stripped fallback keeps a caller that skipped it out of the
          // spam-scoring penalty an html-only message earns.
          text: msg.text ?? htmlToText(msg.html),
          // Resend takes per-message headers as a body field, NOT as request
          // headers — putting `List-Unsubscribe` on the HTTP request would set
          // it on the API call rather than on the mail.
          ...(msg.headers ? { headers: msg.headers } : {}),
        }),
      });
    } catch (cause) {
      // No response at all — DNS, TLS, socket, timeout. Always worth a retry.
      throw new EmailDeliveryError(
        'transient',
        `Resend send to '${msg.to}' failed before a response was received: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }

    if (res.ok) return { providerMessageId: await readResendMessageId(res) };

    const body = await readResendError(res);
    const providerErrorName = typeof body.name === 'string' ? body.name : undefined;
    const providerMessage = typeof body.message === 'string' ? body.message : undefined;
    const kind = classifyResendStatus(res.status, providerErrorName);
    throw new EmailDeliveryError(
      kind,
      `Resend send to '${msg.to}' ${FAILURE_PHRASE[kind]} with HTTP ${res.status}` +
        `${providerErrorName === undefined ? '' : ` (${providerErrorName})`}` +
        `${providerMessage === undefined ? '' : `: ${providerMessage}`}`,
      {
        status: res.status,
        ...(providerErrorName === undefined ? {} : { providerErrorName }),
      },
    );
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The Amazon SES provider (MOTIR-10565).
//
// Selected by EMAIL_PROVIDER=ses. The SDK call itself lives in
// `lib/ses/sesClient.ts`, the only module allowed the SES SDK; everything that
// decides what is sent and what a failure means lives here, beside Resend's, so
// both production arms answer the job engine in one vocabulary.
//
// Three variables, all read at RESOLUTION so a deployment missing one fails its
// boot naming it — the same contract as Resend's key:
//   - AWS_REGION            — the SES region the sending identity is verified
//                             in. ECS sets it on every task.
//   - EMAIL_FROM            — the sender identity, a verified SES identity.
//   - SES_CONFIGURATION_SET — the configuration set every message is sent
//                             under. It is what publishes bounce and complaint
//                             events to SNS, so a send without it is a send
//                             whose bounces nobody hears about — which is why
//                             it is required rather than optional.
// Credentials are NOT a variable: the SDK's default chain resolves the task
// role.
//
// ⚠️ NO IDEMPOTENCY KEY REACHES SES. SESv2 `SendEmail` takes none, so the
// `idempotencyKey` a Resend send passes through is not used here; a job retry
// of a send SES had already accepted delivers twice. The SDK makes one attempt
// (`sesClient.ts`) so it adds no retries of its own on top.
// ─────────────────────────────────────────────────────────────────────────

/**
 * SES error names that mean the account's sending QUOTA is spent. Exceeding
 * the 24-hour quota comes back as `LimitExceededException` ("Daily message
 * quota exceeded"); it clears only when the rolling window does, so retrying
 * minutes apart is just more requests against an exhausted quota.
 */
const SES_QUOTA_EXHAUSTED = new Set(['LimitExceededException']);

/** SES error names a retry can clear: the send RATE, not the quota, was exceeded. */
const SES_TRANSIENT = new Set(['TooManyRequestsException', 'ThrottlingException']);

/** What the SDK's service exceptions carry, as much of it as we depend on. */
interface SesErrorShape {
  name?: unknown;
  message?: unknown;
  $fault?: unknown;
  $metadata?: { httpStatusCode?: unknown } | null;
}

/**
 * Classify an error the SES SDK threw. An error with no `$metadata` never got a
 * response — DNS, TLS, socket, timeout, or a credential lookup that failed —
 * and is always worth a retry. Then the quota, which must be checked before the
 * throttle arm because both are limits: a message saying the daily quota is
 * exceeded is a spent quota under any name. Then the send-rate throttle and
 * every server-side fault. Everything else — an unverified sender, a rejected
 * message, a configuration set that does not exist, a paused or suspended
 * account — is a considered rejection of this request, and repeating it only
 * delays the dead-letter.
 */
export function classifySesError(err: unknown): EmailFailureKind {
  const shape = (err ?? {}) as SesErrorShape;
  if (shape.$metadata === undefined || shape.$metadata === null) return 'transient';
  const name = typeof shape.name === 'string' ? shape.name : '';
  const message = typeof shape.message === 'string' ? shape.message : '';
  if (SES_QUOTA_EXHAUSTED.has(name) || /daily message quota exceeded/i.test(message)) {
    return 'quota_exhausted';
  }
  if (SES_TRANSIENT.has(name)) return 'transient';
  const status = shape.$metadata.httpStatusCode;
  if (shape.$fault === 'server' || (typeof status === 'number' && status >= 500)) {
    return 'transient';
  }
  return 'permanent';
}

/** The `Content.Simple` body of a SESv2 send: subject, both parts, any headers. */
function sesContent(msg: EmailMessage) {
  const headers = Object.entries(msg.headers ?? {}).map(([Name, Value]) => ({ Name, Value }));
  return {
    Simple: {
      Subject: { Data: msg.subject, Charset: 'UTF-8' },
      Body: {
        Html: { Data: msg.html, Charset: 'UTF-8' },
        // Always a text part, for the reason Resend's arm sends one.
        Text: { Data: msg.text ?? htmlToText(msg.html), Charset: 'UTF-8' },
      },
      // SES puts these on the MAIL — the follower digest's List-Unsubscribe pair.
      ...(headers.length > 0 ? { Headers: headers } : {}),
    },
  };
}

/**
 * The `ses` arm. `transport` is injectable so the send can be exercised without
 * the network; production resolves the real one from AWS_REGION.
 */
export function sesProvider(
  createTransport: (region: string) => SesTransport = createSesTransport,
): SendEmail {
  // Eager: every read happens at resolution, so the boot fails, not the send.
  const region = requireEmailEnv('ses', 'AWS_REGION');
  const from = requireEmailEnv('ses', 'EMAIL_FROM');
  const configurationSetName = requireEmailEnv('ses', 'SES_CONFIGURATION_SET');
  const transport = createTransport(region);

  return async (msg) => {
    let messageId: string | undefined;
    try {
      const out = await transport.sendEmail({
        FromEmailAddress: from,
        Destination: { ToAddresses: [msg.to] },
        Content: sesContent(msg),
        ConfigurationSetName: configurationSetName,
      });
      messageId = out.MessageId;
    } catch (cause) {
      const kind = classifySesError(cause);
      const shape = (cause ?? {}) as SesErrorShape;
      const providerErrorName = typeof shape.name === 'string' ? shape.name : undefined;
      const status = shape.$metadata?.httpStatusCode;
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new EmailDeliveryError(
        kind,
        `SES send to '${msg.to}' ${FAILURE_PHRASE[kind]}` +
          `${typeof status === 'number' ? ` with HTTP ${status}` : ''}` +
          `${providerErrorName === undefined ? '' : ` (${providerErrorName})`}: ${detail}`,
        {
          cause,
          ...(typeof status === 'number' ? { status } : {}),
          ...(providerErrorName === undefined ? {} : { providerErrorName }),
        },
      );
    }
    // An accepted send with no id is still accepted — the same rule as Resend's.
    return {
      providerMessageId: typeof messageId === 'string' && messageId !== '' ? messageId : null,
    };
  };
}

// Dev-only file provider. Appends each email as a single JSON line to the
// path in EMAIL_OUTBOX_PATH (defaults to /tmp/motir-test-emails.jsonl).
// Playwright E2E specs subscribe to this file to read the reset link —
// the dev server's stdout isn't reliably tappable from a separate test
// process, but a file on disk is.
//
// Atomicity: Node's fs.appendFile opens the file with O_APPEND, so even
// if multiple concurrent emails are flushing at once the OS guarantees
// each line-sized write lands intact (POSIX guarantees writes ≤ PIPE_BUF
// against an O_APPEND fd are atomic; a single 1–2KB JSON line is well
// inside that). No external lockfile needed.
//
// Trailing newline is REQUIRED — readers split on `\n`, so a missing
// final newline would silently drop the last email.
//
// SECURITY: the outbox file is unauthenticated and world-readable by
// whatever process started the dev server. Refusing to enable this
// provider in production keeps the contract obvious: 'file' is a test
// harness, not a deliverability path.
function fileProvider(): SendEmail {
  // Refused in real production, but ALLOWED under the E2E production harness
  // (MOTIR-1679): that runs a `next start` build, which forces
  // NODE_ENV=production even though it is the test suite writing to the file
  // outbox the specs poll. isE2EProdHarness() is only ever true for the E2E
  // webServer, never a real deploy.
  if (process.env['NODE_ENV'] === 'production' && !isE2EProdHarness()) {
    throw new Error(
      `Email provider 'file' is not allowed in production. ` +
        `It is a test-only sink that writes emails to a local file. ` +
        `Set EMAIL_PROVIDER to a real provider (or 'console' for dev).`,
    );
  }
  const path = process.env['EMAIL_OUTBOX_PATH'] ?? '/tmp/motir-test-emails.jsonl';
  return async (msg) => {
    const line =
      JSON.stringify({
        to: msg.to,
        subject: msg.subject,
        text: msg.text ?? htmlToText(msg.html),
        html: msg.html,
        sentAt: new Date().toISOString(),
      }) + '\n';
    await appendFile(path, line, { encoding: 'utf8' });
    return NO_PROVIDER_MESSAGE_ID;
  };
}

// Dev/test-only deterministic fault injector. Wraps whichever provider is
// resolved so a Playwright spec can make a send FAIL on demand — the only way
// to exercise the real Story-1.6 failure path (provider throws → job retries →
// dead-letters → operator replays) end-to-end through the running stack
// (Subtask 1.6.6).
//
// Cross-process by design. The Playwright runner and the Next dev server are
// SEPARATE processes, so an in-memory flag can't reach the provider running in
// the server. We reuse the same channel the file outbox already relies on — a
// file on disk: the test writes a recipient SUBSTRING into the file at
// EMAIL_FAULT_PATH to arm the fault, and deletes the file to disarm it. The
// provider reads the file on every send and throws iff the file exists and its
// content is a (case-insensitive) substring of `msg.to`.
//
// Per-recipient, not global. Because the trigger is the RECIPIENT matching the
// armed substring (not a blanket "fail everything" switch), only the spec's
// chosen forced-failure address fails; every other email in the same dev
// server keeps flowing. Combined with the file's set/clear lifecycle being
// owned by the spec, the fault scope is per-spec, never global.
//
// Off unless explicitly armed. The wrapper is a no-op unless EMAIL_FAULT_PATH
// is set, so production and ordinary dev never pay for it. Setting it in
// production is refused at module load — like the 'file' provider, this is a
// test harness and must never ship as a deliverability path.
function withFaultInjection(provider: SendEmail): SendEmail {
  const faultPath = process.env['EMAIL_FAULT_PATH'];
  if (faultPath === undefined || faultPath === '') return provider;
  // Refused in real production, allowed under the E2E production harness — same
  // rationale as fileProvider() above (MOTIR-1679).
  if (process.env['NODE_ENV'] === 'production' && !isE2EProdHarness()) {
    throw new Error(
      `EMAIL_FAULT_PATH is set in production. It is a test-only deterministic ` +
        `email-fault injector and must never be enabled in production. Unset it.`,
    );
  }
  return async (msg) => {
    // Read the armed pattern fresh on every send so the test can arm/disarm it
    // mid-run (the forced-failure path arms it, the replay path clears it).
    let pattern: string | null = null;
    try {
      pattern = (await readFile(faultPath, 'utf8')).trim();
    } catch (err) {
      // No file → fault disarmed. Any other error is a real problem.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (pattern && msg.to.toLowerCase().includes(pattern.toLowerCase())) {
      // A typed-ish provider failure: the email.send job surfaces this as a
      // retried run, then a DLQ entry once the retry budget is spent.
      throw new Error(
        `Injected email-delivery fault: send to '${msg.to}' failed deterministically ` +
          `(matched armed pattern '${pattern}' at EMAIL_FAULT_PATH).`,
      );
    }
    return provider(msg);
  };
}

/**
 * WHICH provider is configured, by name. Recorded on the delivery row
 * (MOTIR-3513), because a null `providerMessageId` means something different
 * per provider: for 'console' / 'file' it is simply how those providers work,
 * while for 'resend' it means the accepted response carried no parseable id.
 */
export function emailProviderName(): string {
  return process.env['EMAIL_PROVIDER'] ?? 'console';
}

export function getEmailProvider(): SendEmail {
  const provider = emailProviderName();
  switch (provider) {
    case 'console':
      return consoleProvider;
    case 'file':
      return fileProvider();
    case 'resend':
      return resendProvider();
    case 'ses':
      return sesProvider();
    case 'postmark':
      return unimplementedProvider('postmark');
    default:
      throw new Error(
        `Unknown EMAIL_PROVIDER='${provider}'. ` +
          `Valid values: 'console' (default), 'file' (dev/test only), 'resend', 'ses', 'postmark'. ` +
          `See lib/email.ts for the abstraction.`,
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// The NOTIFICATION budget (MOTIR-5873).
//
// Every template shares ONE provider account and so ONE sending quota. On
// 2026-09-14 a burst of watcher notifications spent Resend's daily quota and
// 277 sends dead-lettered — and a password reset asked for that day would
// have been refused the same way. The budget is how many NOTIFICATION-class
// sends (watchers, mentions, subscriptions, digests — `emailService`'s
// template classes) may be accepted in any rolling 24 hours. Past it,
// notifications are skipped and the rest of the quota stays for the mail a
// person is waiting on: password reset, email change, invites, sign-in codes.
//
// ⚠️ IT APPLIES TO THE `resend` ARM ONLY (MOTIR-10565). The cap exists because
// of Resend's FREE plan; Amazon SES has no free-plan cap, and its own quota is
// raised by request rather than by plan. So under every other provider — `ses`,
// and the dev providers — there is no budget and the variable is not read.
//
// EMAIL_NOTIFICATION_DAILY_BUDGET (read only when EMAIL_PROVIDER=resend):
//   - unset      → 60. 60 sits
//                  under the Resend FREE plan's 100/day — the only Resend plan
//                  with a DAILY quota, which is what `daily_quota_exceeded`
//                  proves production is on — leaving 40/day for essential
//                  mail, and 60 × 30 = 1,800 stays inside the plan's
//                  3,000/month with the same margin.
//   - an integer ≥ 0 → that many (0 = no notification email at all).
//   - `none`     → no budget (a paid plan with no daily quota).
// Anything else throws at module load, like a bad EMAIL_PROVIDER does.
// ─────────────────────────────────────────────────────────────────────────

/** The default when a Resend deployment sets no budget — see the block above. */
export const DEFAULT_RESEND_NOTIFICATION_DAILY_BUDGET = 60;

/**
 * The notification budget per rolling 24 hours, or `null` for none. Read
 * fresh on every call (tests re-point the env), and once at module load
 * below so a malformed value fails the boot, not the first watcher email.
 */
export function getNotificationDailyBudget(): number | null {
  if (emailProviderName() !== 'resend') return null;
  const raw = process.env['EMAIL_NOTIFICATION_DAILY_BUDGET']?.trim();
  if (raw === undefined || raw === '') return DEFAULT_RESEND_NOTIFICATION_DAILY_BUDGET;
  if (raw.toLowerCase() === 'none') return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `EMAIL_NOTIFICATION_DAILY_BUDGET='${raw}' is not a non-negative integer or 'none'. ` +
        `It caps notification email per rolling 24 hours so password-reset mail keeps ` +
        `headroom under the provider's quota — see lib/email.ts.`,
    );
  }
  return Number.parseInt(raw, 10);
}

getNotificationDailyBudget();

export const sendEmail: SendEmail = withFaultInjection(getEmailProvider());
