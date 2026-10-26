import type { PageSearchResultDto } from '@/lib/dto/pages';

// The ONE browser-side call to `GET /api/pages/search` (Story MOTIR-9491 ·
// MOTIR-9637). The only place the path is named.
//
// The answer is the route's `PageSearchResultDto`, returned as is. A refusal
// throws `PageSearchRequestError` carrying the response's `code` and `status`
// (and `limit` for a too-long query), read from the JSON body; a body that is
// not JSON reads as `UNKNOWN`. Nothing here judges the query — the service is
// the rule.

type Fetch = typeof fetch;

export class PageSearchRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly limit?: number,
  ) {
    super(`page search answered ${status} ${code}`);
  }
}

export interface PageSearchRequestOptions {
  fetchImpl?: Fetch;
  signal?: AbortSignal;
}

async function refusal(res: Response): Promise<PageSearchRequestError> {
  const body = (await res.json().catch(() => null)) as { code?: unknown; limit?: unknown } | null;
  const code = typeof body?.code === 'string' ? body.code : 'UNKNOWN';
  const limit = typeof body?.limit === 'number' ? body.limit : undefined;
  return new PageSearchRequestError(res.status, code, limit);
}

export async function searchPages(
  projectId: string,
  q: string,
  cursor: string | null,
  { fetchImpl = fetch, signal }: PageSearchRequestOptions = {},
): Promise<PageSearchResultDto> {
  const params = new URLSearchParams({ projectId, q });
  if (cursor !== null) params.set('cursor', cursor);
  const res = await fetchImpl(`/api/pages/search?${params.toString()}`, { signal });
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as PageSearchResultDto;
}
