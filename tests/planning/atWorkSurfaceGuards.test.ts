import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COLOUR_ROLES,
  GATED,
  HOOKS,
  MESSAGE_KEYS,
  REPORTED,
  SPECS,
  STYLESHEETS,
  SURFACE,
} from '../helpers/atWorkStorySurface';

// THE AT-WORK STORY's STRUCTURAL SWEEPS (Story MOTIR-8413 · Subtask MOTIR-8418).
//
// The properties a coverage percentage cannot see, read off source text over the
// story's own ENUMERATED surface (`tests/helpers/atWorkStorySurface.ts`, the same
// list the coverage floor is built from). Static reads, deliberately: which module
// emits a class and which literal a declaration carries are invisible to a render
// — and happy-dom drops `@layer` rules and matches no reduced-motion query, so a
// render-side check of the CSS would pass while measuring nothing
// (`tests/theme/reducedMotionSpinner.test.ts`). The JS half of reduced motion and
// the rendered seam are `tests/integration/planning/atWorkStoryGate.test.tsx`'s.
//
// A member of the structural-guard lane: it imports no `lib/`, `app/` or
// `components/` module, binds no database and runs once, in `pnpm test:guards`.

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
/** Source with its comments blanked — a sweep rules on code, not on prose about it. */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** `{ body }` of every top-level-or-nested rule whose selector matches `test`. */
function rulesMatching(css: string, test: (selector: string) => boolean) {
  const out: { selector: string; body: string; media: string[] }[] = [];
  const stack: string[] = [];
  let i = 0;
  let start = 0;
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  while (i < noComments.length) {
    const ch = noComments[i];
    if (ch === '{') {
      const selector = noComments.slice(start, i).trim();
      if (selector.startsWith('@')) {
        stack.push(selector);
        start = i + 1;
      } else {
        const close = noComments.indexOf('}', i);
        if (test(selector)) {
          out.push({ selector, body: noComments.slice(i + 1, close), media: [...stack] });
        }
        i = close;
        start = close + 1;
      }
    } else if (ch === '}') {
      stack.pop();
      start = i + 1;
    } else if (ch === ';' && stack.length === 0) {
      start = i + 1;
    }
    i += 1;
  }
  return out;
}

const css = read('app/globals.css');
const isStorySelector = (s: string) =>
  s.includes(HOOKS.cueMotion) ||
  s.includes(HOOKS.markClass) ||
  (s.includes('.canvas-node--drafting') && !s.includes('.canvas-node--laying'));
/** The story's rules: the at-work / leaving / mark rules and the drafting colour. */
const storyRules = rulesMatching(css, isStorySelector).filter(
  (r) =>
    r.selector.includes(HOOKS.cueMotion) ||
    r.selector.includes(HOOKS.markClass) ||
    /--el-drafting/.test(r.body),
);
/** The keyframes the story added. */
const STORY_KEYFRAMES = [
  'canvas-cue-pop',
  'canvas-cue-grow',
  'canvas-cue-glow',
  'canvas-cue-settle',
  'canvas-cue-wash-out',
  // MOTIR-11254 (§31.4 T4): the wash lifting off a card that falls back to Thinking.
  'canvas-cue-wash-lift',
];
function keyframeBody(name: string): string {
  const at = css.indexOf(`@keyframes ${name} {`);
  if (at < 0) return '';
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  return '';
}

/** Is every entry a path on disk? The same predicate the real run uses. */
const missingPaths = (paths: readonly string[]) => paths.filter((p) => !existsSync(join(ROOT, p)));

describe('the enumeration is real', () => {
  it('every enumerated source, stylesheet and spec exists on disk', () => {
    expect(missingPaths([...SURFACE, ...SPECS])).toEqual([]);
  });

  it('the predicate rejects a path that does not exist — it cannot pass vacuously', () => {
    expect(missingPaths(['components/planning/NoSuchAtWorkFile.tsx'])).toEqual([
      'components/planning/NoSuchAtWorkFile.tsx',
    ]);
  });

  it('the coverage lane is built from this enumeration, not a copy of it', () => {
    const config = read('vitest.coverage.plan-at-work.config.ts');
    expect(config).toMatch(/from '\.\/tests\/helpers\/atWorkStorySurface'/);
    expect(config).toMatch(/include: \[\.\.\.SPECS\]/);
    expect(config).toMatch(/include: \[\.\.\.GATED, \.\.\.REPORTED\]/);
    expect(config).toMatch(/GATED\.map\(\(file\) => \[file, FLOOR\]\)/);
    expect(read('package.json')).toMatch(
      /"test:coverage:plan-at-work": "vitest run --config vitest\.coverage\.plan-at-work\.config\.ts --coverage"/,
    );
  });

  it('the enumeration module imports nothing', () => {
    expect(read('tests/helpers/atWorkStorySurface.ts')).not.toMatch(/^\s*import\s/m);
  });
});

describe("the lane's own patterns all resolve — no dead entry", () => {
  // The same picomatch / tinyglobby pair the coverage provider uses, resolved
  // THROUGH vitest's own node_modules (as `tests/helpers/coverageGate.ts` does for
  // the root gate, which reads the root config and so cannot be pointed here).
  const requireHere = createRequire(import.meta.url);
  const requireFromVitest = createRequire(requireHere.resolve('vitest'));
  const pm = requireFromVitest('picomatch') as (glob: string) => (p: string) => boolean;
  const { globSync } = requireFromVitest('tinyglobby') as {
    globSync: (patterns: string[], options: Record<string, unknown>) => string[];
  };
  const resolves = (pattern: string) => {
    const files = globSync([pattern], { cwd: ROOT, dot: true, onlyFiles: true });
    const match = pm(pattern);
    return files.filter((f) => match(f));
  };

  it('every include pattern and every threshold key reaches a file', () => {
    const dead = [...GATED, ...REPORTED].filter((p) => resolves(p).length === 0);
    expect(dead).toEqual([]);
  });

  it('a pattern that matches nothing is rejected by the same check', () => {
    expect(resolves('app/(authed)/no-such-route/page.tsx')).toEqual([]);
    expect(resolves('components/planning/PlanAtWorkMark.tsx')).toEqual([
      'components/planning/PlanAtWorkMark.tsx',
    ]);
  });
});

describe('one cue layer, no overlay-only copy', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const path = join(dir, entry);
      if (statSync(join(ROOT, path)).isDirectory()) walk(path, out);
      else if (/\.tsx$/.test(entry))
        out.push(relative(ROOT, join(ROOT, path)).split(sep).join('/'));
    }
    return out;
  };
  const sources = [...walk('components'), ...walk('app')];

  it('only PlanningCanvas emits the cue ring, the cue chip or the motion attribute', () => {
    const emitters = (needle: RegExp) => sources.filter((f) => needle.test(read(f))).sort();
    expect(emitters(/['"`]canvas-cue-ring['"`]/)).toEqual([
      'components/planning/PlanningCanvas.tsx',
    ]);
    expect(emitters(/canvas-cue-chip/)).toEqual(['components/planning/PlanningCanvas.tsx']);
    expect(emitters(/data-cue-motion=/)).toEqual(['components/planning/PlanningCanvas.tsx']);
  });

  it('only PlanAtWorkMark applies the mark hook, and only the rail mounts it', () => {
    expect(sources.filter((f) => read(f).includes(HOOKS.markClass))).toEqual([
      'components/planning/PlanAtWorkMark.tsx',
    ]);
    expect(sources.filter((f) => /<PlanAtWorkMark\b/.test(read(f)))).toEqual([
      'components/planning/PlanChangeRail.tsx',
    ]);
    expect(read('components/planning/PlanChangeRail.tsx').match(/<PlanAtWorkMark\b/g)).toHaveLength(
      1,
    );
  });
});

/** Split a shorthand on whitespace OUTSIDE parentheses. */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

describe('one duration and easing vocabulary', () => {
  // The three durations `lib/planning/canvasMotion.ts`'s `readDurations` resolves,
  // the canvas's two easings, and the ONE keyword the approved design adds.
  const DURATION =
    /^(var\(--transition-(fast|duration|slow)\)|calc\(var\(--transition-slow\) \* 6\))$/;
  const EASING = /^(var\(--canvas-ease-(enter|exit)\)|ease-in-out)$/;

  const animations = storyRules.flatMap((r) =>
    [...r.body.matchAll(/animation:\s*([^;]+);/g)].flatMap((m) =>
      m[1]!.split(/,(?![^(]*\))/).map((part) => part.trim().replace(/\s+/g, ' ')),
    ),
  );

  it('finds the story animations at all', () => {
    expect(animations.length).toBeGreaterThanOrEqual(6);
  });

  it('every animation names a story keyframe or a shipped one, a vocabulary duration and easing', () => {
    for (const a of animations) {
      const tokens = splitTopLevel(a);
      const [name, ...rest] = tokens;
      expect([...STORY_KEYFRAMES, 'canvas-cue-ring-enter', 'canvas-fade-out']).toContain(name);
      const durations = rest.filter((t) => /transition/.test(t));
      expect(durations.length, a).toBeGreaterThanOrEqual(1);
      for (const d of durations) expect(d, a).toMatch(DURATION);
      const easings = rest.filter((t) => /ease/.test(t));
      expect(easings, a).toHaveLength(1);
      expect(easings[0], a).toMatch(EASING);
      expect(a, a).not.toMatch(/\b\d+(\.\d+)?m?s\b/);
    }
  });

  it('no bare time literal and no other easing keyword in the story keyframes', () => {
    for (const k of STORY_KEYFRAMES) {
      const body = keyframeBody(k);
      expect(body, k).not.toBe('');
      expect(body, k).not.toMatch(/\b\d+(\.\d+)?m?s\b/);
      expect(body, k).not.toMatch(/cubic-bezier|\bease\b|linear|steps\(/);
    }
  });
});

describe('token-only colour', () => {
  const HEX = /#[0-9a-f]{3,8}\b/i;
  const LITERAL = /\b(rgb|rgba|hsl|hsla|oklch|lab)\(/i;

  it('no colour literal in the story rules or keyframes', () => {
    const bodies = [...storyRules.map((r) => r.body), ...STORY_KEYFRAMES.map(keyframeBody)];
    for (const b of bodies) {
      expect(b).not.toMatch(HEX);
      expect(b).not.toMatch(LITERAL);
      expect(b).not.toMatch(/var\(--color-/);
    }
  });

  it('no colour literal in the story-written components', () => {
    for (const f of GATED.filter((p) => p.endsWith('.tsx'))) {
      expect(read(f)).not.toMatch(HEX);
      expect(read(f)).not.toMatch(LITERAL);
    }
  });

  it('the two roles map to palette tokens only, in every block that declares them', () => {
    const theme = read('packages/design-system/theme.css');
    for (const role of COLOUR_ROLES) {
      const decls = [...theme.matchAll(new RegExp(`${role}:\\s*([^;]+);`, 'g'))].map((m) => m[1]!);
      expect(decls.length, role).toBeGreaterThanOrEqual(4);
      for (const d of decls) expect(d).toMatch(/^var\(--(el|color)-[a-z0-9-]+\)$/);
    }
  });
});

describe('no new dependency', () => {
  const pkg = JSON.parse(read('package.json')) as Record<string, Record<string, string>>;
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);

  it('every bare import on the enumerated surface is declared', () => {
    for (const f of [...GATED, ...REPORTED]) {
      const bare = [...read(f).matchAll(/from\s+'([^'.@][^']*|@[^/']+\/[^']+)'/g)]
        .map((m) => m[1]!)
        .filter((s) => !s.startsWith('@/'))
        .map((s) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]!));
      for (const name of bare) expect(declared.has(name), `${f} imports ${name}`).toBe(true);
    }
  });

  it('neither manifest carries an animation library', () => {
    const ds = JSON.parse(read('packages/design-system/package.json')) as Record<
      string,
      Record<string, string>
    >;
    const names = [
      ...declared,
      ...Object.keys(ds.dependencies ?? {}),
      ...Object.keys(ds.peerDependencies ?? {}),
    ];
    expect(
      names.filter((n) =>
        /^(framer-motion|motion|gsap|animejs|popmotion|@react-spring\/.*|react-spring|@motionone\/.*)$/.test(
          n,
        ),
      ),
    ).toEqual([]);
  });
});

describe('reduced motion — the stylesheet half', () => {
  it('every story animation sits inside the no-preference gate', () => {
    const animated = storyRules.filter((r) => /animation:/.test(r.body));
    expect(animated.length).toBeGreaterThanOrEqual(5);
    for (const r of animated) {
      expect(r.media, r.selector).toContain('@media (prefers-reduced-motion: no-preference)');
    }
  });

  it('the static colour form is drawn OUTSIDE any motion gate', () => {
    const colour = storyRules.filter(
      (r) => /--el-drafting/.test(r.body) && !/animation/.test(r.body),
    );
    expect(colour.length).toBeGreaterThanOrEqual(4);
    for (const r of colour) expect(r.media, r.selector).toEqual([]);
  });

  it('under reduce the leaving form shows no cue', () => {
    const reduce = storyRules.filter((r) =>
      r.media.includes('@media (prefers-reduced-motion: reduce)'),
    );
    expect(reduce.some((r) => /display:\s*none/.test(r.body))).toBe(true);
  });
});

describe('planner parity — the structural half', () => {
  const PRODUCER = /authorSource|harness|sessionId|turnCount|planningSource/;

  it('the mark takes the snapshot, failing and the stream flag, and never reads the steps', () => {
    const src = code('components/planning/PlanAtWorkMark.tsx');
    const props = /export interface PlanAtWorkMarkProps \{([\s\S]*?)\n\}/.exec(src)![1]!;
    const names = [...props.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
    expect(names).toEqual(['progress', 'failing', 'turnStreaming']);
    expect(src).not.toMatch(/\.steps\b/);
    expect(src).not.toMatch(PRODUCER);
    expect(src).not.toMatch(/\.state\b/);
  });

  it('the cue takes a moving flag and no producer-shaped input', () => {
    const canvas = read('components/planning/PlanningCanvas.tsx');
    const cue = /export interface NodeCue \{([\s\S]*?)\n\}/.exec(canvas)![1]!;
    expect([...cue.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1])).toEqual([
      'kind',
      'label',
      'text',
      'moving',
    ]);
    expect(cue).not.toMatch(PRODUCER);
  });

  it('neither canvas re-derives the answer: no readPlanAtWork, no failing, no state test', () => {
    for (const f of [
      'components/planning/PlanningCanvas.tsx',
      'components/planning/PlanReviewCanvas.tsx',
    ]) {
      const src = code(f);
      expect(src, f).not.toMatch(/readPlanAtWork|readPlanProgress|usePlanProgressReading/);
      expect(src, f).not.toMatch(/progressFailing|liveFailing/);
      expect(src, f).not.toMatch(/\.state\s*===\s*'(stalled|working|writing|starting|resuming)'/);
    }
  });

  it('readPlanAtWork is called in exactly the two clock owners', () => {
    const owners = [...GATED, ...REPORTED].filter((f) => /readPlanAtWork\(/.test(code(f))).sort();
    expect(owners).toEqual([
      'components/planning/PlanAtWorkMark.tsx',
      'components/planning/PlanProposalViews.tsx',
      'lib/plans/planProgress.ts',
    ]);
  });
});

describe('copy', () => {
  const lookup = (catalogue: unknown, key: string) =>
    key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], catalogue);

  it.each(['en', 'zh'])('every message key the surface reads resolves in %s', (locale) => {
    const catalogue = JSON.parse(read(`messages/${locale}.json`)) as unknown;
    for (const key of MESSAGE_KEYS) {
      expect(typeof lookup(catalogue, key), `${locale} ${key}`).toBe('string');
    }
  });

  it('the stylesheets list is what the sweeps read', () => {
    expect([...STYLESHEETS]).toEqual(['app/globals.css', 'packages/design-system/theme.css']);
  });
});
