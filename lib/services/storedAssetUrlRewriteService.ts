// The cutover's stored-reference rewrite (Story MOTIR-9712 · MOTIR-10075) — step 5
// of the AWS window.
//
// WHY. Since MOTIR-2404 `User.image` and `Project.image` store an object KEY, and
// `storedAssetUrl` resolves a key against `MOTIR_S3_PUBLIC_BASE_URL` while passing
// an ABSOLUTE value through unchanged. So a key follows the public base when the
// window moves the store to Amazon S3 — and a row written between MOTIR-2389 and
// MOTIR-2404, still holding an absolute URL on the previous store's public base,
// would keep pointing at that store and break once it is decommissioned. This
// sweep rewrites exactly those rows to their keys, so every public asset resolves
// against S3's public base.
//
// ⚠️ THE BASE IS AN ARGUMENT, NEVER `MOTIR_S3_PUBLIC_BASE_URL`. The rows were written
// on the previous store's base, and the environment running this names S3's once
// flipped; a base read from it would match nothing and report a false 0. The
// window ran it against the SOURCE core database — the one production was leaving
// — after the freeze and before the dump (motir-infra `docs/core-cutover.md`
// step 5), so the Amazon RDS database restored from that dump holds keys.
//
// ⚠️ THE REDUCTION IS THE PRODUCT'S. Each URL becomes its key through
// `publicUrlToKey`, the same function the avatar gate, the GC and the display
// resolver use — so what this writes is what the product reads back.
//
// ONE TRANSACTION, ALL OR NOTHING. A row that does not reduce to a key, a
// compare-and-set that changes nothing (the row moved since it was read), or a
// re-count above 0 throws `StoredAssetRewriteError` inside the transaction, which
// rolls every row back. The DRY RUN is the same code stopping before the writes,
// so its count predicts the apply exactly.
//
// CROSS-TENANT: `withSystemContext`. `User` carries no RLS. `project`'s
// `project_workspace_or_system_read` admits the system arm on USING but not on
// WITH CHECK, so each project write binds that project's workspace first.
import { StoredAssetRewriteError } from '@/lib/blob/errors';
import { publicUrlToKey } from '@/lib/blob/referencedUrls';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';

/** One row the sweep found: its current value and the key it reduces to. */
export interface StoredAssetRewriteRow {
  id: string;
  from: string;
  /** null when the value does not reduce to a key — an apply refuses it. */
  to: string | null;
}

/** One column's half of the report. */
export interface StoredAssetRewriteColumnReport {
  /** Rows whose value starts with `<fromBase>/`, before the sweep. */
  before: number;
  rows: StoredAssetRewriteRow[];
  /** Absolute values on any OTHER host — left alone, reported. */
  foreignAbsolute: number;
  /** Rows still on `<fromBase>/` after the sweep: the re-count on an apply,
   *  `before` on a dry run (nothing was written). */
  after: number;
}

export interface StoredAssetRewriteReport {
  fromBase: string;
  apply: boolean;
  users: StoredAssetRewriteColumnReport;
  projects: StoredAssetRewriteColumnReport;
}

/**
 * Validate and normalise the base the operator passed: an `https:` URL with its
 * trailing slashes removed. Pure, so the script refuses a bad base before any
 * query runs.
 */
export function parseFromBase(raw: string | undefined): string {
  if (!raw) {
    throw new StoredAssetRewriteError(
      'STORED_ASSET_BAD_BASE',
      '--from-base is required: the previous public base the absolute rows were written on.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new StoredAssetRewriteError('STORED_ASSET_BAD_BASE', `--from-base is not a URL: ${raw}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new StoredAssetRewriteError('STORED_ASSET_BAD_BASE', `--from-base must be https: ${raw}`);
  }
  return raw.replace(/\/+$/, '');
}

function reduce(rows: Array<{ id: string; image: string }>, base: string): StoredAssetRewriteRow[] {
  return rows.map((r) => ({ id: r.id, from: r.image, to: publicUrlToKey(r.image, base) }));
}

function refuseUnreducible(table: 'user' | 'project', rows: StoredAssetRewriteRow[]): void {
  const bad = rows.find((r) => r.to === null);
  if (bad) {
    throw new StoredAssetRewriteError(
      'STORED_ASSET_NOT_REDUCIBLE',
      `${table} ${bad.id}: ${bad.from} does not reduce to an object key — nothing was written.`,
      { table, rowId: bad.id },
    );
  }
}

function refuseUnchanged(table: 'user' | 'project', row: StoredAssetRewriteRow): never {
  throw new StoredAssetRewriteError(
    'STORED_ASSET_CHANGED',
    `${table} ${row.id} no longer holds ${row.from} — it changed since it was counted; nothing was written.`,
    { table, rowId: row.id },
  );
}

export const storedAssetUrlRewriteService = {
  /**
   * Count — and with `apply`, rewrite to their keys — every `User.image` and
   * `Project.image` holding an absolute URL on `fromBase`. Returns the report the
   * script prints; throws `StoredAssetRewriteError` (rolling everything back) when
   * an apply cannot finish cleanly.
   */
  async rewriteAbsoluteAssetUrls(input: {
    fromBase: string;
    apply: boolean;
  }): Promise<StoredAssetRewriteReport> {
    const base = parseFromBase(input.fromBase);
    const prefix = `${base}/`;

    return withSystemContext(async (tx) => {
      const userRows = reduce(await userRepository.listImagesWithPrefix(prefix, tx), base);
      const projectList = await projectRepository.listImagesWithPrefix(prefix, tx);
      const projectRows = reduce(projectList, base);
      const usersForeign = await userRepository.countAbsoluteImagesNotWithPrefix(prefix, tx);
      const projectsForeign = await projectRepository.countAbsoluteImagesNotWithPrefix(prefix, tx);

      let usersAfter = userRows.length;
      let projectsAfter = projectRows.length;

      if (input.apply) {
        refuseUnreducible('user', userRows);
        refuseUnreducible('project', projectRows);

        for (const row of userRows) {
          const changed = await userRepository.compareAndSetImage(row.id, row.from, row.to!, tx);
          if (changed !== 1) refuseUnchanged('user', row);
        }
        for (const [i, row] of projectRows.entries()) {
          await bindWorkspaceContext(tx, projectList[i]!.workspaceId);
          const changed = await projectRepository.compareAndSetImage(row.id, row.from, row.to!, tx);
          if (changed !== 1) refuseUnchanged('project', row);
        }

        usersAfter = (await userRepository.listImagesWithPrefix(prefix, tx)).length;
        projectsAfter = (await projectRepository.listImagesWithPrefix(prefix, tx)).length;
        if (usersAfter !== 0 || projectsAfter !== 0) {
          throw new StoredAssetRewriteError(
            'STORED_ASSET_REWRITE_INCOMPLETE',
            `after the rewrite ${usersAfter} user and ${projectsAfter} project row(s) still start with ${prefix} — nothing was written.`,
          );
        }
      }

      return {
        fromBase: base,
        apply: input.apply,
        users: {
          before: userRows.length,
          rows: userRows,
          foreignAbsolute: usersForeign,
          after: usersAfter,
        },
        projects: {
          before: projectRows.length,
          rows: projectRows,
          foreignAbsolute: projectsForeign,
          after: projectsAfter,
        },
      };
    });
  },
};
