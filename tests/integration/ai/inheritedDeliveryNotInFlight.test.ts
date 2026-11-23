import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { linkPrByIdentifier } from '../../helpers/prLink';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// AN INHERITED DELIVERY ROW IS NOBODY'S IN-FLIGHT CODE (Bug MOTIR-12098), on a REAL Postgres
// through the real link, webhook, `get_work_item` and dispatch-prompt doors.
//
// The defect, as MOTIR-11561 met it in production: with "Complete children when a parent is
// done" on, linking a pull request to ONE child writes an `inherited = true` row on the story
// (MOTIR-11835), so the story's completion waits for that pull request. The in-flight read
// took that row as the story's own open pull request: the story reported its child's bug
// branch as `source: 'own'`, every SIBLING reported it as the parent run it rides
// (`source: 'inherited'`, `fromKey` = the story), and a sibling's dispatch prompt told it to
// commit onto that branch. Only an EXPLICIT link is where a card's code lives.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { dispatchPromptService } = await import('@/lib/services/dispatchPromptService');
const { aiBoundaryService } = await import('@/lib/services/aiBoundaryService');
const { runGetWorkItem } = await import('@/lib/mcp/tools/getWorkItem');

const INSTALLATION_ID = 'inst-12098';
const REPO_PROVIDER_ID = '12098';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

async function makeScenario(email: string) {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  await adminDb.project.update({
    where: { id: project.id },
    data: { autoCompleteChildrenOnParentDone: true },
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  const story = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'story', title: 'The story' },
    ctx,
  );
  const a = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: 'Child A', parentId: story.id },
    ctx,
  );
  const b = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'subtask', title: 'Child B', parentId: story.id },
    ctx,
  );
  for (const item of [story, a, b])
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  return { project, ctx, story, a, b };
}

const opened = (number: number, headRef: string) =>
  githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A change (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });

const link = (identifier: string, number: number, headRef: string) =>
  linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });

function structuredOf(r: CallToolResult): Record<string, unknown> {
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return r.structuredContent as Record<string, unknown>;
}

const inFlightOf = async (identifier: string, ctx: { userId: string; workspaceId: string }) =>
  structuredOf(await runGetWorkItem({ key: identifier }, ctx))['inFlightCode'];

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a child-only link with "Complete children when a parent is done" on', () => {
  it('the story inherits the delivery row, and it is nobody’s in-flight code but the child’s', async () => {
    const s = await makeScenario('12098-child-only@example.com');
    const refA = `subtask/${s.a.identifier}-fix`;
    await link(s.a.identifier, 57, refA);
    await opened(57, refA);

    // The precondition the defect needs: the story holds the row, as inherited.
    const storyRows = await adminDb.workItemDelivery.findMany({
      where: { workItemId: s.story.id },
      select: { inherited: true },
    });
    expect(storyRows).toEqual([{ inherited: true }]);

    // The linked child: its own pull request, as before.
    expect(await inFlightOf(s.a.identifier, s.ctx)).toEqual([
      expect.objectContaining({ prNumber: 57, branch: refA, source: 'own' }),
    ]);
    // The defect: the sibling read A's branch as the story's parent run…
    expect(await inFlightOf(s.b.identifier, s.ctx)).toEqual([]);
    // …and the story read it as its own.
    expect(await inFlightOf(s.story.identifier, s.ctx)).toEqual([]);

    // The hosted planner's item read is handed the same answer.
    const read = await aiBoundaryService.getItem(s.project.id, s.b.identifier, s.ctx);
    expect(read.item.inFlightCode).toEqual([]);

    // And the sibling's dispatch is not told to commit onto A's branch.
    const prompt = await dispatchPromptService.getDispatchPrompt(
      s.project.id,
      s.b.identifier,
      s.ctx,
    );
    expect(prompt.prompt).not.toContain(refA);
  });

  it('an EXPLICIT story link is still the parent run its children ride, beside an inherited one', async () => {
    const s = await makeScenario('12098-explicit@example.com');
    const storyRef = `parent/${s.story.identifier}-run`;
    const refA = `subtask/${s.a.identifier}-fix`;
    await link(s.story.identifier, 60, storyRef);
    await opened(60, storyRef);
    await link(s.a.identifier, 61, refA);
    await opened(61, refA);

    const parentRun = expect.objectContaining({
      prNumber: 60,
      branch: storyRef,
      source: 'inherited',
      fromKey: s.story.identifier,
    });
    expect(await inFlightOf(s.b.identifier, s.ctx)).toEqual([parentRun]);
    expect(await inFlightOf(s.story.identifier, s.ctx)).toEqual([
      expect.objectContaining({ prNumber: 60, branch: storyRef, source: 'own' }),
    ]);
    const prompt = await dispatchPromptService.getDispatchPrompt(
      s.project.id,
      s.b.identifier,
      s.ctx,
    );
    expect(prompt.prompt).toContain(storyRef);
    expect(prompt.prompt).not.toContain(refA);
  });
});
