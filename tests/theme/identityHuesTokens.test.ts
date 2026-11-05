import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapeRegExp } from '@/lib/utils/regexp';

// MOTIR-1274 · 1266.3 — the new IDENTITY-hue element tokens (roles / org-roles /
// privacy / labels / avatars) plus the decoupled --el-notif-* / --el-model-*
// families. The COMPREHENSIVE per-palette coverage / swap-layer matrix is owned
// by 1266.7; this suite pins THIS card's contract: the tokens exist in the
// Tier-3 base block mapped to the right Tier-0 --color-* (so every palette
// re-skins them via its --color-* override), and the three --el-type-* MISUSES
// (NotificationRow, the retired ProjectAvatar mono tile, OrgUsageClient
// deepseek) are gone.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
// The design-system token layer moved into `@motir/design-system/theme.css`
// (MOTIR-1527); app/globals.css now only `@import`s it + keeps app base styles.
// Read the UNION so these runtime-contract assertions see the full token layer.
const GLOBALS_CSS = read('app/globals.css') + read('packages/design-system/theme.css');

// The Tier-3 base block (the only place a new --el-* is defined; palettes
// override the underlying --color-*, not the --el-*). It's a flat declaration
// block, so it runs from its selector's `{` to the first `}`.
const BASE_BLOCK = (() => {
  const m = GLOBALS_CSS.match(/:root,\s*\[data-appearance-scope\]\s*\{/);
  expect(m?.index).toBeGreaterThanOrEqual(0);
  const open = m!.index! + m![0].length;
  const close = GLOBALS_CSS.indexOf('}', open);
  expect(close).toBeGreaterThan(open);
  return GLOBALS_CSS.slice(open, close);
})();

function mappingOf(token: string): string | null {
  const m = BASE_BLOCK.match(new RegExp(`${escapeRegExp(token)}:\\s*var\\((--color-[a-z-]+)\\)`));
  return m?.[1] ?? null;
}

describe('identity-hue element tokens map to their Tier-0 --color-* base', () => {
  // Every token defaults to today's exact tint → zero visual change; mapping to
  // a --color-* is what makes a palette swap reach it (the swap-layer contract).
  const EXPECTED: Record<string, string> = {
    // Roles / org-roles / privacy
    '--el-role-admin': '--color-tint-lavender',
    '--el-role-member': '--color-tint-sky',
    '--el-role-viewer': '--color-tint-mint',
    '--el-org-role-owner': '--color-tint-lavender',
    '--el-org-role-admin': '--color-tint-sky',
    '--el-org-role-member': '--color-tint-mint',
    '--el-privacy-private': '--color-tint-lavender',
    '--el-privacy-public': '--color-tint-sky',
    // Label ramp (peach,rose,mint,lavender,sky,yellow in order)
    '--el-label-1': '--color-tint-peach',
    '--el-label-2': '--color-tint-rose',
    '--el-label-3': '--color-tint-mint',
    '--el-label-4': '--color-tint-lavender',
    '--el-label-5': '--color-tint-sky',
    '--el-label-6': '--color-tint-yellow',
    // Avatar ramp (named keys kept — DB contract) + fallback
    '--el-avatar-peach': '--color-tint-peach',
    '--el-avatar-rose': '--color-tint-rose',
    '--el-avatar-mint': '--color-tint-mint',
    '--el-avatar-lavender': '--color-tint-lavender',
    '--el-avatar-sky': '--color-tint-sky',
    '--el-avatar-yellow': '--color-tint-yellow',
    '--el-avatar-fallback': '--color-info',
    // Notification badges (decoupled from --el-type-*; same hues)
    '--el-notif-mentioned': '--color-primary-fill',
    '--el-notif-commented': '--color-info',
    '--el-notif-assigned': '--color-accent-green',
    '--el-notif-transitioned': '--color-accent-teal',
    // An org admin hibernated your agent (MOTIR-10368, the Fleet delta's token)
    '--el-notif-agent-hibernated': '--color-info',
    // AI model dots (named family; deepseek decoupled from --el-type-subtask)
    '--el-model-opus': '--color-primary-fill',
    '--el-model-sonnet': '--color-info',
    '--el-model-haiku': '--color-success',
    '--el-model-deepseek': '--color-accent-teal',
  };

  it('defines every identity-hue token mapped to its Tier-0 --color-* base', () => {
    for (const [token, base] of Object.entries(EXPECTED)) {
      expect(mappingOf(token), token).toBe(base);
    }
  });

  it('preserves the decoupled hues exactly (zero visual change vs the borrowed --el-type-*)', () => {
    // commented/assigned/transitioned kept --el-type-task/story/subtask's bases…
    expect(mappingOf('--el-notif-commented')).toBe(mappingOf('--el-type-task'));
    expect(mappingOf('--el-notif-assigned')).toBe(mappingOf('--el-type-story'));
    expect(mappingOf('--el-notif-transitioned')).toBe(mappingOf('--el-type-subtask'));
    // …and deepseek kept the subtask teal it used to borrow.
    expect(mappingOf('--el-model-deepseek')).toBe(mappingOf('--el-type-subtask'));
    // The mono avatar fallback kept the blue it borrowed from --el-type-task.
    expect(mappingOf('--el-avatar-fallback')).toBe(mappingOf('--el-type-task'));
  });
});

describe('the --el-type-* misuse is decoupled in every consumer', () => {
  it('NotificationRow event badges use --el-notif-*, never --el-type-*', () => {
    const src = read('app/(authed)/_components/NotificationRow.tsx');
    const meta = src.slice(src.indexOf('const TYPE_META'), src.indexOf('const DEFAULT_META'));
    expect(meta).not.toMatch(/--el-type-/);
    for (const t of ['mentioned', 'commented', 'assigned', 'transitioned']) {
      expect(meta).toContain(`bg-(--el-notif-${t})`);
    }
  });

  // ⚠️ RETIRED with its subject (MOTIR-2679). `ProjectAvatar` rendered the
  // preset icon-and-colour chip and its mono fallback; a project's mark is an
  // uploaded logo now (`docs/decisions/entity-marks.md`), so there is no chip
  // left to bind to a hue. The `--el-avatar-*` ramp is NOT orphaned by that —
  // its consumers are `TriageAvatar` (asserted directly below) and the
  // `--el-avatar-fallback` initial tiles in `gitSettingsPrimitives` and
  // `CodeAccessSettings`, which the coverage test binds. Deleting the assertion
  // rather than re-pointing it is correct here: the thing it asserted about no
  // longer exists.

  it('TriageAvatar hashes onto the shared --el-avatar-* ramp, never --el-tint-*', () => {
    const src = read('app/(authed)/triage/_components/TriageAvatar.tsx');
    expect(src).toContain('bg-(--el-avatar-mint)');
    expect(src).not.toMatch(/bg-\(--el-tint-/);
  });

  // ⚠️ RETIRED with its subject (MOTIR-7229). The org usage page drew a dot per
  // model in its per-model panel and run log; no model id reaches an
  // organization any more, so there is no dot left to bind. The `--el-model-*`
  // tokens stay defined (and on the `/tokens` specimen) — the mapping test above
  // still pins them, and a later surface that names a model reaches for them.

  it('label + role chips route through the dedicated families', () => {
    const picker = read('packages/design-system/src/components/ui/MultiSelectPicker.tsx');
    for (const n of [1, 2, 3, 4, 5, 6]) expect(picker).toContain(`bg-(--el-label-${n})`);
    expect(picker).not.toMatch(/bg-\(--el-tint-/);

    const pill = read('packages/design-system/src/components/ui/Pill.tsx');
    for (const r of ['admin', 'member', 'viewer']) expect(pill).toContain(`bg-(--el-role-${r})`);
    for (const r of ['owner', 'admin', 'member']) expect(pill).toContain(`bg-(--el-org-role-${r})`);
    expect(pill).toContain('bg-(--el-privacy-private)');
  });
});

describe('the label ramp order matches lib/labels/labelTint.ts', () => {
  it('LABEL_TINTS order is the --el-label-1..6 order (so hash → token is stable)', () => {
    const src = read('lib/labels/labelTint.ts');
    const m = src.match(/LABEL_TINTS\s*=\s*\[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const order = (m?.[1] ?? '')
      .split(',')
      .map((s) => s.replace(/['"\s]/g, ''))
      .filter(Boolean);
    expect(order).toEqual(['peach', 'rose', 'mint', 'lavender', 'sky', 'yellow']);
    // …and globals.css maps --el-label-1..6 onto those tints in that order.
    const TINT_BASE = ['peach', 'rose', 'mint', 'lavender', 'sky', 'yellow'];
    order.forEach((tint, i) => {
      expect(mappingOf(`--el-label-${i + 1}`)).toBe(`--color-tint-${TINT_BASE[i]}`);
    });
  });
});
