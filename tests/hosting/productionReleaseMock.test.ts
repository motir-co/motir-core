import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { repoDeployments } from '@/lib/github/repoDeployments';
import { seedPromotionGithub } from '@/lib/github/seedPromotion';
import { parseHostingManifest } from '@/lib/hosting/manifest';
import { E2E_MOCK_SEAMS } from '@/lib/test-mock-seams';
import {
  installProductionReleaseMock,
  type ProductionReleaseCall,
  type ProductionReleaseControl,
} from '@/lib/test-production-release-mock';

// THE E2E PRODUCTION-RELEASE GITHUB SEAM (Story MOTIR-9797 · MOTIR-10040), driven
// through the REAL clients the merge-release and status jobs call — the manifest
// read and the deployment + status writes — against the seam's intercepts on an
// undici `MockAgent` with net connect DISABLED, so anything the seam does not
// claim fails here instead of reaching api.github.com.

const original = getGlobalDispatcher();
const dir = mkdtempSync(join(tmpdir(), 'production-release-mock-'));
const CONTROL = join(dir, 'control.json');
const JOURNAL = join(dir, 'journal.jsonl');
const ACCESS = { owner: 'motir-projects-e2e', repo: 'shop-web', token: 'ghs_test' };

const MANIFEST = {
  schemaVersion: 1,
  targets: ['fly'],
  port: 3000,
  healthCheck: { path: '/api/health' },
  startCommand: 'node server.js',
  buildCommand: 'pnpm build',
  requires: { websockets: false, backgroundWork: false },
  database: { kind: 'postgres', migrateCommand: 'node migrate.js deploy' },
};

function control(value: ProductionReleaseControl | string) {
  writeFileSync(CONTROL, typeof value === 'string' ? value : JSON.stringify(value));
}

function journal(): ProductionReleaseCall[] {
  return readFileSync(JOURNAL, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProductionReleaseCall);
}

function install() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  installProductionReleaseMock(agent);
  setGlobalDispatcher(agent);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('MOTIR_PRODUCTION_RELEASE_CONTROL_PATH', CONTROL);
  vi.stubEnv('MOTIR_PRODUCTION_RELEASE_JOURNAL_PATH', JOURNAL);
  vi.stubEnv('E2E_TEST_GITHUB_REPOS', '');
  writeFileSync(JOURNAL, '');
  control({
    installations: { 'Motir-Projects-E2E': 4242 },
    manifests: { 'motir-projects-e2e/Shop-Web': MANIFEST },
  });
  install();
});

afterAll(() => {
  setGlobalDispatcher(original);
  vi.unstubAllEnvs();
});

describe('the production-release seam, through the real clients', () => {
  it('serves the manifest the control names, at any commit, parseable by the release', async () => {
    const raw = await seedPromotionGithub.readHostingManifest(ACCESS, 'abc1234');
    expect(parseHostingManifest(raw)).toMatchObject({ port: 3000, database: { kind: 'postgres' } });
    expect(journal()).toEqual([
      {
        method: 'GET',
        path: '/repos/motir-projects-e2e/shop-web/contents/motir.hosting.json?ref=abc1234',
        body: null,
      },
    ]);
  });

  it('creates a deployment and accepts its statuses, journalling each body', async () => {
    const id = await repoDeployments.createDeployment(ACCESS, {
      ref: 'abc1234',
      environment: 'production',
    });
    expect(Number(id)).toBeGreaterThan(0);
    const next = await repoDeployments.createDeployment(ACCESS, {
      ref: 'def5678',
      environment: 'production',
    });
    expect(Number(next)).toBe(Number(id) + 1);
    await repoDeployments.createDeploymentStatus(ACCESS, {
      deploymentId: id,
      state: 'success',
      environmentUrl: 'https://shop--acme.motir.site',
    });
    const calls = journal();
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', '/repos/motir-projects-e2e/shop-web/deployments'],
      ['POST', '/repos/motir-projects-e2e/shop-web/deployments'],
      ['POST', `/repos/motir-projects-e2e/shop-web/deployments/${id}/statuses`],
    ]);
    expect(calls[0]!.body).toMatchObject({ ref: 'abc1234', environment: 'production' });
    expect(calls[2]!.body).toMatchObject({ state: 'success' });
  });

  it('answers the installation read of an org the control names, and only that org', async () => {
    const res = await fetch('https://api.github.com/orgs/motir-projects-e2e/installation');
    expect(await res.json()).toEqual({ id: 4242 });
    await expect(fetch('https://api.github.com/orgs/someone-else/installation')).rejects.toThrow();
  });

  it('leaves the installation read to the repos seam when that seam is on', async () => {
    vi.stubEnv('E2E_TEST_GITHUB_REPOS', '1');
    install();
    await expect(
      fetch('https://api.github.com/orgs/motir-projects-e2e/installation'),
    ).rejects.toThrow();
  });

  it('claims no repository the control does not name, and nothing with no control', async () => {
    await expect(
      seedPromotionGithub.readHostingManifest({ ...ACCESS, repo: 'other' }, 'abc1234'),
    ).rejects.toThrow();
    control('{"manifests":');
    await expect(seedPromotionGithub.readHostingManifest(ACCESS, 'abc1234')).rejects.toThrow();
    vi.stubEnv('MOTIR_PRODUCTION_RELEASE_CONTROL_PATH', '');
    await expect(seedPromotionGithub.readHostingManifest(ACCESS, 'abc1234')).rejects.toThrow();
  });

  it('answers without a journal, and over a body that is not JSON', async () => {
    vi.stubEnv('MOTIR_PRODUCTION_RELEASE_JOURNAL_PATH', '');
    const res = await fetch(
      'https://api.github.com/repos/motir-projects-e2e/shop-web/deployments/7/statuses',
      { method: 'POST', body: 'not json' },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ state: null });
    vi.stubEnv('MOTIR_PRODUCTION_RELEASE_JOURNAL_PATH', join(dir, 'missing', 'journal.jsonl'));
    const created = await fetch(
      'https://api.github.com/repos/motir-projects-e2e/shop-web/deployments',
      { method: 'POST' },
    );
    expect(await created.json()).toMatchObject({ ref: null });
  });
});

describe('the seam is in the one table, ahead of the GitHub seams it shares a host with', () => {
  it('registers before the merge and repos seams', () => {
    const order = E2E_MOCK_SEAMS.map((s) => s.flag);
    const own = order.indexOf('E2E_TEST_PRODUCTION_RELEASE');
    expect(own).toBeGreaterThanOrEqual(0);
    expect(own).toBeLessThan(order.indexOf('E2E_TEST_GITHUB_MERGE'));
    expect(own).toBeLessThan(order.indexOf('E2E_TEST_GITHUB_REPOS'));
  });
});
