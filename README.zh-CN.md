# NoTrace Browser

[English](README.md) | [简体中文](README.zh-CN.md)

NoTrace Browser 是一个源码可见、专注 macOS 的编排与多账号管理客户端，用于启动用户单独安装的 **CloakBrowser C++ 补丁 Chromium 内核**。本仓库包含原生选择器、CLI、账号目录隔离、代理中继、伴侣扩展和打包脚本；不包含、也不重新分发 CloakBrowser 二进制内核。

> [!IMPORTANT]
> **NoTrace 客户端与浏览器内核的分发条款彼此独立。** 请从 CloakBrowser [官方仓库](https://github.com/CloakHQ/CloakBrowser)、[官方 Releases](https://github.com/CloakHQ/CloakBrowser/releases) 或 [官网](https://cloakbrowser.dev/) 获取内核。上游目前声明 wrapper 采用 MIT 许可，二进制采用延迟免费发布模式（较旧版免费，最新版为 Pro）。使用或再分发前请核对上游当前条款。本 NoTrace 仓库目前未包含项目许可证，“源码可见”本身不等于授予复用或再分发权。

---

## 💡 为什么选择 NoTrace Browser？

现代 Web 应用、AI 平台和各类在线服务采用了极其严格的风控与机器人检测机制（如 Cloudflare Turnstile、FingerprintJS 和 CreepJS 等），用来持续跟踪用户的硬件指纹与 IP-时区一致性。

当您使用普通的浏览器多开（例如 Chrome Profiles）或原生 WebView（如 Tauri、WKWebView）管理多个账号时，它们**实际上都在共享相同的物理设备指纹、进程环境和系统本地时区**。这极易导致您的多个账号被关联判定为“同设备同用户多开”，从而频繁触发验证码（CAPTCHA）、账号限制甚至被永久封号。

NoTrace Browser 通过为每个账号分配**稳定 Seed、独立 Profile 目录和可选的专属网络出口**，降低账号之间意外共用环境的概率。

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
| **系统原生桌面体验** | **是** (PWA 模式 + 权限/沙盒修护) | **否** (普通的浏览器窗口) | **否** (笨重的 Electron 多开壳) |
| **使用成本** | **NoTrace 源码可见；CloakBrowser 内核单独分为免费 / Pro** | **免费** (但多开 AI 账号风险极大) | **收费** (每月 $50–$300+ 不等) |

---

## 🛡️ 隐私防关联与检测绕过机制

NoTrace Browser 将 CloakBrowser 的源代码级内核补丁、伴侣扩展和按账号启动配置组合使用。这些机制用于降低账号关联信号；实际结果仍取决于具体内核版本、代理质量、网络路径和目标站点持续变化的检测逻辑。

### 1. WebGL/GPU 渲染器伪装
隐去真实的 GPU 型号（如 `Apple M4 Pro`），基于账号 Seed 注入随机化的 Apple M1–M4 渲染配置，统一上报为通用的 Metal 渲染字符串（`ANGLE (Apple, ANGLE Metal Renderer: Apple M1-M4, Unspecified Version)`，Vendor 为 `Google Inc. (Apple)`），用于减少可能导致 CreepJS 出现“like headless”提示的渲染特征矛盾。

### 2. WebRTC IP 泄露物理隔离
利用 CloakBrowser 底层的 `--fingerprint-webrtc-ip` 参数，NoTrace 会请求受支持的内核版本在 WebRTC candidate 中呈现已配置的代理出口 IP。浏览器、网络和代理行为仍可能影响泄漏测试，每次更换内核或代理后都应重新运行实时审计。

### 3. UA 与高熵客户端提示 (Client Hints) 一致性
如果只修改 User Agent 却不改 Client Hints，会产生版本一致性矛盾。NoTrace 同步 User Agent 与 `navigator.userAgentData` 的高熵属性（包括 `fullVersionList`、`platformVersion` 和 `architecture`），用于减少应用层不一致。网络层 TLS 特征仍取决于所用内核版本与网络路径。

### 4. 无损 Canvas 与 Audio 噪声扰动
- **Canvas 噪声**：如果持续扭曲 Canvas 画布会导致网页图像绘制异常。NoTrace 仅在网页调用 `toDataURL` 和 `toBlob` 导出图像时拦截，临时为 8 个像素注入微小的 Seed 颜色偏置，提取数据后**立刻恢复像素原状**。这会产生按账号区分、对同一 Seed 稳定的输出，且不会故意改变可见画布。
- **Audio 噪声**：拦截 `OfflineAudioContext.startRendering` 生成的音频信号，并在返回的 `AudioBuffer` 采样点中，按特定步长注入 $10^{-7}$ 级别的微小偏置，从而干扰 Audio 唯一指纹。

### 5. Web Worker 级时区物理同步
普通插件无法将时区脚本注入到 Web Workers 线程中运行。NoTrace 在启动时同时应用 `--fingerprint-timezone` 参数与 `TZ` 环境变量，使受支持的内核版本能够对齐主页面与 Web Workers 的时区。

### 6. 防检测 API 垫片与反劫持防护
- 补齐了在自动化/无头浏览器中常常缺失的 API（如 `ContentIndex`、`navigator.contacts` 下的 `ContactsManager`、`navigator.connection` 的 `downlinkMax`）。
- 将所有劫持逻辑隐藏于 Proxy 之下，并修改 `Function.prototype.toString.toString()` 使其保持原生态格式，防止风控脚本探测到 JavaScript 函数被代理污染。

---

## ⚙️ 内置 Rust 多线程代理中转守护程序

Chromium 自身并不原生支持带有用户名密码认证的 SOCKS5 代理 (`socks5://user:pass@host:port`)。

NoTrace Browser 在 CLI 内部直接集成了一个用 Rust (基于 Tokio 与 Rustls 库) 编写的**多线程代理中转守护进程 (Proxy Relay)**。
- **自动生命周期管理**：当拉起配置了认证代理的账号时，CLI 会自动在后台开启该代理中转，随机绑定一个本地空闲 TCP 端口，通过 Socks5 握手自检成功后引导浏览器连接该端口。
- **零资源泄漏**：主进程退出时，Relay Supervisor 会自动销毁后台中转程序，防止残留进程占用系统端口和套接字。
- **支持协议**：SOCKS5 (无认证 / 用户名密码认证)、HTTP 以及 HTTPS (使用 Rustls 的 TLS 隧道)。

---

## 🛠️ `cloak` 命令行管理工具箱

NoTrace Browser 的每个账号工作区都可以通过编译生成的 `cloak` 命令行工具实现完全的自动化管理。

| 子命令 | 语法结构 | 描述 |
| :--- | :--- | :--- |
| **列出活跃账号** | `cloak account list [--json]` | 列出所有处于活跃状态的账号，展示 Seed 种子和代理配置。 |
| **列出回收站** | `cloak account list-trashed [--json]` | 列出已被移入回收站（软删除）的账号目录。 |
| **创建账号环境** | `cloak account create <name> [--json]` | 创建一个新的隔离账号工作区，生成并锁定独立的 Seed 指纹。 |
| **重命名账号** | `cloak account rename <old> <new>` | 重命名账号，同时安全继承其稳定的 Seed 和数据，不影响指纹。 |
| **软删除账号** | `cloak account delete <name>` | 安全将账号工作区移至回收站，可随时还原。 |
| **硬删除账号** | `cloak account purge <name>` | 永久从磁盘中擦除账号文件夹的全部数据。 |
| **还原账号** | `cloak account restore <name>` | 将处于回收站的账号恢复为活跃状态。 |
| **设置出口代理** | `cloak account set-proxy <name> [url] [--clear]`| 为账号绑定指定的代理服务器 (SOCKS5/HTTP/HTTPS)。 |
| **设置区域约束** | `cloak account set-region <name> [code] [--clear]`| 绑定地理区域标识，防止国家/时区对齐出现偏差。 |
| **设置账号分组** | `cloak account set-group <name> [group] [--clear]`| 将账号归入特定的分组，方便批量管理。 |
| **设置账号标记** | `cloak account set-mark <name> [note] [--clear]`| 为账号添加红色圆圈提醒和可选的 24 字符备注；使用 `--clear` 可取消。 |
| **语言跟随开关** | `cloak account toggle-locale <name>` | 开启/关闭让浏览器的 Accept-Language 等随出口 IP 自动同步。 |
| **显示账号配置** | `cloak account show <name> [--json]` | 打印账号环境的所有详细元数据配置。 |
| **启动浏览器实例**| `cloak launch <name> [--dry-run] [--skip-geo]`| 带指纹参数拉起实例。`--dry-run` 仅输出最终组装的启动 flags。 |
| **环境自我诊断** | `cloak self-check [--json]` | 校验 CloakBrowser 内核完整性、签名以及插件目录是否准备就绪。 |

---

## 🍎 macOS 原生桌面体验与 TCC 系统权限修护 (macOS 专属)

NoTrace Browser 针对 macOS 系统环境进行了深度的专属适配：

- **顽固的绿色桌面图标**：Chromium 在更新 PWA 快捷方式时会自动重写并覆盖 `app.icns`，导致自定义图标丢失。NoTrace 通过 `NSWorkspace setIcon:forFile:` 接口，强行在 Bundle 根目录下设置 Finder 级的自定义 Custom Icon (`kHasCustomIcon` 属性与 `Icon\r` 资源文件)。这使得 LaunchServices 和 Dock 能持久锁定绿色的应用图标，**即使浏览器内核重构更新也不会丢失**。
- **系统级 TCC 权限修护**： ad-hoc 签名编译的 Chromium 内核默认缺少麦克风、摄像头和蓝牙的隐私描述。当网页尝试录音时，macOS 系统安全组件 (TCC) 会直接强行闪退该进程。NoTrace 的 `patch-chromium.sh` 脚本在打包时将 `NSMicrophoneUsageDescription`、`NSCameraUsageDescription` 与 `NSBluetoothAlwaysUsageDescription` 写入 `Info.plist` 并重新签名，彻底解决了网页语音输入和手机蓝牙 Passkey 登录时的系统崩溃闪退问题。

---

## 📁 运行时路径与目录说明

* **日常 PWA 应用路径**：`~/Applications/Chromium Apps.localized/NoTrace Browser.app`
* **CloakBrowser 内核路径**：`~/.cloakbrowser/chromium-<version>/Chromium.app/Contents/MacOS/Chromium`
* **主账号默认 Profile 路径**：`~/Library/Application Support/NoTrace Browser/Profiles/main`
* **多账号隔离沙盒目录**：`~/Library/Application Support/NoTrace Browser/Accounts/<name>`

---

## 🚀 安装与部署

### 前置步骤：单独获取 CloakBrowser 内核
请按当前[官方安装说明](https://github.com/CloakHQ/CloakBrowser#install)完成首次下载或启动，确保 Chromium 应用包存在于 `~/.cloakbrowser/chromium-*` 下（也支持可选的 `~/.cloakbrowser/current` 软链接）。请根据上游当前授权条款选择免费或 Pro 内核。NoTrace 安装脚本不会为您下载或授权该二进制文件。

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

## 🔍 指纹防关联审计与状态验证

本仓库提供本地契约检查与有头实时审计脚本。外部站点的检测结果只是特定时点的观测，不是永久保证；每次更换 CloakBrowser 版本、代理或网络路径后，都应对实际环境重新运行。

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

### 验证目标
* **`navigator.webdriver`**：确认实时页面未暴露自动化状态。
* **WebRTC 真实 IP 泄漏**：确认 candidate 未暴露真实局域网或公网 IP。
* **BrowserScan**：记录当前内核版本的 Bot Detection 结果。
* **CreepJS**：检查 headless / stealth 警示与渲染器一致性。
* **FingerprintJS Pro**：对比同一账号内 Visitor ID 的稳定性与不同账号之间的区分度；欺诈/代理评分应视为站点依赖结果。

---

## ⚠️ 局限性与避坑指南

* **内置网页翻译不可用**：CloakBrowser 采用了 *ungoogled-chromium* 编译版，在网络底层剥离了 Google 域名（重定向至 `chrome.9oo91e.qjz9zk`）和 Chrome 应用商店接口。因此，Chromium 右键的“翻译此页”会报错失效。
  * *避坑方案*：将您喜欢的翻译插件打包为 **已解压的扩展程序** (unpacked) 并在您的账号 Profile 页面手动加载即可。
* **原生 PWA 的启动参数限制**：如果您从 Launchpad 或 Dock 直接点击创建的单 PWA 应用，macOS 的快捷方式机制不支持在启动时追加命令行 flag（例如 `--proxy-server` 或 `--fingerprint-webrtc-ip` 无法直接传入）。如需要严格的代理隔离与高级 Seed 指纹防关联，请务必使用 **多账号选择器 (Cloak Picker)** 启动独立实例。

---

## 🤝 致谢与致敬 (Credits & Acknowledgements)

NoTrace Browser 负责编排用户单独获取的 **CloakBrowser** Chromium 内核，并增加 macOS 原生选择器、账号工作区管理、代理工具和伴侣扩展集成。上游 wrapper 与二进制有各自的授权和发布条款；NoTrace 不捆绑内核二进制，用户与分发者必须遵守当前 [CloakBrowser 条款](https://github.com/CloakHQ/CloakBrowser#cloakbrowser-pro)。
