import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  findRefreshCalls,
  reachableFrom,
  scanLivePaths,
  type LocatedFinding,
} from './helpers/liveRefreshScan';

// NO ROUTE REFRESH ON A LIVE PATH (Story MOTIR-8539 criterion 7 · Subtask MOTIR-8578).
//
// The story's code cards took the route refresh off the Workbench, To approve,
// Planning, the plan overlay and the open approval, each asserting it in its own
// files. This is the permanent form of that removal: the set of source files
// REACHABLE from those live-update paths holds no `router.refresh()`, no
// `useCoordinatedRefresh` and no `window.location` navigation — except the
// entries below, each a refresh that runs only on the reader's OWN press.
//
// ⚠️ REACHABILITY, NOT A DIRECTORY GLOB. The item page and the other authed pages
// refresh after the reader's own edit, and the story leaves them alone; a glob
// over `components/` would flag them all. A static import walk from the roots is
// what separates a live path from the rest of the app — and it is also what
// catches a NEW helper a live path starts importing, which no file-local check
// in the five code cards can see.
//
// The runtime counterpart is the story's E2E, which counts refreshes on the
// paths it drives; this guard covers the paths nobody drives.

const WORKBENCH = 'app/(authed)/workbench/_components/';

/** Every file of a root directory — a new file there is a root the day it lands. */
function filesOf(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir))
    .filter((f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f))
    .sort()
    .map((f) => `${dir}/${f}`);
}

/** The live-update paths. A renamed or deleted root fails the guard, never shrinks it. */
const ROOT_FILES = [
  `${WORKBENCH}WorkbenchLive.tsx`,
  `${WORKBENCH}useWorkbenchLive.ts`,
  `${WORKBENCH}useWorkbenchWindow.ts`,
  `${WORKBENCH}WorkbenchLiveView.tsx`,
  `${WORKBENCH}WorkbenchList.tsx`,
  `${WORKBENCH}WorkbenchTabs.tsx`,
  `${WORKBENCH}ApprovalsList.tsx`,
  `${WORKBENCH}PlanningList.tsx`,
  // MOTIR-8581: the window the view hands To approve and Planning.
  `${WORKBENCH}useTabWindowContent.ts`,
  'lib/live/liveSignal.ts',
  'components/approvals/ApprovalOverlay.tsx',
  'lib/approvals/approvalOverlayClient.ts',
  'components/planning/PlanDetail.tsx',
  'components/planning/PlanningWorkspaceHost.tsx',
  'components/planning/GuideWorkspaceHost.tsx',
  'lib/hooks/useGeneratingPlanPoll.ts',
  'lib/hooks/usePlanGeneration.ts',
  'lib/hooks/usePlanChangeConversation.ts',
  'lib/planning/mergePlanReview.ts',
  'lib/planning/planReviewClient.ts',
] as const;

/** Directories whose every file is a root (`lib/workbench/*` holds MOTIR-8576's reread seam). */
const ROOT_DIRS = ['lib/live/sources', 'lib/workbench'] as const;

interface Allowed {
  file: string;
  symbol: string;
  reason: string;
  /** For an exemption that rests on a fact elsewhere in the tree: that fact, checked. */
  holds?: () => boolean;
}

const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

/**
 * The exemptions, written from the first real run (13 findings over 544 files).
 * One per `{ file, symbol }`; a symbol, never a whole file.
 */
const ALLOWED: readonly Allowed[] = [
  {
    file: 'components/approvals/ApprovalOverlay.tsx',
    symbol: 'onDecide',
    reason:
      "the reader's OWN decision press — the story's scope edge keeps this refresh, and the " +
      'overlay explains it beside the call (MOTIR-8577).',
  },
  {
    file: 'components/approvals/ApprovalOverlay.tsx',
    symbol: 'onEdited',
    reason:
      "the reader's OWN edit in the quick view the overlay opens: it re-reads the page behind " +
      'the overlay after a write the reader just made.',
  },
  {
    file: 'components/approvals/ApprovalRow.tsx',
    symbol: 'press',
    reason: "the reader's OWN Approve on a To approve row, after the decision is announced.",
  },
  {
    file: 'components/github/DevelopmentGateFrame.tsx',
    symbol: 'onDecide',
    reason:
      "the reader's OWN Approve / Request changes on the Development block's gate (three " +
      'arms: an agent review, approve-and-merge, a send-back).',
  },
  {
    file: 'components/github/DevelopmentGateFrame.tsx',
    symbol: 'onDismissed',
    reason:
      "the reader's OWN Dismiss the review press (MOTIR-10342): the card page re-reads after " +
      'the dismissal it just made; inside the overlay the overlay’s own re-read runs instead.',
  },
  {
    file: 'components/github/DevelopmentGateFrame.tsx',
    symbol: 'retryMember',
    reason: "the reader's OWN retry of one pull request the host refused to merge.",
  },
  {
    file: 'components/github/DevelopmentGateFrame.tsx',
    symbol: 'pressReviewAgain',
    reason: "the reader's OWN *Review again* press, which starts one review run.",
  },
  {
    file: 'components/github/DevelopmentGateFrame.tsx',
    symbol: 'onShowCurrentVersion',
    reason: "the reader's OWN *Show the current version* press on a withdrawn gate.",
  },
  {
    file: 'components/github/QueueExitAutoPart.tsx',
    symbol: 'queueAgain',
    reason: "the reader's OWN *Queue again* press on a pull request the merge queue ejected.",
  },
  {
    file: 'components/howToTest/HowToTestWrite.tsx',
    symbol: 'save',
    reason: "the reader's OWN save of a How to test they wrote.",
  },
  {
    file: 'app/(authed)/items/[key]/_components/translation/TranslationProvider.tsx',
    symbol: 'refresh',
    reason:
      'NEVER MOUNTED on a live path. It is `LiveOfferRefresh`, rendered only under ' +
      "`liveRefresh`, which only the item page's own view passes; the quick view the approval " +
      'overlay opens (`IssueQuickViewPanel`) does not. `holds` checks exactly that.',
    holds: () =>
      !/<TranslationProvider\b[^>]*\bliveRefresh\b/.test(
        read('app/(authed)/items/_components/IssueQuickViewPanel.tsx'),
      ),
  },
];

const describeFinding = (f: LocatedFinding) =>
  `${f.file}:${f.line} ${f.kind} in ${f.symbol}\n    reached by ${f.chain.join(' → ')}`;

const isAllowed = (f: LocatedFinding, allowed: readonly Allowed[]) =>
  allowed.some((a) => a.file === f.file && a.symbol === f.symbol);

/** Exemptions that no longer match any finding — an exemption cannot outlive its code. */
function staleEntries(allowed: readonly Allowed[], findings: readonly LocatedFinding[]): Allowed[] {
  return allowed.filter((a) => !findings.some((f) => f.file === a.file && f.symbol === a.symbol));
}

let memo: ReturnType<typeof scanLivePaths> | null = null;
function scan() {
  memo ??= scanLivePaths([...ROOT_FILES, ...ROOT_DIRS.flatMap(filesOf)]);
  return memo;
}

describe('the live paths carry no route refresh (MOTIR-8578)', () => {
  it('every root exists, and every root directory holds a root', () => {
    for (const root of ROOT_FILES) {
      expect(existsSync(join(REPO_ROOT, root)), `root ${root} is gone`).toBe(true);
    }
    for (const dir of ROOT_DIRS) {
      expect(filesOf(dir).length, `root directory ${dir} is empty`).toBeGreaterThan(0);
    }
    expect(() => reachableFrom(['lib/live/not-a-root.ts'])).toThrow(/does not exist/);
  });

  it('the closure is clean after the allowlist', { timeout: 60_000 }, () => {
    const { closure, findings } = scan();
    // A walk that reached nothing would pass vacuously; the roots alone are ~30 files.
    expect(closure.size).toBeGreaterThan(100);
    const unexplained = findings.filter((f) => !isAllowed(f, ALLOWED));
    expect(
      unexplained.map(describeFinding),
      'A refresh is reachable from a live-update path. Remove it — the surface applies its ' +
        "own read in place — or, if it runs ONLY on the reader's own press, add an ALLOWED " +
        'entry naming the symbol and why.',
    ).toEqual([]);
  });

  it(
    'every exemption still matches a finding, and its stated fact still holds',
    { timeout: 60_000 },
    () => {
      const { findings } = scan();
      expect(staleEntries(ALLOWED, findings).map((a) => `${a.file} · ${a.symbol}`)).toEqual([]);
      for (const a of ALLOWED) {
        expect(a.reason.length, `${a.file} · ${a.symbol} has no reason`).toBeGreaterThan(40);
        if (a.holds) expect(a.holds(), `${a.file} · ${a.symbol}: ${a.reason}`).toBe(true);
      }
      // And the staleness check itself bites.
      const ghost: Allowed = { file: 'lib/gone.ts', symbol: 'onGone', reason: 'x'.repeat(41) };
      expect(staleEntries([...ALLOWED, ghost], findings)).toEqual([ghost]);
    },
  );
});

describe('findRefreshCalls — the forbidden shapes, read from the AST', () => {
  const kinds = (src: string) => findRefreshCalls(src, 'x.tsx').map((f) => f.kind);

  it('`router.refresh()` on a `useRouter()` binding, a `router`, or the hook itself', () => {
    expect(kinds(`const r = useRouter(); function a() { r.refresh(); }`)).toEqual([
      'router.refresh',
    ]);
    expect(kinds(`function a(router) { router.refresh(); }`)).toEqual(['router.refresh']);
    expect(kinds(`const { refresh } = useRouter(); refresh();`)).toEqual(['router.refresh']);
    expect(kinds(`useRouter().refresh();`)).toEqual(['router.refresh']);
    expect(kinds(`props.router.refresh();`)).toEqual(['router.refresh']);
  });

  it('a `.refresh` that is not a router, a comment and a string are not findings', () => {
    expect(kinds(`session.refresh(); refreshToken();`)).toEqual([]);
    expect(
      kinds(`// router.refresh()\n/* router.refresh() */ const s = 'router.refresh()';`),
    ).toEqual([]);
  });

  it('`useCoordinatedRefresh` and any import of the coordinator', () => {
    expect(
      kinds(`import { useCoordinatedRefresh } from '@/lib/navigation/coordinatedRefresh';`),
    ).toEqual(['coordinatedRefresh import']);
    expect(
      kinds(`import { CoordinatedRefreshProvider } from '../navigation/coordinatedRefresh';`),
    ).toEqual(['coordinatedRefresh import']);
    expect(kinds(`const go = useCoordinatedRefresh;`)).toEqual(['useCoordinatedRefresh']);
  });

  it('`window.location` navigation, but never a read', () => {
    expect(
      kinds(
        [
          `window.location.assign('/a');`,
          `window.location.replace('/a');`,
          `window.location.reload();`,
          `location.reload();`,
          `window.location = '/a';`,
          `window.location.href = '/a';`,
          `location.href = '/a';`,
        ].join('\n'),
      ),
    ).toEqual(Array(7).fill('window.location navigation'));
    expect(
      kinds(
        `const here = window.location.href; const q = new URLSearchParams(window.location.search);`,
      ),
    ).toEqual([]);
  });

  it('names the line and the enclosing symbol — a JSX attribute or a binding', () => {
    const found = findRefreshCalls(
      `const r = useRouter();\nconst onSave = () => {\n  r.refresh();\n};\nconst el = <A onDone={() => r.refresh()} />;`,
      'x.tsx',
    );
    expect(found.map(({ line, symbol }) => ({ line, symbol }))).toEqual([
      { line: 3, symbol: 'onSave' },
      { line: 5, symbol: 'onDone' },
    ]);
  });
});

describe('the guard bites — fixture trees in a temp directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-refresh-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const write = (file: string, body: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), body);
  };
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        module: 'esnext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        paths: { '@/*': ['./*'] },
      },
    }),
  );
  write(
    'lib/refreshes.ts',
    `import { useRouter } from 'next/navigation';\nexport function useAfter() {\n  const router = useRouter();\n  return () => router.refresh();\n}\n`,
  );
  write(
    'lib/rootStatic.ts',
    `import { useAfter } from './refreshes';\nexport const a = useAfter;\n`,
  );
  write('lib/navigation/coordinatedRefresh.tsx', `export function useCoordinatedRefresh() {}\n`);
  write(
    'lib/coordinated.ts',
    `import { useCoordinatedRefresh } from '@/lib/navigation/coordinatedRefresh';\nexport const b = useCoordinatedRefresh;\n`,
  );
  write('lib/rootAlias.ts', `export { b } from '@/lib/coordinated';\n`);
  write('lib/assigns.ts', `export function leave() {\n  window.location.href = '/elsewhere';\n}\n`);
  write('lib/rootDynamic.ts', `export const load = () => import('./assigns');\n`);
  write(
    'lib/reads.ts',
    `// router.refresh() in prose is not a call\nexport const here = () => window.location.href + 'router.refresh()';\n`,
  );
  write('lib/rootReadOnly.ts', `export * from './reads';\n`);
  write(
    'lib/services/server.ts',
    `export function s(router: { refresh(): void }) { router.refresh(); }\n`,
  );
  write('lib/rootServer.ts', `import { s } from './services/server';\nexport const c = s;\n`);

  it('reports each forbidden shape with file, line and the chain from its root', () => {
    const { findings } = scanLivePaths(
      ['lib/rootStatic.ts', 'lib/rootAlias.ts', 'lib/rootDynamic.ts', 'lib/rootReadOnly.ts'],
      dir,
    );
    const shape = findings.map(({ file, line, kind, chain }) => ({ file, line, kind, chain }));
    expect(shape).toEqual(
      expect.arrayContaining([
        {
          file: 'lib/refreshes.ts',
          line: 4,
          kind: 'router.refresh',
          chain: ['lib/rootStatic.ts', 'lib/refreshes.ts'],
        },
        {
          // Reached through a re-export, via the `@/` alias.
          file: 'lib/coordinated.ts',
          line: 1,
          kind: 'coordinatedRefresh import',
          chain: ['lib/rootAlias.ts', 'lib/coordinated.ts'],
        },
        {
          // Reached through a literal dynamic import.
          file: 'lib/assigns.ts',
          line: 2,
          kind: 'window.location navigation',
          chain: ['lib/rootDynamic.ts', 'lib/assigns.ts'],
        },
      ]),
    );
    // The read-only file is in the closure and reports nothing.
    expect(findings.some((f) => f.file === 'lib/reads.ts')).toBe(false);
    expect(findings).toHaveLength(4);
  });

  it('the walk stops at the coordinator and at server-only modules', () => {
    const closure = reachableFrom(['lib/rootAlias.ts', 'lib/rootServer.ts'], dir);
    expect([...closure.keys()].sort()).toEqual([
      'lib/coordinated.ts',
      'lib/rootAlias.ts',
      'lib/rootServer.ts',
    ]);
  });
});
