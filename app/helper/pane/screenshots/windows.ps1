# Try to screenshot File Explorer on a hosted Windows runner.
# usage: windows.ps1 -Theme light|dark -Out <dir> -Label <name>
param([string]$Theme = "light", [string]$Out = "out", [string]$Label = "windows")
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$fixture = Join-Path $env:USERPROFILE "Documents\Your site"
Remove-Item -Recurse -Force $fixture -ErrorAction SilentlyContinue
foreach ($d in "Fruits\Tasty", "Pages", "Posts") { New-Item -ItemType Directory -Force -Path (Join-Path $fixture $d) | Out-Null }
foreach ($f in "Fruits\Apple.md", "Fruits\Pear.txt", "Fruits\Tasty\Mango.md", "Pages\About.txt", "Pages\Contact.docx", "Introduction.docx", "index.html") {
  Set-Content -Path (Join-Path $fixture $f) -Value "x"
}

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
  # Open the View flyout, then drive it by keyboard: End = last item (Show),
  # Right = open the submenu on its first item (Navigation pane), Enter = toggle.
  $view = Find-Element $root "View"
  if (-not $view) { throw "View button not found" }
  Press $view | Out-Null
  Start-Sleep -Seconds 2
  [System.Windows.Forms.SendKeys]::SendWait("{END}")
  Start-Sleep -Milliseconds 700
  [System.Windows.Forms.SendKeys]::SendWait("{RIGHT}")
  Start-Sleep -Seconds 1
  Shot "submenu"
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  Start-Sleep -Seconds 2
  "drove flyout by keyboard" | Out-File $log -Append
} catch { "uia error: $_" | Out-File $log -Append }
Start-Sleep -Seconds 1
[System.Windows.Forms.SendKeys]::SendWait("{ESC}")
$shellWin = (New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.LocationName -eq "Your site" } | Select-Object -First 1
$h = if ($shellWin) { [IntPtr][int64]$shellWin.HWND } else { [IntPtr]::Zero }
if ($h -eq [IntPtr]::Zero) { $h = [Native.Win]::FindWindow("CabinetWClass", $null) }
$r = New-Object Native.Win+RECT
[Native.Win]::DwmGetWindowAttribute($h, 9, [ref]$r, [System.Runtime.InteropServices.Marshal]::SizeOf($r)) | Out-Null
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
"window: $($r.Left),$($r.Top) ${w}x${ht}" | Out-File "$Out\versions.txt" -Append
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$bmp.Save("$Out\$Label-$Theme.png", [System.Drawing.Imaging.ImageFormat]::Png)
Get-Process explorer | Select-Object Id, MainWindowTitle | Out-String | Out-File "$Out\processes.txt"
