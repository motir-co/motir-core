// The motir-core-side mirror of the boundary envelope (docs/ai-boundary.md →
// motir-ai/docs/contract.md §2/§3/§5). motir-core CANNOT import motir-ai (open-
// core boundary), so each side declares its own types against the shared
// contract. These are the shapes the client (lib/ai/motirAiClient.ts) sends and
// receives.

import type { GuideContext } from '@/lib/ai/guideWorkItem';
import type { TranslateJobInput } from '@/lib/ai/translate';
import type { Locale } from '@/lib/i18n/locales';

export const ENVELOPE_VERSION = 'v1' as const;

// The jobKind enum. `noop` is the 7.1.7 walking skeleton; `discovery` is the
// 7.3 onboarding interview the chat front door submits (aiChatService) — its
// user turns ride in `JobContextBag.prompt` and the drafted direction docs in
// `JobContextBag.discovery`; the rest are reserved for the 7.4+ generation jobs.
export const JOB_KINDS = [
  'noop',
  'discovery',
  'generate_explanation',
  // `analyze_bug` (Story 7.6 — MOTIR-967 handler / MOTIR-1481 trigger) — the
  // OUTWARD self-improving loop: motir-core's `work-item/created` trigger
  // dispatches a user-project `kind: bug` here so motir-ai classifies its root
  // cause and, when Motir is at fault, files a SANITIZED meta-bug into MOTIR +
  // captures the lesson (it writes NO plan delta). This is the motir-core mirror
  // of the closed enum in motir-ai/src/envelope.ts — each side declares its own
  // types against the shared contract (the open-core boundary).
  'analyze_bug',
  // `propose_convention` (Story 7.14 — MOTIR-1601 handler) — the coding-convention
  // engine. The FRESH establish-only path this trigger (7.3.10 · MOTIR-839) fires
  // at onboarding completion: motir-ai derives a convention FROM THE CHOSEN STACK
  // ALONE (no repo, no audit) and records it `status: proposed` via the 7.14.3
  // store, so a fresh project reaches the 7.14.5 adopt→standard surface with a
  // proposal to adopt. The stack hint rides `context.code.stack`; the motir-ai
  // handler auto-selects fresh-vs-migrate off the project's indexed code graph.
  // Mirror of the closed motir-ai enum (the open-core boundary).
  'propose_convention',
  // `plan_sprint` (Story 7.13 — MOTIR-917 handler / MOTIR-918 consumer) — the
  // SPRINT PACKING job. Over the project's schedulable open leaves + their
  // `is_blocked_by` edges (read back over the 7.1.6 token) it packs a
  // dependency-correct, capacity-bounded sequence of SHORT agent-cadence sprints
  // and returns the versioned sprint-assignment delta on its result
  // (`sprintAssignment`, below). Its schedule is DETERMINISTIC — a pure
  // scheduler, never model-invented. It writes NOTHING: no plan delta
  // (`operations: []`) and no sprint. THIS repo persists the proposal through
  // the Epic-4 sprint services behind a human approve
  // (`aiSprintPlanningService.approveSprintPlan`). Mirror of the closed motir-ai
  // enum (the open-core boundary) — adding it here closes the drift motir-ai's
  // envelope.ts documented while its consumer was unbuilt.
  'plan_sprint',
  // `ask_project` (Story MOTIR-1343 — MOTIR-1817 handler / MOTIR-1819 consumer)
  // — the ANSWERING job behind "Ask about this project": a question answered from
  // the plan tree + code graph with CITATIONS, writing no plan delta and changing
  // no work item. Adding it HERE closes the drift motir-ai's envelope documented
  // while this consumer was unbuilt.
  //
  // ⚠️ It is also the CONVERSATION'S DOOR (`docs/decisions/conversation-turn-intent.md`
  // §2): the person types into one composer with no mode to pick, so EVERY user
  // turn is submitted as this kind, and the handler's first turn decides whether
  // to answer it or hand it back as `intent: 'plan_change'` — at which point core
  // dispatches the SHIPPED plan-change submit for the same turn. Mirror of the
  // closed motir-ai enum (the open-core boundary).
  'ask_project',
  // `plan` (Story MOTIR-3943 · MOTIR-4304 — ADR `motir-ai/docs/decisions/session-model.md`
  // §6 step 2) — THE ONE PLANNING KIND. Every planning submit in the product sends
  // it: `startGeneration`, `submitAugment`, `submitContextual`, `submitExpand`
  // and `submitRevise` (`submitReplan` went with its route, MOTIR-4261), plus the
  // auto-plan cadence trigger, which
  // reaches the wire only through `submitExpand` and so inherits the switch.
  //
  // ⚠️ IT REPLACES A DISTINCTION NOTHING CONSUMED. The five planning kinds above
  // all route through one walk on the far side (MOTIR-3940), so the kind was
  // transport carrying an operation name — and an operation is derivable from
  // what the request already says, which is why naming it added no information
  // and created a second place for the answer to drift. What motir-ai resolves
  // the run from is the CONTEXT: `context.planId` names a plan, `rootItemKey` /
  // `targetKeys` a work item, and NEITHER means plan the project.
  //
  // ⚠️ THE FIVE ARE GONE (MOTIR-4308). motir-ai stopped ACCEPTING them in
  // MOTIR-4306, so a copy here would name values the other side refuses — which
  // is the one thing a mirror must never do. This is the last card of ADR §6's
  // three-step sequence, and it runs last for a reason: while motir-core still
  // declared them the switch (MOTIR-4304) stayed revertible on its own.
  'plan',
  // `author_bug` (Story MOTIR-4930 — MOTIR-5847/5848 handler / MOTIR-5849 trigger)
  // — ONE error-monitor issue's facts (`context.bugAuthoring`, below) → a PLANNED
  // bug as the typed `authoredBug` result: both bodies, a type, an executor, a
  // sizing pair, context refs grounded in the project's code graph, and candidate
  // mechanisms. An analysis job — it writes NO plan delta and creates nothing;
  // motir-core carries the answer onto the bug itself (MOTIR-5851). NOT
  // `analyze_bug`, which classifies Motir's OWN defects. Mirror of the closed
  // motir-ai enum (the open-core boundary).
  'author_bug',
  // `guide_work_item` (Story MOTIR-7459 — MOTIR-7463 handler / MOTIR-7464 dispatch)
  // — the conversation's FOURTH intent (`docs/decisions/conversation-turn-intent.md`
  // AMENDMENT 2), chosen by the Guide me through DOOR rather than a classifier: core
  // submits one for every user turn of a `guide`-origin session
  // (`aiGuideService`), carrying the card, its to-do rows and the turns so far as
  // `context.guideContext`. It returns ONE `guideTurn` and writes nothing; core
  // lands its actions (MOTIR-7470). Mirror of the closed motir-ai enum.
  'guide_work_item',
  // `sharpen_turn` (Task MOTIR-1101 — MOTIR-8176 handler / MOTIR-8181 dispatch) —
  // ONE turn of a Sharpen grilling session on a plan or one work item. Core
  // submits one per person action (`aiSharpenService`), carrying the scope, the
  // transcript, the STORED settled answers and assumptions and the action as
  // `context.sharpen`. It returns ONE `sharpenTurn`; at a session end the handler
  // itself writes the settled answers back through `PUT
  // /api/internal/ai/plan-sharpening`. Mirror of the closed motir-ai enum.
  'sharpen_turn',
  // `translate` (Story MOTIR-7735 — MOTIR-8116 handler / MOTIR-8119 client) — a
  // reader's on-demand Translate press: core sends ONE target language and the
  // field texts that need it as `context.translate` (`requestTranslation`,
  // lib/ai/translateClient.ts), and motir-ai answers one text per `fieldRef` as
  // the typed `translations` result, priced in the `translation` lane. It writes
  // nothing; core keeps the answer (the translation door). Mirror of the closed
  // motir-ai enum (the open-core boundary).
  'translate',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface Tenant {
  // The org the job runs within — the billing entity (6.10). motir-core resolves
  // a project's workspace's org and sends it (Subtask 7.2.16); motir-ai keys its
  // org-level credit ledger (7.2.6) to it. Required on every submit.
  organizationId: string;
  // Whether the org is the META org (moooon B.V., `Organization.isMeta`).
  // Propagated so motir-ai's credit gate (out-of-credits) bypasses it — the meta
  // org is never billed. Defaults to false for any non-meta / self-host caller.
  isMeta: boolean;
  // Whether the org is charged exactly like a CUSTOMER and then made whole
  // (`Organization.internalBilling`, MOTIR-4565). motir-ai pairs every debit
  // such an org incurs with an offsetting `internal_offset` credit in the SAME
  // transaction, so the balance nets to zero while both entries stay visible
  // (`docs/decisions/internal-billing-classification.md` §2–§3).
  //
  // ⚠️ IT IS NOT `isMeta` ABOVE, AND IT IS ALMOST THE OPPOSITE OF IT. `isMeta`
  // makes the far side SKIP a charge; this makes it charge in full and then
  // credit. The two are true together on exactly one org today and that
  // coincidence is not identity — §9.1 of `code-graph-index-fleet.md` warns in
  // writing against overloading the first flag, which is why this is a second.
  //
  // ⚠️ OPTIONAL, AND THAT IS THE WIRE CONTRACT RATHER THAN A CONVENIENCE.
  // Absent means `false`, and the consumer (motir-ai MOTIR-4569) parses it that
  // way — which is what makes merge order between the two repositories FREE in
  // both directions: an older motir-ai reading a newer envelope ignores the
  // field, and a newer motir-ai reading an older one reads `false`. Typing it
  // REQUIRED here would assert something stronger than the wire does, and would
  // make an envelope built without it (an older caller, a fixture, a replayed
  // payload) unrepresentable while it is in fact legal and correctly read.
  //
  // Every SHIPPED construction site sets it — `resolveTenantOrg` returns it
  // non-optionally, so a site that has the org has the flag. The optionality is
  // about what a RECEIVER must tolerate, not about what a producer may skip.
  internalBilling?: boolean;
  // Whether the planner may use WEB SEARCH for this org — the `web_search`
  // per-org kill-switch (MOTIR-750). Set by `submitJob` to `false` ONLY when the
  // switch is off; ABSENT means allowed, the same additive wire contract as
  // `internalBilling` above, so merge order with motir-ai is free. A motir-ai that
  // does not yet read it simply keeps searching — the switch is then recorded and
  // sent, and takes effect when the far side honours it.
  webSearch?: boolean;
  // THE TWO LANGUAGES A WRITING JOB WRITES IN (Story MOTIR-7734 · MOTIR-8737).
  // The producer is `resolveTenantLanguages` (`lib/ai/tenantLanguages.ts`):
  // `contentLanguage` is the org's content language — stored work content is
  // written in it; `personLanguage` is the saved account language of the person
  // the job answers — replies and explanations are written in it.
  //
  // ⚠️ `personLanguage: ''` IS NOT `personLanguage` ABSENT. `''` says "no
  // requesting person" (a schedule or a monitor started the job); motir-ai then
  // writes explanations in the content language. ABSENT means a producer forgot
  // the field, and motir-ai REFUSES a writing job that lacks either (MOTIR-8736).
  //
  // Optional on the TS type for the same wire reason as `internalBilling`: older
  // fixtures and the non-writing kinds stay representable. The six writing kinds
  // (`plan`, `ask_project`, `generate_explanation`, `author_bug`, `debug_bug`,
  // `analyze_bug`) always set both.
  contentLanguage?: Locale;
  personLanguage?: Locale | '';
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

// ── analyze_bug context (Story 7.6 — MOTIR-967 handler / MOTIR-1481 trigger) ──
// motir-core's mirror of the `context.bugAnalysis` unit motir-ai's analyze_bug
// handler parses (motir-ai/src/jobs/handlers/analyzeBug.ts `parseAnalyzeBugInput`
// + llm/bugRootCause.ts `BugRootCauseContext`). Each side declares its own types
// against the shared contract (the open-core boundary — motir-core cannot import
// motir-ai). Assembled by the trigger over the 7.1.6 read-back and sent INLINE:
// motir-ai does NOT re-read the bug, so every field it reasons over ships here.

/** One plan-tree node around the bug, tagged with its role relative to it. */
export interface BugAnalysisPlanNode {
  key: string;
  kind: string;
  title: string;
  role: 'owning_epic' | 'owning_story' | 'implicated_subtask' | 'sibling';
  type?: string | null;
  status?: string | null;
  descriptionMd?: string | null;
}

/** The dispatch / PR signal that tells a coding-agent mistake from a planning
 *  one. Absent for a user-filed bug (only Motir's own dispatched work carries
 *  it, and those are skipped); kept for parity with the handler contract. */
export interface BugAnalysisDispatchSignal {
  subtaskKey: string;
  dispatchPromptExcerpt?: string | null;
  prStatus?: string | null;
}

/**
 * What an `author_bug` job authors a planned bug FROM (Story MOTIR-4930 ·
 * MOTIR-5849) — the motir-core mirror of motir-ai's `context.bugAuthoring` hole
 * (`src/jobs/handlers/authorBug.ts` `parseAuthorBugInput`). Assembled INLINE by
 * the enrichment trigger: motir-ai re-reads nothing. The repository set it
 * grounds against rides the ordinary `context.code` hole beside it.
 */
export interface BugAuthoringContext {
  issue: {
    title: string;
    culprit: string | null;
    level: string | null;
    eventCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    permalink: string | null;
  };
  environment: string | null;
  release: string | null;
  frames: Array<{
    filePath: string;
    function: string | null;
    lineNumber: number | null;
    inApp: boolean | null;
  }>;
  monitoredProjectSlug: string | null;
}

/** The full analysis unit the trigger assembles and motir-ai classifies over. */
export interface BugAnalysisContext {
  /** The user bug's human key (e.g. `ACME-42`) — REQUIRED by the handler. */
  bugKey: string;
  /** The bug text — `title` + `descriptionMd` are REQUIRED by the handler;
   *  `comments` are structurally empty at create time (the trigger fires on
   *  `work-item/created`), carried for contract parity. */
  bug: { title: string; descriptionMd: string; comments?: string[] };
  planNeighborhood: BugAnalysisPlanNode[];
  dispatch?: BugAnalysisDispatchSignal | null;
  implicatedPlanningPhase?: 'onboarding_planning' | 'regular_planning' | null;
  /** Extra terms motir-ai's sanitization backstop must never emit verbatim.
   *  motir-ai adds `tenant.projectKey` itself, so this is usually empty. */
  confidentialTerms?: string[];
}

/** The four grilling branches a Sharpen question belongs to (motir-ai's closed set). */
export type GrillingBranch = 'workflow' | 'alternative' | 'non_happy' | 'technical_thread';

/** What the person did on a Sharpen turn. `start` opens a session. */
export type SharpenAction = 'start' | 'answer' | 'own_words' | 'skip' | 'you_decide' | 'stop';

/** One pickable reading of a Sharpen question; ids are assigned by motir-ai's code. */
export interface SharpenReading {
  id: string;
  label: string;
  detail: string;
  recommended: boolean;
}

/** The one question a Sharpen turn asks. */
export interface SharpenQuestion {
  id: string;
  text: string;
  topic: GrillingBranch;
  /** The prior answer this question narrows from, or null. */
  because: string | null;
  /** `technical_thread` only: the person's own words that raised it. */
  quote: string | null;
  readings: SharpenReading[];
}

/** An answer the PERSON settled. */
export interface SettledAnswer {
  questionId: string;
  question: string;
  answer: string;
  topic: GrillingBranch;
  readingId: string | null;
  source: 'person';
}

/** An assumption the PLANNER recorded for a skipped or "you decide" question. */
export interface SharpenAssumption {
  questionId: string;
  question: string;
  recommendation: string;
  why: string;
  source: 'planner';
}

/** `context.sharpen` — one Sharpen turn as a `sharpen_turn` job reads it. */
export interface SharpenJobContext {
  scope: { kind: 'plan' | 'conversation'; ref: string };
  /** The transcript so far, oldest first, EXCLUDING the action below. */
  turns: { role: 'person' | 'planner'; action: SharpenAction | null; body: string }[];
  settled: SettledAnswer[];
  assumptions: SharpenAssumption[];
  /** The question the action answers; null for `start`. */
  pendingQuestion: SharpenQuestion | null;
  action: SharpenAction;
  /** `answer` only. */
  readingId?: string;
  /** `own_words` only. */
  text?: string;
  /** The planning RUN this session stands inside (MOTIR-8450 producer ↔
   *  MOTIR-8451 consumer). ABSENT — never `null`, never `{}` — when there is no
   *  run: a plan with no conversation behind it, or a card outside any run. */
  run?: SharpenRunContext | null;
  /** The CONVERSATION a `conversation`-scope session grills (MOTIR-9314 producer ↔
   *  MOTIR-9312 consumer). Present on a `conversation` scope and only there. */
  conversation?: SharpenConversationContext;
}

/** `context.sharpen.conversation` — a plan-change conversation with no plan yet,
 *  read from stored state. motir-ai declares the identical shape and refuses one
 *  that does not match it. */
export interface SharpenConversationContext {
  /** The person's own turn bodies, in order, verbatim. Never empty. */
  requests: string[];
  /** The latest grounded answer Motir AI gave in the conversation, or null. */
  readAnswer: string | null;
  /** The conversation's anchor card (its `targetKeys[0]`), or null. */
  card: { key: string; title: string } | null;
}

/** `context.sharpen.run` — what the run is planning and which card it is
 *  planning, read from stored state. The shared wire contract: motir-ai declares
 *  the identical shape and refuses a `run` that does not match it. */
export interface SharpenRunContext {
  /** The plan the run is writing. */
  planId: string;
  /** The person's own turn bodies of the run's conversation, in order,
   *  verbatim. Never empty — a run with no person turn sends no `run`. */
  requests: string[];
  /** The run's ANCHOR card (its conversation's `targetKeys[0]`); `null` on a
   *  project-wide run. The key is always present. */
  card: { key: string; title: string } | null;
  /** The plan's stored sharpened requirement, narrowed to its six fields;
   *  absent when the plan carries none. */
  requirement?: SubmittedRequirement;
  /** What the run's conversation was grilled on before planning (MOTIR-9315
   *  producer ↔ MOTIR-9313 consumer); absent when that grilling settled nothing. */
  carried?: CarriedAnswers;
}

/**
 * CARRIED ANSWERS — what a conversation's grilling settled before its planning run
 * started, in motir-ai's `CarriedAnswers` wire shape (`src/jobs/carriedAnswers.ts`).
 * It rides the planning job as `context.carriedAnswers` and the in-run grilling as
 * `context.sharpen.run.carried`, so neither asks the person the same request again.
 * `requests` are the person's turns the answers were given for; never empty.
 */
export interface CarriedAnswers {
  requests: string[];
  settled: Omit<SettledAnswer, 'source'>[];
  assumptions: Omit<SharpenAssumption, 'source'>[];
}

export interface JobContextBag {
  prompt?: string | null;
  rootItemKey?: string | null;
  // The PLAN a `revise_plan` job is revising (Story MOTIR-3595 · MOTIR-3599
  // producer ↔ MOTIR-3600 consumer). Beside `rootItemKey`, never instead of it:
  // every other plan-edit job names a work ITEM and this one names a PLAN, which
  // is the whole reason it is a fourth kind rather than a fourth caller of the
  // three. A proposal on an unapproved plan has no `MOTIR-<n>`, so `rootItemKey`
  // could never have addressed one.
  //
  // The handler reads that plan's OWN proposals through core and seeds its
  // registry from them BEFORE the model's first turn — the difference between
  // revising and re-planning.
  planId?: string | null;
  // The CONTEXTUAL-PLANNING anchor SET (7.12.3 · MOTIR-909 producer ↔ 7.12.2 /
  // MOTIR-908 consumer) — the work-item IDENTIFIERS a chat turn is anchored at.
  // PRESENT ⇒ the submit is a contextual turn: motir-ai classifies the intent from
  // `prompt` (the turn text — the re-plan "reason" IS that message, never a
  // separate param), resolves which of the three shipped 7.11 kinds the turn really
  // is, and pushes the UNION of every anchor's item + parent + siblings + children
  // as grounding. ABSENT ⇒ not a contextual turn: `rootItemKey` drives the single
  // anchor exactly as before. Introduces NO new `jobKind` — the submitted kind is
  // only the fallback when the text carries no signal. Core sends the set only
  // after resolving and view-gating every anchor.
  targetKeys?: string[];
  discovery?: unknown;
  // The RUN SNAPSHOT of an `ask_project` turn typed WHILE a planning run is in
  // progress (Story MOTIR-7990 · MOTIR-7996 producer ↔ MOTIR-7993 consumer) —
  // `{ planId, readable, planStatus?, steps?, proposals?, reason?, pendingOffer? }`
  // (`RunContext`, lib/services/planRunContextService.ts). PRESENT ⇒ run mode:
  // the answering session answers from it, or hands the turn back as a `forward`.
  // ABSENT ⇒ `ask_project` behaves exactly as it always has. Loosely typed here by
  // design, like `discovery`: each side declares its own types against the contract.
  run?: unknown;
  // The LIVE PLAN OFFER of an `ask_project` turn typed with NO run (Story MOTIR-9219 ·
  // MOTIR-9290 producer ↔ MOTIR-9292 consumer) — `{ kind, requestText, targetKey,
  // seq }` (`PendingPlanOfferStatement`, lib/services/planOfferService.ts), the offer
  // that stood when the person spoke, read before their turn was appended. ABSENT —
  // never null, never empty — when no offer is pending, and never sent beside `run`:
  // a mid-run turn's offer is stated inside the snapshot (`run.pendingOffer`). The two
  // names differ on purpose, so nobody reads them as one field. Loosely typed by
  // design, like `run`.
  pendingPlanOffer?: unknown;
  // The workspace's connected repo SET — the PLURAL cross-repo contract with
  // motir-ai's multi-repo code-graph reads (7.10.15/MOTIR-1598 producer ↔
  // 7.10.16/MOTIR-1599 consumer): `{ repos: [{ provider, repoRef,
  // defaultBranch }] }` (`JobCodeContext`, lib/ai/codeContext.ts), one entry
  // per repo granted on the workspace's installation (the 7.10.3 mirror — a
  // workspace is ONE PRODUCT and connects MANY repos). Populated at
  // planning-job submit by `resolveCodeContext`; ABSENT (not empty) when the
  // workspace has no installation or no granted repos. Loosely typed here by
  // design (the reserved-hole convention, like `discovery`) — each side
  // declares its own types against the shared contract.
  code?: unknown;
  // The PROJECT's repository SET (Story MOTIR-2732 · MOTIR-3044 producer ↔
  // MOTIR-3045 consumer) — `{ repos: [{ ref, name, role, label, state }] }`
  // (`JobProjectRepoContext`, lib/ai/projectRepoContext.ts), one entry per
  // `project_repository` row, in set order.
  //
  // ⚠️ BESIDE `code` above, deliberately, and not merged into it. That field is
  // the WORKSPACE's connected grant list and exists for code-graph reads; this one
  // is the PROJECT's own set. They differ in scope, in shape and in what they can
  // express: a grant list has no role, no establish state, and no entry at all for
  // a repository the plan is about to ask for — which is most of them at the
  // moment a tree is generated. Collapsing them is the confusion MOTIR-3044 exists
  // to end.
  //
  // The `ref` is the load-bearing field: a role MAY REPEAT (`ProjectRepo.role`'s
  // own comment — two services are two `api` rows), so a role pin on such a
  // project resolves to null and the planner cannot mean the billing API rather
  // than the search API. The row's identity is what makes it sayable.
  //
  // ABSENT (not empty) when the project records no repositories — the reserved-hole
  // convention, so "this project has none" and "nobody asked" stay tellable apart.
  // Loosely typed here by design, like `discovery` and `code`: each side declares
  // its own types against the shared contract. Optional in BOTH directions, so the
  // two repositories' halves merge in either order.
  repositories?: unknown;
  // The bug-analysis unit an `analyze_bug` job carries — the user bug + its
  // plan-tree neighborhood the OUTWARD classifier reasons over, assembled by the
  // trigger (MOTIR-1481) and sent inline (see BugAnalysisContext above).
  bugAnalysis?: BugAnalysisContext;
  // The monitor-issue facts an `author_bug` job (MOTIR-5849) authors a planned
  // bug FROM (see BugAuthoringContext above).
  bugAuthoring?: BugAuthoringContext;
  // The ONE work item a conversation turn is anchored on (MOTIR-7047 producer ↔
  // MOTIR-7046 consumer) — an identifier such as `MOTIR-12`, usually the triage
  // bug the person just reported. Sent on `ask_project` (the classifier is TOLD
  // the turn is anchored there, and a `debug` verdict echoes it back as
  // `ask.anchorKey`) and on `debug_bug`. Core sends it only after resolving it
  // through the keyed read and browse-gating it (`aiAskService`). Absent when the
  // turn has no anchor. NOT `targetKeys`: that set drives a contextual PLANNING
  // run; this names the item a question or a report is about.
  anchorKey?: string;
  // The submitted report a `debug_bug` job diagnoses (MOTIR-7046) —
  // `{ title?, description? }`, the person's own words from the report widget.
  // The conversation path sends `prompt` instead; either (or both) is legal.
  debugReport?: { title?: string; description?: string };
  // The ONE guide turn a `guide_work_item` job takes (MOTIR-7464 producer ↔
  // MOTIR-7463 consumer; ADR AMENDMENT 2 · A2.3) — the card, its rows (or the
  // temporary list) and the conversation so far, read fresh per turn. Built by
  // `buildGuideContext` (lib/ai/guideWorkItem.ts), whose type is the wire shape.
  guideContext?: GuideContext;
  // The ONE Sharpen turn a `sharpen_turn` job takes (Task MOTIR-1101 · MOTIR-8181
  // producer ↔ MOTIR-8176 consumer) — the wire shape motir-ai's `parseSharpenInput`
  // reads. Built from the session's STORED state, never from a client body.
  sharpen?: SharpenJobContext;
  // The ONE translation batch a `translate` job takes (Story MOTIR-7735 ·
  // MOTIR-8119 producer ↔ MOTIR-8116 consumer) — the reader's target language and
  // the `{ fieldRef, text }` fields to translate into it, in the order the answer
  // comes back. Built by `requestTranslation` (lib/ai/translateClient.ts), whose
  // `TranslateJobInput` (lib/ai/translate.ts) is the wire shape.
  translate?: TranslateJobInput;
  // The work-item context a `generate_explanation` job (8.8.11) drafts an
  // explanation FROM — the title / description / type / parent the "Draft with
  // AI" affordance (8.8.12) sends. Loosely typed (the reserved-hole convention,
  // like `discovery`); the motir-ai handler parses it into an ExplanationInput.
  explanation?: unknown;
  // The AI-drafted-explanations opt-in (Story 7.4 · MOTIR-850), read from
  // `Project.aiGenerateExplanations`. When true, motir-ai's generator drafts a
  // "why this matters" `explanationMd` (`explanationSource = ai_draft`) per
  // proposed item (MOTIR-1468). Absent/false ⇒ proposals carry no explanation.
  // The flag rides the envelope so motir-ai never reads motir-core config
  // directly — which is also why every producer must send it: a submit that
  // omits it cannot be compensated for on the far side.
  //
  // Sent by BOTH planning producers: `aiGenerationService` on a `generate_tree`
  // submit, and `aiPlanEditsService` on every plan EDIT — `augment` /
  // `expand_item` / `replan`, contextual turns included (MOTIR-2110; the
  // consumer half is the motir-ai re-plan handler). It was generation-only
  // before, so the project setting read as global while applying to a plan's
  // first pass alone. Always present (`false` when off), never omitted.
  generateExplanations?: boolean;
  // WHETHER THIS PROJECT'S PLANNER MAY RECORD WHAT IT GOT WRONG (Story
  // MOTIR-3331 · MOTIR-3350 producer ↔ MOTIR-3351 consumer) — the wire form of
  // `Project.aiRecordPlanningMistakes`. Same discipline as `generateExplanations`
  // directly above: motir-ai reads the setting ONLY from here and never from
  // motir-core config, so a submit that omits it cannot be compensated for on the
  // far side.
  //
  // ⚠️ ABSENT IS NOT `false`, and the difference is load-bearing. `false` means
  // *this project switched capture off*; ABSENT means *the producer predates this
  // field*, which the consumer must read as ON — otherwise a deploy in which
  // motir-ai ships first would silently switch capture off for every tenant whose
  // jobs were submitted by the older motir-core. So every producer that can
  // capture sends it UNCONDITIONALLY (`false` when off), and the consumer's
  // fallback exists for version skew alone.
  //
  // Sent by the two producers whose job kinds can reach motir-ai's capture path:
  // `aiPlanEditsService` on the shared plan-EDIT submit (`augment` / `expand_item`
  // / `replan`, contextual turns included) and `aiBugTelemetryService` on
  // `analyze_bug`. `generate_tree` does NOT send it — its handler has no lesson
  // capture at all — and adding it there would claim a gate that does not exist.
  //
  // The KEY is spelled once, in `RECORD_PLANNING_MISTAKES_CONTEXT_FIELD`
  // (`lib/ai/lessonCapture.ts`); the call sites use it as a computed key so this
  // string has exactly one home on this side of the boundary.
  recordPlanningMistakes?: boolean;
  // Is this the project's FIRST plan? Mirrors `Project.onboardingRanAt == null`
  // (the immutable onboarding marker of Subtask 7.4 / MOTIR-1264, stamped by
  // `plansService.approvePlan`) — MOTIR-4736 producer ↔ MOTIR-4737 consumer.
  //
  // ⚠️ ONBOARDING IS A FACT ABOUT HISTORY, NOT ABOUT THE TREE. motir-ai used to
  // infer it from an EMPTY committed tree (`mayPlanTheFirstTree`, MOTIR-4178),
  // which is correct for the start-fresh path and wrong for the migrate wizard —
  // the one onboarding journey that DELIBERATELY has work items before its first
  // plan, because its optional import step (MOTIR-934 / MOTIR-1643) writes a
  // Jira / Linear / GitHub / Plane / CSV backlog first and only then generates.
  // Such a run was read as continued planning, so it got the anchored arm and the
  // continued-planning lesson bucket instead of the onboarding framing.
  //
  // ⚠️ ABSENT IS NOT `false`. `false` means *this project has already had a plan
  // approved*; ABSENT means *the producer predates this field* and the consumer
  // falls back to its own inference — so every planning submit sends it
  // UNCONDITIONALLY, never spread-conditionally like `code` and `repositories`,
  // whose absence means "this workspace/project has none".
  //
  // The KEY is spelled once, in `ONBOARDING_CONTEXT_FIELD`
  // (`lib/ai/onboardingContext.ts`), and the answer once in
  // `onboardingContextFor`; the call sites use the constant as a computed key so
  // this string has exactly one home on this side of the boundary.
  onboarding?: boolean;
  // The project's existing work-item tree summary (MOTIR-1259) — the items the
  // user already has in the project, passed to motir-ai's discovery handler so
  // tier drafting is grounded in what already exists, not a blank slate. Each
  // entry carries the key, title, kind, status, and parentKey — enough to
  // understand the tree's shape and complement it. Absent/empty ⇒ a blank-slate
  // project (the start-fresh path). Loosely typed (the reserved-hole convention,
  // like `discovery`); the motir-ai handler parses it.
  existingWorkItems?: ExistingWorkItemRef[];
  // The sprint-planning settings a `plan_sprint` job (7.13.4 · MOTIR-917) packs
  // with. `aiSprintPlanningService` sets `sprintLengthDays` from the project's
  // `aiSprintLengthDays` column (MOTIR-915), so motir-ai reads the cadence ONLY
  // from the envelope and never from motir-core config directly — the same
  // discipline as `generateExplanations`. `agentMinutesPerDay` / `maxItems` are
  // left to the scheduler's documented defaults today; they are part of the
  // contract hole so a per-project override needs no envelope change. Parsed
  // DEFENSIVELY on the far side (`parseSprintPlanningInput`) — a malformed hole
  // falls back to defaults rather than failing the job.
  sprintPlanning?: SprintPlanningContext;
  // WHAT THIS RUN IS BUILDING (Story MOTIR-3942 · MOTIR-4140 shape ↔ MOTIR-4082
  // consumer ↔ MOTIR-4172 producer) — the six-field requirement PART 1 settled,
  // never prose. motir-ai's `readSuppliedPart1` is what reads it: a present,
  // well-formed value SATISFIES PART 1, so the run enters at PART 2 instead of
  // opening a conversation to ask a question whose answer already existed.
  //
  // ⚠️ ABSENT MEANS NOBODY SUPPLIED ONE — the reserved-hole convention `code`,
  // `repositories` and `planId` use, and deliberately NOT the `generateExplanations`
  // / `recordPlanningMistakes` discipline directly above. Those two are SETTINGS
  // whose absence the consumer must read as a default, so they are always sent;
  // this one is a VALUE the caller either had or did not, and the consumer's
  // answer to absence — open the conversation — is exactly right. So it is
  // spread conditionally at the producer and never sent as `null` or `{}`.
  //
  // ⚠️ AND THE PRODUCER DOES NOT VALIDATE IT. Every key is optional here and on
  // the MCP surface that fills it, because refusing a card must never become
  // conditional on composing the WHAT well: a partial requirement is a legal
  // submit that simply does not settle PART 1. motir-ai's `buildRequirement` is
  // the only validator, and it runs where a half-answer can open a conversation
  // rather than fail a call.
  requirement?: SubmittedRequirement;
  // The CONVERSATION'S CARRIED ANSWERS (Story MOTIR-9221 · MOTIR-9315 producer ↔
  // MOTIR-9313 consumer) — what the person settled when the conversation was
  // grilled before planning. BESIDE `requirement`, never merged into its six
  // fields, and spread conditionally for the same reason: absent means there is
  // nothing to carry.
  carriedAnswers?: CarriedAnswers;
}

/**
 * The `context.requirement` hole a plan-edit submit may fill — motir-ai's
 * `SettledRequirement` (`src/jobs/conversation.ts`) as a PRODUCER states it.
 *
 * The six fields are in CANONICAL ORDER, the order a requirements document
 * states them, and that order is part of the contract: it is what the tool's
 * per-field descriptions teach an agent to compose in.
 *
 * ⚠️ EVERY FIELD IS OPTIONAL HERE AND REQUIRED THERE, and that asymmetry is the
 * design rather than a gap. Three of them — `outcome`, `behaviour`, `acceptance`
 * — must be present and non-empty for the far side to accept the requirement at
 * all; the other three may be the empty string, which says *considered, and
 * there is none* and is a different answer from never having asked. Neither
 * check runs on this side.
 *
 * Typed structurally rather than as `unknown` (which is how motir-ai declares
 * the hole) for the same reason `sprintPlanning` is: motir-core is the PRODUCER
 * here, and the field names are the thing a producer can get wrong.
 */
export interface SubmittedRequirement {
  /** Who it is for, and what becomes possible that is not possible today. */
  outcome?: string;
  /** The observable rules — input → result, and the states that are not the happy path. */
  behaviour?: string;
  /** What is deliberately NOT included. May be blank; blank is an answer. */
  scopeEdge?: string;
  /** What BINDS the shape and is already decided. May be blank. */
  constraints?: string;
  /** How somebody will know it is done, as an observation rather than a test name. */
  acceptance?: string;
  /**
   * What was concluded that nobody confirmed — a LIST of recommendations, each
   * with a stable id (MOTIR-9160), so a verdict can name the one it answers
   * rather than the planner guessing at where prose divides. May be empty.
   * A bare string is still accepted (a requirement stored before the list
   * existed, or an older sender) and is read as ONE recommendation.
   */
  assumptions?: string | (string | RequirementRecommendation)[];
}

/** One of the planner's uncorrected recommendations. `id` is assigned by the reader when absent. */
export interface RequirementRecommendation {
  id?: string;
  text: string;
}

/** The `context.sprintPlanning` hole a `plan_sprint` submit fills (7.13.4). */
export interface SprintPlanningContext {
  sprintLengthDays?: number;
  agentMinutesPerDay?: number;
  /** Cap on how many schedulable items one packing run reads back and packs. */
  maxItems?: number;
}

/** A lightweight summary of one committed work item in the project (MOTIR-1259),
 *  the minimum shape motir-ai's discovery handler needs to ground tier drafting
 *  in what already exists. */
export interface ExistingWorkItemRef {
  key: string;
  kind: string;
  title: string;
  status: string;
  parentKey: string | null;
}

export interface RequestEnvelope {
  envelopeVersion: typeof ENVELOPE_VERSION;
  jobKind: JobKind;
  tenant: Tenant;
  context: JobContextBag;
  readBackToken: string;
  /**
   * Continue an EXISTING plan's walk instead of starting one (Story MOTIR-7905 · MOTIR-7916;
   * motir-ai's `JobRequest.resume`, MOTIR-7910): `planId` is the plan to continue and
   * `fromJobId` the failed job whose conversation and settled PART 1 the new job reads.
   * Absent on every other submit, so the body is byte-identical to before.
   */
  resume?: { planId: string; fromJobId: string };
  /**
   * The submit's idempotency key (MOTIR-9255; motir-ai's `JobRequest.idempotencyKey`): a
   * repeat in the same project answers the job the first submit created. Sent on a
   * conversation turn's submit only; absent elsewhere, so those bodies are unchanged.
   */
  idempotencyKey?: string;
}

/**
 * The sprint-assignment delta's OWN version, independent of `envelopeVersion`
 * (contract §3.2): the persist side switches on it, so the packing shape can
 * evolve without a whole-envelope bump. Mirrors motir-ai's
 * `SPRINT_ASSIGNMENT_DELTA_VERSION`.
 */
export const SPRINT_ASSIGNMENT_DELTA_VERSION = 'v1' as const;
export type SprintAssignmentDeltaVersion = typeof SPRINT_ASSIGNMENT_DELTA_VERSION;

/**
 * ONE proposed sprint. `tempId` is a temp-ref (`sprint:<n>`) in the same spirit
 * as the tree-delta's `planItem:<id>` refs: it names a sprint that does not
 * exist yet, so the persist resolves it to a real sprint id as it creates them
 * IN ORDER. `itemKeys` are REAL work-item identifiers — this delta proposes
 * their sprint MEMBERSHIP only, never their existence — listed in dependency
 * (topological) order within the sprint.
 */
export interface ProposedSprint {
  /** `sprint:1`, `sprint:2`, … — position in the ordered sequence, 1-based. */
  tempId: string;
  name: string;
  lengthDays: number;
  itemKeys: string[];
  totalEstimateMinutes: number;
  capacityMinutes: number;
  /** Members whose OWN estimate exceeds one sprint's capacity (they sprint alone). */
  oversizedKeys: string[];
  /** Deterministically derived explanation of this sprint's composition. */
  rationale: string;
}

/**
 * The versioned sprint-assignment proposal a `plan_sprint` job returns. It
 * carries NO WRITE AUTHORITY: motir-core decides whether to commit it, creating
 * the sprints and assigning members through the Epic-4 sprint services behind a
 * human approve. The motir-core mirror of motir-ai's `SprintAssignmentDelta`.
 */
export interface SprintAssignmentDelta {
  deltaVersion: SprintAssignmentDeltaVersion;
  /** The cadence the packing used (from `context.sprintPlanning.sprintLengthDays`). */
  sprintLengthDays: number;
  /** `sprintLengthDays × agentMinutesPerDay` — the per-sprint estimate budget. */
  capacityMinutes: number;
  agentMinutesPerDay: number;
  /** The proposed sprints, in the order they must run. */
  sprints: ProposedSprint[];
  itemCount: number;
  totalEstimateMinutes: number;
  /** Members with no `estimateMinutes` — charged the default, surfaced not hidden. */
  unestimatedKeys: string[];
  /** Members too big for one sprint — each got its own sprint, flagged not dropped. */
  oversizedKeys: string[];
}

export interface ResultEnvelope {
  envelopeVersion: typeof ENVELOPE_VERSION;
  jobKind: JobKind;
  // ⚠️ NO `planDelta` (MOTIR-1747). motir-ai still SENDS one — every plan-edit
  // handler returns a hardcoded `planDelta: { operations: [] }` — but it has
  // never carried a proposal: the planners write their output as `PlanItem`
  // rows through the Plan substrate, and that Plan is the only thing core
  // reviews or approves. Results are read loosely, so the wire field is simply
  // ignored here; retiring it from the ENVELOPE is a motir-ai change (a
  // versioned boundary bump), deliberately not made from this side.
  summary: string;
  usage: { model: string | null; inputTokens: number; outputTokens: number };
  // The versioned sprint-assignment proposal (7.13.4 · MOTIR-917) — `plan_sprint`
  // ONLY: the ordered sprints the deterministic scheduler packed, each carrying a
  // `sprint:<n>` temp-ref + its real member keys. Absent for every other kind.
  // Purely additive; results are read loosely, and the approve path re-parses
  // this from scratch rather than trusting the shape (see lib/ai/sprintAssignment.ts).
  sprintAssignment?: SprintAssignmentDelta | null;
  // The PLANNED BUG an `author_bug` job produced (Story MOTIR-4930 · MOTIR-5851)
  // — that kind only. Typed `unknown` ON PURPOSE: it is untrusted model output
  // that crossed a boundary, and the only way into a typed value is
  // `parseAuthoredBug` (lib/ai/authoredBug.ts), which VALIDATES rather than casts.
  authoredBug?: unknown;
  // The ONE diagnosis a `debug_bug` job produced (Story MOTIR-7042 · MOTIR-7046) —
  // that kind only. Typed `unknown` for the same reason as `authoredBug`: it is
  // untrusted model output, and its reader lands with the consumer (MOTIR-7049).
  debugBug?: unknown;
  // The ONE guide turn a `guide_work_item` job produced (Story MOTIR-7459 ·
  // MOTIR-7463) — that kind only. Typed `unknown` for the same reason: untrusted
  // model output, read only through `parseGuideTurn` (lib/ai/guideWorkItem.ts).
  guideTurn?: unknown;
  // The ONE Sharpen turn a `sharpen_turn` job produced (Task MOTIR-1101 ·
  // MOTIR-8176) — that kind only. Typed `unknown` for the same reason: untrusted
  // model output, read only through `parseSharpenTurn` (lib/ai/sharpenTurn.ts).
  sharpenTurn?: unknown;
  // The translated texts a `translate` job produced (Story MOTIR-7735 ·
  // MOTIR-8116) — that kind only, one `{ fieldRef, text }` per field sent. Typed
  // `unknown` for the same reason as `authoredBug`: untrusted model output, read
  // only through `parseTranslations` (lib/ai/translate.ts).
  translations?: unknown;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

// RFC 9457 problem+json — the shared error taxonomy (contract §5).
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  jobId?: string;
  /** Where a failed planning walk stopped (MOTIR-7909). Untrusted until parsed. */
  walkStop?: unknown;
  /** Present only on a coding-convention save refused for a stale base (MOTIR-9080). */
  conventionConflict?: { code: 'CONVENTION_VERSION_CONFLICT'; latestVersion: number };
}

// The raw GET /v1/jobs/:id wire body (contract §2.4). The client maps this into
// a JobView (lib/ai/errors.ts) whose `error` is a motir-core typed error.
export interface RawJobResponse {
  jobId: string;
  status: JobStatus;
  result: ResultEnvelope | null;
  error: Problem | null;
  /** Present on a failed planning job only (MOTIR-9121). */
  resumable?: unknown;
}

// An SSE frame from GET /v1/jobs/:id/stream (contract §2.4): `event` is
// status|done|error, `data` the parsed JSON payload.
export interface JobStreamEvent {
  event: string;
  data: unknown;
}

// ── GET /v1/usage — the org cost dashboard read (Subtask 7.2.11) ──────────────
// The drill level the cost view is scoped to. motir-core narrows a non-admin
// member to `project` server-side; it never trusts a client-sent scope.
export type UsageScope = 'org' | 'workspace' | 'project';

// The query motir-core sends motir-ai (over the service-credential boundary).
// Ids are motir-core's own (org/workspace/project) — motir-ai keys its
// AiOrganization/AiProject to them (Subtask 7.2.16).
export interface UsageQuery {
  coreOrganizationId: string;
  scope: UsageScope;
  coreWorkspaceId?: string | null;
  coreProjectId?: string | null;
  page?: number;
  pageSize?: number;
}

// The raw GET /v1/usage wire body (motir-ai's usageService.UsageResponseDto).
// `balance` + `tier` are ALWAYS org-level (one ledger per org); spend +
// breakdown + runs follow the active drill scope. Credits are an internal usage
// unit, never a currency. The motir-core read-through service enriches the
// ws/project ids with names before it reaches the browser.
export interface RawUsageRun {
  jobId: string;
  jobKind: string;
  model: string | null;
  coreWorkspaceId: string;
  coreProjectId: string;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  startedAt: string; // ISO
}

/**
 * `GET /v1/usage` — the ORG-LEVEL web-search spend block (motir-ai
 * `docs/contract.md`, `docs/credit-model.md` §4b).
 *
 * Scope-INDEPENDENT: it counts every search the org made, attributed or not, and
 * does NOT narrow when the drill moves to a workspace or a project. The AI spend
 * figures beside it all join `PlanningTurn` and therefore exclude these rows by
 * construction, which is what lets the billing panel render Motir Search as its
 * own line rather than folding it into the AI number.
 */
export interface RawUsageSearch {
  totalSpend: number;
  monthSpend: number;
}

/** One run's search spend. `jobId` is the SAME key `RawUsageRun` carries. */
export interface RawUsageSearchRun {
  jobId: string;
  credits: number;
  lastSearchAt: string; // ISO
}

/**
 * `GET /v1/usage` — the PER-RUN half of search spend (motir-ai MOTIR-4552,
 * `docs/credit-model.md` §4b.1). Reported ALONGSIDE `search`, never inside it.
 *
 * ⚠️ THE TWO HALVES ARE SCOPED DIFFERENTLY, and a consumer that cannot tell will
 * render an org number under a project heading:
 *
 * - `runs` / `total` FOLLOW THE DRILL SCOPE. A search carries its run and a run
 *   carries a project, so attributed spend narrows the way the AI figures do.
 * - `attributedSpend` / `unattributedSpend` are ORG-LEVEL, all-time, measured
 *   over the same population as `search.totalSpend` — so
 *   `attributedSpend + unattributedSpend === search.totalSpend`, always, however
 *   the reader has drilled.
 *
 * `unattributedSpend` is NOT an error figure. `MOTIR-2778` §4 makes a search
 * outside any run, and a search from an untrusted token, both legitimate and both
 * fully charged, so the remainder is a real quantity to render — showing it is
 * what stops the gap between a total and its rows reading as a bug in the number.
 */
export interface RawUsageSearchRuns {
  runs: RawUsageSearchRun[];
  page: number;
  pageSize: number;
  total: number;
  attributedSpend: number;
  unattributedSpend: number;
}

export interface RawUsageResponse {
  scope: UsageScope;
  coreOrganizationId: string;
  coreWorkspaceId: string | null;
  coreProjectId: string | null;
  balance: number;
  tier: { key: string; name: string; monthlyCreditAllotment: number } | null;
  totalSpend: number;
  monthSpend: number;
  monthlyHistory: { yearMonth: string; credits: number }[];
  /**
   * Still on the WIRE, and deliberately NOT forwarded to a tenant (Story
   * MOTIR-7220 · MOTIR-7229): `aiUsageService` drops it, and each run's `model`,
   * at the `UsageDTO` boundary, because the planning model is a platform setting
   * no tenant sees. Kept here because motir-ai sends it and the redaction is
   * core's read-boundary decision, not a wire change.
   */
  perModel: { model: string; inputTokens: number; outputTokens: number; credits: number }[];
  recentRuns: { runs: RawUsageRun[]; page: number; pageSize: number; total: number };
  /**
   * Web-search spend. motir-ai sends BOTH blocks on every response
   * (`usageService.UsageResponseDto`), so the wire shape is not optional —
   * they are OPTIONAL HERE for one reason only: a ROLLING DEPLOY, where
   * motir-core has shipped and the motir-ai half has not (or has rolled back).
   *
   * ⚠️ `undefined` therefore means UNAVAILABLE, never zero, and the two must not
   * collapse: a customer told they spent nothing on search when the figure could
   * not be fetched is worse off than one told nothing at all. The DTO layer
   * carries that distinction as `null` vs a populated object; see
   * `lib/dto/aiUsage.ts`, and `ciFigures.ts`'s `balanceUnavailable` for the
   * shipped precedent one billed line over.
   */
  search?: RawUsageSearch;
  searchRuns?: RawUsageSearchRuns;
  /**
   * Agent-instance MACHINE TIME and STORAGE spend (motir-ai MOTIR-6915,
   * `docs/decisions/agent-instance-storage.md` §6) — org-level like `search`,
   * this month and all time. Optional for the same ROLLING-DEPLOY reason as
   * `search`: `undefined` means UNAVAILABLE, never zero.
   */
  agentMachine?: RawUsageAgentSpend;
  agentStorage?: RawUsageAgentSpend;
  /**
   * Translation spend (Story MOTIR-7735 · motir-ai MOTIR-8126) — org-level like
   * `search`, this month and all time, and EXCLUDED by motir-ai from every AI
   * figure above (`totalSpend`, `monthSpend`, `monthlyHistory`, the per-model
   * breakdown and the run log's credits). Optional for the same ROLLING-DEPLOY
   * reason as `search`: `undefined` means UNAVAILABLE, never zero.
   */
  translation?: RawUsageTranslationSpend;
}

/** `GET /v1/usage` — the organisation's translation spend (MOTIR-8126). */
export interface RawUsageTranslationSpend {
  totalSpend: number;
  monthSpend: number;
}

/** `GET /v1/usage` — one agent charge kind's org-level spend (MOTIR-6915). */
export interface RawUsageAgentSpend {
  totalSpend: number;
  monthSpend: number;
}

// POST /v1/credits/ci-overage (MOTIR-1899 · motir-ai `docs/contract.md` §2.4) —
// charge an org's ledger for CI-minutes OVERAGE, the ledger's first NON-AI debit
// source.
//
// The whole minutes side stays in motir-core (`docs/decisions/ci-minutes-allowance.md`
// §8.1, because the pool derives from org MEMBERSHIP, which only motir-core
// holds): motir-ai never learns what a minute is, and receives WHOLE CREDITS
// already converted at §2's rate.
export interface CiOverageDebitInput {
  coreOrganizationId: string;
  /** Whole credits of overage (integer ≥ 1), already converted. */
  credits: number;
  /**
   * The caller's own token for the metering state that produced this charge — the
   * IDEMPOTENCY key. motir-ai stores it namespaced (`ci_overage:<token>`) on a
   * globally-unique column, so a redelivered report debits exactly once and a
   * future non-AI source cannot collide. It is deliberately NOT a
   * `planningTurnId`: that hook is AI-turn-shaped and a CI charge has no turn.
   */
  externalRef: string;
  /** Optional free text recorded with the transaction. */
  reason?: string;
}

export interface RawCiOverageDebitResponse {
  transactionId: string;
  aiOrganizationId: string;
  /** Signed, as stored on the ledger (negative for a debit). */
  credits: number;
  balanceAfter: number;
  /**
   * `balanceAfter <= 0` — the SHARED exhaustion threshold. This endpoint refuses
   * nothing itself and invents no second threshold; it reports the state so
   * motir-core's dispatch gate can refuse the NEXT dispatch (§6.2).
   */
  exhausted: boolean;
  /** True when this matched an existing debit and wrote nothing — the signal a
   *  retried, previously-timed-out debit had in fact landed. */
  idempotent: boolean;
}

// ── Embeddings (Story MOTIR-2694 · Subtask MOTIR-2696) ───────────────────────
//
// `POST /v1/embeddings` — motir-ai computes vectors FOR motir-core (MOTIR-2720).
// motir-core STORES plan-tree embeddings and cannot produce them: it holds no
// provider credential, no gateway token and no embedding seam, and it is not
// getting one. Giving the open repo a credential was rejected on two counts —
// it would put an LLM key in the open-source half, and it would create a SECOND
// metering identity for one tenant's spend (`docs/decisions/plan-tree-embeddings.md`
// §6.2). So the vector comes from the service that already owns the gateway
// token and the one `CreditLedger`.
//
// BATCH by design, so a backfill is a handful of round-trips rather than one per
// row. motir-ai caps a request at 64 inputs / 512 000 characters and refuses an
// over-sized batch as a 400 BEFORE any gateway call — a cap this side respects
// by chunking rather than discovering.
export interface RawEmbeddingBatchResponse {
  /**
   * The model the call ACTUALLY used, honouring motir-ai's `EMBEDDING_MODEL`
   * override — not a constant either side assumes. Stored per row, because ADR
   * §6.1 makes it the hard comparability filter: a channel swap that changed the
   * model silently would corrupt every ranking that spans the swap.
   */
  model: string;
  dimensions: number;
  /** One vector per input, IN REQUEST ORDER. */
  embeddings: number[][];
}

// ── Stripe AI-subscription lifecycle read (Subtask 8.1.13) ───────────────────
// The raw GET /v1/stripe/subscription wire body (motir-ai's
// stripeBillingService.SubscriptionDto). `status` is the Stripe lifecycle value
// (decision §5). EVERY field is nullable: a free / never-transacted org resolves
// to the EMPTY shape (`status: null`), NOT a 404 — "no AI subscription yet" is a
// normal state. `currentPeriodEnd` is ISO-8601 (or null before a period is known).
export type StripeSubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid';

export interface SubscriptionQuery {
  coreOrganizationId: string;
}

export interface RawSubscriptionResponse {
  status: StripeSubscriptionStatus | null;
  currentPeriodEnd: string | null; // ISO-8601
  priceId: string | null;
  planTier: { key: string; name: string; monthlyCreditAllotment: number } | null;
}

// The plan-change surface (motir-ai MOTIR-8396 / MOTIR-8398 / MOTIR-8399): the two
// previews, the upgrade, the downgrade schedule and the pending-downgrade read.
// Mirrors motir-ai's `UpgradePreviewDto` / `DowngradePreviewDto` /
// `UpgradeResultDto` / `DowngradeScheduledDto` / `DowngradeClearedDto`. Every
// amount is integer cents of `currency`; every date is ISO-8601 except
// `prorationDate`, which is unix seconds and is sent back unchanged.
export interface RawPendingDowngrade {
  planKey: string;
  effectiveDate: string;
}

export interface RawUpgradePreview {
  prorationDate: number;
  fromPlan: string;
  toPlan: string;
  cadence: 'monthly' | 'annual';
  cadenceChange: { from: 'monthly' | 'annual'; to: 'monthly' | 'annual' } | null;
  amountDueCents: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  billingDaysLeft: number;
  daysLeft: number;
  creditWindowEnd: string;
  extraCredits: number;
  extraIndexAllowance: number | null;
  fromPool: number;
  fullPool: number;
  fullAllowance: number | null;
  toPriceCents: number;
  pendingDowngrade: RawPendingDowngrade | null;
}

export interface RawDowngradePreview {
  fromPlan: string;
  toPlan: string;
  cadence: 'monthly' | 'annual';
  cadenceChange: { from: 'monthly' | 'annual'; to: 'monthly' | 'annual' } | null;
  effectiveDate: string;
  amountDueCents: number;
  refundCents: number;
  creditsChange: number;
  allowanceChange: number;
  fromPool: number;
  fullPool: number;
  fullAllowance: number | null;
  toPriceCents: number;
  currency: string;
  pendingDowngrade: RawPendingDowngrade | null;
}

export interface RawUpgradeResult {
  status: 'upgraded';
  fromPlan: string;
  toPlan: string;
  invoiceId: string | null;
  amountDueCents: number;
  currency: string;
  extraCredits: number;
  extraIndexAllowance: number | null;
  clearedPending: RawPendingDowngrade | null;
}

export type RawDowngradeResult =
  | {
      status: 'scheduled';
      fromPlan: string;
      toPlan: string;
      effectiveDate: string;
      replacedPending: RawPendingDowngrade | null;
    }
  | {
      status: 'cleared';
      fromPlan: string;
      toPlan: string;
      clearedPending: RawPendingDowngrade;
    };

// GET /v1/stripe/billing-history (MOTIR-7303) — an org's default payment method
// and its most recent invoices (at most 12, newest first), read live from Stripe
// by motir-ai. Mirrors motir-ai's BillingHistoryDto. An org with no Stripe
// customer answers `{ paymentMethod: null, invoices: [] }`, never a 404.
export interface RawBillingHistoryResponse {
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  invoices: {
    id: string;
    /** When Stripe raised the invoice, ISO-8601. */
    createdAt: string;
    status: string;
    /** The invoice total in integer cents of `currency`. */
    amountCents: number;
    currency: string;
  }[];
}

// ── Pre-plan read surface (Subtask 7.3.25) ───────────────────────────────────
// The resumable pre-plan state motir-core fetches over GET /v1/preplan to resume
// the onboarding loop and render each artifact's revision diffs at the gate
// (7.3.5). Mirrors motir-ai's preplanSessionService PreplanStateDto. Keyed by the
// core (workspace, project) — motir-ai resolves its AiProject from them, READ-ONLY,
// returning the empty state ({ session: null, docs: [] }) for a not-yet-started
// project (never a 404). Versioning is forward-only — no rollback.

export interface PreplanStateQuery {
  coreWorkspaceId: string;
  coreProjectId: string;
}

// The session-persistent decisions + resume essentials (one per project). Dates
// are ISO strings on the wire (motir-ai serializes its DateTime columns to JSON).
export interface RawPreplanSession {
  aiProjectId: string;
  classification: string | null;
  platform: string | null;
  docSkipSet: string[];
  designStarter: string | null;
  // The persisted onboarding design choice (Subtask 7.3.80/MOTIR-1254 added the
  // column + write endpoint; 7.3.81 consumes it). motir-ai stores it OPAQUELY —
  // the style/palette/type registries live in motir-core — so on the wire the
  // three axes are plain strings; the motir-core service validated them before
  // the write, and re-validates/casts on read.
  designChoice: { styleId: string; paletteId: string; typeId: string } | null;
  validationTiming: string | null;
  currentGate: string | null;
  conversation: unknown;
  status: string;
  createdAt: string;
  updatedAt: string;
}

// One entry of an artifact's forward revision log: when/why/what for a version.
// `diff` is the structured doc diff (motir-ai docDiff.ts) the gate renders, or
// null for the first (created) version.
export interface RawPreplanRevisionEntry {
  version: number;
  changeReason: string | null;
  changeKind: string | null;
  diff: unknown;
  createdAt: string;
}

// One labelled key→value finding in a tier's structured SUMMARY (MOTIR-1392 →
// MOTIR-1225) — the at-a-glance breakdown the canvas captured-findings renders.
// `tone` is the design's visual treatment: `positive` (a captured fact),
// `neutral` (the deliberate negative space — the muted "Out" row), `caution` (a
// still-to-prove finding). motir-ai derives these from the structured tier docs.
export interface RawPreplanFinding {
  label: string;
  value: string;
  tone: 'positive' | 'neutral' | 'caution';
}

// `currentBody` / `currentVersion` are the latest version's rendered Markdown
// body + its number (the fields 7.3.72/MOTIR-1188 added to the motir-ai docs[]
// entry) — what the 7.3.5 gate's `DirectionDocView` renders for the read-only
// tier review. A kind only appears in `docs` once it has ≥1 version, so motir-ai
// always populates both (defensively `''` / fallback in its no-current-doc
// guard); forward-only revision diffs stay in `versions`. `summary` is the
// structured per-tier breakdown (MOTIR-1392) the canvas captured-findings
// renders — `[]` when motir-ai has a rendered body but no structured doc yet (an
// older Markdown-only session).
export interface RawPreplanArtifactLog {
  kind: 'discovery' | 'vision' | 'feasibility' | 'validation';
  currentBody: string;
  currentVersion: number;
  summary: RawPreplanFinding[];
  versions: RawPreplanRevisionEntry[];
}

// The structured feature catalog as it crosses the wire (mirrors motir-ai's
// `FeatureCatalogDto`, the fields 7.3.78/MOTIR-1243 added to GET /v1/preplan).
// A phased feature universe (categories → features) + a concept glossary
// (groups → concepts). `phase`/`status` are the motir-ai enum literals; the
// per-node `id`s are kept (the consumer keys its list render on them). The
// catalog is FOLDED INTO the vision tier on the consumer side, so it rides as a
// sibling field, NOT a `docs[]` entry.
export interface RawPreplanCatalogFeature {
  id: string;
  name: string;
  descriptionMd: string;
  phase: 'mvp' | 'v1' | 'v2' | 'ai';
  status: 'todo' | 'in_progress' | 'done';
}

export interface RawPreplanCatalogCategory {
  id: string;
  title: string;
  features: RawPreplanCatalogFeature[];
}

export interface RawPreplanGlossaryConcept {
  id: string;
  term: string;
  aka: string | null;
  descriptionMd: string;
  example: string | null;
}

export interface RawPreplanGlossaryGroup {
  id: string;
  title: string;
  concepts: RawPreplanGlossaryConcept[];
}

export interface RawPreplanCatalog {
  // motir-ai-internal identity (`id` / `aiProjectId`) + timestamps also ride the
  // wire; the mapper drops them (never leaked to the browser), so they are not
  // typed as consumed fields here.
  categories: RawPreplanCatalogCategory[];
  glossary: RawPreplanGlossaryGroup[];
}

// The raw GET /v1/preplan wire body. All three are empty/null for a project that
// never started a pre-plan (a fresh resume, not an error).
export interface RawPreplanStateResponse {
  session: RawPreplanSession | null;
  docs: RawPreplanArtifactLog[];
  catalog: RawPreplanCatalog | null;
}

// ── GET / PUT /v1/planner-model-settings — the platform planning model ────────
// (Story MOTIR-7220 · MOTIR-7227; motir-ai `docs/contract.md` § The planner-model
// settings.) A MIRROR of motir-ai's contract, the way `JobKind` mirrors §2.3:
// which model Motir plans with is one setting per AUDIENCE, stored and validated
// in motir-ai, and read and written only by the operator console.

/** The three audiences, in the order motir-ai answers them. */
export const PLANNER_AUDIENCES = ['customer', 'meta', 'internal'] as const;
export type PlannerAudience = (typeof PLANNER_AUDIENCES)[number];

/**
 * The model a planning job runs on when its audience's stored model is no longer
 * offered — motir-ai's `PLANNER_MODEL_FALLBACK` (`src/llm/plannerModels.ts`),
 * mirrored here because the console names it in the withdrawn-model line. The
 * open-core boundary means core cannot import it; change both together.
 */
export const PLANNER_MODEL_FALLBACK = 'claude-opus-5-5';

/** One audience's setting as motir-ai serves it. */
export interface PlannerModelSettingRead {
  audience: PlannerAudience;
  model: string;
  /** False once the stored model left the offered list — jobs then run on the fallback. */
  offered: boolean;
  updatedAt: string;
  updatedByCoreUserId: string | null;
  /** The last probe's verdict; null when the model has never been probed. */
  reachable: boolean | null;
  lastProbeAt: string | null;
  lastProbeError: string | null;
}

/** A model motir-ai would accept for planning, right now. */
export interface PlannerOfferedModel {
  id: string;
  provider: string;
}

/** The raw `GET /v1/planner-model-settings` body. */
export interface PlannerModelSettingsRead {
  settings: PlannerModelSettingRead[];
  offered: PlannerOfferedModel[];
}

/** The `PUT /v1/planner-model-settings` body. */
export interface PlannerModelWriteInput {
  audience: PlannerAudience;
  model: string;
  /** The core user making the change — motir-ai stores it as `updatedByCoreUserId`. */
  actorCoreUserId: string;
}

/** The `PUT /v1/planner-model-settings` answer. `previousModel` was read under motir-ai's row lock. */
export interface PlannerModelWriteResult {
  audience: PlannerAudience;
  previousModel: string;
  model: string;
  updatedAt: string;
}

// The PLANNING-MODEL LIST — Story MOTIR-7521 · MOTIR-7524, over motir-ai's
// `GET` / `PUT /v1/planner-model-list` (motir-ai MOTIR-7520). Which models an
// audience MAY be set to. The list stores only the selection; whether a listed
// model is usable right now is recomputed by motir-ai on every read.

/** Why a listed model is not offered for planning right now, in motir-ai's precedence order. */
export const PLANNER_MODEL_LIST_REASONS = ['not_servable', 'not_chat', 'unrated'] as const;
export type PlannerModelListReason = (typeof PLANNER_MODEL_LIST_REASONS)[number];

/** One listed model as motir-ai serves it. */
export interface PlannerModelListEntryRead {
  model: string;
  /** Null when the catalog has no row for the model. */
  provider: string | null;
  offered: boolean;
  /** Null when `offered`. */
  reason: PlannerModelListReason | null;
  /** Null for a row the migration seeded. */
  addedByCoreUserId: string | null;
  createdAt: string;
}

/** A model an admin may ADD to the list (MOTIR-7614): plannable right now, not yet listed. */
export interface PlannerModelCandidateRead {
  id: string;
  provider: string;
}

/** The raw `GET /v1/planner-model-list` body, and the `PUT` answer. */
export interface PlannerModelListRead {
  entries: PlannerModelListEntryRead[];
  /** Servable ∩ chat ∩ planning-rated, minus the listed — sorted by provider, then id. */
  candidates: PlannerModelCandidateRead[];
}

/** The `PUT /v1/planner-model-list` body. */
export interface PlannerModelListWriteInput {
  action: 'add' | 'remove';
  model: string;
  /** The core user making the change — motir-ai stores it as `addedByCoreUserId` on an add. */
  actorCoreUserId: string;
}

// ── Platform-staff credit ops (MOTIR-747 · 10.3.2) ──────────────────────────
//
// The EXACT mirror of motir-ai's `POST /v1/admin/credits`, `POST /v1/admin/tier`
// and `GET /v1/admin/ledger` (motir-ai `docs/contract.md`, the MOTIR-747 entry).
// The ledger lives only in motir-ai; motir-core holds these shapes and no table.

/** The two STAFF credit kinds. `top_up` is the customer's checkout (Epic 8), never staff. */
export type AdminCreditKind = 'grant' | 'adjustment';

/** Who did it, as motir-ai stores it on the row it writes. */
export interface AdminActor {
  /** The motir-core platform-staff user id. */
  userId: string;
  /** A display label captured at the time (`Name <email>`). */
  label: string;
}

/** One `CreditTransaction`, as motir-ai answers it. `kind` is ANY ledger kind, not only the staff two. */
export interface AdminLedgerEntry {
  id: string;
  at: string;
  kind: string;
  credits: number;
  balanceAfter: number;
  reason: string | null;
  actor: AdminActor | null;
  externalRef: string | null;
}

/** A `PlanTier`, as motir-ai answers it. */
export interface AdminPlanTier {
  key: string;
  name: string;
  cadence: string;
  allotmentCredits: number;
}

/** One STAFF tier assignment (`PlanTierAssignment`). */
export interface AdminTierAssignment {
  id: string;
  at: string;
  fromTierKey: string | null;
  toTierKey: string;
  reason: string;
  actor: AdminActor;
}

/** The `POST /v1/admin/credits` body. */
export interface AdminCreditWriteInput {
  coreOrganizationId: string;
  kind: AdminCreditKind;
  credits: number;
  reason: string;
  /** The idempotency key — one per staff action, reused on a retry of that action. */
  requestId: string;
  actor: AdminActor;
}

/** The `POST /v1/admin/credits` answer. */
export interface AdminCreditWriteResult {
  coreOrganizationId: string;
  transaction: AdminLedgerEntry;
  /** The balance NOW (on a replay: as it stands, not as it was). */
  balanceCredits: number;
  idempotent: boolean;
}

/** The `POST /v1/admin/tier` body. */
export interface AdminTierWriteInput {
  coreOrganizationId: string;
  tierKey: string;
  reason: string;
  requestId: string;
  actor: AdminActor;
}

/** The `POST /v1/admin/tier` answer. */
export interface AdminTierWriteResult {
  coreOrganizationId: string;
  assignment: AdminTierAssignment;
  tier: AdminPlanTier;
  /** False when the org was already on that tier (still recorded). */
  changed: boolean;
  idempotent: boolean;
}

/** The `GET /v1/admin/ledger` query. */
export interface AdminLedgerQuery {
  coreOrganizationId: string;
  /** 1..200; motir-ai's default is 50. */
  limit?: number;
  /** Opaque, from the previous page's `nextCursor`. */
  cursor?: string | null;
}

/** The `GET /v1/admin/ledger` answer. `known: false` — motir-ai has never seen the org. */
export interface AdminLedgerRead {
  known: boolean;
  coreOrganizationId: string;
  balanceCredits: number;
  tier: AdminPlanTier | null;
  /** The latest STAFF assignment — Stripe also sets tiers, so compare with `tier.key`. */
  lastTierAssignment: AdminTierAssignment | null;
  /** Newest first. */
  entries: AdminLedgerEntry[];
  nextCursor: string | null;
}
