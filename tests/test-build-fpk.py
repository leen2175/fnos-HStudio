#!/usr/bin/env python3
"""Regression tests for fail-closed Lite/Offline FPK construction."""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("build_thin_fpk", ROOT / "scripts" / "build-thin-fpk.py")
assert SPEC and SPEC.loader
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


def make_runtime(
    path: pathlib.Path,
    version: str,
    valid_layout: bool = True,
    extra_root: bool = False,
    link_type: str | None = None,
    include_server: bool = True,
) -> dict:
    package = json.dumps({"name": "hermes-web-ui", "version": version}).encode("utf-8")
    with tarfile.open(path, "w:gz") as archive:
        if valid_layout:
            files = [
                ("webui/package.json", package, 0o644),
                ("webui/bin/hermes-web-ui.mjs", b"#!/usr/bin/env node\n", 0o755),
            ]
            if include_server:
                files.append(("webui/dist/server/index.js", b"// server entry\n", 0o644))
            for name, data, mode in files:
                member = tarfile.TarInfo(name)
                member.size = len(data)
                member.mode = mode
                archive.addfile(member, io.BytesIO(data))
        else:
            data = b"not a runtime"
            member = tarfile.TarInfo("runtime/README.txt")
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        if extra_root:
            data = b"unexpected"
            member = tarfile.TarInfo("other/file.txt")
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        if link_type:
            member = tarfile.TarInfo("webui/unsafe-link")
            if link_type == "hard":
                member.type = tarfile.LNKTYPE
                member.linkname = "webui/package.json"
            else:
                member.type = tarfile.SYMTYPE
                member.linkname = "../outside"
            archive.addfile(member)
    return {
        "version": version,
        "archive": path.name,
        "size": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def make_smoke_runtime(path: pathlib.Path, version: str) -> dict:
    package = json.dumps(
        {"name": "hermes-web-ui", "version": version, "type": "module"}
    ).encode("utf-8")
    cli = f"""#!/usr/bin/env node
import fs from 'node:fs';
import {{ spawn }} from 'node:child_process';
import {{ fileURLToPath }} from 'node:url';

const home = process.env.HERMES_WEB_UI_HOME;
const pidPath = `${{home}}/server.pid`;
if (process.argv.includes('--version')) {{
  console.log('hermes-web-ui v{version}');
}} else if (process.argv[2] === 'start') {{
  const port = process.argv[process.argv.indexOf('--port') + 1];
  fs.mkdirSync(home, {{ recursive: true }});
  const server = fileURLToPath(new URL('../dist/server/index.js', import.meta.url));
  const child = spawn(process.execPath, [server], {{
    detached: true,
    stdio: 'ignore',
    env: {{ ...process.env, HSTUDIO_SMOKE_PORT: port }},
  }});
  fs.writeFileSync(pidPath, String(child.pid));
  child.unref();
}} else if (process.argv[2] === 'stop') {{
  try {{
    const pid = Number(fs.readFileSync(pidPath, 'utf8'));
    process.kill(pid, 'SIGTERM');
    fs.rmSync(pidPath, {{ force: true }});
  }} catch (error) {{
    if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
  }}
}} else {{
  process.exitCode = 2;
}}
""".encode("utf-8")
    server = b"""import http from 'node:http';
const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  } else {
    response.writeHead(404);
    response.end('not found');
  }
});
server.listen(Number(process.env.HSTUDIO_SMOKE_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
"""
    with tarfile.open(path, "w:gz") as archive:
        for name, data, mode in (
            ("webui/package.json", package, 0o644),
            ("webui/bin/hermes-web-ui.mjs", cli, 0o755),
            ("webui/dist/server/index.js", server, 0o644),
        ):
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = mode
            archive.addfile(member, io.BytesIO(data))
    return {
        "version": version,
        "archive": path.name,
        "size": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "nodeMajor": 24,
        "platform": "linux-x64",
    }


def github_file(content: bytes) -> dict:
    blob = hashlib.sha1(f"blob {len(content)}\0".encode("ascii") + content).hexdigest()
    return {
        "type": "file",
        "encoding": "base64",
        "content": base64.b64encode(content).decode("ascii"),
        "size": len(content),
        "sha": blob,
    }


class BuildFpkTests(unittest.TestCase):
    def test_github_json_fetch_retries_transient_transport_errors(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok": true}'
        failures = [BUILDER.urllib.error.URLError("temporary"), TimeoutError("slow")]
        with (
            mock.patch.object(BUILDER.urllib.request, "urlopen", side_effect=[*failures, response]) as urlopen,
            mock.patch.object(BUILDER.time, "sleep") as sleep,
        ):
            self.assertEqual(BUILDER._fetch_json("https://api.github.com/example"), {"ok": True})
        self.assertEqual(urlopen.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])

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

    def test_lite_build_needs_no_runtime_and_has_valid_double_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            BUILDER.OUT = pathlib.Path(temporary)
            result = BUILDER.build(
                "lite",
                BUILDER.package_version(),
                runtime_path=pathlib.Path(temporary) / "definitely-missing.tar.gz",
            )
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
            repeated = BUILDER.build(
                "lite",
                BUILDER.package_version(),
                runtime_path=pathlib.Path(temporary) / "still-missing.tar.gz",
            )
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
                    "lite",
                    BUILDER.package_version(),
                    None,
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

    def test_public_cli_cannot_enable_test_skip(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            argv = [
                "build-thin-fpk.py",
                "--variant",
                "lite",
                "--output-dir",
                temporary,
                "--test-skip-upstream-verification",
            ]
            with mock.patch.object(sys, "argv", argv), mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("HSTUDIO_TESTING", None)
                with self.assertRaises(SystemExit) as raised:
                    BUILDER.main()
                self.assertEqual(raised.exception.code, 2)
            with mock.patch.object(sys, "argv", argv), mock.patch.dict(
                os.environ, {"HSTUDIO_TESTING": "1"}, clear=False
            ):
                BUILDER.main()
            self.assertTrue(any(pathlib.Path(temporary).glob("fnos-HStudio-lite-*.fpk")))

    def test_library_cannot_skip_offline_check_outside_tests(self) -> None:
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HSTUDIO_TESTING", None)
            BUILDER.OUT = pathlib.Path(temporary)
            with self.assertRaisesRegex(ValueError, "requires HSTUDIO_TESTING=1"):
                BUILDER.build(
                    "offline",
                    BUILDER.package_version(),
                    runtime_path=pathlib.Path(temporary) / "missing.tar.gz",
                    verify_upstream_online=False,
                )

    def test_offline_missing_archive_fails_without_placeholder(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            BUILDER.OUT = pathlib.Path(temporary)
            missing = pathlib.Path(temporary) / self.package_manifest["studio"]["archive"]
            with mock.patch.dict(os.environ, {"HSTUDIO_TESTING": "1"}, clear=False):
                with self.assertRaisesRegex(FileNotFoundError, "not found"):
                    BUILDER.build(
                        "offline",
                        BUILDER.package_version(),
                        runtime_path=missing,
                        verify_upstream_online=False,
                    )
            self.assertEqual(list(pathlib.Path(temporary).glob("*.fpk*")), [])

    def test_runtime_size_sha_and_layout_are_all_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            runtime = directory / "hermes-studio-runtime-9.9.9-linux-x64.tar.gz"
            studio = make_runtime(runtime, "9.9.9")
            self.assertEqual(BUILDER.validate_runtime_archive(runtime, studio), runtime.resolve())

            wrong_size = dict(studio, size=studio["size"] + 1)
            with self.assertRaisesRegex(ValueError, "size mismatch"):
                BUILDER.validate_runtime_archive(runtime, wrong_size)
            wrong_sha = dict(studio, sha256="0" * 64)
            with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
                BUILDER.validate_runtime_archive(runtime, wrong_sha)

            invalid = directory / "hermes-studio-runtime-invalid-linux-x64.tar.gz"
            invalid_studio = make_runtime(invalid, "9.9.9", valid_layout=False)
            with self.assertRaisesRegex(ValueError, "package.json"):
                BUILDER.validate_runtime_archive(invalid, invalid_studio)

            no_server = directory / "hermes-studio-runtime-no-server-linux-x64.tar.gz"
            no_server_studio = make_runtime(no_server, "9.9.9", include_server=False)
            with self.assertRaisesRegex(ValueError, "dist/server/index.js"):
                BUILDER.validate_runtime_archive(no_server, no_server_studio)

            multi_root = directory / "hermes-studio-runtime-multi-linux-x64.tar.gz"
            multi_root_studio = make_runtime(multi_root, "9.9.9", extra_root=True)
            with self.assertRaisesRegex(ValueError, "one top-level directory"):
                BUILDER.validate_runtime_archive(multi_root, multi_root_studio)

            hardlink = directory / "hermes-studio-runtime-hardlink-linux-x64.tar.gz"
            hardlink_studio = make_runtime(hardlink, "9.9.9", link_type="hard")
            with self.assertRaisesRegex(ValueError, "hard links are not allowed"):
                BUILDER.validate_runtime_archive(hardlink, hardlink_studio)

            symlink = directory / "hermes-studio-runtime-symlink-linux-x64.tar.gz"
            symlink_studio = make_runtime(symlink, "9.9.9", link_type="symbolic")
            with self.assertRaisesRegex(ValueError, "escapes top-level directory"):
                BUILDER.validate_runtime_archive(symlink, symlink_studio)

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

    def test_runtime_smoke_uses_node_24_and_releases_random_port(self) -> None:
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node.js is unavailable; CI installs Node.js 24")
        try:
            BUILDER._node_24(node)
        except RuntimeError as error:
            self.skipTest(f"{error}; CI installs Node.js 24")
        with tempfile.TemporaryDirectory() as temporary:
            runtime = pathlib.Path(temporary) / "hermes-studio-runtime-9.9.9-linux-x64.tar.gz"
            studio = make_smoke_runtime(runtime, "9.9.9")
            BUILDER.smoke_runtime_archive(runtime, studio, node_binary=node)

    def test_offline_double_archive_contains_exact_verified_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            runtime = directory / "hermes-studio-runtime-9.9.9-linux-x64.tar.gz"
            package_manifest = json.loads(self.runtime_manifest_bytes)
            package_manifest["studio"].update(make_runtime(runtime, "9.9.9"))
            output = directory / "offline.fpk"
            BUILDER._write_fpk(
                output,
                "offline",
                BUILDER.package_version(),
                runtime,
                package_manifest,
            )
            BUILDER.validate_built_fpk(
                output,
                "offline",
                BUILDER.package_version(),
                package_manifest,
            )
            second = directory / "offline-repeat.fpk"
            BUILDER._write_fpk(
                second,
                "offline",
                BUILDER.package_version(),
                runtime,
                package_manifest,
            )
            self.assertEqual(second.read_bytes(), output.read_bytes())
            with tarfile.open(output, "r:gz") as first_outer, tarfile.open(second, "r:gz") as second_outer:
                self.assertEqual(
                    first_outer.extractfile("app.tgz").read(),
                    second_outer.extractfile("app.tgz").read(),
                )

    def test_online_check_verifies_pinned_release_commit_metadata_and_license_hash(self) -> None:
        commit = "a" * 40
        tag = "v9.9.9"
        runtime_name = "hermes-web-ui-9.9.9.tar.gz"
        source_url = f"https://github.com/example/project/releases/download/{tag}/{runtime_name}"
        metadata_url = f"https://github.com/example/project/releases/download/{tag}/hermes-web-ui-9.9.9.json"
        package = json.dumps(
            {"name": "hermes-web-ui", "version": "9.9.9", "license": "BSL-1.1"}
        ).encode("utf-8")
        license_text = b"test license\n"
        studio = {
            "version": "9.9.9",
            "upstreamRepository": "https://github.com/example/project",
            "upstreamTag": tag,
            "upstreamCommit": commit,
            "sourceType": "official-release",
            "sourceUrl": source_url,
            "releaseMetadataUrl": metadata_url,
            "size": 1234,
            "sha256": "b" * 64,
            "license": "BSL-1.1",
            "licenseSha256": hashlib.sha256(license_text).hexdigest(),
        }
        api = "https://api.github.com/repos/example/project"
        fixtures = {
            f"{api}/releases/tags/v9.9.9": {
                "tag_name": tag,
                "draft": False,
                "prerelease": False,
                "assets": [
                    {"name": runtime_name, "browser_download_url": source_url, "size": 1234},
                    {
                        "name": "hermes-web-ui-9.9.9.json",
                        "browser_download_url": metadata_url,
                    },
                ],
            },
            metadata_url: {
                "webUiVersion": "9.9.9",
                "asset": {"name": runtime_name, "size": 1234, "sha256": "b" * 64},
            },
            f"{api}/git/ref/tags/v9.9.9": {"object": {"type": "commit", "sha": commit}},
            f"{api}/contents/package.json?ref={commit}": github_file(package),
            f"{api}/contents/LICENSE?ref={commit}": github_file(license_text),
        }

        fetched = []

        def fetch(url: str) -> dict:
            fetched.append(url)
            return fixtures[url]

        report = BUILDER.verify_upstream_metadata(studio, fetch_json=fetch)
        self.assertEqual(report["tag"], tag)
        self.assertEqual(report["commit"], commit)
        self.assertEqual(report["licenseSha256"], hashlib.sha256(license_text).hexdigest())
        self.assertNotIn(f"{api}/releases/latest", fetched)

        prerelease = dict(fixtures)
        prerelease[f"{api}/releases/tags/v9.9.9"] = {
            **fixtures[f"{api}/releases/tags/v9.9.9"],
            "prerelease": True,
        }
        with self.assertRaisesRegex(ValueError, "published stable tag"):
            BUILDER.verify_upstream_metadata(studio, fetch_json=lambda url: prerelease[url])

        mismatched = dict(fixtures)
        mismatched[f"{api}/git/ref/tags/v9.9.9"] = {
            "object": {"type": "commit", "sha": "c" * 40}
        }
        with self.assertRaisesRegex(ValueError, "does not match GitHub tag"):
            BUILDER.verify_upstream_metadata(studio, fetch_json=lambda url: mismatched[url])

        changed_license = dict(studio, licenseSha256="0" * 64)
        with self.assertRaisesRegex(ValueError, "LICENSE changed"):
            BUILDER.verify_upstream_metadata(changed_license, fetch_json=fetch)


if __name__ == "__main__":
    unittest.main(verbosity=2)
