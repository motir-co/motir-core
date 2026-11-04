import { NextResponse } from 'next/server';
import { authenticateAndLimitJobRequest } from '@/lib/ai/jobAuth';
import { mapJobRequestError } from '@/lib/ai/jobAuthResponse';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/internal/ai/get-item?key=MOTIR-7[&withComments=1][&withHistory=1]
//   [&commentsCursor=…][&historyCursor=…]  (Subtask 7.5.1)
//
// One work item by key — or by its work-item id, the form a plan stores for a
// committed card (MOTIR-8940) — plus (on request) the DEPTH context 7.1.6 deferred: the
// cursor-paginated comment thread and the cursor-paginated change log — the
// signal a planner uses to understand WHY an item is shaped the way it is.
// Service-to-service ONLY (the §4a service bearer + §4b job token via
// authenticateJobRequest); the item is resolved AS the token's user within the
// token's project, so a cross-tenant / cross-project key is a 404, never a leak.
//
// `item.inFlightCode` (MOTIR-6618) — where the card's UNMERGED code lives, one
// entry per repository: `{ repo, branch, headSha, prNumber, prUrl, draft,
// baseRef, source }`, derived from the `work_item_delivery` rows with NO provider
// call.
//   - `repo` is `owner/name` — exactly the `repoRef` `GET /api/internal/ai/repo-file`
//     (motir-ai's `read_file`) accepts, so the planner passes `repo` as `repoRef`
//     and `branch` as `ref` straight through.
//   - `branch` is the open pull request's `headRef`; `headSha` only dates the
//     observation (null when no head was ever recorded).
//   - `source: 'own'` — the card's own OPEN (not merged) pull request in that
//     repository. `source: 'inherited'` — the card has none there, so the entry
//     is the NEAREST ancestor's open pull request in that repository (the story's
//     `parent/MOTIR-<id>-<slug>` branch a child's commit rides), and `fromKey`
//     names that ancestor. The walk stays inside the token's project.
//   - EMPTY IS THE ORDINARY ANSWER: an array on every item, never null. `[]` with
//     `item.mergedRepos: ['owner/name', …]` means the card's own code has MERGED
//     there (no longer in flight); `[]` with `mergedRepos: []` means nothing was
//     ever delivered on the card or any ancestor.
//
// `item.todos` (MOTIR-10316) — the card's to-do steps, so a planner re-authoring
// a committed card sees what its steps are and which are already ticked. One
// entry per step: `{ id, text, notesMd, commandText, executor, done }`.
//   - ORDER is the card's list order — the order the item page and the MCP's
//     `list_work_item_todos` show — because the rows come from the SAME
//     `workItemTodosService.listTodos` read that tool makes.
//   - `done` is the ticked state, the same derived boolean that tool returns;
//     `notesMd` / `commandText` / `executor` are null when the step has none.
//   - EMPTY IS THE ORDINARY ANSWER: an array on every item, never null or absent.
//     `[]` means the card has no steps.
//
// Typed errors → status:
//   JobAuthError                       → 401
//   WorkItemNotFoundError              → 404 (absent / cross-tenant — no leak)
//   ProjectAccessDeniedError('browse') → 404 (a project the user can't browse)
function parseBool(v: string | null): boolean {
  return v === '1' || v === 'true';
}

export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await authenticateAndLimitJobRequest(req);
  } catch (err) {
    const failure = mapJobRequestError(err);
    if (failure) return failure;
    throw err;
  }

  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key) {
    return NextResponse.json(
      { code: 'KEY_REQUIRED', error: '`key` is required.' },
      { status: 400 },
    );
  }
  const commentsCursor = url.searchParams.get('commentsCursor');
  const historyCursor = url.searchParams.get('historyCursor');

  try {
    const result = await aiBoundaryService.getItem(auth.projectId, key, auth.ctx, {
      withComments: parseBool(url.searchParams.get('withComments')),
      withHistory: parseBool(url.searchParams.get('withHistory')),
      ...(commentsCursor ? { commentsCursor } : {}),
      ...(historyCursor ? { historyCursor } : {}),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    throw err;
  }
}
