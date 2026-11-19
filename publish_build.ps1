# Publish a complete image even when Windows is still using the previous executable.
$ErrorActionPreference = 'Stop'
$destination = Join-Path $PSScriptRoot 'antigravity-bridge.exe'
$source = Join-Path $PSScriptRoot 'target\release\antigravity-bridge.exe'
if (-not [IO.File]::Exists($source)) { throw "Release executable missing. Run cargo build --release --locked first." }
function Get-ImageDigest([string]$path) {
    $stream = [IO.File]::OpenRead($path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [Convert]::ToBase64String($sha.ComputeHash($stream)) }
    finally { $sha.Dispose(); $stream.Dispose() }
}
if ([IO.File]::Exists($destination) -and
    (Get-ImageDigest $source) -eq (Get-ImageDigest $destination)) {
    Write-Host "The installed executable already matches this build."
    return
}
$id = [guid]::NewGuid()
$stage = Join-Path $PSScriptRoot "bridge-$id.tmp"
$backup = Join-Path (Split-Path -Parent $source) "bridge-$id.bak"
try {
    [IO.File]::Copy($source, $stage)
    if ([IO.File]::Exists($destination)) {
        [IO.File]::Replace($stage, $destination, $backup)
        try { [IO.File]::Delete($backup) } catch [IO.IOException] {
            Write-Host "Windows is using the previous image. After it exits you can remove $backup"
        } catch [UnauthorizedAccessException] {
            Write-Host "Previous image retained at $backup"
        }
    } else {
        [IO.File]::Move($stage, $destination)
    }
    Write-Host "Published $destination. A running bridge picks up this build on restart."
} finally {
    if ([IO.File]::Exists($stage)) { [IO.File]::Delete($stage) }
}
