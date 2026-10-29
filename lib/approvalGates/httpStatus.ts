import type { ApprovalGateErrorTag } from './errors';

// The decide route's status map, shared since MOTIR-5634 so the Queue again route
// answers every gate refusal with the same status (`app/api/approval-gates/[id]/decide`).

/**
 * Typed domain error → HTTP status, TOTAL over `ApprovalGateErrorTag` — so a tag
 * added to that union is a compile error here rather than an unmapped throw,
 * which is a bare 500 on the one surface built to explain refusals in place.
 *
 * `409` for both terminal-state refusals: the request was well-formed and the
 * resource is no longer in a state that admits it. `403` for the relationship
 * refusal — the actor cleared the permission floor and may see the gate; saying
 * "not found" here would be a lie the surface cannot render. `501` for an
 * unregistered kind, which is not the caller's fault and not a permanent
 * refusal: it is a hole the registry names an owning card for.
 *
 * ⚠️ `500` for `APPROVAL_GATE_DECIDED_IMMUTABLE`, and it is the one entry here
 * that is NOT a refusal to render (MOTIR-4912). The obvious mapping is `409`
 * beside `ALREADY_DECIDED`, because both describe the same fact about the row —
 * and it is wrong. `ALREADY_DECIDED` is this door's own check, raised with the
 * row lock held and BEFORE any write: the expected outcome of two reviewers
 * pressing in the same second, which the control draws in place. The immutability
 * error can only arrive if that check was absent, bypassed or wrong and the
 * `trg_approval_gate_decided_immutable` trigger caught what the business rule
 * was supposed to. Sharing a status would make a defect indistinguishable from
 * an ordinary race on every surface anybody looks at — so it is a `500`, which
 * is what it is.
 *
 * The MERGE refusals (MOTIR-5512) are the HOST saying no to the merge an
 * approval performs. The four about the pull request's own state are `409`, for
 * the same reason as the terminal-state refusals above. The missing App
 * permission is `424` and deliberately NOT `403`: `403` already means THIS actor
 * lacks the authority, and here the person is entitled — it is Motir's App the
 * host refused, a dependency failing rather than a caller being turned away.
 */
export const APPROVAL_GATE_STATUS: Record<ApprovalGateErrorTag, number> = {
  APPROVAL_GATE_NOT_FOUND: 404,
  APPROVAL_GATE_NOT_AUTHORISED: 403,
  APPROVAL_GATE_ALREADY_DECIDED: 409,
  APPROVAL_GATE_SUPERSEDED: 409,
  // The question is live and changed under the reader (MOTIR-5234) — a well-formed
  // request against a resource no longer in the state it was read in.
  APPROVAL_GATE_STALE_SUBJECT: 409,
  // A verb this gate does not offer (MOTIR-5893) — the REQUEST is malformed for this
  // kind, not the resource in the wrong state, so `400` rather than `409`.
  APPROVAL_GATE_VERB_NOT_OFFERED: 400,
  APPROVAL_GATE_ALREADY_AWAITING: 409,
  // A delivery the card cannot read (MOTIR-8236) — the request is well-formed and the
  // gate is live; its SET is not in a state anyone can decide over until the pull
  // request is visible again or its link is removed.
  APPROVAL_GATE_DELIVERY_UNREADABLE: 409,
  APPROVAL_GATE_KIND_UNREGISTERED: 501,
  // The request is well-formed and the gate is live; its SUBJECT is not in a state
  // that admits Approve until a push fixes the document (MOTIR-5676).
  APPROVAL_GATE_DECISION_UNRESOLVABLE: 409,
  APPROVAL_GATE_DECIDED_IMMUTABLE: 500,
  // A caller passed `source: 'github'` without a synced reviewer, or the reverse
  // (MOTIR-5596). Like the immutability refusal above it is a DEFECT rather than a
  // race: no route, server action or MCP tool can produce it, so reaching a client
  // at all means an internal caller is wrong. 500 for the same reason — sharing a
  // status with a legitimate refusal would make the two indistinguishable.
  APPROVAL_GATE_SYNCED_ACTOR_MISMATCH: 500,
  // A card-reading path met a card-less gate (MOTIR-6032) — a DEFECT, like the two
  // above: only a `plan_approval` gate is card-less, and its paths never read a card.
  APPROVAL_GATE_HAS_NO_CARD: 500,
  // The merge follows its primary (MOTIR-5785) — a well-formed request against a card
  // whose design (or decision) is not yet in the state that admits a merge.
  APPROVAL_GATE_PRIMARY_PENDING: 409,
  MERGE_CHECKS_NOT_GREEN: 409,
  MERGE_CONFLICT: 409,
  MERGE_OUT_OF_DATE: 409,
  MERGE_BRANCH_PROTECTED: 409,
  MERGE_ALREADY_MERGED: 409,
  // A second Queue again press lost the claim (MOTIR-5634) — a race, like the rest.
  MERGE_ALREADY_REQUEUED: 409,
  MERGE_APP_PERMISSION_MISSING: 424,
};
