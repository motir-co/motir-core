// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';
import {
  ArtBar,
  ArtPaper,
  ONBOARDING_HERO_CONTROL_ID,
  OnboardingBrandBar,
  OnboardingHero,
  OnboardingLinkOut,
  OnboardingSection,
  SectionArt,
} from '@/components/onboarding/layout';

// MOTIR-8252 — the onboarding layout primitives, built to the Pattern panel of
// `design/onboarding-entrance/onboarding-entrance--vibe-layout.mock.html`
// (MOTIR-8250) and its Revision 1 parts (`SectionArt`, `OnboardingLinkOut`).
// The screen cards (MOTIR-8253, MOTIR-8251's code card, MOTIR-8286) compose
// these, so what is pinned here is the CONTRACT they compose against: the
// landmarks and headings, the slots, the wave wiring, and the token roles the
// design names. (happy-dom resolves no `var()` chain, so a token is asserted as
// the class the element carries — the contrast run is the integration gate's.)
//
// getByRole/getByText THROW when absent, so the query itself is the assertion.

afterEach(cleanup);

/** The class list of an element, for token-role assertions. */
function classes(el: Element): string[] {
  return (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

describe('OnboardingBrandBar — the lockup bar (Pattern A)', () => {
  it('renders the BrandMark lockup, linked home, named by its visible wordmark', () => {
    const { container } = render(<OnboardingBrandBar />);
    const bar = container.querySelector('header')!;
    expect(bar).not.toBeNull();

    // The link takes its name from the visible word — and carries no aria-label
    // of its own (design/brand §8, "never both").
    const home = screen.getByRole('link', { name: 'Motir' });
    expect(home.getAttribute('href')).toBe('/');
    expect(home.hasAttribute('aria-label')).toBe(false);

    // The real lockup at the Pattern panel's size, not the Sparkles stand-in.
    const lockup = home.querySelector('.brand-lockup') as HTMLElement;
    expect(lockup).not.toBeNull();
    expect(lockup.classList.contains('brand-quiet')).toBe(false);
    expect(lockup.classList.contains('brand-inv')).toBe(false);
    expect(lockup.style.getPropertyValue('--brand-size')).toBe('28px');
    const glyph = lockup.querySelector('svg')!;
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
    expect(glyph.querySelector('path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);
    expect(within(lockup).getByText('Motir').classList.contains('brand-word')).toBe(true);
    expect(container.querySelector('.lucide-sparkles')).toBeNull();
  });

  it('has no fill and no rule, and the Pattern panel’s padding (narrow, then md)', () => {
    const { container } = render(<OnboardingBrandBar />);
    const bar = classes(container.querySelector('header')!);
    expect(bar.some((c) => c.startsWith('bg-'))).toBe(false);
    expect(bar.some((c) => c.startsWith('border'))).toBe(false);
    expect(bar).toEqual(
      expect.arrayContaining([
        'justify-between',
        'px-4',
        'py-3',
        'md:px-(--spacing-card-padding)',
        'md:py-4',
      ]),
    );
  });

  it('inset="row" sits flush in a column the page pads, with the size it is given (MOTIR-8255)', () => {
    const { container } = render(<OnboardingBrandBar inset="row" size={24} linked={false} />);
    const bar = classes(container.querySelector('header')!);
    expect(bar).toContain('pb-4');
    expect(bar.some((c) => /^(md:)?p[xy]-/.test(c))).toBe(false);
    const lockup = container.querySelector('.brand-lockup') as HTMLElement;
    expect(lockup.style.getPropertyValue('--brand-size')).toBe('24px');
    expect(container.querySelector('a')).toBeNull();
  });

  it('puts its children in the trailing slot, after the lockup', () => {
    const { container } = render(
      <OnboardingBrandBar>
        <button type="button">Start from an idea instead</button>
      </OnboardingBrandBar>,
    );
    const bar = container.querySelector('header')!;
    const [first, second] = Array.from(bar.children);
    expect(first!.tagName).toBe('A');
    expect(second).toBe(screen.getByRole('button', { name: 'Start from an idea instead' }));
  });
});

describe('OnboardingHero — the full-width hero (Pattern B)', () => {
  it('renders the headline as the h1 in the serif face, the lede, and its control', () => {
    render(
      <OnboardingHero headline="Vibe the project" lede="You bring the idea." controlId="idea-box">
        <form aria-label="Idea">
          <textarea aria-label="What are you building?" />
        </form>
      </OnboardingHero>,
    );
    const h1 = screen.getByRole('heading', { level: 1, name: 'Vibe the project' });
    expect(classes(h1)).toEqual(
      expect.arrayContaining(['font-serif', 'font-bold', 'text-(--el-text)']),
    );
    // The lede wears motir.co's hero-lede ink, the design's role for it.
    const lede = screen.getByText('You bring the idea.');
    expect(lede.tagName).toBe('P');
    expect(classes(lede)).toContain('text-(--el-accent-on-surface)');
    screen.getByRole('textbox', { name: 'What are you building?' });

    // The hero is a labelled region named by its headline.
    screen.getByRole('region', { name: 'Vibe the project' });
  });

  it('draws the Wave gathered on controlId, inside a relative isolate band', () => {
    const { container } = render(
      <OnboardingHero headline="Vibe the project" controlId="idea-box">
        <span>control</span>
      </OnboardingHero>,
    );
    const hero = container.querySelector('[data-onboarding-hero]')!;
    expect(classes(hero)).toEqual(
      expect.arrayContaining(['relative', 'isolate', 'overflow-hidden', 'bg-(--el-surface)']),
    );
    const waves = hero.querySelectorAll('canvas[data-background="wave"]');
    expect(waves).toHaveLength(1);
    expect(waves[0]!.getAttribute('data-background-focus')).toBe('idea-box');
    expect(waves[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(classes(waves[0]!)).toEqual(
      expect.arrayContaining(['absolute', 'inset-0', '-z-10', 'pointer-events-none']),
    );
    // The element the lines gather around is the control slot, and it exists.
    const slot = container.querySelector('#idea-box')!;
    expect(slot.textContent).toBe('control');
  });

  it('draws no waves when waves is false', () => {
    const { container } = render(
      <OnboardingHero headline="How it works" waves={false}>
        <span>control</span>
      </OnboardingHero>,
    );
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('with no control, still gives the waves a focus: the headline group', () => {
    const { container } = render(<OnboardingHero headline="How it works" lede="Three beats." />);
    const canvas = container.querySelector('canvas[data-background="wave"]')!;
    expect(canvas.getAttribute('data-background-focus')).toBe(ONBOARDING_HERO_CONTROL_ID);
    const focus = container.querySelector(`#${ONBOARDING_HERO_CONTROL_ID}`)!;
    expect(focus.contains(screen.getByRole('heading', { level: 1 }))).toBe(true);
  });

  it('has no max-width centred card around the band', () => {
    const { container } = render(
      <OnboardingHero headline="Vibe the project" lede="Lede" afterLede={<a href="/x">More</a>}>
        <span>control</span>
      </OnboardingHero>,
    );
    const hero = container.querySelector('[data-onboarding-hero]')!;
    // The band itself, and every wrapper between it and the headline, is
    // full width. The only width limits are the lede's measure and the control
    // slot's — neither of which contains the headline.
    let node: Element | null = screen.getByRole('heading', { level: 1 }).parentElement;
    while (node && node !== hero.parentElement) {
      expect(classes(node).some((c) => /^max-w-/.test(c))).toBe(false);
      expect(classes(node)).not.toContain('mx-auto');
      node = node.parentElement;
    }
    // The control slot is capped at the design's 760 px.
    expect(classes(container.querySelector(`#${ONBOARDING_HERO_CONTROL_ID}`)!)).toContain(
      'max-w-[760px]',
    );
    // `afterLede` renders between the lede and the control.
    screen.getByRole('link', { name: 'More' });
  });

  it('carries the brand bar on the hero ground, with barEnd in its trailing slot', () => {
    const { container } = render(
      <OnboardingHero
        headline="Vibe the project"
        barEnd={<button type="button">English</button>}
      />,
    );
    const bar = container.querySelector('[data-onboarding-hero] header')!;
    expect(within(bar as HTMLElement).getByRole('link', { name: 'Motir' })).toBeTruthy();
    within(bar as HTMLElement).getByRole('button', { name: 'English' });
  });

  it('omits the brand bar when brandBar is false', () => {
    const { container } = render(<OnboardingHero headline="Vibe the project" brandBar={false} />);
    expect(container.querySelector('header')).toBeNull();
  });
});

describe('OnboardingSection — one section band (Pattern C)', () => {
  it('renders a full-width band with its title as a heading, its lede and its children', () => {
    const { container } = render(
      <OnboardingSection title="Already have a project?" lede="Motir reads your code.">
        <a href="/onboarding/migrate">We can vibe it too</a>
      </OnboardingSection>,
    );
    const band = screen.getByRole('region', { name: 'Already have a project?' });
    const h2 = screen.getByRole('heading', { level: 2, name: 'Already have a project?' });
    expect(classes(h2)).toEqual(expect.arrayContaining(['font-serif', 'text-(--el-text)']));
    expect(classes(screen.getByText('Motir reads your code.'))).toContain(
      'text-(--el-text-secondary)',
    );
    screen.getByRole('link', { name: 'We can vibe it too' });

    // Full width on the page ground, with the panel's divider role on top.
    expect(classes(band)).toEqual(
      expect.arrayContaining([
        'bg-(--el-page-bg)',
        'border-t',
        'border-(--el-border)',
        '[[data-section-band]+&]:border-(--el-border-soft)',
      ]),
    );
    expect(classes(band).some((c) => /^max-w-/.test(c))).toBe(false);
    expect(band.hasAttribute('id')).toBe(false);
    expect(container.querySelector('[data-section-art]')).toBeNull();
  });

  it('takes an id when given one', () => {
    render(<OnboardingSection id="import" title="Already have a project?" />);
    expect(screen.getByRole('region', { name: 'Already have a project?' }).id).toBe('import');
  });

  it('sets an art drawing beside the text in two equal columns', () => {
    const { container } = render(
      <OnboardingSection
        title="Say what you want"
        lede="A few sentences."
        art={
          <SectionArt tint="sky" name="say">
            <ArtBar width={88} />
          </SectionArt>
        }
      />,
    );
    const art = container.querySelector('[data-section-art="say"]')!;
    const grid = art.parentElement!;
    expect(classes(grid)).toEqual(
      expect.arrayContaining(['items-center', 'md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]']),
    );
    // The text column comes first (and so reads first; the drawing is hidden).
    expect(grid.firstElementChild!.contains(screen.getByRole('heading', { level: 2 }))).toBe(true);
    expect(grid.lastElementChild).toBe(art);
  });
});

describe('SectionArt — the drawing kit (Revision 1)', () => {
  it('is a decorative tinted field on the card tokens', () => {
    const { container } = render(
      <SectionArt tint="lavender" name="watch">
        <ArtPaper className="grid gap-2 p-2.5">
          <ArtBar width={58} />
        </ArtPaper>
      </SectionArt>,
    );
    const field = container.querySelector('[data-section-art="watch"]')!;
    expect(field.getAttribute('aria-hidden')).toBe('true');
    expect(classes(field)).toEqual(
      expect.arrayContaining([
        'bg-(--el-tint-lavender)',
        'rounded-(--radius-card)',
        'p-(--spacing-card-padding)',
        'shadow-(--shadow-card)',
        'border-(--el-border)',
        'h-[208px]',
        'md:h-[248px]',
      ]),
    );
    const paper = field.querySelector('[data-art-paper]')!;
    expect(classes(paper)).toEqual(
      expect.arrayContaining([
        'bg-(--el-card)',
        'border-(--el-border)',
        'shadow-(--shadow-subtle)',
        'p-2.5',
      ]),
    );
    const bar = paper.querySelector('[data-art-bar]') as HTMLElement;
    expect(bar.style.width).toBe('58%');
    expect(classes(bar)).toEqual(
      expect.arrayContaining(['bg-(--el-border-strong)', 'rounded-(--radius-badge)']),
    );
  });

  it('maps every tint slot to its own --el-tint-* token', () => {
    for (const tint of ['sky', 'lavender', 'peach', 'mint', 'rose', 'yellow'] as const) {
      const { container, unmount } = render(<SectionArt tint={tint} />);
      expect(classes(container.firstElementChild!)).toContain(`bg-(--el-tint-${tint})`);
      unmount();
    }
  });

  it('clamps a bar width into 0–100%', () => {
    const { container } = render(
      <>
        <ArtBar width={140} />
        <ArtBar width={-5} />
      </>,
    );
    const [over, under] = Array.from(container.querySelectorAll<HTMLElement>('[data-art-bar]'));
    expect(over!.style.width).toBe('100%');
    expect(under!.style.width).toBe('0%');
  });
});

describe('OnboardingLinkOut — the motir.co link-out band (Revision 1)', () => {
  it('renders a showcase field with a heading, body and ONE new-tab button', () => {
    const { container } = render(
      <OnboardingLinkOut
        title="How Motir works, for developers"
        body="motir.co walks through it module by module."
        cta="Read it on motir.co"
        href="https://motir.co/how-it-works"
        newTabLabel="(opens in a new tab)"
      />,
    );
    const field = screen.getByRole('region', { name: 'How Motir works, for developers' });
    expect(field.getAttribute('data-showcase')).toBe('field');
    expect(classes(field)).toEqual(
      expect.arrayContaining(['bg-(--el-showcase-field)', 'text-(--el-showcase-field-text)']),
    );
    screen.getByRole('heading', { level: 2, name: 'How Motir works, for developers' });
    screen.getByText('motir.co walks through it module by module.');

    const links = within(field).getAllByRole('link');
    expect(links).toHaveLength(1);
    // The sr-only hint is part of the accessible name.
    const cta = screen.getByRole('link', { name: 'Read it on motir.co (opens in a new tab)' });
    expect(cta.getAttribute('href')).toBe('https://motir.co/how-it-works');
    expect(cta.getAttribute('target')).toBe('_blank');
    expect(cta.getAttribute('rel')).toBe('noopener');
    expect(classes(cta)).toEqual(
      expect.arrayContaining([
        'bg-(--el-showcase-decision)',
        'text-(--el-showcase-decision-text)',
        'rounded-(--radius-btn)',
        'h-(--height-btn-lg)',
      ]),
    );
    expect(container.querySelector('.lucide-arrow-up-right')!.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });
});
