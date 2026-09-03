#!/usr/bin/env python3
"""Build and verify Lite/Offline fnOS FPKs without bundling Node.js."""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Callable


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts"
PROJECT_SLUG = "fnos-HStudio"
FPK_NAME = re.compile(r"(?:fnos-HStudio|HStudio)-(?:lite|offline)-v(.+)\.fpk$")
TRIM_CLI_SKILL = ROOT / ".agents" / "skills" / "trim-cli"
PROJECT_LICENSE = ROOT / "LICENSE"
THIRD_PARTY_NOTICE = ROOT / "licenses" / "THIRD-PARTY-NOTICES.md"
GITHUB_TIMEOUT_SECONDS = 30
GITHUB_REQUEST_ATTEMPTS = 3
RUNTIME_SMOKE_TIMEOUT_SECONDS = 60


@contextmanager
def deterministic_tar_gz(destination):
    """Create a gzip-compressed tar with stable headers on every build."""
    owns_file = isinstance(destination, (str, os.PathLike))
    raw = open(destination, "wb") if owns_file else destination
    try:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                yield archive
    finally:
        if owns_file:
            raw.close()


def normalize(member: tarfile.TarInfo) -> tarfile.TarInfo:
    member.uid = member.gid = 0
    member.uname = member.gname = "root"
    member.mtime = 0
    if member.isdir():
        member.mode = 0o755
    elif (
        member.mode & 0o111
        or member.name.endswith(".sh")
        or member.name.startswith("cmd/")
        or "/cmd/" in member.name
        or member.name.endswith("/hermes-web-ui")
        or member.name.endswith("/scripts/trim-cli")
        or member.name.endswith("/bin/trim-cli-linux-x64")
        or member.name.endswith("/bin/trim-cli-linux-arm64")
    ):
        member.mode = 0o755
    else:
        member.mode = 0o644
    return member


def add_tree(tar: tarfile.TarFile, base: Path, arcname: str, excludes=()) -> None:
    tar.add(base, arcname=arcname, recursive=False, filter=normalize)
    for path in sorted(base.rglob("*")):
        if any(excluded in path.parts for excluded in excludes):
            continue
        name = f"{arcname}/{path.relative_to(base).as_posix()}"
        tar.add(path, arcname=name, recursive=False, filter=normalize)


def put_bytes(tar: tarfile.TarFile, name: str, data: bytes, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    normalize(info)
    tar.addfile(info, io.BytesIO(data))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_elf_architecture(path: Path, expected_machine: int, label: str) -> None:
    """Reject missing, non-64-bit, or wrong-architecture Linux payload binaries."""
    header = path.read_bytes()[:20]
    if len(header) < 20 or header[:4] != b"\x7fELF" or header[4] != 2 or header[5] not in (1, 2):
        raise ValueError(f"{label} is not a 64-bit ELF binary")
    byteorder = "little" if header[5] == 1 else "big"
    actual_machine = int.from_bytes(header[18:20], byteorder)
    if actual_machine != expected_machine:
        raise ValueError(
            f"{label} ELF architecture mismatch: expected={expected_machine} actual={actual_machine}"
        )


def stream_sha256(stream) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
        size += len(chunk)
    return digest.hexdigest(), size


def package_version(manifest_path: Path | None = None) -> str:
    """Return the sole FPK version source: the root fnOS manifest."""
    path = manifest_path or ROOT / "manifest"
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"\s*version\s*=\s*\"?([^\"\s]+)\"?\s*", line)
        if match:
            return match.group(1)
    raise ValueError(f"version is missing from {path}")


def checked_package_version(requested: str | None) -> str:
    actual = package_version()
    if requested is not None and requested != actual:
        raise ValueError(
            f"--version {requested!r} does not match root manifest version {actual!r}; "
            "update manifest first or omit --version"
        )
    return actual


def add_trim_cli_payload(tar: tarfile.TarFile, package_manifest: dict) -> None:
    """Bundle the fnOS/Linux trim-cli public tool and its Skill."""
    source = TRIM_CLI_SKILL
    required = (
        source / "SKILL.md",
        source / "manifest.json",
        source / "scripts" / "trim-cli",
        source / "bin" / "trim-cli-linux-x64",
        source / "bin" / "trim-cli-linux-arm64",
        source / "entries",
        source / "reference",
    )
    missing = [str(path.relative_to(ROOT)) for path in required if not path.exists()]
    if missing:
        raise FileNotFoundError("missing trim-cli payload: " + ", ".join(missing))

    metadata = package_manifest.get("trimCli", {})
    binaries = metadata.get("binaries", {})
    for platform_name, filename, elf_machine in (
        ("linux-x64", "trim-cli-linux-x64", 62),
        ("linux-arm64", "trim-cli-linux-arm64", 183),
    ):
        binary = source / "bin" / filename
        validate_elf_architecture(binary, elf_machine, f"trim-cli {platform_name}")
        actual_sha256 = file_sha256(binary)
        expected_sha256 = str(binaries.get(platform_name, {}).get("sha256", "")).lower()
        if not expected_sha256 or actual_sha256 != expected_sha256:
            raise ValueError(
                f"trim-cli {platform_name} checksum drift: expected={expected_sha256 or '<missing>'} "
                f"actual={actual_sha256}"
            )
    skill_manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    if str(skill_manifest.get("version", "")) != str(metadata.get("version", "")):
        raise ValueError("trim-cli version does not match config/runtime-manifest.json")
    skill_manifest["bin"] = {
        "linux-arm64": "bin/trim-cli-linux-arm64",
        "linux-x64": "bin/trim-cli-linux-x64",
    }

    arcname = "skills/trim-cli"
    tar.add(source, arcname=arcname, recursive=False, filter=normalize)
    tar.add(source / "SKILL.md", arcname=f"{arcname}/SKILL.md", recursive=False, filter=normalize)
    put_bytes(
        tar,
        f"{arcname}/manifest.json",
        (json.dumps(skill_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
    )
    add_tree(tar, source / "entries", f"{arcname}/entries")
    add_tree(tar, source / "reference", f"{arcname}/reference")
    tar.add(source / "scripts", arcname=f"{arcname}/scripts", recursive=False, filter=normalize)
    tar.add(
        source / "scripts" / "trim-cli",
        arcname=f"{arcname}/scripts/trim-cli",
        recursive=False,
        filter=normalize,
    )
    tar.add(source / "bin", arcname=f"{arcname}/bin", recursive=False, filter=normalize)
    for filename in ("trim-cli-linux-arm64", "trim-cli-linux-x64"):
        tar.add(
            source / "bin" / filename,
            arcname=f"{arcname}/bin/{filename}",
            recursive=False,
            filter=normalize,
        )


def _safe_tar_member(member: tarfile.TarInfo) -> None:
    name = member.name
    parts = PurePosixPath(name).parts
    if not name or name.startswith(("/", "\\")) or "\\" in name or ".." in parts:
        raise ValueError(f"unsafe archive path: {name!r}")
    if member.ischr() or member.isblk() or member.isfifo():
        raise ValueError(f"unsupported special archive member: {name!r}")
    if member.islnk():
        raise ValueError(f"hard links are not allowed in archives: {name!r}")
    if member.issym():
        link = member.linkname
        if not link or link.startswith(("/", "\\")) or "\\" in link:
            raise ValueError(f"unsafe archive link: {name!r} -> {link!r}")
        joined = PurePosixPath(name).parent / PurePosixPath(link)
        depth = 0
        for part in joined.parts:
            if part in ("", "."):
                continue
            if part == "..":
                depth -= 1
            else:
                depth += 1
            if depth < 0:
                raise ValueError(f"archive link escapes payload: {name!r} -> {link!r}")


def validate_runtime_archive(path: Path, studio: dict) -> Path:
    """Validate the exact locked Runtime archive and its executable package layout."""
    path = path.resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Offline Runtime archive not found: {path}")
    expected_name = str(studio.get("archive", ""))
    if not expected_name or path.name != expected_name:
        raise ValueError(f"Runtime archive name mismatch: expected={expected_name!r} actual={path.name!r}")

    try:
        expected_size = int(studio["size"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("Runtime manifest size is missing or invalid") from error
    actual_size = path.stat().st_size
    if expected_size <= 0 or actual_size != expected_size:
        raise ValueError(f"Runtime archive size mismatch: expected={expected_size} actual={actual_size}")

    expected_sha256 = str(studio.get("sha256", "")).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("Runtime manifest sha256 is missing or invalid")
    actual_sha256 = file_sha256(path)
    if actual_sha256 != expected_sha256:
        raise ValueError(
            f"Runtime archive SHA256 mismatch: expected={expected_sha256} actual={actual_sha256}"
        )

    expected_version = str(studio.get("version", ""))
    try:
        with tarfile.open(path, "r:*") as archive:
            members = archive.getmembers()
            for member in members:
                _safe_tar_member(member)
            top_levels = {PurePosixPath(member.name).parts[0] for member in members}
            if len(top_levels) != 1:
                raise ValueError(
                    "Runtime archive must contain one top-level directory; "
                    f"found={sorted(top_levels)!r}"
                )
            top_level = next(iter(top_levels))
            for member in members:
                if not member.issym():
                    continue
                resolved = []
                for part in (PurePosixPath(member.name).parent / member.linkname).parts:
                    if part in ("", "."):
                        continue
                    if part == "..":
                        if not resolved:
                            raise ValueError(f"Runtime symlink escapes payload: {member.name!r}")
                        resolved.pop()
                    else:
                        resolved.append(part)
                if not resolved or resolved[0] != top_level:
                    raise ValueError(
                        f"Runtime symlink escapes top-level directory: "
                        f"{member.name!r} -> {member.linkname!r}"
                    )
            by_name = {member.name.rstrip("/"): member for member in members}
            roots = []
            for name, member in by_name.items():
                parts = PurePosixPath(name).parts
                if len(parts) != 2 or parts[1] != "package.json" or not member.isfile():
                    continue
                package_file = archive.extractfile(member)
                if package_file is None:
                    continue
                try:
                    package = json.loads(package_file.read().decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise ValueError(f"invalid Runtime package metadata: {name}") from error
                if package.get("name") == "hermes-web-ui":
                    if str(package.get("version", "")) != expected_version:
                        raise ValueError(
                            "Runtime package version mismatch: "
                            f"expected={expected_version!r} actual={package.get('version')!r}"
                        )
                    roots.append(parts[0])
            if not roots:
                raise ValueError("Runtime archive lacks <root>/package.json for hermes-web-ui")
            if not any(
                f"{root}/bin/hermes-web-ui" in by_name
                or f"{root}/bin/hermes-web-ui.mjs" in by_name
                for root in roots
            ):
                raise ValueError("Runtime archive lacks the hermes-web-ui executable entry")
            if not any(
                (member := by_name.get(f"{root}/dist/server/index.js")) is not None
                and member.isfile()
                for root in roots
            ):
                raise ValueError("Runtime archive lacks <root>/dist/server/index.js")
    except (tarfile.TarError, OSError) as error:
        raise ValueError(f"Runtime archive is unreadable: {path}") from error
    return path


def resolve_runtime_archive(studio: dict, requested_path: Path | None = None) -> Path:
    expected_name = str(studio.get("archive", ""))
    if requested_path is not None:
        return validate_runtime_archive(Path(requested_path), studio)
    candidates = [OUT / expected_name]
    fallback = ROOT / "artifacts" / expected_name
    if fallback not in candidates:
        candidates.append(fallback)
    for candidate in candidates:
        if candidate.is_file():
            return validate_runtime_archive(candidate, studio)
    searched = ", ".join(str(candidate) for candidate in candidates)
    raise FileNotFoundError(
        f"Offline Runtime archive is required and no placeholder will be generated; searched: {searched}"
    )


def _node_24(node_binary: str | Path | None = None) -> str:
    candidate = str(node_binary or os.getenv("NODE_BIN") or shutil.which("node") or "")
    if not candidate:
        raise RuntimeError("Node.js 24 is required for the Runtime smoke test")
    try:
        result = subprocess.run(
            [candidate, "--version"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(f"Node.js 24 could not be executed: {candidate}") from error
    version = (result.stdout or result.stderr).strip()
    if result.returncode != 0 or not re.fullmatch(r"v24\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
        raise RuntimeError(f"Runtime smoke test requires Node.js 24; found {version or '<unknown>'}")
    return candidate


def _random_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _wait_for_health(port: int, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    url = f"http://127.0.0.1:{port}/health"
    last_error = "not reachable"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
                last_error = f"HTTP {response.status}"
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = str(error)
        time.sleep(0.25)
    raise RuntimeError(f"Runtime /health did not return HTTP 200: {last_error}")


def _wait_for_port_release(port: int, timeout: float = 20) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
                listener.bind(("127.0.0.1", port))
            return True
        except OSError:
            time.sleep(0.25)
    return False


def smoke_runtime_archive(
    path: Path,
    studio: dict,
    node_binary: str | Path | None = None,
    *,
    already_validated: bool = False,
) -> None:
    """Exercise the locked x64 Runtime with Node 24 before it can enter an Offline FPK."""
    path = path.resolve()
    if not already_validated:
        validate_runtime_archive(path, studio)
    if int(studio.get("nodeMajor", 0)) != 24:
        raise ValueError("Runtime manifest nodeMajor must be 24")
    target = str(studio.get("platform", ""))
    if target != "linux-x64":
        raise RuntimeError(f"full Runtime smoke test only supports linux-x64; found {target or '<unknown>'}")
    node = _node_24(node_binary)
    expected_version = str(studio.get("version", ""))

    with tempfile.TemporaryDirectory(prefix="hstudio-runtime-smoke-") as temporary:
        extraction_root = Path(temporary) / "runtime"
        with tarfile.open(path, "r:*") as archive:
            members = archive.getmembers()
            for member in members:
                _safe_tar_member(member)
            package_roots = []
            for member in members:
                parts = PurePosixPath(member.name.rstrip("/")).parts
                if len(parts) != 2 or parts[1] != "package.json" or not member.isfile():
                    continue
                stream = archive.extractfile(member)
                if stream is None:
                    continue
                package = json.loads(stream.read().decode("utf-8"))
                if package.get("name") == "hermes-web-ui":
                    package_roots.append(parts[0])
            if len(package_roots) != 1:
                raise ValueError("Runtime smoke test requires one hermes-web-ui package root")
            archive.extractall(extraction_root, members=members, filter="data")

        package_root = extraction_root / package_roots[0]
        entry = package_root / "bin" / "hermes-web-ui"
        if not entry.exists():
            entry = package_root / "bin" / "hermes-web-ui.mjs"
        environment = {
            **os.environ,
            "HOME": str(Path(temporary) / "home"),
            "HERMES_WEB_UI_HOME": str(Path(temporary) / "state"),
            "HERMES_RUNTIME_SOURCE": "none",
            "HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART": "1",
            "HERMES_WEB_UI_DISABLE_SKILL_INJECTION": "1",
            "HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT": "1",
            "HERMES_LAN_DISCOVERY_ENABLED": "0",
            "HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN": "0",
        }
        version_result = subprocess.run(
            [node, str(entry), "--version"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=environment,
            timeout=20,
        )
        actual_version = f"{version_result.stdout}{version_result.stderr}".strip()
        expected_output = f"hermes-web-ui v{expected_version}"
        if version_result.returncode != 0 or actual_version != expected_output:
            raise RuntimeError(
                f"Runtime CLI version mismatch: expected={expected_output!r} actual={actual_version!r}"
            )

        port = _random_loopback_port()
        start_error: Exception | None = None
        stop_result = None
        try:
            start_result = subprocess.run(
                [node, str(entry), "start", "--port", str(port), "--no-open"],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=environment,
                timeout=RUNTIME_SMOKE_TIMEOUT_SECONDS,
            )
            if start_result.returncode != 0:
                output = f"{start_result.stdout}{start_result.stderr}".strip()[-2000:]
                raise RuntimeError(f"Runtime start failed: {output or start_result.returncode}")
            _wait_for_health(port, RUNTIME_SMOKE_TIMEOUT_SECONDS)
        except Exception as error:  # cleanup is mandatory even when startup or health fails
            start_error = error
        finally:
            try:
                stop_result = subprocess.run(
                    [node, str(entry), "stop"],
                    check=False,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    env=environment,
                    timeout=30,
                )
            except (OSError, subprocess.SubprocessError) as error:
                if start_error is None:
                    start_error = RuntimeError(f"Runtime stop could not be executed: {error}")
        released = _wait_for_port_release(port)
        if start_error is not None:
            raise start_error
        if stop_result is None or stop_result.returncode != 0:
            output = "" if stop_result is None else f"{stop_result.stdout}{stop_result.stderr}".strip()[-2000:]
            raise RuntimeError(f"Runtime stop failed: {output or '<no output>'}")
        if not released:
            raise RuntimeError(f"Runtime stop did not release loopback port {port}")


def validate_license_file(studio: dict) -> tuple[Path, str]:
    relative_name = str(studio.get("licenseFile", ""))
    expected_sha256 = str(studio.get("licenseSha256", "")).lower()
    relative = PurePosixPath(relative_name)
    if not relative_name or relative.is_absolute() or ".." in relative.parts or "\\" in relative_name:
        raise ValueError("Runtime licenseFile must be a safe repository-relative path")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("Runtime licenseSha256 is missing or invalid")
    path = (ROOT / Path(*relative.parts)).resolve()
    if not path.is_file() or ROOT.resolve() not in path.parents:
        raise FileNotFoundError(f"Runtime license file not found: {path}")
    actual_sha256 = file_sha256(path)
    if actual_sha256 != expected_sha256:
        raise ValueError(
            f"Runtime LICENSE SHA256 mismatch: expected={expected_sha256} actual={actual_sha256}"
        )
    return path, relative.as_posix()


def _fetch_json(url: str) -> dict:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "fnos-HStudio-builder/1",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if urllib.parse.urlparse(url).hostname == "api.github.com" and os.getenv("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    error = None
    for attempt in range(GITHUB_REQUEST_ATTEMPTS):
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=GITHUB_TIMEOUT_SECONDS) as response:
                body = response.read(2 * 1024 * 1024 + 1)
            break
        except (urllib.error.URLError, TimeoutError, OSError) as caught:
            error = caught
            if attempt + 1 < GITHUB_REQUEST_ATTEMPTS:
                time.sleep(attempt + 1)
    else:
        raise RuntimeError(f"GitHub verification request failed: {url}: {error}") from error
    if len(body) > 2 * 1024 * 1024:
        raise RuntimeError(f"GitHub verification response is unexpectedly large: {url}")
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"GitHub verification returned invalid JSON: {url}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"GitHub verification returned a non-object: {url}")
    return value


def _decode_github_file(data: dict, label: str) -> bytes:
    if data.get("type", "file") != "file" or data.get("encoding") != "base64":
        raise ValueError(f"GitHub {label} response is not a base64 file")
    try:
        content = base64.b64decode(str(data["content"]), validate=False)
    except (KeyError, ValueError) as error:
        raise ValueError(f"GitHub {label} response has invalid content") from error
    if int(data.get("size", -1)) != len(content):
        raise ValueError(f"GitHub {label} size mismatch")
    blob_sha = hashlib.sha1(f"blob {len(content)}\0".encode("ascii") + content).hexdigest()
    if str(data.get("sha", "")).lower() != blob_sha:
        raise ValueError(f"GitHub {label} blob hash mismatch")
    return content


def verify_upstream_metadata(
    studio: dict,
    fetch_json: Callable[[str], dict] = _fetch_json,
) -> dict:
    """Verify pinned release metadata, tag commit, package metadata and LICENSE online."""
    repository = urllib.parse.urlparse(str(studio.get("upstreamRepository", "")))
    path_parts = [part for part in repository.path.split("/") if part]
    if repository.scheme != "https" or repository.hostname != "github.com" or len(path_parts) != 2:
        raise ValueError("upstreamRepository must be an https://github.com/<owner>/<repo> URL")
    owner, repo = path_parts
    api = f"https://api.github.com/repos/{owner}/{repo}"
    tag = str(studio.get("upstreamTag", ""))
    version = str(studio.get("version", ""))
    commit = str(studio.get("upstreamCommit", "")).lower()
    source_url = str(studio.get("sourceUrl", ""))
    if tag != f"v{version}":
        raise ValueError(f"upstream tag/version mismatch: tag={tag!r} version={version!r}")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("upstreamCommit must be a full 40-character SHA")
    if studio.get("sourceType") != "official-release":
        raise ValueError("Offline Runtime sourceType must be official-release")

    latest = fetch_json(f"{api}/releases/latest")
    latest_tag = str(latest.get("tag_name", ""))
    if not latest_tag or latest.get("draft"):
        raise ValueError("GitHub latest release metadata is invalid")
    if latest_tag != tag:
        raise ValueError(
            f"pinned upstreamTag {tag!r} is stale; GitHub latest release is {latest_tag!r}. "
            "Offline FPK must bundle the latest upstream release"
        )

    release = fetch_json(f"{api}/releases/tags/{urllib.parse.quote(tag, safe='')}")
    if release.get("tag_name") != tag or release.get("draft"):
        raise ValueError(f"GitHub release metadata does not identify published tag {tag}")
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise ValueError(f"GitHub release {tag} has no asset metadata")
    runtime_asset = next(
        (asset for asset in assets if isinstance(asset, dict) and asset.get("browser_download_url") == source_url),
        None,
    )
    if runtime_asset is None:
        raise ValueError("Runtime sourceUrl is not an asset of the pinned GitHub release")
    if int(runtime_asset.get("size", -1)) != int(studio.get("size", -2)):
        raise ValueError("GitHub Runtime asset size does not match runtime-manifest.json")

    runtime_name = Path(urllib.parse.urlparse(source_url).path).name
    metadata_url = str(studio.get("releaseMetadataUrl", ""))
    metadata_name = Path(urllib.parse.urlparse(metadata_url).path).name
    expected_metadata_name = re.sub(r"\.tar\.(?:gz|zst)$", ".json", runtime_name)
    if not metadata_url or metadata_name != expected_metadata_name:
        raise ValueError("Runtime releaseMetadataUrl is missing or inconsistent with sourceUrl")
    metadata_asset = next(
        (
            asset
            for asset in assets
            if isinstance(asset, dict)
            and asset.get("name") == metadata_name
            and asset.get("browser_download_url") == metadata_url
        ),
        None,
    )
    if metadata_asset is None:
        raise ValueError(f"GitHub release lacks Runtime metadata asset {metadata_name}")
    release_metadata = fetch_json(metadata_url)
    released_asset = release_metadata.get("asset", {})
    if (
        str(release_metadata.get("webUiVersion", "")) != version
        or str(released_asset.get("name", "")) != runtime_name
        or str(released_asset.get("sha256", "")).lower() != str(studio.get("sha256", "")).lower()
        or int(released_asset.get("size", -1)) != int(studio.get("size", -2))
    ):
        raise ValueError("GitHub Runtime metadata does not match runtime-manifest.json")

    tag_ref = fetch_json(f"{api}/git/ref/tags/{urllib.parse.quote(tag, safe='')}")
    git_object = tag_ref.get("object", {})
    seen = set()
    while git_object.get("type") == "tag":
        sha = str(git_object.get("sha", "")).lower()
        if not re.fullmatch(r"[0-9a-f]{40}", sha) or sha in seen:
            raise ValueError(f"invalid annotated Git tag object for {tag}")
        seen.add(sha)
        git_object = fetch_json(f"{api}/git/tags/{sha}").get("object", {})
    tag_commit = str(git_object.get("sha", "")).lower()
    if git_object.get("type") != "commit" or not re.fullmatch(r"[0-9a-f]{40}", tag_commit):
        raise ValueError(f"GitHub tag {tag} does not resolve to a commit")

    package_response = fetch_json(f"{api}/contents/package.json?ref={urllib.parse.quote(commit, safe='')}")
    package_bytes = _decode_github_file(package_response, "package.json")
    try:
        package = json.loads(package_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("upstream package.json is invalid") from error
    if str(package.get("version", "")) != version:
        raise ValueError("upstream package.json version does not match runtime-manifest.json")
    if str(package.get("license", "")) != str(studio.get("license", "")):
        raise ValueError("upstream package.json license identifier changed; review required")

    license_response = fetch_json(f"{api}/contents/LICENSE?ref={urllib.parse.quote(commit, safe='')}")
    license_bytes = _decode_github_file(license_response, "LICENSE")
    license_sha256 = hashlib.sha256(license_bytes).hexdigest()
    expected_license_sha256 = str(studio.get("licenseSha256", "")).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_license_sha256):
        raise ValueError("runtime-manifest.json does not record the upstream LICENSE SHA256")
    if license_sha256 != expected_license_sha256:
        raise ValueError(
            f"upstream LICENSE changed: expected={expected_license_sha256} actual={license_sha256}; "
            "review required"
        )
    if tag_commit != commit:
        raise ValueError(
            f"pinned upstreamCommit {commit} does not match GitHub tag {tag} commit {tag_commit}; "
            f"LICENSE sha256 at pinned commit is {license_sha256}"
        )
    return {
        "latestTag": latest_tag,
        "tag": tag,
        "commit": commit,
        "licenseSha256": license_sha256,
    }


def version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", version))


def prune_old_fpk(keep_versions: int) -> None:
    """Keep only the newest FPK version numbers and their checksum sidecars."""
    packages = [package for package in OUT.glob("*.fpk") if FPK_NAME.fullmatch(package.name)]
    versions: dict[str, list[Path]] = {}
    for package in packages:
        match = FPK_NAME.fullmatch(package.name)
        if match:
            versions.setdefault(match.group(1), []).append(package)
    keep = set(sorted(versions, key=version_key, reverse=True)[: max(1, keep_versions)])
    for version, files in versions.items():
        if version in keep:
            continue
        for package in files:
            package.unlink()
            sidecar = package.with_suffix(package.suffix + ".sha256")
            if sidecar.exists():
                sidecar.unlink()


def refresh_artifacts_index(keep_versions: int = 3) -> None:
    manifest = json.loads((ROOT / "config/runtime-manifest.json").read_text(encoding="utf-8"))
    studio = manifest.get("studio", {})
    rows = []
    packages = [package for package in OUT.glob("*.fpk") if FPK_NAME.fullmatch(package.name)]
    for package in sorted(
        packages,
        key=lambda path: (version_key(FPK_NAME.fullmatch(path.name).group(1)), path.name),
        reverse=True,
    ):
        rows.append(f"| {package.name} | {package.stat().st_size} | {file_sha256(package)} |")
    text = "# FPK artifacts\n\n| File | Bytes | SHA256 |\n|---|---:|---|\n"
    text += "\n".join(rows) + "\n\n"
    text += (
        f"Bundled Hermes Studio Runtime: {studio.get('version', 'unknown')}; "
        f"FPK versions retained: newest {max(1, keep_versions)}; "
        f"upstream commit: `{studio.get('upstreamCommit', 'unknown')}`; "
        f"license: {studio.get('license', 'unknown')} "
        f"(`{studio.get('licenseStatus', 'unknown')}`).\n"
    )
    (OUT / "ARTIFACTS.md").write_text(text, encoding="utf-8")


def create_app_payload(variant: str, runtime: Path | None, package_manifest: dict) -> bytes:
    app_buffer = io.BytesIO()
    with deterministic_tar_gz(app_buffer) as tar:
        for directory in ("bin", "ui"):
            path = ROOT / "app" / directory
            if path.exists():
                add_tree(tar, path, directory)
        license_path, license_name = validate_license_file(package_manifest["studio"])
        if not PROJECT_LICENSE.is_file():
            raise FileNotFoundError(f"project license missing: {PROJECT_LICENSE}")
        if not THIRD_PARTY_NOTICE.is_file():
            raise FileNotFoundError(f"third-party notices missing: {THIRD_PARTY_NOTICE}")
        tar.add(ROOT / "licenses", arcname="licenses", recursive=False, filter=normalize)
        tar.add(
            PROJECT_LICENSE,
            arcname="licenses/HStudio-LICENSE.txt",
            recursive=False,
            filter=normalize,
        )
        tar.add(license_path, arcname=license_name, recursive=False, filter=normalize)
        tar.add(
            THIRD_PARTY_NOTICE,
            arcname="licenses/THIRD-PARTY-NOTICES.md",
            recursive=False,
            filter=normalize,
        )
        add_trim_cli_payload(tar, package_manifest)
        if variant == "offline":
            if runtime is None:
                raise ValueError("Offline app payload requires a verified Runtime archive")
            tar.add(
                runtime,
                arcname=f"runtime/{package_manifest['studio']['archive']}",
                recursive=False,
                filter=normalize,
            )
        if (ROOT / "manager").exists():
            add_tree(tar, ROOT / "manager", "manager")
    return app_buffer.getvalue()


def _manifest_values(text: str) -> dict[str, str]:
    values = {}
    for line in text.splitlines():
        match = re.fullmatch(r"\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*", line)
        if match:
            values[match.group(1)] = match.group(2).strip().strip('"')
    return values


def validate_built_fpk(path: Path, variant: str, version: str, package_manifest: dict) -> None:
    """Validate fnOS outer archive, app.tgz and variant-specific Runtime payload."""
    try:
        with tarfile.open(path, "r:gz") as outer:
            outer_members = outer.getmembers()
            for member in outer_members:
                _safe_tar_member(member)
            outer_names = {member.name.rstrip("/") for member in outer_members}
            required_outer = {
                "app.tgz",
                "manifest",
                "cmd/main",
                "config/resource",
                "config/runtime-manifest.json",
                "wizard/install",
                "wizard/uninstall",
            }
            missing_outer = sorted(required_outer - outer_names)
            if missing_outer:
                raise ValueError("FPK outer archive is missing: " + ", ".join(missing_outer))
            non_executable_cmd = sorted(
                member.name
                for member in outer_members
                if member.isfile() and member.name.startswith("cmd/") and not member.mode & 0o111
            )
            if non_executable_cmd:
                raise ValueError("FPK lifecycle scripts are not executable: " + ", ".join(non_executable_cmd))
            app_data = outer.extractfile("app.tgz").read()
            manifest_text = outer.extractfile("manifest").read().decode("utf-8")
            packaged_runtime_manifest = json.loads(
                outer.extractfile("config/runtime-manifest.json").read().decode("utf-8")
            )
        values = _manifest_values(manifest_text)
        if values.get("version") != version:
            raise ValueError(
                f"FPK manifest version mismatch: expected={version!r} actual={values.get('version')!r}"
            )
        if values.get("checksum") != hashlib.md5(app_data).hexdigest():
            raise ValueError("FPK manifest checksum does not match app.tgz")
        if packaged_runtime_manifest != package_manifest:
            raise ValueError("packaged runtime-manifest.json differs from validated build metadata")

        with tarfile.open(fileobj=io.BytesIO(app_data), mode="r:gz") as app:
            app_members = app.getmembers()
            for member in app_members:
                _safe_tar_member(member)
            app_names = {member.name.rstrip("/") for member in app_members}
            required_app = {
                "bin/hermes-web-ui",
                "manager/backend/server.mjs",
                "manager/frontend/index.html",
                "skills/trim-cli/SKILL.md",
                "skills/trim-cli/scripts/trim-cli",
                "skills/trim-cli/bin/trim-cli-linux-x64",
                "skills/trim-cli/bin/trim-cli-linux-arm64",
                "licenses",
                "licenses/HStudio-LICENSE.txt",
                "licenses/THIRD-PARTY-NOTICES.md",
                str(package_manifest["studio"]["licenseFile"]),
            }
            missing_app = sorted(required_app - app_names)
            if missing_app:
                raise ValueError("app.tgz is missing: " + ", ".join(missing_app))
            executable_app_files = {
                "bin/hermes-web-ui",
                "skills/trim-cli/scripts/trim-cli",
                "skills/trim-cli/bin/trim-cli-linux-x64",
                "skills/trim-cli/bin/trim-cli-linux-arm64",
            }
            by_app_name = {member.name.rstrip("/"): member for member in app_members}
            non_executable_app = sorted(
                name for name in executable_app_files if not by_app_name[name].mode & 0o111
            )
            if non_executable_app:
                raise ValueError("app.tgz executable files lack 0755 mode: " + ", ".join(non_executable_app))
            license_name = str(package_manifest["studio"]["licenseFile"])
            license_stream = app.extractfile(license_name)
            if license_stream is None:
                raise ValueError("packaged Runtime LICENSE is unreadable")
            license_sha256, _ = stream_sha256(license_stream)
            if license_sha256 != str(package_manifest["studio"]["licenseSha256"]).lower():
                raise ValueError("packaged Runtime LICENSE differs from runtime-manifest.json")
            runtime_name = f"runtime/{package_manifest['studio']['archive']}"
            runtime_members = sorted(name for name in app_names if name.startswith("runtime/"))
            if variant == "lite":
                if runtime_members:
                    raise ValueError("Lite FPK unexpectedly contains a Runtime archive")
            else:
                if runtime_members != [runtime_name]:
                    raise ValueError(
                        f"Offline FPK Runtime payload mismatch: expected only {runtime_name!r}, "
                        f"actual={runtime_members!r}"
                    )
                runtime_stream = app.extractfile(runtime_name)
                if runtime_stream is None:
                    raise ValueError("Offline FPK Runtime archive is unreadable")
                actual_sha256, actual_size = stream_sha256(runtime_stream)
                studio = package_manifest["studio"]
                if actual_size != int(studio["size"]) or actual_sha256 != str(studio["sha256"]).lower():
                    raise ValueError("Offline FPK Runtime bytes differ from the verified archive")
    except (tarfile.TarError, OSError, KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid FPK structure: {path}") from error


def _write_fpk(
    output: Path,
    variant: str,
    version: str,
    runtime: Path | None,
    package_manifest: dict,
) -> None:
    app_data = create_app_payload(variant, runtime, package_manifest)
    checksum = hashlib.md5(app_data).hexdigest()
    manifest_lines = (ROOT / "manifest").read_text(encoding="utf-8").splitlines()
    manifest_lines = [
        f"checksum              = {checksum}" if line.startswith("checksum") else line
        for line in manifest_lines
    ]
    temporary = output.with_name(output.name + ".part")
    temporary.unlink(missing_ok=True)
    try:
        with deterministic_tar_gz(temporary) as tar:
            put_bytes(tar, "app.tgz", app_data)
            for name in ("cmd", "config"):
                path = ROOT / name
                if not path.exists():
                    continue
                tar.add(path, arcname=name, recursive=False, filter=normalize)
                for child in sorted(path.rglob("*")):
                    if name == "config" and child == path / "runtime-manifest.json":
                        continue
                    tar.add(
                        child,
                        arcname=f"{name}/{child.relative_to(path).as_posix()}",
                        recursive=False,
                        filter=normalize,
                    )
            put_bytes(
                tar,
                "config/runtime-manifest.json",
                (json.dumps(package_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
            )
            for name in ("ICON.PNG", "ICON_256.PNG"):
                path = ROOT / name
                if path.exists():
                    tar.add(path, arcname=name, recursive=False, filter=normalize)
            put_bytes(tar, "manifest", ("\n".join(manifest_lines) + "\n").encode("utf-8"))
            wizard = ROOT / "wizard"
            if wizard.exists():
                add_tree(tar, wizard, "wizard")
        validate_built_fpk(temporary, variant, version, package_manifest)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def build(
    variant: str,
    version: str | None = None,
    keep_versions: int = 3,
    runtime_path: Path | None = None,
    verify_upstream_online: bool = True,
) -> Path:
    if variant not in ("lite", "offline"):
        raise ValueError(f"unsupported FPK variant: {variant}")
    resolved_version = checked_package_version(version)
    OUT.mkdir(parents=True, exist_ok=True)
    package_manifest = json.loads(
        (ROOT / "config/runtime-manifest.json").read_text(encoding="utf-8")
    )
    validate_license_file(package_manifest["studio"])
    runtime = None
    if variant == "offline":
        if not verify_upstream_online and os.getenv("HSTUDIO_TESTING") != "1":
            raise ValueError("skipping Offline upstream verification requires HSTUDIO_TESTING=1")
        runtime = resolve_runtime_archive(package_manifest["studio"], runtime_path)
        if verify_upstream_online:
            report = verify_upstream_metadata(package_manifest["studio"])
            print(
                f"Verified upstream {report['tag']} commit={report['commit']} "
                f"license-sha256={report['licenseSha256']}"
            )
        else:
            print(
                "WARNING: test-only upstream verification skip is active",
                file=sys.stderr,
            )
        smoke_runtime_archive(runtime, package_manifest["studio"], already_validated=True)
        print(f"Runtime smoke test passed with Node.js 24: {runtime.name}")

    output = OUT / f"{PROJECT_SLUG}-{variant}-v{resolved_version}.fpk"
    _write_fpk(output, variant, resolved_version, runtime, package_manifest)
    sha256 = file_sha256(output)
    output.with_suffix(output.suffix + ".sha256").write_text(
        f"{sha256}  {output.name}\n", encoding="utf-8"
    )
    print(f"{output} {output.stat().st_size} bytes sha256={sha256}")
    prune_old_fpk(keep_versions)
    refresh_artifacts_index(keep_versions)
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", choices=("lite", "offline"), default=os.getenv("BUILD_VARIANT", "lite"))
    parser.add_argument("--version", default=None, help="must match the root manifest version")
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--keep-versions", type=int, default=3)
    parser.add_argument("--runtime-archive", type=Path, default=None)
    parser.add_argument(
        "--test-skip-upstream-verification",
        action="store_true",
        help="tests only: skip GitHub latest/release/commit/LICENSE verification",
    )
    args = parser.parse_args()
    if args.test_skip_upstream_verification and os.getenv("HSTUDIO_TESTING") != "1":
        parser.error("--test-skip-upstream-verification requires HSTUDIO_TESTING=1")
    global OUT
    if args.output_dir:
        OUT = Path(args.output_dir).resolve()
    build(
        args.variant,
        args.version,
        args.keep_versions,
        args.runtime_archive,
        verify_upstream_online=not args.test_skip_upstream_verification,
    )


if __name__ == "__main__":
    main()
