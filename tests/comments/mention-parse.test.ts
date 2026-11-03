import { describe, expect, it } from 'vitest';
import { parseMentionIds } from '@/lib/mentions/parse';

// Unit tests for the pure mention-token parser (Story 5.1 · Subtask 5.1.2) —
// `[@Display Name](mention:<userId>)` extraction, dedup, and the
// malformed-near-token cases (body text, never an error).

describe('parseMentionIds', () => {
  it('is LINEAR on a body of unclosed openers — the MOTIR-4202 reproduction', () => {
    // `[^\]]*` scanned to the end of the string from every `[@` and made this
    // quadratic: 5.2 s at 80k characters. The bound is generous (a CI runner is
    // ~20× slower than a dev box) and still an order of magnitude under the
    // defect, so it cannot pass by accident.
    const body = '[@'.repeat(80_000);
    const started = Date.now();
    expect(parseMentionIds(body)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('a token inside code is not a mention (MOTIR-10233): fenced, inline or longer-fenced', () => {
    expect(parseMentionIds('```text\n[@Ana](mention:u1)\n```')).toEqual([]);
    expect(parseMentionIds('see `[@Ana](mention:u1)` there')).toEqual([]);
    expect(parseMentionIds('`````text\n```` [@Ana](mention:u1)\n`````')).toEqual([]);
    expect(parseMentionIds('```\n[@Ana](mention:u1)\n```\n\nand [@Bo](mention:u2)')).toEqual([
      'u2',
    ]);
    expect(parseMentionIds('> quoted [@Ana](mention:u1)')).toEqual(['u1']);
  });

  it('stays fast on unclosed openers around a real token', () => {
    const body = `${'[@'.repeat(80_000)}[@Real](mention:id-real)`;
    const started = Date.now();
    expect(parseMentionIds(body)).toEqual(['id-real']);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('still matches a token that follows unclosed openers, and never a name holding `[`', () => {
    expect(parseMentionIds('[@[@[@Real](mention:id-real)')).toEqual(['id-real']);
    expect(parseMentionIds('[@a[b](mention:id-x)')).toEqual([]);
  });

  it('extracts the user id from a single token', () => {
    expect(parseMentionIds('Hi [@Bo Philips](mention:user_abc123)!')).toEqual(['user_abc123']);
  });

  it('extracts multiple ids in first-seen order', () => {
    const body = '[@A](mention:id-a) then [@B](mention:id-b) and [@C](mention:id-c)';
    expect(parseMentionIds(body)).toEqual(['id-a', 'id-b', 'id-c']);
  });

  it('dedups a repeated mention to one id', () => {
    const body = '[@A](mention:id-a) again [@A different label](mention:id-a) [@B](mention:id-b)';
    expect(parseMentionIds(body)).toEqual(['id-a', 'id-b']);
  });

  it('handles display names with spaces, dots, and an empty label', () => {
    expect(parseMentionIds('[@Zhu Yue Jr.](mention:cuid1) [@](mention:cuid2)')).toEqual([
      'cuid1',
      'cuid2',
    ]);
  });

  it('ignores malformed near-tokens', () => {
    const body = [
      'plain @name',
      '[@no-scheme](user_x)',
      '[@unclosed(mention:user_y)',
      '[link](mention:)', // no id
      '[@spaced](mention: user_z)', // space breaks the id charset
    ].join(' ');
    expect(parseMentionIds(body)).toEqual([]);
  });

  it('returns [] for an empty body', () => {
    expect(parseMentionIds('')).toEqual([]);
  });
});
