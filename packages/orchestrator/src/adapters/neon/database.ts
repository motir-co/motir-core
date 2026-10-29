import { OrchestratorApiError } from '../../errors';
import { databaseEnvPairs } from '../../database/env';
import {
  DatabaseApplicationRefInvalidError,
  DatabaseNotFoundError,
  assertDatabaseBranchName,
} from '../../database/errors';
import type {
  DatabaseBranchHandle,
  DatabaseHandle,
  DatabasePort,
  DatabaseSummary,
  DatabaseUsage,
} from '../../database/types';
import type { ReleaseEnvVar } from '../../hosting/types';
import type { NeonDatabaseConfig } from './config';

// The NEON adapter of the DATABASE PORT (Story MOTIR-9793 · MOTIR-9973), to the
// decision of record MOTIR-5769 §4 (page cmvrcywwc00jkhpr1zvvnike8, v1): one
// Neon PROJECT per application, inside Motir's own organisation.
//
// The project is named `mh-<applicationRef>`, so create is idempotent by an exact
// name match in the organisation; the handle's `databaseRef` is the project id.
// It is created with one database and one role, both `app`, so the connection
// strings are re-read later from `connection_uri` by those names: the pooled one
// is `DATABASE_URL`, the direct one `DIRECT_URL` (`databaseEnvPairs`), and the
// adapter caches neither.
//
// ⚠️ NO BODY IN ANY ERROR. A Neon response can quote a connection string, so a
// refusal becomes `OrchestratorApiError` with the status and Neon's error CODE
// only. The key goes in the Authorization header and nowhere else.
//
// ⚠️ USAGE BEFORE DELETE. `deleteDatabase` reads the project's usage first; a
// read that fails throws and sends no delete, so a retry is safe and there is no
// delete that does not produce usage. Usage is Neon's consumption history v2
// (`compute_unit_seconds`, by the hour, day or month by the window's age — the
// endpoint the Launch plan serves) and the root branch's logical size.
//
// BRANCHES (MOTIR-5772). A preview's database is a Neon branch of its
// application's preview project, made from the project's root (`main`, which
// MOTIR-5769 §6 keeps data-free) with its own read-write compute; create is
// idempotent by the branch's exact name, and its pairs are `connection_uri` read
// for that branch. A branch's usage is read from the branch itself before it is
// deleted — `compute_time_seconds` (CPU seconds, which on Neon's fractional
// computes is compute-unit seconds) and its `logical_size` — because
// consumption history v2 does not break a project down by branch. A 404 on the
// delete is a branch already gone, so teardown is idempotent.

/** Every project this adapter makes is named with this prefix. */
export const NEON_PROJECT_PREFIX = 'mh-';
/** The database and role each project is created with. */
export const NEON_APP_DATABASE = 'app';
export const NEON_APP_ROLE = 'app';
export const NEON_API_BASE = 'https://console.neon.tech/api/v2';

const REF = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;
const READ_ATTEMPTS = 4;
const RETRY_MS = 500;
const PAGE_LIMIT = 100;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface NeonDatabaseOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

// ── Neon's shapes, private to this folder ────────────────────────────────────

interface NeonProject {
  readonly id: string;
  readonly name: string;
  readonly created_at?: string;
  readonly deleted_at?: string | null;
}

interface NeonProjectsPage {
  readonly projects?: NeonProject[];
  readonly pagination?: { readonly cursor?: string };
}

interface NeonBranch {
  readonly id?: string;
  readonly name?: string;
  readonly created_at?: string;
  readonly default?: boolean;
  readonly primary?: boolean;
  readonly logical_size?: number;
  readonly compute_time_seconds?: number;
}

interface NeonConsumption {
  readonly projects?: Array<{
    readonly periods?: Array<{
      readonly consumption?: Array<{
        readonly metrics?: Array<{ readonly metric_name?: string; readonly value?: number }>;
      }>;
    }>;
  }>;
}

type Granularity = 'hourly' | 'daily' | 'monthly';

/** The project a ref maps to, or the typed refusal before any request. */
export function neonProjectName(applicationRef: string): string {
  if (!REF.test(applicationRef)) throw new DatabaseApplicationRefInvalidError(applicationRef);
  return `${NEON_PROJECT_PREFIX}${applicationRef}`;
}

/** Neon's error code from a body, kept only if it looks like a code. */
function codeOf(body: unknown): string {
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : '';
}

/** The window's history granularity: Neon keeps hourly points for 168 hours,
 *  daily for 60 days, monthly for a year. */
function granularityOf(since: Date, now: Date): Granularity {
  const age = now.getTime() - since.getTime();
  return age <= 168 * HOUR_MS ? 'hourly' : age <= 60 * DAY_MS ? 'daily' : 'monthly';
}

function floorTo(at: Date, granularity: Granularity): Date {
  const d = new Date(at);
  d.setUTCMinutes(0, 0, 0);
  if (granularity !== 'hourly') d.setUTCHours(0);
  if (granularity === 'monthly') d.setUTCDate(1);
  return d;
}

function nextOf(at: Date, granularity: Granularity): Date {
  const d = new Date(at);
  if (granularity === 'hourly') d.setUTCHours(d.getUTCHours() + 1);
  else if (granularity === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export function createNeonDatabasePort(
  config: NeonDatabaseConfig,
  options: NeonDatabaseOptions = {},
): DatabasePort {
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /**
   * One Neon call. `missing` answers a 404 instead of throwing. Reads and
   * deletes are retried on 423, 429 and 5xx; a create is never retried, except
   * on 423 when `lockedRetry` says so — Neon's "project locked by a running
   * operation", which created nothing (a branch asked for right after its
   * project is the common case).
   */
  async function neon<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    init: {
      query?: Record<string, string>;
      body?: unknown;
      missing?: T;
      lockedRetry?: boolean;
    } = {},
  ): Promise<T> {
    const url = new URL(`${NEON_API_BASE}${path}`);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const create = method === 'POST';
    const attempts = create && !init.lockedRetry ? 1 : READ_ATTEMPTS;
    for (let attempt = 1; ; attempt += 1) {
      let res: Response;
      try {
        res = await send(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            Accept: 'application/json',
            ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      } catch {
        if (attempt < attempts) {
          await sleep(RETRY_MS * attempt);
          continue;
        }
        throw new OrchestratorApiError('neon', null, 'request failed');
      }
      const body: unknown = await res.json().catch(() => null);
      if (res.ok) return body as T;
      if (res.status === 404 && 'missing' in init) return init.missing as T;
      const retryable = create
        ? res.status === 423
        : res.status === 423 || res.status === 429 || res.status >= 500;
      if (retryable && attempt < attempts) {
        await sleep(RETRY_MS * attempt);
        continue;
      }
      throw new OrchestratorApiError('neon', res.status, codeOf(body));
    }
  }

  /** The project behind a handle, or null when it is gone or is not the
   *  handle's application's. */
  async function projectOf(handle: DatabaseHandle): Promise<NeonProject | null> {
    const name = neonProjectName(handle.applicationRef);
    const found = await neon<{ project?: NeonProject } | null>(
      'GET',
      `/projects/${encodeURIComponent(handle.databaseRef)}`,
      { missing: null },
    );
    const project = found?.project;
    return project && project.name === name && !project.deleted_at ? project : null;
  }

  async function projectsNamed(prefix: string): Promise<NeonProject[]> {
    const all: NeonProject[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await neon<NeonProjectsPage>('GET', '/projects', {
        query: {
          org_id: config.orgId,
          search: prefix,
          limit: String(PAGE_LIMIT),
          ...(cursor ? { cursor } : {}),
        },
      });
      const projects = page.projects ?? [];
      all.push(...projects.filter((p) => p.name.startsWith(prefix) && !p.deleted_at));
      cursor = page.pagination?.cursor;
      if (projects.length < PAGE_LIMIT || !cursor) return all;
    }
  }

  async function connectionPairs(
    projectId: string,
    branchId?: string,
  ): Promise<readonly ReleaseEnvVar[]> {
    const uri = async (pooled: boolean) => {
      const out = await neon<{ uri?: string } | null>(
        'GET',
        `/projects/${encodeURIComponent(projectId)}/connection_uri`,
        {
          query: {
            ...(branchId ? { branch_id: branchId } : {}),
            database_name: NEON_APP_DATABASE,
            role_name: NEON_APP_ROLE,
            pooled: String(pooled),
          },
          missing: null,
        },
      );
      return out?.uri ?? null;
    };
    const pooledUrl = await uri(true);
    const directUrl = await uri(false);
    if (!pooledUrl || !directUrl) {
      throw new OrchestratorApiError('neon', null, 'connection_uri returned no URI');
    }
    return databaseEnvPairs({ pooledUrl, directUrl });
  }

  async function usageOf(
    handle: DatabaseHandle,
    projectId: string,
    since: Date,
  ): Promise<DatabaseUsage> {
    const until = now();
    const granularity = granularityOf(since, until);
    const from = floorTo(since, granularity);
    const to = nextOf(floorTo(until, granularity), granularity);
    const history = await neon<NeonConsumption>('GET', '/consumption_history/v2/projects', {
      query: {
        org_id: config.orgId,
        project_ids: projectId,
        from: from.toISOString(),
        to: to.toISOString(),
        granularity,
        metrics: 'compute_unit_seconds',
      },
    });
    let compute = 0;
    for (const project of history.projects ?? []) {
      for (const period of project.periods ?? []) {
        for (const frame of period.consumption ?? []) {
          for (const metric of frame.metrics ?? []) {
            if (metric.metric_name === 'compute_unit_seconds') compute += metric.value ?? 0;
          }
        }
      }
    }
    const branches = await neon<{ branches?: NeonBranch[] }>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/branches`,
    );
    const root = (branches.branches ?? []).find((b) => b.default ?? b.primary);
    return {
      provider: 'neon',
      applicationRef: handle.applicationRef,
      since,
      until,
      computeSeconds: Math.round(compute),
      storageBytes: root?.logical_size ?? 0,
    };
  }

  /** The project's branch of that exact name, or null. */
  async function branchNamed(projectId: string, name: string): Promise<NeonBranch | null> {
    const page = await neon<{ branches?: NeonBranch[] }>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/branches`,
      { query: { search: name } },
    );
    return (page.branches ?? []).find((b) => b.name === name && b.id) ?? null;
  }

  /** The branch a handle names, or null when it, or its project, is gone. */
  async function branchOf(handle: DatabaseBranchHandle): Promise<NeonBranch | null> {
    const project = await projectOf(handle.database);
    if (!project) return null;
    const found = await neon<{ branch?: NeonBranch } | null>(
      'GET',
      `/projects/${encodeURIComponent(project.id)}/branches/${encodeURIComponent(handle.branchRef)}`,
      { missing: null },
    );
    const branch = found?.branch;
    return branch && branch.name === handle.name ? branch : null;
  }

  function nothing(applicationRef: string): DatabaseUsage {
    const at = now();
    return {
      provider: 'neon',
      applicationRef,
      since: at,
      until: at,
      computeSeconds: 0,
      storageBytes: 0,
    };
  }

  return {
    provider: 'neon',

    async createDatabase({ applicationRef, region }) {
      const name = neonProjectName(applicationRef);
      let project = (await projectsNamed(name)).find((p) => p.name === name);
      if (!project) {
        const created = await neon<{ project?: NeonProject }>('POST', '/projects', {
          body: {
            project: {
              name,
              org_id: config.orgId,
              region_id: region ?? config.region,
              branch: { database_name: NEON_APP_DATABASE, role_name: NEON_APP_ROLE },
            },
          },
        });
        if (!created.project?.id) {
          throw new OrchestratorApiError('neon', null, 'project create returned no project');
        }
        project = created.project;
      }
      const handle: DatabaseHandle = { provider: 'neon', applicationRef, databaseRef: project.id };
      return { handle, env: await connectionPairs(project.id) };
    },

    async connectionEnv(handle) {
      const project = await projectOf(handle);
      if (!project) throw new DatabaseNotFoundError(handle.applicationRef);
      return connectionPairs(project.id);
    },

    async usageSince(handle, since) {
      const project = await projectOf(handle);
      if (!project) throw new DatabaseNotFoundError(handle.applicationRef);
      return usageOf(handle, project.id, since);
    },

    async deleteDatabase(handle) {
      const project = await projectOf(handle);
      if (!project) return nothing(handle.applicationRef);
      const createdAt = Date.parse(project.created_at ?? '');
      // Usage FIRST: if this throws, nothing below runs.
      const usage = await usageOf(
        handle,
        project.id,
        Number.isNaN(createdAt) ? now() : new Date(createdAt),
      );
      await neon('DELETE', `/projects/${encodeURIComponent(project.id)}`, { missing: null });
      if (await projectOf(handle)) {
        throw new OrchestratorApiError('neon', null, 'project still present after delete');
      }
      return usage;
    },

    async createBranch(handle, { name }) {
      assertDatabaseBranchName(name);
      const project = await projectOf(handle);
      if (!project) throw new DatabaseNotFoundError(handle.applicationRef);
      let branch = await branchNamed(project.id, name);
      if (!branch) {
        const created = await neon<{ branch?: NeonBranch }>(
          'POST',
          `/projects/${encodeURIComponent(project.id)}/branches`,
          {
            body: { branch: { name }, endpoints: [{ type: 'read_write' }] },
            lockedRetry: true,
          },
        );
        if (!created.branch?.id) {
          throw new OrchestratorApiError('neon', null, 'branch create returned no branch');
        }
        branch = created.branch;
      }
      const ref: DatabaseBranchHandle = { database: handle, branchRef: branch.id!, name };
      return { branch: ref, env: await connectionPairs(project.id, branch.id) };
    },

    async deleteBranch(handle) {
      const branch = await branchOf(handle);
      if (!branch) return nothing(handle.database.applicationRef);
      const createdAt = Date.parse(branch.created_at ?? '');
      const usage: DatabaseUsage = {
        provider: 'neon',
        applicationRef: handle.database.applicationRef,
        since: Number.isNaN(createdAt) ? now() : new Date(createdAt),
        until: now(),
        computeSeconds: Math.round(branch.compute_time_seconds ?? 0),
        storageBytes: branch.logical_size ?? 0,
      };
      await neon(
        'DELETE',
        `/projects/${encodeURIComponent(handle.database.databaseRef)}/branches/${encodeURIComponent(handle.branchRef)}`,
        { missing: null },
      );
      return usage;
    },

    async list(): Promise<DatabaseSummary[]> {
      return (await projectsNamed(NEON_PROJECT_PREFIX)).map((project) => ({
        handle: {
          provider: 'neon',
          applicationRef: project.name.slice(NEON_PROJECT_PREFIX.length),
          databaseRef: project.id,
        },
      }));
    },
  };
}
