[CmdletBinding()]
param(
    [ValidateSet("help", "check", "server", "exe", "all", "release", "clean")]
    [string]$Target = "help"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot
$Manifest = Join-Path $ProjectRoot "src-tauri\Cargo.toml"
$Dist = Join-Path $ProjectRoot "dist"
$env:CMAKE_TOOLCHAIN_FILE = Join-Path $ProjectRoot "src-tauri\cmake\windows-no-asm.cmake"
$TargetRoot = if ($env:SHARARAM_TARGET_DIR) {
    [IO.Path]::GetFullPath($env:SHARARAM_TARGET_DIR)
} else {
    Join-Path ([IO.Path]::GetTempPath()) "shararam-ruffle-target"
}

function Invoke-Cargo {
    param(
        [Parameter(Mandatory)] [string[]]$Arguments,
        [string]$TargetDirectory
    )

    $previousTarget = $env:CARGO_TARGET_DIR
    try {
        if ($TargetDirectory) {
            $env:CARGO_TARGET_DIR = $TargetDirectory
        }
        & cargo @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "cargo $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
        }
    } finally {
        $env:CARGO_TARGET_DIR = $previousTarget
    }
}

function Write-Checksums {
    $lines = Get-ChildItem -LiteralPath $Dist -Filter "Shararam-Ruffle*.exe" -File |
        Sort-Object Name |
        ForEach-Object {
            "$((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant())  $($_.Name)"
        }
    [IO.File]::WriteAllLines(
        (Join-Path $Dist "SHA256SUMS.txt"),
        $lines,
        [Text.UTF8Encoding]::new($false)
    )
}

function Build-Artifact {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [string]$TargetDirectory,
        [string[]]$Features = @()
    )

    $arguments = @(
        "build",
        "--manifest-path", $Manifest,
        "--locked",
        "--release",
        "--no-default-features"
    ) + $Features
    Invoke-Cargo -Arguments $arguments -TargetDirectory $TargetDirectory

    $source = Join-Path $TargetDirectory "release\shararam-ruffle.exe"
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Cargo succeeded but did not produce $source"
    }
    New-Item -ItemType Directory -Path $Dist -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination (Join-Path $Dist $Name) -Force
    Write-Checksums
    Write-Host "Built dist\$Name"
}

function Invoke-Checks {
    Invoke-Cargo -Arguments @("fmt", "--manifest-path", $Manifest, "--", "--check")
    Invoke-Cargo -Arguments @(
        "test", "--manifest-path", $Manifest, "--locked", "--no-default-features"
    ) -TargetDirectory (Join-Path $TargetRoot "check")
    Invoke-Cargo -Arguments @(
        "clippy", "--manifest-path", $Manifest, "--locked", "--all-targets",
        "--no-default-features", "--", "-D", "warnings"
    ) -TargetDirectory (Join-Path $TargetRoot "check")
    Invoke-Cargo -Arguments @(
        "clippy", "--manifest-path", $Manifest, "--locked", "--all-targets",
        "--no-default-features", "--features", "desktop", "--", "-D", "warnings"
    ) -TargetDirectory (Join-Path $TargetRoot "check")
}

function Build-Server {
    Build-Artifact `
        -Name "Shararam-Ruffle-Server.exe" `
        -TargetDirectory (Join-Path $TargetRoot "release")
}

function Build-Desktop {
    Build-Artifact `
        -Name "Shararam-Ruffle.exe" `
        -TargetDirectory (Join-Path $TargetRoot "release") `
        -Features @("--features", "desktop")
}

function Remove-BuildOutputs {
    if (Test-Path -LiteralPath $Dist) {
        Remove-Item -LiteralPath $Dist -Recurse -Force
    }
    foreach ($name in @("release", "check", "server", "desktop", "check-desktop")) {
        $path = [IO.Path]::GetFullPath((Join-Path $TargetRoot $name))
        $expectedParent = [IO.Path]::GetFullPath($TargetRoot).TrimEnd('\') + '\'
        if (-not $path.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clean a target outside $TargetRoot"
        }
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Recurse -Force
        }
    }
    Write-Host "Removed release artifacts and Shararam Ruffle Cargo targets"
}

switch ($Target) {
    "help" {
        Write-Host @"
make server   Build dist\Shararam-Ruffle-Server.exe (browser + local web server)
make exe      Build dist\Shararam-Ruffle.exe (single desktop executable)
make all      Build both release artifacts
make check    Run format, tests, and Clippy for both feature sets
make release  Run checks and build both release artifacts
make clean    Remove generated release artifacts and Cargo targets

Without GNU Make, run the equivalent command directly:
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 <target>
"@
    }
    "check" { Invoke-Checks }
    "server" { Build-Server }
    "exe" { Build-Desktop }
    "all" { Build-Server; Build-Desktop }
    "release" { Invoke-Checks; Build-Server; Build-Desktop }
    "clean" { Remove-BuildOutputs }
}
