# Upstream

- Repository: https://github.com/EKKOLearnAI/hermes-studio
- Studio installation/update: official npm `hermes-web-ui@latest`, with fnOS Node.js 24.
- Hermes Runtime: owned exclusively by Hermes Studio's version manager; no HStudio version pin, Git installer, pip lock or local fallback selection.
- Adapter patches to upstream: none.
- License: see the bundled license reference and third-party notices. The reference tag identifies the copied license, not an installation baseline.

Manager reads upstream's `hermes-home/desktop-runtime/active-version.json` and probes only that Runtime. Download, validation, activation and removal require the user's Studio admin session and are performed in Studio. An inactive installed version must not hide a failed active Runtime.

Agents use the top-level Refresh button for local detection and read-only update checks. Coding Agent versions (including Pi's MCP adapter) are queried in parallel from the selected npm registry. Results are cached in memory per registry; Refresh replaces them, while ordinary status reads recalculate availability against the current installation without querying npm. Failed checks are not treated as up-to-date. Update buttons install only the displayed, newer component versions; Hermes instead offers Manage Runtime and directs update checks to Studio's authenticated version manager.

Studio version availability is queried from the official npm registry. Downloads use the selected HTTPS npm mirror for that exact version. No GitHub archive channel, local version selector, or current/previous rotation is maintained. Update rollback remains a transient safety mechanism, not a version-management feature.

`trim-cli` remains the only bundled native tool; its Linux binaries are verified against `config/runtime-manifest.json`. Manager checks the official npm channel on demand; no separate scheduled version-check workflow is maintained.
