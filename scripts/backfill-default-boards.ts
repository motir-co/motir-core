/**
 * `pnpm db:backfill:boards` — backfill the default Kanban board (Subtask
 * 3.1.2) onto every project that predates Story 3.1 (a project with a workflow
 * but no board). One-off operator tooling: the seed reseeds the `moooon` tenant
 * wholesale, but real projects created before this Story have no board.
 *
 * IDEMPOTENT + SAFE TO RE-RUN: it walks every project and
 * `boardsService.backfillDefaultBoard` probes each one for a board under its own
 * workspace before seeding, so a project that has one is a no-op. (It used to
 * filter `boards: { none: {} }` up front, unbound — which found nothing at all
 * as the non-bypass application role a production run uses, MOTIR-10465.) Every project's board is
 * persisted through the shipped repositories under its workspace context (no
 * raw inserts) — the same path `createProject` uses.
 *
 * The per-project actor is the workspace OWNER (the creator tier — roles.ts),
 * falling back to any member: `withWorkspaceContext` binds that user's GUC so
 * the FORCE-RLS board writes pass under the non-bypass motir_app role. (Under
 * the dev/CI BYPASSRLS superuser the GUC is moot, but we bind a real member so
 * the path is production-correct.)
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
// Run through `scripts/data-script-main.ts` (MOTIR-10465): the entry loads `.env`,
// composes `DATABASE_URL` in a Fargate task, and ends the pool after `main` answers.
import { boardsService } from '@/lib/services/boardsService';

/** Seeds the default board on every board-less project; takes no arguments, answers 0. */
export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length > 0) throw new Error(`[backfill-boards] unknown argument: ${argv[0]}`);
  // Every project, read under the system context, and each one probed for its board
  // under its own workspace (`boardsService.listBoardBackfillCandidates`): the
  // application role a production run uses sees no row of either table unbound.
  const projects = await boardsService.listBoardBackfillCandidates();

  console.log(`[backfill-boards] ${projects.length} project(s) to consider.`);

  let created = 0;
  let skipped = 0;
  let unresolved = 0;

  for (const project of projects) {
    const actorUserId = await boardsService.resolveBoardBackfillActor(project.workspaceId);
    if (!actorUserId) {
      unresolved += 1;
      console.warn(
        `[backfill-boards] SKIP ${project.id} (${project.name}) — no workspace member to act as.`,
      );
      continue;
    }
    const didSeed = await boardsService.backfillDefaultBoard(project.id, actorUserId);
    if (didSeed) {
      created += 1;
      console.log(`[backfill-boards] seeded board for ${project.id} (${project.name}).`);
    } else {
      skipped += 1;
    }
  }

  console.log(
    `[backfill-boards] done — ${created} seeded, ${skipped} already had a board, ` +
      `${unresolved} unresolved.`,
  );
  return 0;
}
