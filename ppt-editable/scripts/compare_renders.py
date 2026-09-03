#!/usr/bin/env python3
"""Compare two same-size PNG renders and optionally enforce allowed regions."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


BBox = tuple[int, int, int, int]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Compare a baseline PNG with a revised PNG. A pixel differs when the "
            "largest RGBA channel difference exceeds --threshold."
        ),
        epilog=(
            "Allowed ROI coordinates are [left, top, right, bottom], with right "
            "and bottom excluded. Repeat --allowed-roi to allow multiple regions."
        ),
    )
    parser.add_argument("baseline", help="Baseline PNG")
    parser.add_argument("revised", help="Revised PNG")
    parser.add_argument(
        "--allowed-roi",
        metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"),
        nargs=4,
        action="append",
        type=int,
        help="Region where changes are permitted; may be repeated",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=0,
        help="Ignore per-channel differences at or below this value (default: 0)",
    )
    parser.add_argument("--diff-image", help="Write a black/yellow/red PNG difference map")
    parser.add_argument("--report", help="Also write the JSON report to this path")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print the JSON report")
    parser.add_argument(
        "--fail-outside-roi",
        action="store_true",
        help="Exit with status 2 when changed pixels exist outside the allowed ROI(s)",
    )
    return parser.parse_args()


def validate_roi(values: list[int], width: int, height: int) -> BBox:
    left, top, right, bottom = values
    if left < 0 or top < 0 or right > width or bottom > height:
        raise ValueError(f"allowed ROI {values} is outside the {width}x{height} image")
    if right <= left or bottom <= top:
        raise ValueError(f"allowed ROI {values} must satisfy right > left and bottom > top")
    return left, top, right, bottom


def include_in_bbox(bbox: BBox | None, x: int, y: int) -> BBox:
    """Expand a right/bottom-exclusive bounding box to include one pixel."""
    if bbox is None:
        return x, y, x + 1, y + 1
    left, top, right, bottom = bbox
    return min(left, x), min(top, y), max(right, x + 1), max(bottom, y + 1)


def serialized_bbox(bbox: BBox | None) -> list[int] | None:
    return list(bbox) if bbox is not None else None


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


def inside_any_roi(x: int, y: int, rois: list[BBox]) -> bool:
    return any(left <= x < right and top <= y < bottom for left, top, right, bottom in rois)


def compare(
    baseline_path: Path,
    revised_path: Path,
    rois: list[BBox],
    threshold: int,
    diff_path: Path | None,
) -> dict[str, Any]:
    if not baseline_path.is_file():
        raise ValueError(f"baseline does not exist: {baseline_path}")
    if not revised_path.is_file():
        raise ValueError(f"revised image does not exist: {revised_path}")
    baseline = Image.open(baseline_path).convert("RGBA")
    revised = Image.open(revised_path).convert("RGBA")
    if baseline.size != revised.size:
        raise ValueError(f"image sizes differ: baseline={baseline.size}, revised={revised.size}")

    width, height = baseline.size
    baseline_pixels = baseline.load()
    revised_pixels = revised.load()
    changed_pixels = 0
    outside_pixels = 0
    changed_bbox: BBox | None = None
    outside_bbox: BBox | None = None
    sum_absolute = 0
    changed_absolute = 0
    max_channel_difference = 0
    heatmap = Image.new("RGB", (width, height), "black") if diff_path else None
    heat_pixels = heatmap.load() if heatmap else None

    for y in range(height):
        for x in range(width):
            differences = [abs(baseline_pixels[x, y][i] - revised_pixels[x, y][i]) for i in range(4)]
            pixel_max = max(differences)
            pixel_sum = sum(differences)
            sum_absolute += pixel_sum
            max_channel_difference = max(max_channel_difference, pixel_max)
            if pixel_max <= threshold:
                continue
            changed_pixels += 1
            changed_bbox = include_in_bbox(changed_bbox, x, y)
            changed_absolute += pixel_sum
            allowed = not rois or inside_any_roi(x, y, rois)
            if rois and not allowed:
                outside_pixels += 1
                outside_bbox = include_in_bbox(outside_bbox, x, y)
            if heat_pixels is not None:
                intensity = max(64, pixel_max)
                heat_pixels[x, y] = (intensity, intensity, 0) if allowed else (intensity, 0, 0)

    if heatmap is not None and diff_path is not None:
        if rois:
            draw = ImageDraw.Draw(heatmap)
            for left, top, right, bottom in rois:
                draw.rectangle((left, top, right - 1, bottom - 1), outline=(0, 255, 255), width=1)
        diff_path.parent.mkdir(parents=True, exist_ok=True)
        heatmap.save(diff_path, format="PNG")

    total_pixels = width * height
    total_channels = total_pixels * 4
    inside_pixels = changed_pixels - outside_pixels if rois else None
    return {
        "baseline": str(baseline_path),
        "revised": str(revised_path),
        "size": [width, height],
        "threshold": threshold,
        "coordinateConvention": "right_bottom_exclusive",
        "totalPixels": total_pixels,
        "changedPixels": changed_pixels,
        "changedPercent": round(changed_pixels * 100 / total_pixels, 8) if total_pixels else 0.0,
        "differenceBBox": serialized_bbox(changed_bbox),
        "maxChannelDifference": max_channel_difference,
        "meanAbsoluteChannelDifference": round(sum_absolute / total_channels, 8) if total_channels else 0.0,
        "meanAbsoluteChannelDifferenceOnChangedPixels": (
            round(changed_absolute / (changed_pixels * 4), 8) if changed_pixels else 0.0
        ),
        "roiApplied": bool(rois),
        "allowedRois": [list(roi) for roi in rois],
        "insideAllowedRoiChangedPixels": inside_pixels,
        "outsideAllowedRoiChangedPixels": outside_pixels if rois else None,
        "outsideAllowedRoiDifferenceBBox": serialized_bbox(outside_bbox) if rois else None,
        "diffImage": str(diff_path) if diff_path else None,
    }


def main() -> int:
    args = parse_args()
    try:
        if args.threshold < 0 or args.threshold > 255:
            raise ValueError("threshold must be between 0 and 255")
        baseline_path = Path(args.baseline).expanduser().resolve()
        revised_path = Path(args.revised).expanduser().resolve()
        diff_path = Path(args.diff_image).expanduser().resolve() if args.diff_image else None
        report_path = Path(args.report).expanduser().resolve() if args.report else None
        outputs = []
        if diff_path is not None:
            outputs.append(("diff image", diff_path))
        if report_path is not None:
            outputs.append(("report", report_path))
        validate_output_paths(
            [("baseline", baseline_path), ("revised image", revised_path)], outputs
        )
        with Image.open(baseline_path) as image:
            width, height = image.size
        rois = [validate_roi(values, width, height) for values in (args.allowed_roi or [])]
        if args.fail_outside_roi and not rois:
            raise ValueError("--fail-outside-roi requires at least one --allowed-roi")
        report = compare(baseline_path, revised_path, rois, args.threshold, diff_path)
        indent = 2 if args.pretty else None
        rendered = json.dumps(report, ensure_ascii=False, indent=indent)
        if report_path is not None:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(rendered + "\n", encoding="utf-8")
        print(rendered)
        outside = report["outsideAllowedRoiChangedPixels"]
        return 2 if args.fail_outside_roi and outside else 0
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
