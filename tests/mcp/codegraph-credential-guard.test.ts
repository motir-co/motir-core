import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-11649 (story MOTIR-11497) — NO CODE-GRAPH CREDENTIAL IS READ OR HELD IN
// motir-core. The code-graph MCP reads (`code_explore`, `code_search`, `code_grep`)
// reach the service only through motir-ai's `POST /v1/code-graph/read`; the service's
// credential lives in motir-ai alone. (The guard was written for the name record's two
// tools; they were removed with the record in MOTIR-12265, and the rule still holds.) That is true today and stops being true
// the first time someone wires a tool straight to the service — an edit no runtime test
// can see, because a runtime test drives only the paths it knows. A scan of the tree can.
//
// ⚠️ THE PATTERNS ARE THE TWO SPECIFIC NAMES, NEVER THE `CODEGRAPH_` FAMILY. The bare
// prefix already matches the sandbox's own local codegraph CLI variables (e.g.
// `CODEGRAPH_TARGET_FILE` in `packages/cli/sandbox/agent-config.sh`), which are not the
// service's credential; a guard that starts red on a legitimate neighbour gets switched off.
//
// It reads the tree as data, imports no lib module and opens no database, so it runs in
// the structural-guard lane (`tests/helpers/structuralGuardLane.ts`).

const ROOT = resolve(__dirname, '..', '..');
const SELF = relative(ROOT, __filename).split('\\').join('/');
const CREDENTIAL_NAMES = [/MOTIR_CODEGRAPH_/, /CODEGRAPH_READ_SECRET/] as const;
/** A file over this many bytes is reported as unread rather than scanned. */
const MAX_BYTES = 2 * 1024 * 1024;

interface Hit {
  path: string;
  line: number;
  text: string;
}

/** Every line of `text` that names a code-graph credential, as `path:line`. */
function scanText(path: string, text: string): Hit[] {
  const hits: Hit[] = [];
  text.split('\n').forEach((line, i) => {
    if (CREDENTIAL_NAMES.some((re) => re.test(line))) {
      hits.push({ path, line: i + 1, text: line.trim() });
    }
  });
  return hits;
}

interface Scan {
  hits: Hit[];
  read: number;
  unread: string[];
  skipped: string[];
}

/** Scan the repository's TRACKED text files; binary and over-cap files are reported, not read. */
function scanTree(): Scan {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const scan: Scan = { hits: [], read: 0, unread: [], skipped: [] };
  for (const path of tracked) {
    if (path === SELF) {
      // It names its own patterns as literals; the planted case below is what keeps
      // this one exemption from quietly widening.
      scan.skipped.push(path);
      continue;
    }
    const full = resolve(ROOT, path);
    let size: number;
    try {
      size = statSync(full).size;
    } catch {
      scan.unread.push(path); // tracked but absent from the checkout (a sparse or deleted path)
      continue;
    }
    if (size > MAX_BYTES) {
      scan.unread.push(path);
      continue;
    }
    const bytes = readFileSync(full);
    if (bytes.subarray(0, 8_000).includes(0)) {
      scan.unread.push(path);
      continue;
    }
    scan.read += 1;
    scan.hits.push(...scanText(path, bytes.toString('utf8')));
  }
  return scan;
}

describe('no code-graph credential name appears in motir-core (MOTIR-11649)', () => {
  const scan = scanTree();

  it('finds neither credential name in any tracked text file', () => {
    expect(
      scan.hits.map((h) => `${h.path}:${String(h.line)} ${h.text}`),
      'motir-core must reach the code-graph service only through motir-ai’s ' +
        '/v1/code-graph/* routes; it never reads or holds the service credential.',
    ).toEqual([]);
  });

  it('read the tree it guards, reports what it could not read, and skipped only itself', () => {
    // Without this the zero above could be a scan that read nothing.
    expect(scan.read).toBeGreaterThan(1_000);
    expect(scan.skipped).toEqual([SELF]);
    // Reported beside the verdict rather than claimed: binary and over-cap files.
    // The verdict is stated beside the files it could not reach: the report names them.
    const report = `read ${String(scan.read)} files; could not read ${String(scan.unread.length)} (binary or over ${String(MAX_BYTES)} bytes): ${scan.unread.join(', ')}`;
    expect(scan.unread.length, report).toBeLessThan(scan.read);
    for (const path of [
      'lib/mcp/tools/codeGraphRead.ts',
      'lib/services/codeGraphReadService.ts',
      'lib/ai/motirAiClient.ts',
    ]) {
      expect(scan.unread, path).not.toContain(path);
    }
  });
});

describe('the scan goes RED on a planted credential read — demonstrated, not assumed', () => {
  it('a planted source line reading a code-graph client token is named by path and line', () => {
    const planted = [
      "import { config } from './config';",
      '',
      'export const codeGraphToken = process.env.MOTIR_CODEGRAPH_CLIENT_TOKEN;',
      'const secret = process.env["CODEGRAPH_READ_SECRET"];',
    ].join('\n');
    expect(scanText('lib/planted/codegraphClient.ts', planted)).toEqual([
      {
        path: 'lib/planted/codegraphClient.ts',
        line: 3,
        text: 'export const codeGraphToken = process.env.MOTIR_CODEGRAPH_CLIENT_TOKEN;',
      },
      {
        path: 'lib/planted/codegraphClient.ts',
        line: 4,
        text: 'const secret = process.env["CODEGRAPH_READ_SECRET"];',
      },
    ]);
  });

  it('does not fire on the sandbox CLI’s own CODEGRAPH_ variables — the control', () => {
    expect(
      scanText('packages/cli/sandbox/agent-config.sh', 'export CODEGRAPH_TARGET_FILE=x'),
    ).toEqual([]);
  });
});
