# NoTrace Browser

[English](README.md) | [简体中文](README.zh-CN.md)

NoTrace Browser is a high-performance, open-source, anti-fingerprinting browser client optimized for macOS. It integrates **CloakBrowser's C++ patched Chromium core** with macOS native integration (PWAs, System TCC fixes, and account pickers) to deliver a seamless, anti-association multi-identity management environment for any web service (AI platforms, Web3, Social Media, eCommerce, etc.).

---

## 💡 Why NoTrace Browser?

Modern web applications, AI platforms, and online services employ aggressive bot-detection and anti-fraud systems (like Cloudflare Turnstile, FingerprintJS, and CreepJS) to track user hardware fingerprints and IP-to-timezone consistency.

When you use ordinary browser profiles (e.g., Chrome Profiles) or native webviews (Tauri/WKWebView) to manage multiple accounts, they **share the same device fingerprint, process host, and timezone metadata**. This makes your accounts linkable, triggering frequent CAPTCHAs, restriction screens, or permanent bans.

NoTrace Browser solves this by giving each account a **completely unique, isolated digital fingerprint and network exit** inside a native macOS app experience.

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
| :--- | :---: | :---: | :---: |
| **Data & Cookie Isolation** | **Yes** (Isolated folder paths) | **Yes** (Cookie Isolation) | **Yes** (Profile Sandbox) |
| **C++ Fingerprint Spoofer** | **Yes** (Randomized WebGL/Canvas/Audio) | **No** (Leaks host fingerprint) | **Yes** (But heavily subscription-based) |
| **Web Worker Timezone** | **Yes** (Forced system-level TZ sync) | **No** (Leaks host OS timezone) | **Varies** (Often bypasses Workers) |
| **SOCKS5 Proxy w/ Auth** | **Yes** (Built-in proxy relay launcher) | **No** (Needs third-party plugins) | **Yes** |
| **macOS Native Integration** | **Yes** (Full-bleed PWA shims + TCC patches) | **No** (Standard browser windows) | **No** (Bulky Electron interfaces) |
| **Cost** | **100% Free & Open-source** | **Free** (But unsafe for multi-accs) | **Paid** ($50–$300+/month) |

---

## 🛡️ Deep Stealth & Anti-Fingerprinting Mechanisms

NoTrace Browser goes beyond simple superficial Javascript overrides. It employs kernel-level C++ modifications coupled with a dynamic companion extension to shield your identity:

### 1. WebGL & GPU Masking
Instead of reporting your physical GPU model (e.g., `Apple M4 Pro`), NoTrace overrides rendering parameters to report a generic Metal string (`ANGLE (Apple, ANGLE Metal Renderer: Apple M1-M4, Unspecified Version)`) with vendor `Google Inc. (Apple)`. This eliminates discrepancies that trigger CreepJS's `like headless` flags.

### 2. Physical WebRTC Isolation
Utilizing CloakBrowser's `--fingerprint-webrtc-ip`, NoTrace forces WebRTC local and public candidates to route through and present your proxy's exit IP. This completely masks your real local subnet and public IP addresses, passing browserleaks WebRTC audits cleanly.

### 3. UA & High-Entropy Client Hints Consistency
Modifying the User Agent alone creates a massive version-consistency discrepancy (UA vs. High-Entropy Client Hints vs. TLS/JA3/JA4 fingerprints). NoTrace automatically maps User Agent strings with `navigator.userAgentData` (matching `fullVersionList`, `platformVersion`, and `architecture`), matching TCP/TLS handshakes perfectly.

### 4. Non-Destructive Canvas & Audio Noise
- **Canvas Noise**: Instead of constantly distorting Canvas which breaks normal rendering, NoTrace intercepts `toDataURL` and `toBlob`. It injects a stable, seed-based noise to 8 random pixels, extracts the data, and **instantly restores the original pixels**. Your pages render normally, but fingerprinters get a completely unique Canvas ID.
- **Audio Noise**: Intercepts `OfflineAudioContext.startRendering` to inject a stable $10^{-7}$ level delta noise across channels in the returned `AudioBuffer` samples, generating unique audio fingerprints.

### 5. Worker-Thread Timezone Sync
Normal extensions cannot inject scripts into Web Workers, allowing fingerprinters to detect timezone mismatches inside Worker threads. NoTrace synchronizes the timezone at the operating system/process layer using the `--fingerprint-timezone` flag and the `TZ` environment variables, covering both the main window and Web Workers.

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
| **Toggle Locale** | `cloak account toggle-locale <name>` | Toggles IP-matched Accept-Language / lang header synchronization. |
| **Show Detail** | `cloak account show <name> [--json]` | Prints all metadata configuration of the account workspace. |
| **Launch Account** | `cloak launch <name> [--dry-run] [--skip-geo]`| Launches the engine instance. Use `--dry-run` to output flags. |
| **Self Check** | `cloak self-check [--json]` | Verifies local engine integrity and unpacked extensions path. |

---

## 🍎 Native macOS UX & TCC Permissions

NoTrace Browser is built specifically to feel like a premium macOS application:

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

### Step 1: Clone the Repository & Build Picker
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

We run continuous verification scripts against popular anti-bot sites to audit browser stealth.

### Running Live Audits
To inspect your current fingerprint stealth under headed mode:
```bash
node selftest/run-live-challenge-audit.mjs --headed --site browserscan --site fingerprintjs
```

### Verification Pipeline
Validate CLI arguments, contract hooks, and headless privacy engines:
```bash
./packaging/verify-challenge-contract.sh
```

### Current Status Matrix
* **`navigator.webdriver`**: Hidden (All rows green on bot.sannysoft.com).
* **WebRTC Leakage**: Fully blocked (No local or real public IP leak).
* **BrowserScan Detection**: "Bot Detection: No Detection".
* **CreepJS Stealth Rating**: 0% headless/stealth warnings, reports active Metal GPU and stable WebGL signatures.
* **FingerprintPro**: Resolves a stable visitor ID per-account seed without triggering fraud/proxy alerts.

---

## ⚠️ Limitations & Workarounds

* **Google Translation Failure**: CloakBrowser is an *ungoogled-chromium* compilation; Google domains are decoupled (`chrome.9oo91e.qjz9zk`) at the network layer. Built-in translation will fail.
  * *Workaround*: Sideload your preferred translation plugin as an **unpacked extension** in your profile workspace.
* **PWA Flag Limitations**: The daily PWA launcher (launched directly from macOS Launchpad/Dock) cannot receive runtime flags like `--proxy-server` or `--fingerprint-webrtc-ip`. Use the **Multi-Account Picker** when strict proxy isolation and advanced seed-level masking are required.
