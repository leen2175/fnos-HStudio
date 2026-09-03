# Build

`manifest` 中的 `version` 是唯一 FPK 版本源。构建器不改写源码清单；若显式传入 `--version`，它必须与根清单完全一致。

```bash
python3 scripts/build-thin-fpk.py --variant lite --output-dir artifacts
python3 scripts/build-thin-fpk.py \
  --variant offline \
  --runtime-archive artifacts/hermes-studio-runtime-0.7.16-linux-x64.tar.gz \
  --output-dir artifacts
```

Lite 不需要本地 Runtime archive。Offline 必须使用 `config/runtime-manifest.json` 锁定的官方 archive；缺失，或文件名、字节数、SHA-256、package version、单根目录布局、上游 tag/commit、Release metadata、LICENSE 任一不匹配时，构建立即失败且不生成占位包。Offline 构建还会联网确认 GitHub `releases/latest` 仍等于锁定版本，因此每次打包都不会悄悄内置过时 Runtime。

两个变体都包含相同的 fnOS 适配层、Manager、许可证文件，以及 fnOS 官方公共工具 `trim-cli` 的最小 Linux payload。该 payload 仅包含 Linux x86_64/ARM64 CLI、wrapper 和 Skill；Node.js 与 Python 不进入任何 FPK，真机分别使用依赖应用 `nodejs_v24` 和 `python312`。

输出为：

```text
artifacts/fnos-HStudio-lite-v<version>.fpk
artifacts/fnos-HStudio-offline-v<version>.fpk
```

每个 FPK 都生成 `.sha256`。构建器会复验外层 fnOS 文件、`manifest`/`app.tgz` MD5、脚本执行位、内层 payload、许可证和 Offline Runtime 原始字节，并只保留最近三个 FPK 版本号。外层 FPK 与内层 `app.tgz` 都采用确定性 gzip，相同源码和输入可复现相同 SHA-256。

公开 Release 仍受许可闸门约束。`trim-cli` 已按 fnOS 官方公共工具标记为 `redistribution-approved`；Hermes Studio Runtime 仍为 `license-review-required`，因此 CI 只构建和验证，不上传 FPK artifact，也不创建公共 GitHub Release。
