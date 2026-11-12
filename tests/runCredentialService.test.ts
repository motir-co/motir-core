import { beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '@/lib/apiTokens/token';
import {
  DispatchRunNotFoundError,
  RunCredentialExpiryTooLateError,
  RunCredentialRunNotLiveError,
} from '@/lib/dispatchRuns/errors';
import { latestRunCredentialExpiry } from '@/lib/hostedRuns/limits';
import { CLI_TOKEN_GRANT, HOSTED_RUN_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { runCredentialService } from '@/lib/services/runCredentialService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// `runCredentialService` — mint and revoke of a hosted run's own Motir credential
// (MOTIR-688, `docs/decisions/hosted-agent-run.md` §3), against real Postgres.
// What the credential may REACH is proven at the doors, in
// `tests/api/v1/run-credential-routes.test.ts`; this file proves what is MINTED.

let fixture: WorkItemFixture;
let runId: string;

async function openRun(): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fixture.projectId, kind: 'task', title: 'a hosted card' },
    fixture.ctx,
  );
  const opened = await dispatchRunService.open(
    {
      projectKey: fixture.projectIdentifier,
      command: 'run',
      reportedBy: 'cli',
      origin: 'hosted',
      cards: [{ key: item.identifier, disposition: 'queued' }],
    },
    fixture.ctx,
  );
  return opened.run.id;
}

function inAnHour(): Date {
  return new Date(Date.now() + 60 * 60_000);
}

beforeEach(async () => {
  await truncateAuthTables();
  fixture = await makeWorkItemFixture();
  runId = await openRun();
});

describe('HOSTED_RUN_TOKEN_GRANT', () => {
  it('is exactly the three keys the run’s routes assert — no plan key, nothing past the CLI’s', () => {
    // `repository:manage` for the run's repository door (MOTIR-11055), in catalog order.
    expect([...HOSTED_RUN_TOKEN_GRANT]).toEqual([
      'project:browse',
      'work_item:edit',
      'repository:manage',
    ]);
    expect(HOSTED_RUN_TOKEN_GRANT.every((key) => CLI_TOKEN_GRANT.includes(key))).toBe(true);
    expect(HOSTED_RUN_TOKEN_GRANT.length).toBeLessThan(CLI_TOKEN_GRANT.length);
    expect(HOSTED_RUN_TOKEN_GRANT.some((key) => key.startsWith('ai:'))).toBe(false);
  });
});

describe('mintRunCredential', () => {
  it('AC 5 — returns the secret ONCE; the stored row holds only its hash', async () => {
    const minted = await runCredentialService.mintRunCredential({
      dispatchRunId: runId,
      dispatcherUserId: fixture.owner.id,
      expiresAt: inAnHour(),
    });

    const row = await adminDb.apiToken.findUniqueOrThrow({ where: { id: minted.tokenId } });
    expect(row.tokenHash).toBe(hashToken(minted.token));
    expect(Object.values(row)).not.toContain(minted.token);
    expect(minted.token.startsWith(row.tokenPrefix)).toBe(true);
    expect(row.tokenPrefix.length).toBeLessThan(minted.token.length);
  });

  it('binds the token to the run, its project and the dispatcher, with exactly the run grant', async () => {
    const minted = await runCredentialService.mintRunCredential({
      dispatchRunId: runId,
      dispatcherUserId: fixture.owner.id,
      expiresAt: inAnHour(),
    });

    const verified = await apiTokensService.verify(minted.token);
    expect(verified.user.id).toBe(fixture.owner.id);
    expect(verified.workspaceId).toBe(fixture.workspace.id);
    expect(verified.projectId).toBe(fixture.projectId);
    expect(verified.dispatchRunId).toBe(runId);
    expect([...verified.grant].sort()).toEqual([...HOSTED_RUN_TOKEN_GRANT].sort());
  });

  it('is not listed among the person’s own tokens — nothing to manage mid-run', async () => {
    await runCredentialService.mintRunCredential({
      dispatchRunId: runId,
      dispatcherUserId: fixture.owner.id,
      expiresAt: inAnHour(),
    });
    expect(await apiTokensService.listForUser(fixture.owner.id)).toEqual([]);
  });

  it('AC 4 — refuses an expiry later than the run’s timeout plus the settle margin', async () => {
    const now = new Date();
    const latest = latestRunCredentialExpiry(now);
    await expect(
      runCredentialService.mintRunCredential(
        {
          dispatchRunId: runId,
          dispatcherUserId: fixture.owner.id,
          expiresAt: new Date(latest.getTime() + 1),
        },
        now,
      ),
    ).rejects.toBeInstanceOf(RunCredentialExpiryTooLateError);
    // The bound itself is legal.
    await expect(
      runCredentialService.mintRunCredential(
        { dispatchRunId: runId, dispatcherUserId: fixture.owner.id, expiresAt: latest },
        now,
      ),
    ).resolves.toMatchObject({ expiresAt: latest });
  });

  it('AC 4 — refuses a run in a terminal status', async () => {
    await dispatchRunService.close(runId, { stopReason: 'completed' }, fixture.ctx);
    await expect(
      runCredentialService.mintRunCredential({
        dispatchRunId: runId,
        dispatcherUserId: fixture.owner.id,
        expiresAt: inAnHour(),
      }),
    ).rejects.toBeInstanceOf(RunCredentialRunNotLiveError);
    expect(await adminDb.apiToken.count({ where: { dispatchRunId: runId } })).toBe(0);
  });

  it('refuses a run that does not exist', async () => {
    await expect(
      runCredentialService.mintRunCredential({
        dispatchRunId: 'no-such-run',
        dispatcherUserId: fixture.owner.id,
        expiresAt: inAnHour(),
      }),
    ).rejects.toBeInstanceOf(DispatchRunNotFoundError);
  });
});

describe('revokeRunCredential', () => {
  it('deletes the run’s token, and a second call is a no-op', async () => {
    const minted = await runCredentialService.mintRunCredential({
      dispatchRunId: runId,
      dispatcherUserId: fixture.owner.id,
      expiresAt: inAnHour(),
    });

    expect(await runCredentialService.revokeRunCredential(runId)).toEqual({ revoked: 1 });
    expect(await adminDb.apiToken.findUnique({ where: { id: minted.tokenId } })).toBeNull();
    expect(await runCredentialService.revokeRunCredential(runId)).toEqual({ revoked: 0 });
  });

  it('touches no other token — not the dispatcher’s own, not another run’s', async () => {
    const otherRunId = await openRun();
    const other = await runCredentialService.mintRunCredential({
      dispatchRunId: otherRunId,
      dispatcherUserId: fixture.owner.id,
      expiresAt: inAnHour(),
    });
    const { dto: pat } = await apiTokensService.create(fixture.owner.id, fixture.workspace.id, {
      label: 'my own PAT',
      projectId: fixture.projectId,
    });

    await runCredentialService.mintRunCredential({
      dispatchRunId: runId,
      dispatcherUserId: fixture.owner.id,
      expiresAt: inAnHour(),
    });
    await runCredentialService.revokeRunCredential(runId);

    expect(await adminDb.apiToken.findUnique({ where: { id: other.tokenId } })).not.toBeNull();
    expect(await adminDb.apiToken.findUnique({ where: { id: pat.id } })).not.toBeNull();
  });
});
