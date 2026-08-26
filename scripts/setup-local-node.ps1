param(
  [ValidatePattern("^\d+\.\d+\.\d+$")]
  [string]$Version = "22.22.3",
  [ValidatePattern("^[A-Fa-f0-9]{64}$")]
  [string]$ExpectedSha256 = "6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33",
  [string]$ToolsDir = ".tools"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Get-FullPath {
  param([string]$PathValue)
  return [System.IO.Path]::GetFullPath($PathValue)
}

function Assert-InRepo {
  param([string]$PathValue)

  $fullPath = Get-FullPath $PathValue
  $root = $repoRoot.TrimEnd("\")
  $rootPrefix = "$root\"

  if (
    $fullPath -ne $root -and
    -not $fullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "Refusing to touch path outside the repository: $fullPath"
  }

  return $fullPath
}

$toolsRoot = Assert-InRepo (Join-Path $repoRoot $ToolsDir)
$cacheRoot = Assert-InRepo (Join-Path $toolsRoot "cache")
$nodeRoot = Assert-InRepo (Join-Path $toolsRoot "node")

New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null

$releaseVersion = "v$Version"
$zipName = "node-$releaseVersion-win-x64.zip"
$distUrl = "https://nodejs.org/dist/$releaseVersion"
$zipPath = Assert-InRepo (Join-Path $cacheRoot $zipName)
$partialZipPath = Assert-InRepo "$zipPath.partial"
$extractRoot = Assert-InRepo (Join-Path $cacheRoot "extract-$releaseVersion")

if (-not (Test-Path -LiteralPath $zipPath)) {
  if (Test-Path -LiteralPath $partialZipPath) {
    Remove-Item -LiteralPath $partialZipPath -Force
  }

  Write-Host "Downloading pinned Node.js $releaseVersion..."
  Invoke-WebRequest -Uri "$distUrl/$zipName" -OutFile $partialZipPath
  Move-Item -LiteralPath $partialZipPath -Destination $zipPath
}

Write-Host "Verifying pinned SHA256..."
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
if ($actualHash -ne $ExpectedSha256.ToLowerInvariant()) {
  throw "SHA256 mismatch for $zipName."
}

if (Test-Path -LiteralPath $extractRoot) {
  Assert-InRepo $extractRoot | Out-Null
  Remove-Item -LiteralPath $extractRoot -Recurse -Force
}

Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

$extractedNodeRoot = Assert-InRepo (Join-Path $extractRoot "node-$releaseVersion-win-x64")
if (-not (Test-Path -LiteralPath $extractedNodeRoot)) {
  throw "Extracted Node.js folder was not found: $extractedNodeRoot"
}

if (Test-Path -LiteralPath $nodeRoot) {
  Assert-InRepo $nodeRoot | Out-Null
  Remove-Item -LiteralPath $nodeRoot -Recurse -Force
}

Move-Item -LiteralPath $extractedNodeRoot -Destination $nodeRoot

$nodeExe = Join-Path $nodeRoot "node.exe"
$npmCmd = Join-Path $nodeRoot "npm.cmd"

Write-Host "Installed Node.js to $nodeRoot"
$installedVersion = (& $nodeExe --version | Select-Object -First 1).Trim()
if ($installedVersion -ne $releaseVersion) {
  throw "Installed Node.js version mismatch: expected $releaseVersion, got $installedVersion"
}

Write-Host $installedVersion
$installedNpmVersion = (& $npmCmd --version | Select-Object -First 1).Trim()
if ($Version -eq "22.22.3" -and $installedNpmVersion -ne "10.9.8") {
  throw "Installed npm version mismatch: expected 10.9.8, got $installedNpmVersion"
}

Write-Host $installedNpmVersion
