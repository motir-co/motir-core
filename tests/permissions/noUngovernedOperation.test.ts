import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// The NO-UNGOVERNED-OPERATION guard (Story MOTIR-2255 · Subtask MOTIR-2278).
//
// This is the INVERSE of the orphan guard. That one asserts *every permission
// has a consumer* — no key exists that nothing enforces. This one asserts
// *every actor-initiated operation has an answer* — no operation exists that no
// permission covers.
//
// The asymmetry is why this direction was the one missing. A permission nobody
// enforces is a lie VISIBLE on the settings page, so it gets noticed. An
// operation no permission covers is invisible everywhere, because a missing gate
// looks exactly like a working feature. That is how 82 of 122 services reached
// production ungoverned while the 11 that were governed were carefully tested.
//
// ⚠️ THE ALLOWLIST IS DERIVED FROM THE INVENTORY, NOT HAND-WRITTEN. A bare list
// of paths is a place to put things you would rather not think about, and it
// grows until the guard means nothing. Here, an operation may be un-gated only
// because `docs/decisions/permission-inventory.md` records a DECISION for it —
// so skipping the guard requires arguing with a document, not editing an array.

const ROOT = join(__dirname, '..', '..');
const DOC = join(ROOT, 'docs', 'decisions', 'permission-inventory.md');

// A gate — the shipped `assertCan*` surface, the capability reads, or the
// permission model itself.
//
// ⚠️ `assertPermission(` IS ON THIS LIST, and it has to be. MOTIR-2293 made
// `projectAccessService.assertPermission(projectId, ctx, key, tx?)` THE
// administrative gate — one method that takes the key, rather than twelve named
// `assertCanX`. A walk that only knows the `assertCan*` shape would read every
// operation MOTIR-2256 wires as UNGOVERNED, and the pinned counts below would
// climb as the story CLOSED holes. That is the MOTIR-2292 failure exactly: an
// instrument that under-reports gates in the alarming direction sends the next
// card looking for holes that are not there. The pattern is deliberately loose
// on the receiver so a service's own thin adapter onto the shared gate (e.g.
// `projectMembersService`'s module-local `assertPermission`) counts too — the
// adapter's whole body is one call to the real gate.
//
// ⚠️ AND `isOwnerRole(` / `isWorkspaceManager(` ARE ON IT TOO (MOTIR-2304), which
// is the other half of that card. Everything above recognises a CALL TO A KNOWN
// GATE FUNCTION — so the pattern can only ever see authorization somebody routed
// through a name it already knows. Three services do not: `boardsService`'s
// `assertBoardConfigAdmin`, `workflowsService`'s `assertProjectAdmin` and
// `estimationService`'s `assertEstimationAdmin` each resolve the actor's
// membership themselves and branch on `isOwnerRole(...)`. Following the call into
// the helper (the same-file hop below) finds the helper; it does not help unless
// the walk can also recognise the DECISION the helper makes when it gets there.
//
// These two are `lib/workspaces/roles.ts` / `lib/projects/roles.ts` predicates
// whose only purpose is to answer "may this actor do administrative things",
// so a `lib/services` body that calls one is consulting the access policy by
// definition. That is exactly the guard's question — not "is this gate the one
// we would choose" (the inventory's row decides that) but "does this operation
// consult the policy at all".
//
// ⚠️ AND `filterBrowsable(` IS ON IT (MOTIR-2365). It is the one gate shape that
// answers the question in the PLURAL: `workItemsService.quickSearch` resolves
// every project in the workspace and narrows to the browsable ones before it
// searches, so the mention-search operation IS governed — the walk simply had no
// name for "filter a set by the policy" as opposed to "assert one project". That
// is a real gate reached by a hop the walk could not follow, which is exactly the
// first of the two dispositions the CLAIMED_BUT_UNVERIFIED bucket asks for; the
// other five rows in its half of the bucket turned out to be the second, and got
// gates.
//
// ⚠️ AND `authorizePageSearch(` (MOTIR-9636). `pagesService.searchPages` takes
// its access in `lib/pages/pageSearchAccess.ts`, outside `lib/services`, so the
// walk cannot hop into it; its body is one `assertCanViewPages` call.
const GATE =
  /assertCan[A-Za-z]+|assertPermission\(|get[A-Za-z]*Capabilities|hasPermission\(|canManageProject\(|canBrowse\(|canEdit\(|is(?:Legacy)?OwnerRole\(|isWorkspaceManager\(|filterBrowsable\(|authorizePageSearch\(/;
/**
 * Every `someService.someMethod(` call in `source`.
 *
 * ⚠️ The regex is built FRESH per call and never shared. A `g`-flagged regex
 * carries `lastIndex` as mutable state, so one shared instance used inside the
 * recursion below has its cursor clobbered by the recursive call and the outer
 * loop never terminates. (Found the hard way — the first version of this file
 * hung the suite rather than failing it.)
 */
function serviceCalls(source: string): [string, string][] {
  return [...source.matchAll(/\b([a-z][A-Za-z0-9]*Service)\.([a-zA-Z_][\w]*)\s*\(/g)].map(
    (m) => [m[1]!, m[2]!] as [string, string],
  );
}

function walk(dir: string, hit: (p: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, hit);
    else hit(p);
  }
}

/**
 * The `{ … }` BODY of a method whose signature's opening `(` sits at `afterOpenParen - 1`,
 * or `null` when the source holds no body after it.
 *
 * ⚠️ WALK THE PARAMETER LIST FIRST. Taking the first `{` after the method NAME
 * looks right and is wrong the moment a parameter carries an inline object
 * type — `opts: { repoKeys?: string[] } = {}` — because that brace wins. The
 * "body" then IS the parameter, and a method whose first statement is an
 * `assertCanManage` reports as UNGOVERNED. That is not hypothetical: adding
 * exactly that parameter to three `aiConventionService` methods hid 24 gated
 * operations at once and moved this file's own pinned count (MOTIR-2292). So
 * advance by PAREN depth to the signature's closing `)`, and only then look
 * for the body.
 *
 * Split out of {@link serviceBodies} so the failure shape can be pinned by a
 * synthetic control below rather than by whatever `lib/services` happens to
 * contain today.
 */
function methodBody(src: string, afterOpenParen: number): string | null {
  let parenDepth = 1;
  let cursor = afterOpenParen;
  for (; cursor < src.length && parenDepth > 0; cursor++) {
    if (src[cursor] === '(') parenDepth += 1;
    else if (src[cursor] === ')') parenDepth -= 1;
  }
  if (parenDepth > 0) return null;
  const open = bodyBraceAfter(src, cursor);
  if (open < 0) return null;
  let depth = 0;
  let j = open;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}' && --depth === 0) break;
  }
  return src.slice(open, j + 1);
}

/**
 * The index of the BODY's opening brace, given `from` = just past the signature's
 * closing `)`. Returns -1 when there is no body (an overload signature, an
 * interface member).
 *
 * ⚠️ THE RETURN TYPE COMES FIRST, AND IT CAN CONTAIN BRACES (MOTIR-2443). Taking
 * the first `{` after `)` looks right and is wrong the moment a method returns an
 * object type — `): Promise<{ jobId: string }> {` — because THAT brace wins and
 * the "body" becomes `{ jobId: string }`. A method whose first statement is an
 * `assertPermission` then reports as UNGOVERNED. Reproduced on
 * `aiChatService.submitDiscoveryTurn`, whose gate the guard could not see the day
 * it was added.
 *
 * It is the MOTIR-2292 failure on the other side of the parameter list — that
 * repair walked the PARAMS by paren depth and stopped there — so the rule is the
 * mirror image: a `{` belongs to the TYPE, not the body, when it sits inside
 * `<…>` (a generic argument) or immediately follows a `:` (a bare object return
 * type). Skip those, and the first survivor is the body.
 */
function bodyBraceAfter(src: string, from: number): number {
  let angle = 0;
  let i = from;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ';') return -1; // an overload signature — no body at all
    if (ch === '<') angle += 1;
    else if (ch === '>') angle = Math.max(0, angle - 1);
    else if (ch === '{') {
      // Inside a generic argument, or the object type after a `:` — either way
      // this brace is the annotation's. Walk past it and keep looking.
      let prev = i - 1;
      while (prev >= from && /\s/.test(src[prev]!)) prev -= 1;
      if (angle > 0 || src[prev] === ':') {
        let depth = 0;
        for (; i < src.length; i++) {
          if (src[i] === '{') depth += 1;
          else if (src[i] === '}' && --depth === 0) break;
        }
        i += 1;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

/** Every service method body, by `service.method`. */
function serviceBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  const dir = join(ROOT, 'lib', 'services');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue;
    const svc = file.slice(0, -3);
    const src = readFileSync(join(dir, file), 'utf8');
    // Methods of the exported service object are indented exactly two spaces.
    const re = /^ {2}(?:async\s+)?([a-zA-Z_][\w]*)\s*(?:<[^>]*>)?\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const name = m[1]!;
      if (['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) continue;
      // `m[0]` ends AT the signature's opening `(`, so the walk starts just past it.
      const body = methodBody(src, m.index + m[0].length);
      if (body === null) continue;
      const key = `${svc}.${name}`;
      bodies.set(key, (bodies.get(key) ?? '') + body);
    }
  }
  return bodies;
}

/**
 * Every MODULE-LOCAL function body in each service file, by `service` → `name`
 * → body — the top-level `function` / `async function` declarations that sit
 * beside the exported service object rather than inside it.
 *
 * ⚠️ THIS IS THE HALF THE WALK NEVER HAD, AND WITHOUT IT `GATE` IS A NAME
 * WHITELIST (MOTIR-2304). The pattern lists the names the codebase happened to
 * use for its gates — `assertCan*`, `getXCapabilities`, `hasPermission(` — so a
 * service that factors its authorization into a privately-named helper is
 * invisible, and every operation behind that helper reports UNGOVERNED. Three
 * did, and their policy was not merely unseen but MISREAD: `boardsService`'s
 * `assertBoardConfigAdmin`, `workflowsService`'s `assertProjectAdmin` and
 * `estimationService`'s `assertEstimationAdmin` each resolve `isOwnerRole(...)`
 * — a gate TIGHTER than `project:administer`, reported as no gate at all. Three
 * cards under MOTIR-2256 were sized, argued and estimated on that inversion.
 *
 * It is the MOTIR-2292 failure one level up. That repair fixed WHERE the walk
 * looks (a parameter's inline object type was captured as the body) and left
 * WHAT it recognises alone, which is independent and was never checked. The
 * durable fix is not a longer whitelist — the next privately-named gate would be
 * invisible again — but the same-file hop the walk already makes ACROSS services
 * and never made within one.
 */
function localFunctionBodies(): Map<string, Map<string, string>> {
  const byService = new Map<string, Map<string, string>>();
  const dir = join(ROOT, 'lib', 'services');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue;
    const svc = file.slice(0, -3);
    const src = readFileSync(join(dir, file), 'utf8');
    // Top-level declarations only — column 0, so a nested closure is not one.
    const re = /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][\w]*)\s*(?:<[^>]*>)?\s*\(/gm;
    const locals = new Map<string, string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const body = methodBody(src, m.index + m[0].length);
      if (body === null) continue;
      locals.set(m[1]!, body);
    }
    if (locals.size > 0) byService.set(svc, locals);
  }
  return byService;
}

/**
 * Whether `source` CALLS the bare local function `name`.
 *
 * The negative lookbehind is what keeps `foo.assertThing(` from counting as a
 * call to a local `assertThing` — a method on some other object is not this
 * file's helper, and the cross-service hop already covers that case. Built fresh
 * per call, like `serviceCalls`, so no `lastIndex` state can leak.
 */
function callsLocal(source: string, name: string): boolean {
  return new RegExp(`(?<![.\\w$])${name}\\s*\\(`).test(source);
}

const BODIES = serviceBodies();
const LOCALS = localFunctionBodies();
const gateMemo = new Map<string, boolean>();

/**
 * Whether a body enforces a gate — directly, through a service it calls, or
 * through a MODULE-LOCAL helper in its own file. `svc` names the file so the
 * third hop knows which locals are in scope.
 */
function bodyIsGated(svc: string, body: string, seen: Set<string>): boolean {
  if (GATE.test(body)) return true;
  if (seen.size > 6) return false;
  // Hop 1 — across SERVICES (unchanged).
  for (const [otherSvc, method] of serviceCalls(body)) {
    if (methodIsGated(`${otherSvc}.${method}`, seen)) return true;
  }
  // Hop 1b — to a SIBLING method on the same service object (MOTIR-2443). The
  // walk hops across services and into module-local functions and could not see
  // the shortest hop of all: a method delegating to a sibling through `this.`
  // (`planChangeSessionsService.submitPublic` → `this.submit`, which asserts). `serviceCalls` cannot match it —
  // `this` is not a `…Service` identifier — so the receiver is matched on its own.
  for (const [, method] of [...body.matchAll(/\bthis\.([a-zA-Z_][\w]*)\s*\(/g)]) {
    if (methodIsGated(`${svc}.${method}`, seen)) return true;
  }
  // Hop 2 — into a MODULE-LOCAL function of the same file (MOTIR-2304). Recurses
  // through `bodyIsGated`, so a local calling another local, or a local calling
  // a service, resolves too.
  for (const [name, localBody] of LOCALS.get(svc) ?? []) {
    const localKey = `${svc}::${name}`;
    if (seen.has(localKey)) continue;
    if (!callsLocal(body, name)) continue;
    if (bodyIsGated(svc, localBody, new Set(seen).add(localKey))) return true;
  }
  return false;
}

/** Whether `service.method` enforces a gate, directly or through what it calls. */
function methodIsGated(key: string, seen = new Set<string>()): boolean {
  const memo = gateMemo.get(key);
  if (memo !== undefined) return memo;
  if (seen.has(key) || seen.size > 6) return false;
  const svc = key.slice(0, key.indexOf('.'));
  // A SHORTHAND service object — `export const svc = { getPanel, rollback };` —
  // has no indented method bodies for `serviceBodies` to find: each member IS a
  // module-local function of the same name (MOTIR-10036). Without this hop every
  // operation behind such a service read as UNGOVERNED however plainly the
  // function asserted, which is the MOTIR-2304 failure in another file shape.
  const body = BODIES.get(key) ?? LOCALS.get(svc)?.get(key.slice(svc.length + 1));
  if (body === undefined) return false;
  const gated = bodyIsGated(svc, body, new Set(seen).add(key));
  if (gated) gateMemo.set(key, true);
  return gated;
}

interface Operation {
  url: string;
  gated: boolean;
}

function operations(): Operation[] {
  const ops: Operation[] = [];
  walk(join(ROOT, 'app', 'api'), (p) => {
    if (!p.endsWith(`${'route'}.ts`)) return;
    const url =
      '/' +
      relative(join(ROOT, 'app'), p)
        .replace(/\\/g, '/')
        .replace(/\/route\.ts$/, '');
    const src = readFileSync(p, 'utf8');
    let gated = GATE.test(src);
    if (!gated) {
      gated = serviceCalls(src).some(([svc, method]) => methodIsGated(`${svc}.${method}`));
    }
    ops.push({ url, gated });
  });
  return ops.sort((a, b) => a.url.localeCompare(b.url));
}

const doc = readFileSync(DOC, 'utf8');

/**
 * The inventory's rows, indexed by operation.
 *
 * ⚠️ Cells are TRIMMED, never matched by prefix. Prettier pads markdown table
 * cells to align the columns, so a `line.startsWith('| \`/api/x\` |')` match
 * silently finds nothing and every lookup returns null — which reads as "the
 * inventory does not know about this route" for the whole table at once.
 */
const ROWS: Map<string, string[]> = new Map(
  doc
    .split('\n')
    .filter((l) => l.trimStart().startsWith('| `'))
    .map((l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    )
    .filter((cells) => cells.length >= 4)
    .map((cells) => [cells[0]!.replace(/`/g, ''), cells]),
);

/** The decision the inventory records for an operation, or null if absent. */
function decisionFor(url: string): string | null {
  const cells = ROWS.get(url);
  return cells ? (cells[cells.length - 2] ?? null) : null;
}

/**
 * Decisions that permanently justify NO project gate. These are answers, not
 * omissions — each is argued in the inventory's Reasons section.
 */
const PERMANENTLY_UNGATED = new Set([
  'workspace-scoped', // governed by the workspace role axis, out of this epic
  'user-scoped', // acts on the actor's own account
  'token-scoped', // narrowed by API-token scopes instead
  'no-gate', // no actor at all — serviceAuth, job runner, webhook
  'finding', // logged as a defect rather than silently permitted
  // Gated by platform standing (`requirePlatformStaff*` on the `User.platformRole`
  // ladder), never by a project key — the first ROUTE handlers to carry it are
  // the idea store's `/api/platform/ideas` (Story MOTIR-7662, R91). Kept in step
  // with `inventoryCoverage.test.ts`'s NON_PERMISSION set, which already admits it.
  'platform-scoped',
]);

/**
 * ✅ THE TWO COUNTING-DOWN ARMS ARE GONE (MOTIR-2356). Two decision sets used to
 * live here and be pinned by a `describe` below:
 *
 *   * **`PENDING`** (`new`) — an operation whose key the inventory had named and
 *     nobody had wired. It counted 95 → 0 across MOTIR-2256 and MOTIR-2291, and
 *     three of those falls were the INSTRUMENT being repaired rather than gates
 *     being added (MOTIR-2292, -2304, -2443), which is why every step had to say
 *     which kind it was.
 *   * **`CLAIMED_BUT_UNVERIFIED`** (`existing`) — an operation the inventory said
 *     was governed and this walk could not confirm. It counted 38 → 0 across
 *     MOTIR-2365 and MOTIR-2366; of the eighteen it still held after the
 *     instrument repairs, seven were holes and the rest were mis-mappings or
 *     gates the walk had no name for.
 *
 * Both files said, when they were written, that the arm is DELETED when its count
 * reaches zero rather than re-pinned at it — a pin at zero is a slot for the next
 * one to creep back into, and it makes an un-decided operation look decided. They
 * are deleted.
 *
 * What remains is the assertion that outlives them: an ungated operation must
 * carry a PERMANENTLY_UNGATED decision in the inventory. A new ungated route with
 * a `new` or `existing` decision now fails THAT test — it is not in the allowed
 * set — which is stricter than the pins ever were, because it does not wait for
 * a number to move.
 */

describe('every actor-initiated operation has an ANSWER', () => {
  const ops = operations();

  it('enumerates a real surface (a guard over an empty set passes for the wrong reason)', () => {
    expect(ops.length).toBeGreaterThan(200);
    expect(ops.filter((o) => o.gated).length).toBeGreaterThan(30);
  });

  it('no operation is ungated WITHOUT a decision recorded in the inventory', () => {
    const undecided = ops
      .filter((o) => !o.gated)
      .filter((o) => {
        const d = decisionFor(o.url);
        // ⚠️ ONLY `PERMANENTLY_UNGATED` now (MOTIR-2356). While the two stories
        // were in flight, `new` and `existing` were also accepted here — an
        // operation could be ungated because its gate was still coming. Both
        // stories have landed, so an ungated operation whose row still says
        // `new` or `existing` is no longer waiting for anything: it is undecided,
        // and this test says so.
        return d === null || !PERMANENTLY_UNGATED.has(d);
      })
      .map((o) => `${o.url} → ${decisionFor(o.url) ?? 'NOT IN THE INVENTORY'}`);
    expect(
      undecided,
      'an operation reaching the database with no gate must have a decided policy in ' +
        'docs/decisions/permission-inventory.md — add the row, do not add an exemption',
    ).toEqual([]);
  });

  it('every gated operation is one the inventory also knows about', () => {
    // The map must not fall behind in the other direction either.
    const unknown = ops.filter((o) => o.gated).filter((o) => decisionFor(o.url) === null);
    expect(
      unknown.map((o) => o.url),
      'a gated route still needs its inventory row',
    ).toEqual([]);
  });
});

describe('the guard can actually fail (a guard never seen red is not evidence)', () => {
  it('detects a gate in a governed service, and its absence in an ungoverned one', () => {
    // Positive control: projectAccessService.assertCanEdit plainly gates.
    expect(methodIsGated('projectAccessService.assertCanEdit')).toBe(true);
    // Negative control: a method that does not exist cannot be gated, and a
    // known-ungoverned service reports false rather than defaulting to true.
    expect(methodIsGated('projectAccessService.__doesNotExist')).toBe(false);
    expect(methodIsGated('dashboardsService.listDashboards')).toBe(false);
  });

  it('finds a gate that sits after a parameter carrying an INLINE OBJECT TYPE', () => {
    // The MOTIR-2292 regression, pinned. `methodBody` used to take the first
    // `{` after the method NAME, so this parameter captured it, the "body"
    // became `{ repoKeys?: string[] }`, and the assert on the next line was
    // invisible. The synthetic source keeps the control honest even if every
    // real service later drops the shape.
    const src = [
      'export const svc = {',
      '  async reaudit(',
      '    projectId: string,',
      '    ctx: AccessActorContext,',
      '    opts: { repoKeys?: string[] } = {},',
      '  ): Promise<void> {',
      '    await projectAccessService.assertCanManage(projectId, ctx);',
      '  },',
      '};',
    ].join('\n');
    const open = src.indexOf('(', src.indexOf('reaudit')) + 1;
    const body = methodBody(src, open);
    expect(body, 'the parameter list must be walked before the body is found').not.toBeNull();
    expect(GATE.test(body!), 'the gate inside the real body must be visible').toBe(true);
    // …and the same helper still reports NO gate when there genuinely is none,
    // so the fix is not just "answer true more often".
    const ungated = src.replace('await projectAccessService.assertCanManage(projectId, ctx);', '');
    expect(
      GATE.test(methodBody(ungated, ungated.indexOf('(', ungated.indexOf('reaudit')) + 1)!),
    ).toBe(false);
  });

  it('finds a gate behind a RETURN TYPE that carries braces', () => {
    // The MOTIR-2443 regression, pinned. `methodBody` walked the PARAMETER list
    // by paren depth (the MOTIR-2292 repair) and then took the first `{` — which
    // is the return annotation's when the method returns an object type. The
    // "body" became `{ jobId: string }` and the assert on the next line was
    // invisible. Both the generic form and the bare object form are here: the
    // first is what `aiChatService.submitDiscoveryTurn` actually looks like.
    const generic = [
      'export const svc = {',
      '  async submitDiscoveryTurn(',
      '    prompt: string,',
      '    ctx: ProjectContext,',
      '  ): Promise<{ jobId: string }> {',
      "    await projectAccessService.assertPermission(ctx.projectId, ctx, 'ai:plan');",
      '  },',
      '};',
    ].join('\n');
    const bodyOf = (src: string, name: string): string | null =>
      methodBody(src, src.indexOf('(', src.indexOf(name)) + 1);
    expect(GATE.test(bodyOf(generic, 'submitDiscoveryTurn')!)).toBe(true);

    const bare = [
      'export const svc = {',
      '  async counts(projectId: string, ctx: Ctx): { created: number } {',
      '    await projectAccessService.assertCanBrowse(projectId, ctx);',
      '  },',
      '};',
    ].join('\n');
    expect(GATE.test(bodyOf(bare, 'counts')!)).toBe(true);

    // …and the repair is not just "answer true more often": with the assert
    // removed, the same shape still reports NO gate.
    const ungated = generic.replace(
      "    await projectAccessService.assertPermission(ctx.projectId, ctx, 'ai:plan');",
      '    return submitJob();',
    );
    expect(GATE.test(bodyOf(ungated, 'submitDiscoveryTurn')!)).toBe(false);
  });

  it('follows a `this.` hop to a sibling method, and still says no when the sibling gates nothing', () => {
    // The other half of MOTIR-2443. `serviceCalls` matches `someService.method(`
    // only, so a method delegating to a sibling on the SAME object was a dead
    // end — `planChangeSessionsService.submitPublic` reads as ungated however
    // plainly `this.submit` asserts. (The original instance, `getOrCreateForProject`,
    // was deleted by MOTIR-6028; this is the same shape in shipped code.) Driven through the REAL
    // walk rather than a synthetic string, because the hop is a property of
    // `bodyIsGated`'s recursion, not of one regex.
    expect(methodIsGated('planChangeSessionsService.submitPublic')).toBe(true);
    // The negative control: a delegating method whose target gates nothing.
    expect(methodIsGated('dashboardsService.listDashboards')).toBe(false);
  });

  it('follows a call into a MODULE-LOCAL helper, and still says no when the helper gates nothing', () => {
    // The MOTIR-2304 regression, pinned. `GATE` is a whitelist of NAMES, so a
    // service that factors its authorization into a privately-named helper read
    // as UNGOVERNED however plainly the helper asserted. Both halves are here
    // deliberately: without the negative one, "follow local calls" is
    // indistinguishable from "answer true more often", which is the same trap
    // MOTIR-2292's control was written to close.
    const gatedSrc = [
      'async function assertBoardConfigAdmin(userId: string, projectId: string) {',
      '  const m = await workspaceMembershipRepository.findByUserAndWorkspace(userId, projectId);',
      '  if (!isOwnerRole(m?.role)) throw new NotBoardAdminError();',
      '  await projectAccessService.assertCanBrowse(projectId, ctx);',
      '}',
      'export const svc = {',
      '  async addColumn(boardId: string, ctx: ServiceContext) {',
      '    await assertBoardConfigAdmin(ctx.userId, boardId);',
      '  },',
      '};',
    ].join('\n');
    const gatedLocals = new Map([
      ['assertBoardConfigAdmin', methodBody(gatedSrc, gatedSrc.indexOf('(') + 1)!],
    ]);
    const addColumnBody = methodBody(
      gatedSrc,
      gatedSrc.indexOf('(', gatedSrc.indexOf('addColumn')) + 1,
    )!;
    // The method's own body holds no GATE token — the whole point.
    expect(GATE.test(addColumnBody)).toBe(false);
    expect(callsLocal(addColumnBody, 'assertBoardConfigAdmin')).toBe(true);
    expect(GATE.test(gatedLocals.get('assertBoardConfigAdmin')!)).toBe(true);

    // Negative half: a module-local helper that asserts NOTHING must leave the
    // caller ungated.
    const ungatedSrc = gatedSrc
      .replace('  if (!isOwnerRole(m?.role)) throw new NotBoardAdminError();\n', '')
      .replace('  await projectAccessService.assertCanBrowse(projectId, ctx);\n', '');
    const ungatedLocal = methodBody(ungatedSrc, ungatedSrc.indexOf('(') + 1)!;
    expect(GATE.test(ungatedLocal), 'a helper that gates nothing must not read as a gate').toBe(
      false,
    );

    // …and a DOTTED call to a same-named method on another object is not this
    // file's helper, so it must not satisfy the local hop.
    expect(callsLocal('await other.assertBoardConfigAdmin(x);', 'assertBoardConfigAdmin')).toBe(
      false,
    );
  });

  it('resolves a SHORTHAND service object to its module-local functions', () => {
    // The MOTIR-10036 regression, pinned: `productionPanelService` and
    // `productionRollbackService` export `{ fn, … }` objects, and their gates sit
    // in the module-local functions those members name.
    expect(methodIsGated('productionRollbackService.rollbackProduction')).toBe(true);
    expect(methodIsGated('productionPanelService.getProductionPanel')).toBe(true);
    expect(methodIsGated('productionPanelService.rollback')).toBe(true);
    // Negative control: a shorthand member that does not exist is not gated.
    expect(methodIsGated('productionPanelService.__doesNotExist')).toBe(false);
  });

  it('sees the three real privately-named gates, and reads their operations as governed', () => {
    // Each of these is a top-level `async function assert…` beside its service
    // object, resolving `isOwnerRole(...)`. None matches `assertCan*`, so all
    // three — and every operation behind them — reported UNGOVERNED, which is
    // how three MOTIR-2256 cards came to be written claiming their domains had
    // "no project gate at all" when the gates were there and TIGHTER than
    // `project:administer`.
    expect(LOCALS.get('boardsService')?.has('assertBoardConfigAdmin')).toBe(true);
    expect(LOCALS.get('workflowsService')?.has('assertProjectAdmin')).toBe(true);
    expect(LOCALS.get('estimationService')?.has('assertEstimationAdmin')).toBe(true);

    expect(methodIsGated('boardsService.addColumn')).toBe(true);
    expect(methodIsGated('boardsService.deleteColumn')).toBe(true);
    expect(methodIsGated('boardsService.createBoard')).toBe(true);
    expect(methodIsGated('workflowsService.createStatus')).toBe(true);
    expect(methodIsGated('workflowsService.deleteStatus')).toBe(true);
    expect(methodIsGated('estimationService.updateEstimationConfig')).toBe(true);
  });

  it('sees the three real service methods the regression hid', () => {
    // Each takes an `opts: { … } = {}` parameter and asserts on its first line;
    // all three read as UNGOVERNED before the fix, and with them 24 operations.
    expect(methodIsGated('aiConventionService.reaudit')).toBe(true);
    expect(methodIsGated('aiConventionService.getAudit')).toBe(true);
    expect(methodIsGated('aiConventionService.getConvention')).toBe(true);
  });

  it('flags a synthetic ungated operation that has no inventory row', () => {
    // Exactly the check the suite runs, against a route that does not exist —
    // proving the failure path is reachable rather than merely never taken.
    const synthetic = { url: '/api/definitely-not-a-real-route', gated: false };
    const decision = decisionFor(synthetic.url);
    expect(decision).toBeNull();
    const wouldFail = decision === null || !PERMANENTLY_UNGATED.has(decision);
    expect(wouldFail, 'an unknown ungated operation must be rejected').toBe(true);
  });

  it('rejects a decision string that is not one of the five', () => {
    expect(PERMANENTLY_UNGATED.has('probably-fine')).toBe(false);
    // …and the two that USED to be accepted are not, now that nothing is pending
    // (MOTIR-2356). This is the assertion that makes the deletion of the counting
    // arms a tightening rather than a removal of coverage.
    expect(PERMANENTLY_UNGATED.has('new')).toBe(false);
    expect(PERMANENTLY_UNGATED.has('existing')).toBe(false);
  });
});
