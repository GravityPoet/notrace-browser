# NoTrace Browser

[English](README.md) | [简体中文](README.zh-CN.md)

NoTrace Browser 是一款专为 macOS 优化的通用、开源、高性能、防关联（防指纹）浏览器客户端。它支持任何需要身份隔离与多账号防封锁的 Web 服务（如 ChatGPT、Claude、Web3 平台、社交媒体、跨境电商等）。项目深度集成了 **CloakBrowser 经 C++ 补丁修改的 Chromium 内核**，并完美融合了 macOS 的原生系统体验（PWA 应用模式、系统级 TCC 权限修护、账号选择器），致力于为您提供一个安全、防关联的多账号身份管理环境。

---

## 💡 为什么选择 NoTrace Browser？

现代 Web 应用、AI 平台和各类在线服务采用了极其严格的风控与机器人检测机制（如 Cloudflare Turnstile、FingerprintJS 和 CreepJS 等），用来持续跟踪用户的硬件指纹与 IP-时区一致性。

当您使用普通的浏览器多开（例如 Chrome Profiles）或原生 WebView（如 Tauri、WKWebView）管理多个账号时，它们**实际上都在共享相同的物理设备指纹、进程环境和系统本地时区**。这极易导致您的多个账号被关联判定为“同设备同用户多开”，从而频繁触发验证码（CAPTCHA）、账号限制甚至被永久封号。

NoTrace Browser 通过为每个账号注入**完全独特、物理隔离的数字指纹与专属网络出口**，并将其无缝包装为 macOS 原生的独立应用形态，从根本上解决了这一难题。

```mermaid
graph TD
    A[Cloak Picker 账号选择器 / CLI] -->|携带特定 Seed & 代理启动| B(NoTrace 账号配置文件)
    B -->|C++ 底层指纹补丁| C[伪装的 Canvas, WebGL, Audio 与 Client Hints]
    B -->|内置代理中转| D[独享且带认证的 SOCKS5 出口]
    B -->|伴侣插件| E[自动匹配的 Intl 时区 / Worker TZ]
    B -->|TCC 权限修复引擎| F[麦克风语音输入 / 蓝牙 Passkey 登录]
    D -->|目标网络| G[目标网站 / AI / Web3 / 社交 / 电商]
```

### ⚡ 功能横向对比

| 功能特性 | NoTrace Browser | 普通 Chrome 多开 (Profiles) | 收费的指纹浏览器 |
| :--- | :---: | :---: | :---: |
| **数据与 Cookie 隔离** | **是** (完全独立的沙盒目录) | **是** (Cookie 隔离) | **是** (独立环境沙盒) |
| **C++ 物理指纹伪装** | **是** (自动随机化 WebGL/Canvas/Audio) | **否** (泄漏真实主机硬件指纹) | **是** (通常需要昂贵的订阅费) |
| **Web Worker 时区对齐**| **是** (深度对齐代理出口 IP 的时区) | **否** (泄漏操作系统的真实时区) | **情况不一** (常漏掉 Workers) |
| **带密码认证的 SOCKS5** | **是** (内置自动 relay 代理守护进程) | **否** (需要第三方慢速插件) | **是** |
| **macOS 原生桌面体验** | **是** (绿色全画幅 PWA 图标 + TCC 权限修护) | **否** (普通的浏览器窗口) | **否** (笨重的 Electron 多开壳) |
| **使用成本** | **100% 免费且开源** | **免费** (但多开 AI 账号风险极大) | **收费** (每月 $50–$300+ 不等) |

---

## 🌟 核心特性

### 1. 深度 C++ 级底层指纹防御
基于 C++ 深度修改的 Chromium 内核，NoTrace Browser 能有效拦截并欺骗 JavaScript 指纹采集：
- **WebGL & GPU 伪装**：隐去真实的 GPU 型号（如 `Apple M4 Pro`），统一上报为通用的 Metal 渲染字符串（`ANGLE (Apple, ANGLE Metal Renderer: Apple M1-M4, Unspecified Version)`）。
- **Canvas & Audio 混淆**：为每个账号注入稳定且唯一的指纹噪音，使得通过 `getImageData()` 和 Audio 接口计算出的浏览器唯一 Visitor ID 完全独立，但看起来又如同真实设备一般合理。
- **Client Hints 与 User Agent**：自动生成合成的 macOS 版本，并搭配符合规范的 GREASE 灰度版本号列表。

### 2. 基于唯一 Seed 的多账号物理隔离
- 通过 `launch-account.sh <name>` 启动账号时，系统会为其生成一个独一无二的随机种子并写入 `.cloak-seed`。
- 进程级别的物理隔离确保了内存空间和 Cookie 容器绝对独立。与 Chromium 的原生多开不同，这保证了账号之间**绝不会因物理设备特征被 OpenAI 关联封禁**。

### 3. IP-时区与 Locale 智能对齐
- **代理中转模块**：支持为每个账号配置专属 Proxy（写入 `Accounts/<name>/.cloak-proxy`）。对于需要密码认证的 SOCKS5 代理 (`socks5://user:pass@host:port`)，由于 Chromium 自身不支持 SOCKS5 代理鉴权，NoTrace 会自动拉起一个轻量本地 SOCKS5 relay 中转进程 (`packaging/proxy-relay.py`)，并在浏览器退出时自动销毁，防止端口占用。
- **时区伴侣插件**：内置 MV3 浏览器插件 (`extension/cloak-companion/`)，不仅能修改主页面线程的 `Intl` 与 `Date`，还能覆盖 Web Workers 线程的时区，确保与您的代理 IP 地理位置完美一致。
- **语言 Locale 对齐**：动态修改浏览器的 `--lang` 和 `Accept-Language` 请求头，确保语系与您的 VPN/Proxy 出口国家相符，杜绝异常标记。

### 4. macOS 原生 PWA 优化与系统 TCC 修复
- **单 Dock 图标体验**：将目标网站包装为 Chromium 风格的独立 PWA 窗口，并应用精心设计的全画幅绿色 macOS 风格 Dock 图标，即使浏览器版本升级图标也不会丢失。
- **TCC 权限补丁修复**：直接将麦克风、摄像头和蓝牙的隐私描述（`NSMicrophoneUsageDescription` 等）注入 Chromium 引擎的 `Info.plist` 并完成 ad-hoc 签名。这彻底修复了当网页请求语音输入或通过蓝牙调用手机 Passkey（免密安全密钥登录）时导致 `"Chromium" 意外退出` 的闪退崩溃问题。

---

## 📁 运行时路径与目录说明

* **日常 PWA 应用路径**：`~/Applications/Chromium Apps.localized/NoTrace Browser.app`
* **CloakBrowser 内核路径**：`~/.cloakbrowser/chromium-<version>/Chromium.app/Contents/MacOS/Chromium`
* **主账号默认 Profile 路径**：`~/Library/Application Support/NoTrace Browser/Profiles/main`
* **多账号隔离沙盒目录**：`~/Library/Application Support/NoTrace Browser/Accounts/<name>`

---

## 🚀 安装与部署

### 第一步：克隆仓库并编译账号选择器
如果您希望使用直观的原生多账号图形选择器（基于 Tauri 开发的日间模式界面）：
```bash
# 构建 Tauri 账号选择器并安装至 /Applications/Cloak Picker.app
./packaging/install-cloak-picker-app.sh
```

### 第二步：修补 Chromium TCC 系统权限
执行权限修补和证书签名，以启用语音输入及 Passkey 登录功能，防止崩溃：
```bash
./packaging/patch-chromium.sh
```
*提示：每当 CloakBrowser 大版本更新后，请重新运行一次该脚本。*

### 第三步：应用原生绿色 Dock 图标
默认的 PWA 图标会在白底中内嵌一个绿色的缩略图。通过以下脚本将其替换为精美、全画幅的 macOS 绿底图标：
```bash
./packaging/set-pwa-icon.sh
```

### 第四步：安装时区同步浏览器插件
1. 在浏览器中打开 `chrome://extensions`。
2. 开启右上角的 **开发者模式 (Developer mode)**。
3. 点击 **加载已解压的扩展程序 (Load unpacked)**，并选择本仓库下的 `extension/cloak-companion/` 目录。
4. 点击工具栏的插件图标，勾选 **自动匹配当前 IP**。

---

## 🛠️ 多账号管理与 CLI 使用

NoTrace Browser 提供了三种方式来管理您的 AI 账号工作区：

### 1. Tauri 图形界面 (推荐)
打开原生的多账号图形工作区面板：
```bash
# 打开 /Applications/Cloak Picker.app
./packaging/pick-account.sh
```
在该面板中，您可以一键创建、重命名新账号（重命名不会改变其指纹 Seed）、切换 Locale、配置每个账号的出口代理，并同时并发启动多个互相独立的浏览器实例。

### 2. Terminal 命令行直接启动
在终端中直接带隔离参数拉起指定的浏览器环境：
```bash
# 启动名为 AccountA 的独立环境
./packaging/launch-account.sh AccountA
```

### 3. SOCKS5 代理鉴权与中转
如果某个账号在 `Accounts/<name>/.cloak-proxy` 中配置了代理：
- **无密码代理**：直接作为浏览器启动参数生效。
- **带密码认证的 SOCKS5/HTTP 代理**：将自动在后台启动代理中转守护程序 (`packaging/proxy-relay.py`) 以转发流量。浏览器一旦关闭，中转服务也会随之销毁，确保系统资源干净无残留。

---

## 🔍 指纹防关联审计与状态验证

我们使用持续集成验证脚本对市面主流的防关联/Bot 检测网站进行了长期测试：

### 运行 headed 实时审计
要查看当前浏览器在有头模式下的具体指纹得分：
```bash
node selftest/run-live-challenge-audit.mjs --headed --site browserscan --site fingerprintjs
```

### 运行自动化一致性验证
验证 CLI 参数、扩展绑定和无头隐私环境：
```bash
./packaging/verify-challenge-contract.sh
```

### 当前防关联测试矩阵
* **`navigator.webdriver`**：完美隐藏（bot.sannysoft.com 各项检测均为 Green 通过）。
* **WebRTC 真实 IP 泄漏**：全面拦截（绝不泄露您的物理真实局域网与外网 IP）。
* **BrowserScan 综合评估**：检测结果为 “Bot Detection: No Detection”（无机器人指纹暴露）。
* **CreepJS 指纹评分**：0% headless / 0% stealth 警示，成功伪装出活跃的 Metal 渲染器和一致的 WebGL 调用。
* **FingerprintPro 追踪器**：每个账号均能产出固定但相互独立的 Visitor ID，不触发任何欺诈/代理异常警示。

---

## ⚠️ 局限性与避坑指南

* **内置网页翻译不可用**：CloakBrowser 采用了 *ungoogled-chromium* 编译版，在网络底层剥离了 Google 域名（重定向至 `chrome.9oo91e.qjz9zk`）和 Chrome 应用商店接口。因此，Chromium 右键的“翻译此页”会报错失效。
  * *避坑方案*：将您喜欢的翻译插件（如沉浸式翻译等）打包为 **已解压的扩展程序** (unpacked) 并在您的账号 Profile 页面手动加载即可。
* **原生 PWA 的启动参数限制**：如果您从 Launchpad 或 Dock 直接点击创建的单 ChatGPT PWA 应用（对应 `main` profile），macOS 的快捷方式机制不支持在启动时追加命令行 flag（例如 `--proxy-server` 或 `--fingerprint-webrtc-ip` 无法直接传入）。如需要严格的代理隔离与高级 Seed 指纹防关联，请务必使用 **多账号选择器 (Cloak Picker)** 启动独立实例。
