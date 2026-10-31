import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BILLING_CATALOG } from '@/lib/billing/catalog';
import { calculatorEstimateRequestSchema } from '@/lib/dto/billing';
import {
  PINNED_CALCULATOR_REQUEST,
  PINNED_CATEGORIES_ANSWER,
  PINNED_CATEGORIES_RAW_BODY,
  PINNED_ESTIMATE_ANSWER,
  PINNED_ESTIMATE_RAW_BODY,
  PINNED_VECTOR_BASIS,
} from './fixtures/calculatorPinnedVector';

// The guard over the PINNED CROSS-SURFACE ESTIMATE VECTOR (Story MOTIR-8381 ·
// MOTIR-8642). It asserts the RECORD's own integrity and nothing about the live
// engine: a motir-core suite has no seam to motir-ai, so "the engine still
// answers this" belongs to the engine's public lane and to the integration card.
// What it does catch is the record being edited instead of re-recorded — a figure
// typed into the answer, provenance left blank, a basis that no longer describes
// the answer, or a selection the engine's live list never offered.

// The pattern motir-ai's own public lane asserts (tests/calculatorPublicE2E.test.ts):
// the answer carries no seat, quantity, cost or margin field for a surface to render.
const FORBIDDEN_KEY = /^seat|quantity|^cost|^margin|readAt|time/i;

function everyKey(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) everyKey(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      everyKey(child, out);
    }
  }
  return out;
}

function isWholeNonNegative(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

describe('the pinned calculator vector', () => {
  it('the recorded answer is the engine’s bytes — parsing the raw body deep-equals it', () => {
    expect(JSON.parse(PINNED_ESTIMATE_RAW_BODY)).toStrictEqual(PINNED_ESTIMATE_ANSWER);
    expect(JSON.parse(PINNED_CATEGORIES_RAW_BODY)).toStrictEqual(PINNED_CATEGORIES_ANSWER);
  });

  it('the basis is complete and agrees with the answer it describes', () => {
    expect(PINNED_VECTOR_BASIS.endpoint).toBe('POST /v1/public/calculator/estimate');
    expect(PINNED_VECTOR_BASIS.host).toMatch(/^https:\/\/\S+$/);
    for (const at of [PINNED_VECTOR_BASIS.recordedAt, PINNED_VECTOR_BASIS.categoriesRecordedAt]) {
      expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      expect(Number.isNaN(Date.parse(at))).toBe(false);
    }
    expect(PINNED_VECTOR_BASIS.engineVersion).toBe(PINNED_ESTIMATE_ANSWER.version);
    expect(PINNED_VECTOR_BASIS.profilesVersion).toBe(PINNED_ESTIMATE_ANSWER.profilesVersion);
    expect(PINNED_VECTOR_BASIS.categoryRuleVersion).toBe(
      PINNED_ESTIMATE_ANSWER.categoryRuleVersion,
    );
    // The categories were read on the same category rule the estimate used.
    expect(PINNED_CATEGORIES_ANSWER.categoryRuleVersion).toBe(
      PINNED_ESTIMATE_ANSWER.categoryRuleVersion,
    );
  });

  it('the pinned input is a legal request in the CURRENT shape — two ranges, shares, one cadence', () => {
    const { plannedPerMonth, runPerMonth, categories, shares, cadence } = PINNED_CALCULATOR_REQUEST;
    expect(Object.keys(PINNED_CALCULATOR_REQUEST).sort()).toEqual([
      'cadence',
      'categories',
      'plannedPerMonth',
      'runPerMonth',
      'shares',
    ]);
    // The schema the app's own estimate route parses with (strict: the retired
    // `itemsPerMonth` is refused by name), so the record cannot drift from the wire.
    expect(calculatorEstimateRequestSchema.safeParse(PINNED_CALCULATOR_REQUEST).success).toBe(true);
    for (const range of [plannedPerMonth, runPerMonth]) {
      expect(isWholeNonNegative(range.low)).toBe(true);
      expect(isWholeNonNegative(range.high)).toBe(true);
      expect(range.low).toBeLessThanOrEqual(range.high);
    }
    // Two DIFFERENT ranges and UNEQUAL shares, so a surface that copies one range into
    // the other, or splits the run evenly, cannot render the recorded answer.
    expect(plannedPerMonth).not.toEqual(runPerMonth);
    expect(new Set(Object.values(shares)).size).toBe(categories.length);
    expect(categories.length).toBeGreaterThanOrEqual(2);
    expect(categories.length).toBeLessThanOrEqual(3);
    expect(new Set(categories).size).toBe(categories.length);
    // The cadences the shipped catalog prices — read, not typed as a pair here.
    expect(Object.keys(BILLING_CATALOG.seatPlan.prices)).toContain(cadence);
  });

  it('the record is the recorder’s output — the commands it names sent exactly this request', () => {
    const [categoriesCommand, estimateCommand] = PINNED_VECTOR_BASIS.commands;
    expect(categoriesCommand).toBe(
      `curl -sS -X GET ${PINNED_VECTOR_BASIS.host}/v1/public/calculator/categories`,
    );
    const sent = /--data '(.*)' https:/.exec(estimateCommand ?? '')?.[1];
    expect(JSON.parse(sent ?? 'null')).toStrictEqual(PINNED_CALCULATOR_REQUEST);
    expect(estimateCommand).toContain(`${PINNED_VECTOR_BASIS.host}/v1/public/calculator/estimate`);
    // The recorder writes the file whole, and its source names this file.
    const recorder = readFileSync('scripts/record-calculator-pinned-vector.mjs', 'utf8');
    expect(recorder).toContain('tests/fixtures/calculatorPinnedVector.json');
  });

  it('the answer echoes the two ranges it priced', () => {
    expect(PINNED_ESTIMATE_ANSWER.plannedPerMonth).toStrictEqual(
      PINNED_CALCULATOR_REQUEST.plannedPerMonth,
    );
    expect(PINNED_ESTIMATE_ANSWER.runPerMonth).toStrictEqual(PINNED_CALCULATOR_REQUEST.runPerMonth);
  });

  it('the recorded answer is an ordered estimate at the request’s cadence', () => {
    expect(PINNED_ESTIMATE_ANSWER.kind).toBe('estimate');
    expect(PINNED_ESTIMATE_ANSWER.cadence).toBe(PINNED_CALCULATOR_REQUEST.cadence);
    const { low, high } = PINNED_ESTIMATE_ANSWER.credits;
    expect(isWholeNonNegative(low)).toBe(true);
    expect(isWholeNonNegative(high)).toBe(true);
    expect(low).toBeLessThanOrEqual(high);
  });

  it('no key of the recorded answer names a seat, quantity, cost, margin or time', () => {
    expect(everyKey(PINNED_ESTIMATE_ANSWER).filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
  });

  it('the categories were live when it was recorded — each is listed, and the split covers exactly them', () => {
    const listed = PINNED_CATEGORIES_ANSWER.categories.map((c) => c.key);
    for (const key of PINNED_CALCULATOR_REQUEST.categories) expect(listed).toContain(key);
    const { split } = PINNED_ESTIMATE_ANSWER;
    expect(split.categories.map((c) => c.key)).toEqual([...PINNED_CALCULATOR_REQUEST.categories]);
    expect(split.count).toBe(split.categories.length);
    // The split is the shares the request set, as fractions of the run.
    for (const c of split.categories) {
      expect(c.weight).toBeCloseTo(PINNED_CALCULATOR_REQUEST.shares[c.key]! / 100, 10);
      expect(c.models.length).toBeGreaterThan(0);
    }
  });

  it('the ceiling carries one of the three outcomes the Calculator switches on', () => {
    const { ceiling } = PINNED_ESTIMATE_ANSWER;
    expect(['within_ladder', 'larger_pool', 'top_ups_only']).toContain(ceiling.outcome);
    expect(PINNED_ESTIMATE_ANSWER.version).toBe(2);
  });
});
