<#
  Mediarr system tray.

  Runs Mediarr in the background (no console window) and puts an icon in the notification area.
  Right-click: Open, Start, Stop, Restart, Reset password, Start when Windows starts, Open log, Quit.
  Launch it with tray\Mediarr.vbs (no window flashes) or "npm run tray".

  Uses the PORT and MEDIARR_DATA environment variables if set, like the server does.
  Keep this file ASCII-only: Windows PowerShell 5.1 misreads UTF-8 files without a BOM.
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$Root = Split-Path -Parent $PSScriptRoot
$Port = if ($env:PORT) { [int]$env:PORT } else { 7979 }
$DataDir = if ($env:MEDIARR_DATA) { $env:MEDIARR_DATA } else { Join-Path $Root 'data' }
$LogFile = Join-Path $DataDir 'mediarr.log'
$SetupCodeFile = Join-Path $DataDir 'setup-code.txt'
$ServerJs = Join-Path $Root 'server\dist\index.js'
$ResetJs = Join-Path $Root 'server\dist\resetPassword.js'
$Url = "http://localhost:$Port"
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunValue = 'Mediarr'
$Launcher = Join-Path $PSScriptRoot 'Mediarr.vbs'
# Must match startupCommand() in server/src/system/autostart.ts (the Settings page toggles the same entry).
$StartupCommand = "wscript.exe `"$Launcher`""

# One tray per port.
$createdNew = $false
$script:Mutex = New-Object System.Threading.Mutex($true, "Local\MediarrTray-$Port", [ref]$createdNew)
if (-not $createdNew) { exit 0 }

$Node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $Node) {
  [System.Windows.Forms.MessageBox]::Show("Node.js wasn't found. Install it from nodejs.org, then start Mediarr again.", 'Mediarr', 'OK', 'Error') | Out-Null
  exit 1
}
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$script:Proc = $null          # the Mediarr server process we control
$script:WantRunning = $false  # false after Stop/Quit, so an exit isn't reported as a crash
$script:SetupTipShown = $false

# ---------- Icon ----------
function New-TrayIcon([System.Drawing.Color]$Back) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 9
  $path.AddArc(1, 1, $r, $r, 180, 90); $path.AddArc(31 - $r, 1, $r, $r, 270, 90)
  $path.AddArc(31 - $r, 31 - $r, $r, $r, 0, 90); $path.AddArc(1, 31 - $r, $r, $r, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush $Back), $path)
  $font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $g.DrawString('M', $font, (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(26, 19, 5))), (New-Object System.Drawing.RectangleF(0, 1, 32, 32)), $fmt)
  $g.Dispose()
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$IconRunning = New-TrayIcon ([System.Drawing.Color]::FromArgb(245, 165, 36))
$IconStopped = New-TrayIcon ([System.Drawing.Color]::FromArgb(130, 130, 130))

$Tray = New-Object System.Windows.Forms.NotifyIcon
$Tray.Icon = $IconStopped
$Tray.Text = 'Mediarr'
$Tray.Visible = $true

function Show-Tip([string]$Text, [string]$Kind = 'Info') {
  $Tray.ShowBalloonTip(6000, 'Mediarr', $Text, [System.Windows.Forms.ToolTipIcon]::$Kind)
}

function Write-Log([string]$Text) {
  try { Add-Content -Path $LogFile -Value ("{0} TRAY  {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $Text) } catch { }
}

# ---------- Server control ----------
function Test-PortOpen {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $wait = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    return ($wait.AsyncWaitHandle.WaitOne(300) -and $client.Connected)
  } catch { return $false } finally { $client.Close() }
}

# A Mediarr from this folder that's already listening (started by start.bat, or by an earlier tray).
function Find-RunningServer {
  if (-not (Test-PortOpen)) { return $null }
  try {
    # Node processes running this folder's server (port lookups via netstat/Get-NetTCPConnection
    # aren't reliable on every system, so the command line is what identifies it).
    $mine = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($ServerJs.ToLower()) })
    if ($mine.Count -eq 1) { return Get-Process -Id $mine[0].ProcessId }
    if ($mine.Count -gt 1) {
      # Several copies (different ports): use netstat as a tie-breaker when it can see the listener.
      $line = netstat -ano | Where-Object { $_ -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$" } | Select-Object -First 1
      if ($line) {
        $ownerPid = [int]([regex]::Match($line, '(\d+)\s*$').Groups[1].Value)
        if ($mine.ProcessId -contains $ownerPid) { return Get-Process -Id $ownerPid }
      }
    }
  } catch { }
  return $null
}

function Test-Running { return ($script:Proc -and -not $script:Proc.HasExited) }

function Start-Mediarr {
  if (Test-Running) { return }
  $existing = Find-RunningServer
  if ($existing) { $script:Proc = $existing; $script:WantRunning = $true; Update-Status; return }
  if (Test-PortOpen) { Show-Tip "Port $Port is already in use by another program, so Mediarr can't start." 'Warning'; return }
  if (-not (Test-Path $ServerJs)) { Show-Tip "Mediarr isn't built yet. Run 'npm run build' in $Root, then Start." 'Error'; return }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Node
  $psi.Arguments = '"' + $ServerJs + '"'
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['MEDIARR_LOG_FILE'] = $LogFile
  $psi.EnvironmentVariables['PORT'] = "$Port"
  $psi.EnvironmentVariables['MEDIARR_DATA'] = $DataDir
  $psi.EnvironmentVariables['MEDIARR_TRAY'] = '1'
  Write-Log 'Starting Mediarr'
  $script:Proc = [System.Diagnostics.Process]::Start($psi)
  $script:WantRunning = $true
  $script:SetupTipShown = $false
  Update-Status
}

function Stop-Mediarr {
  $script:WantRunning = $false
  if (Test-Running) {
    Write-Log 'Stopping Mediarr'
    try { $script:Proc.Kill(); $script:Proc.WaitForExit(5000) | Out-Null } catch { }
  }
  $script:Proc = $null
  Update-Status
}

function Restart-Mediarr {
  Stop-Mediarr
  Start-Sleep -Milliseconds 500
  Start-Mediarr
}

# ---------- Start with Windows ----------
function Get-Autostart {
  try {
    $value = (Get-ItemProperty -Path $RunKey -Name $RunValue -ErrorAction Stop).$RunValue
    return $value.ToLower().Contains($Launcher.ToLower())
  } catch { return $false }
}

function Set-Autostart([bool]$Enabled) {
  if ($Enabled) { Set-ItemProperty -Path $RunKey -Name $RunValue -Value $StartupCommand }
  else { Remove-ItemProperty -Path $RunKey -Name $RunValue -ErrorAction SilentlyContinue }
}

# ---------- Reset password ----------
function Show-Prompt([string]$Title, [string]$Message) {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $Title; $form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'
  $form.MinimizeBox = $false; $form.MaximizeBox = $false; $form.TopMost = $true
  $form.ClientSize = New-Object System.Drawing.Size(420, 150)
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Message; $label.SetBounds(14, 12, 392, 48)
  $box = New-Object System.Windows.Forms.TextBox
  $box.SetBounds(14, 66, 392, 24)
  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'Reset password'; $ok.SetBounds(196, 106, 120, 30); $ok.DialogResult = 'OK'
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = 'Cancel'; $cancel.SetBounds(322, 106, 84, 30); $cancel.DialogResult = 'Cancel'
  $form.Controls.AddRange(@($label, $box, $ok, $cancel))
  $form.AcceptButton = $ok; $form.CancelButton = $cancel
  if ($form.ShowDialog() -eq 'OK') { return $box.Text.Trim() }
  return $null
}

function Show-Password([string]$Account, [string]$Password) {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Mediarr - password reset'; $form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'
  $form.MinimizeBox = $false; $form.MaximizeBox = $false; $form.TopMost = $true
  $form.ClientSize = New-Object System.Drawing.Size(440, 170)
  $label = New-Object System.Windows.Forms.Label
  $label.Text = "New password for `"$Account`". Two-factor was turned off and every session was signed out. Sign in and change it under Settings > Security."
  $label.SetBounds(14, 12, 412, 52)
  $box = New-Object System.Windows.Forms.TextBox
  $box.Text = $Password; $box.ReadOnly = $true
  $box.Font = New-Object System.Drawing.Font('Consolas', 12)
  $box.SetBounds(14, 72, 412, 28)
  $copy = New-Object System.Windows.Forms.Button
  $copy.Text = 'Copy'; $copy.SetBounds(256, 124, 80, 30)
  $copy.Add_Click({ [System.Windows.Forms.Clipboard]::SetText($Password); $copy.Text = 'Copied' }.GetNewClosure())
  $close = New-Object System.Windows.Forms.Button
  $close.Text = 'Close'; $close.SetBounds(346, 124, 80, 30); $close.DialogResult = 'OK'
  $form.Controls.AddRange(@($label, $box, $copy, $close))
  $form.AcceptButton = $close
  $form.ShowDialog() | Out-Null
}

function Invoke-ResetPassword {
  if (-not (Test-Path $ResetJs)) { Show-Tip "Mediarr isn't built yet. Run 'npm run build' first." 'Error'; return }
  $account = Show-Prompt 'Mediarr - reset password' 'Account to reset (leave empty if there is only one). It gets a new random password, two-factor is turned off, and it is signed out everywhere.'
  if ($null -eq $account) { return }  # cancelled: nothing is changed

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Node
  $psi.Arguments = '"' + $ResetJs + '"' + $(if ($account) { ' "' + $account.Replace('"', '') + '"' } else { '' })
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.EnvironmentVariables['MEDIARR_DATA'] = $DataDir
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEnd() + $p.StandardError.ReadToEnd()
  $p.WaitForExit()

  $match = [regex]::Match($out, 'New password: (\S+)')
  $who = [regex]::Match($out, 'Password for "([^"]+)"')
  if ($match.Success) { Show-Password $who.Groups[1].Value $match.Groups[1].Value }
  else { [System.Windows.Forms.MessageBox]::Show($out.Trim(), 'Mediarr - reset password', 'OK', 'Information') | Out-Null }
}

# ---------- Menu ----------
$Menu = New-Object System.Windows.Forms.ContextMenuStrip
function Add-Item([string]$Text, [scriptblock]$OnClick) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem $Text
  if ($OnClick) { $item.Add_Click($OnClick) }
  [void]$Menu.Items.Add($item)
  return $item
}
$StatusItem = Add-Item 'Mediarr' $null; $StatusItem.Enabled = $false
[void]$Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$OpenItem = Add-Item 'Open Mediarr' { Start-Process $Url }
$OpenItem.Font = New-Object System.Drawing.Font($OpenItem.Font, [System.Drawing.FontStyle]::Bold)
[void]$Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$StartItem = Add-Item 'Start' { Start-Mediarr }
$StopItem = Add-Item 'Stop' { Stop-Mediarr }
$RestartItem = Add-Item 'Restart' { Restart-Mediarr }
[void]$Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$ResetItem = Add-Item 'Reset password...' { Invoke-ResetPassword }
$AutoItem = Add-Item 'Start when Windows starts' { Set-Autostart (-not (Get-Autostart)); $AutoItem.Checked = Get-Autostart }
$LogItem = Add-Item 'Open log' { if (Test-Path $LogFile) { Start-Process notepad.exe $LogFile } else { Show-Tip 'No log yet.' } }
[void]$Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$QuitItem = Add-Item 'Quit' {
  # Stops Mediarr and removes the tray icon completely.
  Stop-Mediarr
  $Tray.Visible = $false
  $Tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
}
$Menu.Add_Opening({ $AutoItem.Checked = Get-Autostart })
$Tray.ContextMenuStrip = $Menu
$Tray.Add_MouseDoubleClick({ if ($_.Button -eq 'Left') { Start-Process $Url } })
$Tray.Add_BalloonTipClicked({ Start-Process $Url })

function Update-Status {
  $running = Test-Running
  $Tray.Icon = if ($running) { $IconRunning } else { $IconStopped }
  $Tray.Text = if ($running) { "Mediarr - running on port $Port" } else { 'Mediarr - stopped' }
  $StatusItem.Text = if ($running) { "Running at $Url" } else { 'Stopped' }
  $OpenItem.Enabled = $running
  $StartItem.Enabled = -not $running
  $StopItem.Enabled = $running
  $RestartItem.Enabled = $running
}

# Every 2 s: notice crashes, show the first-run setup code, keep the icon current.
$Timer = New-Object System.Windows.Forms.Timer
$Timer.Interval = 2000
$Timer.Add_Tick({
  if ($script:WantRunning -and $script:Proc -and $script:Proc.HasExited) {
    $code = $null
    try { $code = $script:Proc.ExitCode } catch { }
    $script:Proc = $null
    if ($code -eq 75) {
      # Mediarr installed an update and asked to be started again.
      Write-Log 'Mediarr updated; starting the new version'
      Start-Mediarr
      Show-Tip 'Mediarr was updated and has restarted.'
    } else {
      $script:WantRunning = $false
      Write-Log 'Mediarr exited unexpectedly'
      Show-Tip 'Mediarr stopped unexpectedly. Right-click the icon > Open log to see why, or Start to try again.' 'Error'
    }
  }
  if (-not $script:SetupTipShown -and (Test-Running) -and (Test-Path $SetupCodeFile)) {
    $script:SetupTipShown = $true
    $code = (Get-Content $SetupCodeFile -Raw).Trim()
    Show-Tip "No account yet. Click here to open Mediarr and create one. Setup code: $code"
  }
  Update-Status
})

Start-Mediarr
Update-Status

# MEDIARR_TRAY_SELFTEST=1: drive the same Start/Stop/Restart/Quit code without clicking, logging each step
# (used to test the tray; never touches the Windows startup entry).
if ($env:MEDIARR_TRAY_SELFTEST) {
  function Wait-Port([bool]$Open) { for ($i = 0; $i -lt 40; $i++) { if ((Test-PortOpen) -eq $Open) { return $true }; Start-Sleep -Milliseconds 250 }; return $false }
  Write-Log ("SELFTEST start: listening={0} pid={1}" -f (Wait-Port $true), $script:Proc.Id)
  $first = $script:Proc.Id
  Restart-Mediarr
  Write-Log ("SELFTEST restart: listening={0} newPid={1}" -f (Wait-Port $true), ($script:Proc.Id -ne $first))
  Stop-Mediarr
  Write-Log ("SELFTEST stop: closed={0} running={1}" -f (Wait-Port $false), (Test-Running))
  Start-Mediarr
  Write-Log ("SELFTEST start again: listening={0}" -f (Wait-Port $true))
  $QuitItem.PerformClick()
  Write-Log ("SELFTEST quit: closed={0}" -f (Wait-Port $false))
  exit 0
}

$Timer.Start()
[System.Windows.Forms.Application]::Run()
$script:Mutex.ReleaseMutex()
