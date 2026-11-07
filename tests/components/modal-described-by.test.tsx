// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { Modal } from '@/components/ui/Modal';

// `@motir/design-system`'s Modal, the three props MOTIR-10544 added for the
// can't-plan alert (design MOTIR-10543 § "Accessibility contract"): `describedBy`
// adds ids to `aria-describedby` after the description's own, and
// `onOpenAutoFocus` / `onCloseAutoFocus` pass through to Radix. A Modal given
// none of them keeps Radix's own wiring, which the last case pins.

afterEach(cleanup);

describe('Modal describedBy', () => {
  it('names the description AND the extra ids, in that order', () => {
    render(
      <Modal open onOpenChange={() => {}} title="T" description="The lead" describedBy="extra">
        <p id="extra">More</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    const lead = screen.getByText('The lead');
    expect(lead.id).not.toBe('');
    expect(dialog.getAttribute('aria-describedby')).toBe(`${lead.id} extra`);
  });

  it('with no description it names the extra ids alone', () => {
    render(
      <Modal open onOpenChange={() => {}} title="T" describedBy="a b">
        <p id="a">A</p>
        <p id="b">B</p>
      </Modal>,
    );
    expect(screen.getByRole('dialog').getAttribute('aria-describedby')).toBe('a b');
  });

  it('without it Radix wires the description, and a dialog with neither opts out', () => {
    render(
      <Modal open onOpenChange={() => {}} title="T" description="The lead">
        <p>Body</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-describedby')).toBe(screen.getByText('The lead').id);
    cleanup();
    render(
      <Modal open onOpenChange={() => {}} title="T">
        <p>Body</p>
      </Modal>,
    );
    expect(screen.getByRole('dialog').hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('Modal focus pass-through', () => {
  function Harness({ onOpen, onClose }: { onOpen?: () => void; onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    const opener = useRef<HTMLButtonElement>(null);
    const safe = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={opener} onClick={() => setOpen(true)}>
          Open
        </button>
        <Modal
          open={open}
          onOpenChange={setOpen}
          title="T"
          hideClose
          onOpenAutoFocus={(e) => {
            onOpen?.();
            e.preventDefault();
            safe.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            onClose?.();
            e.preventDefault();
            opener.current?.focus();
          }}
        >
          <button>First</button>
          <button ref={safe} onClick={() => setOpen(false)}>
            Safe
          </button>
        </Modal>
      </>
    );
  }

  it('lands focus where the consumer says on open, and returns it on close', async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<Harness onOpen={onOpen} onClose={onClose} />);
    await act(async () => {
      fireEvent.click(screen.getByText('Open'));
    });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('Safe')));
    expect(onOpen).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByText('Safe'));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByText('Open'));
  });
});
