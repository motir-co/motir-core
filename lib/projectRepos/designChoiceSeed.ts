import {
  isPaletteId,
  isStyleId,
  isTypeId,
  resolveAxesToApplied,
  resolvePalette,
  resolveStyle,
  resolveType,
} from '@motir/design-system';

// THE PROJECT'S DESIGN CHOICE, AS THE FILES A SEEDED REPOSITORY CARRIES
// (Story MOTIR-704 · MOTIR-1529).
//
// A starter built on `@motir/design-system` ships `motir.design.json` at its root:
// the three axis ids its root layout reads into `resolveAxesToApplied` (the
// `[data-style]` / `[data-palette]` / `[data-type]` attributes) and into the
// no-flash init script. That file IS the marker: a repository generated from a
// template that carries it wears the design system, and one that does not (the
// initialised entry, a foundation on another stack) is never touched. Nothing in
// Motir's registry has to be kept in step with which starters use the package.
//
// This module is pure. It turns the stored choice into the two files' content,
// resolving every id through the package's OWN registries, so no id-to-attribute
// table lives in motir-core. The GitHub write is `lib/github/repoProvisioning.ts`.

export const DESIGN_MANIFEST_PATH = 'motir.design.json';
export const DESIGN_NOTES_PATH = 'DESIGN.md';

/** The three axes as the pre-plan session stores them: opaque strings, possibly
 *  stale (an id a later package release retired). */
export interface StoredDesignChoice {
  styleId: string;
  paletteId: string;
  typeId: string;
}

export type DesignAxis = 'styleId' | 'paletteId' | 'typeId';

export interface DesignSeed {
  /** The ids the repository will carry — every one a registered id. */
  applied: { styleId: string; paletteId: string; typeId: string };
  /** The axes whose stored id was missing or unknown and fell back to the
   *  registry's default. Logged by the caller, never thrown. */
  fallbacks: DesignAxis[];
  /** The files the ONE design commit writes, in a stable order. */
  files: { path: string; content: string }[];
}

/**
 * Resolve a stored choice (or none) into the files a design-system repository
 * carries. A null choice and an unknown id both resolve to the registry default
 * for that axis; an unknown type follows the resolved style's default type,
 * exactly as the package resolves an unpinned type at runtime.
 */
export function designSeedFor(choice: StoredDesignChoice | null): DesignSeed {
  const resolved = resolveAxesToApplied({
    styleId: choice?.styleId ?? null,
    paletteId: choice?.paletteId ?? null,
    typeId: choice?.typeId ?? null,
  });
  const applied = {
    styleId: resolved.styleId,
    paletteId: resolved.paletteId,
    typeId: resolved.typeId,
  };
  const fallbacks: DesignAxis[] = [];
  if (!isStyleId(choice?.styleId)) fallbacks.push('styleId');
  if (!isPaletteId(choice?.paletteId)) fallbacks.push('paletteId');
  if (!isTypeId(choice?.typeId)) fallbacks.push('typeId');

  return {
    applied,
    fallbacks,
    files: [
      { path: DESIGN_MANIFEST_PATH, content: `${JSON.stringify(applied, null, 2)}\n` },
      { path: DESIGN_NOTES_PATH, content: designNotes(applied) },
    ],
  };
}

/** The short `DESIGN.md` a later agent run reads to learn the project's look. */
function designNotes(applied: DesignSeed['applied']): string {
  const rows: [string, string, string][] = [
    ['Style', applied.styleId, resolveStyle(applied.styleId).name],
    ['Palette', applied.paletteId, resolvePalette(applied.paletteId).name],
    ['Type', applied.typeId, resolveType(applied.typeId).name],
  ];
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
    `To change the look, set another registered id in \`${DESIGN_MANIFEST_PATH}\`. Build new`,
    'screens from the package primitives and its `--el-*` tokens, so they follow the choice.',
    '',
  ].join('\n');
}
