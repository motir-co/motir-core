// ⚠️ `@motir/design-system` IS LOADED LAZILY, in `designSeedFor`, never at the
// top of this file. This module sits under `lib/github/repoProvisioning.ts`, which
// `projectsService` and the other core services reach, and the package is
// ESM-only with no `require` export: a static import puts it in every E2E seed's
// graph, and Playwright's CommonJS loader then refuses the whole spec file
// (`No "exports" main defined`, the MOTIR-8477 note in
// `tests/e2e/_helpers/onboarding-github-connect-seed.ts`).
type DesignSystem = typeof import('@motir/design-system');

// THE PROJECT'S DESIGN CHOICE, AS THE FILES A SEEDED REPOSITORY CARRIES
// (Story MOTIR-704 · MOTIR-1529).
//
// A starter built on `@motir/design-system` ships `motir.design.json` at its root:
// the three axis ids its root layout reads into `resolveAxesToApplied` (the
// `[data-style]` / `[data-palette]` / `[data-type]` attributes) and into the
// no-flash init script, plus a background per page area (`backgrounds`, MOTIR-11607)
// that its landing page, hero and sign-in frame draw. That file IS the marker: a repository generated from a
// template that carries it wears the design system, and one that does not (the
// initialised entry, a foundation on another stack) is never touched. Nothing in
// Motir's registry has to be kept in step with which starters use the package.
//
// This module is pure. It turns the stored choice into the two files' content,
// resolving every id through the package's OWN registries, so no id-to-attribute
// table lives in motir-core. The GitHub write is `lib/github/repoProvisioning.ts`.

export const DESIGN_MANIFEST_PATH = 'motir.design.json';
export const DESIGN_NOTES_PATH = 'DESIGN.md';

/** A page area a project names a background for (the package's `BACKGROUND_AREAS`). */
export type DesignBackgroundArea = DesignSystem['BACKGROUND_AREAS'][number];

/** The three axes, and the per-area backgrounds, as the pre-plan session stores
 *  them: opaque strings, possibly stale (an id a later package release retired).
 *  `backgrounds` is absent on a choice saved before MOTIR-11607. */
export interface StoredDesignChoice {
  styleId: string;
  paletteId: string;
  typeId: string;
  backgrounds?: Partial<Record<DesignBackgroundArea, string>> | null;
}

export type DesignAxis = 'styleId' | 'paletteId' | 'typeId' | `backgrounds.${DesignBackgroundArea}`;

export interface DesignSeed {
  /** The ids the repository will carry — every axis a registered id, every
   *  background a registered id or `none`. */
  applied: {
    styleId: string;
    paletteId: string;
    typeId: string;
    backgrounds: Record<DesignBackgroundArea, string>;
  };
  /** The axes and background areas whose stored value was missing or unknown and
   *  fell back to the registry's default. Logged by the caller, never thrown. */
  fallbacks: DesignAxis[];
  /** The files the ONE design commit writes, in a stable order. */
  files: { path: string; content: string }[];
}

/**
 * Resolve a stored choice (or none) into the files a design-system repository
 * carries. A null choice and an unknown id both resolve to the registry default
 * for that axis; an unknown type follows the resolved style's default type,
 * exactly as the package resolves an unpinned type at runtime. Each background
 * area resolves through `resolveBackgroundChoice`: `none` stays `none`, a
 * registered id stays itself, and a missing or unknown one becomes the resolved
 * style's default background.
 */
export async function designSeedFor(choice: StoredDesignChoice | null): Promise<DesignSeed> {
  const ds = await import('@motir/design-system');
  const resolved = ds.resolveAxesToApplied({
    styleId: choice?.styleId ?? null,
    paletteId: choice?.paletteId ?? null,
    typeId: choice?.typeId ?? null,
  });
  const fallbacks: DesignAxis[] = [];
  if (!ds.isStyleId(choice?.styleId)) fallbacks.push('styleId');
  if (!ds.isPaletteId(choice?.paletteId)) fallbacks.push('paletteId');
  if (!ds.isTypeId(choice?.typeId)) fallbacks.push('typeId');

  const backgrounds = {} as Record<DesignBackgroundArea, string>;
  for (const area of ds.BACKGROUND_AREAS) {
    const stored = choice?.backgrounds?.[area];
    if (stored !== ds.BACKGROUND_NONE && !ds.isBackgroundId(stored)) {
      fallbacks.push(`backgrounds.${area}`);
    }
    backgrounds[area] = ds.resolveBackgroundChoice(stored, resolved.styleId);
  }
  const applied = {
    styleId: resolved.styleId,
    paletteId: resolved.paletteId,
    typeId: resolved.typeId,
    backgrounds,
  };

  return {
    applied,
    fallbacks,
    files: [
      { path: DESIGN_MANIFEST_PATH, content: `${JSON.stringify(applied, null, 2)}\n` },
      { path: DESIGN_NOTES_PATH, content: designNotes(ds, applied) },
    ],
  };
}

/** The short `DESIGN.md` a later agent run reads to learn the project's look. */
function designNotes(ds: DesignSystem, applied: DesignSeed['applied']): string {
  const rows: [string, string, string][] = [
    ['Style', applied.styleId, ds.resolveStyle(applied.styleId).name],
    ['Palette', applied.paletteId, ds.resolvePalette(applied.paletteId).name],
    ['Type', applied.typeId, ds.resolveType(applied.typeId).name],
  ];
  const areaNames: Record<DesignBackgroundArea, string> = {
    landing: 'Landing page',
    login: 'Login page',
    hero: 'Hero section',
  };
  const backgroundName = (id: string): string =>
    id === ds.BACKGROUND_NONE ? 'None (draws nothing)' : ds.resolveBackground(id).name;
  return [
    '# Design',
    '',
    "This project's look comes from Motir's three-axis design system, `@motir/design-system`.",
    `The ids below are the ones chosen for the project. They live in \`${DESIGN_MANIFEST_PATH}\`,`,
    'which the root layout applies to `<html>` as `data-style`, `data-palette` and `data-type`.',
    '',
    '| Axis | Id | Name |',
    '| --- | --- | --- |',
    ...rows.map(([axis, id, name]) => `| ${axis} | \`${id}\` | ${name} |`),
    '',
    `Each page area draws the background \`backgrounds\` names in \`${DESIGN_MANIFEST_PATH}\`,`,
    'through the package `Background` component (`none` draws nothing):',
    '',
    '| Area | Id | Background |',
    '| --- | --- | --- |',
    ...ds.BACKGROUND_AREAS.map(
      (area) =>
        `| ${areaNames[area]} | \`${applied.backgrounds[area]}\` | ${backgroundName(applied.backgrounds[area])} |`,
    ),
    '',
    `To change the look, set another registered id in \`${DESIGN_MANIFEST_PATH}\`. Build new`,
    'screens from the package primitives and its `--el-*` tokens, so they follow the choice.',
    '',
  ].join('\n');
}
