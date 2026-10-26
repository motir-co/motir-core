import type { ClaimActorDto } from '@/lib/dto/claim';
import type { ResolvedWorkItemHostedModelDto } from '@/lib/dto/projectHostedAgentSettings';
import { isWorkItemDifficulty } from '@/lib/issues/difficulty';
import { AGENT_CAPACITY_REASONS, type AgentCapacityReason } from '@/lib/hostedRuns/capacityReasons';

// THE HOSTED DOORS' PURE HELPERS (Story MOTIR-683 · MOTIR-691; Story MOTIR-6527 ·
// MOTIR-6796), lifted out of the item page's `HostedRunProvider` unchanged
// (MOTIR-6879) so a surface other than the item page — the Workbench To fix row —
// can read the same model list and answer a press in the same words.
//
// ⚠️ LIFTED, NOT FORKED. Every function here keeps the body it had in the provider,
// which now imports them back. A change to what a refusal means is made once.

/** The card's resolved preselection (MOTIR-6996): the model its difficulty maps
 *  to, why, and the difficulty it was resolved from — a straight read of the
 *  server's `resolveForWorkItem`, never re-derived here. */
export type HostedResolvedModel = ResolvedWorkItemHostedModelDto;

/** Whether a hosted agent run on the model can start right now (Story MOTIR-9541 ·
 *  MOTIR-9630) — the verdict and its reason code, and nothing else: the parser below
 *  is the client's tenant-safety line, so no counter or limit reaches state. */
export type HostedModelCapacity =
  | { verdict: 'available' }
  | { verdict: 'no_capacity'; reason: AgentCapacityReason };

/** One offered model, as the picker draws it. */
export interface HostedModel {
  id: string;
  provider: string;
  capacity: HostedModelCapacity;
}

/** The offered-model read, as the picker draws it: three faces, never one. */
export type HostedModelsState =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | {
      state: 'ok';
      models: HostedModel[];
      default: string | null;
      /** The card's resolved preselection — null where the read named no card
       *  or the server could not resolve it. */
      resolved?: HostedResolvedModel | null;
    };

/** One repository a run's App cannot write — the start route's 409 body, verbatim. */
export interface HostedRepositoryRefusal {
  repository: string;
  reason: string;
  fix: string;
  fixUrl: string | null;
}

/** Why a start did not start — drawn on the door, never in the timeline. */
export type HostedRunRefusal =
  | { kind: 'notReady' }
  | { kind: 'outOfCredits' }
  | { kind: 'modelNotOffered'; model: string }
  | { kind: 'noCapacity'; model: string }
  | { kind: 'notWritable'; repositories: HostedRepositoryRefusal[]; total: number | null }
  | { kind: 'unavailable' }
  | { kind: 'bootFailed' }
  | { kind: 'failed' };

/** Why a Continue hosted did not start — Run hosted's answers, less `notReady`
 *  (a continue has no readiness), plus the continue claim's own (MOTIR-6792). */
export type ContinueHostedRefusal =
  | Exclude<HostedRunRefusal, { kind: 'notReady' }>
  | { kind: 'taken'; holder: ClaimActorDto | null; startedAt: string | null }
  | { kind: 'runAlive'; holder: ClaimActorDto | null }
  | { kind: 'nothingPushed' }
  | { kind: 'useFix' }
  | { kind: 'notInProgress' }
  | { kind: 'noDeadRun' }
  | { kind: 'theParent'; parentKey: string | null }
  | { kind: 'gateAwaiting' }
  | { kind: 'gateSentBack' };

/** Why a *Fix on the hosted agent* did not start (Story MOTIR-1626 · MOTIR-6930) — Run
 *  hosted's answers, less `notReady` (a repair has no readiness), plus the repair claim's
 *  `taken` naming who holds the repair (`hosted_fix_taken`). The start route's
 *  `hosted_fix_not_sent_back` / `hosted_fix_not_repairable` mean the page is STALE — the
 *  card is no longer a review's to repair — so they read as *not started* and the surface
 *  re-reads its view, which then draws no door ({@link fixStateMoved}). */
export type FixHostedRefusal =
  | Exclude<HostedRunRefusal, { kind: 'notReady' }>
  | { kind: 'taken'; holder: ClaimActorDto | null; startedAt: string | null }
  | { kind: 'stale' };

/**
 * The model preselected from a list (MOTIR-6996): the card's RESOLVED model when
 * it is offered, else motir-ai's default when offered, else the first offered.
 * Total: any state, any list — null only when there is nothing to pick.
 */
export function preselectedModel(models: HostedModelsState): string | null {
  if (models.state !== 'ok' || models.models.length === 0) return null;
  const offered = (id: string | null | undefined): id is string =>
    !!id && models.models.some((m) => m.id === id);
  if (offered(models.resolved?.model)) return models.resolved.model;
  if (offered(models.default)) return models.default;
  return models.models[0]!.id;
}

/** The model is offered and has no agent-run capacity right now — its option is
 *  held and the door's start button is off (design § The preselect decision: the
 *  selection STAYS, whichever of the three sources chose it). */
export function isHeld(models: HostedModelsState, id: string | null): boolean {
  if (models.state !== 'ok' || id === null) return false;
  return models.models.some((m) => m.id === id && m.capacity.verdict === 'no_capacity');
}

/** Every offered model is held — the door's *All-models-held line*. */
export function allHeld(models: HostedModelsState): boolean {
  return (
    models.state === 'ok' &&
    models.models.length > 0 &&
    models.models.every((m) => m.capacity.verdict === 'no_capacity')
  );
}

/** A refusal the door still shows: a no-capacity refusal is about ONE model, and
 *  picking another clears it (design § No-capacity refusal). */
export function standingRefusal<R extends { kind: string; model?: string }>(
  refusal: R | null,
  selected: string | null,
): R | null {
  if (refusal?.kind === 'noCapacity' && refusal.model !== selected) return null;
  return refusal;
}

/** The list without its card resolution — the preselect as it was before
 *  MOTIR-6996, which Continue hosted keeps (a continuation is not re-resolved). */
export function withoutResolution(models: HostedModelsState): HostedModelsState {
  return models.state === 'ok' ? { ...models, resolved: null } : models;
}

/**
 * The resolution the picker's line describes for `value`, or null when there is
 * no line: nothing resolved, a source that is not about difficulty
 * (`platform_default` / `first_offered` — today's *Default* label stands), or a
 * value that is not the resolved model (the person picked another; design F6).
 */
export function provenanceFor(
  models: HostedModelsState,
  value: string | null,
): HostedResolvedModel | null {
  if (models.state !== 'ok' || !models.resolved || value === null) return null;
  const r = models.resolved;
  if (r.difficulty === null) return null;
  if (r.source !== 'override' && r.source !== 'platform_level') return null;
  if (r.model !== value || !models.models.some((m) => m.id === value)) return null;
  return r;
}

const SOURCES = new Set(['override', 'platform_level', 'platform_default', 'first_offered']);

/** The wire `resolved` → the client's, or null when it is absent or malformed. */
function resolvedOf(v: unknown): HostedResolvedModel | null {
  const o = v as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== 'object') return null;
  if (typeof o.model !== 'string' || typeof o.source !== 'string' || !SOURCES.has(o.source)) {
    return null;
  }
  return {
    model: o.model,
    source: o.source as HostedResolvedModel['source'],
    difficulty: isWorkItemDifficulty(o.difficulty) ? o.difficulty : null,
    fromLeaves: o.fromLeaves === true,
  };
}

const REASONS: ReadonlySet<string> = new Set(AGENT_CAPACITY_REASONS);

/** The wire `capacity` → the client's. Missing, malformed or an unknown reason reads
 *  `available`, so an older server or a bad payload never holds a model. */
export function capacityOf(v: unknown): HostedModelCapacity {
  const o = v as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== 'object' || o.verdict !== 'no_capacity') return { verdict: 'available' };
  if (typeof o.reason !== 'string' || !REASONS.has(o.reason)) return { verdict: 'available' };
  return { verdict: 'no_capacity', reason: o.reason as AgentCapacityReason };
}

/** The wire models → the client's, field by field (no wire key rides along). */
function modelsOf(v: unknown[]): HostedModel[] {
  return v.flatMap((m) => {
    const o = m as Record<string, unknown> | null;
    if (!o || typeof o.id !== 'string' || typeof o.provider !== 'string') return [];
    return [{ id: o.id, provider: o.provider, capacity: capacityOf(o.capacity) }];
  });
}

/** Read the offered list; with `workItemKey`, also that card's resolved model. */
export async function readModels(workItemKey?: string | null): Promise<HostedModelsState> {
  try {
    const url = workItemKey
      ? `/api/hosted-runs/models?workItem=${encodeURIComponent(workItemKey)}`
      : '/api/hosted-runs/models';
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { state: 'unavailable' };
    const body = (await res.json()) as {
      models?: unknown;
      default?: string | null;
      resolved?: unknown;
    };
    if (!Array.isArray(body.models)) return { state: 'unavailable' };
    return {
      state: 'ok',
      models: modelsOf(body.models),
      default: body.default ?? null,
      resolved: resolvedOf(body.resolved),
    };
  } catch {
    return { state: 'unavailable' };
  }
}

const CONTINUE_REFUSALS: Record<string, ContinueHostedRefusal['kind']> = {
  hosted_continue_nothing_pushed: 'nothingPushed',
  hosted_continue_use_fix: 'useFix',
  hosted_continue_not_in_progress: 'notInProgress',
  hosted_continue_no_dead_run: 'noDeadRun',
  hosted_continue_gate_awaiting: 'gateAwaiting',
  hosted_continue_gate_sent_back: 'gateSentBack',
};

function actorOf(v: unknown): ClaimActorDto | null {
  const o = v as { id?: unknown; name?: unknown } | null;
  return o && typeof o.id === 'string' && typeof o.name === 'string'
    ? { id: o.id, name: o.name }
    : null;
}

/** The start route's answer to a CONTINUE → the continue door's refusal. */
export function continueRefusalOf(
  status: number,
  body: Record<string, unknown>,
  model: string,
): ContinueHostedRefusal {
  const code = typeof body.code === 'string' ? body.code : '';
  if (code === 'hosted_continue_taken') {
    return {
      kind: 'taken',
      holder: actorOf(body.holder),
      startedAt: typeof body.startedAt === 'string' ? body.startedAt : null,
    };
  }
  if (code === 'hosted_continue_run_alive')
    return { kind: 'runAlive', holder: actorOf(body.holder) };
  if (code === 'hosted_continue_the_parent') {
    return {
      kind: 'theParent',
      parentKey: typeof body.parentKey === 'string' ? body.parentKey : null,
    };
  }
  const kind = CONTINUE_REFUSALS[code];
  if (kind) return { kind } as ContinueHostedRefusal;
  const run = refusalOf(status, body, model);
  // A continue has no readiness: a `not ready` answer would be a stale page, and the
  // nearest true sentence for it is that nothing was started.
  return run.kind === 'notReady' ? { kind: 'failed' } : run;
}

/** A continue refusal that means the page is STALE — its view is re-read (C5a). */
export function continueStateMoved(refusal: ContinueHostedRefusal): boolean {
  return (
    refusal.kind === 'taken' ||
    refusal.kind === 'runAlive' ||
    refusal.kind === 'nothingPushed' ||
    refusal.kind === 'useFix' ||
    refusal.kind === 'notInProgress' ||
    refusal.kind === 'noDeadRun' ||
    refusal.kind === 'theParent' ||
    refusal.kind === 'gateAwaiting' ||
    refusal.kind === 'gateSentBack' ||
    refusal.kind === 'bootFailed'
  );
}

/** The start route's answer to a FIX → the hosted repair door's refusal (MOTIR-6930). */
export function fixRefusalOf(
  status: number,
  body: Record<string, unknown>,
  model: string,
): FixHostedRefusal {
  const code = typeof body.code === 'string' ? body.code : '';
  if (code === 'hosted_fix_taken') {
    return {
      kind: 'taken',
      holder: actorOf(body.holder),
      startedAt: typeof body.startedAt === 'string' ? body.startedAt : null,
    };
  }
  if (code === 'hosted_fix_not_sent_back' || code === 'hosted_fix_not_repairable') {
    return { kind: 'stale' };
  }
  const run = refusalOf(status, body, model);
  // A repair has no readiness: a `not ready` answer would be a stale page too.
  return run.kind === 'notReady' ? { kind: 'stale' } : run;
}

/** A fix refusal that means the page is STALE — its view is re-read. NOT `taken`: its
 *  notice names the holder under the door, and the door stays with it until a reload
 *  draws the holder's running repair (design § 30 Panel 3c). */
export function fixStateMoved(refusal: FixHostedRefusal): boolean {
  return refusal.kind === 'stale' || refusal.kind === 'bootFailed';
}

/** One idempotency key per PRESS: a retried request of the same press replays. */
export function pressKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `press-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The start route's refusal body → the door's refusal. */
export function refusalOf(
  status: number,
  body: Record<string, unknown>,
  model: string,
): HostedRunRefusal {
  const code = typeof body.code === 'string' ? body.code : '';
  if (code === 'hosted_model_not_offered') return { kind: 'modelNotOffered', model };
  if (code === 'hosted_run_no_capacity') {
    return { kind: 'noCapacity', model: typeof body.model === 'string' ? body.model : model };
  }
  if (status === 402) return { kind: 'outOfCredits' };
  if (code === 'hosted_repository_not_writable') {
    return {
      kind: 'notWritable',
      repositories: Array.isArray(body.repositories)
        ? (body.repositories as HostedRepositoryRefusal[])
        : [],
      total: typeof body.totalRepositories === 'number' ? body.totalRepositories : null,
    };
  }
  if (code === 'hosted_run_card_not_ready') return { kind: 'notReady' };
  if (code === 'hosted_run_boot_failed') return { kind: 'bootFailed' };
  if (status === 503) return { kind: 'unavailable' };
  return { kind: 'failed' };
}
