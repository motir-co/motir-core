import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine } from '../helpers/jobs';
import { fleetCodeGraphRefresh as codeGraphRefresh } from '../helpers/fleetIndexJobs';
import {
  codeGraphIndexService,
  isUsableAnchorProjectId,
  requireCurrentIndexTarget,
  StaleIndexTargetMemoError,
} from '@/lib/services/codeGraphIndexService';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { fakeOrchestrator } from '@motir/orchestrator';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  containerExitsWith,
  driveIndexFleetFast,
  indexStepIds,
  refreshEventFor,
  resetTarballBodyTrap,
  seedIndexWorkspace,
  stubIndexFleet,
} from '../helpers/indexFleet';

// THE ANCHOR PROJECT ID, AND THE TWO PLACES IT CAN GO MISSING (MOTIR-5020).
//
// Production: every `system.code-graph-refresh` boot failed with
// `MotirAiBadRequestError: 'coreProjectId' must be a non-empty string`, thrown
// out of `mintCodeGraphRunCredential` — the FIRST outbound call of a dispatch,
// so nothing was provisioned and nothing was billed, and nothing was indexed
// either.
//
// ⚠️ THE MESSAGE IS THE SAME FOR AN ABSENT FIELD AND AN EMPTY ONE, WHICH IS WHY
// THE CARD COULD NOT TELL THEM APART. motir-ai's `requireString`
// (`src/app.ts`) tests `typeof v !== 'string' || v === ''`, and `JSON.stringify`
// DROPS an `undefined` property from the request body — so `undefined` arrives
// as *absent* and reads back identically to `''`.
//
// The two producers are NOT the same defect and only one of them is real:
//
//  1. `''` — needs `projects[0].id` to be the empty string. The old guard
//     (`resolved.anchorProjectId === null`) could not see it. Guarded now by
//     `isUsableAnchorProjectId`, and exercised below through the shipped
//     resolver.
//  2. `undefined` — CANNOT come out of `resolveIndexTarget` at all:
//     `projects[0]?.id ?? null` coalesces `undefined` to `null`, so the old
//     guard did catch that arm. It comes out of a REPLAYED `resolve-target`
//     MEMO written before MOTIR-4652 changed the result's shape, which is a
//     value the guard never sees because a replay does not execute the step.
//     That is the outage, and it is guarded at the step boundary instead.

/** The pre-MOTIR-4652 `resolve-target` result, verbatim: `projectIds`, no anchor. */
function preFanOutRetiredMemo(repoRef: string, organizationId: string, projectIds: string[]) {
  return {
    indexed: true as const,
    repoRef,
    providerId: 'github' as const,
    organizationId,
    projectIds,
  };
}

async function organizationOf(workspaceId: string): Promise<string> {
  const row = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { organizationId: true },
  });
  return row.organizationId;
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await adminDb.fleetInFlightSlot.deleteMany({});
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  resetTarballBodyTrap();
  stubIndexFleet();
  driveIndexFleetFast();
  containerExitsWith(0);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

describe("the anchor's guard is the CONSUMER's predicate, not `=== null`", () => {
  it('accepts a real id and refuses `null`, `undefined` and the empty string alike', () => {
    // The unit the two call sites share. Written as its own assertion because
    // the failure it prevents is a guard that enumerates the bad values its
    // author happened to think of.
    expect(isUsableAnchorProjectId('cmqfb4d8q000e2d0i6n62otyc')).toBe(true);
    expect(isUsableAnchorProjectId(null)).toBe(false);
    expect(isUsableAnchorProjectId(undefined)).toBe(false);
    expect(isUsableAnchorProjectId('')).toBe(false);
  });

  it('an anchor of `""` returns `no_projects` — the arm the strict-`null` guard reported SAFE', async () => {
    const seeded = await seedIndexWorkspace('anchorempty', 1);

    // Drive the shipped resolver, with only the one read forced to the shape
    // that defeated the old guard. `projects[0]?.id ?? null` is `''` here, which
    // is neither `null` nor a usable id — the old test passed it straight
    // through to the mint.
    vi.spyOn(projectRepository, 'findByWorkspace').mockResolvedValue([
      { id: '' },
    ] as unknown as Awaited<ReturnType<typeof projectRepository.findByWorkspace>>);

    const target = await codeGraphIndexService.resolveIndexTarget({
      installationId: seeded.installationId,
      workspaceId: seeded.workspaceId,
      repoOwner: 'moooon',
      repoName: 'motir-core',
      defaultBranch: 'main',
    });

    expect(target).toEqual({ indexed: false, reason: 'no_projects' });
  });

  it('an `""` anchor NEVER REACHES the credential mint — the whole point of skipping', async () => {
    // `no_projects` is a verdict about the run, and the run is only actually
    // cheap if it stops before the first outbound call. Asserted on the boot,
    // which is what mints.
    const seeded = await seedIndexWorkspace('anchoremptyboot', 1);
    vi.spyOn(projectRepository, 'findByWorkspace').mockResolvedValue([
      { id: '' },
    ] as unknown as Awaited<ReturnType<typeof projectRepository.findByWorkspace>>);
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const engine = new JobTestEngine({ function: codeGraphRefresh });
    const { result } = await engine.execute({
      events: [
        refreshEventFor({
          installationId: seeded.installationId,
          workspaceId: seeded.workspaceId,
        }),
      ],
    });

    expect(result).toEqual({ indexed: false, reason: 'no_projects' });
    expect(boot).not.toHaveBeenCalled();
    expect(fakeOrchestrator.provisioned).toEqual([]);
  }, 30_000);
});

describe('a `resolve-target` memo from BEFORE the shape change (the production outage)', () => {
  it('`requireCurrentIndexTarget` refuses the pre-MOTIR-4652 shape, by name', () => {
    // The reproduction, at the boundary the value actually crosses. This object
    // is what `job_step` held for every run that started before `83c0e8a34`:
    // `indexed: true`, so the `!target.indexed` early return does not fire, and
    // no `anchorProjectId` at all.
    const memo = preFanOutRetiredMemo('moooon/motir-core', 'org_1', ['proj_1', 'proj_2']);

    expect(() => requireCurrentIndexTarget(memo)).toThrow(StaleIndexTargetMemoError);
    // It NAMES the field and the value, because the failure it replaces named
    // neither — `'coreProjectId' must be a non-empty string`, raised in another
    // repository, about a field this repository never mentions.
    expect(() => requireCurrentIndexTarget(memo)).toThrow(/anchorProjectId.*undefined/);
  });

  it('a CURRENT target passes through untouched', () => {
    const target = {
      indexed: true as const,
      repoRef: 'moooon/motir-core',
      providerId: 'github' as const,
      organizationId: 'org_1',
      anchorProjectId: 'proj_1',
    };
    expect(requireCurrentIndexTarget(target)).toBe(target);
    // And so does every skip verdict — those carry no anchor by construction and
    // must keep reaching the ledger (`resolveIndexTarget`'s no-op contract).
    const skip = { indexed: false as const, reason: 'no_projects' as const };
    expect(requireCurrentIndexTarget(skip)).toBe(skip);
  });

  it('the stale memo is not read at all — the step id carries the shape', async () => {
    // ⚠️ THE FIX THAT ENDS THE OUTAGE, and it is the step ID rather than the
    // guard. A memo is keyed `(run_id, step_id)`, so bumping the id makes the
    // pre-`83c0e8a34` row unreadable: the run re-executes `resolveIndexTarget`
    // — DB reads only, nothing provisioned twice — and gets a target of the
    // current shape.
    //
    // Seeded under the OLD id, exactly as a resumed production run carried it.
    const seeded = await seedIndexWorkspace('anchorstalememo', 2);
    const organizationId = await organizationOf(seeded.workspaceId);
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');

    const engine = new JobTestEngine({ function: codeGraphRefresh });
    const { ctx, result, error } = await engine.execute({
      events: [
        refreshEventFor({
          installationId: seeded.installationId,
          workspaceId: seeded.workspaceId,
        }),
      ],
      steps: [
        {
          id: 'resolve-target',
          handler: () =>
            // ⚠️ A DISTINCTIVE `repoRef`, so "the memo went unread" is asserted
            // rather than assumed. Absence from `ctx.step.run.mock.calls` would
            // prove nothing — a seeded id that is never called never appears
            // there either. This value can only reach the ledger by way of the
            // memo, so the run's own `repoRef` is the discriminator.
            preFanOutRetiredMemo('stale-memo/never-read', organizationId, seeded.projectIds),
        },
      ],
    });

    expect(error).toBeUndefined();
    // The old id was never consulted; the versioned one was.
    expect(indexStepIds(ctx)).toContain('resolve-target-v2');
    // Re-resolved from the live tenant, not replayed.
    expect(result).toMatchObject({ indexed: true, repoRef: 'moooon/motir-core' });
    // And the boot carries a real project id rather than `undefined`.
    const projectId = boot.mock.calls[0]?.[0]?.projectId;
    expect(isUsableAnchorProjectId(projectId)).toBe(true);
    expect(seeded.projectIds).toContain(projectId);
  }, 30_000);
});

describe('the path that produced the eight failures, end to end', () => {
  it('a refresh for `moooon/motir-core` reaches the mint with a non-empty `coreProjectId`', async () => {
    // Criterion 3 — read off the WIRE, not off the call. The failing runs died
    // inside `mintCodeGraphRunCredential`, so the assertion that answers the
    // outage is about the body that leaves this process for
    // `POST /v1/code-graph/run-credential`.
    const seeded = await seedIndexWorkspace('anchore2e', 2);

    const engine = new JobTestEngine({ function: codeGraphRefresh });
    const { result, error } = await engine.execute({
      events: [
        refreshEventFor({
          installationId: seeded.installationId,
          workspaceId: seeded.workspaceId,
        }),
      ],
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ indexed: true, repoRef: 'moooon/motir-core' });

    const mintCall = (
      global.fetch as unknown as { mock: { calls: [string, RequestInit?][] } }
    ).mock.calls.find(([url]) =>
      new URL(String(url)).pathname.endsWith('/v1/code-graph/run-credential'),
    );
    expect(mintCall).toBeDefined();

    const body = JSON.parse(String(mintCall?.[1]?.body)) as Record<string, unknown>;
    // ⚠️ ASSERTED WITH motir-ai's OWN PREDICATE, transcribed. A test that only
    // checked `body.coreProjectId !== undefined` would pass on `''`, which the
    // consumer refuses in exactly the same words — and `JSON.stringify` having
    // dropped the key is precisely how the production body reached it.
    expect(Object.hasOwn(body, 'coreProjectId')).toBe(true);
    expect(isUsableAnchorProjectId(body.coreProjectId)).toBe(true);
    expect(seeded.projectIds).toContain(body.coreProjectId);
  }, 30_000);
});
