# NoTrace Browser

[English](README.md) | [简体中文](README.zh-CN.md)

NoTrace Browser is a source-available, macOS-focused orchestration and multi-account management client for a separately installed **CloakBrowser C++-patched Chromium engine**. This repository provides the native picker, CLI, profile isolation, proxy relay, companion extension, and packaging scripts; it does not contain or redistribute the CloakBrowser binary.

> [!IMPORTANT]
> **The client and browser engine have separate distribution terms.** Obtain CloakBrowser from its [official repository](https://github.com/CloakHQ/CloakBrowser), [releases](https://github.com/CloakHQ/CloakBrowser/releases), or [website](https://cloakbrowser.dev/). Upstream currently describes its wrappers as MIT-licensed and its binary as a delayed free-release model (an older build is free, while the latest build is Pro). Check the current upstream terms before use or redistribution. This NoTrace repository does not currently include a project license, so source availability alone does not grant reuse or redistribution rights.

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
    B -->|Companion Extension| E[Matched Intl Timezone / Worker TZ]
    B -->|TCC Patched Engine| F[Microphone Voice / Bluetooth Passkeys]
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

### 1. WebGL & GPU Masking
Instead of reporting your physical GPU model (e.g., `Apple M4 Pro`), NoTrace overrides rendering parameters to report a generic Metal string (`ANGLE (Apple, ANGLE Metal Renderer: Apple M1-M4, Unspecified Version)`) with vendor `Google Inc. (Apple)`. This aims to reduce renderer inconsistencies that can contribute to CreepJS's `like headless` flags.

### 2. Physical WebRTC Isolation
Utilizing CloakBrowser's `--fingerprint-webrtc-ip`, NoTrace asks supported engine builds to present the configured proxy exit IP in WebRTC candidates. Verify the result after every engine or proxy change because browser, network, and proxy behavior can still affect leakage tests.

### 3. UA & High-Entropy Client Hints Consistency
Modifying the User Agent alone creates a version-consistency discrepancy (UA vs. High-Entropy Client Hints vs. TLS/JA3/JA4 fingerprints). NoTrace maps User Agent strings with `navigator.userAgentData` (including `fullVersionList`, `platformVersion`, and `architecture`) to reduce application-layer mismatches. Network-layer TLS characteristics still depend on the selected engine build and network path.

### 4. Non-Destructive Canvas & Audio Noise
- **Canvas Noise**: Instead of constantly distorting Canvas which breaks normal rendering, NoTrace intercepts `toDataURL` and `toBlob`. It injects stable, seed-based noise into 8 pixels, extracts the data, and **instantly restores the original pixels**. This produces account-specific, seed-stable output without intentionally changing the visible canvas.
- **Audio Noise**: Intercepts `OfflineAudioContext.startRendering` to inject a stable $10^{-7}$ level delta noise across channels in the returned `AudioBuffer` samples, generating unique audio fingerprints.

### 5. Worker-Thread Timezone Sync
Normal extensions cannot inject scripts into Web Workers, allowing fingerprinters to detect timezone mismatches inside Worker threads. NoTrace applies the `--fingerprint-timezone` flag and the `TZ` environment variable at launch so supported builds can align both the main window and Web Workers.

### 6. Anti-Detection API Shims & Anti-Tampering
- Re-injects native browser APIs commonly missing in automated environments (e.g., `ContentIndex`, `ContactsManager` in `navigator.contacts`, `downlinkMax` in `navigator.connection`).
- Wraps overridden properties inside clean Proxies and patches `Function.prototype.toString.toString()` to prevent checkers from detecting JS hooks.

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
| **Launch Account** | `cloak launch <name> [--dry-run] [--skip-geo]`| Launches the engine instance. Use `--dry-run` to output flags. |

The compatibility launcher also accepts an optional HTTPS destination:
`./packaging/launch-account.sh <name> [https-url]`. Omitting the URL keeps the
existing `https://chatgpt.com/` default. Arguments are passed directly to
Chromium without shell interpolation.
| **Self Check** | `cloak self-check [--json]` | Verifies local engine integrity and unpacked extensions path. |

---

## 🍎 macOS Native UX & TCC Permissions (macOS Specific)

NoTrace Browser is built specifically to feel like a premium application on macOS:

- **Durable Green Icon**: Chromium shims overwrite `app.icns` on updates, stripping custom PWA icons. NoTrace applies a Finder-level custom icon (`kHasCustomIcon` + bundle-root `Icon\r` resource) via `NSWorkspace setIcon:forFile:`. This custom icon is preferred by LaunchServices and **survives browser engine rebuilds**.
- **TCC Permission Patching**: Chromium compiled ad-hoc lacks microphone, camera, and Bluetooth usage descriptions. macOS TCC terminates the process instantly when a page requests voice input. NoTrace provides `patch-chromium.sh` which injects `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`, and `NSBluetoothAlwaysUsageDescription` into `Info.plist` and re-signs the application, resolving voice search and passkey authorization crashes.

---

## 📁 Runtime Paths & Directory Map

* **Daily PWA App Bundle**: `~/Applications/Chromium Apps.localized/NoTrace Browser.app`
* **CloakBrowser Core Engine**: `~/.cloakbrowser/chromium-<version>/Chromium.app/Contents/MacOS/Chromium`
* **Default Profile Path**: `~/Library/Application Support/NoTrace Browser/Profiles/main`
* **Multi-Account Profile Sandbox**: `~/Library/Application Support/NoTrace Browser/Accounts/<name>`

---

## 🚀 Setup & Installation

### Prerequisite: Obtain the CloakBrowser Engine Separately
Follow the current [official installation instructions](https://github.com/CloakHQ/CloakBrowser#install) and complete an initial download or launch so a Chromium bundle exists under `~/.cloakbrowser/chromium-*` (the optional `~/.cloakbrowser/current` symlink is also supported). Choose the upstream free or Pro build according to its current licensing terms. NoTrace installation scripts do not download or license this binary for you.

### Step 1: Clone the Repository & Build Picker
Build prerequisites are macOS 12 or later, Xcode Command Line Tools, a stable Rust toolchain, and Node.js 20 or later with npm. The installer automatically runs `npm ci` when frontend dependencies are missing or do not match `package.json`.

If you want to use the native graphical multi-account picker (Tauri-based):
```bash
# Build the day-mode Tauri picker and install to /Applications/Cloak Picker.app
./packaging/install-cloak-picker-app.sh
```

### Step 2: Patch Chromium TCC Permissions
To prevent crashes when using Voice Inputs or Passkeys, patch and sign the CloakBrowser binary:
```bash
./packaging/patch-chromium.sh
```
*Note: Run this patcher after every major CloakBrowser update.*

### Step 3: Apply the Native Green Icon
Chromium PWAs default to a low-res green badge on a white tile. Set the beautiful, full-bleed macOS green icon:
```bash
./packaging/set-pwa-icon.sh
```

### Step 4: Install the Timezone Companion
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

Normal account launches keep the GeoIP, proxy, and privacy gates but do not run the two-profile headless browser self-test. Run checks explicitly from Cloak Picker (`检查出口` / `挑战兼容`), or opt in for CLI and legacy-script launches with `CLOAK_PREFLIGHT=async` or `CLOAK_PREFLIGHT=strict`.

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

* **Bluetooth / Passkey Permission Scope**: macOS Bluetooth access belongs to the CloakBrowser app's code identity, not to a NoTrace account. Reusing the same unchanged engine should not require a new system grant, although an engine upgrade or necessary re-sign can prompt again. Chromium and website permissions are stored inside each isolated account profile, so each newly created account may still ask once on first Passkey use.
* **Google Translation Failure**: CloakBrowser is an *ungoogled-chromium* compilation; Google domains are decoupled (`chrome.9oo91e.qjz9zk`) at the network layer. Built-in translation will fail.
  * *Workaround*: Sideload your preferred translation plugin as an **unpacked extension** in your profile workspace.
* **PWA Flag Limitations**: The daily PWA launcher (launched directly from macOS Launchpad/Dock) cannot receive runtime flags like `--proxy-server` or `--fingerprint-webrtc-ip`. Use the **Multi-Account Picker** when strict proxy isolation and advanced seed-level masking are required.

---

## 🤝 Credits & Acknowledgements

NoTrace Browser orchestrates a separately obtained **CloakBrowser** Chromium binary and adds a native macOS picker, account workspace management, proxy tooling, and companion integration. The upstream wrapper and binary have distinct licensing and release terms; NoTrace does not bundle the binary, and users or distributors must follow the current [CloakBrowser terms](https://github.com/CloakHQ/CloakBrowser#cloakbrowser-pro).
