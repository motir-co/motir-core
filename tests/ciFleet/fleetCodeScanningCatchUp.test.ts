import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { codeScanningDefaultSetupClient } from '@/lib/github/codeScanningDefaultSetup';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';
import { db } from '@/lib/db';
import { fleetCodeScanningMoveRepository } from '@/lib/repositories/fleetCodeScanningMoveRepository';
import {
  FAILED_MOVE_COOLDOWN_MS,
  fleetCodeScanningCatchUpService as service,
  MOVE_LEASE_MS,
  ON_FLEET_RECHECK_MS,
} from '@/lib/services/fleetCodeScanningCatchUpService';
import { withSystemContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The deferred CodeQL move a fleet boot makes once its runner is registered.
// GitHub is a fake at `fetch`; the stored pair row and the move claim are real.

const ORG = 'acme-connected';
const TARGET: GithubOrgTarget = { org: ORG, installationId: '4401', role: 'provisioning' };
const NO_RUNNER_WITH_LABEL =
  'Code scanning default setup can only be enabled if a runner with the specified label is assigned to this repository.';

interface Setup {
  state: 'configured' | 'not-configured';
  runner_type: 'standard' | 'labeled';
  runner_label: string;
}

let fx: WorkItemFixture;
let setups: Record<string, Setup>;
let isPrivate: boolean;
let patchAnswer: { status: number; message: string } | null;
let readDelayMs: number;
let calls: string[];
/** Fresh copies of `@/lib/db` loaded by {@link separateInstances}, closed after. */
let extraClients: Array<{ $disconnect(): Promise<void> }>;

const STANDARD: Setup = { state: 'configured', runner_type: 'standard', runner_label: '' };
const ON_FLEET: Setup = {
  state: 'configured',
  runner_type: 'labeled',
  runner_label: MOTIR_RUNNER_LABEL,
};

/** motir-ai's default setup, as the fake GitHub holds it. */
function setup(): Setup | undefined {
  return setups['motir-ai'];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function patches(): string[] {
  return calls.filter((c) => c.startsWith('PATCH'));
}

function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(String(url));
      const method = init?.method ?? 'GET';
      if (u.pathname.endsWith('/access_tokens')) {
        return json(201, {
          token: 'ghs_catch_up',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      calls.push(`${method} ${u.pathname}`);
      const setupPath = u.pathname.match(/^\/repos\/[^/]+\/([^/]+)\/code-scanning\/default-setup$/);
      if (setupPath) {
        const name = setupPath[1]!;
        if (method === 'GET') {
          // GitHub answers the state it read when the request arrived; a slow
          // answer is what lets concurrent boots all read before any writes.
          const answer = json(200, { languages: ['actions'], ...setups[name] });
          if (readDelayMs > 0) await new Promise((r) => setTimeout(r, readDelayMs));
          return answer;
        }
        if (patchAnswer) return json(patchAnswer.status, { message: patchAnswer.message });
        const body = JSON.parse(init!.body!) as Record<string, string>;
        setups[name] = {
          state: 'configured',
          runner_type: body['runner_type'] as Setup['runner_type'],
          runner_label: body['runner_label'] ?? '',
        };
        return json(202, { run_id: 1 });
      }
      // GitHub's paths are case-insensitive; the boot passes the owner as the
      // job's repository spells it.
      const repoPath = u.pathname.toLowerCase().match(new RegExp(`^/repos/${ORG}/([^/]+)$`));
      if (repoPath) return json(200, { private: isPrivate });
      return json(500, { message: `unexpected ${method} ${u.pathname}` });
    }),
  );
}

async function storePair(enabled: boolean): Promise<void> {
  await adminDb.platformFleetOrgCi.create({
    data: { projectId: fx.projectId, org: ORG, enabled, lastReason: 'seeded' },
  });
}

type Service = typeof service;

function catchUp(now?: number, opts: { via?: Service; repo?: string } = {}) {
  return (opts.via ?? service).afterRunnerRegistered({
    projectId: fx.projectId,
    owner: 'Acme-Connected',
    repo: opts.repo ?? 'motir-ai',
    target: TARGET,
    ...(now === undefined ? {} : { now }),
  });
}

/**
 * `count` copies of the catch-up service, each loaded from a FRESH module
 * registry — its own module state and its own `@/lib/db` client and pool, as
 * each fleet worker has. Nothing one remembers in process memory reaches
 * another, so only what they share in Postgres can keep them from racing.
 */
async function separateInstances(count: number): Promise<Service[]> {
  const instances: Service[] = [];
  for (let i = 0; i < count; i += 1) {
    vi.resetModules();
    const mod = await import('@/lib/services/fleetCodeScanningCatchUpService');
    const dbMod = await import('@/lib/db');
    if (dbMod.db !== db) extraClients.push(dbMod.db);
    // Warm the client, as a running worker's is: a first query's connect would
    // otherwise stagger the boots and hide the race.
    await dbMod.db.platformFleetOrgCi.findFirst({ select: { id: true } });
    instances.push(mod.fleetCodeScanningCatchUpService);
  }
  return instances;
}

async function clearMoves(): Promise<void> {
  await adminDb.fleetCodeScanningMove.deleteMany({});
}

beforeEach(async () => {
  await truncateAuthTables();
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  await clearMoves();
  setups = { 'motir-ai': { ...STANDARD } };
  isPrivate = true;
  patchAnswer = null;
  readDelayMs = 0;
  calls = [];
  extraClients = [];
  installGitHub();
  fx = await makeWorkItemFixture({ name: 'Motir', identifier: 'MOTIR' });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  await Promise.all(extraClients.map((c) => c.$disconnect()));
  // Outside every truncation helper's list: cleared here so the next file a
  // worker runs starts with no claim.
  await clearMoves();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('fleetCodeScanningCatchUpService.afterRunnerRegistered', () => {
  it('moves a configured default setup onto the fleet label when the pair is ON', async () => {
    await storePair(true);
    expect(await catchUp()).toBe('moved');
    expect(setup()).toEqual(ON_FLEET);
  });

  it('leaves GitHub untouched when the pair is OFF or was never stored', async () => {
    expect(await catchUp()).toBe('pair_off');
    await storePair(false);
    expect(await catchUp()).toBe('pair_off');
    expect(calls).toEqual([]);
  });

  it('does nothing for the provisioning org, which has no pair', async () => {
    await storePair(true);
    const outcome = await service.afterRunnerRegistered({
      projectId: fx.projectId,
      owner: ORG,
      repo: 'motir-ai',
      target: undefined,
    });
    expect(outcome).toBe('no_target');
    expect(calls).toEqual([]);
  });

  it('never writes a public repository or one whose default setup is not configured', async () => {
    await storePair(true);
    isPrivate = false;
    expect(await catchUp()).toBe('not_private');
    isPrivate = true;
    setups['motir-ai'] = { state: 'not-configured', runner_type: 'standard', runner_label: '' };
    expect(await catchUp()).toBe('not_configured');
    expect(calls.some((c) => c.startsWith('PATCH'))).toBe(false);
  });

  it('reads a repository already on the fleet once per recheck window', async () => {
    await storePair(true);
    setups['motir-ai'] = { ...ON_FLEET };
    const t0 = 1_000_000;
    expect(await catchUp(t0)).toBe('already_on_fleet');
    calls = [];
    expect(await catchUp(t0 + ON_FLEET_RECHECK_MS - 1)).toBe('recently_on_fleet');
    expect(calls).toEqual([]);
    expect(await catchUp(t0 + ON_FLEET_RECHECK_MS)).toBe('already_on_fleet');
  });

  it('answers still_no_runner when GitHub does not count the runner yet, and tries again next boot', async () => {
    await storePair(true);
    patchAnswer = { status: 422, message: NO_RUNNER_WITH_LABEL };
    expect(await catchUp()).toBe('still_no_runner');
    patchAnswer = null;
    expect(await catchUp()).toBe('moved');
  });

  it('logs and swallows any other failure, never throwing into the boot', async () => {
    await storePair(true);
    patchAnswer = { status: 403, message: 'Resource not accessible by integration' };
    expect(await catchUp()).toBe('failed');
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringContaining('could not move a deferred CodeQL default setup'),
      expect.objectContaining({ org: ORG, repo: 'motir-ai' }),
    );
  });
  // ── MOTIR-12034 · one move per repository, across processes ──────────────

  it('makes exactly ONE move when ten boots of one repository race on separate instances', async () => {
    await storePair(true);
    readDelayMs = 300;
    const instances = await separateInstances(10);
    const outcomes = await Promise.all(instances.map((via) => catchUp(undefined, { via })));
    expect(patches()).toEqual(['PATCH /repos/Acme-Connected/motir-ai/code-scanning/default-setup']);
    expect(outcomes.filter((o) => o === 'moved')).toHaveLength(1);
    // Every other boot skipped: the move was in flight, or had just landed.
    expect(
      outcomes.every((o) => ['moved', 'move_in_flight', 'recently_on_fleet'].includes(o)),
    ).toBe(true);
    expect(setup()).toEqual(ON_FLEET);
  });

  it('sends nothing to GitHub from another instance within the recheck window after a move lands', async () => {
    await storePair(true);
    const [first, second] = await separateInstances(2);
    const t0 = 5_000_000;
    expect(await catchUp(t0, { via: first })).toBe('moved');
    // GitHub's read can lag a PATCH it accepted with a 202; the store, not a
    // fresh read, is what must stop the next boot.
    setups['motir-ai'] = { ...STANDARD };
    calls = [];
    expect(await catchUp(t0 + ON_FLEET_RECHECK_MS - 1, { via: second })).toBe('recently_on_fleet');
    expect(calls).toEqual([]);
    // Past the window the setup is read again, and moved again if it is off.
    expect(await catchUp(t0 + ON_FLEET_RECHECK_MS, { via: second })).toBe('moved');
  });

  it('gives each repository its own move', async () => {
    await storePair(true);
    setups['motir-gateway'] = { ...STANDARD };
    const [a, b] = await separateInstances(2);
    const outcomes = await Promise.all([
      catchUp(undefined, { via: a }),
      catchUp(undefined, { via: b, repo: 'motir-gateway' }),
    ]);
    expect(outcomes).toEqual(['moved', 'moved']);
    expect(patches().sort()).toEqual([
      'PATCH /repos/Acme-Connected/motir-ai/code-scanning/default-setup',
      'PATCH /repos/Acme-Connected/motir-gateway/code-scanning/default-setup',
    ]);
  });

  it('skips while another boot holds the move, and takes it back once a dead holder’s lease runs out', async () => {
    await storePair(true);
    const t0 = 9_000_000;
    const taken = await withSystemContext((tx) =>
      fleetCodeScanningMoveRepository.tryClaimInTx(
        {
          org: ORG,
          repo: 'motir-ai',
          holder: 'a-boot-that-died',
          now: new Date(t0),
          heldUntil: new Date(t0 + MOVE_LEASE_MS),
        },
        tx,
      ),
    );
    expect(taken).toBe(true);
    expect(await catchUp(t0 + MOVE_LEASE_MS - 1)).toBe('move_in_flight');
    expect(calls).toEqual([]);
    expect(await catchUp(t0 + MOVE_LEASE_MS)).toBe('moved');
  });

  it('holds the move for the cooldown after a refused PATCH, so the rest of the burst sends none', async () => {
    await storePair(true);
    // GitHub refuses a move while an analysis of the repository runs.
    patchAnswer = { status: 409, message: 'A code scanning analysis is in progress' };
    const t0 = 12_000_000;
    expect(await catchUp(t0)).toBe('failed');
    expect(patches()).toHaveLength(1);
    patchAnswer = null;
    calls = [];
    expect(await catchUp(t0 + FAILED_MOVE_COOLDOWN_MS - 1)).toBe('move_in_flight');
    expect(calls).toEqual([]);
    expect(await catchUp(t0 + FAILED_MOVE_COOLDOWN_MS)).toBe('moved');
  });

  it('gives the claim back at once when the move failed before any PATCH was sent', async () => {
    await storePair(true);
    const t0 = 15_000_000;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const get = vi
      .spyOn(codeScanningDefaultSetupClient, 'get')
      .mockRejectedValueOnce(new Error('default-setup read failed'));
    expect(await catchUp(t0)).toBe('failed');
    expect(patches()).toEqual([]);
    get.mockRestore();
    expect(await catchUp(t0 + 1)).toBe('moved');
  });

  it('answers failed, never throwing, when the claim store cannot be reached', async () => {
    await storePair(true);
    vi.spyOn(fleetCodeScanningMoveRepository, 'tryClaimInTx').mockRejectedValue(
      new Error('connection refused'),
    );
    expect(await catchUp()).toBe('failed');
    expect(patches()).toEqual([]);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringContaining('could not move a deferred CodeQL default setup'),
      expect.objectContaining({ detail: 'connection refused' }),
    );
  });

  it('still answers the move when the claim cannot be given back, logging it', async () => {
    await storePair(true);
    vi.spyOn(fleetCodeScanningMoveRepository, 'settleInTx').mockRejectedValue(
      new Error('connection reset'),
    );
    expect(await catchUp()).toBe('moved');
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringContaining('could not move a deferred CodeQL default setup'),
      expect.objectContaining({ detail: 'connection reset' }),
    );
  });
});
