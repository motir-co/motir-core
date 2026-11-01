/** The page's URL state (MOTIR-9987): every filter lives in the query string. */
export interface JobsQuery {
  tab?: 'runs' | 'dlq';
  status?: string;
  page?: number;
  fn?: string;
}

export const JOBS_PATH = '/admin/jobs';

/** `/admin/jobs?…` with the defaults left out, so the plain URL is the Runs tab. */
export function jobsHref(query: JobsQuery): string {
  const params = new URLSearchParams();
  if (query.tab === 'dlq') params.set('tab', 'dlq');
  if (query.status) params.set('status', query.status);
  if (query.page && query.page > 1) params.set('page', String(query.page));
  if (query.fn) params.set('fn', query.fn);
  const search = params.toString();
  return search ? `${JOBS_PATH}?${search}` : JOBS_PATH;
}
