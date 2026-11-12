// THE ROUTES A HOSTED RUN'S OWN CREDENTIAL MAY CALL (MOTIR-6557,
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §4).
//
// The container runs the CLI's own `motir run` / `motir continue` / `motir review`
// / `motir fix`, so a run token must reach exactly what those commands call — for
// its run and its run's cards, and nothing else. This is the ONE list. Each route here sets
// `acceptsRunToken: true` on its `withV1Route`, and no route outside it does;
// `tests/hostedRuns/runTokenRouteTable.test.ts` holds both directions, and holds
// the list against the operations the CLI client actually calls on those paths.
//
// ⚠️ THE GRANT DOES NOT NARROW IT; THE BINDING DOES. Every route below asserts a
// key `HOSTED_RUN_TOKEN_GRANT` holds — `project:browse` or `work_item:edit`, and
// `repository:manage` for the run's repository door alone (MOTIR-11055) — and a
// bare `work_item:edit` would reach every card in the project. What stops it is the
// `binding` column, enforced in the services:
//
//   own_run          — the path's `{id}` is the token's own run
//                      (`dispatchRunService`'s `assertRunTokenScope`).
//   run_cards        — every card the call touches is a LEG of the run or the
//                      run's SCOPE (`runTokenScopeService`, reached through
//                      `workItemsService.getWorkItemByIdentifier` and the few
//                      reads that resolve a card another way).
//   run_scope_claim  — a work-item scope (never a sprint) whose container and
//                      every member are the run's cards (`scopeClaimService`).
//   project          — a read of the run's own project; the token is bound to
//                      it (`ApiToken.projectId`, `projectAccessService`).
//   self             — the credential reading who it is. Nothing else.
//
// Pure data — a leaf module with no imports, safe for any layer and for tests.

export type RunTokenBinding = 'own_run' | 'run_cards' | 'run_scope_claim' | 'project' | 'self';

export interface RunTokenRoute {
  /** The `/api/v1` operation, or `null` for a route that has none (yet). */
  operationId: string | null;
  method: 'GET' | 'POST';
  /** The OpenAPI path, `{param}` form. */
  path: string;
  binding: RunTokenBinding;
  /** Who in the container calls it. */
  calledBy: 'cli' | 'git_credential_helper';
  /**
   * The card that makes the CLI CALL a route that already exists, when no CLI source calls
   * it yet — the review run's two routes (MOTIR-6821) are built before `motir review`
   * (MOTIR-6824) calls them. The table test exempts such an entry from its "still called"
   * check until the card lands and drops this field.
   */
  callerPendingCard?: string;
  /**
   * The card that builds the route, when it does not exist yet. The table test
   * requires the route file to exist — and to opt in — once this is absent.
   */
  pendingCard?: string;
}

export const RUN_TOKEN_ROUTES: readonly RunTokenRoute[] = [
  // Who the credential is — the CLI's `whoami`, for whom a claim assigns to.
  { operationId: 'getMe', method: 'GET', path: '/api/v1/me', binding: 'self', calledBy: 'cli' },

  // The run's project — the scope drain's edge read and the close-out's ready set.
  // The ready LANES (MOTIR-6835) — every CLI ready read goes through these. The
  // flat `GET …/ready` they replaced was deleted by MOTIR-6841 once the released
  // CLI (0.8.0) and the sandbox images read only the lanes.
  {
    operationId: 'getProjectReadyLeaves',
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/ready/leaves',
    binding: 'project',
    calledBy: 'cli',
  },
  {
    operationId: 'getProjectReadyContainers',
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/ready/containers',
    binding: 'project',
    calledBy: 'cli',
  },
  {
    operationId: 'getProjectReadyBugs',
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/ready/bugs',
    binding: 'project',
    calledBy: 'cli',
  },
  {
    operationId: 'listProjectWorkItems',
    method: 'GET',
    path: '/api/v1/projects/{projectKey}/work-items',
    binding: 'project',
    calledBy: 'cli',
  },

  // The run's cards.
  {
    operationId: 'getWorkItem',
    method: 'GET',
    path: '/api/v1/work-items/{key}',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'listWorkItemDesigns',
    method: 'GET',
    path: '/api/v1/work-items/{key}/designs',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'getWorkItemDispatchPrompt',
    method: 'GET',
    path: '/api/v1/work-items/{key}/dispatch-prompt',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'getWorkItemHowToTest',
    method: 'GET',
    path: '/api/v1/work-items/{key}/how-to-test',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  // A REVIEW run's own two routes (MOTIR-6821; `hosted-agent-run.md` §3's pointer, §8.4).
  // ⚠️ NARROWER THAN `run_cards`: the service admits ONLY a `command: review` run's token
  // (`REVIEW_RUN_TOKEN_REQUIRED`) — a build run's token is refused on both — and then the
  // run's own card, through the same `runTokenScopeService` binding. Called by `motir
  // review` (MOTIR-6824, `packages/cli/src/commands/review.ts`).
  {
    operationId: 'getWorkItemReviewPrompt',
    method: 'GET',
    path: '/api/v1/work-items/{key}/review-prompt',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'submitWorkItemAgentReview',
    method: 'POST',
    path: '/api/v1/work-items/{key}/agent-review',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'claimWorkItem',
    method: 'POST',
    path: '/api/v1/work-items/{key}/claim',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'transitionWorkItem',
    method: 'POST',
    path: '/api/v1/work-items/{key}/transitions',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'recordWorkItemIntegration',
    method: 'POST',
    path: '/api/v1/work-items/{key}/integration',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'linkWorkItemPullRequest',
    method: 'POST',
    path: '/api/v1/work-items/{key}/pull-requests',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'completeSession',
    method: 'POST',
    path: '/api/v1/sessions/complete',
    binding: 'run_cards',
    calledBy: 'cli',
  },
  {
    operationId: 'claimScope',
    method: 'POST',
    path: '/api/v1/scope-claims',
    binding: 'run_scope_claim',
    calledBy: 'cli',
  },

  // The run itself.
  {
    operationId: 'appendDispatchRunEvents',
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/events',
    binding: 'own_run',
    calledBy: 'cli',
  },
  {
    // The CLI's hosted mode reads the run the server opened, to ADOPT it with
    // its legs in the run's own order (MOTIR-6558).
    operationId: 'getDispatchRun',
    method: 'GET',
    path: '/api/v1/dispatch-runs/{id}',
    binding: 'own_run',
    calledBy: 'cli',
  },
  {
    operationId: 'getDispatchRunCloseOutPrompt',
    method: 'GET',
    path: '/api/v1/dispatch-runs/{id}/close-out-prompt',
    binding: 'own_run',
    calledBy: 'cli',
  },
  {
    operationId: 'closeDispatchRun',
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/close',
    binding: 'own_run',
    calledBy: 'cli',
  },
  {
    // A hosted run's own liveness is its server supervision, not a beat
    // (`run-death-keeps-work.md` §2) — but the reporter beats whatever run it
    // holds, adopted or opened, with no branch for hosted (MOTIR-6528 · MOTIR-6558).
    operationId: 'heartbeatDispatchRun',
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/heartbeat',
    binding: 'own_run',
    calledBy: 'cli',
  },
  {
    // The run reports that its agent stopped on an unbuildable card (MOTIR-8698) —
    // the agent has no Motir token here, so the CLI makes the report for it.
    operationId: 'reportDispatchRunUnbuildable',
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/unbuildable',
    binding: 'own_run',
    calledBy: 'cli',
  },
  {
    // The run records its agent's build-through discrepancy, and its STOP (MOTIR-8722) —
    // the agent has no Motir token here, so the CLI posts what it wrote in its self-report.
    operationId: 'recordDispatchRunDiscrepancy',
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/discrepancy',
    binding: 'own_run',
    calledBy: 'cli',
  },
  {
    // The run creates the repository its INIT card declares (MOTIR-11055) — the agent has
    // no Motir token here, so the CLI posts the `repository` member of its self-report.
    // The ONE route in this table that asserts `repository:manage`.
    operationId: 'createDispatchRunRepository',
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/repository',
    binding: 'own_run',
    calledBy: 'cli',
  },
  {
    operationId: 'reportDispatchRunStop',
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/stop',
    binding: 'own_run',
    calledBy: 'cli',
  },
  {
    // The run target's How to test (MOTIR-10877) — the agent writes it into its self-report,
    // having no Motir tools here, and the CLI publishes it with the run's credential.
    operationId: 'publishDispatchRunHowToTest',
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/how-to-test',
    binding: 'own_run',
    calledBy: 'cli',
  },
  {
    operationId: 'issueDispatchRunGitCredentials',
    method: 'POST',
    path: '/api/v1/dispatch-runs/{id}/git-credential',
    binding: 'own_run',
    calledBy: 'git_credential_helper',
  },
];

/**
 * Operations the CLI calls on a `motir run` path that a run token is DENIED,
 * each with why — so the table test can tell a deliberate refusal from drift.
 */
export const RUN_TOKEN_DENIED_CLI_OPERATIONS: Readonly<Record<string, string>> = {
  openDispatchRun:
    'the server opens a hosted run and the CLI adopts it (MOTIR-6558); a run token never opens one',
  listWorkspaces:
    "lists every workspace the dispatcher belongs to — beyond the run's own; the CLI's hosted mode resolves its owner from getMe alone (MOTIR-6558)",
  getWorkItemPlan: "`motir auto`'s plan approval — plans are not a run token's to read",
  approveWorkItemPlan: "`motir auto`'s plan approval — plans are not a run token's to decide",
  submitPlanSession:
    'the re-plan a scope run submits when its scope is refused as mis-shaped — plan authoring is not a run token’s; a hosted run reports the refusal instead',
  submitWorkItemExpansion:
    '`--include-planning` / `motir auto` expansion — an AI planning surface, never a hosted run',
  claimWorkItemRepair:
    "a terminal `motir fix`'s repair claim — a HOSTED repair's claim is taken by the server when the person presses (MOTIR-6928), and the container ADOPTS the `fix` run it opened, reading the decision back from `getDispatchRun` (MOTIR-6929); a second claim would find the card taken by its own run",
};
