# Architecture

- System Runtime: 仅强制依赖 fnOS `nodejs_v24`（Studio/Coding Agents）。Hermes 使用上游 Runtime 配套的 Python；已有 fnOS Python 可被检测和使用，但不再要求安装。FPK 不内置或修改系统运行时。
- Hermes Agent: first install, activation, and updates are delegated to Hermes Studio's Runtime manager. Manager reads `$HOME/hermes-home/desktop-runtime/active-version.json`, verifies the selected Runtime with its bundled Python, and never lets a legacy `$HOME/hermes-agent` installation override the managed Runtime.
- Studio installation: only `$HOME/.npm-global`; official `hermes-web-ui@latest`, shared with Coding Agent npm CLIs. Mirrors transport the exact official npm version, not a separate release channel.
- Bundled fnOS public tool: `.agents/skills/trim-cli` is the repository source; the FPK contains only its Linux x86_64/ARM64 binaries plus Skill documentation.
- Skill discovery: install/upgrade fills `$HERMES_HOME/skills`, `$HOME/.agents/skills` (Codex/Pi), and `$HOME/.claude/skills` only when missing; existing user copies are preserved.
- Hermes injection source: before Studio starts, HStudio atomically merges the selected Runtime's `dist/skills` with `trim-cli`; the exclusive `HERMES_WEB_UI_SKILLS_DIR` override therefore never hides upstream bundled Skills and also feeds named profiles.
- trim-cli Runtime: the matching architecture is atomically refreshed at `$HOME/tools/bin/trim-cli`; `$TRIM_CLI_CONFIG_DIR` is private persistent data and no credentials are preconfigured.
- Manager: Node stdlib backend on `manager.sock`, static fnOS iframe frontend at `/app/HStudio/manager`.
- No local Runtime selection: no current/previous pointers or archive fallback. Old directories remain untouched but are never selected. Hermes detection reads only the upstream active record and reports a broken selection without substituting an inactive version.
- Update lifecycle: Manager 仅在官方 npm 提供严格更高版本时更新；先把精确版本安装到隔离前缀并校验 package、CLI 与 server 布局，再停止 Studio、原子切换 `.npm-global`、健康重启。每个发布阶段写入带校验和的 durable journal；硬退出后自动提交或回滚，journal 损坏时 fail-closed。package、bin 与恢复元数据完成 fsync 后才移除 journal，大目录垃圾延迟清理。拒绝同版与降级；FPK 更新检查与 Studio 更新相互独立。
- FPK lifecycle: trim-cli installs locally before any Runtime bootstrap; Manager installs the official npm package later and upgrade callbacks preserve user data without network activity. fnOS stop/upgrade first writes a persistent stopping marker and terminates the owned bootstrap process, preventing a just-completed download from racing the shutdown and restarting Studio.
