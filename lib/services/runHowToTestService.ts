import { assertRunTokenScope } from '@/lib/services/dispatchRunService';
import { projectsService } from '@/lib/services/projectsService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { PublishTestInstructionsResultDTO } from '@/lib/dto/testInstructions';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// A RUN'S HOW TO TEST, posted by the CLI (MOTIR-10877) — the run door beside MOTIR-8722's
// `…/discrepancy` and `…/stop`. A hosted run's agent and an agent-instance run's agent hold
// no Motir token and `/api/mcp` refuses a run token, so `publish_test_instructions` never
// reached those lanes: the agent opened its pull request, wrote no How to test anywhere a
// person could read it, and the card went to Implemented with none. The prompt's NO MOTIR
// TOOLS route now has the agent write its How to test into `$MOTIR_AGENT_REPORT` as
// `howToTest`, and the CLI posts it here with the RUN's credential, beside each repository's
// pushed head.
//
// It is the SAME record as the MCP door's — `testInstructionsService.publish` is the one
// writer — attributed to the run in the path rather than to "the newest running run of the
// card". The run must be the caller's own and still running, and the card an OPEN leg of it;
// all three are read under the run row's lock inside the publish's own transaction.

/** What the CLI sends. */
export interface PublishRunHowToTestInput {
  /** The run target, `KEY-<n>` — a card the run holds as an open leg. */
  key: string;
  bodyMd: string;
  previewPath?: string | null | undefined;
  /** One per repository the run pushed to, with its pushed head. */
  repos?: readonly { repo: string; commitSha: string }[] | undefined;
}

export const runHowToTestService = {
  /**
   * Publish `key`'s How to test for the run `runId`. See the file header.
   *
   * @throws DispatchRunTokenOutOfScopeError — a run token naming another run.
   * @throws WorkItemNotFoundError — the card does not exist for this caller.
   * @throws DispatchRunNotFoundError / DispatchRunTerminalError / UnknownDispatchRunCardError
   * @throws TestInstructions*Error — the record's own refusals (caps, repositories, fields).
   */
  async publish(
    input: PublishRunHowToTestInput,
    ctx: ServiceContext,
    opts: { runId: string },
  ): Promise<PublishTestInstructionsResultDTO> {
    assertRunTokenScope(opts.runId, ctx);
    const identifier = input.key.trim().toUpperCase();
    // An unknown project answers the same `WorkItemNotFoundError` as an unknown card, as the
    // sibling run doors do — nothing about a key's existence leaks.
    let project: Awaited<ReturnType<typeof projectsService.getByKey>>;
    try {
      project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) throw new WorkItemNotFoundError(identifier);
      throw err;
    }
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
    return testInstructionsService.publish(
      {
        workItemId: item.id,
        bodyMd: input.bodyMd,
        previewPath: input.previewPath ?? null,
        repos: (input.repos ?? []).map((entry) => ({
          repoRef: entry.repo,
          commitSha: entry.commitSha,
        })),
        forRunId: opts.runId,
      },
      ctx,
    );
  },
};

function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}
