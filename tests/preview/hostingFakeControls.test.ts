// The fake hosting port's app-side seam (Story MOTIR-5766 · MOTIR-10098): the
// accessor a spec arranges through, the spec helper's loud refusal, and the
// lane wiring that points the runner, the web server and the job worker at one
// state file. Pure: no database, no network.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_HOSTING_STATE_PATH_ENV,
  OrchestratorNotConfiguredError,
  createFakeHostingDeployPort,
} from '@motir/orchestrator';
import {
  getHostingDeployPort,
  hostingFakeControls,
  resetHostingFakes,
} from '@/lib/orchestrator/hosting';
import { previewHostingFake, resetPreviewHosting } from '../e2e/_helpers/preview-hosting';
import { previewHostingSeamEnv } from '../e2e/_helpers/job-worker-process';

const REPO = resolve(__dirname, '../..');
const PREVIEW = { kind: 'preview', pullRequest: 3 } as const;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'preview-hosting-'));
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  resetHostingFakes();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetHostingFakes();
  rmSync(dir, { recursive: true, force: true });
});

describe('hostingFakeControls', () => {
  it('is the very fake getHostingDeployPort hands back', async () => {
    const controls = hostingFakeControls('fly');
    expect(controls).toBe(getHostingDeployPort('fly'));
    const { appRef } = await controls.ensureApp({ repositoryId: 'cmr1', environment: PREVIEW });
    controls.setHealth(appRef, 'unhealthy');
    const port = getHostingDeployPort('fly');
    expect((port as typeof controls).app(appRef)?.health).toBe('unhealthy');
  });

  it('throws the typed not-configured error off the fake and builds nothing', () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fly');
    resetHostingFakes();
    expect(() => hostingFakeControls('fly')).toThrow(OrchestratorNotConfiguredError);
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    // Nothing was cached under the fly selector: the fake built now is new.
    expect(hostingFakeControls('fly').app('mh-cmr1-pr3')).toBeUndefined();
  });
});

describe('the spec helper', () => {
  it('reaches what another instance over the lane file made', async () => {
    vi.stubEnv(FAKE_HOSTING_STATE_PATH_ENV, join(dir, 'state.json'));
    const worker = createFakeHostingDeployPort({ target: 'fly' });
    const { appRef } = await worker.ensureApp({ repositoryId: 'cmr1', environment: PREVIEW });
    expect(previewHostingFake('fly').app(appRef)?.appRef).toBe(appRef);
    resetPreviewHosting();
    expect(worker.app(appRef)).toBeUndefined();
  });

  it('refuses loudly, naming the variable, when the lane carries no store', () => {
    vi.stubEnv(FAKE_HOSTING_STATE_PATH_ENV, '');
    expect(() => previewHostingFake()).toThrow(/MOTIR_FAKE_HOSTING_STATE_PATH/);
  });
});

describe('the lane wiring', () => {
  const read = (file: string) => readFileSync(join(REPO, file), 'utf8');
  const literal = (text: string) =>
    /process\.env\['MOTIR_FAKE_HOSTING_STATE_PATH'\] \?\?= path\.resolve\(\s*'([^']+)'/.exec(
      text,
    )?.[1];

  it('defaults the path on the runner of each lane, to two different files', () => {
    const main = literal(read('playwright.config.ts'));
    const acceptance = literal(read('playwright.acceptance.config.ts'));
    expect(main).toBe('out/playwright-output/.fake-hosting.json');
    expect(acceptance).toBe('out/playwright-output-acceptance/.fake-hosting.json');
    expect(resolve(main!)).not.toBe(resolve(acceptance!));
  });

  it('hands the job worker the path by name from both spawn sites', () => {
    vi.stubEnv(FAKE_HOSTING_STATE_PATH_ENV, '/tmp/lane.json');
    expect(previewHostingSeamEnv()).toEqual({ MOTIR_FAKE_HOSTING_STATE_PATH: '/tmp/lane.json' });
    vi.stubEnv(FAKE_HOSTING_STATE_PATH_ENV, '');
    expect(previewHostingSeamEnv()).toEqual({});
    const spreads = read('tests/e2e/_helpers/job-worker-process.ts').match(
      /\.\.\.previewHostingSeamEnv\(\)/g,
    );
    expect(spreads).toHaveLength(2);
  });
});
