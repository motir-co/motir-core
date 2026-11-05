import { adminDb as db } from './adminDb';

/**
 * Whatever issues a reset statement — the admin client by default, or a
 * transaction a caller opened around it. The E2E lane passes one so its
 * truncates run under `SET LOCAL lock_timeout` (MOTIR-7415,
 * `tests/e2e/_helpers/db-reset.ts`); every Vitest caller passes nothing.
 */
export type ResetExecutor = Pick<typeof db, '$executeRawUnsafe'>;

// ⚠️ These reset helpers run through the ADMIN client, never `@/lib/db`
// (MOTIR-2513). `TRUNCATE` requires table OWNERSHIP, which the non-bypass
// runtime role does not have and must never be granted — under
// `TEST_DB_APP_ROLE=1` the singleton is that role, so truncating through it
// would fail. Routing resets to the owner keeps the privilege where it belongs
// and leaves the code under test on the restricted connection. With the flag
// unset both clients point at the same role and this is a no-op change.

// Truncate every table the test suite touches, restarting identity counters
// and cascading FK rows. Cheaper than `migrate reset` and idempotent — each
// test's beforeEach calls this so test ordering doesn't matter. The CASCADE
// + the FK chain means we only need to name the roots; child rows go with
// them. workspace_membership FKs against both user and workspace, so listing
// user + workspace + the three auth-token tables is sufficient.
//
// Story 6.10: `organization` is now the tenant ROOT *above* workspace
// (workspace.organizationId → organization). Truncating workspace does NOT
// cascade UP to its parent org, so the org must be named explicitly — otherwise
// org rows (one per workspace, minted by createWorkspace) leak across tests and
// collide on the globally-unique `organization.slug`, suffixing slugs that
// should be clean. organization_membership cascades from both organization and
// user; it is named too for clarity.
// `idea_draft` (Subtask 7.22.2 / MOTIR-1458) is an ANONYMOUS table with no FK to
// user/workspace, so a workspace/user CASCADE never reaches it — name it here
// explicitly so its short-lived rows don't leak across tests.
//
// `public_hostname_reservation` (Bug MOTIR-4366) is the same class and joins the
// same statement rather than getting a helper of its own — the raw-statement
// ratchet in `tests/rls/test-singleton-statement-guard.test.ts` only ever falls,
// and a table added to an existing TRUNCATE costs it nothing. It carries no FK
// to workspace DELIBERATELY: the row exists because the workspace was deleted,
// so a cascade reaching it would be the defect it repairs. That is why it must
// be named here — and, as with `code_graph_offboarding`, a row surviving
// `truncateAuthTables` would be the table's load-bearing property observed. Left
// unnamed, one suite's reserved digest refuses the next suite's claim of the
// same label, in a file that has nothing to do with either.
//
// `oauth_client` (MOTIR-6984) is named for the same reason: a dynamically
// registered client carries no user, so no cascade from `user` reaches it, and a
// client left behind would decide the next OAuth sweep suite's counts.
//
// `platform_run_model` / `platform_run_model_list` (MOTIR-7525) are platform-wide:
// a seeded row has no user, and an added one only NULLs its adder when the user
// goes, so neither is reached by the cascade — and a marker left behind would
// stop the next suite's first read from seeding.
//
// `idea` / `idea_tag` (Story MOTIR-7662) are platform content with no FK to any
// tenant or user, so no cascade reaches them; `idea_evidence` and
// `idea_tag_assignment` go with them, and `idea_research_run` with `user`. The
// SEEDED ideas go too — a suite that needs today's 15 re-applies the seed
// migration (`tests/ideas/_helpers.ts`), which is idempotent by contract.
//
// `fleet_shard` (Story MOTIR-8953 · MOTIR-8966) is platform bookkeeping with no
// tenant FK, so no cascade reaches it. Left behind, one suite's ACTIVE account
// naming a GitHub org makes the next suite's first establish assign that org and
// create its repositories there, in a file that never mentions fleet accounts.
// `github_runner_call_event` (MOTIR-8969), the runner-call ledger, is the same
// class: one suite's calls would read as the next suite's GitHub headroom.
// `github_webhook_delivery` (MOTIR-10425), the webhook inbox, too: keyed on the
// delivery GUID alone, so one suite's processed row would make the next suite's
// delivery of the same fixture GUID a `duplicate` that never runs.
export async function truncateAuthTables(executor: ResetExecutor = db): Promise<void> {
  await executor.$executeRawUnsafe(
    'TRUNCATE TABLE "organization_membership", "organization", "workspace_membership", "workspace", "session", "account", "github_identity", "import_source_identity", "verification", "email_change_request", "idea_draft", "public_hostname_reservation", "oauth_client", "platform_run_model", "platform_run_model_list", "idea", "idea_tag", "fleet_shard", "github_runner_call_event", "github_webhook_delivery", "user" RESTART IDENTITY CASCADE',
  );
}

// Rows from SYSTEM jobs carry a null workspace_id, so they are NOT reached by
// truncating "workspace" CASCADE. The jobs suite truncates these tables directly
// between tests.
//
// ⚠️ ALL FIVE IN ONE STATEMENT, and the Postgres engine's three joined the
// ledger's two rather than getting a helper of their own (MOTIR-3420/3426).
// Three reasons, in order of weight:
//
//   1. They are ONE concern — "job rows the workspace cascade does not reach" —
//      and every suite that wants one wants the others.
//   2. `job_queue` cascades from `job_event` and `job_step` from `job_queue`, so
//      a single CASCADE statement is enough; naming all five only saves the FKs
//      from having to do work an untenanted parent could not do anyway.
//   3. `tests/rls/test-singleton-statement-guard.test.ts` RATCHETS the number of
//      raw `$executeRaw*` statements under `tests/`, and that ratchet only ever
//      falls. A sixth helper would have added one more — and a ceiling raised to
//      admit it is the one move that guard exists to refuse.
//
// ⚠️ CALL IT IN `afterEach` AS WELL AS `beforeEach` when a suite writes these
// rows. A table outside the workspace cascade that is only cleared BEFORE each
// test leaves its last test's rows in the worker's database for whatever file
// that worker picks up next — which surfaces as a failure in an unrelated suite,
// nowhere near the diff that caused it.
export async function truncateJobRuns(executor: ResetExecutor = db): Promise<void> {
  // `job_supervision` (MOTIR-3826) is named EXPLICITLY even though it would be
  // reached by the `CASCADE` from `job_queue` — the same call this list already
  // makes for `job_step`. A truncate list that relies on a cascade is one FK
  // change away from silently stopping, and a supervision row that leaks into
  // the next test is a row the sweep's `listStalled` will find.
  //
  // `email_delivery` (MOTIR-3513) joins this list rather than getting its own
  // helper: it is written by the `email.send` job on the same lane as these
  // rows, and it carries the same untenanted case — a password-reset delivery
  // has a NULL workspace_id, so a `TRUNCATE "workspace" CASCADE` never reaches
  // it. Any suite that sends an email writes one, so clearing it here is what
  // keeps those rows from leaking into the next test.
  await executor.$executeRawUnsafe(
    'TRUNCATE TABLE "job_run", "job_run_dlq", "job_event", "job_queue", "job_step", "job_supervision", "email_delivery", "job_dlq_standing_filing" RESTART IDENTITY CASCADE',
  );
}

// `code_graph_offboarding` (MOTIR-2166) carries NO foreign key to workspace or
// project — deliberately, so a pending removal OUTLIVES the workspace-delete
// cascade that makes it necessary (`docs/decisions/code-graph-index-fleet.md`
// §14.5). The consequence for tests is the same one `idea_draft` and `job_run`
// have: a `TRUNCATE "workspace" CASCADE` never reaches it, so a suite that writes
// these rows must clear them explicitly or they leak into the next test.
//
// That leak is worth understanding rather than routing around: it is the table's
// load-bearing property, observed. A row that survived `truncateAuthTables` is a
// row that will survive a customer's workspace delete.
export async function truncateCodeGraphOffboarding(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE "code_graph_offboarding" RESTART IDENTITY CASCADE');
}

// `rate_limit_counter` (Subtask 8.5.9 / MOTIR-1165) is the same class as
// `idea_draft` / `job_run` / `code_graph_offboarding`: it carries NO FK to
// workspace or user — deliberately, because the surfaces it protects (sign-in,
// sign-up, password reset, public writes) are limited BEFORE any tenant is known
// (ADR §7) — so a `TRUNCATE "workspace" CASCADE` never reaches it.
//
// ⚠️ A suite that exercises ANY limited surface must clear it between tests, or
// the counters carry over: the second test's first request arrives with the first
// test's tally already spent, which shows up as a 429 nobody asked for in a case
// that has nothing to do with rate limiting.
export async function truncateRateLimitCounters(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE "rate_limit_counter"');
}
