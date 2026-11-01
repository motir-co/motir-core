import {
  type Prisma,
  type WorkItemLink,
  type WorkItemLinkKind,
  type WorkItemLinkSource,
} from '@/generated/prisma/client';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { parseWorkItemKeys, parseWorkItemProseRefs } from '@/lib/mentions/workItemRefs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Auto-relate-on-mention (Story 5.8 · Subtask 5.8.3). When a work-item text
// field or comment is saved, any work-item reference in it
// (`[KEY](motir:<id>)` token or a bare `KEY-N`) becomes a `relates_to` link —
// the `relates_to` row (stamped `source = mention`) IS the durable record of
// the reference, so there is no separate mention table. This module owns the
// shared write-core (so `linkWorkItems` and the four mention hooks don't
// hand-duplicate the reciprocal + revision logic) and the parse → resolve →
// view-scope → idempotent-create pipeline the hooks call inside their write
// transactions. Pure DB work, always in-tx (it's a write, not an external side
// effect), never throws out of the auto-relate path.

/**
 * The transactional write-core shared by manual linking
 * (`workItemsService.linkWorkItems`) and auto-relate (this module): insert the
 * directed edge, mirror the `relates_to` reciprocal, and record the
 * `links.added` revision on the FROM item — all inside the caller's `tx`.
 * `source` stamps provenance (`manual` default | `mention`).
 *
 * `idempotent` toggles the duplicate policy:
 *  - **false** (manual link): the forward insert THROWS `DuplicateLinkError` on
 *    the `@@unique([fromId, toId, kind])` — the route turns it into a 409.
 *    Always returns the inserted link (never `null` on this branch).
 *  - **true** (auto-relate): forward + reciprocal go in via `ON CONFLICT DO
 *    NOTHING` (`createIfAbsent`), so a concurrent writer that already landed the
 *    edge is a SILENT no-op rather than a thrown P2002 — which, inside a Prisma
 *    interactive transaction, aborts the WHOLE enclosing save (empirically
 *    verified; this is why the duplicate is swallowed at the INSERT, not caught
 *    as an error). Returns `null` when nothing new landed, so the caller skips
 *    the revision.
 */
export async function writeWorkItemLink(
  args: {
    workspaceId: string;
    fromId: string;
    toId: string;
    kind: WorkItemLinkKind;
    createdById: string;
    source?: WorkItemLinkSource;
    idempotent: boolean;
  },
  tx: Prisma.TransactionClient,
): Promise<WorkItemLink | null> {
  const { workspaceId, fromId, toId, kind, createdById, source, idempotent } = args;
  const base = { workspaceId, createdById, ...(source ? { source } : {}) };

  const forward = idempotent
    ? await workItemLinkRepository.createIfAbsent({ ...base, fromId, toId, kind }, tx)
    : await workItemLinkRepository.create({ ...base, fromId, toId, kind }, tx);

  // The symmetric `relates_to` mirror — the same B→A row `linkWorkItems` writes
  // so both halves of the relationship exist (the other kinds are directional
  // and carry no reciprocal).
  if (kind === 'relates_to') {
    if (idempotent) {
      await workItemLinkRepository.createIfAbsent(
        { ...base, fromId: toId, toId: fromId, kind },
        tx,
      );
    } else {
      const existingReciprocal = await workItemLinkRepository.findReciprocal(
        toId,
        fromId,
        'relates_to',
        tx,
      );
      if (!existingReciprocal) {
        await workItemLinkRepository.create({ ...base, fromId: toId, toId: fromId, kind }, tx);
      }
    }
  }

  // Record the link revision only when a NEW forward edge actually landed — so a
  // concurrency-lost auto-relate (forward was a no-op) writes no phantom history.
  if (forward) {
    await workItemRevisionsService.recordRevision(
      {
        workItemId: fromId,
        changedById: createdById,
        changeKind: 'updated',
        diff: { links: { added: [{ toId, kind }] } },
      },
      tx,
    );
  }
  return forward;
}

/** The source item a reference auto-relates FROM. */
export interface AutoRelateSource {
  id: string;
  workspaceId: string;
  projectId: string;
  /** The project's identifier prefix (e.g. `PROD`) — bare-key matching scope. */
  projectIdentifier: string;
}

/**
 * Parse the work-item references in `title` and `bodies` and auto-create a `relates_to` link
 * (`source = mention`) from `source` to each referenced target — inside the
 * caller's write transaction (Subtask 5.8.3). The rules:
 *
 *  - Token ids (`[KEY](motir:<id>)`) ∪ bare keys (`KEY-N`, resolved within the
 *    SAME project) form the candidate set.
 *  - **Only what renders as a reference relates** (bug MOTIR-9825). Each body is
 *    Markdown and is parsed on its own (`parseWorkItemProseRefs`): a key or token
 *    quoted in an inline code span or a code block is literal text and relates
 *    nothing. The `title` is plain text — the title chips every bare key
 *    (`WorkItemTitle`) — so its keys are read raw.
 *  - **Self** is dropped (an item never relates to itself).
 *  - A candidate is dropped silently when it doesn't resolve, lives in another
 *    workspace, or sits in a project the author can't browse — reusing the exact
 *    `filterBrowsable` view gate `quickSearch` rides (NOT a new permission
 *    check). No throw on any of these — a dangling reference is body text.
 *  - **ADD-only / non-destructive:** if the pair is ALREADY linked in any kind /
 *    either direction (`findAnyBetween`), it's left untouched — no second edge,
 *    and an existing `is_blocked_by` is never downgraded. A later edit that
 *    REMOVES the reference never deletes the link.
 *  - **Idempotent + concurrency-safe:** `findAnyBetween` skips re-adds; the
 *    `@@unique([fromId, toId, kind])` (via `createIfAbsent`'s `ON CONFLICT`)
 *    serialises concurrent saves so exactly one edge survives a race.
 */
export async function autoRelateWorkItemMentions(
  args: {
    source: AutoRelateSource;
    /** The item's plain-text title, when it is part of the write. */
    title?: string | null;
    /** The Markdown bodies saved — each parsed separately, so one body's unclosed fence never swallows the next. */
    bodies: ReadonlyArray<string | null | undefined>;
    ctx: ServiceContext;
  },
  tx: Prisma.TransactionClient,
): Promise<void> {
  const { source, title, bodies, ctx } = args;
  const refIds = new Set<string>();
  const refKeys = new Set<string>(title ? parseWorkItemKeys(title, source.projectIdentifier) : []);
  for (const body of bodies) {
    if (!body) continue;
    const refs = parseWorkItemProseRefs(body, source.projectIdentifier);
    for (const id of refs.ids) refIds.add(id);
    for (const key of refs.keys) refKeys.add(key);
  }
  const refs = { ids: [...refIds], keys: [...refKeys] };
  if (refs.ids.length === 0 && refs.keys.length === 0) return;

  // Same-project bare keys → ids (the key parser only matches this project's
  // prefix, so the resolution is project-scoped).
  const keyItems = refs.keys.length
    ? await workItemRepository.findByIdentifiers(source.projectId, refs.keys, tx)
    : [];

  const candidateIds = new Set<string>([...refs.ids, ...keyItems.map((item) => item.id)]);
  candidateIds.delete(source.id); // never self-relate
  if (candidateIds.size === 0) return;

  // Resolve candidates within the SAME workspace — drops cross-workspace and
  // unresolved token ids (a bare key already resolved same-project above).
  const items = await workItemRepository.findByIdsInWorkspace(
    [...candidateIds],
    source.workspaceId,
    tx,
  );
  if (items.length === 0) return;

  // View scope: keep only targets in a project the author may browse — the exact
  // gate `quickSearch` rides, reused not reinvented.
  const projects = await projectRepository.findByWorkspace(source.workspaceId, tx);
  const browsable = await projectAccessService.filterBrowsable(projects, ctx, tx);
  const browsableProjectIds = new Set(browsable.map((p) => p.id));

  for (const target of items) {
    if (!browsableProjectIds.has(target.projectId)) continue;
    // Already linked in SOME kind/direction → leave it (the ADD-only gate).
    const existing = await workItemLinkRepository.findAnyBetween(source.id, target.id, tx);
    if (existing) continue;
    await writeWorkItemLink(
      {
        workspaceId: source.workspaceId,
        fromId: source.id,
        toId: target.id,
        kind: 'relates_to',
        createdById: ctx.userId,
        source: 'mention',
        idempotent: true,
      },
      tx,
    );
  }
}
