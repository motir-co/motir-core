import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DEFAULT_DATE_PICKER_LOCALE,
  DatePickerFormatProvider,
  defaultDatePickerFormatter,
  resolveDatePickerFormat,
  useDatePickerFormat,
  type DatePickerFormatInputs,
  type DatePickerFormatter,
} from '../src/index';

// MOTIR-10574 — the DatePicker's date-format injection: the en/UTC default,
// provider injection and the prop → provider → default precedence, per field.
// Rendered with react-dom/server (no jsdom): the hook is read by a probe that
// prints what it resolved.

const ISO = '2026-06-03';

/** An injected formatter that shows exactly what it was called with. */
const tagging: DatePickerFormatter = (iso, locale) => `X:${iso}:${locale}`;
const other: DatePickerFormatter = (iso, locale) => `Y:${iso}:${locale}`;

function Probe({ props }: { props?: DatePickerFormatInputs }) {
  const { locale, formatDate } = useDatePickerFormat(props);
  return (
    <output>
      {locale}|{formatDate(ISO)}
    </output>
  );
}

const read = (html: string) => /<output>(.*)<\/output>/.exec(html)?.[1] ?? '';

describe('the en/UTC default', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('resolves locale en and formats 2026-06-03 as Jun 3, 2026', () => {
    const resolved = resolveDatePickerFormat();
    expect(DEFAULT_DATE_PICKER_LOCALE).toBe('en');
    expect(resolved.locale).toBe('en');
    expect(resolved.formatDate(ISO)).toBe('Jun 3, 2026');
  });

  it('matches motir-core formatDate(iso, "en") byte for byte (en-US, UTC, numeric/short/numeric)', () => {
    const motirCoreEn = new Date(ISO).toLocaleString('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    expect(defaultDatePickerFormatter(ISO, 'en')).toBe(motirCoreEn);
  });

  // Each date sits at a day, month, year or leap-day edge: formatted in local
  // time west of UTC it would read the previous day, east of it the next.
  const edges: Array<[string, string]> = [
    ['2026-01-01', 'Jan 1, 2026'],
    ['2026-06-30', 'Jun 30, 2026'],
    ['2026-12-31', 'Dec 31, 2026'],
    ['2024-02-29', 'Feb 29, 2024'],
  ];
  for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    it(`formats near-midnight-UTC dates to their own day with TZ=${tz}`, () => {
      process.env.TZ = tz;
      const { formatDate } = resolveDatePickerFormat();
      for (const [iso, expected] of edges) expect(formatDate(iso)).toBe(expected);
    });
  }

  it('renders the default through the hook with no provider', () => {
    expect(read(renderToStaticMarkup(<Probe />))).toBe('en|Jun 3, 2026');
  });
});

describe('the locale is an opaque string', () => {
  it('reaches an injected formatter unaltered', () => {
    expect(resolveDatePickerFormat({ locale: 'zh-CN', formatDate: tagging }).formatDate(ISO)).toBe(
      'X:2026-06-03:zh-CN',
    );
  });

  it('formats zh-CN with the default formatter as motir-core formatDate(iso, "zh") does', () => {
    // motir-core's BCP47 table maps `zh` → `zh-CN`; the default passes the tag through.
    expect(defaultDatePickerFormatter(ISO, 'zh-CN')).toBe('2026年6月3日');
  });

  it('falls back to the en-US output on a malformed tag instead of throwing', () => {
    expect(() => defaultDatePickerFormatter(ISO, 'not a locale!!')).not.toThrow();
    expect(defaultDatePickerFormatter(ISO, 'not a locale!!')).toBe('Jun 3, 2026');
  });

  it('rethrows an error that is not a malformed-tag RangeError', () => {
    const boom = new TypeError('not an Intl tag error');
    const spy = vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(() => {
      throw boom;
    });
    try {
      expect(() => defaultDatePickerFormatter(ISO, 'en')).toThrow(boom);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('provider injection', () => {
  it('hands the provider formatter the ISO string and the provider locale', () => {
    const html = renderToStaticMarkup(
      <DatePickerFormatProvider locale="zh-CN" formatDate={tagging}>
        <Probe />
      </DatePickerFormatProvider>,
    );
    expect(read(html)).toBe('zh-CN|X:2026-06-03:zh-CN');
  });

  it('a provider that sets only a locale keeps the default formatter, which receives it', () => {
    const html = renderToStaticMarkup(
      <DatePickerFormatProvider locale="zh-CN">
        <Probe />
      </DatePickerFormatProvider>,
    );
    expect(read(html)).toBe('zh-CN|2026年6月3日');
  });

  it('a provider that sets only a formatter keeps locale en', () => {
    const html = renderToStaticMarkup(
      <DatePickerFormatProvider formatDate={tagging}>
        <Probe />
      </DatePickerFormatProvider>,
    );
    expect(read(html)).toBe('en|X:2026-06-03:en');
  });
});

describe('precedence — prop, then provider, then default, per field', () => {
  const provider = { locale: 'de-DE', formatDate: tagging };

  it('a prop beats the provider for both fields', () => {
    const r = resolveDatePickerFormat({ locale: 'zh-CN', formatDate: other }, provider);
    expect(r.locale).toBe('zh-CN');
    expect(r.formatDate(ISO)).toBe('Y:2026-06-03:zh-CN');
  });

  it('a locale prop alone keeps the provider formatter, which receives the prop locale', () => {
    expect(resolveDatePickerFormat({ locale: 'zh-CN' }, provider).formatDate(ISO)).toBe(
      'X:2026-06-03:zh-CN',
    );
  });

  it('a formatter prop alone keeps the provider locale', () => {
    expect(resolveDatePickerFormat({ formatDate: other }, provider).formatDate(ISO)).toBe(
      'Y:2026-06-03:de-DE',
    );
  });

  it('an undefined prop falls through to the provider, then to the default', () => {
    expect(
      resolveDatePickerFormat({ locale: undefined, formatDate: undefined }, provider).formatDate(
        ISO,
      ),
    ).toBe('X:2026-06-03:de-DE');
    expect(resolveDatePickerFormat({ locale: undefined }, {}).formatDate(ISO)).toBe('Jun 3, 2026');
  });

  it('the hook applies props over the provider', () => {
    const html = renderToStaticMarkup(
      <DatePickerFormatProvider locale="de-DE" formatDate={tagging}>
        <Probe props={{ locale: 'zh-CN' }} />
      </DatePickerFormatProvider>,
    );
    expect(read(html)).toBe('zh-CN|X:2026-06-03:zh-CN');
  });

  it('a nested provider overrides only the fields it sets', () => {
    const html = renderToStaticMarkup(
      <DatePickerFormatProvider locale="de-DE" formatDate={tagging}>
        <DatePickerFormatProvider locale="zh-CN">
          <Probe />
        </DatePickerFormatProvider>
        <DatePickerFormatProvider formatDate={other}>
          <Probe />
        </DatePickerFormatProvider>
      </DatePickerFormatProvider>,
    );
    const outputs = [...html.matchAll(/<output>(.*?)<\/output>/g)].map((m) => m[1]);
    expect(outputs).toEqual(['zh-CN|X:2026-06-03:zh-CN', 'de-DE|Y:2026-06-03:de-DE']);
  });
});

describe('framework-agnostic sources', () => {
  const src = (f: string) =>
    readFileSync(new URL(`../src/components/ui/${f}`, import.meta.url), 'utf8');
  const imports = (text: string) =>
    [...text.matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

  it('datePickerFormat.ts has no directive and imports nothing', () => {
    const text = src('datePickerFormat.ts');
    expect(text).not.toMatch(/^\s*['"]use client['"]/m);
    expect(imports(text)).toEqual([]);
  });

  it('DatePickerFormatContext.tsx is a client module importing only react and ./datePickerFormat', () => {
    const text = src('DatePickerFormatContext.tsx');
    expect(text.trimStart().startsWith("'use client';")).toBe(true);
    expect(imports(text)).toEqual(['react', './datePickerFormat']);
  });
});
