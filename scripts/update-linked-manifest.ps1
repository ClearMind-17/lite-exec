[CmdletBinding()]
param(
    [string] $DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$profile = Join-Path (Resolve-Path -LiteralPath $DshHome).Path 'profiles\desktop'
$vendor = Join-Path $profile 'vendor\dsh-lite-exec'
$sourceManifest = Join-Path $source 'package.json'
$installedManifest = Join-Path $vendor 'package.json'

$profilePackage = Get-Content -LiteralPath (Join-Path $profile 'package.json') -Raw | ConvertFrom-Json
if ($profilePackage.dependencies.'dsh-lite-exec' -ne 'link:vendor/dsh-lite-exec') {
    throw 'Expected the existing Desktop dependency link:vendor/dsh-lite-exec.'
}

$link = Get-Item -LiteralPath (Join-Path $profile 'node_modules\dsh-lite-exec') -Force
$target = @($link.Target)[0]
if ($link.LinkType -ne 'Junction' -or -not $target -or [IO.Path]::GetFullPath($target) -ne $vendor) {
    throw 'The live Lite Exec junction does not point at the expected vendor directory.'
}
$vendorItem = Get-Item -LiteralPath $vendor -Force
$manifestItem = Get-Item -LiteralPath $installedManifest -Force
if (($vendorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    ($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Expected a regular vendor directory and manifest.'
}

$from = Get-Content -LiteralPath $installedManifest -Raw | ConvertFrom-Json
$to = Get-Content -LiteralPath $sourceManifest -Raw | ConvertFrom-Json
if ($from.name -ne 'dsh-lite-exec' -or $from.version -notin @('0.1.1', '0.1.2') -or
    $to.name -ne 'dsh-lite-exec' -or $to.version -ne '0.1.2' -or
    $to.engines.dsh -ne '0.2.2-rc.3 || 0.2.2-rc.5') {
    throw 'This updater requires the Lite Exec 0.1.1 to 0.1.2 release manifests.'
}
$installedVersion = $from.version
$expectedEngine = if ($installedVersion -eq '0.1.1') { '0.2.2-rc.3' } else { $to.engines.dsh }
if ($from.engines.dsh -ne $expectedEngine) {
    throw 'The installed manifest has an unexpected DSH engine declaration.'
}
$from.version = $to.version
$from.engines.dsh = $to.engines.dsh
if (($from | ConvertTo-Json -Depth 30 -Compress) -cne ($to | ConvertTo-Json -Depth 30 -Compress)) {
    throw 'The installed manifest also changes fields other than version and engines.dsh.'
}

$runtimeFiles = @('cordis.patch.yml') + @(Get-ChildItem -LiteralPath (Join-Path $source 'lib') -File -Recurse | ForEach-Object {
    $_.FullName.Substring($source.Length + 1)
})
foreach ($file in $runtimeFiles) {
    $current = (Get-FileHash -LiteralPath (Join-Path $vendor $file)).Hash
    $expected = (Get-FileHash -LiteralPath (Join-Path $source $file)).Hash
    if ($current -ne $expected) {
        throw "Installed runtime file differs from this release: $file"
    }
}

if ($installedVersion -eq '0.1.2') {
    Write-Output 'Lite Exec 0.1.2 is already installed.'
    return
}
if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
    throw 'Fully quit DeepSeek Harness Desktop, including the tray process, and run this script again.'
}

$suffix = [guid]::NewGuid().ToString('N')
$staged = Join-Path $vendor "package.json.$suffix.tmp"
$backup = Join-Path $vendor "package.json.0.1.1.$suffix.bak"
$expectedManifestHash = (Get-FileHash -LiteralPath $sourceManifest).Hash
try {
    [IO.File]::Copy($sourceManifest, $staged)
    [IO.File]::Replace($staged, $installedManifest, $backup)
    $visibleManifest = Join-Path $link.FullName 'package.json'
    if ((Get-FileHash -LiteralPath $visibleManifest).Hash -ne $expectedManifestHash) {
        throw "Desktop does not see the expected manifest. The previous manifest is saved at $backup"
    }
    Write-Output 'Lite Exec 0.1.2 is installed for DSH 0.2.2-rc.5.'
    Write-Output "Previous manifest: $backup"
} finally {
    if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged }
}
