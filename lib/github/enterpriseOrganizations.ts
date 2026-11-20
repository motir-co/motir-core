import { githubFetch } from '@/lib/github/githubFetch';
import { createAppJwt, mintInstallationToken, type GithubAppRole } from '@/lib/github/appAuth';

// THE GITHUB ENTERPRISE HALF OF ADD-SHARD (Story MOTIR-8953 · MOTIR-8967) — the
// calls `fleet-admin add-shard` makes to find or create a fleet account's GitHub
// org inside Motir's Enterprise and install the Studio App on it.
//
// Every request and response field is read against GitHub's Enterprise Cloud docs:
//   - `GET /app/installations` (App JWT):
//     https://docs.github.com/en/enterprise-cloud@latest/rest/apps/apps#list-installations-for-the-authenticated-app
//     An Enterprise installation answers `target_type: "Enterprise"` and an
//     `account` carrying the enterprise's `slug`.
//   - `GET /app` (App JWT), for the App's `client_id`:
//     https://docs.github.com/en/enterprise-cloud@latest/rest/apps/apps#get-the-authenticated-app
//   - `GET /orgs/{org}`:
//     https://docs.github.com/en/enterprise-cloud@latest/rest/orgs/orgs#get-an-organization
//   - GraphQL `enterprise(slug:)` and `createEnterpriseOrganization`:
//     https://docs.github.com/en/enterprise-cloud@latest/graphql/reference/mutations#createenterpriseorganization
//     (`enterpriseId`, `login`, `profileName`, `billingEmail`, `adminLogins` are
//     all required).
//   - `GET` / `POST /enterprises/{enterprise}/apps/organizations/{org}/installations`:
//     https://docs.github.com/en/enterprise-cloud@latest/rest/enterprise-admin/organization-installations
//     (the POST body is `client_id` and `repository_selection`).
//
// ⚠️ THE ENTERPRISE INSTALLATION ID IS FOUND, NEVER CONFIGURED (MOTIR-1779's rule):
// it is read from `GET /app/installations` on every run.
//
// ⚠️ WHO MAY CREATE AN ORG. MOTIR-8962's H3 probe found that the enterprise
// installation token is refused by `createEnterpriseOrganization` ("Resource not
// accessible by integration"), so the mutation uses `GITHUB_ENTERPRISE_ADMIN_TOKEN`
// when it is set — the only working credential today — and falls back to the
// installation token only for an enterprise where that is allowed.
//
// No call here logs or returns a token; an error carries a status and GitHub's
// one-line message, never a body.

const GITHUB_API = 'https://api.github.com';
const GITHUB_GRAPHQL = 'https://api.github.com/graphql';
/** The Studio App — the one add-shard installs and the one that owns the rows. */
const ROLE: GithubAppRole = 'provisioning';

export const ENTERPRISE_SLUG_ENV = 'GITHUB_ENTERPRISE_SLUG';
export const ENTERPRISE_ADMIN_TOKEN_ENV = 'GITHUB_ENTERPRISE_ADMIN_TOKEN';

/** A GitHub refusal or transport failure on an Enterprise org call. Carries the
 *  status and a short detail, never the raw body (`RunnerGroupApiError`'s posture). */
export class EnterpriseOrganizationApiError extends Error {
  readonly code = 'ENTERPRISE_ORGANIZATION_API_FAILED' as const;
  constructor(
    readonly status: number | null,
    detail: string,
  ) {
    super(
      status === null
        ? `GitHub could not be reached for an Enterprise org call (${detail}).`
        : `GitHub refused an Enterprise org call (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
    this.name = 'EnterpriseOrganizationApiError';
  }
}

/** `GITHUB_ENTERPRISE_SLUG` is not set, or no Enterprise installation of the App
 *  matches it. */
export class EnterpriseInstallationNotFoundError extends Error {
  readonly code = 'ENTERPRISE_INSTALLATION_NOT_FOUND' as const;
  constructor(slug: string | null) {
    super(
      slug
        ? `The Studio App has no Enterprise installation on "${slug}".`
        : `${ENTERPRISE_SLUG_ENV} is not set.`,
    );
    this.name = 'EnterpriseInstallationNotFoundError';
  }
}

export interface EnterpriseInstallation {
  id: string;
  slug: string;
}

export interface GithubOrganization {
  login: string;
  id: number;
}

export interface OrgAppInstallation {
  id: string;
  clientId: string | null;
  appSlug: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function errorDetail(body: unknown): string {
  const message = asRecord(body)?.['message'];
  return typeof message === 'string' ? message.slice(0, 200) : '';
}

async function request(
  url: string,
  init: { method: string; bearer: string; body?: unknown },
): Promise<Response> {
  try {
    return await githubFetch('enterpriseOrganizations', url, {
      method: init.method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'motir',
        authorization: `Bearer ${init.bearer}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (err) {
    throw new EnterpriseOrganizationApiError(null, err instanceof Error ? err.message : 'unknown');
  }
}

async function expectOk(res: Response): Promise<unknown> {
  const body = await readJson(res);
  if (!res.ok) throw new EnterpriseOrganizationApiError(res.status, errorDetail(body));
  return body;
}

function enterpriseSlug(): string {
  const slug = process.env[ENTERPRISE_SLUG_ENV]?.trim();
  if (!slug) throw new EnterpriseInstallationNotFoundError(null);
  return slug;
}

async function enterpriseToken(): Promise<{ token: string; slug: string }> {
  const installation = await findEnterpriseInstallation();
  const { token } = await mintInstallationToken(installation.id, ROLE);
  return { token, slug: installation.slug };
}

async function graphql(bearer: string, query: string, variables: unknown): Promise<unknown> {
  const body = asRecord(
    await expectOk(
      await request(GITHUB_GRAPHQL, { method: 'POST', bearer, body: { query, variables } }),
    ),
  );
  const errors = body?.['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = asRecord(errors[0]);
    const type = typeof first?.['type'] === 'string' ? `${first['type']}: ` : '';
    const message = typeof first?.['message'] === 'string' ? first['message'].slice(0, 200) : '';
    throw new EnterpriseOrganizationApiError(200, `${type}${message}`);
  }
  return body?.['data'] ?? null;
}

export const enterpriseOrganizationsClient = {
  /** The Studio App's installation on the Enterprise `GITHUB_ENTERPRISE_SLUG`
   *  names, read from `GET /app/installations` with the App's JWT. */
  async findEnterpriseInstallation(): Promise<EnterpriseInstallation> {
    return findEnterpriseInstallation();
  },

  /** The App's own OAuth `client_id` — what an org installation is created with. */
  async findAppClientId(): Promise<string> {
    const body = asRecord(
      await expectOk(
        await request(`${GITHUB_API}/app`, {
          method: 'GET',
          bearer: createAppJwt(undefined, ROLE),
        }),
      ),
    );
    const clientId = body?.['client_id'];
    if (typeof clientId !== 'string' || !clientId) {
      throw new EnterpriseOrganizationApiError(200, 'the App answered no client_id');
    }
    return clientId;
  },

  /** The org, or null when GitHub answers 404. */
  async getOrganization(login: string): Promise<GithubOrganization | null> {
    const { token } = await enterpriseToken();
    const res = await request(`${GITHUB_API}/orgs/${encodeURIComponent(login)}`, {
      method: 'GET',
      bearer: token,
    });
    if (res.status === 404) return null;
    const body = asRecord(await expectOk(res));
    const id = body?.['id'];
    const found = body?.['login'];
    if (typeof id !== 'number' || typeof found !== 'string') {
      throw new EnterpriseOrganizationApiError(res.status, 'the org answer had no login or id');
    }
    return { login: found, id };
  },

  /** Create `login` inside the Enterprise. */
  async createEnterpriseOrganization(input: {
    login: string;
    profileName: string;
    billingEmail: string;
    adminLogins: string[];
  }): Promise<GithubOrganization> {
    const adminToken = process.env[ENTERPRISE_ADMIN_TOKEN_ENV]?.trim();
    const slug = enterpriseSlug();
    const bearer = adminToken || (await enterpriseToken()).token;
    const enterprise = asRecord(
      asRecord(
        await graphql(bearer, 'query($slug: String!) { enterprise(slug: $slug) { id } }', {
          slug,
        }),
      )?.['enterprise'],
    );
    const enterpriseId = enterprise?.['id'];
    if (typeof enterpriseId !== 'string') throw new EnterpriseInstallationNotFoundError(slug);

    const data = asRecord(
      await graphql(
        bearer,
        'mutation($input: CreateEnterpriseOrganizationInput!) { ' +
          'createEnterpriseOrganization(input: $input) { organization { login databaseId } } }',
        {
          input: {
            enterpriseId,
            login: input.login,
            profileName: input.profileName,
            billingEmail: input.billingEmail,
            adminLogins: input.adminLogins,
          },
        },
      ),
    );
    const organization = asRecord(
      asRecord(data?.['createEnterpriseOrganization'])?.['organization'],
    );
    const login = organization?.['login'];
    const id = organization?.['databaseId'];
    if (typeof login !== 'string' || typeof id !== 'number') {
      throw new EnterpriseOrganizationApiError(200, 'the mutation answered no organization');
    }
    return { login, id };
  },

  /** The App installations the Enterprise holds on one of its orgs. */
  async listEnterpriseOrgInstallations(org: string): Promise<OrgAppInstallation[]> {
    const { token, slug } = await enterpriseToken();
    const res = await request(
      `${GITHUB_API}/enterprises/${encodeURIComponent(slug)}/apps/organizations/` +
        `${encodeURIComponent(org)}/installations?per_page=100`,
      { method: 'GET', bearer: token },
    );
    const body = await expectOk(res);
    if (!Array.isArray(body)) {
      throw new EnterpriseOrganizationApiError(res.status, 'the installations answer was no list');
    }
    return body.flatMap((raw) => {
      const row = asRecord(raw);
      const id = row?.['id'];
      if (typeof id !== 'number' && typeof id !== 'string') return [];
      const clientId = row?.['client_id'];
      const appSlug = row?.['app_slug'];
      return [
        {
          id: String(id),
          clientId: typeof clientId === 'string' ? clientId : null,
          appSlug: typeof appSlug === 'string' ? appSlug : null,
        },
      ];
    });
  },

  /** Install the App with `clientId` on one of the Enterprise's orgs, on every
   *  repository (the fleet account's runners serve the org's whole estate). */
  async installAppOnOrganization(org: string, clientId: string): Promise<OrgAppInstallation> {
    const { token, slug } = await enterpriseToken();
    const res = await request(
      `${GITHUB_API}/enterprises/${encodeURIComponent(slug)}/apps/organizations/` +
        `${encodeURIComponent(org)}/installations`,
      { method: 'POST', bearer: token, body: { client_id: clientId, repository_selection: 'all' } },
    );
    const row = asRecord(await expectOk(res));
    const id = row?.['id'];
    if (typeof id !== 'number' && typeof id !== 'string') {
      throw new EnterpriseOrganizationApiError(res.status, 'the install answered no id');
    }
    const appSlug = row?.['app_slug'];
    return {
      id: String(id),
      clientId,
      appSlug: typeof appSlug === 'string' ? appSlug : null,
    };
  },
};

async function findEnterpriseInstallation(): Promise<EnterpriseInstallation> {
  const slug = enterpriseSlug();
  const jwt = createAppJwt(undefined, ROLE);
  for (let page = 1; page <= 10; page += 1) {
    const res = await request(`${GITHUB_API}/app/installations?per_page=100&page=${page}`, {
      method: 'GET',
      bearer: jwt,
    });
    const body = await expectOk(res);
    if (!Array.isArray(body)) {
      throw new EnterpriseOrganizationApiError(res.status, 'the installations answer was no list');
    }
    for (const raw of body) {
      const row = asRecord(raw);
      const account = asRecord(row?.['account']);
      const isEnterprise =
        row?.['target_type'] === 'Enterprise' || account?.['type'] === 'Enterprise';
      const accountSlug = account?.['slug'] ?? account?.['login'];
      const id = row?.['id'];
      if (
        isEnterprise &&
        typeof accountSlug === 'string' &&
        accountSlug.toLowerCase() === slug.toLowerCase() &&
        (typeof id === 'number' || typeof id === 'string')
      ) {
        return { id: String(id), slug: accountSlug };
      }
    }
    if (body.length < 100) break;
  }
  throw new EnterpriseInstallationNotFoundError(slug);
}
