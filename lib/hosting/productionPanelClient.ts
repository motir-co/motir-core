import type { ProductionPanelDto } from '@/lib/dto/productionPanel';

// The Production panel's thin client over its two routes (Story MOTIR-9797 ·
// MOTIR-10037): the read (`GET …/repositories/[rowId]/production`, one page of
// history) and the rollback (`POST …/production/rollback`, which answers the
// first page). Browser-safe: it imports types only. Each call answers a result
// rather than throwing, and a refusal comes back as the message KEY the panel
// shows — keyed on the routes' stable `code` values (MOTIR-10036), never on their
// `message`, so no provider's words, connection string or environment value can
// reach the screen through it.

/** A refusal's message, under `settings.production`. */
export type ProductionRefusalKey =
  | 'refusal.noPreviousRelease'
  | 'refusal.releaseInProgress'
  | 'refusal.conflict'
  | 'refusal.forbidden'
  | 'refusal.notFound'
  /** The design's own error line: the provider failed (502), or the answer never
   *  came — either way nothing changed, and the release named is still serving. */
  | 'dialog.error';

export type ProductionResult =
  | { ok: true; data: ProductionPanelDto }
  | { ok: false; refusalKey: ProductionRefusalKey };

/** Each stable route code to its own message. Anything else — an unmapped
 *  code, a 500, a body that is not JSON, the network — is the design's
 *  `dialog.error`, the same words a 502 earns. */
const CODE_KEYS: Record<string, ProductionRefusalKey> = {
  no_previous_release: 'refusal.noPreviousRelease',
  release_in_progress: 'refusal.releaseInProgress',
  rollback_conflict: 'refusal.conflict',
  rollback_not_permitted: 'refusal.forbidden',
  repository_not_found: 'refusal.notFound',
  rollback_failed: 'dialog.error',
};

export async function productionRefusalKey(res: Response): Promise<ProductionRefusalKey> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    const code = body.error?.code;
    if (typeof code === 'string' && Object.hasOwn(CODE_KEYS, code)) return CODE_KEYS[code]!;
  } catch {
    // Not a typed refusal; the status decides.
  }
  if (res.status === 403) return 'refusal.forbidden';
  if (res.status === 404) return 'refusal.notFound';
  return 'dialog.error';
}

function base(projectKey: string, repositoryId: string): string {
  return (
    `/api/projects/${encodeURIComponent(projectKey)}/repositories/` +
    `${encodeURIComponent(repositoryId)}/production`
  );
}

async function call(url: string, init: RequestInit): Promise<ProductionResult> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, refusalKey: 'dialog.error' };
  }
  if (!res.ok) return { ok: false, refusalKey: await productionRefusalKey(res) };
  try {
    return { ok: true, data: (await res.json()) as ProductionPanelDto };
  } catch {
    return { ok: false, refusalKey: 'dialog.error' };
  }
}

const JSON_ACCEPT = { accept: 'application/json' };

export const productionPanelClient = {
  /** One page of the panel: the first without a cursor, the next with one. */
  read(
    projectKey: string,
    repositoryId: string,
    cursor: string | null = null,
  ): Promise<ProductionResult> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return call(`${base(projectKey, repositoryId)}${query}`, { headers: JSON_ACCEPT });
  },

  /** Roll production back to the previous release; answers the panel's first page. */
  rollback(projectKey: string, repositoryId: string): Promise<ProductionResult> {
    return call(`${base(projectKey, repositoryId)}/rollback`, {
      method: 'POST',
      headers: JSON_ACCEPT,
    });
  },
};
