import type {
  HostedImageRowDTO,
  IndexerImageRowDTO,
  RunnerImageRowDTO,
  SandboxImageRowDTO,
} from '@/lib/dto/fleetStatusImages';

// The Verdict pill of a Fleet status image card (MOTIR-10886; design MOTIR-10885
// § Elements, "Verdict pill"). A pure function of the row, so the page and its
// tests read one rule: a publish in flight or failed outranks the gap, an
// unread row is never up to date, and a row is behind only when a newer image
// exists. The indexer row (MOTIR-10986) reads as the runner's, except that a
// pin or a newest release nobody answered for makes the whole pill Not read.

export type FleetImageVerdict =
  | { kind: 'not_read' }
  | { kind: 'unset' }
  | { kind: 'publishing' }
  | { kind: 'publish_failed' }
  | { kind: 'up_to_date' }
  | { kind: 'release_needed' }
  | { kind: 'days_behind'; count: number }
  | { kind: 'releases_behind'; count: number }
  | { kind: 'tags_missing'; missing: number; total: number };

type Row = HostedImageRowDTO | RunnerImageRowDTO | IndexerImageRowDTO | SandboxImageRowDTO;

export function imageVerdict(row: Row): FleetImageVerdict {
  if (row.status === 'not_read') return { kind: 'not_read' };
  if (row.status === 'unset') return { kind: 'unset' };
  if ('history' in row && (row.pinned.state !== 'read' || row.newest.state !== 'read')) {
    return { kind: 'not_read' };
  }
  const { progress } = row.publish;
  if (progress.state === 'running') return { kind: 'publishing' };
  if (progress.state === 'failed') return { kind: 'publish_failed' };
  if ('profiles' in row) {
    const missing = row.profiles.filter((p) => !p.published).length;
    return missing > 0
      ? { kind: 'tags_missing', missing, total: row.profiles.length }
      : { kind: 'up_to_date' };
  }
  if ('unreleased' in row) {
    if (row.behind) {
      return row.releasesBetween
        ? { kind: 'releases_behind', count: row.releasesBetween.length }
        : { kind: 'days_behind', count: row.daysBehind ?? 0 };
    }
    return row.unreleased.length > 0 ? { kind: 'release_needed' } : { kind: 'up_to_date' };
  }
  return row.behind ? { kind: 'days_behind', count: row.daysBehind ?? 0 } : { kind: 'up_to_date' };
}

/** `sha256:<64 hex>` → `sha256:<12 hex>`, the tiles' short form. */
export function shortDigest(digest: string | null): string {
  if (!digest) return '';
  const [algo, hex] = digest.split(':');
  return hex ? `${algo}:${hex.slice(0, 12)}` : digest;
}

/** A full commit → its seven-character form. */
export function shortCommit(commit: string | null): string {
  return commit ? commit.slice(0, 7) : '';
}

/** The build time an AMI's name records (`…-<YYYYMMDDhhmm>-<sha7>`), as ISO, or null. */
export function amiBuiltAt(name: string | null): string | null {
  const match = /-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})-[0-9a-f]{7}$/.exec(name ?? '');
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:00Z`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
