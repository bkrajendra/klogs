# Installs the klogs binary for Windows from GitHub Releases.
#
#   irm https://raw.githubusercontent.com/bkrajendra/klogs/main/install.ps1 | iex
#
# Env vars:
#   KLOGS_VERSION      version tag to install, e.g. v0.1.1 (default: latest release)
#   KLOGS_INSTALL_DIR  directory to install into (default: %LOCALAPPDATA%\Programs\klogs)
$ErrorActionPreference = "Stop"

$Repo = "bkrajendra/klogs"
$Binary = "klogs"

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }

$Version = $env:KLOGS_VERSION
if (-not $Version) {
  Write-Host "Resolving latest klogs release..."
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
  $Version = $release.tag_name
}
if (-not $Version) {
  throw "could not determine the latest klogs version (set KLOGS_VERSION to pin one)"
}

$Archive = "${Binary}_windows_${arch}.zip"
$BaseUrl = "https://github.com/$Repo/releases/download/$Version"

$Tmp = (New-Item -ItemType Directory -Path (Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid()))).FullName
try {
  Write-Host "Downloading klogs $Version for windows/$arch..."
  Invoke-WebRequest -Uri "$BaseUrl/$Archive" -OutFile (Join-Path $Tmp $Archive)
  Invoke-WebRequest -Uri "$BaseUrl/checksums.txt" -OutFile (Join-Path $Tmp "checksums.txt")

  Write-Host "Verifying checksum..."
  $checksumLine = Select-String -Path (Join-Path $Tmp "checksums.txt") -Pattern ([regex]::Escape($Archive))
  if (-not $checksumLine) {
    throw "no checksum entry for $Archive in checksums.txt"
  }
  $expected = ($checksumLine.Line -split '\s+')[0]
  $actual = (Get-FileHash (Join-Path $Tmp $Archive) -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) {
    throw "checksum mismatch for ${Archive}: expected $expected, got $actual"
  }
  Write-Host "Checksum OK."

  Expand-Archive -Path (Join-Path $Tmp $Archive) -DestinationPath $Tmp -Force

  $InstallDir = $env:KLOGS_INSTALL_DIR
  if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\klogs" }
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Move-Item -Path (Join-Path $Tmp "$Binary.exe") -Destination (Join-Path $InstallDir "$Binary.exe") -Force

  Write-Host "Installed to $InstallDir\$Binary.exe"

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $pathEntries = @()
  if ($userPath) { $pathEntries = $userPath -split ";" }
  if ($pathEntries -notcontains $InstallDir) {
    $newPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "Added $InstallDir to your user PATH. Restart your terminal for it to take effect."
  }

  Write-Host ""
  Write-Host "Run '$Binary --version' to verify, then '$Binary --open' to launch the web UI."
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
