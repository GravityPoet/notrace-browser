# 自编译 NoTrace 原生内核：最低发布门槛

## 2026-10-07 收尾状态

本次收尾已将本机 `current` 指向自编译 native 152：
`chromium-152.0.7977.82-native-notrace`。这是保留完整快照后的本机候选切换，
不是把“多开成功”包装成完整无损发布批准；下表仍明确列出尚未证明的 Cloak 专有能力和
跨接口差异。旧 Chromix 152 保留在 `chromium-152.0.7977.82-notrace`，可通过
`packaging/switch-independent-engine.sh` 回滚。

| 能力 | Cloak/现生产基线 | 自编译 native 152 当前证据 | 结论 |
|---|---|---|---|
| 正常 Picker/账号启动 | 已安装 `/Applications/Cloak Picker.app` | Picker 新建账号自动选中并显示启动按钮；真实安装版原生 E2E 13/13、freshness、签名和 ARM64 门禁通过 | 保留 |
| 三会话并发 | 原 Cloak 受单席位限制 | 正常 LaunchServices 路径三进程、三可见窗口、三独立 profile；Cookie/localStorage/IndexedDB 隔离，重启保留 | 新增并发 |
| Canvas / Offscreen / Worker | 旧实现有跨接口差异 | native 自测两 Seed 哈希区分且稳定；HTML/Offscreen/Worker 与 PNG 解码路径一致，导出后页面像素不漂移 | 已测范围保留 |
| Audio | 原生可用；未证明按 Seed 隔离 | OfflineAudioContext 可用，两个 Seed 的合成音频哈希相同 | 原生功能保留；Seed 隔离未证明 |
| WebGL/WebGPU | 原基线有 Seed/GPU 模板能力 | WebGL M3/M4 渲染器按 Seed 区分；WebGPU 计算路径在既有审计中通过 | 已测范围改善/保留 |
| UA/Client Hints/语言 | 版本依赖 | 真实 Chromium 152、UA-CH architecture=arm、bitness=64、fullVersion=152.0.7977.82；当前默认中文语言路径通过 | 保留；多语言完整矩阵未验证 |
| 时区/Worker | 已有参数接入 | 主页面与 Worker 均 Asia/Tokyo，偏移一致 | 保留 |
| WebRTC | 原 Cloak 可绑定出口 IP | native 使用 `disable_non_proxied_udp`；本地无私网候选，但没有出口 IP 改写等价证据 | 变化；不能宣称无损 |
| 真实网站 | 匿名 ChatGPT/Cloudflare 可用 | native 可见窗口三轮匿名 ChatGPT 正常加载输入区，Cloudflare 主站正常；未登录、未发消息、未解验证码 | 辅助证据；不是 Picker 账号路径的生产抗识别证明 |
| 本地签名 | 本机统一 identity | Picker、current 152、native 152、151 本地副本及 helper 均为 `ChatGPT Cloak Local Code Signing`，deep strict verify 通过 | 完成 |

### 最终裁决

**结论：本机已切入 native 152；多会话和已测原生能力成立，但完整无损替代仍为证据不足。**

保留 native 候选、旧 Chromix 152、源码构建目录和账号快照，不删除、不覆盖真实账号数据。
若出现真实网站或媒体能力退步，先停止继续扩大测试，按快照和
`packaging/switch-independent-engine.sh` 回滚到旧 `current`；“数据保留”不等于“跨内核身份完全不变”。

明确未完成/未验证：WebRTC 出口 IP 绑定等价性、真实麦克风/摄像头、远程 TURN TCP/TLS、完整 AudioWorklet/Analyser 全路径、TLS/HTTP2/3 指纹、生产登录账号连续性、生产验证码泛化，以及所有 Cloak 专有能力的逐项等价证明。

## 2026-10-07 安装态证据与失败复现

- 安装态：`/Applications/Cloak Picker.app`，`CFBundleIdentifier=local.cloak.picker`，
  `cloak-picker` 为 macOS ARM64；`ChatGPT Cloak Local Code Signing` 的
  `codesign --verify --deep --strict` 通过。全局安装门禁报告
  `FILESYSTEM_MATCHES=1`、`SPOTLIGHT_MATCHES=1`、`LAUNCHSERVICES_MATCHES=1`、
  `RUNNING_MATCHES=0`、`SIGNATURE=valid`、`INSTALL_STATUS=passed`。
- 内核：`/Users/moonlitpoet/.cloakbrowser/current` 指向
  `chromium-152.0.7977.82-native-notrace`；真实二进制输出
  `Chromium 152.0.7977.82`。`verify-independent-runtime.mjs` 通过，
  `current.sha256` 与当前二进制均为
  `5b95c01591a47db3b584741f0943516d4c247507b24181b0b35eb352f7087261`。
- 连续性：切换前完整快照为
  `/Users/moonlitpoet/.cloakbrowser/backups/independent-engine-20261007-022709.Qy2ZDC.noindex`；
  `snapshot.json` 的 `previous_version` 为 `152.0.7977.82-notrace`，
  账号树摘要为 `3fc44e6c7bb07b04f10886a4e23163f7ffe312376fda4092f294d292e4496c0a`，
  未读取或输出密码、Token、真实 Cookie。
- Picker 运行态：`npm --prefix cloak-picker test` 通过 3 个测试文件、99 个测试；
  安装后的 `bash packaging/test-picker-native-e2e.sh` 通过真实签名 `.app`、真实原生窗口和
  13 项检查，使用临时合成账号/Broker/启动夹具。

失败复现与修复：旧 E2E 在“首次同步失败 → 点击重试”后，先后复现过
`同步成功后仍显示旧错误`，以及在改为只查 row 后复现“同步失败没有展示具体原因”。前者是
React 重渲染后继续读取已脱离 DOM 的旧 row，后者是同步错误实际挂在工作区级 alert 而不是
row 内。最终驱动每次状态变化重新查询当前 row，并在工作区按“服务器文件读写失败”具体文本
定位错误；成功条件同时要求当前 row 已显示“CPA已同步”且该具体错误消失。修复后重新构建、
安装并复跑，13/13 通过。

用户要求：自编译版本至少比免 Key Cloak 145 更强，且保留先前相对 Cloak 151 的关键能力验收，不以版本号、补丁数或多开本身代替结论。

## 基线与来源

- 免 Key 145：macOS `145.0.7632.109.2`，实际 Chromium `145.0.7632.109`。既有正常三会话、三 Seed、重启与原生采集证据见 `selftest/live-results/2026-10-05-keyless-comparison/分析报告.md`；已覆盖最终条件的结果可复用。
- 145 历史源 tag `chromium-v145.0.7632.109.2` 指向 `5d7f7360d889030d70492a86302aaf45db557e33`。完整 Git tree 52 个文件，没有 `.cc/.cpp/.h/.patch/BUILD.gn/DEPS` 内核文件。历史 `BINARY-LICENSE.md` 为 1.0（2026-02），把 MIT wrapper 与 Cloak 自有构建配置/补丁/二进制区分。此为源码可得性核对，不是笼统法律结论。
- 原 151：使用既有合法单会话顺序采集；不得为了测试绕过它的授权或关闭用户浏览器。
- 自编译原生候选：公共 Chromium/ungoogled/公开 BSD 原生实现与自己的源码补丁；不修改专有 Cloak 二进制。编译成功不等于指纹生效。

## 必须通过

| 项目 | 145 已测基线 / 已知问题 | 自编译候选最低要求 |
|---|---|---|
| Canvas | Seed 区分和重启稳定；HTML PNG 与像素存在矛盾 | 保留区分/稳定；HTML、Offscreen、Worker、原始像素及真正 PNG 解码一致；裁剪、透明、重复读取不漂移 |
| WebGL 1/2 | readPixels 按 Seed 区分，页面/Worker一致 | 保留原生区分与稳定，补齐 RGBA/RGB 行布局、合法浮点读回、PBO、编码导出/复制路径对照；不可只覆盖 CPU Uint8 |
| 字体 | 主页面 Seed 差异；Worker 泄露未隔离值 | 原生实现覆盖主页面/Worker 与实际绘制；measureText/DOM/Range/SVG/字体可用性不出现新增矛盾；不以 JS getter 覆盖充数 |
| DOM/Range | 145 Range 有差异；151 Element 也有差异 | 按各版本真实证据对照；关键隔离不能缺失，布局/输入/绘制一致性必须核验 |
| 屏幕、语言、UA | 145 Screen/CSS、语言接入矛盾，bitness 不完整 | 改善跨接口一致性，真实版本 UA/CH，页面与 Worker 同步；不伪装版本 |
| Audio/WebGPU | 原生功能可用；145 未证明全部 per-Seed 音频/硬件隔离 | PCM/Analyser/Worklet、GPU计算与身份/限额联合检查；未验证不得写保留或更强 |
| 网络/WebRTC | 145 本次 0 候选、媒体回环失败；151 有出口候选 | 出口/私网/DNS泄漏与真实可用性分别报告；禁止非代理UDP不等于出口IP绑定，不能以禁用媒体冒充无损 |
| 多开和存储 | 正常 NoTrace 三会话、合成 Cookie/LS/IDB 隔离并重启保留 | 通过 `/Applications/Cloak Picker.app` 正常路径复测，同账号稳定、各账号隔离，不只测自定义脚本或 headless |
| 网站表现 | 匿名 ChatGPT 交互成立，完整生产抗识别未证明 | 同出口与公平环境，ChatGPT/CF/Turnstile/可靠指纹页记录实际加载/交互；差异至少三轮并排除网络/代理/缓存/调试影响；不解验证码 |
| 自主控制 | 145 不提供 Key 可三开 | 自建内核不依赖上游授权/席位；保留安全沙盒。数据保留和身份不变必须分开表述 |

## 裁决

关键指纹缺失或网站结果可重复地明显退步：**未达标，存在实质退步**。编译/接入/测试不完整：**证据不足**。只有在上表已测范围关键能力不退步、明确改善旧矛盾、正常并发和安装态成立时，才可报告“在已测范围达标”，并列出未验证项；不得宣称绝对最强或全网不可关联。

真实账号、密码、Token、真实 Cookie 不参与采集。旧 Seed 跨内核变化、账号迁移与回滚独立验收；当前生产内核不因基线编译成功而自动替换。
