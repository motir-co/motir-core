// The project's APPROVAL-GATE switches (Story MOTIR-4925 · Subtask MOTIR-5170).
//
// `Project settings ▸ Approvals` is the room that holds the switches deciding
// which approval gates a project raises, and this is what that room reads and
// writes. Today it carries ONE switch; the type is an object rather than a bare
// boolean precisely because a second is already decided —
// `docs/decisions/approval-gates.md` §7 moves the pull-request merge mode to the
// project, where `manual` raises the card's ONE approve-to-merge gate and `auto`
// raises none and merges on green — so the next switch joins this DTO instead of
// changing a signature. (It said `pull_request_merge` until MOTIR-5616 retired that
// kind; the SWITCH is unchanged, only the kind it decides.)
//
// ⚠️ THE ENTITLEMENT IS NOT HERE, AND THAT IS THE POINT. Whether the
// organisation holds a paid Motir AI plan is a BILLING fact, resolved
// org-side by `billingService` and combined with this switch in exactly one
// place (`acceptanceVideoEligibilityService`). Putting `hasPaidAiPlan` on this
// DTO would make the settings room a second place the AND could be computed,
// which is what that service's header exists to prevent.

export interface ApprovalGateSettingsDTO {
  /**
   * Whether this project raises the ACCEPTANCE-VIDEO gate: a story that HAS an
   * acceptance video is held until a person approves it. It does NOT govern
   * recording — a run records either way, and the recording stays in the run's
   * own report — which is why the copy is conditional on the video EXISTING.
   */
  acceptanceVideoEnabled: boolean;
  /**
   * Whether this project's green cards are REVIEWED by the review agent before the
   * approve-and-merge gate is asked or anything auto-merges (Story MOTIR-1626 ·
   * `docs/decisions/approval-gates.md` §12). Orthogonal to the merge mode; off by
   * default.
   */
  reviewAgentEnabled: boolean;
  /**
   * Whether a published DESIGN RESULT waits for a person (Story MOTIR-693 ·
   * MOTIR-697; `docs/decisions/hosted-design-rerun-and-design-approval-switch.md`
   * §2). `false` still raises the design gate, and approves it at once on behalf of
   * this setting — on the record, never by skipping it.
   */
  designApprovalGate: boolean;
  /**
   * WHO answers the review while `reviewAgentEnabled` is on (Story MOTIR-10327 ·
   * MOTIR-10332; `approval-gates.md` §12.10): `hosted` — Motir's hosted review run,
   * the default — or `own`, the person's own agent through the verdict door, with
   * no hosted run and nothing billed. Stored while the switch is off too.
   */
  reviewAgentSource: ReviewAgentSourceValue;
  /**
   * Whether Motir's own GitHub App bot posts every agent verdict on the pull
   * requests (`approval-gates.md` §12.16). On by default.
   */
  reviewBotPostsEnabled: boolean;
}

/** The two values of the review source (§12.10). */
export const REVIEW_AGENT_SOURCES = ['hosted', 'own'] as const;
export type ReviewAgentSourceValue = (typeof REVIEW_AGENT_SOURCES)[number];

/** The PATCH body: any subset of the switches, each optional. */
export interface UpdateApprovalGateSettingsInput {
  acceptanceVideoEnabled?: boolean;
  reviewAgentEnabled?: boolean;
  designApprovalGate?: boolean;
  reviewAgentSource?: ReviewAgentSourceValue;
  reviewBotPostsEnabled?: boolean;
}
