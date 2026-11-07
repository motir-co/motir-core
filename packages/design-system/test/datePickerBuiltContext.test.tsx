// @vitest-environment happy-dom
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement, type ComponentType, type ReactNode } from 'react';

// MOTIR-10551 — the BUILT package must give the DatePicker the same format
// context the barrel's DatePickerFormatProvider writes. The build emits one
// chunk per source file with splitting off, so a chunk INLINES what it imports:
// left alone, `DatePicker.js` carried its own `createContext()` and a consumer's
// provider never reached the picker (every source-level test still passed). The
// tsup `singleton-modules` plugin keeps that import external; this pins it on
// the artifact consumers actually load.

const PKG_ROOT = path.resolve(__dirname, '..');
const chunk = (rel: string) => path.join(PKG_ROOT, 'dist', rel);

beforeAll(() => {
  if (!existsSync(chunk('components/ui/DatePicker.js'))) {
    execSync('pnpm run build', { cwd: PKG_ROOT, stdio: 'inherit' });
  }
}, 120_000);

afterEach(cleanup);

describe('the built DatePicker shares the format context', () => {
  it('imports the context chunk instead of inlining a second createContext', () => {
    const text = readFileSync(chunk('components/ui/DatePicker.js'), 'utf8');
    expect(text).toContain("from './DatePickerFormatContext.js'");
    expect(text).not.toMatch(/\bcreateContext\b/);
  });

  it("a provider from the built barrel reaches the built picker's trigger", async () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const dist = (await import(/* @vite-ignore */ chunk('index.js'))) as {
      DatePicker: ComponentType<Record<string, unknown>>;
      DatePickerFormatProvider: ComponentType<{
        locale?: string;
        formatDate?: (iso: string, locale: string) => string;
        children?: ReactNode;
      }>;
    };
    render(
      createElement(
        dist.DatePickerFormatProvider,
        { locale: 'zh-CN', formatDate: (iso, locale) => `X:${iso}:${locale}` },
        createElement(dist.DatePicker, {
          'aria-label': 'Due date',
          value: '2026-06-03',
          onChange: () => {},
        }),
      ),
    );
    expect(screen.getByRole('button', { name: 'Due date' }).textContent).toBe('X:2026-06-03:zh-CN');
  });
});
