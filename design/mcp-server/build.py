#!/usr/bin/env python3
"""Regenerate `design/mcp-server/mcp-server.mock.html`.

    python3 design/mcp-server/build.py          # from the repository root
    pnpm exec prettier --write design/mcp-server/mcp-server.mock.html

The prettier pass is not optional — CI checks formatting repository-wide, and
this script emits the markup unformatted.

Story MOTIR-2309 · Subtask MOTIR-2323 · drawn to ADR Amendment 12 (MOTIR-2321).

WHY A GENERATOR. The catalogue panel has to be drawn at its REAL size — the card
asks for thirty-nine rows, not an abbreviated five — because the page's length,
its anchoring and its behaviour on a phone are decided by looking at the real
thing. Typing thirty-nine rows into a mock by hand would also make the asset a
second hand-maintained copy of a list the code already owns, which is the exact
failure Amendment 12 Q2 exists to prevent one layer down.

WHAT IS DERIVED, and from where — the same split Amendment 12 Q2 decided for
`lib/apiDocs/mcp.ts`:

  * tool NAMES and SCOPES      `lib/mcp/scopes.ts` → TOOL_SCOPES
  * the GROUPING               each tool's own scope; only the six group labels
                               and their order (TOKEN_SCOPES order) are authored
  * the SUMMARIES              authored below, in SUMMARIES — this is the draft
                               MOTIR-2325 inherits, and the pinning mechanism
                               that keeps them true is that card's and
                               MOTIR-2330's, not this asset's
  * the token/shape CSS        copied 1:1 at build time from
                               `design/agent-sandbox/agent-sandbox.mock.html`,
                               which took it from `design/api-docs/`, which took
                               it from `app/globals.css` — so this surface cannot
                               drift from the one it mounts in

The script refuses to write anything if the tool count it derives disagrees with
TOOL_SCOPES, so an asset regenerated after the registry grows is either correct
or a hard error.
"""

import html
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STYLE_SOURCE = os.path.join(ROOT, 'design/agent-sandbox/agent-sandbox.mock.html')
OUT = os.path.join(ROOT, 'design/mcp-server/mcp-server.mock.html')

# ── The authored half (Amendment 12 Q2). One line per tool, reader-facing —
#    NOT the agent-facing `description` the server ships, which is written for a
#    model and reads as noise in a human's scan-and-choose table.
SUMMARIES = {
    "get_work_item": "One item in full — description, status, parent and children, dependency edges, and a readiness verdict.",
    "get_work_item_activity": "One page of an item's discussion and change trail: comment threads and history, interleaved.",
    "list_ready": "The ready-to-start set for a project — every item whose dependencies are all satisfied, paginated.",
    "next_ready": "The single highest-ranked ready item, as a full dispatch payload. The “what do I do next” call.",
    "dispatch_prompt": "The server-generated coding-agent prompt for one item — the same text the CLI hands an agent.",
    "search_work_items": "Search a project's items with the same filter grammar the advanced filter builder writes.",
    "whoami": "Who this token is: the owning user, the active workspace, and the scopes granted. Call it first.",
    "list_projects": "Every project this token can reach, each with the projectKey every other tool takes.",
    "get_project_state": "A project's planning preconditions — established, code connected, indexed, repo set — before you plan.",
    "get_code_health": "Each repository's index state, latest code-health audit summary and derived coding convention — what the hosted planner reads.",
    "get_coding_convention": "One repository's coding convention in full — derived or edited by a person, with its version — what a change in that repository follows.",
    "read_file": "One file's text from a project repository at a ref — capped, line-ranged, every absence a named outcome.",
    "code_explore": "Explore the hosted code graph around a query — the hosted planner's own answer, paged, every absence a named state.",
    "code_search": "Search the hosted code graph for symbols by name — the hosted planner's own answer, paged.",
    "list_sprints": "A project's sprints with state, goal, window and issue count, and the ids the sprint tools take.",
    "validate_sprint": "Is this sprint finishable? Names every in-sprint item still gated by work outside it.",
    "validate_work_item": "Is this epic, story, task or bug finishable? Names the out-of-subtree work still gating it.",
    "get_plan_status": "What became of a submitted planning job — its state, and how many proposals it produced.",
    "get_plan": "A plan with the proposals it bundles: what the planner actually proposed, not just how much.",
    "get_approved_shape_verdict": "Is this card still what its last approved plan approved? Its plan history and the verdict.",
    "report_unbuildable_target": "A dispatched runner reports the card it stopped on as unbuildable — acknowledged, nothing to act on.",
    "record_run_discrepancy": "A runner records what it built differently from a plan wrong only about the HOW, and the decisions it made where the plan was silent — a card comment and a run record, acknowledged.",
    "open_plan_session": "Open — or resume — a project's planning conversation, and read its thread.",
    "create_work_item": "Create an epic, story, task, bug or subtask; points, estimate, type, executor and repo in one call.",
    "update_work_item": "Edit any subset of an item's fields, including the explanation body create cannot set.",
    "transition_status": "Move an item to another status. An illegal move comes back naming the ones that are legal.",
    "claim_next_ready": "Atomically claim the next ready subtask in the active sprint and flip it to In Progress. Race-safe.",
    "add_comment": "Post a Markdown comment as the token owner. Mentions notify the member named.",
    "expand_item": "Submit an AI expansion of one container item. Spends the owner's credits; proposals await approval.",
    "append_plan_turn": "Add one turn to a project's planning conversation — what you want changed about the plan.",
    "submit_plan_session": "Send the conversation's accumulated intent to the planner as one change set.",
    "link_work_items": "Create an edge between two items — blocked_by is the one that holds an item out of the ready set.",
    "unlink_work_items": "Remove an edge, given the same relationship used to create it.",
    "move_to_parent": "Re-parent an item, enforcing the kind-parent matrix and refusing a cycle.",
    "change_kind": "Reclassify a leaf's kind when it is mis-filed — subtask to task, and back.",
    "archive_work_item": "Soft-remove an item: it leaves the ready set and search, and stays fully restorable.",
    "unarchive_work_item": "Restore an archived item — the inverse of archive.",
    "delete_work_item": "Permanently delete an item and its whole subtree. Irreversible, and off by default.",
    "create_sprint": "Create a planned sprint on a project, with an optional name, goal and planned window.",
    "update_sprint": "Rename a sprint, change its goal, or adjust its planned window.",
    "delete_sprint": "Delete a planned or complete sprint.",
    "start_sprint": "Start a planned sprint, making it the project's active one.",
    "complete_sprint": "Complete the active sprint.",
    "move_to_sprint": "Add items to a sprint in one atomic move, appended in the order given.",
    "move_to_backlog": "Move items out of their sprint and back to the backlog.",
    "mark_integrated": "Record that an item's work landed — the branch, the PR and the commit that carried it.",
    "complete_session": "Close out a session branch after its PR merged: every item recorded on it moves to Done."
}


def derive_tools():
    """NAMES + SCOPES from TOOL_SCOPES; titles from the registerTool calls."""
    scopes_src = open(os.path.join(ROOT, 'lib/mcp/scopes.ts')).read()
    block = re.search(
        r'TOOL_SCOPES: Record<McpToolName, TokenScope> = \{(.*?)\n\};',
        scopes_src, re.S).group(1)
    pairs = re.findall(r"^  ([a-z_]+): '([a-z_:]+)'", block, re.M)

    STR = r'''(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")'''
    titles = {}
    tools_dir = os.path.join(ROOT, 'lib/mcp/tools')
    for f in sorted(os.listdir(tools_dir)):
        if not f.endswith('.ts'):
            continue
        src = open(os.path.join(tools_dir, f)).read()
        for m in re.finditer(
                rf'registerTool\(\s*([A-Z_0-9]+),\s*\{{\s*title:\s*({STR})', src):
            const, title = m.group(1), m.group(2)[1:-1]
            cm = re.search(rf"{const}\s*=\s*'([^']+)'", src)
            if cm:
                titles[cm.group(1)] = title

    tools = []
    for name, scope in pairs:
        if name not in SUMMARIES:
            sys.exit(f'no summary authored for tool {name!r} — add one to SUMMARIES')
        tools.append({'name': name, 'scope': scope,
                      'title': titles.get(name, name), 'summary': SUMMARIES[name]})
    stale = [n for n in SUMMARIES if n not in dict(pairs)]
    if stale:
        sys.exit(f'SUMMARIES carries tools the registry no longer has: {stale}')
    return tools


TOOLS = derive_tools()
STYLE = (lambda s: s[s.index('    <style>'):s.index('    </style>') + len('    </style>')])(
    open(STYLE_SOURCE).read())
e = html.escape


# ── Q2's grouping: BY SCOPE, membership derived from TOOL_SCOPES; only the six
#    labels + their order are authored (TOKEN_SCOPES order).
SCOPE_ORDER = ['read', 'work_items:write', 'work_items:archive',
               'work_items:delete', 'sprints:write', 'integration']
SCOPE_LABEL = {
    'read': 'Read',
    'work_items:write': 'Write work items',
    'work_items:archive': 'Archive & restore',
    'work_items:delete': 'Delete',
    'sprints:write': 'Sprints',
    'integration': 'Integration',
}
SCOPE_GATES = {
    'read': 'Every read — items, the ready set, search, sprints, plans, identity. Never mutates.',
    'work_items:write': 'Create, edit, transition, comment, link, re-parent — and submit a planning job.',
    'work_items:archive': 'Soft-remove and restore. Recoverable, so it is on by default.',
    'work_items:delete': 'Irreversible subtree delete. The only scope OFF by default on a new token.',
    'sprints:write': 'The sprint lifecycle and its membership moves.',
    'integration': 'Mark work integrated, and close out a session branch.',
}
DEFAULT_OFF = {'work_items:delete'}

def by_scope():
    return [(s, [t for t in TOOLS if t['scope'] == s]) for s in SCOPE_ORDER]

def cat_rows(groups, anchor_prefix=''):
    out = []
    for scope, tools in groups:
        out.append(f'''
            <section class="cat-group" id="{anchor_prefix}{scope.replace(':','-')}">
              <div class="cat-group-head">
                <h3>{e(SCOPE_LABEL[scope])}</h3>
                <span class="scope-pill{' scope-pill--off' if scope in DEFAULT_OFF else ''}">{e(scope)}</span>
                <span class="cat-count">{len(tools)} tool{'' if len(tools) == 1 else 's'}</span>
              </div>
              <p class="cat-gates">{e(SCOPE_GATES[scope])}</p>
              <table class="spec cat-table">
                <thead><tr><th>Tool</th><th>What it does</th></tr></thead>
                <tbody>''')
        for t in tools:
            out.append(
                f'''<tr><td><code>{e(t['name'])}</code></td>'''
                f'''<td>{e(t['summary'])}</td></tr>''')
        out.append('</tbody></table></section>')
    return '\n'.join(out)

def cat_cards(groups):
    out = []
    for scope, tools in groups:
        out.append(f'''
          <div class="cat-group-head">
            <h3>{e(SCOPE_LABEL[scope])}</h3>
            <span class="scope-pill{' scope-pill--off' if scope in DEFAULT_OFF else ''}">{e(scope)}</span>
          </div>''')
        for t in tools:
            out.append(f'''
          <div class="pcard">
            <dl>
              <dt>Tool</dt><dd><code>{e(t['name'])}</code></dd>
              <dt>Does</dt><dd>{e(t['summary'])}</dd>
            </dl>
          </div>''')
    return '\n'.join(out)

GROUPS = by_scope()
TOTAL = len(TOOLS)
assert TOTAL == 39, TOTAL

EXTRA_CSS = '''
    <style>
      /* ── Added by THIS asset (design/mcp-server/) — the catalogue's own bits.
           Every value routes through an --el-* colour token or an
           element-semantic shape token; nothing Tier-0, nothing invented. ── */
      .cat-group { margin-bottom: 26px; scroll-margin-top: 16px; }
      .cat-group-head { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; }
      /* Uppercase DELIBERATELY, matching the rail's own group headings — a
         catalogue group and a rail group name the same six scopes, so they read
         as one vocabulary. (.doc h3 already uppercases; this states it.) */
      .cat-group-head h3 {
        margin: 0; font-family: var(--font-sans); font-size: 14px;
        font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
        color: var(--el-text);
      }
      .cat-count { margin-left: auto; font-family: var(--font-mono);
        font-size: 11px; color: var(--el-text-faint); }
      .cat-gates { margin: 0 0 8px; max-width: 68ch; font-size: 13px;
        line-height: 1.6; color: var(--el-text-secondary); }
      .scope-pill {
        display: inline-flex; align-items: center;
        padding: var(--spacing-chip-y) var(--spacing-chip-x);
        border-radius: var(--radius-badge);
        background: var(--el-tint-lavender); color: var(--el-text-strong);
        font-family: var(--font-mono); font-size: 11px; white-space: nowrap;
      }
      .scope-pill--off { background: var(--el-tint-peach); }
      .cat-table td:first-child { width: 15.5rem; white-space: nowrap; }
      .cat-table td:first-child code { font-size: 12.5px; }
      .tablet { width: 820px; border: 1px solid var(--el-border);
        border-radius: var(--radius-card); overflow: hidden;
        box-shadow: var(--shadow-card); background: var(--el-page-bg); }
      .tablet .docs-main { padding: 20px 22px 26px; }
      .phone.is-375 { width: 375px; }
      .legend { display: grid; grid-template-columns: 1fr; gap: 0; margin-bottom: 22px; }
      .doorframe { border: 1px solid var(--el-border); border-radius: var(--radius-card);
        background: var(--el-surface-soft); padding: 22px; }
      .marker { display: inline-flex; align-items: center; justify-content: center;
        width: 18px; height: 18px; border-radius: 999px;
        background: var(--el-accent); color: var(--el-accent-text);
        font-family: var(--font-mono); font-size: 11px; margin-right: 6px; }
      .stepnum { display: inline-block; min-width: 1.1em; margin-right: 8px;
        font-family: var(--font-mono); font-weight: 500; color: var(--el-text-faint); }
      .mono-meta { margin: -4px 0 18px; font-family: var(--font-mono);
        font-size: 12px; color: var(--el-text-faint); }
      .doc .lede + .mono-meta { margin-top: 6px; }
      .client-h {
        margin: 22px 0 6px; font-family: var(--font-sans); font-size: 13px;
        font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
        color: var(--el-text-secondary);
      }
      .clientmeta {
        margin: 6px 0 0; max-width: 68ch; font-size: 12px; line-height: 1.6;
        color: var(--el-text-faint);
      }
      .clientmeta code { font-size: 11.5px; overflow-wrap: anywhere; }
      .anno.anno-block { display: block; }
      .anno.anno-block .marker { vertical-align: 1px; }
      .anchorbar { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 20px; }
      .anchorbar a {
        padding: var(--spacing-chip-y) var(--spacing-chip-x);
        border-radius: var(--radius-badge); border: 1px solid var(--el-border-soft);
        background: var(--el-surface); color: var(--el-text-secondary);
        font-size: 12px; text-decoration: none;
      }
    </style>
'''

TIER1 = '''          <nav class="docs-nav" aria-label="Documentation">
            <div class="navgroup">
              <h3>Documentation</h3>
              <a class="navrow" href="/docs/api">API reference</a>
              <a class="navrow" href="/docs/sandbox">Agent sandbox</a>
              <a class="navrow {mcp_active}" href="/docs/mcp"{mcp_aria}>MCP server</a>
            </div>'''

TIER2 = '''
            <div class="navgroup">
              <h3>MCP server</h3>
              <a class="navrow {tools_active}" href="/docs/mcp/tools"{tools_aria}>Tools</a>
            </div>'''


def rail(current):
    """`current` is 'mcp' | 'tools' inside the sub-area, or the name of a page
    OUTSIDE it (e.g. 'sandbox'). Tier 2 is gated on the route PREFIX, never on a
    per-page flag — the shipped `CatalogueNav` gate (Amendment 11 Q2), so the
    left-hand card of Panel 6 shows what a reader on another surface really sees.
    """
    in_area = current in ('mcp', 'tools')
    out = TIER1.format(
        mcp_active='is-active' if current == 'mcp' else '',
        mcp_aria=' aria-current="page"' if current == 'mcp' else '')
    if in_area:
        out += TIER2.format(
            tools_active='is-active' if current == 'tools' else '',
            tools_aria=' aria-current="page"' if current == 'tools' else '')
    return out + '\n          </nav>' 

TOPBAR = '''        <header class="site-top">
          <span class="brand"
            ><span class="tile" aria-hidden="true">M</span><span class="name">Motir</span></span
          >
          <nav class="site-nav" aria-label="Product">
            <span class="nav-label">Product</span>
            <span class="nav-label">Pricing</span>
            <a class="nav-current" href="/docs/api" aria-current="page">Docs</a>
            <a class="nav-link" href="/explore">Explore</a>
          </nav>
          <span style="display: inline-flex; gap: 8px">
            <a class="btn btn-sm btn-ghost" href="/sign-in">Sign in</a>
            <a class="btn btn-sm btn-primary" href="/sign-up">Start free →</a>
          </span>
        </header>'''

# ── PANEL 1 — /docs/mcp, the wiring page (Q1's sub-area index) ──────────────
WIRING_MAIN = '''          <main class="docs-main doc">
            <h1>The Motir MCP server</h1>
            <p class="lede">
              Motir's project plan is reachable by any Model Context Protocol client over one
              endpoint. Point your agent at it with a personal access token and it can read the
              ready set, claim the next item, create work, move statuses and comment — through the
              same services, permissions and data the web app uses.
            </p>

            <h2>Should you use this, or the REST API?</h2>
            <p>
              Motir publishes two programmatic surfaces over the same domain. They are not
              alternatives with the same trade-off, and the difference is worth thirty seconds
              before you pick.
            </p>
            <table class="spec">
              <thead>
                <tr><th></th><th>The MCP server</th><th>The REST API</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td><span class="nm">Endpoint</span></td>
                  <td><code>POST /api/mcp</code></td>
                  <td><code>/api/v1/&hellip;</code></td>
                </tr>
                <tr>
                  <td><span class="nm">Built for</span></td>
                  <td>An <strong>agent you control</strong> — it reads tool descriptions at run time.</td>
                  <td>A <strong>client you ship</strong> — code written once against a fixed shape.</td>
                </tr>
                <tr>
                  <td><span class="nm">Stability</span></td>
                  <td><strong>Expected to change.</strong> Rewording a description or renaming an
                      argument is how an agent's behaviour gets tuned.</td>
                  <td><strong>Additive only.</strong> A breaking change mints <code>/api/v2</code>;
                      v1 keeps its promise.</td>
                </tr>
                <tr>
                  <td><span class="nm">Shape</span></td>
                  <td colspan="2">The same. MCP payloads are derived from the v1 response schemas, so
                      the two describe provably identical objects.</td>
                </tr>
                <tr>
                  <td><span class="nm">Auth</span></td>
                  <td colspan="2">One personal access token, one scope set. The same credential
                      works on both.</td>
                </tr>
              </tbody>
            </table>
            <div class="callout">
              <span aria-hidden="true">◆</span>
              <span>Wiring an agent? Stay here. Writing software other people install?
                <a href="/docs/api">Read the API reference</a>.</span>
            </div>

            <h2><span class="stepnum">1</span> Mint a token</h2>
            <p>
              In the app: <strong>Settings → Account → API tokens → Create</strong>. Give it a label
              and an expiry. The plaintext is shown <strong>once</strong> — copy it then; Motir keeps
              only a hash.
            </p>
            <p>
              A new token carries <strong>every scope except <code>work_items:delete</code></strong>,
              which is the single irreversible one and is opt-in. Which tools that buys you is the
              <a href="/docs/mcp/tools">tool catalogue</a>.
            </p>

            <h2><span class="stepnum">2</span> Point your client at the endpoint</h2>
            <p>
              Every client needs the same four facts. They are Motir's, they are the same for every
              agent, and everything below this table is one of them transcribed into a vendor's file
              format.
            </p>
            <table class="spec">
              <tbody>
                <tr><td><span class="nm">URL</span></td><td><code>https://app.motir.co/api/mcp</code></td></tr>
                <tr><td><span class="nm">Transport</span></td><td>Streamable HTTP — <strong>not</strong> SSE, and not a stdio command</td></tr>
                <tr><td><span class="nm">Header</span></td><td><code>Authorization: Bearer &lt;token&gt;</code>, on every request</td></tr>
                <tr><td><span class="nm">Token</span></td><td><code>motir_pat_&hellip;</code> — the one you minted in step 1</td></tr>
              </tbody>
            </table>

            <div class="callout">
              <span aria-hidden="true">◆</span>
              <span><strong>Don&rsquo;t paste the token into a file your repository tracks.</strong>
                Where your client can read it from somewhere else, the block below does that
                instead — VS&nbsp;Code prompts you for it, Cursor and Codex read an environment
                variable.</span>
            </div>

            <h3 class="client-h">Claude Code</h3>
            <div class="codeblock">
              <div class="cap">.mcp.json</div>
              <button class="copy" type="button">Copy</button>
              <pre>{
  "mcpServers": {
    "motir": {
      "type": "http",
      "url": "https://app.motir.co/api/mcp",
      "headers": { "Authorization": "Bearer motir_pat_&lt;your-token&gt;" }
    }
  }
}</pre>
            </div>
            <p class="clientmeta">Or one command:
              <code>claude mcp add --transport http motir https://app.motir.co/api/mcp --header "Authorization: Bearer motir_pat_&hellip;"</code>
              · <a href="#">Claude Code MCP docs</a> · format checked 2026-08-06</p>

            <h3 class="client-h">Cursor</h3>
            <div class="codeblock">
              <div class="cap">~/.cursor/mcp.json &nbsp;·&nbsp; or .cursor/mcp.json for one project</div>
              <button class="copy" type="button">Copy</button>
              <pre>{
  "mcpServers": {
    "motir": {
      "url": "https://app.motir.co/api/mcp",
      "headers": { "Authorization": "Bearer ${env:MOTIR_TOKEN}" }
    }
  }
}</pre>
            </div>
            <p class="clientmeta">Cursor interpolates <code>${env:&hellip;}</code>, so the token stays in
              your environment and out of the file. · <a href="#">Cursor MCP docs</a> · format checked 2026-08-06</p>

            <h3 class="client-h">VS Code</h3>
            <div class="codeblock">
              <div class="cap">.vscode/mcp.json</div>
              <button class="copy" type="button">Copy</button>
              <pre>{
  "inputs": [
    { "type": "promptString", "id": "motir-token", "description": "Motir PAT", "password": true }
  ],
  "servers": {
    "motir": {
      "type": "http",
      "url": "https://app.motir.co/api/mcp",
      "headers": { "Authorization": "Bearer ${input:motir-token}" }
    }
  }
}</pre>
            </div>
            <p class="clientmeta">VS&nbsp;Code prompts for the token the first time the server starts and
              stores it securely — nothing secret is written to the file. · <a href="#">VS Code MCP docs</a>
              · format checked 2026-08-06</p>

            <h3 class="client-h">Codex CLI</h3>
            <div class="codeblock">
              <div class="cap">~/.codex/config.toml</div>
              <button class="copy" type="button">Copy</button>
              <pre>[mcp_servers.motir]
url = "https://app.motir.co/api/mcp"
bearer_token_env_var = "MOTIR_TOKEN"</pre>
            </div>
            <p class="clientmeta"><code>bearer_token_env_var</code> takes the variable&rsquo;s <strong>name</strong>,
              not the token. · <a href="#">Codex MCP docs</a> · format checked 2026-08-06</p>

            <h3 class="client-h">Any other streamable-HTTP client</h3>
            <p>
              Windsurf, Zed, Cline, Goose, or something you wrote yourself — they all take the same
              four facts under different key names.
            </p>
            <div class="codeblock">
              <div class="cap">whatever your client calls its config</div>
              <pre>Transport:  streamable HTTP
URL:        https://app.motir.co/api/mcp
Header:     Authorization: Bearer motir_pat_&lt;your-token&gt;</pre>
            </div>

            <h2><span class="stepnum">3</span> Check it</h2>
            <p>
              Call <code>whoami</code>. It takes no arguments and answers with the user the token
              belongs to, the workspace it is bound to, and the scopes it was granted — so one call
              confirms all three at once.
            </p>
            <div class="codeblock">
              <div class="cap">tools/call · whoami</div>
              <pre>{
  "user": { "name": "Zhu Yue", "email": "you@example.com" },
  "workspace": { "name": "moooon", "slug": "moooon" },
  "scopes": ["read", "work_items:write", "work_items:archive",
             "sprints:write", "integration"]
}</pre>
            </div>
            <div class="callout callout--warn">
              <span aria-hidden="true">▲</span>
              <span>A <strong>401</strong> means the token is absent, malformed, unknown, revoked or
                expired — the five are deliberately not distinguished, so a caller cannot probe token
                state. Mint a fresh one and try again.</span>
            </div>

            <h2><span class="stepnum">4</span> Do one real thing</h2>
            <p>
              <code>list_projects</code> takes no arguments and gives you the
              <code>projectKey</code> every other tool wants. Then <code>next_ready</code> hands back
              the single item your agent should pick up — the whole point of the surface.
            </p>

            <h2>What next</h2>
            <p>
              <a href="/docs/mcp/tools">The tool catalogue</a> — all
              THIRTYNINE tools, what each does, and the scope that gates it.
              For a tool's exact arguments and response shape, the full reference is
              <a href="https://github.com/moooon-B-V/motir-core/blob/main/docs/mcp.md">docs/mcp.md</a>
              in the repository.
            </p>
          </main>'''.replace('THIRTYNINE', str(TOTAL))

# ── The catalogue page's main column (Q1's second-tier resource index) ──────
def tools_main(anchor_prefix=''):
    anchors = '\n'.join(
        f'                <a href="#{anchor_prefix}{s.replace(":","-")}">{e(SCOPE_LABEL[s])}</a>'
        for s in SCOPE_ORDER)
    return f'''          <main class="docs-main doc">
            <h1>MCP tools</h1>
            <p class="lede">
              Every tool the Motir MCP server exposes, and the scope that gates it. Grouped by
              scope, because that is the choice you make when you mint the token — leave a scope
              off and its whole group refuses.
            </p>
            <p class="mono-meta">{TOTAL} tools · 6 scopes · derived from the server's own scope map</p>

            <div class="anchorbar">
{anchors}
            </div>

            <div class="callout">
              <span aria-hidden="true">◆</span>
              <span>These are the <strong>summaries</strong>. For a tool's exact arguments and
                response shape, see
                <a href="https://github.com/moooon-B-V/motir-core/blob/main/docs/mcp.md">docs/mcp.md</a>
                — the reference is kept beside the code because those facts change most.</span>
            </div>

{cat_rows(GROUPS, anchor_prefix)}
          </main>'''

def stage(rail_html, main_html):
    return f'''      <div class="stage">
{TOPBAR}
        <div class="docs">
{rail_html}
{main_html}
        </div>
      </div>'''

PANEL1 = stage(rail('mcp'), WIRING_MAIN)
PANEL2 = stage(rail('tools'), tools_main())

# ── PANEL 3 — the catalogue at tablet: the rail collapses above the content ──
TABLET_GROUPS = '\n'.join(
    f'''            <section class="cat-group">
              <div class="cat-group-head">
                <h3>{e(SCOPE_LABEL[s])}</h3>
                <span class="scope-pill{' scope-pill--off' if s in DEFAULT_OFF else ''}">{e(s)}</span>
                <span class="cat-count">{len(ts)}</span>
              </div>
              <table class="spec cat-table"><tbody>''' +
    ''.join(f'<tr><td><code>{e(t["name"])}</code></td><td>{e(t["summary"])}</td></tr>' for t in ts) +
    '</tbody></table></section>'
    for s, ts in GROUPS)

PANEL3 = f'''      <div class="tablet">
        <div class="docs" style="flex-direction: column">
          <nav class="docs-nav" aria-label="Documentation" style="width: 100%; border-right: 0; border-bottom: 1px solid var(--el-border)">
            <div class="navgroup">
              <h3>MCP server</h3>
              <a class="navrow" href="/docs/mcp">Wiring an agent</a>
              <a class="navrow is-active" href="/docs/mcp/tools" aria-current="page">Tools</a>
            </div>
          </nav>
          <main class="docs-main doc">
            <h1>MCP tools</h1>
            <p class="lede">
              At the docs breakpoint the rail moves above the content and the table keeps both
              columns — a tool name and one line still fit, so nothing is dropped and nothing
              becomes a card yet.
            </p>
{TABLET_GROUPS}
          </main>
        </div>
      </div>'''

# ── PANEL 4 — the catalogue at 375: one card per row, the DocTable contract ──
PANEL4 = f'''      <div class="phone is-375">
        <div class="docs-main doc">
          <h1 style="font-size: 20px">MCP tools</h1>
          <p class="lede" style="font-size: 13.5px">
            Below the docs breakpoint every row becomes a card and each cell keeps its column name
            as its label — the treatment <code>DocBlocks</code>'s table already ships, applied here
            rather than invented.
          </p>
{cat_cards(GROUPS[:2])}
          <p class="anno anno-block">… the remaining four groups continue in the same form.</p>
        </div>
      </div>'''

# ── PANEL 5 — the derived catalogue yields nothing ──────────────────────────
PANEL5 = f'''      <div class="stage">
{TOPBAR}
        <div class="docs">
{rail('tools')}
          <main class="docs-main doc">
            <h1>MCP tools</h1>
            <div class="empty">
              <span class="glyph" aria-hidden="true">◇</span>
              <h2>The tool catalogue is unavailable</h2>
              <p>
                This page builds its list from the server's own scope map. If that read fails the
                page says so rather than showing an empty column — the rail, the wiring guide and
                every other address still work.
              </p>
              <p><a href="/docs/mcp">Back to wiring an agent</a> ·
                <a href="https://github.com/moooon-B-V/motir-core/blob/main/docs/mcp.md">Read docs/mcp.md</a></p>
            </div>
          </main>
        </div>
      </div>'''

# ── PANEL 6 — THE ACCESS PATH ①: the rail, BOTH tiers ───────────────────────
PANEL6 = f'''      <div class="row2">
        <div class="card">
          <div class="card-head"><h3>On any docs page</h3>
            <span class="hsub">tier 1 only</span></div>
          <div class="card-body">
{rail('none')}
            <p class="anno anno-block"><span class="marker">1</span>The MCP's row in the SURFACE tier. It is
              rendered on every page in the area, so a reader on the API reference or the sandbox
              guide is one click from here. This tier is <code>design/api-docs/</code>'s; this asset
              adds a row to it and redraws nothing.</p>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Inside <code>/docs/mcp/*</code></h3>
            <span class="hsub">tier 1 + tier 2</span></div>
          <div class="card-body">
{rail('tools')}
            <p class="anno anno-block"><span class="marker">2</span>The SECOND TIER appears — the sub-area's own
              pages, minus its index (which is the tier-1 row, so listing it twice would be two rows
              to one place). Gated on the route prefix, exactly as the API sub-area's is. The MCP is
              the second surface to have one, and the first drawn after the rail's own design.</p>
          </div>
        </div>
      </div>'''

# ── PANEL 7 — THE ACCESS PATH ②: the in-app door ────────────────────────────
PANEL7 = '''      <div class="doorframe">
        <div class="settings-head">
          <h2>API tokens</h2>
          <p>Personal access tokens let your coding agents talk to Motir over the MCP server.</p>
        </div>
        <div class="card" style="max-width: 720px">
          <div class="card-body">
            <div class="empty" style="padding: 40px 24px">
              <span class="glyph" aria-hidden="true">⬦</span>
              <h2>No tokens yet</h2>
              <p>Create one to connect a coding agent to this workspace.</p>
              <p>
                <a href="/docs/mcp"><span class="marker">3</span>Read the MCP setup guide</a>
              </p>
              <p><a class="btn btn-sm btn-primary" href="#">Create token</a></p>
            </div>
          </div>
        </div>
        <p class="anno anno-block">
          <span class="marker">3</span><strong>The door this story exists to close.</strong> Today
          <code>MCP_GUIDE_HREF</code> in <code>ApiTokensManager.tsx</code> is a
          <code>github.com/&hellip;/docs/mcp.md</code> blob, so a reader who has just minted their
          first token is sent out of the product to a raw file. It points at
          <code>/docs/mcp</code> — the WIRING page, not the catalogue: this reader has a credential
          and no client yet. Re-pointing it is MOTIR-2328's; this asset draws where it lands.
          Nothing else on the panel changes.
        </p>
      </div>'''

HEADER_COMMENT = f'''    <!--
      DESIGN ASSET (HTML mockup) — THE MCP SERVER DOCUMENTATION.
      Story MOTIR-2309 · Subtask MOTIR-2323. Routes: /docs/mcp and /docs/mcp/tools.

      A NEW surface, in its OWN design area, drawn to the route set ADR
      Amendment 12 (MOTIR-2321) fixed:

        Q1  /docs/mcp        the wiring page AND the sub-area's index
            /docs/mcp/tools  the tool catalogue, as this surface's SECOND-TIER
                             resource index — the first sub-area other than the
                             API reference to have one
        Q2  the catalogue's names, scopes and GROUPING derive from
            `lib/mcp/scopes.ts`; the one-line summaries are authored and pinned
            to the shipped `tools/list`
        Q3  the page owns the FIRST RUN; `docs/mcp.md` keeps the per-tool
            argument tables

      IT MOUNTS INTO the documentation shell Story 11.4 designed and shipped
      (`design/api-docs/`) and changes nothing about it except adding one row to
      the rail's SURFACE tier and one sub-area to its SECOND tier. That asset is
      not touched; the shell and rail markup reproduced here are 11.4's and
      MOTIR-2311's, drawn only as the frame this surface sits in.

      DRAWN AGAINST THE RUNNING APP, not from source. `/docs/api` and
      `/docs/sandbox` were rendered from a local dev server at 1440x900 and
      375x800 before this was drawn, so the shell, the two-tier rail, the top
      bar and the block rhythm here are what the app actually shows today —
      including the operation count, which reads 38 and not the "~28" the ADR
      recorded before Story 11.7 landed.

      THE CATALOGUE'S {TOTAL} ROWS ARE REAL. Names and scopes are generated from
      `lib/mcp/scopes.ts`'s TOOL_SCOPES by `design/mcp-server/build.py`, so the
      panel below is the true size, not an abbreviated five. See design-notes.md
      § "How this file was produced".

      Panels — review EACH (notes.html mistake #31):
        (1) /docs/mcp at 1180 px — the fork, then the wiring procedure.
        (2) /docs/mcp/tools at 1180 px — the catalogue at its real length.
        (3) The catalogue at the tablet width — rail above, table intact.
        (4) The catalogue at 375 px — one card per row.
        (5) The catalogue when the derivation yields nothing.
        (6) THE ACCESS PATH ① — the rail, both tiers, side by side.
        (7) THE ACCESS PATH ② — the in-app door in Settings → Account.

      Colour strictly via --el-*; shape strictly via element-semantic tokens; NO
      invented colour. The token block below is copied 1:1 from
      `design/agent-sandbox/agent-sandbox.mock.html` (which took it from
      `design/api-docs/`, which took it from app/globals.css), so this surface
      cannot drift from the one it mounts in. See design-notes.md for the spec.
    -->'''

def label(n, title, note):
    return (f'    <div class="panel-label">{n} · {title}'
            f'<span class="note">{note}</span></div>\n')

doc = f'''<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Design mock · The MCP server documentation (MOTIR-2309 · MOTIR-2323)</title>
{HEADER_COMMENT}
{STYLE}
{EXTRA_CSS}
  </head>
  <body>
    <div class="review-head">
      <h1>The MCP server documentation</h1>
      <p>
        MOTIR-2309 · MOTIR-2323 · <code>/docs/mcp</code> and <code>/docs/mcp/tools</code> ·
        drawn to ADR Amendment 12. Seven panels; the catalogue's {TOTAL} rows are generated from
        <code>lib/mcp/scopes.ts</code>.
      </p>
    </div>

{label(1, '/docs/mcp — the wiring page', 'the sub-area index · 1180 px')}
    <div class="panel">
{PANEL1}
    </div>

{label(2, '/docs/mcp/tools — the catalogue', f'the second-tier resource index · all {TOTAL} tools · 1180 px')}
    <div class="panel">
{PANEL2}
    </div>

{label(3, 'The catalogue at the tablet width', 'the rail moves above the content; the table keeps both columns')}
    <div class="panel">
{PANEL3}
    </div>

{label(4, 'The catalogue at 375 px', 'one card per row — DocBlocks&rsquo; own narrow treatment')}
    <div class="panel">
{PANEL4}
    </div>

{label(5, 'The catalogue when the derivation yields nothing', 'the state a derived page owes')}
    <div class="panel">
{PANEL5}
    </div>

{label(6, 'THE ACCESS PATH ① — the rail, both tiers', 'tier 1 everywhere; tier 2 only inside the sub-area')}
    <div class="panel">
{PANEL6}
    </div>

{label(7, 'THE ACCESS PATH ② — the in-app door', 'Settings &rarr; Account &rarr; API tokens, empty state')}
    <div class="panel">
{PANEL7}
    </div>
  </body>
</html>
'''
open(OUT, 'w').write(doc)
print('written', len(doc), 'chars ·', TOTAL, 'tools')
