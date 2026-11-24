// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { StatusPill, statusPillTone } from '@/components/issues/StatusPill';
import { StatusValue } from '@/app/(authed)/items/_components/issueCellPrimitives';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';

// MOTIR-3103 — THE STATUS CHIP, RESOLVED BY STATUS AND NOT ONLY BY CATEGORY.
//
// The defect: `implemented` shares the `in_progress` lifecycle category with In
// Progress, Planning and In Review, and the chip was a per-CATEGORY map — so four
// statuses rendered a byte-identical `Pill` and the only thing telling them apart
// was the label. MOTIR-2999's acceptance criterion is the opposite: "a person can
// tell BUILT from READY FOR ME without reading the label."
//
// What is asserted here is the CLASS attribute rather than a screenshot, because
// that is what the tone actually is — a `Pill` variant string. The "does it look
// different" half is the design asset's job (`design/boards/implemented-column`),
// and this is the guard that keeps the code agreeing with it.

afterEach(cleanup);

/** The chip's rendered `<span>` — the Pill itself, not its text node. */
function chipFor(label: string): HTMLElement {
  return screen.getByText(label).closest('span')!;
}

describe('the tone is per-STATUS first, per-category second', () => {
  it('gives `implemented` its own tone, and no other default status takes it', () => {
    expect(statusPillTone('implemented', 'in_progress')).toBe('implemented');
    for (const status of DEFAULT_STATUSES) {
      if (status.key === 'implemented') continue;
      expect(statusPillTone(status.key, status.category)).not.toBe('implemented');
    }
  });

  it('falls back to the CATEGORY for every status without its own tone', () => {
    // The mapping every status had before this card, unchanged — including a
    // CUSTOM workflow's own key, which is the case the fallback exists for.
    expect(statusPillTone('todo', 'todo')).toBe('planned');
    expect(statusPillTone('blocked', 'todo')).toBe('planned');
    expect(statusPillTone('in_progress', 'in_progress')).toBe('in-progress');
    expect(statusPillTone('planning', 'in_progress')).toBe('in-progress');
    expect(statusPillTone('in_review', 'in_progress')).toBe('in-progress');
    expect(statusPillTone('done', 'done')).toBe('done');
    // ⚠️ NOT `done` — `cancelled` is the one status that opts OUT of its
    // category's hue (MOTIR-4782). It is `done`-category and means ABANDONED,
    // and the Workbench's Recently finished tab is the first surface that lists
    // the two together, where the accomplishment tint would be a false claim.
    expect(statusPillTone('cancelled', 'done')).toBeNull();
    expect(statusPillTone('needs_triage', 'todo')).toBe('planned');
  });

  it('resolves nothing for a status with no category — the neutral chip', () => {
    expect(statusPillTone('gone', null)).toBeNull();
    expect(statusPillTone(null, null)).toBeNull();
  });
});

describe('APPROVED — the second per-status tone (MOTIR-5141)', () => {
  it('gives `approved` its own tone, and no other default status takes it', () => {
    expect(statusPillTone('approved', 'in_progress')).toBe('approved');
    for (const status of DEFAULT_STATUSES) {
      if (status.key === 'approved') continue;
      expect(statusPillTone(status.key, status.category)).not.toBe('approved');
    }
  });

  it('renders Approved DIFFERENTLY from every status it shares a category with', () => {
    // The card's acceptance bar, as one assertion. `approved` sits in the
    // `in_progress` category beside four others; without its own tone a person
    // could not tell A PERSON SAID YES from NOBODY HAS LOOKED YET.
    render(
      <>
        <StatusPill statusKey="approved" category="in_progress" label="Approved" />
        <StatusPill statusKey="in_progress" category="in_progress" label="In Progress" />
        <StatusPill statusKey="planning" category="in_progress" label="Planning" />
        <StatusPill statusKey="in_review" category="in_progress" label="In Review" />
        <StatusPill statusKey="implemented" category="in_progress" label="Implemented" />
      </>,
    );
    const approved = chipFor('Approved').className;
    for (const label of ['In Progress', 'Planning', 'In Review', 'Implemented']) {
      expect(chipFor(label).className).not.toBe(approved);
    }
  });

  it('is distinct from DONE too — the pair the glyph exists to separate', () => {
    // `approved` and `done` are the two closest chips in the set at a 14% tint,
    // and they are the pair a reader is most likely to confuse: both mean yes.
    render(
      <>
        <StatusPill statusKey="approved" category="in_progress" label="Approved" />
        <StatusPill statusKey="done" category="done" label="Done" />
      </>,
    );
    expect(chipFor('Approved').className).not.toBe(chipFor('Done').className);
  });

  it('paints the Approved tint from the status token, never a literal', () => {
    render(<StatusPill statusKey="approved" category="in_progress" label="Approved" />);
    const className = chipFor('Approved').className;
    expect(className).toContain('var(--el-status-approved)');
    expect(className).toContain('var(--el-surface)');
    expect(className).toContain('text-(--el-text-strong)');
    expect(className).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(className).not.toMatch(/\brgba?\(/);
  });

  it('carries a glyph, aria-hidden, so the accessible name stays the LABEL', () => {
    render(<StatusPill statusKey="approved" category="in_progress" label="Approved" />);
    const chip = chipFor('Approved');
    const glyph = chip.querySelector('svg');
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute('aria-hidden')).toBe('true');
    expect(chip.textContent).toBe('Approved');
  });
});

describe('TO PLAN — the third per-status tone (MOTIR-12174)', () => {
  it('takes its own tone, not In Progress or Planning', () => {
    expect(statusPillTone('to_plan', 'in_progress')).toBe('to-plan');
    expect(statusPillTone('to_plan', 'in_progress')).not.toBe(
      statusPillTone('in_progress', 'in_progress'),
    );
  });

  it('paints from the status token and carries an aria-hidden glyph', () => {
    render(<StatusPill statusKey="to_plan" category="in_progress" label="To plan" />);
    const chip = chipFor('To plan');
    expect(chip.className).toContain('var(--el-status-to-plan)');
    expect(chip.className).toContain('text-(--el-text-strong)');
    expect(chip.className).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    const glyph = chip.querySelector('svg');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(chip.textContent).toBe('To plan');
  });
});

describe('the rendered chip', () => {
  it('renders Implemented DIFFERENTLY from the three statuses it shares a category with', () => {
    // The whole point of the card, as one assertion: four statuses, four chips
    // that are not all the same. `implemented` is the one that must differ.
    render(
      <>
        <StatusPill statusKey="implemented" category="in_progress" label="Implemented" />
        <StatusPill statusKey="in_progress" category="in_progress" label="In Progress" />
        <StatusPill statusKey="planning" category="in_progress" label="Planning" />
        <StatusPill statusKey="in_review" category="in_progress" label="In Review" />
      </>,
    );
    const implemented = chipFor('Implemented').className;
    for (const label of ['In Progress', 'Planning', 'In Review']) {
      expect(chipFor(label).className).not.toBe(implemented);
    }
    // …and the three that DID share a chip still do: this card added one tone, it
    // did not re-skin the ramp.
    expect(chipFor('Planning').className).toBe(chipFor('In Progress').className);
    expect(chipFor('In Review').className).toBe(chipFor('In Progress').className);
  });

  it('paints the Implemented tint from the status token, never a literal', () => {
    render(<StatusPill statusKey="implemented" category="in_progress" label="Implemented" />);
    const className = chipFor('Implemented').className;
    expect(className).toContain('var(--el-status-implemented)');
    expect(className).toContain('var(--el-surface)');
    expect(className).toContain('text-(--el-text-strong)');
    // No invented colour: the tint's only inputs are the two tokens above.
    expect(className).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(className).not.toMatch(/\brgba?\(/);
  });

  it('carries the CI-running glyph, aria-hidden, so the accessible name is the label', () => {
    render(<StatusPill statusKey="implemented" category="in_progress" label="Implemented" />);
    const chip = chipFor('Implemented');
    const glyph = chip.querySelector('svg');
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute('aria-hidden')).toBe('true');
    // A 14% tint is a quiet mark by construction, so the state is carried by text
    // + icon and never by colour alone (finding #35).
    expect(within(chip).getByText('Implemented')).toBeTruthy();
    expect(chip.textContent).toBe('Implemented');
  });

  it('gives no OTHER status a glyph — one status, one exception', () => {
    render(
      <>
        <StatusPill statusKey="in_review" category="in_progress" label="In Review" />
        <StatusPill statusKey="done" category="done" label="Done" />
      </>,
    );
    expect(chipFor('In Review').querySelector('svg')).toBeNull();
    expect(chipFor('Done').querySelector('svg')).toBeNull();
  });

  it('renders the neutral chip for a status the workflow cannot classify', () => {
    render(<StatusPill statusKey="deleted_status" category={null} label="deleted_status" />);
    const chip = chipFor('deleted_status');
    expect(chip.className).toContain('--el-chip-bg');
    expect(chip.querySelector('svg')).toBeNull();
  });

  it('carries a caller\u2019s layout class through BOTH the toned and the neutral chip', () => {
    // The callers that pass one are the dense surfaces — a relationships row and
    // a child row both need `shrink-0` on the chip or it squeezes to nothing.
    // It has to survive whichever branch the status resolves to.
    render(
      <>
        <StatusPill
          statusKey="implemented"
          category="in_progress"
          label="Implemented"
          className="shrink-0"
        />
        <StatusPill statusKey="gone" category={null} label="gone" className="shrink-0" />
      </>,
    );
    expect(chipFor('Implemented').className).toContain('shrink-0');
    expect(chipFor('gone').className).toContain('shrink-0');
    // …and it is ADDED to the tone, never a replacement for it.
    expect(chipFor('Implemented').className).toContain('var(--el-status-implemented)');
  });
});

describe('the list cell renders the same chip as everywhere else', () => {
  it('`StatusValue` delegates — a row and a detail page cannot disagree', () => {
    // The regression this prevents is the one the card exists for: six surfaces
    // each kept their own copy of the map, so a per-status tone added in one was
    // absent from five.
    const { container: cell } = render(
      <StatusValue statusKey="implemented" category="in_progress" label="Implemented" />,
    );
    const cellClass = cell.querySelector('span')!.className;
    cleanup();
    const { container: pill } = render(
      <StatusPill statusKey="implemented" category="in_progress" label="Implemented" />,
    );
    expect(cellClass).toBe(pill.querySelector('span')!.className);
  });

  it('a caller with no key still gets its category chip', () => {
    // `statusKey` is optional on purpose: a surface that genuinely does not hold
    // the key keeps working, with exactly the chip it had before.
    render(<StatusValue category="in_progress" label="In Progress" />);
    expect(chipFor('In Progress').className).toContain('--el-tint-sky');
  });
});
