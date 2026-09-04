# Third-party notices

This file records third-party components bundled by HStudio. The HStudio adapter is licensed separately under the repository's MIT License; that license does not replace the terms below.

## Hermes Studio Runtime

- Project: https://github.com/EKKOLearnAI/hermes-studio
- Pinned version: `0.7.16`
- Pinned commit: `292a675d6cc82b50baae51d1268980186a985929`
- License: Business Source License 1.1 (`BSL-1.1`)
- License text: `Hermes-Studio-LICENSE.txt`
- Additional Use Grant: non-commercial use, including personal use, education, and research
- Commercial use: requires a separate license from EKKOLearnAI
- Change Date: 2029-05-10
- Change License: Apache License 2.0

The exact upstream license text and its SHA-256 are pinned in `config/runtime-manifest.json` and packaged for the online Runtime bootstrap.

## trim-cli

- Distribution: fnOS official public tool
- Included version: `0.1.0`
- Included platforms: Linux x86_64 and Linux ARM64
- License identifier: `LicenseRef-fnOS-Public-Tool`
- Redistribution status: `redistribution-approved`

HStudio includes the fnOS/Linux tool and its Skill as a public fnOS utility. Exact SHA-256 values are pinned in `config/runtime-manifest.json`; macOS and Windows binaries are not included.

## HStudio adapter

- Copyright: 2026 leen2175
- License: MIT License
- License text: repository root `LICENSE` and packaged `HStudio-LICENSE.txt`

The MIT License applies only to the HStudio adapter and does not relicense Hermes Studio Runtime or trim-cli.
