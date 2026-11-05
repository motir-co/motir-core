// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  renderHook,
  screen,
} from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ChartFrameSvg } from '@/components/ui/charts/ChartFrameSvg';
import { PageChartFrame } from '@/components/ui/charts/PageChartFrame';
import { fitXTicks } from '@/components/ui/charts/fitXTicks';
import { useChartWidth } from '@/components/ui/charts/useChartWidth';
import { ReportWindowControls } from '@/app/(authed)/reports/_components/ReportWindowControls';
import { VelocityRangeControls } from '@/app/(authed)/reports/_components/VelocityRangeControls';
import {
  REPORT_HELP_HIDDEN_STORAGE_KEY,
  resetReportHelpHiddenForTests,
  useReportHelpHidden,
} from '@/lib/hooks/useReportHelpHidden';

// Story MOTIR-8919 · the story gate, case 14: the branches the feature cards'
// own suites leave open in the story's new files, so each can be pinned at the
// project floor. Each case names the branch it closes.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/reports/velocity',
}));

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto['hasPointerCapture'] = vi.fn(() => false);
  proto['setPointerCapture'] = vi.fn();
  proto['releasePointerCapture'] = vi.fn();
  proto['scrollIntoView'] = vi.fn();
});
beforeEach(() => push.mockClear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(() => vi.restoreAllMocks());

const tick = (value: number, label = String(value)) => ({ value, label });

describe('fitXTicks — the edges', () => {
  it('keeps one or two ticks as they are, flat', () => {
    const two = [tick(0), tick(1)];
    expect(fitXTicks({ ticks: two, xScale: (v) => v * 10 })).toEqual({ ticks: two, angle: 0 });
  });

  it('keeps every tick when they all sit at one position (no pitch to measure)', () => {
    const same = [tick(0), tick(1), tick(2), tick(3)];
    const out = fitXTicks({ ticks: same, xScale: () => 50 });
    expect(out.ticks).toEqual(same);
  });

  it('angles a dense run of long labels and always keeps the first and last', () => {
    const many = Array.from({ length: 40 }, (_, i) => tick(i, `Oct ${i + 1}`));
    const out = fitXTicks({ ticks: many, xScale: (v) => 40 + v * 8 });
    expect(out.angle).not.toBe(0);
    expect(out.ticks[0]).toBe(many[0]);
    expect(out.ticks[out.ticks.length - 1]).toBe(many[39]);
  });
});

describe('ChartFrameSvg — angled labels and hover bands', () => {
  const base = {
    width: 400,
    height: 240,
    x: { domain: [0, 3] as [number, number], ticks: [tick(0), tick(3)], title: 'Day' },
    y: { domain: [0, 10] as [number, number], ticks: [tick(0), tick(10)] },
    description: 'frame',
  };

  it('rotates every x label when an angle is given, flat otherwise', () => {
    const angled = rtlRender(
      <svg>
        <ChartFrameSvg {...base} xTickAngle={-45}>
          {() => null}
        </ChartFrameSvg>
      </svg>,
    );
    expect(angled.container.innerHTML).toContain('rotate(-45');
    angled.unmount();
    const flat = rtlRender(<ChartFrameSvg {...base}>{() => null}</ChartFrameSvg>);
    expect(flat.container.innerHTML).not.toContain('rotate(');
  });

  it.each([
    ['a single band spans the whole plot', [{ x: 1, title: 'only' }]],
    [
      'two bands split the plot between them',
      [
        { x: 3, title: 'second' },
        { x: 0, title: 'first' },
      ],
    ],
    ['no bands draws none', []],
  ])('%s', (_label, hitBands) => {
    const { container } = rtlRender(
      <ChartFrameSvg {...base} hitBands={hitBands}>
        {() => null}
      </ChartFrameSvg>,
    );
    expect(container.querySelectorAll('rect > title')).toHaveLength(hitBands.length);
  });
});

describe('PageChartFrame — an explicit bottom margin wins', () => {
  it('uses the margin the caller gives instead of the flat/angled default', () => {
    const { container } = rtlRender(
      <PageChartFrame
        width={600}
        height={300}
        margin={{ bottom: 90 }}
        x={{ domain: [0, 1], ticks: [tick(0), tick(1)], title: 'x' }}
        y={{ domain: [0, 1], ticks: [tick(0), tick(1)] }}
        description="page frame"
      >
        {() => null}
      </PageChartFrame>,
    );
    expect(container.querySelector('svg')).toBeTruthy();
  });
});

describe('PageChartFrame — a dense axis widens the bottom margin when it angles the labels', () => {
  it('draws the angled labels in a taller bottom margin than the flat ones', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: (e: { contentRect: { width: number } }[]) => void) {
          cb([{ contentRect: { width: 360 } }]);
        }
        observe() {}
        disconnect() {}
      },
    );
    const ticks = Array.from({ length: 40 }, (_, i) => tick(i, `Oct ${i + 1}`));
    const { container } = rtlRender(
      <PageChartFrame
        width={360}
        height={300}
        x={{ domain: [0, 39], ticks, title: 'x' }}
        y={{ domain: [0, 1], ticks: [tick(0), tick(1)] }}
        description="dense"
      >
        {() => null}
      </PageChartFrame>,
    );
    expect(container.innerHTML).toContain('rotate(');
  });
});

describe('useChartWidth — the observer’s edges', () => {
  function Probe() {
    const { ref, width } = useChartWidth<HTMLDivElement>(500);
    return <div ref={ref}>{width}</div>;
  }

  it('ignores an empty entry list and a zero width, and follows a real one', () => {
    let fire: ((entries: { contentRect: { width: number } }[]) => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: typeof fire) {
          fire = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const { container } = rtlRender(<Probe />);
    act(() => fire?.([]));
    expect(container.textContent).toBe('500');
    act(() => fire?.([{ contentRect: { width: 0 } }]));
    expect(container.textContent).toBe('500');
    act(() => fire?.([{ contentRect: { width: 733.4 } }]));
    expect(container.textContent).toBe('733');
  });

  it('keeps the initial width when nothing is attached to measure', () => {
    const { result } = renderHook(() => useChartWidth<HTMLDivElement>(321));
    expect(result.current.width).toBe(321);
  });
});

describe('useReportHelpHidden — storage that fails', () => {
  it('reads as shown when localStorage throws, and ignores an unrelated storage key', () => {
    window.localStorage.clear();
    resetReportHelpHiddenForTests();
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useReportHelpHidden());
    expect(result.current[0]).toBe(false);
    spy.mockRestore();
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'something.else', newValue: 'true' }),
      );
    });
    expect(result.current[0]).toBe(false);
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: REPORT_HELP_HIDDEN_STORAGE_KEY, newValue: 'false' }),
      );
    });
    expect(result.current[0]).toBe(false);
    resetReportHelpHiddenForTests();
  });
});

describe('ReportWindowControls — the stepper both ways', () => {
  it('steps the window shorter and longer along the bucket-free ladder', () => {
    const onChange = vi.fn();
    render(<ReportWindowControls daysBack={30} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Shorter window' }));
    expect(onChange).toHaveBeenLastCalledWith({ daysBack: 14 });
    fireEvent.click(screen.getByRole('button', { name: 'Longer window' }));
    expect(onChange).toHaveBeenLastCalledWith({ daysBack: 60 });
    // No Period control (MOTIR-10346).
    expect(screen.queryByRole('button', { name: 'Daily' })).toBeNull();
  });

  it('disables each end of the ladder: 7 cannot shrink, 365 cannot grow', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ReportWindowControls daysBack={7} onChange={onChange} />);
    const fewer = () => screen.getByRole('button', { name: 'Shorter window' }) as HTMLButtonElement;
    const more = () => screen.getByRole('button', { name: 'Longer window' }) as HTMLButtonElement;
    expect(fewer().disabled).toBe(true);
    expect(more().disabled).toBe(false);
    rerender(<ReportWindowControls daysBack={365} onChange={onChange} />);
    expect(fewer().disabled).toBe(false);
    expect(more().disabled).toBe(true);
  });
});

describe('VelocityRangeControls — the picker’s edges', () => {
  it('names no sprint under "Latest" when there are none, and offers search past six', () => {
    const { rerender } = render(<VelocityRangeControls sprints={[]} endingAt={null} count={7} />);
    expect(screen.getByRole('combobox')).toBeTruthy();
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `Sprint ${i}` }));
    rerender(<VelocityRangeControls sprints={many} endingAt="s3" count={7} />);
    expect(screen.getByRole('combobox')).toBeTruthy();
  });

  it('choosing Latest again clears the end sprint from the URL', () => {
    const three = [
      { id: 's3', name: 'Sprint 3' },
      { id: 's2', name: 'Sprint 2' },
    ];
    render(<VelocityRangeControls sprints={three} endingAt="s2" count={7} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Ending at' }));
    fireEvent.click(screen.getByRole('option', { name: 'Latest completed — Sprint 3' }));
    expect(push).toHaveBeenLastCalledWith('/reports/velocity');
  });
});
