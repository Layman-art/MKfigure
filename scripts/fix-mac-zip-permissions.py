"""Build/validate Darwin app ZIPs on Windows without changing system policy.

Uses Electron's documented prebuilt-binary + app.asar distribution layout.
Framework symlinks come verbatim from the official archive. Windows staging
uses junctions/hardlinks solely for reading nested framework signing metadata;
the final ZIP restores actual Unix symbolic links and executable modes.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import posixpath
import re
import shutil
import stat
import struct
import subprocess
from typing import Callable
import zipfile

CPU_TYPES = {"arm64": 0x100000C, "x64": 0x1000007}


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def validate_library(read_resource: Callable[[str], bytes]) -> dict:
    """Verify originals and previews in either a staging tree or the final ZIP."""
    catalog = json.loads(read_resource("library/catalog.json"))
    hashes = json.loads(read_resource("library/hashes.json"))
    if not isinstance(catalog, list) or len(catalog) != 13:
        raise AssertionError("Expected 13 bundled library assets")
    if not isinstance(hashes, list) or len(hashes) != 13:
        raise AssertionError("Missing library source hash records")
    recorded = {item["id"]: item for item in hashes}
    ids = {item["id"] for item in catalog}
    if len(ids) != 13 or set(recorded) != ids:
        raise AssertionError("Duplicate or missing library identifiers")
    references = {item["id"] for item in catalog if item["category"] == "reference"}
    if references != {"pastel-method", "algorithm-flow", "voltage-control"}:
        raise AssertionError("Bundled reference identifiers changed")
    icons = 0
    for item in catalog:
        for key in ("file", "thumbnail"):
            relative = item[key]
            parts = PurePosixPath(relative)
            if parts.is_absolute() or ".." in parts.parts or "\\" in relative or ":" in relative:
                raise AssertionError("Unsafe library resource path")
        original = read_resource(item["file"])
        thumbnail = read_resource(item["thumbnail"])
        if not original or not thumbnail.startswith(b"\x89PNG\r\n\x1a\n"):
            raise AssertionError("Missing library original or PNG thumbnail: " + item["id"])
        record = recorded[item["id"]]
        digest = hashlib.sha256(original).hexdigest()
        if record["file"] != item["file"] or digest != record["sha256"]:
            raise AssertionError("Bundled library original hash changed: " + item["id"])
        if item["category"] == "icon":
            if item["extension"] != "svg" or item["mime"] != "image/svg+xml" or not item["file"].endswith(".svg"):
                raise AssertionError("Bundled icon is not its original SVG")
            if record.get("sourceSha256") != digest or record.get("identical") is not True:
                raise AssertionError("Bundled SVG differs from source artwork: " + item["id"])
            icons += 1
        elif item["category"] != "reference":
            raise AssertionError("Unknown library category")
    if icons != 10:
        raise AssertionError("Expected 10 bundled SVG icons")
    return {"assets": len(catalog), "references": len(references), "svgIcons": icons,
            "thumbnails": len(catalog), "originalHashesVerified": True, "svgSourceHashesPreserved": True}


def architecture(data: bytes) -> list[int]:
    if data[:4] in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe"):
        return [struct.unpack("<I", data[4:8])[0]]
    if data[:4] in (b"\xfe\xed\xfa\xcf", b"\xfe\xed\xfa\xce"):
        return [struct.unpack(">I", data[4:8])[0]]
    if data[:4] in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
        count = struct.unpack(">I", data[4:8])[0]
        stride = 32 if data[:4] == b"\xca\xfe\xba\xbf" else 20
        return [struct.unpack(">I", data[8 + i * stride:12 + i * stride])[0] for i in range(min(count, 16))]
    return []


def ensure_inside(path: Path, root: Path) -> None:
    if not path.absolute().is_relative_to(root.absolute()):
        raise ValueError(f"Path escaped packaging workspace: {path}")


def rename_entry(name: str) -> str:
    name = name.replace("Electron.app/", "MK Figure.app/", 1)
    name = name.replace("/Electron Helper", "/MK Figure Helper")
    if name == "MK Figure.app/Contents/MacOS/Electron":
        name = "MK Figure.app/Contents/MacOS/MK Figure"
    return name


def read_asar_metadata(asar: Path, workspace: Path) -> dict:
    js = """const a=require('@electron/asar'),c=require('node:crypto');
const f=process.argv[1], p=JSON.parse(a.extractFile(f,'package.json'));
const entries=a.listPackage(f); console.log(JSON.stringify({main:p.main,version:p.version,
native:entries.filter(v=>/\\.(node|dll|dylib|exe)$/i.test(v)),
headerHash:c.createHash('sha256').update(a.getRawHeader(f).headerString).digest('hex'),entries:entries.length}));"""
    result = subprocess.run(["node", "-e", js, str(asar)], cwd=workspace, capture_output=True, text=True, check=True)
    metadata = json.loads(result.stdout)
    if metadata["native"]:
        raise ValueError("Windows app.asar includes platform-native files; cannot reuse it for Darwin")
    if metadata["main"] != "dist/main/main.cjs":
        raise ValueError("Unexpected application entry point")
    return metadata


def prepare(workspace: Path, stage: Path, electron_zip: Path, asar: Path, arch: str) -> tuple[dict[str, str], dict]:
    stage.mkdir(parents=True, exist_ok=True)
    info = read_asar_metadata(asar, workspace)
    package = json.loads((workspace / "package.json").read_text("utf-8"))
    version_match = re.fullmatch(r"electron-v([0-9.]+)-darwin-(arm64|x64)\.zip", electron_zip.name)
    if not version_match or version_match.group(2) != arch:
        raise ValueError("Electron archive name/architecture mismatch")
    checksum_file = workspace / "release-mac/electron-SHASUMS256.txt"
    if not checksum_file.exists():
        import urllib.request
        urllib.request.urlretrieve(f"https://github.com/electron/electron/releases/download/v{version_match.group(1)}/SHASUMS256.txt", checksum_file)
    checksum_rows = [line.split() for line in checksum_file.read_text("utf-8").splitlines() if line.strip()]
    expected_hash = next((row[0] for row in checksum_rows if row[-1].lstrip("*") == electron_zip.name), None)
    actual_hash = sha256(electron_zip)
    if actual_hash != expected_hash:
        raise ValueError("Official Electron SHA256 mismatch")
    links = {}
    with zipfile.ZipFile(electron_zip) as source:
        for entry in source.infolist():
            if not entry.filename.startswith("Electron.app/"):
                continue
            if entry.filename.endswith("/default_app.asar"):
                continue
            name = rename_entry(entry.filename)
            if ".." in PurePosixPath(name).parts or name.startswith("/"):
                raise ValueError("Unsafe upstream ZIP entry")
            destination = stage / name
            ensure_inside(destination, stage)
            if stat.S_ISLNK(entry.external_attr >> 16):
                links[name.rstrip("/")] = source.read(entry).decode("utf-8")
                continue
            if entry.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            with source.open(entry) as stream, destination.open("wb") as target:
                shutil.copyfileobj(stream, target)
        resources = stage / "MK Figure.app/Contents/Resources"
        for upstream, local in [("LICENSE", "LICENSE.electron.txt"), ("LICENSES.chromium.html", "LICENSES.chromium.html")]:
            if upstream in source.namelist():
                (resources / local).write_bytes(source.read(upstream))

    # The final ZIP never contains NTFS junctions/hardlinks: it gets Unix links below.
    def resolve_alias(name: str) -> str:
        parts = name.split("/")
        for length in range(1, len(parts) + 1):
            prefix = "/".join(parts[:length])
            if prefix in links:
                target = posixpath.normpath(posixpath.join(posixpath.dirname(prefix), links[prefix]))
                return resolve_alias(posixpath.join(target, *parts[length:]))
        return name

    for name, target in sorted(links.items(), key=lambda item: len(item[0])):
        alias = stage / name
        actual = stage / resolve_alias(posixpath.normpath(posixpath.join(posixpath.dirname(name), target)))
        ensure_inside(alias, stage); ensure_inside(actual, stage)
        if alias.exists():
            continue
        alias.parent.mkdir(parents=True, exist_ok=True)
        if actual.is_dir():
            if os.name == "nt":
                subprocess.run(["cmd", "/d", "/c", "mklink", "/J", str(alias), str(actual)], capture_output=True, check=True)
            else:
                os.symlink(target, alias, target_is_directory=True)
        else:
            if os.name == "nt":
                os.link(actual, alias)
            else:
                os.symlink(target, alias)

    app = stage / "MK Figure.app"
    resources = app / "Contents/Resources"
    shutil.copy2(asar, resources / "app.asar")
    for folder in ["references", "library", "skill", "font-licenses"]:
        shutil.copytree(workspace / "resources" / folder, resources / folder, dirs_exist_ok=True)
    info["library"] = validate_library(lambda relative: (resources / relative).read_bytes())
    shutil.copytree(workspace / "resources/codex" / f"mac-{arch}", resources / "codex", dirs_exist_ok=True)
    for filename in ["icon.png", "icon.icns", "THIRD_PARTY_NOTICES.md"]:
        shutil.copy2(workspace / "resources" / filename, resources / filename)

    main_plist = app / "Contents/Info.plist"
    data = plistlib.loads(main_plist.read_bytes())
    data.update({"CFBundleName": "MK Figure", "CFBundleDisplayName": "MK Figure", "CFBundleExecutable": "MK Figure",
                 "CFBundleIdentifier": package["build"]["appId"], "CFBundleShortVersionString": package["version"],
                 "CFBundleVersion": package["version"], "CFBundleIconFile": "icon.icns",
                 "LSApplicationCategoryType": "public.app-category.productivity",
                 "ElectronAsarIntegrity": {"Resources/app.asar": {"algorithm": "SHA256", "hash": info["headerHash"]}}})
    main_plist.write_bytes(plistlib.dumps(data))
    helpers = sorted((app / "Contents/Frameworks").glob("MK Figure Helper*.app"))
    for helper in helpers:
        path = helper / "Contents/Info.plist"
        helper_data = plistlib.loads(path.read_bytes())
        name = helper.stem
        suffix = name.replace("MK Figure Helper", "").strip(" ()").lower()
        helper_data.update({"CFBundleName": name, "CFBundleDisplayName": name, "CFBundleExecutable": name,
                            "CFBundleIdentifier": package["build"]["appId"] + ".helper" + ("." + suffix if suffix else ""),
                            "CFBundleVersion": package["version"], "CFBundleShortVersionString": package["version"]})
        path.write_bytes(plistlib.dumps(helper_data))
    info.update({"appVersion": package["version"], "minimumMacOS": data["LSMinimumSystemVersion"], "electronZip": str(electron_zip), "electronVersion": version_match.group(1), "electronZipSha256": actual_hash, "officialElectronSha256Verified": True, "asarSha256": sha256(asar), "helperCount": len(helpers)})
    return links, info


def sign_stage(stage: Path, rcodesign: Path, log_dir: Path) -> list[dict]:
    log_dir.mkdir(parents=True, exist_ok=True)
    null_config = log_dir / "empty.toml"
    null_config.write_text("# Explicit empty config: never load personal signing identities.\n", "utf-8")
    app = stage / "MK Figure.app"
    signer_env = {key: value for key, value in os.environ.items() if not key.startswith("RCODESIGN_")}
    results = []
    # Intel Electron prebuilts have unsigned frameworks, unlike arm64. Sign
    # those actual version directories first, including their dylibs/helpers.
    # Official Codex executables already carry signatures and stay byte-identical.
    for framework in sorted((app / "Contents/Frameworks").glob("*.framework")):
        version = framework / "Versions/A"
        framework_info = version / "Resources/Info.plist"
        executable = version / plistlib.loads(framework_info.read_bytes())["CFBundleExecutable"]
        with executable.open("rb") as stream:
            header = stream.read(65536)
        cursor = 32; signed = False
        for _ in range(struct.unpack_from("<I", header, 16)[0]):
            command, size = struct.unpack_from("<II", header, cursor)
            if command == 0x1D:
                signed = True
            cursor += size
        if signed:
            continue
        result = subprocess.run([str(rcodesign), "--config-file", str(null_config), "sign", "--timestamp-url", "none", str(version)], capture_output=True, encoding="utf-8", errors="replace", env=signer_env)
        log_path = log_dir / f"framework-{framework.stem}.log"
        log_path.write_text(result.stdout + result.stderr, "utf-8")
        if result.returncode:
            raise RuntimeError(f"Framework ad-hoc signing failed: {log_path}")
        verified = verify_code_directory(executable, framework_info, version / "_CodeSignature/CodeResources")
        results.append({"entity": str(version), "signing": "local ad-hoc", "certificate": None, "notarized": False, "codeDirectoryHashesVerified": verified, "log": str(log_path)})
    entities = sorted((app / "Contents/Frameworks").glob("MK Figure Helper*.app")) + [app]
    for number, entity in enumerate(entities):
        args = [str(rcodesign), "--config-file", str(null_config), "sign", "--shallow", "--timestamp-url", "none", str(entity)]
        result = subprocess.run(args, capture_output=True, encoding="utf-8", errors="replace", env=signer_env)
        log_path = log_dir / f"{number:02d}-{entity.stem}.log"
        log_path.write_text(result.stdout + result.stderr, "utf-8")
        if result.returncode:
            raise RuntimeError(f"Local ad-hoc signing failed: {log_path}\n{result.stderr[-3000:]}")
        executable = entity / "Contents/MacOS" / entity.stem
        verification = subprocess.run([str(rcodesign), "--config-file", str(null_config), "verify", str(executable)], capture_output=True, encoding="utf-8", errors="replace", env=signer_env)
        verify_log = log_dir / f"{number:02d}-{entity.stem}-verify.log"
        verify_log.write_text(verification.stdout + verification.stderr, "utf-8")
        # rcodesign 0.29 verify reports its documented empty-CMS false positive
        # for ad-hoc signatures. Verify every CodeDirectory page/special hash
        # independently; this is not a substitute for macOS codesign/Gatekeeper.
        verified = verify_code_directory(executable, entity / "Contents/Info.plist", entity / "Contents/_CodeSignature/CodeResources")
        if verification.returncode and "CMS error: missing further values" not in verification.stdout + verification.stderr:
            raise RuntimeError(f"Unexpected signature verification failure: {verify_log}")
        results.append({"entity": str(entity), "signing": "local ad-hoc", "certificate": None, "notarized": False, "codeDirectoryHashesVerified": verified, "rcodesignVerifyKnownEmptyCmsIssue": verification.returncode != 0, "log": str(log_path)})
    # rcodesign can reserialize an upstream CodeDirectory before computing a
    # nested cdhash. A directory hash must cover the exact embedded bytes.
    # Repair any such reference and re-sign only the outer executable with the
    # corrected resource envelope (framework binary bytes remain unchanged).
    resource_path = app / "Contents/_CodeSignature/CodeResources"
    envelope = plistlib.loads(resource_path.read_bytes())
    repaired = []
    for relative, record in envelope["files2"].items():
        if "cdhash" not in record:
            continue
        nested = app / "Contents" / relative
        if relative.endswith(".app"):
            nested_info = plistlib.loads((nested / "Contents/Info.plist").read_bytes())
            binary = nested / "Contents/MacOS" / nested_info["CFBundleExecutable"]
        elif relative.endswith(".framework"):
            nested_info = plistlib.loads((nested / "Resources/Info.plist").read_bytes())
            binary = nested / nested_info["CFBundleExecutable"]
        else:
            binary = nested
        actual = code_directory_hash(binary.read_bytes())
        if record["cdhash"] != actual:
            repaired.append({"path": relative, "previous": record["cdhash"].hex(), "actual": actual.hex()})
            record["cdhash"] = actual
    if repaired:
        resource_path.write_bytes(plistlib.dumps(envelope))
        bundle_id = plistlib.loads((app / "Contents/Info.plist").read_bytes())["CFBundleIdentifier"]
        result = subprocess.run([str(rcodesign), "--config-file", str(null_config), "sign", "--timestamp-url", "none",
                                 "--binary-identifier", bundle_id, "--info-plist-file", "Contents/Info.plist",
                                 "--code-resources-file", "Contents/_CodeSignature/CodeResources", "Contents/MacOS/MK Figure"],
                                cwd=app, capture_output=True, encoding="utf-8", errors="replace", env=signer_env)
        (log_dir / "outer-envelope-repair.log").write_text(result.stdout + result.stderr, "utf-8")
        if result.returncode:
            raise RuntimeError("Re-signing corrected outer bundle failed")
        results[-1]["codeDirectoryHashesVerified"] = verify_code_directory(app / "Contents/MacOS/MK Figure", app / "Contents/Info.plist", resource_path)
        results[-1]["nestedCodeHashReferencesRepaired"] = repaired
    return results


def verify_code_directory(executable: Path, info_path: Path, resources_path: Path) -> dict:
    data = executable.read_bytes()
    if data[:4] != b"\xcf\xfa\xed\xfe":
        raise ValueError("Expected thin little-endian 64-bit Mach-O")
    commands = struct.unpack_from("<I", data, 16)[0]
    cursor = 32
    signature = None
    for _ in range(commands):
        command, size = struct.unpack_from("<II", data, cursor)
        if command == 0x1D:
            offset, length = struct.unpack_from("<II", data, cursor + 8)
            signature = data[offset:offset + length]
            break
        cursor += size
    if signature is None or struct.unpack_from(">I", signature, 0)[0] != 0xFADE0CC0:
        raise ValueError("Mach-O code signature missing")
    count = struct.unpack_from(">I", signature, 8)[0]
    blobs = {}
    for index in range(count):
        slot, offset = struct.unpack_from(">II", signature, 12 + index * 8)
        length = struct.unpack_from(">I", signature, offset + 4)[0]
        blobs[slot] = signature[offset:offset + length]
    directory = blobs[0]
    _, _, version, flags, hash_offset, _, special_count, code_count, code_limit = struct.unpack_from(">9I", directory, 0)
    hash_size, hash_type, _, page_exp = struct.unpack_from(">4B", directory, 36)
    if not flags & 2:
        raise ValueError("Expected ad-hoc signature, no developer identity")
    if hash_type != 2 or hash_size != 32:
        raise ValueError("Expected SHA256 CodeDirectory")
    page_size = (1 << page_exp) if page_exp else code_limit
    for index in range(code_count):
        expected = directory[hash_offset + index * hash_size:hash_offset + (index + 1) * hash_size]
        actual = hashlib.sha256(data[index * page_size:min((index + 1) * page_size, code_limit)]).digest()
        if actual != expected:
            raise ValueError(f"CodeDirectory code page digest mismatch: {executable} page {index}")
    special_inputs = {1: info_path.read_bytes(), 3: resources_path.read_bytes()}
    if 2 in blobs:
        special_inputs[2] = blobs[2]
    for slot, value in special_inputs.items():
        if slot > special_count:
            raise ValueError("CodeDirectory missing required special slot")
        expected = directory[hash_offset - slot * hash_size:hash_offset - (slot - 1) * hash_size]
        if hashlib.sha256(value).digest() != expected:
            raise ValueError(f"CodeDirectory special digest mismatch: {executable} slot {slot}")
    return {"flags": flags, "adHoc": True, "hash": "SHA256", "codePages": code_count, "infoPlist": True, "codeResources": True, "requirements": 2 in blobs}


def code_directory_hash(data: bytes) -> bytes:
    if data[:4] != b"\xcf\xfa\xed\xfe":
        raise AssertionError("Expected thin Mach-O for nested signature")
    cursor = 32
    for _ in range(struct.unpack_from("<I", data, 16)[0]):
        command, size = struct.unpack_from("<II", data, cursor)
        if command == 0x1D:
            offset, _ = struct.unpack_from("<II", data, cursor + 8)
            count = struct.unpack_from(">I", data, offset + 8)[0]
            for index in range(count):
                slot, position = struct.unpack_from(">II", data, offset + 12 + index * 8)
                if slot == 0:
                    start = offset + position
                    length = struct.unpack_from(">I", data, start + 4)[0]
                    directory = data[start:start + length]
                    algorithm = "sha1" if directory[37] == 1 else "sha256"
                    return hashlib.new(algorithm, directory).digest()[:20]
            raise AssertionError("Missing primary CodeDirectory")
        cursor += size
    raise AssertionError("Missing code signature for nested entity")


def zip_stage(stage: Path, destination: Path, links: dict[str, str]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as target:
        for current, dirs, files in os.walk(stage):
            parent = Path(current)
            dirs[:] = [name for name in dirs if (parent / name).relative_to(stage).as_posix() not in links]
            for filename in files:
                path = parent / filename
                relative = path.relative_to(stage).as_posix()
                if relative in links:
                    continue
                with path.open("rb") as stream:
                    is_macho = bool(architecture(stream.read(512)))
                entry = zipfile.ZipInfo(relative)
                entry.create_system = 3
                entry.external_attr = (stat.S_IFREG | (0o755 if is_macho else 0o644)) << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                with path.open("rb") as stream, target.open(entry, "w", force_zip64=True) as output:
                    shutil.copyfileobj(stream, output)
            # Explicit directory records carry POSIX traversal permissions on every level.
            relative_dir = parent.relative_to(stage).as_posix()
            if relative_dir != ".":
                entry = zipfile.ZipInfo(relative_dir + "/")
                entry.create_system = 3
                entry.external_attr = ((stat.S_IFDIR | 0o755) << 16) | 0x10
                target.writestr(entry, b"")
        for name, target_name in sorted(links.items()):
            entry = zipfile.ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            target.writestr(entry, target_name.encode("utf-8"))


def validate_archive(path: Path, arch: str, metadata: dict) -> dict:
    prefix = "MK Figure.app/Contents/"
    expected = CPU_TYPES[arch]
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        if len(names) != len(archive.namelist()):
            raise AssertionError("Duplicate ZIP entries")
        info = plistlib.loads(archive.read(prefix + "Info.plist"))
        if info["CFBundleExecutable"] != "MK Figure" or info["CFBundleIdentifier"] != "art.mkfigure.studio":
            raise AssertionError("Incorrect bundle metadata")
        if info["CFBundleVersion"] != metadata["appVersion"] or info["CFBundleShortVersionString"] != metadata["appVersion"]:
            raise AssertionError("Application version mismatch")
        if info["LSMinimumSystemVersion"] != metadata["minimumMacOS"]:
            raise AssertionError("Minimum macOS version differs from the official Electron runtime")
        if info["ElectronAsarIntegrity"]["Resources/app.asar"] != {"algorithm": "SHA256", "hash": metadata["headerHash"]}:
            raise AssertionError("Electron ASAR header integrity mismatch")
        if hashlib.sha256(archive.read(prefix + "Resources/app.asar")).hexdigest() != metadata["asarSha256"]:
            raise AssertionError("app.asar payload mismatch")
        for resource in ["skill/SKILL.md", "library/provenance.md", "icon.icns", "THIRD_PARTY_NOTICES.md", "LICENSE.electron.txt", "LICENSES.chromium.html", "font-licenses/inter-OFL.txt", "font-licenses/noto-serif-sc-OFL.txt", "font-licenses/source-serif-4-OFL.txt"]:
            if not archive.read(prefix + "Resources/" + resource):
                raise AssertionError("Required application resource is empty: " + resource)
        library = validate_library(lambda relative: archive.read(prefix + "Resources/" + relative))
        if prefix + "Resources/default_app.asar" in names:
            raise AssertionError("Electron default application unexpectedly included")
        manifest = json.loads(archive.read(prefix + "Resources/codex/manifest.json"))
        if manifest["target"] != f"mac-{arch}":
            raise AssertionError("Codex architecture manifest mismatch")
        runtime_checked = []
        for item in manifest["files"]:
            data = archive.read(prefix + "Resources/codex/" + item["path"])
            if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise AssertionError("Official runtime modified: " + item["path"])
        for item in manifest["licenses"]:
            if hashlib.sha256(archive.read(prefix + "Resources/codex/" + item["name"])).hexdigest() != item["sha256"]:
                raise AssertionError("Bundled Codex license hash mismatch: " + item["name"])
        for executable in manifest["executables"]:
            entry = archive.getinfo(prefix + "Resources/codex/" + executable)
            if stat.S_IMODE(entry.external_attr >> 16) != 0o755:
                raise AssertionError("Codex executable mode missing: " + executable)
            if expected not in architecture(archive.read(entry)[:512]):
                raise AssertionError("Codex executable architecture mismatch: " + executable)
            runtime_checked.append(executable)
        link_map = {item.filename: archive.read(item).decode("utf-8") for item in archive.infolist() if stat.S_ISLNK(item.external_attr >> 16)}
        def resolve_link(name: str, seen: int = 0) -> str:
            if seen > 32:
                raise AssertionError("Symlink cycle")
            parts = name.split("/")
            for length in range(1, len(parts) + 1):
                prefix = "/".join(parts[:length])
                if prefix in link_map:
                    target_name = posixpath.normpath(posixpath.join(posixpath.dirname(prefix), link_map[prefix]))
                    return resolve_link(posixpath.join(target_name, *parts[length:]), seen + 1)
            return name
        symlinks = []
        macho = []
        for entry in archive.infolist():
            mode = entry.external_attr >> 16
            if not entry.filename.startswith("MK Figure.app/") or ".." in PurePosixPath(entry.filename).parts:
                raise AssertionError("Unsafe application ZIP entry: " + entry.filename)
            if entry.create_system != 3:
                raise AssertionError("Non-Unix ZIP metadata: " + entry.filename)
            if stat.S_ISLNK(mode):
                if stat.S_IMODE(mode) != 0o777:
                    raise AssertionError("Incorrect symlink permissions: " + entry.filename)
                link = archive.read(entry).decode("utf-8")
                normalized = posixpath.normpath(posixpath.join(posixpath.dirname(entry.filename), link))
                if not normalized.startswith("MK Figure.app/"):
                    raise AssertionError("Symlink escapes app bundle")
                resolved = resolve_link(normalized)
                if resolved not in names and resolved + "/" not in names:
                    raise AssertionError("Broken symlink: " + entry.filename)
                symlinks.append({"path": entry.filename, "target": link, "mode": oct(mode)})
            elif entry.is_dir():
                if not stat.S_ISDIR(mode) or stat.S_IMODE(mode) != 0o755:
                    raise AssertionError("Incorrect directory permissions: " + entry.filename)
            elif not entry.is_dir():
                with archive.open(entry) as stream:
                    cpus = architecture(stream.read(512))
                if cpus:
                    if expected not in cpus or stat.S_IMODE(mode) != 0o755:
                        raise AssertionError("Mach-O architecture/mode mismatch: " + entry.filename)
                    macho.append(entry.filename)
                elif not stat.S_ISREG(mode) or stat.S_IMODE(mode) != 0o644:
                    raise AssertionError("Incorrect resource permissions: " + entry.filename)
        envelope = plistlib.loads(archive.read(prefix + "_CodeSignature/CodeResources"))["files2"]
        sealed_files = 0; nested_code = 0
        for relative, record in envelope.items():
            name = prefix + relative
            if "hash2" in record:
                if hashlib.sha256(archive.read(resolve_link(name))).digest() != record["hash2"]:
                    raise AssertionError("Sealed resource hash mismatch: " + relative)
                sealed_files += 1
            if "cdhash" in record:
                if relative.endswith(".app"):
                    bundle_info = plistlib.loads(archive.read(name + "/Contents/Info.plist"))
                    binary_name = name + "/Contents/MacOS/" + bundle_info["CFBundleExecutable"]
                elif relative.endswith(".framework"):
                    bundle_info = plistlib.loads(archive.read(resolve_link(name + "/Resources/Info.plist")))
                    binary_name = resolve_link(name + "/" + bundle_info["CFBundleExecutable"])
                else:
                    binary_name = resolve_link(name)
                if code_directory_hash(archive.read(binary_name)) != record["cdhash"]:
                    raise AssertionError("Nested code signature reference mismatch: " + relative)
                nested_code += 1
        references = sorted(name for name in names if name.startswith(prefix + "Resources/references/") and name.endswith(".png"))
        if len(references) != 3 or len(symlinks) != 14:
            raise AssertionError("Missing bundled references or framework symlinks")
        if archive.testzip() is not None:
            raise AssertionError("ZIP CRC integrity check failed")
    return {"file": str(path), "bytes": path.stat().st_size, "sha256": sha256(path), "architecture": arch,
            "minimumMacOS": info["LSMinimumSystemVersion"], "bundleId": info["CFBundleIdentifier"], "version": info["CFBundleShortVersionString"],
            "asar": metadata, "references": references, "library": library, "frameworkSymlinks": symlinks, "machoExecutables": macho,
            "codexVersion": manifest["version"], "officialCodexHashesPreserved": True, "codexExecutablesChecked": runtime_checked,
            "asarHeaderIntegrityVerified": True, "requiredResourcesVerified": True, "codexLicensesVerified": True,
            "bundleResourceEnvelope": {"sha256FilesChecked": sealed_files, "nestedCodeDirectoryHashesChecked": nested_code},
            "zipCrcPassed": True, "nativeMacExecutionTested": False, "developerIdSigned": False, "notarized": False}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--arch", choices=CPU_TYPES, required=True)
    parser.add_argument("--electron-zip", type=Path, required=True)
    parser.add_argument("--asar", type=Path, required=True)
    parser.add_argument("--rcodesign", type=Path, required=True)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    output = workspace / "release-mac"
    stage = output / "staging" / args.arch
    links, metadata = prepare(workspace, stage, args.electron_zip.resolve(), args.asar.resolve(), args.arch)
    (output / f"{args.arch}-preparation.json").write_text(json.dumps({"symlinks": links, "asar": metadata}, indent=2), "utf-8")
    print(f"Prepared {args.arch}: {len(links)} framework symlinks; app.asar has {metadata['entries']} entries and no native Node modules", flush=True)
    if args.prepare_only:
        return
    signing = sign_stage(stage, args.rcodesign.resolve(), output / "logs" / args.arch)
    print(f"Ad-hoc signed and verified {len(signing)} rebranded app executables; no Developer ID or uploads", flush=True)
    destination = output / f"MK-Figure-{metadata['appVersion']}-macOS-{args.arch}.zip"
    zip_stage(stage, destination, links)
    report = validate_archive(destination, args.arch, metadata)
    report["localAdHocSigning"] = signing
    (output / f"macOS-{args.arch}-validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps({"file": str(destination), "bytes": report["bytes"], "sha256": report["sha256"], "nativeMacExecutionTested": False}), flush=True)


if __name__ == "__main__":
    main()
