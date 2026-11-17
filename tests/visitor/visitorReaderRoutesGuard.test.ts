import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// THE READER-ROUTES GUARD (MOTIR-6888).
//
// The Visitor route tree (`app/(visitor)/p/[identifier]/**`, Story MOTIR-6170)
// renders the MEMBER app's page bodies (MOTIR-6643). Two things those bodies do
// were written for a member and silently answer a Visitor with the reader's OWN
// project:
//
// 1. They build hrefs to MEMBER routes — a row's `/items/<key>`, a pager's
//    `/approvals?page=2`, a board filter's `/boards?…`. Followed from a Visitor
//    page, the member page reads the reader's active project. `proxy.ts`'s
//    referer + cookie redirect only rescues one while the `motir_visitor` cookie
//    survives. So every such address goes through `readerRoutes` /
//    `useReaderRoutes` (`lib/visitor/routes.ts`), which answers the Visitor path
//    on the Visitor tree and the member route everywhere else.
// 2. They call SERVER ACTIONS. A read action a Visitor view calls must resolve
//    its reader through `resolveActionReadActor`; a member-only action (a write,
//    or an edit picker a Visitor view never renders) must NOT — that half is
//    `visitorWriteDoorGuard.test.ts`, and this file only asks that every action
//    the Visitor tree can import has been CLASSIFIED, so a new read action cannot
//    arrive answering from the active project unnoticed.
//
// ── The population, measured, not remembered ────────────────────────────────
// The files checked are the IMPORT CLOSURE of the Visitor tree's pages and
// layout: every non-type import, followed through `@/` and relative specifiers.
// It over-approximates what a Visitor can reach (an edit dialog the body imports
// but never renders for a Visitor is in it), and that is deliberate: routing an
// address through `readerRoutes` is correct for a member too, so the guard asks
// every body in the closure rather than a hand-kept list of what a Visitor sees.
//
// ALLOWED and ACTIONS are asserted TIGHT: an entry that stops matching fails.

const ROOT = resolve(__dirname, '..', '..');
const VISITOR_TREE = 'app/(visitor)/p/[identifier]';

/** A member route's first segment — every route a shared body links to. */
export const MEMBER_ROUTE =
  /^\/(items|plans|approvals|runs|boards|roadmap|triage|backlog|sprints)(?=[/?#]|$)/;

/** Calls whose argument is where a member route BELONGS: the reader mapping, and cache revalidation (never a link). */
const WRAPPERS = new Set(['readerPath', 'path', 'view', 'revalidatePath']);

/**
 * Library builders that RETURN a member route. Their own literal is the route's
 * one spelling, so it is not flagged; every CALL to one is, unless it is wrapped
 * like a literal would be.
 */
const BUILDERS: { file: string; fn: string; takes?: 'routes' }[] = [
  { file: 'lib/boards/boardFilterHref.ts', fn: 'buildBoardFilterHref' },
  // The board header filter's hrefs (MOTIR-11565): a header change (which may
  // carry `?boardFilter=off`) and Reset to board filter.
  { file: 'lib/boards/boardHeaderFilter.ts', fn: 'buildBoardHeaderFilterHref' },
  { file: 'lib/boards/boardHeaderFilter.ts', fn: 'boardFilterResetHref' },
  { file: 'lib/runs/runsAddress.ts', fn: 'runsHref' },
  // The Approval records room's pager (MOTIR-6891).
  { file: 'lib/approvals/recordsAddress.ts', fn: 'approvalRecordsHref' },
  // Answers an object, not an href, so it takes the reader's routes as an input
  // (`routes`) instead of being wrapped: a call without one is flagged.
  { file: 'lib/planning/planDestination.ts', fn: 'planRowDestination', takes: 'routes' },
  // The planning overlay's host page; no Visitor body calls it, and one that
  // did would be flagged.
  { file: 'lib/planning/launcher.ts', fn: 'planningHostPathFor' },
];

/** Files whose member-route literals are the mapping itself, or not links. */
const EXEMPT_FILES = new Set(['lib/visitor/routes.ts', 'proxy.ts', ...BUILDERS.map((b) => b.file)]);

/**
 * Member routes still emitted RAW. Each one is owned by a named card that
 * empties it; nothing else may be added.
 */
const ALLOWED: { file: string; text: string; why: string }[] = [];

/**
 * Every export of every `'use server'` module in the closure. `read` actions are
 * called by a Visitor view and must resolve their reader through
 * `resolveActionReadActor`; `member` actions must not (a write, or a picker a
 * Visitor view never renders) and are answered for a Visitor exactly as for any
 * non-member. `owedBy` marks a read action that does not yet — the card that
 * fixes it empties the mark.
 */
const ACTIONS: {
  file: string;
  action: string;
  kind: 'read' | 'member';
  owedBy?: string;
}[] = [
  // READ — what a Visitor view fetches after its first paint.
  { file: 'app/(authed)/items/actions.ts', action: 'listRootIssuesAction', kind: 'read' },
  { file: 'app/(authed)/items/actions.ts', action: 'listChildIssuesAction', kind: 'read' },
  { file: 'app/(authed)/items/actions.ts', action: 'listFolderLevelAction', kind: 'read' },
  { file: 'app/(authed)/plans/_actions.ts', action: 'loadMoreSessionsAction', kind: 'read' },
  // MEMBER — writes, and the reads that only an edit affordance or a write's own
  // follow-up makes (the pickers, the How-to-test draft, the placement re-read,
  // the archive): a Visitor holds no key that draws any of them.
  {
    file: 'app/(authed)/items/[key]/acceptanceActions.ts',
    action: 'turnOnAcceptanceVideoAction',
    kind: 'member',
  },
  { file: 'app/(authed)/items/[key]/actions.ts', action: 'createLinkAction', kind: 'member' },
  { file: 'app/(authed)/items/[key]/actions.ts', action: 'linkMonitorIssueAction', kind: 'member' },
  { file: 'app/(authed)/items/[key]/actions.ts', action: 'linkPullRequestAction', kind: 'member' },
  {
    file: 'app/(authed)/items/[key]/actions.ts',
    action: 'listLinkCandidatesAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/actions.ts',
    action: 'listPullRequestCandidatesAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/actions.ts',
    action: 'loadHowToTestDraftAction',
    kind: 'member',
  },
  { file: 'app/(authed)/items/[key]/actions.ts', action: 'removeLinkAction', kind: 'member' },
  { file: 'app/(authed)/items/[key]/actions.ts', action: 'saveHowToTestAction', kind: 'member' },
  {
    file: 'app/(authed)/items/[key]/actions.ts',
    action: 'searchMonitorIssuesAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/actions.ts',
    action: 'unlinkMonitorIssueAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/actions.ts',
    action: 'unlinkPullRequestAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/approvalGateActions.ts',
    action: 'approveAndMergeAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/approvalGateActions.ts',
    action: 'decideApprovalGateAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/approvalGateActions.ts',
    action: 'queueAgainAutoAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/approvalGateActions.ts',
    action: 'retryApproveAndMergeMemberAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/commentActions.ts',
    action: 'addCommentAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/commentActions.ts',
    action: 'deleteCommentAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/commentActions.ts',
    action: 'editCommentAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/customFieldActions.ts',
    action: 'setCustomFieldValueAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/edit/actions.ts',
    action: 'changeStatusAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/edit/actions.ts',
    action: 'fileWorkItemAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/edit/actions.ts',
    action: 'getWorkItemPlacementAction',
    kind: 'member',
  },
  { file: 'app/(authed)/items/[key]/edit/actions.ts', action: 'updateIssueAction', kind: 'member' },
  {
    file: 'app/(authed)/items/[key]/labelComponentActions.ts',
    action: 'addComponentAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/labelComponentActions.ts',
    action: 'addLabelAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/labelComponentActions.ts',
    action: 'removeComponentAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/labelComponentActions.ts',
    action: 'removeLabelAction',
    kind: 'member',
  },
  { file: 'app/(authed)/items/[key]/todoActions.ts', action: 'addTodoAction', kind: 'member' },
  { file: 'app/(authed)/items/[key]/todoActions.ts', action: 'deleteTodoAction', kind: 'member' },
  // Read only by the guide overlay, which a Visitor never opens (MOTIR-7466).
  { file: 'app/(authed)/items/[key]/todoActions.ts', action: 'listTodosAction', kind: 'member' },
  { file: 'app/(authed)/items/[key]/todoActions.ts', action: 'moveTodoAction', kind: 'member' },
  { file: 'app/(authed)/items/[key]/todoActions.ts', action: 'setTodoDoneAction', kind: 'member' },
  { file: 'app/(authed)/items/[key]/todoActions.ts', action: 'updateTodoAction', kind: 'member' },
  {
    file: 'app/(authed)/items/[key]/watcherActions.ts',
    action: 'addWatcherAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/watcherActions.ts',
    action: 'removeWatcherAction',
    kind: 'member',
  },
  {
    file: 'app/(authed)/items/[key]/watcherActions.ts',
    action: 'toggleWatchAction',
    kind: 'member',
  },
  { file: 'app/(authed)/items/actions.ts', action: 'createFolderAction', kind: 'member' },
  { file: 'app/(authed)/items/actions.ts', action: 'createIssueAction', kind: 'member' },
  { file: 'app/(authed)/items/actions.ts', action: 'deleteFolderAction', kind: 'member' },
  { file: 'app/(authed)/items/actions.ts', action: 'describeFolderDeletionAction', kind: 'member' },
  { file: 'app/(authed)/items/actions.ts', action: 'listArchivedWorkItemsAction', kind: 'member' },
  { file: 'app/(authed)/items/actions.ts', action: 'listCandidateParentsAction', kind: 'member' },
  {
    file: 'app/(authed)/items/actions.ts',
    action: 'listCreateLinkCandidatesAction',
    kind: 'member',
  },
  { file: 'app/(authed)/items/actions.ts', action: 'listProjectFoldersAction', kind: 'member' },
  { file: 'app/(authed)/items/actions.ts', action: 'moveFolderAction', kind: 'member' },
  { file: 'app/(authed)/items/actions.ts', action: 'renameFolderAction', kind: 'member' },
];

// ── the walk ────────────────────────────────────────────────────────────────

const rel = (abs: string) => relative(ROOT, abs).split(sep).join('/');

function resolveImport(fromRel: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(ROOT, dirname(fromRel), spec);
  else return null;
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.tsx?$/.test(candidate)) {
      return rel(candidate);
    }
  }
  return null;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** Every value import (and re-export) a source file makes. Type-only ones carry no code. */
function importsOf(sf: ts.SourceFile): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

function entries(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry === 'page.tsx' || entry === 'layout.tsx') out.push(rel(abs));
    }
  };
  walk(join(ROOT, VISITOR_TREE));
  return out;
}

function closure(): Map<string, ts.SourceFile> {
  const seen = new Map<string, ts.SourceFile>();
  const stack = entries();
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    const sf = parse(file, readFileSync(join(ROOT, file), 'utf8'));
    seen.set(file, sf);
    for (const spec of importsOf(sf)) {
      const next = resolveImport(file, spec);
      if (next && !next.startsWith('generated/')) stack.push(next);
    }
  }
  return seen;
}

function isUseServer(sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use server'
  );
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** Whether `node` sits inside an argument of one of the WRAPPERS. */
function isWrapped(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (
      ts.isCallExpression(at) &&
      at.arguments.some((arg) => arg.pos <= node.pos && node.end <= arg.end)
    ) {
      const name = calleeName(at);
      if (name && WRAPPERS.has(name)) return true;
    }
  }
  return false;
}

export interface RawRoute {
  file: string;
  line: number;
  text: string;
}

/**
 * The member routes a source file emits RAW — a literal naming one, or a call to
 * a registered builder, outside every wrapper. Pure over (path, text) so the
 * guard can be watched failing on a synthetic file.
 */
export function rawRoutesOf(file: string, text: string): RawRoute[] {
  const sf = parse(file, text);
  const builders = new Map(BUILDERS.map((b) => [b.fn, b]));
  const found: RawRoute[] = [];
  const position = (node: ts.Node, value: string): RawRoute => ({
    file,
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    text: value,
  });
  const report = (node: ts.Node, value: string) => {
    if (!isWrapped(node)) found.push(position(node, value));
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // An import specifier or a type position is not an address.
      if (
        !ts.isImportDeclaration(node.parent) &&
        !ts.isExportDeclaration(node.parent) &&
        !ts.isLiteralTypeNode(node.parent) &&
        MEMBER_ROUTE.test(node.text)
      ) {
        report(node, node.text);
      }
    } else if (ts.isTemplateExpression(node)) {
      if (MEMBER_ROUTE.test(node.head.text)) report(node, `${node.head.text}…`);
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const builder = name ? builders.get(name) : undefined;
      if (builder?.takes === 'routes') {
        const arg = node.arguments[0];
        const passesRoutes =
          !!arg &&
          ts.isObjectLiteralExpression(arg) &&
          arg.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'routes');
        if (!passesRoutes) found.push(position(node, `${name}(…) without routes`));
      } else if (builder) {
        report(node, `${name}(…)`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Each exported action of a `'use server'` module, with whether it names `resolveActionReadActor`. */
export function actionsOf(file: string, text: string): { action: string; readsActor: boolean }[] {
  const sf = parse(file, text);
  const out: { action: string; readsActor: boolean }[] = [];
  for (const st of sf.statements) {
    const exported = (ts.getModifiers(st as ts.HasModifiers) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;
    if (ts.isFunctionDeclaration(st) && st.name) {
      out.push({
        action: st.name.text,
        readsActor: st.getText(sf).includes('resolveActionReadActor'),
      });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          out.push({
            action: d.name.text,
            readsActor: d.getText(sf).includes('resolveActionReadActor'),
          });
        }
      }
    }
  }
  return out;
}

// ── the assertions ──────────────────────────────────────────────────────────

describe('the Visitor tree’s shared bodies build their addresses for the reader (MOTIR-6888)', () => {
  const files = closure();
  const scanned = [...files.keys()].filter(
    (f) => !EXEMPT_FILES.has(f) && !isUseServer(files.get(f)!) && !f.startsWith(`${VISITOR_TREE}/`),
  );

  it('walks the import closure of every Visitor page and layout', () => {
    // A sanity floor, not a pin: the closure is the eight page bodies and
    // everything they render, so it is large, and it grows.
    expect(entries().length).toBeGreaterThanOrEqual(11);
    expect(files.size).toBeGreaterThan(200);
    for (const b of BUILDERS) expect(files.has(b.file), b.file).toBe(true);
  });

  it('emits no member route raw, beyond the entries named cards still owe', () => {
    const raw = scanned.flatMap((f) => rawRoutesOf(f, files.get(f)!.getFullText()));
    const unexplained = raw.filter(
      (r) => !ALLOWED.some((a) => a.file === r.file && r.text.startsWith(a.text)),
    );
    expect(unexplained.map((r) => `${r.file}:${r.line} ${r.text}`)).toEqual([]);
    // TIGHT: an allowance nothing matches any more is removed, not kept.
    for (const a of ALLOWED) {
      expect(
        raw.some((r) => r.file === a.file && r.text.startsWith(a.text)),
        `stale allowance ${a.file} ${a.text}`,
      ).toBe(true);
    }
  });

  it('classifies every server action a Visitor page can import, and every read one reads the Visitor', () => {
    const seen = [...files.entries()]
      .filter(([, sf]) => isUseServer(sf))
      .flatMap(([file, sf]) => actionsOf(file, sf.getFullText()).map((a) => ({ file, ...a })));
    const key = (a: { file: string; action: string }) => `${a.file}#${a.action}`;
    expect(seen.map(key).sort()).toEqual(ACTIONS.map(key).sort());
    for (const a of ACTIONS) {
      const found = seen.find((s) => key(s) === key(a))!;
      if (a.kind === 'member') {
        expect(found.readsActor, `${key(a)} is member-only`).toBe(false);
      } else {
        // An owed read does NOT read the Visitor yet; the card that fixes it
        // removes `owedBy`, and until then this keeps the mark honest.
        expect(found.readsActor, `${key(a)}${a.owedBy ? ` (owed by ${a.owedBy})` : ''}`).toBe(
          !a.owedBy,
        );
      }
    }
  });

  it('flags a raw literal, a raw builder call and a raw template, and passes the wrapped forms', () => {
    const synthetic = [
      'const a = <a href={`/items/${key}`} />;',
      "const b = '/approvals?page=2';",
      'const c = buildBoardFilterHref({ filter });',
      "const d = routes.path('/items/archived');",
      'const e = routes.path(buildBoardFilterHref({ filter }));',
      'const f = readerPath(id, `/plans/${p}`);',
      "revalidatePath('/items');",
      "import x from '@/items/thing';",
      "const g = '/itemsfoo';",
      'const h = planRowDestination({ planId, host });',
      'const i = planRowDestination({ planId, host, routes });',
      'const j = routes.view(runsHref({ scope }));',
    ].join('\n');
    expect(rawRoutesOf('synthetic.tsx', synthetic).map((r) => r.line)).toEqual([1, 2, 3, 10]);
  });
});
