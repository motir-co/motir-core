import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { ActionsVariableApiError, actionsVariableClient } from '@/lib/github/actionsVariables';
import {
  getOrgInstallation,
  latestWorkflowCommit,
  listInstallationRepositoryIds,
  OrgInstallationReadError,
} from '@/lib/github/orgInstallation';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';
import {
  _resetProvisioningInstallationCache,
  findProvisioningInstallationId,
} from '@/lib/github/repoProvisioning';
import { repoVisibilityClient } from '@/lib/github/repoVisibility';
import {
  CodeScanningDefaultSetupApiError,
  codeScanningDefaultSetupClient,
} from '@/lib/github/codeScanningDefaultSetup';
import {
  fleetOrgCiStorePath,
  installGithubFleetOrgCiMock,
  type FleetOrgCiCall,
  type FleetOrgCiControl,
  type FleetOrgCiStore,
} from '@/lib/test-github-fleet-org-ci-mock';

// THE E2E GITHUB FLEET ORG CI SEAM (Story MOTIR-8699 · MOTIR-8717), driven through the
// REAL clients `/admin/fleet-settings` reaches — `getOrgInstallation`,
// `listInstallationRepositoryIds`, `latestWorkflowCommit`, `repoVisibilityClient`,
// `findProvisioningInstallationId` and `actionsVariableClient` — and the REAL App JWT +
// installation-token mint (`appAuth.ts`, signed with a key generated here), against the
// seam's intercepts on an undici `MockAgent` with net connect DISABLED, so any call the
// seam does not answer fails loudly instead of reaching api.github.com.

const original = getGlobalDispatcher();
const dir = mkdtempSync(join(tmpdir(), 'fleet-org-ci-mock-'));
const CONTROL = join(dir, 'control.json');
const JOURNAL = join(dir, 'journal.jsonl');
const STORE = fleetOrgCiStorePath(CONTROL);

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ORG = 'Acme-Connected';
const INSTALLATION = '88170001';
const target: GithubOrgTarget = { org: ORG, installationId: INSTALLATION, role: 'provisioning' };

const READY: FleetOrgCiControl = {
  orgs: {
    [ORG]: {
      installationId: INSTALLATION,
      permissions: {
        organization_self_hosted_runners: 'write',
        organization_actions_variables: 'write',
      },
      events: ['workflow_job'],
      repositories: [
        { id: 501, name: 'api', workflowCommit: { sha: 'abc123', date: '2026-10-01T00:00:00Z' } },
        { id: 502, name: 'site', private: false },
        { id: 503, name: 'tools' },
      ],
    },
  },
};

function control(value: FleetOrgCiControl) {
  writeFileSync(CONTROL, JSON.stringify(value));
}

function journal(): FleetOrgCiCall[] {
  try {
    return readFileSync(JOURNAL, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FleetOrgCiCall);
  } catch {
    return [];
  }
}

function store(): FleetOrgCiStore {
  try {
    return JSON.parse(readFileSync(STORE, 'utf8')) as FleetOrgCiStore;
  } catch {
    return { variables: {}, spentFailures: [] };
  }
}

const writes = () => journal().filter((c) => c.method !== 'GET' && c.path.includes('/variables'));

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('E2E_GITHUB_FLEET_ORG_CI_CONTROL', CONTROL);
  vi.stubEnv('E2E_GITHUB_FLEET_ORG_CI_JOURNAL', JOURNAL);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '424242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  writeFileSync(JOURNAL, '');
  rmSync(STORE, { force: true });
  control(READY);
  const agent = new MockAgent();
  agent.disableNetConnect();
  installGithubFleetOrgCiMock(agent);
  setGlobalDispatcher(agent);
});

afterAll(() => {
  setGlobalDispatcher(original);
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('the installation reads answer from the control', () => {
  it('reports the installation, its permissions and events, under the App JWT', async () => {
    const installation = await getOrgInstallation(ORG, 'provisioning');
    expect(installation).toEqual({
      id: INSTALLATION,
      permissions: {
        organization_self_hosted_runners: 'write',
        organization_actions_variables: 'write',
      },
      events: ['workflow_job'],
      repositorySelection: 'selected',
      suspendedAt: null,
    });
    // The setting's own lookup reads the same path; the org login is matched as GitHub
    // matches it, whatever its case.
    expect(await findProvisioningInstallationId(ORG.toLowerCase())).toBe(INSTALLATION);
  });

  it('answers 404 — "not installed" — when the control says so', async () => {
    control({ orgs: { [ORG]: { ...READY.orgs![ORG]!, installed: false } } });
    expect(await getOrgInstallation(ORG, 'provisioning')).toBeNull();
    expect(journal().at(-1)).toMatchObject({ path: `/orgs/${ORG}/installation`, status: 404 });
  });

  it('lists the granted repositories through a minted token, following `Link` to the end', async () => {
    control({ orgs: { [ORG]: { ...READY.orgs![ORG]!, repositoriesPageSize: 2 } } });
    expect(await listInstallationRepositoryIds(target)).toEqual([501, 502, 503]);
    const mints = journal().filter((c) => c.path.endsWith('/access_tokens'));
    expect(mints).toEqual([
      expect.objectContaining({ path: `/app/installations/${INSTALLATION}/access_tokens` }),
    ]);
    expect(journal().filter((c) => c.path.startsWith('/installation/repositories'))).toHaveLength(
      2,
    );
  });

  it('a repository the installation is not granted is left out of the list', async () => {
    const repos = READY.orgs![ORG]!.repositories!.map((r) =>
      r.id === 503 ? { ...r, granted: false } : r,
    );
    control({ orgs: { [ORG]: { ...READY.orgs![ORG]!, repositories: repos } } });
    expect(await listInstallationRepositoryIds(target)).toEqual([501, 502]);
  });

  it('reports each repository’s visibility, and the workflow commit the control gives', async () => {
    expect(await repoVisibilityClient.isPrivate(ORG, 'api', target)).toBe(true);
    expect(await repoVisibilityClient.isPrivate(ORG, 'site', target)).toBe(false);
    expect(await latestWorkflowCommit(target, ORG, 'api')).toEqual({
      sha: 'abc123',
      committedAt: '2026-10-01T00:00:00Z',
    });
    expect(await latestWorkflowCommit(target, ORG, 'tools')).toBeNull();
  });
});

describe('the MOTIR_RUNNER variable store', () => {
  it('a write is visible to the next read: ensure creates, then reads back', async () => {
    expect(await actionsVariableClient.getOrgVariable('MOTIR_RUNNER', target)).toBeNull();
    expect(
      await actionsVariableClient.ensureOrgVariable('MOTIR_RUNNER', 'motir-runner', target),
    ).toBe('created');
    expect(await actionsVariableClient.getOrgVariable('MOTIR_RUNNER', target)).toEqual({
      name: 'MOTIR_RUNNER',
      value: 'motir-runner',
      visibility: 'private',
    });
    expect(
      await actionsVariableClient.ensureOrgVariable('MOTIR_RUNNER', 'motir-runner', target),
    ).toBe('unchanged');
    expect(writes()).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: `/orgs/${ORG}/actions/variables`,
        org: ORG.toLowerCase(),
        status: 201,
        body: { name: 'MOTIR_RUNNER', value: 'motir-runner', visibility: 'private' },
      }),
    ]);
  });

  it('PATCH corrects a drifted variable and DELETE removes it', async () => {
    await actionsVariableClient.ensureOrgVariable('MOTIR_RUNNER', 'motir-runner', target);
    expect(await actionsVariableClient.patch('MOTIR_RUNNER', 'other', target)).toBe('updated');
    expect(store().variables[ORG.toLowerCase()]!['MOTIR_RUNNER']!.value).toBe('other');
    expect(await actionsVariableClient.deleteOrgVariable('MOTIR_RUNNER', target)).toBe('deleted');
    expect(await actionsVariableClient.deleteOrgVariable('MOTIR_RUNNER', target)).toBe('absent');
    expect(await actionsVariableClient.getOrgVariable('MOTIR_RUNNER', target)).toBeNull();
  });

  it('a forced write failure answers its status ONCE and leaves the store unchanged', async () => {
    await actionsVariableClient.ensureOrgVariable('MOTIR_RUNNER', 'motir-runner', target);
    const before = store().variables;

    control({
      orgs: { [ORG]: { ...READY.orgs![ORG]!, failNextWrite: { id: 'f1', status: 403 } } },
    });
    const refused = await actionsVariableClient
      .deleteOrgVariable('MOTIR_RUNNER', target)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ActionsVariableApiError);
    expect((refused as ActionsVariableApiError).status).toBe(403);
    expect(store().variables).toEqual(before);
    expect(await actionsVariableClient.getOrgVariable('MOTIR_RUNNER', target)).toMatchObject({
      value: 'motir-runner',
    });
    expect(writes().at(-1)).toMatchObject({ method: 'DELETE', status: 403 });

    // The same armed failure is spent: the next write goes through.
    expect(await actionsVariableClient.deleteOrgVariable('MOTIR_RUNNER', target)).toBe('deleted');
  });

  it('a variable call without the token this seam minted is refused 401', async () => {
    const res = await fetch(`https://api.github.com/orgs/${ORG}/actions/variables/MOTIR_RUNNER`, {
      headers: { authorization: 'Bearer somebody-elses-token' },
    });
    expect(res.status).toBe(401);
  });
});

describe('CodeQL default setup (MOTIR-10289)', () => {
  const configured: FleetOrgCiControl = {
    orgs: {
      [ORG]: {
        ...READY.orgs![ORG]!,
        repositories: [
          {
            id: 501,
            name: 'api',
            defaultSetup: {
              state: 'configured',
              runnerType: 'labeled',
              runnerLabel: 'motir-runner',
            },
          },
          { id: 503, name: 'tools' },
        ],
      },
    },
  };

  it('answers the control, else not configured, and a PATCH moves the runner in the store', async () => {
    control(configured);
    expect(await codeScanningDefaultSetupClient.get(ORG, 'api', target)).toEqual({
      state: 'configured',
      runner: { type: 'labeled', label: 'motir-runner' },
    });
    expect(await codeScanningDefaultSetupClient.get(ORG, 'tools', target)).toEqual({
      state: 'not-configured',
    });
    await codeScanningDefaultSetupClient.setRunner(ORG, 'api', { type: 'standard' }, target);
    expect(await codeScanningDefaultSetupClient.get(ORG, 'api', target)).toEqual({
      state: 'configured',
      runner: { type: 'standard' },
    });
    expect(store().defaultSetups?.['acme-connected']?.['api']).toEqual({
      state: 'configured',
      runnerType: 'standard',
      runnerLabel: null,
    });
    await codeScanningDefaultSetupClient.setRunner(
      ORG,
      'api',
      { type: 'labeled', label: 'motir-runner' },
      target,
    );
    expect(store().defaultSetups?.['acme-connected']?.['api']).toMatchObject({
      runnerType: 'labeled',
      runnerLabel: 'motir-runner',
    });
  });

  it('a PATCH on a repository not configured is refused 422 and configures nothing', async () => {
    control(configured);
    const err = await codeScanningDefaultSetupClient
      .setRunner(ORG, 'tools', { type: 'standard' }, target)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeScanningDefaultSetupApiError);
    expect(err).toMatchObject({ status: 422 });
    expect(store().defaultSetups?.['acme-connected']?.['tools']).toBeUndefined();
  });

  it('an unknown repository is 404, and a call without the minted token is 401', async () => {
    control(configured);
    await expect(codeScanningDefaultSetupClient.get(ORG, 'nope', target)).rejects.toMatchObject({
      status: 404,
    });
    const res = await fetch(`https://api.github.com/repos/${ORG}/api/code-scanning/default-setup`, {
      headers: { authorization: 'Bearer forged' },
    });
    expect(res.status).toBe(401);
    expect(
      journal()
        .filter((c) => c.path.endsWith('/default-setup'))
        .map((c) => c.status),
    ).toEqual([404, 401]);
  });
});

describe('an org the control does not name is refused, never answered', () => {
  const stranger: GithubOrgTarget = { ...target, org: 'someone-else' };

  it('its variable read and write leave nothing in the store and nothing in the journal', async () => {
    const read = await actionsVariableClient
      .getOrgVariable('MOTIR_RUNNER', stranger)
      .catch((e: unknown) => e);
    expect(read).toBeInstanceOf(ActionsVariableApiError);
    expect((read as ActionsVariableApiError).status).toBeNull();

    const write = await actionsVariableClient
      .ensureOrgVariable('MOTIR_RUNNER', 'motir-runner', stranger)
      .catch((e: unknown) => e);
    expect(write).toBeInstanceOf(ActionsVariableApiError);

    expect(store().variables['someone-else']).toBeUndefined();
    expect(journal().some((c) => c.org === 'someone-else' || c.path.includes('someone-else'))).toBe(
      false,
    );
  });

  it('its installation read is not answered', async () => {
    const err = await getOrgInstallation('someone-else', 'provisioning').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrgInstallationReadError);
    expect((err as OrgInstallationReadError).status).toBeNull();
  });

  it('an installation id the control does not name gets no token', async () => {
    await expect(
      listInstallationRepositoryIds({ ...target, installationId: '1' }),
    ).rejects.toMatchObject({ name: 'OrgTargetAuthError' });
  });
});
