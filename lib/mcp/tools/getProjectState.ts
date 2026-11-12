import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ProjectStateDto } from '@/lib/dto/projectState';
import { projectStateService } from '@/lib/services/projectStateService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `get_project_state` (MOTIR-1968) — the project-CONFIGURATION read a planning
// agent needs to VERIFY a tenant precondition instead of asserting one.
//
// The MCP surface has always been able to answer "what work exists" and never
// "what is this project's setup". So an agent planning over it could only
// assert: MOTIR-1755 was authored twice on unverified tenant state — first that
// the repos had never been connected (they had, months earlier), then that the
// code graph followed from the grant (zero of five repos had one, and no shipped
// path could give them one). Neither claim was checkable, and catching the second
// cost a card of manual audit. This is the read that would have answered both in
// one call. `list_projects` (MOTIR-1879) closed the same gap one level out —
// "which projects are there" — and this is its inward continuation.
//
// A thin adapter over `projectStateService.getProjectState`: no business logic
// here, no Prisma, and every answer is the shipped one (the planning-host gate,
// the migrate wizard's index projection, the project repository set, the
// onboarding run). See that service for what each field is read from and why.
//
// Tenancy: `projectKey` selects WITHIN the token's workspace, it does not choose
// one. The service resolves the key through `projectsService.getByKey`, which is
// bound to `ctx.workspaceId` and browse-gated, so another tenant's key reads as
// a plain not-found — the same 404-not-403 answer every other tool gives.
//
// READ-ONLY, and deliberately so: there is no way here to stamp the onboarding
// marker, kick an index, or advance a migrate run. Reporting a precondition and
// satisfying it are different acts, and only the first belongs on this surface.

export const GET_PROJECT_STATE_TOOL_NAME = 'get_project_state';

const inputSchema = {
  projectKey: projectKeyField,
};

/** Compact human summary — the four questions, one line each. */
export function summarizeProjectState(state: ProjectStateDto): string {
  const { project, planningGate, code, repoSet, onboarding, starterLibrary, contentLanguage } =
    state;
  const established =
    planningGate === 'workspace'
      ? `established (onboarding ran ${project.onboardingRanAt})`
      : 'NOT established — never onboarded';

  const codeLine = !code.installed
    ? 'Code: no GitHub App installation in this workspace'
    : code.index.total === 0
      ? 'Code: App installed, but the grant covers no repositories'
      : `Code: App installed · ${code.index.indexedCount}/${code.index.total} repos indexed` +
        (code.index.hasRunning ? ' · an index is running' : '');

  const repoLines = code.index.repos.map((repo) => `  - ${repo.repoRef} · ${repo.status}`);

  const setLine =
    repoSet.length === 0
      ? 'Repository set: none recorded for this project'
      : `Repository set: ${repoSet.map((row) => `${row.name} (${row.role}/${row.state})`).join(', ')}`;

  const onboardingLine = onboarding
    ? `Onboarding run: step ${onboarding.step} · ${onboarding.status} · codeGraphReady=${onboarding.codeGraphReady} · conventionApprovedAt=${onboarding.conventionApprovedAt ?? 'null'}`
    : 'Onboarding run: none (this project never ran the migrate wizard)';

  return [
    `${project.key} — ${project.name}`,
    `Planning gate: ${planningGate} — ${established}`,
    codeLine,
    ...repoLines,
    setLine,
    onboardingLine,
    starterLibrary.length === 0
      ? 'Starter library: no active entry'
      : `Starter library: ${starterLibrary.length} active ${starterLibrary.length === 1 ? 'entry' : 'entries'} (${starterLibrary.map((entry) => entry.key).join(', ')})`,
    `Content language: ${contentLanguage}`,
  ].join('\n');
}

/** The adapter: resolve the project by key, then report its planning preconditions. */
export async function runGetProjectState(
  args: { projectKey: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const state = await projectStateService.getProjectState(
      args.projectKey.trim().toUpperCase(),
      ctx,
    );
    // Dual content: the summary for a human watching, the whole DTO for the
    // agent. The DTO is spread rather than nested so a caller reads
    // `structuredContent.code` / `.planningGate` directly — `structuredContent`
    // must be an object, and this one already is.
    return toolOk(summarizeProjectState(state), exempt('get_project_state', { ...state }));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerGetProjectState(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    GET_PROJECT_STATE_TOOL_NAME,
    {
      title: 'Get project state',
      description:
        "Read a project's PLANNING PRECONDITIONS — the configuration an agent should verify " +
        'before planning against it, rather than assume. Answers, in one call: is the project ' +
        'ESTABLISHED (the onboarding marker, via the same gate the planning surfaces read); is ' +
        'a GitHub App INSTALLED and which repositories are granted; is each of those repos ' +
        'code-INDEXED or still pending; what is the project’s own repository SET; and where ' +
        'its onboarding run stopped (or null if it never had one). It also returns the ' +
        'organisation’s CONTENT LANGUAGE (`contentLanguage`), the language work content is ' +
        'written in, and the STARTER LIBRARY (`starterLibrary`): every active seed registry ' +
        'entry, whole — role, stack, use cases, sizes, hosting targets — the same list the ' +
        'hosted planner is handed, to judge which starter covers a repository the plan has ' +
        'to create. It is present for a project with no repositories, and `[]` only when no ' +
        'entry is active. Read-only — it reports ' +
        'state, it never changes it. A project with nothing configured returns a well-formed ' +
        '"nothing configured" answer, never an error, so "there is no code" is ' +
        'distinguishable from "I could not look". Honors the same access checks as the UI; ' +
        'the project key resolves inside the token’s own workspace.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runGetProjectState(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
