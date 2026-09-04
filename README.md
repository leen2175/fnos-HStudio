# fnos-HStudio

`fnos-HStudio` 是 `EKKOLearnAI/hermes-studio` 的独立 fnOS 薄适配仓库。FPK 不携带 Node.js、Python、Hermes Agent 源码或编译工具；运行时依赖 fnOS `nodejs_v24` 与 `python312`，并可在数据目录缓存官方预构建 Hermes Studio Runtime。FPK 携带由 Hermes Studio 固定版本导出的带哈希 Python 依赖清单，Manager 可将 Hermes Agent 安装到应用私有 Git 工作树和 Python venv，不修改系统 Python。

项目仓库：https://github.com/leen2175/fnos-HStudio

fnOS 应用身份固定为 `appname=HStudio`。当前 FPK 版本为 `0.0.53`，目标平台为 x86_64，服务端口为 8649。

## 项目结构

- `app/`、`cmd/`、`config/`、`wizard/`：FPK 内容与 fnOS 生命周期。
- `manager/`：轻量 Manager 后端与静态管理页。
- `scripts/`、`tests/`：构建与回归检查。
- `docs/`：架构、迁移、构建与上游约束。
- `.agents/skills/trim-cli/`：fnOS 官方公共工具的 Skill 源，仅保留 FPK 使用的 Linux x86_64/ARM64 CLI 与配套文档。
- `artifacts/`：构建时生成的本地输出目录；只保留最近三个 FPK 版本。

## 运行模型

- `cmd/lib/environment.sh` 从 `TRIM_PKGHOME/data` 派生 `$HOME`、`$HERMES_WEB_UI_HOME` 和 `$HOME/.npm-global`，所有 Hermes CLI 与 Manager 共用同一 PATH。
- `cmd/lib/runtime.sh` 按 `auto → user-global → bundled` 选择健康 Runtime；bundled 内部再按 `current → previous → legacy` 回退。只有精确进程路径和 HTTP 健康检查都通过后才提升 previous，用户选择保存在 `data/manager/state.json`。
- `cmd/lib/process.sh` 只依据本应用 PID 文件停止进程，不扫描或杀死其他用户进程；服务端口按 `HERMES_PORT → TRIM_SERVICE_PORT → 8649` 解析，启动与健康检查始终使用同一端口。fnOS 的应用状态以 Manager 控制面为准，Studio 单独存活不会掩盖 Manager 退出。
- 用户数据位于 `TRIM_PKGHOME/data`。升级回调不会删除或覆盖 user-global Runtime、凭据、数据库和日志；Offline FPK 会在不联网的 package-only 流程中验证并刷新包内 bundled fallback，Lite 升级保持 no-op。
- Lite 与 Offline 均内置 fnOS 官方公共工具 `trim-cli` 的 Skill 和 Linux x86_64/ARM64 CLI。安装时默认部署到 Hermes、Codex/Pi、Claude Code 的发现目录；已有 Skill 保留不覆盖。HStudio 运行时使用的架构匹配副本位于 `data/tools/bin/trim-cli`；`usr-local-linker` 暴露的是包内 Skill wrapper，由它选择对应架构的 CLI。
- 启动 Studio 前会把当前 Runtime 的 `dist/skills` 与 `trim-cli` 原子合并为托管源，避免 `HERMES_WEB_UI_SKILLS_DIR` 的排他语义遮蔽上游内置 Skills。

Manager 通过 Unix socket 提供本地 API，并由 `app/ui/config` 注册只读桌面入口。界面只有“总览”“Agents”“设置”三个标签；总览同时展示 HStudio、Hermes Studio Runtime 状态及启动、停止、重启和更新操作。顶部的“打开 Hermes Studio”优先使用可选的 `HSTUDIO_PUBLIC_URL`；未配置时，域名入口沿用 fnOS 的 `hstudio.<主机>` 形式，IP/localhost 则使用同主机的实际服务端口。桌面图标仍指向 fnOS 注册的应用入口。管理员操作要求 fnOS 网关注入的 `X-Trim-Userid` 与 `X-Trim-Isadmin` 请求头；明确的 cross-site 请求会被拒绝，日志在完整输出边界统一脱敏 token、cookie、password 等敏感字段。

设置页的 FPK 更新功能当前只读取 `leen2175/fnos-HStudio` 的最新 GitHub Release，以结构化状态展示当前版本、最新版本、检查时间和发布页，与 Studio Runtime 更新相互独立；无 Release、检查失败与确有更新是不同状态。缓存命中时仍会按当前 FPK 重新比较版本，网络失败使用短期缓存避免反复请求。该功能尚不校验 Release 中是否存在兼容的 FPK，也不会下载或安装 FPK，因此不能更新 Manager 自身。完整 FPK 升级仍需通过 fnOS 应用中心手动安装，开发或重复测试也可使用 `appcenter-cli install-fpk`。

总览中的 Hermes Studio 状态卡片只在需要时显示安装、重试或确有新版本的更新；启动、停止、重启与更新都会按后台任务持续反馈结果。前端只轮询轻量操作状态，任务完成后才重新探测 Runtime 和 Agents。更新前比较严格 SemVer，禁止 npm latest 低于当前 Runtime 时降级。更新会先在隔离目录取得并校验精确版本，停止 Studio 后才原子切换；带校验和的阶段 journal 可在 Manager 被终止或断电后自动回滚，损坏 journal 则保留并 fail-closed。成功后重建 Skill 合并源，大目录旧包在正确性提交后延迟清理。

`Agents` 页分别管理 Hermes Agent 与 Coding Agents。Hermes Agent 首次安装或从旧 PyPI 环境迁移时，按 FPK 锁定 Studio release 的 Runtime 清单拉取固定 tag/commit，在隔离目录用带哈希依赖清单完成 editable 安装和验证；最终版本及 Git origin 全部通过后才提交新目录并尽力清理旧备份，失败时恢复旧安装。本地分支保持为 `main`，后续 Manager 更新直接执行官方 `hermes update`。Hermes Studio 启动时会把 Agent Bridge 固定到 HStudio 私有 venv，并使用 `TRIM_PKGVAR` 下的 Unix socket（缺失时回退到 `data/run`）。该流程复用 fnOS Python/Node.js，不执行远程安装脚本，也不覆盖 `$HERMES_HOME` 配置。Codex（`@openai/codex`）、Claude Code（`@anthropic-ai/claude-code`）和 Pi（`@earendil-works/pi-coding-agent` 最新版）统一写入应用用户的 `.npm-global`，Pi 同时安装 npm 最新版 `pi-mcp-adapter`。命令文件存在但版本探测失败时只显示“需修复”，不会误报可用；Agent 安装与 Studio 启动/重启相互排斥，停止操作始终保留。

Hermes Agent 的 Git 安装和更新要求 fnOS 环境能调用 `git`；Manager 会固定校验官方 HTTPS `origin`，不会对其他来源执行自更新。页面分别显示 FPK 验证的 Agent 基线、当前设备版本和浏览器组件；若 Studio Runtime 已独立更新到不同版本，会明确标记兼容性尚未由当前 FPK 验证。`hermes update` 自带的配置快照、迁移和依赖同步保持启用。

设置页提供受控的 npm 镜像切换和 FPK 更新检查，可选择官方 npm、淘宝镜像（npmmirror）或腾讯云镜像。选择会持久化到 `data/manager/npm-registry.json`，并同步写入应用 `.npmrc`；Runtime bootstrap 的 npm fallback、Studio 更新和 Coding Agents 安装会使用该镜像。Hermes Agent 的首次安装仍使用固定 GitHub Git 源与 Python 依赖，后续由 `hermes update` 管理。为避免任意地址注入，Manager 只接受这三个白名单选项。

## 构建

```bash
python3 scripts/build-thin-fpk.py --variant lite --output-dir artifacts
python3 scripts/build-thin-fpk.py \
  --variant offline \
  --runtime-archive artifacts/hermes-studio-runtime-0.7.16-linux-x64.tar.gz \
  --output-dir artifacts
```

Lite FPK 安装阶段只安装适配层并启动 Manager。首次 bootstrap 优先断点下载并校验官方 GitHub Runtime archive；GitHub 不可达时，可在隔离临时前缀从所选 npm 镜像取得固定版本，再经相同健康检查发布为 bundled Runtime，绝不写坏用户 `.npm-global`。Offline 构建不会自行下载 Runtime，必须提供与 `config/runtime-manifest.json` 完全匹配的 archive；构建器联网验证锁定的稳定 Release、tag、commit、asset、摘要及许可证，不要求它仍是 GitHub latest，因此历史版本可重复构建。是否存在更新版本由 `upstream-watch` 独立检查。Hermes Agent 源码和 Python wheels 仍需首次安装时联网获取，两个变体都使用同一份固定版本与依赖哈希。所有 FPK 输入使用显式白名单，未跟踪缓存或备份不会进入产物；构建器会在 `artifacts/ARTIFACTS.md` 生成当前产物及校验值。

`trim-cli` 不预置账号、密码或 session；首次连接仍需用户显式登录。包内只保留 fnOS/Linux 所需的两个架构文件，并由 `config/runtime-manifest.json` 固定 SHA-256。

## 上游、许可证与发布边界

仓库当前锁定上游 `v0.7.16`、完整提交 `292a675d6cc82b50baae51d1268980186a985929`。官方 Runtime archive 的 SHA-256 为 `457d5745c58d6c5991b729c403bc890d564c48de62703a435a376a1e13f9a797`。Offline 构建会联网复核这个锁定 Release 及其来源；归档缺失、尺寸、摘要、布局或锁定元数据不匹配时不会生成 FPK。

Hermes Studio `v0.7.16` 推荐的 Hermes Agent 为 `0.20.6`，源码 ref 为 `v2026.8.27`，固定 commit 为 `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`。首次安装严格使用该基线；用户主动执行 `hermes update` 后，当前版本可以高于 Studio 推荐版本。

HStudio 适配层采用 [MIT License](LICENSE)。Hermes Studio Runtime 使用 BSL-1.1：附加授权仅允许非商业用途，商业使用需要 EKKOLearnAI 的单独许可，并将在 2029-05-10 转为 Apache-2.0。`trim-cli` 按 fnOS 官方公共工具处理并随 FPK 提供，仍不受适配层 MIT 许可证覆盖。完整边界见 [第三方声明](licenses/THIRD-PARTY-NOTICES.md)。

CI 按产物实际内容分别执行许可闸门：Lite 只要求 `trim-cli` 为 `redistribution-approved`，Offline 还要求 Hermes Studio Runtime 获得同样状态。当前 Lite 可在 CI 验证后上传短期 artifact，Offline 仍会构建验证但不会上传；工作流保持只读权限，不能创建公共 Release。PR 与 `main`/`v*` 使用独立触发，纯 README/docs 变更会跳过上游 checkout、Runtime 下载和 Offline 构建。

详细设计、迁移、构建和上游约束位于 [`docs/`](docs/)。
