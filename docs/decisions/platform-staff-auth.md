# ADR: The platform-staff auth model — `PlatformRole`, the `/admin` gate, and the audited cross-tenant read

- **Status:** Accepted (2026-08-17)
- **Story / Subtask:** 8.5 Production hardening + observability (MOTIR-658) · Subtask
  **MOTIR-729** (8.5.17 — authored as 10.1.2 under Story 10.1, re-filed into Story 8.5
  on 2026-08-17)
- **Supersedes / superseded by:** none
- **Consumed by:** **MOTIR-2896** (8.5.16 — the foundation: the `platformRole` column,
  `requirePlatformStaff()`, the `app/(admin)/admin/` segment, the `PlatformAuditLog`
  model + its write path), **MOTIR-1167** (8.5.11 — the day-1 health glance and the two
  day-1 support writes), **MOTIR-730** (10.1.3 — `platformReadService` and the
  platform-scoped repositories), **MOTIR-731 / MOTIR-732 / MOTIR-733** (10.1.4–10.1.6 —
  the estate overview, the usage/cost rollups, the drill-down), **MOTIR-734 / MOTIR-735**
  (10.1.7–10.1.8 — the gating tests), all of Story **10.2** (MOTIR-736) and Story
  **10.3** (MOTIR-745, in particular MOTIR-749's impersonation and MOTIR-751's audit-log
  view), and Story **MOTIR-7662** (the idea store — the ideas-endpoints token exception
  amended into §2 by MOTIR-7669, built by MOTIR-7673).

> Structured **Status → Context → Decision → Consequences**, with the load-bearing
> shapes pinned in explicit tables so every downstream subtask implements against one
> authoritative source (the convention `work-item-type-taxonomy.md` set and
> `status-derivation.md` follow).

> **Filed under `docs/decisions/`, not `docs/adr/`.** The MOTIR-729 card says
> `docs/adr/platform-staff-auth.md`; shipped reality is that all 36 of this repo's ADRs
> live in `docs/decisions/` and there is no `docs/adr/` directory anywhere in the tree.
> Decision-authority ladder rung 2 (shipped reality) outranks the card's path, so this
> ADR joins its siblings — the same call `status-derivation.md` recorded for MOTIR-1616.

---

## Context

Every access question motir-core answers today is **scoped to one tenant**. `MemberRole`
(Story 6.4) asks whether a user may view or edit inside a workspace or project;
`OrganizationRole` (Story 6.10) asks the same one tier up; the permission catalog
(`lib/permissions/catalog.ts`, 16 domains, none of them cross-tenant) enumerates 31
enforced keys and every one of them resolves against a project the actor already belongs
to. The isolation rule underneath all of it is the **404-not-403 guard**: a principal who
cannot browse a project gets the same answer as one asking about a project that does not
exist, because a 403 confirms existence and lets a caller enumerate real keys
(`lib/api/v1/planning/operations.ts`, `projectAccessService`, `sprintsService`).

Motir now needs the one surface that deliberately reads **across** that boundary: the
internal operator console at `/admin`, where moooon B.V. staff see every org, workspace,
project and user at once, plus the platform-wide usage rollup. Story 8.5 needs a subset of
it before launch (a system-health glance and two support actions); Epic 10 builds the rest
on top.

**A platform-staff persona does not exist in the shipped schema.** Verified on
`origin/main` @ `bd0584c5` (2026-08-17): `git grep -iE 'isPlatformStaff|requirePlatformStaff|platform_staff'`
hits only `design/platform-admin/design-notes.md` and `scripts/plan-seed/data/story-10.1.ts`;
there is no `/admin` route of any kind (the only `admin` path in the tree is
`tests/helpers/adminDb.ts`, the test-side owner client); `prisma/schema.prisma` carries
`OrganizationRole` and `MemberRole` and nothing else role-shaped. All of it is net-new.

**Why this is decided once, in writing, before any of it is built.** Four cards across
three stories each need the same primitive — MOTIR-2896's gate, MOTIR-1167's day-1
support tools, MOTIR-730's read layer, MOTIR-751's audit view. Left to themselves each
would make a small reasonable choice (a boolean here, an enum there, a 403 where a 404 was
meant, an audit row shaped for its own screen), and four reasonable choices make one
incoherent security boundary. MOTIR-2582 is the planning bug that established the single
owner; this ADR is what that owner builds to.

**The cited posture (rung 1 — the mirror, cited not asserted).** The multi-tenant RBAC
literature carves out exactly one exception to tenant isolation: _no global roles that
bypass tenant isolation EXCEPT a small, highly-controlled super-admin set_, with _admin
actions and cross-tenant access logged centrally_ as SOC-2-style evidence. The same shape
ships in the products Motir mirrors — GitLab's admin area, Sentry's and Stripe's internal
consoles, Supastarter's super-admin panel, Vercel's estate view. Story 10.1's module
header (`scripts/plan-seed/data/story-10.1.ts`) records the citation; this ADR implements
it rather than restating it as a claim of its own.

### The two facts about the runtime that shape everything below

1. **RLS exists and is currently inert in production.** motir-core ships 69 RLS-enabled
   tables whose policies read the per-transaction GUCs `app.user_id` / `app.workspace_id` /
   `app.project_id` / `app.system_admin` (`lib/workspaces/context.ts`,
   `lib/organizations/context.ts`). Production's `DATABASE_URL` still connects as a
   **BYPASSRLS owner**, so none of those policies execute today; MOTIR-2435 owns the
   cutover to the non-bypass `motir_app` role. **Consequence for this ADR: RLS is the
   structural backstop, never the gate.** The application-layer check is primary, exactly
   as `app/api/%5Ftest/_helpers.ts` already records for the tenant guard.
2. **`withSystemContext` is not a general escape hatch, and its failure is silent.** It
   binds one flag, `app.system_admin`, and **24 of the 69 RLS tables carry an arm that
   reads it — 45 do not**, including `work_item`, `workspace`, `workspace_membership`,
   `organization`, `sprint` and `comment`. A read of an unarmed table inside that context
   returns **zero rows and raises nothing**, so the caller reads a denial as absence
   (MOTIR-2880). The arms are also READ-side only by design: `withSystemContext` is
   deliberately **refused** by the tenant-root WRITE policies (MOTIR-2865).

---

## Decision

### 1. The staff identity — a `PlatformRole` enum on `User`, orthogonal to every tenant role

`User` gains **one nullable column**:

```prisma
/// Platform-staff standing — moooon B.V. operators ONLY. NULL means "not
/// platform staff", which is every customer account and the default for every
/// row. Deliberately SEPARATE from `MemberRole` (Story 6.4, workspace/project)
/// and `OrganizationRole` (Story 6.10, org): those describe a user's standing
/// INSIDE one tenant, this one describes standing OUTSIDE all of them, and no
/// value of either can produce a value of this. See
/// docs/decisions/platform-staff-auth.md.
platformRole PlatformRole? @map("platform_role")
```

```prisma
/// Degrees of platform-staff access (ADR: platform-staff-auth). A LADDER —
/// each value contains the one before it. Values are deliberately disjoint
/// from `MemberRole` / `OrganizationRole`'s (`owner` / `admin` / `member` /
/// `viewer`) so that a log line, a test fixture or a code review can never
/// confuse a tenant role with a platform one.
enum PlatformRole {
  /// Read the estate: the console, the audited drill-down, the health glance.
  support
  /// `support` + the day-1 support WRITES (password reset, account suspend).
  operator
  /// `operator` + Story 10.3 governance, and the only role that may grant or
  /// revoke `platformRole` itself.
  superadmin

  @@map("platform_role")
}
```

**Why an enum and not a boolean.** The card offered a flag as the default and an enum
"if degrees of staff access are foreseen". They are not foreseen — they are already
specified, in a merged design asset:

| Degree       | Already-specified consumer                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `support`    | The read-only console — Panels 2–6 of `design/platform-admin/`, and Panel 8's health glance (MOTIR-1167). The drill-down is explicitly read-only. |
| `operator`   | Panel 9's two day-1 writes — send password reset, suspend/unsuspend an account — each behind a confirm dialog with a required reason.             |
| `superadmin` | Story 10.3: credit grants (MOTIR-747), org suspend (MOTIR-748), write-level impersonation (MOTIR-749, _"possibly two-person"_), feature flags     |
|              | (MOTIR-750). The design calls this tier _"separate, heavily-gated"_ in as many words.                                                             |

A boolean would collapse three specified tiers into one on day 1 and be widened later —
and widening a boolean to an enum after three stories have written `if (user.isPlatformStaff)`
means revisiting every call site with no compiler help, which is the migration this
choice avoids. Nullable-with-no-`none`-member is deliberate for the same reason: "is
staff" is `platformRole !== null`, so there is no non-staff enum value that a future
`in`-list could accidentally admit.

**The load-bearing invariant, stated once so it can be cited:**

> **No tenant role, at any tier, in any combination, produces a `PlatformRole`.** There is
> no "org owner ⇒ platform staff" path, no role mapping, no inheritance, no
> `Math.max(tenantRole, platformRole)`. The column is written only by the paths §6 names.
> A workspace owner, an org owner and an anonymous visitor are all equally non-staff, and
> `/admin` answers all three identically.

Three concrete corollaries, each of which is a shape someone would otherwise build:

- **`PlatformRole` is NOT a permission-catalog key.** `lib/permissions/catalog.ts` is the
  project-scoped vocabulary; its 16 domains are all tenant-scoped and none may gain a
  `platform` domain. Putting one there would make it grantable, because
  `lib/tokens/grant.ts` grants keys from that catalog to API tokens — and a customer's PAT
  must never be able to carry platform standing.
- **`PlatformRole` is NOT in the session payload.** It is read from the database on each
  request that needs it (§2), not added to Better-Auth's `additionalFields`. A revoked
  operator must lose access on their next request, not on their next sign-in.
- **`PlatformRole` is NOT `app.system_admin`.** That GUC is the trusted-machine context —
  jobs, webhooks, the meter — and §3 keeps the two apart deliberately.

### 2. The gate — `requirePlatformStaff()`, server-side, answering 404

```ts
// lib/platform/auth.ts
export interface PlatformPrincipal {
  userId: string;
  email: string;
  role: PlatformRole;
}

/** Resolves the acting platform principal, or throws NotPlatformStaffError. */
export async function requirePlatformStaff(
  minimum: PlatformRole = 'support',
): Promise<PlatformPrincipal>;
```

| Property              | Decision                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where it lives        | `lib/platform/auth.ts` — a new `lib/platform/` domain, beside `lib/platform/errors.ts`. Not `lib/permissions/` (that is the tenant vocabulary, §1) and not `lib/auth/index.ts` (that is Better-Auth adapter wiring, which `CLAUDE.md` names as a framework boundary not to refactor). |
| Input                 | `getSession()` from `@/lib/auth` — nothing is read from the request, a header, a cookie claim or a client prop.                                                                                                                                                                       |
| Lookup                | The `platformRole` column, read fresh per request through `platformStaffRepository`, wrapped in React `cache()` for per-request dedupe (the shape `getSession` already uses).                                                                                                         |
| Ladder                | `minimum` compares on the `support < operator < superadmin` order. A read surface asks for `support`; MOTIR-1167's two writes ask for `operator`; 10.3 asks for `superadmin`.                                                                                                         |
| Failure               | Throws `NotPlatformStaffError` — one error for "no session", "session but no `platformRole`" and "role below `minimum`". The three are **indistinguishable** to the caller.                                                                                                           |
| Rendering the failure | A React Server Component / layout calls `notFound()`. A route handler returns the **same 404 body the tenant guard returns** for an unknown id. **No response, header, log line or redirect anywhere says `403`, `forbidden`, or names `/admin`.**                                    |

**`/admin` is deliberately NOT added to `proxy.ts`'s `config.matcher`.** The proxy's
optimistic check _redirects_ a cookie-less request to `/sign-in?next=<path>` — a response
that is visibly different from an unknown path's 404 and therefore proves `/admin` is
real. An anonymous request must instead reach the `(admin)` layout and be answered by
`requirePlatformStaff()` with the ordinary 404. This is the one place where following the
established authed-route pattern would break the posture, which is why it is written down
rather than left to be inferred. (It costs nothing: the layout's session read is the same
one every authed page already makes.)

The gate is asserted at **two** layers, and both are required: the `(admin)` layout (§4),
and **every platform-scoped service method** independently (§3). The layout protects the
pages; the service check protects against a future route handler, server action or job
that reaches the platform tier without passing through a layout.

> **⚠️ AMENDED 2026-10-07 (Story MOTIR-7662 · MOTIR-7669) — the ideas endpoints accept a staff
> member's personal access token.** Decided by the owner on 2026-10-06 and recorded as a published,
> approved decision page on [MOTIR-7661](https://app.motir.co/items/MOTIR-7661) (page
> `cmuxral3u00n2hvoih84no58b`, version 1). It amends the **Input** row above at ONE door; the table is
> deliberately left as it was, and every other clause of this section stands.
>
> - **What is allowed.** On `/api/platform/ideas/**` — and nowhere else — the gate also accepts
>   `Authorization: Bearer motir_pat_…`: a token `apiTokensService.verify` resolves, whose **OWNER**
>   currently holds a `platformRole` at or above the route's level — `operator` for every read and
>   write (list, add, update, retire, add a tag, record a research run), `superadmin` for the hard
>   `DELETE`. The owner's standing is read fresh from the database on every request, exactly as the
>   Lookup row says. **No token scope or permission is consulted and none is introduced**: the
>   owner's standing is the whole test, so a token carries no more platform reach than the person
>   who minted it holds at the moment it is used. A request with no bearer header falls back to the
>   operator's console session, unchanged.
> - **What stays forbidden.** Every `/admin` page, every console server action and every other
>   platform route keeps `getSession()` as the gate's only input — `requirePlatformStaff` itself
>   still reads no header, and never will. On the ideas endpoints a RUN token (a token bound to a
>   dispatch run), a revoked, expired or unknown token, a token of a suspended organization and an
>   OAuth connection are all refused, and so is a token whose owner is not staff at the route's
>   level. **Every refusal is the same 404 as the Failure row** — a token is never told which of
>   these it was.
> - **Where it is enforced.** A SEPARATE gate, `requirePlatformStaffForIdeas(req, minimum)` in
>   `lib/platform/ideasGate.ts`, beside `requirePlatformStaff` — never a flag on the shared gate,
>   which would leave every caller one argument away from accepting tokens. It may be imported only
>   from `app/api/platform/ideas/**`; `tests/platform/platformTokenBoundary.test.ts` fails when any
>   other file imports it, and proves a bearer header alone never satisfies `requirePlatformStaff`.
> - **The service-level check, on a token request.** The rule above that _"every platform-scoped
>   service method"_ asserts the gate independently cannot mean calling `requirePlatformStaff` on a
>   token request — that gate reads the session, which a token request does not have, so it would
>   refuse every legitimate call. The ideas service instead re-checks the principal the ideas gate
>   already resolved (its `role` against the method's level, e.g. `superadmin` for a delete), and
>   accepts that principal only as an argument the gate produced.
> - **The audit consequence (§3b).** Every write through the ideas endpoints appends its
>   `PlatformAuditLog` row in the same transaction, `targetKind: 'idea'`, and its `metadata` names
>   the credential beside the person: `credential: { kind: 'session' }`, or
>   `credential: { kind: 'token', apiTokenId }` with the token row's id. The token's secret, prefix
>   and hash are never recorded.
> - **Not a precedent.** A further platform route that needs a token is a new decision, not an
>   extension of this one.
>
> Consumed by Story **MOTIR-7662** (the idea store): **MOTIR-7673** (the gate and the boundary
> test), **MOTIR-7671** (the audit metadata), **MOTIR-7675** (the routes), **MOTIR-7677** (the
> platform-wide boundary tests).

### 3. Cross-tenant reads — an explicit platform tier, and an audit row written in the same transaction

The bypass is a **tier**, not a flag threaded through the existing services. A tenant-scoped
service must never grow a `skipTenantFilter` parameter: the whole point is that the set of
code that can read across tenants is small, named, and greppable.

| Layer         | Shape                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service       | `lib/services/platform*Service.ts` (MOTIR-730's `platformReadService` is the first). Every public method takes a `PlatformPrincipal` as its **first** parameter and re-asserts the ladder.                           |
| Repository    | `lib/repositories/platform*Repository.ts`. Reads only. Each method takes `tx: Prisma.TransactionClient` as a **required** parameter — not `tx?` — so a platform read cannot be issued on the unbound `db` singleton. |
| Context       | `withPlatformRead(...)` (below) — the only helper that binds `app.platform_staff`.                                                                                                                                   |
| Tenant filter | Deliberately absent. A platform repository method carries no `workspaceId` / `organizationId` predicate, and that absence is the thing being reviewed rather than a bug to be caught.                                |

#### 3a. `withPlatformRead` — the audit is structural, not a convention

This is the load-bearing paragraph of this ADR:

> **There is no way to open a platform context without naming, up front, what is about to
> be read.** The audit row is INSERTed as the first statement inside the same transaction
> as the read. A read that rolls back leaves no audit row, and a read that commits cannot
> exist without one. Auditing is therefore not a step a caller can forget — it is the
> price of the transaction.

```ts
// lib/platform/context.ts
export async function withPlatformRead<T>(
  principal: PlatformPrincipal,
  entry: PlatformAuditEntry, // action, targetKind, targetId, targetLabel
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T>;
```

It opens `db.$transaction`, `set_config('app.platform_staff', 'true', true)` and
`set_config('app.user_id', principal.userId, true)`, appends the `PlatformAuditLog` row,
then calls `fn`. It **does not** bind `app.workspace_id` or `app.project_id` — binding a
tenant GUC would narrow the very read this context exists to widen.

**Why a new `app.platform_staff` GUC rather than reusing `app.system_admin`.** Three
reasons, in ascending order of weight:

1. `withSystemContext`'s own docstring records that it is _never fed user input_ and binds
   a constant for machine paths. A platform-staff HTTP request is a human principal; the
   two belong to different classes of trust.
2. An audit of "who can read across tenants" that cannot separate a cron from an operator
   answers the SOC-2 question incorrectly.
3. **The decisive one.** The console needs `system_admin` READ arms on `work_item`,
   `workspace`, `workspace_membership`, `organization`, `sprint` and `comment` — six of
   the 45 tables that carry none. Adding them for the console's benefit would silently
   widen the **job runtime's** reach over the same six tables, because `withSystemContext`
   is what the job ledger, the webhook paths and the meters already bind. A separate GUC
   makes the console's new arms visible to the console and to nothing else.

The arms MOTIR-730 adds are **READ-side only**, mirroring the refusal MOTIR-2865 recorded
for `system_admin`: **no INSERT / UPDATE / DELETE policy on any tenant table gains a
`platform_staff` arm.** A platform principal that needs to write a tenant row (10.3's
governance actions) does it through a named service method that resolves the tenant and
opens a normal `withWorkspaceServiceContext` / `withOrgServiceWriteContext`, so the write
is confined to the one tenant it names.

**The read-only "View as tenant" session (design Panel 6) is not this mechanism.** It
opens the tenant's own app with writes disabled; it must be built as a _scoped tenant_
session, audited at open, and must never be implemented by binding `app.platform_staff`
into a tenant request path. Doing so would make every subsequent query in that request
cross-tenant. Ownership: MOTIR-733 for the read-only half, MOTIR-749 for the write-level
half.

#### 3b. `PlatformAuditLog` — the record shape, one table, four writers

```prisma
/// Every platform-staff action against the estate: the cross-tenant READS the
/// console performs (MOTIR-730), the day-1 support WRITES (MOTIR-1167), and
/// Story 10.3's governance actions (MOTIR-747/748/749/750). One shape, because
/// "who touched this tenant, and when?" cannot be answered by three tables.
/// APPEND-ONLY: the repository exposes create + reads and nothing else.
model PlatformAuditLog {
  id             String                  @id @default(cuid())
  /// The operator. Restrict on the FK: a user with audit rows on record cannot
  /// be hard-deleted (the `WorkItem.reporter` precedent).
  actorUserId    String                  @map("actor_user_id")
  /// The operator's role AT THE TIME. Snapshotted, not joined — a later grant
  /// or revoke must not rewrite what the record says happened.
  actorRole      PlatformRole            @map("actor_role")
  /// `<domain>.<verb>`, from the code-owned PLATFORM_AUDIT_ACTIONS union.
  action         String
  targetKind     PlatformAuditTargetKind @map("target_kind")
  /// Bare ids and a label, with NO @relation and NO FK — deliberately. The
  /// record must outlive the org, workspace, project or user it describes; a
  /// Cascade would delete exactly the evidence of what happened to a tenant
  /// that was then deleted, and a Restrict would make the audit log block
  /// account deletion. (CLAUDE.md's FK rule holds: no SQL FK, so no @relation.)
  targetId       String?                 @map("target_id")
  targetLabel    String?                 @map("target_label")
  organizationId String?                 @map("organization_id")
  /// REQUIRED for every write action, NULL for a read. Enforced in the service,
  /// not by the column, because reads legitimately have none.
  reason         String?
  metadata       Json?
  createdAt      DateTime                @default(now()) @map("created_at")

  actor User @relation(fields: [actorUserId], references: [id], onDelete: Restrict)

  @@index([organizationId, createdAt])
  @@index([actorUserId, createdAt])
  @@map("platform_audit_log")
}

enum PlatformAuditTargetKind {
  organization
  workspace
  project
  user
  platform

  @@map("platform_audit_target_kind")
}
```

**`action` is a `String` in the database and a closed union in TypeScript.** A Postgres
enum would need an `ALTER TYPE` migration for every action four stories add across two
epics; an audit vocabulary is open-ended by nature. The closedness that matters —
catching a typo at the call site — is bought by a code-owned
`PLATFORM_AUDIT_ACTIONS` const union in `lib/platform/auditActions.ts`, exactly as
`lib/permissions/catalog.ts` owns the permission keys in code rather than in the schema.

**RLS on `platform_audit_log`, stated as enforced state rather than intent.** The table
ships `ENABLE` + `FORCE ROW LEVEL SECURITY` and **one PERMISSIVE `FOR ALL` policy** in the
same migration that creates it:

```sql
CREATE POLICY platform_audit_log_platform_only ON platform_audit_log
  FOR ALL
  USING      (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');
```

Three things this fixes, each because getting it wrong has already cost this repo a card:

- **`FOR ALL`, not four verb-specific policies.** `tests/tenant-root-creation-rls.test.ts`
  asserts that every RLS-enabled table admits all four verbs; a table with SELECT and
  INSERT policies only fails it. Under a non-bypass role "no policy" is not "no gate" — it
  is a closed door (the MOTIR-2435 / `add_workspace_rls` lesson).
- **No tenant arm at all.** No value of `app.workspace_id` or `app.organization_id` admits
  a row. A tenant request cannot read the platform audit log even by accident.
- **Append-only is an APPLICATION property here, not a database one.** The policy admits
  UPDATE and DELETE _under a platform context_ because the totality guard requires the
  verbs to be covered; what makes the table append-only is that
  `platformAuditLogRepository` exposes `create` and reads and no mutator. Tamper-_evidence_
  (the hash chain) was deliberately not in this ADR — it is MOTIR-751's, and shipped there
  (the amendment below). Do not read this bullet as a claim that the row cannot be edited:
  it still can be, by anyone with write access to the table. What changed is that the edit
  is now DETECTED.

> **⚠️ AMENDED 2026-10-03 (MOTIR-751 · Story 10.3) — the table is now a HASH CHAIN.**
> `PlatformAuditLog` gained `seq` (unique, 1, 2, 3, … with no gaps), `prevHash` (the previous
> entry's hash; NULL only for #1) and `entryHash` = **SHA-256** over the row's canonical form
> — `["motir.platform_audit.v1", seq, createdAt, actorUserId, actorRole, action, targetKind,
targetId, targetLabel, organizationId, reason, metadata, prevHash]`, sorted-key JSON, defined
> in `lib/platform/auditChain.ts` and mirrored byte-for-byte in SQL by
> `platform_audit_entry_hash()` (migration `20261003000000_platform_audit_hash_chain`).
>
> - **No new table.** The design (MOTIR-746) and §7 below both said 10.3 extends this one;
>   the card's `AdminAuditEntry` sketch was superseded on the record.
> - **The append is still `withPlatformRead`'s first write.** It takes a transaction-scoped
>   advisory lock on the chain head, reads the head, and inserts `head.seq + 1` chained to
>   it — so concurrent appends serialize and the chain cannot fork. The cost, stated: the
>   lock is held to COMMIT, so platform transactions serialize behind one another; `fn`
>   must stay short and must never open a second platform context.
> - **Plain SHA-256, not an HMAC.** Verification then needs no secret — anyone with the
>   rows, or a database session running the SQL mirror, can recompute the chain. The
>   accepted limit is that someone with WRITE access can rewrite a SUFFIX of the chain and
>   re-hash it consistently, and can truncate the newest rows. Detecting that needs a hash
>   held outside the database: an HMAC key kept outside it, or periodically anchoring the
>   head `(seq, entryHash)` somewhere external. Both are **deferred hardening**, unowned.
> - **Rows that predate the chain were chained by the migration**, in `(created_at, id)`
>   order, with the same v1 form. Their hashes attest to their content as of 2026-10-03,
>   not before.
> - **`platformAuditService.verifyChain`** recomputes every hash and link and reports the
>   FIRST broken entry (`hash_mismatch` / `link_mismatch` / `seq_gap`) and how many follow
>   it; **`platformAuditService.searchEntries`** is the keyset-paged (50) search the
>   audit-log page (MOTIR-752) renders. Both are `superadmin` and both are themselves
>   audited, as `audit.verify` and `audit.read`.

The table is **not** added to that test's `DELIBERATELY_UNGUARDED` map: it ships a policy,
which is the other branch of the same either/or.

### 4. Where the admin app lives — `app/(admin)/admin/` inside motir-core

A gated route group inside motir-core, a **sibling of `(authed)` / `(auth)` / `(public)` /
`(onboarding)` / `(planning)`** — not a separate application, not a subdomain, not a
second Next app.

| Question              | Decision                                                                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route group           | `app/(admin)/admin/` — `admin/page.tsx` (overview), `admin/usage/page.tsx`, `admin/tenants/[scope]/[id]/page.tsx`, and the search API the top-bar box calls, per the merged design.                                                                        |
| Gate placement        | `app/(admin)/layout.tsx` calls `requirePlatformStaff()` before rendering anything, and calls `notFound()` on the throw. The layout is the single choke point for the pages.                                                                                |
| Middleware            | Not in `proxy.ts`'s matcher — §2.                                                                                                                                                                                                                          |
| API routes            | `app/api/admin/**`, each handler calling `requirePlatformStaff()` itself. A layout does not protect a route handler.                                                                                                                                       |
| Why inside motir-core | It reuses the shipped auth, the app shell, the design system and the `--el-*` / shape tokens; the design composes `Sidebar`, `Popover`, `CommandPalette`, `Segmented`, `Card` and `Pill` with **no bespoke admin CSS**. A second app would fork all of it. |
| Why open-core is fine | The console is operator UI over motir-core's own data; it holds no metering (§5) and no proprietary planning logic, so nothing about it belongs on the closed side (Principle #19).                                                                        |
| Entry affordance      | The staff-only "Platform admin" row in the TopNav avatar `Popover` (design Panel 1). **Absent** for non-staff — not disabled, not hidden by CSS: not rendered, so no markup names the route.                                                               |

### 5. Usage and cost are READ over the 7.1 boundary — motir-core holds no metering

motir-core does not gain a metering table, a credit ledger or a spend rollup. The planning
metering (7.12) and the coding-gateway spend (9.0) live in motir-ai, and the platform
console reads a **pre-aggregated platform rollup** over the 7.1 boundary — the same
leaf-client read-through `aiUsageService` already ships for the org dashboard
(`getOrgUsage` → `GET /v1/usage` in `lib/ai/motirAiClient.ts`), one level up.

- **Pre-aggregated, never a live scan (finding #57).** At platform scale the raw metering
  is billions of rows; the rollup is stored at multiple hierarchy levels
  (project → workspace → org → platform) and queried at the right granularity. The rollup
  table itself and its aggregation job are **MOTIR-732's** build, not this ADR's.
- **The enrichment split is motir-core's.** motir-ai returns ids; motir-core joins its own
  workspace / project names on before the DTO reaches the browser, exactly as
  `aiUsageService` does today.
- **A transport failure renders as an error, never as a zero.** The design draws this
  state explicitly (Panel 7d: _"no tenant has zero usage; the figures are simply not
  loaded"_), and `getOrgUsage` already maps a non-2xx to a typed error for that reason.
- **The open-core invariants hold unchanged.** Browsers never call motir-ai; only
  motir-core's server-side handlers do, over the private service channel
  (`docs/ai-boundary.md` invariant 1).

### 6. Who may GRANT platform standing, and how the first one exists

- **Only `superadmin` may grant or revoke `platformRole`,** and there is **no in-app grant
  UI before Story 10.3**. Nothing in MOTIR-2896, MOTIR-1167 or Story 10.1 renders a
  control that writes the column.
- **Development:** `db:seed` seeds one platform-staff user so `/admin` is reachable
  locally (MOTIR-2896's criterion).
- **Production:** the first row is written by an **operator script run against the
  production database** — there is no bootstrap endpoint, no environment variable, and no
  "first user becomes staff" rule, because each of those is a permanent hole left open to
  buy a one-time convenience.
- **That production step has no owning card, so this ADR does not defer it silently —
  it is filed as MOTIR-2932** (8.5.18, `blocked_by` MOTIR-2896). Story 8.5 is launch
  readiness and MOTIR-1167's day-1 operator tools are gated on staff existing in
  production; without that card the tools ship green and unreachable, which is the
  MOTIR-1916 shape (_five done cards and the fleet could not boot a runner_).

### 7. Read-mostly — the accurate allocation, which is not the one MOTIR-729 was authored with

Story 10.1's body says _"10.1 is read-mostly (its only writes are audit-log appends)"_.
**That remains true of Story 10.1 and is NOT true of the platform surface from day 1.**
`design/platform-admin/design-notes.md` — merged 2026-08-11, nearly two months after
MOTIR-729 was authored on 2026-06-15 — adds Panels 8 and 9 for Story 8.5 and allocates two
writes to **MOTIR-1167**, before Epic 10 runs at all. The card's fourth acceptance
criterion was amended on the record on 2026-08-17 to match; this table is the allocation
every consumer builds to.

| Action                                                           | Story / card                      | Minimum role | Reason required | Audited |
| ---------------------------------------------------------------- | --------------------------------- | ------------ | --------------- | ------- |
| Read the estate; drill into a tenant; the health glance          | 8.5 MOTIR-1167 · 10.1.4–6         | `support`    | no              | yes     |
| Send a password reset                                            | **8.5 MOTIR-1167**                | `operator`   | **yes**         | yes     |
| Suspend / unsuspend an **account**                               | **8.5 MOTIR-1167**                | `operator`   | **yes**         | yes     |
| Credit grants, plan / tier assignment                            | 10.3 MOTIR-747                    | `superadmin` | yes             | yes     |
| Suspend / reactivate an **organization**                         | 10.3 MOTIR-748                    | `superadmin` | yes             | yes     |
| Write-level impersonation (time-boxed)                           | 10.3 MOTIR-749                    | `superadmin` | yes             | yes     |
| Per-org feature flags / kill-switches                            | 10.3 MOTIR-750                    | `superadmin` | yes             | yes     |
| Classify an **organization** internal-billing / remove it        | **MOTIR-4565** (Story MOTIR-4337) | `superadmin` | **yes**         | yes     |
| Set the platform planning model per audience                     | **MOTIR-7227** (Story MOTIR-7220) | `superadmin` | **yes**         | yes     |
| Stop one organisation's fleet containers                         | **MOTIR-7317** (Story MOTIR-6905) | `superadmin` | **yes**         | yes     |
| Move an **Enterprise request** through its states                | **MOTIR-7608** (Story MOTIR-7602) | `operator`   | yes (service)   | yes     |
| The audit-log **VIEW**, searchable + tamper-evident (hash chain) | 10.3 MOTIR-751                    | `superadmin` | no              | yes     |
| Grant / revoke `platformRole`                                    | 10.3 (no card yet — §6)           | `superadmin` | yes             | yes     |
| Replay a dead letter, a workspace's or none, from `/admin/jobs`  | **MOTIR-9985** (Story MOTIR-9980) | `operator`   | yes (service)   | yes     |

Every one of those writes reuses **this** gate and **this** `PlatformAuditLog`. The day-1
rows are the plain append-only shape above; 10.3's hash chaining extends the same table
rather than introducing a second one.

> **⚠️ AMENDED 2026-09-05 (Story MOTIR-4337 · MOTIR-4565).** The row above the last one is the
> first member of this table from OUTSIDE Epic 10 and Story 8.5, and it is placed at
> `superadmin` deliberately rather than at the `operator` degree MOTIR-1167's two writes take:
> it changes what an organization is BILLED, which is the class every other `superadmin` row here
> already covers (credit grants, tier assignment, per-org flags). Its two actions —
> `org.internal_billing_set` and `org.internal_billing_unset` — join
> `PLATFORM_AUDIT_ACTIONS` in the same pull request, both `reason: 'required'`.
>
> It also ships the FIRST `platform_staff` policy arms on a tenant table —
> a SELECT arm and an UPDATE arm on `organization`, and on `organization` only.
> Those are carved from **MOTIR-730** on the record, which keeps
> `platformReadService` and every other table's arms; the boundary is written up in
> `docs/decisions/internal-billing-classification.md` §5. Until they landed, the
> _"deliberately does NOT decide"_ table's allocation meant a cross-tenant read of any
> tenant table from this tier returned zero rows and raised nothing.

> **⚠️ AMENDED 2026-10-02 (Story MOTIR-7220 · MOTIR-7227).** The planning-model row is the
> second member from outside Epic 10. Which model Motir plans with is one platform setting per
> audience — customer orgs, the meta org, internal orgs — stored in motir-ai, and changing one
> changes what every organization in that audience is planned with and charged per turn, so it
> takes `superadmin` like every other billing-class row. Its action, `ai.planner_model.set`, joins
> `PLATFORM_AUDIT_ACTIONS` as `reason: 'required'`, with `targetKind: 'platform'`, the audience as
> `targetId`, and `{ audience, fromModel, toModel }` as metadata. The page's READ is covered by the
> first row's `support` minimum; it reads no tenant row, so it writes no audit row of its own.

> **⚠️ AMENDED 2026-10-04 (Story MOTIR-7521 · MOTIR-7524).** The planning-model LIST — the models
> an audience may be set to, stored in motir-ai — is edited from the same page at the same degree:
> `superadmin` writes, `support` and up read. Its two actions, `ai.planner_model_list.add` and
> `ai.planner_model_list.remove`, join `PLATFORM_AUDIT_ACTIONS` as `reason: 'required'`, with
> `targetKind: 'platform'`, the model id as `targetId`, and `{ action, model }` as metadata. motir-ai's
> write runs inside the audited transaction, so a refusal (not qualified, the fallback, in use by an
> audience) leaves no row.

> **⚠️ AMENDED 2026-10-04 (Story MOTIR-7521 · MOTIR-7525).** The HOSTED-RUN model list — which
> models a hosted run may use, stored in core's `platform_run_model` — is curated at the same degree:
> `superadmin` writes, `support` and up read. `ai.run_model_list.add` and `ai.run_model_list.remove`
> join `PLATFORM_AUDIT_ACTIONS` as `reason: 'required'` (`targetKind: 'platform'`, the model id as
> `targetId`). A third, `ai.run_model_list.seed`, records the one-time initialisation the first
> console read performs: it is a write whose reason the service supplies, because the operator whose
> read triggered it chose nothing — only motir-ai's offer is ever seeded. The page's read names the
> projects that use each model, so it crosses every tenant's `project` row and is audited as
> `estate.read`.

> **⚠️ AMENDED 2026-10-02 (Story MOTIR-1408 · MOTIR-1411).** The planning-lessons page adds four
> writes from outside Epic 10: `ai.lesson.edit`, `ai.lesson.enable`, `ai.lesson.disable` and
> `ai.lesson.promote`, all `reason: 'required'`. Edit and enable/disable take `operator`, because
> they curate what a planner is told; promote takes `superadmin`, because it puts one customer's
> words in front of every other customer's planner, which is a disclosure decision. The lesson lives
> in motir-ai, which writes no audit row: core appends it, with `targetKind: 'platform'`, the lesson
> id as `targetId`, the owning organization as `organizationId` on a tenant lesson, and
> `{ lessonId, before, after }` (changed fields only) as metadata. Unlike the planning-model page,
> the READS here are audited: a tenant lesson is customer text, so opening the list or a detail is a
> cross-tenant read and writes one `estate.read` row.
> MOTIR-1463 adds a fifth, `ai.lesson.retention_set` (`superadmin`, reason required): the
> platform-wide lesson-retirement window N, with `lesson-retention` as `targetId` and
> `{ before: { days }, after: { days } }` as metadata.
>
> **⚠️ AMENDED 2026-10-03 (Story 10.3 · MOTIR-747) — credit & plan ops.** The "Credit grants, plan /
> tier assignment" row ships as `platformCreditOpsService` (`grantCredits` / `adjustCredits` /
> `setPlan` / `getLedger`) over motir-ai's `POST /v1/admin/credits`, `POST /v1/admin/tier` and
> `GET /v1/admin/ledger`. Three actions join `PLATFORM_AUDIT_ACTIONS`, all `reason: 'required'`,
> `targetKind: 'organization'`: **`org.credit_grant`** and **`org.credit_adjust`** (metadata
> `{ requestId, credits, balanceBefore, balanceAfter }`, the balances as the operator saw them) and
> **`org.plan_set`** (metadata `{ requestId, fromTierKey, toTierKey }`). The ledger read is an
> `estate.read` at `support`. motir-ai's write runs INSIDE the audited transaction, so a refusal or
> an unreachable credit service leaves no row; the residual case (motir-ai applied, core's commit
> failed) is recoverable because every write is idempotent on its `requestId`. Core gained no
> billing table.

> **⚠️ AMENDED 2026-10-03 (Story 10.3 · MOTIR-748) — organization suspension.** The "Suspend /
> reactivate an organization" row ships as `platformOrgLifecycleService.suspend` / `.reactivate`
> over three new `organization` columns (`suspended_at`, `suspended_reason`,
> `suspended_by_user_id` → `user`, `ON DELETE SET NULL`). Two actions join
> `PLATFORM_AUDIT_ACTIONS`, both `reason: 'required'`, `targetKind: 'organization'`:
> **`org.suspend`** and **`org.reactivate`**. Each locks the org row (`FOR UPDATE`) and refuses a
> no-op inside the audited transaction, so the refusal leaves no row. The EFFECT is enforced at the
> two gates every door already passes: `organizationsService.resolveWorkspaceAccess` (cookie pages,
> the cookie API, server actions, OAuth connections) and `apiTokensService.verify` (PATs, device
> credentials, run tokens), each raising `OrganizationSuspendedError` → 403
> `ORGANIZATION_SUSPENDED` on an API, a redirect to `/organization-suspended?org=<id>` on a page.
> It is raised only after membership is established, so a non-member keeps the no-leak 404. This
> tier is untouched: the console reads through `withPlatformRead`, never through the tenant gate,
> so staff keep full access to a suspended org. A suspend also stops the org's CI fleet after
> commit (`fleetStopService.stopOrganization(…, 'admin_stop')`, best-effort).

> **⚠️ AMENDED 2026-10-03 (Story 10.3 · MOTIR-750) — per-org kill-switches.** The "Per-org feature
> flags / kill-switches" row ships as `featureFlagService` over one new table, `org_feature_flag`
> (unique `(organization_id, key)`, overrides only — absence is the registry default, ON for every
> key). The keys are a CLOSED set: `ai_planning`, `hosted_runs`, `web_search`. Two actions join
> `PLATFORM_AUDIT_ACTIONS`, both `reason: 'required'`, `targetKind: 'organization'`:
> **`org.kill_switch_off`** and **`org.kill_switch_on`**, metadata `{ key, enabled }`. A flip locks
> the organization row (a first flip has no override row to lock) and refuses a no-op inside the
> audited transaction. The table carries NO tenant arm: `app.platform_staff` reads and writes,
> `app.system_admin` reads (the hot-path evaluation, which several actorless callers reach). A
> suspended org (MOTIR-748) evaluates every switch OFF without touching its overrides. The switches
> are not the internal-billing classification (MOTIR-4337), and MOTIR-751's log is their only log.

> **⚠️ AMENDED 2026-10-03 (Story 10.3 · MOTIR-749) — staff "View as" sessions.** The
> "Write-level impersonation (time-boxed)" row ships as `impersonationService` over one new table,
> `impersonation_session` (the card called it a grant; it is a SESSION with a start, a box and an
> end). The row holds the SHA-256 of a random token, the operator (`operator_user_id` → `user`) and
> the role they held, the operator's own Better-Auth session id it is bound to, the target account,
> its organization and the one workspace the session is pinned to (all `@relation`, `ON DELETE
CASCADE`), the mode (`read_only` · `full`), the reason, `started_at` / `expires_at`, and
> `ended_at` / `ended_by` (`operator` · `expiry` · `revoked`). RLS has no tenant arm:
> `app.platform_staff` reads and writes, `app.system_admin` reads (the request gate is actorless).
> **Both modes are `superadmin`** — a read-only session still reads a customer's data AS that
> customer, which no `support` read does — and every start carries a REQUIRED REASON and a time-box
> of 15 / 30 / 60 minutes (never extended; a new session asks for a new reason).
>
> - **How it is carried.** The operator keeps their own session; a start sets ONE more cookie,
>   `motir_staff_session` (httpOnly, lax, expiring with the box) holding the token. Nothing is
>   minted for the customer. `readSession` (`lib/auth`) — which every tenant door already goes
>   through — resolves it and substitutes the TARGET's identity, attaching the session and the
>   operator's own identity as `impersonation`. An ended / expired / revoked / unknown token makes
>   the request signed-out (fail closed), and the `(authed)` layout sends it through
>   `/api/staff-session/clear` to the ended page. The console never reads through it:
>   `requirePlatformStaff` reads the operator's raw session whenever the cookie is present.
> - **The chokepoint.** In `read_only` a MUTATING request — a Server Action on a tenant page, an
>   unsafe method on the cookie API, or a route handler reached with a browser `Origin` — is refused
>   with `ImpersonationReadOnlyError` (403 `IMPERSONATION_READ_ONLY`) before any service runs. In
>   `full` it is audited first. In either mode minting a credential (PAT, device approval, OAuth
>   consent: `IMPERSONATION_CREDENTIAL_REFUSED`) and accepting the customer's legal terms are
>   refused, and the customer's 2FA and re-consent holds are not applied to the operator.
> - **Four actions** join `PLATFORM_AUDIT_ACTIONS`, `targetKind: 'user'`, the target as `targetId`:
>   **`user.impersonation_start`** (`reason: 'required'`; metadata `{ mode, durationMinutes,
startedAt, expiresAt, targetUserId, targetEmail, organizationId, organizationName, workspaceId,
tokenHashPrefix }`), **`user.impersonation_end`** (metadata `{ sessionId, mode, endedBy,
startedAt, expiresAt, endedAt }`, plus `supersededBy` / `revokedBecause` when they apply),
>   **`user.impersonation_action`** — EACH mutating request of a `full` session, written BEFORE it
>   runs (metadata `{ sessionId, mode, method, path, serverAction }`; a failed write fails the
>   request) — and **`user.impersonation_view`**, each tenant page rendered in either mode
>   (metadata `{ sessionId, mode, path }`). The end and action rows carry the session's reason
>   (`reason: 'inherited'` — required, but supplied by the session rather than typed again).
> - **The vocabulary gains an explicit KIND.** Every action now declares `kind: 'read' | 'write'`
>   beside its reason policy; `PLATFORM_AUDIT_READ_ACTIONS` and the operator-write test derive from
>   it rather than from the reason policy, which `inherited` made ambiguous. `user.impersonation_view`
>   is a read; the other three are writes.
> - **Eligibility.** Refused (`ImpersonationTargetIneligibleError`), before the transaction and again
>   inside it: the operator's own account, any platform staff member, a suspended account, an account
>   with no workspace, and **an account whose organization is suspended** — a session into a
>   suspended org would show the operator an app its members cannot reach. An org suspended
>   MID-session shows the ordinary suspension refusal; an account suspended mid-session, an operator
>   who loses `superadmin`, or an operator who signs out REVOKES the session at the next request.
> - **Expiry.** The gate refuses a session from `expires_at` whatever else happens; the bar sends
>   the browser to the ended page at that instant; and `system.impersonation-expiry-sweep`
>   (`*/5 * * * *`, `latest`) writes the end row for a session nobody came back to.
>
> **Not built here**, named so it is not mistaken for done: the TWO-PERSON rule (§1's _"possibly
> two-person"_ — no second approver exists yet; the mandatory reason, the time-box and the
> per-action trail are the controls); Better-Auth's own `/api/auth/*` endpoints and the client
> `useSession()` still see the operator; individual API GETs inside a session are not audited (the
> page views are); and the app-wide "edit disabled in read-only" affordance — the server refuses
> the write today, the UI does not yet grey the control.

> **⚠️ AMENDED 2026-10-03 (Story MOTIR-6905 · MOTIR-7317).** The fleet-stop row is the third member
> from outside Epic 10. A stop cancels one organisation's GitHub Actions runs, destroys its CI
> containers, ends its hosted-agent runs and hibernates its agent instances, so it is destructive and
> cross-tenant and takes `superadmin`. Its action, `fleet.stop`, joins `PLATFORM_AUDIT_ACTIONS` as
> `reason: 'required'`, with `targetKind: 'organization'`, and is written AFTER the effects with what
> they achieved, failures included, as metadata. The preview it confirms from is a read under the
> first row's `support` minimum, audited as `estate.read`.

> **⚠️ AMENDED 2026-10-05 (Story MOTIR-7602 · MOTIR-7608).** The Enterprise-request row is the fourth
> member from outside Epic 10, and the first at `operator` since MOTIR-1167: a move changes where a
> sales conversation stands, not what an organisation is billed or can do, so it sits with the
> day-1 support writes rather than the `superadmin` rows. Its action, `enterprise_request.transition`,
> joins `PLATFORM_AUDIT_ACTIONS` as `reason: 'required'`, `targetKind: 'organization'`, metadata
> `{ requestId, from, to }`, written in the same transaction as a CONDITIONAL update (`WHERE id = ? AND
status = from`), so a move that loses a race to another staff member changes nothing and records
> nothing (`ENTERPRISE_REQUEST_STALE`). The reason is written by the service, not typed: the design
> gives a move no reason field. Listing and reading requests are the first row's `support` reads,
> audited as `estate.read`.

---

## What this ADR deliberately does NOT decide

Named with their owner, so no deliverable leaves the plan at the moment this card goes
done (the MOTIR-1916 rule):

| Not decided here                                                                                          | Owner                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Which tables get a `platform_staff` READ arm, and each policy's SQL                                       | MOTIR-730 (10.1.3)                                                                          |
| The `PlatformUsageDTO` shape and the platform rollup table + its job                                      | MOTIR-732 (10.1.5)                                                                          |
| The console's own layout, copy and i18n namespace                                                         | `design/platform-admin/` (merged) + MOTIR-2896                                              |
| The `PLATFORM_AUDIT_ACTIONS` vocabulary's initial members                                                 | MOTIR-2896 seeds it; each consumer extends it                                               |
| Hash-chained tamper evidence and the audit-log viewer                                                     | MOTIR-751 (10.3.6) — shipped; §3b's amendment. The page is MOTIR-752                        |
| Write-level impersonation's time-box, two-person rule and banner                                          | MOTIR-749 (10.3.4) — shipped (§7's amendment) except the two-person rule, which has no card |
| Whether `/admin` is reachable in a self-hosted build                                                      | open — no card; see Consequences                                                            |
| The production bootstrap of the first staff row                                                           | **MOTIR-2932** (8.5.18), filed by this ADR                                                  |
| The account-SUSPENSION **mechanism** — the `User` columns, the session revocation and the sign-in refusal | **MOTIR-1167** (8.5.11) — shipped there; added retroactively by **MOTIR-3641**              |

**⚠️ The row above is recorded, not deferred, and it is the one this table was missing.** §7 allocates
_"suspend / reactivate an account"_ to MOTIR-1167 and `design/platform-admin/design-notes.md` Panel 9
specifies the behaviour precisely (_"signed out of every session immediately and cannot sign back
in"_) — **both allocate the ACTION, and until MOTIR-1167 merged neither allocated the MECHANISM, which
did not exist.** On `origin/main` at `2852f19b2`: `User` carried no suspension column of any shape,
Better-Auth's `admin` plugin (which ships `banned` / `banReason` / `banExpires`) was not in
`lib/auth/index.ts`'s `plugins` array, and nothing anywhere refused a sign-in for a disabled account or
revoked another user's sessions. So the ADR and the card agreed the work was owned while neither owned
it, and the card was sealed at 5 points / 60 minutes against a delivered 35 files / +3,782 lines.

It ships today as `prisma/schema.prisma`'s `User.suspendedAt` / suspension-reason columns,
`lib/auth/accountSuspension.ts`, a `databaseHooks.session.create.before` hook in `lib/auth/index.ts`,
a `SELECT … FOR UPDATE` guard in `lib/repositories/platformUserRepository.ts`, and a copy branch on
**both** credential sign-in surfaces (`SignInCard.tsx`, `PublicAuthDialog.tsx`).

**The general rule this produced** (MOTIR-3641, in `motir-meta/prompts/plan-rules/phase-deepen.md` and
mirrored into `SHARED_PLANNING_RULES`): **a row of an allocation table names an ACTION, and a verb
presupposes the thing it acts on — so every row owes a line about the SUBSTRATE that action writes to.**
_"Send a password reset"_ had substrate (the shipped `requestPasswordReset` flow); _"suspend an
account"_ had none, and the two are indistinguishable in a table with an owner column and a role
column. Adding a row here is what that check produces when the answer is _absent_.

---

## Consequences

**Good.**

- One primitive, four consumers, no drift. MOTIR-2896 ships it; MOTIR-1167, MOTIR-730 and
  Story 10.3 consume it by name.
- The audit obligation cannot be forgotten, because it is the transaction's entry cost
  (§3a) rather than a line a reviewer has to notice is missing.
- The 404 posture is total: no route in the matcher, no menu row in the markup, no error
  body naming the surface, and one indistinguishable error for all three denial cases.
- The blast radius of the escape hatch is a directory. "What can read across tenants?" is
  answered by `ls lib/services/platform*Service.ts` plus the one context helper.

**Costs, accepted.**

- A three-value enum is more than day 1 strictly needs. The alternative was widening a
  boolean across three stories' call sites with no compiler help.
- A second cross-cutting GUC alongside `app.system_admin` is one more thing a policy author
  must know about. The alternative silently widened the job runtime over six tenant tables.
- Every platform read costs one INSERT. At operator traffic (a handful of humans) that is
  free; it is a real cost only if a platform read is ever put on a hot path, which is what
  the pre-aggregated rollup (§5) exists to prevent.

**Open, and honestly open.**

- **Self-hosting.** motir-core is GPL-3.0 and anyone may run it. A self-hosted operator
  granting themselves `superadmin` over their own single-tenant instance is harmless and
  arguably correct — but nothing decides whether `/admin` should be present, absent or
  degraded there, and no card owns the question. It does not block anything below Story
  10.3 and is recorded here rather than answered, so the next reader finds it named.
- **RLS is inert in production until MOTIR-2435 lands.** Everything in §3's RLS half is a
  backstop that does not execute yet. The application-layer gate is doing all of the work
  today, and a reader must not take the policy SQL above as evidence that the database is
  currently enforcing anything.

---

## References

- `design/platform-admin/design-notes.md` + `console.mock.html` — the merged design
  (MOTIR-728 for Panels 1–7, MOTIR-1166 for Panels 8–9). §§ "What this area is",
  "⚠️ Net-new capability", "Where it lives", "The three boundaries, in writing".
- `scripts/plan-seed/data/story-10.1.ts` — Story 10.1's module header: the locked
  platform-staff model and the cited multi-tenant security posture.
- `lib/workspaces/context.ts` · `lib/organizations/context.ts` — the GUC-binding context
  helpers and `withSystemContext`'s documented limits (MOTIR-2880, MOTIR-2865).
- `docs/rls-runtime-role-inventory.md` — what executes under the non-bypass role today.
- `tests/tenant-root-creation-rls.test.ts` — the four-verb totality guard and the
  `DELIBERATELY_UNGUARDED` set.
- `lib/permissions/catalog.ts` · `docs/decisions/permission-inventory.md` ·
  `docs/decisions/token-permissions.md` — the tenant permission vocabulary this is
  separate from.
- `lib/ai/motirAiClient.ts` · `lib/services/aiUsageService.ts` · `docs/ai-boundary.md` —
  the 7.1 read-through pattern §5 extends.
- `app/api/%5Ftest/_helpers.ts` — the shipped 404-not-403 precedent (`productionGate`).
- MOTIR-7661 — the published decision page (`cmuxral3u00n2hvoih84no58b`) behind §2's
  ideas-endpoints amendment.
- MOTIR-2582 · MOTIR-2897 — the planning bugs that consolidated ownership onto MOTIR-2896.
