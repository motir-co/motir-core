import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { WHY_REASON_CODES } from '@/app/(admin)/admin/fleet-settings/_components/fleetReadinessCopy';

/**
 * The Fleet settings page's catalogue coverage (MOTIR-8715).
 *
 * Three things, each derived from its source of truth rather than listed here:
 *
 *  1. Every `platformAdmin.fleetSettings.*` string the DESIGN fixes
 *     (`design/platform-admin/design-notes.md` § AMENDMENT 2026-10 — Fleet
 *     settings, its Copy table) is in `en.json`, verbatim, and in `zh.json`.
 *  2. Every key under `platformAdmin.fleetSettings` in en has a zh twin (and
 *     the reverse), so the page never renders a raw key path in Chinese.
 *  3. Every `reasonCode` the readiness service can emit for a condition that is
 *     NOT met has a sentence (`why.<code>`) in en and zh, and the island's own
 *     list of codes it renders matches the service exactly. Met codes render no
 *     sentence (design: "A met row shows only its mark and label").
 */

type Tree = Record<string, unknown>;

function flatten(obj: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [kk, vv] of flatten(v as Tree, path)) out.set(kk, vv);
    } else if (typeof v === 'string') out.set(path, v);
  }
  return out;
}

const enFlat = flatten(en as Tree);
const zhFlat = flatten(zh as Tree);
const NS = 'platformAdmin.fleetSettings.';

/** The design's Copy table: `| \`key\` | string |` rows of the fleet amendment. */
function designCopy(): Map<string, string> {
  const notes = readFileSync('design/platform-admin/design-notes.md', 'utf8');
  const start = notes.indexOf('# AMENDMENT 2026-10 — Fleet settings');
  expect(start, 'the fleet settings amendment is in the design notes').toBeGreaterThan(-1);
  const section = notes.slice(start);
  const copy = new Map<string, string>();
  for (const line of section.split('\n')) {
    // A later amendment retires a key with a `Removed: \`key\`, …` line; the
    // table rows above it are a record of what shipped then, not copy today.
    if (/^Removed:/.test(line)) {
      for (const [, key] of line.matchAll(/`((?:shell|fleetSettings)\.[A-Za-z0-9_.]+)`/g)) {
        copy.delete(`platformAdmin.${key}`);
      }
      continue;
    }
    const m = /^\|\s*`((?:shell|fleetSettings)\.[A-Za-z0-9_.]+)`\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    // Markdown only: the table's code spans and escaped pipes are not copy.
    copy.set(`platformAdmin.${m[1]}`, m[2]!.replace(/\\\|/g, '|').replace(/`/g, ''));
  }
  return copy;
}

describe('Fleet settings catalogue', () => {
  it('carries every string the design fixes, verbatim in en and present in zh', () => {
    const copy = designCopy();
    expect(copy.size, 'the design Copy table parsed').toBeGreaterThan(90);
    const wrong: string[] = [];
    const missingZh: string[] = [];
    for (const [key, text] of copy) {
      if (enFlat.get(key) !== text) wrong.push(`${key}: en=${JSON.stringify(enFlat.get(key))}`);
      if (!zhFlat.get(key)) missingZh.push(key);
    }
    expect(wrong).toEqual([]);
    expect(missingZh).toEqual([]);
  });

  it('has a zh string for every en key under platformAdmin.fleetSettings, and no orphan', () => {
    const enKeys = [...enFlat.keys()].filter((k) => k.startsWith(NS)).sort();
    const zhKeys = [...zhFlat.keys()].filter((k) => k.startsWith(NS)).sort();
    expect(enKeys.length).toBeGreaterThan(0);
    expect(zhKeys).toEqual(enKeys);
    expect(zhFlat.get('platformAdmin.shell.navFleetSettings')).toBeTruthy();
    expect(enFlat.get('platformAdmin.shell.navFleetSettings')).toBe('Fleet settings');
  });

  it('has an en and zh sentence for every reasonCode the readiness service emits when not met', () => {
    const source = readFileSync('lib/services/fleetReadinessService.ts', 'utf8').replace(
      /\s+/g,
      ' ',
    );
    const emitted = new Map<string, Set<string>>();
    const call = /condition\( ?[\w']+, ?'(met|unmet|unknown)', ?([^,]+),/g;
    for (const m of source.matchAll(call)) {
      for (const lit of m[2]!.matchAll(/'([a-z_]+)'/g)) {
        const set = emitted.get(lit[1]!) ?? new Set<string>();
        set.add(m[1]!);
        emitted.set(lit[1]!, set);
      }
    }
    // The derivation is not vacuous: nine conditions, at least one code each.
    expect(emitted.size).toBeGreaterThanOrEqual(20);
    const notMet = [...emitted].filter(
      ([, states]) => states.has('unmet') || states.has('unknown'),
    );
    const metOnly = [...emitted].filter(([, states]) => states.size === 1 && states.has('met'));
    expect(metOnly.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const [code] of notMet) {
      for (const [locale, flat] of [
        ['en', enFlat],
        ['zh', zhFlat],
      ] as const) {
        if (!flat.get(`${NS}why.${code}`)) missing.push(`${locale}: why.${code}`);
      }
    }
    // `read_failed` splits on its HTTP status: a number, null, or absent.
    for (const extra of ['read_unreachable', 'read_failedNoStatus']) {
      if (!enFlat.get(`${NS}why.${extra}`) || !zhFlat.get(`${NS}why.${extra}`)) {
        missing.push(`why.${extra}`);
      }
    }
    expect(missing).toEqual([]);

    // The island renders exactly these codes from the catalogue; anything else
    // falls back to the service's English message.
    expect([...WHY_REASON_CODES].sort()).toEqual(notMet.map(([code]) => code).sort());
  });

  it('labels all nine conditions in en and zh', () => {
    const keys = [
      'kill_switch',
      'app_installed',
      'app_runner_permission',
      'app_variables_permission',
      'workflow_job_subscription',
      'app_repositories',
      'delivery_attributable',
      'runner_group',
      'image_coverage',
    ];
    for (const key of keys) {
      expect(enFlat.get(`${NS}cond.${key}.label`), key).toBeTruthy();
      expect(zhFlat.get(`${NS}cond.${key}.label`), key).toBeTruthy();
    }
  });
});
