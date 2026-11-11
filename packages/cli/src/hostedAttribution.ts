// A HOSTED RUN'S ATTRIBUTION (Story MOTIR-683 · MOTIR-6559).
//
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §6: a hosted run's
// commits and pull requests are the App's, and EVERY pull request body names the
// dispatcher by their Motir name and links the card and the run. This module
// holds the one prepared run of this process and renders that line — for the
// pull requests the CLI opens (`git.ts`) and for the ones the agent opens (the
// prompt addendum `hostedAgent.ts` appends). It imports nothing, so `git.ts`
// can use it without taking on the client.

/** The marker that makes the pull-request attribution idempotent. */
const ATTRIBUTION_MARKER = '<!-- motir-hosted-run -->';

/** Who and what a hosted run's pull requests name. */
export interface HostedAttribution {
  runId: string;
  serverUrl: string;
  /** The card `motir run` was given — the leaf, or the parent whose scope it runs. */
  targetKey: string;
  dispatchedBy: string | null;
  stateDir: string;
}

let active: HostedAttribution | null = null;

/** The hosted run this process prepared, or null on every local run. */
export function activeHostedRun(): HostedAttribution | null {
  return active;
}

/** Record the run `prepareHostedRun` set up — a process prepares at most one. */
export function setActiveHostedRun(run: HostedAttribution): HostedAttribution {
  active = run;
  return run;
}

/** Forget the prepared run — for tests. */
export function resetHostedRun(): void {
  active = null;
}

/**
 * The line every hosted pull request ends with (decision §6): the dispatcher's
 * Motir name, the card and the run. Null on a local run.
 *
 * The run links to `/runs?run=<id>` — the run modal on the runs page, the same
 * form `runUrlOf` (`lib/mappers/orgFleetMappers.ts`) builds. There is no
 * `/runs/<id>` route (MOTIR-10973; the item page made the same mistake in
 * MOTIR-5398).
 */
export function hostedAttributionLine(a: HostedAttribution | null = active): string | null {
  if (!a) return null;
  const server = a.serverUrl.replace(/\/+$/, '');
  const who = a.dispatchedBy ? `Dispatched by ${a.dispatchedBy}` : 'Dispatched';
  return (
    `${ATTRIBUTION_MARKER}\n${who} through a Motir hosted run — ` +
    `card [${a.targetKey}](${server}/items/${a.targetKey}) · ` +
    `run [${a.runId}](${server}/runs?run=${encodeURIComponent(a.runId)}).`
  );
}

/** A pull request body with the attribution appended, once. Unchanged on a local run. */
export function withHostedAttribution(body: string, a: HostedAttribution | null = active): string {
  const line = hostedAttributionLine(a);
  if (!line || body.includes(ATTRIBUTION_MARKER)) return body;
  return `${body.replace(/\s+$/, '')}\n\n---\n${line}\n`;
}

/**
 * What the agent is told on top of the server's prompt in a hosted run: that
 * git is already the App, and the line its own pull requests must end with.
 */
export function hostedPromptAddendum(a: HostedAttribution | null = active): string {
  const line = hostedAttributionLine(a);
  if (!line) return '';
  return [
    '',
    '## HOSTED RUN — git and pull requests',
    '',
    "- git and `gh` are already authenticated for this run's repositories and commit as Motir's GitHub App.",
    '  Do not change `user.name`, `user.email`, remote URLs or credential settings, and use no other GitHub credential.',
    '- Every pull request you open or edit must END its body with these two lines, verbatim:',
    '',
    line,
    '',
  ].join('\n');
}
