// @motir/design-system — public entry.
//
// This barrel re-exports the whole JS surface the ADR
// (docs/decisions/design-system-package.md §4) freezes as the package's public
// API: the three-axis registries, the theme-apply contract, the appearance
// types, the `cn` helper, the theme provider, and the framework-agnostic
// primitives. The token CSS ships separately as `@motir/design-system/theme.css`
// (a consumer's globals.css does `@import 'tailwindcss'; @import
// '@motir/design-system/theme.css';`).
//
// NOTE on the axis id re-exports: `StyleId` / `PaletteId` / `TypeId` are owned by
// the registry modules (`./theme/styles` etc.) and only *re-exported* by
// `./theme/types`. To keep them unambiguous at this barrel we `export *` the
// registries (their home) and export from `./theme/types` only the members it
// OWNS (the pattern axis + storage/defaults) — never the duplicated ids.

// ── Axis registries (own the axis ids) ──────────────────────────────────────
export * from './theme/styles';
export * from './theme/palettes';
export * from './theme/typography';
export * from './theme/fontSets';

// ── Pattern axis + storage/defaults (owned by ./theme/types) ─────────────────
export { THEME_STORAGE_KEYS, THEME_DEFAULTS, isThemePattern, resolvePattern } from './theme/types';
// Its own line: `test/barrel-rsc-safe.test.ts` reads dist/index.js line by line,
// and a re-export prettier wraps across lines no longer reads as one.
export { PALETTE_IDS_VERSION, PALETTE_ID_MIGRATION, migrateStoredPaletteId } from './theme/types';
export type { ThemePattern, ResolvedThemePattern } from './theme/types';

// ── The theme-apply contract (§4) ────────────────────────────────────────────
export * from './theme/init-script';
export * from './theme/appearance-resolution';
export * from './theme/tilt';

// ── Applied-appearance types (re-homed into the package) ─────────────────────
export * from './appearance';

// ── The classname helper ─────────────────────────────────────────────────────
export * from './utils/cn';
export * from './utils/fullscreen';

// ── Theme provider + pickers + preview specimen ──────────────────────────────
export * from './contexts/theme-context';
export * from './components/theme/AppearancePickers';
export * from './components/theme/StyleVignette';
export * from './components/theme/HandDrawnFilter';
export * from './components/theme/ImmersiveTilt';

// ── Framework-agnostic UI primitives ─────────────────────────────────────────
export * from './components/ui/Button';
export * from './components/ui/Card';
export * from './components/ui/Checkbox';
export * from './components/ui/Input';
export * from './components/ui/Textarea';
export * from './components/ui/FormField';
export * from './components/ui/Modal';
export * from './components/ui/Pill';
export * from './components/ui/Popover';
export * from './components/ui/DatePicker';
export * from './components/ui/Combobox';
export * from './components/ui/SectionLabel';
export * from './components/ui/Segmented';
export * from './components/ui/Switch';
export * from './components/ui/Spinner';
export * from './components/ui/Tooltip';
export * from './components/ui/Toast';
export * from './components/ui/EmptyState';
export * from './components/ui/ErrorState';
export * from './components/ui/MultiSelectPicker';
export * from './components/ui/ColorSwatchPicker';
// The DatePicker's date-format injection: the pure types/default/resolver
// (server-safe) and the client provider + hook, each its own chunk.
export * from './components/ui/datePickerFormat';
export * from './components/ui/DatePickerFormatContext';

// ── The isolation specimen (a live /tokens-style render) ─────────────────────
export * from './specimen/TokensSpecimen';
