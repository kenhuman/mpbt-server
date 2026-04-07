# Applies the local two-GUI validation patch to a sandbox copy of MPBTWIN.EXE.
# Do not run this against an original installation copy; use a disposable client
# directory and keep the executable name exactly MPBTWIN.EXE.
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,

  [switch]$Revert
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$target = (Resolve-Path -LiteralPath $Path).Path
if ([IO.Path]::GetFileName($target) -cne 'MPBTWIN.EXE') {
  throw 'Target path must end in MPBTWIN.EXE. Renamed executables trip the client startup check.'
}

$backup = "$target.pre-two-gui-patch.bak"

$patches = @(
  @{
    Name = 'single-instance guard'
    Offset = 0x28388
    Original = 0x74
    Patched = 0xEB
  },
  @{
    Name = 'second-client SetDisplayMode failure branch'
    Offset = 0x2751
    Original = 0x74
    Patched = 0xEB
  }
)

if ($Revert) {
  if (-not (Test-Path -LiteralPath $backup)) {
    throw "Backup not found: $backup"
  }
  Copy-Item -LiteralPath $backup -Destination $target -Force
  Write-Host "Restored $target from $backup"
  exit 0
}

$currentBytes = @()
$readStream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  foreach ($patch in $patches) {
    $readStream.Position = $patch.Offset
    $currentBytes += $readStream.ReadByte()
  }
}
finally {
  $readStream.Close()
}

for ($i = 0; $i -lt $patches.Count; $i++) {
  $patch = $patches[$i]
  $current = $currentBytes[$i]
  if (($current -ne $patch.Original) -and ($current -ne $patch.Patched)) {
    throw ("Unexpected byte for {0} at 0x{1:x}: expected 0x{2:x2} or 0x{3:x2}, found 0x{4:x2}" -f $patch.Name, $patch.Offset, $patch.Original, $patch.Patched, $current)
  }
}

$allOriginal = $true
for ($i = 0; $i -lt $patches.Count; $i++) {
  if ($currentBytes[$i] -ne $patches[$i].Original) {
    $allOriginal = $false
    break
  }
}

if (-not (Test-Path -LiteralPath $backup)) {
  if ($allOriginal) {
    Copy-Item -LiteralPath $target -Destination $backup
    Write-Host "Created backup $backup"
  }
  else {
    Write-Warning "Target already appears patched and no clean backup exists at $backup. Patch will continue, but -Revert will not work for this target."
  }
}

$stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
try {
  foreach ($patch in $patches) {
    $stream.Position = $patch.Offset
    $current = $stream.ReadByte()
    if ($current -eq $patch.Patched) {
      Write-Host ("Already patched: {0} at 0x{1:x}" -f $patch.Name, $patch.Offset)
      continue
    }

    $stream.Position = $patch.Offset
    $stream.WriteByte($patch.Patched)
    Write-Host ("Patched {0} at 0x{1:x}: 0x{2:x2} -> 0x{3:x2}" -f $patch.Name, $patch.Offset, $patch.Original, $patch.Patched)
  }
}
finally {
  $stream.Close()
}

Write-Host 'Done. Use -Revert to restore the backup.'
