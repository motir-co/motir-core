// THE PORT BOUNDARY SCAN of the serverless story (MOTIR-9793 · MOTIR-9976): a
// pure function over (path, text) pairs, so the story gate can run it over the
// tracked tree AND over a planted in-memory offender, which proves it can fail.
//
// A rule bans a set of import specifiers and a set of identifiers everywhere
// except under the directories it allows. The sets are DERIVED by the caller
// from the adapters themselves (the SDK client packages the serverless adapter
// imports, the type names the Neon adapter declares), never typed by hand, so a
// new client package or a new response shape is covered the day it lands.
//
// `tests/ciFleet/awsSdkBoundary.test.ts` holds every `@aws-sdk/*` import of
// `packages/orchestrator/src`, `lib` and `app` to its registered directory; this
// scan is the story's own, wider in what it reads (`tests` and `scripts` too)
// and narrower in what it bans (the two hosting providers only).

export interface SourceText {
  readonly path: string;
  readonly text: string;
}

export interface BoundaryRule {
  readonly name: string;
  /** Path prefixes (repository-relative, `/`-separated) the rule does not apply to. */
  readonly allowed: readonly string[];
  /** Module specifiers no other file may import. */
  readonly modules: ReadonlySet<string>;
  /** Identifiers no other file may name. */
  readonly identifiers: ReadonlySet<string>;
}

export interface BoundaryOffence {
  readonly rule: string;
  readonly path: string;
  readonly line: number;
  readonly what: string;
}

const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/g;

/** Line and block comments blanked to spaces, so line numbers survive. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

function offencesIn(file: SourceText, rule: BoundaryRule): BoundaryOffence[] {
  const named = [...rule.identifiers];
  // Cheap first: most files mention nothing the rule bans.
  if (![...rule.modules, ...named].some((banned) => file.text.includes(banned))) return [];
  const identifier = named.length ? new RegExp(`\\b(?:${named.join('|')})\\b`, 'g') : null;
  return withoutComments(file.text)
    .split('\n')
    .flatMap((line, index) => {
      const at = (what: string) => ({ rule: rule.name, path: file.path, line: index + 1, what });
      const imports = [...line.matchAll(IMPORT)]
        .map((match) => match[1]!)
        .filter((module) => rule.modules.has(module));
      const names = identifier ? [...line.matchAll(identifier)].map((match) => match[0]) : [];
      return [...imports, ...names].map(at);
    });
}

/** Every place a file outside a rule's allowed directories imports or names
 *  what the rule bans. */
export function scanPortBoundary(
  files: readonly SourceText[],
  rules: readonly BoundaryRule[],
): BoundaryOffence[] {
  return rules.flatMap((rule) =>
    files
      .filter((file) => !rule.allowed.some((prefix) => file.path.startsWith(prefix)))
      .flatMap((file) => offencesIn(file, rule)),
  );
}

/** The module specifiers a file imports. */
export function importsOf(text: string): string[] {
  return [...withoutComments(text).matchAll(IMPORT)].map((match) => match[1]!);
}

/** The names a file declares as an interface or a type alias. */
export function declaredTypesOf(text: string): string[] {
  return [
    ...withoutComments(text).matchAll(/^\s*(?:export\s+)?(?:interface|type)\s+([A-Z]\w*)/gm),
  ].map((match) => match[1]!);
}
