<#
  hidden-run.ps1 — start a windowed program on an INVISIBLE Windows desktop, verify it ran, then stop it.

  Two ways in:
    -RequestFile <json>   { "exe": "...", "args": ["..."], "cwd": "...", "seconds": 6 }   (used by the run_hidden tool)
    -Exe <path> [-ArgList a,b] [-WorkingDirectory dir] [-Seconds n]                        (ad-hoc use)

  Output: one JSON line on stdout:
    { exe, desktop, pid, survivedSeconds, survived, realDesktopWindows }

  Exit codes
    0 started, stayed up for the window, nothing on the real desktop
    1 could not create the desktop or start the process
    2 the process exited before the window closed (launcher stub or crash)
    3 the process put a window on the REAL desktop
#>
param(
  [string]$Exe,
  [string[]]$ArgList = @(),
  [string]$WorkingDirectory = (Get-Location).Path,
  [int]$Seconds = 6,
  [string]$RequestFile,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"

if ($RequestFile) {
  $req = Get-Content -Raw -LiteralPath $RequestFile | ConvertFrom-Json
  $Exe = [string]$req.exe
  if ($null -ne $req.args) { $ArgList = @($req.args | ForEach-Object { [string]$_ }) }
  if ($req.cwd) { $WorkingDirectory = [string]$req.cwd }
  if ($req.seconds) { $Seconds = [int]$req.seconds }
}
if (-not $Exe) {
  if (-not $Quiet) { Write-Output "FAIL no executable given" }
  exit 1
}

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DshHidden {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, int flags, uint access, IntPtr sa);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
        uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr h, uint ms);

    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    public const uint DESKTOP_ALL_ACCESS = 0x000F01FF;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    public const uint WAIT_TIMEOUT = 0x102;

    // Visible windows on the interactive desktop owned by this process — the number that must stay at zero.
    public static int VisibleWindowsForPid(int pid) {
        int n = 0;
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            uint p; GetWindowThreadProcessId(h, out p);
            if (p == (uint)pid) n++;
            return true;
        }, IntPtr.Zero);
        return n;
    }
}
"@

function Quote([string]$s) {
  if ($s -match '[\s"]') { return '"' + ($s -replace '"', '\"') + '"' }
  return $s
}

$desktopName = "dsh-hidden-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$desk = [DshHidden]::CreateDesktop($desktopName, [IntPtr]::Zero, [IntPtr]::Zero, 0, [DshHidden]::DESKTOP_ALL_ACCESS, [IntPtr]::Zero)
if ($desk -eq [IntPtr]::Zero) {
  if (-not $Quiet) { Write-Output ("FAIL create-desktop err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  exit 1
}

$pi = New-Object DshHidden+PROCESS_INFORMATION
$targetPid = 0
try {
  $cmd = (Quote $Exe)
  foreach ($a in $ArgList) { $cmd += " " + (Quote $a) }
  $si = New-Object DshHidden+STARTUPINFO
  $si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
  $si.lpDesktop = $desktopName
  $sb = New-Object System.Text.StringBuilder $cmd
  # lpApplicationName must be the exe itself: PowerShell marshals $null for a [string] P/Invoke argument as "",
  # which makes CreateProcessW fail with ERROR_PATH_NOT_FOUND.
  $ok = [DshHidden]::CreateProcess($Exe, $sb, [IntPtr]::Zero, [IntPtr]::Zero, $false,
        [DshHidden]::CREATE_UNICODE_ENVIRONMENT, [IntPtr]::Zero, $WorkingDirectory, [ref]$si, [ref]$pi)
  if (-not $ok) {
    if (-not $Quiet) { Write-Output ("FAIL create-process err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    exit 1
  }
  $targetPid = $pi.dwProcessId

  Start-Sleep -Seconds $Seconds
  $survived = ([DshHidden]::WaitForSingleObject($pi.hProcess, 0) -eq [DshHidden]::WAIT_TIMEOUT)
  $ownWindows = [DshHidden]::VisibleWindowsForPid($targetPid)

  $result = [ordered]@{
    exe                = $Exe
    desktop            = $desktopName
    pid                = $targetPid
    survivedSeconds    = $Seconds
    survived           = $survived
    realDesktopWindows = $ownWindows
  }
  if (-not $Quiet) { Write-Output ($result | ConvertTo-Json -Compress) }

  if ($ownWindows -gt 0) { exit 3 }
  if (-not $survived) { exit 2 }
  exit 0
}
finally {
  if ($targetPid -gt 0) { & taskkill /PID $targetPid /T /F 2>&1 | Out-Null }
  if ($pi.hProcess -ne [IntPtr]::Zero) { [void][DshHidden]::CloseHandle($pi.hProcess) }
  if ($pi.hThread -ne [IntPtr]::Zero) { [void][DshHidden]::CloseHandle($pi.hThread) }
  [void][DshHidden]::CloseDesktop($desk)
}
