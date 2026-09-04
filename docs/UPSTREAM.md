# Upstream

- Repository: https://github.com/EKKOLearnAI/hermes-studio
- Bundled tag: `v0.7.16`
- Commit: `292a675d6cc82b50baae51d1268980186a985929`
- Source: npm package / prebuilt runtime (`nodejs_v24` host)
- Engine: Node `>=23.0.0`
- License: BSL-1.1; non-commercial Additional Use Grant, commercial use requires a separate EKKOLearnAI license, Change Date 2029-05-10 to Apache-2.0.
- Adapter patches: none; all fnOS behavior is implemented in this repository.
- Latest read-only sync checked: GitHub latest release `v0.7.16`, main commit `292a675d`; the release asset is 129,814,801 bytes with SHA-256 `457d5745c58d6c5991b729c403bc890d564c48de62703a435a376a1e13f9a797`.
- npm 的 `hermes-web-ui@latest` 在本次核对时仍为 `0.7.15`。Manager 必须先比较版本，禁止用 npm latest 把 `0.7.16` 降级；首次安装的 GitHub archive 以清单锁定的大小和摘要为准。
- Hermes Studio `v0.7.16` 的 `packages/desktop/build/runtime-release.json` 固定 Hermes Agent `0.20.6`、ref `v2026.8.27`、commit `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`。HStudio 只从该 Studio release 元数据更新首次安装基线，不独立跟踪 Hermes Agent 版本。
- Coding-agent package behavior follows upstream: Codex `@openai/codex`, Claude Code `@anthropic-ai/claude-code`, and Pi `@earendil-works/pi-coding-agent`; this adapter intentionally lets Pi and `pi-mcp-adapter` resolve npm latest versions.

## Repository source boundary

HStudio 的 fnOS 适配、生命周期、Manager 和构建系统均在本仓库独立实现。Hermes Studio 源码和 Runtime archive 都不进入 FPK。

`trim-cli` 按 fnOS 官方公共工具使用，`.agents/skills/trim-cli` 是本项目唯一打包源，只保留 Skill 文档、Linux wrapper、Linux x86_64 与 ARM64 CLI。两个二进制的 SHA-256 记录在 `config/runtime-manifest.json` 并在构建时校验。

定时 `upstream-watch` 负责报告首次安装基线落后；Manager 则按 npm 严格 SemVer 更新。CI 验证并上传不携带 Hermes Studio Runtime 的在线 FPK，版本标签构建通过后自动发布 GitHub Release。
