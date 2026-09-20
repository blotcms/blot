# Experiments in getting a 200% (HiDPI) File Explorer capture on a hosted
# Windows runner. Each experiment runs in a fresh VM and leaves a full-screen
# screenshot plus a log of what the OS reported.
# usage: windows-hidpi.ps1 -Experiment dpi|res-dpi|spi|logpixels|rdp -Out <dir>
param([string]$Experiment = "dpi", [string]$Out = "out")
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$log = "$Out\$Experiment.log"
function Log($m) { "$m" | Tee-Object -FilePath $log -Append }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Hidpi {
  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] public struct HDR { public int type; public uint size; public LUID adapter; public uint id; }
  [StructLayout(LayoutKind.Sequential)] public struct GET { public HDR h; public int minRel; public int curRel; public int maxRel; }
  [StructLayout(LayoutKind.Sequential)] public struct SET { public HDR h; public int rel; }
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint paths, IntPtr pathArr, ref uint modes, IntPtr modeArr, IntPtr topo);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref GET p);
  [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(ref SET p);
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(int a, int b, IntPtr c, int d);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);

  public static string SetScale(int percent) {
    uint np, nm; int r = GetDisplayConfigBufferSizes(2, out np, out nm); if (r != 0) return "sizes " + r;
    IntPtr pa = Marshal.AllocHGlobal((int)np * 72), ma = Marshal.AllocHGlobal((int)nm * 64);
    r = QueryDisplayConfig(2, ref np, pa, ref nm, ma, IntPtr.Zero); if (r != 0) return "query " + r;
    LUID luid = new LUID(); luid.Low = (uint)Marshal.ReadInt32(pa, 0); luid.High = Marshal.ReadInt32(pa, 4);
    uint id = (uint)Marshal.ReadInt32(pa, 8);
    GET g = new GET(); g.h.type = -3; g.h.size = (uint)Marshal.SizeOf(typeof(GET)); g.h.adapter = luid; g.h.id = id;
    r = DisplayConfigGetDeviceInfo(ref g); if (r != 0) return "get " + r;
    int[] steps = {100,125,150,175,200,225,250,300,350,400,450,500};
    int rel = Array.IndexOf(steps, percent) - (-g.minRel);
    SET s = new SET(); s.h.type = -4; s.h.size = (uint)Marshal.SizeOf(typeof(SET)); s.h.adapter = luid; s.h.id = id; s.rel = rel;
    r = DisplayConfigSetDeviceInfo(ref s);
    return "min=" + g.minRel + " cur=" + g.curRel + " max=" + g.maxRel + " set rel=" + rel + " -> " + r;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency, dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);
  public static string Modes() {
    var seen = new System.Collections.Generic.SortedSet<string>();
    DEVMODE dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    for (int i = 0; EnumDisplaySettings(null, i, ref dm); i++) seen.Add(dm.dmPelsWidth + "x" + dm.dmPelsHeight);
    return string.Join(" ", seen);
  }
  public static string SetResolution(int w, int h) {
    DEVMODE dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    EnumDisplaySettings(null, -1, ref dm);
    dm.dmPelsWidth = w; dm.dmPelsHeight = h; dm.dmFields = 0x80000 | 0x100000;
    return "ChangeDisplaySettings " + w + "x" + h + " -> " + ChangeDisplaySettings(ref dm, 0);
  }
}
"@
[Hidpi]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null   # per-monitor v2, so we see real pixels

function Fixture {
  $f = Join-Path $env:USERPROFILE "Documents\Your site"
  Remove-Item -Recurse -Force $f -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Join-Path $f "Fruits") | Out-Null
  foreach ($n in "Apple.md", "Report.docx", "index.html") { Set-Content -Path (Join-Path $f $n) -Value "x" }
  return $f
}
function Report($name) {
  Start-Sleep -Seconds 3
  $w = [Hidpi]::GetSystemMetrics(0); $h = [Hidpi]::GetSystemMetrics(1)
  $win = (New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.LocationName -eq "Your site" } | Select-Object -First 1
  $hwnd = if ($win) { [IntPtr][int64]$win.HWND } else { [Hidpi]::FindWindow("CabinetWClass", $null) }
  Log "$name : screen ${w}x${h}, system dpi $([Hidpi]::GetDpiForSystem()), explorer window dpi $(if ($hwnd -ne [IntPtr]::Zero) { [Hidpi]::GetDpiForWindow($hwnd) } else { 'no window' })"
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen(0, 0, 0, 0, $bmp.Size)
  $bmp.Save("$Out\$Experiment-$name.png")
}
function OpenExplorer($f) {
  (New-Object -ComObject Shell.Application).MinimizeAll(); Start-Sleep -Seconds 2
  Start-Process explorer.exe -ArgumentList "`"$f`""; Start-Sleep -Seconds 8
}

Log "start: modes = $([Hidpi]::Modes())"
Report "before-no-window"
$f = Fixture

switch ($Experiment) {
  "dpi" {
    Log "SetScale 200: $([Hidpi]::SetScale(200))"
    Start-Sleep -Seconds 5
    OpenExplorer $f
    Report "explorer"
  }
  "res-dpi" {
    # ask for the biggest 16:9-ish mode, then 200%
    $best = ([Hidpi]::Modes() -split " " | Where-Object { $_ -match "^(\d+)x(\d+)$" } | Sort-Object { [int]($_ -split "x")[0] } | Select-Object -Last 1)
    $wh = $best -split "x"
    Log "SetResolution: $([Hidpi]::SetResolution([int]$wh[0], [int]$wh[1]))"
    Start-Sleep -Seconds 4
    Log "SetScale 200: $([Hidpi]::SetScale(200))"
    Start-Sleep -Seconds 5
    OpenExplorer $f
    Report "explorer"
  }
  "spi" {
    # SPI_SETLOGICALDPIOVERRIDE: relative scale steps above the recommended value
    foreach ($steps in 4, 3, 2, 1) {
      Log "SPI_SETLOGICALDPIOVERRIDE $steps -> $([Hidpi]::SystemParametersInfo(0x9F, $steps, [IntPtr]::Zero, 3))"
    }
    Start-Sleep -Seconds 5
    OpenExplorer $f
    Report "explorer"
  }
  "logpixels" {
    $k = "HKCU:\Control Panel\Desktop"
    Set-ItemProperty -Path $k -Name LogPixels -Value 192 -Type DWord
    Set-ItemProperty -Path $k -Name Win8DpiScaling -Value 1 -Type DWord
    New-Item -Path "$k\WindowMetrics" -Force | Out-Null
    Set-ItemProperty -Path "$k\WindowMetrics" -Name AppliedDPI -Value 192 -Type DWord
    Stop-Process -Name explorer -Force; Start-Sleep -Seconds 6
    OpenExplorer $f
    Report "explorer"
  }
  "rdp" {
    # A loopback Remote Desktop session with a 200% desktop scale factor: run
    # explorer inside that session and capture from there.
    $pw = "Pane-" + [guid]::NewGuid().ToString("N").Substring(0, 12) + "!"
    net user paneuser $pw /add | Out-Null
    net localgroup Administrators paneuser /add | Out-Null
    net localgroup "Remote Desktop Users" paneuser /add | Out-Null
    Set-ItemProperty -Path "HKLM:\System\CurrentControlSet\Control\Terminal Server" -Name fDenyTSConnections -Value 0
    Enable-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue
    Start-Service TermService -ErrorAction SilentlyContinue
    cmdkey /generic:TERMSRV/localhost /user:paneuser /pass:$pw | Out-Null
    $rdp = "$Out\pane.rdp"
    @"
full address:s:localhost
username:s:paneuser
desktopwidth:i:1600
desktopheight:i:1000
desktopscalefactor:i:200
smart sizing:i:0
prompt for credentials:i:0
authentication level:i:0
"@ | Set-Content $rdp
    # what to run inside the RDP session
    $cap = "C:\pane-cap.ps1"
    @"
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr c); [DllImport("user32.dll")] public static extern uint GetDpiForSystem(); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);' -Name W -Namespace N
[N.W]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null
`$f = Join-Path `$env:USERPROFILE 'Documents\Your site'
New-Item -ItemType Directory -Force -Path (Join-Path `$f 'Fruits') | Out-Null
Start-Process explorer.exe -ArgumentList "`"`$f`""
Start-Sleep -Seconds 10
`$w = [N.W]::GetSystemMetrics(0); `$h = [N.W]::GetSystemMetrics(1)
"session screen `${w}x`${h} dpi `$([N.W]::GetDpiForSystem())" | Out-File C:\pane-cap.log
`$b = New-Object System.Drawing.Bitmap `$w, `$h
[System.Drawing.Graphics]::FromImage(`$b).CopyFromScreen(0, 0, 0, 0, `$b.Size)
`$b.Save('C:\pane-cap.png')
"@ | Set-Content $cap
    Start-Process mstsc.exe -ArgumentList "`"$rdp`""
    Start-Sleep -Seconds 25
    Log "sessions: $(quser 2>&1 | Out-String)"
    schtasks /create /tn panecap /tr "powershell -ExecutionPolicy Bypass -File $cap" /sc once /st 00:00 /ru paneuser /rp $pw /it /rl highest /f 2>&1 | ForEach-Object { Log $_ }
    schtasks /run /tn panecap 2>&1 | ForEach-Object { Log $_ }
    Start-Sleep -Seconds 30
    Copy-Item C:\pane-cap.png "$Out\rdp-session.png" -ErrorAction SilentlyContinue
    Copy-Item C:\pane-cap.log "$Out\rdp-session.log" -ErrorAction SilentlyContinue
    Report "host-desktop"
  }
}
Log "done"
