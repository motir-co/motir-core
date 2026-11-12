import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PROJECT_REPO_ROLES } from '@/lib/projectRepos/vocabulary';
import {
  projectRepoCreationService,
  type CreateProjectRepositoryArgs,
} from '@/lib/services/projectRepoCreationService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { derived } from '../payloads/define';
import { createProjectRepositoryPayload } from '../payloads/projectRepositories';
import { presentProjectRepository } from '@/lib/api/v1/projects/repositories';
import { toToolError, toolError, toolOk } from '../toolResult';

// `create_project_repository` (Story MOTIR-10162 · Subtask MOTIR-11038) — the
// door an init card's run uses to bring the repository it declares into being.
//
// A THIN adapter: it parses its arguments, calls
// `projectRepoCreationService.createProjectRepositoryFromStarter` once, and maps
// what comes back. The sequence (read the set, decide, append only when absent,
// establish that one row) and every decision live in the service, because the
// run-credential door is this same implementation's second transport and a v1
// route may not import `@/lib/mcp/`.
//
// ── ⚠️ THE PERMISSION ─────────────────────────────────────────────────────
// The set service asserts `repository:manage` on every write, so that is this
// tool's row in `TOOL_PERMISSIONS` — and `CLI_TOKEN_GRANT` is WIDENED to carry
// it in the same change (argued beside that constant), because the dispatch
// seam refuses before this handler runs and the agent driving the CLI is the
// caller the door exists for.

export const CREATE_PROJECT_REPOSITORY_TOOL_NAME = 'create_project_repository';

const inputSchema = {
  projectKey: z
    .string()
    .trim()
    .min(1)
    .describe('The project key, e.g. "ACME" — the project whose repository set gains the row.'),
  name: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The BARE repository name to create, e.g. "acme-infra" — no owner, no "/". The name an ' +
        "init card declares as its `initRepositoryName`. Matched against the project's rows " +
        'case-insensitively, as the git host matches names.',
    ),
  role: z
    .enum(PROJECT_REPO_ROLES)
    .describe(`The repository's role in the project — one of ${PROJECT_REPO_ROLES.join(' · ')}.`),
  starterKey: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'A starter (seed-registry) key the repository starts from. OMIT it for an EMPTY base — ' +
        'omission never means the role\'s default starter, so "no starter covers this base" is ' +
        'expressible.',
    ),
};

/** The adapter. Every refusal is a tool error carrying its own code. */
export async function runCreateProjectRepository(
  args: CreateProjectRepositoryArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const result = await projectRepoCreationService.createProjectRepositoryFromStarter(args, ctx);
    if (result.outcome === 'failed') {
      // The row's OWN failure, verbatim — one failure never acquires two
      // spellings. The row is left `failed` and resumable: a repeat call
      // re-attempts it rather than appending another.
      return toolError(
        result.establish.failureCode ?? 'REPO_ESTABLISH_FAILED',
        `${result.establish.failureReason ?? 'The repository could not be created.'} ` +
          `The row "${result.row.name}" is left failed and resumable — calling again re-attempts it.`,
      );
    }
    const sentence =
      result.outcome === 'created'
        ? `Created the repository "${result.row.name}" for ${args.projectKey}.`
        : result.outcome === 'adopted'
          ? `Established the existing row "${result.row.name}" in ${args.projectKey}.`
          : `The repository "${result.row.name}" was already settled in ${args.projectKey}; nothing was written.`;
    return toolOk(
      sentence,
      derived(createProjectRepositoryPayload, {
        outcome: result.outcome,
        repository: { ...presentProjectRepository(result.row), seedSource: result.row.seedSource },
        establish: result.establish,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerCreateProjectRepository(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    CREATE_PROJECT_REPOSITORY_TOOL_NAME,
    {
      title: 'Create project repository',
      description:
        "Create ONE repository in a project's repository set and establish it — the call an " +
        'init card makes for the repository it declares. It appends a row for `name` with ' +
        '`role` and the base `starterKey` names (omitted = an EMPTY base, never the role’s ' +
        'default starter), then creates, seeds and settles exactly that row. ' +
        'The answer’s `outcome` is `created` (this call appended the row), `adopted` (the row ' +
        'was already in the project with the same base and role, and this call established it) ' +
        'or `already_settled` (the row was settled; nothing was written). The establish pass’s ' +
        'own per-row result rides beside it as `establish`. ' +
        'REPLAY-SAFE: repeating the same call finds the row it made and writes nothing, so a ' +
        'retried init never makes a second repository. ' +
        'Refusals: REPO_EXISTS_WITH_OTHER_SPEC (a row of this name exists with a different ' +
        'base or role — nothing is changed), REPO_ESTABLISH_BUSY (another run is creating the ' +
        'row), and a failed attempt answers the row’s OWN failure code verbatim with its ' +
        'reason — e.g. REPO_NAME_TAKEN_ON_HOST when the name is taken on the git host; that ' +
        'row stays failed and a repeat call re-attempts it. The set’s own refusals ' +
        '(PROJECT_REPO_NAME_TAKEN, PROJECT_REPO_INVALID_FIELD, PROJECT_REPO_SEED_REFUSED, …) ' +
        'and the paid-AI-plan precondition (ai_plan_required, plan_unknown) answer their own ' +
        'codes. Requires `repository:manage` on the project.',
      inputSchema,
    },
    async (args, extra) => runCreateProjectRepository(args, resolveContext(extra)),
  );
}
