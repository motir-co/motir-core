import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { presentDispatchPrompt } from '@/lib/api/v1/workLoop/schema';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import {
  FINDINGS_POLICY_TOKENS,
  parseFindingsPolicy,
  type FindingsPolicy,
} from '@/lib/dispatch/promptTemplate';

// GET /api/v1/work-items/{key}/dispatch-prompt (Story 11.7 · Subtask 11.7.3 —
// MOTIR-2237) — the first WORK-LOOP operation on the public API, and the one
// `motir run` / `next` / `auto` / `batch` are built out of.
//
// ── A READ, and the whole endpoint turns on it staying one ──────────────────
// Fetching a prompt does NOT claim the item, does NOT move its status, and does
// NOT change its recorded `session_branch`. Printing a prompt to look at it must
// never mutate the plan — an agent orchestrator that could not preview work
// without taking it would have no safe way to decide what to take. The service
// enforces this (it reads and assembles; the claim lives in `claim_next_ready`),
// and the suite asserts the row is byte-identical before and after, including
// for an item already `in_progress`.
//
// ── `sessionBranch` is a FALLBACK the server may ignore ─────────────────────
// It seeds an unattended run when the item has no lineage of its own. It never
// OVERRIDES: an item whose dependencies are already integrated, or that is
// itself integrated, keeps its own branch. That is the one way this endpoint
// could corrupt state — redirecting a live lineage onto a caller-supplied branch
// would strand an integrated chain across two branches — so it is asserted
// directly rather than trusted to the service.
//
// ── The branch pattern is validated HERE, before the read ───────────────────
// The seed is INTERPOLATED INTO PROMPT TEXT that instructs an agent to run
// `git … origin/<branch>`, so a name carrying whitespace, a shell metacharacter
// or a leading `-` would become a command an agent might run on the caller's
// behalf. Refusing those is cheaper than escaping them and every real branch name
// passes. The MCP tool refuses the same set at its own boundary
// (`lib/mcp/tools/dispatchPrompt.ts`); this is the same rule re-expressed for
// this transport, not an import from it — v1 never reaches into `lib/mcp/tools`.
//
// Two service calls, both RESOLVE/PROJECT: the key → project resolution and the
// one read. ADR Amendment 3 Q4's bounded-call rule; no `db.*`, no transaction.

/** A git ref name restricted to what may safely be interpolated into the prompt. */
const SEED_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;
const MAX_SEED_BRANCH_LENGTH = 200;

/**
 * Read the optional `?sessionBranch=`.
 *
 * An ABSENT parameter and an EMPTY one are the same thing — no seed — because a
 * client assembling a query string from an optional value would otherwise have
 * to know the difference between omitting the key and sending it blank.
 */
function parseSessionBranch(req: Request): string | null {
  const raw = new URL(req.url).searchParams.get('sessionBranch');
  if (raw === null) return null;
  const branch = raw.trim();
  if (branch === '') return null;
  if (branch.length > MAX_SEED_BRANCH_LENGTH || !SEED_BRANCH_PATTERN.test(branch)) {
    throw new InvalidRequestError(
      'INVALID_SESSION_BRANCH',
      'The `sessionBranch` parameter is not a safe branch name.',
    );
  }
  return branch;
}

/**
 * Read the optional `?findingsPolicy=` — a comma-separated list of the
 * capabilities this run switches OFF (MOTIR-3020,
 * `docs/decisions/run-findings-protocol.md` Q1).
 *
 * The VOCABULARY and the parse live in `lib/dispatch/promptTemplate.ts`, shared
 * with the MCP tool, so the two transports cannot drift on what a token means.
 * What belongs here is only the refusal's HTTP shape.
 *
 * ⚠️ AN UNKNOWN TOKEN IS REFUSED, never ignored. Silently rendering the full
 * protocol for `?findingsPolicy=no-log-bug` would hand the operator a prompt they
 * believe is narrowed and an agent that was told otherwise — the precise class of
 * lie the parameter exists to remove.
 */
/**
 * Read the optional `?autoApproveReplan=` — whether THIS run's loop is willing
 * to approve a submitted re-plan itself and carry on (MOTIR-4085).
 *
 * ⚠️ ITS OWN PARAMETER, NOT A `findingsPolicy` TOKEN, and the reason is that
 * parameter's own documented meaning: a comma-separated list of what this run
 * switches OFF. This switches something on, and it is not a capability of the
 * agent at all — the agent's tools, anchor and one shot are identical either
 * way. Folding it in would make one list mean two opposite things.
 *
 * Absent, empty and `0` / `false` all mean NO, which is the safe direction: a
 * prompt that told an agent its plan might be approved unattended when no loop
 * will approve it is a lie the agent cannot check.
 */
function parseAutoApproveReplan(req: Request): boolean {
  const raw = new URL(req.url).searchParams.get('autoApproveReplan');
  if (raw === null) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * Read the optional `?agentReport=` — the client's DECLARATION that it posts what
 * its agent writes into `$MOTIR_AGENT_REPORT` as `unbuildable`, `discrepancy` and
 * `stop` (MOTIR-8810).
 *
 * ⚠️ ABSENT MEANS NO, AND THAT IS THE WHOLE FIX. Every CLI anyone could install
 * when MOTIR-8698 deployed — `@motir/cli` 0.12.0 — sends nothing here and reads
 * only `model` from that file, so a prompt that routed the unbuildable report
 * through it lost the report. A client that cannot say it posts gets the tool as
 * the route — the text the MCP tool renders, which never declares it. A capability
 * rather than a version, because a CLI built from `main` reports the same version
 * string as the release it is ahead of.
 */
function parseAgentReport(req: Request, param = 'agentReport'): boolean {
  const raw = new URL(req.url).searchParams.get(param);
  if (raw === null) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true';
}

function parsePolicy(req: Request): FindingsPolicy {
  const raw = new URL(req.url).searchParams.get('findingsPolicy');
  const parsed = parseFindingsPolicy(raw, {
    autoApproveReplan: parseAutoApproveReplan(req),
  });
  if (parsed.policy === null) {
    throw new InvalidRequestError(
      'INVALID_FINDINGS_POLICY',
      `\`${parsed.unknown}\` is not a findings-policy capability. Known: ${FINDINGS_POLICY_TOKENS.join(', ')}.`,
    );
  }
  return parsed.policy;
}

// ⚠️ `acceptsRunToken` — a hosted run's own credential (MOTIR-688) fetches its
// card's prompt here, and ONLY that card's: `dispatchPromptService` answers any
// other key `WORK_ITEM_NOT_FOUND` (404), exactly as for a card it cannot see.
export const GET = withV1Route<{ key: string }>(
  { permission: 'project:browse', acceptsRunToken: true },
  async (ctx) => {
    // Parse BEFORE reading: an unsafe branch name is the caller's to fix, and
    // answering 422 without a database round-trip is both faster and honest.
    const sessionBranch = parseSessionBranch(ctx.req);
    const findingsPolicy = parsePolicy(ctx.req);
    // A CONTINUE of a dead run (MOTIR-6531): the run's id, validated by the service
    // against this item — an invalid one is `CONTINUE_FROM_INVALID` (422).
    const continueFrom = new URL(ctx.req.url).searchParams.get('continueFrom')?.trim() || undefined;
    const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);

    const dto = await dispatchPromptService.getDispatchPrompt(projectId, identifier, ctx.service, {
      sessionBranch,
      findingsPolicy,
      runnerPostsAgentReport: parseAgentReport(ctx.req),
      // MOTIR-10000: the client also posts the agent's `decisions`.
      runnerPostsDecisions: parseAgentReport(ctx.req, 'agentReportDecisions'),
      ...(continueFrom ? { continueFrom } : {}),
    });

    return NextResponse.json(presentDispatchPrompt(dto));
  },
);
