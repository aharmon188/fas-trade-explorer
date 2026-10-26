#Requires -Version 5.1
<#
.SYNOPSIS
Stores a Census API key encrypted (DPAPI) for the current Windows user and computer.
.DESCRIPTION
Run interactively in your VS Code PowerShell terminal:
    .\tools\Set-CensusApiKey.ps1

Enter the key only at the masked prompt. The key is stored outside the project
at %LOCALAPPDATA%\FasTradeExplorer\census-api-key.clixml.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$credentialDirectory = Join-Path $env:LOCALAPPDATA 'FasTradeExplorer'
$credentialPath = Join-Path $credentialDirectory 'census-api-key.clixml'
$apiKey = Read-Host 'Enter your Census API key (input is hidden)' -AsSecureString

try {
    if ($apiKey.Length -eq 0) {
        throw 'The API key cannot be empty. No credential was saved.'
    }

    $apiKey.MakeReadOnly()
    $null = New-Item -ItemType Directory -Path $credentialDirectory -Force
    $apiKey | Export-Clixml -LiteralPath $credentialPath -Encoding UTF8
    Write-Host "Encrypted Census API key saved to: $credentialPath"
}
finally {
    $apiKey.Dispose()
}
