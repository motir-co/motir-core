import { ApiV1Error } from '@/lib/api/v1/errors';
import type { V1ErrorStatus } from '@/lib/api/v1/openapi/statuses';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// The PAGE refusal vocabulary on `/api/v1` (Story MOTIR-9486 · MOTIR-9493) — one
// mapper for every page route, so create, read, update and move answer each
// refusal with one status and one code.
//
// Mirrors the session routes' map (`lib/pages/routeErrors.ts`) refusal for
// refusal, with two v1 differences:
//
// ── 422, not 400, for a request the caller can fix ──────────────────────────
// v1's status vocabulary (`lib/api/v1/openapi/statuses.ts`) has no 400: a body
// that parses but is wrong is 422 everywhere on this surface
// (`InvalidRequestError`). So `PAGE_UPDATE_MALFORMED` and `PAGE_CURSOR_INVALID`,
// 400 on the session doors, are 422 here — same CODE, the status v1 speaks.
//
// ── A page the caller cannot see is `PAGE_NOT_FOUND`, byte for byte ──────────
// A page that never existed, a page in another project, and a page in a project
// the caller cannot browse answer the SAME body: `{ code: 'PAGE_NOT_FOUND',
// error: 'Page not found.' }`. The generic v1 map renders `PROJECT_ACCESS_DENIED`
// as a 404 with its own code, which would tell the caller the page exists; here
// a `browse` refusal and a `ProjectNotFoundError` become the page's not-found. A
// caller who CAN browse but lacks the page key gets 403 `PROJECT_ACCESS_DENIED`
// — the project is already known to them, and "you may not" is the honest answer.
//
// The codes are the package's own (`packages/pages/src/errors.ts`), the same
// names the MCP page tools surface, so the two doors agree without either
// importing the other. Every message the package writes is generic: none carries
// a title.

/** The 404 every invisible page answers with — one body, whatever the reason. */
const PAGE_NOT_FOUND_MESSAGE = 'Page not found.';

/** Each page refusal's status, by the package's code. */
export const PAGE_ERROR_STATUS: Readonly<Record<string, V1ErrorStatus>> = Object.freeze({
  PAGE_NOT_FOUND: 404,
  PAGE_VERSION_NOT_FOUND: 404,
  // A folder parent that is missing or not this project's — the package's own
  // class, the code the folder resource uses.
  FOLDER_NOT_FOUND: 404,
  // The page's STATE is not what the request assumed.
  PAGE_REVISION_CONFLICT: 409,
  PAGE_ARCHIVED: 409,
  PAGE_NOT_ARCHIVED: 409,
  PAGE_ARCHIVE_ROOT_REQUIRED: 409,
  PAGE_HOLDS_FROZEN_VERSION: 409,
  PAGE_BODY_TOO_LARGE: 413,
  // A request the caller can fix.
  PAGE_TITLE_TOO_LONG: 422,
  PAGE_UPDATE_MALFORMED: 422,
  PAGE_CURSOR_INVALID: 422,
  PAGE_PARENT_NOT_ALLOWED: 422,
  PAGE_CYCLE: 422,
  PAGE_DEPTH_EXCEEDED: 422,
  CROSS_PROJECT_PAGE_PARENT: 422,
  PAGE_NEIGHBOUR_INVALID: 422,
  PAGE_PARENT_ARCHIVED: 422,
});

/**
 * Map a refusal a page door raised onto the v1 error it renders as. Anything
 * that is not a page or project-access refusal is returned UNCHANGED, so the
 * wrapper classifies it as it would any other error (an `ApiV1Error`, a mapped
 * domain code, or a bare 500). Use it as `catch (err) { throw mapPageErrorToV1(err) }`.
 */
export function mapPageErrorToV1(err: unknown): unknown {
  if (err instanceof ProjectNotFoundError) return pageNotFound();
  if (err instanceof ProjectAccessDeniedError) {
    return err.kind === 'browse' ? pageNotFound() : new ApiV1Error(err.code, 403, err.message);
  }
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (code === 'PAGE_NOT_FOUND') return pageNotFound();
      const status = PAGE_ERROR_STATUS[code];
      if (status !== undefined) {
        return new ApiV1Error(code, status, (err as { message?: unknown }).message as string);
      }
    }
  }
  return err;
}

/** Run a page door, rethrowing its refusal as the v1 error it renders as. */
export async function withPageErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw mapPageErrorToV1(err);
  }
}

function pageNotFound(): ApiV1Error {
  return new ApiV1Error('PAGE_NOT_FOUND', 404, PAGE_NOT_FOUND_MESSAGE);
}
