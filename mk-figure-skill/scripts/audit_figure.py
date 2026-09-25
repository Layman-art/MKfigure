#!/usr/bin/env python3
"""Audit editable figure structure. A structural pass is never visual approval.

Standard library only. Font checks use stored properties; they cannot establish
the font actually substituted by PowerPoint, Office, or an SVG renderer.
"""

import argparse
import json
import math
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "s": "http://www.w3.org/2000/svg",
}
CN_FONTS = {"microsoft yahei", "微软雅黑"}
EN_FONTS = {"times new roman"}
MATH_FONTS = {
    "times new roman", "cambria math", "stix two math", "stix math",
    "xits math", "latin modern math", "asana math", "libertinus math",
}
VECTOR_TAGS = {"path", "rect", "circle", "ellipse", "line", "polyline", "polygon"}
LATIN = re.compile(r"[A-Za-z]")
GREEK = re.compile(r"[\u0370-\u03ff]")
CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
SINGLE_VARIABLE = re.compile(r"^[A-Za-z\u0370-\u03ff]$")


def local(tag):
    return tag.rsplit("}", 1)[-1]


def normalize(text):
    return re.sub(r"\s+", "", text)


def issue(items, status, code, message, location=None, **details):
    row = {"status": status, "code": code, "message": message}
    if location:
        row["location"] = location
    row.update(details)
    items.append(row)


def status_for(items):
    if any(row["status"] == "failed" for row in items):
        return "failed"
    if any(row["status"] == "warning" for row in items):
        return "warning"
    return "passed"


def font_name(value):
    # Only the preferred face is enforced. A renderer may choose later fallbacks.
    return value.split(",", 1)[0].strip().strip("'\"").casefold() if value else None


def font_check(text, props, where, rows):
    if not text.strip():
        return
    is_math = props.get("math", False)
    checks = []
    if CJK.search(text):
        checks.append(("chinese", props.get("east_asia") or props.get("family"), CN_FONTS))
    if LATIN.search(text) or (is_math and GREEK.search(text)):
        checks.append(("math" if is_math else "english", props.get("latin") or props.get("family"), MATH_FONTS if is_math else EN_FONTS))
    for script, family, allowed in checks:
        name = font_name(family)
        state = "warning" if not name or name.startswith("+") else "passed" if name in allowed else "failed"
        row = {"location": where, "text": text, "script": script, "font": family,
               "bold": props.get("bold"), "italic": props.get("italic"), "status": state}
        if state == "warning":
            row["reason"] = "Font inheritance or theme is unresolved; visual/Office verification is required."
        elif state == "failed":
            row["reason"] = "Explicit font does not match the workflow font convention."
        rows.append(row)
    # A single marked mathematical letter is unambiguously a variable. Do not
    # enforce italic on digits, punctuation, functions, or normal-text OMML runs.
    if is_math and SINGLE_VARIABLE.fullmatch(text.strip()) and not props.get("normal_math"):
        italic = props.get("italic")
        rows.append({"location": where, "text": text, "script": "math_variable",
                     "font": props.get("latin") or props.get("family"),
                     "italic": italic, "status": "warning" if italic is None else "passed" if italic else "failed",
                     "reason": "A marked single-letter mathematical variable should be italic."})


def drawing_props(element, theme):
    if element is None:
        return {}
    result = {}
    for attr, name in (("b", "bold"), ("i", "italic")):
        if attr in element.attrib:
            result[name] = element.get(attr) in {"1", "true"}
    for tag, name in (("latin", "latin"), ("ea", "east_asia")):
        face = element.find("a:" + tag, NS)
        if face is not None and face.get("typeface"):
            raw = face.get("typeface")
            result[name] = theme.get(raw, raw)
    return result


def pptx_audit(path):
    checks, fonts, texts = [], [], []
    counts = {"slides": 0, "native_shapes": 0, "connectors": 0, "groups": 0,
              "graphic_frames": 0, "text_runs": 0, "pictures": 0,
              "omml_equations": 0, "embedded_svg_references": 0}
    report = {"path": str(path.resolve()), "counts": counts, "checks": checks, "font_runs": fonts}
    try:
        with zipfile.ZipFile(path) as package:
            bad = package.testzip()
            if bad:
                issue(checks, "failed", "zip_crc", "ZIP member failed CRC verification.", bad)
            names = set(package.namelist())
            for essential in ("[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"):
                if essential not in names:
                    issue(checks, "failed", "missing_pptx_part", "Required PPTX part is missing.", essential)
            trees = {}
            for name in sorted(names):
                if name.endswith((".xml", ".rels")):
                    try:
                        trees[name] = ET.fromstring(package.read(name))
                    except ET.ParseError as exc:
                        issue(checks, "failed", "invalid_xml", str(exc), name)
            slides = sorted(n for n in trees if re.fullmatch(r"ppt/slides/slide\d+\.xml", n))
            counts["slides"] = len(slides)
            if not slides:
                issue(checks, "failed", "missing_slides", "No parseable slide XML was found.")
            # Different slide masters can have different themes. The common
            # theme is used only when all stored themes agree for that face.
            theme_candidates = {}
            for name, root in trees.items():
                if name.startswith("ppt/theme/"):
                    for scope, prefix in (("majorFont", "+mj-"), ("minorFont", "+mn-")):
                        for tag, suffix in (("latin", "lt"), ("ea", "ea")):
                            face = root.find(".//a:" + scope + "/a:" + tag, NS)
                            if face is not None and face.get("typeface"):
                                theme_candidates.setdefault(prefix + suffix, set()).add(face.get("typeface"))
            theme = {k: next(iter(v)) for k, v in theme_candidates.items() if len(v) == 1}
            for name in slides:
                root = trees[name]
                counts["native_shapes"] += len(root.findall(".//p:sp", NS))
                counts["connectors"] += len(root.findall(".//p:cxnSp", NS))
                counts["groups"] += len(root.findall(".//p:grpSp", NS))
                counts["graphic_frames"] += len(root.findall(".//p:graphicFrame", NS))
                counts["pictures"] += len(root.findall(".//p:pic", NS))
                counts["embedded_svg_references"] += sum(local(e.tag) == "svgBlip" for e in root.iter())
                counts["omml_equations"] += len(root.findall(".//m:oMath", NS))
                parents = {child: parent for parent in root.iter() for child in parent}
                for p_index, paragraph in enumerate(root.findall(".//a:p", NS), 1):
                    body = parents.get(paragraph)
                    ppr = paragraph.find("a:pPr", NS)
                    try:
                        level = int(ppr.get("lvl", "0")) + 1 if ppr is not None else 1
                    except ValueError:
                        issue(checks, "failed", "invalid_paragraph_level", "Paragraph list level is not an integer.", name)
                        level = 1
                    base = drawing_props(body.find("a:lstStyle/a:lvl%dpPr/a:defRPr" % level, NS), theme) if body is not None else {}
                    base.update(drawing_props(paragraph.find("a:pPr/a:defRPr", NS), theme))
                    combined = []
                    for run_index, run in enumerate(list(paragraph), 1):
                        if local(run.tag) not in {"r", "fld"}:
                            continue
                        text = "".join(e.text or "" for e in run.findall("a:t", NS))
                        combined.append(text)
                        counts["text_runs"] += 1
                        props = dict(base)
                        props.update(drawing_props(run.find("a:rPr", NS), theme))
                        family = font_name(props.get("latin"))
                        props["math"] = family in MATH_FONTS - EN_FONTS
                        # Without explicit run/paragraph style, absence of i is
                        # not proof of roman text: the property may inherit.
                        font_check(text, props, "%s:p%d:run%d" % (name, p_index, run_index), fonts)
                    if combined:
                        texts.append("".join(combined))
                for equation_index, equation in enumerate(root.findall(".//m:oMath", NS), 1):
                    texts.append("".join(e.text or "" for e in equation.findall(".//m:t", NS)))
                    for run_index, run in enumerate(equation.findall(".//m:r", NS), 1):
                        text = "".join(e.text or "" for e in run.findall("m:t", NS))
                        props = {"latin": "Cambria Math", "math": True, "italic": True}
                        props.update(drawing_props(run.find("a:rPr", NS), theme))
                        word_fonts = run.find("w:rPr/w:rFonts", NS)
                        if word_fonts is not None:
                            for attr, key in (("ascii", "latin"), ("eastAsia", "east_asia")):
                                value = word_fonts.get("{" + NS["w"] + "}" + attr)
                                if value:
                                    props[key] = value
                        rpr = run.find("m:rPr", NS)
                        if rpr is not None:
                            normal = rpr.find("m:nor", NS)
                            props["normal_math"] = normal is not None and normal.get("{" + NS["m"] + "}val", "1") not in {"0", "false"}
                            style = rpr.find("m:sty", NS)
                            if style is not None:
                                val = style.get("{" + NS["m"] + "}val", "i")
                                props["italic"] = val in {"i", "bi"}
                                props["bold"] = val in {"b", "bi"}
                        font_check(text, props, "%s:equation%d:run%d" % (name, equation_index, run_index), fonts)
                for relation in trees.get("ppt/slides/_rels/" + Path(name).name + ".rels", []):
                    if relation.get("TargetMode") == "External" and relation.get("Type", "").endswith("/image"):
                        issue(checks, "warning", "external_image", "Slide depends on an external image.", name, target=relation.get("Target"))
            native = counts["native_shapes"] + counts["connectors"] + counts["graphic_frames"] + counts["omml_equations"]
            if counts["pictures"] and not native:
                issue(checks, "failed", "picture_only_pptx", "All visible content is stored as pictures; embedded SVG pictures also do not establish native PPT editability.")
            elif counts["pictures"]:
                issue(checks, "warning", "mixed_picture_content", "Native objects and pictures coexist. Visually verify that labels, formulae, and diagram geometry are editable; identify any accepted raster assets.")
            if counts["graphic_frames"]:
                issue(checks, "warning", "graphic_frame_editability", "Graphic frames need inspection: tables/charts may be editable, while OLE or other payloads may not be.")
            if not native and not counts["pictures"]:
                issue(checks, "failed", "no_slide_content", "No native objects or pictures were found.")
            size = trees.get("ppt/presentation.xml")
            size = size.find("p:sldSz", NS) if size is not None else None
            if size is not None:
                try:
                    report["canvas_emu"] = {"width": int(size.get("cx", "0")), "height": int(size.get("cy", "0"))}
                    if min(report["canvas_emu"].values()) <= 0:
                        raise ValueError("Nonpositive canvas size")
                except ValueError as exc:
                    issue(checks, "failed", "invalid_canvas", str(exc))
            else:
                issue(checks, "warning", "missing_canvas", "Slide dimensions could not be determined.")
    except (OSError, zipfile.BadZipFile) as exc:
        issue(checks, "failed", "pptx_read_error", str(exc))
    return report, texts


def css_properties(element, inherited):
    props = dict(inherited)
    css = {k.strip(): v.strip() for k, v in re.findall(r"([\w-]+)\s*:\s*([^;]+)", element.get("style", ""))}
    for name in ("font-family", "font-style", "font-weight"):
        value = css.get(name, element.get(name))
        if value is None or value == "inherit":
            continue
        if name == "font-family":
            props["family"] = value
        elif name == "font-style":
            props["italic"] = value in {"italic", "oblique"}
        else:
            props["bold"] = value in {"bold", "bolder", "600", "700", "800", "900"}
    role = element.get("data-role", "").casefold()
    classes = set(element.get("class", "").casefold().split())
    if role in {"math", "formula", "equation"} or classes & {"math", "formula", "equation"}:
        props["math"] = True
    if font_name(props.get("family")) in MATH_FONTS - EN_FONTS:
        props["math"] = True
    if element.get("data-math-style") == "normal":
        props["normal_math"] = True
    return props


def svg_audit(path):
    checks, fonts, texts = [], [], []
    counts = {"text": 0, "tspan": 0, "path": 0, "vector_elements": 0, "images": 0,
              "embedded_raster_images": 0, "embedded_svg_images": 0, "external_images": 0}
    report = {"path": str(path.resolve()), "counts": counts, "checks": checks, "font_runs": fonts}
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as exc:
        issue(checks, "failed", "svg_read_error", str(exc))
        return report, texts
    if root.tag != "{" + NS["s"] + "}svg":
        issue(checks, "failed", "svg_root", "The root must be an SVG element in the SVG namespace.")
    viewbox = root.get("viewBox")
    if viewbox:
        try:
            numbers = [float(x) for x in re.split(r"[\s,]+", viewbox.strip())]
            if len(numbers) != 4 or not all(math.isfinite(x) for x in numbers) or min(numbers[2:]) <= 0:
                raise ValueError("viewBox requires four finite values and positive width/height.")
            report["viewBox"] = numbers
        except ValueError as exc:
            issue(checks, "failed", "invalid_viewbox", str(exc))
    else:
        issue(checks, "warning", "missing_viewbox", "A viewBox is recommended for predictable scaling.")
    report["canvas"] = {key: root.get(key) for key in ("width", "height")}
    numeric_canvas = {}
    for key, value in report["canvas"].items():
        if value is None:
            issue(checks, "warning", "responsive_canvas", "No explicit %s; verify target-renderer sizing." % key)
            continue
        match = re.fullmatch(r"\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|%|em|ex)?\s*", value)
        if not match:
            issue(checks, "warning", "unresolved_canvas", "SVG %s is not a simple supported CSS length; verify computed dimensions in the renderer." % key, value=value)
        elif float(match.group(1)) <= 0:
            issue(checks, "failed", "invalid_canvas", "SVG %s must be positive." % key, value=value)
        elif match.group(2) in {None, "px"}:
            numeric_canvas[key] = float(match.group(1))
    if len(numeric_canvas) == 2 and report.get("viewBox"):
        vb = report["viewBox"]
        if abs(numeric_canvas["width"] / numeric_canvas["height"] - vb[2] / vb[3]) > 1e-6:
            issue(checks, "warning", "canvas_aspect_ratio", "Canvas and viewBox aspect ratios differ; inspect padding or distortion.")
    external_refs = []
    for index, element in enumerate(root.iter(), 1):
        tag = local(element.tag)
        if tag in {"text", "tspan", "path"}:
            counts[tag] += 1
        if tag in VECTOR_TAGS:
            counts["vector_elements"] += 1
        href = element.get("href", element.get("{http://www.w3.org/1999/xlink}href", ""))
        if tag == "image":
            counts["images"] += 1
            if href.startswith("data:image/svg+xml"):
                counts["embedded_svg_images"] += 1
            elif href.startswith("data:image/"):
                counts["embedded_raster_images"] += 1
            elif href and not href.startswith("#"):
                counts["external_images"] += 1
            elif not href:
                issue(checks, "failed", "empty_image_href", "Image has no source.", "image%d" % index)
        if href and not href.startswith(("#", "data:")) and tag != "a":
            external_refs.append({"element": tag, "reference": href})
        for value in element.attrib.values():
            for ref in re.findall(r"url\(\s*['\"]?([^)'\"]+)", value):
                if not ref.startswith(("#", "data:")):
                    external_refs.append({"element": tag, "reference": ref})
        if tag == "style":
            issue(checks, "warning", "stylesheet_review", "Stylesheet selector rules and web fonts are not resolved by this audit; verify computed fonts visually.")
            for ref in re.findall(r"url\(\s*['\"]?([^)'\"]+)", element.text or ""):
                if not ref.startswith(("#", "data:")):
                    external_refs.append({"element": "style", "reference": ref})
    if external_refs:
        issue(checks, "warning", "external_resources", "SVG uses external resources and is not self-contained; embed resources for portable delivery.", references=external_refs)
    if counts["images"] and not counts["vector_elements"] and not counts["text"]:
        issue(checks, "failed", "image_only_svg", "An SVG image wrapper is not editable diagram reconstruction.")
    elif counts["images"]:
        issue(checks, "warning", "mixed_svg_image_content", "SVG includes image assets; inspect whether any required editable elements remain rasterized.")
    if not counts["text"]:
        issue(checks, "warning", "no_editable_svg_text", "No SVG text elements found; text might be outlined, absent, or rasterized.")
    # Traverse in order, preserving inherited style for each text/tspan fragment.
    def walk(element, inherited, inside_text=False, where="svg"):
        props = css_properties(element, inherited)
        in_text = inside_text or local(element.tag) == "text"
        if local(element.tag) == "text":
            texts.append("".join(element.itertext()))
        if in_text and element.text:
            font_check(element.text, props, where, fonts)
        for index, child in enumerate(element, 1):
            walk(child, props, in_text, where + "/" + local(child.tag) + str(index))
            if in_text and child.tail:
                font_check(child.tail, props, where + ":tail%d" % index, fonts)
    walk(root, {"italic": False, "bold": False})
    return report, texts


def expected_audit(labels, texts, artifact):
    joined = [normalize(text) for text in texts]
    missing = [label for label in labels if normalize(label) and not any(normalize(label) in text for text in joined)]
    return {"artifact": artifact, "expected_count": len(labels), "missing": missing,
            "status": "failed" if missing else "passed",
            "scope": "Unicode substring matching within extracted text blocks; no OCR or formula-equivalence verification."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pptx", type=Path)
    parser.add_argument("--svg", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--expected-text-json", type=Path)
    args = parser.parse_args()
    if not args.pptx and not args.svg:
        parser.error("at least one of --pptx and --svg is required")
    labels = None
    if args.expected_text_json:
        try:
            labels = json.loads(args.expected_text_json.read_text(encoding="utf-8-sig"))
            if isinstance(labels, dict):
                labels = labels.get("labels")
            if not isinstance(labels, list) or not all(isinstance(v, str) for v in labels):
                raise ValueError("expected JSON must be a string array or an object with a string-array labels key")
        except (OSError, ValueError) as exc:
            parser.error(str(exc))
    result = {"schema_version": "1.0", "automatic_structure": {"status": "pending", "artifacts": {}},
              "expected_text": [], "visual_review_required": {"status": "pending", "checks": [
                  "Render the generated reference, SVG, and PPTX using the target renderers and compare them side by side.",
                  "Check scientific meaning, symbols, formulae, units, arrow direction, data provenance, and source fidelity.",
                  "Check Chinese boldness against the reference; no automatic boldness decision is made.",
                  "Check actual rendered fonts, italic mathematical variables, upright functions/digits, and baseline alignment.",
                  "Check clipping, overlap, line breaks, object positions, stroke widths, canvas edges, and academic color contrast.",
                  "Select/edit text, equations, and representative diagram objects in PowerPoint; disclose any intentional raster asset.",
              ]}, "overall_status": "visual_review_required"}
    combined = []
    for kind, path, audit in (("pptx", args.pptx, pptx_audit), ("svg", args.svg, svg_audit)):
        if path is None:
            continue
        report, texts = audit(path)
        report["font_audit_status"] = status_for(report["font_runs"])
        report["status"] = status_for(report["checks"] + report["font_runs"])
        result["automatic_structure"]["artifacts"][kind] = report
        combined.extend(report["checks"] + report["font_runs"])
        if labels is not None:
            expected = expected_audit(labels, texts, kind)
            result["expected_text"].append(expected)
            combined.append(expected)
    result["automatic_structure"]["status"] = status_for(combined)
    if result["automatic_structure"]["status"] == "failed":
        result["overall_status"] = "failed"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"automatic_structure": result["automatic_structure"]["status"],
                      "overall_status": result["overall_status"], "report": str(args.output.resolve())}, ensure_ascii=True))
    return 1 if result["overall_status"] == "failed" else 0


if __name__ == "__main__":
    sys.exit(main())
