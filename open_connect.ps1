$ErrorActionPreference = 'Stop'

$bridgePort = 8000
if ($env:BRIDGE_PORT -and (-not [int]::TryParse($env:BRIDGE_PORT, [ref]$bridgePort) -or $bridgePort -lt 1 -or $bridgePort -gt 65535)) {
    Write-Error 'BRIDGE_PORT must be a number between 1 and 65535.'
    exit 1
}
$bridgeUrl = "http://127.0.0.1:$bridgePort"
$timer = [Diagnostics.Stopwatch]::StartNew()
$ready = $false
while ($timer.Elapsed.TotalSeconds -lt 15) {
    try {
        $health = Invoke-RestMethod -Uri "$bridgeUrl/healthz" -TimeoutSec 2
        if ($health.ok -eq $true -and $health.engine -eq 'rust-axum') {
            $ready = $true
            break
        }
    } catch { }
    Start-Sleep -Milliseconds 200
}
if (-not $ready) {
    Write-Error 'The bridge did not become ready. Check the server error in the launcher window.'
    exit 1
}

$connection = Invoke-RestMethod -Uri "$bridgeUrl/api/connection" -TimeoutSec 5
if ($connection.primary_url) {
    Write-Host "Phone address: $($connection.primary_url)"
    Write-Host 'Open Connect on the laptop to pair your phone.'
} else {
    Write-Host $connection.unavailable_reason
}
Start-Process "$bridgeUrl/#connect"
