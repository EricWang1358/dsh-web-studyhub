param(
    [Parameter(Mandatory)][string]$PredecessorMsi,
    [Parameter(Mandatory)][string]$FinalMsi,
    [Parameter(Mandatory)][string]$FinalExe,
    [Parameter(Mandatory)][string]$ExpectedJar
)
$ErrorActionPreference = 'Stop'
$installer = New-Object -ComObject WindowsInstaller.Installer
function Read-Package([string]$path) {
    $db = $installer.OpenDatabase((Resolve-Path -LiteralPath $path).Path, 0)
    $view = $db.OpenView('SELECT Property,Value FROM Property')
    [void]$view.Execute()
    $properties = @{}
    while ($row = $view.Fetch()) { $properties[$row.StringData(1)] = $row.StringData(2) }
    [void]$view.Close()
    if ($properties.ProductName -ne 'StudyHub Spring' -or $properties.UpgradeCode -ne '{5BE4E226-41F7-421C-9B42-2FD52EC447DE}') {
        throw "Unexpected MSI product: $path"
    }
    return $properties
}

$old = Read-Package $PredecessorMsi
$new = Read-Package $FinalMsi
if ([version]$old.ProductVersion -ge [version]$new.ProductVersion -or $old.ProductCode -eq $new.ProductCode) {
    throw 'Need a real lower-version predecessor with its own MSI product code'
}
$root = Join-Path $env:LOCALAPPDATA 'StudyHub Spring'
$registries = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
function Registrations {
    Get-ItemProperty -Path $registries -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'StudyHub Spring' }
}
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'StudyHub Spring.lnk'
function StartMenuLinks {
    Get-ChildItem -LiteralPath ([Environment]::GetFolderPath('Programs')) -Filter 'StudyHub Spring.lnk' -Recurse -File
}
if ((Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath $desktopLink) -or
    @(StartMenuLinks).Count -gt 0 -or @(Registrations).Count -ne 0) {
    throw 'An existing StudyHub Spring installation, shortcut or installation directory belongs to this user'
}
$folder = Join-Path ([IO.Path]::GetTempPath()) ('studyhub-spring-install-' + [guid]::NewGuid())
[void](New-Item -Type Directory -Path $folder)
Write-Output "Private test data and installer logs: $folder"
$launcher = Join-Path $root 'StudyHub Spring.exe'
$owned = @($old.ProductCode,$new.ProductCode)
$msiexec = Join-Path $env:WINDIR 'System32\msiexec.exe'
$expected = (Get-FileHash -LiteralPath $ExpectedJar).Hash

function Run-Installer([string]$program, [string[]]$arguments, [string]$phase) {
    $log = Join-Path $folder ($phase + '.log')
    $all = @($arguments) + @('/qn','/norestart','REBOOT=ReallySuppress','/L*v',('"' + $log + '"'))
    $p = Start-Process -FilePath $program -ArgumentList $all -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit(360000)) { throw "Installer timeout during $phase. See $log" }
    if ($p.ExitCode -ne 0) { throw "Installer exit $($p.ExitCode) during $phase. See $log" }
    Write-Output "Windows Installer succeeded: $phase"
}

function Assert-Version([hashtable]$properties, [bool]$final) {
    $registration = @(Registrations)
    if ($registration.Count -ne 1 -or $registration[0].DisplayVersion -ne $properties.ProductVersion -or
        $registration[0].PSChildName -ne $properties.ProductCode -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        throw "Installed state differs from expected product $($properties.ProductCode) / $($properties.ProductVersion)"
    }
    if ($final -and (Get-FileHash -LiteralPath (Join-Path $root 'app\studyhub.jar')).Hash -ne $expected) {
        throw 'Installed executable JAR differs from the verified Maven artifact'
    }
    if (-not (Test-Path -LiteralPath $desktopLink) -or @(StartMenuLinks).Count -ne 1) {
        throw 'Expected Windows desktop and Start menu launch shortcuts'
    }
}

function Read-ExeRegistration {
    $entries = @(Registrations)
    if ($entries.Count -ne 1 -or $entries[0].DisplayVersion -ne $new.ProductVersion) {
        throw 'The executable installer did not register the expected product version'
    }
    $code = $entries[0].PSChildName
    $cached = Read-Package $installer.ProductInfo($code, 'LocalPackage')
    if ($cached.ProductCode -ne $code -or $cached.Manufacturer -ne $new.Manufacturer -or $cached.ProductVersion -ne $new.ProductVersion) {
        throw 'The cached installer identity differs from the requested executable installer'
    }
    return $cached
}

function Run-Launcher([string]$phase) {
    & node (Join-Path $PSScriptRoot 'windows-native.mjs') $launcher (Join-Path $folder 'data') $phase
    if ($LASTEXITCODE -ne 0) { throw "Installed launcher check failed during $phase" }
}

function Remove-OwnedProducts([string]$phase) {
    foreach ($entry in @(Registrations)) {
        if ($owned -notcontains $entry.PSChildName) { throw "Refusing to uninstall unknown product $($entry.PSChildName)" }
        Run-Installer $msiexec @('/x',$entry.PSChildName) ($phase + '-' + $entry.PSChildName)
    }
    if (@(Registrations).Count -ne 0 -or (Test-Path -LiteralPath $launcher) -or
        (Test-Path -LiteralPath $desktopLink) -or @(StartMenuLinks).Count -ne 0) {
        throw 'Windows Installer left a registration, launcher or shortcut'
    }
}

try {
    Run-Installer $msiexec @('/i',('"' + (Resolve-Path -LiteralPath $PredecessorMsi).Path + '"')) 'install-old'
    Assert-Version $old $false
    Run-Launcher 'seed'
    Run-Installer $msiexec @('/i',('"' + (Resolve-Path -LiteralPath $FinalMsi).Path + '"')) 'upgrade-msi'
    Assert-Version $new $true
    Run-Launcher 'upgraded'
    Remove-OwnedProducts 'uninstall-upgrade'
    Run-Installer (Resolve-Path -LiteralPath $FinalExe).Path @() 'install-exe'
    $exePackage = Read-ExeRegistration
    $owned += $exePackage.ProductCode
    Assert-Version $exePackage $true
    Run-Launcher 'restored'
} finally {
    Remove-OwnedProducts 'uninstall-final'
}
Write-Output 'MSI upgrade, executable installer, isolated course persistence and uninstall passed.'
