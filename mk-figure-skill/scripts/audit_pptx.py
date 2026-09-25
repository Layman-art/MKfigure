#!/usr/bin/env python3
"""Contract-driven structural audit for editable PowerPoint files.

This script intentionally uses only the Python standard library.  It inspects
the PPTX ZIP package and its OOXML parts; it does not open or rewrite the deck.
Exit codes: 0 = pass, 1 = contract violation, 2 = invalid input/contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from typing import Any, Iterable
from xml.etree import ElementTree as ET


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")


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
DEFAULT_MANUAL_MARKERS = ["•", "●", "○", "◦", "▪", "▫", "·", "‧"]
SELECTOR_FIELDS = {
    "slide", "slides", "name", "names", "name_regex", "id", "ids", "type", "types",
    "placeholder", "placeholder_types", "has_text_body", "has_picture_fill", "picture_fill_text", "text",
}
TEXT_MATCHER_FIELDS = {"value", "match", "case_sensitive", "normalize_whitespace"}
OBJECT_TYPES = set(OBJECT_TAGS.values())


class AuditInputError(Exception):
    """Raised for malformed files or contracts."""


def reject_unknown(mapping: dict[str, Any], allowed: set[str], label: str) -> None:
    unknown = sorted(set(mapping) - allowed)
    if unknown:
        raise AuditInputError(f"{label} contains unsupported field(s): {', '.join(unknown)}")


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AuditInputError(f"{label} must be an object")
    return value


def require_boolean(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise AuditInputError(f"{label} must be a boolean")
    return value


def require_string(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise AuditInputError(f"{label} must be a string")
    return value


def require_number(value: Any, label: str) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise AuditInputError(f"{label} must be a finite number")
    return value


def require_array(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise AuditInputError(f"{label} must be an array")
    return value


def require_string_array(value: Any, label: str, *, allow_empty: bool = True) -> list[str]:
    items = require_array(value, label)
    if not allow_empty and not items:
        raise AuditInputError(f"{label} must not be empty")
    for index, item in enumerate(items):
        require_string(item, f"{label}[{index}]")
    return items


def validate_text_matcher(value: Any, label: str) -> None:
    if isinstance(value, str):
        return
    matcher = require_object(value, label)
    reject_unknown(matcher, TEXT_MATCHER_FIELDS, label)
    if "value" not in matcher:
        raise AuditInputError(f"{label} must contain value")
    require_string(matcher["value"], f"{label}.value")
    mode = matcher.get("match", "contains")
    require_string(mode, f"{label}.match")
    if mode not in {"exact", "contains", "regex"}:
        raise AuditInputError(f"unsupported text match mode in {label}: {mode}")
    for key in ("case_sensitive", "normalize_whitespace"):
        if key in matcher:
            require_boolean(matcher[key], f"{label}.{key}")
    if mode == "regex":
        try:
            re.compile(matcher["value"])
        except re.error as exc:
            raise AuditInputError(f"invalid text regex in {label}: {exc}") from exc


def validate_selector(value: Any, label: str) -> None:
    selector = require_object(value, label)
    reject_unknown(selector, SELECTOR_FIELDS, label)
    if "slide" in selector:
        slide = selector["slide"]
        if isinstance(slide, bool) or not isinstance(slide, int) or slide < 1:
            raise AuditInputError(f"{label}.slide must be a positive integer")
    if "slides" in selector:
        slides = require_array(selector["slides"], f"{label}.slides")
        if not slides:
            raise AuditInputError(f"{label}.slides must not be empty")
        for index, slide in enumerate(slides):
            if isinstance(slide, bool) or not isinstance(slide, int) or slide < 1:
                raise AuditInputError(f"{label}.slides[{index}] must be a positive integer")
    if "name" in selector:
        require_string(selector["name"], f"{label}.name")
    if "names" in selector:
        require_string_array(selector["names"], f"{label}.names", allow_empty=False)
    if "name_regex" in selector:
        require_string(selector["name_regex"], f"{label}.name_regex")
        try:
            re.compile(selector["name_regex"])
        except re.error as exc:
            raise AuditInputError(f"invalid name_regex in {label}: {exc}") from exc
    if "id" in selector:
        object_id = selector["id"]
        if isinstance(object_id, bool) or not isinstance(object_id, (str, int)):
            raise AuditInputError(f"{label}.id must be a string or integer")
    if "ids" in selector:
        object_ids = require_array(selector["ids"], f"{label}.ids")
        if not object_ids:
            raise AuditInputError(f"{label}.ids must not be empty")
        for index, object_id in enumerate(object_ids):
            if isinstance(object_id, bool) or not isinstance(object_id, (str, int)):
                raise AuditInputError(f"{label}.ids[{index}] must be a string or integer")
    requested_types: list[Any] = []
    if "type" in selector:
        require_string(selector["type"], f"{label}.type")
        requested_types.append(selector["type"])
    if "types" in selector:
        requested_types.extend(require_string_array(selector["types"], f"{label}.types", allow_empty=False))
    invalid_types = sorted({str(item) for item in requested_types if item not in OBJECT_TYPES})
    if invalid_types:
        raise AuditInputError(f"{label} contains unsupported object type(s): {', '.join(invalid_types)}")
    if "placeholder_types" in selector:
        require_string_array(selector["placeholder_types"], f"{label}.placeholder_types", allow_empty=False)
    for key in ("placeholder", "has_text_body", "has_picture_fill", "picture_fill_text"):
        if key in selector:
            require_boolean(selector[key], f"{label}.{key}")
    if "text" in selector:
        validate_text_matcher(selector["text"], f"{label}.text")


def validate_rule_list(
    value: Any,
    label: str,
    rule_fields: set[str],
    *,
    validate_rule_text: bool = False,
) -> None:
    if not isinstance(value, list):
        raise AuditInputError(f"{label} must be an array")
    allowed = set(rule_fields) | SELECTOR_FIELDS
    for index, raw_rule in enumerate(value):
        rule_label = f"{label}[{index}]"
        rule = require_object(raw_rule, rule_label)
        reject_unknown(rule, allowed, rule_label)
        if "selector" in rule:
            ignored_siblings = sorted((set(rule) & SELECTOR_FIELDS) - set(rule_fields))
            if ignored_siblings:
                raise AuditInputError(
                    f"{rule_label} has selector fields beside nested selector that would be ignored: "
                    + ", ".join(ignored_siblings)
                )
            validate_selector(rule["selector"], f"{rule_label}.selector")
        else:
            inline_selector = {key: rule[key] for key in SELECTOR_FIELDS if key in rule}
            validate_selector(inline_selector, rule_label)
        if "count" in rule:
            count_spec(rule["count"], f"{rule_label}.count")
        if "object_count" in rule:
            count_spec(rule["object_count"], f"{rule_label}.object_count")
        if "paragraph_count" in rule:
            count_spec(rule["paragraph_count"], f"{rule_label}.paragraph_count")
        for key in (
            "bullet_paragraph_count",
            "numbered_paragraph_count",
            "manual_marker_paragraph_count",
        ):
            if key in rule:
                count_spec(rule[key], f"{rule_label}.{key}")
        if validate_rule_text and "text" in rule:
            validate_text_matcher(rule["text"], f"{rule_label}.text")


def validate_contract(contract: dict[str, Any]) -> None:
    """Reject misspelled or vacuous contracts before any deck inspection."""
    top_level = {
        "schema_version", "deck", "source", "sources", "placeholders", "fonts", "text", "objects",
        "text_boxes", "bullets", "images", "picture_fill_text", "metadata",
    }
    reject_unknown(contract, top_level, "contract")
    if "schema_version" in contract:
        schema_version = contract["schema_version"]
        if isinstance(schema_version, bool) or not isinstance(schema_version, int):
            raise AuditInputError("schema_version must be an integer")
        if schema_version != 1:
            raise AuditInputError(f"unsupported schema_version: {schema_version}")
    if "metadata" in contract:
        require_object(contract["metadata"], "metadata")

    if "deck" in contract:
        deck = require_object(contract["deck"], "deck")
        reject_unknown(deck, {"slide_count", "sha256", "size"}, "deck")
        if "slide_count" in deck:
            count_spec(deck["slide_count"], "deck.slide_count")
        if "sha256" in deck:
            require_string(deck["sha256"], "deck.sha256")
        if "size" in deck:
            size = require_object(deck["size"], "deck.size")
            reject_unknown(
                size,
                {
                    "width_emu", "height_emu", "tolerance_emu", "width_inches", "height_inches",
                    "tolerance_inches", "aspect_ratio", "aspect_tolerance",
                },
                "deck.size",
            )
            for key in ("width_emu", "height_emu", "tolerance_emu"):
                if key in size:
                    value = size[key]
                    if isinstance(value, bool) or not isinstance(value, int):
                        raise AuditInputError(f"deck.size.{key} must be an integer")
            for key in ("width_inches", "height_inches", "tolerance_inches", "aspect_ratio", "aspect_tolerance"):
                if key in size:
                    require_number(size[key], f"deck.size.{key}")

    if "source" in contract and "sources" in contract:
        raise AuditInputError("use source or sources, not both")
    source_value = contract.get("sources", contract.get("source"))
    if source_value is not None:
        sources = [source_value] if isinstance(source_value, dict) else source_value
        if not isinstance(sources, list):
            raise AuditInputError("sources must be an object or array")
        for index, raw_source in enumerate(sources):
            source = require_object(raw_source, f"sources[{index}]")
            reject_unknown(source, {"path", "sha256", "required"}, f"sources[{index}]")
            if "path" not in source or "sha256" not in source:
                raise AuditInputError(f"sources[{index}] must contain path and sha256")
            require_string(source["path"], f"sources[{index}].path")
            require_string(source["sha256"], f"sources[{index}].sha256")
            if not source["path"]:
                raise AuditInputError(f"sources[{index}].path must not be empty")
            if "required" in source:
                require_boolean(source["required"], f"sources[{index}].required")

    if "placeholders" in contract:
        section = require_object(contract["placeholders"], "placeholders")
        reject_unknown(section, {"forbid_empty", "selector", "ignore"}, "placeholders")
        if "forbid_empty" in section:
            require_boolean(section["forbid_empty"], "placeholders.forbid_empty")
        if "selector" in section:
            validate_selector(section["selector"], "placeholders.selector")
        if "ignore" in section:
            if not isinstance(section["ignore"], list):
                raise AuditInputError("placeholders.ignore must be an array")
            for index, selector in enumerate(section["ignore"]):
                validate_selector(selector, f"placeholders.ignore[{index}]")

    if "fonts" in contract:
        section = require_object(contract["fonts"], "fonts")
        reject_unknown(
            section,
            {"scope", "allowed", "required", "forbidden", "ignore_theme_tokens", "require_explicit"},
            "fonts",
        )
        if "scope" in section:
            require_string_array(section["scope"], "fonts.scope", allow_empty=False)
        for key in ("allowed", "required", "forbidden"):
            if key in section:
                require_string_array(section[key], f"fonts.{key}")
        for key in ("ignore_theme_tokens", "require_explicit"):
            if key in section:
                require_boolean(section[key], f"fonts.{key}")

    if "text" in contract:
        section = require_object(contract["text"], "text")
        reject_unknown(section, {"required", "forbidden"}, "text")
        for mode in ("required", "forbidden"):
            if mode not in section:
                continue
            rules = section[mode]
            if not isinstance(rules, list):
                raise AuditInputError(f"text.{mode} must be an array")
            for index, raw_rule in enumerate(rules):
                label = f"text.{mode}[{index}]"
                rule = require_object(raw_rule, label)
                reject_unknown(rule, TEXT_MATCHER_FIELDS | {"selector", "count"}, label)
                if "value" not in rule:
                    raise AuditInputError(f"{label} must contain value")
                validate_text_matcher(
                    {key: rule[key] for key in TEXT_MATCHER_FIELDS if key in rule},
                    label,
                )
                if "selector" in rule:
                    validate_selector(rule["selector"], f"{label}.selector")
                if "count" in rule:
                    count_spec(rule["count"], f"{label}.count")

    if "objects" in contract:
        section = require_object(contract["objects"], "objects")
        reject_unknown(section, {"required", "forbidden", "counts"}, "objects")
        for mode in ("required", "forbidden"):
            if mode in section:
                validate_rule_list(section[mode], f"objects.{mode}", {"selector", "count"})
        if "counts" in section:
            counts = require_object(section["counts"], "objects.counts")
            allowed_counts = {"all", "placeholder", "text_box", "picture_fill", "picture_fill_text"} | OBJECT_TYPES
            reject_unknown(counts, allowed_counts, "objects.counts")
            for key, value in counts.items():
                count_spec(value, f"objects.counts.{key}")

    if "text_boxes" in contract:
        section = require_object(contract["text_boxes"], "text_boxes")
        reject_unknown(section, {"required"}, "text_boxes")
        if "required" in section:
            validate_rule_list(
                section["required"],
                "text_boxes.required",
                {
                    "selector", "count", "paragraph_count", "bullet_paragraph_count",
                    "numbered_paragraph_count", "manual_marker_paragraph_count",
                },
            )

    if "bullets" in contract:
        section = require_object(contract["bullets"], "bullets")
        reject_unknown(section, {"required", "forbid_manual_markers", "manual_markers", "selector"}, "bullets")
        if "forbid_manual_markers" in section:
            require_boolean(section["forbid_manual_markers"], "bullets.forbid_manual_markers")
        if "manual_markers" in section:
            require_string_array(section["manual_markers"], "bullets.manual_markers", allow_empty=False)
        if "selector" in section:
            validate_selector(section["selector"], "bullets.selector")
        if "required" in section:
            validate_rule_list(
                section["required"],
                "bullets.required",
                {"selector", "object_count", "kind", "paragraph_count", "text"},
                validate_rule_text=True,
            )
            for index, rule in enumerate(section["required"]):
                if "kind" in rule:
                    require_string(rule["kind"], f"bullets.required[{index}].kind")
                    if rule["kind"] not in {"bullet", "numbered", "any"}:
                        raise AuditInputError(f"unsupported bullet kind: {rule['kind']}")

    if "images" in contract:
        section = require_object(contract["images"], "images")
        image_count_fields = {"picture_count", "picture_fill_count", "media_count", "unique_media_count"}
        reject_unknown(
            section,
            image_count_fields
            | {
                "allowed_extensions", "required_extensions", "forbidden_extensions", "required_sha256",
                "forbidden_sha256", "require_relationship_targets_exist",
            },
            "images",
        )
        for key in image_count_fields:
            if key in section:
                count_spec(section[key], f"images.{key}")
        for key in ("allowed_extensions", "required_extensions", "forbidden_extensions", "required_sha256", "forbidden_sha256"):
            if key in section:
                require_string_array(section[key], f"images.{key}")
        if "require_relationship_targets_exist" in section:
            require_boolean(section["require_relationship_targets_exist"], "images.require_relationship_targets_exist")

    if "picture_fill_text" in contract:
        section = require_object(contract["picture_fill_text"], "picture_fill_text")
        reject_unknown(section, {"required", "forbidden", "forbid_picture_fill_without_text"}, "picture_fill_text")
        if "forbid_picture_fill_without_text" in section:
            require_boolean(
                section["forbid_picture_fill_without_text"],
                "picture_fill_text.forbid_picture_fill_without_text",
            )
        for mode in ("required", "forbidden"):
            if mode in section:
                validate_rule_list(
                    section[mode],
                    f"picture_fill_text.{mode}",
                    {"selector", "count", "require_nonempty_text"},
                )
                for index, rule in enumerate(section[mode]):
                    if "require_nonempty_text" in rule:
                        require_boolean(
                            rule["require_nonempty_text"],
                            f"picture_fill_text.{mode}[{index}].require_nonempty_text",
                        )

    substantive = False
    deck = contract.get("deck", {})
    substantive |= any(key in deck for key in ("slide_count", "sha256"))
    if isinstance(deck.get("size"), dict):
        substantive |= any(
            key in deck["size"]
            for key in ("width_emu", "height_emu", "width_inches", "height_inches", "aspect_ratio")
        )
    substantive |= bool(source_value)
    placeholders = contract.get("placeholders", {})
    substantive |= bool(placeholders.get("forbid_empty", False))
    fonts = contract.get("fonts", {})
    substantive |= "allowed" in fonts or bool(fonts.get("required")) or bool(fonts.get("forbidden"))
    substantive |= bool(fonts.get("require_explicit", False))
    for section_name in ("text", "objects", "text_boxes", "bullets", "picture_fill_text"):
        section = contract.get(section_name, {})
        substantive |= bool(section.get("required")) or bool(section.get("forbidden"))
    substantive |= bool(contract.get("objects", {}).get("counts"))
    substantive |= bool(contract.get("bullets", {}).get("forbid_manual_markers", False))
    substantive |= bool(contract.get("picture_fill_text", {}).get("forbid_picture_fill_without_text", False))
    images = contract.get("images", {})
    substantive |= any(key in images for key in {"picture_count", "picture_fill_count", "media_count", "unique_media_count", "allowed_extensions"})
    substantive |= any(bool(images.get(key)) for key in {"required_extensions", "forbidden_extensions", "required_sha256", "forbidden_sha256"})
    substantive |= bool(images.get("require_relationship_targets_exist", False))
    if not substantive:
        raise AuditInputError("contract has no substantive assertions")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def paths_alias(first: Path, second: Path) -> bool:
    """Return True for the same resolved path or an existing filesystem alias."""
    if first.resolve() == second.resolve():
        return True
    try:
        return first.exists() and second.exists() and first.samefile(second)
    except OSError:
        return False


def declared_source_paths(contract: dict[str, Any], contract_dir: Path) -> list[Path]:
    value = contract.get("sources", contract.get("source"))
    if value is None:
        return []
    sources = [value] if isinstance(value, dict) else value
    paths: list[Path] = []
    for source in sources:
        path = Path(source["path"])
        paths.append(path.resolve() if path.is_absolute() else (contract_dir / path).resolve())
    return paths


def normalized_text(value: str) -> str:
    return " ".join((value or "").split())


def natural_key(value: str) -> list[Any]:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value)]


def relationship_part(part_name: str) -> str:
    directory, filename = posixpath.split(part_name)
    return posixpath.join(directory, "_rels", filename + ".rels")


def resolve_target(source_part: str, target: str) -> str:
    if target.startswith("/"):
        return posixpath.normpath(target.lstrip("/"))
    return posixpath.normpath(posixpath.join(posixpath.dirname(source_part), target))


def count_spec(value: Any, label: str) -> dict[str, int]:
    if isinstance(value, bool):
        raise AuditInputError(f"{label} must be an integer or count object")
    if isinstance(value, int):
        return {"exact": value}
    if not isinstance(value, dict):
        raise AuditInputError(f"{label} must be an integer or count object")
    reject_unknown(value, {"exact", "min", "max"}, label)
    result: dict[str, int] = {}
    for key in ("exact", "min", "max"):
        if key in value:
            if isinstance(value[key], bool) or not isinstance(value[key], int):
                raise AuditInputError(f"{label}.{key} must be an integer")
            result[key] = value[key]
    if not result:
        raise AuditInputError(f"{label} must contain exact, min, or max")
    return result


def count_matches(actual: int, spec: dict[str, int]) -> bool:
    if "exact" in spec and actual != spec["exact"]:
        return False
    if "min" in spec and actual < spec["min"]:
        return False
    if "max" in spec and actual > spec["max"]:
        return False
    return True


def text_matches(actual: str, spec: Any) -> bool:
    if isinstance(spec, str):
        spec = {"value": spec, "match": "contains"}
    if not isinstance(spec, dict) or "value" not in spec:
        raise AuditInputError("text matcher must be a string or contain value")
    expected = str(spec["value"])
    mode = spec.get("match", "contains")
    case_sensitive = bool(spec.get("case_sensitive", False))
    normalize = bool(spec.get("normalize_whitespace", True))
    left = normalized_text(actual) if normalize else actual
    right = normalized_text(expected) if normalize else expected
    if mode == "regex":
        flags = 0 if case_sensitive else re.IGNORECASE
        try:
            return re.search(right, left, flags=flags) is not None
        except re.error as exc:
            raise AuditInputError(f"invalid text regex {right!r}: {exc}") from exc
    if not case_sensitive:
        left, right = left.casefold(), right.casefold()
    if mode == "exact":
        return left == right
    if mode == "contains":
        return right in left
    raise AuditInputError(f"unsupported text match mode: {mode}")


def direct_text_bodies(element: ET.Element, object_type: str) -> list[ET.Element]:
    if object_type == "shape":
        body = element.find("p:txBody", NS)
        return [body] if body is not None else []
    if object_type == "graphic_frame":
        return list(element.findall(".//a:txBody", NS))
    return []


def paragraph_info(paragraph: ET.Element) -> dict[str, Any]:
    pieces: list[str] = []
    for child in list(paragraph):
        if child.tag in {Q["a"] + "r", Q["a"] + "fld"}:
            pieces.extend(node.text or "" for node in child.findall(".//a:t", NS))
        elif child.tag == Q["a"] + "br":
            pieces.append("\n")
        elif child.tag == Q["a"] + "tab":
            pieces.append("\t")
    ppr = paragraph.find("a:pPr", NS)
    bullet = "inherited"
    level = 0
    if ppr is not None:
        level = int(ppr.get("lvl", "0")) if ppr.get("lvl", "0").isdigit() else 0
        if ppr.find("a:buChar", NS) is not None:
            bullet = "bullet"
        elif ppr.find("a:buAutoNum", NS) is not None:
            bullet = "numbered"
        elif ppr.find("a:buNone", NS) is not None:
            bullet = "none"
    return {"text": "".join(pieces), "bullet": bullet, "level": level}


def declared_fonts(root: ET.Element) -> set[str]:
    fonts: set[str] = set()
    property_tags = {Q["a"] + "rPr", Q["a"] + "defRPr", Q["a"] + "endParaRPr"}
    property_nodes: list[ET.Element] = [root] if root.tag in property_tags else []
    for props_tag in ("rPr", "defRPr", "endParaRPr"):
        property_nodes.extend(root.findall(f".//a:{props_tag}", NS))
    for props in property_nodes:
        for family_tag in ("latin", "ea", "cs", "sym"):
            family = props.find(f"a:{family_tag}", NS)
            if family is not None and family.get("typeface"):
                fonts.add(family.get("typeface", ""))
    return fonts


def font_run_info(body: ET.Element) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for paragraph in body.findall(".//a:p", NS):
        ppr = paragraph.find("a:pPr", NS)
        paragraph_fonts = declared_fonts(ppr) if ppr is not None else set()
        for run_tag in ("r", "fld"):
            for run in paragraph.findall(f"a:{run_tag}", NS):
                text = "".join(node.text or "" for node in run.findall(".//a:t", NS))
                if not normalized_text(text):
                    continue
                rpr = run.find("a:rPr", NS)
                fonts = declared_fonts(rpr) if rpr is not None else set()
                if not fonts:
                    fonts = set(paragraph_fonts)
                runs.append({"text": text, "fonts": sorted(fonts), "unresolved": not fonts})
    return runs


class PptxPackage:
    def __init__(self, path: Path):
        self.path = path
        try:
            self.archive = zipfile.ZipFile(path, "r")
        except (OSError, zipfile.BadZipFile) as exc:
            raise AuditInputError(f"cannot open PPTX package: {exc}") from exc
        self.names = set(self.archive.namelist())
        if "ppt/presentation.xml" not in self.names:
            raise AuditInputError("package has no ppt/presentation.xml")
        self.relationship_issues: list[dict[str, Any]] = []
        self.slide_relationship_issues: list[dict[str, Any]] = []
        self.declared_slide_count = 0
        self.slide_paths = self._slide_paths()
        self.width_emu, self.height_emu = self._slide_size()
        self.objects: list[dict[str, Any]] = []
        self.broken_image_relationships: list[dict[str, Any]] = []
        for slide_number, slide_path in enumerate(self.slide_paths, start=1):
            self._read_slide(slide_number, slide_path)
        self.media = self._read_media()

    def close(self) -> None:
        self.archive.close()

    def xml(self, part: str) -> ET.Element:
        try:
            return ET.fromstring(self.archive.read(part))
        except KeyError as exc:
            raise AuditInputError(f"missing OOXML part: {part}") from exc
        except ET.ParseError as exc:
            raise AuditInputError(f"malformed XML in {part}: {exc}") from exc

    def relationships(self, source_part: str) -> dict[str, dict[str, str]]:
        rel_part = relationship_part(source_part)
        if rel_part not in self.names:
            return {}
        root = self.xml(rel_part)
        if root.tag != Q["pr"] + "Relationships":
            self.relationship_issues.append(
                {"relationship_part": rel_part, "reason": "relationship part has an invalid root element"}
            )
            return {}
        result: dict[str, dict[str, str]] = {}
        for index, rel in enumerate(root.findall("pr:Relationship", NS), start=1):
            rel_id = rel.get("Id")
            if not rel_id:
                self.relationship_issues.append(
                    {"relationship_part": rel_part, "index": index, "reason": "relationship is missing Id"}
                )
                continue
            if rel_id in result:
                self.relationship_issues.append(
                    {
                        "relationship_part": rel_part,
                        "index": index,
                        "relationship_id": rel_id,
                        "reason": "duplicate relationship Id",
                    }
                )
                continue
            external = rel.get("TargetMode") == "External"
            target = rel.get("Target", "")
            result[rel_id] = {
                "type": rel.get("Type", ""),
                "target": target if external else resolve_target(source_part, target),
                "external": str(external),
            }
        return result

    def _slide_paths(self) -> list[str]:
        root = self.xml("ppt/presentation.xml")
        rels = self.relationships("ppt/presentation.xml")
        ordered: list[str] = []
        slide_ids = root.findall("p:sldIdLst/p:sldId", NS)
        self.declared_slide_count = len(slide_ids)
        seen_targets: set[str] = set()
        for index, slide_id in enumerate(slide_ids, start=1):
            rel_id = slide_id.get(Q["r"] + "id")
            evidence = {"index": index, "slide_id": slide_id.get("id", ""), "relationship_id": rel_id}
            if not rel_id:
                self.slide_relationship_issues.append({**evidence, "reason": "missing r:id"})
                continue
            rel = rels.get(rel_id)
            if rel is None:
                self.slide_relationship_issues.append({**evidence, "reason": "relationship is missing"})
                continue
            target = rel["target"]
            evidence["target"] = target
            if rel["external"] == "True":
                self.slide_relationship_issues.append({**evidence, "reason": "slide relationship is external"})
                continue
            if not rel["type"].endswith("/slide"):
                self.slide_relationship_issues.append(
                    {**evidence, "reason": "relationship type is not a slide", "relationship_type": rel["type"]}
                )
                continue
            if target not in self.names:
                self.slide_relationship_issues.append({**evidence, "reason": "slide target is missing"})
                continue
            try:
                slide_root = self.xml(target)
            except AuditInputError as exc:
                self.slide_relationship_issues.append(
                    {**evidence, "reason": "slide target is not valid XML", "detail": str(exc)}
                )
                continue
            if slide_root.tag != Q["p"] + "sld":
                self.slide_relationship_issues.append(
                    {**evidence, "reason": "slide target root is not p:sld", "actual_root": slide_root.tag}
                )
                continue
            if target in seen_targets:
                self.slide_relationship_issues.append({**evidence, "reason": "duplicate slide target"})
                continue
            seen_targets.add(target)
            ordered.append(target)

        loose_slides = sorted(
            (name for name in self.names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
            key=natural_key,
        )
        if not slide_ids and loose_slides:
            self.slide_relationship_issues.append(
                {"reason": "slide parts exist but presentation.xml declares no slides", "targets": loose_slides}
            )
        return ordered

    def _slide_size(self) -> tuple[int, int]:
        root = self.xml("ppt/presentation.xml")
        size = root.find("p:sldSz", NS)
        if size is None or not size.get("cx") or not size.get("cy"):
            raise AuditInputError("presentation has no valid p:sldSz")
        return int(size.get("cx", "0")), int(size.get("cy", "0"))

    def _read_slide(self, slide_number: int, slide_path: str) -> None:
        root = self.xml(slide_path)
        rels = self.relationships(slide_path)
        tree = root.find("p:cSld/p:spTree", NS)
        if tree is None:
            return

        def visit(container: ET.Element, group_names: list[str]) -> None:
            for element in list(container):
                object_type = OBJECT_TAGS.get(element.tag)
                if not object_type:
                    continue
                nv = element.find(NV_PATHS[object_type], NS)
                object_id = nv.get("id", "") if nv is not None else ""
                name = nv.get("name", "") if nv is not None else ""
                ph = element.find(PH_PATHS[object_type], NS)
                placeholder_type = ph.get("type", "obj") if ph is not None else None
                bodies = direct_text_bodies(element, object_type)
                paragraphs = [paragraph_info(p) for body in bodies for p in body.findall(".//a:p", NS)]
                text = "\n".join(item["text"] for item in paragraphs).strip()
                fonts = set().union(*(declared_fonts(body) for body in bodies)) if bodies else set()
                font_runs = [run for body in bodies for run in font_run_info(body)]
                has_picture_fill = (
                    object_type == "shape" and element.find("p:spPr/a:blipFill", NS) is not None
                )
                media_targets: list[str] = []
                relationship_ids: list[str] = []
                for blip in element.findall(".//a:blip", NS):
                    rel_id = blip.get(Q["r"] + "embed") or blip.get(Q["r"] + "link")
                    if not rel_id:
                        continue
                    relationship_ids.append(rel_id)
                    rel = rels.get(rel_id)
                    if rel and rel["external"] == "False":
                        media_targets.append(rel["target"])
                item = {
                    "slide": slide_number,
                    "slide_part": slide_path,
                    "id": object_id,
                    "name": name,
                    "type": object_type,
                    "group_path": list(group_names),
                    "placeholder": ph is not None,
                    "placeholder_type": placeholder_type,
                    "has_text_body": bool(bodies),
                    "text": text,
                    "paragraphs": paragraphs,
                    "fonts": sorted(fonts),
                    "font_runs": font_runs,
                    "has_picture_fill": has_picture_fill,
                    "picture_fill_text": bool(has_picture_fill and bodies),
                    "media_targets": sorted(set(media_targets)),
                    "relationship_ids": relationship_ids,
                }
                self.objects.append(item)
                if object_type == "group":
                    visit(element, group_names + [name or object_id])

        visit(tree, [])
        for rel_id, rel in rels.items():
            if not rel["type"].endswith("/image") or rel["external"] == "True":
                continue
            if rel["target"] not in self.names:
                self.broken_image_relationships.append(
                    {"slide": slide_number, "relationship_id": rel_id, "target": rel["target"]}
                )

    def _read_media(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for name in sorted(self.names, key=natural_key):
            if not name.startswith("ppt/media/") or name.endswith("/"):
                continue
            data = self.archive.read(name)
            result.append(
                {
                    "path": name,
                    "extension": Path(name).suffix.lower(),
                    "size": len(data),
                    "sha256": sha256_bytes(data),
                }
            )
        return result

    def font_declarations(self, scopes: Iterable[str]) -> set[str]:
        prefixes = {
            "slides": "ppt/slides/",
            "layouts": "ppt/slideLayouts/",
            "masters": "ppt/slideMasters/",
            "notes": "ppt/notesSlides/",
        }
        fonts: set[str] = set()
        for scope in scopes:
            if scope not in prefixes:
                raise AuditInputError(f"unsupported font scope: {scope}")
            prefix = prefixes[scope]
            for name in self.names:
                if name.startswith(prefix) and name.endswith(".xml") and "/_rels/" not in name:
                    fonts.update(declared_fonts(self.xml(name)))
        return fonts


class Auditor:
    def __init__(self, package: PptxPackage, contract: dict[str, Any], contract_dir: Path):
        self.package = package
        self.contract = contract
        self.contract_dir = contract_dir
        self.checks: list[dict[str, Any]] = []

    def add(
        self,
        check_id: str,
        passed: bool,
        message: str,
        *,
        expected: Any = None,
        actual: Any = None,
        evidence: Any = None,
        severity: str = "error",
    ) -> None:
        status = "pass" if passed else ("warning" if severity == "warning" else "fail")
        item: dict[str, Any] = {"id": check_id, "status": status, "message": message}
        if expected is not None:
            item["expected"] = expected
        if actual is not None:
            item["actual"] = actual
        if evidence is not None:
            item["evidence"] = evidence
        self.checks.append(item)

    def check_count(self, check_id: str, actual: int, expected: Any, message: str, evidence: Any = None) -> None:
        spec = count_spec(expected, check_id)
        self.add(
            check_id,
            count_matches(actual, spec),
            message,
            expected=spec,
            actual=actual,
            evidence=evidence,
        )

    def select(self, selector: dict[str, Any] | None, base: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
        selector = selector or {}
        objects = base if base is not None else self.package.objects

        def match(obj: dict[str, Any]) -> bool:
            if "slide" in selector and obj["slide"] != selector["slide"]:
                return False
            if "slides" in selector and obj["slide"] not in selector["slides"]:
                return False
            if "name" in selector and obj["name"] != selector["name"]:
                return False
            if "names" in selector and obj["name"] not in selector["names"]:
                return False
            if "name_regex" in selector:
                try:
                    if re.search(selector["name_regex"], obj["name"]) is None:
                        return False
                except re.error as exc:
                    raise AuditInputError(f"invalid name_regex: {exc}") from exc
            if "id" in selector and str(obj["id"]) != str(selector["id"]):
                return False
            if "ids" in selector and str(obj["id"]) not in {str(v) for v in selector["ids"]}:
                return False
            allowed_types = selector.get("types", [selector["type"]] if "type" in selector else None)
            if allowed_types is not None and obj["type"] not in allowed_types:
                return False
            if "placeholder" in selector and obj["placeholder"] != bool(selector["placeholder"]):
                return False
            if "placeholder_types" in selector and obj["placeholder_type"] not in selector["placeholder_types"]:
                return False
            if "has_text_body" in selector and obj["has_text_body"] != bool(selector["has_text_body"]):
                return False
            if "has_picture_fill" in selector and obj["has_picture_fill"] != bool(selector["has_picture_fill"]):
                return False
            if "picture_fill_text" in selector and obj["picture_fill_text"] != bool(selector["picture_fill_text"]):
                return False
            if "text" in selector and not text_matches(obj["text"], selector["text"]):
                return False
            return True

        return [obj for obj in objects if match(obj)]

    @staticmethod
    def selector_from_rule(rule: dict[str, Any]) -> dict[str, Any]:
        if "selector" in rule:
            if not isinstance(rule["selector"], dict):
                raise AuditInputError("selector must be an object")
            return dict(rule["selector"])
        return {key: value for key, value in rule.items() if key in SELECTOR_FIELDS}

    def audit_deck(self) -> None:
        section = self.contract.get("deck", {})
        if "slide_count" in section:
            self.check_count("deck.slide_count", len(self.package.slide_paths), section["slide_count"], "slide count")
        if "sha256" in section:
            actual = sha256_file(self.package.path)
            expected = str(section["sha256"]).upper()
            self.add("deck.sha256", actual == expected, "output deck hash", expected=expected, actual=actual)
        size = section.get("size")
        if size:
            if not isinstance(size, dict):
                raise AuditInputError("deck.size must be an object")
            actual_w, actual_h = self.package.width_emu, self.package.height_emu
            if "width_emu" in size or "height_emu" in size:
                tolerance = int(size.get("tolerance_emu", 0))
                if "width_emu" in size:
                    expected = int(size["width_emu"])
                    self.add("deck.size.width_emu", abs(actual_w - expected) <= tolerance, "slide width", expected=expected, actual=actual_w)
                if "height_emu" in size:
                    expected = int(size["height_emu"])
                    self.add("deck.size.height_emu", abs(actual_h - expected) <= tolerance, "slide height", expected=expected, actual=actual_h)
            if "width_inches" in size or "height_inches" in size:
                tolerance = float(size.get("tolerance_inches", 0.001))
                actual_w_in, actual_h_in = actual_w / 914400.0, actual_h / 914400.0
                if "width_inches" in size:
                    expected = float(size["width_inches"])
                    self.add("deck.size.width_inches", abs(actual_w_in - expected) <= tolerance, "slide width in inches", expected=expected, actual=actual_w_in)
                if "height_inches" in size:
                    expected = float(size["height_inches"])
                    self.add("deck.size.height_inches", abs(actual_h_in - expected) <= tolerance, "slide height in inches", expected=expected, actual=actual_h_in)
            if "aspect_ratio" in size:
                expected = float(size["aspect_ratio"])
                tolerance = float(size.get("aspect_tolerance", 0.001))
                actual = actual_w / actual_h
                self.add("deck.size.aspect_ratio", math.isclose(actual, expected, abs_tol=tolerance), "slide aspect ratio", expected=expected, actual=actual)

    def audit_sources(self) -> None:
        sources = self.contract.get("sources", self.contract.get("source", []))
        if isinstance(sources, dict):
            sources = [sources]
        if sources is None:
            return
        if not isinstance(sources, list):
            raise AuditInputError("sources must be an object or array")
        for index, source in enumerate(sources):
            if not isinstance(source, dict) or "path" not in source or "sha256" not in source:
                raise AuditInputError(f"sources[{index}] must contain path and sha256")
            path = Path(source["path"])
            if not path.is_absolute():
                path = self.contract_dir / path
            required = bool(source.get("required", True))
            if not path.is_file():
                self.add(
                    f"sources[{index}].sha256",
                    False,
                    "source file is missing",
                    expected=str(source["sha256"]).upper(),
                    actual=None,
                    evidence=str(path),
                    severity="error" if required else "warning",
                )
                continue
            actual = sha256_file(path)
            expected = str(source["sha256"]).upper()
            self.add(
                f"sources[{index}].sha256",
                actual == expected,
                "source file remains unchanged",
                expected=expected,
                actual=actual,
                evidence=str(path),
                severity="error" if required else "warning",
            )

    def audit_placeholders(self) -> None:
        section = self.contract.get("placeholders", {})
        if not section.get("forbid_empty", False):
            return
        selector = section.get("selector", {})
        candidates = self.select({**selector, "placeholder": True})
        ignored_rules = section.get("ignore", [])
        if not isinstance(ignored_rules, list):
            raise AuditInputError("placeholders.ignore must be an array of selectors")
        ignored_ids = {
            (obj["slide"], obj["id"])
            for ignore in ignored_rules
            for obj in self.select(ignore, candidates)
        }
        empty = []
        for obj in candidates:
            if (obj["slide"], obj["id"]) in ignored_ids:
                continue
            has_graphic = bool(obj["media_targets"]) or obj["type"] == "graphic_frame" or obj["has_picture_fill"]
            if not normalized_text(obj["text"]) and not has_graphic:
                empty.append({"slide": obj["slide"], "id": obj["id"], "name": obj["name"], "placeholder_type": obj["placeholder_type"]})
        self.add("placeholders.forbid_empty", not empty, "no unapproved empty placeholders", expected=0, actual=len(empty), evidence=empty)

    def audit_fonts(self) -> None:
        section = self.contract.get("fonts")
        if not section:
            return
        scopes = section.get("scope", ["slides"])
        if isinstance(scopes, str):
            scopes = [scopes]
        fonts = self.package.font_declarations(scopes)
        ignore_theme = bool(section.get("ignore_theme_tokens", True))
        considered = {font for font in fonts if not (ignore_theme and font.startswith("+"))}
        lookup = {font.casefold(): font for font in considered}
        if "allowed" in section:
            allowed = {str(font).casefold() for font in section["allowed"]}
            extras = sorted(font for font in considered if font.casefold() not in allowed)
            self.add("fonts.allowed", not extras, "only allowed font declarations are used", expected=section["allowed"], actual=sorted(considered), evidence=extras)
        if "forbidden" in section:
            forbidden = {str(font).casefold() for font in section["forbidden"]}
            hits = sorted(lookup[key] for key in forbidden if key in lookup)
            self.add("fonts.forbidden", not hits, "forbidden fonts are absent", expected=[], actual=hits)
        if "required" in section:
            missing = [font for font in section["required"] if str(font).casefold() not in lookup]
            self.add("fonts.required", not missing, "required fonts are declared", expected=section["required"], actual=sorted(considered), evidence=missing)
        if section.get("require_explicit", False):
            unresolved = [
                {"slide": obj["slide"], "id": obj["id"], "name": obj["name"], "text": run["text"]}
                for obj in self.package.objects
                for run in obj["font_runs"]
                if run["unresolved"]
            ]
            self.add("fonts.require_explicit", not unresolved, "all non-empty runs have an explicit run or paragraph font", expected=0, actual=len(unresolved), evidence=unresolved)

    def audit_rule_list(self, section_name: str, rules: Any, forbidden: bool = False) -> None:
        if not isinstance(rules, list):
            raise AuditInputError(f"{section_name} must be an array")
        for index, rule in enumerate(rules):
            if not isinstance(rule, dict):
                raise AuditInputError(f"{section_name}[{index}] must be an object")
            selector = self.selector_from_rule(rule)
            matches = self.select(selector)
            expected = rule.get("count", {"exact": 0} if forbidden else {"min": 1})
            evidence = [{"slide": obj["slide"], "id": obj["id"], "name": obj["name"], "type": obj["type"], "text": obj["text"]} for obj in matches]
            self.check_count(f"{section_name}[{index}]", len(matches), expected, "object selector match count", evidence=evidence)

    def audit_text_and_objects(self) -> None:
        text_section = self.contract.get("text", {})
        for mode in ("required", "forbidden"):
            rules = text_section.get(mode, [])
            converted = []
            for rule in rules:
                if not isinstance(rule, dict) or "value" not in rule:
                    raise AuditInputError(f"text.{mode} rules must contain value")
                selector = dict(rule.get("selector", {}))
                selector["text"] = {key: rule[key] for key in ("value", "match", "case_sensitive", "normalize_whitespace") if key in rule}
                converted.append({"selector": selector, "count": rule.get("count", {"exact": 0} if mode == "forbidden" else {"min": 1})})
            self.audit_rule_list(f"text.{mode}", converted, forbidden=(mode == "forbidden"))
        object_section = self.contract.get("objects", {})
        for mode in ("required", "forbidden"):
            if mode in object_section:
                self.audit_rule_list(f"objects.{mode}", object_section[mode], forbidden=(mode == "forbidden"))
        counts = object_section.get("counts", {})
        for kind, expected in counts.items():
            if kind == "all":
                actual = len(self.package.objects)
            elif kind == "placeholder":
                actual = sum(obj["placeholder"] for obj in self.package.objects)
            elif kind == "text_box":
                actual = sum(obj["type"] == "shape" and obj["has_text_body"] for obj in self.package.objects)
            elif kind == "picture_fill":
                actual = sum(obj["has_picture_fill"] for obj in self.package.objects)
            elif kind == "picture_fill_text":
                actual = sum(obj["picture_fill_text"] for obj in self.package.objects)
            elif kind in set(OBJECT_TAGS.values()):
                actual = sum(obj["type"] == kind for obj in self.package.objects)
            else:
                raise AuditInputError(f"unsupported objects.counts key: {kind}")
            self.check_count(f"objects.counts.{kind}", int(actual), expected, f"{kind} object count")

    def audit_text_boxes(self) -> None:
        section = self.contract.get("text_boxes", {})
        rules = section.get("required", [])
        if not isinstance(rules, list):
            raise AuditInputError("text_boxes.required must be an array")
        for index, rule in enumerate(rules):
            selector = self.selector_from_rule(rule)
            selector.update({"type": "shape", "has_text_body": True})
            matches = self.select(selector)
            self.check_count(f"text_boxes.required[{index}].objects", len(matches), rule.get("count", {"min": 1}), "matching text box count")
            constraints = {
                "paragraph_count": lambda obj: len(obj["paragraphs"]),
                "bullet_paragraph_count": lambda obj: sum(p["bullet"] == "bullet" for p in obj["paragraphs"]),
                "numbered_paragraph_count": lambda obj: sum(p["bullet"] == "numbered" for p in obj["paragraphs"]),
                "manual_marker_paragraph_count": lambda obj: sum(
                    p["bullet"] not in {"bullet", "numbered"}
                    and any(p["text"].lstrip().startswith(marker) for marker in DEFAULT_MANUAL_MARKERS)
                    for p in obj["paragraphs"]
                ),
            }
            for constraint, getter in constraints.items():
                if constraint not in rule:
                    continue
                failures = []
                for obj in matches:
                    actual = int(getter(obj))
                    spec = count_spec(rule[constraint], f"text_boxes.required[{index}].{constraint}")
                    if not count_matches(actual, spec):
                        failures.append({"slide": obj["slide"], "id": obj["id"], "name": obj["name"], "actual": actual})
                self.add(
                    f"text_boxes.required[{index}].{constraint}",
                    not failures,
                    f"each matching text box satisfies {constraint}",
                    expected=count_spec(rule[constraint], constraint),
                    actual="all" if not failures else "see evidence",
                    evidence=failures,
                )

    def audit_bullets(self) -> None:
        section = self.contract.get("bullets", {})
        rules = section.get("required", [])
        if not isinstance(rules, list):
            raise AuditInputError("bullets.required must be an array")
        for index, rule in enumerate(rules):
            selector = self.selector_from_rule(rule)
            selector["has_text_body"] = True
            objects = self.select(selector)
            self.check_count(f"bullets.required[{index}].objects", len(objects), rule.get("object_count", {"min": 1}), "objects selected for bullet audit")
            kind = rule.get("kind", "any")
            if kind not in {"bullet", "numbered", "any"}:
                raise AuditInputError(f"unsupported bullet kind: {kind}")
            failures = []
            for obj in objects:
                paragraphs = [p for p in obj["paragraphs"] if kind == "any" and p["bullet"] in {"bullet", "numbered"} or p["bullet"] == kind]
                if "text" in rule:
                    paragraphs = [p for p in paragraphs if text_matches(p["text"], rule["text"])]
                spec = count_spec(rule.get("paragraph_count", {"min": 1}), f"bullets.required[{index}].paragraph_count")
                if not count_matches(len(paragraphs), spec):
                    failures.append({"slide": obj["slide"], "id": obj["id"], "name": obj["name"], "actual": len(paragraphs)})
            self.add(
                f"bullets.required[{index}].paragraphs",
                not failures,
                "each selected object has the required native bullet paragraphs",
                expected=rule.get("paragraph_count", {"min": 1}),
                actual="all" if not failures else "see evidence",
                evidence=failures,
            )
        if section.get("forbid_manual_markers", False):
            markers = section.get("manual_markers", DEFAULT_MANUAL_MARKERS)
            selector = section.get("selector", {"has_text_body": True})
            hits = []
            for obj in self.select(selector):
                for paragraph_index, paragraph in enumerate(obj["paragraphs"], start=1):
                    if paragraph["bullet"] in {"bullet", "numbered"}:
                        continue
                    if any(paragraph["text"].lstrip().startswith(marker) for marker in markers):
                        hits.append({"slide": obj["slide"], "id": obj["id"], "name": obj["name"], "paragraph": paragraph_index, "text": paragraph["text"]})
            self.add("bullets.forbid_manual_markers", not hits, "typed bullet glyphs are absent from non-bulleted paragraphs", expected=0, actual=len(hits), evidence=hits)

    def audit_images(self) -> None:
        section = self.contract.get("images", {})
        counts = {
            "picture_count": sum(obj["type"] == "picture" for obj in self.package.objects),
            "picture_fill_count": sum(obj["has_picture_fill"] for obj in self.package.objects),
            "media_count": len(self.package.media),
            "unique_media_count": len({item["sha256"] for item in self.package.media}),
        }
        for key, actual in counts.items():
            if key in section:
                self.check_count(f"images.{key}", int(actual), section[key], key.replace("_", " "))
        extensions = {item["extension"] for item in self.package.media}
        if "allowed_extensions" in section:
            allowed = {str(ext).lower() if str(ext).startswith(".") else "." + str(ext).lower() for ext in section["allowed_extensions"]}
            extras = sorted(extensions - allowed)
            self.add("images.allowed_extensions", not extras, "media extensions are allowed", expected=sorted(allowed), actual=sorted(extensions), evidence=extras)
        if "required_extensions" in section:
            required = {str(ext).lower() if str(ext).startswith(".") else "." + str(ext).lower() for ext in section["required_extensions"]}
            missing = sorted(required - extensions)
            self.add("images.required_extensions", not missing, "required media extensions are present", expected=sorted(required), actual=sorted(extensions), evidence=missing)
        if "forbidden_extensions" in section:
            forbidden = {str(ext).lower() if str(ext).startswith(".") else "." + str(ext).lower() for ext in section["forbidden_extensions"]}
            hits = sorted(extensions & forbidden)
            self.add("images.forbidden_extensions", not hits, "forbidden media extensions are absent", expected=[], actual=hits)
        hashes = {item["sha256"] for item in self.package.media}
        for mode in ("required_sha256", "forbidden_sha256"):
            if mode not in section:
                continue
            requested = {str(value).upper() for value in section[mode]}
            evidence = sorted(requested - hashes) if mode == "required_sha256" else sorted(requested & hashes)
            message = "required media hashes are present" if mode == "required_sha256" else "forbidden media hashes are absent"
            self.add(f"images.{mode}", not evidence, message, expected=sorted(requested), actual=sorted(hashes), evidence=evidence)
        if section.get("require_relationship_targets_exist", False):
            broken = self.package.broken_image_relationships
            self.add("images.require_relationship_targets_exist", not broken, "all internal image relationships resolve", expected=0, actual=len(broken), evidence=broken)

    def audit_picture_fill_text(self) -> None:
        section = self.contract.get("picture_fill_text", {})
        for mode in ("required", "forbidden"):
            rules = section.get(mode, [])
            converted = []
            for rule in rules:
                if not isinstance(rule, dict):
                    raise AuditInputError(f"picture_fill_text.{mode} rules must be objects")
                selector = self.selector_from_rule(rule)
                selector.update({"type": "shape", "has_picture_fill": True, "has_text_body": True})
                if mode == "required" and rule.get("require_nonempty_text", True):
                    selector.setdefault("text", {"value": r"\S", "match": "regex", "normalize_whitespace": False})
                converted.append({"selector": selector, "count": rule.get("count", {"exact": 0} if mode == "forbidden" else {"min": 1})})
            self.audit_rule_list(f"picture_fill_text.{mode}", converted, forbidden=(mode == "forbidden"))
        if section.get("forbid_picture_fill_without_text", False):
            offenders = [
                {"slide": obj["slide"], "id": obj["id"], "name": obj["name"]}
                for obj in self.package.objects
                if obj["type"] == "shape" and obj["has_picture_fill"] and (not obj["has_text_body"] or not normalized_text(obj["text"]))
            ]
            self.add("picture_fill_text.forbid_picture_fill_without_text", not offenders, "picture-filled shapes also carry non-empty editable text", expected=0, actual=len(offenders), evidence=offenders)

    def run(self) -> dict[str, Any]:
        schema_version = self.contract.get("schema_version", 1)
        if schema_version != 1:
            raise AuditInputError(f"unsupported schema_version: {schema_version}")
        self.add(
            "package.relationships",
            not self.package.relationship_issues,
            "parsed relationship parts have valid roots and unique non-empty Id values",
            expected=0,
            actual=len(self.package.relationship_issues),
            evidence=self.package.relationship_issues,
        )
        self.add(
            "package.slide_relationships",
            not self.package.slide_relationship_issues,
            "every slide declared by presentation.xml has one valid internal slide relationship",
            expected=0,
            actual=len(self.package.slide_relationship_issues),
            evidence=self.package.slide_relationship_issues,
        )
        self.audit_deck()
        self.audit_sources()
        self.audit_placeholders()
        self.audit_fonts()
        self.audit_text_and_objects()
        self.audit_text_boxes()
        self.audit_bullets()
        self.audit_images()
        self.audit_picture_fill_text()
        failed = sum(check["status"] == "fail" for check in self.checks)
        warnings = sum(check["status"] == "warning" for check in self.checks)
        media_counts: dict[str, int] = {}
        for item in self.package.media:
            media_counts[item["extension"]] = media_counts.get(item["extension"], 0) + 1
        inventory = {
            "slide_count": len(self.package.slide_paths),
            "declared_slide_count": self.package.declared_slide_count,
            "relationship_issue_count": len(self.package.relationship_issues),
            "broken_slide_relationship_count": len(self.package.slide_relationship_issues),
            "canvas": {
                "width_emu": self.package.width_emu,
                "height_emu": self.package.height_emu,
                "width_inches": self.package.width_emu / 914400.0,
                "height_inches": self.package.height_emu / 914400.0,
                "aspect_ratio": self.package.width_emu / self.package.height_emu,
            },
            "object_count": len(self.package.objects),
            "object_types": {
                kind: sum(obj["type"] == kind for obj in self.package.objects)
                for kind in sorted(set(OBJECT_TAGS.values()))
            },
            "empty_placeholder_count": sum(
                obj["placeholder"] and not normalized_text(obj["text"]) and not obj["media_targets"] and not obj["has_picture_fill"]
                and obj["type"] != "graphic_frame"
                for obj in self.package.objects
            ),
            "declared_slide_fonts": sorted(self.package.font_declarations(["slides"])),
            "picture_fill_text_count": sum(obj["picture_fill_text"] for obj in self.package.objects),
            "media_count": len(self.package.media),
            "media_by_extension": media_counts,
            "broken_image_relationship_count": len(self.package.broken_image_relationships),
        }
        return {
            "status": "pass" if failed == 0 else "fail",
            "file": str(self.package.path.resolve()),
            "sha256": sha256_file(self.package.path),
            "summary": {"passed": len(self.checks) - failed - warnings, "failed": failed, "warnings": warnings},
            "inventory": inventory,
            "checks": self.checks,
        }


def load_contract(value: str) -> tuple[dict[str, Any], Path]:
    try:
        if value == "-":
            data = json.load(sys.stdin)
            base = Path.cwd()
        else:
            path = Path(value).resolve()
            with path.open("r", encoding="utf-8-sig") as handle:
                data = json.load(handle)
            base = path.parent
    except (OSError, json.JSONDecodeError) as exc:
        raise AuditInputError(f"cannot read JSON contract: {exc}") from exc
    if not isinstance(data, dict):
        raise AuditInputError("contract root must be a JSON object")
    return data, base


def print_human(report: dict[str, Any]) -> None:
    print(f"PPTX audit: {report['status'].upper()}")
    print(f"File: {report['file']}")
    summary = report["summary"]
    print(f"Checks: {summary['passed']} passed, {summary['failed']} failed, {summary['warnings']} warnings")
    for check in report["checks"]:
        marker = {"pass": "PASS", "fail": "FAIL", "warning": "WARN"}[check["status"]]
        print(f"[{marker}] {check['id']}: {check['message']}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit a PPTX against a JSON QA contract without modifying it.")
    parser.add_argument("pptx", help="PPTX file to inspect")
    parser.add_argument("--contract", required=True, help="JSON contract path, or - to read it from stdin")
    parser.add_argument("--report", help="optional path for the full JSON report")
    parser.add_argument("--json", action="store_true", help="print the full JSON report to stdout")
    args = parser.parse_args()

    package: PptxPackage | None = None
    try:
        pptx_path = Path(args.pptx).resolve()
        if not pptx_path.is_file():
            raise AuditInputError(f"PPTX file does not exist: {pptx_path}")
        contract, contract_dir = load_contract(args.contract)
        validate_contract(contract)
        if args.report:
            report_path = Path(args.report).resolve()
            if paths_alias(report_path, pptx_path):
                raise AuditInputError("--report must not be the PPTX input path")
            if args.contract != "-" and paths_alias(report_path, Path(args.contract).resolve()):
                raise AuditInputError("--report must not be the contract input path")
            for index, source_path in enumerate(declared_source_paths(contract, contract_dir)):
                if paths_alias(report_path, source_path):
                    raise AuditInputError(f"--report must not overwrite sources[{index}]: {source_path}")
        package = PptxPackage(pptx_path)
        report = Auditor(package, contract, contract_dir).run()
        encoded = json.dumps(report, ensure_ascii=False, indent=2)
        if args.report:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(encoded + "\n", encoding="utf-8")
        if args.json:
            print(encoded)
        else:
            print_human(report)
        return 0 if report["status"] == "pass" else 1
    except (AuditInputError, TypeError, ValueError, AttributeError) as exc:
        print(f"audit input error: {exc}", file=sys.stderr)
        return 2
    finally:
        if package is not None:
            package.close()


if __name__ == "__main__":
    raise SystemExit(main())
