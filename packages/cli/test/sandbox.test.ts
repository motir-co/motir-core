import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  agentProfileIds,
  codegraphWiredProfiles,
  sandboxAgentConfigHome,
  AGENT_PROFILES,
  type AgentProfile,
} from '../src/agentProfiles.js';

// Structural guards for the sandbox image (base: 7.9.7a, agent profiles:
// 7.9.7b). These assert the image's CONTRACT — the Node floor, the mounts and
// their read-only split, the absence of a docker socket, and the per-agent
// profile matrix — from the source files, with no docker daemon involved.
// Building the image, running the loop inside it and asserting write-
// confinement for real is 7.9.7c's smoke matrix (MOTIR-885); this suite is what
// keeps a later edit from quietly widening the blast radius between now and
// then, and from letting the three per-agent surfaces (install layer, compose
// service, devcontainer) drift apart.

const SANDBOX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sandbox');
const read = (name: string): string => readFileSync(join(SANDBOX_DIR, name), 'utf8');

/**
 * Drop whole-line `#` comments. The sandbox files DOCUMENT what they
 * deliberately leave out (a docker socket, extra host binds), so an
 * absence assertion has to read the directives, not the prose.
 */
const directivesOf = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const dockerfile = read('Dockerfile');
const installAgent = read('install-agent.sh');
const entrypoint = read('entrypoint.sh');
// MOTIR-4959 moved the agent-config half of the entrypoint into its own script,
// because `overrideCommand: true` replaces the ENTRYPOINT and a devcontainer
// therefore never ran it (MOTIR-4956). The guards below follow the code: every
// assertion that used to read `entrypoint` for this contract now reads
// `agentConfig`, unchanged in what it asserts.
const agentConfig = read('agent-config.sh');
const agentConfigProfile = read('agent-config-profile.sh');
const compose = read('docker-compose.yml');
const readme = read('README.md');
const devcontainerRaw = read(join('devcontainer', 'devcontainer.json'));

const PROFILE_IDS = agentProfileIds();

/**
 * Split the compose file into its top-level service blocks. A dependency-free
 * split is enough (and keeps this suite runnable with no YAML parser): service
 * keys are the only thing at exactly two spaces of indentation.
 */
// Comments are KEPT here: a profile that deliberately mounts no credential has
// to explain itself in the block, and the volume/socket matchers below ignore
// comment lines anyway.
const composeServices: Record<string, string> = (() => {
  const lines = compose.split('\n');
  const services: Record<string, string> = {};
  let current = '';
  for (const line of lines) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1] ?? '';
      services[current] = '';
      continue;
    }
    if (current && line.trim()) services[current] += `${line}\n`;
  }
  return services;
})();

/** A compose service block by name — asserted present so callers get a string. */
const serviceBlock = (name: string): string => {
  const block = composeServices[name];
  expect(block, `compose service ${name}`).toBeDefined();
  return block ?? '';
};

/** The bind-mount sources of one compose service block, in file order. */
const volumesOf = (block: string): string[] =>
  block
    .split('\n')
    .filter((line) => /^\s+- \S+:\S/.test(line))
    .map((line) => line.trim().replace(/^- /, ''));

/**
 * The `environment:` keys of one compose service block. Read as `KEY: value`
 * lines under that key so a variable named only in a COMMENT cannot satisfy the
 * pass-through assertion.
 */
const environmentOf = (block: string): string[] => {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => /^\s{4}environment:\s*$/.test(line));
  if (start === -1) return [];
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s{4}\S/.test(line)) break; // the next service-level key
    const entry = /^\s{6}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (entry?.[1]) keys.push(entry[1]);
  }
  return keys;
};

/**
 * A profile's case arm in install-agent.sh: everything from its own `<id>)`
 * label up to the next `;;`. Read as an ARM rather than a substring so the
 * "profile is named somewhere in the file" drift guard cannot be satisfied by
 * a comment or by a shared refuse-everything arm.
 */
const armOf = (id: string): string => {
  const start = new RegExp(`^\\s{4}${id}\\)$`, 'm').exec(installAgent);
  if (!start) return '';
  const rest = installAgent.slice(start.index);
  const end = rest.indexOf('\n        ;;');
  return end === -1 ? rest : rest.slice(0, end);
};

/** A profile's row in the README's install matrix. */
const readmeRowOf = (id: string): string =>
  readme.split('\n').find((line) => line.startsWith(`| \`${id}\``)) ?? '';

/**
 * That row's cells: profile, tier, installed-from, binary, credential mount.
 * Split on unescaped pipes only — an install command may contain a `\|`.
 */
const readmeMatrixCells = (id: string): string[] =>
  readmeRowOf(id)
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim());

/** The dirs the profile table's credential paths are resolved against here. */
const TEST_DIRS = {
  home: '/home/tester',
  xdgConfigHome: '/home/tester/.config',
  xdgDataHome: '/home/tester/.local/share',
  // Unset on purpose: the mount assertions below are about a profile's DEFAULT
  // credential path. An agent redirected by CLAUDE_CONFIG_DIR / CODEX_HOME
  // resolves OUTSIDE the mount by design — that is what the redirect is for —
  // so pinning the probe against the mount only makes sense with no override.
  configHome: () => undefined,
};

/** A profile by id — asserted present so callers get a profile, not undefined. */
const profileOf = (id: string): AgentProfile => {
  const profile = AGENT_PROFILES.find((p) => p.id === id);
  expect(profile, `profile ${id}`).toBeDefined();
  return profile as AgentProfile;
};

describe('sandbox Dockerfile', () => {
  it('bases on the Node line and ASSERTS the >= 24.15 floor rather than trusting the tag', () => {
    expect(dockerfile).toMatch(/^ARG NODE_TAG=24-/m);
    expect(dockerfile).toMatch(/FROM node:\$\{NODE_TAG\}/);
    // Headroom over every supported agent's own floor (the highest being Kimi
    // Code's Node >= 22.19).
    expect(dockerfile).toContain('maj < 24 || (maj === 24 && min < 15)');
  });

  it('installs git and gh — both are part of the dispatch contract', () => {
    // Read from the RUNTIME stage (`AS base`): the node-pty build stage
    // (MOTIR-6938) runs its own apt-get for build tools, earlier in the file.
    const runtime = dockerfile.slice(dockerfile.indexOf(' AS base'));
    const aptPackages = runtime.slice(
      runtime.indexOf('apt-get install'),
      runtime.indexOf('rm -rf /var/lib/apt/lists'),
    );
    expect(aptPackages).toMatch(/^\s+git \\$/m);
    expect(aptPackages).toMatch(/install -y --no-install-recommends gh \\$/m);
  });

  it('installs python3 and smoke-tests it — the RUNBOOK path needs an interpreter (MOTIR-6195)', () => {
    // Read the DIRECTIVES: the block comment above this layer now explains why
    // python3 is contract, so a prose match would pass on the explanation of the
    // package rather than on the package.
    const directives = directivesOf(dockerfile);
    const runtime = directives.slice(directives.indexOf(' AS base'));
    const aptPackages = runtime.slice(
      runtime.indexOf('apt-get install'),
      runtime.indexOf('rm -rf /var/lib/apt/lists'),
    );
    // ⚠️ The FULL interpreter, pinned — NOT `python3-minimal` (MOTIR-6204).
    // `libpython3.11-minimal` is 81 modules rather than the standard library,
    // and `json`, `shutil` and `difflib` are not among them, so
    // SELECTOR.check.py died on `import json` in the image shipped to let it
    // run. The negative assertion is the load-bearing one: it is what stops the
    // package being narrowed back for size.
    expect(aptPackages).toMatch(/^\s+"python3=\$\{PYTHON_VERSION\}" \\$/m);
    expect(aptPackages).not.toContain('python3-minimal');
    expect(directives).toMatch(/^ARG PYTHON_VERSION=\d+\.\d+\.\d+-\d+(\+b\d+)?$/m);
    // Same reasoning as `motir --version` below: a base that cannot run python3
    // must fail the BUILD, not the first `motir sweep planning bugs`. The two
    // doors that drive prompts/sweep-planning-bugs.py have no degraded mode.
    expect(directives).toMatch(/&& python3 --version/);
    // And the assertion is what the CONSUMER IMPORTS — a `--version` is exactly
    // what passed while the guard could not start.
    expect(directives).toMatch(/python3 -c 'import [^']*\bjson\b/);
    expect(directives).toMatch(/python3 -c 'import [^']*\bshutil\b/);
    expect(directives).toMatch(/python3 -c 'import [^']*\bdifflib\b/);
  });

  it('installs procps and smoke-tests `ps` — Codex fails to start without it (MOTIR-8868)', () => {
    const directives = directivesOf(dockerfile);
    const runtime = directives.slice(directives.indexOf(' AS base'));
    const aptPackages = runtime.slice(
      runtime.indexOf('apt-get install'),
      runtime.indexOf('rm -rf /var/lib/apt/lists'),
    );
    expect(aptPackages).toMatch(/^\s+"procps=\$\{PROCPS_VERSION\}" \\$/m);
    expect(directives).toMatch(/^ARG PROCPS_VERSION=\d+:\d+\.\d+\.\d+-\d+(\+b\d+)?$/m);
    // A base without `ps` must fail the BUILD, not the first `codex` in an agent.
    expect(directives).toMatch(/&& ps --version/);
  });

  it('installs the motir binary and smoke-tests it in the same layer', () => {
    expect(dockerfile).toContain('npm install -g /tmp/motir-cli.tgz');
    // A base that cannot run `motir --version` must fail the BUILD.
    expect(dockerfile).toMatch(/&& motir --version/);
  });

  it('creates the pack destination before packing into it', () => {
    // `npm pack --pack-destination` does NOT create the directory, and the
    // failure is a bare ENOENT on the .tgz that reads like a missing INPUT.
    // Caught by 7.9.7c's build matrix on its first run — until then nothing had
    // ever built this file. The real guard is now that CI build; this one keeps
    // the line from being tidied away as redundant.
    // Anchored on the DIRECTIVE, not the word: the header comment mentions
    // `npm pack` a hundred lines earlier, and matching that would compare the
    // mkdir against a comment and pass or fail for the wrong reason.
    const packAt = dockerfile.indexOf('npm pack --pack-destination /pkg');
    const mkdirAt = dockerfile.indexOf('mkdir -p /pkg');
    expect(packAt).toBeGreaterThan(-1);
    expect(mkdirAt).toBeGreaterThan(-1);
    expect(mkdirAt).toBeLessThan(packAt);
  });

  it('installs the agents into a prefix node owns, AFTER motir and codegraph (MOTIR-6183)', () => {
    // A sandbox may run for weeks, and an agent must be able to update itself
    // there: every one was installed as root into /usr/local, so every
    // self-update failed ("Auto-update failed: no write permission to npm
    // prefix"). The agents now go under one prefix chowned to `node`.
    expect(dockerfile).toMatch(/^ENV MOTIR_AGENT_PREFIX=\/opt\/motir-agents$/m);
    expect(dockerfile).toMatch(/^ENV NPM_CONFIG_PREFIX=\/opt\/motir-agents$/m);
    expect(dockerfile).toMatch(/^ENV PATH=\/opt\/motir-agents\/bin:\$PATH$/m);
    // …and again for a LOGIN shell, whose /etc/profile replaces PATH: the image's
    // own `bash -l` would otherwise not find the agent at all.
    expect(dockerfile).toContain('> /etc/profile.d/motir-agents-path.sh');
    expect(dockerfile).toContain('PATH="/opt/motir-agents/bin:$PATH"');
    const prefixAt = dockerfile.search(/^ENV NPM_CONFIG_PREFIX=/m);
    // AFTER the motir and codegraph installs, so those stay root-owned in
    // /usr/local — the agent updates itself, never the CLI that supervises it.
    expect(dockerfile.indexOf('npm install -g /tmp/motir-cli.tgz')).toBeLessThan(prefixAt);
    expect(dockerfile.indexOf('@colbymchenry/codegraph')).toBeLessThan(prefixAt);
    // BEFORE the agent layer, so the arms install into it.
    expect(prefixAt).toBeLessThan(dockerfile.indexOf('install-agent.sh "${AGENT}"'));
    // And node owns it — created even in `base`, which installs nothing there.
    // Matched with a WORD BOUNDARY rather than an end-of-line anchor: the same
    // chown now also carries /opt/motir-browsers (MOTIR-6204), and this
    // assertion is about who owns the agent prefix, not about what happens to
    // be last on the line.
    expect(dockerfile).toMatch(/mkdir -p [^\n]*\/opt\/motir-agents\/bin/);
    expect(dockerfile).toMatch(/chown -R node:node [^\n]*\/opt\/motir-agents(\s|$)/m);
    // The retired approach is gone: nothing turns an updater off.
    expect(dockerfile).not.toContain('DISABLE_AUTOUPDATER');
  });

  it('ships a DEBUGGING Postgres — 18, pgvector, C.UTF-8, owned by node (MOTIR-6204, MOTIR-10223)', () => {
    // The image is unprivileged with no sudo, so a database absent at build
    // time is absent for every run. These four properties are what make the one
    // it ships usable AND honest; three of them are invisible to a `--version`.
    const directives = directivesOf(dockerfile);
    // Pinned exactly, and on BOTH published architectures — an unpinned apt
    // install is how two builds of one immutable tag come to differ.
    // The major is production's (18.6 on both databases) and CI's (MOTIR-10221).
    expect(directives).toMatch(/^ARG PG_MAJOR=18$/m);
    expect(directives).toMatch(/^ARG PG_VERSION=18\.\d+-\d+\.pgdg\d+\+\d+$/m);
    expect(directives).toMatch(/^ARG PGVECTOR_VERSION=\d+\.\d+\.\d+-\d+\.pgdg\d+\+\d+$/m);
    expect(directives).toContain('"postgresql-${PG_MAJOR}=${PG_VERSION}"');
    expect(directives).toContain('"postgresql-${PG_MAJOR}-pgvector=${PGVECTOR_VERSION}"');
    // Debian's postgresql-common creates a cluster under the SYSTEM locale on
    // install. Shipping it would put exactly the collation this layer exists to
    // avoid beside the one it wants, so it is never created.
    expect(directives).toContain("'create_main_cluster = false'");
    // The socket directory is load-bearing: the compiled-in default is
    // /var/run/postgresql, owned by postgres:postgres, so a server run by `node`
    // cannot create its lock file there and refuses to start.
    expect(directives).toContain("unix_socket_directories = '/tmp'");
    // The collation the fractional-index ordering depends on, and the extension
    // two repositories' migrations run on their first apply.
    expect(directives).toContain('--locale=C.UTF-8');
    expect(directives).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    // Asserted at BUILD time on the same grounds as `motir --version`: a
    // cluster that collates by dictionary must fail the build, not somebody's
    // debugging session eleven red assertions later.
    expect(directives).toContain("SELECT 'Zz' < 'a0'");
    // initdb runs as `node`, so the runtime user owns every byte and needs no
    // privilege to start it. A root-initialised cluster is MOTIR-6183's defect
    // one directory over.
    expect(directives).toMatch(/su node -c "[^"]*initdb/);
    expect(directives).toMatch(/^ENV PGDATA=\/var\/lib\/motir-postgres$/m);
    // The role, database and port every CI job in these repositories sets, so a
    // test command runs as typed.
    expect(directives).toMatch(
      /^ENV DATABASE_URL=postgresql:\/\/prodect:prodect@localhost:5432\/prodect$/m,
    );
    // Driven by a named command, NOT the entrypoint: `overrideCommand: true`
    // means the devcontainer route never runs the entrypoint (MOTIR-4956), so an
    // entrypoint start works on one documented route and silently not the other.
    expect(directives).toContain('/usr/local/bin/motir-sandbox-postgres');
    expect(directivesOf(entrypoint)).not.toContain('pg_ctl');
    // The client binaries reach a LOGIN shell too. `ENV PATH` does not: Debian's
    // /etc/profile replaces PATH for a non-root user, and `bash -l` is this
    // image's own CMD — so `psql` would be missing from the shell a reader gets
    // while working perfectly under the `bash -c` the smoke suite uses. That
    // asymmetry is what made MOTIR-6183's agent PATH need the same hook.
    expect(directives).toContain('> /etc/profile.d/motir-postgres-path.sh');
    expect(directives).toMatch(/PATH="\/usr\/lib\/postgresql\/18\/bin:\$PATH"/);
  });

  it('names ONE Postgres major everywhere the binaries are spelled out (MOTIR-10223)', () => {
    // The login-shell PATH hook and the helper's PG_BIN default spell the bin
    // directory as a literal, not through ${PG_MAJOR}. A major bump that misses
    // one leaves `psql` or `motir-sandbox-postgres` pointing at a directory the
    // image no longer has — a failure only a person in the container would see.
    const major = /^ARG PG_MAJOR=(\d+)$/m.exec(directivesOf(dockerfile))?.[1];
    expect(major).toBeDefined();
    const spelled = [dockerfile, read('postgres.sh')].flatMap((source) =>
      [...source.matchAll(/\/usr\/lib\/postgresql\/(\d+)\/bin/g)].map((m) => m[1]),
    );
    expect(spelled.length).toBeGreaterThanOrEqual(3);
    expect(new Set(spelled)).toEqual(new Set([major]));
  });

  it('ships a browser AND the libraries only root could install (MOTIR-6204)', () => {
    const directives = directivesOf(dockerfile);
    expect(directives).toMatch(/^ARG PLAYWRIGHT_VERSION=\d+\.\d+\.\d+$/m);
    // BOTH halves. The libraries are the half an unprivileged agent can never
    // add, and without them a downloaded browser does not launch at all; the
    // binary is baked because this container is pulled once and lived in, which
    // is the opposite of infra/ci-runner's per-job pull (it bakes libraries
    // only, on the same evidence read the other way — see the layer comment).
    expect(directives).toContain('install-deps chromium');
    expect(directives).toMatch(/playwright@\$\{PLAYWRIGHT_VERSION\}" install chromium/);
    // A shared path rather than ~/.cache/ms-playwright, which a devcontainer's
    // home mount can shadow and which a root-run install writes to root's home.
    expect(directives).toMatch(/^ENV PLAYWRIGHT_BROWSERS_PATH=\/opt\/motir-browsers$/m);
    // Writable by the runtime user: a repo pinned to a Playwright this image did
    // not bake runs `playwright install` itself, and that download has to land.
    expect(directives).toMatch(/chown -R node:node [^\n]*\/opt\/motir-browsers$/m);
  });

  it('puts both runtime layers BEFORE the motir install, so they cache across profiles', () => {
    // `COPY --from=builder /pkg/*.tgz` is invalidated by every source change,
    // and everything after it rebuilds with it. Two apt/download layers of this
    // size behind that line would be re-fetched on every commit, ×9 profiles
    // ×2 architectures — the same reasoning the codegraph layer states for
    // sitting where it does.
    const motirInstallAt = dockerfile.indexOf('COPY --from=builder /pkg/*.tgz');
    expect(motirInstallAt).toBeGreaterThan(-1);
    expect(dockerfile.search(/^ARG PG_VERSION=/m)).toBeLessThan(motirInstallAt);
    expect(dockerfile.search(/^ARG PLAYWRIGHT_VERSION=/m)).toBeLessThan(motirInstallAt);
  });

  it('exposes the AGENT selector with a base-only default and routes it through the seam', () => {
    expect(dockerfile).toMatch(/^ARG AGENT=base$/m);
    expect(dockerfile).toContain('install-agent.sh "${AGENT}"');
  });

  it('runs unprivileged and drops into /workspace via the entrypoint', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^WORKDIR \/workspace$/m);
    expect(dockerfile).toContain('ENTRYPOINT ["motir-sandbox-entrypoint"]');
    // HOME is what makes the read-only PAT mount target deterministic.
    expect(dockerfile).toMatch(/^ENV HOME=\/home\/node$/m);
  });
});

describe('the build survives a dropped download', () => {
  // Image cache (main) failed three builds in two days on one dropped connection to
  // www.postgresql.org (`curl: (18) HTTP/2 stream 1 was not closed cleanly`). Exit 18
  // is not in curl's transient set, so `--retry` alone would not retry it.
  it('every curl the build runs retries, on every error', () => {
    const calls = dockerfile
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
      .match(/\bcurl -fsSL[^\n]*/g);
    expect(calls).not.toBeNull();
    for (const call of calls!) expect(call).toContain('--retry 5 --retry-all-errors');
  });
});

describe('the per-agent layer seam', () => {
  it('handles the base default as a no-op', () => {
    expect(installAgent).toMatch(/^\s*base \| none\)/m);
  });

  it('gives EVERY agent profile the CLI knows about its own install arm', () => {
    // Drift guard: adding a profile to AGENT_PROFILES without extending the
    // seam would leave that agent falling through to "unknown AGENT".
    for (const id of PROFILE_IDS) {
      expect(armOf(id), `install arm for ${id}`).not.toBe('');
    }
  });

  it('installs each agent from a real source instead of claiming one it lacks', () => {
    // The 7.9.7a placeholder REFUSED a known profile rather than half-building
    // it. Now every arm must actually fetch something — an arm that only echoes
    // would produce an image advertising an agent that is not in it.
    for (const id of PROFILE_IDS) {
      expect(armOf(id), `install source for ${id}`).toMatch(
        /npm_agent |fetch_installer |pip install/,
      );
    }
  });

  it('never pipes a remote installer into a shell — each is fetched, checked, then run (MOTIR-6495)', () => {
    // A pipe executes whatever arrives. A vendor cache once answered the
    // antigravity arm with a 200 gzip body, and bash "ran" it as
    // `syntax error near unexpected token ')'`. `fetch_installer` decodes,
    // shebang-checks, `bash -n`-checks and retries instead (its behaviour is
    // driven for real in `fetchInstaller.test.ts`; this guards the WIRING).
    const directives = directivesOf(installAgent);
    expect(directives).not.toMatch(/\|\s*(\w+=\S+\s+)*(ba)?sh\b/);
    expect(directives).not.toMatch(/\bcurl\b/);
    for (const id of ['antigravity', 'cursor', 'goose']) {
      expect(armOf(id), `vendor script for ${id}`).toMatch(
        /fetch_installer https:\/\/\S+ "\$INSTALLER"/,
      );
      expect(armOf(id), `runs the checked file for ${id}`).toMatch(/bash "\$INSTALLER"/);
    }
    // The helper ships beside the script that sources it, before that RUN.
    const copyAt = dockerfile.indexOf(
      'packages/cli/sandbox/fetch-installer.sh /usr/local/lib/motir-sandbox/fetch-installer.sh',
    );
    expect(copyAt).toBeGreaterThan(-1);
    expect(copyAt).toBeLessThan(
      dockerfile.indexOf('RUN /usr/local/lib/motir-sandbox/install-agent.sh "${AGENT}"'),
    );
    expect(installAgent).toContain('. "$(dirname "${BASH_SOURCE[0]}")/fetch-installer.sh"');
  });

  it('installs claude from the `stable` dist-tag, not `latest` (MOTIR-3192)', () => {
    // claude-code's native binary ships as a per-platform OPTIONAL dependency,
    // and on 2026-08-19 `latest` moved to a version whose two x64 platform
    // packages were never published. An absent optional dependency is not an
    // error, so the install succeeded, installed one package, and the launcher
    // then reported "claude native binary not installed" — red-lighting every
    // amd64 build in the repository 56 minutes after the publish.
    //
    // `stable` is upstream's own curated channel, which a partial publish to
    // `latest` cannot reach. Asserted because the failure it prevents is
    // invisible here: a floating install looks identical in the diff and breaks
    // on somebody else's release schedule.
    expect(armOf('claude')).toContain("npm_agent '@anthropic-ai/claude-code' 'stable'");
  });

  it('logs the RESOLVED version of every npm-installed agent (MOTIR-3192)', () => {
    // `added N packages` names nothing, so placing that outage meant diffing
    // two job logs twelve minutes apart to find which version each had. One
    // `npm ls` line in the shared helper makes the next one a grep.
    expect(installAgent).toMatch(/npm ls -g --depth=0 "\$name"/);
  });

  it('smoke-tests the binary it installed, so a broken profile fails the BUILD', () => {
    // Same rule the base applies to `motir --version`: a profile that cannot
    // execute its agent must fail here, not inside an unattended run.
    for (const id of PROFILE_IDS) {
      expect(armOf(id), `version check for ${id}`).toMatch(/^\s+\S+ --version$/m);
    }
  });

  it('installs onto the global PATH — the layer runs as root, before USER node', () => {
    // An installer left to its own default would drop the agent in /root,
    // invisible to the unprivileged user that actually runs it.
    for (const id of PROFILE_IDS) {
      const arm = armOf(id);
      if (!arm.includes('fetch_installer ')) continue;
      expect(arm, `global install for ${id}`).toMatch(/AGENT_PREFIX/);
    }
    // Under the node-owned agent prefix (MOTIR-6183), never root-owned
    // /usr/local — and every relocated payload with it.
    expect(installAgent).toContain('AGENT_ROOT="${MOTIR_AGENT_PREFIX:-/opt/motir-agents}"');
    expect(installAgent).toContain('AGENT_PREFIX="$AGENT_ROOT/bin"');
    expect(installAgent).not.toMatch(/\/usr\/local\/bin|\/opt\/aider|\/opt\/cursor-agent/);
  });

  it('does NOT re-install the interpreter the base already ships (MOTIR-6204)', () => {
    // MOTIR-6195 put python3-minimal in the base, which made the aider arm's
    // "installed HERE and not in the base — no other profile pays for it"
    // false while the apt line under it still said so. Read the DIRECTIVES: the
    // arm's comment now explains the history, so a prose match would pass on
    // the explanation of the package rather than on the package.
    const arm = directivesOf(armOf('aider'));
    expect(arm).not.toMatch(/install[^\n]*\bpython3\b(?!-)/);
    // python3-venv stays — nothing else in the image needs it, and it is what
    // keeps pip off Debian's externally-managed system Python (PEP 668).
    expect(arm).toContain('python3-venv');
    expect(arm).toContain('python3 -m venv');
  });

  it('ships NO Gemini CLI profile — Antigravity replaces the retired tool', () => {
    // Asserted as the absence of a PROFILE, not of the word: the README names
    // Gemini precisely to say it is deliberately not shipped.
    expect(PROFILE_IDS).toContain('antigravity');
    expect(PROFILE_IDS).not.toContain('gemini');
    expect(armOf('gemini')).toBe('');
    expect(directivesOf(compose)).not.toContain('AGENT: gemini');
    expect(existsSync(join(SANDBOX_DIR, 'devcontainer', 'gemini'))).toBe(false);
  });

  it('refuses an unknown profile instead of building a half-image', () => {
    expect(installAgent).toContain("unknown AGENT '${AGENT}'");
    expect(installAgent).toMatch(/exit 1/);
  });
});

describe('sandbox entrypoint', () => {
  it('drops into /workspace and execs the requested command', () => {
    expect(entrypoint).toContain('cd "$WORKSPACE"');
    expect(entrypoint).toContain('exec "$@"');
  });

  it('fails fast when /workspace is not writable', () => {
    expect(entrypoint).toContain('if [ ! -w "$WORKSPACE" ]');
  });

  it('keeps stdout clean — every message goes to stderr', () => {
    // Widened with the MOTIR-4959 split: the rule is about what the IMAGE's
    // startup shell prints, and that is now two files. Narrowing it to the
    // entrypoint would have stopped covering the half that does the talking.
    const echoes = `${entrypoint}\n${agentConfig}`.match(/^\s*echo .*$/gm) ?? [];
    expect(echoes.length).toBeGreaterThan(0);
    // `motir next --print | pbcopy` must receive the prompt and nothing else.
    for (const line of echoes) expect(line).toMatch(/>&2$/);
  });
});

// ── The credential story: three tiers, one of which needs no mount (MOTIR-1877)
// The sandbox used to have exactly ONE way in — a credential mounted read-only
// from a host that had already run a login — which left a fresh machine, a CI
// runner and anyone running a published image with no path at all. These guards
// pin the three tiers across every surface that has to agree about them: the
// entrypoint's message, compose, the devcontainers and the README.

describe('the credential tiers', () => {
  const CREDENTIAL_ENV = ['MOTIR_TOKEN', 'MOTIR_SERVER'];

  it('passes the env tier through on EVERY compose service, not just the base one', () => {
    // A profile that forgot them would work on the maintainer's laptop (where
    // the mount is populated) and fail on every machine that has no host login —
    // the exact split the env tier exists to close.
    for (const [name, block] of Object.entries(composeServices)) {
      const env = environmentOf(block);
      for (const key of CREDENTIAL_ENV) {
        expect(env, `compose service ${name} must pass ${key} through`).toContain(key);
      }
    }
  });

  it('names ALL THREE ways in when no credential is present', () => {
    // The old message named one (mount it from the host), which is correct only
    // on the machine you already logged in on.
    const block = entrypoint.slice(entrypoint.indexOf('THREE ways a credential gets in here'));
    expect(block, 'the env tier').toContain('-e MOTIR_TOKEN');
    expect(block, 'the in-container login').toMatch(/motir login/);
    expect(block, 'the mount').toContain('$HOME/.config/motir:$CONFIG_DIR:ro');
  });

  it('says nothing at all when MOTIR_TOKEN carries the credential', () => {
    // A warning that fires on a working configuration teaches people to ignore
    // the warnings that matter.
    expect(entrypoint).toContain(
      'if [ -z "${MOTIR_TOKEN:-}" ] && [ ! -f "$CONFIG_DIR/config.json" ]',
    );
  });

  it('tells the truth about `motir login` by TESTING whether the config dir is writable', () => {
    // Under a `:ro` mount the login cannot persist, so offering it flatly would
    // send the reader at a command that must fail. The writability of the
    // nearest existing ancestor is the honest test — the dir itself may not
    // exist yet, in which case the CLI creates it.
    expect(entrypoint).toContain('config_dir_writable() {');
    expect(entrypoint).toMatch(/while \[ ! -e "\$dir" \]/);
    expect(entrypoint).toContain('drop the :ro mount to use it');
  });

  it('carries the mount-free one-liner in the entrypoint header AND the README', () => {
    const header = entrypoint.slice(0, entrypoint.indexOf('set -euo pipefail'));
    expect(header).toContain('-e MOTIR_TOKEN -e MOTIR_SERVER');
    expect(readme).toContain('-e MOTIR_TOKEN -e MOTIR_SERVER');
    // …and the mount is documented as OPTIONAL rather than as the contract.
    expect(readme).toContain('Three ways to give it a Motir credential');
    expect(readme).toMatch(/\*\*Optional\*\*, read-only/);
  });

  it('makes EVERY devcontainer variant run the agent-config setup (MOTIR-4956)', () => {
    // `overrideCommand: true` replaces the image's ENTRYPOINT as well as its
    // CMD, so a devcontainer never ran `motir-sandbox-entrypoint` and the agent
    // was handed an unset CLAUDE_CONFIG_DIR — a read-only `~/.claude` it could
    // neither read a credential from nor sign in to. `postStart` rather than
    // `postCreate`: it must also run when a STOPPED container is restarted,
    // which is the case MOTIR-4959's idempotency work makes safe.
    //
    // In the same loop as `remoteEnv` above, deliberately: a profile added later
    // cannot ship without it.
    const variants = [
      'devcontainer.json',
      ...PROFILE_IDS.map((id) => join(id, 'devcontainer.json')),
    ];
    expect(variants).toHaveLength(9);
    for (const relative of variants) {
      const variant = JSON.parse(
        readFileSync(join(SANDBOX_DIR, 'devcontainer', relative), 'utf8'),
      ) as { postStartCommand?: string; overrideCommand?: boolean };
      expect(variant.postStartCommand, `${relative} must run the setup`).toContain(
        'motir-sandbox-agent-config',
      );
      // And it STAYS `true`: the image's `CMD ["bash", "-l"]` exits, so dropping
      // it trades a container nobody can sign in to for one that will not stay
      // up. The fix is the postStartCommand, never removing this.
      expect(variant.overrideCommand, `${relative} still needs overrideCommand`).toBe(true);
    }
  });

  it('keeps the guide constant and the shipped recipes on the SAME command string', () => {
    // lib/apiDocs/sandbox.ts is the guide of record the sandbox smoke asserts
    // against (assert-commands.mjs's DEFAULT_GUIDE_PATH), and no route renders
    // it any more — which is exactly what makes it easy to leave behind. Two
    // spellings of the same command would publish one recipe and test another.
    const base = JSON.parse(read(join('devcontainer', 'devcontainer.json'))) as {
      postStartCommand?: string;
    };
    // Read as TEXT rather than imported: packages/cli does not depend on the
    // app's lib/, and the repo's other guide guards read it the same way.
    const guideSource = readFileSync(
      join(SANDBOX_DIR, '..', '..', '..', 'lib', 'apiDocs', 'sandbox.ts'),
      'utf8',
    );
    const guideLine = /"postStartCommand":\s*"([^"]*)"/.exec(guideSource)?.[1];
    expect(guideLine, 'the guide constant must carry a postStartCommand').toBeDefined();
    expect(guideLine).toBe(base.postStartCommand);
    // `|| true` so an older pinned `:<profile>-<version>` image, which has no
    // such command on PATH, still starts. The image's own login-shell hook is
    // what covers that container instead.
    expect(base.postStartCommand).toContain('|| true');
  });

  it('forwards the env tier into every devcontainer variant too', () => {
    // `remoteEnv` is the devcontainer analogue of compose's `environment:` — a
    // variant without it is the one shape of this image that still demands a
    // host login.
    const variants = [
      'devcontainer.json',
      ...PROFILE_IDS.map((id) => join(id, 'devcontainer.json')),
    ];
    for (const relative of variants) {
      const variant = JSON.parse(
        readFileSync(join(SANDBOX_DIR, 'devcontainer', relative), 'utf8'),
      ) as { remoteEnv?: Record<string, string> };
      for (const key of CREDENTIAL_ENV) {
        expect(variant.remoteEnv?.[key], `${relative} must forward ${key}`).toBe(
          `\${localEnv:${key}}`,
        );
      }
    }
  });
});

describe('sandbox mounts and blast radius', () => {
  it('mounts /workspace writable and the PAT config READ-ONLY', () => {
    expect(compose).toContain(':/workspace');
    expect(compose).toContain('${HOME}/.config/motir:/home/node/.config/motir:ro');
  });

  it('builds from the repo root with the base AGENT', () => {
    expect(compose).toContain('context: ../../..');
    expect(compose).toContain('dockerfile: packages/cli/sandbox/Dockerfile');
    expect(compose).toMatch(/profiles: \['base'\]/);
  });

  it('never mounts a docker socket anywhere in the sandbox', () => {
    // A container that can drive the host daemon is not confined at all.
    for (const source of [
      dockerfile,
      compose,
      entrypoint,
      agentConfig,
      agentConfigProfile,
      installAgent,
    ]) {
      expect(directivesOf(source)).not.toContain('docker.sock');
    }
    expect(devcontainerRaw).not.toContain('docker.sock');
  });

  it('gives every profile a `sandboxMounts` equal to what its compose service BINDS', () => {
    // The published `/docs/sandbox` guide derives its credential-mount column
    // from `sandboxMounts`, so a mount added to (or moved in) the compose file
    // without the profile record following makes the public page wrong. This is
    // the arm that stops that: the field is a RESTATEMENT of the compose volumes
    // and is only safe while something compares the two.
    //
    // Deliberately NOT `credentialPaths` — that field is `motir doctor`'s probe
    // and diverges from the mount on four of the eight profiles by design.
    for (const profile of AGENT_PROFILES) {
      const block = serviceBlock(`sandbox-${profile.id}`);
      const bound = volumesOf(block)
        .slice(2) // the two base mounts every service carries
        .map((volume) => volume.replace(/^\$\{HOME\}/, '~').replace(/:.*$/, ''));
      expect(profile.sandboxMounts, `${profile.id} sandboxMounts`).toEqual(bound);
    }
  });

  it('binds no host path beyond the workspace, the PAT config and the agent credential', () => {
    // Scoped PER SERVICE rather than over the whole file: every service must
    // carry the two base mounts FIRST, and anything it adds beyond them has to
    // be a read-only agent credential path — never a second writable host bind.
    for (const [name, block] of Object.entries(composeServices)) {
      const volumes = volumesOf(block);
      expect(volumes.slice(0, 2), `${name} base mounts`).toEqual([
        '${MOTIR_WORKSPACE:-../../../..}:/workspace',
        '${HOME}/.config/motir:/home/node/.config/motir:ro',
      ]);
      for (const extra of volumes.slice(2)) {
        expect(extra, `${name} extra mount`).toMatch(/^\$\{HOME\}\/.+:ro$/);
      }
    }
  });
});

describe('devcontainer variant', () => {
  const devcontainer = JSON.parse(devcontainerRaw) as {
    build: { args: Record<string, string>; dockerfile: string };
    workspaceFolder: string;
    mounts: string[];
    remoteUser: string;
  };

  it('is strict JSON and opens the same /workspace folder as the plain image', () => {
    expect(devcontainer.workspaceFolder).toBe('/workspace');
    expect(devcontainer.remoteUser).toBe('node');
  });

  it('carries the same AGENT selector', () => {
    expect(devcontainer.build.dockerfile).toBe('../Dockerfile');
    expect(devcontainer.build.args['AGENT']).toBe('base');
  });

  it('mounts the PAT config read-only', () => {
    const configMount = devcontainer.mounts.find((m) => m.includes('.config/motir'));
    expect(configMount).toBeDefined();
    expect(configMount).toContain('readonly');
  });
});

// ── The per-agent profile matrix (Subtask 7.9.7b) ───────────────────────────
// Every profile the CLI knows about must be RUNNABLE, not just installable:
// a compose service and a devcontainer that select it and mount its credential,
// plus a README row a human can act on. These guards are what keep the three
// surfaces from drifting apart as agents are added.

// ── CodeGraph in the sandbox (Subtask 7.9.7d / MOTIR-1513) ──────────────────
// The coding agent's OWN navigation graph: the binary in the base image, the
// MCP server wired per agent at build time, and the entrypoint that indexes the
// mount and keeps the graph fresh through git hooks. These guards assert the
// contract from the sources; actually building the image and querying the graph
// in-container is 7.9.7c's smoke matrix (MOTIR-885).

describe('codegraph in the base image', () => {
  it('installs the engine the 7.5.3 spike selected and smoke-tests it in the same layer', () => {
    expect(dockerfile).toContain('npm install -g --no-fund --no-audit @colbymchenry/codegraph');
    // Same rule the base applies to `motir --version`: an image that cannot run
    // the binary must fail the BUILD, not the first unattended run.
    expect(dockerfile).toMatch(/&& codegraph --version/);
  });

  it('disables telemetry by ENV as well as by the persisted setting', () => {
    // The env var is the one that actually holds in an unattended run: it
    // survives a home directory replaced by a bind mount, which the persisted
    // `telemetry off` state file does not.
    expect(dockerfile).toMatch(/^ENV CODEGRAPH_TELEMETRY=0$/m);
    expect(dockerfile).toContain('codegraph telemetry off');
  });

  it('installs codegraph BEFORE the per-agent seam, which wires MCP with it', () => {
    // Ordering is load-bearing twice over: install-agent.sh calls the codegraph
    // binary, and an agent-independent layer stays cached across all eight
    // profile builds.
    const codegraphLayer = dockerfile.indexOf('@colbymchenry/codegraph');
    const agentSeam = dockerfile.indexOf('install-agent.sh "${AGENT}"');
    expect(codegraphLayer).toBeGreaterThan(-1);
    expect(agentSeam).toBeGreaterThan(codegraphLayer);
  });

  it('chowns the whole runtime home, which the root-run seam writes MCP config into', () => {
    // `codegraph install` writes ~/.claude.json, ~/.codex/config.toml, … as
    // ROOT. Left root-owned, an agent that rewrites its own config at startup
    // fails on a home it cannot write.
    expect(dockerfile).toContain('chown -R node:node /workspace /home/node');
  });
});

describe('the per-agent codegraph MCP wiring', () => {
  // codegraph's OWN accepted target ids, read off `codegraph install
  // --print-config <id>` against the shipped version — NOT the profile ids, and
  // not assumable: three of the eight sandbox profiles have no target at all.
  const CODEGRAPH_TARGETS = [
    'claude',
    'cursor',
    'codex',
    'opencode',
    'hermes',
    'gemini',
    'antigravity',
    'kiro',
  ];

  it('claims a target only from the set codegraph actually accepts', () => {
    // The mistake this blocks is the #124 shape: carrying an assumed capability
    // list for a third-party tool instead of the one it reports. A near-miss id
    // ("claude-code", "codex-cli") is rejected by codegraph at build time, so a
    // wrong entry here would fail every image build for that profile.
    for (const { id, target } of codegraphWiredProfiles()) {
      expect(CODEGRAPH_TARGETS, `codegraph target for ${id}`).toContain(target);
    }
  });

  it('wires every profile that HAS a target, inside that profile own arm', () => {
    const wired = codegraphWiredProfiles();
    // Five of the eight: claude, codex, opencode, antigravity, cursor.
    expect(wired.map((p) => p.id).sort()).toEqual([
      'antigravity',
      'claude',
      'codex',
      'cursor',
      'opencode',
    ]);
    for (const { id, target } of wired) {
      expect(armOf(id), `codegraph wiring for ${id}`).toContain(`wire_codegraph ${target}`);
    }
  });

  it('leaves a profile codegraph has NO target for explicitly unwired', () => {
    // Same "UNKNOWN rather than guessed" rule the profile table applies to
    // credential paths: pointing kimi/aider/goose at a near-miss id would claim
    // a wiring the image does not have.
    const unwired = AGENT_PROFILES.filter((p) => p.codegraphTarget === null).map((p) => p.id);
    expect(unwired.sort()).toEqual(['aider', 'goose', 'kimi']);
    for (const id of unwired) {
      expect(armOf(id), `${id} must record that it has no wiring`).toContain('no_codegraph');
      expect(armOf(id), `${id} must not claim a wiring`).not.toContain('wire_codegraph');
    }
  });

  it('installs the wiring into the RUNTIME home, not the root that runs the layer', () => {
    // The same trap invariant 1 describes for binaries, one directory up: the
    // seam runs as root, so an install left to $HOME lands in /root, invisible
    // to the `node` user that runs the agent. Both homes the wiring can target
    // — the runtime home and the image-owned config home a shadowed profile is
    // redirected to — are under /home/node, never root's.
    expect(installAgent).toContain('RUNTIME_HOME=/home/node');
    expect(installAgent).toMatch(/local target="\$1" home="\$\{2:-\$RUNTIME_HOME\}"/);
    expect(installAgent).toMatch(/HOME="\$home" codegraph install/);
    expect(installAgent).toContain(
      'SANDBOX_AGENT_HOME="$RUNTIME_HOME/.motir-sandbox/agent-config"',
    );
  });

  it('installs non-interactively WITH the auto-allow list, so an unattended agent can call the tools', () => {
    // `--yes` is what turns the auto-allow permissions on; without it the agent
    // has the server but stops to ask before every call — useless unattended.
    // `--no-permissions` would defeat exactly that, so it must not appear.
    expect(installAgent).toContain('--location global --yes');
    expect(installAgent).not.toContain('--no-permissions');
  });

  it('records the resolved target in ONE place for the startup shell to re-read', () => {
    // The profile -> target map lives in the case arms and nowhere else; a
    // second copy in the re-reader could drift out of agreement with the arm
    // that actually did the install. MOTIR-4959 moved the re-reader from the
    // entrypoint into agent-config.sh — the ONE-place rule is untouched, and
    // the entrypoint must not have kept a copy on the way past.
    expect(installAgent).toContain(
      'CODEGRAPH_TARGET_FILE=/usr/local/lib/motir-sandbox/codegraph-target',
    );
    expect(agentConfig).toContain(
      'CODEGRAPH_TARGET_FILE=/usr/local/lib/motir-sandbox/codegraph-target',
    );
    expect(entrypoint).not.toContain('CODEGRAPH_TARGET_FILE=');
  });
});

// ── The read-only mount must never shadow the wiring (7.9.7f + 7.9.7g) ───────
// 7.9.7d wired the codegraph MCP server into each agent at BUILD time, writing
// that agent's own config file. For `codex` and `opencode` (MOTIR-1835) and then
// `claude` (MOTIR-1840) that file landed INSIDE the directory 7.9.7b bind-mounts
// READ-ONLY from the host, so the host's copy shadowed it and those agents saw
// no code-graph tools at all under the recommended compose path. The fix
// redirects all three to a config home the image owns; this guard is what stops
// a future profile reintroducing the shadowing silently — the failure mode is
// invisible at build time and only shows up as an agent that quietly greps
// instead of querying the graph.

describe('codegraph config is never shadowed by a read-only credential mount', () => {
  /** The container-side dirs the sandbox pins (Dockerfile: ENV HOME=/home/node). */
  const CONTAINER_DIRS = {
    home: '/home/node',
    xdgConfigHome: '/home/node/.config',
    xdgDataHome: '/home/node/.local/share',
    configHome: () => undefined,
  };

  /** The container paths a profile's compose service mounts READ-ONLY. */
  const readOnlyMountTargets = (id: string): string[] =>
    volumesOf(serviceBlock(`sandbox-${id}`))
      .filter((mount) => mount.endsWith(':ro'))
      .map((mount) => mount.split(':')[1] ?? '');

  /** Is `path` the mount itself, or anything beneath it? */
  const shadowedBy = (path: string, mounts: string[]): string | null =>
    mounts.find((mount) => path === mount || path.startsWith(`${mount}/`)) ?? null;

  it('gives every profile with a codegraph target a placement, and no other profile one', () => {
    // The two fields answer different questions ("is it wired?" vs "where does
    // the wiring land?"), so a profile carrying one without the other would
    // leave this guard with nothing to check.
    for (const profile of AGENT_PROFILES) {
      expect(
        profile.codegraphConfig !== null,
        `${profile.id}: codegraphConfig must be present iff codegraphTarget is`,
      ).toBe(profile.codegraphTarget !== null);
    }
  });

  it('never lets a profile read its MCP SERVER config from inside its own :ro mount', () => {
    // THE guard. A shadowed server file is the total failure — the agent has no
    // code-graph tools at all, which is exactly what shipped for codex and
    // opencode until 7.9.7f.
    for (const { id } of codegraphWiredProfiles()) {
      const placement = profileOf(id).codegraphConfig;
      expect(placement, `${id} placement`).not.toBeNull();
      const path = placement?.mcpServers(CONTAINER_DIRS) ?? '';
      const mounts = readOnlyMountTargets(id);
      expect(
        shadowedBy(path, mounts),
        `${id}: ${path} is shadowed by the read-only mount it sits inside`,
      ).toBeNull();
    }
  });

  it('declares — never hides — an auto-allow list that IS still inside a mount', () => {
    // The narrower failure: the agent HAS the tools but reads the host's
    // permission list, so an unattended run stops to ask before calling them.
    // It may exist, but only as a tracked, named condition.
    for (const { id } of codegraphWiredProfiles()) {
      const placement = profileOf(id).codegraphConfig;
      const autoAllow = placement?.autoAllow?.(CONTAINER_DIRS);
      const gap = placement?.knownAutoAllowGap ?? null;
      if (autoAllow && shadowedBy(autoAllow, readOnlyMountTargets(id))) {
        expect(gap, `${id}: a shadowed auto-allow list must name its tracking item`).toMatch(
          /^MOTIR-\d+$/,
        );
        continue;
      }
      // Nothing shadowed — a lingering reference would misreport a fixed gap.
      expect(gap, `${id} has no shadowed auto-allow list, so it must claim no gap`).toBeNull();
    }
  });

  it('leaves NO declared gap standing — claude was the last one (7.9.7g)', () => {
    // The stronger form of the guard above: not "every gap is declared" but
    // "there is nothing left to declare". Until 7.9.7g claude carried
    // MOTIR-1840 here, which is the whole reason the field exists.
    const declared = AGENT_PROFILES.filter((p) => p.codegraphConfig?.knownAutoAllowGap).map(
      (p) => p.id,
    );
    expect(declared).toEqual([]);
  });

  it('redirects exactly the profiles that would otherwise be shadowed, and exports the env var', () => {
    // A redirect the setup script does not actually export is decoration;
    // claude, codex and opencode are the three the mount contract shadows.
    const redirected = codegraphWiredProfiles()
      .filter(({ id }) => profileOf(id).codegraphConfig?.redirect)
      .map(({ id }) => id);
    expect(redirected.sort()).toEqual(['claude', 'codex', 'opencode']);
    for (const id of redirected) {
      const env = profileOf(id).codegraphConfig?.redirect?.env ?? '';
      expect(agentConfig, `${id}: agent-config.sh must export ${env}`).toMatch(
        new RegExp(`export ${env}=`),
      );
    }
  });

  it('keeps the image-owned config home identical across the table and both shell files', () => {
    // Three copies of one path is a drift risk; the profile table computes the
    // paths this suite checks, so a shell file that moved would let the guard
    // pass against a location the image no longer uses.
    const home = sandboxAgentConfigHome(CONTAINER_DIRS.home);
    expect(home).toBe('/home/node/.motir-sandbox/agent-config');
    expect(installAgent).toContain('.motir-sandbox/agent-config');
    expect(agentConfig).toContain('SANDBOX_AGENT_HOME="$HOME/.motir-sandbox/agent-config"');
    // It must sit outside every profile's mounts, not just the two redirected
    // ones — that is the property that makes it a safe destination at all.
    for (const id of PROFILE_IDS) {
      expect(shadowedBy(home, readOnlyMountTargets(id)), `${id} must not mount over ${home}`).toBe(
        null,
      );
    }
  });

  it('seeds the redirected codex home from the mount, so the credential survives', () => {
    // CODEX_HOME governs auth.json as well as config.toml, so a bare redirect
    // would trade "no code-graph tools" for "not signed in" — a worse bug.
    const block = agentConfig.slice(agentConfig.indexOf('redirect_codegraph_config() {'));
    expect(block).toContain('cp -a "$mounted/." "$private/"');
    expect(block).toMatch(/export CODEX_HOME=/);
  });

  it('seeds the redirected claude dir too — CLAUDE_CONFIG_DIR governs the credential', () => {
    // Same trap as codex, one profile over: CLAUDE_CONFIG_DIR moves
    // .credentials.json along with the settings and the state file, so a bare
    // redirect would sign the agent out.
    const block = agentConfig.slice(agentConfig.indexOf('redirect_codegraph_config() {'));
    expect(block).toMatch(/local mounted="\$HOME\/\.claude"/);
    expect(block).toMatch(/export CLAUDE_CONFIG_DIR=/);
    expect(block).toContain('cp -a "$mounted/$entry" "$private/"');
  });

  it('seeds only the claude CONFIG surface, never the session archives', () => {
    // ~/.claude is ~850 MB on a working machine and all but ~50 MB of it is
    // per-machine session state the container regenerates. A blanket `cp -a`
    // here would tax every container start to copy transcripts nothing reads.
    const seeded = (/^CLAUDE_SEED_ENTRIES='([^']*)'/m.exec(agentConfig)?.[1] ?? '').split(' ');
    expect(seeded).toContain('.credentials.json'); // the credential itself
    expect(seeded).toContain('.claude.json'); // the state file the lift targets
    expect(seeded).toContain('settings.json'); // where the auto-allow list lands
    expect(seeded).toContain('CLAUDE.md');
    for (const bulk of ['projects', 'file-history', 'history.jsonl', 'shell-snapshots']) {
      expect(seeded, `${bulk} is session state, not config`).not.toContain(bulk);
    }
  });

  it('lifts the one file codegraph and Claude Code disagree about, MERGING not replacing', () => {
    // codegraph writes the claude server stanza to <HOME>/.claude.json; the
    // shipped CLI reads <CLAUDE_CONFIG_DIR>/.claude.json and ignores the legacy
    // sibling entirely. The seeded target holds the user's OWN servers plus the
    // rest of Claude Code's state, so the lift merges a single key into it.
    const block = agentConfig.slice(agentConfig.indexOf('reconcile_codegraph_config() {'));
    expect(block).toMatch(/\[ "\$1" = claude \] \|\| return 0/); // claude-only
    expect(block).toContain('state.mcpServers = { ...(state.mcpServers || {}), ...servers };');
    expect(block).toContain('"$CLAUDE_CONFIG_DIR/.claude.json"');
    // Running it is part of the install step, not a function nobody calls.
    expect(agentConfig).toContain('elif ! reconcile_codegraph_config "$codegraph_target"; then');
  });

  it('wires claude into the image-owned home, where the redirected config dir looks', () => {
    // Two of codegraph's three claude outputs land under <HOME>/.claude, which
    // IS the redirected config dir — so installing under $SANDBOX_AGENT_HOME is
    // what puts settings.json and CLAUDE.md where the agent reads them.
    expect(armOf('claude')).toContain('wire_codegraph claude "$SANDBOX_AGENT_HOME"');
  });

  it('returns the install home through a global, not a subshell capture', () => {
    // `codegraph_home=$(redirect …)` would run the function in a SUBSHELL,
    // where the exported CODEX_HOME / OPENCODE_CONFIG die with it — the agent
    // would then read its unredirected (shadowed) config after all.
    expect(agentConfig).toContain('redirect_codegraph_config "$codegraph_target" || true');
    expect(agentConfig).toMatch(/HOME="\$CODEGRAPH_INSTALL_HOME" codegraph install/);
    expect(agentConfig).not.toMatch(/\$\(redirect_codegraph_config/);
  });
});

describe('the agent-config codegraph step', () => {
  it('indexes the mounted workspace on start, and re-syncs an already-indexed one', () => {
    expect(agentConfig).toMatch(/codegraph init "\$WORKSPACE"/);
    expect(agentConfig).toMatch(/codegraph sync --quiet "\$WORKSPACE"/);
  });

  it('installs BOTH the post-merge and post-checkout sync hooks', () => {
    expect(agentConfig).toMatch(/for hook in post-merge post-checkout; do/);
    expect(agentConfig).toContain('chmod +x "$hooks/$hook"');
  });

  it('never clobbers a hook the user already wrote', () => {
    // .git/hooks is untracked and lives in the HOST repo, so overwriting one
    // would silently destroy the user's own tooling.
    expect(agentConfig).toContain('CODEGRAPH_HOOK_MARKER=');
    expect(agentConfig).toMatch(/grep -qF "\$CODEGRAPH_HOOK_MARKER"/);
  });

  it('follows core.hooksPath, so the hook is not decoration in a redirected repo', () => {
    expect(agentConfig).toContain('core.hooksPath');
  });

  it('writes a hook that is a silent no-op without codegraph and NEVER fails a merge', () => {
    // The hook OUTLIVES the container inside the host repo, where codegraph
    // usually is not installed. It must not error on every merge, and a sync
    // failure must never block one.
    expect(agentConfig).toContain('command -v codegraph >/dev/null 2>&1 || exit 0');
    expect(agentConfig).toMatch(/codegraph sync --quiet "\\\$dir" >\/dev\/null 2>&1 \|\| true/);
  });

  it('treats the graph as an ENHANCEMENT — no codegraph failure aborts the run', () => {
    // `set -e` is on, so every call needs an explicit guard; an unindexable
    // workspace must still dispatch work.
    const block = agentConfig.slice(agentConfig.indexOf('── CodeGraph'));
    expect(block).toMatch(/codegraph init "\$WORKSPACE" >&2 \|\|/);
    expect(block).toMatch(/codegraph sync --quiet "\$WORKSPACE" >&2 \|\|/);
  });

  it('keeps codegraph output OFF stdout, which belongs to the prompt alone', () => {
    // The echo-only guard above cannot see a SUBPROCESS writing stdout, and
    // `codegraph init` is chatty.
    expect(agentConfig).toMatch(/codegraph init "\$WORKSPACE" >&2/);
    expect(agentConfig).not.toMatch(/^\s*codegraph (init|sync)[^|]*$/m);
  });

  it('says so out loud when a read-only mount masks the wiring, instead of failing silently', () => {
    // A credential dir mounted :ro (compose does this for ~/.codex and
    // ~/.config/opencode) shadows the config the build wrote — the agent would
    // otherwise just quietly have no code-graph tools.
    expect(agentConfig).toContain('could not refresh the codegraph MCP wiring');
    expect(agentConfig).toContain('READ-ONLY');
  });

  it('can be skipped entirely for a print-only or smoke-test run', () => {
    expect(agentConfig).toMatch(/\$\{MOTIR_SANDBOX_CODEGRAPH:-1\}/);
  });
});

// ── Reachable from a shell that never went through the entrypoint ───────────
// (MOTIR-4959, fixing MOTIR-4956)
//
// `"overrideCommand": true` — which every devcontainer recipe needs, because the
// image's `CMD ["bash", "-l"]` exits — makes Dev Containers replace the
// container's ENTRYPOINT as well as its CMD. So `motir-sandbox-entrypoint` never
// ran on that route, CLAUDE_CONFIG_DIR was never exported, and Claude Code fell
// back to `~/.claude`: the read-only mount, which on a macOS host holds no
// credential (the OAuth token is in the login Keychain) and cannot be written to
// sign in either. Both doors shut, with no error naming the cause.
//
// These guards pin the three things that fix it and the one thing that must not
// regress: the work is on PATH, it is safe to run twice, it EMITS the
// environment it computes, and the `docker run` route still carries that
// environment into the process it execs.

describe('the agent-config setup is reachable from any shell', () => {
  it('ships as its own script, installed on PATH under its own name', () => {
    // On PATH rather than under /usr/local/lib: the callers that need it are a
    // login shell, a `postStartCommand` and a human typing into a terminal, and
    // none of them knows an internal path.
    expect(existsSync(join(SANDBOX_DIR, 'agent-config.sh'))).toBe(true);
    expect(dockerfile).toContain(
      'COPY --chmod=0755 packages/cli/sandbox/agent-config.sh /usr/local/bin/motir-sandbox-agent-config',
    );
  });

  it('is what the entrypoint DELEGATES to — it does not carry the work itself', () => {
    // The point of the split. A copy left behind in the entrypoint would drift
    // from the one the shell hooks call, and the devcontainer route reads only
    // the latter.
    expect(entrypoint).toContain('motir-sandbox-agent-config || true');
    for (const moved of [
      'redirect_codegraph_config() {',
      'reconcile_codegraph_config() {',
      'install_codegraph_hooks() {',
      'CLAUDE_SEED_ENTRIES=',
    ]) {
      expect(entrypoint, `${moved} must live in agent-config.sh alone`).not.toContain(moved);
      expect(agentConfig, `${moved} must have moved into agent-config.sh`).toContain(moved);
    }
  });

  it('runs it as a CHILD, so a codegraph failure still cannot fail the run', () => {
    // The contract the moved block states in its own words. Sourcing it would
    // put `set -euo pipefail` and every unguarded call back in the entrypoint's
    // process, where a failure aborts the dispatch.
    expect(entrypoint).not.toMatch(/^\s*\.\s+.*motir-sandbox-agent-config/m);
    expect(entrypoint).toContain('motir-sandbox-agent-config || true');
  });

  it('still ends in cd + exec, with the env the child computed', () => {
    // The `docker run` route must be unchanged in BEHAVIOUR: `export` in a child
    // does not reach this process, so the entrypoint sources the file the child
    // wrote before handing over. Without this line the split would have MOVED
    // the defect rather than fixed it.
    expect(entrypoint).toContain('SANDBOX_AGENT_HOME="$HOME/.motir-sandbox/agent-config"');
    expect(entrypoint).toContain('. "$SANDBOX_AGENT_HOME/env.sh"');
    const tail = entrypoint.slice(entrypoint.indexOf('$SANDBOX_AGENT_HOME/env.sh'));
    expect(tail).toContain('cd "$WORKSPACE"');
    expect(tail).toContain('exec "$@"');
  });

  it('is SAFE TO RUN TWICE — neither seeding arm wipes a credential only it holds', () => {
    // THE idempotency guard. Both arms used to open with an unconditional
    // `rm -rf "$private"`, which was harmless while the entrypoint was the only
    // caller and runs exactly once. With a shell hook and a postStartCommand
    // calling it, a container RESTART would delete the credential an in-container
    // `motir login` wrote — and on a macOS host that copy is the ONLY one, since
    // there is no ~/.claude/.credentials.json to mount.
    const block = agentConfig.slice(agentConfig.indexOf('redirect_codegraph_config() {'));
    // The unconditional shape was a `rm -rf` on the line directly after the
    // arm's `local mounted=…`. Pinning THAT is what stops it coming back — a
    // bare "no rm -rf anywhere" would be satisfied by deleting the wipe
    // outright, which is a different (and wrong) fix: when the mount DOES carry
    // the credential the host must stay authoritative.
    expect(block).not.toMatch(/local mounted=[^\n]*\n\s*rm -rf "\$private"/);
    expect(block.match(/rm -rf "\$private"/g) ?? [], 'both arms still wipe').toHaveLength(2);
    expect(
      block.match(/if ! private_credential_would_be_lost/g) ?? [],
      'and both wipes are guarded',
    ).toHaveLength(2);
    expect(agentConfig).toContain('private_credential_would_be_lost() {');
    // The predicate itself: a private credential the mount cannot put back.
    expect(agentConfig).toContain('[ -f "$private_credential" ] && [ ! -f "$mounted_credential" ]');
    // Both arms ask it, each about ITS OWN credential file — claude keeps one in
    // .credentials.json, codex in auth.json.
    expect(block).toContain('"$private/.credentials.json" "$mounted/.credentials.json"');
    expect(block).toContain('"$private/auth.json" "$mounted/auth.json"');
  });

  it('WRITES the environment it computes, which is the whole devcontainer fix', () => {
    // A `postStartCommand` runs in one process; the terminal a human opens is
    // another. Nothing an export does survives that gap, so the assignments have
    // to reach the disk.
    expect(agentConfig).toContain('AGENT_CONFIG_ENV_FILE="$SANDBOX_AGENT_HOME/env.sh"');
    expect(agentConfig).toContain('write_agent_config_env() {');
    expect(agentConfig).toMatch(/^write_agent_config_env$/m);
    // Exactly the three variables a redirect can set, and no line for one that
    // is unset — an empty export would overwrite whatever the shell already had.
    expect(agentConfig).toContain('for var in CLAUDE_CONFIG_DIR CODEX_HOME OPENCODE_CONFIG; do');
    expect(agentConfig).toContain('[ -n "$value" ] || continue');
  });
});

describe('the login-shell hooks that repair an already-copied recipe', () => {
  it('installs a /etc/profile.d snippet AND a ~/.bashrc line', () => {
    // Two, because they cover different shells and a devcontainer produces both:
    // /etc/profile.d is read by a LOGIN shell, ~/.bashrc by an interactive
    // NON-login one, which is what a VS Code terminal usually opens.
    expect(dockerfile).toContain(
      'COPY --chmod=0644 packages/cli/sandbox/agent-config-profile.sh /etc/profile.d/motir-sandbox-agent-config.sh',
    );
    expect(dockerfile).toContain('>> /home/node/.bashrc');
    expect(existsSync(join(SANDBOX_DIR, 'agent-config-profile.sh'))).toBe(true);
  });

  it('SOURCES the snippet rather than executing it, from both hooks', () => {
    // A child process cannot put CLAUDE_CONFIG_DIR into the shell that needs it,
    // so an executed hook would be decoration — the exact shape of the bug being
    // fixed, one level up.
    expect(dockerfile).toContain('. /etc/profile.d/motir-sandbox-agent-config.sh');
    expect(agentConfigProfile).toContain('. "${__motir_sandbox_agent_home}/env.sh"');
    // The snippet is sourced, so it must not be executable or carry a shebang
    // that invites someone to run it.
    expect(agentConfigProfile.startsWith('#!')).toBe(false);
  });

  it('runs the setup ONCE per container, but sources the env on EVERY shell', () => {
    // The split matters: the sentinel is in the writable layer, so a RESTARTED
    // container keeps it and does not redo the work — and an unconditional
    // source is then the only thing that still gives that container's shells the
    // right CLAUDE_CONFIG_DIR.
    expect(agentConfig).toContain('AGENT_CONFIG_SENTINEL="$SANDBOX_AGENT_HOME/.setup-done"');
    expect(agentConfigProfile).toContain('.setup-done');
    const guarded = agentConfigProfile.slice(agentConfigProfile.indexOf('.setup-done'));
    expect(guarded).toContain('motir-sandbox-agent-config >/dev/null || true');
    // The env source sits AFTER the sentinel guard's `fi`, not inside it.
    const sourceAt = agentConfigProfile.indexOf('${__motir_sandbox_agent_home}/env.sh');
    const guardEnds = agentConfigProfile.indexOf('fi', agentConfigProfile.indexOf('.setup-done'));
    expect(sourceAt).toBeGreaterThan(guardEnds);
  });

  it('never lets a shell FAIL because of it', () => {
    // A terminal that will not open is a far worse outcome than an agent without
    // a code graph, and this file runs on every shell in the container.
    expect(agentConfigProfile).not.toContain('set -e');
    expect(agentConfigProfile).not.toMatch(/^\s*exit /m);
    expect(agentConfigProfile).toContain('|| true');
  });
});

describe.each(PROFILE_IDS)('agent profile: %s', (id) => {
  const service = serviceBlock(`sandbox-${id}`);

  it('has a compose service selecting its AGENT behind its own compose profile', () => {
    expect(service).toContain(`profiles: ['${id}']`);
    expect(service).toContain(`AGENT: ${id}`);
    expect(service).toContain('dockerfile: packages/cli/sandbox/Dockerfile');
  });

  it('mounts its own credential path READ-ONLY, or documents why it cannot', () => {
    const credentialMounts = volumesOf(service).slice(2);
    if (credentialMounts.length === 0) {
      // The honest case: no vendor-documented portable credential path (the
      // agent uses the OS keyring). Guessing one would make docker create an
      // empty root-owned directory on the host — so the profile must SAY so
      // rather than mount a path nobody documented.
      expect(service, `${id} has no credential mount and must explain that`).toMatch(
        /No agent credential mount/,
      );
      return;
    }
    for (const mount of credentialMounts) {
      expect(mount, `${id} credential mount`).toMatch(/:ro$/);
      // It must be the AGENT's path, not a second copy of the Motir PAT.
      expect(mount).not.toContain('/.config/motir');
    }
  });

  it('has a devcontainer variant carrying the same selector and mounts', () => {
    const path = join(SANDBOX_DIR, 'devcontainer', id, 'devcontainer.json');
    expect(existsSync(path), `devcontainer for ${id}`).toBe(true);
    const variant = JSON.parse(readFileSync(path, 'utf8')) as {
      build: { args: Record<string, string>; dockerfile: string; context: string };
      workspaceFolder: string;
      mounts: string[];
      remoteUser: string;
    };
    expect(variant.build.args['AGENT']).toBe(id);
    expect(variant.workspaceFolder).toBe('/workspace');
    expect(variant.remoteUser).toBe('node');
    // A nested variant sits one directory deeper than the base one.
    expect(variant.build.dockerfile).toBe('../../Dockerfile');
    // Every mount is read-only, PAT included — the workspace comes in through
    // workspaceMount, so nothing here should ever be writable.
    expect(variant.mounts.some((m) => m.includes('.config/motir'))).toBe(true);
    for (const mount of variant.mounts) expect(mount).toContain('readonly');
    // Same credential paths as the compose service, so the two forms cannot
    // drift into disagreeing about where an agent keeps its credential.
    const composeTargets = volumesOf(service)
      .slice(2)
      .map((mount) => mount.split(':')[1]);
    for (const target of composeTargets) {
      expect(variant.mounts.some((m) => m.includes(`target=${target}`))).toBe(true);
    }
  });

  it('is documented in the README with an install source and a credential column', () => {
    const row = readmeRowOf(id);
    expect(row, `README matrix row for ${id}`).not.toBe('');
    // Tier, install source, binary, credential — a row that lost a column would
    // leave the reader without the thing the profile is selected by.
    expect(row.split('|').filter((cell) => cell.trim()).length).toBeGreaterThanOrEqual(5);
  });

  it('matches the README matrix on the BINARY the agent actually installs as', () => {
    // The README matrix is the VERIFIED source for this column (re-checked
    // against each vendor's installer). The CLI's profile table restates it, and
    // a restatement drifts: `cursor` sat in the table as the binary name for a
    // CLI whose installer links `agent`, so it matched nothing at all and the
    // profile was dead code nobody could reach.
    const readmeBinaries = [...(readmeMatrixCells(id)[3] ?? '').matchAll(/`([^`]+)`/g)].map(
      (match) => match[1],
    );
    expect(readmeBinaries.length, `README binary column for ${id}`).toBeGreaterThan(0);
    const profile = profileOf(id);
    for (const binary of readmeBinaries) {
      expect(profile.binaries, `${id} must match its documented binary`).toContain(binary);
    }
    // Any name BEYOND the documented ones may only be the profile id itself —
    // the alias a user might have made. The table may not invent a third name.
    for (const binary of profile.binaries) {
      if (readmeBinaries.includes(binary)) continue;
      expect(binary, `${id} extra alias`).toBe(id);
    }
  });

  it('tests a credential only WITHIN a path the README matrix pins', () => {
    // The matrix pins the MOUNT; `doctor` may narrow it (opencode's auth.json
    // inside the data dir) or decline it, but it may never test a path the
    // sandbox does not mount — that would report a credential the container
    // never receives.
    const readmePaths = [...(readmeMatrixCells(id)[4] ?? '').matchAll(/~\/[^\s`*]+/g)].map(
      (match) => match[0].replace('~', TEST_DIRS.home),
    );
    const profilePaths = profileOf(id).credentialPaths(TEST_DIRS);
    if (readmePaths.length === 0) {
      // No documented portable credential (the OS-keyring agents) — so there is
      // nothing legitimate to look for either.
      expect(profilePaths, `${id} has no documented credential path`).toEqual([]);
      return;
    }
    for (const path of profilePaths) {
      expect(
        readmePaths.some((mount) => path === mount || path.startsWith(`${mount}/`)),
        `${id}: ${path} is outside the documented mounts ${readmePaths.join(', ')}`,
      ).toBe(true);
    }
  });

  it('documents a VERIFIED auto-approve mechanism for unattended runs', () => {
    // These flags drift release-to-release, which is why they are documented
    // per agent rather than assumed — a profile with no documented unattended
    // path cannot be used by `motir auto` at all.
    const flagRows = readme
      .split('\n')
      .filter((line) => line.startsWith(`| \`${id}\``))
      .filter((line) => /--|GOOSE_MODE|auto/.test(line));
    expect(flagRows.length, `auto-approve row for ${id}`).toBeGreaterThanOrEqual(1);
  });

  it('has no docker socket anywhere in its variant', () => {
    const variantRaw = readFileSync(
      join(SANDBOX_DIR, 'devcontainer', id, 'devcontainer.json'),
      'utf8',
    );
    expect(variantRaw).not.toContain('docker.sock');
    expect(directivesOf(service)).not.toContain('docker.sock');
  });
});
