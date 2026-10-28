// The names a Motir repository's environment configuration may not set (Story
// MOTIR-9795 · MOTIR-9960), because the platform sets them itself: the port the
// app listens on, the database it is given, and every `MOTIR_*` variable. The
// rule is the same in every environment. The service and the resolver import
// this one function; the database's CHECK on `environment_config_entry.name` is
// its backstop.

const RESERVED_EXACT: readonly string[] = ['PORT', 'DATABASE_URL'];
const RESERVED_PREFIX = 'MOTIR_';

/** Whether `name` is reserved, compared against the exact string given:
 *  case-sensitive, no trimming and no normalisation. */
export function isReservedEnvironmentName(name: string): boolean {
  return RESERVED_EXACT.includes(name) || name.startsWith(RESERVED_PREFIX);
}
/** The shape every environment-variable name takes: a letter or underscore, then
 *  letters, digits and underscores. */
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isEnvironmentVariableName(name: string): boolean {
  return NAME_SHAPE.test(name);
}
