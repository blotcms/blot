# Try to screenshot File Explorer on a hosted Windows runner.
# usage: windows.ps1 -Theme light|dark -Out <dir> -Label <name>
param([string]$Theme = "light", [string]$Out = "out", [string]$Label = "windows", [int]$Scale = 1, [int]$Width = 480)
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$fixture = Join-Path $env:USERPROFILE "Documents\Your site"
Remove-Item -Recurse -Force $fixture -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $fixture "Fruits") | Out-Null
# One subfolder plus one file of every type we need an icon for (keep in sync with
# make-fixture.sh). Images and HTML are Photoshop-style transparency grids.
$assets = Join-Path $PSScriptRoot "fixture-assets"
Copy-Item (Join-Path $assets "checker.png") (Join-Path $fixture "Logo.png")
Copy-Item (Join-Path $assets "checker.gif") (Join-Path $fixture "Animation.gif")
Copy-Item (Join-Path $assets "checker.jpg") (Join-Path $fixture "Photo.jpg")
Copy-Item (Join-Path $assets "checker.html") (Join-Path $fixture "index.html")
$text = @{
  "Fruits\Apple.md" = "Apple"; "Notes.md" = "# Notes"; "Draft.md" = "# Draft"
  "Plan.gdoc" = '{"doc_id":"1abc","resource_id":"document:1abc"}'; "Report.docx" = "docx"; "Old report.doc" = "doc"
  "Blot.webloc" = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>URL</key><string>https://blot.im</string></dict></plist>'
  "Tasks.org" = "* Heading"; "About.txt" = "Hello"
}
foreach ($k in $text.Keys) { Set-Content -Path (Join-Path $fixture $k) -Value $text[$k] }
# spread created/modified times across the years so each OS's date formats get exercised
$when = @(0, -3, -20, -45, -100, -200, -400, -800, -1200, -2000, -3000, -4000, -5000)
$i = 0
foreach ($item in Get-ChildItem $fixture -Recurse) {
  $d = (Get-Date).AddDays($when[$i % $when.Count]).AddMinutes(-13 * $i); $i++
  $item.CreationTime = $d.AddDays(-2); $item.LastWriteTime = $d
}

(Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber | Out-String) | Out-File "$Out\versions.txt"

$light = if ($Theme -eq "dark") { 0 } else { 1 }
$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name AppsUseLightTheme -Value $light -Type DWord
Set-ItemProperty -Path $key -Name SystemUsesLightTheme -Value $light -Type DWord

# clear the runner's console windows off the desktop first
# the runner leaves System Properties / Performance Options dialogs open
Get-Process SystemProperties* -ErrorAction SilentlyContinue | Stop-Process -Force
(New-Object -ComObject Shell.Application).MinimizeAll()
Start-Sleep -Seconds 2
Start-Process explorer.exe -ArgumentList "`"$fixture`""
Start-Sleep -Seconds 8

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
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Native -Name Win -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
[DllImport("user32.dll")] public static extern bool SystemParametersInfo(int a, int b, string c, int d);
[DllImport("user32.dll")] public static extern bool SetSysColors(int n, int[] i, int[] c);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
public struct RECT { public int Left, Top, Right, Bottom; }
"@
[Hidpi]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null  # per-monitor v2: real pixels
# Hide the navigation pane via UI Automation (View > Show > Navigation pane).
# Best-effort: everything is logged to uia.log so failures can be diagnosed.
$log = "$Out\uia.log"
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $A = [System.Windows.Automation.AutomationElement]
  $root = $A::RootElement
  function Find-Element($scope, $name) {
    $cond = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $name)
    return $scope.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  }
  function Press($el) {
    $p = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return "invoke" }
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand(); return "expand" }
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return "toggle" }
    return "no usable pattern"
  }
  function Shot($name) {
    $sb = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $sbmp = New-Object System.Drawing.Bitmap $sb.Width, $sb.Height
    [System.Drawing.Graphics]::FromImage($sbmp).CopyFromScreen($sb.Location, [System.Drawing.Point]::Empty, $sb.Size)
    $sbmp.Save("$Out\debug-$name.png")
  }
  Add-Type -Namespace Native -Name Mouse -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
"@
  function Click($x, $y) {
    # nudge, hover, press, hold, release: XAML menu items ignore an instant click
    [Native.Mouse]::SetCursorPos($x - 3, $y - 3) | Out-Null
    Start-Sleep -Milliseconds 200
    [Native.Mouse]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 700
    [Native.Mouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    [Native.Mouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  }
  # The window opens at a fixed place on the 1024x768 desktop. Open View, then
  # Show (last item), which opens the submenu containing Navigation pane.
  Click 660 183
  Start-Sleep -Seconds 2
  Click 650 555
  Start-Sleep -Seconds 2
  Shot "submenu"
  Click 867 559
  Start-Sleep -Seconds 2
  "clicked Navigation pane" | Out-File $log -Append
} catch { "uia error: $_" | Out-File $log -Append }
Start-Sleep -Seconds 1
[System.Windows.Forms.SendKeys]::SendWait("{ESC}")
$shellWin = (New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.LocationName -eq "Your site" } | Select-Object -First 1
$h = if ($shellWin) { [IntPtr][int64]$shellWin.HWND } else { [IntPtr]::Zero }
if ($h -eq [IntPtr]::Zero) { $h = [Native.Win]::FindWindow("CabinetWClass", $null) }

if ($Scale -ne 1) {
  # The navigation pane setting sticks, so hide it at 100% (above) and only then
  # scale up: Windows caps the scale by resolution (200% needs a 1600x1200 screen).
  $shellWin.Quit(); Start-Sleep -Seconds 2
  "resolution: $([Hidpi]::SetResolution(1600, 1200))" | Out-File "$Out\hidpi.log" -Append
  Start-Sleep -Seconds 4
  "scale $($Scale * 100)%: $([Hidpi]::SetScale($Scale * 100))" | Out-File "$Out\hidpi.log" -Append
  Start-Sleep -Seconds 5
  Start-Process explorer.exe -ArgumentList "`"$fixture`""; Start-Sleep -Seconds 8
  $shellWin = (New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.LocationName -eq "Your site" } | Select-Object -First 1
  $h = if ($shellWin) { [IntPtr][int64]$shellWin.HWND } else { [Native.Win]::FindWindow("CabinetWClass", $null) }
  "explorer dpi: $([Hidpi]::GetDpiForWindow($h))" | Out-File "$Out\hidpi.log" -Append
}
# a runner dialog ("System Properties") sometimes sits behind the window; close it
$dlg = [Native.Win]::FindWindow("#32770", "System Properties")
if ($dlg -ne [IntPtr]::Zero) { [Native.Win]::SendMessage($dlg, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
# Desktop: Photoshop-style white and mid-grey squares (20 logical px), which makes
# the window's drop shadow easy to measure. Tiled wallpaper is drawn at physical
# pixel size, so build the tile at the current scale.
$sq = 20 * $Scale
$tb = New-Object System.Drawing.Bitmap (2 * $sq), (2 * $sq)
$tg = [System.Drawing.Graphics]::FromImage($tb)
$tg.Clear([System.Drawing.Color]::White)
$greyBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(153, 153, 153))
$tg.FillRectangle($greyBrush, 0, 0, $sq, $sq); $tg.FillRectangle($greyBrush, $sq, $sq, $sq, $sq)
$tileFile = Join-Path $env:TEMP "desktop-tile.bmp"
$tb.Save($tileFile, [System.Drawing.Imaging.ImageFormat]::Bmp)
Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name WallpaperStyle -Value "0"
Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name TileWallpaper -Value "1"
[Native.Win]::SystemParametersInfo(0x14, 0, $tileFile, 3) | Out-Null
Start-Sleep -Seconds 2

# Size the window (logical px x scale) and keep it clear of the screen edges and
# taskbar, leaving room for its shadow. Icons sit in a column at the left of the
# desktop, so the window (and so the capture) stays to their right.
$sw = [Hidpi]::GetSystemMetrics(0); $sh = [Hidpi]::GetSystemMetrics(1)
# 80px of desktop around the window (the screen is short at 200%, and the "Test Mode"
# watermark sits above the taskbar at the bottom right)
$taskbar = 48 * $Scale; $pad = 80 * $Scale; $left = 176 * $Scale
# 480x360 logical px. MoveWindow includes Explorer's invisible 7px resize borders
# (left, right, bottom), so ask for a little more to get a visible 480 wide.
$winH = (360 + 7) * $Scale
$suffix = if ($Scale -ne 1) { "@${Scale}x" } else { "" }
function Place($width) { [Native.Win]::MoveWindow($h, $left - 7 * $Scale, $pad, ($width + 14) * $Scale, $winH, $true) | Out-Null; Start-Sleep -Seconds 2 }
function Capture($name) {
  $r = New-Object Native.Win+RECT
  [Native.Win]::DwmGetWindowAttribute($h, 9, [ref]$r, [System.Runtime.InteropServices.Marshal]::SizeOf($r)) | Out-Null
  # click the tab (moves keyboard focus off the toolbar), then park the mouse on the
  # desktop so no tooltip or hover state is captured
  Click ($r.Left + 40 * $Scale) ($r.Top + 22 * $Scale)
  [Native.Mouse]::SetCursorPos($sw - 4, 4) | Out-Null
  Start-Sleep -Seconds 2
  $x0 = [Math]::Max(0, $r.Left - $pad); $y0 = [Math]::Max(0, $r.Top - $pad)
  $x1 = [Math]::Min($sw, $r.Right + $pad); $y1 = [Math]::Min($sh - $taskbar, $r.Bottom + $pad)
  "window: $($r.Left),$($r.Top) $($r.Right - $r.Left)x$($r.Bottom - $r.Top); capture $x0,$y0 $($x1 - $x0)x$($y1 - $y0)" | Out-File "$Out\versions.txt" -Append
  $bmp = New-Object System.Drawing.Bitmap ($x1 - $x0), ($y1 - $y0)
  [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($x0, $y0, 0, 0, $bmp.Size)
  $bmp.Save("$Out\$name.png", [System.Drawing.Imaging.ImageFormat]::Png)
}
Place $Width
Capture "$Label-$Theme$suffix"   # Details, Explorer's default

# The other view options. The command bar collapses View into an overflow menu at
# narrow widths, so widen the window to pick each one, then narrow it to capture.
# Menu items sit at fixed offsets below the View button (measured at 100%).
# (index = position in the View flyout; opening it through UI Automation puts the
# keyboard focus on the first item, and mouse clicks on flyout items don't register)
$views = @(
  @("icons", 2), @("list", 4), @("tiles", 6), @("content", 7)
)
foreach ($v in $views) {
  try {
    Place 800
    $btn = Find-Element $root "View"
    Press $btn | Out-Null; Start-Sleep -Seconds 2
    for ($i = 0; $i -lt $v[1]; $i++) { [System.Windows.Forms.SendKeys]::SendWait("{DOWN}"); Start-Sleep -Milliseconds 250 }
        [System.Windows.Forms.SendKeys]::SendWait("{ENTER}"); Start-Sleep -Seconds 2
    Place $Width
    Capture "$Label-$Theme$suffix-$($v[0])"
  } catch { "view $($v[0]) failed: $_" | Out-File $log -Append }
}
Get-Process explorer | Select-Object Id, MainWindowTitle | Out-String | Out-File "$Out\processes.txt"
