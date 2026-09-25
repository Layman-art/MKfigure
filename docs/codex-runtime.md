# Bundled Codex runtime

MK Figure bundles unmodified OpenAI Codex CLI 0.154.0 binaries. It starts its own official App Server over stdio. The installed app does not need Node.js or npm for Codex integration. It never bundles user credentials, copies OAuth tokens, changes the user's global Codex installation, or writes global Codex configuration.

## Reproduce the runtime preparation

With Node.js and the operating system's `tar` available in the build environment:

```sh
node scripts/prepare-codex.mjs
# Or only one target:
node scripts/prepare-codex.mjs win-x64
```

The script downloads official npm metadata and tarballs, checks the pinned SHA-512 integrity, rejects unexpected package identity/license/path/architecture, retains the upstream vendor tree, and creates a manifest with each native file's SHA-256. Cached archives are rehashed before reuse. `_downloads` is a build cache and must not be copied into the application.

The official umbrella package uses npm aliases: for example, `@openai/codex-win32-x64` resolves to `npm:@openai/codex@0.154.0-win32-x64`; it is not a separately versioned package under the alias name. All three platform metadata entries declare Apache-2.0.

## Runtime paths

Each platform directory contains `manifest.json`. Resolve its `executable` relative to that platform directory during development, or relative to `process.resourcesPath/codex` in an installed Electron application.

| Build resource directory | Native executable, relative to that directory |
|---|---|
| `resources/codex/win-x64` | `vendor/x86_64-pc-windows-msvc/bin/codex.exe` |
| `resources/codex/mac-arm64` | `vendor/aarch64-apple-darwin/bin/codex` |
| `resources/codex/mac-x64` | `vendor/x86_64-apple-darwin/bin/codex` |

Keep `codex-package.json`, `bin/codex-code-mode-host`, `codex-path/rg`, and platform helper files together. Codex resolves these resources relative to its executable and the upstream package manifest. Do not flatten only the main executable.

The manifest's `executables` array lists files that must have Unix execute permission. macOS ZIP packages produced on Windows need their ZIP Unix mode metadata repaired to `0o100755` for these paths, in addition to Electron's own main executable and helper apps. Running `chmod` on a Windows build filesystem alone does not guarantee the correct ZIP attributes. Preserve the remaining files as regular readable files.

## Provenance and notices

Every installed runtime contains the original package metadata and README, the Codex Apache-2.0 license and NOTICE, and notices for bundled ripgrep (15.2.0), Ratatui (0.30.2 as declared by Codex's release source), and PCRE2 (10.45 as reported by the Windows bundled ripgrep). Original binary files are not modified. `manifest.json` records authoritative download URLs, integrity values, license URLs, and file hashes. This verifies downloaded content against the pinned official registry integrity; it does not claim independent verification of npm publisher signatures or a full transitive dependency license audit.

Official sources:

- [Codex 0.154.0 npm metadata](https://registry.npmjs.org/@openai%2Fcodex/0.154.0)
- [Windows x64 platform metadata](https://registry.npmjs.org/@openai%2Fcodex/0.154.0-win32-x64)
- [macOS arm64 platform metadata](https://registry.npmjs.org/@openai%2Fcodex/0.154.0-darwin-arm64)
- [macOS x64 platform metadata](https://registry.npmjs.org/@openai%2Fcodex/0.154.0-darwin-x64)
- [Codex Apache license](https://github.com/openai/codex/blob/rust-v0.154.0/LICENSE) and [NOTICE](https://github.com/openai/codex/blob/rust-v0.154.0/NOTICE)
- [Official App Server protocol](https://developers.openai.com/codex/app-server)

## Verification performed on Windows

- All three official tarballs passed their SHA-512 integrity pins.
- All vendor files have recorded SHA-256 digests.
- Windows main executable is PE x86_64 and reported `codex-cli 0.154.0`.
- macOS main executables have valid 64-bit Mach-O headers with the expected arm64 / x86_64 CPU types.
- macOS runtime execution, Apple signing, notarization, and Gatekeeper acceptance were not tested on this Windows host. Binary and architecture checks do not establish macOS execution success.

The provider integration was first tested against the existing Windows Codex CLI 0.151.0: authenticated account read, dynamic model list, bounded JSON completion, and an actual native image-generation event all succeeded. The newly bundled Windows 0.154.0 binary then also passed the opt-in authenticated account/catalog/JSON-completion test in 11 seconds. Image generation was not repeated against 0.154.0 at this step. These tests did not log account identifiers or tokens, and did not alter global configuration.
