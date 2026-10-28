import { createHash } from 'node:crypto';

// What the two RELEASE shapes (MOTIR-10008 function, MOTIR-10009 container)
// do the same way to their stack template and their releases: write the
// release's variables into the template at a marker line (CloudFormation cannot
// turn one parameter into a map or a list of variables), hash every variable
// into the `ConfigHash` that publishes a new release and names the environment
// secret's version, and work out the previous release from the release numbers.

/** A template lost the marker line a release's variables go at. */
export class ReleaseTemplateMarkerMissingError extends Error {
  readonly code = 'AWS_RELEASE_TEMPLATE_MARKER_MISSING' as const;
  constructor(readonly marker: string) {
    super(`The release template has no ${marker} line.`);
    this.name = 'ReleaseTemplateMarkerMissingError';
  }
}

/** A JSON string, which YAML reads as a double-quoted scalar — with the
 *  characters YAML 1.1 parsers take for line breaks escaped too. */
export function yamlString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u0085\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** The template with the marker line replaced by `lines`, each at the marker's
 *  indentation. */
export function replaceMarkerLine(
  template: string,
  marker: string,
  lines: readonly string[],
): string {
  const all = template.split('\n');
  const at = all.findIndex((line) => line.trim() === marker);
  if (at < 0) throw new ReleaseTemplateMarkerMissingError(marker);
  const indent = all[at]!.slice(0, all[at]!.indexOf('#'));
  all.splice(at, 1, ...lines.map((line) => `${indent}${line}`));
  return all.join('\n');
}

/** A release's variables, split between where they are delivered in the clear
 *  and the environment secret. */
export interface ReleaseVariableSplit {
  readonly plain: Readonly<Record<string, string>>;
  readonly secret: Readonly<Record<string, string>>;
}

/**
 * The hash of the release's variables: the `ConfigHash` that publishes a new
 * release when any of them changes, and the id of the secret version that holds
 * the secret ones. Every name and value goes in, so no value can be read back
 * from it alone.
 */
export function releaseConfigHash(split: ReleaseVariableSplit): string {
  const entries = (record: Readonly<Record<string, string>>) =>
    Object.keys(record)
      .sort()
      .map((k) => [k, record[k]]);
  return createHash('sha256')
    .update(JSON.stringify([entries(split.plain), entries(split.secret)]))
    .digest('hex');
}

/**
 * The release a rollback would restore, from the release numbers and the live
 * one, with no state of its own: while the live release is the newest, it is the
 * newest one below it; after a rollback the live one is older than the newest,
 * and the newest — the release the rollback replaced — is the one to restore.
 */
export function previousReleaseNumber(
  numbers: readonly number[],
  live: number | null,
): number | null {
  const valid = numbers.filter((n) => Number.isInteger(n) && n > 0);
  if (live === null || valid.length === 0) return null;
  const newest = Math.max(...valid);
  if (live < newest) return newest;
  const below = valid.filter((n) => n < live);
  return below.length > 0 ? Math.max(...below) : null;
}
