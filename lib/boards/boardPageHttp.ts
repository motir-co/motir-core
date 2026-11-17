import { NextResponse } from 'next/server';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  BoardColumnNotFoundError,
  BoardNotFoundError,
  InvalidBoardCursorError,
  InvalidBoardLaneError,
} from '@/lib/boards/errors';
import { decodeFilterParam } from '@/lib/filters/ast';
import { FilterValidationError } from '@/lib/filters/errors';
import type { BoardFilterInput } from '@/lib/dto/boards';
import { BOARD_FILTER_OFF_PARAM, isBoardFilterOff } from '@/lib/boards/boardFilterOff';

// The board PAGE routes' shared HTTP plumbing (MOTIR-11446) — the counterpart of
// `boardGateResponse.ts` for the two doors a board pages through:
//
//   GET /api/board/columns/[columnId]/cards — a column's next page, or with
//       `?lane=` one (lane × column) cell's page;
//   GET /api/board/lanes/[laneKey]/cells    — one lane's first page per column.
//
// Both answer the same refusal set, so the param reading and the typed-error →
// status mapping live once, here, and the two doors cannot disagree about a
// status code. The routes stay HTTP only: no cursor decoding, no lane parsing
// and no page bound — those are `boardsService`'s.

/** The query both page doors read: the board, the optional board filter, and
 * the raw params for the route's own (`cursor`, `lane`). */
export type BoardPageParams = {
  boardId: string | undefined;
  filter: BoardFilterInput | undefined;
  params: URLSearchParams;
};

/**
 * The board filter a board read was asked for — the ONE parse the projection
 * (`/api/board`) and both page doors share, so a page is always read under the
 * filter its projection was:
 *
 *   - `?filter=v1:` — the header filter's compiled AST. A value that does not
 *     decode, or decodes to zero conditions, is no header filter (the
 *     forged-URL degrade); a decodable AST the registry rejects is the
 *     service's 422.
 *   - `?boardFilter=off` — do not apply the board's stored filter. Any other
 *     value is ignored.
 *
 * `undefined` when the request carries neither.
 */
export function readBoardFilterInput(params: URLSearchParams): BoardFilterInput | undefined {
  const rawFilter = params.get('filter')?.trim() || undefined;
  let ast: BoardFilterInput['ast'];
  if (rawFilter) {
    const decoded = decodeFilterParam(rawFilter);
    if (decoded.ok && decoded.ast.conditions.length > 0) ast = decoded.ast;
  }
  const storedFilterOff = isBoardFilterOff(params.get(BOARD_FILTER_OFF_PARAM));
  if (!ast && !storedFilterOff) return undefined;
  return { ...(ast ? { ast } : {}), ...(storedFilterOff ? { storedFilterOff } : {}) };
}

/**
 * Read `?boardId=` and the board filter ({@link readBoardFilterInput}) — the
 * SAME params the projection was read with, so a page never holds a card the
 * filtered board would not. Which params are REQUIRED is each route's own
 * contract, so a missing one is answered by the route, with {@link badRequest}.
 */
export function readBoardPageParams(req: Request): BoardPageParams {
  const params = new URL(req.url).searchParams;
  const boardId = params.get('boardId')?.trim() || undefined;
  return { boardId, filter: readBoardFilterInput(params), params };
}

/** The 400 a request missing a required page param owes. */
export function badRequest(error: string): Response {
  return NextResponse.json({ code: 'BAD_REQUEST', error }, { status: 400 });
}

/**
 * The typed refusals of a board page read, as the status each owes; null when
 * the error is not one of them (the caller rethrows it).
 *
 *   InvalidBoardCursorError / InvalidBoardLaneError                     → 400
 *   BoardNotFoundError / BoardColumnNotFoundError / ProjectNotFoundError → 404
 *   FilterValidationError                                               → 422
 *
 * A lane the board's group-by cannot hold is a 400, not a 404: the board exists
 * and the key is well formed, so what is wrong is the request.
 */
export function boardPageErrorResponse(err: unknown): Response | null {
  if (err instanceof InvalidBoardCursorError || err instanceof InvalidBoardLaneError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  if (err instanceof BoardNotFoundError || err instanceof BoardColumnNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof ProjectNotFoundError) {
    return NextResponse.json(
      { code: 'BOARD_NOT_FOUND', error: 'Board not found.' },
      { status: 404 },
    );
  }
  if (err instanceof FilterValidationError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
  }
  return null;
}
