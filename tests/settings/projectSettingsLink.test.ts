import { describe, expect, it } from 'vitest';
import {
  PROJECT_LINK_PARAM,
  projectSettingsHref,
  readProjectSettingsLink,
} from '@/lib/settings/projectSettingsLink';

// The one spelling of a project-settings link that names its project (Bug
// MOTIR-12169): the notification rows build it, the settings area layout reads
// it back. Pure, so both ends are pinned here without a request.

describe('projectSettingsHref', () => {
  it('puts the project key last, after the room’s own parameters', () => {
    expect(projectSettingsHref('/settings/project/code-access', 'ACME')).toBe(
      '/settings/project/code-access?project=ACME',
    );
    expect(
      projectSettingsHref('/settings/project/production', 'ACME', {
        repository: 'row-1',
        event: 'evt 9',
      }),
    ).toBe('/settings/project/production?repository=row-1&event=evt+9&project=ACME');
  });

  it('encodes a key it cannot pass through verbatim', () => {
    expect(projectSettingsHref('/settings/project', 'A&B=C')).toBe(
      '/settings/project?project=A%26B%3DC',
    );
  });

  it('round-trips through the reader to the same room without the key', () => {
    const href = projectSettingsHref('/settings/project/production', 'ACME', {
      repository: 'row-1',
    });
    expect(readProjectSettingsLink(href)).toEqual({
      projectKey: 'ACME',
      href: '/settings/project/production?repository=row-1',
    });
  });
});

describe('readProjectSettingsLink', () => {
  it('reads the key and drops only that parameter, keeping the rest in order', () => {
    expect(
      readProjectSettingsLink('/settings/project/production?repository=r&project=BBB&event=e'),
    ).toEqual({ projectKey: 'BBB', href: '/settings/project/production?repository=r&event=e' });
    expect(readProjectSettingsLink('/settings/project?project=%20BBB%20')).toEqual({
      projectKey: 'BBB',
      href: '/settings/project',
    });
  });

  it('answers null when the request names no project', () => {
    for (const path of [
      null,
      '',
      '/settings/project/code-access',
      `/settings/project/code-access?${PROJECT_LINK_PARAM}=`,
      `/settings/project/code-access?${PROJECT_LINK_PARAM}=%20`,
    ]) {
      expect(readProjectSettingsLink(path), String(path)).toBeNull();
    }
  });

  it('answers null for anything outside the settings area — the href becomes a navigation target', () => {
    for (const path of [
      '/items?project=BBB',
      '/settings/projects?project=BBB',
      '/settings/workspace?project=BBB',
      '/settings/project/../../items?project=BBB',
      'settings/project?project=BBB',
      '//evil.example/settings/project?project=BBB',
      '/\\evil.example/settings/project?project=BBB',
      'https://evil.example/settings/project?project=BBB',
    ]) {
      expect(readProjectSettingsLink(path), path).toBeNull();
    }
  });

  it('answers null for a path URL cannot parse', () => {
    // A backslash reads as a slash, so this is a protocol-relative URL whose
    // host is an unterminated IPv6 literal — `new URL` throws on it.
    expect(readProjectSettingsLink('/\\[settings/project?project=BBB')).toBeNull();
  });
});
