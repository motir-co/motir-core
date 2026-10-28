// The card comment a run's discrepancy record leaves (Story MOTIR-8651 · MOTIR-8655,
// decision page MOTIR-8654). PURE: points in, markdown out — no I/O, no clock.
//
// The comment is the record's TEXT. The `discrepancy_recorded` finding on the run carries
// only a pointer to it, so a customer's words stay in the card's own tenant.
//
// ⚠️ TWO KINDS OF ENTRY, ONE COMMENT (MOTIR-10000). A POINT is the plan being WRONG about
// the HOW (a build-through); a DECISION is the plan being SILENT and the run deciding by the
// repository's conventions, then industry best practice. Each gets its own section, so a
// reader never takes a decision for a defect of the plan; a record with only decisions keeps
// the build-through header out of the comment entirely.

/** One point of a discrepancy: what the plan asked · what was built · why. */
export interface RunDiscrepancyPoint {
  planAsked: string;
  built: string;
  why: string;
}

/** One decision the run made where the plan was silent: what it said · what was chosen · why. */
export interface RunDecisionPoint {
  /** What the card or plan said about it — "nothing" when it was silent. */
  planSaid: string;
  chose: string;
  /** The convention or the best practice the choice follows. */
  why: string;
  /** The options considered and not taken, when the run named any. */
  alternatives?: string | null;
}

function discrepancyLines(points: readonly RunDiscrepancyPoint[]): string[] {
  const lines: string[] = [
    `**Built through a plan that was wrong about the HOW** — ${points.length} ` +
      `${points.length === 1 ? 'discrepancy' : 'discrepancies'}. The card's outcome and ` +
      'acceptance criteria were met; the route to them differs from the plan.',
    '',
  ];
  points.forEach((point, index) => {
    lines.push(
      `**${index + 1}.**`,
      `- **Plan asked:** ${point.planAsked}`,
      `- **Built:** ${point.built}`,
      `- **Why:** ${point.why}`,
      '',
    );
  });
  return lines;
}

function decisionLines(decisions: readonly RunDecisionPoint[]): string[] {
  const lines: string[] = [
    `**Decided by the run where the plan was silent** — ${decisions.length} ` +
      `${decisions.length === 1 ? 'decision' : 'decisions'}, each by the repository's ` +
      'conventions first, then industry best practice.',
    '',
  ];
  decisions.forEach((decision, index) => {
    lines.push(
      `**${index + 1}.**`,
      `- **Plan said:** ${decision.planSaid}`,
      `- **Chose:** ${decision.chose}`,
      `- **Why:** ${decision.why}`,
    );
    if (decision.alternatives)
      lines.push(`- **Alternatives considered:** ${decision.alternatives}`);
    lines.push('');
  });
  return lines;
}

/**
 * Compose the comment body — one numbered block per point, then one per decision, each in the
 * order given. Either list may be empty, never both (the service refuses that first).
 */
export function composeDiscrepancyComment(
  points: readonly RunDiscrepancyPoint[],
  decisions: readonly RunDecisionPoint[] = [],
): string {
  const lines: string[] = [];
  if (points.length > 0) lines.push(...discrepancyLines(points));
  if (decisions.length > 0) lines.push(...decisionLines(decisions));
  return lines.join('\n').trimEnd();
}
