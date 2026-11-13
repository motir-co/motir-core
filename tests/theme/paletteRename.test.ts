import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASE_PALETTE_ID,
  DEFAULT_PALETTE_ID,
  DEFAULT_PROJECT_PALETTE_ID,
  PALETTE_IDS,
  PALETTE_REGISTRY,
  isPaletteId,
} from '@/lib/theme/palettes';
import {
  PALETTE_ID_MIGRATION,
  PALETTE_IDS_VERSION,
  THEME_STORAGE_KEYS,
  migrateStoredPaletteId,
} from '@/lib/theme/types';
import { buildThemeInitScript } from '@/lib/theme/init-script';
import type { AppliedAppearanceDto } from '@/lib/dto/appearancePreference';
import { declaredIn, loadTokenLayer, resolveValue, type ThemeContext } from './paletteCascade';

// MOTIR-6471 — the monochrome palette ("Graphite") becomes `motir`, the default,
// and the warm palette that was `motir` becomes `amethyst`. The two ids swap
// meaning, so the rename is only safe if (1) no colour moves, and (2) every id
// a person STORED before the rename is read through the swap exactly once.

describe('the renamed registry', () => {
  it('lists Motir first and Amethyst second, and no palette is called Graphite', () => {
    expect(PALETTE_IDS).toEqual([
      'motir',
      'amethyst',
      'cobalt',
      'evergreen',
      'spectrum',
      'amber',
      'sienna',
      'garnet',
      'citrine',
      'candy',
      'lagoon',
      'olive',
      'contrast',
      'midnight',
    ]);
    expect(PALETTE_REGISTRY.motir.name).toBe('Motir');
    expect(PALETTE_REGISTRY.motir.tagline).toMatch(/^Stark and editorial/);
    expect(PALETTE_REGISTRY.amethyst.name).toBe('Amethyst');
    expect(isPaletteId('graphite')).toBe(false);
    expect(Object.values(PALETTE_REGISTRY).map((p) => p.name)).not.toContain('Graphite');
  });

  it('keeps the default id `motir` (now monochrome), and the project default warm', () => {
    expect(DEFAULT_PALETTE_ID).toBe('motir');
    expect(DEFAULT_PROJECT_PALETTE_ID).toBe('amethyst');
    expect(BASE_PALETTE_ID).toBe('amethyst');
  });
});

describe('no colour moves — resolved --el-* tokens against the pre-rename sheet', () => {
  // The fixture is every `--el-*` token RESOLVED on `origin/main` at 7717433af,
  // the base this card branched from — `graphite` recorded under `motir`, and
  // `motir` under `amethyst`. The resolver is the same one every palette suite
  // uses. A LATER, deliberate retune of either palette changes these values on
  // purpose: regenerate the fixture in that change rather than loosening this.
  // Regenerated once so far: MOTIR-7584 (the motir warm touches, design MOTIR-7583
  // §8), which moved motir's warm roles and added `--el-progress-fill` /
  // `--el-editor-focus` to every palette at the value their consumers painted.
  // And once more, additively: the `--el-showcase-*` family (motir.co's
  // illustration fields) was merged in at its resolved values — new tokens only,
  // no existing value moved.
  // And again for the `--el-live-*` family (motir.co's live header link), the
  // same way: new tokens only.
  // And for the `--el-cta-warm` pair (the onboarding screens' warm primary
  // button, MOTIR-8254), the same way: new tokens only.
  // And for the `--el-drafting` pair (the drafted card's at-work cue, MOTIR-8416),
  // the same way: new tokens only.
  // And for the `--el-chart-workload-*` pair (the Workload report's Assigned /
  // Unassigned segment hues, MOTIR-8919), the same way: new tokens only.
  // And for the `--el-mark-wave-*` family (the Motir mark's at-work flow,
  // MOTIR-9213), the same way: new tokens only.
  // And for `--el-notif-agent-hibernated` (the agent-hibernated-by-an-admin
  // notification hue, MOTIR-10368), the same way: new tokens only.
  // And for the `--el-notif-review-*` pair (the review-path notification hues,
  // MOTIR-10327), the same way: new tokens only.
  // And for the `--el-code-selection-*` pair (the agent terminal's text
  // selection, MOTIR-10856), the same way: new tokens only.
  // And for `--el-changed` (the planning canvas's changed-card highlight,
  // MOTIR-11185), the same way: new tokens only.
  const before = JSON.parse(
    readFileSync(join(process.cwd(), 'tests/fixtures/paletteRename6471.before.json'), 'utf8'),
  ) as Record<string, Record<string, string>>;
  const { rules, elementTokens } = loadTokenLayer();

  for (const key of Object.keys(before)) {
    it(`${key} resolves exactly as its pre-rename palette did`, () => {
      const [palette, theme] = key.split('/') as [string, ThemeContext['theme']];
      const declarations = declaredIn(rules, { palette, theme });
      const now: Record<string, string> = {};
      for (const token of elementTokens) {
        now[token] = resolveValue(declarations[token] ?? '', declarations).value.toLowerCase();
      }
      expect(now).toEqual(before[key]);
    });
  }

  it('leaves no `graphite` selector in the sheet', () => {
    const css = readFileSync(join(process.cwd(), 'packages/design-system/theme.css'), 'utf8');
    expect(css).not.toContain("data-palette='graphite'");
    expect(css).toContain("[data-palette='motir'] {");
    expect(css).toContain("[data-appearance-scope][data-palette='amethyst'] {");
  });
});

describe('migrateStoredPaletteId', () => {
  it('maps a pre-rename value through the swap when no marker is stored', () => {
    expect(migrateStoredPaletteId('motir', null)).toBe('amethyst');
    expect(migrateStoredPaletteId('graphite', null)).toBe('motir');
    expect(migrateStoredPaletteId('cobalt', null)).toBe('cobalt');
    expect(migrateStoredPaletteId(null, null)).toBeNull();
    // An own-property lookup: an inherited name is not a mapping.
    expect(migrateStoredPaletteId('constructor', null)).toBe('constructor');
  });

  it('leaves a value alone once the marker says it is current — the swap runs once', () => {
    expect(migrateStoredPaletteId('motir', PALETTE_IDS_VERSION)).toBe('motir');
    expect(migrateStoredPaletteId('amethyst', PALETTE_IDS_VERSION)).toBe('amethyst');
  });

  it('maps ONLY onto registered ids', () => {
    for (const target of Object.values(PALETTE_ID_MIGRATION))
      expect(isPaletteId(target)).toBe(true);
  });
});

// ── The init script, executed ────────────────────────────────────────────────
// The script is the one place a signed-out browser's stored id is read before
// paint, so it is RUN here against a fake `window` / `document`, not grepped.

interface Run {
  palette: string | null;
  store: Map<string, string>;
}

function runInitScript(
  stored: Record<string, string>,
  serverPref: AppliedAppearanceDto | null,
): Run {
  const store = new Map(Object.entries(stored));
  const attributes = new Map<string, string>();
  const window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
    matchMedia: () => ({ matches: false }),
  };
  const document = {
    documentElement: { setAttribute: (k: string, v: string) => void attributes.set(k, v) },
  };
  new Function('window', 'document', buildThemeInitScript(serverPref))(window, document);
  return { palette: attributes.get('data-palette') ?? null, store };
}

const P = THEME_STORAGE_KEYS.palette;
const V = THEME_STORAGE_KEYS.paletteIds;

describe('the init script migrates a signed-out browser once', () => {
  it('a stored `motir` with no marker was the warm palette — it becomes amethyst', () => {
    const run = runInitScript({ [P]: 'motir' }, null);
    expect(run.palette).toBe('amethyst');
    expect(run.store.get(P)).toBe('amethyst');
    expect(run.store.get(V)).toBe(PALETTE_IDS_VERSION);
  });

  it('a stored `graphite` with no marker becomes motir', () => {
    const run = runInitScript({ [P]: 'graphite' }, null);
    expect(run.palette).toBe('motir');
    expect(run.store.get(V)).toBe(PALETTE_IDS_VERSION);
  });

  it('a stored `motir` WITH the marker is already current and stays motir', () => {
    const run = runInitScript({ [P]: 'motir', [V]: PALETTE_IDS_VERSION }, null);
    expect(run.palette).toBe('motir');
    expect(run.store.get(P)).toBe('motir');
  });

  it('nothing stored renders the default and sets the marker', () => {
    const run = runInitScript({}, null);
    expect(run.palette).toBe('motir');
    expect(run.store.has(P)).toBe(false);
    expect(run.store.get(V)).toBe(PALETTE_IDS_VERSION);
  });

  it('a second load after migrating does not migrate again', () => {
    const first = runInitScript({ [P]: 'motir' }, null);
    const second = runInitScript(Object.fromEntries(first.store), null);
    expect(second.palette).toBe('amethyst');
  });

  it('signed in, the server id wins and the marker is written beside it', () => {
    const run = runInitScript(
      { [P]: 'graphite' },
      {
        pattern: 'light',
        styleId: 'warm-editorial',
        paletteId: 'motir',
        typeId: 'motir',
        typePinned: false,
      },
    );
    expect(run.palette).toBe('motir');
    expect(run.store.get(P)).toBe('motir');
    expect(run.store.get(V)).toBe(PALETTE_IDS_VERSION);
  });
});
