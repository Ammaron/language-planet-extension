# Build script for Langsly Vocab Pass extension on Windows.
# Creates browser-specific builds in dist/chrome and dist/firefox, plus a Chrome Web Store ZIP.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dist = Join-Path $ScriptDir 'dist'
$ChromeDist = Join-Path $Dist 'chrome'
$FirefoxDist = Join-Path $Dist 'firefox'

$resolvedScriptDir = [System.IO.Path]::GetFullPath($ScriptDir)
$resolvedDist = [System.IO.Path]::GetFullPath($Dist)
$scriptDirWithSeparator = $resolvedScriptDir.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar

if (-not $resolvedDist.StartsWith($scriptDirWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean unexpected dist path: $resolvedDist"
}

$sharedFiles = @(
  'vendor/browser-polyfill.min.js',
  'background/theme-utils.js',
  'background/service-worker.js',
  'content/grammar-rules.js',
  'content/matcher.js',
  'content/popup.js',
  'content/content.js',
  'content/content.css',
  'popup/popup.html',
  'popup/popup.js',
  'popup/popup.css',
  'popup/options.html',
  'popup/options.js',
  'popup/options.css',
  'popup/onboarding.html',
  'popup/onboarding.js',
  'popup/onboarding.css',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png'
)

function Copy-SharedFiles {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Target
  )

  foreach ($file in $sharedFiles) {
    $source = Join-Path $ScriptDir $file
    if (-not (Test-Path -LiteralPath $source)) {
      throw "Missing build input: $file"
    }

    $destination = Join-Path $Target $file
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination
  }
}

if (Test-Path -LiteralPath $Dist) {
  Remove-Item -LiteralPath $Dist -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $ChromeDist, $FirefoxDist | Out-Null

Copy-SharedFiles -Target $ChromeDist
Copy-Item -LiteralPath (Join-Path $ScriptDir 'manifest.json') -Destination (Join-Path $ChromeDist 'manifest.json')
Write-Host "Chrome build: $ChromeDist"

Copy-SharedFiles -Target $FirefoxDist

$manifestPath = Join-Path $ScriptDir 'manifest.json'
$firefoxManifestPath = Join-Path $FirefoxDist 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

$manifest.background.PSObject.Properties.Remove('service_worker')
$manifest.background | Add-Member -NotePropertyName 'scripts' -NotePropertyValue @(
  'vendor/browser-polyfill.min.js',
  'background/theme-utils.js',
  'background/service-worker.js'
) -Force
$manifest | Add-Member -NotePropertyName 'browser_specific_settings' -NotePropertyValue @{
  gecko = @{
    id = 'vocabpass@languageplanet.app'
    strict_min_version = '109.0'
  }
} -Force

$firefoxManifestJson = $manifest | ConvertTo-Json -Depth 10
# Windows PowerShell 5.1 escapes < and > by default; keep manifest match patterns readable.
$firefoxManifestJson = $firefoxManifestJson -replace '\\u003c', '<' -replace '\\u003e', '>'
$firefoxManifestJson | Set-Content -LiteralPath $firefoxManifestPath -Encoding UTF8
Write-Host "Firefox build: $FirefoxDist"

$version = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).version
$zipPath = Join-Path $Dist "langsly-vocab-pass-chrome-$version.zip"
Compress-Archive -Path (Join-Path $ChromeDist '*') -DestinationPath $zipPath -Force
Write-Host "Chrome Web Store ZIP: $zipPath"

Write-Host ''
Write-Host 'Load instructions:'
Write-Host "  Chrome:  chrome://extensions -> Load unpacked -> $ChromeDist"
Write-Host "  Firefox: about:debugging -> Load Temporary Add-on -> $firefoxManifestPath"
