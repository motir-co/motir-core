import { NextResponse, type NextRequest } from 'next/server';
import { CLIENT_CLOSED_REQUEST_STATUS, readRawBodyUnlessAborted } from '@/lib/api/clientAbort';
import { verifyGithubWebhookSignature } from '@/lib/github/webhookSignature';
import { GithubWebhookNotConfiguredError, GithubWebhookSignatureError } from '@/lib/github/errors';
import { githubWebhookInboxService } from '@/lib/services/githubWebhookInboxService';
import { bodyByteLength, logWebhookAnswer } from '@/lib/github/webhookAnswerLog';

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
// GUID → 400, a sender that hung up before the body was read → 499, never a thrown
// `Error: aborted`.
//
// ⚠️ EVERY NON-2xx ANSWER WRITES ONE LOG LINE (Bug MOTIR-10804). None of them stores an
// inbox row, so without the line a refused delivery cannot be told from one GitHub never
// sent. The line names the status, the code, the delivery id and the event, and never
// the payload or the signature (`lib/github/webhookAnswerLog.ts`). A throw that escapes
// the handler is logged the same way with code `UNHANDLED_ERROR`, then re-thrown so Next
// still reports it to the monitor.

export async function POST(req: NextRequest): Promise<Response> {
  try {
    return await handleDelivery(req);
  } catch (err) {
    logWebhookAnswer({
      status: 500,
      code: 'UNHANDLED_ERROR',
      headers: req.headers,
      bodyBytes: null,
    });
    throw err;
  }
}

/** The answer for a non-2xx outcome — logged, then returned with its code as the body. */
function refuse(req: NextRequest, status: number, code: string, bodyBytes: number | null) {
  logWebhookAnswer({ status, code, headers: req.headers, bodyBytes });
  return NextResponse.json({ code }, { status });
}

async function handleDelivery(req: NextRequest): Promise<Response> {
  // Read the EXACT bytes GitHub signed — before any JSON parse (a re-serialized
  // body would not match the HMAC).
  const rawBody = await readRawBodyUnlessAborted(req);
  if (rawBody === null) {
    // The connection closed before the body was read (MOTIR-6256) — GitHub gave
    // up on the delivery, typically its ten-second timeout. Nothing arrived that
    // could be verified or processed, so this is a LOST delivery, not a server
    // fault: GitHub records it as failed and does not retry it, and a lost close
    // or check verdict is replayed from the host by `system.pull-request-reconcile`.
    // The line names it, so it can be found in the App's delivery log and redelivered.
    return refuse(req, CLIENT_CLOSED_REQUEST_STATUS, 'CLIENT_CLOSED_REQUEST', null);
  }
  const bodyBytes = bodyByteLength(rawBody);

  try {
    verifyGithubWebhookSignature(rawBody, req.headers.get('x-hub-signature-256'));
  } catch (err) {
    if (err instanceof GithubWebhookSignatureError) return refuse(req, 401, err.code, bodyBytes);
    if (err instanceof GithubWebhookNotConfiguredError)
      return refuse(req, 500, err.code, bodyBytes);
    throw err;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return refuse(req, 400, 'GITHUB_WEBHOOK_MALFORMED_BODY', bodyBytes);
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
      return refuse(req, 400, 'GITHUB_WEBHOOK_MISSING_DELIVERY_ID', bodyBytes);
    default:
      // 202 — stored, and processed after this answer. The body is for logging and
      // tests (`tests/e2e/_helpers/github-seed.ts` waits on the delivery by its id).
      return NextResponse.json(
        { ok: true, receipt: receipt.kind, deliveryId: receipt.deliveryId },
        { status: 202 },
      );
  }
}
