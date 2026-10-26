#Requires -Version 5.1
<#
.SYNOPSIS
Checks authenticated access to FAS reference data without publishing anything.
.DESCRIPTION
Reads the Windows-encrypted key saved by Set-FasApiKey.ps1.
Uses the verified api.fas.usda.gov gateway and X-Api-Key header.
Prints only HTTP status and record counts, never credentials or response bodies.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$credentialPath = Join-Path $env:LOCALAPPDATA 'FasTradeExplorer\fas-api-key.clixml'
$secureKey = Import-Clixml -LiteralPath $credentialPath
if ($secureKey -isnot [System.Security.SecureString]) {
    throw 'The saved FAS credential must contain a SecureString.'
}

$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $false
$client = New-Object System.Net.Http.HttpClient($handler)

try {
    $credential = New-Object System.Management.Automation.PSCredential('fas', $secureKey)
    $client.Timeout = [TimeSpan]::FromSeconds(45)
    if (-not $client.DefaultRequestHeaders.TryAddWithoutValidation(
        'X-Api-Key', $credential.GetNetworkCredential().Password
    )) {
        throw 'Unable to configure the FAS authentication header.'
    }
    $credential = $null

    $checks = @(
        @{ Resource = 'esr/regions'; RequiredFields = @('regionId', 'regionName') },
        @{ Resource = 'gats/countries'; RequiredFields = @('countryCode', 'countryName') },
        @{ Resource = 'gats/commodities'; RequiredFields = @('hS10Code', 'commodityName') },
        @{ Resource = 'gats/unitsOfMeasure'; RequiredFields = @('unitOfMeasureId', 'unitOfMeasureCode') }
    )

    foreach ($check in $checks) {
        $response = $client.GetAsync(
            'https://api.fas.usda.gov/api/' + $check.Resource
        ).GetAwaiter().GetResult()
        try {
            $status = [int]$response.StatusCode
            if (-not $response.IsSuccessStatusCode) {
                throw "FAS $($check.Resource) failed with HTTP $status. Validation stopped."
            }
            $payload = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            $parsed = $payload | ConvertFrom-Json
            $records = @($parsed)
            if ($records.Count -eq 0) {
                throw "FAS $($check.Resource) returned no records."
            }
            foreach ($field in $check.RequiredFields) {
                if ($records[0].PSObject.Properties.Name -notcontains $field) {
                    throw "FAS $($check.Resource) is missing expected field '$field'."
                }
            }
            Write-Output "PASS $($check.Resource): HTTP $status, $($records.Count) records."
        }
        finally {
            $response.Dispose()
        }
    }
}
finally {
    $credential = $null
    $client.Dispose()
    $secureKey.Dispose()
}
