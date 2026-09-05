#!/usr/bin/env python3
"""Build and verify the online fnOS FPK without bundling Node.js."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import tarfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts"
PROJECT_SLUG = "fnos-HStudio"
FPK_NAME = re.compile(r"(?:fnos-HStudio|HStudio)(?:-lite)?-v(.+)\.fpk$")
TRIM_CLI_SKILL = ROOT / ".agents" / "skills" / "trim-cli"
PROJECT_LICENSE = ROOT / "LICENSE"
THIRD_PARTY_NOTICE = ROOT / "licenses" / "THIRD-PARTY-NOTICES.md"
# Keep package inputs reviewable; recursive directory scans also capture ignored local files.
APP_PAYLOAD_FILES = (
    ("app/bin/hermes-web-ui", "bin/hermes-web-ui"),
    ("app/ui/config", "ui/config"),
    ("app/ui/images/icon_64.png", "ui/images/icon_64.png"),
    ("app/ui/images/icon_256.png", "ui/images/icon_256.png"),
    ("manager/backend/server.mjs", "manager/backend/server.mjs"),
    ("manager/frontend/index.html", "manager/frontend/index.html"),
)
TRIM_CLI_FILES = (
    "SKILL.md",
    "entries/trim-app.md",
    "entries/trim-docker.md",
    "entries/trim-download.md",
    "entries/trim-file.md",
    "entries/trim-log.md",
    "entries/trim-media.md",
    "entries/trim-monitor.md",
    "entries/trim-network.md",
    "entries/trim-photos.md",
    "entries/trim-shared.md",
    "entries/trim-storage.md",
    "entries/trim-system.md",
    "entries/trim-user.md",
    "reference/_conventions.md",
    "reference/_index.md",
    "reference/app-center.md",
    "reference/dockermgr.md",
    "reference/download.md",
    "reference/file.md",
    "reference/log.md",
    "reference/media.md",
    "reference/network.md",
    "reference/photos.md",
    "reference/power.md",
    "reference/resmon.md",
    "reference/stor.md",
    "reference/sysinfo.md",
    "reference/user.md",
    "reference/workflows/device-validation.md",
    "reference/workflows/file-routing.md",
    "reference/workflows/file-upload-validation.md",
    "reference/workflows/media-routing.md",
    "reference/workflows/photos-routing.md",
    "reference/workflows/storage-dangerous-ops.md",
    "scripts/trim-cli",
    "bin/trim-cli-linux-arm64",
    "bin/trim-cli-linux-x64",
)
OUTER_PAYLOAD_FILES = (
    "cmd/install_callback",
    "cmd/install_init",
    "cmd/lib/environment.sh",
    "cmd/lib/process.sh",
    "cmd/lib/runtime.sh",
    "cmd/lib/skills.sh",
    "cmd/main",
    "cmd/uninstall_callback",
    "cmd/uninstall_init",
    "cmd/upgrade_callback",
    "cmd/upgrade_init",
    "config/privilege",
    "config/resource",
    "wizard/install",
    "wizard/uninstall",
    "ICON.PNG",
    "ICON_256.PNG",
)
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


def add_required_file(tar: tarfile.TarFile, source: Path, arcname: str) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"required payload file missing: {source}")
    tar.add(source, arcname=arcname, recursive=False, filter=normalize)


def add_directory(tar: tarfile.TarFile, source: Path, arcname: str) -> None:
    if not source.is_dir():
        raise FileNotFoundError(f"required payload directory missing: {source}")
    tar.add(source, arcname=arcname, recursive=False, filter=normalize)


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
    expected_entries = [name for name in TRIM_CLI_FILES if name.startswith("entries/")]
    if skill_manifest.get("entries") != expected_entries:
        raise ValueError("trim-cli entry manifest differs from the packaged whitelist")
    skill_manifest["bin"] = {
        "linux-arm64": "bin/trim-cli-linux-arm64",
        "linux-x64": "bin/trim-cli-linux-x64",
    }

    arcname = "skills/trim-cli"
    add_directory(tar, source, arcname)
    for directory in ("entries", "reference", "reference/workflows", "scripts", "bin"):
        add_directory(tar, source / directory, f"{arcname}/{directory}")
    for relative_name in TRIM_CLI_FILES:
        add_required_file(tar, source / relative_name, f"{arcname}/{relative_name}")
    put_bytes(
        tar,
        f"{arcname}/manifest.json",
        (json.dumps(skill_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
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
    canonical_versions = {
        version
        for version in versions
        if (OUT / f"{PROJECT_SLUG}-v{version}.fpk").exists()
    }
    version_pool = canonical_versions or set(versions)
    keep = set(sorted(version_pool, key=version_key, reverse=True)[: max(1, keep_versions)])
    for version, files in versions.items():
        canonical = OUT / f"{PROJECT_SLUG}-v{version}.fpk"
        for package in files:
            if version in keep and (package == canonical or not canonical_versions):
                continue
            package.unlink()
            sidecar = package.with_suffix(package.suffix + ".sha256")
            if sidecar.exists():
                sidecar.unlink()


def refresh_artifacts_index(keep_versions: int = 3) -> None:
    manifest = json.loads((ROOT / "config/runtime-manifest.json").read_text(encoding="utf-8"))
    studio = manifest.get("studio", {})
    trim_cli = manifest.get("trimCli", {})
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
        f"Hermes Studio bootstrap target: {studio.get('version', 'unknown')}; "
        f"FPK versions retained: newest {max(1, keep_versions)}; "
        f"trim-cli license: {trim_cli.get('license', 'unknown')} "
        f"(`{trim_cli.get('licenseStatus', 'unknown')}`).\n"
    )
    (OUT / "ARTIFACTS.md").write_text(text, encoding="utf-8")


def create_app_payload(package_manifest: dict) -> bytes:
    app_buffer = io.BytesIO()
    with deterministic_tar_gz(app_buffer) as tar:
        for source_name, archive_name in APP_PAYLOAD_FILES:
            add_required_file(tar, ROOT / source_name, archive_name)
        license_path, license_name = validate_license_file(package_manifest["studio"])
        if not PROJECT_LICENSE.is_file():
            raise FileNotFoundError(f"project license missing: {PROJECT_LICENSE}")
        if not THIRD_PARTY_NOTICE.is_file():
            raise FileNotFoundError(f"third-party notices missing: {THIRD_PARTY_NOTICE}")
        add_directory(tar, ROOT / "licenses", "licenses")
        add_required_file(tar, PROJECT_LICENSE, "licenses/HStudio-LICENSE.txt")
        add_required_file(tar, license_path, license_name)
        add_required_file(tar, THIRD_PARTY_NOTICE, "licenses/THIRD-PARTY-NOTICES.md")
        add_trim_cli_payload(tar, package_manifest)
    return app_buffer.getvalue()


def _manifest_values(text: str) -> dict[str, str]:
    values = {}
    for line in text.splitlines():
        match = re.fullmatch(r"\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*", line)
        if match:
            values[match.group(1)] = match.group(2).strip().strip('"')
    return values


def validate_built_fpk(path: Path, version: str, package_manifest: dict) -> None:
    """Validate the fnOS outer archive and online-only app payload."""
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
            runtime_members = sorted(name for name in app_names if name.startswith("runtime/"))
            if runtime_members:
                raise ValueError("FPK unexpectedly contains a Runtime archive")
    except (tarfile.TarError, OSError, KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid FPK structure: {path}") from error


def _write_fpk(
    output: Path,
    version: str,
    package_manifest: dict,
) -> None:
    app_data = create_app_payload(package_manifest)
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
            for directory in ("cmd", "config", "wizard"):
                add_directory(tar, ROOT / directory, directory)
            for relative_name in OUTER_PAYLOAD_FILES:
                add_required_file(tar, ROOT / relative_name, relative_name)
            put_bytes(
                tar,
                "config/runtime-manifest.json",
                (json.dumps(package_manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
            )
            put_bytes(tar, "manifest", ("\n".join(manifest_lines) + "\n").encode("utf-8"))
        validate_built_fpk(temporary, version, package_manifest)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def build(
    version: str | None = None,
    keep_versions: int = 3,
) -> Path:
    resolved_version = checked_package_version(version)
    OUT.mkdir(parents=True, exist_ok=True)
    package_manifest = json.loads(
        (ROOT / "config/runtime-manifest.json").read_text(encoding="utf-8")
    )
    validate_license_file(package_manifest["studio"])
    output = OUT / f"{PROJECT_SLUG}-v{resolved_version}.fpk"
    _write_fpk(output, resolved_version, package_manifest)
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
    parser.add_argument("--version", default=None, help="must match the root manifest version")
    parser.add_argument("--output-dir", default=None)
    parser.add_argument("--keep-versions", type=int, default=3)
    args = parser.parse_args()
    global OUT
    if args.output_dir:
        OUT = Path(args.output_dir).resolve()
    build(args.version, args.keep_versions)


if __name__ == "__main__":
    main()
