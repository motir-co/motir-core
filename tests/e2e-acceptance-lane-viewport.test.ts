import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { REPO_ROOT, specifiersOf, stripComments } from './helpers/importGraph';
import { globToRegExp, laneDeclarationIn } from './helpers/playwrightLane';

// MOTIR-11471 — the ACCEPTANCE FRAME guard: every receipt records at ONE size.
//
// ── The defect ──────────────────────────────────────────────────────────────
// The acceptance lane records every green run as the story's receipt. The clip
// has a fixed frame (`video.size`), and Playwright SCALES whatever the page is
// into it. So a spec that resized its page — `page.setViewportSize(…)`, or a
// context opened at its own size — produced a receipt shrunk into the frame, or
// letterboxed, and one that changed size halfway through when the resize came
// mid-walk. On `main` before this card six specs did it: three admin walks at
// 1440×810, the board at 1600×1000, the provider reconciliation at 1440×900, and
// the review path's last chapter at 390×844 — and runs kept adding them, two in
// the two days before the card was filed. A sentence in a convention had not
// stopped any of them, which is why this is a red check instead.
//
// ── What it holds ───────────────────────────────────────────────────────────
//   1. THE CONFIG: `playwright.acceptance.config.ts` records at the size its
//      project's viewport is, spelled as ONE expression (so the two cannot drift
//      apart), resolving to 1920×1080, set AFTER the device spread so the
//      device's own viewport cannot win, with `deviceScaleFactor: 1`.
//   2. THE SPECS: nothing the lane runs resizes the page. Every spec the config's
//      own `testMatch` selects, and every local module under `testDir` those
//      specs reach through a relative import, is read for:
//        * a `setViewportSize(` call;
//        * a `test.use({ … })` that sets `viewport`, `video`, `deviceScaleFactor`
//          or spreads a `devices[…]` preset;
//        * a `newContext(` / `newPage(` that does the same, or names
//          `recordVideo` (a second recorder) — or whose options the guard cannot
//          read because they are not an object literal. An unreadable argument
//          fails rather than passes, for the reason
//          `tests/e2e-pull-request-number-blocks.test.ts` gives: a guard must not
//          report a sweep it did not perform. An `APIRequestContext`'s
//          `request.newContext(…)` opens no page and is not read.
//
// A context a spec opens with plain `browser.newContext()` is FINE, and the
// reason is Playwright's, measured in 1.60's `lib/index.js`: such a context
// inherits the project's `use` options (`_combinedContextOptions`, so the 1920×1080
// viewport and the scale factor) and is never recorded — `recordVideo` is set
// only by `_contextFactory`, the `page` / `context` fixtures' factory.
//
// A responsive check belongs in a spec OUTSIDE this lane (the review path's
// phone check is `regression-review-path-phone.spec.ts`), where a resize touches
// no receipt.
//
// ── The lane ────────────────────────────────────────────────────────────────
// It parses text, opens no database and imports only `node:fs` / `node:path`
// and the dependency-free `tests/helpers/importGraph` and
// `tests/helpers/playwrightLane`, so it belongs in the structural-guard lane. It
// does its own walk, so nothing derives it — hence its `SELF_WALKING_MEMBERS`
// entry in `tests/ci-structural-guards-lane.test.ts`.

/** The Playwright config that OWNS the lane — its membership and its frame. */
const ACCEPTANCE_CONFIG = 'playwright.acceptance.config.ts';

/** The one frame every receipt records at. */
export const ACCEPTANCE_FRAME = { width: 1920, height: 1080 } as const;

// ── The config's frame ──────────────────────────────────────────────────────

export interface FrameDeclaration {
  /** The expression `video.size` is set to, whitespace-normalised, or null. */
  videoSize: string | null;
  /** Every expression a `viewport:` key is set to, whitespace-normalised. */
  viewports: string[];
  /** `videoSize`, resolved to numbers when it is a literal or a local const. */
  resolved: { width: number; height: number } | null;
  /** The project sets `viewport` after spreading a `devices[…]` preset. */
  viewportAfterDeviceSpread: boolean;
  /** The project pins `deviceScaleFactor: 1`. */
  scaleFactorOne: boolean;
}

const EXPRESSION = String.raw`([A-Za-z_$][\w$]*|\{[^{}]*\})`;
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

function sizeOf(literal: string): { width: number; height: number } | null {
  const width = /\bwidth\s*:\s*(\d+)/.exec(literal);
  const height = /\bheight\s*:\s*(\d+)/.exec(literal);
  return width && height ? { width: Number(width[1]), height: Number(height[1]) } : null;
}

export function frameDeclarationIn(configSource: string): FrameDeclaration {
  const code = stripComments(configSource);
  const video = new RegExp(String.raw`\bvideo\s*:\s*\{[^{}]*?\bsize\s*:\s*${EXPRESSION}`).exec(
    code,
  );
  const videoSize = video?.[1] ? squash(video[1]) : null;
  const viewports = [
    ...code.matchAll(new RegExp(String.raw`\bviewport\s*:\s*${EXPRESSION}`, 'g')),
  ].map((m) => squash(m[1]!));

  let resolved: FrameDeclaration['resolved'] = null;
  if (videoSize?.startsWith('{')) resolved = sizeOf(videoSize);
  else if (videoSize) {
    const decl = new RegExp(String.raw`\bconst\s+${videoSize}\s*=\s*(\{[^{}]*\})`).exec(code);
    resolved = decl?.[1] ? sizeOf(decl[1]) : null;
  }

  const spread = code.search(/\.\.\.\s*devices\s*\[/);
  const viewportAt = code.search(/\bviewport\s*:/);
  return {
    videoSize,
    viewports,
    resolved,
    viewportAfterDeviceSpread: spread >= 0 && viewportAt > spread,
    scaleFactorOne: /\bdeviceScaleFactor\s*:\s*1\b/.test(code),
  };
}

// ── The specs ───────────────────────────────────────────────────────────────

export interface FrameViolation {
  file: string;
  line: number;
  what: string;
}

/** Keys that change the page's size or its recording, per call shape. */
const CONTEXT_KEYS = ['viewport', 'recordVideo', 'deviceScaleFactor'];
const USE_KEYS = ['viewport', 'video', 'deviceScaleFactor'];

const lineAt = (code: string, index: number) => code.slice(0, index).split('\n').length;

/** The `{ … }` object literal starting at `open` (a `{`), brace-matched. */
function objectAt(code: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return null;
}

/** Which of `keys` the literal sets — a `key:` property, a `{ key }` shorthand,
 *  or a `...devices[…]` preset spread (which carries a viewport of its own). */
function framingKeysIn(literal: string, keys: readonly string[]): string[] {
  const found = keys.filter((key) =>
    new RegExp(String.raw`(?:^|[{,\s])${key}\s*(?::|,|\})`).test(literal),
  );
  if (/\.\.\.\s*devices\s*\[/.test(literal)) found.push('...devices[…]');
  return found;
}

export function frameViolationsIn(file: string, source: string): FrameViolation[] {
  const code = stripComments(source);
  const out: FrameViolation[] = [];

  for (const m of code.matchAll(/\bsetViewportSize\s*\(/g)) {
    out.push({
      file,
      line: lineAt(code, m.index),
      what: 'calls setViewportSize — the clip is scaled into the frame from that moment on',
    });
  }

  for (const m of code.matchAll(/(?:(\b[\w$]+)\s*\.\s*)?\b(newContext|newPage|use)\s*\(/g)) {
    const receiver = m[1] ?? '';
    const call = m[2]!;
    if (call === 'use' && receiver !== 'test') continue;
    if (call !== 'use' && /request/i.test(receiver)) continue; // an APIRequestContext
    const argStart = m.index + m[0].length;
    const rest = code.slice(argStart);
    const lead = /^\s*/.exec(rest)![0].length;
    const next = rest[lead];
    const line = lineAt(code, m.index);
    const label = receiver ? `${receiver}.${call}` : call;
    if (next === ')') continue; // no options: the lane's own frame
    if (next !== '{') {
      out.push({
        file,
        line,
        what: `${label}(…) takes options this guard cannot read — pass an object literal`,
      });
      continue;
    }
    const literal = objectAt(code, argStart + lead);
    const keys =
      literal === null
        ? ['(unclosed)']
        : framingKeysIn(literal, call === 'use' ? USE_KEYS : CONTEXT_KEYS);
    if (keys.length > 0) {
      out.push({ file, line, what: `${label}({ ${keys.join(', ')} }) sets its own frame` });
    }
  }
  return out;
}

// ── The lane's population ───────────────────────────────────────────────────

/** Every `.ts` file under `dir`, repo-relative. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, rel))) {
      const child = posix.join(rel, entry);
      if (statSync(join(REPO_ROOT, child)).isDirectory()) walk(child);
      else if (child.endsWith('.ts')) out.push(child);
    }
  };
  walk(dir);
  return out;
}

/** The lane's specs plus every module under `testDir` they reach by a relative import. */
export function laneModules(
  files: readonly string[],
  read: (file: string) => string,
  declaration: { testDir: string; testMatch: string[] },
): { specs: string[]; reached: string[] } {
  const patterns = declaration.testMatch.map(globToRegExp);
  const known = new Set(files);
  const specs = files.filter((f) => {
    if (!f.startsWith(`${declaration.testDir}/`)) return false;
    const rel = f.slice(declaration.testDir.length + 1);
    return patterns.some((p) => p.test(rel));
  });
  const reached = new Set<string>(specs);
  const queue = [...specs];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const specifier of specifiersOf(read(file))) {
      if (!specifier.startsWith('.')) continue;
      const base = posix.normalize(posix.join(posix.dirname(file), specifier));
      const target = [base, `${base}.ts`, `${base}/index.ts`].find((c) => known.has(c));
      if (target && !reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  return { specs, reached: [...reached].sort() };
}

const describeViolation = (v: FrameViolation) => `${v.file}:${v.line} — ${v.what}`;

// ── The tree ────────────────────────────────────────────────────────────────

describe('the acceptance lane records at ONE fixed frame (MOTIR-11471)', () => {
  const configSource = readFileSync(join(REPO_ROOT, ACCEPTANCE_CONFIG), 'utf8');
  const frame = frameDeclarationIn(configSource);
  const declaration = laneDeclarationIn(configSource);
  const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');
  const population = laneModules(filesUnder(declaration.testDir), read, declaration);

  it('the config records at exactly its viewport, spelled once, at 1920×1080', () => {
    expect(frame.videoSize, 'video.size is set').not.toBeNull();
    expect(frame.viewports.length, 'the project sets a viewport').toBeGreaterThan(0);
    for (const viewport of frame.viewports) {
      expect(viewport, 'every viewport is the expression video.size is').toBe(frame.videoSize);
    }
    expect(frame.resolved, `${frame.videoSize} resolves to the frame`).toEqual(ACCEPTANCE_FRAME);
  });

  it('the viewport wins over the device preset, at one CSS pixel per video pixel', () => {
    expect(frame.viewportAfterDeviceSpread).toBe(true);
    expect(frame.scaleFactorOne).toBe(true);
  });

  it('reads a real population — the walk is not vacuous', () => {
    expect(population.specs.length, 'the lane selects specs').toBeGreaterThan(5);
    expect(
      population.reached.filter((f) => f.includes('/_helpers/')).length,
      'the walk follows the specs into their helpers',
    ).toBeGreaterThan(5);
  });

  it('nothing the lane runs resizes the page or opens its own frame', () => {
    const violations = population.reached.flatMap((f) => frameViolationsIn(f, read(f)));
    expect(
      violations.map(describeViolation),
      'An acceptance receipt records at the lane’s one fixed frame (1920×1080) from the first ' +
        'frame to the last. Remove the resize; a responsive check belongs in a spec outside ' +
        'this lane (a `regression-*` or main-lane spec).',
    ).toEqual([]);
  });
});

// ── The predicates, DEMONSTRATED ────────────────────────────────────────────
//
// The assertions above rule on THIS tree, and a predicate that has quietly
// stopped matching passes every one of them. So each arm is proved RED on a
// synthetic source, and its control GREEN.
describe('fires on every framing shape — demonstrated, not assumed', () => {
  const at = (source: string) => frameViolationsIn('tests/e2e/acceptance-x.spec.ts', source);

  it('RED: setViewportSize, with the line it is on', () => {
    const v = at(
      ['test("x", async ({ page }) => {', '  await page.setViewportSize(WIDE);', '});'].join('\n'),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(2);
    expect(describeViolation(v[0]!)).toMatch(/^tests\/e2e\/acceptance-x\.spec\.ts:2 — /);
  });

  it('RED: a context or page opened at its own size, a second recorder, a device preset', () => {
    expect(at('await browser.newContext({ viewport: { width: 390, height: 844 } });')).toHaveLength(
      1,
    );
    expect(at('const viewport = WIDE; await browser.newContext({ viewport });')).toHaveLength(1);
    expect(at("await browser.newContext({ recordVideo: { dir: 'out' } });")).toHaveLength(1);
    expect(at("await browser.newPage({ ...devices['iPhone 13'] });")).toHaveLength(1);
    expect(at('await browser.newContext({ locale: "zh", deviceScaleFactor: 2 });')).toHaveLength(1);
  });

  it('RED: an options object the guard cannot read', () => {
    expect(at('await browser.newContext(options);')[0]?.what).toMatch(/cannot read/);
  });

  it('RED: a test.use that sets the viewport, the video or a preset', () => {
    expect(at('test.use({ viewport: { width: 390, height: 844 } });')).toHaveLength(1);
    expect(at("test.use({ video: 'off' });")).toHaveLength(1);
    expect(at("test.use({ ...devices['Pixel 7'] });")).toHaveLength(1);
  });

  it('GREEN: contexts and pages on the lane’s own frame, and options that frame nothing', () => {
    expect(at('await browser.newContext();')).toEqual([]);
    expect(at('const tab = await context.newPage();')).toEqual([]);
    expect(at("await browser.newContext({ locale: 'zh', baseURL });")).toEqual([]);
    expect(at('await browser.newContext({ storageState: { cookies, origins: [] } });')).toEqual([]);
    expect(at("test.use({ permissions: ['clipboard-read'] });")).toEqual([]);
    // A key that merely CONTAINS a framing word is not one.
    expect(at('await browser.newContext({ viewportLabel: 1 });')).toEqual([]);
  });

  it('GREEN: an APIRequestContext, and prose about a resize', () => {
    expect(at('const api = await request.newContext(opts);')).toEqual([]);
    expect(at('const api = await playwrightRequest.newContext({ baseURL });')).toEqual([]);
    expect(at('// never call page.setViewportSize() in this lane')).toEqual([]);
    expect(at('/* test.use({ viewport }) belongs elsewhere */')).toEqual([]);
  });

  it('the config arm: one expression, resolved, after the spread, scale 1', () => {
    const good = [
      'const FRAME = { width: 1920, height: 1080 } as const;',
      "export default defineConfig({ use: { video: { mode: 'on', size: FRAME } },",
      "  projects: [{ name: 'c', use: { ...devices['Desktop Chrome'], viewport: FRAME, deviceScaleFactor: 1 } }] });",
    ].join('\n');
    expect(frameDeclarationIn(good)).toEqual({
      videoSize: 'FRAME',
      viewports: ['FRAME'],
      resolved: ACCEPTANCE_FRAME,
      viewportAfterDeviceSpread: true,
      scaleFactorOne: true,
    });

    // The shape this card replaced: a literal video size and the device's own viewport.
    const before = [
      "export default defineConfig({ use: { video: { mode: 'on', size: { width: 1280, height: 720 } } },",
      "  projects: [{ name: 'c', use: { ...devices['Desktop Chrome'] } }] });",
    ].join('\n');
    const read = frameDeclarationIn(before);
    expect(read.viewports).toEqual([]);
    expect(read.resolved).toEqual({ width: 1280, height: 720 });
    expect(read.viewportAfterDeviceSpread).toBe(false);
    expect(read.scaleFactorOne).toBe(false);

    // Two spellings of the same size are two authorities, and fail.
    const twice = good.replace('viewport: FRAME', 'viewport: { width: 1920, height: 1080 }');
    expect(frameDeclarationIn(twice).viewports).toEqual(['{ width: 1920, height: 1080 }']);
    // The viewport BEFORE the spread loses to the preset.
    const early = good.replace(
      "...devices['Desktop Chrome'], viewport: FRAME",
      "viewport: FRAME, ...devices['Desktop Chrome']",
    );
    expect(frameDeclarationIn(early).viewportAfterDeviceSpread).toBe(false);
  });

  it('the walk follows relative imports under testDir, and the glob decides the specs', () => {
    const tree: Record<string, string> = {
      'tests/e2e/acceptance-a.spec.ts': "import { seed } from './_helpers/seed';",
      'tests/e2e/_helpers/seed.ts': "import { deep } from './deep';\nimport x from '@/lib/x';",
      'tests/e2e/_helpers/deep.ts': 'export const deep = 1;',
      'tests/e2e/_helpers/unused.ts': 'export const unused = 1;',
      'tests/e2e/widget.spec.ts': "import { unused } from './_helpers/unused';",
    };
    const result = laneModules(Object.keys(tree), (f) => tree[f]!, {
      testDir: 'tests/e2e',
      testMatch: ['**/acceptance*.spec.ts'],
    });
    expect(result.specs).toEqual(['tests/e2e/acceptance-a.spec.ts']);
    expect(result.reached).toEqual([
      'tests/e2e/_helpers/deep.ts',
      'tests/e2e/_helpers/seed.ts',
      'tests/e2e/acceptance-a.spec.ts',
    ]);
  });
});
