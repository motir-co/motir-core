import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { adminDb } from './db-reset';
import { AGENT_HOMES, agentHome, runReleaseFile } from './agent-terminal/paths';
import { recomputeWorkItemCiState } from '@/lib/services/deliveryVerdict';
import { recomputeWorkItemFixReason } from '@/lib/services/fixReasonService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { RunInMyAgentSeed } from './run-in-my-agent-seed';

// FIX IN MY AGENT — the acceptance seams that are not the product's (Story MOTIR-8981 ·
// MOTIR-9056), for `regression-fix-in-my-agent.spec.ts`.
//
// The red and the green are check rows written the way `fix-hosted-seed.ts` writes
// them, then settled through the SHIPPED recomputes (`recomputeWorkItemCiState`,
// `recomputeWorkItemFixReason`), so the card reads exactly what a delivered verdict
// leaves behind. What a webhook adds on top (a signature, the provider's installation)
// is not what this story is about, and the project's repository here is a `created`
// mirror that the webhook's fixed installation does not resolve.

/** One pushed head: the pull request's head moves to `sha` and its one check reports `conclusion`. */
export async function deliverChecks(
  seed: RunInMyAgentSeed,
  card: { id: string },
  pullRequest: number,
  sha: string,
  conclusion: 'success' | 'failure',
): Promise<void> {
  const [owner, name] = seed.repository.split('/') as [string, string];
  const pr = await adminDb.githubPullRequest.findFirstOrThrow({
    where: { number: pullRequest, repo: { owner, name } },
  });
  await adminDb.githubPullRequest.update({ where: { id: pr.id }, data: { headSha: sha } });
  await adminDb.githubCheckRun.create({
    data: { pullRequestId: pr.id, commitSha: sha, checkName: 'Vitest', conclusion },
  });
  await withWorkspaceContext({ userId: seed.userId, workspaceId: seed.workspaceId }, async (tx) => {
    await recomputeWorkItemCiState(card.id, tx);
    await recomputeWorkItemFixReason(card.id, tx);
  });
}

/** A head sha that is unique per spec number and push. */
export function headSha(pullRequest: number, push: number): string {
  return `${pullRequest.toString(16).padStart(8, '0')}${push.toString(16).padStart(4, '0')}`.padEnd(
    40,
    'f',
  );
}

/** What the stub vendor CLI recorded on this agent, in order — the argv and the prompt each call got. */
export interface StubCall {
  cli: string;
  args?: string[];
  prompt?: string;
  refused?: string;
}

export function stubCalls(instanceId: string): StubCall[] {
  const file = path.join(AGENT_HOMES, '.calls', `${instanceId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as StubCall);
}

/**
 * Only the calls a RUN made: the unattended forms carry `danger-full-access` (codex) or
 * `--verbose` without the chat's `--include-partial-messages` (Claude Code).
 */
export function runCalls(instanceId: string): StubCall[] {
  return stubCalls(instanceId).filter((call) => {
    const args = call.args ?? [];
    return (
      args.includes('danger-full-access') ||
      args.some((a) => a.includes('danger-full-access')) ||
      (args.includes('--verbose') && !args.includes('--include-partial-messages'))
    );
  });
}

/** The session the stand-in run's coding agent recorded (`agent_started.data.sessionId`). */
export function sessionOf(instanceId: string, runId: string): string | null {
  const file = path.join(agentHome(instanceId), '.motir-e2e', `session-${runId}`);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
}

/** The agent's next runs record no session — the way a run that died before naming one does. */
export function recordNoSession(instanceId: string): void {
  const file = path.join(agentHome(instanceId), '.motir-e2e', 'no-session');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '\n');
}

/** How a fix run ends: `green` closes it completed, `gave_up` closes it halted. */
export function endFix(instanceId: string, runId: string, how: 'green' | 'gave_up'): void {
  const file = runReleaseFile(instanceId, runId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${how}\n`);
}

/** Codex's sign-in, as `codex` leaves it: its `auth.json` in the agent's config home. */
export function signInCodex(instanceId: string): void {
  const file = path.join(
    agentHome(instanceId),
    '.motir-sandbox',
    'agent-config',
    '.codex',
    'auth.json',
  );
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"stub":"e2e"}\n', { mode: 0o600 });
}
