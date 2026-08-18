# NoTrace Browser

[English](README.md) | [简体中文](README.zh-CN.md)

NoTrace Browser is a source-available, macOS-focused orchestration and multi-account management client for a separately installed **CloakBrowser C++-patched Chromium engine**. This repository provides the native picker, CLI, profile isolation, proxy relay, companion extension, and packaging scripts; it does not contain or redistribute the CloakBrowser binary.

> [!IMPORTANT]
> **The client, wrapper, and browser engine have separate distribution terms.** Obtain CloakBrowser through its [official repository](https://github.com/CloakHQ/CloakBrowser), [releases](https://github.com/CloakHQ/CloakBrowser/releases), or [website](https://cloakbrowser.dev/). Upstream currently publishes MIT-licensed wrappers; a validated free GitHub key can resolve the latest keyed binary with a one-session limit, while the keyless route remains on an older build. That does not make the binary open source. Check the current binary terms before use, modification, or redistribution. This NoTrace repository does not currently include a project license, so source availability alone does not grant reuse or redistribution rights.

---

## 💡 Why NoTrace Browser?

Modern web applications, AI platforms, and online services employ aggressive bot-detection and anti-fraud systems (like Cloudflare Turnstile, FingerprintJS, and CreepJS) to track user hardware fingerprints and IP-to-timezone consistency.

When you use ordinary browser profiles (e.g., Chrome Profiles) or native webviews (Tauri/WKWebView) to manage multiple accounts, they **share the same device fingerprint, process host, and timezone metadata**. This makes your accounts linkable, triggering frequent CAPTCHAs, restriction screens, or permanent bans.

NoTrace Browser reduces accidental cross-account reuse by giving each account a **stable seed, isolated profile directory, and optional dedicated network exit** inside a native desktop app experience.

```mermaid
graph TD
    A[Cloak Picker App / CLI] -->|Launches with Seed & Proxy| B(NoTrace Account Profile)
    B -->|C++ Fingerprint Patches| C[Spoofed Canvas, WebGL, Audio & Client Hints]
    B -->|Proxy Relay Launcher| D[Authenticated SOCKS5 Exit]
    B -->|TZ env + engine timezone flag| E[Intl Timezone matched in page and Worker]
    B -->|TCC-ready Signed Engine| F[Microphone Voice / Bluetooth Passkeys]
    D -->|Target Network| G[Websites / AI / Web3 / Socials / eCommerce]
```

### ⚡ NoTrace Browser vs. Competitors

| Feature | NoTrace Browser | Ordinary Chrome Profiles | Paid Antidetect Browsers |
| :--- | :--- | :--- | :--- |
| **Data & Cookie Isolation** | **Yes** (Isolated folder paths) | **Yes** (Cookie Isolation) | **Yes** (Profile Sandbox) |
| **C++ Fingerprint Spoofer** | **Yes** (Randomized WebGL/Canvas/Audio) | **No** (Leaks host fingerprint) | **Yes** (But heavily subscription-based) |
| **Web Worker Timezone** | **Yes** (Forced system-level TZ sync) | **No** (Leaks host OS timezone) | **Varies** (Often bypasses Workers) |
| **SOCKS5 Proxy w/ Auth** | **Yes** (Built-in proxy relay launcher) | **No** (Needs third-party plugins) | **Yes** |
| **Native OS Integration** | **Yes** (PWA shims + TCC/sandbox patches) | **No** (Standard browser windows) | **No** (Bulky Electron interfaces) |
| **Cost** | **NoTrace source available; CloakBrowser engine is separately Free/Pro** | **Free** (But unsafe for multi-accs) | **Paid** ($50–$300+/month) |

---

## 🛡️ Deep Stealth & Anti-Fingerprinting Mechanisms

NoTrace Browser combines CloakBrowser's source-level engine patches with a companion extension and per-account launch configuration. These mechanisms are intended to reduce cross-account correlation; results still depend on the exact engine version, proxy quality, network path, and target site's changing detection logic.

Normal launches are **native-first**: they use CloakBrowser's engine patches and a stable seed without injecting Navigator/Canvas/Audio hooks into every page or replacing page `Function.prototype.toString`. The legacy page spoof is opt-in via `CLOAK_COMPANION_PAGE_SPOOF=1` and is not recommended for strict bot-detection targets.

### 1. WebGL & GPU Masking
The legacy macOS 145 engine receives the explicit, seed-stable Apple Metal renderer compatibility flags it requires. The fixed macOS `148.0.7778.215.3` line and CloakBrowser 150+ keep the engine's native GPU identity authoritative; NoTrace deliberately does not stack an external renderer override on top of those source-level patches.

### 2. Physical WebRTC Isolation
Utilizing CloakBrowser's `--fingerprint-webrtc-ip`, NoTrace asks supported engine builds to present the configured proxy exit IP in WebRTC candidates. Verify the result after every engine or proxy change because browser, network, and proxy behavior can still affect leakage tests.

### 3. UA & Client Hints Consistency
Modifying the User Agent alone creates a version-consistency discrepancy. NoTrace retains its explicit UA/brand/platform compatibility flags for macOS 145 and earlier 148 revisions. The fixed `148.0.7778.215.3` distribution and CloakBrowser 150+ use the native engine identity, matching the official guidance for those builds. When companion header rules are explicitly enabled, they emit only the low-entropy hints Chrome sends proactively and never force high-entropy hints onto every request. The macOS 145 engine still reports an empty `bitness`, which the live audit records as an upstream limitation.

Each profile also owns a versioned identity contract: an immutable `profile_id`, permanent environment number, `hardware_profile_id`, pinned GPU bucket, render-identity version, actual kernel version, and actual engine build. The picker exposes only two coherent modes: engine-native identity on supported builds, or the stable multi-account compatibility template on legacy builds. It does not expose independent CPU/GPU/screen/UA sliders that can create impossible combinations.

### 4. Optional Legacy Canvas & Audio Noise
The page hooks below run only with `CLOAK_COMPANION_PAGE_SPOOF=1`; native seed isolation is the default.

- **Canvas Noise**: Instead of constantly distorting Canvas which breaks normal rendering, NoTrace intercepts `toDataURL` and `toBlob`. It injects stable, seed-based noise into 8 pixels, extracts the data, and **instantly restores the original pixels**. This produces account-specific, seed-stable output without intentionally changing the visible canvas.
- **Audio Noise**: Intercepts `OfflineAudioContext.startRendering` to inject a stable $10^{-7}$ level delta noise across channels in the returned `AudioBuffer` samples, generating unique audio fingerprints.

### 5. Worker-Thread Timezone Sync
Normal extensions cannot inject scripts into Web Workers, allowing fingerprinters to detect timezone mismatches inside Worker threads. NoTrace applies the `--fingerprint-timezone` flag and the `TZ` environment variable at launch so supported builds can align both the main window and Web Workers.

### 6. Legacy Page-Hook Masking (Opt-In Only)
- Wraps overridden properties inside clean Proxies and patches `Function.prototype.toString` so every hooked native still reports `[native code]`.
- The companion adds **nothing** to `window`. The mask's state lives in a closure that callers reach through the patched `toString` itself, so no page global can name the product, link the accounts sharing it, or switch the mask off.

---

## ⚙️ Embedded SOCKS5 & HTTP Proxy Relay

Chromium lacks native support for authenticated SOCKS5 proxies (`socks5://user:pass@host:port`). 

NoTrace Browser integrates an **embedded multi-threaded Proxy Relay daemon** written in Rust (using Tokio & Rustls) directly inside the CLI. 
- **Automated Lifecycle**: When an account with an authenticated proxy is launched, the CLI automatically boots the relay in the background on a randomized local port, validates ready-state with a local Socks5 handshake, and directs the browser to it.
- **Zero Resource Leaks**: The supervisor checks process bounds and automatically tears down the relay when the browser quits, preventing port collisions and socket leaks.
- **Protocols Supported**: SOCKS5 (no auth / user-pass auth), HTTP, and HTTPS (TLS tunneling via Rustls).

---

## 🛠️ The `cloak` CLI Workspace Toolkit

Every account workspace in NoTrace Browser can be fully automated using the compiled `cloak` CLI tool.

| Subcommand | Syntax | Description |
| :--- | :--- | :--- |
| **List Accounts** | `cloak account list [--json]` | Lists all active account workspaces with seed and proxy status. |
| **List Trashed** | `cloak account list-trashed [--json]` | Lists soft-deleted accounts currently in the trash. |
| **Create Account** | `cloak account create <name> [--json]` | Creates a new isolated profile with a pinned random seed. |
| **Rename Account** | `cloak account rename <old> <new>` | Renames an account while retaining its stable fingerprint seed. |
| **Delete Account** | `cloak account delete <name>` | Safely moves an account workspace to the trash. |
| **Purge Account** | `cloak account purge <name>` | Permanently deletes account folder data from disk. |
| **Restore Account**| `cloak account restore <name>` | Restores a soft-deleted account back to active status. |
| **Set Proxy** | `cloak account set-proxy <name> [url] [--clear]`| Binds an upstream proxy (SOCKS5/HTTP/HTTPS) to the account. |
| **Set Region** | `cloak account set-region <name> [code] [--clear]`| Sets geographical region constraint labels. |
| **Set Group** | `cloak account set-group <name> [group] [--clear]`| Assigns the workspace to an organizational group. |
| **Set Mark** | `cloak account set-mark <name> [note] [--clear]`| Adds a red reminder dot with an optional 24-character note; use `--clear` to remove it. |
| **Toggle Locale** | `cloak account toggle-locale <name>` | Toggles IP-matched Accept-Language / lang header synchronization. |
| **Show Detail** | `cloak account show <name> [--json]` | Prints all metadata configuration of the account workspace. |
| **Launch Account** | `cloak launch <name> [--dry-run] [--skip-geo]`| Launches the engine instance. Trashed accounts launch without being restored; use `--dry-run` to output flags. |

The compatibility launcher also accepts an optional HTTPS destination:
`./packaging/launch-account.sh <name> [https-url]`. Omitting the URL keeps the
existing `https://chatgpt.com/` default. Arguments are passed directly to
Chromium without shell interpolation.
| **Self Check** | `cloak self-check [--json]` | Verifies local engine integrity and unpacked extensions path. |

## 🔐 Encrypted Workspace Backup & Recovery

Open **Manage → Workspace Backup** in Cloak Picker to export or restore one `.ntrace` archive. A backup contains all active and trashed account directories plus Picker group/account ordering, collapsed and hidden groups, sidebar width, and custom mark presets. It deliberately excludes the separately installed browser engine and rebuildable browser caches, relay, and companion runtime files.

- Data is streamed through independently authenticated 1 MiB AES-256-GCM frames. The key is derived with scrypt (`N=32768`, `r=8`, `p=1`); the passphrase must contain 12–1024 characters and is never written to disk.
- The encrypted manifest records every portable path, file size, SHA-256 digest, permanent profile identity, and environment number. Import fully authenticates and hashes the archive before showing its conflict preview.
- Unsafe paths, symlinks, duplicate identities, undeclared bytes, truncation, trailing data, and oversized archives are rejected. Current limits are 2,000 accounts, 500,000 entries, 64 GiB per file, and 1 TiB total payload.
- Name conflicts receive editable rename suggestions. Environment-number conflicts are remapped, while a duplicate immutable `profile_id` is blocked instead of cloning one identity twice.
- Restore decrypts into an isolated same-volume staging directory, then commits with atomic renames. A failed multi-profile commit rolls back already moved profiles; existing local profiles are never overwritten.
- Long scans, verification, and encryption/decryption passes can be cancelled from the dialog. Cancellation is checked between bounded chunks and removes temporary output; once the short atomic commit begins, it is allowed to finish instead of being killed mid-rename.

Every profile carries `.cloak-profile.json` plus two private backup replicas. A damaged primary or backup replica is repaired automatically from a valid copy. The permanent environment number follows the profile through rename and appears in the inspector without adding a distracting Dock badge.

---

## 🍎 macOS Native UX & TCC Permissions (macOS Specific)

NoTrace Browser is built specifically to feel like a premium application on macOS:

- **Durable Green Icon**: Chromium shims overwrite `app.icns` on updates, stripping custom PWA icons. NoTrace applies a Finder-level custom icon (`kHasCustomIcon` + bundle-root `Icon\r` resource) via `NSWorkspace setIcon:forFile:`. This custom icon is preferred by LaunchServices and **survives browser engine rebuilds**.
- **Stable TCC Permission Identity**: The updater never rewrites the wrapper-managed `chromium-<version>[-pro]` source directory. For this machine's own runtime, it copies that bundle to a clearly marked `chromium-<version>[-pro]-notrace` directory, injects the microphone, camera, and Bluetooth usage descriptions, and signs the copy with the persistent local identity. Newly downloaded official archives are checksum/manifest verified by the pinned wrapper; an existing cache hit is only structurally signature-checked and is not mislabeled as freshly verified. The source cache remains independently available, and NoTrace does not package or redistribute the local runtime. Every account launch still goes through LaunchServices.

---

## 📁 Runtime Paths & Directory Map

* **Daily PWA App Bundle**: `~/Applications/Chromium Apps.localized/NoTrace Browser.app`
* **Wrapper-managed CloakBrowser Source Cache**: `~/.cloakbrowser/chromium-<version>[-pro]/Chromium.app/Contents/MacOS/Chromium`
* **Local TCC-ready Runtime**: `~/.cloakbrowser/chromium-<version>[-pro]-notrace/Chromium.app/Contents/MacOS/Chromium`
* **Default Profile Path**: `~/Library/Application Support/NoTrace Browser/Profiles/main`
* **Multi-Account Profile Sandbox**: `~/Library/Application Support/NoTrace Browser/Accounts/<name>`

---

## 🚀 Setup & Installation

### Prerequisite: Obtain the CloakBrowser Engine Separately
Follow the current [official installation instructions](https://github.com/CloakHQ/CloakBrowser#install) and complete an initial download or launch so a Chromium bundle exists under `~/.cloakbrowser/chromium-*` (the optional `~/.cloakbrowser/current` symlink is also supported). Choose the upstream keyless, free-key, or paid tier under its current terms. NoTrace never creates or embeds a license key; its updater delegates later downloads and license validation to the pinned official wrapper.

### Step 1: Clone the Repository & Build Picker
Build prerequisites are macOS 12 or later, Xcode Command Line Tools, a stable Rust toolchain, and Node.js 20 or later with npm. The installer automatically runs `npm ci` when frontend dependencies are missing or do not match `package.json`.

If you want to use the native graphical multi-account picker (Tauri-based):
```bash
# Build the day-mode Tauri picker and install to /Applications/Cloak Picker.app
./packaging/install-cloak-picker-app.sh
```

### Step 2: Patch TCC Permissions on the Marked Local Runtime
The updater performs this automatically on its `-notrace` copy. The command can also repair that marked local runtime idempotently, or patch a separately supplied custom Chromium outside the official cache:
```bash
./packaging/patch-chromium.sh
```
*Note: CloakHQ's current binary license text prohibits modifying every official binary version and contains no personal-use exception. The patcher therefore refuses unsuffixed wrapper-cache `chromium-<version>[-pro]` directories. The local `-notrace` derivative is an explicit machine-local choice and is never included in this repository or redistributed; users remain responsible for the upstream binary terms.*

### Step 3: Install the Signed Update Staging Chain
The updater pins the official JavaScript wrapper at `0.5.7`. That wrapper performs license routing and verifies newly downloaded official archives with SHA256 plus an Ed25519-signed manifest. NoTrace leaves the wrapper source cache unchanged, creates and locally signs the `-notrace` copy, then runs its local/live gates and atomically switches `current` only after approval.

```bash
# Read-only decision
DRY_RUN=1 ./packaging/update-chromium.sh
# Install or refresh the daily staging timer
./packaging/install-updater.sh
# With all Cloak windows closed: run headed gates and promote an eligible candidate
CLOAK_UPDATE_LIVE_GATE=1 ./packaging/update-chromium.sh
# List or atomically select any retained build (including -pro and -notrace targets)
./packaging/rollback-chromium.sh --list
```

The exact macOS build `150.0.7871.114.3` is denylisted because upstream confirmed its `browserTampering` regression. It may be downloaded by other tools, but NoTrace will not promote it; a later fixed macOS build must pass both gates.

### Step 4: Apply the Native Green Icon
Chromium PWAs default to a low-res green badge on a white tile. Set the beautiful, full-bleed macOS green icon:
```bash
./packaging/set-pwa-icon.sh
```

### Step 5: Install the Timezone Companion
1. Open `chrome://extensions` in your browser.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select `extension/cloak-companion/` from this repo.
4. Click the extension toolbar icon and enable **自动匹配当前 IP** (Auto-match IP Timezone).

---

## 🔍 Audit & Verification Status

This repository provides local contract checks and a headed live-audit script. Live detection outcomes are point-in-time observations, not permanent guarantees: rerun them for your exact CloakBrowser version, proxy, and network path after every relevant change.

### Running Live Audits
To inspect your current fingerprint stealth under headed mode:
```bash
node selftest/run-live-challenge-audit.mjs --headed --site browserscan --site fingerprintjs
```

Use the audit's proxy option so GeoIP, timezone, locale, and WebRTC are generated through the same route:
```bash
node selftest/run-live-challenge-audit.mjs --headed --proxy-server http://127.0.0.1:7897 --site browserscan --site creepjs
```

Normal account launches keep the GeoIP, proxy, and privacy gates but do not run the two-profile headless browser self-test. Run checks explicitly from Cloak Picker (`检查出口` / `挑战兼容`), or opt in for CLI and legacy-script launches with `CLOAK_PREFLIGHT=async` or `CLOAK_PREFLIGHT=strict`.

GeoIP now requires a 2-of-3 agreement across `ipwho.is`, `ipinfo.io`, and `geojs.io`. A vote matches only when normalized public IP, country, timezone, and ASN all match. Picker and JSON diagnostics explicitly report `agreement`, `single-source`, `conflict`, or `unavailable`; only `agreement` may drive automatic timezone, locale, and WebRTC fingerprint arguments or enter the five-minute proxy cache.

### Verification Pipeline
Validate CLI arguments, contract hooks, and headless privacy engines:
```bash
./packaging/verify-challenge-contract.sh
```

### Verification Targets
* **`navigator.webdriver`**: Confirm that the live page does not expose automation state.
* **WebRTC Leakage**: Confirm that candidates do not reveal the real local or public IP.
* **BrowserScan**: Record the current bot-detection result for the exact engine build.
* **CreepJS**: Inspect headless/stealth warnings and renderer consistency.
* **FingerprintJS Pro**: Compare visitor stability within one account and separation across accounts; treat fraud/proxy scoring as site-dependent.

---

## ⚠️ Limitations & Workarounds

* **Bluetooth / Passkey Permission Scope**: macOS requires the user to approve the first Bluetooth prompt; an ordinary app cannot silently press **Allow**. After that one approval, Picker, CLI, and per-account launchers reuse the certificate-backed Chromium identity, so new accounts and normally signed engine updates do not produce another system Bluetooth prompt. Removing/changing the signing certificate or forcing ad-hoc signing creates a new TCC identity and requires one new approval. A website can still show its own Passkey chooser independently of this macOS permission.
* **Google Translation Failure**: CloakBrowser is an *ungoogled-chromium* compilation; Google domains are decoupled (`chrome.9oo91e.qjz9zk`) at the network layer. Built-in translation will fail.
  * *Workaround*: Sideload your preferred translation plugin as an **unpacked extension** in your profile workspace.
* **PWA Flag Limitations**: The daily PWA launcher (launched directly from macOS Launchpad/Dock) cannot receive runtime flags like `--proxy-server` or `--fingerprint-webrtc-ip`. Use the **Multi-Account Picker** when strict proxy isolation and advanced seed-level masking are required.

---

## 🤝 Credits & Acknowledgements

NoTrace Browser orchestrates a separately obtained **CloakBrowser** Chromium binary and adds a native macOS picker, account workspace management, proxy tooling, and companion integration. The upstream wrapper and binary have distinct licensing and release terms; NoTrace does not bundle the binary, and users or distributors must review the current [CloakBrowser binary license](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md).
