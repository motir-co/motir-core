import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { policyGatedModels } from './singletonReadScan';

// The TEST call-site classifier (MOTIR-2817).
//
// ── The class it exists to separate ─────────────────────────────────────────
// The twenty fixture batches (MOTIR-2735…2754) migrated `db.<model>.<op>(…)`
// sites in tests onto `adminDb`. A test that instead calls a REPOSITORY
// directly —
//
//   const counts = await workItemRepository.countByStatusCategory(pId, wsId);
//
// — carries no `db.` prefix anywhere on the line, so it was invisible to every
// pass of that sweep. `countByStatusCategory` is bindable (it takes an optional
// `tx`); the test passes none, so the read goes to the `@/lib/db` singleton, the
// policy sees no `app.workspace_id`, and it returns an EMPTY result while the
// rows exist. Nothing raises. A test asserting a value fails confusingly; a test
// asserting emptiness PASSES while checking nothing.
//
// ── Why the verdict cannot be read off the line ─────────────────────────────
// These four lines are indistinguishable in a diff and need four different
// treatments:
//
//   workItemRepository.countByStatusCategory(pId, wsId)  // IN SCOPE — bind it
//   githubIdentityRepository.findByUserId(userId)        // not gated — leave
//   rateLimitCounterRepository.countAllUnsafe()          // pre-auth  — leave
//   workItemRepository.findByIds(ids)                    // not bindable yet
//
// Nothing on the line says which. The verdict is a property of the METHOD being
// called — which model it addresses, and whether its signature accepts a `tx` —
// so it needs the repository's syntax tree, not a grep over the test's.
//
// ── Why an AST and not a regex, concretely ──────────────────────────────────
// A single-line regex for `tx?:` mis-classifies `countBacklog`, which declares
// its `tx?` parameter on its own line, as NOT bindable. That one error inflated
// the first measurement of this class by ~60 sites. `ts.SignatureDeclaration`'s
// `parameters` does not care how the signature is wrapped, so the classifier
// reads the structure and carries a test pinning that exact method.
//
// ── What it deliberately does NOT decide ────────────────────────────────────
// Whether an in-scope site's ASSERTION is right once bound. Binding a vacuous
// emptiness assertion may turn it RED, and that failure is a finding for the
// batch card to adjudicate — not something a scanner can rule on.

const REPO_DIR = 'lib/repositories';
const TESTS_DIR = 'tests';
const GUARD = 'tests/rls/singleton-read-guard.test.ts';
/**
 * The fixture root's stand-in for the guard. It cannot be named `*.test.ts`:
 * vitest's `include` globs every `.test.ts` under `tests/` with no `__fixtures__`
 * exclude, so a fixture under that name is COLLECTED as a real suite and fails
 * with "No test suite found". MOTIR-2784's fixture sidesteps this by containing
 * no test files at all; this one needs a VERDICTS map to parse, so it takes the
 * other exit — a name the collector ignores and this module falls back to.
 */
const GUARD_FIXTURE = 'tests/rls/singleton-read-guard.fixture.ts';

/**
 * Test files whose reads are DELIBERATELY unbound, with the reason.
 *
 * ── Why this channel has to exist ──────────────────────────────────────────
 * The other four leave-alone verdicts are properties of the METHOD: not gated,
 * pre-auth, not yet bindable, already bound. This one is a property of the
 * FILE's INTENT, which no amount of parsing can recover — the call site looks
 * exactly like in-scope work, and only the test's own subject says otherwise.
 *
 * The shape, from the instance that forced it: a file whose subject is the
 * application's explicit `workspaceId` WHERE-clause gate asserts that a read
 * for a FOREIGN workspace comes back empty. Bind that read and the RLS policy
 * filters it too — so it still comes back empty, for a second reason, and the
 * assertion stops distinguishing a working gate from a broken one. Binding does
 * not break the test; it makes it VACUOUS. That is the same failure this whole
 * story exists to remove, arriving from the opposite direction.
 *
 * ⚠️ The adjudication is checked AFTER `already-bound`, not before. A write in
 * such a file still REQUIRES its `tx` and still reads as bound — the decision is
 * "do not bind these READS", not "this file is exempt from the model". Checking
 * it first mislabelled 13 legitimate write calls in the one adjudicated file.
 *
 * ⚠️ An entry here is an ADJUDICATION, not a TODO. Adding one silently converts
 * real work into "leave it", so each carries the card that decided it, and the
 * guard asserts the set is exactly this — a new entry fails the build until a
 * human adds it here on purpose. Same division of labour as MOTIR-2784's
 * VERDICTS map: the machine enumerates, a human adjudicates.
 */
export const ADJUDICATED_UNBOUND_FILES: Record<string, string> = {
  // ── MOTIR-8835: a test whose SUBJECT is the unbound read ──────────────────
  // The auto-translate story's "is invisible to a read outside any tenant context"
  // case asserts that the change-trail repository, read with no bound tx, returns
  // nothing under motir_app. Binding the read would delete the claim.
  'tests/integration/translation/autoTranslateStory.test.ts':
    'MOTIR-8835: the case asserts the change trail is invisible to an unbound read.',

  // ── MOTIR-9967: the environment story's unbound-read case ─────────────────
  // "the repositories' reads outside a transaction see nothing row-level security
  // hides" asserts that the entry and change repositories, read with no bound tx,
  // return nothing under motir_app. Binding the reads would delete the claim.
  'tests/environmentConfig/storyIntegration.test.ts':
    'MOTIR-9967: the case asserts environment entries and changes are invisible to an unbound read.',

  // ── MOTIR-2751: the repository-CONTRACT + migration-CONSTRAINT suites ──────
  // Four files, one header, one argument: their subject is the repository contract
  // and the migration-built constraints, with RLS deliberately inert. Bound, a
  // cross-workspace read returns [] because the POLICY hid the row, and a
  // constraint test that fails with a policy error proves nothing about the
  // constraint. "The admin client is what PRESERVES these claims rather than
  // weakening them."
  'tests/comments/repositories.test.ts':
    'MOTIR-2751: repository contract + migration constraints, RLS deliberately inert.',
  'tests/custom-fields/repositories.test.ts':
    'MOTIR-2751: repository contract + migration constraints, RLS deliberately inert.',
  'tests/labels-components-watch/repositories.test.ts':
    'MOTIR-2751: repository contract + migration constraints, RLS deliberately inert.',
  'tests/notifications/repositories.test.ts':
    'MOTIR-2751: repository contract + migration constraints, RLS deliberately inert.',

  // ── MOTIR-2843: a test whose SUBJECT is the unbound branch itself ─────────
  // `projectKeyAliasRepository.findManyByProject` still carries a `tx ?? db`
  // fallback, and this file's own comment says the read exercises "the repo's
  // no-tx read path (the `?? db` branch)". Binding it does not improve the test,
  // it DELETES it -- and drops the branch's coverage with it. The durable fix is
  // to retire the fallback, as MOTIR-2755 did for projectRoleDefinitionRepository
  // (deleted since, with its table, by MOTIR-6569) once every caller bound; that is a lib/ change and belongs to MOTIR-2796.
  //
  // ⚠️ MOTIR-2952: this adjudication was right about the SCANNER and silent about
  // the ASSERTION, and the assertion was the half that was wrong. The read stayed
  // unbound (as ruled) while still expecting `['PROD']` — the answer only a
  // BYPASSRLS owner gives — so it went red the moment `motir_app` became the
  // default. Fixed by correcting the EXPECTED VALUE to `[]`, which is what
  // `tests/rls/tx-fallback-arm.test.ts` says an unbound read owes; the subject,
  // and the branch coverage this entry protects, are untouched. An exemption
  // from binding is not an exemption from being true.
  'tests/project-details-service.test.ts':
    "MOTIR-2843/2796: the test's subject IS the `?? db` branch; binding deletes it. Retire the fallback instead.",

  // ── MOTIR-2815: the file whose SUBJECT is the unbound arm itself ──────────
  // Every read here is deliberately unbound and asserted PER ROLE — rows under
  // the BYPASSRLS owner, EMPTY under `motir_app`. Binding them does not improve
  // the file, it deletes it, and with it the `tx ?? db` branch coverage that
  // eight repositories need to clear the ≥90% floor once their production
  // callers all thread a `tx` (MOTIR-2815 measured exactly that drop). This is
  // the same argument as `project-details-service.test.ts` below, generalised to
  // one file that owns the whole class.
  'tests/rls/tx-fallback-arm.test.ts':
    'MOTIR-2815: the subject IS the `tx ?? db` arm; every read is unbound on purpose and asserted per role.',

  // ── MOTIR-2734: the ONE unbound arm in an otherwise-bound file ────────────
  // Unlike every other entry here, this file's subject is the BOUND read — which
  // is why it is named `app-role-bound-context-reads`. It carries exactly one
  // deliberately-unbound call, at the `findByIds` case that puts the two arms of
  // `tx ?? db` side by side: the bound arm asserts the rows (the contract), the
  // unbound arm asserts `[]`, because asserting rows there would be asserting
  // that a path with no binding works. Same argument as `tx-fallback-arm.test.ts`
  // above, at one site instead of a whole file.
  //
  // ⚠️ It only became unbound in MOTIR-2734. It read `findByIds([blocker.id], tx)`
  // — a second copy of the bound call directly above it — and the retired
  // `TEST_DB_APP_ROLE` branch hid that perfectly: the arm CI ran asserted rows,
  // which a bound read of course returns, and the `[]` arm that would have caught
  // it ran only under the flag. Collapsing the branch made it a hard failure.
  //
  // ⚠️ And the cost of the file-level ruling is higher here than elsewhere,
  // because the rest of this file IS in-scope: a future accidental unbound read
  // added to it inherits this exemption in silence. The bound sites keep their
  // own `already-bound` verdict, so the ruling covers only reads that are
  // genuinely unbound — but that is a bound on the damage, not a guard.
  'tests/app-role-bound-context-reads.test.ts':
    'MOTIR-2734: one deliberate unbound arm — the `tx ?? db` pair asserted side by side, ' +
    'rows bound and `[]` unbound. The rest of the file is bound and stays in scope.',

  // ── MOTIR-2755 / MOTIR-2840: the batched-read QUERY COUNT ─────────────────
  // A different incompatibility from the others. This file's subject is how MANY
  // queries a batched read issues (the N+1 guard), measured by spying on
  // `db.comment.groupBy`. Binding relocates the query onto the tx client, which
  // the spy cannot see, so every count reads 0 and the guard silently stops
  // guarding. Its cross-workspace pair (a/b) is the WHERE-clause shape as well.
  //
  // ⚠️ MOTIR-2952: the same correction as `project-details-service.test.ts` above.
  // The ruling was right about the SPIED call and was silently extended to the
  // ASSERTIONS riding on it — the buckets, the sparseness, the cross-workspace
  // pair — none of which the spy needs and all of which expected rows an unbound
  // read cannot return. The spied call keeps its unbound arm and now asserts `[]`;
  // each answer-shaped claim moved to its own BOUND read of the same method.
  // The cross-workspace pair came out STRONGER: both sides are now bound to the
  // FAR tenant, so the empty answer can only come from the `workspaceId` filter
  // rather than from the policy hiding the row.
  'tests/mcp/comment-counts.test.ts':
    'MOTIR-2755/2840: subject is the QUERY COUNT; a bound read leaves the client the spy watches.',

  // ── MOTIR-2739/2747: the sprint/backlog repository leaves ─────────────────
  'tests/integration/sprints/repository.test.ts':
    "MOTIR-2739/2747: the file's subject is the explicit `workspaceId` WHERE-clause gate, " +
    'asserted with RLS deliberately out of the picture. Bound, a cross-workspace read ' +
    'returns [] because the POLICY hid the row — the same observation for a different ' +
    "reason — which makes every gate assertion in the file vacuous. The policy's own " +
    'behaviour is proved separately, under the role, in the *-rls suites.',
};

/** Client identifiers a repository method may address a model through.
 *
 * `dbRead` (MOTIR-4295) is the module-scope client under a narrower TYPE — the
 * same object as `db`, minus `$transaction`, so a `tx ?? dbRead` fallback does
 * not hand every call a union of two whole Prisma clients (`lib/db.ts` carries
 * the measurement). Nothing about binding differs, so it belongs in this set for
 * exactly the reason `db` does. */
const CLIENTS = new Set(['db', 'dbRead', 'tx', 'client', 'adminDb', 't']);

/**
 * The identifiers `testSingletonStatementScan` treats as a client. It is a
 * SUBSET of `CLIENTS`, deliberately — see that module's header. Exported from
 * here so both scanners share ONE unwrapping rule (the MOTIR-2911 fix) and
 * differ only in the set of names, which is the part that legitimately differs.
 */
export const SINGLETON_ONLY = new Set(['db', 'dbRead']);

export type TestCallSiteVerdict =
  /** Gated, bindable today, and this call passes no `tx`. THE STORY'S WORK. */
  | 'in-scope'
  /** The method touches no policy-gated model — unbound is correct, LEAVE IT. */
  | 'not-gated'
  /** Adjudicated `pre-auth` by the MOTIR-2784 guard — deliberately actorless, LEAVE IT. */
  | 'pre-auth'
  /** Gated, but the method has no `tx` parameter to pass yet (MOTIR-2830). */
  | 'needs-binding-first'
  /** Gated, bindable, and this call already passes a `tx`. Nothing to do. */
  | 'already-bound'
  /**
   * Gated and bindable, but the FILE has a recorded adjudication that its reads
   * stay unbound — because binding them would make the file's own claim vacuous.
   * LEAVE IT. See `ADJUDICATED_UNBOUND_FILES`.
   */
  | 'adjudicated-unbound';

export interface TestCallSite {
  /** repo-relative, e.g. `tests/publicProjects/publicProjectionStats.test.ts` */
  file: string;
  /** 1-based line of the call */
  line: number;
  /** e.g. `workItemRepository` */
  repository: string;
  /** e.g. `countByStatusCategory` */
  method: string;
  /** `file:line` — stable enough to pin, precise enough to find */
  key: string;
  /**
   * Does this call actually pass a `tx`? Recorded SEPARATELY from the verdict
   * because the do-not-touch guard needs it for sites whose verdict does NOT
   * change when they acquire one: a `not-gated` call given a `tx` is still
   * `not-gated`, so the verdict alone cannot tell you a batch touched it.
   */
  bound: boolean;
  verdict: TestCallSiteVerdict;
}

export interface RepositoryMethod {
  /** the repository FILE, e.g. `workItemRepository.ts` (the guard's key space) */
  file: string;
  /** does it address a policy-gated model, or raw SQL whose target is unknowable? */
  gated: boolean;
  /** 0-based index of the `tx` parameter, or null when the method has none */
  txIndex: number | null;
}

/** `<repositoryName>.<method>` → what the call site needs to know about it. */
export type RepositoryIndex = Map<string, RepositoryMethod>;

function sourceFile(full: string): ts.SourceFile {
  return ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
}

/**
 * Is this expression a Prisma CLIENT — `db`, `tx`, or the `(tx ?? db)` the
 * bindable repository methods are written in?
 *
 * ⚠️ THE FALLBACK FORM IS THE WHOLE POINT (MOTIR-2911). Requiring the head to be
 * a bare identifier reads `db.workItem.findMany(…)` and misses
 * `(tx ?? db).workItem.findMany(…)` — which is the shape EVERY bindable method
 * has, because that is what makes it bindable. The method then addresses no
 * model the scanner can see, `gated` comes out FALSE, and its call sites are
 * classified `not-gated`: told, in the verdict's own words, that no policy
 * applies to a table the migrations gate. Eleven methods across three
 * repositories were mis-verdicted this way, and the sixteen unbound call sites
 * under them sat inside the population the guard reports as CLOSED.
 *
 * Both arms count, not just the fallback: `tx` is a client in `CLIENTS` too, and
 * a method could plausibly be written `(client ?? db)`. Recursing over the whole
 * binary expression is cheaper than deciding which side is the interesting one.
 *
 * `names` is a parameter rather than a closed-over constant so the sibling
 * `testSingletonStatementScan` can ask the SAME question over a NARROWER set
 * (`SINGLETON_ONLY`) instead of re-deriving the unwrapping — which is how this
 * blind spot got written the first time. The default keeps every existing caller
 * unchanged.
 */
export function isClientExpression(
  expr: ts.Expression,
  names: ReadonlySet<string> = CLIENTS,
): boolean {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isBinaryExpression(e)) {
    return isClientExpression(e.left, names) || isClientExpression(e.right, names);
  }
  return ts.isIdentifier(e) && names.has(e.text);
}

/** The models a method body addresses, through ANY client — `db`, `tx`, `(tx ?? db)`. */
function addressedModels(body: ts.Node): { models: Set<string>; raw: boolean } {
  const models = new Set<string>();
  let raw = false;
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && isClientExpression(n.expression)) {
      const name = n.name.text;
      if (name.startsWith('$')) {
        if (name.startsWith('$queryRaw') || name.startsWith('$executeRaw')) raw = true;
      } else {
        models.add(name);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return { models, raw };
}

/** The 0-based index of a `tx` parameter. AST, so a wrapped signature is fine. */
function txParameterIndex(params: readonly ts.ParameterDeclaration[]): number | null {
  const i = params.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === 'tx');
  return i === -1 ? null : i;
}

/**
 * Parse `lib/repositories/*.ts` into the map the call sites are classified against.
 * A repository is an object literal of methods assigned to an exported const whose
 * name ends in `Repository` — the same shape `singletonReadScan` walks.
 */
export function repositoryIndex(root = process.cwd()): RepositoryIndex {
  const gatedModels = policyGatedModels(root);
  const dir = path.join(root, REPO_DIR);
  const index: RepositoryIndex = new Map();

  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()) {
    const sf = sourceFile(path.join(dir, file));

    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text.endsWith('Repository') &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        const repository = node.name.text;
        for (const member of node.initializer.properties) {
          if (!member.name || !ts.isIdentifier(member.name)) continue;
          let params: readonly ts.ParameterDeclaration[] | undefined;
          let body: ts.Node | undefined;
          if (ts.isMethodDeclaration(member)) {
            params = member.parameters;
            body = member.body;
          } else if (
            ts.isPropertyAssignment(member) &&
            (ts.isFunctionExpression(member.initializer) || ts.isArrowFunction(member.initializer))
          ) {
            params = member.initializer.parameters;
            body = member.initializer.body;
          }
          if (!params || !body) continue;

          const { models, raw } = addressedModels(body);
          const gated = raw || [...models].some((m) => gatedModels.has(m));
          index.set(`${repository}.${member.name.text}`, {
            file,
            gated,
            txIndex: txParameterIndex(params),
          });
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return index;
}

/**
 * The `pre-auth` keys the MOTIR-2784 guard has already adjudicated, read out of
 * its `VERDICTS` map by parsing it.
 *
 * Parsed rather than imported because that file is a `.test.ts` and this module
 * is imported BY tests — and because MOTIR-2817 must touch no existing test. The
 * cost is a coupling to the map's NAME, which `test-call-site-guard.test.ts`
 * pins with a non-empty assertion so a rename fails loudly instead of silently
 * returning an empty set and re-opening two adjudicated sites.
 */
export function preAuthKeys(root = process.cwd()): Set<string> {
  const out = new Set<string>();
  const real = path.join(root, GUARD);
  const sf = sourceFile(existsSync(real) ? real : path.join(root, GUARD_FIXTURE));
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'VERDICTS' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const p of node.initializer.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isStringLiteralLike(p.name)) continue;
        if (!ts.isArrayLiteralExpression(p.initializer)) continue;
        const [verdict] = p.initializer.elements;
        if (verdict && ts.isStringLiteralLike(verdict) && verdict.text === 'pre-auth') {
          out.add(p.name.text);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__fixtures__' || entry === 'node_modules') continue;
      walk(full, acc);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      acc.push(full);
    }
  }
  return acc;
}

/** An argument that is literally `undefined` does not bind anything. */
function bindsSomething(arg: ts.Expression | undefined): boolean {
  if (!arg) return false;
  return !(ts.isIdentifier(arg) && arg.text === 'undefined');
}

/**
 * Every `<x>Repository.<method>(…)` call under `tests/`, classified.
 *
 * A call whose method is absent from the repository index is NOT silently
 * dropped and NOT defaulted to `in-scope` — it is returned in `unclassifiable`
 * so the guard can fail on it. A shape this scanner cannot rule on must stop the
 * build, because the alternative is a call site nobody ever looks at again.
 */
export function scanTestCallSites(root = process.cwd()): {
  sites: TestCallSite[];
  unclassifiable: { file: string; line: number; callee: string }[];
} {
  const index = repositoryIndex(root);
  const preAuth = preAuthKeys(root);
  const sites: TestCallSite[] = [];
  const unclassifiable: { file: string; line: number; callee: string }[] = [];

  for (const full of walk(path.join(root, TESTS_DIR))) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    const sf = sourceFile(full);

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text.endsWith('Repository')
      ) {
        const repository = node.expression.expression.text;
        const method = node.expression.name.text;
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const entry = index.get(`${repository}.${method}`);

        if (!entry) {
          unclassifiable.push({ file: rel, line, callee: `${repository}.${method}` });
        } else {
          const bound = entry.txIndex !== null && bindsSomething(node.arguments[entry.txIndex]);
          const verdict: TestCallSiteVerdict = !entry.gated
            ? 'not-gated'
            : preAuth.has(`${entry.file}#${method}`)
              ? 'pre-auth'
              : entry.txIndex === null
                ? 'needs-binding-first'
                : bound
                  ? 'already-bound'
                  : rel in ADJUDICATED_UNBOUND_FILES
                    ? 'adjudicated-unbound'
                    : 'in-scope';
          sites.push({
            file: rel,
            line,
            repository,
            method,
            key: `${rel}:${line}`,
            bound,
            verdict,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  sites.sort((a, b) => a.key.localeCompare(b.key));
  return { sites, unclassifiable };
}

/** Count by verdict — what the ratchet and the story's table are stated in. */
export function countByVerdict(sites: TestCallSite[]): Record<TestCallSiteVerdict, number> {
  const counts: Record<TestCallSiteVerdict, number> = {
    'in-scope': 0,
    'not-gated': 0,
    'pre-auth': 0,
    'needs-binding-first': 0,
    'already-bound': 0,
    'adjudicated-unbound': 0,
  };
  for (const s of sites) counts[s.verdict] += 1;
  return counts;
}
