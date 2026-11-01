import type { ReleaseEnvVar } from '../../../../hosting/types';
import { replaceMarkerLine, yamlString, type ReleaseVariableSplit } from '../releaseTemplate';
import { ReleaseVariableInvalidError } from './errors';

// THE SPLIT of a release's variables (MOTIR-10008). Lambda allows 4 KB of
// environment in aggregate. A plain variable goes into the function's own
// environment while the aggregate stays under that; every `secret: true` value,
// and every plain one that would take it over, goes into the release stack's ONE
// environment secret, which the image's entrypoint loads before `startCommand`.
//
// The plain ones reach the function through the TEMPLATE, written into its
// `Variables` at the marker line: CloudFormation cannot turn one parameter into a
// map of variables, and a parameter is visible to anyone who can describe the
// stack. A secret value is never in the template, a parameter or a returned value.

/** Lambda's limit on a function's environment, keys and values together. */
export const LAMBDA_ENVIRONMENT_LIMIT_BYTES = 4096;

/** The line of `function-release.yaml` the plain variables replace. */
export const RELEASE_VARIABLES_MARKER = '# <release variables>';

/** The variables the template sets itself; a release variable cannot replace one. */
export const FUNCTION_TEMPLATE_VARIABLES = [
  'AWS_LWA_PORT',
  'AWS_LWA_READINESS_CHECK_PATH',
  'MOTIR_ENVIRONMENT',
  'MOTIR_ENVIRONMENT_SECRET_ARN',
  'MOTIR_ENVIRONMENT_SECRET_VERSION',
  'MOTIR_DATABASE_SECRET_ARN',
] as const;

/** The longest environment-secret ARN the template can give, for the budget
 *  before the stack exists: the prefix, a 63-character app name and the suffixes. */
const SECRET_ARN_ALLOWANCE = 256;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Lambda keeps these names to itself; the Web Adapter's own (`AWS_LWA_*`) are
 *  read from the function's environment, so they stay plain. */
const lambdaReserved = (name: string) =>
  (name.startsWith('AWS_') && !name.startsWith('AWS_LWA_')) ||
  name.startsWith('LAMBDA_') ||
  name.startsWith('_');

/** The bytes one variable takes in the environment, measured as JSON — an upper
 *  bound on what Lambda counts. */
const sizeOf = (name: string, value: string) =>
  Buffer.byteLength(JSON.stringify(name)) + Buffer.byteLength(JSON.stringify(value)) + 2;

/**
 * Split `variables` between the function's environment and the secret. `fixed`
 * is the template's own variables with the values they will hold (the secret's
 * ARN may be left out before the stack exists — an allowance stands in for it).
 * Plain variables are taken by name, so the split is the same on every run.
 */
export function splitReleaseVariables(
  variables: readonly ReleaseEnvVar[],
  fixed: Readonly<Record<string, string>>,
): ReleaseVariableSplit {
  const seen = new Set<string>();
  for (const v of variables) {
    if (!NAME.test(v.name)) throw new ReleaseVariableInvalidError(v.name, 'is not a variable name');
    if (seen.has(v.name)) throw new ReleaseVariableInvalidError(v.name, 'is given twice');
    if ((FUNCTION_TEMPLATE_VARIABLES as readonly string[]).includes(v.name)) {
      throw new ReleaseVariableInvalidError(v.name, 'is set by the release itself');
    }
    seen.add(v.name);
  }
  let used = Object.entries(fixed).reduce((sum, [k, value]) => sum + sizeOf(k, value), 0);
  if (!fixed['MOTIR_ENVIRONMENT_SECRET_ARN']) {
    used += sizeOf('MOTIR_ENVIRONMENT_SECRET_ARN', 'x'.repeat(SECRET_ARN_ALLOWANCE));
  }
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  const ordered = [...variables].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const v of ordered) {
    const size = sizeOf(v.name, v.value);
    if (!v.secret && !lambdaReserved(v.name) && used + size <= LAMBDA_ENVIRONMENT_LIMIT_BYTES) {
      plain[v.name] = v.value;
      used += size;
    } else {
      secret[v.name] = v.value;
    }
  }
  return { plain, secret };
}

/** The template with the plain variables written in at the marker. */
export function renderFunctionTemplate(
  template: string,
  plain: Readonly<Record<string, string>>,
): string {
  const lines = Object.keys(plain)
    .sort()
    .map((name) => `${name}: ${yamlString(plain[name]!)}`);
  return replaceMarkerLine(template, RELEASE_VARIABLES_MARKER, lines);
}
