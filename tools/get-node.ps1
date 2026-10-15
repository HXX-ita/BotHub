# get-node.ps1 - download the official portable Node.js into runtime\node
#
# Why: the installer should not require the user to go install Node.js by hand.
# This pulls the official Windows x64 zip from nodejs.org and unpacks it, so
# run\start scripts can use runtime\node\node.exe with no PATH changes.
#
# ASCII-only .ps1 on purpose? No - this one has no Chinese at all, so it is safe
# either way. Keep it ASCII to avoid BOM/encoding surprises.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # ...\<BotHub>
$dest = Join-Path $root 'runtime\node'
$ver  = 'v22.11.0'                                 # LTS line; bump when needed
$url  = "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip"
$zip  = Join-Path $env:TEMP "node-$ver-win-x64.zip"

Write-Host "      downloading $url"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

Write-Host "      unpacking to $dest"
$tmp = Join-Path $env:TEMP "node-unpack-$ver"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force

New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Move-Item -LiteralPath (Join-Path $tmp "node-$ver-win-x64") -Destination $dest

Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

if (Test-Path (Join-Path $dest 'node.exe')) {
  Write-Host "      ok: $(Join-Path $dest 'node.exe')"
} else {
  Write-Host "      failed to unpack Node.js"
  exit 1
}
