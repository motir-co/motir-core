import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

/**
 * The capacity screen's catalogue coverage (MOTIR-9614).
 *
 *  1. Every key under `platformAdmin.capacity` in en has a zh twin, and the
 *     reverse, so the page never renders a raw key path in Chinese.
 *  2. Every literal key the screen's components and page pass to `t(…)` resolves
 *     in en — a typo is a raw key on screen, which the type-check does not catch
 *     for a template key.
 */

type Tree = Record<string, unknown>;

function flatten(obj: Tree, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' ? flatten(v as Tree, path) : [path];
  });
}

const enKeys = new Set(flatten((en as Tree).platformAdmin as Tree));
const zhKeys = new Set(flatten((zh as Tree).platformAdmin as Tree));
const capacity = (keys: Set<string>) => [...keys].filter((k) => k.startsWith('capacity.')).sort();

const DIR = join(__dirname, '..', '..', 'app', '(admin)', 'admin', 'capacity');
const sources = [
  readFileSync(join(DIR, 'page.tsx'), 'utf8'),
  ...readdirSync(join(DIR, '_components')).map((f) =>
    readFileSync(join(DIR, '_components', f), 'utf8'),
  ),
].join('\n');

describe('platformAdmin.capacity', () => {
  it('has the same keys in en and zh', () => {
    expect(capacity(zhKeys)).toEqual(capacity(enKeys));
    expect(capacity(enKeys).length).toBeGreaterThan(80);
  });

  it('has the rail label in both', () => {
    expect(enKeys.has('shell.navCapacity')).toBe(true);
    expect(zhKeys.has('shell.navCapacity')).toBe(true);
  });

  it('resolves every literal key the screen asks for', () => {
    const literal = [...sources.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]!);
    expect(literal.length).toBeGreaterThan(40);
    const missing = literal.filter((k) => !enKeys.has(`capacity.${k}`));
    expect(missing).toEqual([]);
  });
});
