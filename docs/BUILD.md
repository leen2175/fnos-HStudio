# Build

`manifest` 中的 `version` 是唯一 FPK 版本源。构建器不改写源码清单；若显式传入 `--version`，它必须与根清单完全一致。

```bash
python3 scripts/build-thin-fpk.py --variant lite --output-dir artifacts
python3 scripts/build-thin-fpk.py \
  --variant offline \
  --runtime-archive artifacts/hermes-studio-runtime-0.7.16-linux-x64.tar.gz \
  --output-dir artifacts
```

Lite 不需要本地 Runtime archive。Offline 必须使用 `config/runtime-manifest.json` 锁定的官方 archive；缺失，或文件名、字节数、SHA-256、package version、单根目录布局、锁定 tag/commit、Release metadata、LICENSE 任一不匹配时，构建立即失败且不生成占位包。构建器只验证锁定发布的完整性，因此历史版本仍可重建；是否出现更新的上游版本由定时 `upstream-watch` 工作流独立检查。

两个变体都包含相同的 fnOS 适配层、Manager、许可证文件、Hermes Studio release 固定的 Hermes Agent 元数据和带 SHA-256 的 Python requirements，以及 fnOS 官方公共工具 `trim-cli` 的最小 Linux payload。该 payload 仅包含 Linux x86_64/ARM64 CLI、wrapper 和 Skill；Node.js、Python、Hermes Agent 源码与 wheels 不进入 FPK，真机分别使用依赖应用 `nodejs_v24` 和 `python312`。这里的 Offline 指 Studio Runtime 可离线恢复；Hermes Agent 首次安装仍需联网下载固定源码和依赖。

输出为：

```text
artifacts/fnos-HStudio-lite-v<version>.fpk
artifacts/fnos-HStudio-offline-v<version>.fpk
```

每个 FPK 都生成 `.sha256`。构建器会复验外层 fnOS 文件、`manifest`/`app.tgz` MD5、脚本执行位、内层 payload、许可证和 Offline Runtime 原始字节，并只保留最近三个 FPK 版本号。外层 FPK 与内层 `app.tgz` 都固定归档顺序、时间戳、属主和文件模式；在相同源码、输入及固定 Python/zlib 工具链下可复现相同 SHA-256。

公开 Release 仍受许可闸门约束。Lite 只由其实际携带的 `trim-cli` 许可状态控制；Offline 同时要求 `trim-cli` 与 Hermes Studio Runtime 均为 `redistribution-approved`。当前 CI 可以上传 Lite 检查产物；除纯文档变更外，仍会构建但不会上传许可待确认的 Offline FPK。工作流保持只读，不创建公共 GitHub Release。
