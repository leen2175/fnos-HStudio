# Build

`manifest` 中的 `version` 是唯一 FPK 版本源。构建器不改写源码清单；若显式传入 `--version`，它必须与根清单完全一致。

```bash
python3 scripts/build-thin-fpk.py --output-dir artifacts
```

项目只发布不携带 Hermes Studio Runtime 的 Lite FPK。Node.js、Python、Hermes Studio Runtime、Hermes Agent 源码与 wheels 均不进入 FPK；首次安装和后续更新由 Manager 使用官方 Runtime archive、npm 镜像和 Python 镜像在线完成。

产物为：

```text
artifacts/fnos-HStudio-lite-v<version>.fpk
```

构建器会生成 `.sha256`，复验外层 fnOS 文件、`manifest`/`app.tgz` MD5、脚本执行位、内层 payload、许可证和依赖锁，并只保留最近三个 FPK 版本号。外层 FPK 与内层 `app.tgz` 都固定归档顺序、时间戳、属主和文件模式；在相同源码及固定 Python/zlib 工具链下可复现相同 SHA-256。

公开产物只按实际携带的 `trim-cli` 许可状态执行闸门。CI 可以上传 Lite 检查产物，工作流保持只读，不创建公共 GitHub Release。
