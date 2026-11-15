// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { QuickViewKeyCopy } from '@/app/(authed)/items/_components/QuickViewKeyCopy';

// THE QUICK VIEW'S HEADER KEY COPIES IT (MOTIR-11351). The press writes the key
// to the clipboard and confirms with the success toast plus a Check glyph for two
// seconds; a refused clipboard says so with the error toast and shows no Check.
// The panel-level assertions (no link, no navigation, Open full page untouched)
// live in issue-quick-view.test.tsx.

const writeText = vi.fn(async (_text: string) => {});
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});
afterEach(() => {
  cleanup();
  writeText.mockReset();
  writeText.mockImplementation(async () => {});
  vi.useRealTimers();
});

function mount() {
  render(
    <ToastProvider>
      <QuickViewKeyCopy identifier="PROD-7" />
    </ToastProvider>,
  );
  return screen.getByTestId('quick-view-key-copy');
}

describe('QuickViewKeyCopy', () => {
  it('is a native button named "Copy <key>" that shows the key — so Enter and Space activate it', () => {
    const button = mount();
    // A native <button type="button"> is what gives Enter and Space activation
    // (HTML's own activation behaviour) and keyboard focus without a tabIndex;
    // the role query proves it is exposed as a button, not a link.
    expect(screen.getByRole('button', { name: 'Copy PROD-7' })).toBe(button);
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.textContent).toBe('PROD-7');
    expect(screen.queryByRole('link')).toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it('copies the key, confirms with the success toast and a Check for 2s', async () => {
    vi.useFakeTimers();
    const button = mount();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith('PROD-7');
    expect(screen.getByText('Copied PROD-7')).toBeTruthy();
    expect(button.getAttribute('data-copied')).toBe('true');
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(button.getAttribute('data-copied')).toBeNull();
  });

  it('a second press restarts the 2s confirmation instead of ending it early', async () => {
    vi.useFakeTimers();
    const button = mount();
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(button.getAttribute('data-copied')).toBe('true');
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(button.getAttribute('data-copied')).toBeNull();
  });

  it('a refused clipboard says so with the error toast, and shows no success or Check', async () => {
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
    const button = mount();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByText("Couldn't copy PROD-7 to the clipboard")).toBeTruthy();
    expect(screen.queryByText('Copied PROD-7')).toBeNull();
    expect(button.getAttribute('data-copied')).toBeNull();
  });

  it('no Clipboard API at all (an insecure context) is the same failure, not a crash', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const button = mount();
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByText("Couldn't copy PROD-7 to the clipboard")).toBeTruthy();
    expect(button.getAttribute('data-copied')).toBeNull();
  });

  it('unmounting during the confirmation clears its timer', async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const button = mount();
    await act(async () => {
      fireEvent.click(button);
    });
    clear.mockClear();
    cleanup();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });
});
