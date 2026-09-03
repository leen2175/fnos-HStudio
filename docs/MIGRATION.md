# Migration

旧版本的 `$HOME/node` 会原位保留并被识别为只读 legacy bundled fallback，不再复制到 `runtime/studio/legacy`，避免大目录占用翻倍或断电留下半份副本。`.npm-global`、`.npm-cache`、`.codex`、`.claude`、Pi/Hermes 配置、认证 token 和 workspace 永不删除或合并。Runtime 安装先 staging、健康检查后原子切换；失败时保留 current/previous 并继续使用旧版本。
