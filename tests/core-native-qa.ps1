param([string]$Workspace = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$qaRoot = Join-Path $Workspace 'output\native-qa'
New-Item -ItemType Directory -Path $qaRoot -Force | Out-Null
$smokeFiles = @(Get-ChildItem -LiteralPath (Join-Path $Workspace 'output\smoke') -Filter '*.pptx' -File)
if ($smokeFiles.Count -ne 1) { throw 'Expected exactly one actual application-exported PPTX.' }
$sources = @(
  @{ Label = 'offline-example'; Path = Join-Path $Workspace 'tests\artifacts\offline-example-final.pptx' },
  @{ Label = 'electron-export'; Path = $smokeFiles[0].FullName }
)

function Read-ShapeEvidence($Shape, [string]$ParentName = '') {
  $record = [ordered]@{ Name = $Shape.Name; Type = [int]$Shape.Type; Parent = $ParentName; Left = [double]$Shape.Left; Top = [double]$Shape.Top; Width = [double]$Shape.Width; Height = [double]$Shape.Height }
  if ([int]$Shape.Type -eq 6) {
    $children = @()
    for ($idx = 1; $idx -le $Shape.GroupItems.Count; $idx++) { $children += Read-ShapeEvidence $Shape.GroupItems.Item($idx) $Shape.Name }
    $record.Children = $children
  } elseif ($Shape.HasTextFrame -eq -1 -and $Shape.TextFrame.HasText -eq -1) {
    $textRange = $Shape.TextFrame.TextRange
    $record.Text = $textRange.Text
    $runs = @()
    for ($runIdx = 1; $runIdx -le $textRange.Runs().Count; $runIdx++) {
      $run = $textRange.Runs($runIdx, 1)
      $runs += [ordered]@{ Text = $run.Text; Font = $run.Font.Name; FontSize = [double]$run.Font.Size; Italic = [int]$run.Font.Italic; Bold = [int]$run.Font.Bold }
    }
    $record.Runs = $runs
  }
  return $record
}
function Find-Shape($Collection, [string]$Name) {
  for ($idx = 1; $idx -le $Collection.Count; $idx++) {
    $shape = $Collection.Item($idx)
    if ($shape.Name -eq $Name) { return $shape }
    if ([int]$shape.Type -eq 6) {
      $nested = Find-Shape $shape.GroupItems $Name
      if ($null -ne $nested) { return $nested }
    }
  }
  return $null
}

$application = New-Object -ComObject PowerPoint.Application
$report = [ordered]@{ PowerPointVersion = $application.Version; CreatedAt = (Get-Date).ToString('o'); SourceChecks = @(); EditCheck = $null; ApplicationQuitCalled = $false }
try {
  foreach ($source in $sources) {
    $presentation = $null
    try {
      $sourceHashBefore = (Get-FileHash -LiteralPath $source.Path -Algorithm SHA256).Hash
      $presentation = $application.Presentations.Open($source.Path, -1, 0, 0)
      if ($presentation.Slides.Count -ne 1) { throw 'Expected one scientific figure slide.' }
      $renderFolder = Join-Path $qaRoot $source.Label
      New-Item -ItemType Directory -Path $renderFolder -Force | Out-Null
      $presentation.Export($renderFolder, 'PNG', 2400, 1280)
      $slide = $presentation.Slides.Item(1)
      $shapes = @()
      for ($idx = 1; $idx -le $slide.Shapes.Count; $idx++) { $shapes += Read-ShapeEvidence $slide.Shapes.Item($idx) }
      $report.SourceChecks += [ordered]@{ Label = $source.Label; Path = $source.Path; ReadOnly = [int]$presentation.ReadOnly; SourceHashBefore = $sourceHashBefore; SourceHashAfter = (Get-FileHash -LiteralPath $source.Path -Algorithm SHA256).Hash; SlideCount = $presentation.Slides.Count; WidthPt = [double]$presentation.PageSetup.SlideWidth; HeightPt = [double]$presentation.PageSetup.SlideHeight; RenderFolder = $renderFolder; Shapes = $shapes }
    } finally {
      if ($null -ne $presentation) { $presentation.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
    }
  }

  # Change only an owned copy. The user's original files are never saved or overwritten.
  $editedPath = Join-Path $qaRoot 'electron-export-edited-copy.pptx'
  Copy-Item -LiteralPath $smokeFiles[0].FullName -Destination $editedPath -Force
  $presentation = $null
  try {
    $presentation = $application.Presentations.Open($editedPath, 0, 0, 0)
    $slide = $presentation.Slides.Item(1)
    $formula = Find-Shape $slide.Shapes 'mk:eq-z'
    $group = Find-Shape $slide.Shapes 'vector-field'
    if ($null -eq $formula -or $null -eq $group) { throw 'Expected formula and editable group missing.' }
    $oldFormula = $formula.TextFrame.TextRange.Text
    $oldLeft = [double]$group.Left
    $formula.TextFrame.TextRange.Characters(1, 1).Text = 'q'
    $group.Left = $oldLeft + 5.0
    $presentation.Save()
  } finally {
    if ($null -ne $presentation) { $presentation.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
  }

  $presentation = $null
  try {
    $presentation = $application.Presentations.Open($editedPath, -1, 0, 0)
    $slide = $presentation.Slides.Item(1)
    $formula = Find-Shape $slide.Shapes 'mk:eq-z'
    $group = Find-Shape $slide.Shapes 'vector-field'
    $newFormula = $formula.TextFrame.TextRange.Text
    $newLeft = [double]$group.Left
    $editPassed = $newFormula -eq 'q(t)' -and [Math]::Abs($newLeft - $oldLeft - 5.0) -lt 0.01 -and [int]$group.Type -eq 6
    if (-not $editPassed) { throw 'Edited formula/group failed save-and-reopen verification.' }
    $renderFolder = Join-Path $qaRoot 'electron-export-edited-copy'
    New-Item -ItemType Directory -Path $renderFolder -Force | Out-Null
    $presentation.Export($renderFolder, 'PNG', 2400, 1280)
    $report.EditCheck = [ordered]@{ File = $editedPath; Passed = $editPassed; PreviousFormula = $oldFormula; ReopenedFormula = $newFormula; FormulaEvidence = (Read-ShapeEvidence $formula); PreviousGroupLeftPt = $oldLeft; ReopenedGroupLeftPt = $newLeft; MovedByPt = $newLeft - $oldLeft; GroupType = [int]$group.Type; GroupChildCount = $group.GroupItems.Count; RenderFolder = $renderFolder }
  } finally {
    if ($null -ne $presentation) { $presentation.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
  }
  $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $qaRoot 'powerpoint-native-report.json') -Encoding utf8
  $report.EditCheck | ConvertTo-Json
} finally {
  # Intentionally do not call Application.Quit(): user presentations must remain untouched.
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($application)
}
