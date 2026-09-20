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

Start-Process explorer.exe -ArgumentList "`"$fixture`""
Start-Sleep -Seconds 8

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
"screen: $($b.Width)x$($b.Height)" | Out-File "$Out\versions.txt" -Append
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save("$Out\$Label-$Theme-screen.png", [System.Drawing.Imaging.ImageFormat]::Png)
Get-Process explorer | Select-Object Id, MainWindowTitle | Out-String | Out-File "$Out\processes.txt"
