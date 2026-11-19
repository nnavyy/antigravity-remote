param(
    [Parameter(Mandatory)][string]$Binary,
    [Parameter(Mandatory)][string]$LogPath,
    [long]$LimitBytes = 10MB
)
$encoding = New-Object System.Text.UTF8Encoding($false)
$writer = $null
try {
    & $Binary 2>&1 | ForEach-Object {
        $line = $_.ToString()
        if ($null -eq $writer) {
            $writer = [IO.StreamWriter]::new($LogPath, $true, $encoding)
            $writer.AutoFlush = $true
        }
        if ($writer.BaseStream.Length -gt 0 -and
            $writer.BaseStream.Length + $encoding.GetByteCount($line) + 2 -gt $LimitBytes) {
            $writer.Dispose()
            $previous = "$LogPath.1"
            [IO.File]::Copy($LogPath, $previous, $true)
            $writer = [IO.StreamWriter]::new($LogPath, $false, $encoding)
            $writer.AutoFlush = $true
        }
        $writer.WriteLine($line)
    }
    $bridgeExit = $LASTEXITCODE
} finally {
    if ($null -ne $writer) { $writer.Dispose() }
}
exit $bridgeExit
