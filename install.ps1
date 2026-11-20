# Antigravity Remote - One-Line Windows Installer
# Usage:
#   irm https://raw.githubusercontent.com/nnavyy/antigravity-remote/main/install.ps1 | iex
# Optional environment overrides:
#   $env:ANTIGRAVITY_REMOTE_DIR = "$env:LOCALAPPDATA\AntigravityRemote"
#   $env:ANTIGRAVITY_REMOTE_TAG = "v2.0.0-dev.7"
#   $env:ANTIGRAVITY_REMOTE_NO_LAUNCH = "1"

& {
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    } catch { }

    $repo = 'nnavyy/antigravity-remote'
    $installDir = if ($env:ANTIGRAVITY_REMOTE_DIR) {
        $env:ANTIGRAVITY_REMOTE_DIR
    } else {
        Join-Path $env:LOCALAPPDATA 'AntigravityRemote'
    }
    $headers = @{
        'User-Agent' = 'antigravity-remote-installer'
        'Accept'     = 'application/vnd.github+json'
    }

    Write-Host ''
    Write-Host '=== Antigravity Remote Installer (Windows) ===' -ForegroundColor Cyan

    # 1. Resolve release metadata from GitHub Releases
    if ($env:ANTIGRAVITY_REMOTE_TAG) {
        $releaseUrl = "https://api.github.com/repos/$repo/releases/tags/$($env:ANTIGRAVITY_REMOTE_TAG)"
        Write-Host "[1/4] Fetching release $($env:ANTIGRAVITY_REMOTE_TAG)..."
        $release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers -TimeoutSec 30
    } else {
        Write-Host '[1/4] Checking latest GitHub release...'
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=10" -Headers $headers -TimeoutSec 30
        $release = @($releases) | Where-Object { -not $_.draft -and @($_.assets).Count -gt 0 } | Select-Object -First 1
    }

    if (-not $release) {
        throw "Could not find a downloadable release on https://github.com/$repo/releases."
    }

    $tag = [string]$release.tag_name
    $releaseAssets = @($release.assets)
    $prebuiltAsset = $releaseAssets | Where-Object { $_.name -eq 'antigravity-remote-windows-x64.zip' } | Select-Object -First 1
    $sourceAsset = $releaseAssets | Where-Object { $_.name -eq 'antigravity-remote-source.zip' } | Select-Object -First 1
    $asset = if ($prebuiltAsset) { $prebuiltAsset } else { $sourceAsset }
    if (-not $asset) {
        throw "Release $tag does not contain a supported Windows archive."
    }
    $isPrebuilt = ($asset.name -eq 'antigravity-remote-windows-x64.zip')

    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("antigravity-remote-install-" + [guid]::NewGuid().ToString('N'))
    $zipPath = Join-Path $tempRoot $asset.name
    $stageDir = Join-Path $tempRoot 'extract'
    New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

    try {
        # 2. Download and verify SHA-256 (when published in release notes)
        Write-Host "[2/4] Downloading $($asset.name) ($tag)..."
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -Headers @{ 'User-Agent' = 'antigravity-remote-installer' } -UseBasicParsing

        $actualSha = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $bodyText = if ($release.PSObject.Properties['body'] -and $release.body) { [string]$release.body } else { '' }
        $escapedName = [regex]::Escape($asset.name)
        $shaMatch = [regex]::Match($bodyText, "(?i)$escapedName[^\r\n\x60]*\x60?([0-9a-f]{64})\x60?")
        if (-not $shaMatch.Success) {
            $shaMatch = [regex]::Match($bodyText, '(?i)SHA-256[^\r\n]*?\x60([0-9a-f]{64})\x60')
        }
        if ($shaMatch.Success) {
            $expectedSha = $shaMatch.Groups[1].Value.ToLowerInvariant()
            if ($actualSha -ne $expectedSha) {
                throw "SHA-256 mismatch for $($asset.name)! Expected $expectedSha, got $actualSha."
            }
            Write-Host "      SHA-256 verified: $actualSha" -ForegroundColor Green
        } else {
            Write-Host "      SHA-256: $actualSha"
        }

        # 3. Extract cleanly while preserving any existing data/ and logs/
        Write-Host "[3/4] Installing into $installDir..."
        Expand-Archive -Path $zipPath -DestinationPath $stageDir -Force
        if (-not (Test-Path -LiteralPath $installDir)) {
            New-Item -ItemType Directory -Path $installDir -Force | Out-Null
        }

        Get-ChildItem -LiteralPath $stageDir -Force | ForEach-Object {
            if ($_.Name -in @('data', 'logs')) {
                return
            }
            $destPath = Join-Path $installDir $_.Name
            if ($_.PSIsContainer) {
                if (Test-Path -LiteralPath $destPath) {
                    Remove-Item -LiteralPath $destPath -Recurse -Force
                }
                Copy-Item -LiteralPath $_.FullName -Destination $destPath -Recurse -Force
            } else {
                Copy-Item -LiteralPath $_.FullName -Destination $destPath -Force
            }
        }

        # 4. Build native Rust binary (unless release already shipped a prebuilt exe)
        $exePath = Join-Path $installDir 'antigravity-bridge.exe'
        if ($isPrebuilt -and (Test-Path -LiteralPath $exePath)) {
            Write-Host '[4/4] Pre-built Windows binary ready.' -ForegroundColor Green
        } else {
            $extraPaths = @()
            if (Test-Path -LiteralPath 'C:\w64devkit\bin') { $extraPaths += 'C:\w64devkit\bin' }
            $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
            if (Test-Path -LiteralPath $cargoBin) { $extraPaths += $cargoBin }
            $savedPath = $env:PATH
            if ($extraPaths.Count -gt 0) {
                $env:PATH = ($extraPaths -join ';') + ';' + $env:PATH
            }

            try {
                $cargoCmd = Get-Command cargo -ErrorAction SilentlyContinue
                if (-not $cargoCmd) {
                    Write-Host ''
                    Write-Host '[4/4] Source extracted, but Rust (cargo) was not found on PATH.' -ForegroundColor Yellow
                    Write-Host '      Install stable Rust for Windows, then run build.bat once:' -ForegroundColor Yellow
                    Write-Host '        winget install Rustlang.Rustup'
                    Write-Host "        cd `"$installDir`""
                    Write-Host '        .\build.bat'
                    Write-Host '        .\Start_Antigravity_Remote.bat'
                    Write-Host ''
                    return
                }

                Write-Host '[4/4] Building native Rust binary (cargo build --release --locked)...'
                Push-Location -LiteralPath $installDir
                try {
                    & cmd.exe /d /c 'build.bat'
                    if ($LASTEXITCODE -ne 0) {
                        throw "build.bat failed with exit code $LASTEXITCODE."
                    }
                } finally {
                    Pop-Location
                }
            } finally {
                $env:PATH = $savedPath
            }
        }

        Write-Host ''
        Write-Host "Installed Antigravity Remote ($tag) to:" -ForegroundColor Green
        Write-Host "  $installDir"
        if (Get-Command agy -ErrorAction SilentlyContinue) {
            Write-Host '  Antigravity CLI (agy): detected' -ForegroundColor Green
        } else {
            Write-Host '  Note: Sign in to Antigravity App or install agy CLI before sending tasks.' -ForegroundColor Yellow
        }
        Write-Host '  Tip: If your phone cannot open the QR link on the same Wi-Fi, allow antigravity-bridge.exe on Private networks in Windows Firewall.'
        Write-Host ''

        if ($env:ANTIGRAVITY_REMOTE_NO_LAUNCH -eq '1') {
            Write-Host "Auto-launch skipped (ANTIGRAVITY_REMOTE_NO_LAUNCH=1). Run `"$installDir\Start_Antigravity_Remote.bat`" to start."
        } else {
            Write-Host 'Launching Antigravity Remote...' -ForegroundColor Cyan
            Start-Process -FilePath (Join-Path $installDir 'Start_Antigravity_Remote.bat') -WorkingDirectory $installDir
        }
    } finally {
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
