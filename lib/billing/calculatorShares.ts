import { CALCULATOR_REQUEST_LIMITS } from '@/lib/dto/billing';

// The Calculator's category shares (MOTIR-9832, design/billing § "Amendment 2026-10-27 —
// each category's share of the run"): each picked category carries a whole percentage
// of the run, and the shares always total 100. Pure, so the view and its tests share
// one rule.

const TOTAL = CALCULATOR_REQUEST_LIMITS.sharesTotal;

/** The lowest share a picked category can carry: it is picked, so it carries some. */
export const MIN_SHARE = 1;

/** The even split over `count` categories, the remainder on the first: 50/50, 34/33/33. */
export function evenShares(count: number): number[] {
  if (count <= 0) return [];
  const part = Math.floor(TOTAL / count);
  const rest = TOTAL - part * count;
  return Array.from({ length: count }, (_, i) => part + (i < rest ? 1 : 0));
}

/** The highest share one of `count` categories can carry, leaving the floor to the rest. */
export function maxShare(count: number): number {
  return TOTAL - (count - 1) * MIN_SHARE;
}

/**
 * Move share `index` to `to` and take the difference from the others in equal whole
 * parts. A part that does not divide goes to the others in order, first first; no
 * share goes below `MIN_SHARE`, and what a share at the floor cannot give is taken
 * from the rest. `to` is clamped to what the others can give, so the result always
 * totals 100.
 */
export function dragShare(shares: readonly number[], index: number, to: number): number[] {
  const next = [...shares];
  if (index < 0 || index >= next.length || next.length < 2) return next;
  const target = Math.min(Math.max(Math.round(to), MIN_SHARE), maxShare(next.length));
  // > 0: the others give; < 0: the others take.
  let left = target - next[index]!;
  next[index] = target;
  while (left !== 0) {
    const others = next
      .map((_, j) => j)
      .filter((j) => j !== index && (left < 0 || next[j]! > MIN_SHARE));
    if (others.length === 0) break;
    const part = Math.trunc(left / others.length);
    let rest = left - part * others.length;
    for (const j of others) {
      let step = part;
      if (rest !== 0) {
        step += Math.sign(rest);
        rest -= Math.sign(rest);
      }
      if (left > 0) step = Math.min(step, next[j]! - MIN_SHARE);
      next[j] = next[j]! - step;
      left -= step;
    }
  }
  return next;
}
