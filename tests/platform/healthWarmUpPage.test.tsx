// @vitest-environment happy-dom
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import PagesWarmUpPage, { dynamic, metadata } from '@/app/health/warm-up/page';
import { PAGE_WARM_UP_PATH } from '@/lib/services/readinessService';

// `/health/warm-up` (Bug MOTIR-10142) — the page the readiness warm-up renders
// over loopback to warm the page runtime. What it must do is evaluate its two
// imports, which importing this file already proves; what it must NOT do is show
// anything, be cached or be indexed. `readinessHealth.test.ts` holds the request
// that renders it.

afterEach(cleanup);

describe('the page warm-up', () => {
  it('lives at the path the readiness warm-up requests', () => {
    // A move of either half would leave the warm-up rendering a 404, which it only
    // logs: readiness does not wait on it, so nothing else would notice.
    expect(existsSync(path.join(process.cwd(), 'app', PAGE_WARM_UP_PATH, 'page.tsx'))).toBe(true);
  });

  it('renders nothing', () => {
    const { container } = render(<PagesWarmUpPage />);
    expect(container.innerHTML).toBe('');
  });

  it('is rendered on every request, never prerendered, and never indexed', () => {
    // A prerendered page is served from the build and evaluates nothing.
    expect(dynamic).toBe('force-dynamic');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
