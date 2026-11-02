import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { withAfterCommitScope } from './afterCommit';
import { retryOnceBeforeBody } from './retryBeforeBody';

// Runtime half of the workspace-RLS pair (the DB half lives in
// prisma/migrations/.../add_workspace_rls and .../add_work_item_rls). Every
// tenant-scoped query path opens a transaction via withWorkspaceContext,
// which sets three per-transaction GUCs the RLS policies read:
//   app.user_id      — the authenticated user's id
//   app.workspace_id — the active workspace id
//   app.project_id   — the active project id, OR empty string when no
//                      project is active. Read by the work_item table's
//                      restrictive project-narrowing policy (1.4.5): when
//                      empty, all of the workspace's projects are visible;
//                      when set, work_item reads narrow to that one project.
//                      Always bound (empty string when absent) so the
//                      policy's `coalesce(...) = ''` branch fires cleanly
//                      with no "unset vs empty" ambiguity. Unused by the
//                      workspace/project/work_item_link policies.
//
// Why $transaction (not just $executeRaw on the singleton): SET LOCAL /
// set_config(..., true) are transaction-scoped. Outside a transaction
// each statement is its own implicit txn, so the GUC would die between
// the SET and the next query — leaving the RLS policies seeing NULL and
// hiding everything. Wrapping the work in $transaction binds the GUC to
// every query routed through the `tx` client.
//
// Why set_config(..., true) instead of `SET LOCAL`: SET LOCAL is a
// statement, not an expression, so it can't accept parameter bindings.
// Passing user-supplied values through it would require string
// interpolation (SQL injection risk). set_config() is a function call
// that accepts parameters, so Prisma's tagged-template $executeRaw
// binds userId/workspaceId safely.
//
// ⚠️ THE SHAPE OF A BOUND READ PATH — ONE TRANSACTION PER SERVICE METHOD.
// Decided and MEASURED in docs/decisions/bound-read-transaction-shape.md
// (MOTIR-2799). Because the GUCs are transaction-local, every read of a
// policy-gated table needs a transaction, and a method with N reads could
// open one transaction (N sequential reads) or N transactions (still
// parallel). The convention is ONE, at the SERVICE-METHOD boundary, with
// `tx` threaded into every read beneath it:
//
//   * A repository read of a policy-gated table takes `tx?:
//     Prisma.TransactionClient` LAST and resolves `const client = tx ?? dbRead`.
//     That is also the form tests/rls/singletonReadScan.ts treats as
//     BINDABLE, so adding it removes the read from the scan.
//   * A `Promise.all` inside the boundary collapses to sequential awaits.
//     That is the accepted cost: measured on a 10 000-item corpus, the
//     widest fan-out that can be built from reportsService's reads goes
//     58 ms -> 118 ms, while total pooled-connection TIME is unchanged —
//     one transaction per method holds ONE Neon pool slot per request
//     instead of N, and the pooler (measured: ~98 server connections, then
//     it QUEUES rather than erroring) turns N-at-once into a request whose
//     latency is the MAX of N queue waits.
//   * A read already inside a bound transaction threads THAT `tx`. Never
//     open a second — Prisma rejects nesting.
//   * Read paths do NOT pass `options`. 118 ms against a 5 s default is a
//     38x margin; see {@link TransactionBudget}, whose callers carry very
//     different justifications — including the three read paths that do
//     pass it (the 2FA gate, MOTIR-5866, the active-project resolver,
//     MOTIR-6254, and the active-workspace resolver, MOTIR-6253), where the
//     budget is outgrown by a WAIT the expiry cannot shorten, never by the
//     read's work. All three are DOORS nearly every signed-in request passes
//     through; that, not the read, is what earns the exception.
//
// The ONE sanctioned exception is STRUCTURAL, never performance: a fan-out
// whose members need DIFFERENT bindings. `publicProjectsService` is it —
// `work_item_public_project_read` fires only when `app.workspace_id` is
// UNSET, so its page mixes bound and deliberately unbound reads and no
// single transaction can express both. Wanting (B) for speed requires a
// measurement in the PR showing this shape past a stated budget.

export interface WorkspaceContext {
  userId: string;
  workspaceId: string;
  /**
   * Optional active-project id. When provided, work_item reads narrow to
   * this project (the restrictive project policy from add_work_item_rls);
   * when omitted, all of the workspace's projects are visible. Bound as the
   * `app.project_id` GUC (empty string when absent). Does not affect writes
   * or the work_item_link table — those are workspace-scoped only.
   */
  projectId?: string;
}

/**
 * Opens a Prisma transaction, binds the workspace + user GUCs the RLS
 * policies read, and invokes `fn` with the transaction client. Every
 * query issued through `tx` inside `fn` sees the GUCs and is RLS-scoped
 * to the workspace; once the transaction ends the GUCs are discarded.
 *
 * `options` raises Prisma's interactive-transaction budget — see
 * {@link TransactionBudget}, and note that its "raising it is a visible, argued
 * decision at the call site" is the whole contract: OMIT it and the Prisma
 * defaults (5 000 ms / 2 000 ms) apply, which is what all but one caller wants.
 *
 * ⚠️ IT TAKES ONE BECAUSE THE ABSENCE WAS NOT A DECISION (MOTIR-3396). This is
 * the context every tenant-scoped WRITE opens, and it was the only one of the
 * four in this file that could not be given a budget — `withWorkspaceServiceContext`
 * has accepted one since MOTIR-1972. So the one path with a genuinely large
 * transaction (`plansService.approvePlan`, which materializes a whole proposed
 * subtree) had no way to say so, and a 15-item plan died mid-body on P2028 with
 * the route reporting a bare 500. Adding the parameter does not make long
 * transactions cheap: the caller that reaches for it owes the argument, and
 * approve's own fix was to remove ~26 round trips FIRST and raise the budget
 * second.
 */
export async function withWorkspaceContext<T>(
  ctx: WorkspaceContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: TransactionBudget,
): Promise<T> {
  // The after-commit scope (`./afterCommit.ts`, MOTIR-6819): work a writer deferred
  // runs once this transaction has committed, and never when it rolled back.
  // A transaction that dies on P2028 before `fn` starts is retried once
  // (`./retryBeforeBody.ts`, MOTIR-8333); each attempt gets its own scope.
  // Each attempt is measured and traced (MOTIR-8550): `bodyStarted` ends the wait
  // and runs `fn` under the hold span; `settled` ends the hold when the
  // transaction does, before any after-commit work runs.
  return retryOnceBeforeBody(
    (bodyStarted, settled) =>
      withAfterCommitScope(() =>
        settled(
          db.$transaction(
            async (tx) => {
              await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
              await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
              // Always bind app.project_id (empty string when no project is active) so
              // the work_item project-narrowing policy's `coalesce(...) = ''` branch
              // fires cleanly — no ambiguity between "unset" and "deliberately empty".
              await tx.$executeRaw`SELECT set_config('app.project_id', ${ctx.projectId ?? ''}, true)`;
              return bodyStarted(() => fn(tx));
            },
            options ? { timeout: options.timeoutMs, maxWait: options.maxWaitMs } : undefined,
          ),
        ),
      ),
    'workspace',
  );
}

/**
 * The interactive-transaction budget a {@link withSystemContext} caller may ask for.
 *
 * ⚠️ OMIT IT AND THE TRANSACTION DIES AT PRISMA'S DEFAULT OF 5 SECONDS. That is
 * right for a transaction made only of queries, and wrong for one that holds a
 * row lock ACROSS an outbound call: the call can succeed at the far end after
 * the transaction has expired, and the write recording its answer then rolls
 * back. With a ROTATING refresh token that loses the only usable credential
 * (MOTIR-5988), so such a caller passes a `timeout` derived from its call's own
 * deadline rather than trusting the default.
 */
export interface SystemTransactionOptions {
  /** Ms the whole transaction may run before Prisma expires it (default 5000). */
  timeout?: number;
  /** Ms to wait for a pooled connection before giving up (default 2000). */
  maxWait?: number;
}

/**
 * Opens a Prisma transaction binding the `app.system_admin` GUC to `'true'`,
 * then invokes `fn` with the transaction client. This is the TRUSTED-WRITER /
 * cross-workspace-admin context for the job-ledger tables (job_run /
 * job_run_dlq, Subtask 1.6.4): their RLS policy admits any row — tenanted or
 * untenanted — when system_admin is set.
 *
 * Two callers, by design:
 *   * the background-jobs runtime (jobRunsService, run by defineJob) — it
 *     writes ledger rows OUTSIDE any HTTP request, so it has no active
 *     workspace context; the system-admin branch is what lets its INSERT/UPDATE
 *     pass WITH CHECK under the non-bypass motir_app role.
 *   * operator tooling that must see SYSTEM rows (workspace_id IS NULL) or span
 *     workspaces (the 1.6.5 dashboard's system tab).
 *
 * ⚠️ IT IS NOT A UNIVERSAL ESCAPE HATCH, AND THE FAILURE IS SILENT (MOTIR-2880).
 * `app.system_admin` is read by a policy ARM, and that arm is added TABLE BY TABLE —
 * many RLS tables carry none (when MOTIR-2880 measured it, `work_item` / `workspace`
 * / `workspace_membership` / `organization` / `sprint` / `comment` were among them).
 * Whether a given table admits this context is a property of THAT table's policy, so
 * read the policy (`pg_policies`, or the migration that created it) rather than a
 * count. A read of an unarmed table inside this context returns ZERO ROWS AND RAISES
 * NOTHING, so the caller reads a real row's absence as data. The rule that follows:
 *
 *   * The CONNECTION tier — `github_installation` / `github_repo` /
 *     `github_pull_request` / `job_run` / the CI meters — is what this context is
 *     for. Those policies are `system_admin OR workspace_id = app.workspace_id`.
 *   * A TENANT table read in the same transaction owes a tenant binding. Call
 *     {@link bindWorkspaceContext} (or `bindOrganizationContext`) the moment the id
 *     is known — it is additive, so the connection reads keep their arm.
 *   * A read that is cross-tenant BY DESIGN (no single tenant exists — the
 *     cross-workspace live-project resolve, the meta/tenant cost split) is the only
 *     case that earns a new `system_admin` READ arm on the table.
 *
 * WRITES follow the same per-table rule, on the policy's `WITH CHECK` clause. A
 * write under this context passes only where the system-admin arm also covers new
 * rows: the job ledger (`job_run_workspace_or_system_admin`), deliveries
 * (`work_item_delivery_workspace_or_system`) and hosted applications
 * (`hosted_application_workspace_or_system`) carry it on both `USING` and
 * `WITH CHECK`, which is why jobRunsService and emailDeliveryService write here on
 * purpose. An arm on `USING` alone admits the read and refuses the write.
 *
 * The tenant-root WRITE policies (`membership_insert_active_or_bootstrap` and
 * friends, MOTIR-2865) REFUSE this context, and that refusal is load-bearing. System
 * code writing a tenant row binds the workspace first (`withWorkspaceServiceContext`,
 * or {@link bindWorkspaceContext} inside this transaction), taking the id from the
 * row it read; a new `WITH CHECK` arm is added only where no workspace can be known
 * first. Never answer a blind read by arming an INSERT/UPDATE policy.
 *
 * SECURITY: this helper is NEVER fed user input — it binds a constant. A tenant
 * request path uses withWorkspaceContext (which binds only user/workspace/
 * project), so a tenant can never elevate itself to system_admin. Keep it that
 * way: do not thread a request-derived flag into this function.
 */
export async function withSystemContext<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: SystemTransactionOptions,
): Promise<T> {
  // The after-commit scope, as in `withWorkspaceContext` — the webhook and job paths
  // that re-raise gates open THIS context.
  return retryOnceBeforeBody(
    (bodyStarted, settled) =>
      withAfterCommitScope(() =>
        settled(
          db.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
            return bodyStarted(() => fn(tx));
          }, options),
        ),
      ),
    'system',
  );
}

/**
 * Bind `app.workspace_id` on a transaction that is ALREADY open — the one case the
 * `with*Context` wrappers above cannot serve, because the workspace is not known
 * until partway through the transaction. The workspace-tier twin of
 * `bindOrganizationContext` (`lib/organizations/context.ts`), and its callers are
 * the mirror image: there the org is learned from a workspace row mid-write; here
 * the WORKSPACE is learned from a connection-tier row mid-read.
 *
 * ⚠️ THE CASE IT EXISTS FOR (MOTIR-2880). `withSystemContext` binds ONE flag, and
 * only the tables whose policy carries a system-admin arm read it. A webhook / job path
 * legitimately opens a system transaction to reach the CONNECTION tier — the
 * `github_installation` / `github_repo` / `job_run` family, whose policies are
 * `system_admin OR workspace_id = app.workspace_id` — and then reads TENANT tables
 * (`work_item`, `workspace_membership`, `project_repository`, …) whose policies have
 * no system arm at all. Those reads return ZERO ROWS AND RAISE NOTHING. The tenant
 * is discovered by the FIRST read, so no wrapper could have bound it up front:
 * the binding has to move to the point where the id becomes known.
 *
 * Binding here is ADDITIVE, never a swap. `app.system_admin` stays set, so the
 * connection-tier reads in the same transaction keep their arm; the workspace GUC
 * only ADMITS rows that were invisible before. It is also strictly NARROWING in
 * effect — nothing this grants sight of is outside the one workspace named.
 *
 * `set_config(..., true)` is transaction-LOCAL, so the binding dies with `tx` exactly
 * as the wrappers' do.
 *
 * ⚠️ POSITION IS THE WHOLE POINT: a statement issued BEFORE this call is still
 * unbound. Call it immediately after the read that resolves the workspace, before
 * the first tenant-table statement — `tests/rls/system-context-arm-guard.test.ts`
 * adjudicates each statement against this call's position, exactly as
 * `bareTransactionScan` does for an inline `set_config`.
 *
 * SECURITY: same constraint as `withWorkspaceServiceContext` — the id must come from
 * a TRUSTED resolution (a stored `github_repo` / `github_installation` row, a job
 * event envelope), never from request input.
 */
export async function bindWorkspaceContext(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
}

/**
 * Run `fn` with the PROJECT narrowing lifted, on a transaction that is already
 * bound to one — then rebind it. The workspace gate is untouched throughout, so
 * this WIDENS from one project to the workspace and never past it.
 *
 * ⚠️ THE POLICY THIS EXISTS FOR (MOTIR-3581). `work_item` carries two axes: the
 * PERMISSIVE `work_item_active_workspace` gate on `app.workspace_id`, and the
 * RESTRICTIVE `work_item_project_narrow` FOR SELECT policy
 * (`prisma/migrations/20260601074342_add_work_item_rls/migration.sql`):
 *
 *     coalesce(current_setting('app.project_id', true), '') = ''
 *     OR "projectId" = current_setting('app.project_id', true)
 *
 * `withWorkspaceContext` always binds `app.project_id`, so a read issued inside
 * one of its transactions cannot see a work item in ANOTHER PROJECT of the same
 * workspace — even when the question being asked is workspace-scoped by
 * definition. That is the right default for a page read and the wrong one for a
 * TENANCY question ("does this id name a work item in this workspace?"), and the
 * gap is not theoretical: a cross-project `blocked_by` is a supported edge
 * (`link_work_items`: "targets may be in another project in the same
 * workspace"; `work_item_link` carries NO project narrowing, deliberately), and
 * `plansService.approvePlan` rejected every plan proposing one because its
 * in-transaction gate pass could not see the blocker its pre-transaction pass
 * had just resolved.
 *
 * ⚠️ IT IS NOT A SECURITY WIDENING, and the distinction is the whole licence for
 * this helper. The project GUC is a VIEW narrowing, opt-in by
 * `withWorkspaceContext`'s caller; the tenancy boundary is `app.workspace_id`,
 * which stays bound. A read reached through here is still confined to one
 * workspace by RLS, and its repository method filters on `workspaceId`
 * explicitly as well (`workItemRepository.findByIdsInWorkspace`). Do NOT reach
 * for it to escape a workspace, an organization, or a permission check — none of
 * those is expressible here.
 *
 * ⚠️ NARROW IT TO THE STATEMENTS THAT NEED IT. Every read issued inside `fn`
 * loses the narrowing, so `fn` holds the tenancy-scoped statements and nothing
 * else — never a whole transaction body, and never `materialize`-style writes,
 * which the workspace policy governs but which a reader of this call would then
 * have to re-derive the scope of.
 *
 * `set_config(..., true)` is transaction-LOCAL both times, so a rollback discards
 * the rebinding along with everything else — which is why the restore is best
 * effort: if `fn` threw a SQL error the transaction is already aborted and the
 * rebinding cannot run, and there is nothing left for it to protect.
 */
export async function withProjectNarrowingSuspended<T>(
  tx: Prisma.TransactionClient,
  boundProjectId: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.$executeRaw`SELECT set_config('app.project_id', '', true)`;
  try {
    return await fn();
  } finally {
    await tx.$executeRaw`SELECT set_config('app.project_id', ${boundProjectId ?? ''}, true)`.catch(
      () => {
        // The transaction is aborted; the GUC dies with it. Swallowing here keeps
        // the ORIGINAL failure as the one the caller sees.
      },
    );
  }
}

/**
 * Opens a Prisma transaction binding ONLY the `app.workspace_id` GUC (no
 * `app.user_id`, no `app.system_admin`), then invokes `fn` with the transaction
 * client. This is the workspace-tier analogue of
 * `withOrgServiceWriteContext` (lib/organizations/context.ts): the context for a
 * TRUSTED path that operates within ONE workspace WITHOUT an acting user.
 *
 * The first caller was the CI-minutes meter (Story MOTIR-1775 · MOTIR-1896),
 * which resolves a GitHub `workflow_run` delivery to its tenant. A webhook has
 * no session, so there is no user to bind — but `withSystemContext` would be the
 * WRONG tool: `system_admin` is a cross-table, cross-tenant flag, and the meter
 * needs to read exactly one workspace's rows. Binding the workspace id keeps the
 * reach row-scoped, so RLS itself enforces that a repo can only be attributed
 * inside the tenant that holds its installation. MOTIR-2685 added the rest of
 * the userless paths — the notification / automation job runtime and the
 * `workspaceId`-only service helpers — through `readProjectForService` /
 * `readWorkItemForService` (`lib/workspaces/tenantRead.ts`).
 *
 * SUFFICIENCY, table by table. Sufficient for every policy that gates PURELY on
 * `workspace_id` — the `project_repository` / `sprint` / `plan` shape, the
 * `workspace_active` SELECT policy, `workflow_status` / `workflow_transition`,
 * `project` (`project_workspace_or_system_read`, whose other arm is the
 * system-admin one), and `work_item`. NOT sufficient for a policy that also
 * reads `app.user_id` (membership-gated rows), which is deliberate: a path that
 * needs one has an acting user and should use `withWorkspaceContext`.
 *
 * `work_item` is the case worth spelling out, because this note used to claim
 * the opposite. Its permissive policy `work_item_active_workspace` keys purely
 * on `app.workspace_id`; the RESTRICTIVE `work_item_project_narrow` AND'd onto
 * it reads `app.project_id`, but it is satisfied — not defeated — when the GUC
 * is unbound, because its first branch is
 *
 *     coalesce(current_setting('app.project_id', true), '') = ''
 *     OR "projectId" = current_setting('app.project_id', true)
 *
 * (`prisma/migrations/20260601074342_add_work_item_rls/migration.sql`). An
 * unbound GUC coalesces to `''`, the branch is true, and the policy imposes no
 * restriction — every project in the workspace stays visible, which is exactly
 * what a userless caller resolving an item BEFORE it knows the project needs.
 * Narrowing is opt-IN, so not opting in is not a hole. (Reading "the policy
 * reads `app.project_id`" as "the context must bind it" is the mis-inference
 * this paragraph exists to stop: a shipped comment that contradicts the shipped
 * SQL is how the next reader re-derives the wrong answer.)
 *
 * SECURITY: the workspace id must come from a TRUSTED resolution (the meter
 * takes it from the stored `github_installation` row the delivery's installation
 * id resolves to), never from user input — exactly the constraint
 * `withOrgServiceWriteContext` documents. The policy confines the effect to that
 * one workspace, so it grants no broader reach than the id already implies.
 *
 * `options` raises Prisma's interactive-transaction budget for the ONE path that
 * needs it — see {@link TransactionBudget}. Omit it and the default 5s applies,
 * which is what every shipped caller wants.
 */
export async function withWorkspaceServiceContext<T>(
  workspaceId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: TransactionBudget,
): Promise<T> {
  // The after-commit scope, as in `withWorkspaceContext`.
  return retryOnceBeforeBody(
    (bodyStarted, settled) =>
      withAfterCommitScope(() =>
        settled(
          db.$transaction(
            async (tx) => {
              await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
              return bodyStarted(() => fn(tx));
            },
            options ? { timeout: options.timeoutMs, maxWait: options.maxWaitMs } : undefined,
          ),
        ),
      ),
    'workspace_service',
  );
}

/**
 * Opens a Prisma transaction binding ONLY `app.bootstrap_slug`, then invokes `fn`
 * with the transaction client. The narrowest context in this file: it admits
 * exactly ONE row — the workspace (or organization) whose `slug` equals the bound
 * value — through the `*_visible_bootstrap` policies from
 * `20260810001000_tenant_root_insert_policies`.
 *
 * Two callers, and they are the same shape from opposite ends:
 *   * `workspacesService.createWorkspace`, which must READ BACK the tenant root it
 *     is creating before any `app.workspace_id` exists to bind (it binds the slug
 *     inline, as part of a larger transaction).
 *   * `scripts/stampOnboardingRan.ts` (MOTIR-2813), which resolves a workspace by
 *     slug as an OPERATOR — no active workspace, and the slug IS the handle.
 *
 * SECURITY: the slug is a HANDLE, not an authorisation. Binding it grants sight of
 * that one row and nothing else — no items, no projects, no memberships — which is
 * why it is safe for a resolve that has no tenant yet and why it must never be
 * used as a substitute for `withWorkspaceContext` once one is known.
 */
export async function withBootstrapSlugContext<T>(
  slug: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return retryOnceBeforeBody(
    (bodyStarted, settled) =>
      settled(
        db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.bootstrap_slug', ${slug}, true)`;
          return bodyStarted(() => fn(tx));
        }),
      ),
    'bootstrap_slug',
  );
}

/**
 * An explicit, raised budget for an interactive transaction.
 *
 * Prisma's default is `timeout: 5000` / `maxWait: 2000`, and that default is
 * correct for essentially everything: a transaction is a lock held on live rows,
 * and a long one is usually a design smell. It is stated as a TYPE rather than
 * two loose numbers so that raising it is a visible, argued decision at the call
 * site instead of a magic literal.
 *
 * The shipped callers are SIX, and they are raised for different reasons — which
 * is why the type asks for an argument rather than a number:
 *
 *   * the per-project runner-group sync (MOTIR-1972), which must hold the
 *     project's row lock ACROSS its GitHub calls because the access list it
 *     writes is read-derived — see that service's header for why the lock
 *     cannot be released first. Its budget covers time spent WAITING on a third
 *     party.
 *   * `plansService.approvePlan` (MOTIR-3396), whose transaction is large
 *     because the WORK is large — materializing a whole proposed subtree. Its
 *     budget covers time spent doing our own round trips, so the argument at
 *     that call site has to explain why the work could not be made smaller
 *     first. It was: batching the `blocked_by` pass took a 15-item / 27-edge
 *     plan from ~42 statements of edge-writing to 1.
 *   * the CI-feedback consumer (MOTIR-5865, `changeRequestCiFeedback`), whose
 *     transactions are small and whose budget covers time spent WAITING on our
 *     own database — a lock another session holds, a stalled process — because
 *     an expired transaction there loses a webhook GitHub never redelivers. Its
 *     `withSystemContext` calls take the same number through
 *     {@link SystemTransactionOptions}.
 *   * the 2FA gate (MOTIR-5866, `twoFactorPolicyService.resolveRequirement`) —
 *     the one READ path with a budget, and the exception the "read paths do not
 *     pass `options`" rule at the top of this file names. That rule is argued
 *     from WORK (118 ms against 5 s); this transaction is one read, and what
 *     expired it in production was a 17 s WAIT. For a transaction that holds no
 *     lock, the expiry cannot end a wait early — Prisma rolls back only after
 *     the statement in flight returns — so it turns a slow answer into a slow
 *     500, on a gate every signed-in request passes through.
 *   * the active-project resolver (MOTIR-6254, `projectsService.getActiveProject`)
 *     — the SECOND read path with a budget, on the same argument: two indexed
 *     reads under the (authed) layout and ~130 other callers, expired in
 *     production at COMMIT after a 6.4 s wait. Its one lock (the pointer heal's
 *     UPDATE) is its LAST statement, so the ceiling cannot lengthen how long a
 *     lock is held.
 *   * the active-WORKSPACE resolver (MOTIR-6253,
 *     `workspacesService.resolveActiveWorkspace`) — the THIRD read path, a door of
 *     the same kind as the other two: `getWorkspaceContext` runs it for every
 *     signed-in request. It writes nothing and takes no lock, and production
 *     expired it at QUERY after a 30.5 s wait — so its ceiling is 60 s, not the
 *     siblings' 30 s, which would have failed that very event. A fourth read path
 *     reaching for this owes the same two facts: that it is a door, and that the
 *     time is a wait, not work — and a ceiling sized against the wait it saw.
 */
export interface TransactionBudget {
  /** Max wall-clock ms the transaction body may run before Prisma rolls back. */
  timeoutMs: number;
  /** Max ms to wait for a free connection before the transaction even starts. */
  maxWaitMs: number;
}

/**
 * Opens a Prisma transaction binding ONLY the `app.user_id` GUC, then
 * invokes `fn` with the transaction client. This is the half-context used
 * while RESOLVING which workspace a request acts within: the workspace id
 * isn't known yet (that's what the resolver is computing), so only the
 * user GUC can be bound. The membership-scoped RLS policies still bite —
 * they gate on `app.user_id` — so a non-superuser connection sees only the
 * caller's own membership rows.
 *
 * Once the active workspace is known, tenant-scoped query paths should use
 * withWorkspaceContext (both GUCs) instead.
 *
 * SUFFICIENCY, table by table — and the caveat above is the whole trap
 * (MOTIR-2886). "The membership-scoped RLS policies still bite" is true and is
 * NOT the same claim as "the tables this context reads are admitted": a table
 * with no `app.user_id` arm returns ZERO ROWS here and raises nothing, so the
 * caller reads the denial as absence. Sufficient for `workspace`
 * (`workspace_membership_visible`), `workspace_membership`
 * (`membership_visible_active_or_own`), `organization` /
 * `organization_membership` (their `_active_or_own` arms), `user` (no RLS), and
 * — since `20260817140000` — `project`, whose `project_user_membership_read` arm
 * exists for exactly this context and is gated on `app.workspace_id` being
 * UNBOUND so it cannot widen a tenant request. NOT sufficient for any other
 * tenant table: `work_item`, `board`, `sprint` and the rest key purely on
 * `app.workspace_id`, and a resolution path that needs one of them is resolving
 * too much — finish resolving the workspace, then open withWorkspaceContext.
 * Before adding a read here, check `pg_policies` for an arm that reads
 * `app.user_id`, and check it for every table the query JOINS, not just the one
 * it targets.
 *
 * `options` raises Prisma's interactive-transaction budget — see
 * {@link TransactionBudget}. Omit it and the default 5s applies, which is what
 * every caller but the 2FA gate and the active-workspace resolver wants.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: TransactionBudget,
): Promise<T> {
  return retryOnceBeforeBody(
    (bodyStarted, settled) =>
      settled(
        db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
            return bodyStarted(() => fn(tx));
          },
          options ? { timeout: options.timeoutMs, maxWait: options.maxWaitMs } : undefined,
        ),
      ),
    'user',
  );
}
