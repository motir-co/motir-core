/**
 * The platform audit vocabulary — `docs/decisions/platform-staff-auth.md` §3b.
 *
 * `platform_audit_log.action` is a `String` in the database and a CLOSED UNION
 * here. That split is the decision, not an oversight: an audit vocabulary is
 * open-ended by nature (four cards across two epics each add verbs), and a
 * Postgres enum would need an `ALTER TYPE` migration for every one of them. The
 * closedness that actually matters — catching a typo at the call site — is
 * bought in code, exactly as `lib/permissions/catalog.ts` owns the permission
 * keys rather than the schema.
 *
 * ⚠️ THIS TABLE IS MEANT TO GROW, and each consumer extends it. MOTIR-2896
 * seeds it with the actions the foundation itself performs; MOTIR-730's
 * cross-tenant reads, MOTIR-1167's two day-1 support writes and Story 10.3's
 * governance actions each add their own. **The ADR's §7 table is the
 * allocation** — which card owns which action, at which minimum role, and
 * whether a reason is required — and it is the thing to read before adding a
 * member here.
 *
 * Naming: `<domain>.<verb>`, lowercase, dot-separated. The domain is the
 * SUBJECT of the action, not the screen it was performed from.
 */
export const PLATFORM_AUDIT_ACTIONS = {
  /**
   * A platform-staff principal opened the operator console. The one action the
   * foundation itself performs — a cross-tenant surface being ENTERED, which is
   * the first thing a SOC-2-style reviewer asks the log for ("who was in the
   * console, and when?").
   */
  'console.open': { kind: 'read', reason: 'never' },
  /**
   * A read across the tenant boundary, named by its target. MOTIR-730's
   * `platformReadService` is the first writer; the entry it passes carries the
   * tenant it resolved, so this one member covers org / workspace / project /
   * user reads without a member per tier.
   */
  'estate.read': { kind: 'read', reason: 'never' },
  /**
   * The day-1 system-health glance was read (MOTIR-1167, design Panel 8).
   *
   * Its own member rather than `estate.read`, because it reads no tenant row at
   * all — the six signals come from the job ledger, the dead-letter set and the
   * deployment's own configuration. A trail that called this "a read of the
   * estate" would answer "which tenants did this operator look at?" with a page
   * view that looked at none.
   */
  'health.read': { kind: 'read', reason: 'never' },
  /**
   * One account was opened in the operator drill-down (MOTIR-1167, design
   * Panel 9) — the read the design's `--el-info` banner tells the operator, in
   * the surface itself, is being recorded.
   */
  'user.read': { kind: 'read', reason: 'never' },
  /**
   * A password-reset link was sent to an account's own address at an operator's
   * request. The FIRST `required`-reason member (ADR §7): a write, and one whose
   * whole justification lives outside Motir — somebody wrote in and said they
   * could not get back into their account.
   *
   * It does not set a password and it does not read one: it triggers the shipped
   * `requestPasswordReset` flow, so the link goes to the account holder and the
   * operator never holds a credential.
   */
  'user.password_reset_sent': { kind: 'write', reason: 'required' },
  /** An account was suspended — every session revoked, no new one issuable. */
  'user.suspend': { kind: 'write', reason: 'required' },
  /**
   * A suspension was lifted. `required` like its twin, and for a reason worth
   * saying out loud: the trail has to answer "why is this account open again?"
   * as readably as it answers why it was closed, and an unsuspend with no
   * reason is the half of the pair somebody would be tempted to leave blank.
   */
  'user.unsuspend': { kind: 'write', reason: 'required' },
  /**
   * An organization was classified INTERNAL BILLING (MOTIR-4565) — from now on
   * every debit it incurs is paired, in the same transaction, with an
   * offsetting credit, so it is charged exactly like a customer and made whole
   * (`docs/decisions/internal-billing-classification.md` §2).
   *
   * `required`, and joining ADR §7's allocation table at the `superadmin`
   * degree. The domain is `org` rather than `billing` because the SUBJECT of
   * the action is the organization, not the screen it was performed from —
   * this file's own naming rule.
   */
  'org.internal_billing_set': { kind: 'write', reason: 'required' },
  /**
   * The classification was removed. `required` like its twin, and for the
   * reason `user.unsuspend` gives: the trail has to answer "why is this org
   * being billed again?" as readably as it answers why it stopped, and the
   * unset is the half of the pair somebody would be tempted to leave blank.
   *
   * Removing it leaves every ledger row exactly where it is — the debits and
   * their offsets are history, not state.
   */
  'org.internal_billing_unset': { kind: 'write', reason: 'required' },
  /**
   * The platform PLANNING MODEL for one audience was changed (Story MOTIR-7220 ·
   * MOTIR-7227) — which model plans for every customer org, the meta org or the
   * internal orgs, from the next planning job on.
   *
   * `required`, at the `superadmin` degree of ADR §7: it changes what every
   * organization in the audience is planned WITH, and so what each is charged
   * per turn. Target is `platform` with the audience as `targetId`, because the
   * setting belongs to no single tenant; `metadata` carries
   * `{ audience, fromModel, toModel }`. The domain is `ai` — the SUBJECT is the
   * planner, not the console screen.
   */
  'ai.planner_model.set': { kind: 'write', reason: 'required' },
  /**
   * A model was ADDED to, or REMOVED from, the platform PLANNING-MODEL LIST
   * (Story MOTIR-7521 · MOTIR-7524) — the set of models an audience may be set
   * to, stored in motir-ai.
   *
   * `required`, at `superadmin`, for `ai.planner_model.set`'s reason: the list
   * bounds what every audience can be planned with, and so what every
   * organization can be charged per turn. Target is `platform` with the model
   * id as `targetId` (the list belongs to no tenant); `metadata` carries
   * `{ action, model }`.
   */
  'ai.planner_model_list.add': { kind: 'write', reason: 'required' },
  'ai.planner_model_list.remove': { kind: 'write', reason: 'required' },
  /**
   * The platform HOSTED-RUN MODEL LIST (Story MOTIR-7521 · MOTIR-7525) — which
   * models a hosted run may use, stored in core (`platform_run_model`).
   *
   * `add` / `remove` are a superadmin's, `required`, at `superadmin`: the list
   * bounds what every project can run with. Target is `platform` with the model
   * id as `targetId`; `metadata` carries `{ action, model }`.
   *
   * `seed` is the ONE-TIME initialisation the first console read after deploy
   * performs, writing motir-ai's offer as the list. It is a write, so it is
   * recorded; its reason is not typed by the operator whose read triggered it
   * but written by the service (the read cannot choose WHAT is seeded — only
   * motir-ai's offer is), and `metadata` carries `{ models }`.
   */
  'ai.run_model_list.seed': { kind: 'write', reason: 'required' },
  'ai.run_model_list.add': { kind: 'write', reason: 'required' },
  'ai.run_model_list.remove': { kind: 'write', reason: 'required' },
  /**
   * Credits were GRANTED to an organization (MOTIR-747 · 10.3.2, design Panel
   * 2a/2b) — a positive `grant` row appended to its motir-ai ledger, the
   * support / goodwill path. Never a `top_up` (that is the customer's checkout,
   * Epic 8) and never a Stripe object.
   *
   * `required`, at the `superadmin` degree of ADR §7's "credit grants" row.
   * `metadata` carries `{ requestId, credits, balanceBefore, balanceAfter }` —
   * the two balances as the operator SAW them when the action was taken, the
   * planner-model row's from/to convention; `requestId` is motir-ai's idempotency
   * key and joins this row to the ledger row's `externalRef`
   * (`grant:staff:<requestId>`).
   */
  'org.credit_grant': { kind: 'write', reason: 'required' },
  /**
   * An organization's balance was CORRECTED by a signed `adjustment` row
   * (MOTIR-747, design Panel 2c) — a billing mistake, not goodwill. Same degree,
   * same metadata shape as `org.credit_grant`; `credits` is signed.
   */
  'org.credit_adjust': { kind: 'write', reason: 'required' },
  /**
   * An organization's AI PLAN TIER was assigned by an operator (MOTIR-747, design
   * Panel 2d). `metadata` carries `{ requestId, fromTierKey, toTierKey }`, the
   * from-tier as the operator saw it. It grants nothing and changes no Stripe
   * subscription — a paid org's next subscription event still sets its tier.
   */
  'org.plan_set': { kind: 'write', reason: 'required' },
  /**
   * An organization was SUSPENDED (MOTIR-748, design Panel 3a) — the
   * non-payment / abuse lever: every member of every workspace under it is
   * refused at the access gate on every door until it is reactivated. Nothing is
   * deleted. `targetKind: 'organization'`, the org as `organizationId`.
   */
  'org.suspend': { kind: 'write', reason: 'required' },
  /**
   * A suspended organization was REACTIVATED (MOTIR-748, design Panel 3c) — its
   * members are admitted again on their next request. Kill-switches keep their
   * own state across a suspension; reactivating does not touch them.
   */
  'org.reactivate': { kind: 'write', reason: 'required' },
  /**
   * A per-org KILL-SWITCH was turned OFF (MOTIR-750) — `ai_planning`,
   * `hosted_runs` or `web_search`, named in `metadata.key` with
   * `metadata.enabled: false`. Takes effect on the org's next request.
   */
  'org.kill_switch_off': { kind: 'write', reason: 'required' },
  /** A per-org kill-switch was turned back ON (MOTIR-750), `metadata.key`. */
  'org.kill_switch_on': { kind: 'write', reason: 'required' },
  /**
   * A superadmin STARTED a staff "View as" session (MOTIR-749, design Panel 4) —
   * seeing, or acting in, a tenant as one of its users. `required`, at the
   * `superadmin` degree of ADR §7. `targetKind: 'user'` (the account viewed as),
   * the org as `organizationId`; `metadata` carries
   * `{ sessionId, mode, durationMinutes, expiresAt, targetUserId, targetEmail,
   * organizationId, workspaceId }`.
   */
  'user.impersonation_start': { kind: 'write', reason: 'required' },
  /**
   * A staff session ENDED (MOTIR-749). Its reason is the SESSION's — the operator
   * typed it once, at start, and the row carries a copy (`inherited`), so the
   * trail answers "why was staff in this account?" on the end row too.
   * `metadata.endedBy` is `operator` (Exit session, or a new session replacing
   * it), `expiry` (the time-box ran out — noticed at the gate or by the sweep)
   * or `revoked` (the operator lost `superadmin` or signed out, or the account /
   * organization was suspended). The actor is the session's operator in every
   * case, so the end sits in the same operator's trail as its start.
   */
  'user.impersonation_end': { kind: 'write', reason: 'inherited' },
  /**
   * A page was OPENED inside a staff session (MOTIR-749) — one row per page
   * render, read-only and full access alike, `metadata` `{ sessionId, mode,
   * path }`. A read, so reason-free; the session's reason is on its start row,
   * joined by `sessionId`. The design's ended-page promise — "the session and
   * everything you opened in it are in the audit log" — is these rows.
   */
  'user.impersonation_view': { kind: 'read', reason: 'never' },
  /**
   * A MUTATING request (a Server Action, or a non-GET API call) made inside a
   * FULL-ACCESS staff session (MOTIR-749) — written BEFORE the request runs, so
   * nothing can be changed as a customer without the row "run by staff X as
   * user Y, reason Z" existing first. `inherited` reason; `metadata`
   * `{ sessionId, mode, method, path, serverAction }`. A read-only session never
   * produces one: its mutating requests are refused at the same chokepoint.
   */
  'user.impersonation_action': { kind: 'write', reason: 'inherited' },
  /**
   * The audit log ITSELF was searched (MOTIR-751 — the page is MOTIR-752,
   * design Panel 6). Reading the record of who touched the estate is a platform
   * read like any other, so it leaves a row: "who looked at the audit log, and
   * for what?" is a question the log has to be able to answer about itself.
   * `targetKind: 'organization'` with the org when the search was narrowed to
   * one tenant, `platform` otherwise; `metadata` carries the filters.
   */
  'audit.read': { kind: 'read', reason: 'never' },
  /**
   * The hash chain was VERIFIED (MOTIR-751, design Panels 6/7's "Verify
   * again"). A read — it recomputes and changes nothing — recorded with its
   * range in `metadata`, so a broken-chain finding can be traced to the check
   * that surfaced it.
   */
  'audit.verify': { kind: 'read', reason: 'never' },
  /**
   * The four PLANNING-LESSON curate acts (Story MOTIR-1408 · MOTIR-1411) — what
   * the planner is told, edited, switched off or on, or promoted out of one
   * organisation into the global corpus every planner reads.
   *
   * `required`, all four: each changes what a planner is told from its next job,
   * and a promote moves one customer's words in front of every other customer.
   * Edit and enable/disable are `operator`; promote is `superadmin` (a disclosure
   * decision, not a curation one). motir-ai stores the lesson and writes NO
   * audit row; core appends this one. Target is `platform` with the lesson id as
   * `targetId` (the planner-model precedent — a lesson is not a core entity, so
   * no new target kind), `organizationId` the owning org on a tenant lesson, and
   * `metadata` carries `{ lessonId, before, after }`, the changed fields only.
   */
  'ai.lesson.edit': { kind: 'write', reason: 'required' },
  'ai.lesson.enable': { kind: 'write', reason: 'required' },
  'ai.lesson.disable': { kind: 'write', reason: 'required' },
  'ai.lesson.promote': { kind: 'write', reason: 'required' },
  /**
   * The LESSON-RETIREMENT WINDOW N was changed (MOTIR-1463) — how many days a
   * lesson may go without recurring before every organisation's planner stops
   * being told it. `required`, at `superadmin`: one platform-wide rule. Target
   * is `platform` with `lesson-retention` as `targetId`; `metadata` carries
   * `{ before: { days }, after: { days } }`.
   */
  'ai.lesson.retention_set': { kind: 'write', reason: 'required' },
  /**
   * One organisation's fleet containers were STOPPED by a platform admin (Story
   * MOTIR-6905 · MOTIR-7317): its GitHub Actions runs cancelled and its CI
   * containers destroyed, its hosted-agent runs ended, its agent instances
   * hibernated. Index containers are left to end on their own.
   *
   * `required`, at the `superadmin` degree of ADR §7: destructive and
   * cross-tenant. Target is `organization`. Written AFTER the effects, with what
   * they achieved — failures included — as `metadata`, so a partial stop is still
   * on the record as exactly as partial as it was.
   */
  'fleet.stop': { kind: 'write', reason: 'required' },
  /**
   * The platform setting "Run Motir's private repositories' CI on the fleet" was
   * turned ON or OFF for one (project, connected org) pair (Story MOTIR-8699 ·
   * MOTIR-8714): ON writes the org's `MOTIR_RUNNER` Actions variable so new jobs
   * request a fleet runner; OFF deletes it so they fall back to GitHub-hosted.
   *
   * `required`, at the `superadmin` degree of ADR §7: it moves where another
   * GitHub org's CI runs and what Motir pays for it. Target is `platform` with
   * `<projectId>:<org>` as `targetId` (the setting belongs to the platform, not
   * the tenant); `metadata` carries `{ projectId, projectKey, org, from, to,
   * variableOutcome }`. Written only for a flip that changed something. The
   * domain is `fleet` — the SUBJECT is the fleet, not the console screen.
   */
  'fleet.org_ci.enable': { kind: 'write', reason: 'required' },
  'fleet.org_ci.disable': { kind: 'write', reason: 'required' },
  /**
   * The agent hoster's Fly↔AWS switch was turned ON (new agent instances are
   * placed on an account of the agent-hoster AWS pool) or OFF (new ones go back
   * to Fly) from /admin/fleet-settings › Agent hosting (MOTIR-9503). Agents that
   * already exist are not moved either way.
   *
   * `required`, at the `superadmin` degree of ADR §7: it moves where every
   * tenant's new agents run and what Motir pays for them. Target is `platform`
   * with the fleet kind (`agent_instance`) as `targetId`; `metadata` carries
   * `{ fleetKind, from, to }`. Written only for a flip that changed something.
   */
  'fleet.agent_hosting.enable': { kind: 'write', reason: 'required' },
  'fleet.agent_hosting.disable': { kind: 'write', reason: 'required' },
  /**
   * A fleet ACCOUNT was added to, or resumed in, a fleet kind's pool by
   * `fleet-admin add-shard` (Story MOTIR-8953 · MOTIR-8967) — one row per run,
   * written after its steps, carrying `{ fleetKind, provider, steps,
   * pendingManualSteps }` and never a credential value. `fleet.shard.limits` is
   * `refresh-limits`: an account's quota re-read after a raise, `{ from, to }`.
   *
   * `required`, at the `superadmin` degree of ADR §7, with a reason the SERVICE
   * writes: the command is run from a shell with no reason field, the row says which command and which account, and
   * a write is never `never`. Target is `platform` with the account's id as
   * `targetId` and its name as `targetLabel`; the domain is `fleet`.
   */
  'fleet.shard.add': { kind: 'write', reason: 'required' },
  'fleet.shard.limits': { kind: 'write', reason: 'required' },
  /**
   * The account controls beside add-shard (Story MOTIR-8953 · MOTIR-8972):
   * `set-ceiling` (an admission ceiling set or cleared), `disable` and `enable`.
   * Same target and degree as `fleet.shard.add`; `metadata` is `{ fleetKind,
   * from, to }`. `disable`'s reason is the operator's `--reason`; the other two
   * carry the command the service writes.
   */
  'fleet.shard.ceiling': { kind: 'write', reason: 'required' },
  'fleet.shard.disable': { kind: 'write', reason: 'required' },
  'fleet.shard.enable': { kind: 'write', reason: 'required' },
  /**
   * One POOL GROWTH (Story MOTIR-9362 · MOTIR-9461): an account crossed 70% of
   * its live granted vCPU quota, and the growth pass promoted the kind's ready
   * spare and/or created the next account. One row per growth, beside its
   * `fleet_growth_event`, written by the pass as Motir's system account
   * (`fleetAutomationPrincipal`) with a reason the service writes. Target is
   * `platform` with the triggering account's id and name; `metadata` is
   * `{ fleetKind, growthEventId, outcome, triggeringShardId, vcpuInUse,
   * grantedQuota, spareShardId, newShardId, quotaRequestId }`, never a
   * credential.
   */
  'fleet.pool.grow': { kind: 'write', reason: 'required' },
  /**
   * `fleet-admin request-quota` (Story MOTIR-9362 · MOTIR-9463): vCPU quota
   * raises filed on one or more fleet accounts. One row per invocation, as the
   * `--operator` superadmin, with a reason the service writes; `metadata` is
   * `{ desiredVcpu, quotaCode, accounts: [{ name, outcome, awsRequestId? }] }`.
   */
  'fleet.shard.quota_request': { kind: 'write', reason: 'required' },
  /**
   * A Host organisation's CAPACITY REQUESTS (Story MOTIR-9365 · MOTIR-9583), as
   * `fleet-admin` works them: `list` (the open and filed requests were read),
   * `link` (a request linked to the quota raise the platform admin filed) and
   * `close` (closed with the operator's note). Target is `platform` with the
   * request's id; `metadata` is `{ organizationId, awsAccountId, fleetKind,
   * desiredVcpu, quotaRequestId? }`, never a credential.
   */
  'fleet.capacity_request.list': { kind: 'read', reason: 'never' },
  'fleet.capacity_request.link': { kind: 'write', reason: 'required' },
  'fleet.capacity_request.close': { kind: 'write', reason: 'required' },
  /**
   * The IDEA STORE's writes (Story MOTIR-7662 · MOTIR-7671), `targetKind:
   * 'idea'`, written by `ideasAdminService` inside `withPlatformWrite`. Reached
   * from the console session OR — on `/api/platform/ideas/**` alone — a staff
   * member's personal access token (ADR §2, the 2026-10-07 amendment), so every
   * row's `metadata.credential` names which: `{ kind: 'session' }` or
   * `{ kind: 'token', apiTokenId }`.
   *
   * `retire` and `delete` are `required`: the trail must say why an idea left
   * the public list. The others are `inherited` — required on the row, but
   * supplied by the caller's context (the skill's run, or "edited in the
   * console") rather than typed per idea.
   */
  'idea.add': { kind: 'write', reason: 'inherited' },
  'idea.update': { kind: 'write', reason: 'inherited' },
  'idea.retire': { kind: 'write', reason: 'required' },
  'idea.delete': { kind: 'write', reason: 'required' },
  'idea.tag_add': { kind: 'write', reason: 'inherited' },
  // Story MOTIR-7772 · MOTIR-7774 — label translations merged into an existing tag.
  'idea.tag_translate': { kind: 'write', reason: 'inherited' },
  'idea.research_run': { kind: 'write', reason: 'inherited' },
  /**
   * The capacity ALERT SHARE was changed (Story MOTIR-9539 · MOTIR-9609): the
   * percentage of any one provider limit at which platform admins are alerted.
   * `targetKind: 'platform'`, `targetId: 'capacity.alert_share'`, `metadata`
   * `{ fromPercent, toPercent }` (`fromPercent` is the default 80 when no value
   * was stored). `inherited`: the service writes a default reason when the
   * screen supplies none.
   */
  'capacity.alert_share.set': { kind: 'write', reason: 'inherited' },
  /**
   * A provider/model's capacity LIMITS were edited on the gateway (Story
   * MOTIR-9539 · MOTIR-9613): a limit, the planning share or the tier note.
   * `targetKind: 'platform'`, `targetId: '<provider>/<model>'`, `metadata`
   * `{ provider, model, keys }` where `keys` maps each edited wire key to its new
   * value (`null` is "unknown"). The gateway write runs inside the audited
   * transaction, so a refused edit leaves no row. `inherited`: the service
   * writes a default reason when the screen supplies none.
   */
  'capacity.limits.edit': { kind: 'write', reason: 'inherited' },
} as const satisfies Record<
  string,
  { kind: PlatformAuditActionKind; reason: PlatformAuditReasonPolicy }
>;

/**
 * Whether an action must carry an operator's stated reason.
 *
 * `never` for a READ — a read legitimately has none, which is why the column is
 * nullable and the rule lives here rather than in the schema. `required` for
 * every WRITE, per the ADR's §7 table.
 *
 * ⚠️ THE FIRST `required` MEMBERS ARRIVED WITH MOTIR-1167, exactly as MOTIR-2896
 * predicted here: `user.password_reset_sent`, `user.suspend` and
 * `user.unsuspend`, each of which the design puts behind a confirm dialog with a
 * mandatory reason. The enforcement shipped with the mechanism it guards, one
 * card early, so this card added three rows to the table above and inherited the
 * check rather than re-deriving it — which is the whole argument for building a
 * rule's unexercised arm alongside the rule.
 */
export type PlatformAuditReasonPolicy = 'never' | 'required' | 'inherited';

/**
 * Whether an action READS the estate or CHANGES something (MOTIR-749).
 *
 * Explicit rather than derived from the reason policy since MOTIR-749: until
 * then "reason `never`" and "a read" were the same set, and MOTIR-751 derived
 * the audit log's default "Writes" filter from that. `user.impersonation_end`
 * and `user.impersonation_action` are WRITES whose reason the operator did not
 * type on the row itself — it is the session's, copied (`inherited`) — so the
 * derivation would have had to choose between misfiling them as reads and
 * pretending the operator typed a reason twice. The kind says what the action
 * IS; the policy says where its reason comes from.
 */
export type PlatformAuditActionKind = 'read' | 'write';

/** A member of the platform audit vocabulary. */
export type PlatformAuditAction = keyof typeof PLATFORM_AUDIT_ACTIONS;

/** Every action, as an array — for iteration and for tests. */
export const PLATFORM_AUDIT_ACTION_KEYS = Object.keys(
  PLATFORM_AUDIT_ACTIONS,
) as readonly PlatformAuditAction[];

/**
 * The READ verbs — what the audit log's default "Writes" filter leaves out
 * (MOTIR-751, design Panel 6).
 *
 * Derived from each action's explicit `kind` (MOTIR-749). It used to be derived
 * from the reason policy (`never` ⇒ read), which stopped being exact when the
 * staff-session writes arrived carrying the SESSION's reason — see
 * {@link PlatformAuditActionKind}. `tests/platform/platformAuditLog.test.ts`
 * pins the kind and the policy together: a read is always `never`, a write is
 * never `never`.
 */
export const PLATFORM_AUDIT_READ_ACTIONS: readonly PlatformAuditAction[] =
  PLATFORM_AUDIT_ACTION_KEYS.filter((a) => PLATFORM_AUDIT_ACTIONS[a].kind === 'read');

/** True for an action that CHANGES something — every operator write, direct or in a staff session. */
export function isPlatformAuditWrite(action: PlatformAuditAction): boolean {
  return PLATFORM_AUDIT_ACTIONS[action].kind === 'write';
}

/**
 * A narrowing guard for the one place the union cannot reach: a value read BACK
 * out of the database. The column is a `String`, so a row written by an older
 * deploy can carry a member this build does not know.
 */
export function isPlatformAuditAction(value: string): value is PlatformAuditAction {
  return Object.hasOwn(PLATFORM_AUDIT_ACTIONS, value);
}

/** The reason policy for one action. */
export function reasonPolicyFor(action: PlatformAuditAction): PlatformAuditReasonPolicy {
  return PLATFORM_AUDIT_ACTIONS[action].reason;
}

/**
 * The rule itself, as a pure function of (policy, reason).
 *
 * Split out from the action lookup deliberately, so BOTH arms are reachable by
 * a test. It was written when no action carried `required`, so that the rule's
 * load-bearing half was not shipped unexecuted; MOTIR-1167's three writes are
 * now the first callers to take that arm through the action lookup.
 *
 * A blank / whitespace-only reason does NOT satisfy `required`: the design puts
 * the reason behind a confirm dialog precisely so somebody has to type one, and
 * a space would defeat that while looking like compliance in the log.
 */
export function reasonSatisfied(
  policy: PlatformAuditReasonPolicy,
  reason: string | null | undefined,
): boolean {
  // `inherited` is held to the same bar: the service copies the session's
  // reason onto the row, and a row that arrived without one is a bug upstream.
  if (policy === 'never') return true;
  return typeof reason === 'string' && reason.trim().length > 0;
}
