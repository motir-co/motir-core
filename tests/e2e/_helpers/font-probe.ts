// FONT PROBES for the acceptance lane, moved out of
// `regression-font-sets.spec.ts` by MOTIR-7901 so the per-language font-set
// receipt (MOTIR-7733) and the per-language font-pick receipt (MOTIR-7736) read
// faces with one implementation rather than two copies that drift. Unchanged,
// except that the readers needing the registry take it from the spec (below).
//
// ⚠️ EVERY READER HERE MEASURES WHAT THE BROWSER DREW OR FETCHED, never what was
// asked for. `CSS.getPlatformFontsForNode` (Chrome DevTools Protocol) lists the
// faces that actually rendered a node's glyphs, by the name in the font file;
// the network log of a FRESH context lists the files a page fetched, each
// attributed to the `@font-face` rule (and so the family) that names it. A
// computed `font-family` string only says what the stylesheet asked for, and is
// used solely to ask the browser to load the face before it is measured.

import type { Browser, BrowserContext, CDPSession, Locator, Page } from '@playwright/test';
import { test, expect } from './acceptance-video';

// ⚠️ THIS FILE IMPORTS NO REGISTRY. It belongs to the `tsconfig.tests.json`
// project, whose file list does not take in `packages/design-system` (only the
// spec project, `tsconfig.e2e.json`, lists `fontSets.ts`). So the readers that
// need the font-set registry are built by {@link registryFaces} from the
// registry a spec imports and hands in, typed by the structural
// {@link FontRegistry} below.

/** The three type roles every set covers. */
export type FontSetRole = 'sans' | 'serif' | 'mono';

/** The part of `FONT_SET_REGISTRY` these readers use, structurally. */
export interface FontRegistry {
  readonly [setId: string]: {
    readonly cjk: boolean;
    readonly roles: Readonly<
      Record<
        FontSetRole,
        {
          readonly default: string;
          readonly members: readonly { readonly id: string; readonly family: string | null }[];
        }
      >
    >;
  };
}

// ── The faces ───────────────────────────────────────────────────────────────

/**
 * Each Type pairing's Latin face per role, as `packages/design-system/theme.css`
 * composes them (`[data-type]` blocks). The family name is the one in the font
 * file, which is what CDP reports.
 */
export const PAIRING_FACES: Record<string, Record<FontSetRole, string>> = {
  motir: { sans: 'Inter', serif: 'Source Serif 4', mono: 'JetBrains Mono' },
  'motir-sans': { sans: 'Inter', serif: 'Inter', mono: 'JetBrains Mono' },
  'motir-mono': { sans: 'JetBrains Mono', serif: 'JetBrains Mono', mono: 'JetBrains Mono' },
  grotesk: { sans: 'Space Grotesk', serif: 'Space Grotesk', mono: 'JetBrains Mono' },
  editorial: { sans: 'Inter', serif: 'Fraunces', mono: 'JetBrains Mono' },
  'mono-technical': { sans: 'IBM Plex Mono', serif: 'IBM Plex Mono', mono: 'IBM Plex Mono' },
};
export const PAIRING_NAMES: Record<string, string> = {
  motir: 'Motir',
  'motir-sans': 'Motir Sans',
  'motir-mono': 'Motir Mono',
  grotesk: 'Grotesk',
  editorial: 'Editorial',
  'mono-technical': 'Mono-Technical',
};
export const DEFAULT_PAIRING = PAIRING_FACES.motir!;
/** Every Latin face any pairing loads (every page preloads them all). */
export const ALL_PAIRING_FACES = [...new Set(Object.values(PAIRING_FACES).flatMap(Object.values))];

/**
 * The registry-derived readers, over the registry a spec imports
 * (`FONT_SET_REGISTRY` / `FONT_SET_ROLES` from the design system's source).
 */
export function registryFaces<Id extends string>(
  registry: FontRegistry & Record<Id, FontRegistry[string]>,
  roles: readonly FontSetRole[],
) {
  /** A set's default face for one role, from the registry. */
  function defaultFace(setId: Id, role: FontSetRole): string {
    const r = registry[setId].roles[role];
    const m = r.members.find((x) => x.id === r.default);
    return m?.family ?? '';
  }

  /** Every face a set can load, over all its roles and members. */
  function setFamilies(setId: Id): string[] {
    return [
      ...new Set(
        roles.flatMap((role) =>
          registry[setId].roles[role].members.map((m) => m.family).filter((f): f is string => !!f),
        ),
      ),
    ];
  }

  const CJK_SETS = (Object.keys(registry) as Id[]).filter((id) => registry[id].cjk);
  const ALL_CJK_FAMILIES = [...new Set(CJK_SETS.flatMap(setFamilies))];

  return { defaultFace, setFamilies, CJK_SETS, ALL_CJK_FAMILIES };
}

/**
 * Does a platform font name (what CDP reports, from the font file) name this
 * family? A variable face reports its default instance (`Noto Sans JP Thin`),
 * and M PLUS Rounded 1c's file calls itself `Rounded Mplus 1c`.
 */
export function isFace(platformName: string, family: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const alias: Record<string, string> = { mplusrounded1c: 'roundedmplus1c' };
  const want = norm(family);
  return norm(platformName).startsWith(alias[want] ?? want);
}

// ── Reading what the browser drew ───────────────────────────────────────────

export interface PlatformFont {
  familyName: string;
  glyphCount: number;
}

let probeSeq = 0;

/** The faces that rendered `node`'s glyphs, per CDP, once its face has loaded. */
export async function platformFonts(cdp: CDPSession, node: Locator): Promise<PlatformFont[]> {
  const id = `fp-${++probeSeq}`;
  await node.evaluate(async (el, probeId) => {
    el.setAttribute('data-font-probe', probeId);
    // Ask the browser to load the face for exactly this text; the measurement
    // below is CDP's, not this string's.
    // A face that fails to load rejects here; that is not this probe's verdict
    // (CDP's list below shows the fallback that drew instead), so it is swallowed.
    await document.fonts.load(getComputedStyle(el).font, el.textContent ?? '').catch(() => []);
    await document.fonts.ready;
  }, id);
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: `[data-font-probe="${id}"]`,
  });
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  return fonts.map((f) => ({ familyName: f.familyName, glyphCount: f.glyphCount }));
}

export interface Drawn {
  /** Each of these faces drew at least one glyph. */
  in: string[];
  /** Nothing else drew any (no system fallback). Defaults to `in`; `'any'` skips it. */
  only?: string[] | 'any';
  /** None of these drew a glyph. */
  never?: string[];
}

/**
 * Assert the faces that rendered `node`. Polled, because a face that finished
 * loading re-renders the node on the next frame.
 */
export async function expectDrawnIn(cdp: CDPSession, node: Locator, want: Drawn): Promise<void> {
  const only = want.only === 'any' ? null : [...(want.only ?? []), ...want.in];
  const never = want.never ?? [];
  let last: PlatformFont[] = [];
  await expect
    .poll(
      async () => {
        last = await platformFonts(cdp, node);
        const names = last.map((f) => f.familyName);
        const ok =
          want.in.every((fam) => names.some((n) => isFace(n, fam))) &&
          (!only || names.every((n) => only.some((fam) => isFace(n, fam)))) &&
          !names.some((n) => never.some((fam) => isFace(n, fam)));
        // On a miss, the faces the browser used ARE the received value, so the
        // failure prints them.
        return ok ? 'as expected' : `drawn in: ${names.join(', ') || '(nothing)'}`;
      },
      {
        message: `drawn in ${want.in.join(' + ')}${only ? ` (allowed: ${only.join(', ')})` : ''}${never.length ? `, never ${never.join(', ')}` : ''}`,
        timeout: 20_000,
      },
    )
    .toBe('as expected');
  // Say what was drawn on the report, so a reviewer can read the faces too.
  test.info().annotations.push({
    type: 'drawn',
    description: last.map((f) => `${f.familyName} ×${f.glyphCount}`).join(', '),
  });
}

export async function cdpFor(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  return cdp;
}

/** Add a node to `<main>` (inheriting the page's `lang`) and return it. */
export async function inject(page: Page, html: string): Promise<Locator> {
  const id = `inj-${++probeSeq}`;
  await page.getByRole('main').evaluate(
    (main, { markup, probeId }) => {
      const box = document.createElement('div');
      box.setAttribute('data-injected', probeId);
      box.style.cssText =
        'padding:16px;margin:16px 0;border:1px dashed var(--el-border);color:var(--el-text)';
      box.innerHTML = markup;
      main.prepend(box);
    },
    { markup: html, probeId: id },
  );
  const box = page.locator(`[data-injected="${id}"]`);
  await box.scrollIntoViewIfNeeded();
  return box;
}

// ── Reading what the network fetched ────────────────────────────────────────

/**
 * Open `path` in a FRESH context (no font cache) carrying only `cookies`, and
 * return the family of every font file it fetched, each attributed to the
 * `@font-face` rule that names it. An unattributable file fails.
 */
export async function familiesFetched(
  browser: Browser,
  cookies: Awaited<ReturnType<BrowserContext['cookies']>>,
  path: string,
  ready: (page: Page) => Promise<void>,
): Promise<string[]> {
  const context = await browser.newContext({ storageState: { cookies, origins: [] } });
  try {
    const page = await context.newPage();
    const files: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'font') files.push(r.url());
    });
    await page.goto(path);
    await ready(page);
    await page.evaluate(() => document.fonts.ready);
    return attribute(page, files);
  } finally {
    await context.close();
  }
}

/** Map each fetched font file to the family of the `@font-face` rule naming it. */
export async function attribute(page: Page, files: string[]): Promise<string[]> {
  const names = files.map((u) => new URL(u).pathname.split('/').pop() ?? u);
  const families = await page.evaluate((wanted) => {
    const out: Record<string, string> = {};
    for (const sheet of [...document.styleSheets]) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of [...rules]) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        const src = rule.style.getPropertyValue('src');
        for (const f of wanted) {
          if (src.includes(f)) {
            out[f] = rule.style.getPropertyValue('font-family').replace(/^["']|["']$/g, '');
          }
        }
      }
    }
    return out;
  }, names);
  const unknown = names.filter((n) => !families[n]);
  expect(unknown, 'every fetched font file is named by an @font-face rule').toEqual([]);
  return [...new Set(names.map((n) => families[n]!))];
}
