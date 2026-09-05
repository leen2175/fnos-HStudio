# HStudio for fnOS

Hermes Studio 的轻量 fnOS 适配器，提供 Manager 管理页面，不修改上游源码。

- 支持 x86_64，仅强制依赖 fnOS `nodejs_v24`；Hermes Runtime 自带 Python。
- 桌面入口为 **HStudio**，Studio 默认端口为 **8648**。
- 仅提供在线安装包，不内置 Studio、Hermes Runtime、Node.js 或 Python。

## 安装与使用

1. 在 fnOS 应用中心手动安装 FPK。
2. 从桌面打开 **HStudio**，等待 Manager 在线安装 Hermes Studio。
3. 点击“打开 Hermes Studio”，在 Studio 版本管理中安装并启用 Hermes Runtime。

Manager 包含三个页面：

- **总览**：查看版本和运行状态，启动、停止、重启或更新 Studio。
- **Agents**：管理 Claude、Codex、Pi、Grok；顶部“刷新”检查安装状态及可用更新。Hermes Runtime 统一在 Studio 中管理。
- **设置**：选择 npm／Python 镜像、主题及自动打开 Studio，检查 FPK 更新。更换镜像后请重启 Studio。

管理操作需要 fnOS 管理员身份。内置 trim-cli 工具，不预置登录凭据。

## 更新与数据

- **Studio**：从官方 npm 查询最新版本，通过所选镜像下载；不提供本地版本切换。
- **Hermes Runtime**：由上游 Studio 下载、校验、启用和更新。
- **FPK**：Manager 仅检查发布信息，升级需在 fnOS 应用中心手动安装。私有仓库可能无法匿名检查更新。

用户数据保存在 `TRIM_PKGHOME/data`，升级保留配置及已有安装。迁移旧版本前建议备份，详见[迁移说明](docs/MIGRATION.md)。

## 构建

```bash
python3 scripts/build-thin-fpk.py --output-dir artifacts
```

版本号以 [manifest](manifest) 为准。输出 `artifacts/fnos-HStudio-v<version>.fpk` 和 SHA-256 校验文件，默认保留最近三个版本。

GitHub Actions 自动构建；推送与 manifest 一致的版本标签时创建 Release。

## 文档与许可

- [架构](docs/ARCHITECTURE.md) · [构建](docs/BUILD.md) · [上游约束](docs/UPSTREAM.md)
- HStudio 适配层采用 [MIT](LICENSE)；Studio 和 trim-cli 适用各自许可，见[第三方声明](licenses/THIRD-PARTY-NOTICES.md)。
