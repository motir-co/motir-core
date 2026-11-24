// MASKING A PRODUCTION LOG LINE (Story MOTIR-9799 · MOTIR-12105). Pure, no I/O:
// the logs service reads the secret values fresh on every call and hands them
// here, and nothing in this module keeps, logs or throws one.
//
// ⚠️ TWO TRAPS THAT PASS EVERY HAPPY TEST.
//   1. Overlapping secrets. Replacing values one after another leaves pieces
//      behind: mask `bc` first in `abcd` and a later `abcd` no longer matches.
//      Masking here works on POSITIONS instead — every occurrence of every
//      value is found in the ORIGINAL text, the ranges are merged, and each
//      merged range becomes one mask — so a secret inside another is masked
//      whole, and two that overlap leave no character of either.
//   2. The text filter as an oracle. The target filters on RAW text, so a line
//      it returns for `q` may contain `q` only inside a secret; showing it would
//      tell the viewer the secret contains `q`, one guess at a time.
//      `matchesOutsideSecrets` asks whether the filter occurs with every secret
//      range replaced by a character no filter can match, so the masked line is
//      kept only when its VISIBLE text still holds the filter.

/** What replaces a secret value in a line — the convention CI logs use. */
export const LOG_SECRET_MASK = '***';

/** Stands in for a secret range while the filter is checked; a filter holding
 *  it is not text a log line can contain outside a secret. */
const HIDDEN = '\u0000';

/**
 * The values to look for, from the secret values: each value whole and, for a
 * multi-line value, each of its lines that is not blank — a log line never
 * carries a newline, so a multi-line secret is printed one line at a time.
 * Deduplicated, empty values dropped, longest first.
 */
export function secretNeedles(values: readonly string[]): string[] {
  const needles = new Set<string>();
  for (const value of values) {
    if (value.length > 0) needles.add(value);
    const lines = value.split(/\r?\n/);
    if (lines.length < 2) continue;
    for (const line of lines) if (line.trim().length > 0) needles.add(line);
  }
  return [...needles].sort((a, b) => b.length - a.length);
}

/**
 * The secret values a connection string carries beside itself: its password,
 * as written and percent-decoded, so a line that prints only the password (a
 * driver's error, a URL split into fields) is masked too. None for a value that
 * is not a URL with a password.
 */
export function connectionStringSecrets(value: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  if (url.password.length === 0) return [];
  let decoded = url.password;
  try {
    decoded = decodeURIComponent(url.password);
  } catch {
    // Keep the encoded form alone.
  }
  return decoded === url.password ? [url.password] : [url.password, decoded];
}

/** The merged [start, end) ranges every needle occupies in `message`. */
function secretRanges(message: string, needles: readonly string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const needle of needles) {
    // Overlapping occurrences too: `aa` in `aaa` is at 0 and 1.
    for (let at = message.indexOf(needle); at !== -1; at = message.indexOf(needle, at + 1)) {
      ranges.push([at, at + needle.length]);
    }
  }
  if (ranges.length === 0) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [ranges[0]!];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function replaceRanges(
  message: string,
  ranges: ReadonlyArray<[number, number]>,
  replacement: string,
): string {
  let out = '';
  let from = 0;
  for (const [start, end] of ranges) {
    out += message.slice(from, start) + replacement;
    from = end;
  }
  return out + message.slice(from);
}

/** `message` with every occurrence of every secret value replaced by the mask.
 *  `needles` is `secretNeedles(values)`. */
export function maskSecretValues(message: string, needles: readonly string[]): string {
  return replaceRanges(message, secretRanges(message, needles), LOG_SECRET_MASK);
}

/**
 * Does `filter` occur in `message` outside every secret value, compared
 * case-insensitively as the port's filter is? An empty filter matches every
 * line. A filter is never matched across a secret, nor inside one.
 */
export function matchesOutsideSecrets(
  message: string,
  needles: readonly string[],
  filter: string | null | undefined,
): boolean {
  if (!filter) return true;
  if (filter.includes(HIDDEN)) return false;
  const visible = replaceRanges(message, secretRanges(message, needles), HIDDEN);
  return visible.toLowerCase().includes(filter.toLowerCase());
}
