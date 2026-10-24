import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { seedCreatedRepo } from './hosted-run-seed';
import { seedMyAgents, type MyAgentsSeed } from './my-agents-seed';
import { claudeCredentialFile, runReleaseFile, runRepositoryFile } from './agent-terminal/paths';
import { workItemsService } from '@/lib/services/workItemsService';

// RUN A READY CARD IN YOUR OWN AGENT — the acceptance seed (Story MOTIR-6864 ·
// MOTIR-7031), for `regression-run-in-my-agent.spec.ts`.
//
// It is `my-agents-seed.ts`'s owner and project (the persistent fake fleet, the
// credit pre-flight answered by the lane's motir-ai mock) plus what a run needs
// on top: a `created`-state repository the start's write pre-flight accepts
// (`hosted-run-seed.ts`'s shape), and ready cards to send.
//
// ⚠️ THE AGENT IS NOT SEEDED AS A ROW. It is created through the product's own
// route, so its machine, volume and terminal config are the fleet's and its boot
// runs the real probes through the exec door; then it is signed in the way a
// person signs in — the coding agent's credential file appears in its home — and
// hibernated by the real idle check, which records that sign-in on its way down.

export const REPO_OWNER = 'motir-projects-e2e';

export interface RunInMyAgentSeed extends MyAgentsSeed {
  /** The project's one repository, `owner/name` — what the run's pull request is opened on. */
  repository: string;
}

export async function seedRunInMyAgent(tag: string): Promise<RunInMyAgentSeed> {
  const seed = await seedMyAgents(tag);
  const name = `invoices-${tag.slice(-6)}`;
  await seedCreatedRepo(seed.workspaceId, seed.organizationId, seed.projectId, {
    owner: REPO_OWNER,
    name,
  });
  return { ...seed, repository: `${REPO_OWNER}/${name}` };
}

/** A READY leaf card on the seed's project (no blockers, in the to-do category). */
export async function seedReadyCard(
  seed: MyAgentsSeed,
  title: string,
): Promise<{ id: string; key: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title },
    { userId: seed.userId, workspaceId: seed.workspaceId },
  );
  return { id: item.id, key: item.identifier };
}

/** Give `card` an open blocker — it stops being ready (behind any page already showing it). */
export async function blockCard(seed: MyAgentsSeed, cardId: string, title: string): Promise<void> {
  const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };
  const blocker = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title },
    ctx,
  );
  await workItemsService.linkWorkItems(
    { fromId: cardId, toId: blocker.id, kind: 'is_blocked_by' },
    ctx,
  );
}

/**
 * Call the app's API FROM THE PAGE, so the request carries every cookie the
 * browser holds — the active-workspace cookie is `Secure` on a production build
 * and is not sent by Playwright's own request client over plain http.
 */
export async function api(
  page: Page,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: unknown = text;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON — kept as text for the assertion message
      }
      return { status: res.status, json };
    },
    { method, url, body },
  );
}

interface AgentRow {
  id: string;
  state: string;
  signInState?: string;
}

async function agentRow(page: Page, seed: MyAgentsSeed, id: string): Promise<AgentRow | undefined> {
  const list = await api(page, 'GET', `/api/projects/${seed.projectIdentifier}/instances`);
  expect(list.status).toBe(200);
  return (list.json as { instances: AgentRow[] }).instances.find((row) => row.id === id);
}

/** The agent's state on the committed read. */
export async function agentState(
  page: Page,
  seed: MyAgentsSeed,
  id: string,
): Promise<string | undefined> {
  return (await agentRow(page, seed, id))?.state;
}

/**
 * Create an agent through the product's own route and wait for its boot to settle.
 * Also names the project's repository for the stub run (`runRepositoryFile`).
 */
export async function createAgent(
  page: Page,
  seed: RunInMyAgentSeed,
  name: string,
  profileId = 'claude',
): Promise<string> {
  const res = await api(page, 'POST', `/api/projects/${seed.projectIdentifier}/instances`, {
    name,
    profileId,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const { instance } = res.json as { instance: { id: string } };
  await expect.poll(() => agentState(page, seed, instance.id), { timeout: 30_000 }).toBe('running');
  const repositoryFile = runRepositoryFile(instance.id);
  mkdirSync(dirname(repositoryFile), { recursive: true });
  writeFileSync(repositoryFile, `${seed.repository}\n`);
  return instance.id;
}

/** The coding agent's sign-in, as `/login` in its terminal would leave it: the credential file. */
export function signInCodingAgent(instanceId: string): void {
  const file = claudeCredentialFile(instanceId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"stub":"e2e"}\n', { mode: 0o600 });
}

/** …and signed out again: the file is gone. */
export function signOutCodingAgent(instanceId: string): void {
  rmSync(claudeCredentialFile(instanceId), { force: true });
}

/** Thirty quiet minutes pass: the REAL idle check hibernates each agent. */
export async function letIdleWindowPass(page: Page, ids: string[]): Promise<void> {
  const res = await api(page, 'POST', '/api/_test/agent-instances/idle', {
    instanceIds: ids,
    advanceMinutes: 31,
  });
  expect(res.status).toBe(200);
  expect(res.json).toEqual({ results: Object.fromEntries(ids.map((id) => [id, 'idle'])) });
}

/** Wake an agent through My agents' own route and wait for it to be running. */
export async function wakeAgent(page: Page, seed: MyAgentsSeed, id: string): Promise<void> {
  const res = await api(
    page,
    'POST',
    `/api/projects/${seed.projectIdentifier}/instances/${id}/wake`,
  );
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await expect.poll(() => agentState(page, seed, id), { timeout: 30_000 }).toBe('running');
}

/**
 * Let the run's coding agent finish: the fake `claude -p` is waiting on this file,
 * and `motir-run.py` then links the pull request it names — the number the fake
 * GitHub opened for the run's branch.
 */
export function finishRun(instanceId: string, runId: string, pullRequest: number): void {
  const file = runReleaseFile(instanceId, runId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${pullRequest}\n`);
}

/** The work item's runs on the committed read — what "no run was created" is asserted against. */
export async function runsOf(
  page: Page,
  key: string,
): Promise<Array<{ id: string; status: string; origin: string }>> {
  const res = await api(page, 'GET', `/api/work-items/${key}/dispatch-runs`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return (res.json as { runs: Array<{ id: string; status: string; origin: string }> }).runs;
}
