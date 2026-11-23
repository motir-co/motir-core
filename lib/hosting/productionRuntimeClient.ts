import type { ProductionHealthDto } from '@/lib/dto/productionHealth';
import type { ProductionLogsDto } from '@/lib/dto/productionLogs';
import {
  productionRefusalKey,
  type ProductionRefusalKey,
} from '@/lib/hosting/productionPanelClient';

// The Production panel's thin client over its two RUNTIME reads (Story
// MOTIR-9799 · MOTIR-12109): the health route (`GET …/production/health`,
// MOTIR-12106) and the logs route (`GET …/production/logs`, MOTIR-12105).
// Browser-safe: it imports types and the shipped refusal mapping only. Each call
// answers a result rather than throwing, and a refusal comes back as the message
// KEY the panel shows, keyed on the routes' stable codes — never their words.

export type RuntimeResult<T> =
  | { ok: true; data: T }
  | { ok: false; refusalKey: ProductionRefusalKey };

export interface LogsQuery {
  /** ISO 8601; the start of the time range. */
  since: string;
  /** ISO 8601; omitted for "until now". */
  until?: string;
  /** The text filter; omitted or empty for none. */
  filter?: string;
  /** The opaque token for the next (older) page. */
  cursor?: string | null;
}

function base(projectKey: string, repositoryId: string): string {
  return (
    `/api/projects/${encodeURIComponent(projectKey)}/repositories/` +
    `${encodeURIComponent(repositoryId)}/production`
  );
}

async function get<T>(url: string): Promise<RuntimeResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    return { ok: false, refusalKey: 'dialog.error' };
  }
  if (!res.ok) return { ok: false, refusalKey: await productionRefusalKey(res) };
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, refusalKey: 'dialog.error' };
  }
}

export const productionRuntimeClient = {
  /** The application's health state, its condition and its crash events. */
  readHealth(
    projectKey: string,
    repositoryId: string,
  ): Promise<RuntimeResult<ProductionHealthDto>> {
    return get(`${base(projectKey, repositoryId)}/health`);
  },

  /** One page of the running release's logs, newest first, already masked. */
  readLogs(
    projectKey: string,
    repositoryId: string,
    query: LogsQuery,
  ): Promise<RuntimeResult<ProductionLogsDto>> {
    const params = new URLSearchParams({ since: query.since });
    if (query.until) params.set('until', query.until);
    if (query.filter) params.set('q', query.filter);
    if (query.cursor) params.set('cursor', query.cursor);
    return get(`${base(projectKey, repositoryId)}/logs?${params.toString()}`);
  },
};
