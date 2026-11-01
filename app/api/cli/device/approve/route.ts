import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { ImpersonationCredentialRefusedError } from '@/lib/platform/errors';
import { cliDeviceService } from '@/lib/services/cliDeviceService';
import {
  DeviceGrantExpiredError,
  DeviceGrantForbiddenError,
  DeviceGrantNotClaimedError,
  DeviceGrantNotPendingError,
  DeviceGrantWorkspaceRequiredError,
  DeviceUpdateRefusedError,
  InvalidDeviceGrantError,
} from '@/lib/cliDevice/errors';
import { NotAMemberError } from '@/lib/workspaces/errors';

// POST /api/cli/device/approve (Story MOTIR-1863 · Subtask MOTIR-1865) — the act
// that authorizes a CLI credential. Called by the /device page (MOTIR-1867), never by
// the CLI.
//
// COOKIE-SESSION ONLY, and that is the whole security model: the browser session is
// the authority for the mint, so this route is never bearer-reachable — a PAT cannot
// mint more PATs (docs/mcp.md). Body `{ userCode, workspaceId }`; the workspace is
// the approver's choice from the picker, and the server re-asserts membership
// regardless of what the form posted.
//
// PRECONDITION: the page must first call GET /api/auth/device?user_code=… while
// signed in — that read is what CLAIMS the code (stamps `userId` onto the grant), and
// Better-Auth refuses to approve an unclaimed one. A POST that skips it gets 409
// rather than a silent failure.
//
// Routes are HTTP-only (CLAUDE.md): parse → one service call → typed-error→status.

export async function POST(req: Request): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }
  const { userCode, workspaceId } = (body ?? {}) as {
    userCode?: unknown;
    workspaceId?: unknown;
  };

  if (typeof userCode !== 'string' || userCode.trim().length === 0) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'A userCode is required.' },
      { status: 400 },
    );
  }
  // Optional since MOTIR-10189: a `motir auth refresh` grant updates a token that
  // already has its workspace, so its approval names none. A login without one is
  // refused by the service (400 below), which is the only layer that knows which
  // flow the code belongs to.
  if (
    workspaceId !== undefined &&
    workspaceId !== null &&
    (typeof workspaceId !== 'string' || workspaceId.length === 0)
  ) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'workspaceId must be a non-empty string.' },
      { status: 400 },
    );
  }

  try {
    await cliDeviceService.approve({
      userCode,
      workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
      actorUserId: session.user.id,
      // Better-Auth's approve endpoint reads the session from the request itself, so
      // the cookies have to be forwarded — `getSession()` above gates the route, but
      // it cannot stand in for the plugin's own session read.
      headers: req.headers,
    });
  } catch (err) {
    // A workspace the approver is not a member of (or a forged id). 403, matching the
    // token-create surface: the picker only offers the user's own workspaces, so a
    // mismatch is a forbidden action rather than a hidden resource.
    // A credential cannot be minted inside a staff "View as" session (MOTIR-749).
    if (err instanceof ImpersonationCredentialRefusedError) {
      return NextResponse.json({ code: err.code }, { status: 403 });
    }
    if (err instanceof NotAMemberError) {
      return NextResponse.json({ code: 'WORKSPACE_FORBIDDEN' }, { status: 403 });
    }
    // Claimed by a different signed-in user — the phishing-relevant case, and the one
    // the approval screen's identity inventory is there to make visible.
    if (err instanceof DeviceGrantForbiddenError) {
      return NextResponse.json({ code: err.code }, { status: 403 });
    }
    if (err instanceof InvalidDeviceGrantError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    if (err instanceof DeviceGrantExpiredError) {
      return NextResponse.json({ code: err.code }, { status: 410 });
    }
    // Both are "the grant is not in a state that can be approved" — separated because
    // the page renders them differently: NOT_CLAIMED is its own sequencing bug to fix,
    // NOT_PENDING is the already-approved / already-denied screen.
    if (err instanceof DeviceGrantNotClaimedError || err instanceof DeviceGrantNotPendingError) {
      return NextResponse.json({ code: err.code }, { status: 409 });
    }
    if (err instanceof DeviceGrantWorkspaceRequiredError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
    }
    // A refresh whose token could not be updated (gone, not the approver's, or a
    // staff session). The grant has been denied, so the terminal stops waiting.
    if (err instanceof DeviceUpdateRefusedError) {
      return NextResponse.json({ code: err.code }, { status: 422 });
    }
    throw err;
  }

  return NextResponse.json({ ok: true });
}
