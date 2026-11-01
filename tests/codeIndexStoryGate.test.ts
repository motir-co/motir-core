import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from './fixtures/workItemFixtures';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import { deriveCodeGraphIndexState } from '@/lib/codeGraph/indexState';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE STORY'S motir-core GATE (Story MOTIR-1754 · MOTIR-1770).
//
// It runs after the story's motir-core subtasks are on the branch, so it
// measures their real, composed surface rather than each piece in isolation.
//
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ TWO OF THIS CARD'S ENUMERATED ITEMS NAME MECHANISMS THAT NO LONGER EXIST,
// and they are recorded here rather than quietly skipped.
//
//  1. **"The ai→core status seam"** — *"drive the code-context service against a
//     stubbed motir-ai status response shaped exactly as the producer route
//     returns it"*. THERE IS NO SUCH RESPONSE. MOTIR-4724 moved every freshness
//     fact into motir-core's own columns and MOTIR-1765's `GET
//     /v1/code-graph/status` was archived; `resolvePlanningCodeContext`'s own
//     header records the consequence — *"the read cannot fail to answer — the
//     branch is not unreachable, it is inexpressible"*. A test that stubbed that
//     boundary would be asserting a key-name agreement between one repository
//     and nobody.
//
//  2. **"a connected repo with a NULL `lastPushSha` resolves to `current`"** —
//     the column is `defaultBranchHeadSha`, and the state is `indexed`, not
//     `current`. The RULE the item is about is exactly right and is the most
//     load-bearing thing in this file, so it survives under its real names
//     (§ *the one wrong default*). Only the vocabulary was stale, and MOTIR-4817
//     is why: `Current` claimed a currency the state cannot support.
//
// Everything else the card asks for is asserted below.
// ═══════════════════════════════════════════════════════════════════════════

let fx: WorkItemFixture;
let orgId: string;
let installationRowId: string;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  orgId = fx.workspace.organizationId;
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  installationRowId = installation.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedRepo(opts: { indexedHeadSha?: string | null; headSha?: string | null } = {}) {
  return adminDb.githubRepo.create({
    data: {
      installationId: installationRowId,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      repoId: 'host-web',
      owner: 'moooon',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
      archived: false,
      indexedHeadSha: opts.indexedHeadSha ?? null,
      defaultBranchHeadSha: opts.headSha ?? null,
    },
  });
}

async function linkIntoProject(githubRepoId: string) {
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'web' },
    fx.ctx,
  );
  await adminDb.projectRepo.update({ where: { id: row.id }, data: { githubRepoId } });
}

async function seedSucceededIndex() {
  await adminDb.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'code-graph/index.requested',
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      lane: 'inngest',
      attempt: 1,
      status: 'succeeded',
      output: { repoRef: 'moooon/web' },
    },
  });
  // …and the settle's stamp on the repository row, which is what every index
  // state reads (`hasBuiltGraph`, Bug MOTIR-10171): a real success writes both.
  const [owner, name] = 'moooon/web'.split('/');
  await adminDb.githubRepo.updateMany({
    where: { owner, name, indexedAt: null },
    data: { indexedAt: new Date() },
  });
}

const CTX = () => ({ userId: fx.ownerId, workspaceId: fx.workspaceId });
const readRow = async () => (await resolveCodeContextState(fx.projectId, CTX())).repos[0];

// ───────────────────────────────────────────────────────────────────────────
describe('⚠️ THE ONE WRONG DEFAULT — a missing comparand is NOT drift', () => {
  // The card gives this its own named guard rather than leaving it to coverage,
  // and it is right to: getting it backwards shows a false warning to every
  // pre-existing user at once, on the surface whose entire value is being
  // believed.

  it('a repository with NO head sha reads `indexed`, never `stale`', async () => {
    // `defaultBranchHeadSha` is written by the push webhook and by NOTHING else,
    // so a connected repository nobody has pushed to never acquires one.
    // Treating an absent comparand as a difference flips the whole estate to
    // `stale` on deploy.
    const repo = await seedRepo({ indexedHeadSha: 'base1', headSha: null });
    await linkIntoProject(repo.id);
    await seedSucceededIndex();

    expect((await readRow())?.indexState).toBe('indexed');
  });

  it('and neither known sha is enough on its own', async () => {
    const repo = await seedRepo({ indexedHeadSha: null, headSha: 'head9' });
    await linkIntoProject(repo.id);
    await seedSucceededIndex();

    expect((await readRow())?.indexState).toBe('indexed');
  });

  it('⚠️ `never` is about the LEDGER, not about the shas', async () => {
    // The distinction the card asks for under its old name. A repository with no
    // succeeded index has no graph at all; one with a graph and no comparison is
    // `indexed`. Conflating them would tell somebody to connect a repository
    // that is already connected.
    const repo = await seedRepo({ indexedHeadSha: 'base1', headSha: 'head9' });
    await linkIntoProject(repo.id);

    expect((await readRow())?.indexState).toBe('never');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('PUSH → HEAD → VERDICT, end to end — the story’s core behaviour', () => {
  // It spans the push writer, the column and the derivation, and no unit test
  // sees the whole of it.

  it('a push past the indexed commit flips the repository to `stale`', async () => {
    const repo = await seedRepo({ indexedHeadSha: 'base1', headSha: 'base1' });
    await linkIntoProject(repo.id);
    await seedSucceededIndex();
    expect((await readRow())?.indexState).toBe('indexed');

    // The push writer's own effect, through its repository method — the one
    // writer of this column.
    //
    // ⚠️ BOUND, and asserted on the COUNT. `db.$transaction` alone is UNBOUND:
    // `github_repo`'s RLS policy sees no workspace, `updateMany` matches zero
    // rows, and the method returns `0` while the test reads on and blames the
    // derivation. The webhook itself writes under `withSystemContext` — the
    // trusted-writer escape — which is what this mirrors.
    const written = await withSystemContext((tx) =>
      githubRepoRepository.setDefaultBranchHeadSha(repo.id, 'head2', tx),
    );
    expect(written, 'the head write must actually land').toBe(1);

    expect((await readRow())?.indexState).toBe('stale');
  });

  it('and the index catching up returns it to `indexed`', async () => {
    // The other half, and the reason it matters is MOTIR-4817's: a warning that
    // never visibly clears teaches people to ignore it.
    const repo = await seedRepo({ indexedHeadSha: 'base1', headSha: 'head2' });
    await linkIntoProject(repo.id);
    await seedSucceededIndex();
    expect((await readRow())?.indexState).toBe('stale');

    await adminDb.githubRepo.update({
      where: { id: repo.id },
      data: { indexedHeadSha: 'head2' },
    });

    expect((await readRow())?.indexState).toBe('indexed');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('`hasImplementedWork` — PROVENANCE, not doneness', () => {
  it('is false for a project whose items were never implemented through Motir', async () => {
    expect((await resolveCodeContextState(fx.projectId, CTX())).hasImplementedWork).toBe(false);
  });

  it('⚠️ stays FALSE for a project full of `done` items with null provenance', async () => {
    // The guard the card names explicitly, and the reason it exists: a migrated
    // tracker is full of done items implemented by nobody through Motir. Reading
    // doneness would nag every one of those projects to connect a repository on
    // the strength of work Motir never touched.
    for (const title of ['Shipped in 2019', 'Shipped in 2020', 'Shipped in 2021']) {
      const item = await createTestWorkItem(fx, { kind: 'task', title });
      // `WorkItem.status` is the workflow status KEY, a plain string column.
      await adminDb.workItem.update({
        where: { id: item.id },
        data: { status: 'done', implementationSource: null },
      });
    }

    expect((await resolveCodeContextState(fx.projectId, CTX())).hasImplementedWork).toBe(false);
  });

  it('is true once ONE item carries an implementation source', async () => {
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Built with an agent' });
    // ⚠️ `byok` — an agent on the user's OWN machine, which is the loop this
    // whole story closes. It is the provenance, not the status, that says Motir
    // was involved.
    await adminDb.workItem.update({
      where: { id: item.id },
      data: { implementationSource: 'byok' },
    });

    expect((await resolveCodeContextState(fx.projectId, CTX())).hasImplementedWork).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('⚠️ CONTRACT GUARDS — what no amount of coverage would catch', () => {
  const read = (p: string) => readFileSync(p, 'utf8');

  it('the verdict is TOTAL over four states, with no default arm', () => {
    // A default arm is where a fifth state would go to die: it would render as
    // whichever branch happened to be last, silently, on every surface at once.
    const src = read('lib/codeGraph/indexState.ts');
    for (const state of ['never', 'indexing', 'indexed', 'stale']) {
      expect(src, state).toContain(`'${state}'`);
    }
    // And the derivation is exercised over its whole input space rather than
    // asserted to be total by reading it.
    const seen = new Set<string>();
    for (const hasSucceededIndex of [true, false])
      for (const hasRunningIndex of [true, false])
        for (const indexedHeadSha of [null, 'a', 'b'])
          for (const defaultBranchHeadSha of [null, 'a', 'b'])
            seen.add(
              deriveCodeGraphIndexState({
                hasSucceededIndex,
                hasRunningIndex,
                indexedHeadSha,
                defaultBranchHeadSha,
              }),
            );
    expect([...seen].sort()).toEqual(['indexed', 'indexing', 'never', 'stale']);
  });

  it('⚠️ the UI’s verdict mapping is total too — every state draws a chip', () => {
    // The other half: a state the derivation can produce and the surface cannot
    // draw renders as nothing at all, which reads as "no problem".
    const row = read('app/(authed)/code/_components/CodeRepositories.tsx');
    for (const label of ['indexing', 'stale', 'indexed', 'never']) {
      expect(row, label).toContain(`labels.${label}`);
    }
  });

  it('⚠️ NO CLIENT COMPONENT reaches the code-context service', () => {
    // It opens a `withWorkspaceContext` transaction; a `'use client'` module
    // importing it would be a build-time error at best and a bundled server
    // secret at worst. Asserted over the whole tree rather than over the files
    // this story happened to touch.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.next') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(tsx?|jsx?)$/.test(name)) continue;
        const src = readFileSync(full, 'utf8');
        if (!src.includes("'use client'") && !src.includes('"use client"')) continue;
        if (/from '@\/lib\/services\/codeContextService'/.test(src)) offenders.push(full);
      }
    };
    for (const root of ['app', 'components']) walk(root);
    expect(offenders).toEqual([]);
  });

  it('the webhook RESULT UNION still carries its prior arms', () => {
    // The head-recording change writes inside the push arm; it must not have
    // altered what the webhook reports, because callers switch on these.
    const src = read('lib/services/githubWebhookService.ts');
    for (const arm of [
      "'ignored'",
      "'installation'",
      "'synced'",
      "'removed'",
      "'skipped_unbound'",
      "'skipped_shared_installation'",
      "'malformed'",
    ]) {
      expect(src, arm).toContain(arm);
    }
  });

  it('⚠️ every message key this story added has a `zh` twin', () => {
    // The catalogue test enforces parity in general; this CONFIRMS it covers the
    // story's own keys rather than assuming, which is what the card asks for.
    const en = JSON.parse(read('messages/en.json')) as Record<string, unknown>;
    const zh = JSON.parse(read('messages/zh.json')) as Record<string, unknown>;
    const flat = (o: unknown, p = ''): string[] =>
      o && typeof o === 'object' && !Array.isArray(o)
        ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
            flat(v, p ? `${p}.${k}` : k),
          )
        : [p];
    const enKeys = flat(en).filter((k) => k.startsWith('code.') || k === 'shell.nav.code');
    expect(enKeys.length).toBeGreaterThan(10);
    const zhKeys = new Set(flat(zh));
    expect(enKeys.filter((k) => !zhKeys.has(k))).toEqual([]);
  });

  it('⚠️ the ONE derivation stayed one — no surface re-derives staleness', () => {
    // The guard MOTIR-4724 established, re-asserted over what THIS story added:
    // a comparison written in a component or a service would be a second
    // definition of "still current", and the two would drift.
    for (const f of [
      'app/(authed)/code/_components/CodeRepositories.tsx',
      'app/(authed)/code/page.tsx',
      'lib/ai/codeContext.ts',
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(/indexedHeadSha\s*!==\s*.*defaultBranchHeadSha/);
    }
  });
});
