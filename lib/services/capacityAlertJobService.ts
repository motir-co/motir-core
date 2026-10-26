import 'server-only';

import { reportCapacityAlertJobProblem } from '@/lib/monitoring/capacityAlertJobAlert';
import { capacityAlertEvaluationService } from '@/lib/services/capacityAlertEvaluationService';

/**
 * ONE PASS of the scheduled capacity alert job (Story MOTIR-9539 · MOTIR-9612).
 *
 * It calls the evaluation and nothing else: the threshold, raise and clear rules
 * all live in `capacityAlertEvaluationService`. What this adds is that a pass
 * NEVER THROWS — the next minute's pass is the retry, and a thrown pass would
 * dead-letter a job whose only fault was a gateway blip — and that the two
 * faults nobody else would see reach Sentry:
 *
 *  - `auth_refused` / `bad_response`: a misconfigured credential or gateway,
 *    one fingerprinted warning per pass;
 *  - anything the evaluation threw: one `error`, and `{ outcome: 'failed' }`.
 *
 * `not_configured` (no token — the normal state in CI and dev) and the
 * transient reasons are silent; the ledger's run output still records them.
 */

export type CapacityAlertJobResult =
  | { outcome: 'evaluated'; readAt: string; overShareCount: number; raisedCount: number }
  | { outcome: 'unavailable'; reason: string; raisedCount: number }
  | { outcome: 'failed' };

const REPORTED_REASONS = new Set(['auth_refused', 'bad_response']);

export const capacityAlertJobService = {
  async run(): Promise<CapacityAlertJobResult> {
    try {
      const result = await capacityAlertEvaluationService.evaluate();
      if (result.outcome === 'unavailable') {
        if (REPORTED_REASONS.has(result.reason)) {
          reportCapacityAlertJobProblem(result.reason as 'auth_refused' | 'bad_response');
        }
        return {
          outcome: 'unavailable',
          reason: result.reason,
          raisedCount: result.raised.length,
        };
      }
      const overShareCount = result.evaluation.entries
        .flatMap((entry) => entry.limits)
        .filter((row) => row.state === 'over_share').length;
      return {
        outcome: 'evaluated',
        readAt: result.evaluation.readAt.toISOString(),
        overShareCount,
        raisedCount: result.raised.length,
      };
    } catch (error) {
      reportCapacityAlertJobProblem('failed', error);
      return { outcome: 'failed' };
    }
  },
};
