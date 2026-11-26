param([Parameter(Mandatory=$true)][string]$OutputDir)
$ErrorActionPreference = 'Stop'
$null = New-Item -ItemType Directory -Force -Path $OutputDir
$OutputDir = (Resolve-Path -LiteralPath $OutputDir).Path
$work = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ('studyhub-webview-' + [guid]::NewGuid()))
try {
    $package = Join-Path $work.FullName 'webview.zip'
    $source = 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.2903.40/microsoft.web.webview2.1.0.2903.40.nupkg'
    & curl.exe -fsSL --retry 2 --max-time 90 -o $package $source
    if ($LASTEXITCODE -ne 0) { throw 'WebView2 SDK download failed' }
    $digest = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($digest.ComputeHash([IO.File]::ReadAllBytes($package))).Replace('-', '') }
    finally { $digest.Dispose() }
    if ($hash -ne 'EF128016DD1E51C59178C827ED5B8AA3322C57AFA8675D930F8109505542AD74') {
        throw 'WebView2 SDK checksum mismatch'
    }
    $null = [Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem')
    [IO.Compression.ZipFile]::ExtractToDirectory($package, (Join-Path $work.FullName 'sdk'))
    $sdk = Join-Path $work.FullName 'sdk'
    $core = Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.Core.dll'
    $forms = Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $binary = Join-Path $OutputDir 'StudyHub.WebView.exe'
    & $compiler /nologo /target:winexe /platform:x64 "/out:$binary" "/reference:$core" "/reference:$forms" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll (Join-Path $PSScriptRoot 'StudyHub.WebView.cs')
    if ($LASTEXITCODE -ne 0) { throw 'WebView2 host compilation failed' }
    Copy-Item -LiteralPath $core,$forms,(Join-Path $sdk 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $OutputDir
} finally {
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ($work.Parent.FullName.TrimEnd('\') -eq $tempRoot -and $work.Name.StartsWith('studyhub-webview-')) {
        Remove-Item -LiteralPath $work.FullName -Recurse -Force
    }
}
