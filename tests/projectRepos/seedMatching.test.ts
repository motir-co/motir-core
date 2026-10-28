import { afterEach, describe, expect, it, vi } from 'vitest';

// The seed matching's answer per hosting target (Story MOTIR-9796 · MOTIR-10014).
// The planner names this answer in a hosting decision card, so the answer must
// come from the MATCHING and never from text: replacing the matching must move
// every target's answer with it.
const matching = vi.hoisted(() => ({ override: null as ((role: string) => string) | null }));
vi.mock('@/lib/projectRepos/vocabulary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projectRepos/vocabulary')>();
  return {
    ...actual,
    defaultSeedSourceForRole: vi.fn(
      (role: Parameters<typeof actual.defaultSeedSourceForRole>[0]) =>
        matching.override ? matching.override(role) : actual.defaultSeedSourceForRole(role),
    ),
  };
});

import { HOSTING_TARGETS } from '@/lib/hosting/vocabulary';
import {
  seedSourceForHostingTarget,
  starterByHostingTarget,
} from '@/lib/projectRepos/seedMatching';
import { defaultSeedSourceForRole } from '@/lib/projectRepos/vocabulary';

afterEach(() => {
  matching.override = null;
  vi.mocked(defaultSeedSourceForRole).mockClear();
});

describe('seedSourceForHostingTarget', () => {
  it('answers what the role matching answers for a new app (`web`), for every target', () => {
    for (const target of HOSTING_TARGETS) {
      expect(seedSourceForHostingTarget(target)).toBe('nextjs-prisma-vercel-starter');
    }
    expect(defaultSeedSourceForRole).toHaveBeenCalledWith('web');
  });

  it('follows the matching when the matching changes — the answer is never a literal', () => {
    matching.override = (role) => `replaced-${role}`;
    for (const target of HOSTING_TARGETS) {
      expect(seedSourceForHostingTarget(target)).toBe('replaced-web');
    }
  });
});

describe('starterByHostingTarget', () => {
  it('has exactly one entry per hosting target, each the matching’s answer', () => {
    matching.override = () => 'starter-from-matching';
    const map = starterByHostingTarget();
    expect(Object.keys(map)).toEqual([...HOSTING_TARGETS]);
    for (const target of HOSTING_TARGETS) {
      expect(map[target]).toBe('starter-from-matching');
    }
    expect(defaultSeedSourceForRole).toHaveBeenCalledTimes(HOSTING_TARGETS.length);
  });

  it('carries no starter key as a string literal in its source', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile('lib/projectRepos/seedMatching.ts', 'utf8');
    expect(source).not.toMatch(/['"`](nextjs-prisma-vercel-starter|initialised|blank)['"`]/);
  });
});
