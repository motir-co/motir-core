// THE INDEX ALLOWANCE, AS MOTIR-CORE READS IT (MOTIR-4593 · Story MOTIR-4335).
//
// motir-ai owns the allowance: the two pools, the rate, the verdict
// (`motir-ai` MOTIR-4592 / MOTIR-5284, `docs/contract.md` § index-check /
// index-draw). motir-core owns the container-seconds and the dispatch. This
// module is the vocabulary between the two: pure, so a test and a job read the
// same rules.
//
// ⚠️⚠️ MOTIR DOES NOT CHARGE FOR CODE INDEXING. The allowance is internal cost
// accounting on Motir's own compute. Nothing here reaches a customer surface, and
// nothing here touches the visible credit balance.
//
// ⚠️ ONLY A HARD STOP PREVENTS A BOOT. `soft_gate_crossed` — a paid tier past its
// allowance — BOOTS, and motir-ai records the crossing. A soft gate that refused
// would destroy the instrument: the crossing rate is what says whether the gate is
// mis-sized, and a gate that blocks can never measure how often it was wrong.

/** The verdicts motir-ai names today. The type stays OPEN (`string`) on the wire:
 *  a verdict added there (hard gate B, MOTIR-5280) must reach the family rule
 *  below rather than be refused by a parser that never heard of it. */
export const KNOWN_INDEX_ALLOWANCE_OUTCOMES = [
  'ok',
  'soft_gate_crossed',
  'hard_stop_no_credit',
  'hard_stop_allowance_exhausted',
  'no_allowance_configured',
  'exempt',
] as const;

export type KnownIndexAllowanceOutcome = (typeof KNOWN_INDEX_ALLOWANCE_OUTCOMES)[number];

/** A verdict from `POST /v1/credits/index-check` or `/index-draw`. */
export interface IndexAllowanceVerdict {
  /** A known outcome, or a newer `hard_stop_*` / other value motir-ai added. */
  outcome: string;
  window: string | null;
  grantedCredits: number | null;
  consumedCredits: number | null;
  attributedCredits: number;
}

/** The reason recorded on a repository whose index was paused by a hard stop —
 *  `hard_stop_no_credit` → `paused_index_no_credit`. */
export type IndexPauseReason = `paused_index_${string}`;

/** The pause recorded when index admission refuses an organisation with no paid
 *  AI plan (MOTIR-8235). Not an allowance stop, but the same kind of state: a
 *  repository that is not being indexed for a reason, which the catch-up sweep
 *  re-asks about. */
export const AI_PLAN_INDEX_PAUSE_REASON: IndexPauseReason = 'paused_index_ai_plan_required';

/** The pause recorded when every account of the indexer pool is full
 *  (MOTIR-9451). NOT an allowance stop: it is a property of Motir's capacity,
 *  not of the organisation, so the catch-up sweep lifts it when the pool has
 *  room rather than by asking the allowance, and the allowance surfaces do not
 *  list it as a stopped organisation. The repository is waiting, not refused. */
export const INDEX_POOL_FULL_PAUSE_REASON: IndexPauseReason = 'paused_index_pool_full';

/** Is this recorded pause a full indexer pool rather than an allowance or plan
 *  stop? The one comparison — no caller compares the strings. */
export function isPoolFullPause(reason: string | null | undefined): boolean {
  return reason === INDEX_POOL_FULL_PAUSE_REASON;
}

const HARD_STOP_PREFIX = 'hard_stop_';

/**
 * Does this verdict stop the container from booting?
 *
 * ⚠️ IT KEYS ON THE OUTCOME FAMILY, NOT ON A LIST OF NAMES (MOTIR-4593 AC 4). Hard
 * gate B's `hard_stop_headroom_exhausted` lands in motir-ai separately; when it
 * does, it is refused here with no change. A list of the two stops known today
 * would boot the third.
 */
export function isIndexHardStop(outcome: string): boolean {
  return outcome.startsWith(HARD_STOP_PREFIX) && outcome.length > HARD_STOP_PREFIX.length;
}

/** The recorded pause reason for a hard stop, or `null` for a verdict that boots. */
export function indexPauseReasonFor(outcome: string): IndexPauseReason | null {
  if (!isIndexHardStop(outcome)) return null;
  return `paused_index_${outcome.slice(HARD_STOP_PREFIX.length)}`;
}

/**
 * Parse a verdict body, or `null` when it is not one.
 *
 * ⚠️ `null` IS "COULD NOT ASK", NEVER A VERDICT. A body without a string `outcome`
 * — an error envelope, an older motir-ai answering 404, a proxy page — must not be
 * read as `ok` and must not be read as a stop. The caller decides what not
 * knowing means.
 */
export function parseIndexAllowanceVerdict(body: unknown): IndexAllowanceVerdict | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b['outcome'] !== 'string' || b['outcome'] === '') return null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    outcome: b['outcome'],
    window: typeof b['window'] === 'string' ? b['window'] : null,
    grantedCredits: num(b['grantedCredits']),
    consumedCredits: num(b['consumedCredits']),
    attributedCredits: num(b['attributedCredits']) ?? 0,
  };
}

/** The draw's idempotency key: ONE draw per container, whatever replays. */
export function indexDrawKey(containerProvider: string, containerId: string): string {
  return `index-container:${containerProvider}:${containerId}`;
}

// ── THE PLATFORM ADMIN'S READS (MOTIR-4595 · motir-ai MOTIR-5340) ────────────────

/** One tier's row of motir-ai's `GET /v1/admin/index-allowance/summary`. */
export interface IndexAllowanceTierSummary {
  tierKey: string;
  tierName: string;
  cadence: 'one_time' | 'monthly';
  allotmentCredits: number;
  orgs: number;
  crossed: number | null;
  exhausted: number | null;
  grantedCreditsPerOrg: number | null;
  configured: boolean;
}

export interface IndexAllowanceSummary {
  window: string;
  ratio: number | null;
  untieredOrgs: number;
  tiers: IndexAllowanceTierSummary[];
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isIntOrNull = (v: unknown): v is number | null => v === null || isInt(v);

/** Parse a summary body, or `null` when it is not one — never a partial summary. */
export function parseIndexAllowanceSummary(body: unknown): IndexAllowanceSummary | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b['window'] !== 'string' || !Array.isArray(b['tiers'])) return null;
  const tiers: IndexAllowanceTierSummary[] = [];
  for (const raw of b['tiers'] as unknown[]) {
    if (!raw || typeof raw !== 'object') return null;
    const t = raw as Record<string, unknown>;
    if (
      typeof t['tierKey'] !== 'string' ||
      typeof t['tierName'] !== 'string' ||
      (t['cadence'] !== 'one_time' && t['cadence'] !== 'monthly') ||
      !isInt(t['allotmentCredits']) ||
      !isInt(t['orgs']) ||
      !isIntOrNull(t['crossed']) ||
      !isIntOrNull(t['exhausted']) ||
      !isIntOrNull(t['grantedCreditsPerOrg']) ||
      typeof t['configured'] !== 'boolean'
    ) {
      return null;
    }
    tiers.push({
      tierKey: t['tierKey'],
      tierName: t['tierName'],
      cadence: t['cadence'],
      allotmentCredits: t['allotmentCredits'],
      orgs: t['orgs'],
      crossed: t['crossed'],
      exhausted: t['exhausted'],
      grantedCreditsPerOrg: t['grantedCreditsPerOrg'],
      configured: t['configured'],
    });
  }
  const ratio = b['ratio'];
  return {
    window: b['window'],
    ratio: typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : null,
    untieredOrgs: isInt(b['untieredOrgs']) ? b['untieredOrgs'] : 0,
    tiers,
  };
}

/** Parse `POST /v1/admin/orgs/tiers` into `coreOrganizationId → tierKey | null`, or
 *  `null` when the body is not the answer. */
export function parseOrgTiers(body: unknown): Map<string, string | null> | null {
  if (!body || typeof body !== 'object') return null;
  const orgs = (body as Record<string, unknown>)['orgs'];
  if (!Array.isArray(orgs)) return null;
  const out = new Map<string, string | null>();
  for (const raw of orgs as unknown[]) {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (typeof o['coreOrganizationId'] !== 'string') return null;
    out.set(o['coreOrganizationId'], typeof o['tierKey'] === 'string' ? o['tierKey'] : null);
  }
  return out;
}

/** The share of a tier's organisations that crossed, above which the gate is read
 *  as mis-sized. */
export interface RecalcThreshold {
  pct: number;
  /** True while it is the design's default rather than a configured value. */
  provisional: boolean;
}

/**
 * The recalculate threshold (MOTIR-4595).
 *
 * ⚠️ PROVISIONAL BY DEFAULT, DELIBERATELY NOT UNSET. MOTIR-4588 measures and
 * proposes the real value, and it needs production to do so. An unset threshold
 * would draw the headline crossing rate against nothing, which is a state the design
 * does not draw. So it defaults to the design's 25%, and the surface says the
 * figure is provisional until `INDEX_ALLOWANCE_RECALC_THRESHOLD_PCT` is set
 * (approved with the MOTIR-4595 split, 2026-09-13).
 */
export const DEFAULT_RECALC_THRESHOLD_PCT = 25;

export function readRecalcThreshold(
  raw: string | undefined = process.env['INDEX_ALLOWANCE_RECALC_THRESHOLD_PCT'],
): RecalcThreshold {
  if (raw === undefined || raw.trim() === '') {
    return { pct: DEFAULT_RECALC_THRESHOLD_PCT, provisional: true };
  }
  const pct = Number(raw);
  return Number.isFinite(pct) && pct > 0 && pct <= 100
    ? { pct, provisional: false }
    : { pct: DEFAULT_RECALC_THRESHOLD_PCT, provisional: true };
}

/** The org read's state vocabulary (motir-ai MOTIR-5340). Open on the wire. */
export type OrgIndexState =
  | 'exempt'
  | 'stopped_no_credit'
  | 'stopped_allowance_exhausted'
  | 'over_still_indexing'
  | 'under'
  | 'not_configured'
  | 'not_granted_yet';

/** One organisation's two pools, as motir-ai's `GET /v1/admin/index-allowance/orgs/:id`
 *  returns them. */
export type OrgIndexPools =
  | { known: false }
  | {
      known: true;
      isMeta: boolean;
      tier: {
        key: string;
        name: string;
        cadence: 'one_time' | 'monthly';
        allotmentCredits: number;
      } | null;
      credit: { balanceCredits: number };
      index: {
        window: string;
        grantedCredits: number;
        consumedCredits: number;
        remainingCredits: number;
        crossingRecorded: boolean;
      } | null;
      state: string;
    };

/** Parse the org read, or `null` when the body is not one — never a partial pool. */
export function parseOrgIndexPools(body: unknown): OrgIndexPools | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b['known'] === false) return { known: false };
  if (b['known'] !== true || typeof b['state'] !== 'string') return null;
  const credit = b['credit'] as Record<string, unknown> | null | undefined;
  if (!credit || typeof credit['balanceCredits'] !== 'number') return null;
  const rawTier = b['tier'] as Record<string, unknown> | null | undefined;
  const tier =
    rawTier &&
    typeof rawTier['key'] === 'string' &&
    typeof rawTier['name'] === 'string' &&
    (rawTier['cadence'] === 'one_time' || rawTier['cadence'] === 'monthly') &&
    isInt(rawTier['allotmentCredits'])
      ? {
          key: rawTier['key'],
          name: rawTier['name'],
          cadence: rawTier['cadence'] as 'one_time' | 'monthly',
          allotmentCredits: rawTier['allotmentCredits'],
        }
      : null;
  const rawIndex = b['index'] as Record<string, unknown> | null | undefined;
  let index = null;
  if (rawIndex) {
    if (
      typeof rawIndex['window'] !== 'string' ||
      !isInt(rawIndex['grantedCredits']) ||
      !isInt(rawIndex['consumedCredits']) ||
      !isInt(rawIndex['remainingCredits'])
    ) {
      return null;
    }
    index = {
      window: rawIndex['window'],
      grantedCredits: rawIndex['grantedCredits'],
      consumedCredits: rawIndex['consumedCredits'],
      remainingCredits: rawIndex['remainingCredits'],
      crossingRecorded: rawIndex['crossingRecorded'] === true,
    };
  }
  return {
    known: true,
    isMeta: b['isMeta'] === true,
    tier,
    credit: { balanceCredits: credit['balanceCredits'] },
    index,
    state: b['state'],
  };
}
