import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import {
  presentRunHowToTestAcknowledgement,
  runHowToTestBodySchema,
} from '@/lib/api/v1/workLoop/runAgentReports';
import { runHowToTestService } from '@/lib/services/runHowToTestService';

// POST /api/v1/dispatch-runs/{id}/how-to-test (MOTIR-10877) — the RUN publishes its run
// target's HOW TO TEST. The same record as the `publish_test_instructions` MCP tool, made by
// the CLI with the run's credential after the agent exits, from the body the agent wrote into
// `$MOTIR_AGENT_REPORT` and each repository's pushed head: a hosted or agent-instance agent
// holds no Motir token and `/api/mcp` refuses the run token.
//
// Refusals, each typed by the service and mapped by code (`lib/api/v1/errors.ts`):
//   401 — no bearer;
//   403 `DISPATCH_RUN_TOKEN_OUT_OF_SCOPE` — a run token naming another run;
//   403 `PERMISSION_DENIED` — the caller may browse the card but not edit it;
//   404 `DISPATCH_RUN_NOT_FOUND` — unknown run, another tenant's, another operator's;
//   404 `WORK_ITEM_NOT_FOUND` — the card does not exist for this caller;
//   409 `DISPATCH_RUN_TERMINAL` — the run has closed;
//   422 `UNKNOWN_DISPATCH_RUN_CARD` — the card is not an open leg of this run;
//   422 `TEST_INSTRUCTIONS_*` — the record's own refusals (a cap, a repository outside the
//       project, a malformed commit or preview path);
//   422 `INVALID_BODY` — a malformed body.
//
// ⚠️ `acceptsRunToken` — bound to the token's own run (`own_run`,
// `lib/hostedRuns/runTokenRoutes.ts`). One service call.
export const POST = withV1Route<{ id: string }>(
  { permission: 'work_item:edit', acceptsRunToken: true },
  async (ctx) => {
    const body = await parseV1Body(ctx.req, runHowToTestBodySchema);
    const result = await runHowToTestService.publish(body, ctx.service, { runId: ctx.params.id });
    return NextResponse.json(presentRunHowToTestAcknowledgement(result));
  },
);
