import type { Prisma } from '@/generated/prisma/client';
import { toFixDetailDto } from '@/lib/mappers/fixReasonMappers';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemRepository, type HomeWorkItemRow } from '@/lib/repositories/workItemRepository';
import {
  fixGroupKeyOf,
  fixGroupKindOf,
  orderFixGroupMembers,
  pullRequestGroupHead,
  type FixGroupKind,
} from '@/lib/workItems/fixReason';

// TO FIX ENTRIES (MOTIR-7589; `design/workbench/design-notes.md` § 34.2) — the cards
// stuck for one reason that ONE repair clears, read as one entry with a HEAD.
//
// The key is stored per card (`fixDetail.groupKey`, written by the recompute); this
// module reads an entry's MEMBERS by it — every stuck card carrying the key, whoever
// holds them — and picks the head the repair runs on:
//
//   `run:`  the run's SCOPE card (`DispatchRun.scopeWorkItemId`), else its first leg;
//           members in the run's own leg order.
//   `prs:`  the member that is an ancestor of the others, else the lowest key.
//   `card:` the card itself.
//
// The head need not be stuck itself (a scope card a dead run never claimed), and it need
// not be one of the reader's cards: line 1 names it either way, and the repairs run on it.

/** A Workbench row, with the parent the head rule follows. */
export type FixGroupRow = HomeWorkItemRow & { parentId: string | null };

/** One resolved entry. `members` excludes the head and is in the entry's order. */
export interface FixEntry {
  groupKey: string;
  kind: FixGroupKind;
  head: FixGroupRow;
  members: FixGroupRow[];
}

/** The card id a `card:<id>` key names. */
function cardIdOf(groupKey: string): string {
  return groupKey.slice('card:'.length);
}

/**
 * RESOLVE these entries — their members, their heads and their order — inside the
 * caller's transaction. `viewerId` puts the members the reader holds first (§ 34.4);
 * pass `null` where there is no reader to favour.
 *
 * An entry with no readable member (every card left between the key read and this one)
 * is absent from the map: it has nothing left to repair.
 */
export async function resolveFixEntries(
  workspaceId: string,
  projectIds: readonly string[],
  groupKeys: readonly string[],
  viewerId: string | null,
  tx: Prisma.TransactionClient,
): Promise<Map<string, FixEntry>> {
  const keys = [...new Set(groupKeys)];
  const shared = keys.filter((k) => fixGroupKindOf(k) !== 'card');
  const alone = keys.filter((k) => fixGroupKindOf(k) === 'card').map(cardIdOf);
  const runIds = shared.filter((k) => fixGroupKindOf(k) === 'run').map((k) => k.slice(4));

  const [memberIds, scopes, legs] = await Promise.all([
    workItemRepository.findFixGroupMemberIds(workspaceId, projectIds, shared, tx),
    dispatchRunRepository.findScopesByIds(runIds, tx),
    dispatchRunCardRepository.listPositionsByRuns(runIds, tx),
  ]);
  const scopeByRun = new Map(scopes.map((s) => [s.id, s.scopeWorkItemId]));
  const positionByRun = new Map<string, Map<string, number>>();
  for (const leg of legs) {
    if (leg.workItemId === null) continue;
    const byCard = positionByRun.get(leg.dispatchRunId) ?? new Map<string, number>();
    byCard.set(leg.workItemId, leg.position);
    positionByRun.set(leg.dispatchRunId, byCard);
  }

  const rows = await workItemRepository.findHomeRowsByIds(
    workspaceId,
    [...new Set([...memberIds.map((m) => m.id), ...alone])],
    tx,
  );
  const membersByKey = new Map<string, FixGroupRow[]>();
  for (const row of rows) {
    // A row read by a `card:` key whose stored key moved on belongs to its new entry —
    // which this page did not ask for — so it is dropped, never filed under the old one.
    const key = fixGroupKeyOf(row);
    if (!keys.includes(key) || row.fixReason === null) continue;
    membersByKey.set(key, [...(membersByKey.get(key) ?? []), row]);
  }

  // A run's scope card that is not itself stuck is read on its own (one more read, only
  // when some page needs one).
  const missingHeads = [
    ...new Set(
      [...membersByKey.keys()]
        .filter((k) => fixGroupKindOf(k) === 'run')
        .map((k) => scopeByRun.get(k.slice(4)) ?? null)
        .filter((id): id is string => id !== null && !rows.some((r) => r.id === id)),
    ),
  ];
  const extraHeads = await workItemRepository.findHomeRowsByIds(workspaceId, missingHeads, tx);
  const headById = new Map(extraHeads.map((r) => [r.id, r]));

  const entries = new Map<string, FixEntry>();
  for (const [groupKey, members] of membersByKey) {
    const kind = fixGroupKindOf(groupKey);
    const positions = kind === 'run' ? positionByRun.get(groupKey.slice(4)) : undefined;
    const position = (m: FixGroupRow) => positions?.get(m.id) ?? null;
    const held = (m: FixGroupRow) =>
      viewerId !== null && (m.assigneeId === viewerId || m.reporterId === viewerId);

    let head: FixGroupRow | null = null;
    if (kind === 'run') {
      const scopeId = scopeByRun.get(groupKey.slice(4)) ?? null;
      head = (scopeId && (members.find((m) => m.id === scopeId) ?? headById.get(scopeId))) || null;
      head ??= orderFixGroupMembers(members, () => false, position)[0] ?? null;
    } else if (kind === 'prs') {
      head = pullRequestGroupHead(members);
    } else {
      head = members[0] ?? null;
    }
    /* v8 ignore next -- a key in the map has at least one member by construction. */
    if (head === null) continue;
    const others = members.filter((m) => m.id !== head.id);
    entries.set(groupKey, {
      groupKey,
      kind,
      head,
      members: orderFixGroupMembers(others, held, position),
    });
  }
  return entries;
}

/**
 * Where a card's tag and banner point (work-items § _ONE ENTRY PER RUN_): for each stuck
 * card, its entry's HEAD and the OTHER cards stuck with it. `null` for a card stuck
 * alone, so a surface keeps today's name and sentence for it.
 */
export interface FixGroupPointer {
  kind: FixGroupKind;
  headId: string;
  headKey: string;
  /** Every card of the entry other than the head, in the entry's order. */
  carriedKeys: string[];
}

export async function fixGroupPointersFor(
  workspaceId: string,
  cards: readonly { id: string; projectId: string; fixReason: string | null; fixDetail: unknown }[],
  tx: Prisma.TransactionClient,
): Promise<Map<string, FixGroupPointer | null>> {
  const stuck = cards.filter(
    (c) => c.fixReason !== null && fixGroupKindOf(fixGroupKeyOf(c)) !== 'card',
  );
  const out = new Map<string, FixGroupPointer | null>(cards.map((c) => [c.id, null]));
  if (stuck.length === 0) return out;
  const entries = await resolveFixEntries(
    workspaceId,
    [...new Set(stuck.map((c) => c.projectId))],
    stuck.map(fixGroupKeyOf),
    null,
    tx,
  );
  for (const card of stuck) {
    const entry = entries.get(fixGroupKeyOf(card));
    if (!entry || entry.members.length === 0) continue;
    out.set(card.id, {
      kind: entry.kind,
      headId: entry.head.id,
      headKey: entry.head.identifier,
      carriedKeys: entry.members.map((m) => m.identifier),
    });
  }
  return out;
}

/**
 * The HEAD each of these cards is carried by, for the TAG's name (work-items § _ONE ENTRY
 * PER RUN_, Panel 1): only cards in a shared entry that are NOT its head appear in the
 * map. Pass the ids of the rows a surface is about to draw with a reason; the rest cost
 * nothing.
 */
export async function fixHeadKeysFor(
  workspaceId: string,
  ids: readonly string[],
  tx: Prisma.TransactionClient,
): Promise<Map<string, string>> {
  return (await fixTagFactsFor(workspaceId, ids, tx)).headKeys;
}

/** What a list, tree or board row's To fix TAG reads beyond `fixReason`, by card id. */
export interface FixTagFacts {
  /** The head each carried card names (`fixHeadKeysFor`). */
  headKeys: Map<string, string>;
  /** The cards whose stored detail says FIXING (MOTIR-10309 · MOTIR-10506) — a repair
   *  live on the card, or a fix pushed and its checks running. Read from the stored
   *  `fixDetail.fixing` only, never re-derived: the derivation already read the run. */
  fixingIds: Set<string>;
}

/**
 * The tag's facts for these cards, over ONE read of their stored to-fix answers: the head
 * a carried card names, and whether the card is Fixing. Rows carry only `fixReason`, so the
 * detail is read here, for the ids already showing a reason, and never shipped whole.
 */
export async function fixTagFactsFor(
  workspaceId: string,
  ids: readonly string[],
  tx: Prisma.TransactionClient,
): Promise<FixTagFacts> {
  const headKeys = new Map<string, string>();
  const fixingIds = new Set<string>();
  if (ids.length === 0) return { headKeys, fixingIds };
  const states = await workItemRepository.findFixStateByIds(workspaceId, ids, tx);
  for (const state of states) {
    // A dead run is never Fixing: its repair is a continue, and no CI speaks for it.
    if (state.fixReason === 'run_died') continue;
    if (toFixDetailDto(state.fixReason, state.fixDetail)?.fixing) fixingIds.add(state.id);
  }
  const pointers = await fixGroupPointersFor(workspaceId, states, tx);
  for (const [id, pointer] of pointers) {
    if (pointer && pointer.headId !== id) headKeys.set(id, pointer.headKey);
  }
  return { headKeys, fixingIds };
}

/** No tag facts — a Visitor's read, or no row showing a reason. */
export const NO_FIX_TAG_FACTS: FixTagFacts = { headKeys: new Map(), fixingIds: new Set() };

/** The optional DTO fields one row's tag reads — each ABSENT when it does not apply. */
export function fixTagFieldsOf(
  id: string,
  facts: FixTagFacts,
): { fixHeadKey?: string; fixing?: true } {
  const head = facts.headKeys.get(id);
  return {
    ...(head ? { fixHeadKey: head } : {}),
    ...(facts.fixingIds.has(id) ? { fixing: true as const } : {}),
  };
}
