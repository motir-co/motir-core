import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import {
  dispatchRunRepositoryBodySchema,
  presentDispatchRunRepository,
} from '@/lib/api/v1/workLoop/dispatchRunRepository';
import { runRepositoryCreationService } from '@/lib/services/runRepositoryCreationService';

// POST /api/v1/dispatch-runs/{id}/repository (Story MOTIR-10162 · MOTIR-11055) — the RUN
// creates the repository its INIT card declares. The same creation sequence as the
// `create_project_repository` MCP tool, made by the CLI with the run's credential after the
// agent exits, from the `repository` member the agent wrote into `$MOTIR_AGENT_REPORT`: a
// hosted agent holds no Motir token and `/api/mcp` refuses the run token.
//
// Refusals, each typed by its service and mapped by code (`lib/api/v1/errors.ts`):
//   401 — no bearer;
//   402 `ai_plan_required` · 503 `plan_unknown` — the establish pass's paid-plan gate;
//   403 `DISPATCH_RUN_TOKEN_OUT_OF_SCOPE` — a run token naming another run;
//   403 `INSUFFICIENT_PERMISSION` — the credential's grant lacks `repository:manage` (the
//       wrapper, before the handler); `PERMISSION_DENIED` — the caller's role lacks it;
//   404 `DISPATCH_RUN_NOT_FOUND` — unknown run, another tenant's, another operator's;
//   404 `WORK_ITEM_NOT_FOUND` — the card does not exist for this caller;
//   409 `DISPATCH_RUN_TERMINAL` — the run has closed;
//   409 `REPO_EXISTS_WITH_OTHER_SPEC` · `REPO_ESTABLISH_BUSY` · `PROJECT_REPO_NAME_TAKEN` —
//       the creation sequence's own conflicts;
//   422 `UNKNOWN_DISPATCH_RUN_CARD` — the card is not an open leg of this run;
//   422 `RUN_CARD_NOT_INIT_CARD` — the card is not an init card;
//   422 `RUN_REPOSITORY_NAME_MISMATCH` — the card declares another name;
//   422 `INVALID_BODY` — a missing or blank name, a role outside the closed list, a blank
//       starter key.
//
// ⚠️ `acceptsRunToken` — bound to the token's own run (`own_run`,
// `lib/hostedRuns/runTokenRoutes.ts`). `repository:manage` is the key the repository set
// asserts on every write, so it is the key this door declares. One service call.
export const POST = withV1Route<{ id: string }>(
  { permission: 'repository:manage', acceptsRunToken: true },
  async (ctx) => {
    const body = await parseV1Body(ctx.req, dispatchRunRepositoryBodySchema);
    const result = await runRepositoryCreationService.createRunRepository(
      ctx.params.id,
      body,
      ctx.service,
    );
    return NextResponse.json(presentDispatchRunRepository(result));
  },
);
