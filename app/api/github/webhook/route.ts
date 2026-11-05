import { NextResponse, type NextRequest } from 'next/server';
import { CLIENT_CLOSED_REQUEST_STATUS, readRawBodyUnlessAborted } from '@/lib/api/clientAbort';
import { verifyGithubWebhookSignature } from '@/lib/github/webhookSignature';
import { GithubWebhookNotConfiguredError, GithubWebhookSignatureError } from '@/lib/github/errors';
import { githubWebhookInboxService } from '@/lib/services/githubWebhookInboxService';

// POST /api/github/webhook (Story 7.10 · MOTIR-892) — the inbound GitHub App
// webhook: PR lifecycle → work-item status sync, CI feedback, the installation
// grant mirror and the rest of `githubWebhookService.handleEvent`. HTTP-only
// (CLAUDE.md 4-layer): this route verifies the signature and hands the delivery
// to ONE service method.
//
// Signature verification FIRST, over the RAW body, BEFORE any parse: an
// unauthentic delivery is rejected 401 and nothing is stored or processed.
//
// ⚠️ IT ANSWERS BEFORE THE WORK RUNS (Bug MOTIR-10425). GitHub waits ten seconds
// for the response headers, records a slower delivery as failed, and does NOT
// retry it — a failed delivery is redelivered only by a person, from the App's
// Recent Deliveries. So the route stores the verified delivery in the webhook
// inbox and answers 202; the `system.github-webhook-delivery` job processes it
// afterwards, and retries it if processing throws. An event Motir does not act on
// (`ping`, …) is answered 200 `ignored` and stored nowhere.
//
// Never leak internals: a bad/missing signature → 401, an unconfigured secret →
// 500, a malformed JSON body → 400, a handled event with no `X-GitHub-Delivery`
// GUID → 400, a sender that hung up before the body was read → 499 and a warning,
// never a thrown `Error: aborted`.

export async function POST(req: NextRequest): Promise<Response> {
  // Read the EXACT bytes GitHub signed — before any JSON parse (a re-serialized
  // body would not match the HMAC).
  const rawBody = await readRawBodyUnlessAborted(req);
  if (rawBody === null) {
    // The connection closed before the body was read (MOTIR-6256) — GitHub gave
    // up on the delivery, typically its ten-second timeout. Nothing arrived that
    // could be verified or processed, so this is a LOST delivery, not a server
    // fault: GitHub records it as failed and does not retry it, and a lost close
    // or check verdict is replayed from the host by `system.pull-request-reconcile`.
    // Name it, so it can be found in the App's delivery log and redelivered by hand.
    console.warn(
      `[github-webhook] delivery ${req.headers.get('x-github-delivery') ?? '(no id)'} ` +
        `(${req.headers.get('x-github-event') ?? 'unknown event'}) lost: the client closed the connection before the body was read`,
    );
    return NextResponse.json(
      { code: 'CLIENT_CLOSED_REQUEST' },
      { status: CLIENT_CLOSED_REQUEST_STATUS },
    );
  }

  try {
    verifyGithubWebhookSignature(rawBody, req.headers.get('x-hub-signature-256'));
  } catch (err) {
    if (err instanceof GithubWebhookSignatureError) {
      return NextResponse.json({ code: err.code }, { status: 401 });
    }
    if (err instanceof GithubWebhookNotConfiguredError) {
      return NextResponse.json({ code: err.code }, { status: 500 });
    }
    throw err;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ code: 'GITHUB_WEBHOOK_MALFORMED_BODY' }, { status: 400 });
  }

  const receipt = await githubWebhookInboxService.receive({
    event: req.headers.get('x-github-event') ?? '',
    payload,
    // The delivery's GUID — a hand REDELIVERY repeats it, which is what makes it the
    // processing's idempotency key (and the merge-queue exit's, MOTIR-5632).
    deliveryId: req.headers.get('x-github-delivery'),
  });

  switch (receipt.kind) {
    case 'ignored':
      return NextResponse.json({ ok: true, result: receipt.result }, { status: 200 });
    case 'missing_delivery_id':
      return NextResponse.json({ code: 'GITHUB_WEBHOOK_MISSING_DELIVERY_ID' }, { status: 400 });
    default:
      // 202 — stored, and processed after this answer. The body is for logging and
      // tests (`tests/e2e/_helpers/github-seed.ts` waits on the delivery by its id).
      return NextResponse.json(
        { ok: true, receipt: receipt.kind, deliveryId: receipt.deliveryId },
        { status: 202 },
      );
  }
}
