# NoTrace Browser

[English](README.md) | [简体中文](README.zh-CN.md)

NoTrace Browser is a generic, high-performance, open-source, anti-fingerprinting browser client optimized for macOS. It is designed to support any web service (ChatGPT, Claude, Web3 platforms, Social Media, eCommerce, etc.) where identity isolation is required. It integrates **CloakBrowser's C++ patched Chromium core** with macOS native integration (PWAs, System TCC fixes, and account pickers) to deliver a seamless, anti-association multi-account identity management environment.

---

## 💡 Why NoTrace Browser?

Modern web services, AI platforms, and online systems employ aggressive bot-detection and anti-fraud systems (like Cloudflare Turnstile, FingerprintJS, and CreepJS) to track user hardware fingerprints and IP-to-timezone consistency. 

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

## 🌟 Key Features

### 1. Hardened C++ Fingerprinting Defenses
Powered by C++ patched Chromium, NoTrace Browser spoofs low-level APIs that Javascript fingerprinters exploit:
- **WebGL & GPU Masking**: Replaces your real GPU model (e.g., `Apple M4 Pro`) with a generic Metal string (`ANGLE (Apple, ANGLE Metal Renderer: Apple M1-M4, Unspecified Version)`).
- **Canvas & Audio Spoofing**: Injects stable per-account noise, ensuring that `getImageData()` and Audio API queries yield unique, consistent visitor IDs without looking suspicious.
- **Client Hints & User Agent**: Reports synthetic macOS versions with GREASE-correct full-version lists.

### 2. Multi-Account Identities with Stable Seeds
- Launching an account via `launch-account.sh <name>` generates a stable random seed pinned in `.cloak-seed`.
- The process boundary ensures separate memory spaces and cookie jars. Unlike Chromium's native switcher, this guarantees accounts are **never linkable by device characteristics**.

### 3. IP-Timezone & Locale Alignment
- **Proxy Relay Launcher**: Supports per-account proxy settings (written to `Accounts/<name>/.cloak-proxy`). For authenticated SOCKS5 proxies (`socks5://user:pass@host:port`), NoTrace automatically boots a local proxy-relay daemon (`packaging/proxy-relay.py`) since Chromium natively lacks SOCKS5 authentication support.
- **Companion Extension**: The MV3 companion extension (`extension/cloak-companion/`) overrides page-visible timezones (`Intl` and `Date`) to match your exit proxy's location, fully supporting Web Workers.
- **Geo-Matched Languages**: Dynamically modifies `--lang` and `Accept-Language` headers to prevent region mismatches.

### 4. Native macOS PWA Integration & TCC Fixes
- **Single-Tile Launchers**: Packages any target web application inside a sleek Chromium-installed PWA window with a custom, full-bleed green Dock tile that survives browser engine updates.
- **TCC Permission Patches**: Adds required microphone, camera, and Bluetooth usage descriptions (`NSMicrophoneUsageDescription`, etc.) directly into Chromium's `Info.plist` and re-signs the binary. This fixes the `"Chromium" exited unexpectedly` crash that happens when a web page attempts to record voice inputs or initiate WebAuthn hybrid passkeys.

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

## 🛠️ Multi-Account Picker & CLI Usage

NoTrace Browser offers three ways to manage your account workspace:

### 1. Tauri GUI (Recommended)
Launch the graphical workspace switcher:
```bash
# Opens /Applications/Cloak Picker.app
./packaging/pick-account.sh
```
In the GUI, you can create new profiles, rename them (retaining the seed), toggle localized headers, configure region proxies, and boot isolated browser instances concurrently.

### 2. CLI Launches
Launch an account profile directly from your terminal:
```bash
# Launch a profile named "AccountA"
./packaging/launch-account.sh AccountA
```

### 3. SOCKS5 Relay & Network Operations
If your account carries a proxy configuration inside `Accounts/<name>/.cloak-proxy`:
- **Unauthenticated SOCKS5/HTTP**: Configured directly in the browser launch arguments.
- **Authenticated SOCKS5/HTTP**: Starts a background relay (`packaging/proxy-relay.py`) routing authentication over localhost. Automatically shuts down once the browser process terminates to prevent socket leakage.

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
