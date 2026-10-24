import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { adminDb } from './db-reset';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { workItemsService } from '@/lib/services/workItemsService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { appendEvents, closeRun, ingestContext, openRun } from './agent-run-seed';
import { openAgentSession, publishDesignResult } from './design-approval-seed';
import { seedHostedRun, type HostedRunSeed } from './hosted-run-seed';

// THE TO-RESUME E2E SEED (Story MOTIR-7701 · Subtask MOTIR-7715), for
// `regression-to-resume.spec.ts`.
//
// `hosted-run-seed.ts`'s workspace — an owner, a project, a `created`-state repository
// the hosted pre-flight can write, a paid AI plan — plus, per story the spec walks, the
// shape the whole story is about: a story with a DESIGN child, a code child
// `blocked_by` it, a child that already landed, and a parent run over the three that
// stopped at the design's awaiting gate (`stopReason: 'gated'`).
//
// ⚠️ THE GATE IS NOT SEEDED. It is raised by PUBLISHING, through the real
// `publish_design_result` tool over `/api/mcp` — `design-approval-seed.ts` says why —
// and it has to exist BEFORE the run closes: the close is what records the gates it
// held (`dispatch_run_held_gate`, MOTIR-7703), and a gate published afterwards would
// leave the run holding nothing, which reads `released` at once.
//
// ⚠️ THE TWO RUNS ARE OPENED THROUGH THE DOORS THAT OPEN THEM IN THE PRODUCT, as far as a
// spec can reach one. A LOCAL run is the CLI's: opened, reported and closed over the
// PAT-authenticated `/api/v1` ingest (`agent-run-seed.ts`). A HOSTED run is opened by
// `hostedRunService.start` inside the app, which no spec can call with a stopping
// container behind it — so it is opened through `dispatchRunService.open` with
// `origin: 'hosted'`, the same service call the start makes, as the owner (the run's
// dispatcher, whose credits and access the auto-resume will check). Its container's
// half — the leg it integrated onto the session branch, and the gated close — is the
// same service's `appendEvents` / `close`, which is what the container's ingest calls.
//
// ⚠️ THE DESIGN IS ASSIGNED TO THE OWNER, so the viewer is the gate's decider: the To
// resume entry names *You decide* and offers *Review*, the door this walk presses.

/** The model the hosted run ran with — offered by the lane's hosted fixture. */
export const HOSTED_MODEL = 'e2e-hosted-default';
/** The branch the hosted run's integrated leg landed on — what the resume carries on. */
export const SESSION_BRANCH = 'motir/auto-20261007-0900';

export interface ToResumeSeed {
  hosted: HostedRunSeed;
  /** `CLI_TOKEN_GRANT` — a dispatched run's own grant, for the publishes. */
  agentToken: string;
  /** A v1 token for the LOCAL run's ingest, as `motir run`'s reporter holds one. */
  ingestToken: string;
}

export interface GatedStory {
  storyKey: string;
  storyTitle: string;
  designKey: string;
  designTitle: string;
  codeKey: string;
  runId: string;
}

export interface StoryTitles {
  story: string;
  design: string;
  code: string;
  landed: string;
}

export async function seedToResume(email: string, identifier: string): Promise<ToResumeSeed> {
  const hosted = await seedHostedRun(email, identifier);
  const agentToken = (
    await apiTokensService.create(hosted.userId, hosted.workspaceId, {
      label: 'to-resume-agent',
      projectId: hosted.projectId,
      permissions: [...CLI_TOKEN_GRANT],
    })
  ).token;
  const ingestToken = (
    await apiTokensService.create(hosted.userId, hosted.workspaceId, {
      label: 'to-resume-ingest',
      projectId: hosted.projectId,
      permissions: ['project:browse', 'work_item:edit'],
    })
  ).token;
  return { hosted, agentToken, ingestToken };
}

/**
 * A story whose parent run stopped at its design's gate. `where` says whose run it was:
 * `hosted` (it resumes itself once the gate is approved) or `local` (a terminal's, which
 * a person continues with `motir continue <KEY>`).
 */
export async function seedGatedStory(
  seed: ToResumeSeed,
  baseURL: string,
  titles: StoryTitles,
  where: 'hosted' | 'local',
): Promise<GatedStory> {
  const { hosted } = seed;
  const ctx = { userId: hosted.userId, workspaceId: hosted.workspaceId };
  const create = (
    title: string,
    extra: { parentId?: string; kind?: 'story' | 'subtask'; type?: 'design' | 'code' } = {},
  ) =>
    workItemsService.createWorkItem(
      {
        projectId: hosted.projectId,
        kind: extra.kind ?? 'subtask',
        title,
        ...(extra.parentId ? { parentId: extra.parentId } : {}),
        ...(extra.type ? { type: extra.type } : {}),
        assigneeId: hosted.userId,
      },
      ctx,
    );

  const story = await create(titles.story, { kind: 'story' });
  const landed = await create(titles.landed, { parentId: story.id, type: 'code' });
  const design = await create(titles.design, { parentId: story.id, type: 'design' });
  const code = await create(titles.code, { parentId: story.id, type: 'code' });
  await workItemsService.linkWorkItems(
    { fromId: code.id, toId: design.id, kind: 'is_blocked_by' },
    ctx,
  );
  // Where a run leaves its cards: the story and its legs claimed (In Progress) — a
  // design must be, for its approval to write Done (`design-approval-seed.ts`).
  for (const item of [story, landed, design]) {
    await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  }
  // The blocked leg was claimed with the rest of the set; readiness refuses the status
  // door while its blocker is open, so the claim's own state is written directly.
  await adminDb.workItem.update({ where: { id: code.id }, data: { status: 'in_progress' } });

  // THE QUESTION: publishing raises the awaiting `design_result` gate.
  const client = await openAgentSession(seed.agentToken, baseURL);
  try {
    const published = await publishDesignResult(client, design.identifier);
    expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
  } finally {
    await client.close();
  }

  const cards = [landed, design, code].map((leg) => ({ key: leg.identifier }));
  let runId: string;
  if (where === 'hosted') {
    const { run } = await dispatchRunService.open(
      {
        projectKey: hosted.projectKey,
        command: 'run_scope',
        origin: 'hosted',
        agent: 'opencode',
        model: HOSTED_MODEL,
        reportedBy: 'cli',
        scopeKey: story.identifier,
        cards: cards.map((c) => ({ ...c, disposition: 'queued' as const })),
      },
      ctx,
    );
    runId = run.id;
    await dispatchRunService.appendEvents(
      runId,
      [
        {
          kind: 'card_settled',
          workItemKey: landed.identifier,
          disposition: 'integrated',
          sessionBranch: SESSION_BRANCH,
        },
      ],
      ctx,
    );
    await settleLanded(landed.id);
    await dispatchRunService.close(runId, { stopReason: 'gated' }, ctx);
  } else {
    const api: APIRequestContext = await ingestContext(seed.ingestToken, baseURL);
    try {
      runId = await openRun(api, {
        projectKey: hosted.projectKey,
        command: 'run_scope',
        scopeKey: story.identifier,
        agent: 'claude',
        cards,
      });
      await appendEvents(api, runId, [
        {
          kind: 'card_settled',
          workItemKey: landed.identifier,
          disposition: 'integrated',
          sessionBranch: `session/${story.identifier.toLowerCase()}-run`,
        },
      ]);
      await settleLanded(landed.id);
      await closeRun(api, runId, 'gated');
    } finally {
      await api.dispose();
    }
  }

  return {
    storyKey: story.identifier,
    storyTitle: titles.story,
    designKey: design.identifier,
    designTitle: titles.design,
    codeKey: code.identifier,
    runId,
  };
}

/** The leg the run integrated reads Implemented, as the run's own settle leaves it. */
async function settleLanded(id: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { status: 'implemented' } });
}
