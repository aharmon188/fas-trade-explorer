#Requires -Version 5.1
<#
.SYNOPSIS
Stores a FAS API key encrypted for the current Windows user and computer.
.DESCRIPTION
Run interactively in your VS Code PowerShell terminal:
    .\tools\Set-FasApiKey.ps1

Enter the key only at the masked prompt, not as a command argument.
The key is encrypted using Windows DPAPI and stored outside the project.
Run this script again to replace it. The ingestion or validation process must
run as the same Windows user on the same computer to decrypt it.

This protects the stored key, not a compromised Windows account. Authorized
requests will still need the decrypted key briefly in process memory.
To revoke access, revoke the key with its issuer; deleting the local file alone
does not revoke the key.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT' -or [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'This setup requires Windows and a local application-data directory.'
}

$credentialDirectory = Join-Path $env:LOCALAPPDATA 'FasTradeExplorer'
$credentialPath = Join-Path $credentialDirectory 'fas-api-key.clixml'
$apiKey = Read-Host 'Enter your FAS API key (input is hidden)' -AsSecureString

try {
    if ($apiKey.Length -eq 0) {
        throw 'The API key cannot be empty. No credential was saved.'
    }

    $apiKey.MakeReadOnly()
    $null = New-Item -ItemType Directory -Path $credentialDirectory -Force
    $apiKey | Export-Clixml -LiteralPath $credentialPath -Encoding UTF8
    Write-Host "Encrypted FAS API key saved to: $credentialPath"
    Write-Host 'The key was not printed or written to the project.'
}
finally {
    $apiKey.Dispose()
}
