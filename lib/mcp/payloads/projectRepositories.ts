import { z } from 'zod/v4';
import {
  projectRepositorySchema,
  type V1ProjectRepository,
} from '@/lib/api/v1/projects/repositories';
import { definePayload } from './define';

// The `create_project_repository` payload (Story MOTIR-10162 · MOTIR-11038).
//
// The row the call leaves behind is the per-PROJECT repository row `/api/v1`
// publishes as `ProjectRepository` (MOTIR-3586), so the payload's `repository`
// PROBES that resource and the drift guard holds the two surfaces to one shape.
// It is widened by ONE field v1 does not carry — `seedSource`, the base the row
// starts from — because the caller CHOSE it (`starterKey`, or an empty base) and
// must be able to read back what was recorded. `outcome` and `establish` are the
// envelope: what this call did to the row, and the establish pass's own per-row
// result verbatim.

export const projectRepositoryCreationSchema = z.object({
  outcome: z.enum(['created', 'adopted', 'already_settled']),
  repository: projectRepositorySchema.extend({ seedSource: z.string() }),
  establish: z.object({
    outcome: z.enum(['created', 'adopted', 'failed', 'already_settled', 'not_attempted']),
    failureCode: z.string().nullable(),
    failureReason: z.string().nullable(),
  }),
});
export type McpProjectRepositoryCreation = z.infer<typeof projectRepositoryCreationSchema>;

export const createProjectRepositoryPayload = definePayload({
  schema: projectRepositoryCreationSchema as unknown as z.ZodType<
    {
      outcome: McpProjectRepositoryCreation['outcome'];
      repository: V1ProjectRepository & { seedSource: string };
      establish: McpProjectRepositoryCreation['establish'];
    } & Record<string, unknown>
  >,
  probes: [{ resource: 'ProjectRepository', select: (p) => [p.repository] }],
});
