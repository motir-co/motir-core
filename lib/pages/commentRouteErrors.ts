import { NextResponse } from 'next/server';
import {
  PageCommentAnchorInvalidError,
  PageCommentBodyEmptyError,
  PageCommentCursorInvalidError,
  PageCommentForbiddenError,
  PageCommentNotFoundError,
  PageCommentNotRootError,
  PageCommentReplyDepthError,
} from '@/lib/pages';
import { pageErrorResponse } from '@/lib/pages/routeErrors';
import { PermissionDeniedError } from '@/lib/projects/errors';

// The page-comment routes' refusal map (Story MOTIR-10866 · MOTIR-10873). The
// two refusal families this story adds answer here; everything else goes to
// `pageErrorResponse`, so a page-level refusal — a stranger, an unknown page, an
// archived page — answers exactly as every other page route does, and anything
// that is no refusal at all is rethrown there.

const COMMENT_ERRORS = [
  PageCommentNotFoundError,
  PageCommentReplyDepthError,
  PageCommentForbiddenError,
  PageCommentNotRootError,
  PageCommentBodyEmptyError,
  PageCommentAnchorInvalidError,
  PageCommentCursorInvalidError,
] as const;

/** Map a page-comment refusal to HTTP, or hand it to the page map. */
export function pageCommentErrorResponse(err: unknown): NextResponse {
  // A write without `comment:add` — the generic keyed refusal, naming the key.
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, permission: err.permission },
      { status: 403 },
    );
  }
  for (const Ctor of COMMENT_ERRORS) {
    if (err instanceof Ctor) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
  }
  return pageErrorResponse(err);
}
