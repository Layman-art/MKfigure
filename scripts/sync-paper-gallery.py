"""Materialize the pinned public FigureForge gallery. Requires Python 3.9+ and Git."""

import argparse
import collections
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


REPOSITORY = "https://github.com/qwdwqfwq/topconf-paper-figure-gallery"
REVISION = "b330dadd61612f6281052defe20181737397cd43"
CATALOG = "data/figures.json"
SUPPORT_HASHES = {
    CATALOG: "8949316de6703bc9d20ec8a60d81bb521b2b585c7dafc348fd89b62adfa062fb",
    "assets/figures.js": "1be7068180c4d29d4af65490baffc761b10dc357ed09c2c2ed6c75a5954bc941",
    "LICENSE": "2350e38b3b77e35d200cc3424c6fded8d282bb5ba3f3b0b440730f8780020e0c",
    "NOTICE.md": "467dd08d7f9cb851f46c22f999b06ddb45ea16c0a89e5b7197ec01507b497ea8",
    "IMAGES_POLICY.md": "135582a3407482b7a7b56dbe82b4dd3a4333536f570e6d5324487c93313a671d",
}
IMAGE_TREE_HASH = "4e25d59f2a196a4e7556f7e99528fa839fa343e316eed2552ddb9e0032044ace"


def git(directory, *args, input_data=None):
    return subprocess.run(
        ["git", "-C", str(directory), *args], check=True, input=input_data,
        stdout=subprocess.PIPE,
    ).stdout


def checkout(directory):
    git(directory, "init", "--quiet")
    git(directory, "remote", "add", "origin", REPOSITORY + ".git")
    git(directory, "config", "remote.origin.promisor", "true")
    git(directory, "config", "remote.origin.partialclonefilter", "blob:none")
    git(directory, "fetch", "--quiet", "--no-tags", "--depth=1", "--filter=blob:none", "origin", REVISION)
    patterns = ["/" + name for name in SUPPORT_HASHES] + ["/images/*/final/"]
    git(directory, "sparse-checkout", "set", "--no-cone", "--stdin",
        input_data=("\n".join(patterns) + "\n").encode())
    git(directory, "checkout", "--quiet", "--detach", REVISION)


def write_file(path, content):
    if path.is_file() and path.read_bytes() == content:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        name = stream.name
        try:
            stream.write(content)
        except BaseException:
            stream.close()
            os.unlink(name)
            raise
    try:
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def sync(source, dest, verify):
    def output(relative, content):
        path = dest / relative
        if verify:
            if not path.is_file() or path.read_bytes() != content:
                raise ValueError(f"Content differs: {path}")
        else:
            write_file(path, content)

    objects = {}
    if not verify:
        listing = git(source, "ls-tree", "-r", "-z", REVISION, "images")
        for entry in listing.split(b"\0"):
            if entry:
                meta, path = entry.split(b"\t", 1)
                objects[path.decode()] = meta.split()[2].decode()
    support = {}
    for name, expected in SUPPORT_HASHES.items():
        content = (dest / name).read_bytes() if verify else git(source, "show", f"{REVISION}:{name}")
        if hashlib.sha256(content).hexdigest() != expected:
            raise ValueError(f"Source checksum mismatch: {name}")
        support[name] = content
    rows = json.loads(support[CATALOG])
    identifiers = {row["id"] for row in rows}
    paths = {row["image"] for row in rows}
    if len(rows) != 3449 or len(rows) != len(identifiers) or len(rows) != len(paths):
        raise ValueError("Unexpected row count, duplicate IDs, or duplicate image paths")
    js = support["assets/figures.js"].decode("utf-8").strip()
    if json.loads(js.removeprefix("window.FIGURES = ").removesuffix(";")) != rows:
        raise ValueError("Browser and JSON catalogs disagree")
    for row in rows:
        if row["image"] != f"images/{row['venue']}/final/{row['id']}.jpg":
            raise ValueError(f"Unexpected path for {row['id']}")
        if not row["authors"] or not row["paper"] or not row["pdf_source"]:
            raise ValueError(f"Missing attribution on {row['id']}")

    digest = hashlib.sha256()
    image_hashes = {}
    total_bytes = 0
    for relative in sorted(paths):
        # A sparse checkout of the source is needed only for materializing image data.
        path = (dest if verify else source) / relative
        content = path.read_bytes()
        if not verify:
            blob_hash = hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest()
            if blob_hash != objects[relative]:
                raise ValueError(f"Image does not match the upstream Git object: {relative}")
        if not content.startswith(b"\xff\xd8\xff"):
            raise ValueError(f"Invalid JPEG signature: {relative}")
        picture_hash = hashlib.sha256(content)
        digest.update(relative.encode() + b"\0" + picture_hash.digest())
        image_hashes[Path(relative).stem] = picture_hash.hexdigest()
        total_bytes += len(content)
        if not verify:
            output(relative, content)

    if digest.hexdigest() != IMAGE_TREE_HASH:
        raise ValueError("Image data differs from the pinned upstream snapshot")
    output("data/image-hashes.json", (json.dumps(image_hashes, sort_keys=True, separators=(",", ":")) + "\n").encode())
    if not verify:
        for name, content in support.items():
            output(name, content)
    manifest = {
        "project": "Top-Conf Figure Gallery",
        "repository": REPOSITORY,
        "revision": REVISION,
        "homepage": "https://qwdwqfwq.github.io/topconf-paper-figure-gallery/",
        "catalog": CATALOG,
        "offlineBrowserCatalog": "assets/figures.js",
        "upstreamCatalog": f"{REPOSITORY}/blob/{REVISION}/{CATALOG}",
        "catalogSha256": hashlib.sha256(support[CATALOG]).hexdigest(),
        "figures": len(rows),
        "jpegBytes": total_bytes,
        "imageTreeSha256": digest.hexdigest(),
        "imageTreeHashMethod": "SHA-256 of the concatenation of each UTF-8 path, NUL, and raw SHA-256 digest, sorted by path.",
        "byVenue": dict(sorted(collections.Counter(row["venue"] for row in rows).items())),
        "byYear": dict(sorted(collections.Counter(row["year"] for row in rows).items())),
        "byPattern": dict(sorted(collections.Counter(row["pattern"] for row in rows).items())),
        "rights": {
            "codeLicense": "LICENSE",
            "attributionNotice": "NOTICE.md",
            "figureRightsPolicy": "IMAGES_POLICY.md",
            "figureRights": "Paper images retain their original rights. Follow the terms of the cited paper and its rights holders.",
            "attributionFields": ["title", "authors", "venue", "year", "paper", "pdf_source"],
        },
    }
    output("upstream.json", (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode())
    print(f"{len(rows):,} attributed records, {len(paths):,} verified JPEGs, {total_bytes:,} bytes.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="Directory for the self-contained gallery data.")
    parser.add_argument("--source", type=Path, help="Use an existing pinned Git checkout with gallery images.")
    parser.add_argument("--verify", action="store_true", help="Verify the destination without changing it.")
    args = parser.parse_args()
    if args.verify:
        sync(None, args.destination.resolve(), True)
        raise SystemExit(0)
    if (args.destination / "upstream.json").is_file():
        try:
            sync(None, args.destination.resolve(), True)
        except (FileNotFoundError, ValueError):
            pass
        else:
            print("The complete snapshot is already available offline.")
            raise SystemExit(0)
    if args.source:
        sync(args.source.resolve(), args.destination.resolve(), args.verify)
    else:
        with tempfile.TemporaryDirectory(prefix="topconf-gallery-") as tmp:
            checkout(Path(tmp))
            sync(Path(tmp), args.destination.resolve(), args.verify)
