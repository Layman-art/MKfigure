param(
  [Parameter(Mandatory = $true)][string]$PptxPath,
  [Parameter(Mandatory = $true)][string]$ScenePath,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$pptx = (Resolve-Path -LiteralPath $PptxPath).Path
$scene = Get-Content -LiteralPath $ScenePath -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = (Resolve-Path -LiteralPath $OutputDirectory).Path
$expected = @{}
foreach ($element in $scene.elements) { $expected['mk:' + $element.id] = $element }

function Read-TextLayout($Shapes) {
  for ($index = 1; $index -le $Shapes.Count; $index++) {
    $shape = $Shapes.Item($index)
    if ([int]$shape.Type -eq 6) { Read-TextLayout $shape.GroupItems; continue }
    $element = $expected[$shape.Name]
    if ($null -eq $element) { throw "Unknown shape: $($shape.Name)" }
    if ($element.type -ne 'text') { continue }
    $range = $shape.TextFrame2.TextRange
    $actualText = $range.Text.Replace("`r`n", "`n").Replace("`r", "`n").Replace([char]11, [char]10)
    if ($actualText -cne $element.text) { throw "Text changed: $($shape.Name)" }
    $lineCount = $range.Lines().Count
    $expectedLines = $element.text.Split("`n").Count
    if ($lineCount -ne $expectedLines) { throw "Unexpected line wrap: $($shape.Name): $lineCount lines; expected $expectedLines" }
    if ([int]$shape.TextFrame.WordWrap -ne 0) { throw "Automatic wrapping enabled: $($shape.Name)" }
    [ordered]@{ Id = $element.id; Text = $actualText; Lines = $lineCount; Font = $range.Font.Name; FontSizePt = [double]$range.Font.Size }
  }
}
function Find-Shape($Shapes, [string]$Name) {
  for ($index = 1; $index -le $Shapes.Count; $index++) {
    $shape = $Shapes.Item($index)
    if ($shape.Name -eq $Name) { return $shape }
    if ([int]$shape.Type -eq 6) {
      $found = Find-Shape $shape.GroupItems $Name
      if ($null -ne $found) { return $found }
    }
  }
  return $null
}
$hash = (Get-FileHash -LiteralPath $pptx -Algorithm SHA256).Hash
$application = New-Object -ComObject PowerPoint.Application
$presentation = $null
try {
  $presentation = $application.Presentations.Open($pptx, -1, 0, 0)
  $slide = $presentation.Slides.Item(1)
  $records = @(Read-TextLayout $slide.Shapes)
  $expectedCount = @($scene.elements | Where-Object type -eq 'text').Count
  if ($records.Count -ne $expectedCount) { throw 'Missing native text objects' }
  $slide.Export((Join-Path $output 'powerpoint-render.png'), 'PNG', [int]$scene.width, [int]$scene.height)
  $presentation.Close()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  $presentation = $null

  # Verify genuine editability in an owned copy, never by saving the source file.
  $editedPath = Join-Path $output 'edited-copy.pptx'
  if ($editedPath -eq $pptx) { throw 'Edited copy must differ from source' }
  Copy-Item -LiteralPath $pptx -Destination $editedPath -Force
  $presentation = $application.Presentations.Open($editedPath, 0, 0, 0)
  $firstText = $scene.elements | Where-Object type -eq 'text' | Select-Object -First 1
  $shape = Find-Shape $presentation.Slides.Item(1).Shapes ('mk:' + $firstText.id)
  $shape.TextFrame.TextRange.Text = 'Editable check'
  $presentation.Save()
  $presentation.Close()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  $presentation = $application.Presentations.Open($editedPath, -1, 0, 0)
  $shape = Find-Shape $presentation.Slides.Item(1).Shapes ('mk:' + $firstText.id)
  if ($shape.TextFrame.TextRange.Text -cne 'Editable check') { throw 'Text edit failed save/reopen' }
  if ((Get-FileHash -LiteralPath $pptx -Algorithm SHA256).Hash -ne $hash) { throw 'Source unexpectedly changed' }
  $report = [ordered]@{ PowerPointVersion = $application.Version; TextCount = $records.Count; UnexpectedWraps = 0; EditableSaveReopen = $true; SourceUnchanged = $true; Shapes = $records }
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $output 'native-layout-report.json') -Encoding utf8
  [pscustomobject]$report | Select-Object PowerPointVersion, TextCount, UnexpectedWraps, EditableSaveReopen, SourceUnchanged | ConvertTo-Json
} finally {
  if ($null -ne $presentation) { $presentation.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
  # Do not quit PowerPoint: the user may have unrelated presentations open.
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($application)
}
