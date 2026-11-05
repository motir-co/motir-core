// The planner-findings DTO (Story MOTIR-10354 · Subtask MOTIR-10386).
//
// What `plannerFindingsService.recordFinding` answers: the stored finding's
// identity and the three fields the store computed or fixed, mapped off
// motir-ai's raw row so the row itself never leaks to the MCP tool.

/** One finding as it was stored in motir-ai's findings store. */
export interface RecordedPlannerFindingDTO {
  /** The stored finding's id in motir-ai. */
  id: string;
  /** Always `check_plan` for a finding recorded through motir-core. */
  source: string;
  /** Computed upstream from the site and attribution; groups repeats of one defect. */
  fingerprint: string;
  /** The triage status; a new finding is `new`. */
  status: string;
}
