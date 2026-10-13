# 官方 macOS ARM64 Cloak 154 升级验收

验收日期：2026-10-13，Asia/Shanghai。

结论：已按用户明确接受的 Canvas 共有问题升级至官方
`154.0.8037.57.1 Pro`。结果为 **通过，但保留已知问题**，不能表述为
“全部指纹无损”或“最强抗识别”。官方单会话规则继续生效。

## 安装与来源

- 官方发行：<https://github.com/CloakHQ/CloakBrowser/releases/tag/chromium-v154.0.8037.57.1-pro>。
- 下载器：固定官方 npm `cloakbrowser@0.6.2`，许可证感知下载；保留
  Ed25519 清单签名、版本绑定和 SHA-256 校验，未使用跳过校验开关。
- 官方 ARM64 归档 SHA-256：
  `08526e46462ef0b23aa0deb2e97fe320aa1e9b66dd70fff18a8424b80b5e4073`。
- 官方缓存：`~/.cloakbrowser/chromium-154.0.8037.57.1-pro/`，未修改。
- 当前指针：`~/.cloakbrowser/current` 指向
  `chromium-154.0.8037.57.1-pro-notrace`。
- 实际二进制：该运行目录的 `Chromium.app/Contents/MacOS/Chromium`，
  `--version` 输出 `Chromium 154.0.8037.57.1`。
- 运行副本二进制 SHA-256：
  `c0e29533cbfb7de9a0e43e6dd064cce1f686b264b4ee9ae5e290fcf28d1b57fd`。
- 运行副本保留麦克风、相机及蓝牙 TCC 用途声明，使用
  `ChatGPT Cloak Local Code Signing`。Picker 安装位置为
  `/Applications/Cloak Picker.app`，架构 ARM64。

## 对照结果与边界

151 与 154 顺序运行独立临时配置，使用相同机器、Seed、时区、语言和网络。
两版在 headless 与 headed 模式均出现相同的 Canvas 编码差异，采样值一致。
用户明确选择“接受共有问题，继续验收并升级 154”。测试将该项保持为
`pass=false`、`known-baseline-issue`；仅匹配 151 → 154 的确切版本、探针哈希、
Seed、条件与 Canvas 输出。其他失败仍阻止通过。

| 能力 | 151 基线 | 154 结果 | 判断 |
|---|---|---|---|
| Canvas 像素读取 | HTML/Offscreen 读回一致，编码后原图不变 | 与 151 相同 | 保留 |
| Canvas 编码像素 | HTML toBlob / Offscreen convertToBlob 解码哈希不一致 | 同 Seed 输出与 151 完全相同 | 共有问题，用户已接受 |
| Audio | 可取得指纹摘要 | 可取得指纹摘要 | 保留；未证明重启稳定性全部不变 |
| WebGL | Apple/Mac 渲染器检查通过 | 同项通过 | 保留已测接口；readPixels 全矩阵未验证 |
| UA / Client Hints | 原生接口形状与主版本检查 | 主版本均为 154，原生 NavigatorUAData | 版本变化；不把 fullVersion 等同于发行后缀 |
| CPU / 内存、字体、屏幕 | 可用与基本合理性 | 同项通过 | 基础检查保留；跨 Seed 模板多样性未完整验证 |
| 语言 / 时区 / Worker | 页面与 Worker 时区一致 | 同项通过 | 保留已测范围 |
| WebRTC | 契约无私网 IP 泄漏 | 实站出口 IP 与预检一致，无私网 IP | 保留；真实音视频通话未验证 |
| Cookie / localStorage / IndexedDB | 独立配置隔离 | 两个测试配置隔离通过 | 保留已测范围；未验证真实账号迁移后的全部数据 |
| WebGPU、字体 Seed 区分、Range/DOMRect | 本轮无完整新基线 | 本轮未完整采样 | 未验证 |

154 本地契约：35 项通过，2 项为上述接受的共有问题，报告结论
`PASS_WITH_KNOWN_ISSUE`。JS companion 指纹覆盖默认关闭，不能把模拟覆盖
测试或参数存在当作原生功能已验收。

## 网站与正常启动

七项 headed 检查通过：版本一致性、Cloudflare Turnstile 官方测试 key、
BrowserScan、Sannysoft、BrowserLeaks WebRTC、CreepJS、Fingerprint Pro demo。
Turnstile 检查使用官方始终通过的测试 key，只证明控件与服务端测试验证兼容；
不代表生产挑战全部通过。检测站结果不证明完整抗识别能力。

已安装 NoTrace 的 `Contents/MacOS/cloak` 经默认 `current` 启动临时账号，
使用正常 LaunchServices 路径、真实 headed Chromium；未传二进制或调试接口
覆盖参数。真实 PID 的二进制路径匹配 154，隐私预检无错误，安全沙盒保留。
测试结束后只停止该临时进程，官方席位查询为 `active=0, limit=1`。

电脑操作工具返回 `Computer Use was not approved to use Chromium`，因此
该正常启动窗口的 ChatGPT 页面可视化交互、真实账号登录/对话未验证。
此次没有读取真实 Cookies、密码或 Token。

Picker 前端 140 项测试、TypeScript/Vite 构建通过；原生 E2E 通过，涵盖
标签删除/账号及标签二次确认、选择与定位、授权复用、浏览器关闭后成功凭据
接收、CPA 同步失败后重试及额度显示。该 E2E 使用独立合成浏览器/OAuth/Broker，
不能替代 154 的真实浏览器测试。

## 证据与复现

- 本地对照报告：
  `~/.cloakbrowser/update-gates/chromium-154.0.8037.57.1-pro-notrace/` 下的
  `comparison-151-headed.json`、`comparison-154-headed.json`、
  `baseline-151-headless.json`。
- 最终契约报告：`~/.Trash/cloak-contract.WUPezu/report.json`。
- 真实网站报告：上述门禁目录下
  `live-20261013-123931/report.json`，七项 `passed=true`。
- 正常启动证据：`/private/tmp/notrace154-normal-launch.json`。
- 原生界面报告：
  `~/.Trash/cloak-picker-native-e2e.rfRjqn/cloak-picker-native-e2e-report.json`。
- 验收夹具均处于独立临时目录；结束后用 OS Trash API 回收，核验父目录
  inode/device 与恢复回执。永久删除 UI 测试另留合成账号副本及外部哨兵。

Canvas 复现：按 `packaging/verify-challenge-contract.sh` 读取本机已有 key
并在内部传给临时浏览器，分别指定两个版本的 `CLOAK_BROWSER_BIN`，执行
`selftest/run-selftest.mjs --pair --headless --quiet --result-file <临时报告>`；
不提供 `--canvas-baseline` 时，两版都以 2 个 Canvas 硬失败退出。

首次 154 冷启动曾报 `DevToolsActivePort never appeared`；后续最小对照中
两版均正常启动与退出，最终原始契约也完成采样。该首次超时未有足够证据
确定根因，不归因于内核退步。

## 回退与账号连续性

官方 151 缓存与运行副本保留，签名、版本、TCC 和回退 dry-run 检查通过。
关闭正在运行的浏览器后可执行：

```bash
cd $HOME/Tools/AI-tools/notrace-browser && bash packaging/rollback-chromium.sh 151.0.7922.108.3-pro-notrace
```

此次没有迁移或重写真实账号配置。Seed 和数据保留不代表跨 Chromium
版本后身份完全不变：UA/Client Hints、渲染器与版本相关特征可能变化。
本轮未完成旧 Seed 跨版本全部接口稳定性证明。
