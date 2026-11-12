import { describe, expect, it } from 'vitest';
import { amiBuiltAt, imageVerdict, shortCommit, shortDigest } from '@/lib/fleetStatus/imageVerdict';
import {
  hostedRow,
  indexerRow,
  NEWEST_DIGEST,
  publishIdle,
  runnerRow,
  sandboxRow,
} from '../fixtures/fleetStatusImageRows';

// THE VERDICT PILL of a Fleet status image card (MOTIR-10886; design MOTIR-10885
// § Elements): a publish in flight or failed outranks the gap, an unread row is
// never up to date, and a row is behind only when a newer image exists.

describe('imageVerdict', () => {
  it('not read and unset rows say so', () => {
    expect(imageVerdict({ status: 'not_read', source: 'ghcr', detail: 'x' })).toEqual({
      kind: 'not_read',
    });
    expect(imageVerdict({ status: 'unset', variable: 'MOTIR_RUNNER_IMAGE' })).toEqual({
      kind: 'unset',
    });
  });

  it('a running or failed publish outranks the gap', () => {
    expect(
      imageVerdict(
        hostedRow({ publish: publishIdle({ progress: { state: 'running', startedAt: 'x' } }) }),
      ),
    ).toEqual({ kind: 'publishing' });
    expect(
      imageVerdict(
        sandboxRow(['kimi'], {
          publish: publishIdle({ progress: { state: 'failed', endedAt: 'x', error: null } }),
        }),
      ),
    ).toEqual({ kind: 'publish_failed' });
  });

  it('hosted: days behind, or up to date', () => {
    expect(imageVerdict(hostedRow())).toEqual({ kind: 'days_behind', count: 3 });
    expect(imageVerdict(hostedRow({ daysBehind: null }))).toEqual({
      kind: 'days_behind',
      count: 0,
    });
    expect(imageVerdict(hostedRow({ behind: false }))).toEqual({ kind: 'up_to_date' });
  });

  it('runner: releases behind, days behind when the pin is no release, release needed, up to date', () => {
    expect(imageVerdict(runnerRow())).toEqual({ kind: 'releases_behind', count: 2 });
    expect(imageVerdict(runnerRow({ releasesBetween: null }))).toEqual({
      kind: 'days_behind',
      count: 5,
    });
    expect(imageVerdict(runnerRow({ releasesBetween: null, daysBehind: null }))).toEqual({
      kind: 'days_behind',
      count: 0,
    });
    const change = {
      commit: 'abc',
      committedAt: '2026-11-07T00:00:00Z',
      subject: 'bump',
      paths: ['infra/ci-runner/Dockerfile'],
      relation: 'ahead' as const,
    };
    expect(imageVerdict(runnerRow({ behind: false, unreleased: [change] }))).toEqual({
      kind: 'release_needed',
    });
    expect(imageVerdict(runnerRow({ behind: false }))).toEqual({ kind: 'up_to_date' });
  });

  // MOTIR-10986 — the indexer reads as the runner, except that a pin or a
  // newest release nobody answered for is Not read, ahead of any publish state.
  it('indexer: releases behind, release needed, up to date, and Not read for an unread part', () => {
    expect(imageVerdict(indexerRow())).toEqual({ kind: 'releases_behind', count: 1 });
    const change = {
      commit: 'abc',
      committedAt: '2026-11-12T00:00:00Z',
      subject: 'fix',
      paths: ['src/indexer'],
      relation: 'ahead' as const,
    };
    expect(imageVerdict(indexerRow({ behind: false, unreleased: [change] }))).toEqual({
      kind: 'release_needed',
    });
    expect(imageVerdict(indexerRow({ behind: false }))).toEqual({ kind: 'up_to_date' });
    const unread = { state: 'not_read' as const, source: 'aws' as const, detail: 'x' };
    expect(imageVerdict(indexerRow({ pinned: unread }))).toEqual({ kind: 'not_read' });
    expect(
      imageVerdict(
        indexerRow({
          newest: unread,
          publish: publishIdle({ progress: { state: 'failed', endedAt: 'x', error: null } }),
        }),
      ),
    ).toEqual({ kind: 'not_read' });
    // The history alone not answering leaves the compare standing.
    expect(imageVerdict(indexerRow({ history: { ...unread, source: 'github' } }))).toEqual({
      kind: 'releases_behind',
      count: 1,
    });
  });

  it('sandbox: tags missing, or up to date', () => {
    expect(imageVerdict(sandboxRow(['kimi', 'goose']))).toEqual({
      kind: 'tags_missing',
      missing: 2,
      total: 9,
    });
    expect(imageVerdict(sandboxRow())).toEqual({ kind: 'up_to_date' });
  });
});

describe('the short forms', () => {
  it('shortDigest keeps the algorithm and twelve hex characters', () => {
    expect(shortDigest(NEWEST_DIGEST)).toBe('sha256:9f9f9f9f9f9f');
    expect(shortDigest(null)).toBe('');
    expect(shortDigest('nocolon')).toBe('nocolon');
  });

  it('shortCommit is seven characters', () => {
    expect(shortCommit('c22cba55d5ece36c')).toBe('c22cba5');
    expect(shortCommit(null)).toBe('');
  });

  it('amiBuiltAt reads the name’s build stamp', () => {
    expect(amiBuiltAt('motir-ci-runner-0.2.4-202611051230-4a9cb14')).toBe(
      '2026-11-05T12:30:00.000Z',
    );
    expect(amiBuiltAt('motir-ci-runner-0.2.4-209913991299-4a9cb14')).toBeNull();
    expect(amiBuiltAt('no stamp')).toBeNull();
    expect(amiBuiltAt(null)).toBeNull();
  });
});
