'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, Ban, RotateCcw } from 'lucide-react';
import {
  BACKGROUND_AREAS,
  BACKGROUND_IDS,
  BACKGROUND_NONE,
  BACKGROUND_REGISTRY,
  Background,
  defaultBackgroundForStyle,
  resolveBackgroundChoice,
  type AxisOption,
  type BackgroundArea,
  type BackgroundChoice,
} from '@motir/design-system';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StyleVignette } from '@/components/theme/StyleVignette';
import {
  AxisField,
  AxisNote,
  AxisRadioGroup,
  PalettePicker,
  StylePicker,
  ThemeSegmentedControl,
  TypePicker,
} from '@/components/theme/AppearancePickers';
import { DEFAULT_STYLE_ID, STYLE_REGISTRY, type StyleId } from '@/lib/theme/styles';
import {
  DEFAULT_PROJECT_PALETTE_ID,
  PALETTE_REGISTRY,
  isPaletteId,
  type PaletteId,
} from '@/lib/theme/palettes';
import { DEFAULT_TYPE_ID, TYPE_REGISTRY, type TypeId } from '@/lib/theme/typography';
import type { ThemePattern } from '@/lib/theme/types';
import type { DesignChoiceDTO } from '@/lib/dto/aiPreplan';

// The onboarding DESIGN STEP (Subtask 7.3.27 / MOTIR-1040) — screen H of
// `design/ai-chat/onboarding.mock.html`. The web-only step where the user designs
// THEIR NEW PROJECT's look on four controls — Theme (light/dark) × Style
// (shape/feel) × Palette (colour) × Type (typography).
//
// ⚠️ This designs the USER'S PROJECT, NOT Motir itself (Yue). So — unlike the
// account-settings Appearance pane, which themes Motir via the global `useTheme()`
// — this step holds its OWN local state and scopes it to THIS PAGE: the
// `data-theme/-style/-palette/-type` attributes sit on the design step's ROOT
// `<section>`, so the WHOLE wizard page restyles (header, pickers, the preview,
// the footer — the page IS the example, screen H), but ONLY this page. Nothing is
// written to `<html>`, so the hub and the rest of Motir stay exactly as they are.
// The page defaults to LIGHT regardless of Motir's own theme — the
// `[data-theme='light']` re-assertion block in globals.css lets the scoped subtree
// force light even when Motir is dark.
//
// The chosen design is local for now; persisting it to the user's project (the
// DESIGN.md starter) is the cross-repo handoff downstream (MOTIR-1041 / motir-ai).
// "Fine-tune" knobs (density/radius/motion) are a separate subtask (MOTIR-1246/47).
//
// The fifth field, Backgrounds (MOTIR-11618, design MOTIR-11615 —
// `design/ai-chat/onboarding--background-picker.mock.html`), picks what each page
// area of the project (landing page, login page, hero section) draws behind its
// content: one of the package's registered backgrounds, or None. Each chip leads
// with a still swatch of its background; the preview under the example draws the
// three choices live, in the step's scoped style, palette and theme. The choice is
// saved with the three axes (`DesignChoiceDTO.backgrounds`, MOTIR-11607).

export interface DesignStepProps {
  /** Leave the design step for the hub. */
  onBack: () => void;
  /** Confirm the look: hands the chosen three axes up so the caller can persist
   *  them (Subtask 7.3.81) and return to the hub. The Theme toggle is a preview
   *  mode, NOT part of the choice. */
  onUseDesign: (choice: DesignChoiceDTO) => void;
  /** The previously-saved choice (7.3.81) to RESTORE on re-entry — seeds the three
   *  axes so the step shows the saved look, not defaults. Null/undefined → defaults. */
  initialChoice?: DesignChoiceDTO | null;
}

export function DesignStep({ onBack, onUseDesign, initialChoice }: DesignStepProps) {
  const t = useTranslations('onboarding.design');

  // The PROJECT's design — local to this step, NOT the global Motir theme. Seeded
  // from the saved choice when re-entering (7.3.81), else the default PROJECT look —
  // `DEFAULT_PROJECT_PALETTE_ID`, the warm Amethyst, which is not Motir's own
  // default (MOTIR-6471).
  // Theme defaults to light (a preview mode, never persisted).
  const [pattern, setPattern] = useState<ThemePattern>('light');
  const [styleId, setStyleId] = useState<StyleId>(initialChoice?.styleId ?? DEFAULT_STYLE_ID);
  // A saved choice is restored only when its id is still registered: a choice
  // stored before a palette rename (MOTIR-6471's retired `graphite`) falls back
  // to the project default rather than stamping a dead `data-palette`.
  const [palette, setPalette] = useState<PaletteId>(
    isPaletteId(initialChoice?.paletteId) ? initialChoice.paletteId : DEFAULT_PROJECT_PALETTE_ID,
  );
  const [type, setType] = useState<TypeId>(initialChoice?.typeId ?? DEFAULT_TYPE_ID);
  // Per-area backgrounds. A saved choice is restored through
  // `resolveBackgroundChoice`, so a retired id falls back to the style's default
  // rather than drawing nothing; a choice saved before backgrounds existed opens
  // every area on that default.
  const [backgrounds, setBackgrounds] = useState<Record<BackgroundArea, BackgroundChoice>>(() =>
    initialBackgrounds(initialChoice?.backgrounds, initialChoice?.styleId ?? DEFAULT_STYLE_ID),
  );

  const themeLabels: Record<ThemePattern, string> = {
    light: t('theme.light'),
    dark: t('theme.dark'),
    system: t('theme.system'),
  };

  function resetToDefault() {
    setPattern('light');
    setStyleId(DEFAULT_STYLE_ID);
    setPalette(DEFAULT_PROJECT_PALETTE_ID);
    setType(DEFAULT_TYPE_ID);
    setBackgrounds(initialBackgrounds(undefined, DEFAULT_STYLE_ID));
  }

  // The page's scoped axis attributes — applied to the design step's ROOT section
  // ONLY, so the WHOLE wizard page wears the chosen design, never Motir. `system`
  // carries no data-theme (the page then follows the OS like a real app would);
  // light/dark force it (the [data-theme='light'] block re-asserts light under a
  // dark Motir).
  const pageAttrs: Record<string, string> = {
    // `data-appearance-scope` re-emits the --el-* layer locally so the overridden
    // --color-* (from the axes below) actually reaches the tokens components read —
    // see globals.css. Without it, only :root's --el-* (Motir's) would apply.
    'data-appearance-scope': '',
    'data-style': styleId,
    'data-palette': palette,
    'data-type': type,
  };
  if (pattern !== 'system') pageAttrs['data-theme'] = pattern;

  return (
    <section
      {...pageAttrs}
      data-testid="design-page"
      className="flex h-full min-h-0 flex-col bg-(--el-surface)"
      aria-label={t('title')}
    >
      {/* Step bar — Motir's own chrome (NOT scoped). Carries the page title (no
          internal "pre-plan" jargon). */}
      <div className="flex flex-none items-center gap-3 border-b border-(--el-border) px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<ArrowLeft className="size-4" />}
          onClick={onBack}
        >
          {t('back')}
        </Button>
        <h1 className="grow font-serif text-base font-semibold text-(--el-text)">{t('title')}</h1>
      </div>

      {/* Body — two columns that fill the width (no centered gutters): the
          controls on the LEFT (own scroll), the live example on the RIGHT (own
          scroll), so changing a control never scrolls the example out of view.
          Stacks below lg. */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* LEFT — the controls. */}
        <div className="min-h-0 overflow-y-auto px-6 py-6 lg:w-[28rem] lg:shrink-0 lg:border-r lg:border-(--el-border)">
          <p className="text-sm text-(--el-text-secondary)">{t('lead')}</p>

          {/* The four controls — they drive the LOCAL project design. */}
          <div className="mt-5 flex flex-col">
            <AxisField
              name={t('theme.name')}
              help={t('theme.help')}
              note={t(`theme.note.${pattern}`)}
            >
              <ThemeSegmentedControl
                value={pattern}
                onChange={setPattern}
                label={t('theme.name')}
                labels={themeLabels}
              />
            </AxisField>

            <AxisField
              name={t('style.name')}
              help={t('style.help')}
              note={
                <AxisNote
                  name={STYLE_REGISTRY[styleId].name}
                  tagline={STYLE_REGISTRY[styleId].tagline}
                />
              }
            >
              <StylePicker value={styleId} onChange={setStyleId} label={t('style.name')} />
            </AxisField>

            <AxisField
              name={t('palette.name')}
              help={t('palette.help')}
              note={
                <AxisNote
                  name={PALETTE_REGISTRY[palette].name}
                  tagline={PALETTE_REGISTRY[palette].tagline}
                />
              }
            >
              <PalettePicker value={palette} onChange={setPalette} label={t('palette.name')} />
            </AxisField>

            <AxisField
              name={t('type.name')}
              help={t('type.help')}
              note={
                <AxisNote name={TYPE_REGISTRY[type].name} tagline={TYPE_REGISTRY[type].tagline} />
              }
            >
              <TypePicker value={type} onChange={setType} label={t('type.name')} />
            </AxisField>

            <AxisField name={t('background.name')} help={t('background.help')}>
              <div className="flex flex-col">
                {BACKGROUND_AREAS.map((area) => (
                  <BackgroundAreaRow
                    key={area}
                    area={area}
                    value={backgrounds[area]}
                    styleName={STYLE_REGISTRY[styleId].name}
                    onChange={(value) => setBackgrounds((prev) => ({ ...prev, [area]: value }))}
                  />
                ))}
              </div>
            </AxisField>
          </div>
        </div>

        {/* RIGHT — the live example, always in view while you edit. A concrete
            product surface (the 7.3.37 specimen) framed as an app window, in the
            chosen design (inherits the section's scoped axes). */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-(--el-surface-soft) px-6 py-6">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-(--el-text-secondary)">
            {t('example.eyebrow')}
          </p>
          <div className="mt-2.5 overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg)">
            {/* faux window chrome — three dots + the project's accent bar */}
            <div className="flex items-center gap-2 border-b border-(--el-border) bg-(--el-surface) px-4 py-2.5">
              <span className="size-3 rounded-full bg-(--el-danger)" aria-hidden />
              <span className="size-3 rounded-full bg-(--el-warning)" aria-hidden />
              <span className="size-3 rounded-full bg-(--el-success)" aria-hidden />
              <span
                className="ml-3 h-4 w-40 rounded-(--radius-badge) bg-(--el-muted)"
                aria-hidden
              />
            </div>
            <div className="p-6 lg:p-8">
              <StyleVignette label={t('example.label')} className="w-full" />
            </div>
          </div>

          <p className="mt-6 text-[11px] font-semibold uppercase tracking-wide text-(--el-text-secondary)">
            {t('background.previewEyebrow')}
          </p>
          <div className="mt-2.5 grid grid-cols-1 gap-3 xl:grid-cols-3">
            {BACKGROUND_AREAS.map((area) => (
              <BackgroundPreview key={area} area={area} value={backgrounds[area]} />
            ))}
          </div>
        </div>
      </div>

      {/* Footer — pinned (outside the scroll area). Motir's chrome. */}
      <div className="flex flex-none flex-wrap items-center gap-3 border-t border-(--el-border) bg-(--el-surface) px-4 py-3">
        <span className="text-xs text-(--el-text-secondary)">{t('footerNote')}</span>
        <span className="grow" />
        <Button
          variant="ghost"
          leftIcon={<RotateCcw className="size-4" />}
          onClick={resetToDefault}
        >
          {t('reset')}
        </Button>
        <Button
          variant="primary"
          rightIcon={<ArrowRight className="size-4" />}
          onClick={() => onUseDesign({ styleId, paletteId: palette, typeId: type, backgrounds })}
        >
          {t('use')}
        </Button>
      </div>
    </section>
  );
}

/** Every area's opening choice: the saved one where there is one, else the style's default. */
function initialBackgrounds(
  saved: Partial<Record<BackgroundArea, unknown>> | undefined,
  styleId: StyleId,
): Record<BackgroundArea, BackgroundChoice> {
  const out = {} as Record<BackgroundArea, BackgroundChoice>;
  for (const area of BACKGROUND_AREAS) {
    out[area] = saved
      ? resolveBackgroundChoice(saved[area], styleId)
      : defaultBackgroundForStyle(styleId);
  }
  return out;
}

/** A chip's leading still swatch — the background in miniature, drawn once. */
function BackgroundSwatch({ id }: { id: BackgroundChoice }) {
  if (id === BACKGROUND_NONE) {
    return (
      <span
        aria-hidden
        className="inline-flex h-4 w-7 shrink-0 items-center justify-center rounded-(--radius-badge) border border-dashed border-(--el-border-strong) bg-(--el-page-bg)"
      >
        <Ban className="size-2.5 text-(--el-text-secondary)" aria-hidden />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      data-background-swatch={id}
      className="relative isolate inline-block h-4 w-7 shrink-0 overflow-hidden rounded-(--radius-badge) border border-(--el-border) bg-(--el-page-bg)"
    >
      <Background id={id} still />
    </span>
  );
}

/** One page area's chip row: the seven backgrounds in registry order, then None. */
function BackgroundAreaRow({
  area,
  value,
  styleName,
  onChange,
}: {
  area: BackgroundArea;
  value: BackgroundChoice;
  styleName: string;
  onChange: (value: BackgroundChoice) => void;
}) {
  const t = useTranslations('onboarding.design.background');
  const label = t(`areas.${area}`);
  const options: AxisOption<BackgroundChoice>[] = [
    ...BACKGROUND_IDS.map((id) => ({
      id,
      label: BACKGROUND_REGISTRY[id].name,
      leading: <BackgroundSwatch id={id} />,
    })),
    { id: BACKGROUND_NONE, label: t('none'), leading: <BackgroundSwatch id={BACKGROUND_NONE} /> },
  ];
  return (
    <div className="flex flex-col gap-2 py-2 first:pt-0">
      <span className="text-xs font-semibold text-(--el-text-secondary)">{label}</span>
      <AxisRadioGroup label={label} value={value} onChange={onChange} options={options} />
      <p className="text-xs leading-relaxed text-(--el-text-secondary)">
        {value === BACKGROUND_NONE ? (
          t('noneNote')
        ) : (
          <>
            <AxisNote
              name={BACKGROUND_REGISTRY[value].name}
              tagline={BACKGROUND_REGISTRY[value].description}
            />{' '}
            {BACKGROUND_REGISTRY[value].followsStyle
              ? t('followsNote', { style: styleName })
              : t('fixedNote')}
          </>
        )}
      </p>
    </div>
  );
}

/** One area's live preview: its background behind a stand-in for the area's content. */
function BackgroundPreview({ area, value }: { area: BackgroundArea; value: BackgroundChoice }) {
  const t = useTranslations('onboarding.design.background');
  const focusId = useId();
  const caption = `${t(`areas.${area}`)} · ${
    value === BACKGROUND_NONE ? t('previewNone') : BACKGROUND_REGISTRY[value].name
  }`;
  return (
    <figure className="flex min-w-0 flex-col gap-1.5" data-background-preview={area}>
      <div className="relative isolate flex h-[150px] items-center justify-center overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg)">
        <Background id={value} focusId={focusId} />
        <PreviewStandIn area={area} id={focusId} />
      </div>
      <figcaption className="text-xs text-(--el-text-secondary)">{caption}</figcaption>
    </figure>
  );
}

/**
 * The stand-in content each area's background gathers around / clears behind. It
 * is a picture of the area, not a control: `inert` keeps its button out of the tab
 * order and the accessibility tree, and the caption names what it shows.
 */
function PreviewStandIn({ area, id }: { area: BackgroundArea; id: string }) {
  const t = useTranslations('onboarding.design.background.standIn');
  if (area === 'landing') {
    return (
      <Card id={id} inert className="flex w-[190px] flex-col items-center gap-1 text-center">
        <p className="font-serif text-base font-semibold text-(--el-text)">{t('landingTitle')}</p>
        <p className="text-xs text-(--el-text-secondary)">{t('landingLead')}</p>
      </Card>
    );
  }
  if (area === 'login') {
    return (
      <Card id={id} inert className="flex w-[140px] flex-col gap-2">
        <p className="text-sm font-semibold text-(--el-text)">{t('loginTitle')}</p>
        <Button size="sm" variant="primary">
          {t('loginCta')}
        </Button>
      </Card>
    );
  }
  return (
    <Card id={id} inert className="w-[180px]">
      <p className="text-xs text-(--el-text-secondary)">{t('heroPrompt')}</p>
    </Card>
  );
}
