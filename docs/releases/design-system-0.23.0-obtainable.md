# `@motir/design-system@0.23.0` is obtainable by a stranger, and it is MIT

**Card:** MOTIR-11357 · **Read on:** 2026-11-19 (UTC) · **Version under test:** `0.23.0`

This is the artifact-side record for the design system's first MIT release. It reads
what the **public npm registry serves** to somebody with no npm account. It does not
read what the release pipeline reported. Every value below sits beside the command
that produced it, and each output is pasted from that command's run. Nothing was
retyped, and nothing was installed or pinned in any repository.

## Verdict

**Pass.** Every line of the card's pass condition holds:

| Check                                            | Read                                                                                                            | Result                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Version under test is the release record's       | MOTIR-11358 publish record: `@motir/design-system@0.23.0`, tag `design-system-v0.23.0`, publish run 43717838160 | `0.23.0`                                                                                                         |
| That version is in the registry's published list | `npm view @motir/design-system versions --json`                                                                 | present, between `0.22.4` and `0.24.0`                                                                           |
| Reader held no credential                        | `npm whoami` under an empty user and global config                                                              | `ENEEDAUTH`, exit 1                                                                                              |
| Effective registry is the public one             | `npm config get registry`                                                                                       | `https://registry.npmjs.org/`                                                                                    |
| Advertised licence for that exact version        | `npm view @motir/design-system@0.23.0 license version --json`                                                   | `"license": "MIT"`                                                                                               |
| Version is not 0.22.x                            | same read                                                                                                       | `"version": "0.23.0"`                                                                                            |
| Tarball pulled with no credential                | `npm pack @motir/design-system@0.23.0 --json`                                                                   | `motir-design-system-0.23.0.tgz`, exit 0                                                                         |
| Tarball digest                                   | pack output, registry `dist`, local `sha1sum` / `openssl`                                                       | shasum `6c526d432f28e6126726de34f22c5b6696eacc54` and integrity `sha512-vkEf…A3LQ==`, identical across all three |
| Licence file in the tarball                      | `tar -tzf` root entries                                                                                         | `LICENSE`, `README.md`, `dist`, `package.json`, `theme.css`                                                      |
| Licence text in the tarball                      | `tar -xzOf … package/LICENSE`                                                                                   | MIT License, `Copyright (c) 2026 moooon B.V.`                                                                    |
| Manifest in the tarball                          | `tar -xzOf … package/package.json`                                                                              | `"version": "0.23.0"`, `"license": "MIT"`                                                                        |
| Provenance (recorded, not a criterion)           | registry `dist.attestations`                                                                                    | `https://registry.npmjs.org/-/npm/v1/attestations/@motir%2fdesign-system@0.23.0`, SLSA provenance v1             |

`latest` reads `0.24.1` today. **No reading here uses `latest`.** Every read names
`@0.23.0` explicitly. The dist-tags read is recorded only to show that `latest` has
moved past the version under test.

## 1. The version under test comes from the release record

The version under test is not chosen here. MOTIR-11358 (the post-merge card) closed
with this publish record: **`@motir/design-system@0.23.0`**, tag
`design-system-v0.23.0` → `d60207b22dca87ce6e88f55d190dd4dcdb38f226`, release run
43717421885 pushed the tag, and publish run 43717838160 executed `npm publish` with
provenance. Every command below addresses `0.23.0` by name.

## 2. The reader is a stranger, shown before any read

The script ran in a new `mktemp -d` directory under `/tmp`, outside every
repository. `HOME` pointed at an empty directory. `NPM_CONFIG_USERCONFIG` and
`NPM_CONFIG_GLOBALCONFIG` pointed at two empty files, and `NPM_CONFIG_CACHE` at a
new directory. `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `npm_config__auth` and any registry
override were unset.

```console
$ pwd
/tmp/motir-11357-GfoWSW
```

Exit status: `0`.

```console
$ ls -A
global.npmrc
home
user.npmrc
```

Exit status: `0`.

```console
$ git rev-parse --show-toplevel
fatal: not a git repository (or any of the parent directories): .git
```

Exit status: `128`.

```console
$ node --version
v22.23.5
```

Exit status: `0`.

```console
$ npm --version
10.9.9
```

Exit status: `0`.

```console
$ env | grep -iE "^(npm_config_|NPM_)?(_?auth|token)" | cut -d= -f1
```

Exit status: `0`.

No auth or token variable is set: the output is empty.

```console
$ npm config get userconfig
/tmp/motir-11357-GfoWSW/user.npmrc
```

Exit status: `0`.

```console
$ npm config get globalconfig
/tmp/motir-11357-GfoWSW/global.npmrc
```

Exit status: `0`.

```console
$ npm whoami
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in.
npm error need auth You need to authorize this machine using `npm adduser`
npm error A complete log of this run can be found in: /tmp/motir-11357-GfoWSW/cache/_logs/2026-11-19T01_06_42_200Z-debug-0.log
```

Exit status: `1`.

```console
$ npm config get registry
https://registry.npmjs.org/
```

Exit status: `0`.

The session's network proxy lists `registry.npmjs.org` in `npm_config_noproxy`, so
npm connects straight to the public registry. It does not go through a mirror.

## 3. What the registry advertises for `0.23.0`

```console
$ npm view @motir/design-system@0.23.0 license version --json
{
  "license": "MIT",
  "version": "0.23.0"
}
```

Exit status: `0`.

```console
$ npm view @motir/design-system@0.23.0 dist --json
{
  "shasum": "6c526d432f28e6126726de34f22c5b6696eacc54",
  "tarball": "https://registry.npmjs.org/@motir/design-system/-/design-system-0.23.0.tgz",
  "fileCount": 135,
  "integrity": "sha512-vkEfDQjUe4RyhwysTwwIlNFwqdGC5s2q5z+4SRxrrYF9c6hvRuLB1qT5bGryXj6+Xu+U5SKrSVfo3A3X90A3LQ==",
  "signatures": [
    {
      "sig": "MEQCIHaEPr+vsbW2DMkUfkkiuBphEGUnNqa1BTiR96aS28H+AiAssYmezmQbJvqHwFUJ6QlFn1s4nav+KuTMGlBdvwmqPQ==",
      "keyid": "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U"
    },
    {
      "sig": "MEUCIF72o+lAmV4H0EYRQVZYDj5VEhgxW2vJ77pDzX0/ihQuAiEAojZde4CIM6oE+KVo0ZURg9cPwGjE9A/7bh3h4qdo3mo=",
      "keyid": "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U"
    }
  ],
  "attestations": {
    "url": "https://registry.npmjs.org/-/npm/v1/attestations/@motir%2fdesign-system@0.23.0",
    "provenance": {
      "predicateType": "https://slsa.dev/provenance/v1"
    }
  },
  "unpackedSize": 2577359
}
```

Exit status: `0`.

```console
$ npm view @motir/design-system versions --json
[
  "0.1.0",
  "0.1.1",
  "0.1.2",
  "0.1.3",
  "0.2.0",
  "0.3.0",
  "0.4.0",
  "0.4.1",
  "0.4.2",
  "0.4.3",
  "0.5.0",
  "0.5.1",
  "0.6.0",
  "0.7.0",
  "0.8.0",
  "0.8.1",
  "0.8.2",
  "0.10.0",
  "0.10.1",
  "0.11.0",
  "0.12.0",
  "0.13.0",
  "0.14.0",
  "0.15.1",
  "0.17.0",
  "0.17.1",
  "0.18.0",
  "0.19.0",
  "0.20.0",
  "0.21.0",
  "0.21.1",
  "0.21.2",
  "0.21.3",
  "0.21.4",
  "0.22.0",
  "0.22.1",
  "0.22.2",
  "0.22.3",
  "0.22.4",
  "0.23.0",
  "0.24.0",
  "0.24.1"
]
```

Exit status: `0`.

```console
$ npm view @motir/design-system dist-tags --json
{
  "latest": "0.24.1"
}
```

Exit status: `0`.

## 4. The tarball, pulled the way a consumer pulls it

`npm pack` ran under the same empty configuration, in the same empty directory. The
full `files` array it printed is the 135-entry listing in section 5; it is shortened
here.

```console
$ npm pack @motir/design-system@0.23.0 --json
[
  {
    "id": "@motir/design-system@0.23.0",
    "name": "@motir/design-system",
    "version": "0.23.0",
    "size": 724490,
    "unpackedSize": 2577359,
    "shasum": "6c526d432f28e6126726de34f22c5b6696eacc54",
    "integrity": "sha512-vkEfDQjUe4RyhwysTwwIlNFwqdGC5s2q5z+4SRxrrYF9c6hvRuLB1qT5bGryXj6+Xu+U5SKrSVfo3A3X90A3LQ==",
    "filename": "motir-design-system-0.23.0.tgz",
    "files": [
      {
        "path": "LICENSE",
        "size": 1068,
        "mode": 420
      },
      … 134 further entries, shortened here …
    ],
    "entryCount": 135,
    "bundled": []
  }
]
```

Exit status: `0`.

```console
$ ls -l motir-design-system-0.23.0.tgz
-rw-r--r-- 1 root root 724490 Nov 19 01:06 motir-design-system-0.23.0.tgz
```

Exit status: `0`.

```console
$ sha1sum motir-design-system-0.23.0.tgz
6c526d432f28e6126726de34f22c5b6696eacc54  motir-design-system-0.23.0.tgz
```

Exit status: `0`.

```console
$ printf 'sha512-'; openssl dgst -sha512 -binary motir-design-system-0.23.0.tgz | base64 -w0; echo
sha512-vkEfDQjUe4RyhwysTwwIlNFwqdGC5s2q5z+4SRxrrYF9c6hvRuLB1qT5bGryXj6+Xu+U5SKrSVfo3A3X90A3LQ==
```

Exit status: `0`.

The shasum and integrity computed locally from the downloaded bytes match the pack
output and the registry's `dist` block exactly.

## 5. What is inside the tarball

```console
$ tar -tzf motir-design-system-0.23.0.tgz | awk -F/ '{print $2}' | sort -u
LICENSE
README.md
dist
package.json
theme.css
```

Exit status: `0`.

The tarball has five root entries. These are the four that 0.22.4 already shipped
(`dist`, `package.json`, `README.md`, `theme.css`) plus **`LICENSE`**, which no
earlier version carried. The manifest's `files` list still names only `dist` and
`theme.css`, so `LICENSE` and `README.md` are in the tarball by npm's
always-include rule. This is the first reading of that rule against this package's
real artifact.

<details>
<summary>Full listing: <code>tar -tzf motir-design-system-0.23.0.tgz</code> (135 entries)</summary>

```console
$ tar -tzf motir-design-system-0.23.0.tgz
package/LICENSE
package/theme.css
package/dist/theme/appearance-resolution.js
package/dist/appearance.js
package/dist/components/theme/AppearancePickers.js
package/dist/components/ui/Button.js
package/dist/components/ui/Card.js
package/dist/components/ui/Checkbox.js
package/dist/utils/cn.js
package/dist/components/ui/ColorSwatchPicker.js
package/dist/components/ui/Combobox.js
package/dist/components/ui/DatePicker.js
package/dist/components/ui/datePickerFormat.js
package/dist/components/ui/DatePickerFormatContext.js
package/dist/components/ui/EmptyState.js
package/dist/components/ui/ErrorState.js
package/dist/theme/fontSets.js
package/dist/components/ui/FormField.js
package/dist/utils/fullscreen.js
package/dist/components/theme/HandDrawnFilter.js
package/dist/components/theme/ImmersiveTilt.js
package/dist/index.js
package/dist/mock/index.js
package/dist/theme/init-script.js
package/dist/components/ui/Input.js
package/dist/components/ui/Modal.js
package/dist/components/ui/MultiSelectPicker.js
package/dist/theme/palettes.js
package/dist/components/ui/Pill.js
package/dist/components/ui/Popover.js
package/dist/mock/pruneUnmatchedRules.js
package/dist/mock/renderMock.js
package/dist/components/ui/SectionLabel.js
package/dist/components/ui/Segmented.js
package/dist/components/ui/Spinner.js
package/dist/theme/styles.js
package/dist/components/theme/StyleVignette.js
package/dist/components/ui/Switch.js
package/dist/components/ui/Textarea.js
package/dist/contexts/theme-context.js
package/dist/theme/tilt.js
package/dist/components/ui/Toast.js
package/dist/specimen/TokensSpecimen.js
package/dist/components/ui/Tooltip.js
package/dist/theme/types.js
package/dist/theme/typography.js
package/package.json
package/dist/theme/appearance-resolution.js.map
package/dist/appearance.js.map
package/dist/components/theme/AppearancePickers.js.map
package/dist/components/ui/Button.js.map
package/dist/components/ui/Card.js.map
package/dist/components/ui/Checkbox.js.map
package/dist/utils/cn.js.map
package/dist/components/ui/ColorSwatchPicker.js.map
package/dist/components/ui/Combobox.js.map
package/dist/components/ui/DatePicker.js.map
package/dist/components/ui/datePickerFormat.js.map
package/dist/components/ui/DatePickerFormatContext.js.map
package/dist/components/ui/EmptyState.js.map
package/dist/components/ui/ErrorState.js.map
package/dist/theme/fontSets.js.map
package/dist/components/ui/FormField.js.map
package/dist/utils/fullscreen.js.map
package/dist/components/theme/HandDrawnFilter.js.map
package/dist/components/theme/ImmersiveTilt.js.map
package/dist/mock/index.js.map
package/dist/theme/init-script.js.map
package/dist/components/ui/Input.js.map
package/dist/components/ui/Modal.js.map
package/dist/components/ui/MultiSelectPicker.js.map
package/dist/theme/palettes.js.map
package/dist/components/ui/Pill.js.map
package/dist/components/ui/Popover.js.map
package/dist/mock/pruneUnmatchedRules.js.map
package/dist/mock/renderMock.js.map
package/dist/components/ui/SectionLabel.js.map
package/dist/components/ui/Segmented.js.map
package/dist/components/ui/Spinner.js.map
package/dist/theme/styles.js.map
package/dist/components/theme/StyleVignette.js.map
package/dist/components/ui/Switch.js.map
package/dist/components/ui/Textarea.js.map
package/dist/contexts/theme-context.js.map
package/dist/theme/tilt.js.map
package/dist/components/ui/Toast.js.map
package/dist/specimen/TokensSpecimen.js.map
package/dist/components/ui/Tooltip.js.map
package/dist/theme/types.js.map
package/dist/theme/typography.js.map
package/README.md
package/dist/theme/appearance-resolution.d.ts
package/dist/appearance.d.ts
package/dist/components/theme/AppearancePickers.d.ts
package/dist/components/ui/Button.d.ts
package/dist/components/ui/Card.d.ts
package/dist/components/ui/Checkbox.d.ts
package/dist/utils/cn.d.ts
package/dist/components/ui/ColorSwatchPicker.d.ts
package/dist/components/ui/Combobox.d.ts
package/dist/components/ui/DatePicker.d.ts
package/dist/components/ui/datePickerFormat.d.ts
package/dist/components/ui/DatePickerFormatContext.d.ts
package/dist/components/ui/EmptyState.d.ts
package/dist/components/ui/ErrorState.d.ts
package/dist/theme/fontSets.d.ts
package/dist/components/ui/FormField.d.ts
package/dist/utils/fullscreen.d.ts
package/dist/components/theme/HandDrawnFilter.d.ts
package/dist/components/theme/ImmersiveTilt.d.ts
package/dist/index.d.ts
package/dist/mock/index.d.ts
package/dist/theme/init-script.d.ts
package/dist/components/ui/Input.d.ts
package/dist/components/ui/Modal.d.ts
package/dist/components/ui/MultiSelectPicker.d.ts
package/dist/theme/palettes.d.ts
package/dist/components/ui/Pill.d.ts
package/dist/components/ui/Popover.d.ts
package/dist/mock/pruneUnmatchedRules.d.ts
package/dist/mock/renderMock.d.ts
package/dist/components/ui/SectionLabel.d.ts
package/dist/components/ui/Segmented.d.ts
package/dist/components/ui/Spinner.d.ts
package/dist/theme/styles.d.ts
package/dist/components/theme/StyleVignette.d.ts
package/dist/components/ui/Switch.d.ts
package/dist/components/ui/Textarea.d.ts
package/dist/contexts/theme-context.d.ts
package/dist/theme/tilt.d.ts
package/dist/components/ui/Toast.d.ts
package/dist/specimen/TokensSpecimen.d.ts
package/dist/components/ui/Tooltip.d.ts
package/dist/theme/types.d.ts
package/dist/theme/typography.d.ts
```

Exit status: `0`.

</details>

```console
$ tar -xzOf motir-design-system-0.23.0.tgz package/package.json
{
  "name": "@motir/design-system",
  "version": "0.23.0",
  "description": "Motir's 3-axis design system (colour · style · type): distributable token CSS, the axis registries, the theme-apply API, and framework-agnostic React primitives. Shared by motir-core and planner-scaffolded products.",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/motir-co/motir-core.git",
    "directory": "packages/design-system"
  },
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./mock": {
      "types": "./dist/mock/index.d.ts",
      "import": "./dist/mock/index.js"
    },
    "./theme.css": "./theme.css"
  },
  "files": [
    "dist",
    "theme.css"
  ],
  "publishConfig": {
    "access": "public"
  },
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@radix-ui/react-dialog": "^1.1.15",
    "@radix-ui/react-popover": "^1.1.15",
    "@radix-ui/react-toast": "^1.2.15",
    "@radix-ui/react-tooltip": "^1.2.8",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^1.16.0",
    "tailwind-merge": "^3.6.0"
  },
  "peerDependencies": {
    "next": "^16",
    "react": "^19",
    "react-dom": "^19",
    "tailwindcss": "^4"
  },
  "peerDependenciesMeta": {
    "next": {
      "optional": true
    }
  },
  "devDependencies": {
    "@testing-library/react": "^16.3.2",
    "@types/node": "^22.19.19",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "happy-dom": "^20.9.0",
    "tsup": "^8.5.0",
    "typescript": "^5",
    "vitest": "^4.1.11"
  }
}
```

Exit status: `0`.

```console
$ tar -xzOf motir-design-system-0.23.0.tgz package/LICENSE | head -n 20
MIT License

Copyright (c) 2026 moooon B.V.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
```

Exit status: `0`.

```console
$ tar -xzOf motir-design-system-0.23.0.tgz package/LICENSE | wc -l
21
```

Exit status: `0`.

The licence file has 21 lines. The 20 quoted above carry the MIT grant and the
copyright line `Copyright (c) 2026 moooon B.V.`. The last line is the standard MIT
closing, `SOFTWARE.`.

The README in the tarball says the same:

```console
$ tar -xzOf motir-design-system-0.23.0.tgz package/README.md | grep -n -i -A4 '^## *licen'
412:## License
413-
414-`@motir/design-system` is licensed under the [MIT License](LICENSE); the
415-`LICENSE` file in this package holds the full text and ships in the published
416-tarball. The package was relicensed from GPL-3.0-only to MIT by MOTIR-11318, so
```

Exit status: `0`.

## Discrepancies

None. The advertised licence, the manifest inside the tarball and the `LICENSE` file
inside the tarball all say MIT for `0.23.0`. The version is not 0.22.x, and the
pull needed no credential. No defect was filed.

## Reproduce

Run this from any machine with Node 22 and npm. It writes only inside a new
temporary directory.

```bash
W=$(mktemp -d) && cd "$W" && mkdir home && : > user.npmrc && : > global.npmrc
export HOME="$W/home" NPM_CONFIG_USERCONFIG="$W/user.npmrc" NPM_CONFIG_GLOBALCONFIG="$W/global.npmrc" NPM_CONFIG_CACHE="$W/cache"
unset NPM_TOKEN NODE_AUTH_TOKEN npm_config__auth npm_config_registry NPM_CONFIG_REGISTRY
npm whoami                     # must fail: ENEEDAUTH
npm config get registry        # must print https://registry.npmjs.org/
npm view @motir/design-system@0.23.0 license version --json
npm view @motir/design-system@0.23.0 dist --json
npm view @motir/design-system versions --json
npm pack @motir/design-system@0.23.0
tar -tzf motir-design-system-0.23.0.tgz | awk -F/ '{print $2}' | sort -u
tar -xzOf motir-design-system-0.23.0.tgz package/package.json
tar -xzOf motir-design-system-0.23.0.tgz package/LICENSE | head -n 20
```
