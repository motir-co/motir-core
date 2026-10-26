// The Hit snippet's emphasis (Story MOTIR-9491 · MOTIR-9638). The service's
// `ts_headline` runs with empty start and stop selectors, so a snippet arrives as
// plain text with no match markers: the words are found here, in the browser.
//
// Each query word matches case-insensitively at the START of a word, so "zeph"
// marks the front of "Zephyr" and never the middle of "azephyr". Words are
// escaped before they reach the RegExp, so `c++` is a literal. A hit found by
// meaning, or by a stem the query does not share, simply has nothing marked.

export interface SnippetSegment {
  text: string;
  match: boolean;
}

const escapeRegExp = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function emphasise(snippet: string, query: string): SnippetSegment[] {
  if (snippet === '') return [];
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [{ text: snippet, match: false }];
  // Longest first, so the alternation prefers "zephyr" over "zep".
  const alternation = [...new Set(words)]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation})`, 'giu');
  const segments: SnippetSegment[] = [];
  let at = 0;
  for (const m of snippet.matchAll(re)) {
    const start = m.index;
    if (start > at) segments.push({ text: snippet.slice(at, start), match: false });
    segments.push({ text: m[0], match: true });
    at = start + m[0].length;
  }
  if (at < snippet.length) segments.push({ text: snippet.slice(at), match: false });
  return segments;
}
