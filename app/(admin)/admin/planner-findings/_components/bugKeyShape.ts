/**
 * The planning-bug key SHAPE the console checks before a write: a project key, a
 * dash and digits, after upper-casing — the service's own rule. A courtesy check
 * only; the service and the route are the authority.
 *
 * A plain module, so the record page's key cell (MOTIR-11463) can share it with
 * the finding page's triage controls without importing their action module.
 */
const BUG_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

export function looksLikeBugKey(value: string): boolean {
  return BUG_KEY.test(value.trim().toUpperCase());
}

/** The key as the service stores it: trimmed and upper-cased. */
export function normalizeBugKey(value: string): string {
  return value.trim().toUpperCase();
}
