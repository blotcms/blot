# Try to screenshot File Explorer on a hosted Windows runner.
# usage: windows.ps1 -Theme light|dark -Out <dir> -Label <name>
param([string]$Theme = "light", [string]$Out = "out", [string]$Label = "windows")
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$fixture = Join-Path $env:USERPROFILE "Documents\Your site"
Remove-Item -Recurse -Force $fixture -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $fixture "Fruits") | Out-Null
# One subfolder plus one file of every type we need an icon for (keep in sync with make-fixture.sh)
$png = [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
$gif = [Convert]::FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
[IO.File]::WriteAllBytes((Join-Path $fixture "Logo.png"), $png)
[IO.File]::WriteAllBytes((Join-Path $fixture "Animation.gif"), $gif)
$text = @{
  "Fruits\Apple.md" = "Apple"; "Notes.markdown" = "# Notes"; "Draft.md" = "# Draft"; "Photo.jpg" = "jpeg"
  "Plan.gdoc" = '{"doc_id":"1abc","resource_id":"document:1abc"}'; "Report.docx" = "docx"; "Old report.doc" = "doc"
  "Blot.webloc" = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>URL</key><string>https://blot.im</string></dict></plist>'
  "Blot.url" = "[InternetShortcut]`r`nURL=https://blot.im"; "index.html" = "<h1>Hello</h1>"; "Tasks.org" = "* Heading"; "About.txt" = "Hello"
}
foreach ($k in $text.Keys) { Set-Content -Path (Join-Path $fixture $k) -Value $text[$k] }

(Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber | Out-String) | Out-File "$Out\versions.txt"

$light = if ($Theme -eq "dark") { 0 } else { 1 }
$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name AppsUseLightTheme -Value $light -Type DWord
Set-ItemProperty -Path $key -Name SystemUsesLightTheme -Value $light -Type DWord

# clear the runner's console windows off the desktop first
(New-Object -ComObject Shell.Application).MinimizeAll()
Start-Sleep -Seconds 2
Start-Process explorer.exe -ArgumentList "`"$fixture`""
Start-Sleep -Seconds 8

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
[Native.Win]::SetProcessDPIAware() | Out-Null
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
    [Native.Mouse]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 300
    [Native.Mouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [Native.Mouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
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

# Plain mild-grey desktop with no icons, so the window's shadow is visible
Set-ItemProperty -Path "HKCU:\Control Panel\Colors" -Name Background -Value "128 128 128"
[Native.Win]::SystemParametersInfo(0x14, 0, "", 3) | Out-Null
[Native.Win]::SetSysColors(1, @(1), @(0x808080)) | Out-Null
$progman = [Native.Win]::FindWindow("Progman", $null)
[Native.Win]::SendMessage($progman, 0x111, [IntPtr]0x7402, [IntPtr]::Zero) | Out-Null  # toggle desktop icons

# Move the window clear of the desktop edges and taskbar, leaving room for its shadow
[Native.Win]::MoveWindow($h, 170, 30, 800, 640, $true) | Out-Null
Start-Sleep -Seconds 2

$r = New-Object Native.Win+RECT
[Native.Win]::DwmGetWindowAttribute($h, 9, [ref]$r, [System.Runtime.InteropServices.Marshal]::SizeOf($r)) | Out-Null
$pad = 60
$x0 = [Math]::Max(0, $r.Left - $pad); $y0 = [Math]::Max(0, $r.Top - $pad)
$x1 = [Math]::Min(1024, $r.Right + $pad); $y1 = [Math]::Min(700, $r.Bottom + $pad)
"window: $($r.Left),$($r.Top) $($r.Right - $r.Left)x$($r.Bottom - $r.Top); capture $x0,$y0 $($x1 - $x0)x$($y1 - $y0)" | Out-File "$Out\versions.txt" -Append
$bmp = New-Object System.Drawing.Bitmap ($x1 - $x0), ($y1 - $y0)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x0, $y0, 0, 0, $bmp.Size)
$bmp.Save("$Out\$Label-$Theme.png", [System.Drawing.Imaging.ImageFormat]::Png)
Get-Process explorer | Select-Object Id, MainWindowTitle | Out-String | Out-File "$Out\processes.txt"
