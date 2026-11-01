import { describe, expect, it } from 'vitest';
import { dragShare, evenShares, maxShare } from '@/lib/billing/calculatorShares';

// The Calculator's share rule (MOTIR-9832): even to start, a drag taken from the others
// in equal whole parts, never below 1%, always totalling 100.

const total = (shares: number[]) => shares.reduce((a, b) => a + b, 0);

describe('evenShares', () => {
  it.each([
    [0, []],
    [1, [100]],
    [2, [50, 50]],
    [3, [34, 33, 33]],
  ])('splits %i categories evenly, the remainder on the first', (count, even) => {
    expect(evenShares(count)).toEqual(even);
  });
});

describe('maxShare', () => {
  it('leaves 1% to each other category', () => {
    expect(maxShare(2)).toBe(99);
    expect(maxShare(3)).toBe(98);
  });
});

describe('dragShare', () => {
  it('with two, the other is 100 minus the dragged one', () => {
    expect(dragShare([50, 50], 0, 70)).toEqual([70, 30]);
    expect(dragShare([70, 30], 1, 45)).toEqual([55, 45]);
  });

  it('takes the difference from the others equally; an odd part from the first', () => {
    expect(dragShare([34, 33, 33], 1, 52)).toEqual([24, 52, 24]);
    expect(dragShare([34, 33, 33], 2, 35)).toEqual([33, 32, 35]);
  });

  it('gives the difference back equally when a share is dragged down', () => {
    expect(dragShare([24, 52, 24], 1, 30)).toEqual([35, 30, 35]);
    expect(dragShare([34, 33, 33], 0, 33)).toEqual([33, 34, 33]);
  });

  it('never takes a share below 1%: the rest comes from the others', () => {
    expect(dragShare([30, 69, 1], 1, 79)).toEqual([20, 79, 1]);
    expect(dragShare([2, 50, 48], 1, 60)).toEqual([1, 60, 39]);
  });

  it('clamps the dragged share to what the others can give', () => {
    expect(dragShare([34, 33, 33], 0, 100)).toEqual([98, 1, 1]);
    expect(dragShare([50, 50], 1, 0)).toEqual([99, 1]);
  });

  it('rounds a fractional drag to a whole percentage', () => {
    expect(dragShare([50, 50], 0, 60.6)).toEqual([61, 39]);
  });

  it('totals 100 after any drag', () => {
    let shares = [34, 33, 33];
    for (const [i, to] of [
      [0, 90],
      [2, 40],
      [1, 1],
      [0, 7],
      [2, 98],
      [1, 50],
    ] as const) {
      shares = dragShare(shares, i, to);
      expect(total(shares)).toBe(100);
      expect(Math.min(...shares)).toBeGreaterThanOrEqual(1);
      expect(shares[i]).toBe(Math.min(Math.max(to, 1), 98));
    }
  });

  it('leaves the shares as they are for one category or an unknown index', () => {
    expect(dragShare([100], 0, 40)).toEqual([100]);
    expect(dragShare([50, 50], 5, 40)).toEqual([50, 50]);
  });
});
