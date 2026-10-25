// The `/api/v1` CONTRACT VERSION — one number, one meaning, one definition
// (Story 11 · MOTIR-2275).
//
// ⚠️ WHY THIS IS ITS OWN MODULE, and not still a line in `openapi/emit.ts`.
// Two things read this number now: the emitted document (`info.version`) and
// the `X-Motir-Api-Version` header the wrapper stamps on EVERY response. The
// wrapper is on the hot path of every v1 request, and `emit.ts` imports the
// whole operation registry — every resource schema and every operation
// declaration — so importing the constant from there would drag the
// documentation emitter into the request path of the API it documents. A leaf
// module with no imports is what lets both sides read the SAME value without
// one depending on the other; `emit.ts` re-exports it, so every existing
// importer is unchanged.

/**
 * `info.version`, and the value of the `X-Motir-Api-Version` response header —
 * the API CONTRACT's version, NOT the app's release number.
 *
 * MAJOR is the path version (`1`), MINOR increments on an additive change under
 * ADR §8's allowed list, and PATCH on a documentation-only correction (ADR
 * Amendment 4 Q6). A client reading it learns what the contract offers; a
 * release number would churn on every unrelated deploy and tell a client
 * nothing it can act on. This is the number Story 11.5's CLI version-skew gate
 * compares against.
 *
 * ⚠️ **BUMP IT WHEN THE CONTRACT GROWS.** An additive change under §8 that
 * leaves this string alone makes the number lie about the one thing it exists
 * to report — and, since 1.1.0, it lies on a header every client reads off the
 * happy path rather than in a document nobody fetches at runtime.
 *
 * ⚠️ **FOR A NEW OPERATION THAT OBLIGATION HAS AN EXECUTOR** —
 * `tests/api/v1/contract-version-guard.test.ts` fails when the operation
 * registry holds an id that no entry below names (MOTIR-3157). It cannot check
 * a new FIELD or a new HEADER, so for those the rule above is still discharged
 * by whoever remembers it; for an endpoint it is not.
 *
 * - `1.0.0` — the contract as Stories 11.1–11.4 and 11.7 shipped it.
 * - `1.1.0` — MOTIR-2275 adds the `X-Motir-Api-Version` response header.
 * - `1.2.0` — MOTIR-2279 adds the minimal ACTOR object to a collection row
 *   (`ReadyItem.assignee`), the rule Amendment 10 Q1 states for every one.
 * - `1.3.0` — MOTIR-2283 applies that rule to `Comment.author`, the one shape
 *   that had kept the rationale Amendment 10 overturned.
 * - `1.3.1` — MOTIR-2317 declares the ready set's `kind` / `priority` as the
 *   ARRAYS the route has always read them as. A PATCH, not a minor: the set of
 *   requests the server accepts is unchanged — `parseReadyFilters` has read
 *   both with `getAll` since they shipped — and only the document, which
 *   described them as scalars while its own prose said "Repeatable", moves.
 * - `1.4.0` — MOTIR-2318 adds `GET …/work-items/count`, the operation
 *   Amendment 14 decided on so a client can learn how many items match a filter
 *   without paging the match set. Additive: a new operation, no declared shape
 *   changed.
 * - `1.5.0` — MOTIR-2320 adds `totalComments` / `totalChanges` to the activity
 *   page (Amendment 15). The merged `all` view reports two streams, and one
 *   `totalCount` cannot say what it is made of. Additive: two new fields,
 *   `totalCount` unchanged in meaning on every view.
 * - `1.6.0` — MOTIR-2400 adds `inheritedSessionBranch` to the READY row
 *   (Amendment 17). The row asserted that an item is ready without saying what
 *   that readiness is measured against — from the trunk, or on top of unmerged
 *   work. Additive: one new field, and the `blockedBy` it sits beside is
 *   unchanged.
 * - `1.7.0` — MOTIR-2445 adds `parentKey` to the DISPATCH PROMPT. The prompt
 *   already named the parent in its CONTEXT prose; the field lets a client read
 *   it without parsing text the server may reword — and costs no query, since
 *   the parent row is already read to render that line. Additive: one new
 *   field, the prompt text byte-identical.
 * - `1.8.0` — MOTIR-2421 adds `POST /api/v1/work-items/{key}/implementation`.
 *   Recording WHAT BUILT an item was only reachable through the integration
 *   endpoint, which requires a session branch — so the per-item-PR path could
 *   not record provenance at all without also asserting a lineage that does not
 *   exist. Additive: one new endpoint, on the existing `integration` scope, with
 *   `POST …/integration` unchanged in shape and behaviour.
 * - `1.9.0` — MOTIR-2728 adds `targetRepos` to the work-item detail response and
 *   to both work-item write bodies: the ordered SET of repositories an item ships
 *   in, of which `targetRepo` is the first element. Additive on all three, and
 *   deliberately so — §8 forbids removing, renaming or retyping a published
 *   field, and turning `targetRepo` into an array is all three at once. A client
 *   written against `targetRepo` keeps reading the repository dispatch routes to;
 *   one that never learns about the set under-reports rather than mis-reports.
 *   The two write fields are MUTUALLY EXCLUSIVE (`CONFLICTING_TARGET_REPO_INPUT`,
 *   422) — a new CONDITION getting a status, which §8 permits, on an existing
 *   code family. See `docs/decisions/work-item-repository-set.md` §3.
 * - `1.10.0` — MOTIR-2903 adds the SUBSUMPTION member to the dispatch prompt's
 *   `advisories` union: a card whose body names a path a later merge already
 *   changed, so its deliverable may already be in the repository. Additive — a
 *   new member of a union on a field clients are required to tolerate unknown
 *   members of, with every existing member byte-identical.
 * - `1.11.0` — MOTIR-3041 adds `targetRepositories` — the item's repository set
 *   as REFERENCES to the project's `project_repository` rows — beside the
 *   derived names, on the work-item detail response, the MCP item shape and the
 *   DTO. Additive; the names it publishes are read projections of the same
 *   references. (Logged retroactively by MOTIR-3131: the bump shipped with
 *   MOTIR-2732 and the line for it did not.)
 * - `1.12.0` — MOTIR-3131 adds `targetRepos` to the DISPATCH PROMPT: EVERY
 *   repository the item ships in, ordered with the primary first, each with its
 *   clone URL, its default branch and its per-repository delivery state. The
 *   payload described a repository where the card has a set, so a launcher could
 *   not resolve a checkout, a prompt could not instruct a second worktree, and a
 *   run could not say that one of two repositories had already shipped.
 *   Additive: one new field, the three scalars unchanged in value, the assembled
 *   `prompt` text byte-identical. See `docs/decisions/work-item-repository-set.md`
 *   § *Amendment 2026-08-19* §B1.
 * - `1.13.0` — MOTIR-3110 adds the SIZING member to the dispatch prompt's
 *   `advisories` union: a childless `coding_agent` card sized over the
 *   estimation gate (13+ story points, or more than 60 estimated minutes).
 *   Additive on the same terms as `1.10.0` — a new member of the same union, on
 *   the same field clients must tolerate unknown members of. It is a SECOND
 *   `kind: "shape"` variant rather than a third severity inside the existing
 *   one, because it carries no `criterionIndex` and making that field optional
 *   would be a nullability change §8 forbids. Every existing member is
 *   byte-identical.
 *
 *   ⚠️ ITS POINTS THRESHOLD IS `8` NOW, AND THE VERSION DOES NOT MOVE FOR IT
 *   (MOTIR-5588, PRODECT_FINDINGS #106). The entry above says *13+ story
 *   points*, which is what 1.13.0 shipped and is left standing as the record of
 *   it. The planner's deck is `1 / 2 / 3 / 5 / 8` and **8 IS the split signal**,
 *   so the points arm could never fire on planner output and the one value the
 *   rule calls a split signal produced no advisory at all. **No §8 clause
 *   moves:** no field is removed, renamed or retyped, no error `code` is
 *   repurposed, no existing condition changes status, and nothing is REFUSED —
 *   an advisory is a report, so a threshold is not a limit in §8's sense. What
 *   changes is how often an existing member of an existing union appears, on a
 *   field clients already tolerate unknown members of. Stated here rather than
 *   buried, on the same terms as the `ai:decide_plan` note below: a client that
 *   counted on `13` was reading a number this contract never promised.
 * - `1.14.0` — MOTIR-3157 records `uploadWorkItemAttachment`, the
 *   `POST /api/v1/work-items/{key}/attachments` operation MOTIR-3000 shipped
 *   WITHOUT moving this number. Additive: a new endpoint, §8's first allowed
 *   change — so the contract grew when that operation merged and only the
 *   number stood still, which is the one thing this string exists not to do.
 *   The bump is therefore RETROACTIVE, and the entry names the OPERATION rather
 *   than the position: which minor it lands on depends on merge order, and a
 *   reader asking "when did the attachment door arrive?" needs the id, not the
 *   ordinal. Nothing on the wire changes here — the endpoint has been live
 *   since #2145; what changes is that a client pinning a minor to get it is now
 *   told the truth by `X-Motir-Api-Version`.
 * - `1.15.0` — MOTIR-2961 adds `claimWorkItem`,
 *   `POST /api/v1/work-items/{key}/claim`: an ATOMIC claim of one work item BY
 *   KEY — lock the row, re-assert the to-do category, assign and transition, in
 *   one transaction. Every dispatch path except `claim_next_ready`'s "give me
 *   whatever is next" was serialising claimants with an assignment its own code
 *   calls an advisory, so two runs could start the same card. Additive: one new
 *   endpoint (§8's first allowed change) and one new resource (`WorkItemClaim`);
 *   no declared shape changed.
 * - `1.16.0` — MOTIR-3178 adds the SELF-BLOCKING-DESIGN member to the dispatch
 *   prompt's `advisories` union: a CHILDLESS card one of whose acceptance
 *   criteria produces a design ASSET while another builds the rendered SURFACE
 *   that drawing decides — the planning-time design gate's degenerate reading,
 *   where the `type: design` subtask a UI card must be linked to IS the card.
 *   Additive on the same terms as the sizing member — a new member of the same
 *   union, on the same field clients must tolerate unknown members of. It is a
 *   THIRD `kind: "shape"` variant rather than a fourth severity inside the
 *   criterion-carrying one, because it carries a PAIR of indices
 *   (`designCriterionIndex` / `surfaceCriterionIndex`) and no `criterionIndex`
 *   at all. Every existing member is byte-identical.
 * - `1.17.0` — MOTIR-3017 adds two things a run needs in order to report what it
 *   found, both additive. (1) An optional `findingsPolicy` query parameter on
 *   `GET …/dispatch-prompt`: a comma-separated list of the capabilities this run
 *   switches OFF for its agent. Omitted renders the protocol byte-identically to
 *   today, so no existing caller moves; an unrecognised capability is refused
 *   (`INVALID_FINDINGS_POLICY`, 422) rather than ignored, which is a new
 *   CONDITION getting a status on an existing operation — §8's allowed shape.
 *   (2) `approveWorkItemPlan` — `POST /api/v1/work-items/{key}/plan-approval`,
 *   the bounded public entrance to `plansService.approvePlan` that
 *   `motir auto --auto-approve-replan` drives: a new operation, gated by the key
 *   the service already asserts, with no declared shape changed. Its 409
 *   additionally carries
 *   `planStatus`, an enrichment on a NEW condition rather than a change to an
 *   existing one. See `docs/decisions/run-findings-protocol.md`.
 *
 *   ⚠️ THAT KEY IS NOW `ai:decide_plan`, AND THE VERSION DOES NOT MOVE FOR IT
 *   (MOTIR-3188, 2026-08-20). The entry above named `ai:view_plan`; that key
 *   gated no view and held AUTHOR and DECIDE at once, and the decisions were
 *   split onto `ai:decide_plan`. `approveWorkItemPlan` follows the service, as it
 *   always did. **No §8 clause moves:** no field is removed, renamed or retyped,
 *   no error `code` is repurposed, no existing condition changes status, no limit
 *   tightens and no optional parameter becomes required — the operation is byte-
 *   identical in shape. §8 governs the CONTRACT's surface, and a gate is not on
 *   it; inventing a clause for one here would be a policy change of its own
 *   (and would bind `POLICY_FORBIDDEN` in `lib/apiDocs/guide.ts`), not a note.
 *
 *   ⚠️ THE ONE THING A READER SHOULD KNOW ANYWAY, stated rather than buried: a
 *   token holding an EXPLICIT grant of `ai:view_plan` and not `ai:decide_plan`
 *   loses this operation. Every built-in role resolves the two keys identically,
 *   and `DEFAULT_TOKEN_GRANT` is derived at mint from the grantable set, so the
 *   affected population is tokens minted with a hand-picked grant in the window
 *   between MOTIR-3021 landing and this change — hours, on one deployment. Re-mint
 *   or edit such a token's grant; nothing about the request or response changes.
 *
 *   ⚠️ RENUMBERED 1.14.0 → 1.17.0 ON MERGE, which is the process working rather
 *   than a correction. This number is a SERIALIZED RESOURCE: every in-flight
 *   additive pull request claims the next MINOR, and three landed while this one
 *   was open (MOTIR-3157, MOTIR-2961, MOTIR-3178). The entry above names the
 *   OPERATIONS rather than a position precisely so renumbering stays one line,
 *   and it did.
 * - `1.18.0` — MOTIR-3049 adds `claimScope`, `POST /api/v1/scope-claims`: an
 *   ATOMIC claim of a whole SCOPE — a container and its children, or a
 *   project's active sprint — locked, re-asserted and flipped in ONE
 *   transaction, all or nothing. `claimWorkItem` made a single card safe to
 *   dispatch; a SCOPED run needs the whole set before its first agent starts,
 *   or a second run takes card five while it is on card two and the story ends
 *   up split across two pull requests. Additive: one new endpoint (§8's first
 *   allowed change) and one new resource (`ScopeClaim`); no declared shape
 *   changed.
 * - `1.19.0` — MOTIR-3196 adds two query parameters to the flat ready set
 *   (`GET …/ready`, deleted in `1.55.0`):
 *   `ancestor` (repeatable) narrows the ready set to the leaves STRICTLY
 *   BENEATH one or more containers, at any depth; `sprintId` (single-valued,
 *   with the reserved literal `active`) narrows it to the items whose OWN
 *   `sprintId` matches. Together they publish the SCOPE a run claims through
 *   `claimScope` (1.18.0), so the read and the claim can name the same set.
 *   Additive: two optional parameters on an existing operation (§8's second
 *   allowed change); omit them and the response is byte-identical. An
 *   unresolvable value is refused with the existing `INVALID_READY_FILTER` →
 *   422 rather than silently matching everything, and an `ancestor` key from
 *   another project is refused identically to one that never existed.
 * - `1.20.0` — MOTIR-3586 adds `listProjectRepositories`,
 *   `GET /api/v1/projects/{projectKey}/repositories`: the project's repository
 *   SET, in set order, each row carrying the checkout `name`, `repoRef`,
 *   `cloneUrl`, `defaultBranch`, `archived`, its establish `state` and the
 *   derived `established` discriminator. A PAT-authenticated client could not
 *   learn which repositories a project has at all — the only repository-set read
 *   in the product is session-cookie authenticated and returns the establish
 *   step's whole view model — so a CLI could not fetch the code before a work
 *   item had been picked. Additive: one new operation (§8's first allowed
 *   change) and one new resource (`ProjectRepository`); no declared shape
 *   changed. Gated on `project:browse`, already in `CLI_TOKEN_GRANT` — the
 *   grant is NOT widened. See
 *   `docs/decisions/link-materializes-the-checkouts.md` §2 and §7.
 *
 * - `1.21.0` — MOTIR-3230 widens the `subsumption` dispatch advisory to OPEN pull
 *   requests. The check read the mirror for MERGED rows only, and a pull request
 *   is merged for the rest of time and open for about an hour — so it was
 *   available for the whole period in which the answer no longer changes anything
 *   and blind for the one window in which it would. The two hits carry OPPOSITE
 *   remedies (*read the diff and close the card* vs *somebody is editing this
 *   file, go and coordinate*), so they are separable on the wire: a new required
 *   `state` field, `'merged' | 'open'`, and a new `likely-in-flight` severity.
 *
 *   Additive, and the shape is chosen to keep it that way. `mergedAt` is NOT
 *   relaxed to nullable — that would RETYPE a declared field, which §8 forbids —
 *   so the variant is SPLIT: the merged payload is byte-identical to the shipped
 *   one plus `state: 'merged'` (§8's allowed new field on an existing shape), and
 *   the open payload, carrying `state: 'open'` and `mergedAt: null`, is a shape no
 *   consumer has ever received and so can break none. `severity` was already
 *   open-ended and every client is required to tolerate unknown members of it.
 *
 * - `1.22.0` — MOTIR-3697 adds `deliveries` to the work-item detail resource: the
 *   DELIVERY SET, every pull request that delivers the card, each with its
 *   repository, number, title, url, `state`, `baseRef`, that repository's own
 *   `defaultBranch`, and `ci`.
 *
 *   It exists because `ci` had no route out. `derivePrCiState` is server-side, and
 *   no v1 read exposed a pull request at all — so a PAT-authenticated client that
 *   needed to know whether its own pull request was green could only shell out to
 *   `gh pr checks`. That is a SECOND CI verdict, computed from different inputs by
 *   different rules, and it would drift from the pill a person reads on the same
 *   card. MOTIR-3685's watch-and-fix loop is the consumer, and its own acceptance
 *   criterion forbids the second verdict; this is the first one, published.
 *
 *   `baseRef` + `defaultBranch` ride along because a merge is not a delivery: a
 *   pull request merged onto a base that is NOT its repository's default branch
 *   delivered nothing to the trunk, and a client cannot tell without both. Never
 *   `main` by assumption — a self-hoster's trunk is `master` or `trunk`, and a card
 *   spanning two repositories may face two different names.
 *
 *   Additive: one new field on an existing shape (§8's first allowed change); no
 *   declared field removed, renamed or retyped. **It is an ARRAY on every work
 *   item, never `null` and never absent**, and empty is the ordinary answer — it
 *   means nothing is recorded, never that nothing has landed.
 *
 *   ⚠️ THIS NUMBER IS A SERIALIZED RESOURCE. Every in-flight additive pull
 *   request claims the next MINOR, so read `V1_CONTRACT_VERSION` on
 *   `origin/main` before merging and RENUMBER if a sibling has taken it since —
 *   the entry names the OPERATION rather than a position precisely so that stays
 *   one line (the 1.14.0 → 1.17.0 note above is the same process working).
 *
 * - `1.23.0` — MOTIR-1792 adds the DISPATCH RUN ingest: `openDispatchRun`
 *   (`POST /api/v1/dispatch-runs`), `appendDispatchRunEvents`
 *   (`POST …/{id}/events`) and `closeDispatchRun` (`POST …/{id}/close`), plus the
 *   `DispatchRun` / `DispatchRunCard` / `DispatchRunOpened` / `DispatchRunAppended`
 *   resources.
 *
 *   They exist because a run had nowhere to say what it did. A person types
 *   `motir run <story>`, eleven cards go In Progress in one transaction, and the
 *   whole account of which card is being worked, which were skipped and why, and
 *   why the run stopped lives in a terminal on one machine until the window
 *   closes. `docs/decisions/dispatch-run-record.md` is the contract.
 *
 *   ⚠️ THE SET RIDES IN THE OPEN, and that shape is the decision rather than a
 *   convenience: it exists for exactly one moment, in one process — a scope claim
 *   has just returned its members, or a batch snapshot has just been frozen — and
 *   rebuilt afterwards from per-card events it degrades into a list of what the
 *   run got round to, losing the SKIPPED cards entirely.
 *
 *   Additive: three new operations (§8's first allowed change) and four new
 *   resources; no declared shape changed. Gated on `work_item:edit`, already in
 *   `CLI_TOKEN_GRANT` — the grant is NOT widened. The ingest writes no work-item
 *   status, no pull request and no cost, so nothing an existing operation reports
 *   moves.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, per the rule the 1.22.0 entry
 *   states: `V1_CONTRACT_VERSION` was `1.22.0` at `435bce9bd`, so this claims
 *   `1.23.0`. If a sibling has taken it since, RENUMBER this entry — it names the
 *   OPERATIONS rather than a position, precisely so that stays one line.
 *
 * - `1.24.0` — MOTIR-4085 adds `getWorkItemPlan`
 *   (`GET …/work-items/{key}/plan-approval`): the plan a
 *   card's own re-plan produced, READ without deciding it, resolved by exactly the
 *   walk the POST beside it uses. It exists so an unattended loop can BOUND what
 *   it is about to approve — `motir auto --auto-approve-replan` reads the
 *   proposals, checks that each falls inside the card's own lane (the leaf and its
 *   siblings), and declines to approve one that does not, naming what fell out. It
 *   also adds `parentKey` to a plan PROPOSAL: `parentRef` is a cuid, which §7
 *   forbids a client from resolving, so without it a caller cannot answer *where
 *   is this proposal putting a child?* at all.
 *
 *   Additive twice over: one new operation (§8's first allowed change) and one new
 *   nullable field on an existing resource; no declared shape changed and nothing
 *   was removed. The read is gated on `project:browse` — the key its service
 *   asserts, and the same key `getPlan` declares for the IDENTICAL document, so
 *   two doors onto one plan cannot disagree about who may open them — while the
 *   DECISION stays on `ai:decide_plan`. So a sandboxed agent may read this (it
 *   always could: it holds the plan's id from its own submit) and may not decide
 *   it, which is the bound that was ever worth having;
 *   `work-item-plan-approval-route.test.ts` asserts both halves from the grant
 *   constant.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, per the rule the 1.22.0 entry
 *   states: `V1_CONTRACT_VERSION` was `1.23.0` at `e055b6b23`, so this claims
 *   `1.24.0`. If a sibling has taken it since, RENUMBER this entry — it names the
 *   OPERATION rather than a position, precisely so that stays one line.
 *
 * - `1.25.0` — MOTIR-3810 / MOTIR-4620 adds `todos` to a plan PROPOSAL's
 *   `proposedFields`: the card's ORDERED STEPS, proposed with the card so a
 *   reviewer reads the list they will tick before approving it
 *   (`docs/decisions/agent-authored-plans.md` AMENDMENT 14 D6). Each row is
 *   `{ text, notesMd, commandText, executor }`, array order is list order, and
 *   approve writes one real to-do row per element.
 *
 *   Additive: ONE new nullable field on an existing resource, `null` on every
 *   proposal that carries no steps — which is every proposal that exists today,
 *   so no response a client has already seen changes shape. It is READ-ONLY here
 *   and stays so: `/api/v1` has no plan-authoring operation, so there is no write
 *   door for this field to appear on, and adding one is a different decision.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.24.0` at `4dc08ff39`, so this claims `1.25.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the FIELD rather than a position.
 *   MOTIR-3157 is the bug filed the last time a shape moved without the number.
 *
 * - `1.26.0` — MOTIR-5048 adds `linkWorkItemPullRequest`
 *   (`POST /api/v1/work-items/{key}/pull-requests`): DECLARE which pull request
 *   delivers a work item. The link is the ONLY association a pull request has —
 *   the title parse was retired by MOTIR-3674 — and it was reachable only
 *   through the `link_pull_request` MCP tool, so only a dispatched AGENT could
 *   write one. `packages/cli` retired its MCP transport in 11.5.6, which left an
 *   ORCHESTRATOR unable to say what its own session pull request delivers.
 *
 *   Additive: ONE new operation (§8's first allowed change). No declared shape
 *   changed and nothing was removed. It is gated on `work_item:edit` — the key
 *   the service already asserts and the same key the MCP tool declares, so two
 *   doors onto one write cannot disagree about who may open it, and
 *   `CLI_TOKEN_GRANT` already carries it, so no grant is widened.
 *
 *   The response omits the pull-request row's internal cuid: §7 keeps the cuid
 *   off the wire, and a caller already holds the coordinate it sent. It reports
 *   `created` instead — whether this call WROTE the row because no webhook
 *   delivery had arrived yet, which is the case the operation exists for.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.25.0` at `d4981d354`, so this claims `1.26.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the OPERATION rather than a position.
 *
 * - `1.27.0` — MOTIR-5357 adds `getDispatchRunCloseOutPrompt`
 *   (`GET /api/v1/dispatch-runs/{id}/close-out-prompt`): the prompt a scoped run
 *   hands ONE agent before marking its pull requests ready, so HOW TO TEST is
 *   written once onto the run target (`docs/decisions/approval-gates.md` §9's
 *   2026-09-13 amendment). The target and the landed cards come from the run's
 *   own record; a run with no scope is `NO_RUN_TARGET` (422).
 *
 *   Additive: ONE new operation (§8's first allowed change). No declared shape
 *   changed and nothing was removed. Gated on `work_item:edit`, which
 *   `CLI_TOKEN_GRANT` already carries.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.26.0` at the branch point, so this claims `1.27.0`. If a sibling has
 *   taken it since, RENUMBER this entry — it names the OPERATION.
 *
 * - `1.28.0` — MOTIR-5358 adds `getWorkItemHowToTest`
 *   (`GET /api/v1/work-items/{key}/how-to-test`): a run target's CURRENT
 *   How-to-test record, each repository section named `owner/name`, so the CLI
 *   renders the `## How to test` section of a session pull request body from the
 *   same record the item page shows. Additive: ONE new operation; gated on
 *   `project:browse`. Same re-read-before-merge rule as `1.27.0` above.
 *
 * - `1.29.0` — MOTIR-5408 adds the FOLDER resource: `listFolders`
 *   (`GET /api/v1/projects/{projectKey}/folders`, one level, keyset-paged over
 *   `(position, id)`), `createFolder` (`POST` on the same path), `getFolder`,
 *   `updateFolder` and `deleteFolder` (`GET` / `PATCH` / `DELETE`
 *   `/api/v1/folders/{folderId}`), plus the `folders` cursor collection and six
 *   folder error codes (`FOLDER_NOT_FOUND`, `INVALID_FOLDER_NAME`,
 *   `FOLDER_NAME_TAKEN`, `FOLDER_CYCLE`, `CROSS_PROJECT_FOLDER`,
 *   `SUBTASK_NEEDS_PLACEMENT`), each of which rendered as a bare 500 before.
 *
 *   Additive: five new operations (§8's first allowed change) and new codes for
 *   new conditions. No declared shape changed and nothing was removed. Reads are
 *   gated on `project:browse`, writes on `work_item:edit` — the key the folder
 *   service asserts — and `CLI_TOKEN_GRANT` carries both.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.28.0` at `4a4975c40`, so this claims `1.29.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the OPERATIONS.
 *
 * - `1.30.0` — MOTIR-5412 adds a work item's FOLDER placement to the work-item
 *   resource: `folderId` and `folderPath` (names root-first) on the detail every
 *   single-item read and write returns — `getWorkItem`, `createWorkItem`,
 *   `updateWorkItem`, `transitionWorkItem`, `archiveWorkItem`,
 *   `restoreWorkItem` — both non-null exactly when the item is filed; and
 *   `folderId` on the `createWorkItem` / `updateWorkItem` request bodies (a string
 *   files the item, `null` on a PATCH takes it out), plus `PLACEMENT_CONFLICT`
 *   (422) when a body names `parentKey` AND `folderId`.
 *
 *   Additive: two new response fields and one new optional request field on
 *   existing operations (§8's allowed list), and a new code for a new condition.
 *   A `parentKey` PATCH on a filed item now succeeds and unfiles it, where it
 *   ended in a database CHECK violation (a bare 500) before — a fault repaired,
 *   not a shape changed. The contract-version guard cannot see fields, so this
 *   entry is the record.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.29.0` on `parent/MOTIR-5310-agents-file-into-folders` at `7c5c00e74`,
 *   so this claims `1.30.0`. If a sibling has taken it since, RENUMBER this entry
 *   — it names the FIELDS.
 *
 * - `1.31.0` — MOTIR-5415 adds `folderId` and `folderPath` to `PlanProposal`
 *   (`getPlan`, `GET /api/v1/plans/{planId}`, and the plan
 *   `getWorkItemPlan` / `approveWorkItemPlan` return): the folder a proposal
 *   NAMES as its placement (`parentRef` / `patch.parentRef` = `folder:<id>`) and
 *   that folder's names, root first. `folderPath` is `null` for a folder deleted
 *   after the plan was written. `parentKey` stays `null` for a folder ref, as it
 *   is for every ref that names no work item.
 *
 *   Additive: two new nullable response fields (§8's allowed list). No
 *   operation, no request shape and no existing field changed.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: this claims
 *   `1.31.0` because sibling MOTIR-5412 claims `1.30.0` on the same parent
 *   branch. If the numbering has moved, RENUMBER this entry.
 *
 * - `1.32.0` — MOTIR-5464 adds `claimWorkItemRepair`
 *   (`POST /api/v1/work-items/{key}/repair`) and its `WorkItemRepairClaim`
 *   resource: the claim `motir fix <key>` makes to hand an `implemented` card's
 *   failing pull requests to ONE fixing agent, answered as a 200 with an
 *   `outcome` (`claimed` / `mine` / `taken` / `not_repairable` + `reason`). It
 *   also adds `fix` to the `DispatchRun.command` vocabulary, because the claim IS
 *   an open dispatch run with that command.
 *
 *   Additive: one new operation and one new resource (§8's first allowed
 *   change). The new `command` member is written only by the new operation, so a
 *   run any existing client opens or reads keeps the five members it already
 *   knew; a client reading the runs of a project where somebody ran `motir fix`
 *   will meet it, and `command` is a label there, never a branch. Gated on
 *   `work_item:edit`, already in `CLI_TOKEN_GRANT` — the grant is NOT widened.
 *   No work-item status is written, so nothing an existing operation reports
 *   moves.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.31.0` at `3205ae235`, so this claims `1.32.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the OPERATION.
 *
 * - `1.33.0` — MOTIR-5560 adds the THREE DESIGN READS: `listWorkItemDesigns`
 *   (`GET …/work-items/{key}/designs`), `getWorkItemDesign`
 *   (`GET …/work-items/{key}/design`) and `listProjectDesigns`
 *   (`GET …/projects/{projectKey}/designs`), plus the `DesignVerdict`,
 *   `ApprovedDesign`, `DesignAsset` and `WorkItemDesigns` resources.
 *
 *   They exist because Motir could take a design IN and never give it back out.
 *   An agent could only find a design by opening `design/<area>/` in a repository
 *   checkout — so a project that does not commit its designs had no way to hand
 *   one to a run, and a hosted agent, which works from what it is given, had none
 *   at all. `docs/decisions/design-result.md` AMENDMENT 5 is the contract, and its
 *   Q2 is the load-bearing part: the approved design is the version the APPROVAL
 *   named, not the design card's current result.
 *
 *   ⚠️ THE LINKS RIDE ON THE SINGLE READS ONLY, and that asymmetry is the
 *   decision rather than an omission: a presign lives 300 seconds, so a page of
 *   twenty-five designs would mint seventy-five links that begin expiring before
 *   the caller has read the page. The list is for FINDING a design; the single
 *   read is for fetching one.
 *
 *   Additive: three new operations and four new resources (§8's first allowed
 *   change); no declared shape changed. Gated on `project:browse`, already in
 *   `CLI_TOKEN_GRANT` — the grant is NOT widened. All three are READS: no status,
 *   no pull request and no cost is written, so nothing an existing operation
 *   reports moves.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.32.0` at `6471cac0f`, so this claims `1.33.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the OPERATIONS.
 *
 * - `1.34.0` — MOTIR-5719 adds `queueExit` to `WorkItemRepairClaim.pullRequests[]`:
 *   the repair claim now counts a pull request the merge queue threw out for a
 *   standing failure as FAILING (so `motir fix` can take an ejected card instead of
 *   being refused `not_failing`), and tells the agent why — the queue's reason and
 *   its failing check, both null-able for a conflict.
 *
 *   Additive: one new nullable field on an existing resource (§8's allowed list).
 *   No refusal name changes; `ci` keeps its meaning (the pull request's OWN
 *   verdict) and may now read `passing` beside a set `queueExit`. Gated on the
 *   same `work_item:edit`; the grant is NOT widened.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.33.0` at `bbbe8d9b0`, so this claims `1.34.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the FIELD.
 *
 * - `1.35.0` — MOTIR-5720 adds `queueExit` to `WorkItemDetail.deliveries[]`: a
 *   delivering pull request whose latest merge-queue exit is a failure, not
 *   re-queued, at its current head carries the exit's reason and failing check.
 *   The server decides "standing"; `ci` keeps the pull request's own verdict. It
 *   is what lets `motir fix` see an ejected pull request as red — its own checks
 *   are green, so the watch loop used to call it green and never run the agent.
 *
 *   Additive: one new nullable field on an existing shape (§8's allowed list); no
 *   declared field changes meaning. Read-only, on the same `project:browse` read.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.35.0` over
 *   MOTIR-5719's `1.34.0` on the same parent branch. If the numbering has moved,
 *   RENUMBER both entries.
 *
 * - `1.36.0` — MOTIR-5428 adds the `likely-blocker-count-mismatch` dispatch
 *   advisory shape: the exact counted claim, its stated number, and the current
 *   number of `blocked_by` edges. Additive: one new member of an advisory union
 *   whose severity is explicitly open-ended; no existing shape changes.
 *
 * - `1.37.0` — MOTIR-5399 adds a fourth `shape` variant to the dispatch prompt's
 *   `advisories[]`: `body-edit-above-field-move`, carrying `bodyEdit` and
 *   `fieldMove` (`{ at, fields }` each) — the card's newest body write sitting
 *   directly above a write that moved a field the body describes. A prompt to
 *   re-read, never a gate.
 *
 *   Additive: a new member of a union whose `severity` is documented open-ended
 *   (§8's allowed list); no declared field changes type or meaning. Read-only, on
 *   the same `work_item:edit` claim path; the grant is NOT widened.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: `V1_CONTRACT_VERSION` was `1.36.0`
 *   at `412bc953b` (MOTIR-5428 took `1.36.0`), so this claims `1.37.0`. If a sibling has taken it since,
 *   RENUMBER this entry — it names the ADVISORY VARIANT.
 *
 * - `1.38.0` — MOTIR-6098 adds a leaf's `difficulty` (`trivial` / `low` / `medium` / `high`,
 *   nullable) to the work-item resource every single-item read and write returns,
 *   and to the `createWorkItem` / `updateWorkItem` request bodies (`null` on a
 *   PATCH clears it), plus `DIFFICULTY_NOT_ALLOWED_ON_KIND` (422) when a body
 *   would leave a non-null difficulty on an epic or story.
 *
 *   Additive: one new nullable response field and one new optional request field
 *   on existing operations (§8's allowed list), and a new code for a new
 *   condition. No declared field changes meaning. Gated on the same keys.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.37.0` on `origin/main` (MOTIR-5428 took `1.36.0` and MOTIR-5399 took
 *   `1.37.0` while this branch was open — renumbered twice), so this claims
 *   `1.38.0`. If a sibling has taken it since, RENUMBER this entry — it names
 *   the FIELD.
 *
 * - `1.39.0` — MOTIR-6191 adds `getWorkItemApprovalGate`:
 *   `GET /api/v1/work-items/{key}/approval-gate?kind=…`, answering one gate's
 *   DECISION RECORD — `state`, the `noteMd` the decider wrote, `decidedAt`,
 *   `decidedByLabel`, `decidedUnderAuthority`, `decisionSource`,
 *   `subjectVersion`, `supersededCause`, `outcomeRef` — plus the live
 *   `routedToLabel`. The new `ApprovalGateDecision` component carries it, and
 *   `gate: null` is an ANSWER (this card has no gate of that kind) rather than a
 *   404. `INVALID_GATE_KIND` (422) is the refusal for a `kind` outside the
 *   vocabulary.
 *
 *   Additive: a NEW operation and a NEW component (§8's allowed list); no
 *   existing operation, field or code changes meaning. Gated on `project:browse`,
 *   a key `CLI_TOKEN_GRANT` already carries, so the grant is NOT widened.
 *
 *   ⚠️ AND IT ADDS NO DECIDE DOOR. `approval:decide_any` is asserted by no v1
 *   operation and no MCP tool, stays ungrantable to a token by derivation, and
 *   there is still no programmatic path to approving a gate
 *   (`docs/decisions/approval-gates.md` §1, §2). This bump names a READ.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.38.0` at `bfae2ec2b`, so this claims `1.39.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the OPERATION.
 *
 * - `1.40.0` — MOTIR-6366 adds one query parameter to the flat ready set
 *   (`GET …/ready`, deleted in `1.55.0`):
 *   `allowSoftBlock` (`true` / `false`, default `false`). `true` lists a leaf
 *   held only by an ANCESTOR's block (a SOFT block) while still excluding one
 *   with its own open `blocked_by` (a HARD block). A non-boolean value is the
 *   existing `INVALID_READY_FILTER` → 422.
 *
 *   Additive: one optional parameter on an existing operation (§8's second
 *   allowed change); omit it and the response is byte-identical. Gated on the
 *   same `project:browse` key; the grant is NOT widened.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.39.0` at `b889f767a`, so this claims `1.40.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the PARAMETER.
 *
 * - `1.41.0` — MOTIR-6421 adds `refusalVerdict` (`revise` / `re_plan`, nullable) to the
 *   `ApprovalGateDecision` component `getWorkItemApprovalGate` answers: what a person
 *   meant by sending a `design_result` gate back from Motir (`approval-gates.md` §10d).
 *   Null on every other kind, verb and source, and on every gate decided before the
 *   column existed.
 *
 *   Additive: one new nullable field on an existing component (§8's allowed list); no
 *   existing field changes meaning, and `outcomeRef` still carries the status written.
 *   Still a READ — no v1 operation decides a gate.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.40.0` at `b4588d153`, so this claims `1.41.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the FIELD. *
 * - `1.42.0` — MOTIR-6501 adds `offersRefusalVerdict` (boolean) to the
 *   `ApprovalGateDecision` component `getWorkItemApprovalGate` answers: whether a refusal
 *   of this gate, pressed in Motir, must carry a verdict. True on an awaiting
 *   `design_result`, and on an awaiting `acceptance_result` whose story has an open
 *   delivery of its own (a story run, `acceptance-refusal-verdict.md` §1); false on every
 *   other kind and state. `refusalVerdict` may now be set on a story run's
 *   `acceptance_result` as well.
 *
 *   Additive: one new field on an existing component (§8's allowed list); no existing
 *   field changes meaning. Still a READ — no v1 operation decides a gate.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.41.0` at `70c845f0a`, so this claims `1.42.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the FIELD. *
 * - `1.43.0` — MOTIR-6502 adds `repairClass` (`ci` | `acceptance_rerun`) and
 *   `acceptanceRefusal` (`{ reasonMd, decidedByLabel, decidedAt }`, nullable) to the
 *   `WorkItemRepairClaim` component `claimWorkItemRepair` answers. `acceptance_rerun`
 *   admits a story whose acceptance video was sent back with Re-run in Motir
 *   (`acceptance-refusal-verdict.md` §4): its checks may be green, so every open member
 *   is handed over, and the reason rides beside them. Every shipped admission is `ci`.
 *
 *   Additive: two new fields on an existing component (§8's allowed list) and a new
 *   admission of an existing operation; no existing field changes meaning.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: this claims `1.43.0` on top
 *   of MOTIR-6501's `1.42.0` in the same pull request. RENUMBER both if a sibling has
 *   taken either since.
 *
 * - `1.44.0` — MOTIR-6581 adds a work item's OBSOLESCENCE mark: `obsolescence`
 *   (`outdated` / `deprecated`, nullable) and `obsolescenceNoteMd` (Markdown,
 *   nullable) on `WorkItemDetail`, on the `WorkItemSummary` collection row and on
 *   the `ReadyItem` row, and as optional fields on the `createWorkItem` /
 *   `updateWorkItem` bodies (`null` clears either), on ANY kind and in ANY
 *   status. The enum is ONE new named component, `WorkItemObsolescence`, that
 *   every carrier `$ref`s. `INVALID_OBSOLESCENCE` (422) is the refusal for a
 *   value outside it — from the body schema and the service alike. The SAME
 *   story's MOTIR-6580 rides this entry too: the `supersedes` / `superseded_by`
 *   members of the links route's `relationship` enum, and the `supersedes` /
 *   `supersededBy` groups on `WorkItemLinkGroups` (newer item supersedes older).
 *
 *   Additive: new nullable response fields, new optional request fields, a new
 *   component, new enum members and link groups, and a new code for a new
 *   condition (§8's allowed list); no
 *   declared field changes meaning, and a marked card is neither hidden from nor
 *   re-sorted in any read. Gated on the same keys.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.43.0` at `e3be83c90` (MOTIR-6501 · MOTIR-6502 took `1.42.0` / `1.43.0`), so
 *   this claims `1.44.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the FIELD.
 *
 * - `1.45.0` — MOTIR-6547 adds `accessMode` (`workspace` / `members` / `public`) to
 *   the `Project` resource (Story MOTIR-6169): who may ENTER the project, the
 *   authoritative access field. `accessLevel` stays, DERIVED from the mode
 *   (`members` → `private`), so `limited` is never emitted again, and is marked
 *   deprecated. Additive: one new field, and every existing field keeps its type.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.45.0` on top of
 *   MOTIR-6581's `1.44.0` (it claimed `1.42.0`, then `1.44.0`, as siblings landed
 *   first). If a sibling has taken it since, RENUMBER this entry — it names the FIELD.
 *
 * - `1.46.0` — MOTIR-6528 adds `heartbeatDispatchRun`:
 *   `POST /api/v1/dispatch-runs/{id}/heartbeat`, no body, `204` — a LOCAL run says
 *   it is still alive (`docs/decisions/run-death-keeps-work.md` §2). And one field on
 *   the `DispatchRun` component: `lastHeartbeatAt` (nullable), when the run last did.
 *   `DISPATCH_RUN_TERMINAL` (409) answers a heartbeat on a closed run;
 *   `DISPATCH_RUN_NOT_FOUND` (404) an unknown, cross-tenant or another operator's run.
 *   MOTIR-6530 adds one field to the `DispatchPrompt` component, `branch`
 *   (nullable): the branch the prompt tells the agent to work on — the session
 *   branch, else the card's per-item branch — which a local run records on its
 *   leg's `checkout_ready` event.
 *   MOTIR-6532 adds `claimWorkItemContinue`: `POST /api/v1/work-items/{key}/continue`
 *   — the CONTINUE claim `motir continue <key>` makes on a work item whose last run
 *   died (`WorkItemContinueClaim` component; a refusal is a 200 with an `outcome`),
 *   and `continue` as a member of the `DispatchCommand` vocabulary.
 *   MOTIR-6531 adds one optional query parameter to `getWorkItemDispatchPrompt`,
 *   `continueFrom` (a dead run's id): the prompt then CONTINUES that run on its
 *   branch; an invalid one is `CONTINUE_FROM_INVALID` (422). Every git workflow
 *   also gains a checkpoint instruction (push after each commit) — prompt TEXT,
 *   not contract.
 *   MOTIR-6535 / MOTIR-6537: `WorkItemContinueClaim` also carries `resumedKeys`
 *   (the dead parent run's in-flight legs, now the caller's), and `claimScope`'s
 *   `work_item` body takes an optional `exceptLanded` (leave children already at
 *   Implemented or later out of the claim instead of refusing on them) — both for
 *   `motir continue <PARENT>`; a body without the flag claims exactly as before.
 *
 *   Additive: a NEW operation and NEW nullable fields (§8's allowed list); no
 *   existing field changes meaning. Gated on `work_item:edit`, a key
 *   `CLI_TOKEN_GRANT` already carries, so the grant is NOT widened.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.45.0` at `f9f970569`, so this claims `1.46.0` (renumbered from `1.42.0`
 *   and then `1.44.0`, which MOTIR-6501/6502 and MOTIR-6581/6547 took first). If a sibling has taken
 *   it since, RENUMBER this entry — it names the OPERATION.
 *
 * - `1.47.0` — MOTIR-6735 adds `mergeRefusal` to `WorkItemDetail.deliveries[]`: a
 *   delivering pull request whose merge Motir pressed and the HOST refused carries
 *   the refusal's `code`, the host's own message as `reason` (nullable), the head it
 *   refused and when — while it stands (not superseded, still at the current head,
 *   the pull request still open). The message is the only record of WHICH setting
 *   refused a `branch_protected` merge.
 *
 *   Additive: one new nullable field on an existing shape (§8's allowed list); no
 *   declared field changes meaning. Read-only, on the same `project:browse` read.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: `V1_CONTRACT_VERSION` was `1.46.0` at
 *   `520148f5c`, so this claims `1.47.0`. If a sibling has taken it since, RENUMBER
 *   this entry — it names the FIELD.
 *
 * - `1.48.0` — MOTIR-6672 · MOTIR-6673: a mark is a FINISHED card's state. Two new
 *   codes for two new conditions, both 422 and both with an additive payload:
 *   `OBSOLESCENCE_REQUIRES_FINISHED` (`item`: the key, status and its category) on
 *   `createWorkItem` / `updateWorkItem` when a mark is SET on a card whose status is
 *   outside the done category, and `MARKED_CARD_CANNOT_REOPEN` (`mark`: the key, the
 *   mark and the refused target) on `transitionWorkItem` for a marked card's move out
 *   of the done category, and on the two writes for new work under a marked parent.
 *   Both are named in the three operations' descriptions, and their bodies are
 *   declared beside the other refusal bodies (`obsolescenceRequiresFinishedSchema`,
 *   `markedCardCannotReopenSchema`). This narrows what 1.44.0 documented ("any status") —
 *   the story's decision (MOTIR-6575), recorded here so the number says the rule
 *   moved. No field changes shape.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.47.0` at the merge of `origin/main` that brought MOTIR-6735 (which took
 *   `1.47.0` first — this entry was renumbered from it), so this claims `1.48.0`. If a
 *   sibling has taken it since, RENUMBER this entry — it names the CODES.
 *
 * - `1.49.0` — MOTIR-6558 adds `getDispatchRun` (`GET /api/v1/dispatch-runs/{id}`):
 *   one run with its SET, the same `DispatchRun` component the ingest operations
 *   already answer with. A hosted run is opened by the SERVER, and the `motir`
 *   CLI in its container ADOPTS it (`hosted-run-runs-the-cli-as-the-app.md` §3) —
 *   this read is how it learns the cards it owns, in the run's own order. A run's
 *   own credential may read its own run and no other.
 *
 *   Additive: one new READ operation reusing an existing component (§8's allowed
 *   list); nothing existing changes.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.48.0` on `origin/main` when this was merged (MOTIR-6735 took `1.47.0`
 *   and MOTIR-6672/6673 `1.48.0` after MOTIR-6528, MOTIR-6530, MOTIR-6532,
 *   MOTIR-6531 and MOTIR-6535/6537 took `1.46.0` together), so this claims
 *   `1.49.0`. If a sibling has taken it since, RENUMBER this entry — it names the
 *   OPERATION.
 *
 * - `1.50.0` — MOTIR-6538 adds `issueDispatchRunGitCredentials`:
 *   `POST /api/v1/dispatch-runs/{id}/git-credential`, a running HOSTED run's git
 *   credentials — one entry per repository of the run, each an installation token
 *   of the Motir GitHub App that writes it, with the App's bot as author and the
 *   dispatcher named only as `dispatchedBy`
 *   (`docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §5).
 *
 *   Additive: a NEW operation (§8's allowed list); no existing operation, field
 *   or code changes meaning. It answers ONLY a hosted run's own credential
 *   (`DISPATCH_RUN_TOKEN_OUT_OF_SCOPE`, 403, for any other token, a person's
 *   included), so no person's grant is widened by it.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.49.0` after MOTIR-6558, so this claims `1.50.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the OPERATION.
 *
 * - `1.51.0` — MOTIR-6539 adds `workBranch` (nullable) to the `DispatchPrompt`
 *   component `getWorkItemDispatchPrompt` answers: the branch the prompt tells the
 *   agent to CREATE for its work — the same name in every repository the item
 *   ships in — or `null` for a manual item. A runner names it on `checkout_ready`
 *   before the agent exists, and pushes it as the agent commits so a run that dies
 *   leaves its work on origin.
 *
 *   Additive: one new nullable field on an existing component (§8's allowed list);
 *   nothing existing changes meaning, and `sessionBranch` still names the lineage.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.50.0` after MOTIR-6538, so this claims `1.51.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the FIELD.
 *
 * - `1.52.0` — MOTIR-6791 adds `branches` to `WorkItemContinueClaim`: EVERY
 *   repository's branch of the dead run, primary first — `{ repository, branch,
 *   pullRequest }` — because a run that spanned several repositories pushed a
 *   branch in each and `branch` could only name one. `branch` stays, equal to the
 *   primary repository's entry. The CONTINUE block of `getWorkItemDispatchPrompt`
 *   names each repository's branch — prompt TEXT, not contract.
 *
 *   Additive: one new array field on an existing shape (§8's allowed list); no
 *   declared field changes meaning.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.51.0` after MOTIR-6539, so this claims `1.52.0`. If a sibling has taken
 *   it since, RENUMBER this entry — it names the FIELD.
 *
 * - `1.53.0` — MOTIR-6795 adds `continues` to `DispatchRun`, filled only by
 *   `getDispatchRun` and only for a `continue` run: the dead run it carries on,
 *   every repository's branch (each with its repository's clone URL, so a
 *   repository no remaining leg touches can still be closed out), and for a
 *   parent the legs that landed and the ones in flight. A hosted container ADOPTS the run the server's continue claim
 *   opened instead of claiming, so this is how it learns what that claim decided.
 *
 *   Additive: one new optional, nullable field on an existing shape (§8's allowed
 *   list); no declared field changes meaning.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.53.0` after this
 *   branch's own `1.52.0`. If a sibling has taken either since, RENUMBER.
 *
 * - `1.54.0` — MOTIR-6832 adds the three READY LANES (Story MOTIR-6829):
 *   `getProjectReadyLeaves` (`GET /api/v1/projects/{projectKey}/ready/leaves`),
 *   `getProjectReadyContainers` (`…/ready/containers`) and `getProjectReadyBugs`
 *   (`…/ready/bugs`) — the ready set partitioned the way work is run, each lane
 *   row naming its runnable `container`, with the new `ReadyLaneItem` and
 *   `ReadyContainer` components.
 *
 *   Additive: three new READ operations (§8's allowed list). The flat ready set
 *   is unchanged; the user's 2026-09-28 decision deletes it in a later task, once
 *   the released CLI no longer calls it (`1.55.0`).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE, the same rule: `V1_CONTRACT_VERSION`
 *   was `1.53.0` after MOTIR-6791 (`1.52.0`) and MOTIR-6795 (`1.53.0`) merged while
 *   this branch held `1.52.0`, so it was RENUMBERED to `1.54.0`. If a sibling has
 *   taken it since, RENUMBER this entry — it names the OPERATIONS.
 *
 * - `1.55.0` — MOTIR-6841 DELETES the flat ready set, `GET
 *   /api/v1/projects/{projectKey}/ready`: its operation, its route (now a 404) and
 *   a hosted run's token grant for it. The three lanes of `1.54.0` replace it —
 *   `getProjectReadyLeaves` plus `getProjectReadyBugs` hold exactly its rows, with
 *   the same facets and cascade — and `@motir/cli` 0.8.0, published with the
 *   sandbox images at `cli-v0.8.0` (MOTIR-6840), reads only the lanes.
 *
 *   NOT additive, and deliberately so: a removal is what §8 reserves for a new
 *   major. The user decided on 2026-09-28 that this one operation is DELETED
 *   rather than deprecated, because nothing else calls it; the decision is
 *   recorded here and on MOTIR-6841, and it overrides §8 for this operation only.
 *   A MINOR, because the path version stays `1` and every other operation is
 *   untouched. The two lanes' descriptions also stop naming the deleted read.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: `V1_CONTRACT_VERSION` was `1.54.0`
 *   at `58946b8a0`, so this claims `1.55.0`. If a sibling has taken it since,
 *   RENUMBER this entry.
 *
 * - `1.56.0` — MOTIR-6818 (Story MOTIR-1626, the review agent) adds `review` to
 *   `DispatchCommand`: a hosted REVIEW run the server opens for an `agent_review`
 *   gate (`docs/decisions/hosted-agent-run.md` §8). No operation writes it yet. The
 *   approval-gate record gains `agent_review` (kind), `review_agent` (authority) and
 *   `review_agent_disabled` (supersede cause) — `docs/decisions/approval-gates.md` §12.
 *
 *   Additive: new members of enums every client must tolerate unknown members of
 *   (§8's allowed list); no declared field changes meaning.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: `V1_CONTRACT_VERSION` was `1.55.0`
 *   after MOTIR-6841, so this claims `1.56.0`. If a sibling has taken it since,
 *   RENUMBER this entry — it names the ENUM MEMBER.
 *
 * - `1.57.0` — MOTIR-6821 (Story MOTIR-1626, the review agent) adds the hosted REVIEW
 *   run's two operations (`docs/decisions/hosted-agent-run.md` §8.2 / §8.4):
 *   `getWorkItemReviewPrompt` (`GET …/work-items/{key}/review-prompt`, the server-assembled
 *   review brief with every pull request at its reviewed head) and
 *   `submitWorkItemAgentReview` (`POST …/work-items/{key}/agent-review`, the run's ONE
 *   verdict deciding the `agent_review` gate as `review_agent`), with the components
 *   `ReviewPrompt` and `AgentReviewResult`. Both answer ONLY a `review` run's own
 *   credential, for its own card.
 *
 *   Additive: two new operations; no declared shape changes.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.57.0` after MOTIR-6818's
 *   `1.56.0`, and the sibling MOTIR-6822 claims `1.58.0` above it on the same branch. If
 *   either number is taken on `origin/main` by then, RENUMBER — it names the OPERATIONS.
 *
 * - `1.58.0` — MOTIR-6822 (Story MOTIR-1626, the review agent) adds `review` to the
 *   `WorkItemRepairClaim` component's `repairClass`, and `reviewRefusal`
 *   (`{ gate, findingsMd, reviewerName, decidedAt }`, nullable) beside it. `review` is a
 *   card a REVIEW sent back — the review agent's `changes_requested` on `agent_review`, or
 *   a person's Request changes on the approve-and-merge gate — still standing over the
 *   current delivery-set version (`approval-gates.md` §12.4, §12.7): `motir fix` claims it
 *   though its checks are green, and its prompt carries the findings in full.
 *
 *   Additive: a new member of an enum every client must tolerate, and a new nullable
 *   field (§8's allowed list). A client that predates it reads `review` as an unknown
 *   class and runs its CI loop, which finds nothing red — it changes nothing.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.58.0` because the sibling
 *   MOTIR-6821 claims `1.57.0` on the same story branch. If either number is taken on
 *   `origin/main` by then, RENUMBER this entry — it names the ENUM MEMBER and the FIELD.
 *
 * - `1.59.0` — MOTIR-6929 (Story MOTIR-1626, the hosted repair) adds `repair` to
 *   `DispatchRun`, filled only by `getDispatchRun` and only for a HOSTED `fix` run: the
 *   repair class, every pull request on its OWN branch with the head it was handed, and
 *   the review's findings (gate, version, text, reviewer, decider, authority, when), as
 *   the repair claim's hosted opening recorded them on `run_opened` (MOTIR-6928). The
 *   container ADOPTS the run instead of claiming a second time, so this is how it learns
 *   what that claim decided — `continues` (1.53.0) for the repair.
 *
 *   Additive: one new optional, nullable field on an existing shape (§8's allowed list).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.59.0` after MOTIR-6822's
 *   `1.58.0` on the same story branch. If it is taken on `origin/main` by then, RENUMBER
 *   this entry — it names the FIELD.
 *
 * - `1.60.0` — MOTIR-7023 (Story MOTIR-6864, a run in your agent) adds `instance` to
 *   `DispatchRunOrigin` — a run inside one of the developer's own agents
 *   (`docs/decisions/agent-instance-run.md` §5) — and `agentInstance`
 *   (`{ id, name, profile, profileLabel }`, nullable) to `DispatchRun`. Only the server
 *   opens such a run: `openDispatchRun` REFUSES `origin: "instance"` (400).
 *
 *   Additive: a new member of an enum every client must tolerate, and a new nullable
 *   field (§8's allowed list).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.60.0` after MOTIR-6929's
 *   `1.59.0`. If a sibling has taken it since, RENUMBER this entry — it names the ENUM
 *   MEMBER and the FIELD.
 *
 * - `1.61.0` — MOTIR-7146 adds `subject_gone` to the approval-gate record's supersede
 *   cause: a gate whose subject no longer resolves through its kind's handler is
 *   withdrawn when a read observes it.
 *
 *   Additive: a new member of an enum every client must tolerate (§8's allowed list).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.61.0` after MOTIR-7023's
 *   `1.60.0`. If a sibling has taken it since, RENUMBER this entry — it names the ENUM
 *   MEMBER.
 *
 * - `1.62.0` — MOTIR-7474 (Story MOTIR-7460) adds `manual_work` to the approval-gate
 *   KIND — a manual card a run reached, waiting on a person
 *   (`docs/decisions/manual-work-gate.md`) — and `no_longer_manual` and
 *   `closed_without_decision` to its supersede cause.
 *
 *   Additive: new members of enums every client must tolerate (§8's allowed list).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.62.0` after MOTIR-7146's
 *   `1.61.0`. If a sibling has taken it since, RENUMBER this entry — it names the ENUM
 *   MEMBERS.
 *
 * - `1.63.0` — MOTIR-7640 (Story MOTIR-7630; `agent-authored-plans.md` AMENDMENT 23
 *   §5) adds the SESSION form of `PLAN_TARGET_HELD`'s `plan` payload: a card an OPEN
 *   planning session holds is refused a move out of Planning before any plan exists.
 *   Every `plan` now carries `kind` (`plan` | `session`); the session form has
 *   `planId` and `planStatus` null, its holding `sessionId`, and `holderId` /
 *   `holderName` / `heldByViewer`.
 *
 *   Additive in what a client meets on the existing condition: a plan hold's payload
 *   is unchanged but for the new `kind` field. The session form is a NEW condition of
 *   the same code, and a client written against the plan form must read `kind`
 *   before `planId`.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.63.0` after MOTIR-7474's
 *   `1.62.0`. If a sibling has taken it since, RENUMBER this entry.
 *
 * - `1.64.0` — MOTIR-7708 (Story MOTIR-7701) lets the continue claim RESUME a run that
 *   stopped at a gate (closed `gated`) once a gate it stopped on is approved. The
 *   claim's refusal `reason` gains `gate_awaiting` and `gate_sent_back`, and
 *   `WorkItemContinueClaim` gains `gates` (`{ key, kind, state }[]`, the gates a gated
 *   run stopped on) and `resumesGated` (true on a resume).
 *
 *   Additive: new members of an enum every client must tolerate, and two new fields on
 *   an existing shape (§8's allowed list).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.64.0` after MOTIR-7640's
 *   `1.63.0`. If a sibling has taken it since, RENUMBER this entry — it names the ENUM
 *   MEMBERS and the FIELDS.
 *
 * - `1.65.0` — MOTIR-8098 (Story MOTIR-7731) adds CONTENT LANGUAGES to work items.
 *   `WorkItemDetail` gains `languages` (`{ title, description, explanation }`, each a
 *   locale code or `null` when none was recorded), and the create / update bodies
 *   accept `language` and `languages` — the language the written text is in.
 *
 *   Additive: a new field on an existing shape and new optional body fields (§8's
 *   allowed list).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.65.0` after MOTIR-7708's
 *   `1.64.0`. If a sibling has taken it since, RENUMBER this entry — it names the
 *   FIELDS.
 *
 * - `1.66.0` — MOTIR-8600 (Story MOTIR-8548) makes the 429 RETRYABLE BY MACHINE: the
 *   error body gains an optional numeric `retryAfterSeconds`, sent on a rate-limit
 *   refusal, and the 429 response gains a `Retry-After` header carrying the same
 *   number. The code stays `RATE_LIMIT_EXCEEDED`.
 *
 *   Additive: a new optional field on an existing shape and a new response header
 *   (§8's allowed list; ADR §6's 2026-10-14 amendment).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.66.0` after MOTIR-8098's
 *   `1.65.0`. If a sibling has taken it since, RENUMBER this entry — it names the
 *   FIELD and the HEADER.
 *
 * - `1.67.0` — MOTIR-8670 adds `not_ready` and `replanned` to the approval-gate
 *   supersede cause: a `manual_work` gate is withdrawn when its card is Blocked or gains
 *   an open `blocked_by`, and when it is re-planned (`docs/decisions/manual-work-gate.md`
 *   §6, amended).
 *
 *   Additive: new members of an enum every client must tolerate (§8's allowed list).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.67.0` after MOTIR-8600's
 *   `1.66.0`. If a sibling has taken it since, RENUMBER this entry — it names the ENUM
 *   MEMBERS.
 *
 * - `1.68.0` — MOTIR-8698 adds `reportDispatchRunUnbuildable`:
 *   `POST /api/v1/dispatch-runs/{id}/unbuildable`, body `{ targetKey, reason }`, `200`
 *   with `UnbuildableReportAcknowledgement` (`{ acknowledged, recordedOnRun }`) — the
 *   run-found report made by the CLI with the run's own credential, so a hosted run, a
 *   run inside an agent instance and an agent with no Motir MCP all reach it
 *   (`run-found-trigger-dispatched-path.md` AMENDMENT 1). A run token may call it for
 *   its own run (`runTokenRoutes.ts`, binding `own_run`).
 *
 *   Additive: a new operation and a new component (§8's allowed list).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.68.0` after MOTIR-8670's
 *   `1.67.0`. If a sibling has taken it since, RENUMBER this entry — it names the
 *   OPERATION.
 *
 * - `1.69.0` — MOTIR-8722 adds `recordDispatchRunDiscrepancy`
 *   (`POST /api/v1/dispatch-runs/{id}/discrepancy`, body `{ key, points }`, `200` with
 *   `RunDiscrepancyAcknowledgement` — `{ commentId, recorded }`) and `reportDispatchRunStop`
 *   (`POST /api/v1/dispatch-runs/{id}/stop`, body `{ key, comment, toPlanning, requirement? }`,
 *   `200` with `RunStopReportAcknowledgement` — `{ commentId, movedToPlanning }`): the CLI
 *   records a build-through and a STOP with the run's own credential, so a hosted run and a
 *   run inside an agent instance reach both (`run-found-trigger-dispatched-path.md`
 *   AMENDMENT 2). A run token may call both for its own run (`runTokenRoutes.ts`, `own_run`).
 *
 *   Additive: two new operations and two new components (§8's allowed list).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.69.0` after MOTIR-8698's
 *   `1.68.0`. If a sibling has taken it since, RENUMBER this entry — it names the
 *   OPERATIONS.
 *
 * - `1.70.0` — MOTIR-8810 adds the optional `agentReport` query parameter to
 *   `getWorkItemDispatchPrompt`: `1` declares that the client posts what its agent writes
 *   into `$MOTIR_AGENT_REPORT` as `unbuildable`, `discrepancy` and `stop`. Absent, the STOP
 *   branch routes the report through `report_unbuildable_target` again and names neither
 *   file route — `@motir/cli` 0.12.0 sends nothing and posts none of the three, so the
 *   prompt MOTIR-8698 deployed lost every report it handled
 *   (`run-found-trigger-dispatched-path.md` AMENDMENT 3).
 *
 *   Additive: a new optional parameter; a client that omits it is answered a prompt it
 *   can act on.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.70.0` after MOTIR-8722's
 *   `1.69.0`. If a sibling has taken it since, RENUMBER this entry — it names the
 *   PARAMETER.
 *
 * - `1.71.0` — MOTIR-5427 adds the `under-authored` dispatch advisory shape: a childless
 *   card with no enumerated acceptance criterion and null `storyPoints`,
 *   `estimateMinutes`, `type` and `executor`, carrying `criteria` (`no-heading` or
 *   `no-criterion`). Never a gate.
 *
 *   Additive: one new member of an advisory union whose severity is explicitly
 *   open-ended (§8's allowed list); no existing shape changes.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.71.0` after MOTIR-8810's
 *   `1.70.0`. If a sibling has taken it since, RENUMBER this entry.
 *
 * - `1.72.0` — MOTIR-9029 adds `getSectionSets` (`GET /api/v1/section-sets`, optional
 *   `kind` and `type` query parameters, `200` with `SectionSets`) and the code
 *   `UNKNOWN_SECTION_CELL` (422): which sections a work item of a kind × type has, which
 *   are required and the heading each renders under in the free-text `descriptionMd`.
 *   The same descriptor the MCP `get_section_sets` tool serves.
 *
 *   Additive: a new operation, a new component and a new code for a new condition
 *   (§8's allowed list).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.72.0` after MOTIR-5427's
 *   `1.71.0`. If a sibling has taken it since, RENUMBER this entry — it names the
 *   OPERATION.
 *
 * - `1.73.0` — MOTIR-9031 adds an optional `sections` object to the `createWorkItem` and
 *   `updateWorkItem` bodies (named sections the service checks against the registry for
 *   the item's kind × type and renders into `descriptionMd`; sparse on PATCH), an optional
 *   `sections` field on the error body (`missing` / `unknown` / `invalid`, by name), and the
 *   codes `INVALID_SECTIONS` and `SECTIONS_AND_DESCRIPTION_CONFLICT` (422). `descriptionMd`
 *   stays the one stored, always-free-text body and a write without `sections` is unchanged.
 *
 *   Additive: two new optional request fields, a new optional response field and two new
 *   codes for new conditions (§8's allowed list).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.73.0` after MOTIR-9029's
 *   `1.72.0`. If a sibling has taken it since, RENUMBER this entry — it names the FIELD.
 *
 * - `1.74.0` — MOTIR-9052 (Story MOTIR-8981) adds the optional nullable `repair.resume`
 *   (`profile`, `sessionId`, `canResume`) to `getDispatchRun`: the profile and recorded
 *   session of the card's last agent run, which an agent-door `fix` run opened with so
 *   the CLI can resume that conversation.
 *
 *   Additive: one new optional response field.
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.74.0` after MOTIR-9031's
 *   `1.73.0`. If a sibling has taken it since, RENUMBER this entry.
 *
 * - `1.75.0` — MOTIR-9493 (Story MOTIR-9486) adds the page resource: `createPage`
 *   (`POST /api/v1/projects/{projectKey}/pages`, `page:edit`, `201` with `Page`) and
 *   `getPage` (`GET /api/v1/pages/{pageId}`, `page:view`, `200` with `Page`), and MOTIR-9494's
 *   `updatePage` (`PATCH /api/v1/pages/{pageId}`, `page:edit`, the whole body with the
 *   `revision` read; a stale one is `PAGE_REVISION_CONFLICT` 409), and MOTIR-9495's `movePage`
 *   (`PATCH /api/v1/pages/{pageId}/placement`, `page:edit`, `200` with `PagePlacement`) — a page's
 *   title, placement, `revision` and markdown body, over the same `pagesService` doors as
 *   the MCP `create_page` / `get_page`. The page refusal codes (`PAGE_NOT_FOUND`,
 *   `CROSS_PROJECT_PAGE_PARENT`, `PAGE_PARENT_ARCHIVED`, `PAGE_PARENT_NOT_ALLOWED`,
 *   `PAGE_DEPTH_EXCEEDED`, `PAGE_TITLE_TOO_LONG`, `PAGE_BODY_TOO_LARGE`, …) are the
 *   package's own.
 *
 *   Additive: four new operations, two new components and new codes for new conditions
 *   (§8's allowed list).
 *
 *   ⚠️ RE-READ ON `origin/main` BEFORE MERGE: this claims `1.75.0` after MOTIR-9052's
 *   `1.74.0`. If a sibling has taken it since, RENUMBER this entry — it names the
 *   OPERATIONS.
 */
export const V1_CONTRACT_VERSION = '1.75.0';
