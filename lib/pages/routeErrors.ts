import { NextResponse } from 'next/server';
import { PageLinkAlreadyExistsError, PageLinkNotFoundError } from '@/lib/pages/linkErrors';
import { PageSearchQueryEmptyError, PageSearchQueryTooLongError } from '@/lib/pages/searchErrors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  CrossProjectPageParentError,
  PageBodyTooLargeError,
  PageCycleError,
  PageDepthExceededError,
  PageFolderNotFoundError,
  PageHoldsFrozenVersionError,
  PageLevelCursorInvalidError,
  PageNeighbourInvalidError,
  PageArchiveRootRequiredError,
  PageArchivedError,
  PageNotArchivedError,
  PageNotFoundError,
  PageParentArchivedError,
  PageParentNotAllowedError,
  PageTitleTooLongError,
  PageUpdateMalformedError,
  PageVersionNotFoundError,
} from '@/lib/pages';

// The page routes' refusal map (Story MOTIR-5752 · MOTIR-7278) — the same shape
// as `lib/workItems/gateResponse.ts`: one function every `/api/pages` handler's
// catch block calls, so the four doors cannot disagree about a status.
//
// ⚠️ A NON-MEMBER AND AN UNKNOWN PAGE GET THE SAME BYTES. `pagesService` refuses
// a caller who cannot browse the project as `ProjectAccessDeniedError('browse')`
// and a page from another project as `PageNotFoundError`; both answer the one
// body below, so neither a stranger nor a member of project A learns whether a
// page id exists. (`ProjectNotFoundError` — a foreign or token-narrowed project —
// is the same case one layer down.)

/** The not-found body, built once so every arm that answers 404 sends it verbatim. */
export function pageNotFoundResponse(): NextResponse {
  return NextResponse.json({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' }, { status: 404 });
}

/** A body over the save cap — the route's own pre-read refusal uses it too. */
export function pageBodyTooLargeResponse(limit: number, size: number): NextResponse {
  const err = new PageBodyTooLargeError(limit, size);
  return NextResponse.json(
    { code: err.code, error: err.message, limit: err.limit, size: err.size },
    { status: 413 },
  );
}

/** Map a page refusal to HTTP, or rethrow anything that is not one. */
export function pageErrorResponse(err: unknown): NextResponse {
  if (err instanceof ProjectAccessDeniedError) {
    if (err.kind === 'browse') return pageNotFoundResponse();
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof ProjectNotFoundError || err instanceof PageNotFoundError) {
    return pageNotFoundResponse();
  }
  // A version the cap pruned, or never existed (MOTIR-7386). DISTINCT from the
  // page's 404 so the history panel can say which; only a caller who can browse
  // the project reaches it, so it says nothing to a stranger.
  if (err instanceof PageVersionNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof PageBodyTooLargeError) return pageBodyTooLargeResponse(err.limit, err.size);
  // An empty or undecodable save body (MOTIR-7281). The editor host reads any
  // non-413 refusal as `offline` and retries; our own editor never produces one.
  if (err instanceof PageUpdateMalformedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  if (err instanceof PageTitleTooLongError) {
    return NextResponse.json(
      { code: err.code, error: err.message, limit: err.limit },
      { status: 422 },
    );
  }
  // The tree refusals (Story MOTIR-5753 · MOTIR-7372).
  if (err instanceof PageDepthExceededError) {
    return NextResponse.json(
      { code: err.code, error: err.message, limit: err.limit, attemptedLevel: err.attemptedLevel },
      { status: 422 },
    );
  }
  if (err instanceof PageNeighbourInvalidError) {
    return NextResponse.json(
      {
        code: err.code,
        error: err.message,
        side: err.side,
        neighbourId: err.neighbourId,
        reason: err.reason,
      },
      { status: 422 },
    );
  }
  if (
    err instanceof PageCycleError ||
    err instanceof CrossProjectPageParentError ||
    err instanceof PageParentNotAllowedError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  // A folder parent outside the caller's scope — the folder domain's own code.
  if (err instanceof PageFolderNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof PageLevelCursorInvalidError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  // Page search's query refusals (Story MOTIR-9491 · MOTIR-9636), named so the
  // search box can show a too-long query as a hint rather than an error.
  if (err instanceof PageSearchQueryEmptyError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
  }
  if (err instanceof PageSearchQueryTooLongError) {
    return NextResponse.json(
      { code: err.code, error: err.message, limit: err.limit },
      { status: err.status },
    );
  }
  // The archive refusals (Story MOTIR-5755 · MOTIR-7422). A write to an archived
  // page and an action on the wrong archive state are conflicts with the page's
  // current state, 409; a sub-page names its root so the client can link to the
  // page that restores or deletes. A create or move UNDER an archived page is a
  // tree refusal like the others above, 422.
  if (err instanceof PageArchivedError || err instanceof PageNotArchivedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  // A delete that would take an approved decision's frozen version (MOTIR-7431).
  if (err instanceof PageHoldsFrozenVersionError) {
    return NextResponse.json(
      { code: err.code, error: err.message, pageId: err.pageId },
      { status: 409 },
    );
  }
  // The hand link (MOTIR-9197): a second link of one pair, and an unlink of a
  // pair that has no hand link.
  if (err instanceof PageLinkAlreadyExistsError || err instanceof PageLinkNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
  }
  if (err instanceof PageArchiveRootRequiredError) {
    return NextResponse.json(
      { code: err.code, error: err.message, rootId: err.rootId },
      { status: 409 },
    );
  }
  if (err instanceof PageParentArchivedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  throw err;
}

/**
 * A history route's positive-integer input (`before`, `limit`, a version
 * `number`) — `null` when it is anything else, which the route answers as 400.
 */
export function parsePositiveInt(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** The 400 a history route sends for a malformed integer input. */
export function badIntegerResponse(name: string): NextResponse {
  return NextResponse.json(
    { code: 'BAD_REQUEST', error: `Expected \`${name}\` to be a positive integer.` },
    { status: 400 },
  );
}
