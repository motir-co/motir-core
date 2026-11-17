import { useId, type ReactNode } from 'react';
import { Background } from '@motir/design-system';
import { OnboardingBrandBar } from './OnboardingBrandBar';

// The onboarding hero (MOTIR-8252) — Pattern B of
// `design/onboarding-entrance/onboarding-entrance--vibe-layout.mock.html`
// (MOTIR-8250, design-notes.md's "Hero ground", "Wave lines", "H1", "Lede" and
// "Idea control" rows). A FULL-WIDTH band — there is no centred card around it;
// the only width limits are the lede's measure and the control slot's.
//
//   ground   `--el-surface`, `relative isolate overflow-hidden`, so
//            the Wave's `absolute inset-0 -z-10` canvas (the design system's
//            `<Background id="wave">`, MOTIR-11608) stays inside the band
//   bar      `OnboardingBrandBar` at the top of the hero, on the hero ground
//            (design: "OnboardingHero (ground, lockup bar, waves)"); its
//            trailing slot is `barEnd` (the language control, MOTIR-8286)
//   rhythm   gutter `clamp(16px,3vw,48px)` · pt `clamp(40px,5vw,64px)` ·
//            pb `clamp(64px,8vw,104px)` · gap 22 px (18 narrow)
//   h1       `--font-serif` 700 · `clamp(48px,7.5vw,112px)` · lh 0.94 ·
//            -0.035em · `--el-text` · balanced
//   lede     500 · `clamp(17px,1.45vw,21px)` · max 62ch ·
//            `--el-accent-on-surface` (motir.co's hero lede ink — the design's
//            value; the card's draft said `--el-text-secondary`)
//   after    `afterLede` — the "See how Motir works" line (Panel 1), as given
//   control  slot `max-w 760px`, full width narrow; it carries `controlId`, the
//            element the wave lines gather around
//   waves    cropped, not dropped, at narrow widths: the field always fills the
//            band's box, so a phone sees the middle of the same field
//
// COMPACT (MOTIR-8254, design/onboarding-migrate § 2026-10-12 "The hero"): the
// wizard screens take the full hero only on a run's FIRST screen and this
// smaller one after every step advance, so the step stays above the fold —
// h1 56 px (34 narrow), lede 17 px (16 narrow), `pt-6 pb-12` (`pt-4 pb-8`
// narrow), the same ground and waves.
//
// Presentational: strings and nodes in, no `useTranslations`.

export interface OnboardingHeroProps {
  /** The page's one `h1`. */
  headline: ReactNode;
  /** The paragraph under the headline. */
  lede?: ReactNode;
  /**
   * A line under the lede, before the control — the entrance's "See how Motir
   * works" link (design Panel 1). Rendered as given.
   */
  afterLede?: ReactNode;
  /** The hero's control — the idea box on the entrance. Omitted on how-it-works. */
  children?: ReactNode;
  /**
   * The id the Wave gathers around. It is set on the control slot — or, with
   * no control, on the headline group, so the lines still have a focus.
   */
  controlId?: string;
  /** Draw the wave lines behind the hero. Default `true`. */
  waves?: boolean;
  /** Render the brand bar at the top of the hero. Default `true`. */
  brandBar?: boolean;
  /** The brand bar's trailing slot (e.g. the language control). */
  barEnd?: ReactNode;
  /** A whole bar to render in place of the default `OnboardingBrandBar` — the
   *  wizard screens pass theirs (flow name, exits, language, initial). */
  bar?: ReactNode;
  /** The compact variant — every wizard step after the first. Default `false`. */
  compact?: boolean;
}

export const ONBOARDING_HERO_CONTROL_ID = 'onboarding-hero-control';

export function OnboardingHero({
  headline,
  lede,
  afterLede,
  children,
  controlId = ONBOARDING_HERO_CONTROL_ID,
  waves = true,
  brandBar = true,
  barEnd,
  bar,
  compact = false,
}: OnboardingHeroProps) {
  const headingId = useId();
  const hasControl = children != null && children !== false;
  return (
    <section
      data-onboarding-hero={compact ? 'compact' : 'full'}
      aria-labelledby={headingId}
      className="relative isolate overflow-hidden bg-(--el-surface)"
    >
      {waves ? <Background id="wave" focusId={controlId} /> : null}
      {bar ?? (brandBar ? <OnboardingBrandBar>{barEnd}</OnboardingBrandBar> : null)}
      <div
        className={
          compact
            ? 'grid justify-items-center gap-2 px-[clamp(16px,3vw,48px)] pt-4 pb-8 text-center md:gap-3 md:pt-6 md:pb-12'
            : 'grid justify-items-center gap-[18px] px-[clamp(16px,3vw,48px)] pt-[clamp(40px,5vw,64px)] pb-[clamp(64px,8vw,104px)] text-center md:gap-[22px]'
        }
      >
        <div
          id={hasControl ? undefined : controlId}
          className={
            compact
              ? 'grid justify-items-center gap-2 md:gap-3'
              : 'grid justify-items-center gap-[18px] md:gap-[22px]'
          }
        >
          <h1
            id={headingId}
            className={
              (compact ? 'text-[34px] md:text-[56px]' : 'text-[clamp(48px,7.5vw,112px)]') +
              ' m-0 font-serif leading-[0.94] font-bold tracking-[-0.035em] text-balance text-(--el-text)'
            }
          >
            {headline}
          </h1>
          {lede != null ? (
            <p
              className={
                (compact ? 'text-[16px] md:text-[17px]' : 'text-[clamp(17px,1.45vw,21px)]') +
                ' m-0 max-w-[62ch] leading-normal font-medium text-balance text-(--el-accent-on-surface)'
              }
            >
              {lede}
            </p>
          ) : null}
          {afterLede != null ? <div>{afterLede}</div> : null}
        </div>
        {hasControl ? (
          <div id={controlId} className="mt-2 flex w-full max-w-[760px] text-left md:mt-[18px]">
            {children}
          </div>
        ) : null}
      </div>
    </section>
  );
}
