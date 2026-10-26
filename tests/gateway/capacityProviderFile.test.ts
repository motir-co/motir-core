import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultCapacityFakeState,
  parseCapacityFakeState,
  type CapacityFakeState,
} from '@/lib/gateway/capacityFakeState';

// THE FILE-BACKED CAPACITY FAKE (Story MOTIR-9539 · MOTIR-9617): the acceptance
// lane's web server, job worker and spec are separate module copies and
// processes, so the fake's state lives in one file they all read per call. Each
// "process" here is a fresh module graph (`vi.resetModules()`).

const ROOT = process.cwd();
let dir: string;
let statePath: string;

async function client() {
  vi.resetModules();
  const { gatewayCapacityClient } = await import('@/lib/gateway/capacityProvider');
  return gatewayCapacityClient();
}

const fileState = (): CapacityFakeState => parseCapacityFakeState(readFileSync(statePath, 'utf8'));

function writeState(state: CapacityFakeState) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'capacity-fake-'));
  statePath = join(dir, 'nested', 'capacity.json');
  vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY', '1');
  vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY_STATE_PATH', statePath);
  vi.stubEnv('MOTIR_GATEWAY_CAPACITY_TOKEN', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('the state file', () => {
  it('is created from the default seed on the first read', async () => {
    expect(existsSync(statePath)).toBe(false);
    const read = await (await client()).read();
    expect(existsSync(statePath)).toBe(true);
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    const byProvider = Object.fromEntries(read.entries.map((e) => [e.provider, e.limits]));
    const setUnits = (provider: string) =>
      Object.entries(byProvider[provider]!)
        .filter(([, limit]) => limit.status === 'set')
        .map(([unit]) => unit);
    expect(setUnits('claude')).toEqual(['rpm', 'input_tpm', 'output_tpm']);
    expect(setUnits('qwen')).toEqual(['rpm', 'tpm']);
    expect(setUnits('deepseek')).toEqual(['max_concurrency']);
    for (const limits of Object.values(byProvider)) {
      for (const limit of Object.values(limits)) expect(limit.status).not.toBe('unknown');
    }
    expect(fileState()).toEqual(defaultCapacityFakeState());
  });

  it('is re-read on every call: a change between two reads shows with no restart', async () => {
    const gateway = await client();
    await gateway.read();
    const state = fileState();
    state.entries[0]!.tierNote = 'Changed by the spec';
    writeState(state);
    const read = await gateway.read();
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    expect(read.entries[0]!.tierNote).toBe('Changed by the spec');
  });
});

describe('a write', () => {
  it('an accepted edit is visible to another module copy and in the file', async () => {
    await (await client()).write('qwen', 'qwen-example-1', { rpm: 900, tierNote: 'Tier 3' });
    const read = await (await client()).read();
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    const qwen = read.entries.find((e) => e.provider === 'qwen')!;
    expect(qwen.limits.rpm).toEqual({ status: 'set', value: 900 });
    expect(qwen.tierNote).toBe('Tier 3');
    expect(fileState().entries.find((e) => e.provider === 'qwen')!.limits.rpm).toEqual({
      status: 'set',
      value: 900,
    });
  });

  it('a refused edit throws capacity_invalid_value on rpm and leaves the file byte-for-byte', async () => {
    const gateway = await client();
    await gateway.read();
    const before = readFileSync(statePath);
    await expect(gateway.write('qwen', 'qwen-example-1', { rpm: -1 })).rejects.toMatchObject({
      code: 'capacity_invalid_value',
      field: 'rpm',
    });
    await expect(
      gateway.write('qwen', 'qwen-example-1', { planningSharePercent: 101 }),
    ).rejects.toMatchObject({ field: 'planning_share_percent' });
    expect(readFileSync(statePath).equals(before)).toBe(true);
  });
});

describe('the modes', () => {
  it('unavailable answers with the counter store down, lanes and hints null, limits present', async () => {
    writeState({ ...defaultCapacityFakeState(), mode: 'unavailable' });
    const read = await (await client()).read();
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    expect(read.counterStore.state).toBe('unavailable');
    for (const entry of read.entries) {
      expect(entry.lanes).toEqual({ planning: null, agent: null });
      expect(entry.providerHint).toBeNull();
      expect(entry.tierNote).toBe('Example tier (E2E fake)');
      expect(Object.values(entry.limits).some((l) => l.status === 'set')).toBe(true);
    }
  });

  it('unreachable reads as network, and a write throws GatewayCapacityUnavailableError', async () => {
    writeState({ ...defaultCapacityFakeState(), mode: 'unreachable' });
    const gateway = await client();
    expect(await gateway.read()).toEqual({ outcome: 'unavailable', reason: 'network' });
    await expect(gateway.write('qwen', 'qwen-example-1', { rpm: 1 })).rejects.toMatchObject({
      name: 'GatewayCapacityUnavailableError',
    });
  });
});

describe('selection', () => {
  it('without the path the in-memory fake answers and no file is written', async () => {
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_CAPACITY_STATE_PATH', '');
    const gateway = await client();
    await gateway.write('qwen', 'qwen-example-1', { rpm: 700 });
    expect(existsSync(statePath)).toBe(false);
    const read = await gateway.read();
    if (read.outcome !== 'answered') throw new Error('expected an answer');
    expect(read.entries.find((e) => e.provider === 'qwen')!.limits.rpm).toEqual({
      status: 'set',
      value: 700,
    });
  });

  it('a production build without the harness selects neither fake', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    vi.resetModules();
    const { gatewayCapacityClient, httpGatewayCapacityClient } =
      await import('@/lib/gateway/capacityProvider');
    expect(gatewayCapacityClient()).toBe(httpGatewayCapacityClient);
    expect(await gatewayCapacityClient().read()).toEqual({
      outcome: 'unavailable',
      reason: 'not_configured',
    });
    expect(existsSync(statePath)).toBe(false);
  });
});

describe('the lane wiring', () => {
  const config = readFileSync(join(ROOT, 'playwright.acceptance.config.ts'), 'utf8');
  const worker = readFileSync(join(ROOT, 'tests/e2e/_helpers/job-worker-process.ts'), 'utf8');

  it.each(['MOTIR_E2E_FAKE_GATEWAY_CAPACITY', 'MOTIR_E2E_FAKE_GATEWAY_CAPACITY_STATE_PATH'])(
    'sets %s on the runner and hands it to the webServer',
    (name) => {
      expect(config).toMatch(new RegExp(`process\\.env\\['${name}'\\] \\?\\?=`));
      expect(config).toMatch(new RegExp(`${name}:\\s*process\\.env\\['${name}'\\]!`));
    },
  );

  it('reaches the job worker through its inherited environment', () => {
    expect(worker).toMatch(
      /spawn\(process\.execPath, \[WORKER_BUNDLE\], \{\s*env: \{\s*\.\.\.process\.env,/,
    );
  });
});
