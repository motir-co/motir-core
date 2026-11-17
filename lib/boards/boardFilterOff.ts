// The board's "stored filter off" signal (MOTIR-11564) — one name for the query
// param, shared by the server's parse (`boardPageHttp.readBoardFilterInput`) and
// the client's URLs (`boardFilterHref`). Pure, so the client can import it.
//
// `?boardFilter=off` asks a board read NOT to apply the board's own stored
// filter, so with no header filter the board shows its whole scope. It is
// ignored beside a header filter (which already replaces the stored one) and on
// a board with no stored filter.

/** The query param that turns the board's stored filter off. */
export const BOARD_FILTER_OFF_PARAM = 'boardFilter';
/** The only value of {@link BOARD_FILTER_OFF_PARAM} that means anything. */
export const BOARD_FILTER_OFF_VALUE = 'off';

/** Whether a param value (a URL search param, or a page's `searchParams` entry)
 * turns the board's stored filter off. Anything but exactly `off` does not. */
export function isBoardFilterOff(raw: string | string[] | null | undefined): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === BOARD_FILTER_OFF_VALUE;
}
