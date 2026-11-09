'use client';

import { useRef, type CSSProperties, type ReactNode } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '../../utils/cn';
import { STYLE_IDS, STYLE_REGISTRY, type StyleId } from '../../theme/styles';
import { PALETTE_IDS, PALETTE_REGISTRY, type PaletteId } from '../../theme/palettes';
import { TYPE_IDS, TYPE_REGISTRY, type TypeId } from '../../theme/typography';
import type { ThemePattern } from '../../theme/types';

/**
 * The three-axis design-system PICKERS — the shared control vocabulary for
 * Motir's own appearance (the account-settings Appearance pane, 7.3.58) AND the
 * onboarding design wizard (7.3.27), which themes the user's OWN product with the
 * same axes. They are kept here, beside `StyleVignette` (the 7.3.37 specimen), so
 * the two surfaces share ONE implementation instead of forking the picker
 * language (the 7.3.58 "share the axis pickers" requirement).
 *
 * Every picker is CONTROLLED + presentational: it renders the chips from the
 * shipped registries (`lib/theme/{styles,palettes,typography}.ts`) and reports a
 * `value` / `onChange` — it does NOT read `theme-context`. Each consumer wires the
 * source of truth it owns: the Appearance pane wires `useTheme()` (so picking
 * re-skins Motir live via the localStorage → `<html>` bootstrap); the onboarding
 * wizard wires its own product-design state. Option NAMES + taglines come from the
 * registries (brand/style names, like the `/tokens` composer), so the pickers can
 * never drift from what the app can actually wear.
 *
 * Colour flows through `--el-*` only; chip / segmented shape flows through the
 * element-semantic shape tokens (`--radius-badge` / `--radius-btn`,
 * `--spacing-chip-*` / `--spacing-btn-x`, `--shadow-subtle`) so a `data-style`
 * swap reshapes them too (CLAUDE.md colour + shape rules). The mock of record is
 * `design/settings/appearance.mock.html` (7.3.57 / MOTIR-1074).
 */

// ── AxisField — the labelled wrapper around one axis control ────────────────
/**
 * One hairline-separated axis row: a name + helper head, the control, and a live
 * registry note showing the active selection. Matches the mock's `.axis-field`.
 */
export function AxisField({
  name,
  help,
  children,
  note,
}: {
  name: string;
  help: string;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="border-b border-(--el-border-soft) py-4 last:border-b-0">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-sm font-semibold text-(--el-text)">{name}</span>
        <span className="text-xs text-(--el-text-muted)">{help}</span>
      </div>
      {children}
      {note ? (
        <p className="mt-2.5 text-xs leading-relaxed text-(--el-text-muted)">{note}</p>
      ) : null}
    </div>
  );
}

/** A live registry note — the bolded active name followed by its tagline. */
export function AxisNote({ name, tagline }: { name: string; tagline: string }) {
  return (
    <>
      <span className="font-semibold text-(--el-text-secondary)">{name}</span> — {tagline}
    </>
  );
}

// ── AxisRadioGroup — a keyboard-navigable chip radiogroup ────────────────────
export interface AxisOption<T extends string> {
  id: T;
  /** Visible chip label. */
  label: string;
  /** Optional leading visual (e.g. a palette swatch dot) before the label. */
  leading?: ReactNode;
  /** Optional class on the label span (e.g. a per-type font scope). */
  labelClassName?: string;
  /** Optional inline style on the label span (e.g. a font-set member's face). */
  labelStyle?: CSSProperties;
  /** Optional content after the label inside the chip (e.g. a script sample). */
  detail?: ReactNode;
  /** Optional data-* attrs on the chip so it can preview that axis value. */
  scope?: Record<string, string>;
}

/**
 * A `role="radiogroup"` of `.pick`-style chips with roving-tabindex + arrow-key
 * navigation (the standard radiogroup interaction). Selecting moves focus too, so
 * arrow keys both change and focus the selection. Generic over the id union.
 */
export function AxisRadioGroup<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: AxisOption<T>[];
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function move(delta: number, from: number) {
    const next = (from + delta + options.length) % options.length;
    onChange(options[next]!.id);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((opt, i) => {
        const selected = opt.id === value;
        return (
          <button
            key={opt.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(opt.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(1, i);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(-1, i);
              }
            }}
            {...(opt.scope ?? {})}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-(--radius-badge) border',
              'px-(--spacing-chip-x) py-(--spacing-chip-y) text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
              selected
                ? 'border-(--el-accent) bg-(--el-tint-lavender) text-(--el-accent-on-surface)'
                : 'border-(--el-border) bg-(--el-page-bg) text-(--el-text-secondary) hover:border-(--el-border-strong) hover:text-(--el-text)',
            )}
          >
            {opt.leading}
            <span className={opt.labelClassName} style={opt.labelStyle}>
              {opt.label}
            </span>
            {opt.detail}
            {selected ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

// ── ThemeSegmentedControl — Light · Dark · System ────────────────────────────
const THEME_SEGMENTS: { id: ThemePattern; Icon: typeof Sun }[] = [
  { id: 'light', Icon: Sun },
  { id: 'dark', Icon: Moon },
  { id: 'system', Icon: Monitor },
];

/**
 * The light/dark/system base as a segmented control (the mock's `.segmented`).
 * `labels` maps each pattern to its translated chip text (the consumer owns i18n).
 */
export function ThemeSegmentedControl({
  value,
  onChange,
  label,
  labels,
}: {
  value: ThemePattern;
  onChange: (value: ThemePattern) => void;
  label: string;
  labels: Record<ThemePattern, string>;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function move(delta: number, from: number) {
    const next = (from + delta + THEME_SEGMENTS.length) % THEME_SEGMENTS.length;
    onChange(THEME_SEGMENTS[next]!.id);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex gap-[3px] rounded-(--radius-btn) border border-(--el-border) bg-(--el-muted) p-[3px]"
    >
      {THEME_SEGMENTS.map(({ id, Icon }, i) => {
        const selected = id === value;
        return (
          <button
            key={id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(1, i);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(-1, i);
              }
            }}
            className={cn(
              'inline-flex h-(--height-btn-sm) items-center gap-2 px-(--spacing-btn-x) text-sm font-medium',
              'rounded-[calc(var(--radius-btn)-2px)] border transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
              selected
                ? 'border-(--el-border) bg-(--el-page-bg) text-(--el-text) shadow-(--shadow-subtle)'
                : 'border-transparent text-(--el-text-secondary) hover:text-(--el-text)',
            )}
          >
            <Icon className={cn('size-4 shrink-0', selected && 'text-(--el-accent)')} aria-hidden />
            {labels[id]}
          </button>
        );
      })}
    </div>
  );
}

// ── The three registry-driven axis pickers ───────────────────────────────────
/** Style (shape/feel) — the 6-style chip row. */
export function StylePicker({
  value,
  onChange,
  label,
}: {
  value: StyleId;
  onChange: (value: StyleId) => void;
  label: string;
}) {
  const options: AxisOption<StyleId>[] = STYLE_IDS.map((id) => ({
    id,
    label: STYLE_REGISTRY[id].name,
  }));
  return <AxisRadioGroup label={label} value={value} onChange={onChange} options={options} />;
}

/**
 * Each palette's signature primary hue, hardcoded — the light-theme
 * `--color-primary-fill` of its `[data-palette]` block in `packages/design-system/theme.css`
 * (motir's is its near-black ink CTA; amethyst, the base, is the old purple). Used for the picker swatch so the dot
 * shows the palette's identity colour independent of the active theme/style.
 */
const PALETTE_SWATCH_HEX: Record<PaletteId, string> = {
  motir: '#1a1d21',
  amethyst: '#5645d4',
  cobalt: '#3650c2',
  evergreen: '#0c7a52',
  spectrum: '#5a37c9',
  amber: '#f0b90b',
  sienna: '#fa520f',
  garnet: '#c30021',
  citrine: '#ffd02f',
  candy: '#efbfdd',
  lagoon: '#0f667c',
  olive: '#4a5e26',
  contrast: '#953ea3',
};

/** Palette (colour) — the 10-palette chip row, each with its accent swatch dot. */
export function PalettePicker({
  value,
  onChange,
  label,
}: {
  value: PaletteId;
  onChange: (value: PaletteId) => void;
  label: string;
}) {
  const options: AxisOption<PaletteId>[] = PALETTE_IDS.map((id) => ({
    id,
    label: PALETTE_REGISTRY[id].name,
    // The dot's colour is HARDCODED (the palette's light-theme signature primary
    // — its `--color-primary-fill` in packages/design-system/theme.css), NOT a `data-palette`-scoped
    // `--el-accent`. The reason is THEME-INDEPENDENCE, and it is the whole of
    // the reason: a scoped `--el-accent` resolves under the ACTIVE theme, so the
    // dot would shift in dark mode, while this row is an identity legend — each
    // swatch must read as the palette's own hue whatever the page is wearing.
    // (This comment used to cite the StyleVignette nested-base caveat as a
    // second reason. That leak is closed on both axes — palette by
    // MOTIR-3933's `data-appearance-scope` re-emission, material by
    // MOTIR-3997's `@scope … to ([data-style])` limit — so a nested scope now
    // resolves its own tokens. The citation is retired; the swatch stays
    // hardcoded on the theme-independence reason alone.) The
    // `Record<PaletteId, …>` keeps it total — a new palette won't typecheck until
    // its swatch is added.
    leading: (
      <span
        className="size-[11px] shrink-0 rounded-full"
        style={{ background: PALETTE_SWATCH_HEX[id] }}
        aria-hidden
      />
    ),
  }));
  return <AxisRadioGroup label={label} value={value} onChange={onChange} options={options} />;
}

/** Typography — the 6-pairing chip row; each label set in its own headline face. */
export function TypePicker({
  value,
  onChange,
  label,
}: {
  value: TypeId;
  onChange: (value: TypeId) => void;
  label: string;
}) {
  const options: AxisOption<TypeId>[] = TYPE_IDS.map((id) => ({
    id,
    label: TYPE_REGISTRY[id].name,
    // The label scopes `data-type` to itself + uses the headline role, so the
    // chip previews the pairing's own headline face.
    scope: { 'data-type': id },
    labelClassName: 'font-serif',
  }));
  return <AxisRadioGroup label={label} value={value} onChange={onChange} options={options} />;
}
