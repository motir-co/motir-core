// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { useState } from 'react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Modal } from '@/components/ui/Modal';

afterEach(cleanup);

const OPTIONS: ComboboxOption<string>[] = [
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
];

// Mirror the issue-list table's clipping wrapper (IssueListTable.tsx:90 /
// TreeTable.tsx:448): a SHORT card with `overflow-hidden`. Before the fix the
// Combobox menu was an absolutely-positioned descendant of this card, so a short
// table clipped it (bug-inline-edit-clipped-when-table-short). The menu must now
// be portaled OUT of this overflow ancestor.
function Host() {
  const [value, setValue] = useState<string | null>('in_progress');
  return (
    <div data-testid="clip-card" className="overflow-hidden" style={{ height: 60 }}>
      <Combobox label="Status" options={OPTIONS} value={value} onChange={setValue} />
    </div>
  );
}

describe('Combobox — menu portaling (bug-inline-edit-clipped-when-table-short)', () => {
  it('renders the open menu outside the overflow-hidden ancestor (portaled to body)', () => {
    render(<Host />);
    const card = screen.getByTestId('clip-card');

    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));

    const listbox = screen.getByRole('listbox', { name: 'Status' });
    // The whole menu panel is the listbox's parent; it must NOT live inside the
    // clipping card, and it must be anchored with position:fixed (viewport
    // coords) rather than the old absolute-inside-the-scroller positioning.
    expect(card.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);

    const panel = listbox.parentElement as HTMLElement;
    expect(panel.style.position).toBe('fixed');
  });

  it('still commits a selection clicked inside the portaled menu', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));

    // A click lands on the portaled option; the click-outside guard must treat
    // the portaled menu as "inside" so it does not pre-close before commit.
    fireEvent.click(screen.getByRole('option', { name: 'Done' }));

    expect(screen.queryByRole('listbox')).toBeNull(); // menu closed after pick
    expect(screen.getByRole('combobox', { name: 'Status' }).textContent).toContain('Done');
  });

  // Regression for the E2E failure on PR #444: inside a focus-trapping dialog the
  // menu must render INLINE (a body-portaled menu lands outside the dialog's focus
  // scope → focus-trap war → unstable / un-clickable; and the dialog's centering
  // transform breaks a fixed child's viewport coords). Pickers in the create-issue
  // modal must keep working.
  function DialogHost() {
    const [value, setValue] = useState<string | null>('todo');
    return (
      // A focus-trapping Modal carries `data-surface="modal"` — the marker the
      // inline-vs-portal decision keys on (NOT bare `role="dialog"`, which a
      // non-modal Popover also sets; see the portal cases below).
      <div role="dialog" data-surface="modal">
        <Combobox label="Status" options={OPTIONS} value={value} onChange={setValue} />
      </div>
    );
  }

  it('renders inline (not portaled) inside a modal, and still commits', () => {
    render(<DialogHost />);
    const dialog = screen.getByRole('dialog');

    fireEvent.click(screen.getByRole('combobox', { name: 'Status' }));

    const listbox = screen.getByRole('listbox', { name: 'Status' });
    // Inline: the menu stays WITHIN the dialog subtree (not portaled to body).
    expect(dialog.contains(listbox)).toBe(true);
    expect((listbox.parentElement as HTMLElement).style.position).not.toBe('fixed');

    fireEvent.click(screen.getByRole('option', { name: 'In Progress' }));
    expect(screen.getByRole('combobox', { name: 'Status' }).textContent).toContain('In Progress');
  });

  // Regression for bug-combobox-menu-clipped-inside-modal: inside a Modal's
  // overflow-hidden panel the inline menu cannot escape, so a long option list
  // opened near the bottom of a short modal used to be CLIPPED (only the first
  // 1–2 options reachable — the Add-widget Statistic-type picker). The inline
  // menu must now CLAMP its listbox height to the dialog's available space and
  // FLIP above when that side is taller, so it always fits + scrolls internally.
  // happy-dom does no layout, so we drive getBoundingClientRect with explicit
  // rects to exercise the clamp geometry (the same posture as the swimlane /
  // detail-overflow geometry tests — measured, not CSS-asserted).
  function rect(top: number, bottom: number): DOMRect {
    return {
      top,
      bottom,
      left: 0,
      right: 360,
      width: 360,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  const TALL_OPTIONS: ComboboxOption<string>[] = Array.from({ length: 8 }, (_, i) => ({
    value: `s${i}`,
    label: `Statistic ${i}`,
  }));

  // A hard-clipping dialog panel = the centered Modal (`overflow-hidden`,
  // `data-surface="modal"` — the focus-trapping marker that keeps the menu inline).
  function TallDialogHost() {
    const [value, setValue] = useState<string | null>(null);
    return (
      <div role="dialog" data-surface="modal" style={{ overflowY: 'hidden' }}>
        <Combobox
          label="Statistic type"
          options={TALL_OPTIONS}
          value={value}
          onChange={setValue}
          searchable
        />
      </div>
    );
  }

  it('clamps the inline menu height + flips above when the modal clips it', () => {
    render(<TallDialogHost />);
    const dialog = screen.getByRole('dialog');
    const trigger = screen.getByRole('combobox', { name: 'Statistic type' });

    // A short modal (height 320) whose trigger sits in the lower half: ~76px
    // below the trigger inside the panel, ~188px above it. The unclamped 16rem
    // (256px) menu would overflow the panel's bottom edge and be clipped.
    dialog.getBoundingClientRect = () => rect(100, 420);
    trigger.getBoundingClientRect = () => rect(300, 332);

    fireEvent.click(trigger);
    // Re-measure with the mocked rects in place (the open-time layout effect ran
    // against happy-dom's zero rects; the resize listener recomputes).
    fireEvent.resize(window);

    const listbox = screen.getByRole('listbox', { name: 'Statistic type' });
    const panel = listbox.parentElement as HTMLElement;

    // Flipped ABOVE (188px > 76px) so it opens into the taller side…
    expect(panel.className).toContain('bottom-full');
    expect(panel.className).not.toContain('top-full');

    // …and clamped to fit that side (≤ the ~188px of room above the trigger),
    // with overflow-y-auto so it scrolls internally rather than being clipped.
    const maxH = parseInt(listbox.style.maxHeight, 10);
    expect(maxH).toBeGreaterThan(0);
    expect(maxH).toBeLessThanOrEqual(188);
    expect(listbox.className).toContain('overflow-y-auto');
  });

  // MOTIR-7655: the real Modal wraps its fields in `Modal.Body`, an
  // `overflow-y-auto` SCROLL box inside the hard-clipping, transformed panel.
  // An absolute menu there extended the body's scroll area and was cut at its
  // visible edge — on the short Add-a-model dialog only one option showed. The
  // menu must now lift out with `position: fixed` (laid out against the panel,
  // which the centring transform makes its containing block), stay in the
  // dialog's DOM, fit the panel, and never rise above the body's top (the
  // dialog header).
  function ScrollBodyDialogHost() {
    const [value, setValue] = useState<string | null>(null);
    return (
      <div
        role="dialog"
        data-surface="modal"
        data-testid="panel"
        style={{ overflowY: 'hidden', transform: 'translate(-50%, -50%)' }}
      >
        <div data-testid="body" style={{ overflowY: 'auto' }}>
          <Combobox
            label="Model"
            options={TALL_OPTIONS}
            value={value}
            onChange={setValue}
            searchable
          />
        </div>
      </div>
    );
  }

  function openIn(panelRect: DOMRect, bodyRect: DOMRect, triggerRect: DOMRect) {
    render(<ScrollBodyDialogHost />);
    screen.getByTestId('panel').getBoundingClientRect = () => panelRect;
    screen.getByTestId('body').getBoundingClientRect = () => bodyRect;
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    trigger.getBoundingClientRect = () => triggerRect;
    fireEvent.click(trigger);
    fireEvent.resize(window);
    const listbox = screen.getByRole('listbox', { name: 'Model' });
    return { listbox, menu: listbox.parentElement as HTMLElement };
  }

  it('lifts the menu out of a scrolling Modal.Body with fixed positioning, below the trigger', () => {
    // Panel 100–420; body 150–360; trigger near the body's top at 170–202.
    const { listbox, menu } = openIn(rect(100, 420), rect(150, 360), rect(170, 202));

    // Still INSIDE the dialog (focus scope, accessibility tree)…
    expect(screen.getByTestId('panel').contains(listbox)).toBe(true);
    // …but fixed, so the scroll body no longer clips it or grows a scrollbar.
    expect(menu.style.position).toBe('fixed');
    expect(menu.className).not.toContain('top-full');
    expect(menu.className).not.toContain('absolute');
    // Offsets are measured from the panel (the transformed containing block):
    // trigger bottom 202 + 4px gap − panel top 100.
    expect(menu.style.top).toBe('106px');
    expect(menu.style.minWidth).toBe('360px');
    // Clamped to the PANEL's room below the trigger (420 − 202 − 4 − 8 = 206),
    // not the body's (360 − 202): the menu may overlay the dialog footer.
    const maxH = parseInt(listbox.style.maxHeight, 10);
    expect(maxH).toBeGreaterThan(0);
    expect(maxH).toBeLessThanOrEqual(206);
  });

  it('flips above inside a scrolling Modal.Body without rising over the body top (the header)', () => {
    // Trigger low in the panel: 56px of room below it, 158px above it down to
    // the body's top (320 − 150 − 4 − 8).
    const { listbox, menu } = openIn(rect(100, 420), rect(150, 360), rect(320, 352));

    expect(menu.style.position).toBe('fixed');
    expect(menu.className).not.toContain('bottom-full');
    // Anchored by its bottom edge, measured from the panel's bottom (420):
    // 420 − (320 − 4) = 104.
    expect(menu.style.bottom).toBe('104px');
    expect(menu.style.top).toBe('');
    // The list fits the 158px above the trigger, so the menu's top stays at or
    // below the body's top and never covers the dialog header.
    const maxH = parseInt(listbox.style.maxHeight, 10);
    expect(maxH).toBeGreaterThan(0);
    expect(maxH).toBeLessThanOrEqual(158);
  });

  // MOTIR-11096: the real Modal panel is centred WITHOUT a transform, so it is
  // not the containing block of the lifted menu. The panel's overflow clip then
  // no longer bounds the menu: it may reach past the panel's bottom edge, down
  // to the viewport, and its offsets are measured from the viewport.
  function UntransformedPanelHost() {
    const [value, setValue] = useState<string | null>(null);
    return (
      <div role="dialog" data-surface="modal" data-testid="panel" style={{ overflowY: 'hidden' }}>
        <div data-testid="body" style={{ overflowY: 'auto' }}>
          <Combobox
            label="Model"
            options={TALL_OPTIONS}
            value={value}
            onChange={setValue}
            searchable
          />
        </div>
      </div>
    );
  }

  it('lets the lifted menu reach past an untransformed panel, bounded by the viewport', () => {
    render(<UntransformedPanelHost />);
    // Panel 100–420 (a short dialog); body 150–360; trigger 170–202.
    screen.getByTestId('panel').getBoundingClientRect = () => rect(100, 420);
    screen.getByTestId('body').getBoundingClientRect = () => rect(150, 360);
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    trigger.getBoundingClientRect = () => rect(170, 202);
    fireEvent.click(trigger);
    fireEvent.resize(window);
    const listbox = screen.getByRole('listbox', { name: 'Model' });
    const menu = listbox.parentElement as HTMLElement;

    expect(screen.getByTestId('panel').contains(listbox)).toBe(true);
    expect(menu.style.position).toBe('fixed');
    // No containing block: the offset is the viewport's, trigger bottom 202 + 4.
    expect(menu.style.top).toBe('206px');
    // The panel's room below the trigger is 420 − 202 − 4 − 8 = 206px; the
    // viewport's is far more, so the list grows past the panel to its cap.
    const maxH = parseInt(listbox.style.maxHeight, 10);
    expect(window.innerHeight - 202).toBeGreaterThan(400);
    expect(maxH).toBeGreaterThan(206);
    expect(maxH).toBe(320);
  });

  // MOTIR-1346: the Advanced-filter builder is a NON-modal anchored Popover
  // (role="dialog" but NO data-surface="modal") whose overflow-hidden panel +
  // inner overflow-y-auto scroll body CLIP an inline menu — the field/operator
  // menus were cut off at the popover edge. Because it does NOT trap focus, the
  // menu must PORTAL to <body> (escaping every clip), exactly as it does in a
  // table. Inline is reserved for true modals (the cases above).
  function PopoverDialogHost() {
    const [value, setValue] = useState<string | null>(null);
    return (
      // The Advanced-filter shape: an overflow-hidden popover whose body is an
      // overflow-y-auto SCROLL region. NO data-surface="modal" → portals.
      <div role="dialog" style={{ overflow: 'hidden' }}>
        <div style={{ overflowY: 'auto', maxHeight: 200 }}>
          <Combobox label="Operator" options={TALL_OPTIONS} value={value} onChange={setValue} />
        </div>
      </div>
    );
  }

  it('PORTALS the menu out of a non-modal popover-dialog so it escapes the clip (MOTIR-1346)', () => {
    render(<PopoverDialogHost />);
    const dialog = screen.getByRole('dialog');

    fireEvent.click(screen.getByRole('combobox', { name: 'Operator' }));

    const listbox = screen.getByRole('listbox', { name: 'Operator' });
    // Portaled to <body> — OUT of the clipping popover/scroll-body subtree.
    expect(dialog.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);
    expect((listbox.parentElement as HTMLElement).style.position).toBe('fixed');
  });

  // The triage promote-sprint / mark-duplicate shape: a non-modal `role="dialog"`
  // Popover (no data-surface="modal"). Same rule — it portals to <body>, the
  // proven escape these popovers already relied on (they carry overflowVisible so
  // an inline menu COULD render past the edge, but portaling is uniform + clip-proof).
  function OverflowVisibleDialogHost() {
    const [value, setValue] = useState<string | null>(null);
    return (
      <div role="dialog" style={{ overflow: 'visible' }}>
        <Combobox
          label="Sprint"
          options={TALL_OPTIONS}
          value={value}
          onChange={setValue}
          searchable
        />
      </div>
    );
  }

  it('PORTALS the menu out of a non-modal overflow-visible popover-dialog too (MOTIR-1346)', () => {
    render(<OverflowVisibleDialogHost />);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(screen.getByRole('combobox', { name: 'Sprint' }));

    const listbox = screen.getByRole('listbox', { name: 'Sprint' });
    expect(dialog.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);
  });
});

// ── autoOpen INSIDE a modal (MOTIR-2563) ─────────────────────────────────────
// The in-dialog branch used to be read during RENDER, on the stated invariant
// that "the only ref-null case is autoOpen, used solely by inline-edit cells
// (always in a table, never a dialog)". The quick-view peek's editable rail
// broke that: it opens a picker on mount INSIDE the modal. Because `useMounted`
// returns true on the first client render and its subscribe is a no-op, the
// ref-null read was never re-evaluated — the menu portaled to <body>, landed
// outside the dialog's focus scope, and every option became invisible to the
// accessibility tree (queryAllByRole('option') returned 0 of 5).
describe('Combobox — autoOpen inside a modal renders INLINE, not portaled', () => {
  function ModalHost() {
    const [value, setValue] = useState<string | null>('in_progress');
    return (
      <Modal open onOpenChange={() => {}} srTitle="Peek">
        <Combobox label="Status" options={OPTIONS} value={value} onChange={setValue} autoOpen />
      </Modal>
    );
  }

  it('keeps the menu inside the dialog so its options stay reachable', async () => {
    render(<ModalHost />);

    const listbox = await screen.findByRole('listbox', { name: 'Status' });
    // Inside the modal panel — a body-portaled menu loses the focus-trap war and
    // is mispositioned by the dialog's centring transform.
    expect(listbox.closest('[data-surface="modal"]')).not.toBeNull();
    // And every option is in the accessibility tree, not aria-hidden behind it.
    expect(screen.getAllByRole('option')).toHaveLength(OPTIONS.length);
  });
});
