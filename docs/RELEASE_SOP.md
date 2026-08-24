# NoTrace Browser Release SOP

## Project

- Repository: `GravityPoet/notrace-browser`
- GitHub remote: `git@github.com:GravityPoet/notrace-browser.git`
- Default release branch: `main`
- Package ecosystem: Rust workspace plus two npm workspaces (`cloak-picker` and the pinned CloakBrowser wrapper)
- Package manager: `cargo` and `npm`
- Distribution boundary: source-only NoTrace release; the separately obtained CloakBrowser binary is never bundled or uploaded.

## Versioning

- Version source: `Cargo.toml` `[workspace.package].version`, mirrored by `cloak-picker/package.json`, `cloak-picker/package-lock.json`, and `cloak-picker/src-tauri/tauri.conf.json`.
- Current release version: `0.1.1`.
- Tag format: annotated `v<version>`; `v0.1.0` is immutable, so the current patch target is `v0.1.1`.
- Changelog source: shipped customer value from commits since the previous tag (there is no tracked CHANGELOG yet), plus the bilingual release notes supplied to GitHub.
- Release type: stable source release unless the user explicitly requests draft or prerelease.

## Preconditions

- Clean working tree; unrelated local changes are never staged.
- Exact target commit and version are recorded before the first remote write.
- SSH access to `origin` is available for branch/tag pushes.
- An authenticated GitHub API client (`gh auth status`) is available before creating a GitHub Release.
- macOS 12+, Xcode Command Line Tools, Rust toolchain, Node.js 20+, and npm are available for the native release gate.
- The wrapper pin, lockfile, updater constant, compatibility matrix, TCC runtime identity, `current.sha256`, staging-space check, rollback retention, and headed challenge contract all pass as defined by `docs/RELEASE-CONTRACT.md`.

## Commands

### Install

```bash
cd /Users/moonlitpoet/Tools/AI-tools/notrace-browser
(cd packaging/cloakbrowser-wrapper && npm ci --omit=optional --ignore-scripts)
(cd cloak-picker && npm ci)
cargo fetch
```

### Verify

```bash
cd /Users/moonlitpoet/Tools/AI-tools/notrace-browser
git diff --check
(cd packaging/cloakbrowser-wrapper && npm audit --omit=optional --audit-level=high)
node packaging/audit-cloakbrowser-compatibility.mjs
(cd cloak-picker && npm audit --audit-level=high && npm test && npm run build)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bash -n packaging/*.sh
python3 -m py_compile packaging/*.py
for file in extension/cloak-companion/*.js selftest/*.mjs; do node --check "$file"; done
node --test selftest/*.test.mjs
./packaging/test-patch-chromium.sh
./packaging/test-update-pin.sh
./packaging/test-update-wrapper.sh
./packaging/test-rollback-chromium.sh
./packaging/verify-challenge-contract.sh
./packaging/install-cloak-picker-app.sh
./packaging/check-picker-fresh.sh --print
./packaging/test-picker-native-e2e.sh
```

The native Picker E2E must exercise the signed `.app` at the canonical install
boundary and prove a real window, release WebView, runtime provenance, long
path truncation/copy behavior, and account/workspace keyboard navigation.

### Package

The repository does not redistribute the CloakBrowser binary. For a source
release, create an archive from the exact tag and a detached checksum:

```bash
cd /Users/moonlitpoet/Tools/AI-tools/notrace-browser
mkdir -p dist
git archive --format=tar.gz --prefix=notrace-browser-v0.1.1/ v0.1.1 > dist/notrace-browser-v0.1.1.tar.gz
shasum -a 256 dist/notrace-browser-v0.1.1.tar.gz > dist/notrace-browser-v0.1.1.tar.gz.sha256
```

### GitHub distribution

```bash
cd /Users/moonlitpoet/Tools/AI-tools/notrace-browser
git tag -a v0.1.1 -m "NoTrace Browser v0.1.1"
git push origin main
git push origin v0.1.1
gh release create v0.1.1 dist/notrace-browser-v0.1.1.tar.gz dist/notrace-browser-v0.1.1.tar.gz.sha256 \
  --title "NoTrace Browser v0.1.1" --notes-file /tmp/notrace-browser-v0.1.1-notes.md
```

The release notes must contain complete `English` and `中文` sections with the
same shipped facts. Do not claim the CloakBrowser binary is bundled, licensed,
or redistributed by this repository.

## Verification

- Local: all commands in `Verify` pass; the archive checksum matches after a temporary download; `git show --check` and `git status --short --branch` are clean.
- GitHub: `git ls-remote origin refs/heads/main refs/tags/v0.1.1` points to the intended commit/tag, and `gh release view v0.1.1 --json name,tagName,isDraft,isPrerelease,url,assets` shows the two expected assets.
- Package install/download: download the public source archive to a temporary directory, verify its SHA-256, extract it, and confirm the top-level directory and `LICENSE`/`docs/RELEASE-CONTRACT.md` are present.

## Rollback

- Before branch/tag push: remove only the local unpushed tag with `git tag -d v0.1.1`; restore code with a new corrective commit, never rewrite public history.
- After branch push: publish a corrective commit to `main`; do not force-push.
- After tag push: keep the immutable tag; if the release is not acceptable, mark the GitHub Release draft or prerelease and publish a replacement patch version after verification.
- After GitHub Release creation: edit the release to draft/prerelease or publish a corrective release; do not delete or overwrite a public tag without explicit P0 approval.
- Source archive rollback: remove the affected GitHub asset/release only through an explicitly approved recoverable action; retain the local checksum and commit inventory.

## Fuse Conditions

- Stop before any remote write if the target version/tag collides, the working tree is dirty, the exact commit changes unexpectedly, SSH authorization fails, or a required local gate fails.
- Stop before GitHub Release creation if `gh auth status` is invalid, the remote tag points elsewhere, the release already exists, or the uploaded asset checksum/name does not match.
- Do not bundle, patch, upload, or claim redistribution rights for the separate CloakBrowser binary.

## Failure Ledger

| Date | Version/Tag | Command | Error Signature | Root Cause | Fix | Prevention |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-25 | v0.1.0 | `git ls-remote origin refs/heads/main` / `git push --dry-run origin main` | `ssh: Could not resolve hostname ssh.github.com: -65563` | The restricted execution environment could not resolve the configured SSH host. | Retry the exact preflight and push through the approved network boundary; do not change the remote or rewrite history. | Run a read-only remote/tag collision check immediately before the first external write and classify DNS/transport failure separately from repository permission failure. |
| 2026-08-25 | v0.1.0 | `gh auth status` / `gh api repos/GravityPoet/notrace-browser` | `The token in default is invalid` / `error connecting to api.github.com` | The local GitHub CLI credential is invalid and the restricted API path is unavailable. | Push through SSH if available; re-authenticate `gh` before creating a GitHub Release, then verify the public Release independently. | Treat branch/tag push and GitHub Release API creation as separate gates; never infer Release success from a successful Git push. |
| 2026-08-25 | v0.1.0 | `npm audit --omit=optional --audit-level=high` | `getaddrinfo ENOTFOUND registry.npmjs.org` / `audit endpoint returned an error` | The restricted environment could not resolve the npm registry during the first audit attempt. | Re-run the exact audit through the approved network boundary; both wrapper and Picker audits then passed with 0 vulnerabilities. | Separate registry transport failures from dependency findings and do not publish a green audit result from a failed request. |
| 2026-08-25 | v0.1.0 | `cargo test --workspace` / `cargo clippy --workspace --all-targets -- -D warnings` | `Could not resolve host: static.crates.io` while downloading `clap_lex`/`clap_derive` | The restricted environment lacked network access for uncached crates. | Re-run through the approved network boundary; Rust tests and clippy then passed. | Keep the exact crate-download failure in the release ledger and rerun the original commands after network recovery instead of weakening the gate. |
| 2026-08-25 | v0.1.0 | `cargo run --quiet -p cloak-cli -- self-check --json` | `io: Operation not permitted (os error 1)` | The first self-check attempted to inspect machine-local runtime/config paths blocked by the sandbox. | Re-run with the release host permission boundary and require the structured self-check result before claiming installed-runtime health. | Treat sandbox filesystem denial as an environment limitation, not a passing self-check; repeat at the real macOS runtime boundary. |
| 2026-08-25 | v0.1.0 | `git add docs/RELEASE_SOP.md && git commit -m "docs: add release SOP"` | `Unable to create .git/index.lock: Operation not permitted` | The managed sandbox exposes `.git` as read-only for the first commit attempt. | Retry the unchanged commit command through the approved repository-write boundary. | Distinguish repository write-scope denial from hook or content failure; do not alter Git metadata or remove locks blindly. |
| 2026-08-25 | v0.1.0 | `(cd cloak-picker && npm test -- --runInBand=false)` | `CACError: Unknown option \`--runInBand\`` | A Jest-only option was added to the Vitest command during a final-gate wrapper probe. | Re-run the repository-defined `npm test` command without extra flags; the full 53-test suite passed. | Use the exact package script from `package.json` for release evidence; do not transfer runner-specific flags between test frameworks. |
| 2026-08-25 | v0.1.0 | ad-hoc prepublish shell assertion | exit 1 before checks ran | The assertion expected a clean tree while the required SOP ledger update was intentionally still unstaged. | Inspect the status, commit the SOP update, then rerun the checks against the clean target commit. | Keep release-gate assertions aligned with the documented write order; do not require cleanliness before committing a required release-document update. |
| 2026-08-25 | v0.1.0 | `test "$(git rev-parse HEAD)" = 04793db` | exit 1 before checks ran | A short commit ID was compared to Git's full object ID. | Use `git rev-parse --short` for a short-ID comparison or compare the full expected SHA. | Keep exact-SHA checks explicit about short versus full forms and print the resolved object before the gate. |
| 2026-08-25 | v0.1.0 | `(cd "$tmpdir" && shasum -a 256 -c check.sha256)` after `gh release download` | `FAILED open or read .../dist/notrace-browser-v0.1.0.tar.gz` | The checksum manifest was generated from the repository root and retained a `dist/` relative path; copying it beside the downloaded asset changed the lookup base. | Compare the manifest hash field directly with the downloaded file hash; the public asset then verified successfully. | Keep checksum path context explicit when moving manifests between directories; verify both digest equality and archive contents. |
| 2026-08-25 | v0.1.0 | GitHub Actions run `32750609549`, `./packaging/test-picker-native-e2e.sh` | `长账号目录没有在真实 WebView 中以省略号收纳`; fixture report stopped after the first two tab checks | The CI fixture used a short temporary account path (~58 characters); the hosted macOS window was wide enough that the path did not overflow, so later copy/provenance/tab checks were never reached. | Make the fixture account base deterministically long, rerun the real native E2E, and require all six checks. | Native UI overflow gates must construct a path longer than the widest supported runner window; do not rely on a random temp prefix to create overflow. |
| 2026-08-25 | v0.1.0 | GitHub Actions run `32751861884`, `./packaging/test-picker-native-e2e.sh` | `等待超时：账号目录复制动作`; `navigator.clipboard.writeText` never settled in the signed WebView | The native macOS WebView exposed Clipboard API but did not resolve the promise for the real click, while the UI awaited it indefinitely. | Add a bounded Clipboard API wait, call the native `/usr/bin/pbcopy` bridge, then retain the DOM fallback; the installed-app E2E passed after forcing the pending-promise behavior. | Native copy actions must have a bounded Clipboard API wait and a native recoverable fallback; never let a platform clipboard promise block the UI indefinitely. |
| 2026-08-25 | v0.1.0 | GitHub Actions run `32752886898`, `node --test selftest/*.test.mjs` | `getImageData cost 40ms against 10ms native`; strict `<4` ratio assertion failed at the timer boundary while 51/52 tests passed | The performance probe used short 20,000-call batches and millisecond `Date.now()`, so hosted-runner timer granularity made a cached path land exactly on the cutoff. | Use `performance.now()` with 100,000-call batches while retaining the `<4` ratio threshold; repeated local runs passed. | Performance release gates must use high-resolution timing and enough work to dominate timer quantization; keep the behavioral threshold unchanged when stabilizing measurement noise. |
| 2026-08-25 | v0.1.0 | final `git push` cleanliness preflight | exit 1 because `packaging/__pycache__/` was untracked | Local `py_compile` generated a temporary bytecode directory after the prior syntax gate. | Remove the generated cache before the push preflight; no tracked source changed. | Keep syntax-gate bytecode output on an explicit cleanup trap locally, and require a clean tree before every external write. |
| 2026-08-25 | v0.1.0 | GitHub Actions run `32753586682`, `./packaging/test-picker-native-e2e.sh` | Clipboard timeout persisted after the JavaScript timeout/DOM fallback; report again stopped at `path-ellipsis-copy-source` | Hosted WebKit exposed a pending Clipboard API and did not permit the hidden `execCommand` fallback, so the UI had no reliable system pasteboard path. | Add a Tauri `copy_to_clipboard` command that writes through `/usr/bin/pbcopy` via stdin, invoke it before the DOM fallback, and force the pending-promise path in native E2E; the signed-app E2E then passed. | macOS release gates must exercise the native pasteboard bridge explicitly; a browser-only fallback is not sufficient evidence for a signed WebView. |
| 2026-08-25 | v0.1.1 | `node packaging/audit-cloakbrowser-compatibility.mjs` from `packaging/cloakbrowser-wrapper/` | `Cannot find module .../packaging/cloakbrowser-wrapper/packaging/audit-cloakbrowser-compatibility.mjs` | The repository-root CI command was run from the wrapper subdirectory, so its root-relative path resolved incorrectly. | Re-run the unchanged command from the repository root; compatibility audit passed with `wrapper=0.5.8`. | Keep commands with repository-root paths in the documented working directory, and use the exact CI working-directory boundary when reproducing release gates. |
| 2026-08-25 | v0.1.1 | `gh auth status` / `gh release view v0.1.1` before upload | `The token in default is invalid`; Release API unavailable through the default `gh` credential | The local `gh` credential had expired even though SSH push access remained valid. | Use the explicitly supplied short-lived `GH_TOKEN` only for the release API, then verify the public Release independently. | Treat SSH branch/tag access and GitHub Release API authentication as separate gates; never infer one from the other. |
| 2026-08-25 | v0.1.1 | release-tag collision probe using `set -e` and `gh api repos/GravityPoet/notrace-browser/releases/tags/v0.1.1` | shell exited on the expected 404 before printing `release-collision=NO` | `set -e` treated the expected absence of a Release as a fatal command failure. | Re-run the probe inside an explicit `if ...; then collision; else no collision; fi` branch. | Expected-negative preflights must classify non-zero responses explicitly instead of relying on `$?` after `set -e`. |
| 2026-08-25 | v0.1.1 | `gh release view v0.1.1 --json name,tagName,isDraft,isPrerelease,isLatest,url,assets` | `Unknown JSON field: "isLatest"` | The installed `gh` version exposes `isLatest` in release listings but not in `release view`. | Query the supported `isImmutable`/status fields for the release and use `gh release list` for latest-state verification. | Keep `gh` JSON field sets command-specific and validate them against `gh ... --help`/supported output before the final gate. |
| 2026-08-25 | v0.1.1 | public Actions jobs probe with a combined `jq` program | `jq: syntax error, unexpected ';'` | Two independent jq filters were joined with a semicolon without wrapping them as separate shell commands. | Run the job summary and step summary as two explicit jq invocations; both reported success. | Keep multi-query JSON checks as separate, syntax-checked commands so a reporting probe cannot obscure the underlying CI result. |
