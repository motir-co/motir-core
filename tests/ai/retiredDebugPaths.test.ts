import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// THE RETIREMENT GUARD for MOTIR-9216 on the motir-core side (MOTIR-9233). AMENDMENT
// 5 to the turn-intent decision retired the debug and new_session verdicts and the
// debug_bug job: every turn is one grounded read. Two arms, both over the CODE of
// lib/, app/, components/ and tests/ (comments stripped, strings kept):
//
//  1. no retired PRODUCER comes back — a debug_bug submit, the ask→debug claim, the
//     client's debug narration, a debugging / debugged / confirming settle member, or
//     (MOTIR-9327) the ungrounded debug reply and the debug_bug result parse;
//  2. the string literals 'debug' and 'new_session' are not used as a turn intent
//     outside the paths that READ a stored turn (the DTO vocabulary, the stale-result
//     parser, the stored-turn rendering, the debug landing, and the tests that seed
//     stored turns). Stored turns still load and render, so those reads stay.
//
// The motir-ai half of the search is recorded in the pull request: a test here
// cannot read another repository.

const ROOT = path.resolve(__dirname, '../..');
const DIRS = ['lib', 'app', 'components', 'tests'];
const SELF = 'tests/ai/retiredDebugPaths.test.ts';

/** Remove line and block comments, keeping string literals so a retired kind or
 *  outcome on the wire still counts. A quote never spans a line outside a template,
 *  so an apostrophe in JSX text costs at most the rest of its own line. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) {
        j += src[j] === '\\' ? 2 : 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const RETIRED: Record<string, RegExp> = {
  'a debug_bug submit': /['"`]debug_bug['"`]/,
  'the ask→debug claim': /\bclaimTurnIntent\b/,
  'the debug narration': /\bnarrateDebugFrame\b/,
  'the debug hand-off act': /\bredirectedDebug\b/,
  'a debugging settle member': /['"]debugging['"]/,
  'a debugged settle member': /['"]debugged['"]/,
  'a confirming settle member': /\boutcome\s*(?::|===|!==)\s*['"]confirming['"]/,
  // MOTIR-9327: the landing is fed by a confirmed offer, never a debug_bug result.
  'the ungrounded debug reply': /\bDEBUG_UNGROUNDED_REPLY\b/,
  'the debug_bug result parse': /\bparseDebugBug\b/,
};

// Each file allowed to keep a retired name, and which, with the reason.
const RETIRED_ALLOWED: Record<string, { names: string[]; why: string }> = {
  'tests/components/use-plan-change-debug.test.tsx': {
    names: ['a debugging settle member', 'a debugged settle member'],
    why: 'asserts a stale settle result of those shapes is ignored',
  },
  'tests/e2e/regression-ask-single-read.spec.ts': {
    names: ['a debug_bug submit'],
    why: 'the story spec asserts no debug_bug job is ever submitted',
  },
  'tests/e2e/regression-debug-with-motir-ai.spec.ts': {
    names: ['a debug_bug submit'],
    why: 'the bug-offer receipt asserts no debug_bug job is ever submitted',
  },
  'tests/ai/debugLanding.test.ts': {
    names: ['a debugged settle member'],
    why: 'debugLandingService’s own test, which stored landings still read',
  },
};

const INTENT_LITERAL = /['"](debug|new_session)['"]/;
const INTENT_CONTEXT = /intent|Intent|confirm/;

// The paths that READ a stored turn under a retired intent, or its confirm.
const INTENT_ALLOWED: Record<string, string> = {
  'lib/dto/planChange.ts': 'the stored-turn DTO vocabulary',
  'lib/planning/askResult.ts': 'readAskOutcome’s stale-result arms, which settle silent',
  'lib/test-ai-jobs-mock.ts': 'the acceptance mock’s result vocabulary',
  'lib/services/planChangeSessionsService.ts':
    'the stored debug landing claim and the person-pressed restart confirm',
  'lib/services/debugLandingService.ts': 'lands a stored debug turn',
  'components/planning/PlanChangeRail.tsx': 'renders a stored new-session confirm',
  'tests/components/debug-turn-rail.test.tsx': 'seeds stored debug turns and a confirm',
  'tests/components/use-plan-change-restart.test.tsx': 'seeds a stored confirm',
  'tests/components/planning-workspace-host.test.tsx': 'seeds a stored confirm',
  'tests/components/plan-change-rail-restart.test.tsx': 'seeds a stored confirm',
  'tests/ai/askEveryTurnReads.test.ts': 'seeds stored turns and stale results',
  'tests/ai/askSingleReadGate.test.ts': 'seeds stored turns and stale results',
  'tests/e2e/regression-ask-single-read.spec.ts': 'seeds a stored debug turn and a stored confirm',
  'tests/ai/planChangeSessionsCoverage.test.ts': 'seeds a stored debug turn',
  'tests/planning/planSessionRestart.test.ts': 'reads a stale result and a stored confirm',
  'tests/planning/askResult.test.ts': 'readAskOutcome’s stale-result arms',
  'tests/integration/planning/planSomethingNewGate.test.ts': 'reads the restart confirm',
  'tests/triage/triageBugConversationAnchor.test.ts': 'settles a stale debug result',
};

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) files.push(full);
  }
  return files;
}

const CODE = DIRS.flatMap((d) => sourceFiles(path.join(ROOT, d))).map((file) => ({
  rel: path.relative(ROOT, file).split(path.sep).join('/'),
  code: stripComments(readFileSync(file, 'utf8')),
}));

function retiredHits(code: string): string[] {
  return Object.entries(RETIRED)
    .filter(([, re]) => re.test(code))
    .map(([name]) => name);
}

function intentLines(code: string): string[] {
  return code
    .split('\n')
    .filter((line) => INTENT_LITERAL.test(line) && INTENT_CONTEXT.test(line))
    .map((line) => line.trim());
}

describe('stripComments', () => {
  it('drops comments and keeps strings', () => {
    const code = stripComments(
      "// 'debug_bug' retired\n/* narrateDebugFrame */ submit('debug_bug'); const u = 'http://x';",
    );
    expect(retiredHits(code)).toEqual(['a debug_bug submit']);
    expect(code).toContain("'http://x'");
  });

  it('an apostrophe in JSX text does not swallow the next line', () => {
    const code = stripComments("<p>don't</p>\nconst x = narrateDebugFrame;");
    expect(retiredHits(code)).toEqual(['the debug narration']);
  });

  it('the intent arm reads a turn-intent use, not a log level', () => {
    expect(intentLines("if (turn.intent === 'debug') x();\nlog('debug', msg);")).toEqual([
      "if (turn.intent === 'debug') x();",
    ]);
  });
});

describe('no retired debug path is left in motir-core (MOTIR-9216)', () => {
  it('no debug_bug submit, ask→debug claim, debug narration or retired settle member', () => {
    const found: string[] = [];
    for (const { rel, code } of CODE) {
      if (rel === SELF) continue;
      const allowed = RETIRED_ALLOWED[rel]?.names ?? [];
      for (const name of retiredHits(code)) {
        if (!allowed.includes(name)) found.push(`${rel}: ${name}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("'debug' and 'new_session' are turn intents only where a stored turn is read", () => {
    const found: string[] = [];
    for (const { rel, code } of CODE) {
      if (rel === SELF || INTENT_ALLOWED[rel]) continue;
      for (const line of intentLines(code)) found.push(`${rel}: ${line}`);
    }
    expect(found).toEqual([]);
  });

  it('every allow-listed file still exists, so the list cannot rot into a blanket pass', () => {
    const present = new Set(CODE.map((c) => c.rel));
    for (const rel of [...Object.keys(RETIRED_ALLOWED), ...Object.keys(INTENT_ALLOWED)]) {
      expect(present.has(rel), rel).toBe(true);
    }
  });
});
