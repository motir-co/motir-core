import type { CommandResult } from '../src/git.js';

// The OPEN PULL REQUEST a scripted run's agent left behind (MOTIR-10877). A card that opens
// its own pull request is finished only once the run has LINKED it (`runDelivery.ts`), and the
// run finds it with `gh pr view <branch>`. Every suite that scripts a run which "pushed and
// opened its pull request" answers that call with this, so the run links a pull request that
// exists rather than reporting work linked to nothing.

export const FAKE_PULL_REQUEST_URL = 'https://github.com/acme/motir-core/pull/42';

/** `gh pr view`'s JSON for an open pull request from `branch` (any repository named in `url`). */
export function prViewJson(
  branch = 'subtask/PROD-7-add-the-thing',
  url = FAKE_PULL_REQUEST_URL,
  headSha = 'abc1234def5678abc1234def5678abc1234def56',
): string {
  return JSON.stringify({
    url,
    state: 'OPEN',
    headRefName: branch,
    headRefOid: headSha,
    baseRefName: 'main',
  });
}

/**
 * The answer to `gh pr view <branch|url> …`, or null for any other command. A pull request
 * looked up by branch answers with that branch as its head.
 */
export function answerPrView(bin: string, args: readonly string[]): CommandResult | null {
  if (bin !== 'gh' || args[0] !== 'pr' || args[1] !== 'view') return null;
  const ref = args[2];
  const branch = ref && !ref.startsWith('https://') ? ref : undefined;
  return { exitCode: 0, stdout: prViewJson(branch), stderr: '' };
}
