#!/usr/bin/env python3
"""Crop reusable PNG assets from one reference image using a JSON plan.

Bounding boxes use Pillow's convention: ``[left, top, right, bottom]`` with
right and bottom excluded.  Padding adds clean pixels around the crop; it does
not sample neighbouring source pixels.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from PIL import Image


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


Color = tuple[int, int, int, int]
BBox = tuple[int, int, int, int]
Padding = tuple[int, int, int, int]
BACKGROUND_RING_WIDTH = 3
BACKGROUND_CONFIDENCE_MIN = 0.60


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Crop PNG assets from a reference image and report likely clipped "
            "foreground or forbidden-colour border contamination."
        ),
        epilog=(
            "Plan keys: inputImage, outputDir, assets[]. Each asset needs name "
            "and either bbox=[left,top,right,bottom] or left/top/right/bottom. "
            "Optional padding, background, edgeGuard, forbiddenColors, tolerance, "
            "and contentThreshold may be set globally or per asset. Right/bottom "
            "coordinates are exclusive. Background inference is preview-only: "
            "omit background only when a background_inferred_review_required "
            "warning and manual review are acceptable."
        ),
    )
    parser.add_argument("plan", help="JSON plan path, or '-' to read JSON from stdin")
    parser.add_argument("--report", help="Also write the JSON report to this path")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print the JSON report")
    parser.add_argument(
        "--fail-on-warning",
        action="store_true",
        help=(
            "Exit with status 2 for any warning, including inferred-background "
            "review, low confidence, zero foreground, clipping, or forbidden colour"
        ),
    )
    return parser.parse_args()


def resolve_path(value: Any, base_dir: Path, field: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty path string")
    path = Path(value).expanduser()
    return (base_dir / path).resolve() if not path.is_absolute() else path.resolve()


def as_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} must be an integer")
    return value


def parse_bbox(asset: dict[str, Any]) -> BBox:
    raw = asset.get("bbox")
    if isinstance(raw, dict):
        values = [raw.get(k) for k in ("left", "top", "right", "bottom")]
    elif raw is not None:
        if not isinstance(raw, list) or len(raw) != 4:
            raise ValueError("bbox must be [left, top, right, bottom] or an object with those keys")
        values = raw
    else:
        values = [asset.get(k) for k in ("left", "top", "right", "bottom")]
    left, top, right, bottom = (
        as_int(value, f"bbox.{key}")
        for key, value in zip(("left", "top", "right", "bottom"), values)
    )
    if right <= left or bottom <= top:
        raise ValueError("bbox must satisfy right > left and bottom > top")
    return left, top, right, bottom


def parse_padding(value: Any) -> Padding:
    if value is None:
        return 0, 0, 0, 0
    if isinstance(value, int) and not isinstance(value, bool):
        values = (value, value, value, value)
    elif isinstance(value, list) and len(value) == 2:
        x, y = (as_int(v, "padding") for v in value)
        values = (x, y, x, y)
    elif isinstance(value, list) and len(value) == 4:
        values = tuple(as_int(v, "padding") for v in value)
    elif isinstance(value, dict):
        values = tuple(as_int(value.get(k, 0), f"padding.{k}") for k in ("left", "top", "right", "bottom"))
    else:
        raise ValueError("padding must be an integer, [x,y], [left,top,right,bottom], or an object")
    if any(v < 0 for v in values):
        raise ValueError("padding values must be non-negative")
    return values  # type: ignore[return-value]


def parse_color(value: Any, field: str) -> Color:
    if isinstance(value, str):
        text = value.strip().lstrip("#")
        if len(text) == 3:
            text = "".join(ch * 2 for ch in text)
        if len(text) not in (6, 8):
            raise ValueError(f"{field} must be #RGB, #RRGGBB, #RRGGBBAA, or an RGB(A) array")
        try:
            channels = tuple(int(text[i : i + 2], 16) for i in range(0, len(text), 2))
        except ValueError as exc:
            raise ValueError(f"{field} contains an invalid hex colour") from exc
    elif isinstance(value, (list, tuple)) and len(value) in (3, 4):
        channels = tuple(as_int(v, field) for v in value)
    else:
        raise ValueError(f"{field} must be a colour string or an RGB(A) array")
    if any(channel < 0 or channel > 255 for channel in channels):
        raise ValueError(f"{field} channels must be between 0 and 255")
    return (*channels, 255) if len(channels) == 3 else channels  # type: ignore[return-value]


def color_hex(color: Color) -> str:
    return "#" + "".join(f"{channel:02X}" for channel in color)


def perimeter_colours(image: Image.Image) -> list[Color]:
    width, height = image.size
    pixels = image.load()
    perimeter: list[Color] = []
    for x in range(width):
        perimeter.append(pixels[x, 0])
        if height > 1:
            perimeter.append(pixels[x, height - 1])
    for y in range(1, max(1, height - 1)):
        perimeter.append(pixels[0, y])
        if width > 1:
            perimeter.append(pixels[width - 1, y])
    return perimeter


def outer_ring_colours(source: Image.Image, bbox: BBox, ring_width: int) -> list[Color]:
    """Sample a ring immediately outside bbox, never pixels from inside the crop."""
    left, top, right, bottom = bbox
    outer_left = max(0, left - ring_width)
    outer_top = max(0, top - ring_width)
    outer_right = min(source.width, right + ring_width)
    outer_bottom = min(source.height, bottom + ring_width)
    pixels = source.load()
    return [
        pixels[x, y]
        for y in range(outer_top, outer_bottom)
        for x in range(outer_left, outer_right)
        if not (left <= x < right and top <= y < bottom)
    ]


def infer_background(
    source: Image.Image, crop: Image.Image, bbox: BBox, content_threshold: int
) -> tuple[Color, dict[str, Any]]:
    ring = outer_ring_colours(source, bbox, BACKGROUND_RING_WIDTH)
    if ring:
        samples = ring
        sample_source = "outer_ring"
    else:
        samples = perimeter_colours(crop)
        sample_source = "crop_perimeter_fallback"

    background = Counter(samples).most_common(1)[0][0]
    support = sum(
        colour_distance(sample, background) <= content_threshold for sample in samples
    )
    confidence = support / len(samples)
    low_confidence = (
        sample_source != "outer_ring"
        or len(samples) < 8
        or confidence < BACKGROUND_CONFIDENCE_MIN
    )
    return background, {
        "source": sample_source,
        "sampleCount": len(samples),
        "supportCount": support,
        "confidence": round(confidence, 6),
        "lowConfidence": low_confidence,
        "reviewRequired": True,
        "ringWidth": BACKGROUND_RING_WIDTH if sample_source == "outer_ring" else 0,
    }


def colour_distance(a: Color, b: Color) -> int:
    return max(abs(a[i] - b[i]) for i in range(4))


def make_mask(image: Image.Image, predicate: Any) -> list[bytearray]:
    pixels = image.load()
    return [bytearray(1 if predicate(pixels[x, y]) else 0 for x in range(image.width)) for y in range(image.height)]


def longest_run(values: Iterable[int]) -> int:
    best = current = 0
    for value in values:
        current = current + 1 if value else 0
        best = max(best, current)
    return best


def edge_stats(mask: list[bytearray], guard: int) -> dict[str, Any]:
    height = len(mask)
    width = len(mask[0]) if height else 0
    if guard <= 0 or width == 0 or height == 0:
        return {"guard": guard, "touches": [], "counts": {}, "longestRuns": {}}
    gx, gy = min(guard, width), min(guard, height)
    edge_values: dict[str, list[list[int]]] = {
        "top": [[mask[y][x] for x in range(width)] for y in range(gy)],
        "bottom": [[mask[y][x] for x in range(width)] for y in range(height - gy, height)],
        "left": [[mask[y][x] for y in range(height)] for x in range(gx)],
        "right": [[mask[y][x] for y in range(height)] for x in range(width - gx, width)],
    }
    counts = {edge: sum(sum(line) for line in lines) for edge, lines in edge_values.items()}
    runs = {edge: max((longest_run(line) for line in lines), default=0) for edge, lines in edge_values.items()}
    return {
        "guard": guard,
        "touches": [edge for edge, count in counts.items() if count],
        "counts": counts,
        "longestRuns": runs,
    }


def add_padding(image: Image.Image, padding: Padding, background: Color) -> Image.Image:
    left, top, right, bottom = padding
    output = Image.new("RGBA", (image.width + left + right, image.height + top + bottom), background)
    output.paste(image, (left, top))
    return output


def output_name(raw: Any) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("asset.name must be a non-empty string")
    path = Path(raw.strip())
    if path.name != raw.strip() or path.name in (".", ".."):
        raise ValueError("asset.name must be a file name, not a path")
    if not path.suffix:
        path = path.with_suffix(".png")
    if path.suffix.lower() != ".png":
        raise ValueError("asset.name must use the .png extension")
    return path.name


def inherited(asset: dict[str, Any], plan: dict[str, Any], key: str, default: Any) -> Any:
    return asset[key] if key in asset else plan.get(key, default)


def paths_alias(first: Path, second: Path) -> bool:
    """Return whether two resolved paths name the same file, including hard links."""
    if os.path.normcase(str(first)) == os.path.normcase(str(second)):
        return True
    try:
        return first.exists() and second.exists() and os.path.samefile(first, second)
    except OSError:
        return False


def validate_output_paths(
    inputs: list[tuple[str, Path]], outputs: list[tuple[str, Path]]
) -> None:
    """Reject outputs that could overwrite an input or another output."""
    for output_label, output_path in outputs:
        for input_label, input_path in inputs:
            if paths_alias(output_path, input_path):
                raise ValueError(
                    f"{output_label} path aliases {input_label}: {output_path}"
                )
    for index, (first_label, first_path) in enumerate(outputs):
        for second_label, second_path in outputs[index + 1 :]:
            if paths_alias(first_path, second_path):
                raise ValueError(
                    f"{first_label} path aliases {second_label}: {first_path}"
                )


def process_plan(
    plan: dict[str, Any],
    base_dir: Path,
    plan_path: Path | None = None,
    report_path: Path | None = None,
) -> tuple[dict[str, Any], bool]:
    input_path = resolve_path(plan.get("inputImage"), base_dir, "inputImage")
    output_dir = resolve_path(plan.get("outputDir"), base_dir, "outputDir")
    assets = plan.get("assets")
    if not isinstance(assets, list) or not assets:
        raise ValueError("assets must be a non-empty array")
    if not input_path.is_file():
        raise ValueError(f"inputImage does not exist: {input_path}")

    source = Image.open(input_path).convert("RGBA")
    seen_names: set[str] = set()
    prepared_assets: list[tuple[dict[str, Any], str, BBox, Path]] = []
    for index, asset in enumerate(assets):
        if not isinstance(asset, dict):
            raise ValueError(f"assets[{index}] must be an object")
        name = output_name(asset.get("name"))
        if name.casefold() in seen_names:
            raise ValueError(f"duplicate asset name: {name}")
        seen_names.add(name.casefold())
        bbox = parse_bbox(asset)
        left, top, right, bottom = bbox
        if left < 0 or top < 0 or right > source.width or bottom > source.height:
            raise ValueError(f"asset {name} bbox {list(bbox)} is outside the source image")
        prepared_assets.append((asset, name, bbox, (output_dir / name).resolve()))

    protected_inputs = [("input image", input_path)]
    if plan_path is not None:
        protected_inputs.append(("plan", plan_path))
    protected_outputs = [
        (f"asset destination {name}", destination)
        for _, name, _, destination in prepared_assets
    ]
    if report_path is not None:
        protected_outputs.append(("report", report_path))
    validate_output_paths(protected_inputs, protected_outputs)

    output_dir.mkdir(parents=True, exist_ok=True)
    asset_reports: list[dict[str, Any]] = []
    any_warning = False

    for asset, name, bbox, destination in prepared_assets:
        left, top, right, bottom = bbox

        padding = parse_padding(inherited(asset, plan, "padding", 0))
        edge_guard = as_int(inherited(asset, plan, "edgeGuard", 2), "edgeGuard")
        tolerance = as_int(inherited(asset, plan, "tolerance", 12), "tolerance")
        content_threshold = as_int(
            inherited(asset, plan, "contentThreshold", 16), "contentThreshold"
        )
        if edge_guard < 0:
            raise ValueError("edgeGuard must be non-negative")
        if not 0 <= tolerance <= 255 or not 0 <= content_threshold <= 255:
            raise ValueError("tolerance and contentThreshold must be between 0 and 255")

        crop = source.crop(bbox)
        raw_background = inherited(asset, plan, "background", None)
        if raw_background is not None:
            background = parse_color(raw_background, "background")
            background_inference = {
                "source": "explicit",
                "sampleCount": 0,
                "supportCount": None,
                "confidence": None,
                "lowConfidence": False,
                "reviewRequired": False,
                "ringWidth": 0,
            }
        else:
            background, background_inference = infer_background(
                source, crop, bbox, content_threshold
            )
        raw_forbidden = inherited(asset, plan, "forbiddenColors", [])
        if isinstance(raw_forbidden, str):
            raw_forbidden = [raw_forbidden]
        if not isinstance(raw_forbidden, list):
            raise ValueError("forbiddenColors must be an array of colours")
        forbidden = [parse_color(value, "forbiddenColors") for value in raw_forbidden]

        foreground_mask = make_mask(crop, lambda pixel: colour_distance(pixel, background) > content_threshold)
        foreground_pixels = sum(sum(row) for row in foreground_mask)
        foreground_edges = edge_stats(foreground_mask, edge_guard)
        forbidden_details = []
        forbidden_detected = False
        for colour in forbidden:
            colour_mask = make_mask(crop, lambda pixel, target=colour: colour_distance(pixel, target) <= tolerance)
            stats = edge_stats(colour_mask, edge_guard)
            matched = sum(stats["counts"].values())
            forbidden_detected = forbidden_detected or matched > 0
            forbidden_details.append(
                {"color": color_hex(colour), "detected": matched > 0, "edgeMatches": stats}
            )

        output = add_padding(crop, padding, background)
        output_foreground = make_mask(
            output, lambda pixel: colour_distance(pixel, background) > content_threshold
        )
        output_edges = edge_stats(output_foreground, edge_guard)
        output.save(destination, format="PNG")

        warnings = []
        if background_inference["reviewRequired"]:
            warnings.append("background_inferred_review_required")
        if background_inference["lowConfidence"]:
            warnings.append("background_inference_low_confidence")
        if foreground_pixels == 0:
            warnings.append("no_foreground_detected")
        if foreground_edges["touches"]:
            warnings.append("foreground_touches_crop_edge")
        if forbidden_detected:
            warnings.append("forbidden_colour_on_crop_edge")
        any_warning = any_warning or bool(warnings)
        asset_reports.append(
            {
                "name": name,
                "outputPath": str(destination),
                "bbox": list(bbox),
                "coordinateConvention": "right_bottom_exclusive",
                "cropSize": [crop.width, crop.height],
                "padding": list(padding),
                "outputSize": [output.width, output.height],
                "background": color_hex(background),
                "backgroundReviewRequired": background_inference["reviewRequired"],
                "backgroundInference": background_inference,
                "foregroundPixelCount": foreground_pixels,
                "foregroundCropEdges": foreground_edges,
                "foregroundOutputEdges": output_edges,
                "forbiddenColorChecks": forbidden_details,
                "warnings": warnings,
            }
        )

    return (
        {
            "inputImage": str(input_path),
            "inputSize": [source.width, source.height],
            "outputDir": str(output_dir),
            "assetCount": len(asset_reports),
            "backgroundReviewRequiredCount": sum(
                item["backgroundReviewRequired"] for item in asset_reports
            ),
            "warningCount": sum(len(item["warnings"]) for item in asset_reports),
            "assetsWithWarnings": sum(bool(item["warnings"]) for item in asset_reports),
            "assets": asset_reports,
        },
        any_warning,
    )


def main() -> int:
    args = parse_args()
    try:
        report_path = Path(args.report).expanduser().resolve() if args.report else None
        if args.plan == "-":
            plan = json.load(sys.stdin)
            base_dir = Path.cwd()
            plan_path = None
        else:
            plan_path = Path(args.plan).expanduser().resolve()
            with plan_path.open("r", encoding="utf-8") as handle:
                plan = json.load(handle)
            base_dir = plan_path.parent
        if not isinstance(plan, dict):
            raise ValueError("plan root must be a JSON object")
        report, has_warning = process_plan(
            plan, base_dir, plan_path=plan_path, report_path=report_path
        )
        indent = 2 if args.pretty else None
        rendered = json.dumps(report, ensure_ascii=False, indent=indent)
        if report_path is not None:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(rendered + "\n", encoding="utf-8")
        print(rendered)
        return 2 if args.fail_on_warning and has_warning else 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
