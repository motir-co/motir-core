import { describe, expect, it } from 'vitest';
import { sectionSchemaService } from '@/lib/services/sectionSchemaService';
import { UnknownSectionCellError } from '@/lib/workItems/sections/errors';
import { describeSectionSets } from '@/lib/workItems/sections/registry';

describe('sectionSchemaService.describe', () => {
  it('returns the whole registry descriptor with no filter', () => {
    expect(sectionSchemaService.describe()).toEqual(describeSectionSets());
    expect(sectionSchemaService.describe({ kind: null, type: null })).toEqual(
      describeSectionSets(),
    );
  });

  it('narrows to one kind × type cell', () => {
    const { sets } = sectionSchemaService.describe({ kind: 'task', type: 'decision' });
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ kind: 'task', type: 'decision' });
    expect(sets[0]!.sections.filter((s) => s.required).map((s) => s.name)).toEqual(
      expect.arrayContaining(['decisionBrief', 'alternatives', 'consumers', 'framing']),
    );
    expect(sets[0]!.sections.filter((s) => s.required).map((s) => s.name)).not.toContain(
      'question',
    );
  });

  it('narrows to one kind', () => {
    const { sets } = sectionSchemaService.describe({ kind: 'epic' });
    expect(sets.length).toBeGreaterThan(0);
    expect(new Set(sets.map((s) => s.kind))).toEqual(new Set(['epic']));
  });

  it('a type alone returns that type’s cell for every kind', () => {
    const { sets } = sectionSchemaService.describe({ type: 'test' });
    expect(sets.map((s) => s.kind).sort()).toEqual(['bug', 'epic', 'story', 'subtask', 'task']);
    expect(new Set(sets.map((s) => s.type))).toEqual(new Set(['test']));
  });

  it('keeps the version and the catalogue on a narrowed answer', () => {
    const whole = describeSectionSets();
    const narrowed = sectionSchemaService.describe({ kind: 'story' });
    expect(narrowed.version).toBe(whole.version);
    expect(narrowed.sections).toEqual(whole.sections);
  });

  it('refuses an unknown kind, naming the value and the legal ones', () => {
    try {
      sectionSchemaService.describe({ kind: 'nope' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownSectionCellError);
      expect((err as UnknownSectionCellError).code).toBe('UNKNOWN_SECTION_CELL');
      expect((err as Error).message).toContain("'nope'");
      expect((err as Error).message).toContain('epic');
    }
  });

  it('refuses an unknown type, naming the value', () => {
    expect(() => sectionSchemaService.describe({ type: 'sorcery' })).toThrow(/'sorcery'/);
  });
});
