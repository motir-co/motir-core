# The Motir sandbox image

The confined container an unattended `motir auto` run executes in, instead of a
skip-permissions coding agent loose on your host. This is the shape of the dev
sandbox Motir itself is built in.

Running `motir auto` in a normal console stays **fully supported** — the
container is the _recommended_ path, not a requirement.

> **Status (Subtask 7.9.7e).** The base image (Node ≥ 24.15, git, `gh`, the
> `motir` binary, the `AGENT` build-arg selector) shipped in 7.9.7a; 7.9.7b
> filled its per-agent layer seam with the **profile matrix** below — eight
> selectable coding agents, each with its own credential mount; 7.9.7d added
> **CodeGraph** (the binary, the per-agent MCP wiring, and the index + git sync
> hooks), which 7.9.7f + 7.9.7g keep clear of the read-only credential mounts;
> 7.9.7c added the **validation harness** — every pull request builds
> each profile, runs its liveness check, asserts the confinement claims against
> the real mount table, and drives `motir auto` end-to-end inside the image with
> a fake agent (see [Validation](#validation)). This slice **publishes** it: the
> smoke-tested images go to GHCR on a `cli-v*` tag, so adopting the sandbox is a
> `docker run`, not a `git clone` (see [Publishing](#publishing)). MOTIR-1877
> then closed the last thing that still needed a prior host login: the
> credential mount is **optional**, `MOTIR_TOKEN` / `MOTIR_SERVER` are honoured
> everywhere, and `motir login` runs inside the container (see
> [the three ways](#three-ways-to-give-it-a-motir-credential)) — reaching the
> **published** image only with `cli-v0.1.1` (MOTIR-2131). The current release is
> **`cli-v0.3.0`**, which carries `@motir/cli@0.3.0` and its permission-named 403
> hint (MOTIR-2572; see [Published images](#published-images)).

## Run

> **Setting it up for the first time?** The published guide at
> **<https://app.motir.co/docs/sandbox>** is the first ten minutes — pick a profile,
> start the container, `motir login`, `motir link`, `motir doctor` — and needs no
> checkout. This README is the reference for everything past that.

Pull and go — no checkout, no build, and no prior host login:

```sh
docker run --rm -it \
  -v "$PWD:/workspace" \
  -e MOTIR_TOKEN -e MOTIR_SERVER \
  -v "$HOME/.claude:/home/node/.claude:ro" \
  ghcr.io/motir-co/motir-sandbox:claude \
  motir auto --agent "claude --dangerously-skip-permissions"
```

One required mount, one optional one, and the agent's own:

| Mount / variable               | Why                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `$PWD:/workspace`              | **Required, writable.** Your `.motir.json` tree — the only host path the agent can change.                                                      |
| `MOTIR_TOKEN` / `MOTIR_SERVER` | The Motir credential, from the environment. Needs no host state at all, so it is the CI / fresh-machine / published-image path.                 |
| `$HOME/.config/motir:…:ro`     | **Optional**, read-only. A credential you already have on this host — an alternative to the two variables above, not a requirement (see below). |
| `$HOME/.claude:…:ro`           | Read-only. The agent's own credential — swap it for your profile's row in [the matrix](#the-profile-matrix).                                    |

Run it from your **workspace root** (the directory holding `.motir.json`), not
from inside a single checkout — `motir auto` dispatches across every repo in the
workspace. With no command, you get an interactive shell in `/workspace`
instead.

### Three ways to give it a Motir credential

The container needs a token for your Motir server. It has the same three tiers
the CLI has anywhere else — the resolution ladder is
`MOTIR_TOKEN` → the stored config — and all three work in here (MOTIR-1877):

1. **`-e MOTIR_TOKEN -e MOTIR_SERVER`** — pass them through from your shell.
   `GH_TOKEN` / `GH_HOST` one-for-one. Nothing is mounted, nothing is written to
   disk, and it is the only tier a CI runner or a brand-new machine can use.
   Mint the token in Motir under **Settings → Account → Tokens**.
2. **`motir login`, inside the container** — a device grant: it prints a code and
   a URL, you approve it in a browser on any device, and the container polls
   until the token is minted. Headless by construction, which is exactly what a
   container is. **This needs the credential mount to be ABSENT** — with no bind
   over it, `~/.config/motir` inside the container is writable and the login
   persists for the container's life (and dies with `--rm`, like the rest of the
   ephemeral layer).
3. **`-v "$HOME/.config/motir:/home/node/.config/motir:ro"`** — mount a
   credential you already have. Read-only, because a container that mounts one
   _consumes_ it and never mints or rotates it. This is the convenient path on
   the laptop you already ran `motir login` on.

With none of them, the entrypoint says so on **stderr** and names all three
before anything fails deeper in.

> **An environment credential does not widen the blast radius.** It is a variable
> in one process tree, not a host path, so the mount table — the thing
> [confinement](#what-it-confines--and-what-it-does-not) is actually asserted
> against — is one entry SHORTER than it used to be. The smoke lane proves both
> halves: the mount-free legs run with only `/workspace` bound, and the
> confinement suite still refuses any host bind beyond the documented ones.

> The `base` image ships **no** coding agent, so `motir auto --agent …` has
> nothing to launch there. Use it for `motir next --print` workflows — the
> entrypoint keeps stdout clean, so piping the prompt straight out of
> `docker run` works — and run your agent on the host. For an unattended loop,
> pull one of the agent profiles below.

## Published images

`ghcr.io/motir-co/motir-sandbox`, one tag per profile plus the agent-less
base, built for **linux/amd64 + linux/arm64** (Apple Silicon is a first-class
BYOK dev machine). Each tag exists in two forms:

- `:<profile>` — **moving**. Points at the latest release. Convenient, not
  reproducible.
- `:<profile>-<version>` — **immutable**, where `<version>` is the
  [`@motir/cli`](../package.json) version the image was cut from, so the `motir`
  inside the image and the one on npm are the same build.

**Pin the digest for anything you need to reproduce.** A moving tag is not a
sandbox you can re-enter — the same argument 7.9.7a makes for the base image:

```sh
docker run --rm -it \
  -v "$PWD:/workspace" \
  -e MOTIR_TOKEN -e MOTIR_SERVER \
  -v "$HOME/.claude:/home/node/.claude:ro" \
  ghcr.io/motir-co/motir-sandbox@sha256:<digest> \
  motir auto --agent "claude --dangerously-skip-permissions"
```

Every release keeps its own table below, newest first, and older ones are never
edited: a moving `:claude` is a pointer, but `:claude-0.1.0` and the digest
beside it are a promise about specific bytes, and [Public, and asserted to
be](#public-and-asserted-to-be-motir-2010) tells a story that reads on the
`cli-v0.1.0` rows in particular. Overwriting a release's digests in place would
quietly change what an earlier paragraph is talking about.

**The release lane writes these tables itself** (MOTIR-2699). At each `cli-v*` tag
[`render-digest-table.mjs`](smoke/render-digest-table.mjs) resolves every
published tag from the registry over an **anonymous** pull, checks the two
invariants each section claims, prepends the new section, demotes the outgoing one
to history, and commits the result on `main` (see [Publishing](#publishing)).
Nobody retypes a digest, and a digest that disagrees with what the push recorded
fails the release rather than being written. The registry is still the authority,
and still one command away:

```sh
docker buildx imagetools inspect ghcr.io/motir-co/motir-sandbox:claude
```

<!-- sandbox-digests:release cli-v0.18.0 -->

### Release `cli-v0.18.0`

([run 43219479663](https://github.com/motir-co/motir-core/actions/runs/43219479663)).
The `motir` inside each image is
[`@motir/cli@0.18.0`](https://www.npmjs.com/package/@motir/cli/v/0.18.0), the
same build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.18.0` — points at the same manifest,
and the moving `:<profile>` tags point here too: this is the current release.

<!-- sandbox-digests:currency end -->

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the
token request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.18.0 | grep -i docker-content-digest
```

Two things CHECKED rather than assumed, by the release lane that wrote this
section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**
manifest as its `:<profile>-0.18.0` twin (9 of 9), and **every digest below
differs from its `cli-v0.17.1` row** (9 of 9) — an unchanged digest across a
version bump would mean a variant did not actually rebuild, which is a finding,
not a formatting detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:c44521f6fbd1697e9f48ef651abc1e39512e26310a84d1b294a43e740f12d356` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:2cc03dbaade458e9a4814eba5530c8a3fb56699cc980a6c5175bfe423a1089d3` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:45f91635e34f8bdb24328526fdc5b89943905a70467eaeb9cfa740edff855c57` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:1e260719d146c6ee42a382e6dafdb8f68dbbec43119c7c437c52294fbeeff2b7` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:79c7659e048fe245c80fdbab30b0f5bb84fb1b18a0b4dceec4e1f415d28b0886` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:0bd00af2f79372f94811e41c6d688a12836b34dd590252f6884672f66ef20a8f` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:4bb3235b3f643211772939fee527f5f5fd7eb419d745124ec35f6e96bc2f3457` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:b12ad757a986fb7f1053562397e2e3abb8cd71da61bd1f213a7778bfc335dd81` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:8dc6361733869149a956f8e2091dbf5802185d9632288bca2b837a003e795437` |

<!-- sandbox-digests:release cli-v0.17.1 -->

### Release `cli-v0.17.1`

([run 42520273270](https://github.com/motir-co/motir-core/actions/runs/42520273270)).
The `motir` inside each image is
[`@motir/cli@0.17.1`](https://www.npmjs.com/package/@motir/cli/v/0.17.1), the
same build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.17.1` — points at the same manifest.
It **was** the current release until `cli-v0.18.0`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists.

<!-- sandbox-digests:currency end -->

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the
token request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.17.1 | grep -i docker-content-digest
```

Two things CHECKED rather than assumed, by the release lane that wrote this
section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**
manifest as its `:<profile>-0.17.1` twin (9 of 9), and **every digest below
differs from its `cli-v0.17.0` row** (9 of 9) — an unchanged digest across a
version bump would mean a variant did not actually rebuild, which is a finding,
not a formatting detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:525a15d1b55e993c42fc2902ca65919c8ce68308cfb121d1934ec39bb09a0227` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:ea5edd5cb328b31bb421e8cb99aba2995f927680719b9b354ac01d21c36950aa` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:4c1eb2096fe65acb297c8c480a1cb02e24559b1d8c3bb7bdbe44599149f51a3e` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:3470919619b903fdccd316957d63b4f35f3936e99dd375b0cdcaa97ed4db9db7` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:5195c217f1947fd9bbc00e3d0a42255efcd91d64cc49707733b6145d92b1718d` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:5f393a41aaf9a8edf4ada411af0d8aac17535822d8a688c3f4f0c898a6f36819` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:0b3879925735a6c4c912eb0396f09484b57fb4d7575470d516d458833fdf7df2` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:d852a3fc709681ec0b830b0417ce58bebacd5d60cc4c522a24fc331a1f767874` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:b05d008d65bf25133e80e1036c0701246f387b88fc47991c8e4bedf974c2619a` |

<!-- sandbox-digests:release cli-v0.17.0 -->

### Release `cli-v0.17.0`

([run 42100885377](https://github.com/motir-co/motir-core/actions/runs/42100885377)).
The `motir` inside each image is
[`@motir/cli@0.17.0`](https://www.npmjs.com/package/@motir/cli/v/0.17.0), the
same build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.17.0` — points at the same manifest.
It **was** the current release until `cli-v0.17.1`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists.

<!-- sandbox-digests:currency end -->

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the
token request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.17.0 | grep -i docker-content-digest
```

Two things CHECKED rather than assumed, by the release lane that wrote this
section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**
manifest as its `:<profile>-0.17.0` twin (9 of 9), and **every digest below
differs from its `cli-v0.13.1` row** (9 of 9) — an unchanged digest across a
version bump would mean a variant did not actually rebuild, which is a finding,
not a formatting detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:2c16414559cd304e99025932bd165108afbece6dac4b75f982474439dcf5d164` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:6cbff5d0215a4e673dbead4b3cf13943600e2978064ad0f3c2c92420302a0c02` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:cbe1b20f2c773b06d833b867dc3edf87bc8db94feaa394a703e366192047242d` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:0d2584dfc8b280793f15a9b8f870043b9ee36752f802ea60d3442ac4ebbe0488` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:db9a0f930d09fe48e2b0a1107b5af1a749be7c1b28025c6c1294a901e5e70aa7` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:2e791820a603a9cab36cf519ba9071d61e84e42c9bd51621cef5d0ac9bf35a43` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:ed8e7306151bdd41c322a7898033814b053b7e06586e3361d6cde87309e89e2a` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:72d96ac4117e29f6c420e1d8a3129b5d6bb119d0261a88bf2d3e032981e596c2` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:b3dec98244c6fdb185770e85948f5ddeb59eb5da6ce8d13c8765f73efc7b9a86` |

<!-- sandbox-digests:release cli-v0.13.1 -->

### Release `cli-v0.13.1`

([run 39171613379](https://github.com/moooon-B-V/motir-core/actions/runs/39171613379)).
The `motir` inside each image is
[`@motir/cli@0.13.1`](https://www.npmjs.com/package/@motir/cli/v/0.13.1), the
same build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.13.1` — points at the same manifest.
It **was** the current release until `cli-v0.17.0`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists.

<!-- sandbox-digests:currency end -->

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the
token request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.13.1 | grep -i docker-content-digest
```

Two things CHECKED rather than assumed, by the release lane that wrote this
section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**
manifest as its `:<profile>-0.13.1` twin (9 of 9), and **every digest below
differs from its `cli-v0.13.0` row** (9 of 9) — an unchanged digest across a
version bump would mean a variant did not actually rebuild, which is a finding,
not a formatting detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:7275ea88cb5089b44c2154b0b0848da85471e67419ec15c03973396d51a72bcf` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:594b7e2973ab394afc1729003d5921a470812aa71c98b505918ad42b48a3602c` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:407935723306a4e7f346d017e4e081f2b2d3a7fcc3ff3c2ced4757f3afef0a05` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:6ce2e2d87a84a40c1e2bdb0d7386c335b662817ea942b709f218918490367a32` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:0436bf3474e8990a2644adffd16c7b888a61167679f05c33ff1b414eb9c19cc7` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:0fee99b3812a79b76640417b86f06ae3c921502cca7c12ced7e7a356d55319b4` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:4bb71fcc848f5481345ff64406bfcbef3489274ae1dd513ebd64cbe9655c8d8e` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:b83948a1566ee3a3549e2a40269252578f8a828a97986122f783929e02193c58` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:6ea4f0e8bf55f03f224f283ef69af4f9388930764e5d550f3e66278688799029` |

<!-- sandbox-digests:release cli-v0.13.0 -->

### Release `cli-v0.13.0`

([run 38960139186](https://github.com/moooon-B-V/motir-core/actions/runs/38960139186)).
The `motir` inside each image is
[`@motir/cli@0.13.0`](https://www.npmjs.com/package/@motir/cli/v/0.13.0), the
same build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.13.0` — points at the same manifest.
It **was** the current release until `cli-v0.13.1`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists.

<!-- sandbox-digests:currency end -->

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the
token request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.13.0 | grep -i docker-content-digest
```

Two things CHECKED rather than assumed, by the release lane that wrote this
section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**
manifest as its `:<profile>-0.13.0` twin (9 of 9), and **every digest below
differs from its `cli-v0.12.0` row** (9 of 9) — an unchanged digest across a
version bump would mean a variant did not actually rebuild, which is a finding,
not a formatting detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:3c926e6875088d41c3096d59d990021a95b55f4b652577151fe3dee4a5902b87` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:53ff5f584226c9fa4d0bdcc980ef7fbd64de67b1a07e329c14d20378b7495064` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:d2883be04617c11babfe6e61e28b185e2d1a3d1956f0af2419abde3bd31e0727` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:e0091779c989cb21fbe090caee5e92a99049126c5aa2cb97607f01483df976b4` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:fbd760e11b6dca6575024a09d7a3c11ae2173066fa336b7598a3a687b360f95f` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:fdd1b5bb4404d9725d44b78e6f5fc7da13a1fa36c0db1c4bbda96448f92bcd52` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:98db4e2b31cfb45f9bca78395351e82a3172421af6eb8b43d332e0bf84c63d94` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:bcc478f2979c66212e4e0bd004f77e237e321829df5582abac44b109c181f892` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:d4b4ffa9183dd55b6817200a2f569cc9778d158a3e4957f65aaa345e56957479` |

<!-- sandbox-digests:release cli-v0.12.0 -->

### Release `cli-v0.12.0`

([run 37186256308](https://github.com/moooon-B-V/motir-core/actions/runs/37186256308)).
The `motir` inside each image is
[`@motir/cli@0.12.0`](https://www.npmjs.com/package/@motir/cli/v/0.12.0), the
same build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.12.0` — points at the same manifest.
It **was** the current release until `cli-v0.13.0`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists.

<!-- sandbox-digests:currency end -->

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the
token request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.12.0 | grep -i docker-content-digest
```

Two things CHECKED rather than assumed, by the release lane that wrote this
section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**
manifest as its `:<profile>-0.12.0` twin (9 of 9), and **every digest below
differs from its `cli-v0.11.1` row** (9 of 9) — an unchanged digest across a
version bump would mean a variant did not actually rebuild, which is a finding,
not a formatting detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:f4df2b0ae90c6e2c9d34b4772008894d1b6bfd25d1b542a5e944c24ddd6fc90d` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:1710a703b7c4af579013da389a53b7304e2ac377858248b378fcf24b01f3a7b4` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:f8f6b4d1d78b6391afb62be6ae7ef04fc958d2dc869d1f542028a30957b91740` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:4210eb3d52c78a23b75c29ac36efdcc6907b49a90fd74e4cb09586df3285c797` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:e3b9dc45c11652a0df6996329f353eb8e3bdc2755097f0ba322c270d91d69d7e` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:03f1957fc4a97d4faec28ff4bfa00177edfaf3d50b5328f4c953832c91d2eeef` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:8290f433f8a9d6f2b1dc56d44ef791242cbb51876c2b24408fba0479749a88b5` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:1535285c9646ea58df4500f68300ef06dff775007a0b5986bb6bb6826459400c` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:917857420aa96932f598b03b3ce28263274e06af22af3aa1ab721489abfe283c` |

<!-- sandbox-digests:release cli-v0.11.1 -->

### Release `cli-v0.11.1`

([run 36997956171](https://github.com/moooon-B-V/motir-core/actions/runs/36997956171)).
The `motir` inside each image is
[`@motir/cli@0.11.1`](https://www.npmjs.com/package/@motir/cli/v/0.11.1), the
same build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.11.1` — points at the same manifest.
It **was** the current release until `cli-v0.12.0`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists.

<!-- sandbox-digests:currency end -->

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the
token request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.11.1 | grep -i docker-content-digest
```

Two things CHECKED rather than assumed, by the release lane that wrote this
section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**
manifest as its `:<profile>-0.11.1` twin (9 of 9), and **every digest below
differs from its `cli-v0.9.0` row** (9 of 9) — an unchanged digest across a
version bump would mean a variant did not actually rebuild, which is a finding,
not a formatting detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:c383973ad8d36d4cbf8de8c667a44ba895acd3bf52417d73b63d2724a5e4ca77` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:5a9583786415e2d4d87c4f640d15bd3f3d6a5fbe55053acf060652144b6e5e30` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:50479c3fb6b8ec3867880ad8dec87c8cc71a49fad5cde031e3db661029705ecc` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:0db29a92ba66760e83f2d0f3474cdedab1c289f535f2005850c5ff57e442f980` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:37583af67e32c2731436246c3b1bd10a814857d931eb56e70558e6f95bba9857` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:2e13b39153ebd801dd11371280d18922712fd0716deaa218638c8515016b91a2` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:91133afa7cf0d3450b5a902087c22ebe00e58b9cda72ccc77fc764480e197572` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:e89d1f5bc22ce305daa248b5456b40164b72ea25ed0183b77f24b56e530ea8a5` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:8bcd74275f5f7fab436dfc6f49be9f239deee019a4fedc3f386d23d46aae5033` |

<!-- sandbox-digests:release cli-v0.9.0 -->

### Release `cli-v0.9.0`

([run 36720947162](https://github.com/moooon-B-V/motir-core/actions/runs/36720947162)).
The `motir` inside each image is
[`@motir/cli@0.9.0`](https://www.npmjs.com/package/@motir/cli/v/0.9.0), the same
build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.9.0` — points at the same manifest. It
**was** the current release until `cli-v0.11.1`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists.

<!-- sandbox-digests:currency end -->

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the
token request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.9.0 | grep -i docker-content-digest
```

Two things CHECKED rather than assumed, by the release lane that wrote this
section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**
manifest as its `:<profile>-0.9.0` twin (9 of 9), and **every digest below
differs from its `cli-v0.8.0` row** (9 of 9) — an unchanged digest across a
version bump would mean a variant did not actually rebuild, which is a finding,
not a formatting detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:9508103c4a12f4b35cc7495dd65b60b73d949cfeb9a59454ac2a472360c453fa` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:9124810e42305b896c5a808cdf1864f43b7f21ae23e53551ad68a0eef61facba` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:2a4d293f9c2bddb367f1213d6635df49d746c9b45b1b544e7f3294ae1d6e4041` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:3590bc9c15ad2995122f1c24e6a19aa4dd3d9dfa643ef5f6de117b9be5746b28` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:853ed13bd54389d1eee6f172789b8acd497a521d806fd00bb6fb548d7bee945b` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:dca709bb335f1fe0894c61365808e4eea804597681296cec7146ecda52d8c5b3` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:8361a914b4304df44e11a1aa56046cbdf27bc062f524cf4334bae6c465398f02` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:c44578c1b130326ca8d977e23495cafcaa49966cce6f2682e4a9afe1f22844b3` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:a3f958ff5de5a3bec713f43bcff46dd1498f69c11236e8f1c2a9eb67c922051f` |

<!-- sandbox-digests:release cli-v0.8.0 -->

### Release `cli-v0.8.0`

([run 36565335462](https://github.com/moooon-B-V/motir-core/actions/runs/36565335462)).
The `motir` inside each image is
[`@motir/cli@0.8.0`](https://www.npmjs.com/package/@motir/cli/v/0.8.0), the same
build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.8.0` — points at the same manifest. It
**was** the current release until `cli-v0.9.0`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists.

<!-- sandbox-digests:currency end -->

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the
token request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.8.0 | grep -i docker-content-digest
```

Two things CHECKED rather than assumed, by the release lane that wrote this
section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**
manifest as its `:<profile>-0.8.0` twin (9 of 9), and **every digest below
differs from its `cli-v0.7.0` row** (9 of 9) — an unchanged digest across a
version bump would mean a variant did not actually rebuild, which is a finding,
not a formatting detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:c9f3f4a92db797c947bcf1a0b94de52c7d121d616ab82e4547bae4907d2c345e` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:a4818309f70e055199c09d49294ee21696eaf087eb604c09d9e124f9015461d5` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:3bfbc772972b21c108d8fc43116e1e83a245620dccf539738dd37c83cbb5b70a` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:18cbbf04cf52bf7588662a2c3e42b4b3d0ed7cbba5e80a8ee72ebc70778e1770` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:9d552be5672602f36a5e97a6dbb3961c3f52fbd8d716ad54ed03a9c40cdf3d29` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:50241c4f86fb8cfd28593f57081084db7bd337abda5821780aeaec0d218a302b` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:65486618f4532cfde4c1d7d05fd30e87e6d565a605daf243d93d8efc74dea2e3` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:ab9ff288c6ad8bd9358e74f1ebe0e0ad52f594de3b90f660e9b57bfbef35cc82` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:5bcdf6fa8aed094190768f74a37525571dbf993c2471e17bd2405a89331eeb52` |

<!-- sandbox-digests:release cli-v0.7.0 -->

### Release `cli-v0.7.0`

([run 36446538828](https://github.com/moooon-B-V/motir-core/actions/runs/36446538828)).
The `motir` inside each image is
[`@motir/cli@0.7.0`](https://www.npmjs.com/package/@motir/cli/v/0.7.0), the same
build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.7.0` — points at the same manifest. It
**was** the current release until `cli-v0.8.0`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists.

<!-- sandbox-digests:currency end -->

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the
token request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.7.0 | grep -i docker-content-digest
```

Two things CHECKED rather than assumed, by the release lane that wrote this
section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**
manifest as its `:<profile>-0.7.0` twin (9 of 9), and **every digest below
differs from its `cli-v0.6.0` row** (9 of 9) — an unchanged digest across a
version bump would mean a variant did not actually rebuild, which is a finding,
not a formatting detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:120f90cc92008e54497d5013b3a14ecccec6d4d4bd80f06705070c1b8635b505` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:193902fb6e811239504f011f0b626c05295596412710ddd7bf15b8b3c9afbb3d` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:84da208e6207c4a1f777168f49eaef654b812e0c46f000bf21c2053a79de845b` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:3cc98365c466d42c01e72bd1b0b9d48081d4a5aeb048a54ec61b1ae3d590b26e` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:b34e4cccc60afcd4b371a1f48f2094b8c7f797519c77ef02c3920214bf38a072` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:c56e2eca460b6dc4e5a08934ce967103033146145a3b8657ad8d1b4b361e217d` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:b1e5db49c9dea0fff6203b4470fe1ae0b1c0a57019dca9bf344e52b0717605b7` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:3f64ef5f9add480cdaded6d24a68acc8269814a98acf1cd91f8fde0064d58b21` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:4bc52567af985c116d75451465ff085a4b47a64244960a42b09830bee7ac2be1` |

<!-- sandbox-digests:release cli-v0.6.0 -->

### Release `cli-v0.6.0`

([run 36213262310](https://github.com/moooon-B-V/motir-core/actions/runs/36213262310)).
The `motir` inside each image is
[`@motir/cli@0.6.0`](https://www.npmjs.com/package/@motir/cli/v/0.6.0), the same
build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.6.0` — points at the same manifest. It
**was** the current release until `cli-v0.7.0`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists.

<!-- sandbox-digests:currency end -->

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the
token request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.6.0 | grep -i docker-content-digest
```

Two things CHECKED rather than assumed, by the release lane that wrote this
section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**
manifest as its `:<profile>-0.6.0` twin (9 of 9), and **every digest below
differs from its `cli-v0.5.1` row** (9 of 9) — an unchanged digest across a
version bump would mean a variant did not actually rebuild, which is a finding,
not a formatting detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:1219b9f93d16f907f363f8948d14b1ea0658f2c80dc381aa6a3a3f420f57ac1a` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:f05759631bc44b7595b2e25c78562c047d6d951282cfdfc90e11180570c24ac6` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:e97c5de30d17bae9ec4cd61a9a6da23b9b014cb08ada789b111781dc5bc80552` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:69531ab96bce16494abbb3c4daaa3b60587d400a69587cbe14a11913d3b2f5b4` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:f71e5b61ffeb4f37836d4fd85978b0b35cb1122cc2d3a7cda7126ab656878b77` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:9476b220719e01a678e4c36eec623d9de4020fb3ec3b21558a2068e3a9c2fd10` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:6321c595ba363dbe8783d6367fcaa19dc655a426cd879e35915a689dedd459f3` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:d022566c3e9e6ef6cc797018391ab72ae04a830ed271f0995854b629ab32aa67` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:a8f0f7577b24e00110b74946f4cd0bfd1186b358ffe6d2b1da08d9aba294d38d` |

<!-- sandbox-digests:release cli-v0.5.1 -->

### Release `cli-v0.5.1`

([run 35973663477](https://github.com/moooon-B-V/motir-core/actions/runs/35973663477)).
The `motir` inside each image is
[`@motir/cli@0.5.1`](https://www.npmjs.com/package/@motir/cli/v/0.5.1), the same
build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.5.1` — points at the same manifest. It
**was** the current release until `cli-v0.6.0`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists.

<!-- sandbox-digests:currency end -->

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the
token request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.5.1 | grep -i docker-content-digest
```

Two things CHECKED rather than assumed, by the release lane that wrote this
section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**
manifest as its `:<profile>-0.5.1` twin (9 of 9), and **every digest below
differs from its `cli-v0.4.0` row** (9 of 9) — an unchanged digest across a
version bump would mean a variant did not actually rebuild, which is a finding,
not a formatting detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:fdd126c14ed70a1a582517aa511510d26c8fb19ab42d1bc56f06f3fcbe555cc2` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:a4c4f0079688585ad2a1474ce8399e51ce2723f7ce671808b7d06de30ffb8807` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:05125001a2c93f50a50d4f5e29a30850b2bff9b5adb4363a20a2155f3419c625` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:f38f5cb40ba573316cbda80850337f08e4f348b07b634a376b459df4d42e4f8e` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:2c2019e2e84e61d7aedf150620dba6116d552b4aa2ddf9eef50e65df567c9649` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:0c70a825a6163bcfffe10c1e554570aeb768af25448f2f9680ef4e0ad29d06e1` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:5ff54021e619b8388c6664204f638a80378f4f9bace423affb4482d5c077a02f` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:e36abb1db91b727e46349c362e44af828270e78d0b5ea1840dfe96e8c53d9925` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:9e7ef6667e77a0e06b8400e091b018064060f5a4915b21c1f9f43c501147864e` |

<!-- sandbox-digests:release cli-v0.4.0 -->

### Release `cli-v0.4.0`

([run 33314220333](https://github.com/moooon-B-V/motir-core/actions/runs/33314220333)).
The `motir` inside each image is
[`@motir/cli@0.4.0`](https://www.npmjs.com/package/@motir/cli/v/0.4.0), the same
build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.4.0` — points at the same manifest. It
**was** the current release until `cli-v0.5.1`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists.

<!-- sandbox-digests:currency end -->

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the
token request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.4.0 | grep -i docker-content-digest
```

Two things CHECKED rather than assumed, by the release lane that wrote this
section (MOTIR-2699): each moving `:<profile>` tag resolves to the **same**
manifest as its `:<profile>-0.4.0` twin (9 of 9), and **every digest below
differs from its `cli-v0.3.0` row** (9 of 9) — an unchanged digest across a
version bump would mean a variant did not actually rebuild, which is a finding,
not a formatting detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:f9cbcb5b8dfa560629c198a3c042235bb881a1669d3fa000824618a655f9259c` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:f602e5b9dec6cfc0b372dff83bc47b39cc2f56382ef34154a182c02d536a5c07` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:f8d508ba42a608acc23d86414e5428bc43bfc0f520f24766ce084b17961bad0f` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:555633be498751ad1ec02bd2212eb93b086125cffa0fe0ac84fa2e85ebd47cc5` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:a93952c5247d6cf37591928490db8c678a2698e94bde7b61b50bf7ad2854ec15` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:9513e74d5453587f7071e100ee69a542b3a37c51e4be0cac0ead8aed4c770f62` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:981b76ee2da55226b30977cd183c62d063594e5086542e4b8b8675f2271271b0` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:6b95949017c8a12d996da37e6619ffbbb9f359c0f8ef71b63c5de22e4e8f1bed` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:c7257e4727d5c4301fcfcb737baccb7583d532a2f8d23ef5d7272073f0d3d9cd` |

<!-- sandbox-digests:release cli-v0.3.0 -->

### Release `cli-v0.3.0`

([run 31529928332](https://github.com/moooon-B-V/motir-core/actions/runs/31529928332)).
The release whose 403 hint names a PERMISSION rather than one of the six retired
scopes (MOTIR-2572) — the `motir` inside each image is
[`@motir/cli@0.3.0`](https://www.npmjs.com/package/@motir/cli/v/0.3.0), the same
build npm serves.

<!-- sandbox-digests:currency start -->

Each row's immutable twin — `:<profile>-0.3.0` — points at the same manifest. It
**was** the current release until `cli-v0.4.0`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists.

<!-- sandbox-digests:currency end -->

It also carries the MOTIR-2532 rename, which `cli-v0.2.1` was meant to ship and
never did — that tag was prepared but never cut, so `0.2.0` is the version this
one supersedes on npm and there is no `0.2.1` row below.

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the token
request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.3.0 | grep -i docker-content-digest
```

Two things that check rather than assume, both verified at transcription time:
each moving `:<profile>` tag resolves to the **same** manifest as its
`:<profile>-0.3.0` twin (9 of 9), and **every digest below differs from its
`cli-v0.2.0` row** (9 of 9) — an unchanged digest across a version bump would
mean a variant did not actually rebuild, which is a finding, not a formatting
detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:f44c37d71abc267789ac8835d88846b50bd63c498d6729af25062c77035d6cfa` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:9d7222cb3700a96effe39c1f0cc7074df79138ee795b396bafb4bef1d4395f7e` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:ef3e1465f4d76e5a0f5fed6047486462078ef3c44e45f3c3bbd78a1a1a4bc2b8` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:bf3baebd0f4c2e337a58eaa3a9a505775548355f2b5396eaceb7725c2c5f433f` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:d705e5f6c8c1065676b3e1a9167b2389c60564711b712056636594eef8437cc8` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:00d8709bbcbcf00e39051cb0cf7feac2348f7227c79f170931408344bc66ffb2` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:7f0aa72d0edfaa232476a5584393c7e467edafb766fccc37554043619a055e2f` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:f24cd73e6dde5d9a17035e18eeb7ab460724616227fb688c0f5c01dab3c914fb` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:1439af41696f590095f3d7444f2bd0958cbff7b5bc8adddd5f61cf00213a7915` |

### Release `cli-v0.2.0`

([run 31280497216](https://github.com/moooon-B-V/motir-core/actions/runs/31280497216)).
The release that moved the CLI onto `/api/v1` (MOTIR-1855) — the `motir` inside
each image is [`@motir/cli@0.2.0`](https://www.npmjs.com/package/@motir/cli/v/0.2.0),
the same build npm serves. Each row's immutable twin — `:<profile>-0.2.0` — points
at the same manifest. It **was** the current release until `cli-v0.3.0`; the moving
`:<profile>` tags have since moved on and no longer point here, which is exactly
what a moving tag is for and why the immutable twin exists.

**Read from the registry, not from the run's job summary** (MOTIR-2220). Every
digest below is the `Docker-Content-Digest` GHCR returned for that tag, fetched
with a token minted from the anonymous endpoint — no `Authorization` on the token
request, so it is the answer a stranger gets, not the publisher's:

```sh
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:motir-co/motir-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/motir-co/motir-sandbox/manifests/claude-0.2.0 | grep -i docker-content-digest
```

Two things that check rather than assume, both verified at transcription time:
each moving `:<profile>` tag resolves to the **same** manifest as its
`:<profile>-0.2.0` twin (9 of 9), and **every digest below differs from its
`cli-v0.1.1` row** (9 of 9) — an unchanged digest across a version bump would
mean a variant did not actually rebuild, which is a finding, not a formatting
detail.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:518925114ac46bd3dbb061f947422b74773bbf83ee3a6a636d683a1f52ef6190` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:44d90222195f6bb6665fd8a9bf84bd631db41d39a1b77af473cb9878dc853904` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:74a585bbb4c8d0d228a2bc6e3b48d165f75e2ff612e0b62a443ed1ba6d9ef25c` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:594adcab904b75ff96b12f8120f2ce5aceb26b6a1cd941ecfdbf697d9986d783` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:bb3e40d8588c042b5e4bf990cdebee506c2e5f78255e483e58f51760a9230ecb` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:5609b0375bbf2e4b24f769b0884e8d1bfc0a822b204aab5f475cb5aaa6913d9b` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:534522c6571904961a5384252b90b14cb4770fbdf2dfe2f8797560bcc5a21bfd` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:846876bb174fd84fa353a57bc2a7b27748a0abac0b84e2d0e7377e6f5922f915` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:2a6a1f547fe4a918a967d0a98b592e7b2659d7b5e31f03996ab9ce1c92a24f95` |

### Release `cli-v0.1.1`

([run 30966874373](https://github.com/moooon-B-V/motir-core/actions/runs/30966874373)).
Each row's immutable twin — `:<profile>-0.1.1` — points at the same manifest.
It **was** the current release until `cli-v0.2.0`; the moving `:<profile>` tags
have since moved on and no longer point here, which is exactly what a moving tag
is for and why the immutable twin exists. Every digest below differs from its
`cli-v0.1.0` row, which is the whole point of the release — see [Current, and
asserted to be](#current-and-asserted-to-be-motir-2131).

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:f58990cf375dbe35c746f57e44bf47430f16089d4d21b0528f94e251358fe21a` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:aabc233887475ef147e24beb8f0703964e516087a2fc0988c7b87f470df0dfcc` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:a39149a096900db72a39bc5d012284a09e9481aade9f573a3751f6a4cdb71532` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:dda49f319f7b29b392996e0cba7ed81afa7c6018067bbce7c963e2a83b2d04a0` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:74b43a68481927a908dd0e84bb7e664d395d7bec34eea630e8667286e1caf6f4` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:f1a826c558a1eaf299b10256d7ce8250be35e7c17a648017d0b14d90fb6aec91` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:20e6ed2c3781b590a0e465e6bb7731da5d82319a2ee08affc37d6254c3eee8c0` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:1ae5866f83e9c36bfbb1ae2cd5f07dc0bbbc5013081e25cdfab2e7e8c360308b` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:f9fdbbcf3588dda3b84cb3e975f5c654d8d0e45558b0350776f73f36ccbccb41` |

### Release `cli-v0.1.0`

([run 30547054641](https://github.com/moooon-B-V/motir-core/actions/runs/30547054641)).
Each row's immutable twin — `:<profile>-0.1.0` — points at the same manifest.

| Tag                                          | Digest                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `ghcr.io/motir-co/motir-sandbox:base`        | `sha256:292289b41e97acc93f8f336ca31d4146a25941036e0199ca8e5e9e931262066e` |
| `ghcr.io/motir-co/motir-sandbox:claude`      | `sha256:be09575019378b707e229808a7d832f063afe6515dfe325371cf4b13f85362be` |
| `ghcr.io/motir-co/motir-sandbox:codex`       | `sha256:f1212309ebbd945cfb9cff398565e78f77225472defece899ccf311d0cbef0e6` |
| `ghcr.io/motir-co/motir-sandbox:opencode`    | `sha256:9a1f012847795029ffe5b015f320fc1485e658cd693adbd33bcad0e6b580ba4b` |
| `ghcr.io/motir-co/motir-sandbox:kimi`        | `sha256:e0aec4f3908fb64e60bda93ce260e0f598f6c7a502b3bb764aef5dc0f5cdc561` |
| `ghcr.io/motir-co/motir-sandbox:antigravity` | `sha256:3e0a1e5600ec86b9f7583f918be5ee5445caf75da85210b8bcf6abfd51be8496` |
| `ghcr.io/motir-co/motir-sandbox:cursor`      | `sha256:0955c69d320cc26af0882cc93205f2d38ac82770b963cec5076d714666d17b3c` |
| `ghcr.io/motir-co/motir-sandbox:aider`       | `sha256:dfbb31dd911a27b48d910a273a93980c5ff510c197b1c98de8130d6845265c9c` |
| `ghcr.io/motir-co/motir-sandbox:goose`       | `sha256:57d6e0e0024f3e8f57490d7e782e3745e7e399f5f1f1bd5f5af0a26fc49f38ac` |

### Public, and asserted to be (MOTIR-2010)

**No `docker login`, no token, no org membership.** The package is public, which
is what makes the `docker run` at the top of this file a real instruction rather
than an instruction-shaped sentence.

That is worth stating because it was once false and nothing noticed. `cli-v0.1.0`
built nine images, smoke-tested them, pushed them, pulled every one back by
digest, recorded the nine digests above, and went green — while the package was
**private**, so the first command in [`docs/cli.md`](../../../docs/cli.md)
returned `unauthorized` for everyone outside the org. The verify job pulled as
the _publisher_, and for a publisher a private package is perfectly pullable.
_Published_ and _obtainable_ are different claims, and only a caller with **no
credential** can tell them apart.

So the release lane now ends with a job that holds none:
[`smoke/assert-public.mjs`](smoke/assert-public.mjs) resolves every digest it
just pushed against GHCR with no `Authorization` header, from a job with no
registry login and no `packages:` scope, and fails the release if any of them
refuses. It probes a known-public repository first and reports INDETERMINATE if
_that_ fails — a broken probe answers "private" to everything, and "private" is
the answer it is hunting.

**It is ONE package, not nine.** Every profile is a TAG in the single OCI
repository `motir-co/motir-sandbox` — the registry says so itself, issuing the
same `scope="repository:motir-co/motir-sandbox:pull"` challenge for `:claude`,
`:codex` and `:base` alike. GHCR's visibility is a property of the package, so
one setting governs all eighteen tags. (Useful to know before touching it: the
public-visibility flip is UI-only and **irreversible** — see
[`docs/decisions/fleet-image-pull.md`](../../../docs/decisions/fleet-image-pull.md)
§4.1.)

Check it yourself, from any shell, credentials or not — the script never sends
one either way:

```sh
node packages/cli/sandbox/smoke/assert-public.mjs \
  --ref ghcr.io/motir-co/motir-sandbox:claude
```

### Current, and asserted to be (MOTIR-2131)

Obtainable is not the same claim as **up to date**, and the second one failed
next. Five days after `cli-v0.1.0` was cut, `:claude` was eleven commits behind
`main`: it greeted every new user with a credential banner naming _one_ of the
[three tiers](#three-ways-to-give-it-a-motir-credential) above and telling them
to log in on the host — the exact thing [`docs/cli.md`](../../../docs/cli.md)
§ The sandbox promises you do not have to do. `motir login` was not in the image
at all. Nothing noticed, and nothing could have: CI was green, the docs were
accurate about `main`, and `motir auto` in a normal console worked. None of
those consume the artifact.

**`cli-v0.1.1` is the release cut to close it** ([the table
above](#release-cli-v011)) — nine new digests, none of them equal to their
`cli-v0.1.0` row, built from a `main` that has carried `motir login` and the
three-tier banner since MOTIR-1877. The fix was to the published bytes, not to
`main`, which had been right the whole time. Note what that argument rests on,
though: it is build provenance, not an observation of the running image. Nothing
in CI asserts the banner's text — `assert-current.mjs` compares tags to commits
and `assert-public.mjs` asks the registry a question about access, and neither
one reads a line of output. Someone has to run the image and look.

Drift itself is expected here — [Publishing](#publishing) has no push-to-`main`
trigger on purpose, because a `:latest` that moves on every merge is not a
sandbox you can reproduce a run in. What was missing is a **tripwire on how
long the drift has sat**, so the gap surfaces before a user does:

```sh
node packages/cli/sandbox/smoke/assert-current.mjs
```

No Docker, no network, no credential — it compares the newest `cli-v*` tag
against your checkout and tells you what is unreleased, and for how long.
`.github/workflows/sandbox-staleness.yml` runs it daily and fails once the
oldest unreleased commit passes the window (three days by default —
`--max-age-days` moves it). It reports the drift even while it passes, so the
number is visible before it is fatal, and it distinguishes _drifted_ from
_bumped but never tagged_, which need opposite fixes.

⚠️ **The obvious version-only check would not have caught this.** Comparing
`packages/cli/package.json` to the newest tag is a real check — it catches a
release prepared and never cut — but on 2026-08-04 the version was `0.1.0` and
the tag was `cli-v0.1.0`, a perfect match, for the entire time the images were
wrong. Nobody forgot to tag a bump. Nobody bumped.

## What it confines — and what it does not

|                |                                                                                                                                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Filesystem** | Confined. The only host surfaces inside the container are a writable `/workspace` (your `.motir.json` tree) and, _if you mount one_, a **read-only** `~/.config/motir` (the PAT). With the environment tier there is exactly ONE host bind. No docker socket, no other host bind. |
| **Network**    | **Open, by design.** Every coding agent needs its provider API, and every dispatched item needs git remotes plus the Motir server. This image confines the filesystem blast radius, not egress — reach for docker's own `--network` controls if your threat model needs more.     |
| **Privileges** | Runs as the unprivileged `node` user (uid 1000), so files written into the mount stay owned by you rather than by root.                                                                                                                                                           |

A MOUNTED PAT is read-only because the container _consumes_ that credential and
never rotates it — so `motir login` cannot persist over a `:ro` bind, and says so
in one sentence rather than dying on an `EROFS` (the smoke lane asserts exactly
that). Minting a credential in here is a different matter and is supported:
start the container **without** the mount and run `motir login`, or hand it a
token with `MOTIR_TOKEN`. See [the three ways](#three-ways-to-give-it-a-motir-credential).

> **The CLI's own mutable state does not live beside the PAT.** The session
> exclude list (the ids `motir auto` skips after a failed agent) resolves from
> `MOTIR_STATE_HOME` → `MOTIR_CONFIG_HOME` → `XDG_STATE_HOME` →
> `~/.local/state/motir` — deliberately NOT the read-only config dir, which
> would give the CLI no writable state directory at all inside this image. That
> is not a hypothetical: it used to live there, and the write on the failure
> path aborted whole runs before their close-out (MOTIR-1836). Inside the
> container `~/.local/state` is the ephemeral layer, so the list is per-run;
> mount a writable path and point `MOTIR_STATE_HOME` at it if you want it to
> survive `--rm`. Nothing is lost if you don't — the list only avoids
> re-picking an item that just failed, and a failed item is already held out of
> the ready set by its status. If the store is unwritable wherever it lands, the
> CLI says so once and carries on.

## What is in it — the three runtimes (MOTIR-6204)

Everything an agent needs at run time has to be here at BUILD time. The
container is unprivileged and ships no `sudo`, so `apt-get install` inside it
answers `Could not open lock file /var/lib/dpkg/lock-frontend` and there is no
way around that from the inside. Three runtimes are therefore baked in.

| Runtime      | Version                                                   | Why that version                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Python 3** | 3.11 (`python3`, pinned)                                  | The corpus guards and the two sweep doors in `motir-meta` are Python. **Not `python3-minimal`** — that ships 81 modules rather than the standard library, and `json`, `shutil` and `difflib` are not among them. |
| **Postgres** | **16** + pgvector, `C.UTF-8`                              | The **consumer's**, not the newest — see below.                                                                                                                                                                  |
| **Browser**  | chromium via Playwright 1.62.1, plus its system libraries | The repositories this image serves resolve 1.62.x. `PLAYWRIGHT_BROWSERS_PATH=/opt/motir-browsers`, writable by `node`.                                                                                           |

### The database is for DEBUGGING — and that is why it is 18, production's major

`motir-sandbox-postgres` drives an initialised cluster that the image ships:

```sh
motir-sandbox-postgres start      # idempotent; prints the URL
motir-sandbox-postgres status
motir-sandbox-postgres psql       # a shell on the database
motir-sandbox-postgres reset      # drop + recreate the database, extension and all
motir-sandbox-postgres stop
```

`DATABASE_URL` is already set in the image to
`postgresql://prodect:prodect@localhost:5432/prodect` — the role, database and
port every CI job in these repositories uses — so a test command runs as typed.

**It is not started by the entrypoint**, deliberately: every devcontainer recipe
sets `"overrideCommand": true`, which replaces the ENTRYPOINT as well as the CMD
(the same fact behind MOTIR-4956), so an entrypoint start would work on the
`docker run` route and silently not on the VS Code one. Start it by name.

**What it is for:** running the few tests around a failure you are debugging.
**What it is not:** CI parity, or a full-suite runner. `fsync` is off and the
cluster dies with the container. A suite-wide number is the pull request's CI to
answer, not this.

**Three properties are load-bearing, and one of them is why this entry is pinned
to production's major rather than to the newest release:**

- **Postgres 18** — both production databases run 18 (18.6), and `motir-core`
  and `motir-ai` run 18 in compose and in CI to match (MOTIR-10221). The image
  pins 18.6 exactly. Any other major would debug against an engine neither
  production nor CI runs, so a reproduction would mean less, not more.
- **pgvector** — `motir-core`'s `work_item_embedding` migration and `motir-ai`'s
  `20260624000000_enable_pgvector` both run `CREATE EXTENSION vector`. Without
  it the migrations fail and no database test runs at all.
- **`C.UTF-8` collation** — `lib/workItems/positioning.ts` mints base-62
  fractional keys that mix cases, so `'Zz' < 'a0'` holds only under BYTE
  ordering. The last cluster that drifted to glibc's `en_US.utf8` turned eleven
  ordering assertions red across three Vitest shards, naming no cause. `reset`
  recreates the DATABASE and not the cluster, so the collation survives it by
  construction.

### The browser ships its libraries AND a binary

The system libraries are the half an unprivileged agent could never add, and a
downloaded browser will not launch without them. The binary is baked too —
which is where this image deliberately disagrees with `infra/ci-runner`, whose
header argues _against_ baking one. That runner is pulled fresh per job, so a
baked browser there trades a CDN download for an equal-sized registry pull; this
container is pulled once and lived in for days, so the same bytes are paid once
instead of per debugging session. A repository pinned to another Playwright
version runs `playwright install` itself — that download needs no privilege, and
`/opt/motir-browsers` is writable.

## Build it yourself

Everything below still works from a checkout — that is the path to take when you
are **customising a profile**, adding an agent, or running the image off an
unreleased commit. The build context is the motir-core repo **root** (the image
builds the `motir` binary from your checkout):

```sh
docker build -f packages/cli/sandbox/Dockerfile -t motir-sandbox:base .
```

A locally built image runs exactly like a pulled one — same mounts, same
entrypoint; only the image reference changes:

```sh
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$HOME/.config/motir:/home/node/.config/motir:ro" \
  -v "$HOME/.claude:/home/node/.claude:ro" \
  motir-sandbox:claude motir auto --agent "claude --dangerously-skip-permissions"
```

## Compose

Each profile is its own service, gated behind a compose profile of the same
name, so you build and run exactly the variant you asked for:

```sh
cd packages/cli/sandbox
docker compose --profile codex build
docker compose --profile codex run --rm sandbox-codex \
  motir auto --agent "codex exec --sandbox workspace-write --ask-for-approval never"
```

`MOTIR_WORKSPACE=/path/to/workspace` overrides which host directory is mounted
as `/workspace`; the default is the parent of this motir-core checkout.

**Every service passes `MOTIR_TOKEN` and `MOTIR_SERVER` through from your shell**,
so the compose form has the same mount-free credential path as `docker run`:
export the two variables and the `~/.config/motir` bind carries nothing the run
needs. The bind stays in the file because compose cannot express a conditional
mount (and it is still the right default on a host you have logged in on) — if
you want a container with genuinely no credential mount, which is also what
`motir login` inside the container requires, use the `docker run` form above.

## Dev container

`devcontainer/devcontainer.json` is the VS Code / `devcontainer` CLI variant of
the **base** image, and `devcontainer/<profile>/devcontainer.json` is the same
thing per agent — same `/workspace` folder, same read-only PAT mount, the
profile's `AGENT` build arg plus that agent's own read-only credential mount:

```sh
devcontainer up --workspace-folder . \
  --config packages/cli/sandbox/devcontainer/claude/devcontainer.json
```

Each variant also forwards `MOTIR_TOKEN` / `MOTIR_SERVER` from your local
environment (`remoteEnv`), so a dev container on a machine that never ran a host
login still resolves a credential — the same tier the `docker run` and compose
forms use.

To use one for your own workspace, copy the file to
`<your-workspace>/.devcontainer/devcontainer.json` and repoint `build.context` /
`build.dockerfile` at your motir-core checkout — **or** drop the whole `build`
block and pin the published image instead, which needs no checkout at all:

```jsonc
{
  "image": "ghcr.io/motir-co/motir-sandbox@sha256:<digest>",
  // …the same mounts / workspaceFolder the committed file carries
}
```

The committed files keep the `build` block because they are the _repo's_ dev
containers, and a checkout is exactly what those are for.

## Selecting an agent (`AGENT`)

`--build-arg AGENT=<profile>` selects which coding agent is layered on the base.
The profile ids are the ones in
[`src/agentProfiles.ts`](../src/agentProfiles.ts) — plus the default `base`,
which installs none. The selector lives in the Dockerfile; the layers it selects
live in [`install-agent.sh`](./install-agent.sh)'s case block.

```sh
docker build -f packages/cli/sandbox/Dockerfile \
  --build-arg AGENT=claude -t motir-sandbox:claude .
```

Motir is **BYOK and agent-agnostic**: these profiles make the popular CLIs
first-class, they do not make Motir depend on any of them. Nothing here
redistributes an agent — each layer fetches the third-party CLI from its
**official source at build time**, under that project's own licence. An agent
that is not listed still works via the tier-3 escape hatch below.

## The profile matrix

Tier 1 is first-class: install source **and** credential location are pinned.
Tier 2 is also-supported, with the credential path pinned only where the vendor
documents one.

| Profile       | Tier | Installed from                                                        | Binary                         | Credential mount (read-only)                           |
| ------------- | ---- | --------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| `claude`      | 1    | npm `@anthropic-ai/claude-code`                                       | `claude`                       | `~/.claude`                                            |
| `codex`       | 1    | npm `@openai/codex` (Apache-2.0)                                      | `codex`                        | `~/.codex`                                             |
| `opencode`    | 1    | npm `opencode-ai` (MIT)                                               | `opencode`                     | `~/.config/opencode` **and** `~/.local/share/opencode` |
| `kimi`        | 1    | npm `@moonshot-ai/kimi-code` (MIT)                                    | `kimi`                         | `~/.kimi-code`                                         |
| `antigravity` | 2    | `curl -fsSL https://antigravity.google/cli/install.sh \| bash`        | `agy`                          | — (OS keyring; see below)                              |
| `cursor`      | 2    | `curl https://cursor.com/install -fsS \| bash`                        | `agent` (alias `cursor-agent`) | `~/.local/share/cursor-agent`                          |
| `aider`       | 2    | PyPI `aider-chat` in a venv (Apache-2.0)                              | `aider`                        | `~/.aider.conf.yml` + a model key from the env         |
| `goose`       | 2    | `curl -fsSL …/goose/releases/download/stable/download_cli.sh \| bash` | `goose`                        | `~/.config/goose`                                      |

**Agents can update themselves in place (MOTIR-6183).** A sandbox may run for
weeks, so every agent is installed under `/opt/motir-agents`, a prefix the
container's `node` user owns — `NPM_CONFIG_PREFIX` points there and its `bin`
comes first on `PATH`. An agent's own updater (Claude Code's auto-update, or
`npm install -g <agent>@latest` by hand) can therefore write where the agent was
installed, with no rebuild: `/workspace`, your Motir sign-in, the agent's
sign-in and any running session are all kept.

- **An update lasts as long as the container.** Rebuild Container (VS Code) or a
  new `docker run` returns you to the image's version, which is the one CI built
  and tested. Nothing is on a volume, so pulling a newer image always takes effect.
- **`motir` is NOT in that prefix.** It and codegraph stay root-owned in
  `/usr/local`, so an agent can update itself but cannot rewrite the CLI that
  supervises it. `motir` itself updates by pulling the image.
- **Tier-2 agents install there too, but their updaters are the vendor's.**
  Whether `agy`, cursor's `agent`, `goose` or aider's pip write to the location
  they were installed in is not verified here.

### Auto-approve flags — VERIFIED, not remembered

An unattended run needs the agent to stop asking for approval, and **these flags
drift between releases**. Every entry below was re-checked against the vendor's
CURRENT documentation while writing this matrix; **re-verify before trusting one,
and treat a mismatch as the doc being stale, not the agent being broken.** Run
`<agent> --help` in the built image — that is the version you are actually
running.

| Profile       | Non-interactive                 | Auto-approve                                                                                                                       |
| ------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `claude`      | `-p` / `--print`                | `--dangerously-skip-permissions` (equivalent to `--permission-mode bypassPermissions`)                                             |
| `codex`       | `codex exec`                    | `--sandbox workspace-write --ask-for-approval never`; full bypass is `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) |
| `opencode`    | `opencode run "<prompt>"`       | `--auto` ("auto-approve permissions that are not explicitly denied")                                                               |
| `kimi`        | `-p` / `--prompt`               | none needed — `-p` already runs under the `auto` permission policy; interactively, `--yolo`                                        |
| `antigravity` | `-p` / `--print` / `--prompt`   | `--dangerously-skip-permissions`                                                                                                   |
| `cursor`      | `-p` / `--print`                | `--force` (alias `--yolo`) — without it, print mode only _proposes_ edits                                                          |
| `aider`       | `--message "<prompt>"` (`-m`)   | `--yes-always`                                                                                                                     |
| `goose`       | `goose run --no-session -t "…"` | `GOOSE_MODE=auto` — an **environment variable**, not a flag (`approve`/`smartapprove` refuse to run non-interactively)             |

> ⚠️ **`codex --full-auto` is deprecated upstream** and prints a warning; the
> card that planned this matrix still listed it as verified. Use `codex exec`
> with an explicit sandbox + approval policy instead. This is exactly why the
> flags are re-verified rather than carried forward.

So a full unattended run looks like:

```sh
docker compose --profile claude run --rm sandbox-claude \
  motir auto --agent "claude --dangerously-skip-permissions"
```

### Credentials

Every profile mounts its agent's credential path **read-only**, for the same
reason the Motir PAT is read-only: the container _consumes_ a credential and
never mints or rotates one. **Sign in on the host first**, then run the
container.

Three consequences worth knowing before you hit them:

- **The host path must exist.** Docker materialises a missing bind source as a
  root-owned empty directory, which then shadows the agent's own config. Sign in
  on the host (or `mkdir`/`touch` the path) before the first run — this applies
  especially to `aider`, whose mount is a single `~/.aider.conf.yml` **file**.
- **An agent that writes session state into its credential directory will fail
  to.** Claude Code and Kimi keep history/session data alongside their
  credentials, so a read-only mount makes those writes fail. Point the agent's
  state at the writable container home when it supports that (e.g. Kimi's
  `KIMI_CODE_HOME`), or drop `:ro` for that one profile if you accept the wider
  blast radius. Making this ergonomic per agent is 7.9.7c's smoke-matrix work.
- **`antigravity` mounts nothing, on purpose.** `agy` stores its token in the OS
  keyring (Keychain / Secret Service / Credential Manager) and documents no
  portable file, so there is nothing honest to mount — guessing a path would
  create an empty root-owned directory on your host. Authenticate _inside_ the
  container: the CLI detects a non-local shell and prints a copy-paste
  authorization URL. `goose` has the same keyring default, but it falls back to
  a file-based `secrets.yaml` in its config dir, which the profile sets
  `GOOSE_DISABLE_KEYRING=1` to force.

### Not shipped: Gemini CLI

There is **no `gemini` profile**, deliberately. Google's Gemini CLI is retired
and Antigravity CLI (`agy`) is its mandated replacement, so the sunset tool is
absent from the matrix rather than merely non-default. The sandbox test asserts
it stays absent.

## CodeGraph — the agent's own navigation graph

The image ships [CodeGraph](https://github.com/colbymchenry/codegraph) (the
engine the 7.5.3 spike selected) so the agent inside the container can ask
`callers` / `impact` / `explore` / `search` about the code it is editing instead
of grepping its way around an unfamiliar repo. Telemetry is off
(`CODEGRAPH_TELEMETRY=0`).

> ⚠️ This is the **coding agent's own per-container graph**, not `motir-ai`'s
> planner code graph (7.5.4). Same engine, different consumer, different store —
> nothing here talks to `motir-ai`.

Three moving parts:

1. **The binary**, in the base image — `codegraph --version` works in every
   profile, agent or not.
2. **The MCP server, wired per agent at build time** — `codegraph install
--target <id> --yes`, which also writes the auto-allow list so an unattended
   agent can call the tools instead of stopping to ask.
3. **The entrypoint**, which indexes the mounted `/workspace` on start and
   installs a `post-merge` + `post-checkout` git hook running `codegraph sync`,
   so the graph stays current as the branch advances.

### Which profiles get the MCP wiring

CodeGraph installs into the agents **it** has a target for — `claude`, `cursor`,
`codex`, `opencode`, `hermes`, `gemini`, `antigravity`, `kiro`. Five of the eight
profiles here intersect that set; the other three are left explicitly unwired
rather than pointed at a near-miss id (the same "leave it UNKNOWN rather than
guess" rule the credential column follows).

| Profile       | codegraph target | Config the agent actually reads                                         |
| ------------- | ---------------- | ----------------------------------------------------------------------- |
| `claude`      | `claude`         | `~/.motir-sandbox/agent-config/.claude/` (redirected, below)            |
| `codex`       | `codex`          | `~/.motir-sandbox/agent-config/.codex/config.toml` (redirected, below)  |
| `opencode`    | `opencode`       | `~/.motir-sandbox/agent-config/.config/opencode/opencode.jsonc` (ditto) |
| `cursor`      | `cursor`         | `~/.cursor/mcp.json`                                                    |
| `antigravity` | `antigravity`    | `~/.gemini/antigravity/mcp_config.json`                                 |
| `kimi`        | — none           | not wired                                                               |
| `aider`       | — none           | not wired (Aider is not an MCP client)                                  |
| `goose`       | — none           | not wired (no `goose` target in codegraph)                              |

The three redirected rows are why the next section exists: codegraph's own
default for them (`~/.claude/`, `~/.codex/config.toml`,
`~/.config/opencode/opencode.jsonc`) falls inside that agent's read-only
credential mount.

### When the credential mount would mask the wiring (7.9.7f, 7.9.7g)

For `claude`, `codex` and `opencode` the config file above lives _inside_ the
directory the compose/dev-container form mounts read-only from the host — so the
host's copy shadowed the one the image built in, and those agents saw no
codegraph tools at all under the recommended compose path.

All three are now pointed at a config home the **image** owns,
`~/.motir-sandbox/agent-config`, which sits outside every mounted path and so can
never be shadowed. The credential mounts are unchanged; nothing needs dropping.

| Profile    | Env var the entrypoint exports | Mechanism                                                                                                                                                                                                               |
| ---------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`   | `CLAUDE_CONFIG_DIR`            | `CLAUDE_CONFIG_DIR` governs the state file, `settings.json`, `CLAUDE.md` **and** `.credentials.json`, so the redirected dir is SEEDED from the read-only mount and codegraph then merges its stanza into that copy.     |
| `codex`    | `CODEX_HOME`                   | `CODEX_HOME` governs `config.toml` **and** `auth.json`, so the redirected home is SEEDED from the read-only mount (credential + your own `config.toml` come along) and codegraph then MERGES its stanza into that copy. |
| `opencode` | `OPENCODE_CONFIG`              | `OPENCODE_CONFIG` is MERGED over the global config rather than replacing it, so your mounted `~/.config/opencode` still applies and no credential is copied at all. Auth lives in the XDG **data** dir, untouched.      |

Every value in that table was **verified against the real CLIs** — claude 2.1.220,
codex 0.146.0, opencode 1.18.9, codegraph 1.5.0, each run against a scratch home
with the credential directory made unwritable to stand in for the `:ro` mount —
not read off their documentation. That is the same "leave an unverified
third-party path UNKNOWN rather than guess it" rule the credential column follows.

#### The `claude` profile, in detail (7.9.7g / MOTIR-1840)

`codegraph install --target claude --yes` writes **three** files, and the shipped
Claude Code CLI reads none of them where codegraph puts them:

| codegraph writes               | what it is                            | where Claude Code 2.1.220 reads it from |
| ------------------------------ | ------------------------------------- | --------------------------------------- |
| `<home>/.claude.json`          | the MCP **server** stanza             | `$CLAUDE_CONFIG_DIR/.claude.json`       |
| `<home>/.claude/settings.json` | the **auto-allow** list + prompt hook | `$CLAUDE_CONFIG_DIR/settings.json`      |
| `<home>/.claude/CLAUDE.md`     | the agent's codegraph instructions    | `$CLAUDE_CONFIG_DIR/CLAUDE.md`          |

`$CLAUDE_CONFIG_DIR` defaults to `~/.claude`, so the last two land inside the
read-only mount and are masked by the host's copies. The first is a **legacy
path the 2.x CLI no longer reads at all** — verified by `claude mcp list`, which
ignores a `~/.claude.json` holding the codegraph stanza. So this profile did not
merely stop to ask before calling the tools: it had no code-graph tools.

Pointing `CLAUDE_CONFIG_DIR` at `~/.motir-sandbox/agent-config/.claude` and
running `codegraph install` with `HOME=~/.motir-sandbox/agent-config` lines up two
of the three files exactly. The entrypoint then lifts the `mcpServers` key from
the third into the redirected state file — a **merge** of one key, so your own MCP
servers and the rest of Claude Code's state survive. A state file that is present
but unparseable is left alone and reported, never overwritten.

**The mount contract, amended — deliberately.** 7.9.7b's rule was that an agent
credential is mounted read-only and never copied. `codex` already had to break
that, and `claude` now does too: `CLAUDE_CONFIG_DIR` moves `.credentials.json`
along with everything else, so a redirect without a seed would trade "no
code-graph tools" for "not signed in". The reasoning is the same one the codex
seed rests on — **copying the credential to a second path inside the container
widens nothing**, because the container could always read the mounted file; what
the `:ro` mount actually guarantees, that the container cannot WRITE the host's
copy, still holds. What is copied is bounded and explicit
(`CLAUDE_SEED_ENTRIES` in `agent-config.sh`): the credential, the state file, your
settings, your `CLAUDE.md`, and `agents/` `commands/` `skills/` `plugins/`.
Session archives (`projects/`, `file-history/`, `history.jsonl`, …) are **not**
copied — they are per-machine state the container regenerates, and they are ~95%
of the directory's size on a working machine.

A side effect worth knowing: the redirected config dir is **writable**, where
`~/.claude` was mounted `:ro`. Claude Code can keep its own session state again
instead of failing to write it.

Two notes on the seam:

- **`MOTIR_SANDBOX_CODEGRAPH=0` skips the redirect too**, along with the rest of
  the block, leaving each agent on its own default config exactly as before.
- `cursor` and `antigravity` never needed any of this — their MCP server config
  sits outside the mounted path.

The entrypoint keeps its stderr warning as a backstop for any config path that is
still unwritable; it should no longer fire for a supported profile.

### Escape hatch

`MOTIR_SANDBOX_CODEGRAPH=0` skips indexing, hook installation and the wiring
refresh entirely — useful for a `--print`-only workflow or a build-matrix smoke
test. Nothing in this step can fail a run: the graph is an enhancement to how
well the agent reads the repo, never a precondition for doing the work, so every
step warns to stderr and carries on.

The hooks are written into `.git/hooks` (or `core.hooksPath`) of `/workspace` and
of each repository one level below it. They are **never** written over a hook you
already have, and because `.git/hooks` is untracked they outlive the container in
your host repo — so each one self-guards: with no `codegraph` on `PATH` it is a
silent no-op, and it always exits 0 so it can never fail a merge or a checkout.

### Tier 3 — any other agent

An agent not in the matrix is still supported, unchanged: build the base image
and give `motir auto` the full command.

```sh
docker compose --profile base run --rm sandbox \
  motir auto --agent "<your-cli> <its-unattended-flag>"
```

If the agent needs to be _inside_ the image, add a case arm to
`install-agent.sh` and a service to `docker-compose.yml` — that is the whole
extension surface. Adding it to `AGENT_PROFILES` without an arm fails the
sandbox test rather than silently falling through to "unknown AGENT".

## Validation

The build/smoke matrix lives in `.github/workflows/sandbox-images.yml` and runs
on every pull request (`ci.yml` calls it). It is the reason the claims on this
page can be believed rather than merely written down — and, because
[Publishing](#publishing) calls the very same workflow, it is also the release
gate: the push step is a later step of the job that just proved the image works,
so an image no smoke test touched cannot reach the registry.

### `Sandbox smoke (loop + failure + confinement)`

Builds the base image, then starts it **three times** — once per credential
recipe from [Run](#run), because whether a credential mount is present and
whether a token is in the environment are properties of how the container was
LAUNCHED, not something a script can simulate from inside one.

**Run 1 — with the read-only credential mount.** Five suites:

- **`runtimes-smoke.sh`** — the three runtimes, asserted **as `node`**, which is
  the point: each build layer already smoke-tests its own install as ROOT, and
  every one of those can pass on a runtime the container's own user cannot reach
  (that is MOTIR-6183's defect, one layer over). Python is asserted by the
  IMPORTS the corpus makes rather than by `--version` — `python3-minimal`
  answered `--version` perfectly while `SELECTOR.check.py` could not import
  `json`. Postgres is asserted by the debugging contract: it starts, it accepts
  a connection on `$DATABASE_URL`, `CREATE EXTENSION vector` succeeds, and
  `'Zz' < 'a0'` still orders by byte. The browser is LAUNCHED, because chromium
  without its system libraries exists and refuses to start. It runs first: a
  missing runtime explains any later failure, and nothing later explains it.

- **`confinement.sh`** — asserts the blast radius against `/proc/self/mounts`,
  the ground truth: `/workspace` is the one writable host bind, every credential
  bind is `ro`, **no other host path is mounted at all**, the container is
  unprivileged, and there is no docker socket or docker client. It also proves
  the system tree (`/`, `/etc`, `/usr/local/*`, `/opt`, `/var`) is not writable
  by the user the agent runs as.

  > **What "writes outside `/workspace` fail" does and does not mean.** `$HOME`
  > and `/tmp` **are** writable inside the container — every coding agent writes
  > caches, logs and sessions there, and an image that forbade it would run no
  > agent at all. Those writes are confined because they land in the container's
  > ephemeral layer and die with `--rm`, not because permissions stop them. The
  > host-blast-radius claim is the mount-table one, and that is what is asserted.

- **`loop-smoke.sh`** — runs `motir auto --agent <fake-agent>` end to end with
  **no LLM, no Motir deployment, no Postgres and no network**: a zero-dependency
  stub `/api/v1` server scripts the ready set, a fake agent does the integration,
  and every request is recorded so `assert-run.mjs` can check the SEQUENCE — one
  read of the ready set per iteration (never a batch read-ahead), each item's
  prompt fetched with the run's session branch as the seed, each flipped to In
  Progress before its agent is launched, each integration recorded on that same
  branch, and exactly ONE pull request at the end. A run that exited 0 having
  skipped the integration record fails this test.

  > **⚠️ The stub spoke MCP until 11.5.6 and answered every `GET` with a 405, so
  > from the moment the CLI moved to `/api/v1` the first request of every smoke
  > run failed (MOTIR-2436). It serves the real endpoints now, and its bodies are
  > checked against the CLI's own generated validators by
  > `packages/cli/test/sandboxStub.test.ts` — the v1 client rejects a response
  > that is only nearly right, so an approximate body would fail here in a Docker
  > matrix twenty minutes into CI rather than in the unit lane in milliseconds.**

- **`failure-smoke.sh`** — the same loop with an agent that **fails** partway
  through, which the happy path structurally cannot cover: the exclude store is
  only written on the failure path, so only a failing agent, under the real
  read-only credential mount, exercises it. It asserts that a run which
  integrated work and _then_ hit a failing agent still pushes its branch and
  opens its ONE pull request, reporting the failed item — the case
  `closeOutRepos` exists to guarantee and that MOTIR-1836 broke. Two legs: one
  with the state home writable (the store lands in `~/.local/state/motir` and
  the credential mount is never touched), one with `MOTIR_STATE_HOME` forced
  back onto the read-only mount (the run still closes out, warning instead of
  dying).

- **`readonly-login-smoke.sh`** — `motir login` under that same mount. The grant
  succeeds and there is then nowhere to put the token, which must surface as ONE
  sentence naming the fix (and pointing at `MOTIR_TOKEN`, the tier that needs no
  disk) — never an `EROFS`, never a stack trace, and with the mounted credential
  left byte-for-byte unchanged. A supported configuration used correctly must not
  read as a crash (MOTIR-1836 is that class of bug).

**Run 2 — no credential mount, `-e MOTIR_TOKEN -e MOTIR_SERVER`.**
`env-credential-smoke.sh` asserts the bind really is absent (against
`/proc/self/mounts`, so the leg cannot pass on a credential it was handed rather
than the one under test), then drives the whole `loop-smoke.sh` suite —
`motir ready` plus the full `motir auto` loop — on the environment tier alone.
This is the recipe CI and a fresh machine use, so it is smoke-tested as its own
case rather than assumed to follow from the mounted one.

**Run 3 — no mount and no token: a fresh machine.** `login-smoke.sh` runs
`motir login --no-browser` inside the container against the stub's device routes:
the code is printed grouped (`K4TP-9RXM`) with its URL, the approval is scripted
after one `authorization_pending` poll, and the minted credential is written to
the container's own `~/.config/motir/config.json` at mode 600. Then `motir ready`
reads the plan with nothing in the environment — which is the actual claim, not
that a file appeared.

Run it yourself — it needs nothing but docker:

```sh
packages/cli/sandbox/smoke/run.sh            # build + smoke
packages/cli/sandbox/smoke/run.sh --keep     # keep the fixture for inspection
```

### `Sandbox profile <id>`

One leg per profile, read from `smoke/profiles.json`: `docker build
--build-arg AGENT=<id>` from a clean checkout, then `motir --version` **and** the
agent's own liveness check, run in the finished image as the unprivileged `node`
user — which is what catches an installer that landed its binary somewhere only
root can reach.

**Tier 1 gates; Tier 2 is allow-fail — on the pull-request lane.** Tier-2
installers pull from vendor endpoints Motir does not control, so a network flake
there must not put a red X on an unrelated pull request — but the leg still runs
and is still reported, so a profile that broke for real still gets noticed. **On
the release lane every tier gates**: a release that quietly shipped six of eight
images, green, is worse than one that failed.

## Publishing

`.github/workflows/release-sandbox.yml`, on a `cli-v<x.y.z>` **tag** — the same
tag that releases [`@motir/cli`](../package.json) to npm, so the binary in the
image and the published package are the same version by construction. There is
deliberately no push-to-`main` trigger: a `:latest` that moves on every merge is
not a sandbox anyone can reproduce a run in.

```sh
# 1. bump packages/cli/package.json `version`, open + merge the PR
# 2. tag the merge commit
git tag cli-v0.2.0 && git push origin cli-v0.2.0
```

The tag fires the guard (tag version must equal `packages/cli/package.json`), then
the [validation](#validation) matrix with its push steps on, then **two**
post-deploy verification jobs, because there are two different claims to check:

1. **`sandbox-published`** pulls every image back **by digest** and runs `motir
--version` in it — "the push exited 0" and "the bytes are in the registry and
   they run" are not the same claim. Its summary prints the digest table, which is
   now a convenience rather than a handoff: the `readme` job below writes the
   table into [Published images](#published-images) itself.
2. **`sandbox-public`** asks whether a **stranger** can pull them, which the
   first job structurally cannot: it logs in, and a private package is pullable
   by its publisher. See [Public, and asserted to
   be](#public-and-asserted-to-be-motir-2010) for why that gap shipped nine
   unobtainable images green, and what closed it.

…and then a third job, which writes the record rather than checking a claim:

3. **`readme`** runs
   [`render-digest-table.mjs`](smoke/render-digest-table.mjs) against the
   registry, renders the [Published images](#published-images) section for this
   version, demotes the outgoing one to history, and commits the result on `main`
   (MOTIR-2699). It is the step that used to read _"copy its digest table into the
   sandbox README"_ and be done by hand — four releases running, one of which
   lapsed. Three things about it are load-bearing:
   - **It reads the digests from the registry ANONYMOUSLY**, never the values the
     push carried forward, and it cross-checks them against what the push
     recorded. A disagreement fails the release; nothing is written.
   - **The two invariants the section claims are asserted, not repeated.** A
     moving tag that has drifted from its immutable twin, or a digest unchanged
     since the previous release, is a red release rather than a green table.
   - **A release with nothing to change writes nothing.** Re-running a tag whose
     section is already exact produces no commit, rather than an empty one.

   It edits `main`, not the tag — a tag-triggered run checks out the tag's tree,
   and the file the record belongs in is the one on the branch.

   A pull request would fit this repository's manual-merge convention better, and
   is not available: the repository's Actions permissions have _"Allow GitHub
   Actions to create and approve pull requests"_ **off**, so `gh pr create` under
   the job's own `GITHUB_TOKEN` is a 403. The content is machine-derived and
   machine-checked — there is nothing in it for a reviewer to judge — so it is
   committed. Turn that setting on and this becomes a branch push plus one
   `gh pr create`.

Auth is the workflow's own `GITHUB_TOKEN` under a `packages: write` permission
block, granted on the release lane only. **No repository secret, no registry
account, nothing provisioned out of band** — and the pull-request lane, which has
no such block, cannot push even if it tried.

Five things worth knowing before your first release:

- **Something will tell you when the next one is overdue.** Because this lane
  fires only on a tag, `main` and the published image drift apart between
  releases by design — and drifted five days and eleven commits without anyone
  noticing once already (MOTIR-2131). `sandbox-staleness.yml` runs
  [`assert-current.mjs`](smoke/assert-current.mjs) daily and goes red when the
  oldest unreleased commit passes its window; see [Current, and asserted to
  be](#current-and-asserted-to-be-motir-2131). Run it yourself any time with
  `node packages/cli/sandbox/smoke/assert-current.mjs` — it needs nothing but a
  checkout with tags, and after a bump merges it will keep failing until the tag
  is pushed, naming the exact command.

- **Package visibility.** A GHCR package starts **private**. After the first
  successful release, make it public once at
  `https://github.com/orgs/moooon-B-V/packages/container/motir-sandbox/settings`
  — one flip, covering every tag, and **irreversible**. This bullet existed
  before `cli-v0.1.0` and the step was skipped anyway, which is exactly why the
  release now FAILS on it (`sandbox-public`) instead of merely mentioning it. Do
  it before the tag if you can; the failing job prints the same URL if you
  cannot.
- **`workflow_dispatch` with `dry_run: true`** runs the whole lane without
  pushing — how to validate a change to the release path without minting a
  version.
- **What "arm64 works" is actually backed by.** The runner is amd64, so that is
  the arch the liveness and smoke checks EXECUTE. The arm64 half is built under
  QEMU, where each install arm still runs its own `<agent> --version` at build
  time — a strong build-time check, not a run-time one. An agent whose vendor
  ships no arm64 binary therefore fails the RELEASE build rather than shipping a
  broken arm64 layer.
- **A Tier-2 vendor can block a release, on purpose.** Since every tier gates
  here, a vendor endpoint that is down at tag time fails the run. Re-run the
  failed job once the vendor recovers (the guard is idempotent — re-tagging is
  not needed), or drop that profile from `smoke/profiles.json` and
  `AGENT_PROFILES` if it is gone for good. Do not "fix" it by publishing a
  partial set: the verification job fails on a missing digest precisely so a
  short release cannot pass as a complete one.

Not in scope here, deliberately: signing / SBOM / provenance attestation (a real
hardening concern, and its own decision — half of it would be worse than none),
and the **hosted** run image, which is 9.1.3 / 9.1.4's separate registry.

### A partial release, and re-running one (MOTIR-10884)

`cli-v0.17.2` built and smoke-tested all nine images, then GHCR refused six of
the pushes with an intermittent `denied: permission_denied: write_package`. The
run ended red, every check of the published set above was skipped because each
needs every leg, and nothing said which images were missing. The lane now
handles that in three places:

- **A refused push is retried, and only a push.** Each image is built for both
  architectures in one step and pushed in the next, through
  [`push-with-retry.mjs`](smoke/push-with-retry.mjs): a registry refusal
  (`denied`, `unauthorized`, a 5xx, a 429, a timeout) is retried up to three
  times with a 30 s then 60 s backoff, re-pushing the image already built. A
  build failure is never retried.
- **`sandbox-complete` names what is missing.** Once every leg has ended,
  however it ended, it asks the registry anonymously for each name's
  `:<name>-<version>` tag ([`release-set.mjs verify`](smoke/release-set.mjs)) and
  fails naming each image the release lacks.
- **A re-run builds only the gap.** Before anything is built, the setup job asks
  the same question (`release-set.mjs plan`) and the matrix runs only the
  profiles that have no tag at this version; the base job is skipped when
  `:base-<version>` exists. The digests already published are handed to the
  verify jobs and the record, so they see the whole release. To finish a partial
  release, re-run its tag's workflow run ("Re-run all jobs"), or dispatch
  `Release sandbox images` on the tag ref:

```sh
gh workflow run release-sandbox.yml --ref cli-v<x.y.z>
```

A dispatch does not write the README record, which runs on a tag push only.

## Files

| File                             | What it is                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                     | The base image: Node floor assertion, git + `gh`, the three runtimes (Python, the debugging Postgres, the browser), the packed `motir` binary, the CodeGraph engine, the `AGENT` selector, the unprivileged user and the `/workspace` entrypoint.                                                                            |
| `install-agent.sh`               | The per-agent layer seam invoked by the `AGENT` build arg — one case arm per profile, each smoke-testing the binary it installs and wiring the codegraph MCP server where codegraph has a target.                                                                                                                            |
| `fetch-installer.sh`             | Sourced by `install-agent.sh`: downloads a vendor's install script to a file, decodes a gzip body, requires a `#!` shebang and a clean `bash -n`, and retries (3 attempts, backoff) before anything runs it — no arm pipes a remote script into a shell.                                                                     |
| `postgres.sh`                    | Installed as `motir-sandbox-postgres`: start / stop / status / reset / psql for the debugging cluster the image ships. A named command rather than entrypoint work, because `overrideCommand: true` means the devcontainer route never runs the entrypoint.                                                                  |
| `entrypoint.sh`                  | Verifies the mounts, names all three credential paths when none is present, redirects the three agents whose codegraph config a `:ro` mount would mask, indexes `/workspace` with CodeGraph and installs its git sync hooks, drops into `/workspace`, `exec`s your command. All output on stderr so stdout stays pipe-clean. |
| `docker-compose.yml`             | The compose form — one service + compose profile per agent, each passing `MOTIR_TOKEN` / `MOTIR_SERVER` through and mounting its agent credential.                                                                                                                                                                           |
| `devcontainer/devcontainer.json` | The dev-container form of the base image.                                                                                                                                                                                                                                                                                    |
| `devcontainer/<profile>/`        | The dev-container form of each agent profile.                                                                                                                                                                                                                                                                                |
| `smoke/run.sh`                   | The validation driver: build the image, then run it through each documented credential recipe — mounted, env-only, and nothing-at-all — executing the suites that belong to each.                                                                                                                                            |
| `smoke/confinement.sh`           | The blast-radius assertions, read from `/proc/self/mounts` rather than from this page.                                                                                                                                                                                                                                       |
| `smoke/runtimes-smoke.sh`        | The three runtimes asserted AS `node`: the stdlib the corpus imports, and for Postgres the DEBUGGING contract rather than a version string — it starts, it accepts the documented URL, `CREATE EXTENSION vector` succeeds, and `Zz` sorts before `a0`.                                                                       |
| `smoke/loop-smoke.sh`            | `motir auto --agent <fake-agent>` end to end inside the image — builds its own git fixture, needs no LLM and no server.                                                                                                                                                                                                      |
| `smoke/failure-smoke.sh`         | The failure path: an agent that dies mid-run must still cost nothing — the branch is pushed and the pull request opened, with the store writable and unwritable.                                                                                                                                                             |
| `smoke/env-credential-smoke.sh`  | The mount-free environment tier: proves the bind is absent, then runs the whole loop on `MOTIR_TOKEN` alone.                                                                                                                                                                                                                 |
| `smoke/login-smoke.sh`           | `motir login` performed INSIDE the container — device grant, approval, a credential written to its own config dir, and a read that uses it.                                                                                                                                                                                  |
| `smoke/readonly-login-smoke.sh`  | The same login under the `:ro` mount: it must refuse in one sentence naming the fix, write nothing, and never leak an `EROFS`.                                                                                                                                                                                               |
| `smoke/stub-server.mjs`          | A zero-dependency `/api/v1` server scripting the ready set, recording every request — plus the two device-grant routes `motir login` speaks. Its bodies are validated against the generated client by `packages/cli/test/sandboxStub.test.ts`.                                                                               |
| `smoke/fake-agent.sh`            | The scripted agent: verifies the prompt arrived on BOTH delivery channels, integrates onto the session branch, exits 0.                                                                                                                                                                                                      |
| `smoke/failing-agent.sh`         | The scripted agent that refuses ONE named item and delegates the rest — so the run has real integrated work behind it when the failure lands.                                                                                                                                                                                |
| `smoke/assert-run.mjs`           | Asserts the recorded request SEQUENCE — the thing an exit code cannot tell you.                                                                                                                                                                                                                                              |
| `smoke/assert-public.mjs`        | Asks whether a STRANGER can pull what the release just pushed — a manifest probe that sends no `Authorization` header and checks a known-public control first. Three-valued: public / private-or-absent / could not tell.                                                                                                    |
| `smoke/assert-current.mjs`       | Asks whether the published image is still what `main` says it is — compares the newest `cli-v*` tag against a checkout and fails once unreleased work has SAT past its window. Needs no Docker, network or credential.                                                                                                       |
| `smoke/render-digest-table.mjs`  | Writes § Published images. Resolves every published tag anonymously, asserts the two invariants the section claims, renders the release section and demotes the outgoing one — so the digest table is produced by the release rather than retyped from its job summary.                                                      |
| `smoke/profiles.json`            | The CI build/liveness matrix: one entry per profile, read by the workflow so adding an agent extends CI on its own.                                                                                                                                                                                                          |

Three workflow files sit outside this directory: the build/smoke/publish matrix
itself, `.github/workflows/sandbox-images.yml`; the tagged release lane that
calls it with publishing on, `.github/workflows/release-sandbox.yml`; and the
daily drift tripwire, `.github/workflows/sandbox-staleness.yml`.

The image sources' invariants (the read-only PAT mount, the absence of a docker
socket, the Node floor, the seam covering every agent profile, the codegraph
wiring and its sync hooks) are asserted by
[`test/sandbox.test.ts`](../test/sandbox.test.ts); the validation harness and the
release lane are guarded against drift by
[`test/sandboxCi.test.ts`](../test/sandboxCi.test.ts).
