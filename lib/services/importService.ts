// The issue-importer DOMAIN service (Story 7.16 · MOTIR-941) — the ONE service
// the import API routes call (the 4-layer rule: a route calls a single service
// method, never Prisma). It owns the `Import` lifecycle (create draft → preview
// → run), builds the per-source connector from the connection config + the
// acting member's stored credential, and delegates:
//   • classify/preview → `importEngineService` (the write-free SLICE-A engine)
//   • persist/run      → `importPersistService` (the write-enabled engine)
// The persist/classify engines own their own transactions; this service owns the
// `Import`-row transactions.

import type { ImportSource } from '@/generated/prisma/client';
import { importRepository } from '@/lib/repositories/importRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { linearImportOAuthService } from '@/lib/services/linearImportOAuthService';
import { jiraOAuthService } from '@/lib/services/jiraOAuthService';
import { planeImportOAuthService } from '@/lib/services/planeImportOAuthService';
import { LinearOAuthExchangeError } from '@/lib/import/linear/errors';
import { JiraOAuthExchangeError } from '@/lib/import/jira/errors';
import { PlaneOAuthExchangeError } from '@/lib/import/plane/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ImportConnectionConfig, ImportDiscoverResult, ImportDto } from '@/lib/dto/import';
import { toImportDto } from '@/lib/mappers/importMappers';
import type { ImportMapping, ImportPlanRow } from '@/lib/import/engine/types';
import { importEngineService } from '@/lib/import/engine/importEngineService';
import { markDerivedParentStatuses } from '@/lib/import/engine/importDerivedStatus';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  importPersistService,
  type ImportRunProgress,
} from '@/lib/import/engine/importPersistService';
import {
  CsvConnector,
  GithubConnector,
  JiraConnector,
  LinearConnector,
  PlaneConnector,
  type IssueSourceConnector,
} from '@/lib/import/connectors';
import {
  ImportConnectionConfigError,
  ImportNotFoundError,
  ImportSourceNotConnectedError,
} from '@/lib/import/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { readProject } from '@/lib/workspaces/tenantRead';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

export interface CreateImportInput {
  projectId: string;
  source: ImportSource;
  sourceRef?: string | null;
}

export interface PreviewResult {
  rows: ImportPlanRow[];
  counts: { create: number; update: number; skip: number };
}

/**
 * Assert the actor may RUN an import into this project — `import:run`
 * (Story MOTIR-2291 · Subtask MOTIR-2353).
 *
 * ⚠️ THE LARGEST SINGLE REVOCATION IN THE STORY: this was `assertCanEdit`, so
 * every project MEMBER could run one; `import:run` is ADMIN-ONLY by decision
 * (`docs/decisions/member-facing-permissions.md` §1). An import is not an edit —
 * it authenticates against another company's tracker with a stored credential,
 * writes hundreds of work items in a single act, and is close to irreversible;
 * nobody un-imports a Jira project. Both mirrors say so in their own
 * documentation: Plane allows imports to workspace admins only "to maintain
 * governance", and Linear requires a Linear Admin.
 *
 * The recovery path for a team that needs a non-admin to import is MOTIR-2257's
 * custom roles — a role holding `import:run` and nothing else administrative —
 * not a wider default.
 *
 * Only the five PROJECT-SCOPED operations are here. The six importer OAuth legs
 * bind a provider credential to a WORKSPACE and resolve no project at all, so
 * MOTIR-2346 re-decided them as `workspace-scoped`; wiring a project permission
 * onto them is impossible, not merely wrong.
 */
async function assertCanRunImports(projectId: string, ctx: ServiceContext): Promise<void> {
  await projectAccessService.assertPermission(projectId, ctx, 'import:run');
}

export const importService = {
  /** Create a DRAFT import for a project (POST /api/import). Gated by
   *  `import:run` (MOTIR-2353); the reporter/owner is the acting user. */
  async createDraft(input: CreateImportInput, ctx: ServiceContext): Promise<ImportDto> {
    const project = await readProject(input.projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(input.projectId);
    }
    await assertCanRunImports(input.projectId, ctx);

    // BOUND (MOTIR-2869). `import_active_workspace` gates every verb on
    // `workspace_id = current_setting('app.workspace_id', true)`, so the bare
    // transaction this replaced had the very FIRST row of the import flow
    // refused — migration did not degrade under `motir_app`, it was impossible,
    // and it failed with a database error rather than anything a user could act
    // on. This is the failure `docs/rls-runtime-role-inventory.md` has quoted by
    // its error text in "Out of scope, and still open: the WRITE surface" since
    // MOTIR-2796 closed. `ctx.workspaceId` is the same value the row carries in
    // its own column, and `:231` already proves it is in scope here.
    const row = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      importRepository.create(
        {
          workspaceId: ctx.workspaceId,
          projectId: input.projectId,
          source: input.source,
          sourceRef: input.sourceRef ?? null,
          createdById: ctx.userId,
        },
        tx,
      ),
    );
    return toImportDto(row);
  },

  /**
   * Read one import's status + counts (GET /api/import/:id). Tenant-scoped: a
   * cross-workspace id is a 404, never a leak.
   *
   * ⚠️ It asks `import:run` WITH THE WRITES, not `project:browse` (MOTIR-2353).
   * An import draft holds the connection configuration and the field mapping —
   * operator material for whoever is running the import, not project content for
   * everyone who can see the board. It had no project gate at all before this
   * card; the tenancy check in `requireImport` was the whole of it.
   */
  async getImport(importId: string, ctx: ServiceContext): Promise<ImportDto> {
    const row = await this.requireImport(importId, ctx);
    await assertCanRunImports(row.projectId, ctx);
    return toImportDto(row);
  },

  /**
   * CONNECT-step probe (POST /api/import/:id/discover) — build the per-source
   * connector from the wizard's connection config (+ the acting member's stored
   * credential for a live source) and return BOTH the reachability/issue-count
   * probe AND the source field vocabulary the mapping step maps from. Read-only:
   * no writes, no `Import` mutation (unlike `preview`, which persists the mapping).
   * This is the thin route over 7.16.4's connector `connect()` + `discoverFields()`
   * that 7.16.5's API set (MOTIR-941) did not expose.
   */
  async discoverFields(
    importId: string,
    args: { connection: ImportConnectionConfig },
    ctx: ServiceContext,
  ): Promise<ImportDiscoverResult> {
    const imp = await this.requireImport(importId, ctx);
    await assertCanRunImports(imp.projectId, ctx);

    const connector = await this.buildConnector(imp.source, args.connection, ctx);
    // Sequential (not Promise.all): `connect()` validates reachability + auth, so
    // a bad token / unreachable source surfaces as its typed error BEFORE we page
    // for the field vocabulary.
    const connect = await connector.connect();
    const vocabulary = await connector.discoverFields();
    return {
      connect: { sourceRef: connect.sourceRef, issueCount: connect.issueCount },
      vocabulary,
    };
  },

  /**
   * DRY-RUN preview (POST /api/import/:id/preview) — classify every source issue
   * (CREATE/UPDATE/SKIP + resolved payload + warnings) with NO writes, via the
   * SLICE-A engine. Stores the confirmed mapping + a `previewed` status on the
   * `Import` so a subsequent run reuses them.
   */
  async preview(
    importId: string,
    args: { mapping: ImportMapping; connection: ImportConnectionConfig },
    ctx: ServiceContext,
  ): Promise<PreviewResult> {
    const imp = await this.requireImport(importId, ctx);
    await assertCanRunImports(imp.projectId, ctx);

    const connector = await this.buildConnector(imp.source, args.connection, ctx);
    const resolveCtx = await importEngineService.buildResolveContext(
      imp.projectId,
      ctx.workspaceId,
      ctx.userId,
    );

    const rows: ImportPlanRow[] = [];
    const counts = { create: 0, update: 0, skip: 0 };
    for await (const row of importEngineService.previewFromConnector(
      connector,
      args.mapping,
      resolveCtx,
    )) {
      rows.push(row);
      counts[row.plan] += 1;
    }

    // ── The derived-parent-status disclosure (Task MOTIR-2974) ────────────
    //
    // A parent's status is a function of its CHILDREN, not of the file's status
    // column (`docs/decisions/status-derivation.md`, amended 2026-08-27). Say so
    // HERE, in the dry run, rather than leaving it to be discovered after the
    // write. This is the first tier holding the whole plan — the resolve path is
    // streamed per issue and cannot see whether some OTHER row names this one as
    // its parent — so the annotation is a post-pass, not a resolver rule.
    //
    // Both reads are BOUND (`withWorkspaceServiceContext`), the same tier
    // `parentStatusRollupService` binds its own `findStatusAutomation` at:
    // unbound, `project` and `work_item` answer for no tenant.
    const derivation = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const automation = await projectRepository.findStatusAutomation(imp.projectId, tx);
      if (!automation?.autoRollupParentStatus) return null;
      // Only the rows that MATCHED an existing item can already have children;
      // an empty list short-circuits in the repository.
      const matchedIds = rows
        .map((r) => r.existingWorkItemId)
        .filter((id): id is string => id !== null);
      const children = await workItemRepository.findChildrenForItems(
        matchedIds,
        ctx.workspaceId,
        tx,
      );
      return { existingParentIds: new Set(children.map((c) => c.parentId)) };
    });
    if (derivation) {
      markDerivedParentStatuses(rows, {
        autoRollupParentStatus: true,
        existingParentIds: derivation.existingParentIds,
      });
    }

    // Resolve the human-facing source ref OUTSIDE the transaction (it may hit the
    // source / re-parse a file — never inside a tx).
    const sourceRef = imp.sourceRef ?? (await connectorSourceRef(connector));
    // BOUND (MOTIR-2869) — same policy, same reason as `createDraft`. An UPDATE
    // is checked against `USING` *and* `WITH CHECK`, so unbound it could neither
    // find the row nor write it: the confirmed mapping and the `previewed` status
    // were silently lost between the preview and the run.
    await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      importRepository.update(
        importId,
        { mapping: args.mapping as object, sourceRef, status: 'previewed' },
        tx,
      ),
    );
    return { rows, counts };
  },

  /**
   * Execute the import (POST /api/import/:id/run) — the SLICE-A engine with
   * writes ON. Loads + gates + builds the connector up front (so a 4xx is thrown
   * before streaming), then returns the persist engine's streamed progress
   * generator; the route serialises it to the HTTP response.
   */
  async run(
    importId: string,
    args: { mapping?: ImportMapping; connection: ImportConnectionConfig },
    ctx: ServiceContext,
  ): Promise<AsyncGenerator<ImportRunProgress>> {
    const imp = await this.requireImport(importId, ctx);
    await assertCanRunImports(imp.projectId, ctx);

    const mapping = args.mapping ?? (imp.mapping as ImportMapping | null);
    if (!mapping) {
      throw new ImportConnectionConfigError('no mapping supplied and none stored on the import');
    }

    const connector = await this.buildConnector(imp.source, args.connection, ctx);
    const resolveCtx = await importEngineService.buildResolveContext(
      imp.projectId,
      ctx.workspaceId,
      ctx.userId,
    );

    return importPersistService.runImport({ importId, connector, mapping, ctx: resolveCtx });
  },

  /** Load an import in the acting workspace or throw a 404. */
  async requireImport(importId: string, ctx: ServiceContext) {
    const row = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      importRepository.findById(importId, tx),
    );
    if (!row || row.workspaceId !== ctx.workspaceId) throw new ImportNotFoundError(importId);
    return row;
  },

  /** Build the per-source connector from the connection config + (for live
   *  sources) the acting member's decrypted credential. CSV needs none. */
  async buildConnector(
    source: ImportSource,
    connection: ImportConnectionConfig,
    ctx: ServiceContext,
  ): Promise<IssueSourceConnector> {
    if (connection.source !== source) {
      throw new ImportConnectionConfigError(
        `connection is for "${connection.source}" but the import is "${source}"`,
      );
    }

    if (connection.source === 'csv') {
      return new CsvConnector({
        filename: connection.filename,
        content: connection.content,
        columnMap: connection.columnMap,
        delimiter: connection.delimiter,
      });
    }

    // ⚠️ EVERY OAuth source reads through its `getFreshConnection`, NEVER the raw
    // stored token: each vendor expires the access token (Jira ~60 minutes,
    // Linear 24 hours, Plane per its instance), so the refresh path — which
    // re-mints and re-persists an expired token BEFORE the connector calls the
    // vendor — is the only credential source that still works after connect day.
    // Linear was wired in MOTIR-2434; Jira + Plane in MOTIR-2454, which found
    // that both had shipped the helper and never called it (`getLiveToken`
    // below reached straight past it and replayed a dead Bearer).
    if (connection.source === 'linear') {
      const live = await readFresh('linear', LinearOAuthExchangeError, () =>
        linearImportOAuthService.getFreshConnection({
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        }),
      );
      if (!live) throw new ImportSourceNotConnectedError('linear');
      return new LinearConnector({
        apiKey: live.accessToken,
        authScheme: connection.authScheme,
        teamKey: connection.teamKey,
        endpoint: connection.endpoint,
      });
    }

    if (connection.source === 'jira') {
      const live = await readFresh('jira', JiraOAuthExchangeError, () =>
        jiraOAuthService.getFreshConnection({
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        }),
      );
      if (!live) throw new ImportSourceNotConnectedError('jira');
      return new JiraConnector({
        // ⚠️ The GATEWAY base URL from the grant, not `connection.baseUrl` (the
        // member-typed site). A 3LO Bearer does NOT authenticate against
        // `<site>.atlassian.net`: "Requests that use OAuth 2.0 (3LO) are made
        // via api.atlassian.com (not https://your-domain.atlassian.net)"
        // — developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps. That
        // is exactly why the identity persists the cloud id and
        // `getFreshConnection` returns `apiBaseUrl` (= /ex/jira/<cloudId>);
        // taking the credential from it and the host from somewhere else would
        // renew a token only to send it where it is rejected.
        baseUrl: live.apiBaseUrl,
        apiToken: live.accessToken,
        email: connection.email,
        projectKey: connection.projectKey,
        jql: connection.jql,
      });
    }

    if (connection.source === 'plane') {
      const live = await readFresh('plane', PlaneOAuthExchangeError, () =>
        planeImportOAuthService.getFreshConnection({
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
        }),
      );
      if (!live) throw new ImportSourceNotConnectedError('plane');
      return new PlaneConnector({
        // Sent as `Authorization: Bearer` — Plane reserves `X-API-Key` for a
        // `plane_api_*` personal key, and this is an OAuth access token
        // (MOTIR-2457 moved the scheme; MOTIR-1657 left OAuth as the only one).
        accessToken: live.accessToken,
        // The grant's own API origin wins: the token is bound to the instance
        // that issued it (Cloud or a self-host), so a connection config naming
        // a different host would send it somewhere it is not valid. Fall back
        // to the config only when the identity stored no origin.
        baseUrl: live.baseUrl ?? connection.baseUrl,
        workspaceSlug: connection.workspaceSlug,
        projectId: connection.projectId,
      });
    }

    // GITHUB — the one live source with NO `getFreshConnection` to call, and the
    // reason is structural, not an oversight (settled by MOTIR-2454):
    //
    //  • There is no `githubImportOAuthService`. GitHub is not an import-source
    //    OAuth flow at all — the wizard "reuses your existing GitHub connection"
    //    (`_data.ts` → `githubIdentityService.getIdentityForUser`), i.e. the 7.10
    //    per-user identity grant (MOTIR-1498).
    //  • The refresh lives in the substrate, not here. Motir Integration DOES
    //    expire user tokens (MOTIR-6522), and `githubIdentityService.getLiveToken`
    //    renews them from the refresh token the identity stores (Bug
    //    MOTIR-10021) — so this call site reads a usable token with no
    //    refresh path of its own.
    //
    // ⚠️ So it reads `GithubIdentity` — the SAME row the wizard badges — and not
    // `ImportSourceIdentity`, which is what MOTIR-2456 fixed. That failure was
    // total: NOTHING in the repo ever writes an `ImportSourceIdentity` with
    // `source: 'github'` (only the jira / linear / plane OAuth services call
    // `upsertIdentity`, and there is no `app/api/import/github/*` route), so
    // every GitHub import threw `ImportSourceNotConnectedError` — including for
    // a member the wizard had just badged CONNECTED off the other table. Two
    // surfaces answering one question from two stores: keep this read and
    // `_data.ts`'s pointed at the SAME one, or the badge starts lying again.
    if (connection.source === 'github') {
      const live = await githubIdentityService.getLiveToken(ctx.userId);
      if (!live) throw new ImportSourceNotConnectedError('github');
      return new GithubConnector({
        token: live.accessToken,
        owner: connection.owner,
        repo: connection.repo,
        baseUrl: connection.baseUrl,
      });
    }

    // Every source now reads its credential through the path that keeps it
    // usable after connect day — the three `readFresh` branches above, and
    // GitHub's identity read here. The raw `importSourceIdentityService`
    // fetch-and-decrypt this tail used to do has no caller left: MOTIR-2454
    // took Jira and Plane off it, and MOTIR-2456 took GitHub off it. Do not
    // reintroduce it as a fallback — a stored token read without its refresh
    // path is exactly the day-two failure both cards were filed for.
    return exhaustive(connection);
  },
};

/** The `buildConnector` dispatch is TOTAL over `ImportConnectionConfig`. This
 *  makes that a compile-time claim: a new `ImportSource` variant lands here as a
 *  type error naming the unhandled member, rather than as a runtime fall-through
 *  that would look, from the wizard, exactly like "not connected". */
function exhaustive(connection: never): never {
  throw new ImportConnectionConfigError(
    `no connector for source "${(connection as { source?: string }).source ?? 'unknown'}"`,
  );
}

/** Read one source's connection through its refresh path. A grant the vendor
 *  will no longer refresh (the refresh POST was rejected, or the identity
 *  predates the refresh wiring and stored no refresh token) is, in effect, NOT a
 *  connection: translate that vendor error to the not-connected error, which the
 *  wizard already renders as "connect <source> first" — the member's actual
 *  remedy — instead of letting it escape as an opaque 500. The vendor detail
 *  rides along as the `cause` for logs. Any OTHER error propagates untouched. */
async function readFresh<T>(
  source: Extract<ImportSource, 'jira' | 'linear' | 'plane'>,
  vendorError: abstract new (...args: never[]) => Error,
  read: () => Promise<T | null>,
): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (!(err instanceof vendorError)) throw err;
    const notConnected = new ImportSourceNotConnectedError(source);
    notConnected.cause = err;
    throw notConnected;
  }
}

/** The connector's human-facing source ref (Jira project key / `owner/repo` /
 *  filename) for `Import.sourceRef`, best-effort. */
async function connectorSourceRef(connector: IssueSourceConnector): Promise<string | null> {
  try {
    const result = await connector.connect();
    return result.sourceRef;
  } catch {
    return null;
  }
}
