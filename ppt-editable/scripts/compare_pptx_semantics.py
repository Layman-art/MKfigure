#!/usr/bin/env python3
"""Compare two PPTX packages without modifying either input.

The comparison is intentionally strict about editable slide structure while
ignoring relationship IDs, creation IDs, and document timestamps.  It is aimed
at localized PowerPoint repairs where a small allow-list should explain every
intentional change.

Exit codes:
  0  comparison completed (and, with --fail-unexpected, no unexpected changes)
  1  unexpected changes were found with --fail-unexpected
  2  invalid arguments or an unreadable/invalid PPTX
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import re
import sys
import zipfile
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from xml.etree import ElementTree as ET


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
}
Q = {prefix: f"{{{uri}}}" for prefix, uri in NS.items()}

OBJECT_TAGS = {
    Q["p"] + "sp": "shape",
    Q["p"] + "pic": "picture",
    Q["p"] + "graphicFrame": "graphic_frame",
    Q["p"] + "grpSp": "group",
    Q["p"] + "cxnSp": "connector",
}
NV_PATHS = {
    "shape": "p:nvSpPr/p:cNvPr",
    "picture": "p:nvPicPr/p:cNvPr",
    "graphic_frame": "p:nvGraphicFramePr/p:cNvPr",
    "group": "p:nvGrpSpPr/p:cNvPr",
    "connector": "p:nvCxnSpPr/p:cNvPr",
}
PH_PATHS = {
    "shape": "p:nvSpPr/p:nvPr/p:ph",
    "picture": "p:nvPicPr/p:nvPr/p:ph",
    "graphic_frame": "p:nvGraphicFramePr/p:nvPr/p:ph",
    "group": "p:nvGrpSpPr/p:nvPr/p:ph",
    "connector": "p:nvCxnSpPr/p:nvPr/p:ph",
}
XFRM_PATHS = {
    "shape": "p:spPr/a:xfrm",
    "picture": "p:spPr/a:xfrm",
    "graphic_frame": "p:xfrm",
    "group": "p:grpSpPr/a:xfrm",
    "connector": "p:spPr/a:xfrm",
}

TIMESTAMP_NAMES = {
    "created",
    "modified",
    "lastprinted",
    "datecreated",
    "datemodified",
}

OFFICE_CREATION_NAMESPACE_FRAGMENTS = (
    "schemas.microsoft.com/office/powerpoint/",
    "schemas.microsoft.com/office/drawing/",
)

UNSUPPORTED_SEMANTICS = [
    (
        "Animation and transition timing are not decoded into object-level "
        "semantics. Their normalized XML parts are still compared, so such a "
        "change is reported as an unexplained XML-part change."
    ),
    (
        "Charts, SmartArt, embedded workbooks/OLE objects, macros, and custom "
        "XML are compared only by package parts, relationship targets, and/or "
        "content hashes; their application-level semantics are not decoded."
    ),
    (
        "Theme inheritance, rendered font substitution, effects, and visual "
        "pixel equivalence require the separate structural and render QA gates."
    ),
]


class CompareInputError(Exception):
    """Raised for malformed inputs or selectors."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def local_name(value: str) -> str:
    return value.rsplit("}", 1)[-1] if "}" in value else value


def namespace_uri(value: str) -> str:
    return value[1:].split("}", 1)[0] if value.startswith("{") and "}" in value else ""


def is_office_creation_id(value: str, owner_tag: str | None = None) -> bool:
    if local_name(value).lower() != "creationid":
        return False
    namespaces = [namespace_uri(value)]
    if owner_tag is not None:
        namespaces.append(namespace_uri(owner_tag))
    return any(
        namespace == NS["p"]
        or any(fragment in namespace for fragment in OFFICE_CREATION_NAMESPACE_FRAGMENTS)
        for namespace in namespaces
    )


def natural_key(value: str) -> list[Any]:
    return [int(piece) if piece.isdigit() else piece.lower() for piece in re.split(r"(\d+)", value)]


def relationship_part(source_part: str) -> str:
    if not source_part:
        return "_rels/.rels"
    directory, filename = posixpath.split(source_part)
    return posixpath.join(directory, "_rels", filename + ".rels")


def relationship_source(rels_part: str) -> str:
    if rels_part == "_rels/.rels":
        return ""
    directory, filename = posixpath.split(rels_part)
    if posixpath.basename(directory) != "_rels" or not filename.endswith(".rels"):
        raise CompareInputError(f"Invalid relationship part name: {rels_part}")
    return posixpath.join(posixpath.dirname(directory), filename[:-5])


def resolve_target(source_part: str, target: str, target_mode: str = "") -> str:
    if target_mode.lower() == "external":
        return target
    if target.startswith("/"):
        return posixpath.normpath(target.lstrip("/"))
    return posixpath.normpath(posixpath.join(posixpath.dirname(source_part), target))


def read_xml(archive: zipfile.ZipFile, part: str) -> ET.Element:
    try:
        return ET.fromstring(archive.read(part))
    except KeyError as exc:
        raise CompareInputError(f"Missing required PPTX part: {part}") from exc
    except ET.ParseError as exc:
        raise CompareInputError(f"Invalid XML in {part}: {exc}") from exc


def is_key_part(part: str) -> bool:
    return (
        bool(part)
        and not part.endswith("/")
        and not is_media_part(part)
        and not part.endswith(".rels")
    )


def is_media_part(part: str) -> bool:
    return part.startswith("ppt/media/") and not part.endswith("/")


def is_xml_part(part: str) -> bool:
    return part.endswith(".xml") or part.endswith(".rels") or part == "[Content_Types].xml"


def normalized_text(element: ET.Element | None) -> str:
    if element is None:
        return ""
    return "".join(element.itertext())


def relationship_table(archive: zipfile.ZipFile, source_part: str) -> dict[str, dict[str, str]]:
    rels_name = relationship_part(source_part)
    if rels_name not in archive.namelist():
        return {}
    root = read_xml(archive, rels_name)
    result: dict[str, dict[str, str]] = {}
    for rel in root.findall("pr:Relationship", NS):
        rel_id = rel.get("Id", "")
        if not rel_id:
            raise CompareInputError(f"Relationship without Id in {rels_name}")
        if rel_id in result:
            raise CompareInputError(f"Duplicate relationship Id {rel_id!r} in {rels_name}")
        mode = rel.get("TargetMode", "")
        raw_target = rel.get("Target", "")
        result[rel_id] = {
            "type": rel.get("Type", ""),
            "target": resolve_target(source_part, raw_target, mode),
            "target_mode": mode,
        }
    return result


def stable_relationship_token(rel: dict[str, str]) -> str:
    payload = json.dumps(rel, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "REL:" + hashlib.sha256(payload.encode("utf-8")).hexdigest().upper()[:20]


def canonical_xml_node(
    element: ET.Element,
    rel_tokens: dict[str, str],
    omit_slide_objects: bool = False,
    ignore_document_timestamps: bool = False,
) -> Any | None:
    name = local_name(element.tag).lower()
    if omit_slide_objects and element.tag in OBJECT_TAGS:
        return None
    if is_office_creation_id(element.tag) or (
        ignore_document_timestamps and name in TIMESTAMP_NAMES
    ):
        return None

    attributes: list[tuple[str, str]] = []
    for key, value in element.attrib.items():
        attr_name = local_name(key).lower()
        if is_office_creation_id(key, element.tag) or (
            ignore_document_timestamps and attr_name in TIMESTAMP_NAMES
        ):
            continue
        if value in rel_tokens:
            value = rel_tokens[value]
        attributes.append((key, value))
    attributes.sort()

    text = element.text or ""
    if not text.strip():
        text = ""

    original_children = list(element)
    children = []
    for child in original_children:
        normalized = canonical_xml_node(
            child,
            rel_tokens,
            omit_slide_objects,
            ignore_document_timestamps,
        )
        if normalized is not None:
            children.append(normalized)
    if (
        name in {"ext", "extlst"}
        and any(
            is_office_creation_id(descendant.tag)
            for descendant in element.iter()
        )
        and not children
        and not text
    ):
        return None
    return [element.tag, attributes, text, children]


def normalized_xml_hash(archive: zipfile.ZipFile, part: str) -> str:
    if part.endswith(".rels"):
        source = relationship_source(part)
        rows = sorted(
            relationship_table(archive, source).values(),
            key=lambda row: (row["type"], row["target"], row["target_mode"]),
        )
        payload = rows
    else:
        root = read_xml(archive, part)
        rels = relationship_table(archive, part)
        tokens = {rel_id: stable_relationship_token(row) for rel_id, row in rels.items()}
        payload = canonical_xml_node(
            root,
            tokens,
            ignore_document_timestamps=(part == "docProps/core.xml"),
        )
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256_bytes(raw.encode("utf-8"))


def normalized_slide_residual_hash(archive: zipfile.ZipFile, part: str) -> str:
    """Hash non-object slide markup, including transitions and timing trees."""
    root = read_xml(archive, part)
    rels = relationship_table(archive, part)
    tokens = {rel_id: stable_relationship_token(row) for rel_id, row in rels.items()}
    payload = canonical_xml_node(root, tokens, omit_slide_objects=True)
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256_bytes(raw.encode("utf-8"))


def slide_order(archive: zipfile.ZipFile) -> list[str]:
    root = read_xml(archive, "ppt/presentation.xml")
    if root.tag != Q["p"] + "presentation":
        raise CompareInputError("ppt/presentation.xml does not contain p:presentation")
    rels = relationship_table(archive, "ppt/presentation.xml")
    result: list[str] = []
    declared = root.findall("p:sldIdLst/p:sldId", NS)
    seen_targets: set[str] = set()
    for index, slide_id in enumerate(declared, start=1):
        rel_id = slide_id.get(Q["r"] + "id", "")
        if not rel_id:
            raise CompareInputError(f"Slide declaration {index} has no r:id")
        row = rels.get(rel_id)
        if row is None:
            raise CompareInputError(
                f"Slide declaration {index} references missing relationship {rel_id!r}"
            )
        if row["target_mode"].lower() == "external":
            raise CompareInputError(f"Slide relationship {rel_id!r} is external")
        if not row["type"].endswith("/slide"):
            raise CompareInputError(f"Relationship {rel_id!r} is not a slide relationship")
        target = row["target"]
        if target not in archive.namelist():
            raise CompareInputError(
                f"Slide relationship {rel_id!r} targets missing part {target!r}"
            )
        if target in seen_targets:
            raise CompareInputError(f"Duplicate declared slide target {target!r}")
        if read_xml(archive, target).tag != Q["p"] + "sld":
            raise CompareInputError(
                f"Slide relationship {rel_id!r} targets a non-slide XML part {target!r}"
            )
        seen_targets.add(target)
        result.append(target)

    loose_slides = {
        name
        for name in archive.namelist()
        if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
    }
    orphaned = sorted(loose_slides - seen_targets, key=natural_key)
    if orphaned:
        raise CompareInputError(f"Undeclared slide part(s): {', '.join(orphaned)}")
    return result


def canvas(archive: zipfile.ZipFile) -> dict[str, int | None]:
    root = read_xml(archive, "ppt/presentation.xml")
    size = root.find("p:sldSz", NS)
    if size is None:
        return {"width_emu": None, "height_emu": None}
    return {
        "width_emu": int(size.get("cx", "0")),
        "height_emu": int(size.get("cy", "0")),
    }


def geometry(element: ET.Element, object_type: str) -> dict[str, Any] | None:
    xfrm = element.find(XFRM_PATHS[object_type], NS)
    if xfrm is None:
        return None
    result: dict[str, Any] = {}
    for key in ("rot", "flipH", "flipV"):
        if key in xfrm.attrib:
            result[key] = xfrm.get(key)
    for child_name in ("off", "ext", "chOff", "chExt"):
        child = xfrm.find(f"a:{child_name}", NS)
        if child is not None:
            result[child_name] = {key: int(value) for key, value in sorted(child.attrib.items())}
    return result


def object_text(element: ET.Element, object_type: str) -> list[str]:
    if object_type == "group":
        return []
    if object_type in {"shape", "connector"}:
        body = element.find("p:txBody", NS)
        if body is None:
            return []
        return ["".join(paragraph.itertext()) for paragraph in body.findall("a:p", NS)]
    if object_type == "graphic_frame":
        return ["".join(paragraph.itertext()) for paragraph in element.findall(".//a:p", NS)]
    return []


def picture_fill(element: ET.Element, object_type: str) -> bool:
    if object_type in {"shape", "connector"}:
        return element.find("p:spPr/a:blipFill", NS) is not None
    if object_type == "picture":
        return element.find("p:blipFill", NS) is not None
    return False


def object_relationships(
    archive: zipfile.ZipFile,
    element: ET.Element,
    rels: dict[str, dict[str, str]],
) -> list[dict[str, Any]]:
    seen: set[tuple[str, str, str, str]] = set()
    result: list[dict[str, Any]] = []
    for node in element.iter():
        for attr, value in node.attrib.items():
            if not (attr.startswith(Q["r"]) or value in rels):
                continue
            row = rels.get(value)
            if row is None:
                continue
            role = local_name(attr)
            key = (role, row["type"], row["target"], row["target_mode"])
            if key in seen:
                continue
            seen.add(key)
            item: dict[str, Any] = {
                "role": role,
                "type": row["type"],
                "target": row["target"],
                "target_mode": row["target_mode"],
            }
            if is_media_part(row["target"]) and row["target"] in archive.namelist():
                item["media_sha256"] = sha256_bytes(archive.read(row["target"]))
            result.append(item)
    return sorted(result, key=lambda row: json.dumps(row, sort_keys=True))


def object_record(
    archive: zipfile.ZipFile,
    element: ET.Element,
    object_type: str,
    slide_number: int,
    z_path: tuple[int, ...],
    group_path: list[dict[str, Any]],
    rels: dict[str, dict[str, str]],
) -> dict[str, Any]:
    nv = element.find(NV_PATHS[object_type], NS)
    placeholder = element.find(PH_PATHS[object_type], NS)
    name = nv.get("name", "") if nv is not None else ""
    object_id = nv.get("id", "") if nv is not None else ""
    rel_tokens = {rel_id: stable_relationship_token(row) for rel_id, row in rels.items()}
    if object_type == "group":
        normalized_object = [
            canonical_xml_node(child, rel_tokens)
            for child in list(element)
            if child.tag not in OBJECT_TAGS
        ]
    else:
        normalized_object = canonical_xml_node(element, rel_tokens)
    normalized_object_hash = sha256_bytes(
        json.dumps(
            normalized_object,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )
    return {
        "slide": slide_number,
        "z_path": list(z_path),
        "type": object_type,
        "id": object_id,
        "name": name,
        "text": object_text(element, object_type),
        "geometry": geometry(element, object_type),
        "group_path": group_path,
        "placeholder": dict(sorted(placeholder.attrib.items())) if placeholder is not None else None,
        "picture_fill": picture_fill(element, object_type),
        "relationships": object_relationships(archive, element, rels) if object_type != "group" else [],
        "normalized_xml_sha256": normalized_object_hash,
    }


def slide_objects(archive: zipfile.ZipFile, part: str, slide_number: int) -> list[dict[str, Any]]:
    root = read_xml(archive, part)
    tree = root.find("p:cSld/p:spTree", NS)
    if tree is None:
        return []
    rels = relationship_table(archive, part)
    result: list[dict[str, Any]] = []

    def visit(container: ET.Element, prefix: tuple[int, ...], parents: list[dict[str, Any]]) -> None:
        children = [child for child in list(container) if child.tag in OBJECT_TAGS]
        for position, child in enumerate(children, start=1):
            object_type = OBJECT_TAGS[child.tag]
            z_path = prefix + (position,)
            record = object_record(
                archive,
                child,
                object_type,
                slide_number,
                z_path,
                parents,
                rels,
            )
            result.append(record)
            if object_type == "group":
                next_parent = parents + [
                    {"id": record["id"], "name": record["name"], "z_path": record["z_path"]}
                ]
                visit(child, z_path, next_parent)

    visit(tree, (), [])
    return result


@dataclass(frozen=True)
class Selector:
    raw: str
    slide: int | None = None
    name: str | None = None
    regex: re.Pattern[str] | None = None

    def matches(self, slide: int, name: str) -> bool:
        combined = f"{slide}:{name}"
        if self.regex is not None:
            return self.regex.search(combined) is not None
        return self.slide == slide and self.name == name


def parse_object_selector(raw: str) -> Selector:
    if raw.startswith("re:"):
        try:
            return Selector(raw=raw, regex=re.compile(raw[3:]))
        except re.error as exc:
            raise CompareInputError(f"Invalid --allow-object regex {raw!r}: {exc}") from exc
    slide_text, separator, name = raw.partition(":")
    if not separator or not slide_text.isdigit() or not name:
        raise CompareInputError(
            f"Invalid --allow-object {raw!r}; use SLIDE:NAME or re:PYTHON_REGEX"
        )
    return Selector(raw=raw, slide=int(slide_text), name=name)


@dataclass(frozen=True)
class MediaSelector:
    raw: str
    regex: re.Pattern[str] | None = None

    def matches(self, values: Iterable[str]) -> bool:
        for value in values:
            if self.regex is not None:
                if self.regex.search(value):
                    return True
            elif value == self.raw or posixpath.basename(value) == self.raw:
                return True
        return False


def parse_media_selector(raw: str) -> MediaSelector:
    if raw.startswith("re:"):
        try:
            return MediaSelector(raw=raw, regex=re.compile(raw[3:]))
        except re.error as exc:
            raise CompareInputError(f"Invalid --allow-media regex {raw!r}: {exc}") from exc
    if not raw:
        raise CompareInputError("--allow-media cannot be empty")
    return MediaSelector(raw=raw)


def allowed_object(change: dict[str, Any], selectors: list[Selector]) -> bool:
    candidates = [item for item in (change.get("baseline"), change.get("revised")) if item]
    return any(selector.matches(item["slide"], item["name"]) for selector in selectors for item in candidates)


def allowed_media(change: dict[str, Any], selectors: list[MediaSelector]) -> bool:
    values = [
        str(change[key])
        for key in ("part", "baseline_sha256", "revised_sha256")
        if isinstance(change.get(key), str)
    ]
    return any(selector.matches(values) for selector in selectors)


def changed_fields(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    return sorted(key for key in set(before) | set(after) if before.get(key) != after.get(key))


def compare_object_lists(
    baseline: list[dict[str, Any]],
    revised: list[dict[str, Any]],
    selectors: list[Selector],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    old_remaining = set(range(len(baseline)))
    new_remaining = set(range(len(revised)))
    pairs: list[tuple[int, int]] = []

    def pair_unique(key_fn: Any) -> None:
        old_keys: dict[Any, list[int]] = {}
        new_keys: dict[Any, list[int]] = {}
        for index in old_remaining:
            key = key_fn(baseline[index])
            if key is not None:
                old_keys.setdefault(key, []).append(index)
        for index in new_remaining:
            key = key_fn(revised[index])
            if key is not None:
                new_keys.setdefault(key, []).append(index)
        for key in set(old_keys) & set(new_keys):
            if len(old_keys[key]) == 1 and len(new_keys[key]) == 1:
                old_index = old_keys[key][0]
                new_index = new_keys[key][0]
                pairs.append((old_index, new_index))
                old_remaining.remove(old_index)
                new_remaining.remove(new_index)

    # Slide-local OOXML object IDs are the strongest identity available.  A
    # unique type/name/group-path fallback avoids z-order cascade mismatches
    # when an editor regenerates IDs but preserves semantic object names.
    pair_unique(lambda item: (item["type"], item["id"]) if item["id"] else None)
    pair_unique(
        lambda item: (
            item["type"],
            item["name"],
            tuple(parent["name"] for parent in item["group_path"]),
        )
        if item["name"]
        else None
    )

    allowed: list[dict[str, Any]] = []
    unexpected: list[dict[str, Any]] = []
    comparisons: list[tuple[dict[str, Any] | None, dict[str, Any] | None]] = [
        (baseline[old_index], revised[new_index]) for old_index, new_index in pairs
    ]
    comparisons.extend((baseline[index], None) for index in old_remaining)
    comparisons.extend((None, revised[index]) for index in new_remaining)
    comparisons.sort(
        key=lambda pair: tuple((pair[0] or pair[1] or {}).get("z_path", []))
        + (0 if pair[0] is not None else 1,)
    )
    for before, after in comparisons:
        if before == after:
            continue
        if before is None:
            kind = "added"
        elif after is None:
            kind = "removed"
        else:
            kind = "changed"
        change = {
            "kind": kind,
            "slide": (before or after)["slide"],
            "z_path": (after or before)["z_path"],
            "baseline_z_path": before["z_path"] if before else None,
            "revised_z_path": after["z_path"] if after else None,
            "changed_fields": changed_fields(before or {}, after or {}),
            "baseline": before,
            "revised": after,
        }
        (allowed if allowed_object(change, selectors) else unexpected).append(change)
    return allowed, unexpected


def media_changes(
    baseline: zipfile.ZipFile,
    revised: zipfile.ZipFile,
    selectors: list[MediaSelector],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    old_parts = {name for name in baseline.namelist() if is_media_part(name)}
    new_parts = {name for name in revised.namelist() if is_media_part(name)}
    allowed: list[dict[str, Any]] = []
    unexpected: list[dict[str, Any]] = []
    for part in sorted(old_parts | new_parts, key=natural_key):
        old_hash = sha256_bytes(baseline.read(part)) if part in old_parts else None
        new_hash = sha256_bytes(revised.read(part)) if part in new_parts else None
        if old_hash == new_hash:
            continue
        change = {
            "kind": "added" if old_hash is None else "removed" if new_hash is None else "modified",
            "part": part,
            "baseline_sha256": old_hash,
            "revised_sha256": new_hash,
        }
        (allowed if allowed_media(change, selectors) else unexpected).append(change)
    return allowed, unexpected


def all_relationship_semantics(archive: zipfile.ZipFile) -> dict[str, list[dict[str, str]]]:
    result: dict[str, list[dict[str, str]]] = {}
    for name in sorted((part for part in archive.namelist() if part.endswith(".rels")), key=natural_key):
        source = relationship_source(name)
        rows = list(relationship_table(archive, source).values())
        rows.sort(key=lambda row: (row["type"], row["target"], row["target_mode"]))
        result[source or "<package>"] = rows
    return result


def relationship_changes(
    baseline: zipfile.ZipFile,
    revised: zipfile.ZipFile,
    media_selectors: list[MediaSelector],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    old = all_relationship_semantics(baseline)
    new = all_relationship_semantics(revised)
    allowed: list[dict[str, Any]] = []
    unexpected: list[dict[str, Any]] = []
    for source in sorted(set(old) | set(new), key=natural_key):
        old_counter = Counter(json.dumps(row, sort_keys=True) for row in old.get(source, []))
        new_counter = Counter(json.dumps(row, sort_keys=True) for row in new.get(source, []))
        if old_counter == new_counter:
            continue
        removed = [json.loads(row) for row in list((old_counter - new_counter).elements())]
        added = [json.loads(row) for row in list((new_counter - old_counter).elements())]
        change = {"source": source, "removed": removed, "added": added}
        media_rows: list[tuple[dict[str, str], zipfile.ZipFile]] = []
        media_rows.extend((row, baseline) for row in removed if is_media_part(row.get("target", "")))
        media_rows.extend((row, revised) for row in added if is_media_part(row.get("target", "")))
        all_media = len(media_rows) == len(removed) + len(added) and bool(media_rows)
        is_allowed = all_media
        for row, archive in media_rows:
            values = [row["target"]]
            if row["target"] in archive.namelist():
                values.append(sha256_bytes(archive.read(row["target"])))
            if not any(selector.matches(values) for selector in media_selectors):
                is_allowed = False
                break
        (allowed if is_allowed else unexpected).append(change)
    return allowed, unexpected


def part_set_changes(
    baseline: zipfile.ZipFile,
    revised: zipfile.ZipFile,
    media_selectors: list[MediaSelector],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    old = {name for name in baseline.namelist() if is_key_part(name)}
    new = {name for name in revised.namelist() if is_key_part(name)}
    allowed: list[dict[str, Any]] = []
    unexpected: list[dict[str, Any]] = []
    for kind, names in (("removed", old - new), ("added", new - old)):
        for part in sorted(names, key=natural_key):
            change = {"kind": kind, "part": part}
            values = [part]
            archive = baseline if kind == "removed" else revised
            if is_media_part(part) and part in archive.namelist():
                values.append(sha256_bytes(archive.read(part)))
            is_allowed = is_media_part(part) and any(selector.matches(values) for selector in media_selectors)
            (allowed if is_allowed else unexpected).append(change)
    return allowed, unexpected


def normalized_part_changes(
    baseline: zipfile.ZipFile,
    revised: zipfile.ZipFile,
) -> list[dict[str, Any]]:
    shared = {
        name
        for name in set(baseline.namelist()) & set(revised.namelist())
        if is_key_part(name) and not is_media_part(name) and not name.endswith(".rels")
    }
    result: list[dict[str, Any]] = []
    for part in sorted(shared, key=natural_key):
        if is_xml_part(part):
            old_hash = normalized_xml_hash(baseline, part)
            new_hash = normalized_xml_hash(revised, part)
            comparison = "normalized_xml"
        else:
            old_hash = sha256_bytes(baseline.read(part))
            new_hash = sha256_bytes(revised.read(part))
            comparison = "binary_sha256"
        if old_hash != new_hash:
            result.append(
                {
                    "part": part,
                    "comparison": comparison,
                    "baseline_sha256": old_hash,
                    "revised_sha256": new_hash,
                }
            )
    return result


def compare_decks(
    baseline_path: Path,
    revised_path: Path,
    object_selectors: list[Selector],
    media_selectors: list[MediaSelector],
) -> dict[str, Any]:
    try:
        baseline = zipfile.ZipFile(baseline_path)
        revised = zipfile.ZipFile(revised_path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise CompareInputError(str(exc)) from exc

    with baseline, revised:
        baseline_slides = slide_order(baseline)
        revised_slides = slide_order(revised)
        baseline_canvas = canvas(baseline)
        revised_canvas = canvas(revised)

        deck_changes: list[dict[str, Any]] = []
        if len(baseline_slides) != len(revised_slides):
            deck_changes.append(
                {"field": "slide_count", "baseline": len(baseline_slides), "revised": len(revised_slides)}
            )
        if baseline_canvas != revised_canvas:
            deck_changes.append(
                {"field": "canvas", "baseline": baseline_canvas, "revised": revised_canvas}
            )

        object_allowed: list[dict[str, Any]] = []
        object_unexpected: list[dict[str, Any]] = []
        for slide_number in range(1, min(len(baseline_slides), len(revised_slides)) + 1):
            old_objects = slide_objects(baseline, baseline_slides[slide_number - 1], slide_number)
            new_objects = slide_objects(revised, revised_slides[slide_number - 1], slide_number)
            allowed, unexpected = compare_object_lists(old_objects, new_objects, object_selectors)
            object_allowed.extend(allowed)
            object_unexpected.extend(unexpected)

        media_allowed, media_unexpected = media_changes(baseline, revised, media_selectors)
        rel_allowed, rel_unexpected = relationship_changes(baseline, revised, media_selectors)
        parts_allowed, parts_unexpected = part_set_changes(baseline, revised, media_selectors)
        xml_changes = normalized_part_changes(baseline, revised)

        slides_with_object_changes = {
            baseline_slides[change["slide"] - 1]
            for change in object_allowed + object_unexpected
            if change["slide"] <= len(baseline_slides)
        }
        covered_parts: list[dict[str, Any]] = []
        unexplained_parts: list[dict[str, Any]] = []
        for change in xml_changes:
            part = change["part"]
            if part.startswith("ppt/slides/") and part in slides_with_object_changes:
                old_residual = normalized_slide_residual_hash(baseline, part)
                new_residual = normalized_slide_residual_hash(revised, part)
                annotated = {
                    **change,
                    "baseline_non_object_sha256": old_residual,
                    "revised_non_object_sha256": new_residual,
                }
                if old_residual == new_residual:
                    covered_parts.append(annotated)
                else:
                    unexplained_parts.append(annotated)
            else:
                unexplained_parts.append(change)

        unexpected_flat: list[dict[str, Any]] = []
        unexpected_flat.extend({"category": "deck", **change} for change in deck_changes)
        unexpected_flat.extend({"category": "object", **change} for change in object_unexpected)
        unexpected_flat.extend({"category": "media", **change} for change in media_unexpected)
        unexpected_flat.extend({"category": "relationship", **change} for change in rel_unexpected)
        unexpected_flat.extend({"category": "package_part_set", **change} for change in parts_unexpected)
        unexpected_flat.extend({"category": "unexplained_package_content", **change} for change in unexplained_parts)

        result = {
            "schema_version": 1,
            "baseline": {"path": str(baseline_path), "sha256": sha256_file(baseline_path)},
            "revised": {"path": str(revised_path), "sha256": sha256_file(revised_path)},
            "normalization": {
                "relationship_ids": "resolved to relationship type, target, and target mode",
                "creation_ids": "creationId elements and attributes ignored",
                "timestamps": sorted(TIMESTAMP_NAMES),
            },
            "unsupported_semantics": UNSUPPORTED_SEMANTICS,
            "allow_lists": {
                "objects": [selector.raw for selector in object_selectors],
                "media": [selector.raw for selector in media_selectors],
            },
            "deck": {
                "baseline_slide_count": len(baseline_slides),
                "revised_slide_count": len(revised_slides),
                "baseline_canvas": baseline_canvas,
                "revised_canvas": revised_canvas,
                "changes": deck_changes,
            },
            "changes": {
                "objects": {"allowed": object_allowed, "unexpected": object_unexpected},
                "media": {"allowed": media_allowed, "unexpected": media_unexpected},
                "relationships": {"allowed": rel_allowed, "unexpected": rel_unexpected},
                "package_part_set": {"allowed": parts_allowed, "unexpected": parts_unexpected},
                "normalized_package_content": {
                    "covered_by_object_changes": covered_parts,
                    "unexplained": unexplained_parts,
                },
            },
            "unexpected": unexpected_flat,
        }
        result["summary"] = {
            "pass": not unexpected_flat,
            "unexpected_count": len(unexpected_flat),
            "object_changes": len(object_allowed) + len(object_unexpected),
            "allowed_object_changes": len(object_allowed),
            "unexpected_object_changes": len(object_unexpected),
            "media_changes": len(media_allowed) + len(media_unexpected),
            "allowed_media_changes": len(media_allowed),
            "unexpected_media_changes": len(media_unexpected),
            "relationship_target_changes": len(rel_allowed) + len(rel_unexpected),
            "key_part_set_changes": len(parts_allowed) + len(parts_unexpected),
            "normalized_content_changes": len(xml_changes),
        }
        return result


def same_path(left: Path, right: Path) -> bool:
    try:
        if left.exists() and right.exists() and os.path.samefile(left, right):
            return True
    except OSError:
        pass
    return os.path.normcase(str(left.resolve())) == os.path.normcase(str(right.resolve()))


def write_report(path: Path, baseline: Path, revised: Path, report: dict[str, Any]) -> None:
    if same_path(path, baseline) or same_path(path, revised):
        raise CompareInputError("--report must not overwrite either PPTX input")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    summary = report["summary"]
    print("PASS" if summary["pass"] else "UNEXPECTED CHANGES")
    print(
        "objects: "
        f"{summary['object_changes']} changed "
        f"({summary['allowed_object_changes']} allowed, "
        f"{summary['unexpected_object_changes']} unexpected)"
    )
    print(
        "media: "
        f"{summary['media_changes']} changed "
        f"({summary['allowed_media_changes']} allowed, "
        f"{summary['unexpected_media_changes']} unexpected)"
    )
    print(f"unexpected total: {summary['unexpected_count']}")
    for index, change in enumerate(report["unexpected"], start=1):
        category = change.get("category", "unknown")
        if category == "object":
            candidate = change.get("revised") or change.get("baseline") or {}
            detail = f"slide {candidate.get('slide')} {candidate.get('name')!r} z={change.get('z_path')}"
        elif category == "media":
            detail = str(change.get("part"))
        elif category == "relationship":
            detail = str(change.get("source"))
        elif category in {"package_part_set", "unexplained_package_content"}:
            detail = str(change.get("part"))
        else:
            detail = str(change.get("field", "deck"))
        print(f"  {index}. [{category}] {detail}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only semantic and package comparison for localized PPTX repairs."
    )
    parser.add_argument("baseline", type=Path, help="PPTX before the localized repair")
    parser.add_argument("revised", type=Path, help="PPTX after the localized repair")
    parser.add_argument(
        "--allow-object",
        action="append",
        default=[],
        metavar="SLIDE:NAME|re:REGEX",
        help="Allow changes to an exact slide/name or regex matched against 'slide:name'; repeatable",
    )
    parser.add_argument(
        "--allow-media",
        action="append",
        default=[],
        metavar="PART|BASENAME|re:REGEX",
        help="Allow a changed media part, basename, hash, or regex; repeatable",
    )
    parser.add_argument("--report", type=Path, help="Write the complete JSON report")
    parser.add_argument(
        "--fail-unexpected",
        action="store_true",
        help="Exit 1 when a change is not explained by an allow-list",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        for path, label in ((args.baseline, "baseline"), (args.revised, "revised")):
            if not path.is_file():
                raise CompareInputError(f"{label} PPTX does not exist: {path}")
        object_selectors = [parse_object_selector(raw) for raw in args.allow_object]
        media_selectors = [parse_media_selector(raw) for raw in args.allow_media]
        report = compare_decks(args.baseline, args.revised, object_selectors, media_selectors)
        if args.report:
            write_report(args.report, args.baseline, args.revised, report)
        print_summary(report)
        if args.fail_unexpected and not report["summary"]["pass"]:
            return 1
        return 0
    except CompareInputError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except (OSError, zipfile.BadZipFile, ET.ParseError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
