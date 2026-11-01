import { NextResponse } from 'next/server';
import { requireCompliantSession } from '@/lib/auth/requireCompliantSession';
import { apiTokensService } from '@/lib/services/apiTokensService';
import {
  ApiTokenNotFoundError,
  InvalidTokenBindingError,
  InvalidTokenGrantError,
} from '@/lib/apiTokens/errors';
import { ImpersonationCredentialRefusedError } from '@/lib/platform/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { NotAMemberError } from '@/lib/workspaces/errors';

// DELETE /api/me/api-tokens/[tokenId] (Story 7.8 · Subtask 7.8.3) — revoke one
// of the CURRENT user's own tokens, which DELETES the row (MOTIR-3546).
// Session-authed (cookie only, like the collection route — the mint surface is
// never PAT-reachable).
//
// Ownership is enforced in the service: revoking a token id that is missing OR
// owned by another user is an ApiTokenNotFoundError → 404 (the 404-not-403
// no-existence-leak contract — a cross-user id must not confirm the token
// exists). That is unchanged by the delete; the ownership probe still runs
// first, and RLS still narrows it to the owner.
//
// The response is 204 with NO body: the row is gone, so there is no DTO left to
// return. The client REMOVES the row from its own state (the
// inline-edit-no-tree-refresh contract — the island owns its state, no
// re-fetch), which is what it already did to flip the row; it now splices
// instead of replacing.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ tokenId: string }> },
): Promise<Response> {
  const gate = await requireCompliantSession();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const { tokenId } = await params;
  try {
    await apiTokensService.deleteToken(session.user.id, tokenId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof ApiTokenNotFoundError) {
      return NextResponse.json({ code: err.code }, { status: 404 });
    }
    throw err;
  }
}

// PATCH /api/me/api-tokens/[tokenId] (MOTIR-10188) — replace the GRANT of one of
// the current user's own tokens. Body `{ permissions: string[] }`; answers 200
// `{ token: ApiTokenDto }` with the updated row, which the island swaps in place
// (no re-fetch). The secret, prefix, label, binding and expiry never change, so
// there is nothing secret in the response.
//
//   400 — not a JSON body, or `permissions` is not an array of strings
//   403 — a permission the owner cannot grant in the token's project, NAMED in
//         `permissions` (`API_TOKEN_INVALID_PERMISSION`); or a staff "View as"
//         session (`IMPERSONATION_CREDENTIAL_REFUSED`)
//   404 — not the caller's token (missing, revoked, someone else's), or a project
//         the owner can no longer browse — the 404-not-403 contract
//   422 — a device credential (`motir login`), whose grant only
//         `motir auth refresh` updates (`API_TOKEN_INVALID_BINDING`)
//
// Cookie-session only, like the rest of this surface: a leaked token must not be
// able to widen itself.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ tokenId: string }> },
): Promise<Response> {
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
  const { permissions } = (body ?? {}) as { permissions?: unknown };
  if (!(Array.isArray(permissions) && permissions.every((p) => typeof p === 'string'))) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'permissions must be an array of strings.' },
      { status: 400 },
    );
  }

  const { tokenId } = await params;
  try {
    const token = await apiTokensService.updatePermissions(session.user.id, tokenId, {
      permissions: permissions as string[],
    });
    return NextResponse.json({ token });
  } catch (err) {
    if (err instanceof ImpersonationCredentialRefusedError) {
      return NextResponse.json({ code: err.code }, { status: 403 });
    }
    if (err instanceof InvalidTokenGrantError) {
      return NextResponse.json(
        { code: err.code, permissions: err.invalidPermissions },
        { status: 403 },
      );
    }
    // Not theirs, or bound somewhere the owner can no longer reach (a project they
    // cannot browse, a workspace they have left): one not-found, so the answer
    // never says which.
    if (
      err instanceof ApiTokenNotFoundError ||
      err instanceof ProjectNotFoundError ||
      err instanceof NotAMemberError
    ) {
      return NextResponse.json({ code: 'API_TOKEN_NOT_FOUND' }, { status: 404 });
    }
    if (err instanceof InvalidTokenBindingError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    throw err;
  }
}
