// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion';

// The live `prefers-reduced-motion` read (MOTIR-8595), which `BrandMarkFlow` subscribes to.

function Probe() {
  return <span data-testid="reduced">{String(usePrefersReducedMotion())}</span>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('usePrefersReducedMotion', () => {
  it('reads the query, and follows a change while mounted', () => {
    let matches = false;
    const listeners = new Set<() => void>();
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (media: string) =>
        ({
          get matches() {
            return media.includes('reduce') && matches;
          },
          media,
          addEventListener: (_: string, cb: () => void) => listeners.add(cb),
          removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
        }) as unknown as MediaQueryList,
    );
    const r = render(<Probe />);
    expect(screen.getByTestId('reduced').textContent).toBe('false');
    act(() => {
      matches = true;
      listeners.forEach((cb) => cb());
    });
    expect(screen.getByTestId('reduced').textContent).toBe('true');
    r.unmount();
    expect(listeners.size).toBe(0);
  });

  it('is false where matchMedia does not exist', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<Probe />);
    expect(screen.getByTestId('reduced').textContent).toBe('false');
  });

  it('is false on the server', () => {
    expect(renderToString(<Probe />)).toContain('false');
  });
});
