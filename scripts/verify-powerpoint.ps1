param([Parameter(Mandatory=$true)][string]$Report)
$ErrorActionPreference = 'Stop'
$result = Get-Content -LiteralPath $Report -Raw -Encoding UTF8 | ConvertFrom-Json
$out = Join-Path (Split-Path -Parent $Report) 'powerpoint-check'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$source = $result.files | Where-Object { $_.EndsWith('.pptx') } | Select-Object -First 1
$copy = Join-Path $out 'editable-roundtrip.pptx'
if (Test-Path -LiteralPath $copy) { throw 'Verification copy already exists; keep prior evidence.' }
Copy-Item -LiteralPath $source -Destination $copy
$existingPowerPoint = @(Get-Process POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
$powerPoint = New-Object -ComObject PowerPoint.Application
$presentation = $null
function Find-TextShapes($shapes) {
  foreach ($shape in $shapes) {
    if ($shape.Type -eq 6) { Find-TextShapes $shape.GroupItems }
    elseif ($shape.HasTextFrame -and $shape.TextFrame.HasText) { $shape }
  }
}
try {
  $presentation = $powerPoint.Presentations.Open($copy, 0, 0, 0)
  $slide = $presentation.Slides.Item(1)
  $image = Join-Path $out 'powerpoint-render.png'
  $width = 2400
  $height = [int][Math]::Round($width * $presentation.PageSetup.SlideHeight / $presentation.PageSetup.SlideWidth)
  $slide.Export($image, 'PNG', $width, $height)
  $texts = @(Find-TextShapes $slide.Shapes)
  $target = $texts | Where-Object { $_.TextFrame.TextRange.Text.Trim() -eq 'Initial state' } | Select-Object -First 1
  if ($null -eq $target) { throw 'Editable Initial state label not found.' }
  $target.TextFrame.TextRange.Text = 'Initial state (edit verified)'
  $presentation.Save()
  $presentation.Close()
  $presentation = $powerPoint.Presentations.Open($copy, 0, 0, 0)
  $reopened = @(Find-TextShapes $presentation.Slides.Item(1).Shapes)
  $found = @($reopened | Where-Object { $_.TextFrame.TextRange.Text.Trim() -eq 'Initial state (edit verified)' }).Count
  if ($found -ne 1) { throw 'Edited text failed to survive save/reopen.' }
  $check = @{ passed=$true; application='Microsoft PowerPoint'; version=$powerPoint.Version; slides=$presentation.Slides.Count; editableTextObjects=$texts.Count; editSaveReopen=$true; renderedWidth=$width; renderedHeight=$height; render=$image; originalUntouched=$true }
  $check | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'result.json') -Encoding UTF8
  $check | ConvertTo-Json
} finally {
  if ($null -ne $presentation) { $presentation.Close() }
  if (-not $existingPowerPoint -and $powerPoint.Presentations.Count -eq 0) { $powerPoint.Quit() }
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint)
}
