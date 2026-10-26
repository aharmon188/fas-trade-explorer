#Requires -Version 5.1
<#
.SYNOPSIS
Reconciles the local pilot dataset with Census HS10 values using the encrypted Census key.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$secureKey = Import-Clixml -LiteralPath (
    Join-Path $env:LOCALAPPDATA 'FasTradeExplorer\census-api-key.clixml'
)
$previous = $env:CENSUS_API_KEY
try {
    $credential = New-Object System.Management.Automation.PSCredential('census', $secureKey)
    $env:CENSUS_API_KEY = $credential.GetNetworkCredential().Password
    & python (Join-Path $PSScriptRoot 'Test-CensusPilotReconciliation.py')
    if ($LASTEXITCODE -ne 0) { throw 'Census pilot reconciliation failed.' }
}
finally {
    $env:CENSUS_API_KEY = $previous
    $credential = $null
    $secureKey.Dispose()
}
