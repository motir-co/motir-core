import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import { TYPE_IDS } from '@/lib/theme/typography';
import {
  declaredIn,
  loadTokenLayer,
  resolveTokenInScope,
  type ElementAttributes,
  type ScopeChain,
  type ThemeContext,
} from './paletteCascade';

/*
 * MOTIR-3933 — a SCOPED preview must resolve its OWN axis values, not the
 * active ones.
 *
 * `StyleVignette` in SCOPED mode puts `data-palette` / `data-type` on a nested
 * element so a gallery can show one tile per registry entry. Every tile
 * rendered the ACTIVE entry instead: ten identical palette previews on
 * motir-core's `/tokens`, on the onboarding palette step, and on the public
 * `motir.co/design` page where it was noticed.
 *
 * ⚠️ THE ASSERTION IS A RESOLVED VALUE, NOT AN ATTRIBUTE. The shipped bug was
 * invisible to every markup assertion: the axis attributes were all present and
 * correct, and the render was still the ancestor's palette, because `--el-*`
 * reference `--color-*` and `var()` substitutes where the property is DECLARED.
 * `resolveTokenInScope` is the instrument that can see that — the same one
 * `forcedThemeSubtree` uses, with real inheritance down a scope chain.
 *
 * ⚠️ AND THE ORACLE IS THE STYLESHEET, not a table of expected hexes. For each
 * entry, truth is what that entry resolves to when it is the ACTIVE one on
 * `<html>`. A hard-coded expectation would need re-typing every time a palette
 * is tuned, and the first person to skip that turns this into a test of a stale
 * table. Comparing scoped-against-active also states the requirement exactly:
 * a preview is correct when it looks like the thing it is previewing.
 */

const { rules } = loadTokenLayer();

/**
 * The colour tokens a scoped palette tile must re-resolve.
 *
 * ⚠️ The last three are deliberately tokens that NOT every `[data-palette]`
 * block declares. They are the ones that leak if `[data-appearance-scope]` is
 * not re-emitting the Tier-3 layer, so a probe built only from universally
 * overridden tokens would pass with the scope attribute removed.
 */
const PALETTE_PROBE = [
  '--el-accent',
  '--el-page-bg',
  '--el-surface',
  '--el-text',
  '--el-border',
  '--el-status-blocked',
  '--el-status-planning',
  '--el-priority-high',
];

/** The three role tokens a `[data-type]` block re-points. */
const TYPE_PROBE = ['--font-sans', '--font-serif', '--font-mono'];

/**
 * ROOT attributes. Light is the implicit `@theme` base, so `<html>` carries no
 * `data-theme` for it — the asymmetry `forcedThemeSubtree` documents.
 */
const root = (theme: 'light' | 'dark', axis: string, id: string): ElementAttributes => ({
  [axis]: id,
  ...(theme === 'dark' ? { 'data-theme': 'dark' } : {}),
});

/** What `StyleVignette` emits in SCOPED mode: the axis, plus the scope attribute. */
const tile = (axis: string, id: string): ElementAttributes => ({
  'data-appearance-scope': '',
  [axis]: id,
});

const resolve = (chain: ScopeChain, token: string) =>
  resolveTokenInScope(rules, chain, token).value;

/** The value this entry resolves to when it is the ACTIVE one on `<html>`. */
const truth = (theme: 'light' | 'dark', axis: string, id: string, token: string) =>
  resolve([root(theme, axis, id)], token);

/** What the tile resolves, with `<html>` deliberately on a DIFFERENT entry. */
const scoped = (
  theme: 'light' | 'dark',
  axis: string,
  id: string,
  ancestor: string,
  token: string,
) => resolve([root(theme, axis, ancestor), tile(axis, id)], token);

describe('a scoped PALETTE preview resolves its own colours', () => {
  /*
   * The ancestor is deliberately a NON-base palette. That is the condition the
   * shipped bug needed: with `motir` on `<html>` the base tile is right by
   * accident and the other nine are wrong, so the "correct" cell MOVES with the
   * active palette and a spot check of one tile proves nothing.
   */
  const ancestorFor = (id: string) => (id === 'evergreen' ? 'garnet' : 'evergreen');

  for (const theme of ['light', 'dark'] as const) {
    it(`holds for all ${PALETTE_IDS.length} palettes × ${PALETTE_PROBE.length} tokens, ${theme}`, () => {
      const wrong: string[] = [];
      for (const id of PALETTE_IDS) {
        for (const token of PALETTE_PROBE) {
          const own = truth(theme, 'data-palette', id, token);
          const got = scoped(theme, 'data-palette', id, ancestorFor(id), token);
          expect(own, `${id}/${theme} ${token} must resolve at all`).not.toBe('');
          if (got !== own) wrong.push(`${id} ${token}: got ${got}, own value is ${own}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }

  it('reports the matrix — every palette × both themes, none skipped', () => {
    const rows: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      for (const id of PALETTE_IDS) {
        const own = truth(theme, 'data-palette', id, '--el-accent');
        const got = scoped(theme, 'data-palette', id, ancestorFor(id), '--el-accent');
        rows.push(
          `${theme.padEnd(5)} ${id.padEnd(10)} ${got} ${got === own ? '✓' : `✗ own is ${own}`}`,
        );
      }
    }
    expect(rows).toHaveLength(PALETTE_IDS.length * 2);
    expect(rows.filter((r) => r.includes('✗'))).toEqual([]);
  });
});

describe('a scoped TYPE preview resolves its own faces', () => {
  const ancestorFor = (id: string) => (id === 'mono-technical' ? 'grotesk' : 'mono-technical');

  for (const theme of ['light', 'dark'] as const) {
    it(`holds for all ${TYPE_IDS.length} pairings × ${TYPE_PROBE.length} roles, ${theme}`, () => {
      const wrong: string[] = [];
      for (const id of TYPE_IDS) {
        for (const token of TYPE_PROBE) {
          const own = truth(theme, 'data-type', id, token);
          const got = scoped(theme, 'data-type', id, ancestorFor(id), token);
          if (got !== own) wrong.push(`${id} ${token}: got ${got}, own value is ${own}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }
});

describe('the completeness rules the two axes need — and why they differ', () => {
  /*
   * ⚠️ THE TWO AXES NEED DIFFERENT RULES, and the difference is not arbitrary —
   * it is which layer the tokens live in.
   *
   * A `[data-palette]` block MAY omit a token it does not re-skin: `--el-*`
   * belong to the Tier-3 layer, `[data-appearance-scope]` re-emits that whole
   * layer onto the scoped element, and the re-emitted declaration derives from
   * the `--color-*` this subtree overrides. The omission is covered.
   *
   * `--font-*` are ROLE tokens with no such layer, so an omitted role is simply
   * inherited from the ancestor — invisible on `<html>`, which has none, and
   * wrong in every nested scope. `motir-sans` and `editorial` do not re-point
   * `--font-sans`, so under a mono ancestor they rendered mono. Found by the
   * type case above, which is why the rule is asserted and not just written.
   */
  const blocksFor = (axis: string) => {
    const per = new Map<string, Set<string>>();
    for (const rule of rules) {
      for (const selector of rule.selectors) {
        const m = new RegExp(
          String.raw`^(?:\[data-appearance-scope\])?\[${axis}='([^']+)'\]$`,
        ).exec(selector.trim());
        if (!m || m[1] === undefined) continue;
        const set = per.get(m[1]) ?? new Set<string>();
        for (const token of Object.keys(rule.declarations)) set.add(token);
        per.set(m[1], set);
      }
    }
    return per;
  };

  it('every `[data-type]` block is TOTAL over the three role tokens', () => {
    const per = blocksFor('data-type');
    expect(per.size).toBeGreaterThan(0);
    const union = new Set([...per.values()].flatMap((s) => [...s]));
    const incomplete = [...per.entries()]
      .map(([id, tokens]) => [id, [...union].filter((t) => !tokens.has(t)).sort()] as const)
      .filter(([, missing]) => missing.length > 0)
      .map(([id, missing]) => `${id} omits ${missing.join(', ')}`);
    expect(incomplete).toEqual([]);
  });

  it('the base palette block covers every token ANY palette overrides', () => {
    /*
     * The failure this forbids: a later palette overrides a token the base
     * block does not restate, and that ONE token leaks from the ancestor into a
     * scoped `amethyst` tile. Nothing else would notice.
     */
    const per = blocksFor('data-palette');
    const union = new Set([...per.values()].flatMap((s) => [...s]));
    const base = per.get('amethyst');
    expect(base, 'the base palette must declare a block of its own').toBeDefined();
    expect([...union].filter((t) => !base?.has(t)).sort()).toEqual([]);
  });

  /*
   * ⚠️ MOTIR-3954 — the VALUE half, which was CLAIMED and not written.
   *
   * The base palette's scope block is a hand-kept COPY: every declaration in it
   * restates what the Tier-0 `@theme` / Tier-3 base layer already says, so a
   * nested `amethyst` tile can reach those values without inheriting its
   * ancestor's. `theme.css` told its next reader the duplication was guarded —
   * "asserts each declaration here equals the value the base layer declares for
   * that token, so a change to `@theme` that is not mirrored here fails rather
   * than drifts" — and named a file that does not exist. The test above is the
   * one that does exist, and it checks the token SET only: a copy carrying a
   * STALE value passes it, which is the whole failure mode the sentence
   * promised was covered.
   *
   * It was found by writing a second copy on that promise. The block is
   * currently drift-free, so this costs nothing to add and would have cost a
   * silent divergence to keep omitting — the same shape as the card that found
   * it (a bar everyone believed applied to the base palette, which by
   * construction skipped it).
   */
  it('every value the base palette block copies still equals the base layer’s', () => {
    const drifted: string[] = [];
    let compared = 0;
    for (const theme of ['light', 'dark'] as const) {
      const selectors =
        theme === 'dark'
          ? [
              "[data-theme='dark'] [data-appearance-scope][data-palette='amethyst']:not([data-theme])",
              "[data-appearance-scope][data-palette='amethyst'][data-theme='dark']",
            ]
          : ["[data-appearance-scope][data-palette='amethyst']"];
      const block = rules.find((rule) =>
        rule.selectors.some((selector) => selectors.includes(selector.trim())),
      );
      expect(block, `the base palette must declare a ${theme} block`).toBeDefined();
      // What the layer says with NO palette block in play: the Tier-0 + Tier-3
      // + global-dark cascade and no `[data-palette]` rule, which is what the
      // copy must equal. Every selector naming `data-palette` is dropped rather
      // than relying on an unregistered id to match nothing: since MOTIR-10834
      // an unregistered id takes the `motir` block (the axis's default), so it
      // no longer measures the base.
      const withoutPaletteRules = rules.map((rule) => ({
        ...rule,
        selectors: rule.selectors.filter((selector) => !selector.includes('data-palette')),
      }));
      const layer = declaredIn(withoutPaletteRules, { palette: ' none', theme } as ThemeContext);
      for (const [token, value] of Object.entries(block?.declarations ?? {})) {
        compared += 1;
        const declared = layer[token];
        if (declared === undefined) drifted.push(`${theme} ${token}: absent from the base layer`);
        else if (declared.trim() !== value.trim()) {
          drifted.push(`${theme} ${token}: copy "${value.trim()}" vs base "${declared.trim()}"`);
        }
      }
    }
    expect(drifted).toEqual([]);
    // Guards the guard: a selector that stopped matching would compare nothing.
    expect(compared).toBeGreaterThanOrEqual(70);
  });
});
