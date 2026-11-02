import type {
  GrillingBranch,
  SettledAnswer,
  SharpenAssumption,
  SharpenQuestion,
  SharpenReading,
} from '@/lib/ai/types';

// The core-side READ of a `sharpen_turn` job's result (Task MOTIR-1101 · Subtask
// MOTIR-8181) — the `sharpenTurn` key on the job result envelope, produced by
// motir-ai's grilling session (MOTIR-8176).
//
// It is untrusted model output that crossed a boundary, so it is VALIDATED, never
// cast: only the five `kind` values pass, every string is length-capped, and a
// value that does not parse is `null` — which the Sharpen door treats as a
// FAILED turn, never as a plausible kind it guessed.

export type SharpenTurnKind =
  | 'question'
  | 'nothing_to_ask'
  | 'finished'
  | 'stopped'
  | 'unavailable';

/** One Sharpen turn's result, as motir-ai returns it. */
export interface SharpenTurnResult {
  kind: SharpenTurnKind;
  /** Non-null only on `question`. */
  question: SharpenQuestion | null;
  /** The FULL cumulative set, echoed every turn. */
  settled: SettledAnswer[];
  /** The FULL cumulative set, echoed every turn. */
  assumptions: SharpenAssumption[];
  /** The write-back outcome; null when none was attempted. */
  writeBack: { ok: boolean; error?: string } | null;
}

const KINDS: readonly SharpenTurnKind[] = [
  'question',
  'nothing_to_ask',
  'finished',
  'stopped',
  'unavailable',
];
const BRANCHES: readonly GrillingBranch[] = [
  'workflow',
  'alternative',
  'non_happy',
  'product_fit',
  'technical_thread',
];

/** Caps on what a turn may carry — generous for real use, bounded for storage. */
export const SHARPEN_CAPS = {
  id: 64,
  text: 2_000,
  label: 300,
  detail: 1_000,
  answer: 4_000,
  error: 500,
  entries: 200,
} as const;

/** Thrown inside the parse; caught at its edge and turned into `null`. */
class Unparseable extends Error {}

function obj(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Unparseable();
  return v as Record<string, unknown>;
}

function str(v: unknown, cap: number, { empty = false } = {}): string {
  if (typeof v !== 'string') throw new Unparseable();
  if (!empty && v.trim().length === 0) throw new Unparseable();
  return v.length > cap ? v.slice(0, cap) : v;
}

function nullableStr(v: unknown, cap: number): string | null {
  return v === null || v === undefined ? null : str(v, cap, { empty: true });
}

function branch(v: unknown): GrillingBranch {
  if (!BRANCHES.includes(v as GrillingBranch)) throw new Unparseable();
  return v as GrillingBranch;
}

function list<T>(v: unknown, one: (x: unknown) => T, max: number = SHARPEN_CAPS.entries): T[] {
  if (!Array.isArray(v) || v.length > max) throw new Unparseable();
  return v.map(one);
}

function reading(v: unknown): SharpenReading {
  const r = obj(v);
  if (typeof r.recommended !== 'boolean') throw new Unparseable();
  return {
    id: str(r.id, SHARPEN_CAPS.id),
    label: str(r.label, SHARPEN_CAPS.label),
    detail: str(r.detail ?? '', SHARPEN_CAPS.detail, { empty: true }),
    recommended: r.recommended,
  };
}

function question(v: unknown): SharpenQuestion {
  const q = obj(v);
  const readings = list(q.readings, reading, 4);
  if (readings.length < 2 || readings.filter((r) => r.recommended).length !== 1) {
    throw new Unparseable();
  }
  if (new Set(readings.map((r) => r.id)).size !== readings.length) throw new Unparseable();
  return {
    id: str(q.id, SHARPEN_CAPS.id),
    text: str(q.text, SHARPEN_CAPS.text),
    topic: branch(q.topic),
    because: nullableStr(q.because, SHARPEN_CAPS.text),
    quote: nullableStr(q.quote, SHARPEN_CAPS.text),
    readings,
  };
}

function settled(v: unknown): SettledAnswer {
  const s = obj(v);
  return {
    questionId: str(s.questionId, SHARPEN_CAPS.id),
    question: str(s.question, SHARPEN_CAPS.text),
    answer: str(s.answer, SHARPEN_CAPS.answer),
    topic: branch(s.topic),
    readingId: nullableStr(s.readingId, SHARPEN_CAPS.id),
    source: 'person',
  };
}

function assumption(v: unknown): SharpenAssumption {
  const a = obj(v);
  return {
    questionId: str(a.questionId, SHARPEN_CAPS.id),
    question: str(a.question, SHARPEN_CAPS.text),
    recommendation: str(a.recommendation, SHARPEN_CAPS.label),
    why: str(a.why ?? '', SHARPEN_CAPS.detail, { empty: true }),
    source: 'planner',
  };
}

function writeBack(v: unknown): SharpenTurnResult['writeBack'] {
  if (v === null || v === undefined) return null;
  const w = obj(v);
  if (typeof w.ok !== 'boolean') throw new Unparseable();
  const error = nullableStr(w.error, SHARPEN_CAPS.error);
  return error === null ? { ok: w.ok } : { ok: w.ok, error };
}

/**
 * Parse a `sharpenTurn` result. Returns `null` for anything that is not a
 * well-formed turn — an unknown `kind`, a `question` turn with no question, a
 * question with fewer than two readings or not exactly one recommended.
 */
export function parseSharpenTurn(raw: unknown): SharpenTurnResult | null {
  try {
    const r = obj(raw);
    if (!KINDS.includes(r.kind as SharpenTurnKind)) return null;
    const kind = r.kind as SharpenTurnKind;
    const q = kind === 'question' ? question(r.question) : null;
    return {
      kind,
      question: q,
      settled: list(r.settled ?? [], settled),
      assumptions: list(r.assumptions ?? [], assumption),
      writeBack: writeBack(r.writeBack),
    };
  } catch (err) {
    if (err instanceof Unparseable) return null;
    throw err;
  }
}
