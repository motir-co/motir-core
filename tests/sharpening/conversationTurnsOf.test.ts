import { describe, expect, it } from 'vitest';

import { conversationTurnsOf } from '@/lib/services/aiSharpenService';

// MOTIR-10235 — the WHOLE conversation a conversation grilling reads: both sides,
// in order, so a person's "yes" reads against the planner reply it agreed to.

describe('conversationTurnsOf', () => {
  it('names the person and the planner, keeps the order, and leaves out system markers and blank turns', () => {
    expect(
      conversationTurnsOf([
        { role: 'user', body: 'Add shared export presets' },
        { role: 'system', body: 'submitted' },
        { role: 'assistant', body: 'I could also add a preset picker to the toolbar.' },
        { role: 'assistant', body: '   ' },
        { role: 'user', body: 'yes, add that' },
      ]),
    ).toEqual([
      { role: 'person', body: 'Add shared export presets' },
      { role: 'planner', body: 'I could also add a preset picker to the toolbar.' },
      { role: 'person', body: 'yes, add that' },
    ]);
  });

  it('is empty for a conversation with nothing said', () => {
    expect(conversationTurnsOf([])).toEqual([]);
  });
});
