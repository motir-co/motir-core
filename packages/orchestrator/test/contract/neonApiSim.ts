// A scripted Neon API for the NEON database adapter (MOTIR-9973): an
// organisation's projects, their connection URIs, their branches and their
// consumption history v2. It answers the adapter's `fetch`, records every call
// with its headers, checks the key on each, and refuses one call on demand —
// with a body that quotes a connection string, as a real error body can.

export interface NeonSimCall {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

export interface NeonSimProject {
  id: string;
  name: string;
  orgId: string;
  regionId: string;
  createdAt: number;
  password: string;
  deleted: boolean;
}

export interface NeonApiSim {
  readonly calls: NeonSimCall[];
  readonly projects: Map<string, NeonSimProject>;
  readonly fetch: typeof fetch;
  /** Answer the next call `matches` picks with `status`, once. */
  failNext(matches: (call: NeonSimCall) => boolean, status?: number, body?: unknown): void;
  /** The live projects of the organisation. */
  live(): NeonSimProject[];
}

export const NEON_SIM_KEY = 'neon-sim-api-key-5f1e';
export const NEON_SIM_ORG = 'org-autumn-mountain-12023030';
export const NEON_SIM_STORAGE_BYTES = 30 * 1024 * 1024;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function uriOf(project: NeonSimProject, pooled: boolean): string {
  const host = `ep-${project.id}${pooled ? '-pooler' : ''}.us-east-1.aws.neon.tech`;
  return `postgresql://app:${project.password}@${host}/app?sslmode=require`;
}

export function createNeonApiSim(clock: () => number): NeonApiSim {
  const calls: NeonSimCall[] = [];
  const projects = new Map<string, NeonSimProject>();
  const failures: Array<{
    matches: (call: NeonSimCall) => boolean;
    status: number;
    body: unknown;
  }> = [];
  let sequence = 0;

  const live = () => [...projects.values()].filter((p) => !p.deleted);
  const view = (p: NeonSimProject) => ({
    id: p.id,
    name: p.name,
    org_id: p.orgId,
    region_id: p.regionId,
    created_at: new Date(p.createdAt).toISOString(),
  });

  function answer(call: NeonSimCall): Response {
    const { method, url } = call;
    const path = url.pathname.replace(/^\/api\/v2/, '');
    const q = url.searchParams;
    if (path === '/projects' && method === 'GET') {
      const matching = live().filter(
        (p) => p.orgId === q.get('org_id') && p.name.includes(q.get('search') ?? ''),
      );
      const start = Number(q.get('cursor') ?? '0');
      const limit = Number(q.get('limit') ?? '10');
      const page = matching.slice(start, start + limit);
      return json(200, {
        projects: page.map(view),
        pagination: { cursor: String(start + page.length) },
      });
    }
    if (path === '/projects' && method === 'POST') {
      const body = JSON.parse(call.body ?? '{}') as {
        project: { name: string; org_id: string; region_id: string; branch: { role_name: string } };
      };
      sequence += 1;
      const project: NeonSimProject = {
        id: `proj-${sequence}`,
        name: body.project.name,
        orgId: body.project.org_id,
        regionId: body.project.region_id,
        createdAt: clock(),
        password: `npg_secret${sequence}x`,
        deleted: false,
      };
      projects.set(project.id, project);
      return json(201, {
        project: view(project),
        connection_uris: [{ connection_uri: uriOf(project, false) }],
        operations: [],
      });
    }
    if (path === '/consumption_history/v2/projects' && method === 'GET') {
      const from = Date.parse(q.get('from') ?? '');
      const to = Date.parse(q.get('to') ?? '');
      if (!(from < to) || !q.get('granularity') || q.get('metrics') !== 'compute_unit_seconds') {
        return json(400, { code: 'INVALID_REQUEST', message: 'bad window' });
      }
      const project = projects.get(q.get('project_ids') ?? '');
      const seconds = project ? Math.floor((clock() - project.createdAt) / 1000) : 0;
      return json(200, {
        projects: project
          ? [
              {
                project_id: project.id,
                periods: [
                  {
                    consumption: [
                      { metrics: [{ metric_name: 'compute_unit_seconds', value: seconds }] },
                    ],
                  },
                ],
              },
            ]
          : [],
      });
    }
    const match = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
    const project = match ? projects.get(decodeURIComponent(match[1]!)) : undefined;
    if (!project || project.deleted) {
      return json(404, { code: 'NOT_FOUND', message: 'project not found' });
    }
    const rest = match?.[2] ?? '';
    if (rest === '' && method === 'GET') return json(200, { project: view(project) });
    if (rest === '' && method === 'DELETE') {
      project.deleted = true;
      return json(200, { project: view(project) });
    }
    if (rest === '/connection_uri' && method === 'GET') {
      if (q.get('database_name') !== 'app' || q.get('role_name') !== 'app') {
        return json(404, { code: 'NOT_FOUND', message: 'no such role' });
      }
      return json(200, { uri: uriOf(project, q.get('pooled') === 'true') });
    }
    if (rest === '/branches' && method === 'GET') {
      return json(200, {
        branches: [{ default: true, logical_size: NEON_SIM_STORAGE_BYTES }, { default: false }],
      });
    }
    return json(405, { code: 'METHOD_NOT_ALLOWED', message: `${method} ${path}` });
  }

  const simFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const call: NeonSimCall = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    if (headers['authorization'] !== `Bearer ${NEON_SIM_KEY}`) {
      return json(401, { code: 'UNAUTHORIZED', message: 'bad key' });
    }
    const failure = failures.findIndex((f) => f.matches(call));
    if (failure >= 0) {
      const [f] = failures.splice(failure, 1);
      return json(f!.status, f!.body);
    }
    return answer(call);
  }) as typeof fetch;

  return {
    calls,
    projects,
    fetch: simFetch,
    failNext(matches, status = 503, body) {
      const quoted = live()[0];
      failures.push({
        matches,
        status,
        body: body ?? {
          code: 'INTERNAL_ERROR',
          message: `failed for ${quoted ? uriOf(quoted, true) : 'nothing'}`,
        },
      });
    },
    live,
  };
}
