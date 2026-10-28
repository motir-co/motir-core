import type {
  EnvironmentChangeDto,
  EnvironmentEntryDto,
  SetEnvironmentEntryResultDto,
} from '@/lib/dto/environmentConfig';
import type { EnvironmentName } from '@/lib/environmentConfig/vocabulary';

// The Environment room's thin client over the four environment routes (Story
// MOTIR-9795 · MOTIR-9966). Browser-safe: it imports types only. Each call answers
// a result rather than throwing, and a refusal comes back as the KIND the screen
// keys its copy on — the routes' typed codes (`reserved_environment_name`,
// `invalid_environment_name`), a 403 and a 404 — so no component parses a body.
//
// It never logs: a request body can hold a secret the administrator is typing.

export type EnvironmentRefusal =
  | { kind: 'reserved'; name: string }
  | { kind: 'invalid'; name: string }
  | { kind: 'forbidden' }
  | { kind: 'not_found' }
  | { kind: 'failed' };

export type EnvironmentResult<T> =
  | { ok: true; data: T }
  | { ok: false; refusal: EnvironmentRefusal };

/** The scope every call addresses: one repository's one environment. */
export interface EnvironmentScope {
  projectKey: string;
  repositoryId: string;
  environment: EnvironmentName;
}

function base({ projectKey, repositoryId, environment }: EnvironmentScope): string {
  return (
    `/api/projects/${encodeURIComponent(projectKey)}/repositories/` +
    `${encodeURIComponent(repositoryId)}/environments/${environment}`
  );
}

/** Map a refused response to its kind; `name` is the entry the call was about. */
async function refusalOf(res: Response, name: string): Promise<EnvironmentRefusal> {
  if (res.status === 403) return { kind: 'forbidden' };
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: { code?: string; name?: string } };
    code = body.error?.code;
    if (body.error?.name) name = body.error.name;
  } catch {
    // Not a typed refusal; the status decides.
  }
  if (code === 'reserved_environment_name') return { kind: 'reserved', name };
  if (code === 'invalid_environment_name') return { kind: 'invalid', name };
  if (res.status === 404) return { kind: 'not_found' };
  return { kind: 'failed' };
}

async function call<T>(
  url: string,
  init: RequestInit,
  name: string,
  read: (res: Response) => Promise<T>,
): Promise<EnvironmentResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, refusal: { kind: 'failed' } };
  }
  if (!res.ok) return { ok: false, refusal: await refusalOf(res, name) };
  try {
    return { ok: true, data: await read(res) };
  } catch {
    return { ok: false, refusal: { kind: 'failed' } };
  }
}

const JSON_ACCEPT = { accept: 'application/json' };

export const environmentConfigClient = {
  listEntries(scope: EnvironmentScope): Promise<EnvironmentResult<EnvironmentEntryDto[]>> {
    return call(`${base(scope)}/entries`, { headers: JSON_ACCEPT }, '', (res) => res.json());
  },

  putEntry(
    scope: EnvironmentScope,
    name: string,
    body: { value: string; isSecret: boolean },
  ): Promise<EnvironmentResult<SetEnvironmentEntryResultDto>> {
    return call(
      `${base(scope)}/entries/${encodeURIComponent(name)}`,
      {
        method: 'PUT',
        headers: { ...JSON_ACCEPT, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      name,
      (res) => res.json(),
    );
  },

  deleteEntry(scope: EnvironmentScope, name: string): Promise<EnvironmentResult<null>> {
    return call(
      `${base(scope)}/entries/${encodeURIComponent(name)}`,
      { method: 'DELETE', headers: JSON_ACCEPT },
      name,
      async () => null,
    );
  },

  listChanges(scope: EnvironmentScope): Promise<EnvironmentResult<EnvironmentChangeDto[]>> {
    return call(`${base(scope)}/changes`, { headers: JSON_ACCEPT }, '', (res) => res.json());
  },
};
