/**
 * A wire value's catalogue label, or the raw value when the catalogue has no key
 * for it: a value a newer motir-ai adds shows as it came, never as a plausible
 * member it is not.
 */
export type FindingLabelGroup = 'source' | 'planner' | 'outcome' | 'attribution' | 'status';

interface Translator {
  (key: string): string;
  has(key: string): boolean;
}

export function findingLabel(t: Translator, group: FindingLabelGroup, value: string): string {
  const key = `${group}.${value}`;
  return t.has(key) ? t(key) : value;
}
