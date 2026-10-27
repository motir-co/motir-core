import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compile } from 'tailwindcss';
import { DEFAULT_STYLE_ID, isStyleId, defaultTypeForStyle } from '../theme/styles';
import { DEFAULT_PALETTE_ID, isPaletteId } from '../theme/palettes';
import { isTypeId } from '../theme/typography';
import { pruneUnmatchedRules } from './pruneUnmatchedRules';

// renderMock — the package's OWN parts rendered into ONE self-contained
// `.mock.html` (MOTIR-6961).
//
// A design mock used to be hand-written HTML carrying its own copy of the
// tokens, so it could drift from what the parts actually render. This renders
// the real parts with `react-dom/server`, then COMPILES Tailwind v4 over the
// markup with the package's own `theme.css` as input — the parts style
// themselves with utilities (`bg-(--el-accent)`, `rounded-(--radius-card)`),
// so inlining `theme.css` alone would leave them unstyled.
//
// NODE-ONLY: it reads files and imports `react-dom/server`, so it ships from the
// `@motir/design-system/mock` subpath and is never re-exported by the main
// barrel, which must stay safe for a Next client import
// (`test/barrel-rsc-safe.test.ts`).
//
// The compiler is the `tailwindcss` PEER's own `compile()` API — no extra
// runtime dependency. Its `loadStylesheet` hook is where `@import 'tailwindcss'`
// and the stylesheets that file imports are resolved, from the consumer's
// installed `tailwindcss`.

/** One labelled board section of the mock. */
export interface MockPanel {
  /** The caption drawn above the panel. */
  label: string;
  /** A tree of the package's parts (or any React element) to render. */
  element: ReactElement;
}

/** The three axis ids the document wears — validated against the registries. */
export interface MockAxes {
  styleId: string;
  paletteId: string;
  typeId: string;
}

export interface RenderMockOptions {
  /** The document `<title>` and the board heading. */
  title: string;
  panels: MockPanel[];
  axes: MockAxes;
  /** `data-theme` on `<html>`. Defaults to `light`. */
  theme?: 'light' | 'dark';
  /**
   * CSS inlined VERBATIM into the document's one `<style>` — the caller's way to
   * bring real web fonts (`@font-face` with `data:` URLs keeps it offline).
   * Omitted, the fonts fall back to the stacks `theme.css` declares and no
   * `@font-face` is emitted.
   */
  fontCss?: string;
  /**
   * How wide the board is drawn (MOTIR-9758). Defaults to `'narrow'`.
   * - `'narrow'` — the 64rem column every mock has always had.
   * - `'full'` — the viewport's width, for a page that ships full width.
   * - any other string — ONE max-width utility, e.g. `'max-w-[1400px]'`, for a
   *   page that ships at that width. It lands on the board as a class, so
   *   Tailwind compiles it like any other candidate.
   *
   * An empty string, or one holding whitespace, falls back to `'narrow'` and
   * the fallback is named in a comment at the top, as an unknown axis is.
   */
  boardWidth?: BoardWidth;
}

/** `'narrow'`, `'full'`, or one max-width utility class. */
export type BoardWidth = 'narrow' | 'full' | (string & {});

// `theme.css` sits at the package root, two levels above both the source file
// (src/mock/) and the emitted chunk (dist/mock/).
const THEME_CSS_URL = new URL('../../theme.css', import.meta.url);

/** The axis ids after registry validation, plus a note per fallback taken. */
function resolveAxes(axes: Partial<MockAxes>): {
  styleId: string;
  paletteId: string;
  typeId: string;
  fallbacks: string[];
} {
  const fallbacks: string[] = [];
  const describe = (value: unknown) =>
    value === undefined || value === null || value === ''
      ? 'missing'
      : `unknown "${String(value)}"`;

  let styleId: string = DEFAULT_STYLE_ID;
  if (isStyleId(axes.styleId)) styleId = axes.styleId;
  else fallbacks.push(`styleId ${describe(axes.styleId)} — fell back to "${DEFAULT_STYLE_ID}"`);

  let paletteId: string = DEFAULT_PALETTE_ID;
  if (isPaletteId(axes.paletteId)) paletteId = axes.paletteId;
  else
    fallbacks.push(`paletteId ${describe(axes.paletteId)} — fell back to "${DEFAULT_PALETTE_ID}"`);

  // The type axis's default is the one the ACTIVE style pairs with — the same
  // fallback chain the theme context and the init script use.
  const typeDefault = defaultTypeForStyle(styleId);
  let typeId: string = typeDefault;
  if (isTypeId(axes.typeId)) typeId = axes.typeId;
  else fallbacks.push(`typeId ${describe(axes.typeId)} — fell back to "${typeDefault}"`);

  return { styleId, paletteId, typeId, fallbacks };
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
};

/**
 * Every class token the markup uses — the candidate list Tailwind compiles.
 * `renderToStaticMarkup` escapes attribute values, so an arbitrary variant like
 * `[&>svg]:size-4` arrives as `[&amp;&gt;svg]:size-4` and is un-escaped first.
 */
export function extractClassCandidates(markup: string): string[] {
  const out = new Set<string>();
  for (const match of markup.matchAll(/\sclass="([^"]*)"/g)) {
    const value = (match[1] ?? '').replace(
      /&(?:amp|lt|gt|quot|#x27|#39);/g,
      (e) => ENTITIES[e] ?? e,
    );
    for (const token of value.split(/\s+/)) if (token) out.add(token);
  }
  return [...out];
}

/**
 * Resolve an `@import` the way a bundler would: a package id, or a path relative to `base`.
 * Exported for its own test only — the `./mock` barrel does not re-export it.
 */
export async function loadStylesheet(id: string, base: string) {
  let file: string;
  if (id.startsWith('.') || id.startsWith('/')) {
    file = path.resolve(base, id);
  } else {
    const require = createRequire(path.join(base, 'noop.js'));
    const spec = id === 'tailwindcss' ? 'tailwindcss/index.css' : id;
    file = require.resolve(spec);
  }
  return { path: file, base: path.dirname(file), content: await readFile(file, 'utf8') };
}

async function compileCss(markup: string): Promise<string> {
  const themePath = fileURLToPath(THEME_CSS_URL);
  const themeCss = await readFile(themePath, 'utf8');
  const base = path.dirname(themePath);
  // The consumer's own globals.css shape: Tailwind first, then the package's
  // token layer. The token layer is passed INLINE (not as an @import) so it is
  // exactly the file this package ships, whatever the caller's resolution.
  const input = `@import 'tailwindcss';\n${themeCss}`;
  const compiler = await compile(input, { base, loadStylesheet });
  const candidates = extractClassCandidates(markup);
  // Tailwind writes a utility only for a candidate, but copies every plain rule
  // of `theme.css` through whole — so a component's own rule (the StyleVignette
  // canvas) would land in a mock that never renders that component. Drop the
  // rules this markup cannot match (MOTIR-8565).
  return pruneUnmatchedRules(compiler.build(candidates), candidates);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A `</style>` inside inlined CSS would close the element early; neutralise it.
function safeStyleText(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

const BODY_CLASS = 'bg-(--el-page-bg) text-(--el-text) font-sans antialiased';

const NARROW_WIDTH_CLASS = 'max-w-[64rem]';

/** The board's width class for `boardWidth`, plus a note when it fell back. */
function resolveBoardWidth(boardWidth: unknown): { widthClass: string; fallback?: string } {
  if (boardWidth === undefined || boardWidth === 'narrow')
    return { widthClass: NARROW_WIDTH_CLASS };
  if (boardWidth === 'full') return { widthClass: 'w-full' };
  if (typeof boardWidth === 'string' && /^\S+$/.test(boardWidth)) return { widthClass: boardWidth };
  return {
    widthClass: NARROW_WIDTH_CLASS,
    fallback: `boardWidth ${JSON.stringify(boardWidth)} is not one class — fell back to "narrow"`,
  };
}

function Board({
  title,
  panels,
  widthClass,
}: {
  title: string;
  panels: MockPanel[];
  widthClass: string;
}) {
  return (
    <main className={`mx-auto flex ${widthClass} flex-col gap-8 p-8`}>
      <h1 className="font-sans text-2xl font-semibold text-(--el-text)">{title}</h1>
      {panels.map((panel, i) => (
        <section key={i} className="flex flex-col gap-3" aria-label={panel.label}>
          <h2 className="font-mono text-xs uppercase tracking-wide text-(--el-text-secondary)">
            {panel.label}
          </h2>
          <div className="rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding)">
            {panel.element}
          </div>
        </section>
      ))}
    </main>
  );
}

/**
 * Render the package's parts into ONE self-contained HTML document: the markup,
 * the axis attributes on `<html>`, and a single `<style>` holding the Tailwind
 * output compiled over that markup with `theme.css` (plus `fontCss`). No
 * stylesheet link, no script and no remote import — it opens offline.
 *
 * An unknown or missing axis id never throws: it falls back to that axis's
 * registry default and the fallback is named in a comment at the top. So does
 * a `boardWidth` that is not one class.
 */
export async function renderMock(options: RenderMockOptions): Promise<string> {
  const { title, panels, theme = 'light', fontCss } = options;
  const { styleId, paletteId, typeId, fallbacks } = resolveAxes(options.axes ?? {});
  const { widthClass, fallback: widthFallback } = resolveBoardWidth(options.boardWidth);
  if (widthFallback) fallbacks.push(widthFallback);

  const body = renderToStaticMarkup(
    <Board title={title} panels={panels} widthClass={widthClass} />,
  );
  const bodyTag = `<body class="${BODY_CLASS}">`;
  const compiled = await compileCss(bodyTag + body);
  const css = fontCss === undefined ? compiled : `${fontCss}\n${compiled}`;

  const notes = fallbacks
    .map((note) => `<!-- renderMock: ${note.replace(/--/g, '—')} -->\n`)
    .join('');

  return (
    '<!doctype html>\n' +
    notes +
    `<html lang="en" data-style="${styleId}" data-palette="${paletteId}" data-type="${typeId}" data-theme="${theme}">\n` +
    '<head>\n' +
    '<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    `<title>${escapeHtml(title)}</title>\n` +
    `<style>\n${safeStyleText(css)}\n</style>\n` +
    '</head>\n' +
    `${bodyTag}\n${body}\n</body>\n` +
    '</html>\n'
  );
}
