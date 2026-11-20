# metactl one-line installer (ASCII only, deliberately no BOM).
#
# The real installer lives in install-core.ps1 as UTF-8 with BOM and CRLF,
# which Windows PowerShell 5.1 needs to render its Chinese messages.
# A BOM is fatal when a script arrives through irm ... | iex, because the
# BOM character becomes part of the first token. This shim strips it first.
#
#   irm https://raw.githubusercontent.com/CosmicHourglass/metactl/main/install.ps1 | iex
#
# All arguments are forwarded, e.g.:
#   .\install.ps1 -ZipPath .\metactl-0.2.0-win32-x64.zip -SkipKernel

$ErrorActionPreference = 'Stop'

$corePath = $null
if ($PSScriptRoot) {
    $candidate = Join-Path $PSScriptRoot 'install-core.ps1'
    if (Test-Path -LiteralPath $candidate) { $corePath = $candidate }
}

if ($corePath) {
    $core = Get-Content -LiteralPath $corePath -Raw
} else {
    $core = Invoke-RestMethod -Uri 'https://raw.githubusercontent.com/CosmicHourglass/metactl/main/install-core.ps1'
    if ($core -is [array]) { $core = $core -join "`n" }
}

$core = [string]$core -replace '^\uFEFF', ''
if (-not $core.Trim()) { throw 'metactl: failed to load install-core.ps1' }

$entry = [scriptblock]::Create($core)
& $entry @args
