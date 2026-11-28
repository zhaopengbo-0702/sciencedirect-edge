param([ValidatePattern('^[a-p]{32}$')][string]$ExtensionId)

$ErrorActionPreference = 'Stop'
$extensionRoot = (Get-Item -LiteralPath $PSScriptRoot).FullName.TrimEnd('\')
$extensionManifest = Get-Content -LiteralPath (Join-Path $extensionRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$hostName = 'org.sciencedirect_desktop.save'
$exeSource = Join-Path $extensionRoot 'desktop-host/ScienceDirectDesktopHost.exe'
if (-not (Test-Path -LiteralPath $exeSource -PathType Leaf)) { throw 'ScienceDirectDesktopHost.exe is missing.' }

function ConvertTo-ExtensionId([byte[]]$bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
    $hex = [BitConverter]::ToString($digest, 0, 16).Replace('-', '').ToLowerInvariant()
    return -join ($hex.ToCharArray() | ForEach-Object { [char](97 + [Convert]::ToInt32($_.ToString(), 16)) })
}

# Register every ID this package can be loaded with: the explicit one (if given),
# the folder-path ID Edge uses for an already installed copy, and the manifest-key
# ID Edge uses for a fresh install (which stays the same no matter where the
# extension folder is moved). This way one registration keeps working after
# re-extracting a new version into a different folder.
$ids = New-Object System.Collections.Generic.List[string]
if ($ExtensionId) { $ids.Add($ExtensionId) }
$normalizedPath = $extensionRoot.Substring(0, 1).ToUpperInvariant() + $extensionRoot.Substring(1)
$ids.Add((ConvertTo-ExtensionId ([Text.Encoding]::Unicode.GetBytes($normalizedPath))))
if ($extensionManifest.key) {
    $ids.Add((ConvertTo-ExtensionId ([Convert]::FromBase64String($extensionManifest.key))))
}
$uniqueIds = @($ids | Select-Object -Unique)

# Keep the desktop helper outside the extension folder so that updating or
# moving the extension never breaks the registration.
$hostDir = Join-Path $env:LOCALAPPDATA 'ScienceDirectEdge'
New-Item -ItemType Directory -Path $hostDir -Force | Out-Null
$exe = Join-Path $hostDir 'ScienceDirectDesktopHost.exe'
Copy-Item -LiteralPath $exeSource -Destination $exe -Force

$manifestPath = Join-Path $hostDir "$hostName.json"
$definition = [ordered]@{
    name = $hostName
    description = 'Saves ScienceDirect PDFs to the Windows Desktop'
    path = $exe
    type = 'stdio'
    allowed_origins = @($uniqueIds | ForEach-Object { "chrome-extension://$_/" })
}
[IO.File]::WriteAllText($manifestPath, ($definition | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$registryKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
New-Item -Path $registryKey -Force | Out-Null
Set-Item -LiteralPath $registryKey -Value $manifestPath
Write-Output ('Registered for Microsoft Edge. Extension IDs: ' + ($uniqueIds -join ', '))
