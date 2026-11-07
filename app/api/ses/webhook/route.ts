import { NextResponse, type NextRequest } from 'next/server';
import { parseSnsMessage } from '@/lib/ses/sns';
import {
  SesNotificationsNotConfiguredError,
  SnsSignatureError,
  SnsSubscriptionConfirmError,
  SnsTopicNotAllowedError,
} from '@/lib/ses/errors';
import { sesNotificationService } from '@/lib/services/sesNotificationService';

// POST /api/ses/webhook (MOTIR-10565) — Amazon SNS's HTTPS delivery of the SES
// configuration set's bounce and complaint events. A permanent bounce or a
// complaint adds the address to the suppression list every send reads first.
//
// HTTP-only (CLAUDE.md 4-layer): this route parses the body and dispatches to
// ONE service method; ALL logic — the topic check, then the SNS signature, then
// the suppression — lives in `sesNotificationService`. The status map is the sibling webhook's
// (`app/api/resend/webhook/route.ts`) with the cases SNS adds:
//
//   malformed JSON → 400 · bad signature → 401 · another topic → 403 ·
//   no topic configured → 500 · subscription confirmation failed → 502 ·
//   everything else, including events that change nothing → 200.
//
// SNS signs FIELDS, not bytes, so unlike Resend's HMAC the body is parsed
// first and the signed string is rebuilt from it (`lib/ses/sns.ts`). SNS posts
// with `Content-Type: text/plain`, which is why the body is read as text.

export async function POST(req: NextRequest): Promise<Response> {
  const rawBody = await req.text();

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ code: 'SES_NOTIFICATION_MALFORMED_BODY' }, { status: 400 });
  }

  try {
    const message = parseSnsMessage(body);
    const result = await sesNotificationService.handleMessage(message);
    return NextResponse.json({ ok: true, result }, { status: 200 });
  } catch (err) {
    if (err instanceof SnsSignatureError) {
      return NextResponse.json({ code: err.code }, { status: 401 });
    }
    if (err instanceof SnsTopicNotAllowedError) {
      return NextResponse.json({ code: err.code }, { status: 403 });
    }
    if (err instanceof SesNotificationsNotConfiguredError) {
      return NextResponse.json({ code: err.code }, { status: 500 });
    }
    if (err instanceof SnsSubscriptionConfirmError) {
      console.error(`[ses-notification] ${err.message}`);
      return NextResponse.json({ code: err.code }, { status: 502 });
    }
    throw err;
  }
}
