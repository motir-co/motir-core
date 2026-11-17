import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_AREAS,
  BACKGROUND_DRAWERS,
  BACKGROUND_IDS,
  BACKGROUND_NONE,
  BACKGROUND_REGISTRY,
  DEFAULT_BACKGROUND_ID,
  STYLE_DEFAULT_BACKGROUND,
  STYLE_IDS,
  Background,
  defaultBackgroundForStyle,
  drawerFor,
  isBackgroundId,
  resolveBackground,
  resolveBackgroundChoice,
} from '../src/index';

// The registry loads through the PUBLIC package entry, like the axis registries.
describe('background registry', () => {
  it('lists exactly the seven backgrounds, in picker order', () => {
    expect(BACKGROUND_IDS).toEqual([
      'wave',
      'topography',
      'aurora',
      'cyclic',
      'brian',
      'daynight',
      'rule110',
    ]);
    for (const id of BACKGROUND_IDS) expect(BACKGROUND_REGISTRY[id].id).toBe(id);
  });

  it('declares which backgrounds follow the style', () => {
    const follows = BACKGROUND_IDS.filter((id) => BACKGROUND_REGISTRY[id].followsStyle);
    expect(follows).toEqual(['wave', 'topography']);
  });

  it('marks only the Wave as gathering around the focus instead of clearing behind it', () => {
    expect(BACKGROUND_IDS.filter((id) => BACKGROUND_REGISTRY[id].gathersAroundFocus)).toEqual([
      'wave',
    ]);
  });

  it('names the three page areas', () => {
    expect(BACKGROUND_AREAS).toEqual(['landing', 'login', 'hero']);
  });

  it('guards ids', () => {
    expect(isBackgroundId('aurora')).toBe(true);
    expect(isBackgroundId('none')).toBe(false);
    expect(isBackgroundId('constructor')).toBe(false);
    expect(isBackgroundId(7)).toBe(false);
  });

  it('resolves an unknown or missing id to the default without throwing', () => {
    expect(resolveBackground('lava-lamp').id).toBe(DEFAULT_BACKGROUND_ID);
    expect(resolveBackground(undefined).id).toBe('wave');
    expect(resolveBackground(null, 'neo-brutalism').id).toBe('wave');
    expect(resolveBackground('rule110').id).toBe('rule110');
  });

  it('gives every registered style the Wave unless its entry says otherwise', () => {
    for (const style of STYLE_IDS) {
      expect(defaultBackgroundForStyle(style)).toBe(STYLE_DEFAULT_BACKGROUND[style] ?? 'wave');
    }
    expect(defaultBackgroundForStyle('not-a-style')).toBe('wave');
    expect(defaultBackgroundForStyle()).toBe('wave');
  });

  it('honours a style default where one is set', () => {
    STYLE_DEFAULT_BACKGROUND['swiss-minimal-flat'] = 'topography';
    try {
      expect(resolveBackground('nope', 'swiss-minimal-flat').id).toBe('topography');
      expect(resolveBackgroundChoice(undefined, 'swiss-minimal-flat')).toBe('topography');
    } finally {
      delete STYLE_DEFAULT_BACKGROUND['swiss-minimal-flat'];
    }
  });

  it('keeps `none` as a choice, a known id as itself, and falls back otherwise', () => {
    expect(resolveBackgroundChoice(BACKGROUND_NONE)).toBe('none');
    expect(resolveBackgroundChoice('aurora')).toBe('aurora');
    expect(resolveBackgroundChoice('gone')).toBe('wave');
  });

  it('exports the drawing component and a drawer per drawn id', () => {
    expect(typeof Background).toBe('function');
    expect(drawerFor('aurora')).toBe(BACKGROUND_DRAWERS.aurora);
    for (const id of Object.keys(BACKGROUND_DRAWERS)) expect(isBackgroundId(id)).toBe(true);
  });
});
