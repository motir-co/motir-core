import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  DEFAULT_STATUSES,
  DEFAULT_STATUS_KEYS,
  DEFAULT_TRANSITIONS,
} from '@/lib/workflows/defaultWorkflow';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-3008 — THE GUARANTEES A COVERAGE PERCENTAGE CANNOT SEE.
//
// Each of these fails on a change that every unit suite would still pass, which
// is the only reason to write them:
//
//  • a status nobody can reach, or nobody can leave
//  • a SECOND hand-maintained status list, drifting from the first
//  • the seed and the backfill migration disagreeing — the drift that surfaces
//    months later, on one tenant, as "why does that project look different?"
//  • a raw status write on a delivery path, which moves a card with no revision
//
// The third is the one this story most needed: it ships a status through TWO
// paths (a constant for new projects, SQL for existing ones), and nothing else
// compares their outputs.

const ROOT = process.cwd();
const PASSWORD = 'hunter2hunter2';

/** The terminal statuses — the two a card is allowed to sit in forever. */
const TERMINAL = new Set(['done', 'cancelled']);

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('transition totality — no status is a dead end, and none is unreachable', () => {
  const into = new Set(DEFAULT_TRANSITIONS.map(([, to]) => to));
  const outOf = new Set(DEFAULT_TRANSITIONS.map(([from]) => from));

  it('every non-initial status has at least one edge INTO it', () => {
    const unreachable = DEFAULT_STATUSES.filter((s) => !s.isInitial && !into.has(s.key)).map(
      (s) => s.key,
    );
    expect(unreachable).toEqual([]);
  });

  it('every status has at least one edge OUT of it, terminal ones included', () => {
    // Even the terminal statuses are escapable here — `done → in_progress` and
    // `cancelled → todo` are the reopen edges, and a workflow where a mistake is
    // unrecoverable is worse than one where it is.
    const trapped = DEFAULT_STATUSES.filter((s) => !outOf.has(s.key)).map((s) => s.key);
    expect(trapped).toEqual([]);
  });

  it('every edge names a status the workflow actually has', () => {
    const keys = new Set(DEFAULT_STATUSES.map((s) => s.key));
    for (const [from, to] of DEFAULT_TRANSITIONS) {
      expect(keys.has(from), `${from} → ${to}: unknown FROM`).toBe(true);
      expect(keys.has(to), `${from} → ${to}: unknown TO`).toBe(true);
    }
  });

  it('the lifecycle path a run actually walks is legal end to end', () => {
    // The claim `docs/cli.md` and the runbook both make, asserted rather than
    // described: every hop of the documented path exists as an edge.
    const edge = (from: string, to: string) =>
      DEFAULT_TRANSITIONS.some(([f, t]) => f === from && t === to);
    expect(edge('todo', 'in_progress')).toBe(true);
    expect(edge('in_progress', 'implemented')).toBe(true);
    expect(edge('implemented', 'in_review')).toBe(true);
    expect(edge('in_review', 'done')).toBe(true);
    // …and the two recoveries that keep a red build from stranding a card.
    expect(edge('implemented', 'in_progress')).toBe(true);
    expect(edge('implemented', 'done')).toBe(true);
    // NOT the shortcut: In Review is CI's to write, so nothing may jump there
    // from where an unfinished run leaves a card.
    expect(edge('in_progress', 'in_review')).toBe(true); // the pre-existing manual path
    // A pull request delivering a card nobody moved records it built (MOTIR-12202);
    // that is the link's move, not a run's shortcut past In Progress.
    expect(edge('todo', 'implemented')).toBe(true);
    expect(edge('todo', 'done')).toBe(false);
    expect(TERMINAL.has('done') && TERMINAL.has('cancelled')).toBe(true);
  });
});

describe('the constants have ONE home', () => {
  it('`DEFAULT_STATUS_KEYS` is exactly `DEFAULT_STATUSES`, in the same order', () => {
    expect([...DEFAULT_STATUS_KEYS]).toEqual(DEFAULT_STATUSES.map((s) => s.key));
  });

  it('no OTHER file hand-maintains the status list', () => {
    // A second list is how a status gets added in one place and forgotten in the
    // other. The scan looks for any source file that names EVERY default status
    // key — which is what a duplicated list looks like and what a targeted
    // consumer (a map of two, a switch on three) does not.
    const keys = DEFAULT_STATUSES.map((s) => s.key);
    const offenders: string[] = [];
    for (const file of sourceFiles(['lib', 'app', 'components', 'packages/cli/src'])) {
      if (file.endsWith('lib/workflows/defaultWorkflow.ts')) continue; // the one home
      const text = readFileSync(join(ROOT, file), 'utf8');
      if (keys.every((key) => text.includes(`'${key}'`))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the seed and the backfill migration AGREE', () => {
  /** The three things a project's workflow IS, in a comparable shape. */
  async function shapeOf(projectId: string) {
    const statuses = await adminDb.workflowStatus.findMany({
      where: { projectId },
      orderBy: { position: 'asc' },
    });
    const transitions = await adminDb.workflowTransition.findMany({
      where: { projectId },
      include: { fromStatus: true, toStatus: true },
    });
    const columns = await adminDb.boardColumn.findMany({
      where: { projectId },
      orderBy: { position: 'asc' },
      include: { statusMappings: { include: { status: true } } },
    });
    return {
      statuses: statuses.map((s) => `${s.key}:${s.category}:${s.isInitial}`),
      edges: transitions.map((t) => `${t.fromStatus.key}→${t.toStatus.key}`).sort(),
      columns: columns.map(
        (c) => `${c.name}=${c.statusMappings.map((m) => m.status.key).join(',')}`,
      ),
    };
  }

  it('a BACKFILLED project ends identical to a freshly SEEDED one', async () => {
    // The comparison is the test. Reading either one and asserting what it
    // "should" contain is how the two drifted in the first place.
    const user = await usersService.createUser({
      email: 'agreement@example.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: user.id,
    });
    const fresh = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Fresh',
      identifier: 'FRESH',
    });
    const backfilled = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Backfilled',
      identifier: 'BACK',
    });

    // Reproduce the pre-migration shape on ONE of them, then run the real
    // migration file exactly as `migrate deploy` runs it.
    await adminDb.$executeRawUnsafe(
      `DELETE FROM board_column WHERE project_id = $1 AND name = 'Implemented'`,
      backfilled.id,
    );
    await adminDb.$executeRawUnsafe(
      `DELETE FROM workflow_status WHERE project_id = $1 AND key = 'implemented'`,
      backfilled.id,
    );
    // Every migration that writes an edge touching `implemented`, in the order
    // `migrate deploy` applies them: deleting the status also cascades
    // MOTIR-5630's ejection edges (`approved → implemented`,
    // `in_review → implemented`, `implemented → approved`), which only its own
    // backfill restores — and MOTIR-5804's then removes `implemented → approved`
    // again. The CHAIN is what must agree with the seed.
    for (const migration of [
      '20260819090000_add_implemented_default_status',
      '20260916180000_add_queue_ejection_default_edges',
      // MOTIR-5804 REMOVES `implemented → approved`, which 5630's backfill
      // above just re-added; without it the backfilled project keeps an edge the
      // seed no longer has. ORDER is `migrate deploy`'s — by timestamp.
      '20260919200000_reask_ejection_default_edges',
      // MOTIR-5643's parking edges include `implemented → planning`, which the
      // status deletion above cascades away and only this backfill restores. Its
      // presence in the CHAIN is what proves that backfill complete.
      '20260920090000_add_planning_parking_edges',
      // MOTIR-12202's `todo → implemented` is cascaded away with the status too,
      // and only its own backfill restores it.
      '20261125000000_add_todo_delivery_default_edges',
    ]) {
      await adminDb.$executeRawUnsafe(
        readFileSync(join(ROOT, `prisma/migrations/${migration}/migration.sql`), 'utf8'),
      );
    }

    const [a, b] = await Promise.all([shapeOf(fresh.id), shapeOf(backfilled.id)]);
    expect(b.statuses).toEqual(a.statuses);
    expect(b.edges).toEqual(a.edges);
    expect(b.columns).toEqual(a.columns);
  });
});

describe('no raw status write on a delivery path', () => {
  it('every status move a webhook makes goes through the service', () => {
    // A raw `workItemRepository.update({ status })` or a `$executeRaw` on one of
    // these paths would move a card with NO revision — invisible in the activity
    // feed, and unattributable afterwards. The rule is that these files reach
    // the status only through `workItemsService`.
    const paths = [
      'lib/services/changeRequestStatusSync.ts',
      'lib/services/changeRequestCiFeedback.ts',
      'lib/services/ciPromotion.ts',
    ];
    for (const path of paths) {
      const text = readFileSync(join(ROOT, path), 'utf8');
      const code = text
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
      expect(code, `${path}: raw status write`).not.toMatch(/workItemRepository\.update\(/);
      expect(code, `${path}: raw SQL`).not.toMatch(/\$executeRaw|\$queryRaw/);
      expect(code, `${path}: writes status directly`).not.toMatch(/\bstatus:\s*(?:'|")/);
    }
  });
});

/** Every `.ts`/`.tsx` under the given roots, as repo-relative POSIX paths. */
function sourceFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry)) out.push(relative(ROOT, path).split(sep).join('/'));
    }
  };
  for (const root of roots) walk(join(ROOT, root));
  return out;
}
