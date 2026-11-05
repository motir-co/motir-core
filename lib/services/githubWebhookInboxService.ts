import type { Prisma } from '@/generated/prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import type { GithubWebhookDeliveryDTO } from '@/lib/dto/github';
import { toGithubWebhookDeliveryDTO } from '@/lib/mappers/githubMappers';
import { dispatchSystemEvent } from '@/lib/jobs/sendEvent';
import {
  githubWebhookDeliveryRepository,
  type GithubWebhookDeliveryRef,
} from '@/lib/repositories/githubWebhookDeliveryRepository';
import {
  GITHUB_WEBHOOK_HANDLED_EVENTS,
  githubWebhookService,
  type GithubWebhookResult,
} from './githubWebhookService';

// THE GITHUB WEBHOOK INBOX (Bug MOTIR-10425) — ACK FIRST, PROCESS AFTER.
//
// GitHub waits TEN SECONDS for a delivery's response headers, records anything
// slower as failed, and never redelivers on its own. The route used to run
// `githubWebhookService.handleEvent` before it answered, and the CI path runs
// behind a three-slot in-process gate (`changeRequestCiFeedback.ts`), so at the end
// of a workflow — the last job's `check_run completed`, the suite's `check_suite
// completed` and the other suites' deliveries all at once — a delivery could wait
// longer than ten seconds for a slot. The observed one was a suite's completion: its
// roll-up row stayed `pending`, the card stayed at Implemented and its CI comment
// read "87 of 88" until the reconcile tick re-read the host about eight minutes
// later.
//
// So the work and the answer are split, the shape every webhook consumer that cannot
// afford to lose a delivery takes (GitHub's own guidance: "respond within 10 seconds
// … process the payload asynchronously"):
//
//   1. `receive` — called by the route after the signature is verified. ONE insert
//      of the delivery's GUID, event and body, then the job enqueue. Nothing in it
//      waits on the CI gate or on any other delivery, so the route answers in
//      milliseconds whatever is queued behind the gate.
//   2. `processDelivery` — called by the `system.github-webhook-delivery` job. It
//      runs `handleEvent` on the stored body exactly as the route used to, records
//      the answer, and RETHROWS a failure so the job runner retries it on its
//      backoff; once the job's budget is spent the run is dead-lettered and the row
//      stays `failed` with its error, visible in both places.
//   3. `sweep` — the backstop. A row still `received` minutes after it arrived is
//      one whose enqueue was lost (the process died between the insert and the
//      enqueue, or the enqueue failed); it is enqueued again, under the same key, so
//      a run that does exist is not doubled. It also prunes processed rows.
//
// ⚠️ IDEMPOTENT PER DELIVERY, at two layers. The job is keyed on
// `<deliveryId>:<generation>`, so one delivery has one run however often it is
// enqueued; and `startAttempt` only lets a run work a row still owed work at its own
// generation. A GitHub redelivery of a delivery already in hand changes nothing; one
// of a FAILED delivery re-arms it under a new generation, which is what a person
// pressing "Redeliver" wants. The handlers below `handleEvent` were already written
// to converge under GitHub's redeliveries (the CI path's upserts, the status sync's
// `noop` on a card already where it would go, the merge-queue exit's delivery-id
// ledger), and a second run of one delivery is exactly that case.

/** How long a `received` row may wait before the sweep assumes its enqueue was lost.
 *  Well past the time an enqueued run takes to start on a live worker (a NOTIFY
 *  wakes it), so the sweep re-enqueues only what nothing else will run. */
export const GITHUB_WEBHOOK_INBOX_STALE_MS = 2 * 60_000;
/** How long a processed row is kept, for diagnosis — its body is already gone. */
export const GITHUB_WEBHOOK_INBOX_PROCESSED_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** How long a failed row is kept — the job ledger's own retention, so the dead
 *  letter and the delivery it is about expire together. */
export const GITHUB_WEBHOOK_INBOX_FAILED_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** The most rows one sweep re-enqueues; the rest wait for the next tick. */
export const GITHUB_WEBHOOK_INBOX_SWEEP_BATCH = 200;

/** What the route does with one verified delivery. */
export type GithubWebhookReceipt =
  /** Not an event Motir acts on, or not a JSON object: answered as `handleEvent`
   *  always answered it, and nothing is stored. */
  | { kind: 'ignored'; result: GithubWebhookResult }
  /** A handled event with no `X-GitHub-Delivery` GUID — nothing to key the
   *  processing on. GitHub always sends one. */
  | { kind: 'missing_delivery_id' }
  /** Stored; a run is owed and was enqueued (or will be, by the sweep). */
  | { kind: 'accepted'; deliveryId: string }
  /** A copy of a delivery already in hand (received or processed): nothing new. */
  | { kind: 'duplicate'; deliveryId: string }
  /** A copy of a FAILED delivery: re-armed under a new generation, a run enqueued. */
  | { kind: 'rearmed'; deliveryId: string };

/** What one processing run did — the job's step result. The full answer is on the
 *  row (`result`), so this stays small and stable. */
export type GithubWebhookProcessOutcome =
  | { outcome: 'processed'; event: string }
  /** Nothing to do: the row is gone, processed, or owned by a newer generation. */
  | { outcome: 'skipped'; reason: 'missing' | 'already_processed' | 'superseded' };

export interface GithubWebhookInboxSweepSummary {
  reenqueued: number;
  prunedProcessed: number;
  prunedFailed: number;
}

/** A plain JSON object — the only body shape any handler reads. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The job's payload for one inbox row, idempotency key included. */
function deliveryEvent(ref: GithubWebhookDeliveryRef) {
  return {
    deliveryId: ref.deliveryId,
    generation: ref.generation,
    idempotencyKey: `${ref.deliveryId}:${ref.generation}`,
    workspaceId: null,
  } as const;
}

/**
 * Enqueue the run for one inbox row. A failure is LOGGED, never thrown: the row is
 * committed, so the delivery is not lost — the sweep enqueues it — and the route
 * must still answer 2xx, because a non-2xx would only make GitHub record a failure
 * for a delivery Motir is holding.
 */
async function enqueue(ref: GithubWebhookDeliveryRef): Promise<boolean> {
  try {
    await dispatchSystemEvent('system.github-webhook-delivery', deliveryEvent(ref));
    return true;
  } catch (err) {
    console.error('[githubWebhookInbox] enqueue failed; the inbox sweep will retry it', {
      deliveryId: ref.deliveryId,
      generation: ref.generation,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export const githubWebhookInboxService = {
  /**
   * Persist one verified delivery and enqueue its processing. The route calls this
   * and nothing else on the happy path; it never runs a handler.
   */
  async receive(input: {
    event: string;
    payload: unknown;
    deliveryId: string | null;
  }): Promise<GithubWebhookReceipt> {
    const { event, payload, deliveryId } = input;
    if (!GITHUB_WEBHOOK_HANDLED_EVENTS.has(event)) {
      return { kind: 'ignored', result: { event: 'ignored', reason: `unhandled_event:${event}` } };
    }
    if (!isJsonObject(payload)) {
      return { kind: 'ignored', result: { event: 'ignored', reason: 'malformed_body' } };
    }
    if (!deliveryId) return { kind: 'missing_delivery_id' };

    const body = payload as Prisma.InputJsonValue;
    const stored = await withSystemContext(async (tx) => {
      if (
        await githubWebhookDeliveryRepository.insertIfAbsent(
          { deliveryId, event, payload: body },
          tx,
        )
      ) {
        return { kind: 'accepted' as const, generation: 0 };
      }
      const rearmed = await githubWebhookDeliveryRepository.rearmFailed(deliveryId, body, tx);
      if (rearmed) return { kind: 'rearmed' as const, generation: rearmed.generation };
      return { kind: 'duplicate' as const, generation: null };
    });

    if (stored.kind !== 'duplicate') await enqueue({ deliveryId, generation: stored.generation });
    return { kind: stored.kind, deliveryId };
  },

  /**
   * Process one stored delivery — the job's body. Runs `handleEvent` on the stored
   * body, records its answer and clears the body; a throw is recorded on the row and
   * RETHROWN, so the job runner retries the run.
   */
  async processDelivery(
    ref: GithubWebhookDeliveryRef,
    now: () => Date = () => new Date(),
  ): Promise<GithubWebhookProcessOutcome> {
    const row = await withSystemContext((tx) =>
      githubWebhookDeliveryRepository.startAttempt(ref, tx),
    );
    if (!row) return { outcome: 'skipped', reason: await whyNothingToDo(ref) };

    let result: GithubWebhookResult;
    try {
      result = await githubWebhookService.handleEvent(row.event, row.payload, row.deliveryId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await withSystemContext((tx) =>
        githubWebhookDeliveryRepository.markFailed(row.id, message.slice(0, 2000), tx),
      );
      throw err;
    }

    await withSystemContext((tx) =>
      githubWebhookDeliveryRepository.markProcessed(
        row.id,
        result as unknown as Prisma.InputJsonValue,
        now(),
        tx,
      ),
    );
    return { outcome: 'processed', event: row.event };
  },

  /**
   * The inbox backstop — the `system.github-webhook-inbox-sweep` tick. Re-enqueues
   * every row still `received` past {@link GITHUB_WEBHOOK_INBOX_STALE_MS} (under its
   * own key, so an existing run is not doubled) and prunes rows past their retention.
   */
  async sweep(now: Date = new Date()): Promise<GithubWebhookInboxSweepSummary> {
    const stale = await withSystemContext((tx) =>
      githubWebhookDeliveryRepository.listReceivedBefore(
        new Date(now.getTime() - GITHUB_WEBHOOK_INBOX_STALE_MS),
        GITHUB_WEBHOOK_INBOX_SWEEP_BATCH,
        tx,
      ),
    );
    let reenqueued = 0;
    for (const ref of stale) {
      if (await enqueue(ref)) reenqueued += 1;
    }

    const { prunedProcessed, prunedFailed } = await withSystemContext(async (tx) => ({
      prunedProcessed: await githubWebhookDeliveryRepository.deleteInStateBefore(
        'processed',
        new Date(now.getTime() - GITHUB_WEBHOOK_INBOX_PROCESSED_RETENTION_MS),
        tx,
      ),
      prunedFailed: await githubWebhookDeliveryRepository.deleteInStateBefore(
        'failed',
        new Date(now.getTime() - GITHUB_WEBHOOK_INBOX_FAILED_RETENTION_MS),
        tx,
      ),
    }));
    return { reenqueued, prunedProcessed, prunedFailed };
  },

  /** Where one delivery stands — for an operator, or a test waiting on its outcome. */
  async findDelivery(deliveryId: string): Promise<GithubWebhookDeliveryDTO | null> {
    const row = await withSystemContext((tx) =>
      githubWebhookDeliveryRepository.findByDeliveryId(deliveryId, tx),
    );
    return row ? toGithubWebhookDeliveryDTO(row) : null;
  },
};

/** Why a run found nothing to do — read after `startAttempt` matched no row. */
async function whyNothingToDo(
  ref: GithubWebhookDeliveryRef,
): Promise<'missing' | 'already_processed' | 'superseded'> {
  const row = await withSystemContext((tx) =>
    githubWebhookDeliveryRepository.findByDeliveryId(ref.deliveryId, tx),
  );
  if (!row) return 'missing';
  if (row.generation !== ref.generation) return 'superseded';
  return 'already_processed';
}
