#!/usr/bin/env python3
"""Regression tests for the online-only FPK construction."""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_thin_fpk", ROOT / "scripts" / "build-thin-fpk.py")
assert SPEC and SPEC.loader
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class BuildFpkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime_manifest_path = ROOT / "config" / "runtime-manifest.json"
        self.runtime_manifest_bytes = self.runtime_manifest_path.read_bytes()
        self.package_manifest = json.loads(self.runtime_manifest_bytes)
        self.original_out = BUILDER.OUT

    def tearDown(self) -> None:
        BUILDER.OUT = self.original_out
        self.assertEqual(
            self.runtime_manifest_path.read_bytes(),
            self.runtime_manifest_bytes,
            "build modified the trusted runtime-manifest.json",
        )

    def test_online_build_has_valid_double_archive_without_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            BUILDER.OUT = pathlib.Path(temporary)
            result = BUILDER.build(BUILDER.package_version())
            self.assertTrue(result.is_file())
            first_fpk = result.read_bytes()
            with tarfile.open(result, "r:gz") as outer:
                for member in outer.getmembers():
                    if member.isfile() and member.name.startswith("cmd/"):
                        self.assertTrue(member.mode & 0o111, member.name)
                        self.assertNotIn(
                            b"\r\n",
                            outer.extractfile(member).read(),
                            f"{member.name} must use LF line endings",
                        )
                app_data = outer.extractfile("app.tgz").read()
            with tarfile.open(fileobj=io.BytesIO(app_data), mode="r:gz") as app:
                self.assertFalse(any(name.startswith("runtime/") for name in app.getnames()))
                self.assertIn("licenses", app.getnames())
                project_license = app.extractfile("licenses/HStudio-LICENSE.txt").read()
                self.assertIn(b"MIT License", project_license)
                self.assertIn(b"Copyright (c) 2026 leen2175", project_license)
                notice = app.extractfile("licenses/THIRD-PARTY-NOTICES.md").read()
                self.assertIn(b"trim-cli", notice)
                self.assertIn(b"official public tool", notice)
                requirements = app.extractfile("hermes-agent/requirements.txt").read()
                self.assertEqual(
                    hashlib.sha256(requirements).hexdigest(),
                    self.package_manifest["hermesAgent"]["requirements"]["sha256"],
                )
                license_name = self.package_manifest["studio"]["licenseFile"]
                license_bytes = app.extractfile(license_name).read()
                self.assertEqual(
                    hashlib.sha256(license_bytes).hexdigest(),
                    self.package_manifest["studio"]["licenseSha256"],
                )
                by_name = {member.name: member for member in app.getmembers()}
                for name in (
                    "bin/hermes-web-ui",
                    "skills/trim-cli/scripts/trim-cli",
                    "skills/trim-cli/bin/trim-cli-linux-x64",
                    "skills/trim-cli/bin/trim-cli-linux-arm64",
                ):
                    self.assertTrue(by_name[name].mode & 0o111, name)
                for name in ("bin/hermes-web-ui", "skills/trim-cli/scripts/trim-cli"):
                    self.assertNotIn(
                        b"\r\n",
                        app.extractfile(by_name[name]).read(),
                        f"{name} must use LF line endings",
                    )
            repeated = BUILDER.build(BUILDER.package_version())
            self.assertEqual(repeated.read_bytes(), first_fpk)
            with tarfile.open(repeated, "r:gz") as outer:
                self.assertEqual(outer.extractfile("app.tgz").read(), app_data)

    def test_payload_whitelist_ignores_untracked_files(self) -> None:
        garbage = {
            ROOT / "manager" / "frontend" / "untracked-build-garbage.log": "manager/frontend/untracked-build-garbage.log",
            ROOT / "app" / "ui" / "untracked-build-garbage.log": "ui/untracked-build-garbage.log",
            ROOT / ".agents" / "skills" / "trim-cli" / "reference" / "untracked-build-garbage.log": "skills/trim-cli/reference/untracked-build-garbage.log",
            ROOT / "cmd" / "untracked-build-garbage.log": "cmd/untracked-build-garbage.log",
        }
        for path in garbage:
            path.write_text("must not enter an FPK\n", encoding="utf-8")
        try:
            with tempfile.TemporaryDirectory() as temporary:
                output = pathlib.Path(temporary) / "lite.fpk"
                BUILDER._write_fpk(
                    output,
                    BUILDER.package_version(),
                    self.package_manifest,
                )
                with tarfile.open(output, "r:gz") as outer:
                    outer_names = set(outer.getnames())
                    app_data = outer.extractfile("app.tgz").read()
                with tarfile.open(fileobj=io.BytesIO(app_data), mode="r:gz") as app:
                    app_members = app.getmembers()
                    app_names = {member.name for member in app_members}
                    manager_files = {
                        member.name
                        for member in app_members
                        if member.isfile() and member.name.startswith("manager/")
                    }
                self.assertEqual(
                    manager_files,
                    {"manager/backend/server.mjs", "manager/frontend/index.html"},
                )
                self.assertNotIn(garbage[ROOT / "cmd" / "untracked-build-garbage.log"], outer_names)
                for path, archive_name in garbage.items():
                    if path.parent.name != "cmd":
                        self.assertNotIn(archive_name, app_names)
        finally:
            for path in garbage:
                path.unlink(missing_ok=True)

    def test_requested_version_must_equal_root_manifest(self) -> None:
        with self.assertRaisesRegex(ValueError, "does not match root manifest"):
            BUILDER.checked_package_version("999.999.999")

    def test_hermes_agent_pin_and_lock_are_fail_closed(self) -> None:
        self.assertEqual(
            BUILDER.validate_hermes_agent_release(self.package_manifest),
            ROOT / "app" / "hermes-agent" / "requirements.txt",
        )
        changed = json.loads(json.dumps(self.package_manifest))
        changed["hermesAgent"]["commit"] = "main"
        with self.assertRaisesRegex(ValueError, "full commit"):
            BUILDER.validate_hermes_agent_release(changed)
        changed = json.loads(json.dumps(self.package_manifest))
        changed["hermesAgent"]["requirements"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "checksum drift"):
            BUILDER.validate_hermes_agent_release(changed)

    def test_trim_cli_elf_architecture_is_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            binary = pathlib.Path(temporary) / "trim-cli-linux-arm64"
            header = bytearray(20)
            header[:6] = b"\x7fELF\x02\x01"
            header[18:20] = (183).to_bytes(2, "little")
            binary.write_bytes(header)
            BUILDER.validate_elf_architecture(binary, 183, "trim-cli linux-arm64")
            with self.assertRaisesRegex(ValueError, "architecture mismatch"):
                BUILDER.validate_elf_architecture(binary, 62, "trim-cli linux-x64")
            binary.write_bytes(b"not an ELF binary")
            with self.assertRaisesRegex(ValueError, "not a 64-bit ELF"):
                BUILDER.validate_elf_architecture(binary, 183, "trim-cli linux-arm64")

if __name__ == "__main__":
    unittest.main(verbosity=2)
