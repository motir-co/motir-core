import type {
  CalculatorAnswerDTO,
  CalculatorCadence,
  CalculatorCategoriesDTO,
} from '@/lib/dto/billing';

// The browser side of the Billing & plans Calculator (Story MOTIR-8381 · MOTIR-9004):
// the categories read and the estimate over
// /api/organizations/[orgId]/billing/calculator/{categories,estimate}. Every outcome
// the server can give is folded into a closed union, so the view switches on a
// `kind` and never renders a server `error` string. The one place the two paths
// appear in client code.
//
// Type-only imports: neither zod nor a server-only module reaches the client
// bundle through this file.

export interface CalculatorEstimateInput {
  /** Items planned in Motir a month (MOTIR-9224). */
  plannedPerMonth: { low: number; high: number };
  /** Items run on Motir's runner a month; 0–0 for an org that runs on its own agent. */
  runPerMonth: { low: number; high: number };
  /** One to three category keys — no model is ever chosen. */
  categories: string[];
  /**
   * Each category's whole-percentage share of the run, keyed by `categories`, totalling
   * 100 (MOTIR-9832). Sent only with two or more categories; absent, the run splits evenly.
   */
  shares?: Record<string, number>;
  cadence?: CalculatorCadence;
}

export type CalculatorOutcome<T> =
  /** 200 — the engine's body unaltered (an estimate or its `empty_category`). */
  | { kind: 'answer'; value: T }
  /** 400 CALCULATOR_REQUEST_INVALID — `field` when the door named one. */
  | { kind: 'refused'; field: string | null }
  /** 503 CALCULATOR_UNAVAILABLE — the engine cannot estimate right now: ask again. */
  | { kind: 'unavailable' }
  /** Anything else: a boundary failure, a non-JSON body, a transport error. */
  | { kind: 'failed' };

async function call<T>(
  orgId: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<CalculatorOutcome<T>> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/organizations/${encodeURIComponent(orgId)}/billing/${path}`, {
      ...init,
      cache: 'no-store',
    });
  } catch {
    return { kind: 'failed' };
  }
  const body: unknown = await res.json().catch(() => null);
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (res.ok) return obj ? { kind: 'answer', value: obj as T } : { kind: 'failed' };
  if (obj?.['code'] === 'CALCULATOR_REQUEST_INVALID') {
    return { kind: 'refused', field: typeof obj['field'] === 'string' ? obj['field'] : null };
  }
  if (obj?.['code'] === 'CALCULATOR_UNAVAILABLE') return { kind: 'unavailable' };
  return { kind: 'failed' };
}

export function fetchCalculatorCategories(
  orgId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CalculatorOutcome<CalculatorCategoriesDTO>> {
  return call(orgId, 'calculator/categories', { method: 'GET' }, fetchImpl);
}

export function fetchCalculatorEstimate(
  orgId: string,
  input: CalculatorEstimateInput,
  fetchImpl: typeof fetch = fetch,
): Promise<CalculatorOutcome<CalculatorAnswerDTO>> {
  return call(
    orgId,
    'calculator/estimate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plannedPerMonth: input.plannedPerMonth,
        runPerMonth: input.runPerMonth,
        categories: input.categories,
        ...(input.shares ? { shares: input.shares } : {}),
        ...(input.cadence ? { cadence: input.cadence } : {}),
      }),
    },
    fetchImpl,
  );
}
