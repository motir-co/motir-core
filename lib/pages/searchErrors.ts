// Page search's query refusals (Story MOTIR-9489 · MOTIR-9551). Shaped like
// `@motir/pages`' errors — `code` + `status` + message — so `pageErrorResponse`
// and the MCP page tools read them the same way. The REST route and the
// `search_pages` tool name each one identically.

/** The longest query page search accepts, in characters after trimming. */
export const PAGE_SEARCH_QUERY_MAX_LENGTH = 200;

/** An empty or whitespace-only query — refused, so a search never returns every page. */
export class PageSearchQueryEmptyError extends Error {
  readonly code = 'PAGE_SEARCH_QUERY_EMPTY' as const;
  readonly status = 422 as const;
  constructor() {
    super('Enter a word to search for.');
    this.name = 'PageSearchQueryEmptyError';
  }
}

/** A query over {@link PAGE_SEARCH_QUERY_MAX_LENGTH} characters. */
export class PageSearchQueryTooLongError extends Error {
  readonly code = 'PAGE_SEARCH_QUERY_TOO_LONG' as const;
  readonly status = 422 as const;
  readonly limit = PAGE_SEARCH_QUERY_MAX_LENGTH;
  constructor() {
    super(`A search query can be at most ${PAGE_SEARCH_QUERY_MAX_LENGTH} characters.`);
    this.name = 'PageSearchQueryTooLongError';
  }
}
