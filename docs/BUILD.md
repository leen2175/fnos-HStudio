# Build

`manifest` 中的 `version` 是唯一 FPK 版本源。构建器不改写源码清单；若显式传入 `--version`，它必须与根清单完全一致。

```bash
python3 scripts/build-thin-fpk.py --output-dir artifacts
```

项目只发布不携带 Hermes Studio Runtime 的在线 FPK。Node.js、Python、Hermes Studio Runtime、Hermes Agent 源码与 wheels 均不进入 FPK；Studio 首次安装和更新只使用官方 npm 包，镜像用于精确版本下载；Hermes Runtime 完全由上游 Studio 管理。

产物为：

```text
artifacts/fnos-HStudio-v<version>.fpk
```

构建器会生成 `.sha256`，复验外层 fnOS 文件、`manifest`/`app.tgz` MD5、脚本执行位、内层 payload、许可证和 trim-cli 二进制摘要，并只保留最近三个 FPK 版本号。外层 FPK 与内层 `app.tgz` 都固定归档顺序、时间戳、属主和文件模式；在相同源码及固定 Python/zlib 工具链下可复现相同 SHA-256。

公开产物只按实际携带的 `trim-cli` 许可状态执行闸门。CI 会在 `main`、Pull Request、版本标签和手动触发时生成 Actions Artifact；推送与 `manifest` 完全一致的 `v<version>` 标签时，另由最小 `contents: write` 权限任务创建 GitHub Release 并附加 FPK 与 SHA-256 文件。
