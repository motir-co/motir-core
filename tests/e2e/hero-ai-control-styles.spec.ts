// E2E: the hero AI control takes EVERY registered style's material
// (MOTIR-4743 — the rendered half of `tests/theme/aiCtaStyleSeam.test.ts`).
//
// ── The defect ──────────────────────────────────────────────────────────────
// The "Plan with AI" pill and the floating M orb rendered byte-identically under
// all eleven styles: the hook `design/ai-chat/design-notes.md` prescribes
// (`[data-surface='ai-cta']`) was emitted by no element, and the FILL was painted
// in an inline `style` prop, which beats every stylesheet rule. Only the RADIUS
// moved, because that flows through `--radius-badge`. So a user who picked Swiss
// or Neo-Brutalism — explicitly asking for a flat, sharp surface — got a glowing
// violet gradient in the most prominent slot in the chrome.
//
// ── Why this spec has to RENDER ─────────────────────────────────────────────
// Exactly the argument `style-material-isolation.spec.ts` and
// `shell-immersive-atmosphere.spec.ts` make. The properties under test are
// `var()`-bearing fills declared inside `@scope` blocks, and no DOM
// implementation available to the unit lane resolves either — a `var()` colour
// reads back as `rgba(0, 0, 0, 0)` and `@scope` is not implemented at all — so a
// computed-style assertion there is green on the broken source AND on the fixed
// one. The unit guard asserts the WIRING (the hook, the seam, the derived style
// set, the closure rule); this asserts what a user sees.
//
// ── THE ORACLE IS THE BASE STYLE, never a table of expected values ───────────
// Truth is what the SAME control computes under `warm-editorial` — the Tier-0
// base, whose treatment is the components' own `var()` fallbacks — read in the
// same page session. A hard-coded expectation would need re-typing every time a
// treatment is tuned, and the first person to skip that turns this into a test of
// a stale table. (Same discipline as the two specs above.)
//
// ── AND THE SET UNDER TEST IS DERIVED, not listed ───────────────────────────
// Every registered style must differ from the base EXCEPT the two the design
// exempts on the record: `warm-editorial` (it IS the base) and `3d-immersive`
// (row 8 — its identity is the depth `--plan-hero-shadow` / `--plan-orb-shadow`
// already give it, and a fill rule would take a `data-depth="key"` control off
// the plane ladder it is declared on). A twelfth style added with no hero
// treatment fails here as well as in the unit lane.
//
// ── The SURFACE, and why it is `/tokens` ────────────────────────────────────
// Both controls are gated on `isMotirAiConfigured()` in the signed-in shell, and
// this lane deliberately runs with `MOTIR_AI_URL` unset (playwright.config.ts
// says why — four specs assert the OFF state), so no authed route renders them
// here. `/tokens` is the design-system specimen route, it is public, and it
// already carries the Style control every style spec drives. The section mounts
// the REAL shipped components rather than a stand-in, so this measures the app.

import { expect, test, type Page } from '@playwright/test';

/**
 * Every registered style, in gallery order — `id` is the `data-style` value,
 * `name` the accessible name of the `/tokens` Style control button. STRUCTURAL
 * metadata (the registry's identity), never a table of expected material values.
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

const BASE_STYLE = 'warm-editorial';
/** Row 8 — as base for FILL and TYPE, its own for DEPTH. See the header. */
const DEPTH_ONLY_STYLE = '3d-immersive';

/** The six properties the card measures, plus the two the fill travels on. */
interface Material {
  backgroundImage: string;
  backgroundColor: string;
  border: string;
  boxShadow: string;
  fontFamily: string;
  fontWeight: string;
  textTransform: string;
}

/** One control's resolved material, read from the browser's own cascade. */
async function readMaterial(page: Page, cta: 'pill' | 'orb'): Promise<Material> {
  return page.evaluate((which) => {
    const el = document.querySelector<HTMLElement>(`[data-ai-cta="${which}"]`);
    if (!el) throw new Error(`no [data-ai-cta="${which}"] on this page`);
    const s = getComputedStyle(el);
    return {
      backgroundImage: s.backgroundImage,
      backgroundColor: s.backgroundColor,
      border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      boxShadow: s.boxShadow,
      fontFamily: s.fontFamily,
      fontWeight: s.fontWeight,
      textTransform: s.textTransform,
    };
  }, cta);
}

/** The FILL + TYPE axes alone — everything row 8 keeps identical to the base. */
function fillAndType(m: Material): string {
  return [m.backgroundImage, m.backgroundColor, m.fontFamily, m.fontWeight, m.textTransform].join(
    ' | ',
  );
}

/** The whole fingerprint, as one comparable string. */
function fingerprint(m: Material): string {
  return `${fillAndType(m)} | ${m.border} | ${m.boxShadow}`;
}

/**
 * Drive `<html data-style>` through the page's OWN Style control, never by
 * injecting the attribute — so the cascade under test is the page's real
 * mechanism. The committed attribute is the authoritative signal.
 */
async function setStyle(page: Page, id: string, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-style', id);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tokens');
  await expect(page.locator('[data-ai-cta="pill"]')).toBeVisible();
  await expect(page.locator('[data-ai-cta="orb"]')).toBeVisible();
});

test.describe('the fill falls through to the component literal when no style sets it', () => {
  test('the pill and the orb resolve to their own `var()` FALLBACK under the base style', async ({
    page,
  }) => {
    // AC 3, as a WITHIN-RENDER counterfactual. The component declares
    // `background-image: var(--plan-hero-fill, <literal>)`; under a style that
    // sets neither variable the computed value must be that literal. Both sides
    // are read from THIS page — the specified value off the element's own inline
    // style, the oracle off a probe painted with the extracted fallback — so the
    // assertion needs no cross-branch baseline and cannot go stale.
    await setStyle(page, BASE_STYLE, 'Warm Editorial');

    for (const cta of ['pill', 'orb'] as const) {
      const { computed, probe, declared } = await page.evaluate((which) => {
        const el = document.querySelector<HTMLElement>(`[data-ai-cta="${which}"]`);
        if (!el) throw new Error(`no [data-ai-cta="${which}"]`);
        // The SPECIFIED value — `var(--plan-…-fill, <the literal>)`.
        const spec = el.style.backgroundImage;
        const open = spec.indexOf(',');
        const fallback = spec.slice(open + 1, spec.lastIndexOf(')')).trim();
        // A probe in the same subtree, so it inherits the identical token values.
        const p = document.createElement('div');
        p.style.backgroundImage = fallback;
        el.parentElement!.appendChild(p);
        const probeValue = getComputedStyle(p).backgroundImage;
        const computedValue = getComputedStyle(el).backgroundImage;
        p.remove();
        return { computed: computedValue, probe: probeValue, declared: spec };
      }, cta);

      expect(declared, `${cta} must declare the var() seam`).toContain('var(--plan-');
      expect(probe, `${cta}'s fallback must resolve to a real gradient`).not.toBe('none');
      expect(
        computed,
        `${cta} must fall through to the literal written as its own var() fallback`,
      ).toBe(probe);
    }
  });
});

test.describe('every registered style gives the hero control its own material', () => {
  test('each style but the base and the depth-only one differs from the base, measured', async ({
    page,
  }) => {
    // AC 4 (pill) and AC 5 (orb), in one render. The base is read FIRST and is
    // the oracle for everything after it.
    await setStyle(page, BASE_STYLE, 'Warm Editorial');
    const basePill = await readMaterial(page, 'pill');
    const baseOrb = await readMaterial(page, 'orb');

    // The CONTROL. Before the fix these two reads were identical for every
    // style, which is what made the defect invisible — so state the base is a
    // real value rather than an empty one.
    expect(basePill.backgroundImage, 'the base pill paints a gradient').toContain('gradient');
    expect(baseOrb.backgroundImage, 'the base orb paints its lit sphere').toContain(
      'radial-gradient',
    );

    const same: string[] = [];
    for (const [id, name] of STYLES) {
      if (id === BASE_STYLE) continue;
      await setStyle(page, id, name);
      const pill = await readMaterial(page, 'pill');
      const orb = await readMaterial(page, 'orb');

      if (id === DEPTH_ONLY_STYLE) {
        // Row 8, on the record: the fill and the type are the base's, and the
        // DEPTH is its own — the `--plan-hero-shadow` / `--plan-orb-shadow`
        // MOTIR-3522 built. This is AC 8's rendered half.
        expect(fillAndType(pill), '3d-immersive keeps the base pill fill and type').toBe(
          fillAndType(basePill),
        );
        expect(fillAndType(orb), '3d-immersive keeps the base orb fill and type').toBe(
          fillAndType(baseOrb),
        );
        expect(pill.boxShadow, '3d-immersive keeps the depth MOTIR-3522 gave the pill').not.toBe(
          basePill.boxShadow,
        );
        expect(orb.boxShadow, 'and the depth it gave the orb').not.toBe(baseOrb.boxShadow);
        continue;
      }

      if (fingerprint(pill) === fingerprint(basePill)) same.push(`${id} · pill`);
      if (fingerprint(orb) === fingerprint(baseOrb)) same.push(`${id} · orb`);
    }

    // Reported as a SET rather than as the first failure, so one run names every
    // style whose treatment never landed.
    expect(
      same,
      'these controls render byte-identically to the base style — the defect this card fixes',
    ).toEqual([]);
  });

  test('the orb keeps its lit-sphere recipe under every style that composes over it', async ({
    page,
  }) => {
    // The rule the design states and then measures: a style ADDS its material as
    // a layer above the shipped radial gradient, never replacing it, so
    // `--orb-lit-mix` keeps deciding the glyph's contrast (MOTIR-3207, the 3:1
    // floor `tests/theme/orb-glyph-contrast.test.ts` enforces). The two styles
    // that legitimately paint a FLAT orb say so in their row.
    const FLAT_ORB = new Set(['neumorphism']);
    for (const [id, name] of STYLES) {
      await setStyle(page, id, name);
      const orb = await readMaterial(page, 'orb');
      if (FLAT_ORB.has(id)) {
        expect(orb.backgroundImage, `${id} draws a flat orb by design`).toBe('none');
        continue;
      }
      expect(
        orb.backgroundImage,
        `${id} must COMPOSE over the lit sphere, never replace it — replacing it overwrites the ` +
          'guarded --orb-lit-mix contrast knob',
      ).toContain('radial-gradient');
    }
  });

  test('the SHAPE axis still reaches the pill — the one axis that already worked', async ({
    page,
  }) => {
    // A regression floor rather than a new guarantee. The fix writes fill,
    // border, shadow and type; a rule that also re-stated radius or padding
    // would FREEZE the axis that was working before this card existed, which the
    // design calls out explicitly.
    const radii = new Set<string>();
    for (const [id, name] of STYLES) {
      await setStyle(page, id, name);
      radii.add(
        await page.evaluate(
          () =>
            getComputedStyle(document.querySelector<HTMLElement>('[data-ai-cta="pill"]')!)
              .borderTopLeftRadius,
        ),
      );
    }
    expect(radii.size, 'the pill radius must still move with the style').toBeGreaterThan(1);
  });
});
