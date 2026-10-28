import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// ⚠️ EVERY `<MarkdownView` CALL SITE HANDS IT A WORK-ITEM REF MAP (bug MOTIR-10023).
//
// ── The defect this guards ──────────────────────────────────────────────────
// `MarkdownView` draws a `[KEY](motir:<id>)` link as a live chip only when the
// caller passes a `workItemRefs` map holding that id. With no map,
// `WorkItemRefChip` draws its `is-deleted` state ("This work item no longer
// exists"), and there is no context fallback. So a surface that renders a stored
// body without a map draws every card link in it as deleted — on an approval gate
// a reason to refuse, on an obsolescence note the card that replaced this one.
//
// The shape was fixed one surface at a time by MOTIR-9138 (page version view),
// MOTIR-9355 (proposal peek), MOTIR-9697 (plan summary) and MOTIR-10020 (decision
// port), and still left ten. Each was a surface that FORGOT the map, and nothing
// could notice: the type checker accepts the prop's absence, and the chip renders.
// This guard is what notices: a call site in `app/**` or `components/**` that
// passes no `workItemRefs` fails here, unless it is allowlisted below with the
// reason it cannot carry a link.
//
// A spread (`{...rest}`) is not accepted as carrying the map — it may or may not —
// so a site that forwards its caller's props is allowlisted by name with the
// caller that supplies it.

const ROOT = process.cwd();
const SCOPE = ['app', 'components'];

/** `<file>:<the value expression>` → why the site needs no map of its own. */
const ALLOWLIST: Record<string, string> = {
  'components/ui/MarkdownEditor.tsx:value':
    "the editor's live Preview of the text being typed — a draft, never a stored body",
  'app/tokens/markdown-editor/page.tsx:SAMPLE': 'the /tokens specimen route, fixed sample text',
  'app/tokens/markdown-editor/page.tsx:MENTION_SAMPLE':
    'the /tokens specimen route, fixed sample text',
  'components/planning/PlanBriefing.tsx:s.body':
    'spreads `refs`, which is `{ workItemRefs }` whenever the briefing has them',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

interface MarkdownViewSite {
  file: string;
  line: number;
  /** The `value={…}` expression, which names the site in the allowlist. */
  value: string;
  passesRefs: boolean;
}

/** Every `<MarkdownView …>` opening tag in a source text. Braces are balanced so an
 *  attribute's arrow function or object literal does not end the tag early. */
function markdownViewSites(file: string, src: string): MarkdownViewSite[] {
  const sites: MarkdownViewSite[] = [];
  const open = '<MarkdownView';
  for (let i = src.indexOf(open); i !== -1; i = src.indexOf(open, i + open.length)) {
    if (/[\w$]/.test(src[i + open.length] ?? '')) continue; // `<MarkdownViewProps` &c.
    let depth = 0;
    let end = i + open.length;
    for (; end < src.length; end++) {
      const c = src[end];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    const tag = src.slice(i, end + 1);
    sites.push({
      file,
      line: src.slice(0, i).split('\n').length,
      value: /\bvalue=\{([^}]*)\}/.exec(tag)?.[1]?.trim() ?? '',
      passesRefs: /\bworkItemRefs=\{/.test(tag),
    });
  }
  return sites;
}

function allSites(): MarkdownViewSite[] {
  return SCOPE.flatMap((dir) =>
    walk(join(ROOT, dir)).flatMap((path) =>
      markdownViewSites(relative(ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8')),
    ),
  );
}

const siteKey = (site: MarkdownViewSite) => `${site.file}:${site.value}`;

describe('every <MarkdownView> call site passes workItemRefs (MOTIR-10023)', () => {
  it('finds the call sites at all — a scanner that matches nothing passes everything', () => {
    expect(allSites().length).toBeGreaterThan(20);
  });

  it('has no call site without a ref map that is not allowlisted with a reason', () => {
    const missing = allSites()
      .filter((site) => !site.passesRefs && !(siteKey(site) in ALLOWLIST))
      .map((site) => `${site.file}:${site.line} (value={${site.value}})`);
    expect(
      missing,
      'These render Markdown with no workItemRefs, so every card link in them draws as ' +
        'deleted. Resolve the body on the server with resolveMarkdownWorkItemRefs ' +
        '(lib/workItems/resolveWorkItemRefs.ts), carry the map on the DTO and pass it, ' +
        'or allowlist the site here with the reason it cannot carry a link.',
    ).toEqual([]);
  });

  it('allowlists only sites that exist and still pass no map', () => {
    const bare = new Set(
      allSites()
        .filter((s) => !s.passesRefs)
        .map(siteKey),
    );
    expect(Object.keys(ALLOWLIST).filter((key) => !bare.has(key))).toEqual([]);
  });

  describe('the scanner', () => {
    it('reads a multi-line tag whose attributes hold braces and arrows', () => {
      const src = [
        '<MarkdownView',
        '  value={turn.body}',
        '  renderProposalRef={(id) => (<Ref id={id} />)}',
        '  workItemRefs={refs}',
        '/>',
        '<MarkdownView value={x} className="a" />',
        '<MarkdownViewProps />',
      ].join('\n');
      expect(markdownViewSites('f.tsx', src)).toEqual([
        { file: 'f.tsx', line: 1, value: 'turn.body', passesRefs: true },
        { file: 'f.tsx', line: 6, value: 'x', passesRefs: false },
      ]);
    });

    it('does not count a spread as carrying the map', () => {
      expect(markdownViewSites('f.tsx', '<MarkdownView {...rest} value={v} />')[0]).toMatchObject({
        passesRefs: false,
      });
    });
  });
});
