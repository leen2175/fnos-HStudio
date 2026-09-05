# Migration

历史 `$HOME/node`、`$HOME/runtime/studio`、`$HOME/hermes-agent` 均原位保留，但不再参与 Studio 启动或 Hermes 状态判断；不复制、不自动删除。旧 `manager/state.json` 的 `preferredRuntime` 不再生效。

已有健康的 `.npm-global` Studio 安装继续使用；只有旧 archive 安装的设备，由 Manager 联网安装官方 npm latest 到唯一的 `.npm-global` 路径。断网时明确显示未就绪并允许重试，不切回旧 archive。

`.npm-global` 中其他 Coding Agents、缓存、配置、凭据、会话与工作区保持不变。Hermes Runtime 安装、激活、更新和删除一律在 Hermes Studio 版本管理中操作。Manager 不迁移、不激活、不降级 Hermes Runtime。

Studio 更新仍保留事务性临时备份和断电恢复 journal，用于失败恢复；它们不是可供选择的多版本库。新事务使用 schema 2，不读取、写入或回滚旧 `state.json`；schema 1 的旧 journal 继续恢复其历史配置快照。旧进程识别保留兼容，以便安全停止升级前的实例。
