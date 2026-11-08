// The "Plan with AI" universal launcher — the reusable entrance that summons the
// AI planning workspace (the canvas + chat surface; design @
// `design/ai-chat/planning-workspace.mock.html`, MOTIR-1193) from anywhere in
// the PM core, so the planner is callable any time — not only during onboarding
// (MOTIR-1299 / Story 7.20).
//
// This module is the launcher's PURE core: it maps the surface the user invoked
// the launcher FROM (the originating context) to the planning MODE the workspace
// should open in, and composes the OVERLAY ADDRESS that carries that context —
// the current page's own href plus four namespaced parameters, since MOTIR-4725
// made the workspace a layer rather than a place. It is deliberately framework-free (no React, no `server-only`) so
// it runs identically in the client launcher, the ⌘K command, and unit tests.
//
// The four modes are STATES of the one workspace surface (design §"The planning
// MODES"); each is owned + seeded by its own subtask — generation (7.4),
// re-plan/augment (7.11), contextual (7.12), roadmap-read (7.19). The launcher's
// job is only to OPEN the workspace in the right mode with the originating
// context; what each mode renders is those subtasks' responsibility.

/**
 * The planning mode the workspace opens in. `'project'` is the COARSE
 * project-scoped entrance used when the launch site does not (cheaply) know
 * whether a plan already exists — the workspace itself seeds generation-vs-
 * augment from the live tree. `'generation'` / `'replan'` are the resolved
 * fine split for callers that DO know (`hasPlan`).
 */
export type PlanningMode =
  | 'project'
  | 'generation'
  | 'replan'
  | 'contextual'
  | 'roadmap'
  /** GUIDE ME THROUGH (Story MOTIR-7459 · MOTIR-7466) — Motir AI walks the person
   *  through ONE manual card's to-do list. It always carries its card
   *  (`planItem`); an address without one degrades to the default mode. */
  | 'guide';

/**
 * Where the launcher was invoked from — the originating context the workspace
 * needs to open in the right mode.
 *
 * - `project` — a project-level surface with no specific item.
 * - `work-item` — a specific work item (its detail page / a row action). Its
 *   `hasPlan` is the item's OWN plan-vs-re-plan split (MOTIR-910): an item that
 *   already has children is being RE-planned, one without is being planned for
 *   the first time. Same shape as the project context's `hasPlan`, one level
 *   down; omitted (the coarse case) it degrades to the contextual default.
 * - `roadmap` — the Board↔Roadmap surface.
 * - `refused-gate` — open the planner SEEDED from a decided gate (story
 *   MOTIR-6068 · MOTIR-6210; `approval-gates.md` §10f). The name predates the
 *   pick and is kept because every shipped link carries it: since MOTIR-6435 it
 *   seeds a PICKED option too. It carries the GATE's id and nothing else: the
 *   overlay reads the seed (`GET /api/approval-gates/{id}/planning-seed`) and
 *   resolves it by the seed's `intent` — a REFUSAL to a `work-item` re-plan on the
 *   refused card with the first turn written and unsent; a PICK to a forward
 *   launch on its anchor (or the project) with the first turn SENT once
 *   (`picked-option-planning-starts.md`) — or, for any gate it may not read, to a
 *   plain `project` launch. No reason text and no title ever ride the address.
 */
export type PlanningLaunchContext =
  | { kind: 'project'; hasPlan?: boolean; sessionId?: string; via?: PlanningEntrance }
  | {
      kind: 'work-item';
      itemKey: string;
      hasPlan?: boolean;
      sessionId?: string;
      via?: PlanningEntrance;
      /** START THE CONVERSATION (MOTIR-7973; design MOTIR-7875): the door asks the
       *  overlay to send `Plan <KEY>` once, for the person, as the thread's first
       *  turn — `/ready`'s *Expand* is the one that does. Written as `planStart=1`
       *  and only when no `sessionId` names a conversation to reopen. */
      startTurn?: boolean;
      /** ASK BEFORE STARTING (MOTIR-10624; design MOTIR-10623): the card's Plan /
       *  Re-plan button asks the overlay to open on a planner message that offers
       *  **Start planning** — one click sends the start turn, nothing is sent
       *  until then. Written as `planAsk=1`, only when no `sessionId` names a
       *  conversation to reopen and `startTurn` is not asking to send outright. */
      confirmStart?: boolean;
    }
  | { kind: 'roadmap' }
  | { kind: 'refused-gate'; gateId: string }
  /** A guide's RE-PLAN OFFER (Story MOTIR-8684 · MOTIR-8693): `plan=contextual&planFrom=
   *  guide-offer&planOffer=<turnId>`. It carries the offer's turn id and nothing else —
   *  the request text, the target and the guided card are read from the server. */
  | { kind: 'guide-offer'; guideTurnId: string }
  /** The Guide me through door on a manual card (MOTIR-7466; design MOTIR-7462
   *  panel 1): `plan=guide&planFrom=guide&planItem=<KEY>`. */
  | { kind: 'guide'; itemKey: string };

/**
 * The shipped planning-workspace entry path — the ESTABLISHED-project host
 * (MOTIR-1729): a full-screen route outside the app shell that renders the
 * canvas+chat workspace seeded from the `mode` + `from` context below.
 *
 * It used to be `/onboarding`, which dead-ended: `app/(onboarding)/onboarding/
 * page.tsx` redirects a project whose `onboardingRanAt` is set straight to
 * `/roadmap`, so the launcher round-tripped and the workspace never opened. As
 * this module's original note promised, closing that gap changed only this
 * constant + the resolver — every call site (the TopNav pill, the FAB, ⌘K, the
 * roadmap empty state) is untouched.
 *
 * The onboarding gates are NOT relaxed: a project that never onboarded is
 * forwarded from the host to `/onboarding`, so first-run and migrate projects
 * keep their journey (the host is an ADDITIONAL surface, not a bypass).
 */
/* ⚠️ THREE ROUTE-ERA EXPORTS WERE DELETED HERE (MOTIR-4732, story MOTIR-4725),
 * and this note is what a reader meeting an old citation lands on.
 *
 *   · `PLANNING_WORKSPACE_PATH` — `'/planning'`, the workspace's entry path.
 *   · `planningWorkspaceHref(context)` — the DESTINATION a door navigated to.
 *   · `planningLaunchBackHref(launch)` — where Close RETURNED to, resolved from
 *     the origin: the item page, `/code-health`, or `/roadmap`.
 *
 * The workspace is an OVERLAY now: it opens ON the page you are already on and
 * closes by removing four query parameters from that page's own address. So
 * there is no destination to build and no return route to resolve —
 * `withPlanningOverlay` and `withoutPlanningOverlay` below are what replaced
 * them, and `parsePlanningOverlay` is what reads the result back.
 *
 * The return MAPPING survives in one place, because an old link still needs a
 * page to land on: `app/(authed)/planning/page.tsx`, the forward, inlines it.
 */

/**
 * WHERE A NAMED SESSION WAS REOPENED FROM (`planVia`, Story MOTIR-6012 · MOTIR-6037;
 * `design/ai-planning/design-notes.md` Part XXII §22.2). A list that opens a plan's
 * conversation writes it, and only the reopened line reads it: *Reopened from Waiting on
 * you* / *Reopened from Planning* rather than the Plans-page line every `planSession`
 * address printed before. Absent means the Plans page, so every shipped link keeps its
 * meaning.
 *
 * `planning` is the Workbench's Planning tab (`design/workbench/design-notes.md` § 36.6,
 * MOTIR-7831): only the plan's own requester ever reaches that list, so its line has no
 * *started by {name}* form.
 *
 * `resume` is the Workbench's To resume tab (`design/workbench/design-notes.md` § 37.2,
 * MOTIR-7917): a failed planning session's **Open**. That tab is the reader's OWN list, so
 * its line has the same single *started by you* form as `planning`.
 */
export type PlanningEntrance = 'approvals' | 'planning' | 'resume';

/** Every entrance, so the address parser is total over the union rather than testing one
 *  string — a third entrance added above is then read back without a second edit here. */
const PLANNING_ENTRANCES: readonly PlanningEntrance[] = ['approvals', 'planning', 'resume'];

/** Resolve the originating context to the planning mode the workspace opens in. */
export function resolvePlanningMode(context: PlanningLaunchContext): PlanningMode {
  switch (context.kind) {
    case 'work-item':
      // The per-item entrance's two faces (MOTIR-910): an item that already has
      // children opens the workspace in RE-PLAN (the composer asks what's wrong
      // first); one that does not opens the plain contextual planning turn. An
      // absent `hasPlan` is the coarse case — contextual, as before.
      return context.hasPlan ? 'replan' : 'contextual';
    case 'roadmap':
      return 'roadmap';
    // The ADDRESS's mode only. The seed is not known until the overlay reads it,
    // and the overlay resolves the workspace's real mode from the seed's
    // `intent`: `replan` for a refusal, a forward launch for a pick (MOTIR-6435).
    // `replan` stays here so every refusal link keeps writing the address it
    // always wrote.
    case 'refused-gate':
      return 'replan';
    case 'guide':
      return 'guide';
    // The ADDRESS's mode only: the overlay resolves the workspace from the offer's
    // seed, as it does for `refused-gate`.
    case 'guide-offer':
      return 'contextual';
    case 'project':
      if (context.hasPlan === undefined) return 'project';
      return context.hasPlan ? 'replan' : 'generation';
  }
}

// ─── The INVERSE: reading the launch context back off the host's query ────────
//
// `planningOverlaySearch` writes the context; the overlay reads it back. Both
// halves live here, in the launcher's pure core, so the two can never drift
// apart and both are unit-testable without a route.
//
// `parsePlanningLaunch` still reads the ROUTE-ERA names (`mode` / `from` /
// `item` / `repo`) — it has exactly one caller left, the `/planning` FORWARD
// (MOTIR-4732), which is what an old bookmark lands on. It is kept for that and
// nothing else; `parsePlanningOverlay` is what every live surface uses.

/** The origin kinds an overlay address carries as `planFrom`. */
export type PlanningOrigin = PlanningLaunchContext['kind'];

const PLANNING_MODES: readonly PlanningMode[] = [
  'project',
  'generation',
  'replan',
  'contextual',
  'roadmap',
  'guide',
];

const PLANNING_ORIGINS: readonly PlanningOrigin[] = [
  'project',
  'work-item',
  'roadmap',
  'refused-gate',
  'guide-offer',
  'guide',
];

/**
 * The launch context AS THE HOST SEES IT — the resolved mode plus whatever
 * originating detail survived the href. Every field is total: an absent or
 * unrecognized param degrades to the coarse project-scoped default rather than
 * erroring, because this is parsed from a user-editable URL.
 */
export interface PlanningLaunch {
  mode: PlanningMode;
  from: PlanningOrigin;
  /** The `work-item` origin's target key, when carried. */
  itemKey: string | null;
  /** A named session to reopen (`planSession`), when carried (MOTIR-6024). */
  sessionId?: string | null;
  /** Where that named session was reopened FROM (`planVia`, MOTIR-6037) — present only
   *  with `sessionId`, and only for an entrance other than the Plans page. */
  via?: PlanningEntrance;
  /** The decided gate a `refused-gate` launch is seeded from (`planGate`, MOTIR-6210) —
   *  a refusal or, since MOTIR-6435, a pick. Present only for that origin, and only
   *  when the address carries one. */
  gateId?: string;
  /** The guide offer a `guide-offer` launch is seeded from (`planOffer`, MOTIR-8693) —
   *  the offer's turn id. Present only for that origin. */
  guideTurnId?: string;
  /** Send the start turn (`planStart`, MOTIR-7973) — present only for a `work-item`
   *  origin with an anchor and no named session. */
  startTurn?: boolean;
  /** Ask before starting (`planAsk`, MOTIR-10624) — present only for a `work-item`
   *  origin with an anchor, no named session and no `startTurn`. */
  confirmStart?: boolean;
}

/** The default a missing / unknown `?mode=` falls back to (never an error). */
export const DEFAULT_PLANNING_MODE: PlanningMode = 'project';
const DEFAULT_PLANNING_ORIGIN: PlanningOrigin = 'project';

type RawParam = string | string[] | undefined;

/** Next's `searchParams` hands a repeated key through as an array — take the first. */
function first(raw: RawParam): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Parse `?mode=`; anything unrecognized falls back to the project default. */
export function parsePlanningMode(raw: RawParam): PlanningMode {
  const value = first(raw);
  return PLANNING_MODES.find((m) => m === value) ?? DEFAULT_PLANNING_MODE;
}

/** Parse `?from=`; anything unrecognized falls back to the project origin. */
export function parsePlanningOrigin(raw: RawParam): PlanningOrigin {
  const value = first(raw);
  return PLANNING_ORIGINS.find((o) => o === value) ?? DEFAULT_PLANNING_ORIGIN;
}

/** Read the whole launch context back off the host route's query params. */
export function parsePlanningLaunch(searchParams: Record<string, RawParam>): PlanningLaunch {
  const from = parsePlanningOrigin(searchParams['from']);
  const mode = parsePlanningMode(searchParams['mode']);
  return {
    // The route era never had a guide; an old address naming one has no card to
    // guide through, so it opens the default mode (MOTIR-7466).
    mode: mode === 'guide' ? DEFAULT_PLANNING_MODE : mode,
    from,
    // Only the origin that WRITES the param may carry it back, so a hand-edited
    // `?from=roadmap&item=X` can't smuggle a target into a non-item mode.
    itemKey: from === 'work-item' ? first(searchParams['item']) : null,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE OVERLAY ADDRESS (MOTIR-4728, under story MOTIR-4725)
 *
 * The workspace is a full-screen OVERLAY on the page you are already on, not a
 * route (`design/ai-chat/design-notes.md` § *Opening & exiting — a full-screen
 * overlay ON TOP of the app (sheet 6)*). So the launcher's job changes shape:
 * instead of building a destination href, it MERGES a namespaced query onto the
 * caller's CURRENT address, STRIPS that query for Close, and PARSES it back.
 *
 * ⚠️ THE NAMES ARE THE DESIGN'S, NOT THIS MODULE'S. They are recorded in
 * `design/ai-chat/design-notes.md` § *The ADDRESS — a NAMESPACED query, settled
 * here because three cards read it*, exactly as `design/runs/design-notes.md`
 * records `/runs?run=<id>`, because THREE files have to agree on them: this
 * module writes and parses them, the overlay reads them off `useSearchParams`,
 * and the retiring `/planning` forward rewrites the old `mode`/`from`/`item`/
 * `repo` onto them. `OVERLAY_PARAM_NAMES` below is the single copy in code, and
 * `tests/planning/launcher.test.ts` asserts it against those names verbatim so a
 * rename in either home fails a test.
 *
 * WHY NAMESPACED, measured at `origin/main` `71896757c`: the overlay can open on
 * ANY authed route, so its query rides beside the host page's own — and the
 * obvious names are taken. `?item=` on `/roadmap` is the drilled LEVEL
 * (MOTIR-3836's `resolveArrivalTrail`), `?peek=` is the quick view on `/items`,
 * `/ready` and `/boards`, `?run=` is the run modal, and `?mode=` / `?from=` are
 * generic enough to collide with anything. A merge that clobbered one of those
 * would silently change the page underneath the overlay.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * The four parameters the overlay's address carries.
 *
 * `plan` is BOTH the presence switch and the mode — the way `?run=` and `?peek=`
 * each own one word. Its presence is what opens the overlay, so "is the overlay
 * open?" is one lookup; and because the mode is already total (anything
 * unrecognised falls back to `project`), it can ride that key without a second
 * degradation path.
 */
export const OVERLAY_PARAM_NAMES = {
  /** the presence switch AND the resolved {@link PlanningMode}. */
  mode: 'plan',
  /** the {@link PlanningOrigin} — what decides which of the two below may be read. */
  origin: 'planFrom',
  /** the anchor work-item key; written ONLY for a `work-item` origin. */
  item: 'planItem',
  /**
   * A NAMED planning session to reopen (MOTIR-6024; AMENDMENT 17 §2) — what a
   * Plans row writes. Read only for a `project` or `work-item` origin, and it
   * bypasses the resume read: a named conversation opens whatever its age or state.
   */
  session: 'planSession',
  /**
   * The ENTRANCE a named session was reopened from (MOTIR-6037; design Part XXII
   * §22.2) — `approvals` from a To-approve row. Read only with `planSession`; absent
   * or any other value means the Plans page. Its one reader is the rail's reopened
   * line.
   */
  via: 'planVia',
  /**
   * The DECIDED GATE a seeded launch reads (a refusal, or since MOTIR-6435 a pick) (story MOTIR-6068 · MOTIR-6210; design
   * `design/ai-chat/design-notes.md` § *The SEEDED re-plan* → *The ADDRESS*). Written
   * ONLY for a `refused-gate` origin, as `plan=replan&planFrom=refused-gate&planGate=<id>`,
   * and read only for that origin. It is the gate's id and NOTHING else — the reason
   * is read from the server, never carried in the URL (§10f).
   */
  gate: 'planGate',
  /**
   * START THE CONVERSATION (MOTIR-7973; design MOTIR-7875 § *Expand starts a
   * planning conversation*) — `planStart=1` asks the overlay to SEND the anchor's
   * start turn (`Plan <KEY>`) once, for the person, as the thread's first message.
   * Written ONLY for a `work-item` origin with no `planSession`, and read only
   * there: a named conversation is a reopen, never a start. The host replaces it
   * with `planSession=<id>` after the first turn, so a reload resumes rather than
   * asking again.
   */
  start: 'planStart',
  /**
   * The GUIDE OFFER a `guide-offer` launch is seeded from (Story MOTIR-8684 ·
   * MOTIR-8693) — written ONLY for that origin, as
   * `plan=contextual&planFrom=guide-offer&planOffer=<turnId>`, and read only for it.
   * It is the offer's turn id and NOTHING else: the request text, the target and the
   * guided card are read from the server, never carried in the URL.
   */
  guideOffer: 'planOffer',
  /**
   * ASK BEFORE STARTING (MOTIR-10624; design MOTIR-10623 § *Which launches show
   * it*) — `planAsk=1` asks the overlay to open on the start prompt: a planner
   * message naming the anchor, with **Start planning** / **Start re-planning**.
   * Written ONLY by the card's Plan / Re-plan button, for a `work-item` origin
   * with no `planSession` and no `planStart`, and read only there — so no other
   * door can raise the prompt. Nothing is sent until the person presses Start or
   * sends; the prompt's spent state is derived from the thread, so the address
   * keeps it and a reload draws the same record.
   */
  ask: 'planAsk',
} as const;

/**
 * THE RETURN MARKER (MOTIR-4770) — set on the address onboarding sends a user
 * BACK to, and read once by the overlay it re-opens.
 *
 * ⚠️ IT IS NOT ONE OF THE FOUR. `OVERLAY_PARAM_NAMES` above is the set the
 * design pins and `parsePlanningOverlay` reads to decide whether the workspace
 * is OPEN; this one says nothing about that and is not part of the launch. What
 * it says is *you have just come back from onboarding*, which the overlay needs
 * for exactly one decision: not to ask for a routing verdict again (MOTIR-4769's
 * run) about a project that was routed thirty seconds ago and has just done what
 * it was sent to do.
 *
 * ⚠️ IT IS STRIPPED WITH THEM THOUGH, and that is why it lives beside them. A
 * marker that survived Close would suppress the routing run for the rest of that
 * page's life — a stale query parameter quietly changing what the next open
 * does.
 */
export const PLANNING_RETURN_PARAM = 'planReturned' as const;

/** Every parameter the overlay OWNS, for the strip and the collision guards. */
const OVERLAY_PARAMS: readonly string[] = [
  ...Object.values(OVERLAY_PARAM_NAMES),
  PLANNING_RETURN_PARAM,
];

/**
 * The overlay's parameters for a launch context — the mode, the origin, and the
 * origin's own payload.
 *
 * The payload is gated on the ORIGIN on the way OUT as well as on the way back
 * (`parsePlanningLaunch`'s own rule), so the two halves cannot disagree about
 * which contexts may carry a target.
 */
export function planningOverlaySearch(context: PlanningLaunchContext): URLSearchParams {
  const params = new URLSearchParams({
    [OVERLAY_PARAM_NAMES.mode]: resolvePlanningMode(context),
    [OVERLAY_PARAM_NAMES.origin]: context.kind,
  });
  if (context.kind === 'work-item' || context.kind === 'guide') {
    params.set(OVERLAY_PARAM_NAMES.item, context.itemKey);
  }
  if (context.kind === 'refused-gate') params.set(OVERLAY_PARAM_NAMES.gate, context.gateId);
  if (context.kind === 'guide-offer')
    params.set(OVERLAY_PARAM_NAMES.guideOffer, context.guideTurnId);
  if ((context.kind === 'project' || context.kind === 'work-item') && context.sessionId) {
    params.set(OVERLAY_PARAM_NAMES.session, context.sessionId);
    // The entrance rides ONLY with a named session: it says where THAT session was
    // reopened from, and means nothing without one (MOTIR-6037).
    if (context.via) params.set(OVERLAY_PARAM_NAMES.via, context.via);
  }
  // A START rides only a fresh item conversation: beside a named session it would
  // ask to start a thread that already exists.
  if (context.kind === 'work-item' && context.startTurn && !context.sessionId) {
    params.set(OVERLAY_PARAM_NAMES.start, '1');
  }
  // ASKING rides the same fresh item conversation, and gives way to a START: a
  // door that sends outright has nothing left to ask.
  if (
    context.kind === 'work-item' &&
    context.confirmStart &&
    !context.sessionId &&
    !context.startTurn
  ) {
    params.set(OVERLAY_PARAM_NAMES.ask, '1');
  }
  return params;
}

/**
 * Split an href into its path (with any hash) and its query, WITHOUT resolving
 * it against an origin.
 *
 * `new URL(href)` needs a base and would normalise the path; these hrefs are the
 * app-relative ones `usePathname()` + `useSearchParams()` hand a client, and the
 * one thing this module must not do is change the host page's address in any way
 * other than adding or removing the four parameters above.
 */
function splitHref(href: string): { path: string; query: URLSearchParams; hash: string } {
  const hashAt = href.indexOf('#');
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  const withoutHash = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = withoutHash.indexOf('?');
  return {
    path: queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt),
    query: new URLSearchParams(queryAt === -1 ? '' : withoutHash.slice(queryAt + 1)),
    hash,
  };
}

/** Re-assemble, leaving NO dangling `?` when the query came out empty. */
function joinHref(path: string, query: URLSearchParams, hash: string): string {
  const qs = query.toString();
  return `${path}${qs ? `?${qs}` : ''}${hash}`;
}

/**
 * The OPEN address: `href` — the page the reader is on, with its own query — plus
 * the overlay's parameters.
 *
 * **Every host parameter survives byte for byte.** `/roadmap?item=MOTIR-12` keeps
 * its drilled level and `/items?peek=MOTIR-12` keeps its quick view, which is the
 * whole reason the names are namespaced.
 *
 * **Launching over an ALREADY-OPEN overlay REPLACES its parameters** rather than
 * appending a second set — re-targeting from the canvas's own per-item entrance
 * is a same-address navigation, and two `plan=` values would make the parse
 * order-dependent.
 */
/**
 * WHERE A LAUNCH CONTEXT BELONGS — the page the workspace should be open OVER.
 *
 * ⚠️ LIFTED HERE FROM `app/(authed)/planning/page.tsx` (MOTIR-4770), which is
 * the only place it had survived. Two callers now ask the same question and
 * neither is the forward:
 *
 *   · the FORWARD — an old `/planning?…` address named a context but no page;
 *   · the RETURN — onboarding is finished and the user has a context but has
 *     left the route group entirely, so there is no page underneath to go back
 *     to.
 *
 * They are the same question — *this context belongs to which page?* — and the
 * forward's own note already said so, calling itself `planningLaunchBackHref`'s
 * mapping inlined. Two copies of it is the drift MOTIR-4732's note is about.
 */
export function planningHostPathFor(context: PlanningLaunchContext): string {
  if (context.kind === 'work-item' || context.kind === 'guide') {
    return `/items/${encodeURIComponent(context.itemKey)}`;
  }
  return '/roadmap';
}

export function withPlanningOverlay(href: string, context: PlanningLaunchContext): string {
  const { path, query, hash } = splitHref(href);
  for (const name of OVERLAY_PARAMS) query.delete(name);
  for (const [name, value] of planningOverlaySearch(context)) query.set(name, value);
  return joinHref(path, query, hash);
}

/**
 * The CLOSE address: `href` with ONLY the overlay's parameters removed.
 *
 * This is what Close, `Esc`, the scrim and the guard's *Discard* all write. The
 * host page's own query is untouched, so the filter and the drilled level the
 * reader had are exactly what they come back to — and an href that carried
 * nothing else comes back with no trailing `?`.
 */
export function withoutPlanningOverlay(href: string): string {
  const { path, query, hash } = splitHref(href);
  for (const name of OVERLAY_PARAMS) query.delete(name);
  return joinHref(path, query, hash);
}

/**
 * What a `searchParams` looks like from either side of the render boundary: a
 * `URLSearchParams` (what `useSearchParams()` hands a client component) or the
 * plain record a Server Component's `searchParams` prop carries. The `/planning`
 * forward (MOTIR-4732) parses on the server, so both are accepted here rather
 * than at each call site.
 */
export type PlanningOverlayParams = URLSearchParams | Record<string, RawParam>;

function readParam(params: PlanningOverlayParams, name: string): RawParam {
  /* v8 ignore next -- `URLSearchParams.getAll` returns an ARRAY for an absent
     name, never null or undefined, so the `??` arm is unreachable by the Web
     API's own contract. It is kept because the value crosses into `RawParam`,
     which admits `undefined`, and dropping it would make the type lie about a
     shape nothing produces. `tests/planning/planning-overlay-story-gate.test.ts`
     pins the invariant it stands on. */
  return params instanceof URLSearchParams ? (params.getAll(name) ?? undefined) : params[name];
}

/**
 * Read the launch back off an address — **`null` when the overlay is not in it**,
 * which is the shell's mount predicate: presence of `plan` is what opens the
 * workspace.
 *
 * When it IS present the result is the same total {@link PlanningLaunch}
 * `parsePlanningLaunch` produces — an absent or unrecognised value degrades to
 * the coarse project default rather than erroring, because this is parsed from a
 * user-editable URL — including the anti-smuggling rule: `itemKey` survives only
 * for a `work-item` origin, so a
 * hand-edited `?plan=project&planFrom=roadmap&planItem=MOTIR-1` opens the project
 * conversation and carries no target.
 */
export function parsePlanningOverlay(params: PlanningOverlayParams): PlanningLaunch | null {
  if (first(readParam(params, OVERLAY_PARAM_NAMES.mode)) === null) return null;
  // ⭐ GUIDE (MOTIR-7466) — the one mode whose card is REQUIRED. It reads
  // `planItem` whatever the origin says (the door writes `planFrom=guide`; a
  // hand-typed `plan=guide&planItem=<KEY>` means the same thing), and an address
  // with no card has nothing to guide through, so it opens the default mode with
  // no target rather than a guide about nothing.
  if (parsePlanningMode(readParam(params, OVERLAY_PARAM_NAMES.mode)) === 'guide') {
    const itemKey = first(readParam(params, OVERLAY_PARAM_NAMES.item));
    return itemKey
      ? { mode: 'guide', from: 'guide', itemKey }
      : {
          mode: DEFAULT_PLANNING_MODE,
          from: DEFAULT_PLANNING_ORIGIN,
          itemKey: null,
        };
  }
  const from = parsePlanningOrigin(readParam(params, OVERLAY_PARAM_NAMES.origin));
  const sessionId =
    from === 'project' || from === 'work-item'
      ? first(readParam(params, OVERLAY_PARAM_NAMES.session))
      : null;
  // Read only WITH a named session; anything that names no entrance is the Plans page.
  const viaRaw = sessionId ? first(readParam(params, OVERLAY_PARAM_NAMES.via)) : null;
  const via = PLANNING_ENTRANCES.find((entrance) => entrance === viaRaw) ?? null;
  // The gate rides ONLY its own origin, like `planItem` does.
  const gateId =
    from === 'refused-gate' ? first(readParam(params, OVERLAY_PARAM_NAMES.gate)) : null;
  const guideTurnId =
    from === 'guide-offer' ? first(readParam(params, OVERLAY_PARAM_NAMES.guideOffer)) : null;
  const itemKey = from === 'work-item' ? first(readParam(params, OVERLAY_PARAM_NAMES.item)) : null;
  // The start rides ONLY an item origin with its anchor and no named session —
  // the same rule the write side keeps (MOTIR-7973).
  const startTurn =
    itemKey !== null &&
    sessionId === null &&
    first(readParam(params, OVERLAY_PARAM_NAMES.start)) !== null;
  // …and the ask by the same rule, giving way to a start as the write side does.
  const confirmStart =
    itemKey !== null &&
    sessionId === null &&
    !startTurn &&
    first(readParam(params, OVERLAY_PARAM_NAMES.ask)) !== null;
  return {
    mode: parsePlanningMode(readParam(params, OVERLAY_PARAM_NAMES.mode)),
    from,
    itemKey,
    // Only the two origins a Plans row writes may carry a named session, and the
    // key is present only when it does — every other launch reads as before.
    ...(sessionId ? { sessionId } : {}),
    ...(via ? { via } : {}),
    ...(gateId ? { gateId } : {}),
    ...(guideTurnId ? { guideTurnId } : {}),
    ...(startTurn ? { startTurn: true } : {}),
    ...(confirmStart ? { confirmStart: true } : {}),
  };
}
