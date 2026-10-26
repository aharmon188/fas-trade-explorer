#Requires -Version 5.1
<#
.SYNOPSIS
Fetches and prepares selected countries using the encrypted FAS key.
.DESCRIPTION
No ArcGIS publication. The key is passed only through this process's temporary
environment to the Python child, never as a command argument or source file.
#>
[CmdletBinding()]
param(
    [string]$PartnersFile,
    [string]$Source,
    [string]$Resume,
    [string]$Output
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$secureKey = Import-Clixml -LiteralPath (
    Join-Path $env:LOCALAPPDATA 'FasTradeExplorer\fas-api-key.clixml'
)
$previous = $env:FAS_API_KEY
try {
    if ($secureKey -isnot [System.Security.SecureString]) {
        throw 'Expected a Windows-encrypted SecureString.'
    }
    $credential = New-Object System.Management.Automation.PSCredential('fas', $secureKey)
    $env:FAS_API_KEY = $credential.GetNetworkCredential().Password
    $root = Split-Path $PSScriptRoot -Parent
    if (-not $PartnersFile) { $PartnersFile = Join-Path $root 'prototype\partners.json' }
    if (-not $Output) { $Output = Join-Path $root 'public\prototype-data.json' }
    $arguments = @((Join-Path $root 'prototype\fetch_pilot.py'), '--output', $Output, '--partners', $PartnersFile)
    if ($Source) { $arguments += @('--source', $Source) }
    if ($Resume) { $arguments += @('--resume', $Resume) }
    & python @arguments
    if ($LASTEXITCODE -ne 0) {
        throw 'Pilot collection failed. The previous prepared browser dataset was preserved.'
    }
}
finally {
    $env:FAS_API_KEY = $previous
    $credential = $null
    if ($secureKey -is [System.Security.SecureString]) { $secureKey.Dispose() }
}
