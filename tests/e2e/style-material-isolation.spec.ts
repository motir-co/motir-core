// E2E: the STYLE axis's material layer is ISOLATED per scoped preview
// (MOTIR-3998 — the rendered guard the token-layer cascade model cannot supply).
//
// MOTIR-3947's ADR found that the palette/type axes are guarded by
// `tests/theme/scopedPreviewIsolation.test.ts` (via `tests/theme/paletteCascade.ts`,
// a CSS-cascade MODEL), but the style axis breaks in the SELECTOR layer, not the
// token layer — and the model deliberately skips every descendant/child combinator,
// so it is structurally incapable of seeing a material leak. A `[data-style='X']
// [data-surface='card']` descendant rule crosses a nested `data-style` boundary,
// so a scoped tile labelled "Neo-Brutalism" under an active "Glassmorphism" renders
// as glass. The @scope rewrite (MOTIR-3997) fixed the mechanism; THIS spec is the
// guard that makes a future regression visible, and it must render to see it.
//
// ⚠️ THE ORACLE IS THE STYLESHEET, never a table of expected values. For each
// tile, truth is what that tile computes when `<html>` carries ITS OWN style;
// the tile is then compared against that truth while `<html>` carries a DIFFERENT
// style. A hard-coded expectation would need re-typing every time a style is
// tuned, and the first person to skip that turns this into a test of a stale table.
// Comparing scoped-against-active also states the requirement exactly: a preview
// is correct when it looks like the thing it is previewing.
//
// ⚠️ ASSERT OVER MULTIPLE ANCESTORS. Under `warm-editorial` (the flat base) the
// matrix is 11/11 even with the defect present, because the base ships no material
// layer and has nothing to leak — a spec that only ever runs under the default
// style passes on a broken page. `glassmorphism` and `neumorphism` leak 1/11 each
// before the fix, so they are the ancestors that actually exercise the guard.

import { expect, test, type Page } from '@playwright/test';

/**
 * Every registered style, in gallery order. `name` is the accessible name of the
 * `/tokens` Style control button; `id` is the `data-style` value the tile wrapper
 * and `<html>` carry. This is STRUCTURAL metadata (the registry's identity), not
 * a table of expected material values — the material oracle is the stylesheet.
 */
const STYLES: ReadonlyArray<readonly [id: string, name: string]> = [
  ['warm-editorial', 'Warm Editorial'],
  ['soft-playful', 'Soft / Playful'],
  ['swiss-minimal-flat', 'Swiss / Minimal-Flat'],
  ['neo-brutalism', 'Neo-Brutalism'],
  ['glassmorphism', 'Glassmorphism'],
  ['cybercore-y2k', 'Cybercore / Y2K'],
  ['aurora', 'Aurora'],
  ['3d-immersive', '3D / Immersive'],
  ['neumorphism', 'Neumorphism'],
  ['hand-drawn-indie', 'Hand-Drawn / Indie'],
  ['retrofuturism', 'Retrofuturism'],
  ['dense-pro', 'Dense / Pro'],
] as const;

const NAMES: Record<string, string> = Object.fromEntries(STYLES.map(([id, name]) => [id, name]));

/**
 * The styles exercised as ANCESTORS. Two material styles that leaked 1/11 before
 * the @scope fix, plus `warm-editorial` — the flat control that passes with the
 * defect present, proving the spec's machinery (not the page) is what fails.
 */
const ANCESTORS = ['glassmorphism', 'neumorphism', 'warm-editorial'] as const;

/**
 * Drive `<html data-style>` through the page's OWN Style control (the `/tokens`
 * toggle), never by injecting the attribute — the card's requirement, so the
 * ancestry is the page's real mechanism, not a synthetic one. The authoritative
 * signal is the committed `<html data-style>` attribute, awaited before any read.
 */
async function setStyle(page: Page, id: string): Promise<void> {
  await page.getByRole('button', { name: NAMES[id], exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-style', id);
}

/**
 * The computed material FINGERPRINT of one scoped tile — a flat list of resolved
 * declarations over the surfaces the material layer can paint, plus the `::after`
 * reads `hand-drawn-indie` (the rough-ink `.border::after` / `[data-surface]::after`)
 * and `retrofuturism` (the chrome bevel / specular streak) paint with. Every entry
 * is a `<selector>.<property>:<value>` string, so two fingerprints are byte-equal
 * exactly when the tile wears the same material.
 */
async function readFingerprint(page: Page, id: string): Promise<string[]> {
  return page.evaluate((tileId) => {
    const tile = document.querySelector<HTMLElement>(`.style-vignette[data-style="${tileId}"]`);
    if (!tile) throw new Error(`no scoped tile for style "${tileId}"`);
    const parts: string[] = [];
    const surfaces = ['card', 'modal', 'sidebar', 'input'] as const;
    const props = [
      'background-color',
      'background-image',
      'backdrop-filter',
      'box-shadow',
      'border-color',
    ] as const;
    for (const surface of surfaces) {
      const el = tile.querySelector<HTMLElement>(`[data-surface="${surface}"]`);
      for (const prop of props) {
        // The modal's box-shadow also resolves the style axis's
        // `--shadow-modal` token. Keep it in the rendered fingerprint: this is
        // the cell that proves a scoped BASE style shadows a foreign ancestor's
        // shape tokens as well as its material rules.
        const value = el ? getComputedStyle(el).getPropertyValue(prop) : '<missing>';
        parts.push(`${surface}.${prop}:${value}`);
      }
      const after = el ? getComputedStyle(el, '::after').getPropertyValue('content') : '<missing>';
      parts.push(`${surface}::after:${after}`);
    }
    const canvas = tile.querySelector<HTMLElement>('.sv-canvas');
    parts.push(
      `canvas.background-image:${canvas ? getComputedStyle(canvas).getPropertyValue('background-image') : '<missing>'}`,
    );
    parts.push(
      `canvas.background-color:${canvas ? getComputedStyle(canvas).getPropertyValue('background-color') : '<missing>'}`,
    );
    return parts;
  }, id);
}

/** First index where two fingerprints differ, or -1 when equal. */
function firstDiff(a: string[], b: string[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

test.describe('the STYLE axis material layer is isolated per scoped tile', () => {
  test('every tile wears its OWN material under a foreign ancestor (matrix, not a boolean)', async ({
    page,
  }) => {
    await page.goto('/tokens');
    // The gallery is the scoped row: eleven `.style-vignette[data-style]` tiles.
    await expect(page.locator('.style-vignette[data-style]').first()).toBeVisible();
    await expect(page.locator('.style-vignette[data-style]')).toHaveCount(STYLES.length);

    // ── Truth pass: for each style X, tile X's material under <html data-style=X>.
    const truth = new Map<string, string[]>();
    for (const [id] of STYLES) {
      await setStyle(page, id);
      truth.set(id, await readFingerprint(page, id));
    }

    // ── Ancestor passes: every tile under each foreign ancestor, vs. its truth.
    const wrong: string[] = [];
    for (const ancestor of ANCESTORS) {
      await setStyle(page, ancestor);
      for (const [id] of STYLES) {
        const got = await readFingerprint(page, id);
        const want = truth.get(id);
        if (want === undefined) throw new Error(`missing truth for ${id}`);
        const diff = firstDiff(got, want);
        if (diff >= 0) {
          const own = diff < want.length ? want[diff] : '<past end>';
          wrong.push(
            `tile ${id} under ancestor ${ancestor}: ${got[diff]} (own material is ${own})`,
          );
        }
      }
    }

    // The matrix itself is the report: 3 ancestors × 11 tiles, every cell a tile
    // that must wear its own material. A cell failing names BOTH the tile and the
    // ancestor that painted it, so a future regression is diagnosable from the log.
    const matrix = ANCESTORS.map(
      (a) =>
        `${a.padEnd(15)} ${STYLES.map(([id]) => (wrong.some((w) => w.startsWith(`tile ${id} under ancestor ${a}`)) ? '✗' : '✓')).join(' ')}`,
    ).join('\n');
    expect(
      wrong,
      `material isolation failed for ${wrong.length} of ${ANCESTORS.length * STYLES.length} (ancestor × tile) cells — a tile wore its ancestor's material:\n${matrix}\n`,
    ).toEqual([]);
  });
});
