# fnos-HStudio

`fnos-HStudio` 是 `EKKOLearnAI/hermes-studio` 的独立 fnOS 薄适配仓库。FPK 不携带 Node.js、Python、Hermes Agent 源码或编译工具；运行时依赖 fnOS `nodejs_v24` 与 `python312`，并可在数据目录缓存官方预构建 Hermes Studio Runtime。Hermes Agent 的首次安装、启用和更新统一交给 Hermes Studio 版本管理，Manager 只识别并使用当前启用的 Runtime，不再创建另一套安装。

项目仓库：https://github.com/leen2175/fnos-HStudio

fnOS 应用身份固定为 `appname=HStudio`。当前 FPK 版本为 `0.0.60`，目标平台为 x86_64，Hermes Studio 使用上游默认端口 8648。

## 项目结构

- `app/`、`cmd/`、`config/`、`wizard/`：FPK 内容与 fnOS 生命周期。
- `manager/`：轻量 Manager 后端与静态管理页。
- `scripts/`、`tests/`：构建与回归检查。
- `docs/`：架构、迁移、构建与上游约束。
- `.agents/skills/trim-cli/`：fnOS 官方公共工具的 Skill 源，仅保留 FPK 使用的 Linux x86_64/ARM64 CLI 与配套文档。
- `artifacts/`：构建时生成的本地输出目录；只保留最近三个 FPK 版本。

## 运行模型

- `cmd/lib/environment.sh` 从 `TRIM_PKGHOME/data` 派生 `$HOME`、`$HERMES_WEB_UI_HOME` 和 `$HOME/.npm-global`；不再把旧的 `data/hermes-agent/venv` 注入 PATH 或强制覆盖 Studio 的 Runtime 选择。
- `cmd/lib/runtime.sh` 按 `auto → user-global → bundled` 选择健康 Runtime；bundled 内部再按 `current → previous → legacy` 回退。只有精确进程路径和 HTTP 健康检查都通过后才提升 previous，用户选择保存在 `data/manager/state.json`。
- `cmd/lib/process.sh` 只依据本应用 PID 文件停止进程，不扫描或杀死其他用户进程；服务端口按 `HERMES_PORT → TRIM_SERVICE_PORT → 8648` 解析，启动与健康检查始终使用同一端口。fnOS 的应用状态以 Manager 控制面为准，Studio 单独存活不会掩盖 Manager 退出。
- 用户数据位于 `TRIM_PKGHOME/data`。升级回调不会删除或覆盖 user-global Runtime、凭据、数据库和日志；Runtime 缺失时由 Manager 在线恢复，FPK 升级不触发网络安装。
- FPK 内置 fnOS 官方公共工具 `trim-cli` 的 Skill 和 Linux x86_64/ARM64 CLI。安装时默认部署到 Hermes、Codex/Pi、Claude Code 的发现目录；已有 Skill 保留不覆盖。HStudio 运行时使用的架构匹配副本位于 `data/tools/bin/trim-cli`；`usr-local-linker` 暴露的是包内 Skill wrapper，由它选择对应架构的 CLI。
- 启动 Studio 前会把当前 Runtime 的 `dist/skills` 与 `trim-cli` 原子合并为托管源，避免 `HERMES_WEB_UI_SKILLS_DIR` 的排他语义遮蔽上游内置 Skills。

Manager 通过 Unix socket 提供本地 API，并由 `app/ui/config` 注册为唯一的只读桌面入口。界面只有“总览”“Agents”“设置”三个标签；总览同时展示 HStudio、Hermes Studio Runtime 状态及启动、停止、重启和更新操作。顶部的“打开 Hermes Studio”优先使用可选的 `HSTUDIO_PUBLIC_URL`；未配置时，域名入口沿用 fnOS 的 `hstudio.<主机>` 形式，IP/localhost 则使用同主机的实际服务端口。设置页可选在 Runtime 健康时每个 Manager 会话尝试自动打开一次 Hermes Studio，浏览器拦截时仍使用右上角手动入口。管理员操作要求 fnOS 网关注入的 `X-Trim-Userid` 与 `X-Trim-Isadmin` 请求头；明确的 cross-site 请求会被拒绝，日志在完整输出边界统一脱敏 token、cookie、password 等敏感字段。

设置页的 FPK 更新功能当前只读取 `leen2175/fnos-HStudio` 的最新 GitHub Release，以结构化状态展示当前版本、最新版本、检查时间和发布页，与 Studio Runtime 更新相互独立；无 Release、检查失败与确有更新是不同状态。缓存命中时仍会按当前 FPK 重新比较版本，网络失败使用短期缓存避免反复请求。该功能尚不校验 Release 中是否存在兼容的 FPK，也不会下载或安装 FPK，因此不能更新 Manager 自身。完整 FPK 升级仍需通过 fnOS 应用中心手动安装，开发或重复测试也可使用 `appcenter-cli install-fpk`。

总览中的 Hermes Studio 状态卡片只在需要时显示安装、重试或确有新版本的更新；启动、停止、重启与更新都会按后台任务持续反馈结果。前端只轮询轻量操作状态，任务完成后才重新探测 Runtime 和 Agents。更新前比较严格 SemVer，禁止 npm latest 低于当前 Runtime 时降级。更新会先在隔离目录取得并校验精确版本，停止 Studio 后才原子切换；带校验和的阶段 journal 可在 Manager 被终止或断电后自动回滚，损坏 journal 则保留并 fail-closed。成功后重建 Skill 合并源，大目录旧包在正确性提交后延迟清理。

`Agents` 页使用同一组卡片统一管理 Hermes Agent、Claude、Codex、Pi 和 Grok，Hermes Agent 固定排在首位。Hermes Agent 检测先读取 `hermes-home/desktop-runtime/active-version.json`，再用该 Runtime 自带的 Python 做真实导入探测；已启用 Runtime 才显示“已安装”，其版本、Python、浏览器组件和命令路径都来自同一目录。Hermes 的安装、更新、修复和删除按钮打开 Hermes Studio 版本管理；旧的独立 Git/venv 只会显示“需修复”，不会覆盖当前 Runtime。Agent Bridge 使用 `TRIM_PKGVAR` 下的 Unix socket（缺失时回退到 `data/run`）。Claude（`@anthropic-ai/claude-code`）、Codex（`@openai/codex`）、Pi（`@earendil-works/pi-coding-agent`）和 Grok（`@xai-official/grok`）统一写入应用用户的 `.npm-global`，支持安装、更新和删除；Pi 同时管理 `pi-mcp-adapter`。

Hermes Runtime 完全由 Hermes Studio 下载、校验、启用和更新；Manager 不再暴露独立 Git 安装入口。页面显示的 Agent 版本、Runtime 版本、Python、浏览器组件和命令路径来自同一个已启用 Runtime。历史 `data/hermes-agent` 不会自动删除，便于需要时手动回退或清理。

设置页提供受控的 npm、Python 镜像切换和 FPK 更新检查。npm 可选择官方、npmmirror、腾讯云、华为云或 Yarn，Python 可选择官方 PyPI、清华 TUNA、中科大、阿里云或华为云；只接受这两组固定 HTTPS 白名单。选择分别持久化到 `data/manager/npm-registry.json` 和 `data/manager/python-registry.json`：npm 同步写入应用 `.npmrc`，Python 同步写入应用 `pip.conf` 并设置 pip/uv 标准环境变量。Runtime bootstrap、Studio 更新和 Coding Agents 使用 npm 镜像；Hermes Runtime 内的 pip/uv 操作在重启 Studio 后使用 Python 镜像，预构建 Runtime archive 的下载源仍由 Hermes Studio 版本管理选择。

## 构建

```bash
python3 scripts/build-thin-fpk.py --output-dir artifacts
```

FPK 安装阶段只安装适配层并启动 Manager，不携带 Studio Runtime。首次 bootstrap 优先断点下载并校验官方 GitHub Runtime archive；GitHub 不可达时，可在隔离临时前缀从所选 npm 镜像取得固定版本，再经相同健康检查发布为 bundled Runtime，绝不写坏用户 `.npm-global`。Hermes Agent 源码和 Python wheels 仍需首次安装时联网获取，并使用 Hermes Studio 固定的版本与依赖哈希。所有 FPK 输入使用显式白名单，未跟踪缓存或备份不会进入产物；构建器会在 `artifacts/ARTIFACTS.md` 生成当前产物及校验值。

`trim-cli` 不预置账号、密码或 session；首次连接仍需用户显式登录。包内只保留 fnOS/Linux 所需的两个架构文件，并由 `config/runtime-manifest.json` 固定 SHA-256。

## 上游、许可证与发布边界

仓库当前的首次安装基线为 Hermes Studio `v0.7.16`。在线下载的官方 Runtime archive 固定 SHA-256 `457d5745c58d6c5991b729c403bc890d564c48de62703a435a376a1e13f9a797`，安装前校验大小、摘要、布局和健康状态；之后可由 Manager 更新到更高版本。

Hermes Studio `v0.7.16` 推荐的 Hermes Agent 为 `0.20.6`，源码 ref 为 `v2026.8.27`，固定 commit 为 `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`。首次安装严格使用该基线；用户主动执行 `hermes update` 后，当前版本可以高于 Studio 推荐版本。

HStudio 适配层采用 [MIT License](LICENSE)。Hermes Studio Runtime 使用 BSL-1.1：附加授权仅允许非商业用途，商业使用需要 EKKOLearnAI 的单独许可，并将在 2029-05-10 转为 Apache-2.0。`trim-cli` 按 fnOS 官方公共工具处理并随 FPK 提供，仍不受适配层 MIT 许可证覆盖。完整边界见 [第三方声明](licenses/THIRD-PARTY-NOTICES.md)。

CI 构建不携带 Runtime 的在线 FPK，并按实际包含的 `trim-cli` 执行许可闸门。普通构建只上传短期 Actions Artifact；推送与 `manifest` 版本一致的 `v<version>` 标签时，独立发布任务会自动创建 GitHub Release，并附加 `fnos-HStudio-v<version>.fpk` 与 SHA-256 文件。

详细设计、迁移、构建和上游约束位于 [`docs/`](docs/)。
