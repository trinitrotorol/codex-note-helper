param(
  [int]$Major = 22,
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

$indexUrl = "https://nodejs.org/dist/index.json"
$releases = Invoke-RestMethod -Uri $indexUrl
$release = $releases |
  Where-Object {
    $_.version -match "^v$Major\." -and
    $_.files -contains "win-x64-zip"
  } |
  Select-Object -First 1

if (-not $release) {
  throw "Could not find a Node.js v$Major Windows x64 release."
}

$version = $release.version
$zipName = "node-$version-win-x64.zip"
$distUrl = "https://nodejs.org/dist/$version"
$zipPath = Assert-InRepo (Join-Path $cacheRoot $zipName)
$extractRoot = Assert-InRepo (Join-Path $cacheRoot "extract-$version")

Write-Host "Downloading $zipName..."
Invoke-WebRequest -Uri "$distUrl/$zipName" -OutFile $zipPath

Write-Host "Verifying SHA256..."
$shasums = Invoke-RestMethod -Uri "$distUrl/SHASUMS256.txt"
$expectedHash = ($shasums -split "`n" |
  Where-Object { $_ -match "\s$([regex]::Escape($zipName))$" } |
  Select-Object -First 1) -split "\s+" |
  Select-Object -First 1

if (-not $expectedHash) {
  throw "Could not find SHA256 entry for $zipName."
}

$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash.ToLowerInvariant()) {
  throw "SHA256 mismatch for $zipName."
}

if (Test-Path -LiteralPath $extractRoot) {
  Assert-InRepo $extractRoot | Out-Null
  Remove-Item -LiteralPath $extractRoot -Recurse -Force
}

Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

$extractedNodeRoot = Assert-InRepo (Join-Path $extractRoot "node-$version-win-x64")
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
& $nodeExe --version
& $npmCmd --version
