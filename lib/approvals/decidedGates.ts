'use client';

import { useSyncExternalStore } from 'react';
import type { ApprovalGateDTO, ApprovalGateStateDTO } from '@/lib/dto/approvalGate';

// A GATE DECIDED ELSEWHERE ON THIS PAGE (Story MOTIR-5214 · Subtask MOTIR-5225) —
// the signal the To-approve row's CLIENT island watches, so a decision made in the
// approval overlay settles the row underneath it in the same reconcile
// (`design/workbench/design-notes.md` § 22, planning flag 2).
//
// ⚠️ WHY `router.refresh()` IS NOT ENOUGH. The list is a client island (case 3 of
// CLAUDE.md § *Page state after a mutation*). The overlay is mounted in the authed
// SHELL and the list in the Workbench PAGE, so neither is the other's caller: the
// decision has to travel through something both of them can reach.
//
// ⚠️ WHY A KEYED STORE AND NOT A PROVIDER TICK. A tick says *something changed,
// refetch* — and this island has nothing to refetch with. Its rows are the
// server's, and the server's read returns only `awaiting` gates, so a refetch
// REMOVES the row instead of settling it. What the row needs is the state its
// gate reached, keyed by gate. Holding that for the life of the tab is safe
// because a decided gate is immutable (ADR §6a), so an entry never goes stale.
//
// ⚠️ IT CARRIES THE WHOLE DECISION, NOT ONLY ITS STATE (Story MOTIR-5215 ·
// Subtask MOTIR-5570). The item page is the second listener, and it needs more
// than a row does: the status the decision WROTE (`gate.outcomeRef`), so its
// status rail moves without waiting for a server render (Bug MOTIR-5212's
// channel), and whether the approved files were KEPT, so its record says so
// (Bug MOTIR-5265). Both used to arrive from the section's own decide call,
// which that story removes — the decision is now made in the overlay, outside
// the page's optimistic status provider, and this store is the only thing both
// can reach. The row still reads only the state (`useDecidedGateState`).

/** What the overlay announces: the decided row, and the kind's files-kept answer. */
export interface DecidedGate {
  gate: ApprovalGateDTO;
  filesKept: boolean | null;
  /**
   * The status the decision WROTE, when the announcer knows it (MOTIR-5896). Absent,
   * a reader falls back to `gate.outcomeRef` — true for every kind but a choice,
   * whose `outcomeRef` is the option it picked.
   */
  statusWritten?: string | null;
}

const listeners = new Set<() => void>();
let decided: ReadonlyMap<string, DecidedGate> = new Map();
/** The STATE each announced gate reached — written by both announcements below. */
let decidedStates: ReadonlyMap<string, ApprovalGateStateDTO> = new Map();
/** The gates THIS page has a decide press in flight on (Bug MOTIR-9696). */
let pendingPresses: ReadonlySet<string> = new Set();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Record a decision, and wake every surface watching its gate. */
export function announceGateDecided(decision: DecidedGate): void {
  const { gate } = decision;
  // `awaiting` is not a decision; a repeat is not a change.
  if (gate.state === 'awaiting' || decided.get(gate.id)?.gate.state === gate.state) return;
  decided = new Map(decided).set(gate.id, decision);
  decidedStates = new Map(decidedStates).set(gate.id, gate.state);
  for (const listener of listeners) listener();
}

/**
 * Record ONLY the state a gate reached, for a surface that decided it without holding
 * the decided row (Story MOTIR-6012 · MOTIR-6037). The planning rail decides a plan
 * through the plan's own approve / decline routes, which answer with the PLAN — so it
 * knows the gate's id and the state it reached, and none of the gate's audit columns.
 * Announcing a whole {@link ApprovalGateDTO} would mean inventing them on the client;
 * this wakes the rows that read the state (`useDecidedGateState`) and leaves
 * `useDecidedGate` — whose readers need the whole decision — untouched.
 */
export function announceGateStateDecided(gateId: string, state: ApprovalGateStateDTO): void {
  if (state === 'awaiting' || decidedStates.get(gateId) === state) return;
  decidedStates = new Map(decidedStates).set(gateId, state);
  for (const listener of listeners) listener();
}

/**
 * A PRESS IN FLIGHT ON THIS PAGE (Bug MOTIR-9696). A surface that decides a gate marks it
 * BEFORE it awaits the decide action, and clears the mark on a refusal or a throw (and
 * after it announces the decision).
 *
 * ⚠️ WHY THE ROW NEEDS IT. The press's answer is not the only thing that tells a list the
 * gate has left the awaiting set: the action's own `revalidatePath`, or a live window read
 * the decision's event nudged, can land FIRST — and a read only returns `awaiting` gates,
 * so it drops the row, which the list then draws as HELD (§ 26). A held row with no
 * announced state draws *Decided elsewhere*, which is false for a press made right here.
 * This mark is what lets the held branch tell *decided by me, answer on its way* from
 * *decided by somebody else*.
 */
export function markGatePressPending(gateId: string): void {
  if (pendingPresses.has(gateId)) return;
  pendingPresses = new Set(pendingPresses).add(gateId);
  for (const listener of listeners) listener();
}

/** Clear {@link markGatePressPending}'s mark — the press was refused, threw, or settled. */
export function clearGatePressPending(gateId: string): void {
  if (!pendingPresses.has(gateId)) return;
  const next = new Set(pendingPresses);
  next.delete(gateId);
  pendingPresses = next;
  for (const listener of listeners) listener();
}

/** Whether this page has a decide press in flight on `gateId`. */
export function useGatePressPending(gateId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => pendingPresses.has(gateId),
    () => false,
  );
}

/** The state `gateId` was decided to on this page, or `null` while it has not been. */
export function useDecidedGateState(gateId: string): ApprovalGateStateDTO | null {
  return useSyncExternalStore(
    subscribe,
    () => decidedStates.get(gateId) ?? null,
    // The server render has seen no decision, and the page hydrates from it.
    () => null,
  );
}

/**
 * The whole decision announced for `gateId` on this page, or `null` while there
 * has been none. The entry object is stable until the gate is announced again,
 * so it is safe as an effect dependency.
 */
export function useDecidedGate(gateId: string): DecidedGate | null {
  return useSyncExternalStore(
    subscribe,
    () => decided.get(gateId) ?? null,
    () => null,
  );
}
