import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

// The per-agent PROFILE TABLE — what the BYOK preflight knows about the coding
// agents Motir supports first-class: the binary a profile runs, where that
// agent's CLI is installed FROM (so a missing binary can name its install
// source), and WHERE the agent keeps its own credential (so `motir doctor` can
// assert the credential is PRESENT without ever reading it).
//
// `sandbox/README.md`'s profile matrix is the VERIFIED SOURCE for both columns
// this table restates — the binary each agent installs as, and where that agent
// keeps its credential. Every value here was re-checked against that matrix (and
// against `sandbox/install-agent.sh`, which does the installing);
// `test/sandbox.test.ts` pins the two together so they cannot drift apart again.
// A profile whose credential the matrix does not pin is left UNKNOWN rather than
// guessed, because an unverified path would make `doctor` FAIL a correctly-
// configured machine. (Same reason 7.9.7b treats the agents' auto-approve flags
// as verify-at-build rather than asserted-from-memory.)
//
// The matrix pins a MOUNT, which is not always proof of AUTH — the two diverge
// wherever the mounted location also exists on a machine that never signed in.
// Where they diverge the profile tests the narrower thing — the credential FILE
// inside the mounted dir (`claude`'s `.credentials.json`, `codex`'s `auth.json`,
// opencode's `auth.json` under the DATA home) — or declines to test a path at
// all where the mounted dir is also the install tree (`cursor`; `kimi`, whose
// own binary lives in it), with the reason written beside the entry.
// **A false PASS is worse than a false FAIL**: it tells the user their
// unattended run is ready when it will stop at a sign-in prompt. A DIRECTORY is
// never proof of a sign-in (MOTIR-4957) — every path here is a file.
//
// `binaries` is a LOOKUP KEY LIST, not a claim: the binary actually probed always
// comes from the user's own agent command (`--agent` / `MOTIR_AGENT` / config),
// and a name that matches nothing here simply falls through to the tier-3
// generic path. Motir is agent-agnostic — an unlisted agent is supported, just
// not enriched with a remediation hint.

/**
 * The env vars an agent uses to RELOCATE its whole config home, credential
 * included. A closed union rather than an open string: the probe hands back the
 * VALUE of these (a directory path, never a credential), so the set of names it
 * will answer for is pinned here where it can be read in one glance.
 *
 * Both were verified against the shipped CLIs rather than their docs — `claude`
 * 2.1.267 and `codex` 0.153.4 each carry the name in their own binary, and
 * `sandbox/agent-config.sh` exports both because the sandbox redirects each
 * agent out of its read-only mount.
 */
export const AGENT_CONFIG_HOME_VARS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;

export type AgentConfigHomeVar = (typeof AGENT_CONFIG_HOME_VARS)[number];

/**
 * The directories a credential path is resolved against. Passed as one object
 * so a profile names the dir it means (`xdgDataHome`) instead of depending on
 * argument order — the shape the opencode entry got wrong when the data dir and
 * the config dir were conflated.
 */
export interface CredentialDirs {
  /** The user's home directory. */
  home: string;
  /** `XDG_CONFIG_HOME`, or `~/.config`. Configuration — not always credentials. */
  xdgConfigHome: string;
  /** `XDG_DATA_HOME`, or `~/.local/share`. Where opencode + cursor keep auth. */
  xdgDataHome: string;
  /**
   * The VALUE of an agent's own config-home override, or `undefined` when the
   * environment does not set it. A DIRECTORY, never a credential — the same
   * carve-out `agentEnvOverride` has (see doctor.ts's structural note).
   *
   * A profile that ignores this looks in the wrong place inside the sandbox,
   * where `agent-config.sh` redirects the agent to an image-owned home so the
   * read-only mount can be seeded and written to.
   */
  configHome: (name: AgentConfigHomeVar) => string | undefined;
}

export interface AgentProfile {
  /** Profile id — also the sandbox `AGENT=` selector and the docs' name for it. */
  id: string;
  /** Human label used in report lines. */
  label: string;
  /** 1 = pinned by the sandbox matrix; 2 = also-supported. */
  tier: 1 | 2;
  /**
   * Every binary name this profile is matched by, canonical one FIRST. A list
   * rather than a single name because an agent's own installer can link several
   * (Cursor links both `agent` and `cursor-agent`), and because a user may have
   * aliased the profile id — matching only one name silently drops such a user
   * onto the tier-3 generic path, with no remediation hint.
   */
  binaries: readonly string[];
  /** Where the agent's own CLI comes from (the missing-binary remediation). */
  installSource: string;
  /**
   * Credential locations to test for PRESENCE — always the credential FILE
   * itself, never the directory that holds it.
   *
   * ⚠️ A DIRECTORY IS NEVER A CREDENTIAL (MOTIR-4957). An agent's config dir
   * appears the first time anybody LAUNCHES it, sign-in or not, so probing one
   * is a check that cannot fail: `~/.kimi-code` is created by the installer (it
   * is where the `kimi` binary lands), and inside the sandbox `~/.claude` is the
   * read-only mount itself. Where the credential file cannot be VERIFIED
   * against the shipped CLI, this is `[]` and the profile declares
   * `credentialKnown: false` — an honest WARN beats a PASS nobody can earn.
   */
  credentialPaths: (dirs: CredentialDirs) => string[];
  /**
   * The host paths `sandbox/docker-compose.yml` binds READ-ONLY into the
   * container for this profile, `~`-relative and in mount order. `[]` when the
   * profile mounts nothing at all.
   *
   * ⚠️ NOT `credentialPaths`, and the two are answers to different questions.
   * `credentialPaths` is what `motir doctor` PROBES to prove a sign-in
   * happened, deliberately narrowed wherever a mounted location is not proof of
   * auth (see the header note). This is what the image BINDS. They diverge on
   * SEVEN of the eight profiles, and `antigravity` agrees only because both are
   * empty: `cursor`, `aider`, `goose` and `kimi` probe nothing at all while the
   * compose file mounts a path for each, and `claude`, `codex` and `opencode`
   * each probe one credential FILE inside a mounted directory. Anything PUBLISHING the mount — the
   * `/docs/sandbox` guide derives its table from here — must read this field;
   * deriving it from `credentialPaths` would tell three profiles they need no
   * mount. `test/sandbox.test.ts` pins every value against the compose file.
   */
  sandboxMounts: readonly string[];
  /**
   * Env vars whose PRESENCE also satisfies the credential check. Only ever
   * passed to a presence predicate — the VALUE is never read (see doctor.ts).
   */
  credentialEnv: string[];
  /**
   * False when this profile has nowhere it can honestly look — no pinned path
   * and no env var. It is NOT "the matrix has no row": a matrix mount that
   * proves installation rather than authentication buys nothing.
   */
  credentialKnown: boolean;
  /** How the user provides the credential (the missing-credential remediation). */
  credentialHint: string;
  /**
   * The `codegraph install --target <id>` id that wires the code-graph MCP
   * server for this agent, or null when codegraph has no target for it
   * (7.9.7d). Read off `codegraph install --print-config` against the version
   * the sandbox ships — never assumed: the known set is
   * `claude, cursor, codex, opencode, hermes, gemini, antigravity, kiro`, which
   * covers five of the eight profiles here. A profile with no target is left
   * null rather than pointed at a near-miss id, for the same reason
   * `credentialKnown` is left false: a wrong id would claim a wiring the image
   * does not have.
   */
  codegraphTarget: string | null;
  /**
   * Where that wiring LANDS inside the sandbox image, and how it is kept clear
   * of the profile's own read-only credential mount (7.9.7f). null when the
   * profile has no codegraph target at all.
   */
  codegraphConfig: CodegraphConfigPlacement | null;
  /**
   * The vendor's documented UNATTENDED invocation — what `motir run` launches
   * inside one of the developer's own agents (MOTIR-7024,
   * `docs/decisions/agent-instance-run.md` §3). `null` where the vendor offers
   * none Motir will drive, which refuses the run as `agent_profile_cannot_run`
   * before anything starts. Each value cites the vendor page it was read from
   * (on 2026-09-30); `sandbox/README.md`'s _Auto-approve flags_ is the matrix
   * it restates, and `<agent> --help` in the built image is the final word.
   */
  agentCommand: string | null;
  /**
   * How the prompt reaches {@link AgentProfile.agentCommand}: piped on STDIN,
   * or as its last ARGUMENT. `null` exactly when `agentCommand` is.
   */
  agentPrompt: 'stdin' | 'argument' | null;
  /**
   * Env vars the unattended form needs ADDED to the session's own environment
   * (goose's approval mode is a variable, not a flag). Never a credential, and
   * never anything that narrows or replaces the agent's own sign-in.
   */
  agentEnv: Readonly<Record<string, string>>;
  /**
   * The profile's STREAMING form (MOTIR-8980) — the same agent, launched in the
   * structured headless mode it has, so a run's output reaches Motir while the agent
   * works instead of in one piece when it exits. `null` where the agent has none
   * (`aider`'s `--message` prints plain text) or no unattended form at all; those keep
   * {@link AgentProfile.agentCommand} as it is.
   *
   * ⚠️ THE FLAGS ARE THE CHAT TAB'S, NOT A SECOND LIST. `docs/decisions/agent-chat.md`
   * Q1/Q3 settled each profile's headless stream, its session id and its resume form,
   * and `agentTerminal/chat/adapters/*` parse that stream. A run reads the stream with
   * the SAME adapter's mapper, so a flag changed on one side and not the other makes
   * the parser read a stream it was not written for.
   * `test/agentStreamForm.test.ts` pins the shared tokens against the adapters'
   * own `turnCommand`.
   */
  agentStream: AgentStreamForm | null;
}

/** How a profile is launched when its output is to be STREAMED (MOTIR-8980). */
export interface AgentStreamForm {
  /** The arguments after the binary for a fresh run (the prompt rides {@link prompt}). */
  args: readonly string[];
  /** How the prompt reaches it — on stdin, or as the last argument. */
  prompt: 'stdin' | 'argument';
  /**
   * The flag that lets Motir CHOOSE the agent's session id (`claude --session-id`), or
   * null when the agent picks its own and announces it in the stream.
   */
  sessionIdFlag: string | null;
  /**
   * The arguments after the binary that CONTINUE session `sessionId` — the agent's own
   * conversation, with its context, rather than a cold start on a new prompt. Not yet
   * called by a run (the follow-up story, MOTIR-8981, resumes a red pull request's
   * agent); it is here so the resume form lives beside the stream form it must match.
   */
  resumeArgs: (sessionId: string) => string[];
}

/**
 * The image-owned config home the sandbox redirects a SHADOWED agent to —
 * `<home>/.motir-sandbox/agent-config`. It is deliberately OUTSIDE every
 * credential mount (all of which are `~/.<agent>`-shaped or XDG paths), so a
 * config file written here can never be masked by a `:ro` bind mount.
 *
 * `sandbox/install-agent.sh` and `sandbox/entrypoint.sh` carry the same literal
 * path; `test/sandbox.test.ts` pins the three together.
 */
export const sandboxAgentConfigHome = (home: string): string =>
  join(home, '.motir-sandbox', 'agent-config');

/**
 * Where a profile's codegraph MCP wiring is written, split by the ROLE each
 * file plays — because the two roles fail differently when a read-only mount
 * shadows them. Every path below was read off the REAL `codegraph install`
 * (v1.5.0) writing into a scratch HOME, not off its documentation.
 */
export interface CodegraphConfigPlacement {
  /**
   * The file the agent reads the codegraph MCP SERVER from. Shadowing THIS is
   * the total failure: the agent has no code-graph tools at all. It must never
   * resolve inside one of the profile's read-only mounts.
   */
  mcpServers: (dirs: CredentialDirs) => string;
  /**
   * The separate file holding the auto-allow permission list `--yes` writes,
   * for an agent that keeps it apart from the server list. null when the server
   * file carries the permissions too (codex's `config.toml`, opencode's
   * `opencode.jsonc`) — verified, not assumed.
   */
  autoAllow: ((dirs: CredentialDirs) => string) | null;
  /**
   * The env var the sandbox EXPORTS so the agent reads `mcpServers` from the
   * image-owned home instead of its default location, with the reason. null
   * when the default is already clear of every mount this profile takes.
   */
  redirect: { env: string; why: string } | null;
  /**
   * Set ONLY when `autoAllow` still resolves inside a read-only mount: the
   * declared, NARROWER gap — the agent HAS the tools but its auto-allow list is
   * the host's, so an unattended run stops to ask before calling them. Carries
   * the tracking reference so the condition is visible rather than silent.
   */
  knownAutoAllowGap: string | null;
}

/**
 * Tier-1: the four profiles the sandbox matrix makes first-class. Tier-2:
 * also-supported agents. Every `binaries` and `credentialPaths` value below is
 * the sandbox matrix's, narrowed only where a mount is not proof of auth.
 */
export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    tier: 1,
    binaries: ['claude'],
    installSource: 'npm install -g @anthropic-ai/claude-code',
    // The CREDENTIAL is `.credentials.json` inside the config dir, not the dir
    // itself — verified against claude 2.1.267, whose binary carries both this
    // filename and `CLAUDE_CONFIG_DIR`, and named first in `agent-config.sh`'s
    // CLAUDE_SEED_ENTRIES because it is the file the sandbox seeding exists to
    // carry. `CLAUDE_CONFIG_DIR` moves the whole dir, credential included, so
    // the probe follows it or it looks in the mount the sandbox redirected away
    // from.
    credentialPaths: ({ home, configHome }) => [
      join(configHome('CLAUDE_CONFIG_DIR') ?? join(home, '.claude'), '.credentials.json'),
    ],
    sandboxMounts: ['~/.claude'],
    credentialEnv: ['ANTHROPIC_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Run `claude` once to sign in, or set ANTHROPIC_API_KEY.',
    // https://code.claude.com/docs/en/cli-reference — `-p, --print`: "Print
    // response without interactive mode" (piped stdin is the prompt:
    // `cat file | claude -p`); `--dangerously-skip-permissions`: "Skip permission
    // prompts. Equivalent to `--permission-mode bypassPermissions`".
    agentCommand: 'claude -p --dangerously-skip-permissions',
    agentPrompt: 'stdin',
    agentEnv: {},
    // `--output-format stream-json` needs `--verbose` under `-p`: https://code.claude.com/docs/en/headless.
    // Without it `-p` prints nothing until the turn ends. `--session-id` is Motir's to choose.
    agentStream: {
      args: ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
      prompt: 'stdin',
      sessionIdFlag: '--session-id',
      resumeArgs: (id) => [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--resume',
        id,
      ],
    },
    codegraphTarget: 'claude',
    codegraphConfig: {
      // Claude Code reads its MCP servers from <CLAUDE_CONFIG_DIR>/.claude.json
      // — by default ~/.claude/.claude.json, INSIDE the `:ro` mount. (The
      // ~/.claude.json codegraph writes is a legacy path the shipped 2.x CLI no
      // longer reads at all — verified, which is why this profile had no tools
      // rather than merely no permission list.) The entrypoint redirects
      // CLAUDE_CONFIG_DIR to the image-owned home, seeds it from the mount and
      // merges codegraph's stanza into the copy.
      mcpServers: ({ home }) => join(sandboxAgentConfigHome(home), '.claude', '.claude.json'),
      // The auto-allow list is a SEPARATE file from the server list here, and
      // it moves with the same redirect.
      autoAllow: ({ home }) => join(sandboxAgentConfigHome(home), '.claude', 'settings.json'),
      redirect: {
        env: 'CLAUDE_CONFIG_DIR',
        why: 'CLAUDE_CONFIG_DIR governs the state file, settings.json, CLAUDE.md AND .credentials.json, so the redirected dir is seeded from the read-only mount before codegraph merges into it.',
      },
      knownAutoAllowGap: null,
    },
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    tier: 1,
    binaries: ['codex'],
    installSource: 'npm install -g @openai/codex',
    // `auth.json` under CODEX_HOME — VERIFIED against the shipped codex 0.153.4
    // binary, which carries the filename beside its own sign-in and logout
    // copy ("It will be stored locally in auth.json", "Failed to remove
    // auth.json") as well as `CODEX_HOME`. `install-agent.sh` and
    // `agent-config.sh` both state the same pairing; this comment records that
    // the CLI itself was read, not only our own notes about it.
    credentialPaths: ({ home, configHome }) => [
      join(configHome('CODEX_HOME') ?? join(home, '.codex'), 'auth.json'),
    ],
    sandboxMounts: ['~/.codex'],
    credentialEnv: ['OPENAI_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Run `codex` once to sign in, or set OPENAI_API_KEY.',
    // https://developers.openai.com/codex/cli/reference (now served at
    // https://learn.chatgpt.com/docs/developer-commands?surface=cli) — `codex
    // exec`: "Use `-` to pipe the prompt from stdin"; `--sandbox, -s`:
    // `read-only | workspace-write | danger-full-access`. ⚠️ DIFFERS FROM THE
    // DECISION'S `--sandbox workspace-write --ask-for-approval never`, as §3
    // allows: `--ask-for-approval` is a GLOBAL flag that `codex exec` does not
    // accept (the reference's exec table omits it, and exec never asks), and
    // `workspace-write` runs with NO network by default, so the run could never
    // push or open its pull request. The agent's own machine is the boundary —
    // the same stance as `claude --dangerously-skip-permissions`.
    agentCommand: 'codex exec --sandbox danger-full-access -',
    agentPrompt: 'stdin',
    agentEnv: {},
    // https://developers.openai.com/codex/noninteractive — `--json` makes stdout a JSONL
    // stream; the thread id arrives in its `thread.started` event. `exec resume` takes
    // the sandbox as a `-c` override (the chat's own resume does the same).
    agentStream: {
      args: ['exec', '--json', '--sandbox', 'danger-full-access', '-'],
      prompt: 'stdin',
      sessionIdFlag: null,
      resumeArgs: (id) => [
        'exec',
        'resume',
        '--json',
        '-c',
        'sandbox_mode="danger-full-access"',
        id,
        '-',
      ],
    },
    codegraphTarget: 'codex',
    codegraphConfig: {
      // codegraph's default target is ~/.codex/config.toml — INSIDE the `:ro`
      // mount, so the host copy shadowed it and the agent saw no tools at all.
      // The entrypoint redirects CODEX_HOME to the image-owned home, seeds it
      // from the mount and lets codegraph merge its stanza into the copy.
      mcpServers: ({ home }) => join(sandboxAgentConfigHome(home), '.codex', 'config.toml'),
      // config.toml carries the server AND its trust/approval settings.
      autoAllow: null,
      redirect: {
        env: 'CODEX_HOME',
        why: 'CODEX_HOME governs config.toml AND auth.json, so the redirected home is seeded from the read-only mount before codegraph merges into it.',
      },
      knownAutoAllowGap: null,
    },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    tier: 1,
    binaries: ['opencode'],
    installSource: 'npm, or the OpenCode install script (opencode.ai)',
    // OpenCode SPLITS the two: `~/.config/opencode` holds configuration, while
    // the credential is `auth.json` under the XDG DATA home — which is why the
    // sandbox mounts both dirs. Testing the config dir passed on any machine
    // that had ever run opencode, signed in or not; the check is the auth FILE.
    credentialPaths: ({ xdgDataHome }) => [join(xdgDataHome, 'opencode', 'auth.json')],
    sandboxMounts: ['~/.config/opencode', '~/.local/share/opencode'],
    credentialEnv: [],
    credentialKnown: true,
    credentialHint: 'Run `opencode auth login` to sign in — it writes auth.json.',
    // https://opencode.ai/docs/cli/ — `opencode run [message..]`; `--auto`:
    // "Auto-approve permissions that are not explicitly denied". OpenCode appends
    // a piped stdin to its message, so the prompt goes on argv only.
    agentCommand: 'opencode run --auto',
    agentPrompt: 'argument',
    agentEnv: {},
    // https://opencode.ai/docs/cli/ — `--format json` is "raw JSON events"; `--session`
    // "Session ID to continue". The session id is the `sessionID` on each event.
    agentStream: {
      args: ['run', '--format', 'json', '--auto'],
      prompt: 'argument',
      sessionIdFlag: null,
      resumeArgs: (id) => ['run', '--format', 'json', '--auto', '--session', id],
    },
    codegraphTarget: 'opencode',
    codegraphConfig: {
      // codegraph's default target is ~/.config/opencode/opencode.jsonc —
      // INSIDE the `:ro` config mount. OPENCODE_CONFIG is MERGED on top of the
      // global config rather than replacing it (verified), so pointing it at the
      // image-owned copy adds the codegraph stanza while the host's own config
      // keeps applying, and the credential (XDG data dir) is untouched.
      mcpServers: ({ home }) =>
        join(sandboxAgentConfigHome(home), '.config', 'opencode', 'opencode.jsonc'),
      autoAllow: null,
      redirect: {
        env: 'OPENCODE_CONFIG',
        why: 'OPENCODE_CONFIG merges over the global config, so no credential is copied and the host config still applies.',
      },
      knownAutoAllowGap: null,
    },
  },
  {
    id: 'kimi',
    label: 'Kimi Code CLI',
    tier: 1,
    binaries: ['kimi'],
    installSource: 'npm (@moonshot-ai/kimi-code) — needs Node ≥ 22.19',
    // UNKNOWN on purpose, and the reading is what makes it unknown rather than
    // unexamined. kimi 0.41.0 resolves its credential as
    // `<config home>/credentials/<PROFILE>.json` — its own error text says so:
    // "requires authentication.credentials_path (or load via a profile so it
    // defaults to <config_dir>/credentials/<profile>.json)". So the FILENAME is
    // the active profile's, and `authentication.credentials_path` in config.toml
    // can move it anywhere; there is no fixed path to probe. Probing the
    // DIRECTORY is worse here than anywhere else: `~/.kimi-code/bin/kimi` is
    // where the installer puts the binary, so the dir exists before anyone has
    // signed in at all.
    credentialPaths: () => [],
    sandboxMounts: ['~/.kimi-code'],
    credentialEnv: [],
    credentialKnown: false,
    // https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html —
    // `-p, --prompt` runs one prompt non-interactively and exits; it "cannot be
    // used with --yolo … non-interactive mode uses auto permission by default".
    agentCommand: 'kimi -p',
    agentPrompt: 'argument',
    agentEnv: {},
    // https://moonshotai.github.io/kimi-code/en/reference/kimi-command.html — `-p` takes
    // the prompt as its value, so it stays LAST; `--session` resumes, and the id is the
    // stream's closing `session.resume_hint`.
    agentStream: {
      args: ['--output-format', 'stream-json', '-p'],
      prompt: 'argument',
      sessionIdFlag: null,
      resumeArgs: (id) => ['--output-format', 'stream-json', '--session', id, '-p'],
    },
    credentialHint:
      'Run `kimi` once to sign in — it writes <KIMI_CODE_HOME or ~/.kimi-code>/credentials/<profile>.json, whose name follows the active profile, so Motir cannot confirm it.',
    codegraphTarget: null,
    codegraphConfig: null,
  },
  {
    id: 'antigravity',
    label: 'Antigravity CLI',
    tier: 2,
    // The installer links `agy`, not `antigravity`; the profile id is kept as a
    // tolerated alias for anyone who aliased it that way.
    binaries: ['agy', 'antigravity'],
    installSource: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    // `agy` keeps its token in the OS KEYRING, with no documented portable
    // file — the one profile with genuinely nowhere to look (the sandbox
    // mounts no credential for it either).
    credentialPaths: () => [],
    sandboxMounts: [],
    credentialEnv: [],
    credentialKnown: false,
    credentialHint: 'Sign in with `agy` (its token lives in the OS keyring, not a file).',
    // Not offered for an agent (`agent-instances.md` §9), so no run is driven.
    agentCommand: null,
    agentPrompt: null,
    agentEnv: {},
    agentStream: null,
    codegraphTarget: 'antigravity',
    codegraphConfig: {
      // This profile mounts NO credential directory at all, so nothing can
      // shadow the wiring.
      mcpServers: ({ home }) => join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      autoAllow: null,
      redirect: null,
      knownAutoAllowGap: null,
    },
  },
  {
    id: 'cursor',
    label: 'Cursor CLI',
    tier: 2,
    // The installer symlinks the executable as `agent`, keeping `cursor-agent`
    // as the legacy alias — `cursor` is neither, and matched nothing until the
    // list arrived. It stays last so a user who aliased it keeps a profile.
    binaries: ['agent', 'cursor-agent', 'cursor'],
    installSource: 'curl https://cursor.com/install -fsS | bash',
    // The matrix's `~/.local/share/cursor-agent` mount is also where the
    // installer unpacks the CLI itself, so its presence proves an INSTALL, not
    // a sign-in. The API key is the one unambiguous signal, so it is the only
    // one tested.
    credentialPaths: () => [],
    sandboxMounts: ['~/.local/share/cursor-agent'],
    credentialEnv: ['CURSOR_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Run `cursor-agent login` to sign in, or set CURSOR_API_KEY.',
    // Not offered for an agent (`agent-instances.md` §9), so no run is driven.
    agentCommand: null,
    agentPrompt: null,
    agentEnv: {},
    agentStream: null,
    codegraphTarget: 'cursor',
    codegraphConfig: {
      // Cursor's credential mount is ~/.local/share/cursor-agent, which does not
      // contain ~/.cursor — the wiring is clear of it without a redirect.
      mcpServers: ({ home }) => join(home, '.cursor', 'mcp.json'),
      autoAllow: null,
      redirect: null,
      knownAutoAllowGap: null,
    },
  },
  {
    id: 'aider',
    label: 'Aider',
    tier: 2,
    binaries: ['aider'],
    installSource: 'pip (Python) — PyPI `aider-chat`',
    // Aider's credential IS the model key it reads from the environment. Its
    // `~/.aider.conf.yml` is configuration, and the sandbox asks the user to
    // create it (even empty) so docker can bind it — so its presence would
    // prove nothing at all.
    credentialPaths: () => [],
    sandboxMounts: ['~/.aider.conf.yml'],
    credentialEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    credentialKnown: true,
    credentialHint: 'Give Aider a model key: set ANTHROPIC_API_KEY or OPENAI_API_KEY.',
    // https://aider.chat/docs/config/options.html — `--message`/`-m`: "Specify a
    // single message to send the LLM, process reply then exit"; `--yes-always`:
    // "Always say yes to every confirmation".
    agentCommand: 'aider --yes-always --message',
    agentPrompt: 'argument',
    agentEnv: {},
    agentStream: null,
    codegraphTarget: null,
    codegraphConfig: null,
  },
  {
    id: 'goose',
    label: 'Goose',
    tier: 2,
    binaries: ['goose'],
    installSource: 'the Goose installer (Block)',
    // Goose stores provider secrets in the OS KEYRING by default and only falls
    // back to a file under `~/.config/goose` when the keyring is disabled (as
    // the sandbox does). Neither state is testable from outside: an existing
    // config dir need not hold a key, and a keyring-backed key leaves no file.
    credentialPaths: () => [],
    sandboxMounts: ['~/.config/goose'],
    credentialEnv: [],
    credentialKnown: false,
    credentialHint: 'Run `goose configure` to store a provider key.',
    // https://goose-docs.ai/docs/guides/goose-cli-commands — `goose run`
    // `-t, --text`: "Input text to provide to goose directly"; `--no-session`:
    // "Run goose commands without creating or storing a session file". Approval
    // is the `GOOSE_MODE` VARIABLE (`auto | approve | chat | smart_approve`,
    // https://goose-docs.ai/docs/guides/environment-variables), set explicitly so
    // a developer's own `approve` default cannot stop an unattended run.
    agentCommand: 'goose run --no-session -t',
    agentPrompt: 'argument',
    agentEnv: { GOOSE_MODE: 'auto' },
    // https://goose-docs.ai/docs/guides/goose-cli-commands — `--output-format stream-json`
    // is "events as they occur". No `--no-session`: a run that keeps no session cannot be
    // resumed. The prompt goes on stdin (`-i -`).
    agentStream: {
      args: ['run', '-q', '--output-format', 'stream-json', '-i', '-'],
      prompt: 'stdin',
      sessionIdFlag: null,
      resumeArgs: (id) => [
        'run',
        '-q',
        '--output-format',
        'stream-json',
        '-i',
        '-',
        '--resume',
        '--session-id',
        id,
      ],
    },
    codegraphTarget: null,
    codegraphConfig: null,
  },
];

/** The parsed form of an agent command string: the binary plus its flags. */
export interface ParsedAgentCommand {
  /** The command as given (binary + flags). */
  command: string;
  /** The executable to look for on PATH — the first whitespace-separated token. */
  binary: string;
  /** The remaining tokens (e.g. `--dangerously-skip-permissions`). */
  args: string[];
  /**
   * A BUILT-IN launcher's own environment (the hosted OpenCode launcher,
   * MOTIR-6559). When set it REPLACES the inherited environment instead of
   * extending it — which is the whole point: an ALLOW-LISTED environment keeps
   * the run credential out of the agent. A command the user typed never has one.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * The prompt as ARGUMENTS, for an agent that takes its message on argv
   * (`opencode run <message>`). Called with the prompt and the path it was
   * written to, so a long prompt can be attached as a file instead.
   */
  promptArgs?: (prompt: string, promptFile: string) => string[];
  /**
   * `false` leaves the agent's stdin unconnected. An agent that APPENDS a piped
   * stdin to its argv message would otherwise receive the prompt twice.
   */
  promptOnStdin?: boolean;
  /**
   * Text appended to the server's prompt before it is delivered, on EVERY
   * channel (stdin, the prompt file, and `promptArgs`' prompt). An agent-mode
   * run's git instructions (MOTIR-7024); the server's prompt stays verbatim
   * above it.
   */
  promptAddendum?: () => string;
  /**
   * Set when the agent is launched in its STREAMING form (MOTIR-8980): its stdout is a
   * structured event stream, which `runAgent` reads with this profile's chat adapter and
   * writes out as readable lines. Absent for a command the user typed and for a profile
   * with no stream.
   */
  stream?: {
    /** The profile whose adapter reads the stream. */
    profile: string;
    /** The session id known BEFORE the spawn — Motir chose it, or it is being resumed. */
    sessionId: string | null;
  };
}

/**
 * Split an agent command (`claude --dangerously-skip-permissions`) into the
 * binary to probe and its flags. The tier-3 escape hatch passes a full command,
 * so the binary is always the FIRST token — never the whole string.
 * Returns null for an empty/blank command.
 */
export function parseAgentCommand(command: string | undefined): ParsedAgentCommand | null {
  const trimmed = (command ?? '').trim();
  if (!trimmed) return null;
  // Split at the FIRST whitespace rather than destructuring the split array:
  // the binary is then a string by construction, with no unreachable
  // "empty first token" branch to carry.
  const boundary = trimmed.search(/\s/);
  if (boundary === -1) return { command: trimmed, binary: trimmed, args: [] };
  return {
    command: trimmed,
    binary: trimmed.slice(0, boundary),
    args: trimmed
      .slice(boundary + 1)
      .trim()
      .split(/\s+/),
  };
}

/**
 * Find the profile for a binary, matching ANY of its names (`agent` resolves
 * Cursor just as `cursor-agent` does). Matches on the basename (so an absolute
 * path like `/usr/local/bin/claude` still resolves), case-insensitively,
 * ignoring a Windows `.exe`/`.cmd` suffix. An unmatched binary is the tier-3
 * case → null.
 */
export function findAgentProfile(binary: string): AgentProfile | null {
  return AGENT_PROFILES.find((p) => p.binaries.includes(binaryName(binary))) ?? null;
}

/** A binary as a profile lookup key: basename, lowercased, no Windows suffix. */
function binaryName(binary: string): string {
  return basename(binary)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/**
 * The HARNESS that an agent command runs — the value recorded as
 * `implementationHarness` on every item a run integrates (MOTIR-2419).
 *
 * Derived from the command the loop LAUNCHED, which is the half of the
 * provenance triple the loop is the only actor able to answer: it cannot be
 * misreported, and it needs no cooperation from the agent. (The other half —
 * the model — only the agent knows, so it arrives by self-report or not at
 * all.)
 *
 * A recognised binary reports its PROFILE ID, so `cursor-agent` and `agent`
 * both record `cursor` and the same agent is one value in the data rather than
 * two. An unrecognised one reports its own normalised name: Motir is
 * agent-agnostic, and `my-agent` is a truthful answer where a fallback to
 * something generic would put every tier-3 run back where this bug started.
 */
export function deriveAgentHarness(binary: string): string {
  return findAgentProfile(binary)?.id ?? binaryName(binary);
}

/** Every profile id, for help text / docs (`claude, codex, …`). */
export function agentProfileIds(): string[] {
  return AGENT_PROFILES.map((p) => p.id);
}

/**
 * The profiles whose agent the sandbox image wires the code-graph MCP server
 * into at build time (7.9.7d) — i.e. those codegraph has an install target for.
 * The sandbox suite drives its per-profile guards off this, so a profile that
 * gains (or loses) a codegraph target cannot leave the image's install seam
 * behind.
 */
export function codegraphWiredProfiles(): { id: string; target: string }[] {
  return AGENT_PROFILES.filter(
    (p): p is AgentProfile & { codegraphTarget: string } => p.codegraphTarget !== null,
  ).map((p) => ({ id: p.id, target: p.codegraphTarget }));
}

// ── The unattended agent command (MOTIR-7024) ──────────────────────────────

/**
 * The Motir and GitHub credentials an agent-mode run never hands its coding
 * agent (`agent-instance-run.md` §2): the CLI's own token, the run token, a git
 * token, and the hosted run's gateway pair. Removed from the agent's copy of the
 * environment, whatever put them there.
 */
export const AGENT_RUN_WITHHELD_ENV = [
  'MOTIR_TOKEN',
  'MOTIR_RUN_TOKEN',
  'MOTIR_RUN_KEY',
  'MOTIR_GATEWAY_URL',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

/**
 * A prompt longer than this goes by FILE rather than on argv — Linux refuses a
 * single argv string past 128 KiB (MAX_ARG_STRLEN), as `hostedAgent.ts` notes.
 */
const MAX_ARGV_PROMPT_BYTES = 100 * 1024;

/** A profile by its id (`claude`, `codex`, …), or null for an unknown id. */
export function agentProfileById(profileId: string): AgentProfile | null {
  return AGENT_PROFILES.find((p) => p.id === profileId.trim().toLowerCase()) ?? null;
}

/**
 * The environment variable that forces the profile's plain-text form
 * ({@link AgentProfile.agentCommand}) instead of its streaming one — for a CLI version
 * that refuses the stream flags. Its value is `text`; anything else changes nothing.
 */
export const AGENT_OUTPUT_ENV = 'MOTIR_AGENT_OUTPUT';

export interface UnattendedAgentOptions {
  /**
   * Continue this session of the agent (its own conversation, context included) rather
   * than start a new one. Only a profile with a streaming form can resume; for any other
   * the option is ignored.
   */
  resumeSessionId?: string;
  /** Mints the session id a profile lets Motir choose. Overridden only by the tests. */
  newSessionId?: () => string;
}

/**
 * The profile's UNATTENDED command as a launcher, or null when the id is
 * unknown or the profile has no unattended form (`agentCommand: null`).
 *
 * It is the profile's STREAMING form wherever it has one (MOTIR-8980), so the run's
 * output arrives while the agent works and its session id is known; `MOTIR_AGENT_OUTPUT=text`
 * in `env` asks for the plain-text form instead.
 *
 * ⚠️ THE ENVIRONMENT IS THE SESSION'S OWN, EXTENDED — never an allow-list. The
 * agent needs the `CLAUDE_CONFIG_DIR` / `CODEX_HOME` the image set, which is
 * where its sign-in is (`agent-instance-run.md` §3). What is taken OUT is only
 * {@link AGENT_RUN_WITHHELD_ENV}; what is put in is only the profile's
 * `agentEnv`. It is built from `env` at the call, so it carries the run's git
 * config and `gh` shim when the run has prepared them.
 */
export function unattendedAgentCommand(
  profileId: string,
  env: NodeJS.ProcessEnv = process.env,
  options: UnattendedAgentOptions = {},
): ParsedAgentCommand | null {
  const profile = agentProfileById(profileId);
  const parsed = parseAgentCommand(profile?.agentCommand ?? undefined);
  if (!profile || !parsed) return null;
  const agentEnv: NodeJS.ProcessEnv = { ...env, ...profile.agentEnv };
  for (const name of AGENT_RUN_WITHHELD_ENV) delete agentEnv[name];

  const form = env[AGENT_OUTPUT_ENV]?.trim().toLowerCase() === 'text' ? null : profile.agentStream;
  if (!form) return withPrompt({ ...parsed, env: agentEnv }, profile.agentPrompt);

  let sessionId: string | null = options.resumeSessionId?.trim() || null;
  let args: string[];
  if (sessionId) {
    args = form.resumeArgs(sessionId);
  } else if (form.sessionIdFlag) {
    sessionId = (options.newSessionId ?? randomUUID)();
    args = [...form.args, form.sessionIdFlag, sessionId];
  } else {
    args = [...form.args];
  }
  return withPrompt(
    {
      command: [parsed.binary, ...args].join(' '),
      binary: parsed.binary,
      args,
      env: agentEnv,
      stream: { profile: profile.id, sessionId },
    },
    form.prompt,
  );
}

/**
 * The same launcher with a NEW Motir-chosen session id, for the next agent it spawns
 * (MOTIR-10983).
 *
 * A run resolves its agent ONCE, and {@link unattendedAgentCommand} bakes the session id
 * a profile lets Motir choose (`claude --session-id <uuid>`) into that one command. A
 * session id names ONE conversation: the second spawn of the same command is refused by
 * the agent itself (`Session ID … is already in use`). So every leg that spawns a fresh
 * agent asks for its own id here, just before the spawn.
 *
 * ⚠️ IT CHANGES ONLY WHAT MOTIR ITSELF CHOSE. The command must carry its profile's
 * `sessionIdFlag` followed by exactly the id its stamp names — which is the shape the
 * launcher builds for a fresh run and nothing else is. Anything else comes back
 * untouched, the same object: a command the person typed (no stamp), a profile whose
 * agent picks its own id (no flag), the plain-text form (no stamp), and a RESUME, whose
 * id is the point of the command and must not be replaced.
 */
export function withFreshSessionId(
  command: ParsedAgentCommand,
  newSessionId: () => string = randomUUID,
): ParsedAgentCommand {
  const stream = command.stream;
  const flag = stream ? agentProfileById(stream.profile)?.agentStream?.sessionIdFlag : null;
  if (!stream?.sessionId || !flag) return command;
  const at = command.args.indexOf(flag);
  if (at === -1 || command.args[at + 1] !== stream.sessionId) return command;
  const sessionId = newSessionId();
  const args = command.args.with(at + 1, sessionId);
  return {
    ...command,
    command: [command.binary, ...args].join(' '),
    args,
    stream: { ...stream, sessionId },
  };
}

/** Deliver the prompt the way the profile takes it: stdin as it stands, or argv only. */
function withPrompt(
  command: ParsedAgentCommand,
  channel: 'stdin' | 'argument' | null,
): ParsedAgentCommand {
  if (channel === 'stdin') return command;
  return {
    ...command,
    // An argv agent would also read a piped stdin — the prompt goes on argv only.
    promptOnStdin: false,
    promptArgs: (prompt, promptFile) =>
      Buffer.byteLength(prompt) > MAX_ARGV_PROMPT_BYTES
        ? [`Carry out the task described in the file ${promptFile} — read it first.`]
        : [prompt],
  };
}
