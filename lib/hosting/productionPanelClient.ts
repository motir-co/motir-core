import type { IdlePolicyDto } from '@/lib/dto/idlePolicy';
import type { ProductionPanelDto } from '@/lib/dto/productionPanel';
import type { ProductionUsageDto } from '@/lib/dto/productionUsage';

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

/** A refusal of the idle-policy switch (MOTIR-12110), under `settings.production`:
 *  the words of the When idle control, not the rollback dialog's. */
export type IdlePolicyRefusalKey =
  | 'idle.refusal.credits'
  | 'idle.refusal.unsupportedShort'
  | 'idle.refusal.releaseInProgress'
  | 'idle.refusal.forbidden'
  | 'idle.refusal.noApplication'
  | 'refusal.notFound'
  | 'idle.refusal.failed';

const IDLE_CODE_KEYS: Record<string, IdlePolicyRefusalKey> = {
  always_on_refused_out_of_credits: 'idle.refusal.credits',
  HOSTING_IDLE_POLICY_UNSUPPORTED: 'idle.refusal.unsupportedShort',
  release_in_progress: 'idle.refusal.releaseInProgress',
  idle_policy_not_permitted: 'idle.refusal.forbidden',
  no_application: 'idle.refusal.noApplication',
  repository_not_found: 'refusal.notFound',
  idle_policy_failed: 'idle.refusal.failed',
};

async function idleRefusalKey(res: Response): Promise<IdlePolicyRefusalKey> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    const code = body.error?.code;
    if (typeof code === 'string' && Object.hasOwn(IDLE_CODE_KEYS, code)) {
      return IDLE_CODE_KEYS[code]!;
    }
  } catch {
    // Not a typed refusal; the status decides.
  }
  if (res.status === 403) return 'idle.refusal.forbidden';
  if (res.status === 404) return 'refusal.notFound';
  return 'idle.refusal.failed';
}

/** What a switch asks for: Always on, or Suspend when idle at the route's
 *  default quiet window unless one is named. */
export type IdlePolicyRequest = { mode: 'always_on' } | { mode: 'suspend'; idleSeconds?: number };

export type PanelReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; refusalKey: ProductionRefusalKey };

async function readJson<T>(url: string): Promise<PanelReadResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { headers: JSON_ACCEPT });
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

  /** The application's idle policy, whether the viewer may change it, and the
   *  policy its target refuses (MOTIR-12107). */
  readIdlePolicy(
    projectKey: string,
    repositoryId: string,
  ): Promise<PanelReadResult<IdlePolicyDto>> {
    return readJson(`${base(projectKey, repositoryId)}/idle-policy`);
  },

  /** Switch the idle policy; answers once the serving release runs it. */
  async setIdlePolicy(
    projectKey: string,
    repositoryId: string,
    policy: IdlePolicyRequest,
  ): Promise<{ ok: true; data: IdlePolicyDto } | { ok: false; refusalKey: IdlePolicyRefusalKey }> {
    let res: Response;
    try {
      res = await fetch(`${base(projectKey, repositoryId)}/idle-policy`, {
        method: 'PUT',
        headers: { ...JSON_ACCEPT, 'content-type': 'application/json' },
        body: JSON.stringify(policy),
      });
    } catch {
      return { ok: false, refusalKey: 'idle.refusal.failed' };
    }
    if (!res.ok) return { ok: false, refusalKey: await idleRefusalKey(res) };
    try {
      return { ok: true, data: (await res.json()) as IdlePolicyDto };
    } catch {
      return { ok: false, refusalKey: 'idle.refusal.failed' };
    }
  },

  /** This period's usage and credits for the application (MOTIR-12108). */
  readUsage(
    projectKey: string,
    repositoryId: string,
  ): Promise<PanelReadResult<ProductionUsageDto>> {
    return readJson(`${base(projectKey, repositoryId)}/usage`);
  },
};
