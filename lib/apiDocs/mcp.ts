import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { DEFAULT_TOKEN_GRANT, GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import { permissionSlug, type PermissionKey } from '@/lib/permissions/catalog';
import enMessages from '@/messages/en.json';
import type { GuideBlock } from '@/lib/apiDocs/guide';
import type { McpToolHints, McpToolInputSchema } from './mcpToolSchema';
import { MCP_TOOL_ANNOTATIONS, MCP_TOOL_INPUT_SCHEMAS, MCP_TOOL_TITLES } from './mcpToolSchemas';
import type { Locale } from '@/lib/i18n/locales';
import { localizedGroupText, localizedSummary, resolveCatalogueLocale } from './mcpCatalogueLocale';

// The MCP server documentation, AS DATA (Story MOTIR-2309 · Subtask MOTIR-2325 ·
// design `design/mcp-server/` · ADR `public-api-conventions.md` Amendment 13).
//
// ── Who READS this module at runtime (MOTIR-4194) ───────────────────────────
// `app/api/docs/mcp-tools.json/route.ts` — the PUBLISHED tool catalogue, an
// anonymous, cacheable, unversioned documentation artifact that `motir.co`'s
// `/docs/mcp/tools` fetches at request time and renders without keeping a copy
// (`docs/decisions/public-surface-hosts.md` AMENDMENT 5). It serializes
// {@link mcpToolCatalogueDocument} and nothing else. The in-repo `/docs/mcp*`
// pages that used to read this module left with MOTIR-3951, and between that
// and MOTIR-4194 the module had no runtime reader at all — which is how its
// truth gate could be deleted as collateral without anything noticing
// (MOTIR-4165). The route is what makes the totality chain below guard
// something a reader actually receives.
//
// ── The dependency-graph rule this file exists to keep ──────────────────────
// It imports `lib/mcp/toolPermissions.ts` (a LEAF whose only imports are types —
// it replaced `lib/mcp/scopes.ts` in MOTIR-2574) and NOTHING ELSE from
// `lib/mcp/`, directly or transitively. That module is safe for a public page:
// its only reference to the registry is `import type { McpToolName }`, erased at
// build. `registry.ts` is not — it imports all of `lib/mcp/tools/*.ts`, which
// import the services, which import `@prisma/client` and `lib/db`. None of that
// belongs in the dependency graph of a page — or, now, a route — anybody on the
// internet can request (Amendment 13 Q2).
//
// That is also why the tool-name type below is `keyof typeof TOOL_PERMISSIONS` rather
// than an imported `McpToolName`: the two are the same type — `TOOL_PERMISSIONS` is
// declared `Record<McpToolName, TokenScope>` — but deriving it costs no import at
// all, so the rule holds by construction and not by discipline. The totality
// chain is unbroken: a tool added to `MCP_TOOL_NAMES` without a scope fails
// typecheck in `toolPermissions.ts`; adding it widens `keyof typeof TOOL_PERMISSIONS`;
// and that makes {@link TOOL_SUMMARIES} below incomplete, which fails typecheck
// here. A tool cannot reach the server undocumented.
//
// ⚠️ AND THE RULE IS WHY THE ARGUMENT SCHEMAS ARE GENERATED (MOTIR-4389). A
// tool's `inputSchema` lives in the same `registerTool(...)` call its
// description does, so reading one means BUILDING the server — exactly what the
// paragraph above forbids. `mcpToolSchemas.ts` is the seam: a leaf that imports
// nothing at runtime, written by `pnpm generate:mcp-tool-schemas` from a live
// handshake and pinned byte-for-byte against a fresh one by
// `tests/mcp/tool-schema-truth.test.ts`. So the value crosses the boundary and
// the import does not — and a schema that drifted from the server, or was
// edited by hand, is red rather than published.
//
// ── What is DERIVED and what is AUTHORED (Amendment 13 Q2) ──────────────────
// Derived: every tool NAME, its gating SCOPE, the catalogue's GROUPING (a tool's
// group is its own scope), the scope legend, the default grant, and — generated
// from the registry's live `tools/list`, above — each tool's ARGUMENT SCHEMA, its
// `title` and its `annotations` (the read-only / destructive / idempotent /
// open-world hints, MOTIR-7002). Authored: the reader-facing one-line summaries,
// because a tool's `description` lives inside its `server.registerTool(...)` call
// and is not data anywhere.
//
// Each authored summary carries a FINGERPRINT of the shipped `title` +
// `description` it was written against. `tests/mcp/tool-doc-truth.test.ts`
// recomputes it from a live `tools/list` and fails when they diverge, naming the
// tool and both values. (It was the story's own gate, MOTIR-2330, in
// `tests/api-docs/` — a directory whose every other member walked one of the
// public docs pages, so MOTIR-3951 deleted it along with them and nothing
// recomputed a fingerprint for two days. MOTIR-4165 restored it to a home that
// imports no route and no page, which is the whole point of the move.)
// It does not prove a summary is good — no test can. It proves the summary
// was written against the text the server currently ships, which is exactly the
// property Amendment 9 Q2's second limb asks for, on the one surface Amendment 7
// explicitly licenses to churn.
//
// ── English, per ADR Amendment 4 Q4 ─────────────────────────────────────────
// Long-form documentation prose is localized in principle and lives here rather
// than in `messages/*.json`, for the reason `guide.ts` records: a catalog entry
// per paragraph makes a document unreadable to edit and puts config samples
// inside a localization file. The page CHROME is localized in the catalogs.
//
// The published catalogue is the one place its prose is served per locale
// (MOTIR-8031): `?locale=<code>` swaps each tool's `summary` for a translation in
// `lib/apiDocs/mcpSummaryTranslations/<locale>.ts` and each group's `label` /
// `gates` for the app catalogue's own translated `permissions.*`, per tool and
// per group, and only while the English it was made from is still today's. The
// rule lives in `mcpCatalogueLocale.ts`; the English stays authored here.

/**
 * Every tool the MCP server exposes — structurally identical to `McpToolName`,
 * derived rather than imported so this module needs no `registry.ts` reference.
 */
export type McpCatalogueToolName = keyof typeof TOOL_PERMISSIONS;

// ── The four transport facts, held ONCE ─────────────────────────────────────
// Amendment 13 Q3a: these are OURS and a test can pin them. Every client block
// below is one of them transcribed into a vendor's file format, so a stale block
// is wrong about that vendor's syntax and never about Motir.

/** The example origin, used when the deployment names none. Mirrors `reference.ts`. */
export const MCP_EXAMPLE_ORIGIN = 'https://app.motir.co';

/** The served path — `app/api/mcp/route.ts`, a static route, not `[transport]`. */
export const MCP_ENDPOINT_PATH = '/api/mcp';

/** The header every request carries; the scheme is separate so blocks compose it. */
export const MCP_AUTH_HEADER = 'Authorization';
export const MCP_AUTH_SCHEME = 'Bearer';

/**
 * The bearer PLACEHOLDER, not a plausible-looking fake — `reference.ts`'s rule:
 * a realistic token in published documentation gets pasted verbatim and then
 * debugged as an auth problem; an obvious placeholder cannot.
 */
export const MCP_TOKEN_PLACEHOLDER = 'motir_pat_<your-token>';

/** The four facts, resolved. Passed into every client block so none hard-codes them. */
export interface McpTransportFacts {
  origin: string;
  path: string;
  url: string;
  authHeader: string;
  authScheme: string;
  tokenPlaceholder: string;
}

/** The shipped facts; overridable so a test can prove a block INTERPOLATES them. */
export function mcpTransportFacts(origin: string = MCP_EXAMPLE_ORIGIN): McpTransportFacts {
  return {
    origin,
    path: MCP_ENDPOINT_PATH,
    url: `${origin}${MCP_ENDPOINT_PATH}`,
    authHeader: MCP_AUTH_HEADER,
    authScheme: MCP_AUTH_SCHEME,
    tokenPlaceholder: MCP_TOKEN_PLACEHOLDER,
  };
}

/** One row of the "every client needs these four" table. */
export interface McpTransportFactRow {
  label: string;
  value: string;
}

export function mcpTransportFactRows(
  facts: McpTransportFacts = mcpTransportFacts(),
): McpTransportFactRow[] {
  return [
    { label: 'URL', value: `\`${facts.url}\`` },
    { label: 'Transport', value: 'Streamable HTTP — **not** SSE, and not a stdio command' },
    {
      label: 'Header',
      value: `\`${facts.authHeader}: ${facts.authScheme} <token>\`, on every request`,
    },
    { label: 'Token', value: `\`${facts.tokenPlaceholder}\` — the one you minted in step 1` },
  ];
}

// ── The client matrix (Amendment 13 Q3a) ────────────────────────────────────

/** One client's wiring block. Everything here except `config` is the VENDOR's. */
export interface McpClient {
  id: string;
  /** How the client is known to its users. */
  label: string;
  /** Where the snippet goes — becomes the `CodeBlock` caption. */
  file: string;
  /** The snippet, built by interpolating {@link McpTransportFacts}. */
  config: string;
  /**
   * One line on what this vendor does about the secret, or what to watch for.
   * REQUIRED: every block has something worth saying, and an optional field here
   * bought nothing but a dead branch in the page that renders it.
   */
  note: string;
  /** That vendor's own MCP documentation — the authority when this block is stale. */
  docsUrl: string;
  /** When the FORMAT was last read from `docsUrl`. Amendment 13 Q3a's containment. */
  checkedOn: string;
}

/**
 * The date the four vendor formats below were read from their own documentation.
 * One constant, because they were checked in one pass and a per-client date that
 * nobody updates is worse than an honest shared one.
 */
export const MCP_CLIENT_FORMATS_CHECKED_ON = '2026-08-06';

/**
 * Every client block. **No entry hard-codes the endpoint, the header or the token
 * shape** — each interpolates `facts`, which is what makes the negative case in
 * `tests/mcp/mcp-doc-guards.test.ts` (build with a sentinel origin, assert every
 * config carries it) meaningful. That case is MOTIR-2330's, restored by
 * MOTIR-4269 after MOTIR-3951 deleted it along with the pages it shared a
 * directory with — this sentence went on naming it for two days after the file
 * had gone, which is why that gate now also asserts every test path named here
 * is a real file.
 *
 * Where a vendor supports reading the secret from somewhere else, the block uses
 * it. A guide whose first instruction is "paste a live credential into a file
 * your repository tracks" has taught the wrong habit in the first five minutes.
 */
export function mcpClients(facts: McpTransportFacts = mcpTransportFacts()): McpClient[] {
  const bearer = `${facts.authScheme} ${facts.tokenPlaceholder}`;
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      file: '.mcp.json',
      config: [
        '{',
        '  "mcpServers": {',
        '    "motir": {',
        '      "type": "http",',
        `      "url": "${facts.url}",`,
        `      "headers": { "${facts.authHeader}": "${bearer}" }`,
        '    }',
        '  }',
        '}',
      ].join('\n'),
      note: `Or one command: \`claude mcp add --transport http motir ${facts.url} --header "${facts.authHeader}: ${bearer}"\``,
      docsUrl: 'https://docs.claude.com/en/docs/claude-code/mcp',
      checkedOn: MCP_CLIENT_FORMATS_CHECKED_ON,
    },
    {
      id: 'cursor',
      label: 'Cursor',
      file: '~/.cursor/mcp.json — or .cursor/mcp.json for one project',
      config: [
        '{',
        '  "mcpServers": {',
        '    "motir": {',
        `      "url": "${facts.url}",`,
        `      "headers": { "${facts.authHeader}": "${facts.authScheme} \${env:MOTIR_TOKEN}" }`,
        '    }',
        '  }',
        '}',
      ].join('\n'),
      note: 'Cursor interpolates `${env:…}`, so the token stays in your environment and out of the file.',
      docsUrl: 'https://cursor.com/docs/context/mcp',
      checkedOn: MCP_CLIENT_FORMATS_CHECKED_ON,
    },
    {
      id: 'vscode',
      label: 'VS Code',
      file: '.vscode/mcp.json',
      config: [
        '{',
        '  "inputs": [',
        '    {',
        '      "type": "promptString",',
        '      "id": "motir-token",',
        '      "description": "Motir personal access token",',
        '      "password": true',
        '    }',
        '  ],',
        '  "servers": {',
        '    "motir": {',
        '      "type": "http",',
        `      "url": "${facts.url}",`,
        `      "headers": { "${facts.authHeader}": "${facts.authScheme} \${input:motir-token}" }`,
        '    }',
        '  }',
        '}',
      ].join('\n'),
      note: 'VS Code prompts for the token the first time the server starts and stores it securely — nothing secret is written to the file.',
      docsUrl: 'https://code.visualstudio.com/docs/agents/reference/mcp-configuration',
      checkedOn: MCP_CLIENT_FORMATS_CHECKED_ON,
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      file: '~/.codex/config.toml',
      config: [
        '[mcp_servers.motir]',
        `url = "${facts.url}"`,
        'bearer_token_env_var = "MOTIR_TOKEN"',
      ].join('\n'),
      note: '`bearer_token_env_var` takes the variable’s **name**, not the token.',
      docsUrl: 'https://developers.openai.com/codex/mcp',
      checkedOn: MCP_CLIENT_FORMATS_CHECKED_ON,
    },
    {
      id: 'other',
      label: 'Any other streamable-HTTP client',
      file: 'whatever your client calls its config',
      config: [
        'Transport:  streamable HTTP',
        `URL:        ${facts.url}`,
        `Header:     ${facts.authHeader}: ${bearer}`,
      ].join('\n'),
      note: 'Windsurf, Zed, Cline, Goose, or something you wrote yourself — the same four facts under different key names.',
      docsUrl: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
      checkedOn: MCP_CLIENT_FORMATS_CHECKED_ON,
    },
  ];
}

// ── The reader's fork: MCP or /api/v1? (Amendment 7, published as reasoning) ──

/** One row of the fork table. Cells carry the same marks the prose does. */
export interface McpForkRow {
  axis: string;
  mcp: string;
  rest: string;
}

export function mcpForkRows(facts: McpTransportFacts = mcpTransportFacts()): McpForkRow[] {
  return [
    { axis: 'Endpoint', mcp: `\`POST ${facts.path}\``, rest: '`/api/v1/…`' },
    {
      axis: 'Built for',
      mcp: 'An **agent you control** — it reads tool descriptions at run time.',
      rest: 'A **client you ship** — code written once against a fixed shape.',
    },
    {
      axis: 'Stability',
      mcp: '**Expected to change.** Rewording a description or renaming an argument is how an agent’s behaviour gets tuned.',
      rest: '**Additive only.** A breaking change mints `/api/v2`; v1 keeps its promise.',
    },
    {
      axis: 'Shape',
      mcp: 'The same. MCP payloads are derived from the v1 response schemas, so the two describe provably identical objects.',
      rest: 'The same, and it is the source the MCP derives from.',
    },
    {
      axis: 'Auth',
      mcp: 'One personal access token, one scope set.',
      rest: 'The same credential works on both.',
    },
  ];
}

/** The one-line steer under the fork table. */
export const MCP_FORK_STEER: GuideBlock = {
  kind: 'callout',
  tone: 'info',
  text: 'Wiring an agent? Stay here. Writing software other people install? The REST API is the other half — it is the one that promises not to change under you.',
};

// ── The permission legend, derived from the catalog ─────────────────────────
//
// ⚠️ NOTHING HERE IS AUTHORED ANY MORE (MOTIR-2581). This block used to carry a
// hand-written `SCOPE_LABELS` table — six labels and six sentences describing
// what each scope gated — maintained beside the ones on Roles & permissions. A
// second hand-written description of one capability is the drift this story
// removes: the two say the same thing on the day they are written and diverge
// on the day someone edits one.
//
// So the label and the sentence are read from the SHIPPED i18n copy, by the
// catalog's own `permissions.<slug>.label` / `.description` keys — the exact
// strings the Roles & permissions screen renders. `en.json` is imported rather
// than resolved through next-intl because this module builds a PUBLISHED page,
// which has no request locale; the published reference is English, as the rest
// of `lib/apiDocs` already is.

/** The shipped `permissions.*` copy, as the published page reads it. */
const PERMISSION_COPY = enMessages.permissions as unknown as Record<
  string,
  { label: string; description: string }
>;

function permissionLabel(key: PermissionKey): string {
  return PERMISSION_COPY[permissionSlug(key)]!.label;
}

function permissionDescription(key: PermissionKey): string {
  return PERMISSION_COPY[permissionSlug(key)]!.description;
}

export interface McpScopeLegendRow {
  permission: PermissionKey;
  label: string;
  gates: string;
  /** From `DEFAULT_TOKEN_GRANT` — never a second hand-written list. */
  grantedByDefault: boolean;
  /** Derived: how many tools this permission gates. Never a literal. */
  toolCount: number;
}

export function mcpScopeLegend(): McpScopeLegendRow[] {
  // Seeded TOTAL over GRANTABLE_PERMISSIONS, so the lookup below cannot miss and
  // needs no fallback arm. A permission that currently gates no MCP tool reports
  // 0 rather than vanishing — the legend's job is to tell a reader what every
  // permission on their token means, including one only `/api/v1` exercises.
  const counts = Object.fromEntries(GRANTABLE_PERMISSIONS.map((key) => [key, 0])) as Record<
    PermissionKey,
    number
  >;
  for (const permission of Object.values(TOOL_PERMISSIONS)) {
    counts[permission] += 1;
  }
  return GRANTABLE_PERMISSIONS.map((permission) => ({
    permission,
    label: permissionLabel(permission),
    gates: permissionDescription(permission),
    grantedByDefault: DEFAULT_TOKEN_GRANT.includes(permission),
    toolCount: counts[permission],
  }));
}

// ── The catalogue ───────────────────────────────────────────────────────────

/** One authored summary, plus the fingerprint of the shipped text it was written against. */
export interface McpToolSummary {
  summary: string;
  /** {@link fingerprintToolText} of the shipped `title` + `description`. */
  descriptionFingerprint: string;
}

/**
 * ⚠️ REGENERATE A FINGERPRINT FROM THE LIVE SERVER, NEVER BY RE-READING THE
 * SOURCE. The first pass here derived them by parsing the `registerTool(...)`
 * literals out of `lib/mcp/tools/*.ts`, and **nine of thirty-nine came out
 * wrong** — the descriptions are concatenated across many lines and several
 * contain typographic quotes, so a source-level parse silently truncates some of
 * them. The gate caught all nine, which is the system working; the lesson is
 * that the only trustworthy source for this value is the same one the gate
 * reads. Get it from a `tools/list` handshake (the pattern in
 * `tests/mcp/tool-doc-truth.test.ts`) and copy the result.
 *
 * The stored fingerprints are computed by `fingerprintToolText` in
 * `lib/apiDocs/mcpFingerprint.ts` — which lives in its OWN module because it
 * needs `node:crypto`, and nothing a public page imports may.
 * `tests/mcp/tool-doc-truth.test.ts` imports it, recomputes each fingerprint from
 * a live `tools/list`, and fails when one diverges.
 *
 * ⚠️ AND WHEN IT FAILS, THE FINGERPRINT IS THE LAST THING YOU MOVE. Re-read the
 * tool's shipped text, decide whether the summary still says what a reader
 * choosing between two adjacent tools needs, change it if it does not, and only
 * then re-pin. Moving the pin alone converts the one signal that a summary is
 * owed a re-read into a green check — which is the failure the gate exists for,
 * not a step in clearing it.
 */

/**
 * ⚠️ TOTAL over the tool set by TYPE. A tool added to the registry — which forces
 * a `TOOL_SCOPES` entry — widens `McpCatalogueToolName` and makes this map
 * incomplete, which is a compile error in this file. That is the guarantee; the
 * fingerprints are the separate guarantee that each line still describes the tool
 * the server ships.
 */
const TOOL_SUMMARIES: Record<McpCatalogueToolName, McpToolSummary> = {
  attach_file: {
    summary:
      'Put a file ON a work item — a research findings document, a review’s notes — so a reader sees the deliverable on the work item instead of hunting for a pull request.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: '138c5dd702b3',
  },
  publish_design_result: {
    summary:
      'Put the design RESULT on a design work item — the mock(s) and the area note as a link, what a reviewer opens — only when an open work item is blocked_by the design. No .png and no inline note: both are refused, and so is a done design card, which accepts no new version. Each asset arrives inline as base64, or as the pathname of a create_design_upload grant when it is too large to send.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: '77de91cc8fd8',
  },
  create_design_upload: {
    summary:
      'Mint a short-lived presigned PUT for a design asset too large to send inline \u2014 step 1 ' +
      'of 2, because a large asset is more than a tool argument can carry. Upload the bytes ' +
      'straight to the store, then publish the pathname. Refuses a screenshot, a card nothing waits on, and a done design card.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: 'd7ce4c5ca8d2',
  },
  create_acceptance_upload: {
    summary:
      'Mint a short-lived presigned PUT for a story\u2019s acceptance recording \u2014 step 1 of 2, ' +
      'because a video is far larger than a tool argument can carry. Upload the bytes straight to ' +
      'the store, then register the pathname.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: '0c2e41f16865',
  },
  publish_acceptance_result: {
    summary:
      'Register the uploaded recording as the story\u2019s acceptance receipt \u2014 the thing a ' +
      'reviewer watches and the gate rests on. Nothing else publishes it, and a missing publish ' +
      'looks exactly like a successful run.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: '7b8814f69f72',
  },
  publish_test_instructions: {
    summary:
      'Put a RUN\u2019s HOW TO TEST onto its run target \u2014 before the run finishes, and ' +
      'again when a later commit changes a step: rich-text Markdown with sections and every ' +
      'command in a fenced code block (click-to-copy), plus the commit of each repository it ' +
      'pushed to.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: 'e52196670d2a',
  },
  link_pull_request: {
    summary:
      'Declare which work item a pull request delivers — call it right after opening one, once ' +
      'per work item it delivers. The association is a SET, so a second call ADDS rather than ' +
      'moving, and it works before any webhook delivery has arrived.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    // Re-pinned for MOTIR-3721: the description said a pull request "cannot point at two"
    // work items, which the delivery table falsified when MOTIR-3658 shipped the dual write.
    // Re-pinned again for MOTIR-3757, and the SUMMARY changed with it: the description said
    // the link a work item carries is SINGULAR and MOVES, which stopped being true when the
    // column it described was dropped.
    // Re-pinned for MOTIR-5188: the description said a "cross-workspace repository" is
    // refused, which stopped being true when the repository read moved to the ORGANISATION.
    // The summary names no tier, so it stands.
    descriptionFingerprint: '120f83a21d3e',
  },
  unlink_pull_request: {
    summary:
      'Undo ONE `link_pull_request` — remove the delivery recorded between a work item and a ' +
      'pull request. A delivery is a row, so re-linking the right work item ADDS rather than ' +
      'corrects; this removes exactly the one pair you name and leaves every other delivery ' +
      'alone.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: '0dd646f57b25',
  },
  get_work_item: {
    // Re-pinned for MOTIR-3096, summary UNCHANGED and deliberately so: the tool
    // gained an optional `planId` that answers the SAME question over the live
    // tree ⊕ a plan's proposals. A reader picking a tool off this line is
    // picking it for what it reads, not for which tree it reads.
    // Re-pinned for MOTIR-5413: the description now says the payload DECLARES the
    // item's own folder placement (`folderId` + `folderPath`).
    // Re-pinned for MOTIR-5981, summary WIDENED: the payload declares `errors`,
    // the item's monitor links with their stored evidence — a new question the
    // tool answers, so the line a reader picks a tool from names it.
    // Re-pinned for MOTIR-6422, summary WIDENED: the payload declares `latestRefusal`,
    // the reason the last attempt was sent back (with its verdict) — the refusal the
    // next run is told to address, so the line names it.
    summary:
      'One item in full — description, status, parent or folder, children, dependency edges, a readiness verdict, the errors linked to it, the latest refusal sent back on it, and where its unmerged code is.',
    // Re-pinned for MOTIR-6580, summary UNCHANGED: the text block gains the
    // Supersedes / Superseded by link groups — two more edge groups, which the
    // summary's "dependency edges" already covers without enumerating groups.
    // Re-pinned for MOTIR-6582, summary UNCHANGED: the item and its child rows carry
    // the obsolescence mark + note — fields of the item, which "one item in full"
    // already covers; the summary enumerates questions, not columns.
    // Re-pinned for MOTIR-8098, summary UNCHANGED: the item carries `languages`, each
    // text field's recorded content language — a field of the item, which "one item
    // in full" already covers.
    // Re-pinned for MOTIR-8940, summary UNCHANGED: the item may be addressed by its
    // internal id as well as its key — how a card is NAMED, which a summary of what
    // the read returns does not describe.
    // Re-pinned for MOTIR-9033, summary UNCHANGED: the opt-in `includeSections` adds a
    // parsed view of the body the read already returns — the body, not a new read.
    // Re-pinned for MOTIR-10069, summary WIDENED: the payload declares `inFlightCode`
    // and `mergedRepos`, where the item's unmerged code is (its own pull request or a
    // parent's) — a new question the tool answers, so the line names it.
    descriptionFingerprint: '5e2545bb6213',
  },
  get_design: {
    // Story MOTIR-5553 · MOTIR-5561.
    summary:
      'The APPROVED design of one design card, with short-lived links to its files — or which of five reasons there is none.',
    // Pinned from the LIVE handshake, never hand-computed.
    descriptionFingerprint: '88b29f21f0bd',
  },
  get_approval_gate: {
    // Bug MOTIR-6191.
    summary:
      'The decision a person made on one approval gate — the note they wrote when they sent your work back, who wrote it, when, and on which version.',
    // Pinned from the LIVE handshake, never hand-computed.
    descriptionFingerprint: '4b42310f54d3',
  },
  list_designs: {
    // Story MOTIR-5553 · MOTIR-5561.
    summary:
      'What a card is meant to be built against (`blockersOf`), or a page of the project’s approved designs. No links — take those from `get_design`.',
    // Pinned from the LIVE handshake, never hand-computed.
    descriptionFingerprint: '5698221bd478',
  },
  get_work_item_activity: {
    summary:
      "One page of an item's discussion and change trail: comment threads and history, interleaved.",
    descriptionFingerprint: 'f67109d04887',
  },
  list_ready: {
    summary:
      'One ready LANE of a project, paginated — leaves (default, never a bug, each naming its container), runnable containers, or bugs — in the order the Ready view shows.',
    descriptionFingerprint: '4a08d5afd615',
  },
  next_ready: {
    summary:
      'The next item of one ready lane — a leaf (default, never a bug) or a bug as a full dispatch payload, or the next runnable container for a parent run. The “what do I do next” call.',
    descriptionFingerprint: 'fef598b16a19',
  },
  dispatch_prompt: {
    summary:
      'The server-generated coding-agent prompt for one item — the same text the CLI hands an agent.',
    descriptionFingerprint: 'b597b28346fd',
  },
  search_work_items: {
    // Re-pinned for MOTIR-3096, summary UNCHANGED — same reasoning as
    // `get_work_item`'s. The projected mode is documented in `docs/mcp.md`'s
    // AI-planning section, where somebody would look for it.
    // Re-pinned for MOTIR-6582, summary UNCHANGED: each row carries the obsolescence
    // mark + note — row fields, not a new way to search; the summary names none.
    summary:
      "Search a project's items with the same filter grammar the advanced filter builder writes.",
    descriptionFingerprint: '9ca981741d3b',
  },
  whoami: {
    summary:
      'Who this token is: the owning user, the active workspace, and the scopes granted. Call it first.',
    descriptionFingerprint: 'b8b8a104bfe6',
  },
  list_projects: {
    summary: 'Every project this token can reach, each with the projectKey every other tool takes.',
    descriptionFingerprint: 'ada98598846a',
  },
  get_project_state: {
    summary:
      "A project's planning preconditions — established, code connected, indexed, repo set — and its organisation's content language, before you plan.",
    descriptionFingerprint: '3bd7d4978a1d',
  },
  get_code_health: {
    summary:
      "Each repository's index state, latest code-health audit summary and derived coding convention — what the hosted planner reads.",
    descriptionFingerprint: 'ab6d4bd4fd37',
  },
  get_coding_convention: {
    summary:
      "One repository's coding convention in full — derived or edited by a person, with its version — what a change in that repository follows.",
    descriptionFingerprint: '1c7784e4be1f',
  },
  read_file: {
    summary:
      "One file's text, or a directory's immediate entries, from a repository in the project's set, at a ref — capped and line-ranged like the hosted planner's read, every absence a named outcome.",
    descriptionFingerprint: '8c24af03ed4e',
  },
  list_changed_files: {
    // MOTIR-10069 — the hosted planner's `list_changed_files`, on the MCP.
    summary:
      "The paths a branch changed in a repository in the project's set, against its default branch or a named base — bounded like the hosted planner's listing, every absence a named outcome.",
    // Pinned from the LIVE handshake, never hand-computed.
    descriptionFingerprint: 'd2536eb87f90',
  },
  code_explore: {
    summary:
      "The hosted code graph around a query — the hosted planner's own answer, paged, every absence a named state.",
    // Re-pinned for MOTIR-10094: the description now names the `drift` entry a read off a graph
    // behind its default branch carries. The summary was re-read and still says what the tool does.
    descriptionFingerprint: '829f9a5594b5',
  },
  code_search: {
    summary:
      "Symbols matching a name in the hosted code graph — the hosted planner's own answer, paged.",
    // Re-pinned for MOTIR-10094: the description now names the `drift` entry a read off a graph
    // behind its default branch carries. The summary was re-read and still says what the tool does.
    descriptionFingerprint: '0976e4761ef1',
  },
  code_grep: {
    summary:
      "Lines matching a text or pattern in the indexed file contents — string literals, comments and non-code files the symbol search cannot see — the hosted planner's own answer, paged.",
    // Re-pinned for MOTIR-10094: the description now names the `drift` entry a read off a graph
    // behind its default branch carries. The summary was re-read and still says what the tool does.
    descriptionFingerprint: 'bb73c179712f',
  },
  skeleton: {
    // Re-pinned for MOTIR-5410: the description now names the folder placement
    // (`folderId` on a filed row, the project's `folders`) the read carries.
    // Re-pinned for MOTIR-6582, summary WIDENED: every row carries the obsolescence
    // mark, and this summary enumerates the row's fields, so it names it.
    summary:
      "The whole project's tree shape in one read — every item's key, kind, title, status, parent, folder and obsolescence mark, with no paging loop.",
    descriptionFingerprint: 'a655e6804ec8',
  },
  get_section_sets: {
    summary:
      'Which sections a card of a given kind and type has, which are required and the heading each renders under — read it before writing a card.',
    descriptionFingerprint: 'e229abdc1b1d',
  },
  list_folders: {
    summary:
      "Every folder of a project in one read — each folder's id and its path — to find a folder by name.",
    descriptionFingerprint: 'ef6a154466b6',
  },
  create_folder: {
    summary: 'Create a folder at the root or inside another folder; names are unique per level.',
    descriptionFingerprint: '4a0a04e70d18',
  },
  update_folder: {
    summary: 'Rename a folder, or move and reorder it — one or the other per call, never both.',
    descriptionFingerprint: 'eeec61eb8ae9',
  },
  delete_folder: {
    summary:
      'Delete a folder; its folders and work items move up, and the result lists what moved.',
    descriptionFingerprint: 'ba8ca89ae989',
  },
  get_page: {
    summary:
      'Read one page as markdown — its title, where it is filed, its revision and newest version — to read it or to write it back; or read one version by number.',
    descriptionFingerprint: '1ddf57794b56',
  },
  create_page: {
    summary:
      'Create a page with a markdown body — at the root, in a folder or as a sub-page — and get its id and revision.',
    descriptionFingerprint: '2c4a5319e315',
  },
  update_page: {
    summary:
      'Replace a page’s whole body with markdown at the revision you read; a page saved since is refused, not merged.',
    descriptionFingerprint: '24af12bc474b',
  },
  rename_page: {
    summary:
      'Change a page’s title only — no body write, no revision, and no new version of a published decision page.',
    descriptionFingerprint: 'd1f07933be8e',
  },
  search_pages: {
    summary:
      'Find a project’s live pages by words or by meaning — merged ranked hits with a snippet and the ranking mode, paged by cursor.',
    descriptionFingerprint: '207472930227',
  },
  move_page: {
    summary:
      'Re-file a page and its sub-pages under another page, into a folder or at the root; a cycle or an archived page is refused by name.',
    descriptionFingerprint: 'af2acd1e96dd',
  },
  archive_page: {
    summary:
      'Archive a page with its sub-pages, or restore an archive root and see where it landed — nothing is deleted.',
    descriptionFingerprint: 'e48d9ee5c544',
  },
  link_page: {
    summary:
      'Link a page to a work item of its project, or unlink it; linking twice changes nothing, and another project is refused by name.',
    descriptionFingerprint: '215ff7d3a41d',
  },
  publish_decision_page: {
    summary:
      'Publish a page as a decision card’s decision: seals its newest version and, on an agent card, asks a person to approve it.',
    descriptionFingerprint: 'bdaf778081be',
  },
  search_work_items_semantic: {
    summary:
      'Has this already been built? Search by MEANING rather than substring — keys, titles and scores only.',
    descriptionFingerprint: '71d731c71c15',
  },
  list_sprints: {
    summary:
      "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
    descriptionFingerprint: '1b0f1e472431',
  },
  validate_sprint: {
    // Re-pinned for MOTIR-3095, summary UNCHANGED — same reasoning as
    // `validate_work_item` below: the optional `planId` changes which tree the
    // question is asked over, not what the question is.
    //
    // Re-pinned for MOTIR-6368: the tool checks HARD blockers only — an item's
    // OWN blocked_by, never an ancestor's (a soft block `--allow-soft-block`
    // overrides). Summary UNCHANGED: it still names every in-sprint item gated by
    // work outside the sprint; what changed is which edges count as gating.
    summary:
      'Is this sprint finishable? Names every in-sprint item still gated by work outside it.',
    descriptionFingerprint: '973e54a073f4',
  },
  validate_work_item: {
    // Re-pinned for MOTIR-3095, summary UNCHANGED and deliberately so: the tool
    // gained an optional `planId` that asks the SAME question over a plan being
    // authored, and a reader choosing a tool from this line is choosing it for
    // the question, not for which tree it is asked over. The projected mode is
    // documented where somebody would look for it — `validate_plan`'s own line
    // below, and the `AI planning` section of `docs/mcp.md`.
    //
    // Re-pinned again for MOTIR-3110, summary UNCHANGED for the same reason one
    // rung over: the tool's `advisories` channel gained a third `shape` severity
    // (`likely-over-gate-sizing`). The summary names the QUESTION the tool
    // answers — finishability — and advisories have never been part of it,
    // precisely because they are the half that does not gate. A reader choosing
    // this tool from a one-line catalogue is choosing the verdict; the advisory
    // channel and every severity in it is documented where somebody would look,
    // in `docs/mcp.md`'s `validate_work_item` section and its severity table.
    //
    // Re-pinned once more for MOTIR-3178's FOURTH shape severity
    // (`likely-self-blocking-design`). Same re-read, same answer — and the
    // repetition is now itself the finding worth recording: every severity this
    // family gains drifts this pin and leaves the summary correct, because the
    // summary is scoped to the verdict and the severities live on the channel
    // that never touches it. A future member should expect to bump the hash and
    // change nothing else; a member that DID make this line wrong would be one
    // that started gating, which the family's contract forbids.
    //
    // Re-pinned again for MOTIR-3271, and this one is NOT a new severity: the
    // `likely-over-gate-sizing` line was corrected in place — its minutes
    // threshold moved from sixty to seventy and the text now says that arm is a
    // PROXY, since `estimateMinutes` sums agent time and CI time while the gate
    // ceilings the agent run alone. (Those two numbers are SPELLED OUT, not
    // written as digits: `tests/mcp/mcp-doc-guards.test.ts` forbids the CURRENT
    // tool count as a bare literal anywhere below `McpCatalogueToolName`, and a
    // threshold that merely happens to equal it would trip a guard aimed at
    // something else. Do not "tidy" them back into numerals.)
    // Summary UNCHANGED for the reason above, which the
    // paragraph anticipated: the drift is on the advisory channel, and the
    // summary describes the verdict.
    //
    // Re-pinned for MOTIR-5362's new advisory FAMILY, `coverage`
    // (`likely-unowned-criterion` — a container criterion no child owns). Summary
    // UNCHANGED, and this is the first re-pin that was a family rather than a
    // severity: still the advisory channel, still never a gate, so the verdict
    // line stays true.
    //
    // Re-pinned for MOTIR-5588: the over-gate sizing advisory's points arm moved
    // from 13+ to 8+ story points. Summary UNCHANGED — it names no threshold.
    //
    // Re-pinned for MOTIR-5399's FIFTH shape severity (`body-edit-above-field-move`,
    // the first read off a card's revision trail). Summary UNCHANGED, as the
    // MOTIR-3178 paragraph predicted a new member would be.
    //
    // Re-pinned for MOTIR-5428's counted-own-blockers shape severity. Summary
    // UNCHANGED: like the preceding additions, it grows only the advisory
    // channel and never changes the finishability verdict this line describes.
    //
    // Re-pinned for MOTIR-5424's new advisory FAMILY, `path-reference`
    // (`likely-missing-path-edge` — a criterion naming a not-yet-existing file
    // another open card also names, with no edge between them). Summary
    // UNCHANGED, for the reason the coverage re-pin gave: the advisory channel,
    // never a gate, so the verdict line stays true.
    //
    // Re-pinned for MOTIR-5426: the `likely-ordering-violation` line was
    // corrected in place to say it is a PARTIAL merge-word tell whose absence
    // clears nothing (measured at about one post-deploy criterion in nine).
    // Summary UNCHANGED: the correction is on the advisory channel, and this line
    // describes the verdict.
    //
    // Re-pinned for MOTIR-6245: `likely-self-blocking-design` now names its
    // scope — a childless card that is not itself `type: design`. Summary
    // UNCHANGED: it narrows an advisory, and this line describes the verdict.
    //
    // Re-pinned for MOTIR-9032's advisory `sectionFindings` (the body parsed against
    // the section registry). Summary UNCHANGED: like the other advisory channels it
    // never touches the finishability verdict this line describes.
    //
    // Re-pinned for MOTIR-6368's NON-gating `softBlocks` (an ancestor's open
    // blockers). Summary UNCHANGED: like the advisory channel, it never touches
    // the finishability verdict this line describes.
    summary:
      'Is this epic, story, task or bug finishable, is every edge on one level, and do its cross-parent edges have their parent edges? Names what is missing.',
    // SUMMARY REWRITTEN for MOTIR-6370: `valid` now also requires every
    // cross-parent edge to be carried by its parents (`invalidEdges`), so a line
    // asking only "finishable?" described half the verdict. (MOTIR-6369 had
    // re-pinned it unchanged for the `cross-level-edge` advisory.)
    // Re-pinned for MOTIR-6411, summary UNCHANGED: the level rule the description
    // states moved from kind to POSITION (MOTIR-6387); the summary names neither.
    // Re-pinned for MOTIR-6443, summary UNCHANGED: the level rule the text states
    // gains the epic tier (an epic is blocked only by another epic).
    // SUMMARY REWRITTEN for MOTIR-6509: `valid` gained a THIRD question — a
    // cross-level edge is no longer an advisory but a `crossLevelEdges` verdict
    // ("blocked elsewhere") — so a line naming two questions described two thirds.
    // Re-pinned for MOTIR-7727, summary UNCHANGED: with a `planId` the two edge
    // lists now hold only the findings the plan introduces. The questions are the
    // same; which edges a PLAN answers for is the description's to say.
    // Re-pinned for MOTIR-8647, summary UNCHANGED: the new `title-coverage` advisory
    // never touches the finishability verdict this line describes.
    // Re-pinned for MOTIR-5427, summary UNCHANGED: the new `under-authored` advisory
    // is another severity on the channel, not part of the verdict this line names.
    // Re-pinned for MOTIR-9007, summary UNCHANGED: the new `likely-mislabelled-link`
    // advisory is another severity on the channel, outside the verdict.
    // Re-pinned for MOTIR-9835, summary UNCHANGED: an extra heading alone is not a
    // section finding — advisory channel only, outside the verdict.
    // Re-pinned for MOTIR-9938, summary UNCHANGED: the mislabelled-link advisory
    // now scans the explanation too — still advisory, outside the verdict.
    // Re-pinned for MOTIR-10112, summary UNCHANGED: `likely-self-blocking-design`
    // now exempts `type: test` beside `type: design` — advisory channel only.
    descriptionFingerprint: '2601f9f3a510',
  },
  get_plan_code_reads: {
    // MOTIR-10122: what each planner session read, at which commit — the evidence a check of a
    // plan attributes a defect from.
    summary:
      'Read the code reads each planner session of a plan made — file and range or query, the commit it was read at, and what came back — in call order.',
    descriptionFingerprint: 'b9865a0cd819',
  },
  get_plan_authoring_state: {
    // MOTIR-9821: the live read an author session makes before it wires an edge onto a sibling.
    // SUMMARY REWRITTEN for MOTIR-10001: it now answers committed cards too, `not_in_walk` among them.
    summary:
      'Which proposals and committed cards are being written, which are written, which no author session has started, and which this plan never re-writes — read before wiring an edge onto another card.',
    descriptionFingerprint: '00d2b8e7cb5a',
  },
  validate_plan: {
    // ⚠️ SUMMARY REWRITTEN, not merely re-pinned (MOTIR-3575). The old line —
    // *"Is the plan you are authoring finishable?"* — became FALSE rather than
    // stale: the tool used to answer finishability alone, and a plan the approve
    // button would refuse came back VALID. It now answers TWO questions, and
    // VALID means both pass. A summary naming one of them is precisely the
    // reading that made a malformed plan safe to close, so this is the drift the
    // pin exists to catch rather than an explanatory edit it can ride out.
    summary:
      'Would approve TAKE this plan, is it finishable, is every edge on one level, and do its cross-parent edges have their parent edges? All four, before `final: true` — nobody else will ask.',
    // SUMMARY REWRITTEN for MOTIR-6370: "Both" became false when `valid` gained a
    // THIRD question (`invalidEdges`). MOTIR-6367 had re-pinned it unchanged for
    // the `cross_level` refusal, which sits inside "would approve take it".
    // Re-pinned for MOTIR-6411, summary UNCHANGED: the level rule the description
    // states moved from kind to POSITION (MOTIR-6387); the summary names neither.
    // Re-pinned for MOTIR-6443, summary UNCHANGED: the level rule the text states
    // gains the epic tier (an epic is blocked only by another epic).
    // SUMMARY REWRITTEN for MOTIR-6509: "All three" became false when `valid`
    // gained a FOURTH question (`crossLevelEdges`, a committed edge across levels).
    // Re-pinned for MOTIR-7727, summary UNCHANGED and now more exactly true: "its
    // cross-parent edges" are the plan's own — the two edge lists hold only the
    // findings the plan introduces, not every old edge in the project.
    // Re-pinned for MOTIR-9032's advisory `sectionFindings`, summary UNCHANGED.
    // Re-pinned for MOTIR-9007, summary UNCHANGED: `advisories` (mislabelled links in
    // proposed bodies) rides beside the verdict and never touches it.
    // Re-pinned for MOTIR-9835, summary UNCHANGED: an extra heading alone is not a
    // section finding — advisory channel only, outside the verdict.
    // Re-pinned for MOTIR-9938, summary UNCHANGED: the mislabelled-link advisory
    // now scans proposed explanations too — beside the verdict, never in it.
    // Re-pinned for MOTIR-10087, summary UNCHANGED: `advisories` widens to every
    // shape family on the plan's proposals — still beside the verdict, never in it.
    descriptionFingerprint: '5979fea073d6',
  },
  get_plan_status: {
    // Re-pinned for MOTIR-3064, summary UNCHANGED and deliberately so: the tool
    // description's edit was to the parenthetical explaining WHY the `job` block
    // exists (a failed job no longer leaves its plan `generating` forever — a
    // reconciler declines an empty one within the hour), and this line was never
    // about that. What the tool answers is the same thing it answered before.
    //
    // Re-pinned AGAIN for MOTIR-3578, summary UNCHANGED for the same reason and
    // it is worth saying why the sibling above went the other way. The edit here
    // widened the description's ENUMERATION of the statuses a plan can be in,
    // from four to five (`stale`). This line does not enumerate them — it says
    // the tool reports the job's state and its proposal count, which is still
    // exactly what it does. `validate_plan`'s summary changed because its old
    // text named the WRONG QUESTION, not because its description moved.
    summary:
      'What became of a submitted planning job — its state, and how many proposals it produced.',
    descriptionFingerprint: 'ab983b5ea9ac',
  },
  get_plan: {
    // Re-pinned for MOTIR-4619, summary UNCHANGED and deliberately so — the
    // `get_plan_status` reasoning above, applied here. The description's edit
    // added ONE marker to the one-line render (`· N steps`, the count of a
    // `manual` proposal's proposed to-do rows) and said that the rows themselves
    // ride `structuredContent`. That is a new thing the tool REPORTS, not a
    // different question it answers: this line already says the tool returns what
    // the planner actually proposed rather than how much, and the steps are part
    // of what was proposed.
    //
    // MOTIR-6631 REWROTE the summary, by the opposite verdict: the description
    // now renders a proposed OBSOLESCENCE MARK — `mark: <current> → <proposed>`,
    // the note's first line, and the supersedes edges by KEY on both a `modify`
    // and an `add`. A reader deciding whether this tool shows a plan that retires
    // finished cards needs to know it does, and that the refs come back as keys.
    //
    // MOTIR-8668 REWROTE it again: a `modify` may now REPLACE a card's steps, and
    // the description says the line prints how many it drops and how many were
    // ticked. A reader deciding whether this tool shows what a re-plan costs a
    // person's progress needs to know it does.
    summary:
      'A plan with the proposals it bundles: what the planner actually proposed, not just how much — including a proposed obsolescence mark (current → proposed, with its note), its supersedes edges named by key, and the steps a change replaces with how many were ticked.',
    // Re-pinned for MOTIR-9033, summary UNCHANGED: the opt-in `includeSections` parses
    // each `add`'s body into sections on request; the summary describes what is bundled.
    descriptionFingerprint: '00accdd86bbd',
  },
  get_approved_shape_verdict: {
    // The line has to carry the one thing a reader choosing between this and
    // `get_plan` needs: this answers a question ABOUT A CARD (is it still what a
    // plan approved?), where `get_plan` answers one about a plan.
    summary:
      'Is this card still what its last approved plan approved? Its plan history and the verdict.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: '034119b2ee54',
  },
  report_unbuildable_target: {
    // The line has to say who calls it and that nothing comes back: a reader
    // choosing between this and `add_comment` needs to know this one is the
    // dispatched runner's report to the server, not a note on the card.
    summary:
      'A dispatched runner reports the card it stopped on as unbuildable — acknowledged, nothing to act on.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: 'bf12bf352e1e',
  },
  record_run_discrepancy: {
    summary:
      'A runner records what it built differently from a plan wrong only about the HOW, and the decisions it made where the plan was silent — a card comment and a run record, acknowledged.',
    descriptionFingerprint: 'd5fd54f98dd3',
  },
  create_plan: {
    summary:
      'Open a plan to propose into — the reviewable container an agent fills instead of writing items.',
    descriptionFingerprint: '7c51786d65d6',
  },
  add_plan_items: {
    // The SUMMARY is MOTIR-3193's, and the empty-final-batch close is on it
    // because it is a CAPABILITY — the kind of thing a reader picks a tool off
    // this line for. MOTIR-3194 then re-pinned the fingerprint WITHOUT touching
    // it, because what that card added to the description is the
    // ONE-PROPOSAL-PER-TARGET rule — a refusal a caller meets after it has
    // already chosen this tool, and read from the description.
    //
    // ⚠️ MOTIR-4153 falls on the OTHER side of that same test, which is why this
    // line moved for the first time (re-pinned by MOTIR-4165). `revision: true`
    // appends to a plan you have ALREADY CLOSED. Before it the answer to "my plan
    // is `planned` and needs one more card" was that there is no such call — so
    // it is not a refusal met after choosing this tool, it is the fact that
    // decides whether this is the tool. Same test as the close, same verdict.
    //
    // MOTIR-6051 re-pinned the fingerprint WITHOUT touching the summary, by
    // MOTIR-3194's test: a second `modify` now MERGES rather than refusing, which
    // a caller meets after choosing this tool; and "ids come back in order" is
    // still true — a merged proposal's slot carries the surviving id.
    //
    // MOTIR-6631 REWROTE the summary: a `modify` can now MARK a card (the
    // obsolescence mark, its note, the four supersedes lists) and an `add` can
    // carry `supersedesRefs`. That is a new thing this tool DOES, and its one hard
    // rule — only a FINISHED card may be marked; unfinished work is removed — is a
    // refusal that decides how a caller spells the proposal, so the line says it.
    summary:
      'Append proposals to a plan — close it with an empty final batch, or add to one you already closed with `revision: true`; ids come back in order, so the next batch can hang children off them. A `modify` may also mark a FINISHED card outdated or deprecated, with a note and supersedes edges (an `add` names the cards it replaces in `supersedesRefs`), refs as a key, an id or a `planItem:` ref; marking an unfinished card is refused — remove it instead.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: '71733ed8eccf',
  },
  update_plan_item: {
    // AMENDMENT 24 widened the door: on a plan already closed for review it now
    // rewrites a card's words IN PLACE behind `revision: true`, which is the one
    // thing a caller choosing it over a withdraw-and-re-append has to know.
    summary:
      'Fill in a proposal you appended — the deepen turn while the plan is being written, or, with `revision: true`, a rewrite of a card on a plan already in review, in place.',
    descriptionFingerprint: 'da4bb089ff36',
  },
  update_plan_proposal: {
    // The line has to carry what SEPARATES it from the deepen above, because a
    // reader picking between two adjacent tools is choosing on exactly that.
    //
    // MOTIR-6631 REWROTE the summary: an `add`'s `supersedesRefs` is now a
    // correctable set (replaced wholesale, keys resolved), and a `modify`'s mark
    // and supersedes edges are corrected by replacing its patch, re-checked with
    // the same finished-card-only rule as the append.
    summary:
      'Correct a proposal — including its parent, its dependency and supersedes edges, its obsolescence mark and note, and its whole repository axis (a repo, a row, a set, or a role) — even after the plan is in review; a corrected mark is re-checked, so setting one on an unfinished card is refused.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: '9225d81c855e',
  },
  withdraw_plan_proposal: {
    // The SUMMARY stands as written and MOTIR-4146 only re-pinned the
    // fingerprint — the same split MOTIR-3194 recorded on `add_plan_items`
    // above. What that card added to the description is what the LAST
    // withdrawal does, which a caller meets after it has already chosen this
    // tool and reads from the description; the line a reader picks the tool off
    // is unchanged.
    summary:
      'Take one proposal off a plan, instead of asking a reviewer to decline the whole thing.',
    descriptionFingerprint: 'dc5421fc3039',
  },
  update_plan: {
    // The line has to say WHAT this one is about, because its three neighbours
    // are all about a PROPOSAL and this one is not — that is the whole reason a
    // reader picks between them.
    summary:
      "Correct a plan's OWN title and summary — the heading above the tree — without touching a single proposal, and keep your planner record on it.",
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: 'd8f72cc61e0f',
  },
  record_plan_revision_reason: {
    // The line has to say the thing that makes this tool unlike its six
    // neighbours: they all CHANGE the plan and this one does not — it records
    // why it had to change. A reader picking between them is choosing on
    // exactly that.
    summary:
      'Record WHY an unapproved plan had to change — four branches, two of which file a planning bug; it changes nothing about the plan.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: 'f58da227efc6',
  },
  report_plan_step: {
    // What a reader picks this one on: it is the only plan door that says what
    // a planner is DOING rather than what it proposes, and it is advisory.
    summary:
      'Report the step a planner session is on (settle, lay, author), narrate it, or end it — an advisory progress signal on a generating plan.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    // Re-pinned for MOTIR-8062: the `narration` arm joins the description.
    // Re-pinned for MOTIR-10122, summary UNCHANGED: the `codeReads` arm joins the input schema
    // and the step's exclusive-forms sentence.
    descriptionFingerprint: '4d3e24448453',
  },
  hold_plan_revision: {
    // What a reader picks this one on: it is the only plan door that re-opens a
    // plan up for review while it is rewritten, and closes it again at the end.
    summary:
      'Re-open a plan that is up for review while you revise it — generating, Approve refused, steps recorded — and close it again when you finish.',
    // Regenerated from a live `tools/list` handshake, never from the source.
    // Re-pinned for MOTIR-8208: the revision re-opens the plan and `end` closes it.
    descriptionFingerprint: '36c67f640eb5',
  },
  open_plan_session: {
    // Re-worded for MOTIR-6028: a scope holds MANY conversations now, and the
    // result's session `id` is how every later call names the one it means.
    summary:
      'Open a planning conversation — by its id, your recent one, or a new one — and read its thread.',
    descriptionFingerprint: '70c34d46bda7',
  },
  create_work_item: {
    // Re-pinned for MOTIR-5413: `folderId` files the new item into a folder.
    // Re-pinned for MOTIR-6098: a leaf's `difficulty` joins the leaf fields.
    // Re-pinned for MOTIR-6582, summary WIDENED: the obsolescence mark joins the
    // fields settable in the one call, and this summary enumerates them.
    summary:
      'Create an epic, story, task, bug or subtask under a parent or in a folder; points, estimate, type, executor, difficulty, repo, obsolescence mark and content language in one call.',
    // Re-pinned for MOTIR-6673, summary UNCHANGED: the description names OBSOLESCENCE_REQUIRES_FINISHED (a mark on create) and MARKED_CARD_CANNOT_REOPEN (a marked parent); the summary states no
    // status rule.
    // Re-pinned for MOTIR-8098, summary WIDENED: `language` / `languages` override the
    // organisation's content language for the new item's text, one more field set in
    // the one call, and this summary enumerates them.
    // Re-pinned for MOTIR-9031, summary UNCHANGED: the description names the optional
    // `sections` input (INVALID_SECTIONS, SECTIONS_AND_DESCRIPTION_CONFLICT); a body
    // written as sections is still one description, and the summary lists no body
    // rule. Left alone so the ten translated summaries keep matching their source.
    descriptionFingerprint: '0f4e3cd9e4f1',
  },
  update_work_item: {
    // Re-pinned for MOTIR-5585: the description now names PROJECT-repository
    // validation (MOTIR-4955) instead of the retired connected-repo rule; the
    // summary never named the rule, so it still holds.
    // Re-pinned for MOTIR-6098: the description names `difficulty` among the
    // patchable fields; the summary names no field list, so it still holds.
    // Re-pinned for MOTIR-6582, summary UNCHANGED: the description names the
    // obsolescence mark + note (any kind, any status; INVALID_OBSOLESCENCE) among
    // the patchable fields; "any subset of an item's fields" already covers them.
    summary:
      "Edit any subset of an item's fields, including the explanation body create cannot set.",
    // Re-pinned for MOTIR-6673, summary UNCHANGED: the description names the finished-card rule (OBSOLESCENCE_REQUIRES_FINISHED) and MARKED_CARD_CANNOT_REOPEN for a re-parent; the summary states no
    // status rule.
    // Re-pinned for MOTIR-8098, summary UNCHANGED: the description names `language` /
    // `languages` for the edited text; "any subset of an item's fields" covers them.
    // Re-pinned for MOTIR-9031, summary UNCHANGED: the description names the optional
    // `sections` input merged over the stored body; "any subset of an item's fields"
    // covers it, and the translated summaries keep matching their source.
    descriptionFingerprint: '9dc87a265b74',
  },
  transition_status: {
    summary:
      'Move an item to another status. An illegal move comes back naming the ones that are legal.',
    // Re-pinned for MOTIR-6673, summary UNCHANGED: the description names MARKED_CARD_CANNOT_REOPEN for a marked item; the summary states no
    // status rule.
    descriptionFingerprint: 'b55dfc136bc7',
  },
  claim_next_ready: {
    summary:
      'Atomically claim the next ready subtask in the active sprint: assign it to you and flip it to In Progress.',
    descriptionFingerprint: 'a09bcdf27287',
  },
  claim_work_item: {
    summary:
      'Atomically claim ONE named work item and flip it to In Progress. A lost claim says WHO holds it.',
    descriptionFingerprint: '272d4e9c0a23',
  },
  claim_work_item_repair: {
    summary:
      'Take the repair lock on a work item with failing pull requests, as `motir fix` does. One fixer at a time.',
    descriptionFingerprint: 'ce7801d719d9',
  },
  touch_work_item_repair: {
    summary:
      'Keep your repair of a work item alive. A repair silent for five minutes is closed and its lock released.',
    descriptionFingerprint: '7383e1d2aeaf',
  },
  close_work_item_repair: {
    summary:
      'End your repair of a work item with how it went, so the page shows it and a new repair may start.',
    descriptionFingerprint: '1b8e5165724b',
  },
  claim_work_item_continue: {
    summary:
      'Take over a work item whose last run died or stopped at a gate that is now approved, as `motir continue` does: its branch and pull requests, not a fresh start.',
    descriptionFingerprint: 'fe56eebf7af2',
  },
  touch_work_item_continue: {
    summary:
      'Keep your continue of a work item alive. A continue silent for five minutes is closed and its lock released.',
    descriptionFingerprint: 'e752b186c478',
  },
  close_work_item_continue: {
    summary:
      'End your continue of a work item with how it went, so the page shows it and the card can be continued again.',
    descriptionFingerprint: '5065a62ce4e3',
  },
  start_work_item_run: {
    summary:
      'Open your own run of a card you hold, naming your harness and model, so it shows on Runs and on the card.',
    descriptionFingerprint: 'e52fc38024a8',
  },
  report_action: {
    summary:
      'Say the step you are about to take on a card, record a milestone, or send a heartbeat for your open runs.',
    descriptionFingerprint: '8ca2af76044a',
  },
  close_work_item_run: {
    summary:
      'End your run of a card with how it went; a delivered close records you as the implementer.',
    descriptionFingerprint: 'f9b55d5e5987',
  },
  add_comment: {
    summary: 'Post a Markdown comment as the token owner. Mentions notify the member named.',
    descriptionFingerprint: '81d096a6d087',
  },
  edit_comment: {
    summary: 'Replace the body of a comment you wrote. Only its author can edit it here.',
    descriptionFingerprint: '22242523200c',
  },
  delete_comment: {
    summary:
      'Permanently delete a comment you wrote, with its replies. Only its author can delete it here.',
    descriptionFingerprint: 'e09c5b6edd67',
  },
  list_work_item_todos: {
    summary: 'Read a work item’s to-do list: its steps in order, which are done, and the progress.',
    // Re-pinned for MOTIR-8098, summary UNCHANGED: each step carries the language its
    // text was recorded in — a field of the step, not a new question.
    descriptionFingerprint: '48f4bc2ba869',
  },
  add_work_item_todo: {
    summary: 'Append one step to the end of a work item’s to-do list.',
    // Re-pinned for MOTIR-8098, summary UNCHANGED: the step records the organisation's
    // content language unless `language` names another.
    descriptionFingerprint: '912e836d1d6f',
  },
  set_work_item_todo_done: {
    summary:
      'Tick or untick one step of a work item’s to-do list. Ticking the last step does not change the work item’s status.',
    descriptionFingerprint: 'c69111aa37be',
  },
  update_work_item_todo: {
    summary:
      'Edit one step of a work item’s to-do list. Only the fields you send change; null clears an optional one.',
    descriptionFingerprint: '81aace704cbf',
  },
  delete_work_item_todo: {
    summary: 'Permanently delete one step of a work item’s to-do list.',
    descriptionFingerprint: '9857d5a3fee8',
  },
  move_work_item_todo: {
    summary: 'Move one step of a work item’s to-do list to a new position.',
    descriptionFingerprint: 'f5ab1f9c59d1',
  },
  add_lesson: {
    summary:
      'Record a lesson for this project, so later plans for it are given the lesson. This project only.',
    // Re-pinned by MOTIR-5081: the description gained the FOURTH routing axis,
    // `subject`, and says why it is SCALAR where the other three are sets. The
    // summary is unchanged because it still says the same thing — it pitches
    // what the tool is FOR and never enumerated the axes, so nothing in it went
    // stale. Taken from the live handshake the gate prints, never computed by
    // hand.
    descriptionFingerprint: '6aaebd8fe579',
  },
  search_lessons: {
    summary:
      "Search recorded lessons by meaning — the shared corpus and this project's own — narrowed by kind, type, phase and subject, before you plan or build.",
    // Re-pinned by MOTIR-5621: the tool gained a FOURTH narrowing axis, so the
    // summary's list of what a caller narrows by was no longer the whole set —
    // which is the drift this pin exists to force a re-read of, rather than a
    // re-wrap to absorb. (MOTIR-4775 re-pinned it before, when the phase axis
    // became `lay` / `author`.) Taken from the live handshake the gate prints,
    // never computed by hand.
    descriptionFingerprint: 'b7a51e9d5a29',
  },
  reinforce_lesson: {
    summary:
      'Record that a lesson you found describes something that just went wrong — whether or not you also change it.',
    descriptionFingerprint: '264d63e358fd',
  },
  expand_item: {
    summary:
      "Submit an AI expansion of one container item. Spends the owner's credits; proposals await approval.",
    descriptionFingerprint: 'ee60a5541cc4',
  },
  append_plan_turn: {
    // Re-worded for MOTIR-6028: the turn lands on the conversation its
    // `sessionId` names.
    summary:
      'Add one turn to a planning conversation, named by its session id — what you want changed about the plan.',
    descriptionFingerprint: '6cb04a966e25',
  },
  submit_plan_session: {
    // Re-pinned by MOTIR-4165 with the summary UNTOUCHED, which is the
    // `add_plan_items` / MOTIR-3194 disposition rather than the one directly
    // above. MOTIR-4172 gave the description a paragraph on the optional
    // `requirement` argument — the six-field WHAT a caller may compose so the
    // planner starts knowing the problem. That is read AFTER a caller has chosen
    // this tool: it changes how you call it, never whether this is the call. The
    // line still says what the tool is for, and it is the only thing it owes.
    // Re-pinned for MOTIR-9878, summary UNCHANGED: the description now says the
    // `requirement` and `targetKeys` are input the planner settles from; the call
    // is still the one that hands the conversation's intent to the planner.
    summary: "Send the conversation's accumulated intent to the planner as one change set.",
    // Regenerated from a live `tools/list` handshake, never from the source.
    descriptionFingerprint: '2fe93c5a3739',
  },
  link_work_items: {
    summary:
      'Create an edge between two items — blocked_by is the one that holds an item out of the ready set.',
    // Re-pinned for MOTIR-6369, summary UNCHANGED: the description gained the
    // same-level rule and its CROSS_LEVEL_LINK refusal, which the summary does not
    // enumerate for the other refusals either.
    // Re-pinned for MOTIR-6411, summary UNCHANGED: the level rule the description
    // states moved from kind to POSITION (MOTIR-6387); the summary names neither.
    // Re-pinned for MOTIR-6443, summary UNCHANGED: the level rule the text states
    // gains the epic tier (an epic is blocked only by another epic).
    // Re-pinned for MOTIR-6509, summary UNCHANGED: the description stops naming a
    // CROSS_LEVEL_LINK refusal — a cross-level edge is written and reported by
    // `validate_work_item` instead. The summary named no refusal either way.
    // Re-pinned for MOTIR-6580, summary UNCHANGED: the relationship enum gains
    // `supersedes` / `superseded_by`; blocked_by is still the only edge that holds
    // an item out of the ready set, which is all the summary claims.
    descriptionFingerprint: 'a5762942a5e1',
  },
  unlink_work_items: {
    summary: 'Remove an edge, given the same relationship used to create it.',
    descriptionFingerprint: 'ddebb74fa44c',
  },
  move_to_parent: {
    // Re-pinned for MOTIR-5413: exactly one of `parentKey` / `folderId`.
    summary:
      'Re-place an item — under a new parent, or into or out of a folder — enforcing the kind-parent matrix and refusing a cycle.',
    // Re-pinned for MOTIR-6673, summary UNCHANGED: the description names MARKED_CARD_CANNOT_REOPEN for a move under a marked parent; the summary states no
    // status rule.
    descriptionFingerprint: 'a89b4b4ac5ca',
  },
  change_kind: {
    // Re-pinned for MOTIR-6098: a leaf-only difficulty, like a type, must be
    // cleared before a move to a container; the summary still holds.
    summary: "Reclassify a leaf's kind when it is mis-filed — subtask to task, and back.",
    descriptionFingerprint: '57fec557359d',
  },
  archive_work_item: {
    summary: 'Soft-remove an item: it leaves the ready set and search, and stays fully restorable.',
    descriptionFingerprint: 'c806b53fd762',
  },
  unarchive_work_item: {
    summary: 'Restore an archived item — the inverse of archive.',
    descriptionFingerprint: '8ada099dad87',
  },
  delete_work_item: {
    summary: 'Permanently delete an item and its whole subtree. Irreversible, and off by default.',
    descriptionFingerprint: '416497cebae1',
  },
  create_sprint: {
    summary:
      'Create a planned sprint on a project, with an optional name, goal and planned window.',
    descriptionFingerprint: 'e18783eda5a4',
  },
  update_sprint: {
    summary: 'Rename a sprint, change its goal, or adjust its planned window.',
    descriptionFingerprint: '5efd5da7f72d',
  },
  delete_sprint: {
    summary: 'Delete a planned or complete sprint.',
    descriptionFingerprint: '1993eb2eb159',
  },
  start_sprint: {
    summary: "Start a planned sprint, making it the project's active one.",
    descriptionFingerprint: 'a6537ea4f114',
  },
  complete_sprint: {
    summary: 'Complete the active sprint.',
    descriptionFingerprint: 'a2f8a391c36a',
  },
  move_to_sprint: {
    summary: 'Add items to a sprint in one atomic move, appended in the order given.',
    descriptionFingerprint: '9fb0ffb5cf7c',
  },
  move_to_backlog: {
    summary: 'Move items out of their sprint and back to the backlog.',
    descriptionFingerprint: '52003d122cfd',
  },
  mark_integrated: {
    summary:
      "Record that an item's work landed — the branch, the PR and the commit that carried it.",
    descriptionFingerprint: '645372de2186',
  },
  complete_session: {
    summary:
      'Close out a session branch after its PR merged: every item recorded on it moves to Done.',
    descriptionFingerprint: 'fbfb1bc9197a',
  },
};

/** One catalogue row. */
export interface McpToolRow {
  name: McpCatalogueToolName;
  permission: PermissionKey;
  summary: string;
  /**
   * The tool's ARGUMENTS — the draft-07 JSON Schema `tools/list` serves for it,
   * verbatim (MOTIR-4389).
   *
   * ⚠️ IT IS NOT DERIVED HERE, and it could not be. A schema is declared inside
   * its tool's `registerTool(...)` call, and this module may not import the
   * registry (the dependency-graph rule in this file's header). It comes from
   * `mcpToolSchemas.ts`, a GENERATED leaf written from a live handshake and
   * pinned byte-for-byte against a fresh one by
   * `tests/mcp/tool-schema-truth.test.ts` — the same relationship
   * `packages/cli/src/api/` has to the OpenAPI emitter, and a stronger one than
   * the fingerprint beside it, which pins a hash of the prose rather than the
   * value.
   */
  inputSchema: McpToolInputSchema;
  /**
   * The tool's human name, exactly as `tools/list` serves it (MOTIR-7002) —
   * 1–64 characters, guarded at the registration seam. Generated, like
   * `inputSchema`, for the same reason.
   */
  title: string;
  /**
   * The tool's HINTS, exactly as `tools/list` serves them (MOTIR-7002): whether
   * it only reads, and for a write whether it is destructive and idempotent,
   * and whether it reaches a system outside Motir. The classification is
   * `lib/mcp/toolAnnotations.ts`'s; it reaches this row through the generated
   * leaf, never by an import.
   */
  annotations: McpToolHints;
}

/** One catalogue group — a permission, and the tools it gates. */
export interface McpCatalogueGroup {
  permission: PermissionKey;
  label: string;
  gates: string;
  grantedByDefault: boolean;
  tools: McpToolRow[];
}

/**
 * The catalogue, grouped by PERMISSION.
 *
 * The GROUPING is derived: a tool's group is its own `TOOL_PERMISSIONS` entry, so
 * no per-tool grouping fact is authored and a new tool lands in a group the
 * moment it has a permission — which is the moment it exists. Since MOTIR-2581
 * the group LABELS are derived too, from the shipped `permissions.*` copy; the
 * only authored thing left is the ORDER, which is the catalog's own.
 *
 * Groups with no tools are dropped, so a permission that gates no MCP tool does
 * not render an empty heading.
 */
export function mcpCatalogue(): McpCatalogueGroup[] {
  const rows = (Object.keys(TOOL_SUMMARIES) as McpCatalogueToolName[])
    .map((name) => ({
      name,
      permission: TOOL_PERMISSIONS[name],
      summary: TOOL_SUMMARIES[name].summary,
      inputSchema: MCP_TOOL_INPUT_SCHEMAS[name],
      title: MCP_TOOL_TITLES[name],
      annotations: MCP_TOOL_ANNOTATIONS[name],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return GRANTABLE_PERMISSIONS.map((permission) => ({
    permission,
    label: permissionLabel(permission),
    gates: permissionDescription(permission),
    grantedByDefault: DEFAULT_TOKEN_GRANT.includes(permission),
    tools: rows.filter((row) => row.permission === permission),
  })).filter((group) => group.tools.length > 0);
}

/** Every row, flat — for the truth test and for a count. */
export function mcpToolRows(): McpToolRow[] {
  return mcpCatalogue().flatMap((group) => group.tools);
}

/**
 * How many tools the catalogue carries. **Computed, never a literal** — the
 * number a reader sees is the length of what was derived, so it cannot disagree
 * with the list beneath it.
 */
export function mcpToolCount(): number {
  return mcpToolRows().length;
}

/** The stored fingerprint for one tool, for the gate to compare against. */
export function mcpToolFingerprint(name: McpCatalogueToolName): string {
  return TOOL_SUMMARIES[name].descriptionFingerprint;
}

// ── The PUBLISHED catalogue document (MOTIR-4194) ───────────────────────────
//
// What `GET /api/docs/mcp-tools.json` serves, built here so that the route is a
// one-line serialization and the SHAPE is testable without a request. Every
// field is derived from the catalogue above: the group ORDER is the permission
// catalog's own (the one authored fact), group MEMBERSHIP is each tool's
// `TOOL_PERMISSIONS` entry, and the labels are the shipped `permissions.*` copy.
// The count is computed from the rows, never written.
//
// ⚠️ UNVERSIONED, deliberately — `public-surface-hosts.md` AMENDMENT 5 §C. The
// MCP surface versions itself through `tools/list`, and this document describes
// that surface for a READER, not for a client that hard-codes it. A consumer may
// rely on the path and on the field names below; the tool set, the summaries,
// the labels and the count change whenever the server does, and the consumer
// must tolerate fields it does not know.

/** The published catalogue: `GET /api/docs/mcp-tools.json`'s body. */
export interface McpToolCatalogueDocument {
  /**
   * Where the tools are CALLED — the live `tools/list` there is the authoritative
   * surface, and this document is its reader-facing description.
   */
  endpoint: string;
  /** {@link mcpToolCount} — computed from the rows, so it cannot disagree with them. */
  toolCount: number;
  /** {@link mcpCatalogue} — grouped by permission, in the catalog's order. */
  groups: McpCatalogueGroup[];
}

/**
 * The published catalogue for a reader's language (MOTIR-8031). Everything but
 * the human text is the English document's, and three fields let a renderer mark
 * language honestly with a `lang` attribute.
 */
export interface McpLocalizedToolCatalogueDocument extends Omit<
  McpToolCatalogueDocument,
  'groups'
> {
  /** The served locale (never `'en'`: English is the unlocalized document). */
  locale: Locale;
  groups: Array<
    Omit<McpCatalogueGroup, 'tools'> & {
      /** The language `label` and `gates` are in: the locale or `'en'`. */
      textLocale: Locale;
      tools: Array<
        McpToolRow & {
          /** The language `summary` is in: the locale or `'en'`. */ summaryLocale: Locale;
        }
      >;
    }
  >;
}

function buildCatalogueDocument(): McpToolCatalogueDocument {
  const groups = mcpCatalogue();
  return {
    endpoint: MCP_ENDPOINT_PATH,
    toolCount: groups.reduce((count, group) => count + group.tools.length, 0),
    groups,
  };
}

function buildLocalizedDocument(locale: Exclude<Locale, 'en'>): McpLocalizedToolCatalogueDocument {
  const english = buildCatalogueDocument();
  return {
    endpoint: english.endpoint,
    toolCount: english.toolCount,
    locale,
    groups: english.groups.map((group) => {
      const text = localizedGroupText(
        permissionSlug(group.permission),
        { label: group.label, gates: group.gates },
        locale,
      );
      return {
        ...group,
        label: text.text.label,
        gates: text.text.gates,
        textLocale: text.locale,
        tools: group.tools.map((tool) => {
          const summary = localizedSummary(tool.name, tool.summary, locale);
          return { ...tool, summary: summary.text, summaryLocale: summary.locale };
        }),
      };
    }),
  };
}

// Both depend only on compile-time data, so each is built once.
let englishDocument: McpToolCatalogueDocument | undefined;
const localizedDocuments = new Map<string, McpLocalizedToolCatalogueDocument>();

/**
 * `locale` is the RAW query value. English, absent, empty, mis-cased or unknown
 * values all resolve to the unlocalized document, unchanged and with no new
 * field; the value is never echoed.
 */
export function mcpToolCatalogueDocument(): McpToolCatalogueDocument;
export function mcpToolCatalogueDocument(
  locale: string | null | undefined,
): McpToolCatalogueDocument | McpLocalizedToolCatalogueDocument;
export function mcpToolCatalogueDocument(
  locale?: string | null,
): McpToolCatalogueDocument | McpLocalizedToolCatalogueDocument {
  const resolved = resolveCatalogueLocale(locale);
  if (resolved === null) return (englishDocument ??= buildCatalogueDocument());
  let doc = localizedDocuments.get(resolved);
  if (doc === undefined) {
    doc = buildLocalizedDocument(resolved);
    localizedDocuments.set(resolved, doc);
  }
  return doc;
}

// ── What the page hands off ─────────────────────────────────────────────────

/** The in-repo reference this page fronts; everything past the first run. */
export const MCP_REFERENCE_URL = 'https://github.com/moooon-B-V/motir-core/blob/main/docs/mcp.md';
