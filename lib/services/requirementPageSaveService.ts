import type { Prisma } from '@/generated/prisma/client';
import { requirementPageLocale } from '@/lib/ai/requirementMarkdown';
import { resolveTenantLanguages } from '@/lib/ai/tenantLanguages';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { requirementPageService } from '@/lib/services/requirementPageService';
import { narrowSharpenedRequirement } from '@/lib/sharpening/requirement';
import { deferUntilCommit } from '@/lib/workspaces/afterCommit';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE REQUIREMENT PAGE, SAVED AFTER THE START (MOTIR-10091). A confirmed plan offer that
// carries a composed requirement used to write it as a page INSIDE the confirm, before
// the run was submitted (MOTIR-9436). A failed page or folder write then blocked the
// start, and a typed agreement lost the offer altogether: its answer superseded the
// offer while nothing had started. Nothing needs the page before the run — the
// requirement is stored on the offer and the run is submitted with it — so the page is
// a RECORD, and it is written here, by a background job, after the start.
//
// ── ONE PAGE PER OFFER ──────────────────────────────────────────────────────────────
// The confirm requests the job inside the transaction that CLAIMS the offer, deferred
// to its commit (`deferUntilCommit`), so a claim that rolls back requests nothing. The
// event is keyed by the offer turn's id and the job declares that key as its
// idempotency, so Confirm twice, or Confirm and a typed agreement, enqueue one run.
// The run writes the page in one step and records it on the offer in another, so a
// retry after the write re-uses the page its memo holds; and the write itself first
// reads the offer, so a page already recorded is never written twice.
//
// ── A SAVE THAT NEVER SUCCEEDS ──────────────────────────────────────────────────────
// The run is unaffected. The job's FINAL attempt marks the offer
// `requirementPageFailed` before it throws into the dead-letter queue, and the rail's
// confirmed line says the requirement could not be saved as a page.
//
// Every read and write of the offer is made as the person who confirmed it, under their
// conversation's row lock — the same lock the start's stamp takes, so neither write
// loses the other's keys.

/** The job's payload: which offer to save the requirement of, and as whom. */
export interface PlanOfferRequirementPageRequestedData {
  workspaceId: string;
  projectId: string;
  /** The person who confirmed the offer: the conversation is theirs. */
  userId: string;
  conversationId: string;
  offerTurnId: string;
  /** The offer turn's id — one page per offer, however many confirms reach it. */
  idempotencyKey: string;
}

/** The page recorded on an offer. */
export interface RequirementPageRef {
  pageId: string;
  title: string;
}

/** The event that asks for an offer's page. */
export const REQUIREMENT_PAGE_EVENT = 'plan-offer/requirement-page.requested' as const;

function scopeOf(data: PlanOfferRequirementPageRequestedData) {
  return { userId: data.userId, workspaceId: data.workspaceId, projectId: data.projectId };
}

function offerJson(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** The page recorded on a stored offer, if it reads as one. */
export function recordedRequirementPageOf(raw: unknown): RequirementPageRef | null {
  const page = offerJson(raw)?.['requirementPage'];
  if (!page || typeof page !== 'object' || Array.isArray(page)) return null;
  const { pageId, title } = page as Record<string, unknown>;
  return typeof pageId === 'string' && pageId && typeof title === 'string' && title
    ? { pageId, title }
    : null;
}

/** The stored offer on `offerTurnId`, read under its conversation's lock. */
async function lockedOffer(
  data: PlanOfferRequirementPageRequestedData,
  tx: Prisma.TransactionClient,
): Promise<{ id: string; offer: Record<string, unknown> } | null> {
  if (!(await planChangeSessionRepository.lockById(data.conversationId, tx))) return null;
  const row = await planChangeTurnRepository.findByIdInSession(
    data.offerTurnId,
    data.conversationId,
    data.workspaceId,
    tx,
  );
  const offer = row && row.role === 'assistant' ? offerJson(row.answerOffer) : null;
  return row && offer ? { id: row.id, offer } : null;
}

/** Rewrite the stored offer under its conversation's lock: `change` gets what is
 *  stored and answers what to keep, or null to leave it as it is. */
async function rewriteOffer(
  data: PlanOfferRequirementPageRequestedData,
  change: (offer: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<void> {
  await withWorkspaceContext(scopeOf(data), async (tx) => {
    const locked = await lockedOffer(data, tx);
    const next = locked ? change(locked.offer) : null;
    if (!locked || !next) return;
    await planChangeTurnRepository.setAnswerOffer(
      locked.id,
      data.workspaceId,
      next as Prisma.InputJsonValue,
      tx,
    );
  });
}

export const requirementPageSaveService = {
  /**
   * Ask for the offer's page once the CURRENT transaction commits. Called by the
   * confirm inside the transaction that claims the offer, so a claim that rolls back
   * asks for nothing. Outside a transaction scope it asks at once.
   */
  async requestAfterCommit(
    input: Omit<PlanOfferRequirementPageRequestedData, 'idempotencyKey'>,
  ): Promise<void> {
    const data: PlanOfferRequirementPageRequestedData = {
      ...input,
      idempotencyKey: input.offerTurnId,
    };
    const send = () => sendEvent(REQUIREMENT_PAGE_EVENT, data);
    if (!deferUntilCommit(send)) await send();
  },

  /**
   * Write the offer's requirement as one page in Requirements Docs and answer it — or
   * the page already recorded on the offer, without writing. Null when there is
   * nothing to save: the offer is gone, or it carries no requirement.
   */
  async write(data: PlanOfferRequirementPageRequestedData): Promise<RequirementPageRef | null> {
    const stored = await withWorkspaceContext(scopeOf(data), async (tx) => {
      const locked = await lockedOffer(data, tx);
      return locked?.offer ?? null;
    });
    if (!stored) return null;
    const recorded = recordedRequirementPageOf(stored);
    if (recorded) return recorded;
    const requirement = narrowSharpenedRequirement(stored['requirement']);
    const requestMd = stored['requestMd'];
    if (!requirement || typeof requestMd !== 'string') return null;
    const { contentLanguage } = await resolveTenantLanguages({
      workspaceId: data.workspaceId,
      userId: data.userId,
    });
    const confirmedAt = stored['confirmedAt'];
    const written = await requirementPageService.write({
      workspaceId: data.workspaceId,
      projectId: data.projectId,
      requirement,
      requestMd,
      conversationLabel: data.conversationId,
      at: typeof confirmedAt === 'string' ? new Date(confirmedAt) : new Date(),
      locale: requirementPageLocale(contentLanguage),
    });
    return { pageId: written.pageId, title: written.title };
  },

  /** Record the written page on the offer. A page already recorded stays: the first
   *  record wins, so the rail never swaps one link for another. */
  async record(data: PlanOfferRequirementPageRequestedData, page: RequirementPageRef) {
    await rewriteOffer(data, (offer) => {
      if (recordedRequirementPageOf(offer)) return null;
      const { requirementPageFailed: _cleared, ...kept } = offer;
      return { ...kept, requirementPage: page };
    });
  },

  /** The final attempt failed: mark the offer so the rail's confirmed line says the
   *  requirement could not be saved as a page. A page already recorded wins. */
  async recordFailure(data: PlanOfferRequirementPageRequestedData) {
    await rewriteOffer(data, (offer) =>
      recordedRequirementPageOf(offer) ? null : { ...offer, requirementPageFailed: true },
    );
  },
};
