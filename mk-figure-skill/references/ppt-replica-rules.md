# Replica and surgical-repair rules

Read this for route B or route C.

## Region map

If the reference is not a native-size slide render, calculate horizontal and
vertical scale independently and account for letterboxing or cropping.

For a full build, record each meaningful region's role, reference and slide
bounds, exact copy, native/raster choice, source asset, target frame, background
policy, z-order, connector relationships, and QA region. Repeated components
share one geometry and style definition.

Finish the region map, text audit, asset review, and connector graph before the
first complete PPTX. For a local repair, record only the target's rendered
coordinates, native shape or media relationship, direct dependencies, allowed
difference region, and non-target boundary.

## Truthful structure

Choose the simplest structure that preserves the promised editability:

1. native text or shape;
2. clean image plus editable text;
3. preserved or verified native group;
4. picture-fill AutoShape with editable text;
5. intentional raster region accepted as non-editable.

When separating artwork from text, create a clean asset with obsolete glyphs
and structural lines removed before placing native text. Do not hide them on the
slide.

Preserve real groups. If a new group is required, verify native GroupItems
behavior; stacked objects are not a group. When an image and title only need to
move together and reliable grouping is unavailable, use one picture-fill
AutoShape with editable text.

## Media, crop, and background

Prefer original PPT media over screenshot crops. Preserve aspect ratio and reset
inherited crop state when replacing an image.

Evaluate the raw crop before padding. Padding adds whitespace but cannot restore
an already clipped silhouette.

For each raster asset:

- include the complete antialiased subject and a small safe margin;
- keep source crop, subject bounds, target frame, and final visible bounds
  distinct;
- exclude neighboring labels, arrows, borders, dividers, and neighboring-object
  shadows while preserving the subject's own shadow;
- determine whether a reported defect belongs to the media or an adjacent native
  object before recropping;
- choose alpha, exact_fill (match the target fill exactly), or retain as the
  background policy;
- clean and pad the subject when expanding the crop would capture a neighbor;
- inspect the raw asset and final placement at enlarged scale.

Do not place an asset while a raw-edge warning or neighbor contamination remains
unresolved. A documented exception must prove the subject is complete; adding
padding alone is not proof.

Reject clipped edges, halos, rectangular tints, embedded card lines, and visible
seams. When transparency matters, preview on both the target background and a
contrasting background.

Use scripts/crop_reference_assets.py for repeated crop and edge checks.

## Connector integrity

Main logical paths are native. Record source, target, route, direction, dash,
color, width, and z-order.

Create connectors after final object geometry. Attach endpoints to visible
object boundaries, not unused frame edges, and recalculate them after moves or
resizes. Raster images and masks must not interrupt a bus or dashed path.

Test one representative connector in native PowerPoint before repeating a
pattern. Confirm arrow direction, joins, line ends, and stacking.

## Surgical-repair delta guard

Capture a baseline, check whether the media part is shared by other placements,
change only the identified object or dependency, and compare
the relevant levels:

- semantic objects, including text, geometry, names, and z-order;
- media and relationships;
- native-render pixels inside and outside the allowed region.

Use scripts/compare_pptx_semantics.py and scripts/compare_renders.py when
non-target preservation is required. Investigate every unexplained object,
media, or out-of-region pixel change. Do not rebuild an acceptable slide for one
crop, label, connector, font, or alignment defect.

## Native review

Reopen the saved PPTX and treat native PowerPoint rendering as the visual truth
when available. Inspect the full slide, then modified and high-risk regions at
200 to 400 percent.

Check silhouettes, line ends, one-pixel seams, borders, repeated spacing, text
fit, font weight and italic, formula baselines, list behavior, image background,
aspect ratio, ghost content, connector continuity, direction, and endpoint
clearance.

If the artifact preview and native PowerPoint render disagree, diagnose export
or compatibility before making pixel-level layout changes.
