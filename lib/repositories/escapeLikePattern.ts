/**
 * Escape LIKE metacharacters so a substring search matches `%` and `_` LITERALLY —
 * Prisma's `contains` passes the value into the pattern unescaped. Backslash is
 * Postgres's default LIKE escape. The value is still bound as a parameter, so this is
 * about match correctness, not injection safety.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
