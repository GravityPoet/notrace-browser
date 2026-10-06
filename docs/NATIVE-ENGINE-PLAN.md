# NoTrace 自主原生指纹内核

状态：2026-10-06 公开源码与 ARM64 工具链已准备完成，比较基线构建进行中；未完成内核编译、原生隐私修复或安装。

## 选择

保留 NoTrace / Cloak MIT wrapper 的可复用启动接入，基于 Chromium、ungoogled-chromium 与公开 BSD 原生补丁构建我们自己的内核，不移植或移除 Cloak 专有二进制中的许可代码。Cloak 的公开仓库没有提供它宣称的最新版完整 C++ 补丁，不能将编译其 wrapper 称为重建该内核。

首个可复现 macOS ARM64 基线为 Chromium 152.0.7977.82；公开构建仓库的 Linux/Windows 154 pin 不代表 macOS 源码已升级到 154。先完成相对 Cloak 145/151 与 Chromix 152 的关键原生验收，再沿自己的补丁系列升级 Chromium，不把旧基线说成最终最新版。

采用一个 workspace `.build/native-engine/work`、一个主要输出 `src/out/Default`。源码层均浅历史固定提交，Chromium 使用校验过的源归档，不拉完整历史。正常并发启动，出现实际 OOM/内存压力/链接问题后才降并发。现有本机可用约 81 GiB；阶段间测量实际占用与剩余量，不在未测量前更换机器。空间不足则停在可恢复的阶段，迁往用户指定外接 APFS SSD；不清理真实数据来腾空间。

## 原生优先，不叠加所有补丁

- Canvas：HTML/Offscreen/Worker、像素读取与 PNG 编码统一确定性处理；同账号重启稳定，不同账号分域；不能仅比较 toDataURL。
- WebGL：恢复有界、格式/行布局正确的读回隔离，覆盖 CPU/PBO/导出差异。公开 148 patch 对 RGB/非 RGBA 格式作 RGBA 假设，不能直接照搬到新版本。
- 字体与矩形：主页面/Worker 共用同一种稳定 Seed 推导；字体可用性、度量、DOM/Range/SVG 一致，不以只改主页面掩盖 Worker 本机信号。
- Audio/WebGPU/UA-CH/CPU/内存/屏幕/语言/时区：先建立合理硬件模板和同源一致性，不独立随机每个字段；参数存在不等于原生功能有效。
- 网络与设备：按账号独立配置、隔离存储和代理路径；验证 DNS/WebRTC 出口与真实音视频，不把无 ICE 候选说成音视频完整保留。
- 多会话与自主控制：没有自研席位服务或运行 Key；保留浏览器安全沙盒；不启用需要去掉 renderer sandbox 的远程 Canvas Bridge。

## 发布门槛

先验证补丁实际源码、GN/编译和目标架构，再使用临时账号测试正常 Picker 启动、三会话真实交互、存储隔离/重启、原生矩阵及真实网站。重复差异至少三轮，保护真实 Cookie/Token/密码；不操作生产验证码。旧 Seed 跨内核变化、旧 profile 迁移和回滚单独验证。

在最终内核及安装态证据不足时不切 current、不降级真实 profile、不宣称超过 Cloak 的所有能力。源码锁定见 `packaging/native-engine/source-lock.json`；开发构建参数见 `packaging/native-engine/args.dev.gn`。许可和版权说明随实际采用的源码一起保留。

## 当前可执行的构建入口

依赖为完整 Xcode（SDK 26+）、Apple Metal Toolchain、Python 3、Git、Go、GNU patch (`gpatch`) 和 Ninja；全部检出为固定提交的浅历史。不安装到 `/Applications`，不操作运行中的浏览器或账号。源归档与 LLVM/Node 校验使用公开 pin，Rust 补充官方发布 SHA256。0209 只修正 macOS 152 测试文件尾部上下文；补丁仍以 `fuzz=0` 应用，216 个补丁的反向/正向源码回放已通过。

```bash
cd /Users/moonlitpoet/Tools/AI-tools/notrace-browser && bash packaging/native-engine/prepare-macos-arm64.sh
cd /Users/moonlitpoet/Tools/AI-tools/notrace-browser && bash packaging/native-engine/build-baseline-macos-arm64.sh
```

第二条默认取 `sysctl hw.ncpu`，本机为 10；只有实际失败后才用已有 `CHROMIX_JOBS` 重跑相同目录。这个产物是**公开源码比较基线**，不是“全部原生隐私缺口已修复”的交付版本。新增隐私修复必须独立形成源码补丁与测试，不能把补丁应用、构建成功或架构正确写成抗识别无损。

已复现并修正的构建接入问题：Apple BSD patch 对 0053 不兼容，使用 GNU patch（不降低 fuzz=0）；0209 的 152 测试上下文需要精确重基；LLVM 23 LLD 无法解析本机 SDK 27 的 `arm64e.x1` TAPI，最小 C 链接对照已确认 Apple ld 可用；bindgen 缺少库 RPATH，修正后 `bindgen 0.72.1` 已能正常执行。组件化开发构建须关闭 release 的 `enable_stripping`，否则 Chrome GN 会出现非空 ldflags 覆写冲突。以上都不是并发资源失败，没有因此降低 10 并发。

主编译已启动，并在同一输出目录累计完成 2,500 多个步骤后遇到 LLVM 23 的 PCH/module-name 兼容错误；最小 C++ 头文件对照确认参数影响，关闭 PCH 后继续 10 并发增量编译，不关闭浏览器沙盒。归档缺失的 esbuild 0.25.1 使用 MIT 公开 Go 源码本机构建，提交与 Go 模块校验和已纳入源码锁。磁盘监测只绑定持有本次 `.ninja_log` 的 Ninja PID 和启动时间；剩余低于 8 GiB 时中断编译并保留产物，不删除用户数据，不杀浏览器进程。

2026-10-06：ANGLE Metal 着色器编译发现 Xcode 27 分离的 Metal 组件尚未安装，已通过 Apple `xcodebuild -downloadComponent MetalToolchain` 安装 27A266a，实际 `xcrun metal --version` 回报 `32023.921`。启动前改为检查真实 Metal 输出，不以路径存在或退出码为唯一证明（未安装时 stub 曾打印错误却返回 0）。

2026-10-06 05:30：组件化构建停在 `libui_display.dylib` 的 Rust 分配器符号链接。源码 `build/rust/std/BUILD.gn` 已明确说明预编译 Rust 标准库在组件化构建中存在 ldflags 与分配器依赖传播限制。采用该公开 macOS 配方原本使用的非组件化构建，不臆造分配器替身、不去掉 Rust 或 PartitionAlloc。仍是同一 `out/Default`、10 并发、symbol_level=0、无 ThinLTO；配置宏变化导致受影响对象重编，工具链和源码缓存保留。

候选源码修复已收敛为 0006 一个可回放 overlay：客户端矩形保持原生旧路径关闭、字体真实缓存尺寸按 Seed 缩放、Dedicated Worker 的 `measureText` 使用同一稳定因子；显式 `uxr-native-fingerprint-noise=true` 时启用 C++ 噪声但不启用能力覆盖；合成身份不会隐式开启远程 Canvas Bridge。它尚未应用到当前正在编译的基线，待基线成功后应用、重编并单独验收。
