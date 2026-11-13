import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { ReactElement } from 'react';
import { analyticsEnabled, analyticsScriptSrc } from '@/lib/analytics';
import { AnalyticsScript } from '@/components/analytics/AnalyticsScript';

// MOTIR-1163 — product analytics: the SEAM, and the two things that must stay
// true about it (`docs/decisions/production-service-stack.md` §5).
//
// 1. ONE accessor answers "is analytics on, and what do we load", and the tag
//    is rendered from it — never inline at a call site. That is what makes a
//    future consent gate a one-file change instead of a hunt.
// 2. `PLAUSIBLE_SCRIPT_SRC` is a RUNTIME variable and stays one. The moment it
//    acquires a `NEXT_PUBLIC_` prefix or a `--build-arg`, `next build` inlines
//    it and analytics has manufactured the build-argument dependency §5 chose
//    Plausible to avoid. Nothing fails loudly when that happens, which is why
//    it is asserted here.
//
// The unset case is the one that matters most for a self-hoster: it is the
// difference between a self-hosted install and a telemetry client.

const ROOT = resolve(__dirname, '..');
const SRC_ROOTS = ['app', 'components', 'lib'] as const;
const SEAM_MODULE = 'lib/analytics.ts';
const ENV_VAR = 'PLAUSIBLE_SCRIPT_SRC';

const SCRIPT_URL = 'https://plausible.io/js/pa-aPdFklMzu4ec9tO43UzMI.js';

describe('analyticsScriptSrc / analyticsEnabled (MOTIR-1163)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the configured script URL when the variable is set', () => {
    vi.stubEnv(ENV_VAR, SCRIPT_URL);
    expect(analyticsScriptSrc()).toBe(SCRIPT_URL);
    expect(analyticsEnabled()).toBe(true);
  });

  it('an UNSET variable disables analytics — the self-host / dev path', () => {
    vi.stubEnv(ENV_VAR, undefined);
    expect(analyticsScriptSrc()).toBeNull();
    expect(analyticsEnabled()).toBe(false);
  });

  it('treats an EMPTY value as unset — a cleared secret must not render <script src="">', () => {
    vi.stubEnv(ENV_VAR, '');
    expect(analyticsScriptSrc()).toBeNull();
    expect(analyticsEnabled()).toBe(false);
  });

  it('treats a whitespace-only value as unset', () => {
    vi.stubEnv(ENV_VAR, '   ');
    expect(analyticsScriptSrc()).toBeNull();
  });

  it('trims surrounding whitespace off a configured URL', () => {
    vi.stubEnv(ENV_VAR, `  ${SCRIPT_URL}  `);
    expect(analyticsScriptSrc()).toBe(SCRIPT_URL);
  });
});

describe('<AnalyticsScript /> — the render path (MOTIR-1163)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders NOTHING when the variable is unset — no tag, so no analytics request', () => {
    vi.stubEnv(ENV_VAR, undefined);
    expect(AnalyticsScript()).toBeNull();
  });

  it('renders a deferred script carrying the configured URL when it is set', () => {
    vi.stubEnv(ENV_VAR, SCRIPT_URL);
    const element = AnalyticsScript() as ReactElement<{ src: string; defer: boolean }>;

    expect(element).not.toBeNull();
    expect(element.type).toBe('script');
    expect(element.props.src).toBe(SCRIPT_URL);
    expect(element.props.defer).toBe(true);
  });

  it('reads the environment at RENDER time, not at module load', () => {
    // The whole point of a runtime variable: the same loaded module answers
    // differently once the deployment's secret is set. A module-scope read
    // would freeze the first answer — which is exactly how `metadataBase`
    // froze the localhost fallback into the build (MOTIR-2505).
    vi.stubEnv(ENV_VAR, undefined);
    expect(AnalyticsScript()).toBeNull();
    vi.stubEnv(ENV_VAR, SCRIPT_URL);
    expect(AnalyticsScript()).not.toBeNull();
  });
});

/** Every `.ts`/`.tsx` source file under the given roots, repo-relative. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(relative(ROOT, full).split(sep).join('/'));
    }
  };
  for (const root of SRC_ROOTS) walk(join(ROOT, root));
  return out;
}

describe('the analytics seam is the ONE reader (MOTIR-1163)', () => {
  it('READS PLAUSIBLE_SCRIPT_SRC in exactly one source file', () => {
    // A READER names the variable AND reaches for `process.env`. Prose may
    // name it — `app/layout.tsx`'s comment does, and should, because the
    // reader of that file needs to know where the tag comes from. What must
    // stay singular is the lookup. The expected list is non-empty, so this
    // assertion also proves the walk found the seam rather than nothing.
    const readers = sourceFiles().filter((f) => {
      const src = readFileSync(join(ROOT, f), 'utf8');
      return src.includes(ENV_VAR) && src.includes('process.env');
    });

    expect(
      readers,
      `A second reader of ${ENV_VAR} is a second answer to the question ${SEAM_MODULE} ` +
        `exists to answer once — and the second place a consent gate would have to be added. ` +
        `Call analyticsScriptSrc() instead.`,
    ).toEqual([SEAM_MODULE]);
  });

  it('the root layout renders the tag through the component, not inline', () => {
    const layout = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8');
    expect(layout).toContain("from '@/components/analytics/AnalyticsScript'");
    expect(layout).toContain('<AnalyticsScript />');
  });

  it('the component reads the accessor rather than the environment', () => {
    const component = readFileSync(join(ROOT, 'components/analytics/AnalyticsScript.tsx'), 'utf8');
    expect(component).toContain("from '@/lib/analytics'");
    expect(component).not.toContain('process.env');
  });
});

/** A `build-args:` key — `[1]` its prefix up to the key's column (a sequence
 * entry's `- ` included), `[2]` whatever follows the colon. */
const BUILD_ARGS_KEY = /^(\s*(?:-\s+)?)build-args\s*:(.*)$/;
/** A block scalar header: `|` or `>`, with optional chomping/indentation indicators. */
const BLOCK_SCALAR_HEADER = /^[|>][-+0-9]*$/;

/**
 * Does this text carry a BUILD-TIME reference to the analytics variable — a
 * `NEXT_PUBLIC_` name, a Dockerfile `ARG`, a `--build-arg`, or an entry in a
 * workflow's `build-args:` input?
 *
 * Extracted so the assertions below can be shown to FIRE (the fixture test at
 * the end). A guard that asserts an ABSENCE passes just as green when its
 * detector matches nothing at all, so "no build argument names it" is exactly
 * the shape that would pass vacuously forever.
 *
 * ⚠️ AMENDED (MOTIR-1162): this paragraph used to rest that worry on there being
 * no build arguments AT ALL — "today's Dockerfile declares zero `ARG`s and
 * today's deploy passes zero `--build-arg`s". That is no longer true: MOTIR-1162
 * built the build-argument seam Sentry's browser DSN needs, so the `Dockerfile`
 * now declares five `ARG`s and the deploy passes five `--build-arg`s. The guard
 * is UNAFFECTED, and deliberately so — every line must name PLAUSIBLE before any
 * of the three shapes below is consulted, which is why the fixture test already
 * pins `ARG MOTIR_RELEASE` as a non-match. What changed is only that the
 * vacuity worry is now hypothetical rather than the tree's actual state; the
 * fixture test, not this sentence, is what answers it.
 *
 * ⚠️ AMENDED (MOTIR-11179): the three line shapes were written for the retired
 * Fly deploy, which passed `--build-arg` on a command line. `aws-deploy.yml`
 * hands its build arguments to `docker/build-push-action` as a YAML
 * `build-args:` input instead — one `NAME=value` per line of a block scalar,
 * with no `--build-arg` anywhere — so a PLAUSIBLE entry there matched none of
 * them and the guard passed vacuously on the real release lane. A line is now
 * ALSO a build-time reference when it carries a `build-args:` value: the
 * inline value on the key's own line, or any line of the block scalar under
 * the key. Per YAML, that block runs until the first non-blank line indented
 * no deeper than the key; blank lines inside it do not end it.
 */
function buildTimeAnalyticsReferences(text: string): string[] {
  let buildArgsKeyColumn: number | null = null;
  return text.split('\n').filter((line) => {
    const indent = line.length - line.trimStart().length;
    let isBuildArg = false;
    if (buildArgsKeyColumn !== null && (line.trim() === '' || indent > buildArgsKeyColumn)) {
      isBuildArg = true;
    } else {
      buildArgsKeyColumn = null;
      const key = BUILD_ARGS_KEY.exec(line);
      if (key) {
        const value = key[2]!.replace(/\s+#.*$/, '').trim();
        if (value === '' || BLOCK_SCALAR_HEADER.test(value)) {
          buildArgsKeyColumn = key[1]!.length;
        } else {
          isBuildArg = true;
        }
      }
    }
    if (!/PLAUSIBLE/i.test(line)) return false;
    return (
      isBuildArg ||
      /NEXT_PUBLIC_[A-Z0-9_]*PLAUSIBLE/i.test(line) ||
      /^\s*ARG\s/.test(line) ||
      /--build-arg/.test(line)
    );
  });
}

describe('PLAUSIBLE_SCRIPT_SRC stays a RUNTIME variable (MOTIR-1163)', () => {
  const buildInputs = ['Dockerfile', '.github/workflows/aws-deploy.yml'] as const;

  it.each(buildInputs)('%s carries no build-time reference to it', (file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(text.length).toBeGreaterThan(0);
    expect(
      buildTimeAnalyticsReferences(text),
      `${file} would inline the analytics URL at build time. §5 chose Plausible precisely ` +
        `because it needs no build argument; the tag renders server-side from a runtime ` +
        `secret. Wiring one here re-creates the dependency the choice avoided.`,
    ).toEqual([]);
  });

  it('no source file gives the variable a NEXT_PUBLIC_ prefix', () => {
    const offenders = sourceFiles().filter((f) =>
      /NEXT_PUBLIC_[A-Z0-9_]*PLAUSIBLE/i.test(readFileSync(join(ROOT, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the detector FIRES on a build-time reference — this guard is not vacuous', () => {
    expect(buildTimeAnalyticsReferences('ARG PLAUSIBLE_SCRIPT_SRC')).toHaveLength(1);
    expect(
      buildTimeAnalyticsReferences('run: docker build --build-arg PLAUSIBLE_SCRIPT_SRC=$X .'),
    ).toHaveLength(1);
    expect(
      buildTimeAnalyticsReferences('NEXT_PUBLIC_PLAUSIBLE_SCRIPT_SRC=https://example.test'),
    ).toHaveLength(1);
    // MOTIR-11179 — the shape aws-deploy.yml actually uses: an entry in the
    // `build-args:` block scalar handed to docker/build-push-action.
    const blockEntry = '            PLAUSIBLE_SCRIPT_SRC=${{ secrets.PLAUSIBLE_SCRIPT_SRC }}';
    expect(
      buildTimeAnalyticsReferences(
        [
          '          build-args: |',
          '            MOTIR_RELEASE=${{ github.sha }}',
          blockEntry,
          '          secrets: |',
        ].join('\n'),
      ),
    ).toEqual([blockEntry]);
    // …a blank line inside the block does not end it, and a sequence entry or a
    // chomping indicator on the header does not hide it…
    expect(
      buildTimeAnalyticsReferences(
        ['      - build-args: |-  # Sentry', '          MOTIR_RELEASE=x', '', blockEntry].join(
          '\n',
        ),
      ),
    ).toEqual([blockEntry]);
    // …nor a bare key whose value is a plain multi-line scalar…
    expect(
      buildTimeAnalyticsReferences(['build-args:', '  PLAUSIBLE_SCRIPT_SRC=$X'].join('\n')),
    ).toHaveLength(1);
    // …and neither does an inline value on the key's own line.
    expect(
      buildTimeAnalyticsReferences('          build-args: PLAUSIBLE_SCRIPT_SRC=$X'),
    ).toHaveLength(1);
    // …and stays quiet on the runtime forms that are correct.
    expect(buildTimeAnalyticsReferences('PLAUSIBLE_SCRIPT_SRC=https://example.test')).toEqual([]);
    expect(buildTimeAnalyticsReferences('ARG MOTIR_RELEASE')).toEqual([]);
    // A step's runtime `env:` after the block is NOT a build argument: the block
    // ends at the first line indented no deeper than its key.
    expect(
      buildTimeAnalyticsReferences(
        [
          '          build-args: |',
          '            MOTIR_RELEASE=${{ github.sha }}',
          '        env:',
          '          PLAUSIBLE_SCRIPT_SRC: ${{ secrets.PLAUSIBLE_SCRIPT_SRC }}',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});
