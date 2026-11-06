import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Bug MOTIR-8127 — THE AUDIT STAYS CLOSED.
//
// `GET /api/plans/[id]?since=<reviewVersion>` answers "unchanged" for a `generating` plan, so a
// write door that changes what the review shows without moving the review's version token would
// leave a polling client stale with nothing to correct it. `tests/integration/plans/
// planReviewVersion.test.ts` proves every door IN ITS TABLE moves the token. This file proves the
// table is COMPLETE: every non-repository file that writes the plan family's tables is named here,
// with where its doors are covered. A new writer fails this test, and the fix is to add its door to
// that table (or to say below why it cannot act on a `generating` plan) — not to loosen the scan.

const ROOT = join(__dirname, '..', '..');

/** The write methods of the repositories whose rows the plan review reads. (`lockById` is a row
 * LOCK, not a write: it changes nothing the review shows.) */
const WRITE_CALL =
  /\b(planRepository\.(create|update|touchActivity)|planItemRepository\.(create|update|deleteById|setWorkItemId)|planStepRepository\.(upsertForSession|deleteForSession)|planNarrationRepository\.(createMany|upsertSession)|planRevisionRepository\.create)\b/;

/**
 * Every file that may write those tables, and where its doors on a `generating` plan are covered.
 * A file not on `GENERATING_REACHABLE` is audited as unreachable from a `generating` plan, with the
 * reason — a reason is required so the exemption is a statement a reviewer can check.
 */
const AUDITED: Record<string, string> = {
  'lib/services/plansService.ts':
    'addProposals · deepenProposal · correctPlanBrief · correctProposal · withdrawProposal · recordPlanStep · recordPlanNarration · endPlanStep · markPlanned · declinePlan — each a row of planReviewVersion.test.ts. The remaining writers in the file (validatePlanProposals, approve/materialize, the revision lease, repo-pin moves) act on a `planned` plan or are reached only from a door above.',
  'lib/services/planSessionEndService.ts':
    'endSession (restarted) is a row of planReviewVersion.test.ts; it discards a generating plan.',
  'lib/services/abandonedPlanService.ts':
    'reconcileAbandoned is a row of planReviewVersion.test.ts.',
  'lib/services/planSessionResumeService.ts':
    'resumeAutomatically is a row of planReviewVersion.test.ts; the manual resume binds through the same bindWithin, whose repointSourceJob stamps lastActivityAt.',
  'lib/services/planDriftService.ts':
    'moves a PLANNED plan to `stale` (planStatusCanBeStale); never acts on a `generating` plan.',
  'lib/services/planAuthorFinishedBackfillService.ts':
    'the one-time authorFinished carry-over (MOTIR-10491), an operator script, not a door. It can reach a `generating` plan, but it writes ONLY the `authorFinished` key inside a proposal’s proposed fields, which nothing the review shows reads (no review DTO, hook or component names it), so the review version correctly stays put. Leaving `lastActivityAt` and the trail untouched is its own acceptance criterion; a card a live author step targets is skipped.',
  'lib/services/planRevisionsService.ts':
    'recordRevision appends to the trail inside a door above, in that door’s transaction; it is not a door itself.',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'generated') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('the plan review’s write doors are all audited (MOTIR-8127)', () => {
  it('no file outside the audited set writes the plan family’s tables', () => {
    const writers = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'app'))]
      .map((f) => relative(ROOT, f))
      // The repositories ARE the writes; the audit is of who calls them.
      .filter((f) => !f.startsWith('lib/repositories/'))
      .filter((f) => WRITE_CALL.test(readFileSync(join(ROOT, f), 'utf8')))
      .sort();

    expect(
      writers,
      'A file now writes the plan family’s tables. Add its doors to DOORS in ' +
        'tests/integration/plans/planReviewVersion.test.ts (or say why it cannot act on a ' +
        'generating plan) and list it in AUDITED here.',
    ).toEqual(Object.keys(AUDITED).sort());
  });

  it('every audited entry still names a writer (the list only shrinks with the code)', () => {
    for (const file of Object.keys(AUDITED)) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(WRITE_CALL.test(src), `${file} no longer writes the plan family — drop it`).toBe(true);
    }
  });
});
