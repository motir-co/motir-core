import { z } from 'zod/v4';
import {
  presentProjectRepository,
  projectRepositorySchema,
} from '@/lib/api/v1/projects/repositories';
import { PROJECT_REPO_ROLES } from '@/lib/projectRepos/vocabulary';
import type { CreateProjectRepositoryResult } from '@/lib/services/projectRepoCreationService';

// The run's REPOSITORY door (Story MOTIR-10162 · MOTIR-11055) —
// `POST /api/v1/dispatch-runs/{id}/repository`. The CLI posts it with the run's own
// credential when its agent — an init card's, which holds no Motir token — wrote a
// `repository` member into its self-report. Its home is beside the run's other
// agent-report modules (`unbuildableReport.ts`, `runAgentReports.ts`) for the same
// reason they live here: a body the CLI sends on its agent's behalf.

/** What the CLI sends: the card the run holds, and the repository it asks for. */
export const dispatchRunRepositoryBodySchema = z
  .object({
    /** The init card's `KEY-<n>` — an open leg of the run. */
    key: z.string().trim().min(1),
    /** The repository's BARE name — no owner, no `/`. Its casing is kept. */
    name: z.string().trim().min(1),
    /** The repository's role in the project. */
    role: z.enum(PROJECT_REPO_ROLES),
    /** A starter (seed-registry) key. OMITTED means an EMPTY base, never the role's
     *  default starter; a blank one is refused rather than read as omitted. */
    starterKey: z.string().trim().min(1).optional(),
  })
  .strict();
export type V1DispatchRunRepositoryBody = z.infer<typeof dispatchRunRepositoryBodySchema>;

/**
 * The answer — the creation sequence's own `outcome` and the row it left, with the
 * establish pass's per-row result beside it, verbatim. The row is v1's
 * `ProjectRepository` widened by the base it was recorded with (`seedSource`),
 * which the caller chose and must be able to read back. `failed` is an ANSWER, not
 * a refusal: the row is `failed` and resumable, and `establish` says why.
 */
export const dispatchRunRepositorySchema = z.object({
  outcome: z.enum(['created', 'adopted', 'already_settled', 'failed']),
  repository: projectRepositorySchema.extend({ seedSource: z.string() }),
  establish: z.object({
    outcome: z.enum(['created', 'adopted', 'failed', 'already_settled', 'not_attempted']),
    failureCode: z.string().nullable(),
    failureReason: z.string().nullable(),
  }),
});
export type V1DispatchRunRepository = z.infer<typeof dispatchRunRepositorySchema>;

export function presentDispatchRunRepository(
  result: CreateProjectRepositoryResult,
): V1DispatchRunRepository {
  return {
    outcome: result.outcome,
    repository: { ...presentProjectRepository(result.row), seedSource: result.row.seedSource },
    establish: {
      outcome: result.establish.outcome,
      failureCode: result.establish.failureCode,
      failureReason: result.establish.failureReason,
    },
  };
}
