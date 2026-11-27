param([ValidatePattern('^[a-p]{32}$')][string]$ExtensionId)

$ErrorActionPreference = 'Stop'
$extensionRoot = (Get-Item -LiteralPath $PSScriptRoot).FullName.TrimEnd('\')
$extensionManifest = Get-Content -LiteralPath (Join-Path $extensionRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$hostName = 'org.sciencedirect_desktop.save'
$exe = Join-Path $extensionRoot 'desktop-host/ScienceDirectDesktopHost.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'ScienceDirectDesktopHost.exe is missing.' }

if (-not $ExtensionId) {
    $idBytes = if ($extensionManifest.key) {
        [Convert]::FromBase64String($extensionManifest.key)
    } else {
        $normalizedPath = $extensionRoot.Substring(0, 1).ToUpperInvariant() + $extensionRoot.Substring(1)
        [Text.Encoding]::Unicode.GetBytes($normalizedPath)
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = $sha.ComputeHash($idBytes) } finally { $sha.Dispose() }
    $hex = [BitConverter]::ToString($digest, 0, 16).Replace('-', '').ToLowerInvariant()
    $ExtensionId = -join ($hex.ToCharArray() | ForEach-Object { [char](97 + [Convert]::ToInt32($_.ToString(), 16)) })
}

$manifestPath = Join-Path $extensionRoot "desktop-host/$hostName.json"
$definition = [ordered]@{
    name = $hostName
    description = 'Saves ScienceDirect PDFs to the Windows Desktop'
    path = $exe
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
[IO.File]::WriteAllText($manifestPath, ($definition | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$registryKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
New-Item -Path $registryKey -Force | Out-Null
Set-Item -LiteralPath $registryKey -Value $manifestPath
Write-Output "Registered for Microsoft Edge. Extension ID: $ExtensionId"
