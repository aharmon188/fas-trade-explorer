#Requires -Version 5.1
<#
.SYNOPSIS
Collects a read-only Canada/HS1001 validation sample and source evidence.
.DESCRIPTION
Uses the encrypted local credential. Saves extracts outside the project in
LOCALAPPDATA\FasTradeExplorer\validation. HS1001 is a diagnostic code-prefix
selection, not a verified FAS commodity-group crosswalk.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$root = Join-Path $env:LOCALAPPDATA 'FasTradeExplorer'
$output = Join-Path $root ('validation\' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
$null = New-Item -ItemType Directory -Path $output
$secureKey = Import-Clixml -LiteralPath (Join-Path $root 'fas-api-key.clixml')
if ($secureKey -isnot [System.Security.SecureString]) {
    throw 'The saved credential must contain a SecureString.'
}
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $false
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromSeconds(60)
$requests = New-Object 'System.Collections.Generic.List[object]'
$sample = New-Object 'System.Collections.Generic.List[object]'
$manifest = [ordered]@{
    status = 'in_progress'
    startedUtc = [DateTime]::UtcNow.ToString('o')
    apiBase = 'https://api.fas.usda.gov/api/'
    partnerCode = 'CA'
    diagnosticHsPrefix = '1001'
    groupingVerified = $false
    accountingDefinitionsVerified = $false
    independentReconciliationVerified = $false
    requests = $requests
}

function Get-FasRecords {
    param([string]$Route, [string]$Name)

    $uri = $manifest.apiBase + $Route
    $response = $client.GetAsync($uri).GetAwaiter().GetResult()
    try {
        if (-not $response.IsSuccessStatusCode) {
            throw "FAS request '$Route' failed with HTTP $([int]$response.StatusCode)."
        }
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $parsed = $body | ConvertFrom-Json
        if ($parsed -isnot [array]) {
            throw "FAS '$Route' did not return an array."
        }
        $path = Join-Path $output ($Name + '.json')
        [System.IO.File]::WriteAllText($path, $body)
        $requests.Add([ordered]@{
            url = $uri
            retrievedUtc = [DateTime]::UtcNow.ToString('o')
            httpStatus = [int]$response.StatusCode
            recordCount = $parsed.Count
            file = $Name + '.json'
            sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        })
        return ,$parsed
    }
    finally {
        $response.Dispose()
    }
}

try {
    $credential = New-Object System.Management.Automation.PSCredential('fas', $secureKey)
    if (-not $client.DefaultRequestHeaders.TryAddWithoutValidation(
        'X-Api-Key', $credential.GetNetworkCredential().Password
    )) {
        throw 'Unable to configure the authentication header.'
    }
    $credential = $null

    $exports = Get-FasRecords 'gats/census/data/exports/dataReleaseDates' 'export-releases'
    $imports = Get-FasRecords 'gats/census/data/imports/dataReleaseDates' 'import-releases'
    $countries = Get-FasRecords 'gats/countries' 'countries'
    $commodities = Get-FasRecords 'gats/commodities' 'commodities'
    $units = Get-FasRecords 'gats/unitsOfMeasure' 'units'
    $unitIndex = @{}
    foreach ($unit in $units) {
        if ($unitIndex.ContainsKey([string]$unit.unitOfMeasureId)) {
            throw 'Duplicate unit reference identifier.'
        }
        $unitIndex[[string]$unit.unitOfMeasureId] = $unit
    }
    $commodityIndex = @{}
    foreach ($commodity in $commodities) {
        $key = ([string]$commodity.hS10Code).Trim()
        if (-not $commodityIndex.ContainsKey($key)) { $commodityIndex[$key] = @() }
        $commodityIndex[$key] += $commodity
    }
    if (@($countries | Where-Object {
        $_.countryCode -eq 'CA' -and $_.countryName -eq 'Canada'
    }).Count -ne 1) {
        throw 'Expected one Canada reference record.'
    }

    $now = [DateTime]::UtcNow
    $importMonths = @{}
    foreach ($release in $imports) {
        if ($release.reporterCode -eq 'US' -and
            [DateTime]$release.releaseTimeStamp -le $now) {
            $importMonths[[string]$release.statisticalYearMonth] = $true
        }
    }
    $common = @($exports | Where-Object {
        $_.reporterCode -eq 'US' -and
        [DateTime]$_.releaseTimeStamp -le $now -and
        $importMonths.ContainsKey([string]$_.statisticalYearMonth)
    } | ForEach-Object { [string]$_.statisticalYearMonth } | Sort-Object -Unique)
    if ($common.Count -lt 12) {
        throw 'Fewer than 12 common released months.'
    }
    $latest = [DateTime]::ParseExact($common[-1], 'yyyyMM',
        [System.Globalization.CultureInfo]::InvariantCulture)
    if ($latest.AddMonths(1) -gt $now) {
        throw 'Latest release refers to an incomplete calendar month.'
    }
    $months = @(0..11 | ForEach-Object { $latest.AddMonths($_ - 11).ToString('yyyyMM') })
    foreach ($month in $months) {
        if ($common -notcontains $month) {
            throw "Missing common release for $month."
        }
    }
    $manifest['months'] = $months

    foreach ($flow in @('censusImports', 'censusExports')) {
        $productType = 'X'
        if ($flow -eq 'censusImports') { $productType = 'M' }
        foreach ($month in $months) {
            $route = 'gats/' + $flow + '/partnerCode/CA/year/' +
                $month.Substring(0, 4) + '/month/' + $month.Substring(4, 2)
            $rows = Get-FasRecords $route ($flow + '-' + $month)
            if ($rows.Count -eq 0) {
                throw "No Canada records for $flow $month."
            }
            $seen = @{}
            foreach ($row in $rows) {
                if ($row.date -ne $month -or $row.countryCode -ne 'CA') {
                    throw "Unexpected partner or month in $flow $month."
                }
                $code = ([string]$row.hS10Code).Trim()
                if ($code -notmatch '^\d{10}$') {
                    throw "Invalid HS10 code in $flow $month."
                }
                if ($seen.ContainsKey($code)) {
                    throw "Duplicate HS10 code $code in $flow $month."
                }
                $seen[$code] = $true
                if (-not $code.StartsWith('1001')) { continue }
                foreach ($unitField in @('censusUOMId1', 'censusUOMId2')) {
                    if (-not $unitIndex.ContainsKey([string]$row.$unitField)) {
                        throw "Missing unit reference $unitField in $flow $month."
                    }
                }
                $matchingReferences = @($commodityIndex[$code] | Where-Object {
                    $_.productType -in @($productType, 'B') -and
                    [string]$_.startDate -le $month -and
                    ([string]::IsNullOrEmpty([string]$_.endDtate) -or
                        [string]$_.endDtate -ge $month)
                })
                if ($matchingReferences.Count -ne 1) {
                    throw "Missing or ambiguous dated $productType reference for $code in $month."
                }
                foreach ($unitField in @('censusUOMId1', 'censusUOMId2')) {
                    if ($row.$unitField -ne $matchingReferences[0].$unitField) {
                        throw "Reference/record unit disagreement for $code in $month."
                    }
                }
                $consumptionValue = $null
                if ($flow -eq 'censusImports') {
                    $consumptionValue = [decimal]$row.consumptionValue
                }
                $sample.Add([pscustomobject][ordered]@{
                    sourceEndpoint = $flow
                    partnerCode = 'CA'
                    yearMonth = $month
                    hs10 = $code
                    valueReported = [decimal]$row.value
                    quantity1Reported = [decimal]$row.quantity1
                    quantity2Reported = [decimal]$row.quantity2
                    censusUomId1 = $row.censusUOMId1
                    censusUomId2 = $row.censusUOMId2
                    consumptionValueReported = $consumptionValue
                })
            }
            Write-Output "PASS $flow $month : $($rows.Count) records checked."
        }
    }
    $null = Get-FasRecords (
        'gats/censusReExports/partnerCode/CA/year/' + $latest.ToString('yyyy') +
        '/month/' + $latest.ToString('MM')
    ) ('censusReExports-' + $latest.ToString('yyyyMM'))
    if ($sample.Count -eq 0) {
        throw 'No HS1001 diagnostic records were collected.'
    }
    $sample | Export-Csv -LiteralPath (Join-Path $output 'hs1001-sample.csv') -NoTypeInformation
    $summary = @($sample | Group-Object sourceEndpoint, yearMonth | ForEach-Object {
        [decimal]$total = 0
        foreach ($row in $_.Group) { $total += $row.valueReported }
        [pscustomobject]@{
            endpoint = $_.Group[0].sourceEndpoint
            yearMonth = $_.Group[0].yearMonth
            hs10Count = $_.Count
            valueReportedSum = $total
            quantityUnitIds = @($_.Group.censusUomId1 | Sort-Object -Unique)
        }
    })
    $summary | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath (Join-Path $output 'diagnostic-monthly-totals.json') -Encoding UTF8
    $manifest['sampleRowCount'] = $sample.Count
    $manifest.status = 'sample_checks_passed_semantic_gates_open'
    Write-Output "Sample checks passed: $($months[0]) through $($months[-1]), $($sample.Count) HS1001 rows."
    Write-Output "Evidence directory: $output"
}
catch {
    $manifest.status = 'failed'
    throw
}
finally {
    $manifest['finishedUtc'] = [DateTime]::UtcNow.ToString('o')
    $manifest | ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath (Join-Path $output 'manifest.json') -Encoding UTF8
    $credential = $null
    $client.Dispose()
    $secureKey.Dispose()
}
