param([Parameter(Mandatory)][string]$HostPath)
$ErrorActionPreference = 'Stop'
$web = @(Get-Process -Name 'StudyHub.WebView' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Path -eq $HostPath) { $_ }
})
if ($web.Count -ne 1) { throw "Expected one WebView2 host at the new installation path; found $($web.Count)" }
$process = $web[0]
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StudyHubTrayCheck {
    delegate bool EnumProc(IntPtr window, IntPtr state);
    [DllImport("user32")] static extern bool EnumWindows(EnumProc callback, IntPtr state);
    [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32", SetLastError = true)] static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    public static bool ClickSystemClose(IntPtr window) {
        // SC_CLOSE follows the same WinForms UserClosing path as the title-bar X.
        return PostMessage(window, 0x0112, (IntPtr)0xf060, IntPtr.Zero);
    }
    [StructLayout(LayoutKind.Sequential)] struct IconId {
        public uint size;
        public IntPtr window;
        public uint id;
        public Guid guid;
    }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [DllImport("shell32")] static extern int Shell_NotifyIconGetRect(ref IconId identifier, out Rect rectangle);
    public static bool Registered(uint process) {
        bool found = false;
        EnumWindows(delegate(IntPtr window, IntPtr state) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != process) return true;
            for (uint id = 0; id < 16; ++id) {
                var key = new IconId { size = (uint)Marshal.SizeOf(typeof(IconId)), window = window, id = id };
                Rect bounds;
                if (Shell_NotifyIconGetRect(ref key, out bounds) >= 0 && bounds.right > bounds.left) {
                    found = true;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
$window = $process.MainWindowHandle
if ($window -eq [IntPtr]::Zero -or -not [StudyHubTrayCheck]::IsWindowVisible($window)) { throw 'No visible WebView2 window' }
if (-not [StudyHubTrayCheck]::Registered($process.Id)) { throw 'Explorer did not register the WebView2 host notification icon' }
if (-not [StudyHubTrayCheck]::ClickSystemClose($window)) { throw 'Could not request a title-bar close' }
$until = [DateTime]::UtcNow.AddSeconds(8)
while ([StudyHubTrayCheck]::IsWindowVisible($window) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 100 }
$stillVisible = [StudyHubTrayCheck]::IsWindowVisible($window)
$iconRegistered = [StudyHubTrayCheck]::Registered($process.Id)
if ($process.HasExited -or $stillVisible -or -not $iconRegistered) {
    throw "Close-to-tray state: exited=$($process.HasExited) visible=$stillVisible icon=$iconRegistered title=$($process.MainWindowTitle) handle=$window"
}
Write-Output 'Native WebView2 material navigation, Explorer notification icon and close-to-tray verified.'
