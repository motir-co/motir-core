import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';

// THE APPROVAL OVERLAY'S ADDRESS (Story MOTIR-5214 · Subtask MOTIR-5224), as
// `design/workbench/design-notes.md` § 22 *THE ADDRESS* settles it: two
// NAMESPACED query parameters, `approval` (the work item's identifier, and the
// presence switch) and `approvalKind` (the gate kind, required).
//
// ⚠️ THIS MODULE HAS NO `'use client'` DIRECTIVE, ON PURPOSE. The overlay host is
// a client island, and the row door (MOTIR-5225) and the item page's door
// (MOTIR-5215) both have to WRITE this address. A parameter name or a parser
// declared inside the client component and imported back from anywhere else
// turns the whole module into a client reference — the boundary follows the
// MODULE, not the symbol — so everything two sides need lives here and both
// import it from here.
//
// ⚠️ THE KIND LIST IS WRITTEN OUT, NOT READ FROM THE REGISTRY, because the
// registry imports the handlers and a client module may not. The type assertion
// below is what keeps it total over `ApprovalGateKindDTO`, and
// `tests/approvals/overlayAddress.test.ts` checks it against the registry's own
// classification, so a fifth kind fails a build and a test rather than opening
// the overlay on "not available".

/** The two parameters the address carries. § 22's table is the single copy in
 *  prose; this is the single copy in code. Renaming one is a design change first. */
export const APPROVAL_OVERLAY_PARAM_NAMES = {
  /** The presence switch AND the work item's identifier (`MOTIR-<n>`). */
  item: 'approval',
  /** The gate kind — a member of `ApprovalGateKind`. */
  kind: 'approvalKind',
} as const;

/** Every approval-gate kind, as the wire spells it. */
export const APPROVAL_GATE_KINDS = [
  'design_result',
  'decision_approval',
  'pull_request_approval',
  // ⚠️ `pull_request_merge` STAYS IN THIS TUPLE, and only here. It is the WIRE
  // spelling of every enum member, not the list of kinds this build renders —
  // the exhaustiveness line below is over `ApprovalGateKindDTO`, which keeps the
  // value while the rows that carry it exist (MOTIR-5616 retired the KIND at the
  // registry, and MOTIR-5614's backfill left those rows superseded). A parser
  // that stopped recognising the spelling would fail to address a real row.
  'pull_request_merge',
  'acceptance_result',
  'decision_choice',
  'decision_confirmation',
  // A WIRE SPELLING, never an address this build opens: a plan gate is decided on the
  // planning surface, and the overlay address is NOT extended to it (ADR
  // `approval-gates.md` §11.5b). Listed so the tuple stays total over the enum.
  'plan_approval',
  // An ADDRESS the overlay opens: the item page's Development frame writes it —
  // *Continue without the review* hands over here, where the one decision on the kind is
  // made (§12.3; MOTIR-6323's rule that every decision is the overlay's) — and so does a
  // To approve review-to-run row's press (Bug MOTIR-11983; ADR §12.19). The gate is still
  // never an approval row (§12.1).
  'agent_review',
  // The manual-work question a run raised (MOTIR-7474): its Waiting on you row opens
  // here, where Mark done is pressed (`manual-work-gate.md` §5).
  'manual_work',
  // A WIRE SPELLING, never an address this build opens: a planning-session row opens the
  // planning overlay through the plan-overlay door, and the approval overlay address is
  // NOT extended to it (MOTIR-7913). Listed so the tuple stays total over the enum.
  'planning_session',
] as const satisfies readonly ApprovalGateKindDTO[];

// Exhaustiveness: a member added to `ApprovalGateKindDTO` and not to the tuple
// above stops this line compiling.
type _KindsAreTotal = ApprovalGateKindDTO extends (typeof APPROVAL_GATE_KINDS)[number]
  ? true
  : never;
const _kindsAreTotal: _KindsAreTotal = true;
void _kindsAreTotal;

/** What an address asks for. Either half may be missing or malformed — the
 *  overlay still OPENS on such an address and says the approval is not available
 *  (§ 22 Panel 5a), so the parse keeps the presence and reports the gaps. */
export interface ApprovalOverlayAddress {
  /** The trimmed identifier, or null when the parameter is present but empty. */
  itemKey: string | null;
  /** The kind, or null when absent or not a member of `ApprovalGateKind`. */
  kind: ApprovalGateKindDTO | null;
}

/** The subset of `URLSearchParams` the parse needs — `useSearchParams()`'s
 *  read-only object satisfies it. */
export interface SearchParamsLike {
  get(name: string): string | null;
  has(name: string): boolean;
}

function isGateKind(value: string): value is ApprovalGateKindDTO {
  return (APPROVAL_GATE_KINDS as readonly string[]).includes(value);
}

/** The overlay's address in `params`, or null when the overlay is closed. */
export function parseApprovalOverlay(params: SearchParamsLike): ApprovalOverlayAddress | null {
  if (!params.has(APPROVAL_OVERLAY_PARAM_NAMES.item)) return null;
  const itemKey = params.get(APPROVAL_OVERLAY_PARAM_NAMES.item)?.trim() || null;
  const rawKind = params.get(APPROVAL_OVERLAY_PARAM_NAMES.kind)?.trim() ?? '';
  return { itemKey, kind: isGateKind(rawKind) ? rawKind : null };
}

/**
 * Split an app-relative href into path, query and hash WITHOUT resolving it
 * against an origin — the same reason as `lib/planning/launcher.ts`'s own: the
 * one thing this module must not do is change the host page's address in any
 * way other than adding or removing its two parameters.
 */
function splitHref(href: string): { path: string; query: URLSearchParams; hash: string } {
  const hashAt = href.indexOf('#');
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  const withoutHash = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = withoutHash.indexOf('?');
  return {
    path: queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt),
    query: new URLSearchParams(queryAt === -1 ? '' : withoutHash.slice(queryAt + 1)),
    hash,
  };
}

function joinHref(path: string, query: URLSearchParams, hash: string): string {
  const qs = query.toString();
  return `${path}${qs ? `?${qs}` : ''}${hash}`;
}

/**
 * The OPEN address: `href` plus the overlay's two parameters. Every host
 * parameter survives; an address that already names an approval is RE-TARGETED
 * rather than given a second pair.
 */
export function withApprovalOverlay(
  href: string,
  target: { itemKey: string; kind: ApprovalGateKindDTO },
): string {
  const { path, query, hash } = splitHref(href);
  query.set(APPROVAL_OVERLAY_PARAM_NAMES.item, target.itemKey);
  query.set(APPROVAL_OVERLAY_PARAM_NAMES.kind, target.kind);
  return joinHref(path, query, hash);
}

/** The CLOSED address: `href` with exactly the two parameters removed, and every
 *  other parameter byte-identical (§ 22 — *back to exactly where you were*). */
export function withoutApprovalOverlay(href: string): string {
  const { path, query, hash } = splitHref(href);
  query.delete(APPROVAL_OVERLAY_PARAM_NAMES.item);
  query.delete(APPROVAL_OVERLAY_PARAM_NAMES.kind);
  return joinHref(path, query, hash);
}
