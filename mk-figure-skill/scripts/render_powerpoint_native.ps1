[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$InputPptx,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputDir,

    [Parameter(Mandatory = $false)]
    [ValidateRange(1, 100000)]
    [int[]]$Slides,

    [Parameter(Mandatory = $false)]
    [ValidateRange(320, 8192)]
    [int]$Width = 1920
)

$ErrorActionPreference = 'Stop'
if (Get-Process -Name POWERPNT -ErrorAction SilentlyContinue) {
    throw 'Save and close all PowerPoint windows before rendering. Existing PowerPoint sessions will not be used or closed.'
}
$inputPath = [System.IO.Path]::GetFullPath($InputPptx)
if (-not [System.IO.File]::Exists($inputPath)) {
    throw "Input PowerPoint file does not exist: $inputPath"
}
$extension = [System.IO.Path]::GetExtension($inputPath).ToLowerInvariant()
if ($extension -notin @('.pptx', '.ppsx')) {
    throw "Input must be a non-macro PowerPoint Open XML presentation (.pptx or .ppsx): $inputPath"
}

$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
[System.IO.Directory]::CreateDirectory($outputPath) | Out-Null

$powerPoint = $null
$presentationsCollection = $null
$presentation = $null
$slidesCollection = $null
$pageSetup = $null
$slide = $null
$exported = [System.Collections.Generic.List[object]]::new()

try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
    if ($powerPoint.Presentations.Count -gt 0) {
        throw 'PowerPoint already contains an open presentation. Stop and close it before retrying.'
    }

    # msoAutomationSecurityForceDisable = 3. Set this before opening any file,
    # even though macro-enabled formats are rejected above.
    $powerPoint.AutomationSecurity = 3

    # MsoTriState: -1 = true, 0 = false. Open a private, read-only,
    # windowless presentation and never call Save or SaveAs.
    $presentationsCollection = $powerPoint.Presentations
    $presentation = $presentationsCollection.Open($inputPath, -1, 0, 0)
    $slidesCollection = $presentation.Slides
    $slideCount = [int]$slidesCollection.Count
    if ($slideCount -lt 1) {
        throw 'The presentation contains no slides.'
    }

    if ($null -eq $Slides -or $Slides.Count -eq 0) {
        $requestedSlides = 1..$slideCount
    }
    else {
        $requestedSlides = @($Slides | Sort-Object -Unique)
        $invalidSlides = @($requestedSlides | Where-Object { $_ -lt 1 -or $_ -gt $slideCount })
        if ($invalidSlides.Count -gt 0) {
            throw "Requested slide numbers are outside 1..${slideCount}: $($invalidSlides -join ', ')"
        }
    }

    $pageSetup = $presentation.PageSetup
    $slideWidth = [double]$pageSetup.SlideWidth
    $slideHeight = [double]$pageSetup.SlideHeight
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($pageSetup)
    $pageSetup = $null
    if ($slideWidth -le 0 -or $slideHeight -le 0) {
        throw 'PowerPoint returned an invalid slide size.'
    }
    $height = [Math]::Max(1, [int][Math]::Round($Width * $slideHeight / $slideWidth))

    foreach ($slideNumber in $requestedSlides) {
        try {
            $slide = $slidesCollection.Item([int]$slideNumber)
            $fileName = 'slide-{0}.png' -f $slideNumber
            $filePath = [System.IO.Path]::Combine($outputPath, $fileName)
            if ([System.IO.File]::Exists($filePath)) {
                throw "Refusing to overwrite an existing render target: $filePath"
            }
            $slide.Export($filePath, 'PNG', $Width, $height)
            if (-not [System.IO.File]::Exists($filePath)) {
                throw "PowerPoint did not create the expected render: $filePath"
            }
            $exported.Add([ordered]@{
                slide = [int]$slideNumber
                path = $filePath
                width = $Width
                height = $height
            })
        }
        finally {
            if ($null -ne $slide) {
                [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($slide)
                $slide = $null
            }
        }
    }

    [ordered]@{
        input = $inputPath
        outputDirectory = $outputPath
        slideCount = $slideCount
        renderedCount = $exported.Count
        renders = $exported
    } | ConvertTo-Json -Depth 5
}
finally {
    if ($null -ne $slide) {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($slide)
        $slide = $null
    }
    if ($null -ne $pageSetup) {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($pageSetup)
        $pageSetup = $null
    }
    if ($null -ne $slidesCollection) {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($slidesCollection)
        $slidesCollection = $null
    }
    if ($null -ne $presentation) {
        try { $presentation.Close() } catch { Write-Warning "Could not close presentation cleanly: $_" }
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation)
        $presentation = $null
    }
    if ($null -ne $presentationsCollection) {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentationsCollection)
        $presentationsCollection = $null
    }
    if ($null -ne $powerPoint) {
        try {
            if ($powerPoint.Presentations.Count -eq 0) { $powerPoint.Quit() }
            else { Write-Warning 'PowerPoint now has another open presentation; leaving the application running.' }
        } catch { Write-Warning "Could not close the private PowerPoint session cleanly: $_" }
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint)
        $powerPoint = $null
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
