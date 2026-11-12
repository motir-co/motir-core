import { UnknownDispatchRunCardError } from '@/lib/dispatchRuns/errors';
import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { assertRunTokenScope, dispatchRunService } from '@/lib/services/dispatchRunService';
import {
  projectRepoCreationService,
  type CreateProjectRepositoryResult,
} from '@/lib/services/projectRepoCreationService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { isInitCard } from '@/lib/workItems/initCard';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// ── A DISPATCHED RUN CREATES ITS REPOSITORY (Story MOTIR-10162 · MOTIR-11055) ──
//
// The SECOND transport onto the one creation sequence
// (`projectRepoCreationService`, MOTIR-11038), on the only credential an init
// card's agent lane holds: the run's own. The agent holds no token — it writes a
// `repository` member into its self-report and the CLI posts it to
// `POST /api/v1/dispatch-runs/{id}/repository` (the route that calls this).
//
// What THIS service owns, and nothing else:
//
//   1. THE BINDING, in the shipped order — `assertRunTokenScope` before any read
//      (so a run token naming another run learns nothing), then the card, then
//      the run under its own lock (`findOpenLegOnRun`): an unknown run, another
//      tenant's and another operator's answer the same not-found, a closed run
//      answers terminal, and a card that is not an open leg of the run is refused
//      `UNKNOWN_DISPATCH_RUN_CARD`.
//   2. THE TWO JUDGEMENTS A REPOSITORY TOOL CANNOT MAKE, because they need the
//      run's CARD: the card must be an init card (`isInitCard`, the one rule over
//      the subject and the declaration) — a run is a BUILD lane, and an agent that
//      decided on its own to create a repository is doing what no card asked for;
//      and a request must name the repository the card DECLARES, because the
//      routing pass matches a settled row against that name, so a creation under
//      any other name is a repository nothing routes to. A card that declares no
//      name accepts the requested one: the run is the only actor that knows it.
//
// The creation itself is DELEGATED: no outcome, refusal code or row shape is
// re-spelled here, so a refusal reads the same whichever transport carried it.

/** What the run asks for — the creation sequence's own arguments, less the project. */
export interface RunRepositoryRequest {
  /** The card the run holds — an open leg of the run, and an init card. */
  key: string;
  /** The repository's BARE name. */
  name: string;
  role: ProjectRepoRoleDto;
  /** A seed-registry key; omitted means an EMPTY base. */
  starterKey?: string;
}

/**
 * 422 — the run's card carries no init subject and declares no repository, so this
 * is a BUILD lane, not a repository-creation one. Nothing was written.
 */
export class RunCardNotInitCardError extends Error {
  readonly code = 'RUN_CARD_NOT_INIT_CARD' as const;
  constructor(readonly key: string) {
    super(
      `${key} is not an init card, so this run may not create a repository for it. Only a ` +
        'card that declares the repository it creates may ask the run to create one.',
    );
    this.name = 'RunCardNotInitCardError';
  }
}

/**
 * 422 — the run's card declares one repository name and the request asks for
 * another. Both names are in the message. Nothing was written.
 */
export class RunRepositoryNameMismatchError extends Error {
  readonly code = 'RUN_REPOSITORY_NAME_MISMATCH' as const;
  constructor(
    readonly key: string,
    readonly declared: string,
    readonly requested: string,
  ) {
    super(
      `${key} declares the repository "${declared}", but this run asked to create ` +
        `"${requested}". Ask for "${declared}" — a repository under any other name is one ` +
        'nothing waiting on this card is routed to.',
    );
    this.name = 'RunRepositoryNameMismatchError';
  }
}

/** The project key of a `KEY-<n>` identifier, or null when it has no number part. */
function projectKeyOf(key: string): string | null {
  const dash = key.lastIndexOf('-');
  return dash > 0 ? key.slice(0, dash) : null;
}

export const runRepositoryCreationService = {
  /**
   * Create — or find already created — the repository the run's init card
   * declares. See the file header for the order and the refusals.
   *
   * @throws DispatchRunTokenOutOfScopeError — a run token naming another run.
   * @throws WorkItemNotFoundError — the card does not exist for this caller.
   * @throws DispatchRunNotFoundError / DispatchRunTerminalError — not this caller's running run.
   * @throws UnknownDispatchRunCardError — the card is not an open leg of the run.
   * @throws RunCardNotInitCardError / RunRepositoryNameMismatchError — this door's two refusals.
   * @throws the creation sequence's own refusals, unchanged.
   */
  async createRunRepository(
    runId: string,
    request: RunRepositoryRequest,
    ctx: ServiceContext,
  ): Promise<CreateProjectRepositoryResult> {
    assertRunTokenScope(runId, ctx);
    const key = request.key.trim().toUpperCase();
    const projectKey = projectKeyOf(key);
    if (projectKey === null) throw new WorkItemNotFoundError(key);

    let project: Awaited<ReturnType<typeof projectsService.getByKey>>;
    try {
      project = await projectsService.getByKey(projectKey, ctx);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw new WorkItemNotFoundError(key);
      throw err;
    }
    const item = await workItemsService.getWorkItemByIdentifier(project.id, key, ctx);

    const leg = await dispatchRunService.findOpenLegOnRun(runId, item.id, ctx);
    if (!leg) throw new UnknownDispatchRunCardError(key);

    const declared = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: item.projectId },
      (tx) => workItemRepository.findInitRepositoryName(item.id, tx),
    );
    if (!isInitCard({ subject: item.subject, initRepositoryName: declared })) {
      throw new RunCardNotInitCardError(key);
    }
    const name = request.name.trim();
    if (declared !== null && declared.trim().toLowerCase() !== name.toLowerCase()) {
      throw new RunRepositoryNameMismatchError(key, declared, name);
    }

    return projectRepoCreationService.createProjectRepositoryFromStarter(
      {
        projectKey: project.identifier,
        name,
        role: request.role,
        ...(request.starterKey !== undefined ? { starterKey: request.starterKey } : {}),
      },
      ctx,
    );
  },
};
