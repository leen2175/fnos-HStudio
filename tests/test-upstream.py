#!/usr/bin/env python3
"""Small compatibility gate against the checked-out read-only upstream snapshot."""
import json, os, pathlib
root = pathlib.Path(__file__).resolve().parents[1]
up = pathlib.Path(os.environ.get(
    "HERMES_STUDIO_UPSTREAM",
    root.parent / "hermes-studio-upstream-authoritative",
)).resolve()
pkg = up / "package.json"
manifest = json.loads((root / "config/runtime-manifest.json").read_text(encoding="utf-8"))
version_env = root / "config/bootstrap/hermes-studio-version.env"
version_line = next(
    (line for line in version_env.read_text(encoding="utf-8").splitlines()
     if line.startswith("HERMES_STUDIO_VERSION=")),
    "",
)
pinned_version = version_line.partition("=")[2].strip()
if not pkg.is_file():
    raise SystemExit("upstream snapshot missing: " + str(pkg))
upstream = json.loads(pkg.read_text(encoding="utf-8"))
if pinned_version != manifest["studio"]["version"]:
    raise SystemExit("bootstrap version does not match runtime manifest")
if manifest["studio"]["version"] != upstream.get("version"):
    raise SystemExit("runtime manifest version does not match upstream package")
if not manifest["studio"]["upstreamCommit"]:
    raise SystemExit("upstream full commit is required")
if upstream.get("license") != manifest["studio"]["license"]:
    raise SystemExit("license drift: review runtime manifest")
print("PASS upstream", upstream["version"], manifest["studio"]["upstreamCommit"])
