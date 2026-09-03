#!/usr/bin/env python3
"""Verify the app payload contains only the supported Linux trim-cli files."""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_thin_fpk", ROOT / "scripts" / "build-thin-fpk.py")
assert SPEC and SPEC.loader
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)

manifest = json.loads((ROOT / "config" / "runtime-manifest.json").read_text(encoding="utf-8"))
with tempfile.TemporaryDirectory() as temp_dir:
    runtime = pathlib.Path(temp_dir) / manifest["studio"]["archive"]
    runtime.write_bytes(b"offline-runtime-placeholder")
    for variant in ("lite", "offline"):
        payload = BUILDER.create_app_payload(variant, runtime, manifest)
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
            members = {member.name: member for member in archive.getmembers()}
            expected_bins = {
                "linux-arm64": "skills/trim-cli/bin/trim-cli-linux-arm64",
                "linux-x64": "skills/trim-cli/bin/trim-cli-linux-x64",
            }
            for platform, name in expected_bins.items():
                member = members[name]
                assert member.mode & 0o111, f"{variant}: {name} is not executable"
                data = archive.extractfile(member).read()
                expected_hash = manifest["trimCli"]["binaries"][platform]["sha256"]
                assert hashlib.sha256(data).hexdigest() == expected_hash

            wrapper = members["skills/trim-cli/scripts/trim-cli"]
            assert wrapper.mode & 0o111, f"{variant}: trim-cli wrapper is not executable"
            wrapper_data = archive.extractfile(wrapper).read()
            assert wrapper_data.startswith(b"#!/bin/sh\n") and b"\r" not in wrapper_data
            bundled_manifest = json.loads(
                archive.extractfile(members["skills/trim-cli/manifest.json"]).read().decode("utf-8")
            )
            assert bundled_manifest["bin"] == {
                "linux-arm64": "bin/trim-cli-linux-arm64",
                "linux-x64": "bin/trim-cli-linux-x64",
            }

            forbidden = ("darwin", "windows", ".exe", ".cmd", ".ps1")
            assert not [name for name in members if any(token in name.lower() for token in forbidden)]
            assert "skills/trim-cli/SKILL.md" in members
            assert any(name.startswith("skills/trim-cli/entries/") for name in members)
            assert any(name.startswith("skills/trim-cli/reference/") for name in members)
            assert (f"runtime/{runtime.name}" in members) == (variant == "offline")

resource = json.loads((ROOT / "config" / "resource").read_text(encoding="utf-8"))
assert resource["usr-local-linker"]["bin"] == ["skills/trim-cli/scripts/trim-cli"]
print("PASS trim-cli Lite/Offline payloads: Linux x64 + ARM64 only")
