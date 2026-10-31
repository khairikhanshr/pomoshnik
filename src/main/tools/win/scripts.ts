// Windows PowerShell 5.1 script bodies. Each runs inside buildPsScript(): $A holds the parsed
// JARVIS_ARGS JSON and Send-Result returns a value. Never interpolate user data into these strings.
// PowerShell 5.1 syntax only (no ternary, ??, && / ||, -Parallel) and no backticks.
import { CS_AUDIO, CS_DISPLAY, CS_INPUT, CS_WINDOW } from './native'
import { psAddType } from './ps'

/** Media / volume keys only — small, so it compiles fast. */
const CS_MEDIA_KEYS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class JarvisMediaKeys {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  public static void Tap(int vk, int times) {
    for (int i = 0; i < times; i++) {
      keybd_event((byte)vk, 0, 0x0001u, UIntPtr.Zero);
      keybd_event((byte)vk, 0, 0x0003u, UIntPtr.Zero);
      Thread.Sleep(12);
    }
  }
}
`

/** Start menu apps: Get-StartApps (localized names + AppUserModelIDs), shortcut scan as fallback. */
export const PS_START_APPS = String.raw`
$apps = @()
if (Get-Command -Name Get-StartApps -ErrorAction SilentlyContinue) {
  try {
    $apps = @(Get-StartApps | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; id = [string]$_.AppID; kind = 'appx' } })
  } catch { $apps = @() }
}
if ($apps.Count -eq 0) {
  $roots = @([Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('Programs'))
  $apps = @(foreach ($root in $roots) {
    if ($root -and (Test-Path -LiteralPath $root)) {
      Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in @('.lnk', '.url', '.appref-ms') } |
        ForEach-Object { [pscustomobject]@{ name = $_.BaseName; id = $_.FullName; kind = 'shortcut' } }
    }
  })
}
Send-Result $apps
`

export const PS_START_PROCESS = String.raw`
$p = Start-Process -FilePath ([string]$A.target) -PassThru
$id = $null
if ($p) { $id = $p.Id }
Send-Result @{ id = $id }
`

/** Processes that own a visible top-level window. */
export const PS_LIST_WINDOWS = String.raw`
$list = @(foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })) {
  $desc = $null
  $path = $null
  try { $desc = [string]$p.MainModule.FileVersionInfo.FileDescription } catch {}
  try { $path = [string]$p.Path } catch {}
  [pscustomobject]@{ id = $p.Id; name = [string]$p.ProcessName; title = [string]$p.MainWindowTitle; description = $desc; path = $path }
})
Send-Result $list
`

/** Graceful close (CloseMainWindow) or Stop-Process -Force, then waits briefly for the exit. */
export const PS_CLOSE = String.raw`
$force = [bool]$A.force
$targets = @()
foreach ($id in @($A.ids)) {
  $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
  if ($p) { $targets += $p }
}
foreach ($p in $targets) {
  try {
    if ($force) { Stop-Process -Id $p.Id -Force -ErrorAction Stop } else { [void]$p.CloseMainWindow() }
  } catch {}
}
$alive = @($targets)
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while ($alive.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 250
  $alive = @($targets | Where-Object { Get-Process -Id $_.Id -ErrorAction SilentlyContinue })
}
Send-Result @{ requested = $targets.Count; alive = @($alive | ForEach-Object { $_.Id }) }
`

export const PS_FOCUS = `${psAddType(CS_WINDOW)}${String.raw`
$p = Get-Process -Id ([int]$A.id) -ErrorAction Stop
$ok = [JarvisWindow]::Focus($p.MainWindowHandle.ToInt64())
if (-not $ok) {
  try { $ok = [bool](New-Object -ComObject WScript.Shell).AppActivate([int]$p.Id) } catch {}
}
Send-Result @{ ok = [bool]$ok; title = [string]$p.MainWindowTitle }
`}`

/** $A: { action, x?, y? (physical pixels), dy? } */
export const PS_MOUSE = `${psAddType(CS_INPUT)}${String.raw`
[JarvisInput]::DpiAware()
$action = [string]$A.action
if ($null -ne $A.x -and $null -ne $A.y) {
  [JarvisInput]::Move([int]$A.x, [int]$A.y)
  Start-Sleep -Milliseconds 40
}
switch ($action) {
  'move' { }
  'click' { [JarvisInput]::Click('left', 1) }
  'double_click' { [JarvisInput]::Click('left', 2) }
  'right_click' { [JarvisInput]::Click('right', 1) }
  'scroll' { [JarvisInput]::Scroll([int]$A.dy) }
  default { throw ('Unknown mouse action: ' + $action) }
}
$pos = [JarvisInput]::Position()
Send-Result @{ x = $pos[0]; y = $pos[1] }
`}`

/** $A: { combos: [{ vks: number[], ext: (0|1)[] }] } — modifiers first, main key last. */
export const PS_KEYS = `${psAddType(CS_INPUT)}${String.raw`
$count = 0
foreach ($combo in @($A.combos)) {
  [JarvisInput]::Combo([int[]]@($combo.vks), [int[]]@($combo.ext))
  $count++
  Start-Sleep -Milliseconds 40
}
Send-Result @{ count = $count }
`}`

/** $A: { level?: 0-100, change?: number, mute?: bool }. Exact via IAudioEndpointVolume, volume keys as fallback. */
export const PS_VOLUME = String.raw`
$exact = $true
try {
${psAddType(CS_AUDIO)}
} catch { $exact = $false }
$result = $null
if ($exact) {
  try {
    if ($null -ne $A.level) {
      [JarvisAudio]::SetLevel([float]([double]$A.level / 100))
    } elseif ($null -ne $A.change) {
      [JarvisAudio]::SetLevel([float](([JarvisAudio]::GetLevel() * 100 + [double]$A.change) / 100))
    }
    if ($null -ne $A.mute) {
      [JarvisAudio]::SetMute([bool]$A.mute)
    } elseif ($null -ne $A.level -or ($null -ne $A.change -and [double]$A.change -gt 0)) {
      [JarvisAudio]::SetMute($false)
    }
    $result = @{ level = [int][math]::Round([JarvisAudio]::GetLevel() * 100); muted = [JarvisAudio]::GetMute(); exact = $true }
  } catch { $exact = $false }
}
if (-not $exact) {
${psAddType(CS_MEDIA_KEYS)}
  if ($null -ne $A.level) {
    [JarvisMediaKeys]::Tap(0xAE, 50)
    [JarvisMediaKeys]::Tap(0xAF, [int][math]::Round([double]$A.level / 2))
  } elseif ($null -ne $A.change) {
    $steps = [int][math]::Round([math]::Abs([double]$A.change) / 2)
    if ([double]$A.change -gt 0) { [JarvisMediaKeys]::Tap(0xAF, $steps) } else { [JarvisMediaKeys]::Tap(0xAE, $steps) }
  }
  if ($null -ne $A.mute) { [JarvisMediaKeys]::Tap(0xAD, 1) }
  $result = @{ level = $null; muted = $null; exact = $false }
}
Send-Result $result
`

/** $A: { vk } — media virtual key (play/pause 0xB3, next 0xB0, previous 0xB1). */
export const PS_MEDIA_KEY = `${psAddType(CS_MEDIA_KEYS)}${String.raw`
[JarvisMediaKeys]::Tap([int]$A.vk, 1)
Send-Result @{ ok = $true }
`}`

export const PS_SLEEP = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Send-Result @{ ok = $true }
[void][System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)
`

export const PS_DISPLAY_OFF = `${psAddType(CS_DISPLAY)}${String.raw`
[JarvisDisplay]::Off()
Send-Result @{ ok = $true }
`}`

/** Executable of the default https handler (registry UserChoice -> ProgId -> open command). */
export const PS_DEFAULT_BROWSER = String.raw`
$progId = $null
$exe = $null
try {
  $progId = [string](Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction Stop).ProgId
} catch {}
if ($progId) {
  try {
    $command = [string](Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $progId + '\shell\open\command') -ErrorAction Stop).'(default)'
    if ($command -match '^\s*"([^"]+)"') { $exe = $Matches[1] } elseif ($command -match '^\s*(\S+)') { $exe = $Matches[1] }
  } catch {}
}
Send-Result @{ progId = $progId; exe = $exe }
`

export const PS_SYSTEM_INFO = String.raw`
$os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction SilentlyContinue
$bat = @(Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue)
$battery = $null
if ($bat.Count -gt 0) {
  $battery = @{ percent = [int]$bat[0].EstimatedChargeRemaining; status = [int]$bat[0].BatteryStatus; minutes = [long]$bat[0].EstimatedRunTime }
}
Send-Result @{ caption = [string]$os.Caption; version = [string]$os.Version; build = [string]$os.BuildNumber; battery = $battery }
`

/** $A: { command, cwd? } — the user-confirmed command is evaluated by Invoke-Expression, never spliced into this source. */
export const PS_RUN_COMMAND = String.raw`
$cwd = [string]$A.cwd
if ($cwd) { Set-Location -LiteralPath $cwd }
$ErrorActionPreference = 'Continue'
$code = 0
$text = ''
try {
  $text = (Invoke-Expression -Command ([string]$A.command) 2>&1 | Out-String -Width 220)
  if ($LASTEXITCODE) { $code = [int]$LASTEXITCODE }
} catch {
  $text = $text + ($_ | Out-String -Width 220)
  $code = 1
}
Send-Result @{ output = $text; code = $code }
`

/** Every script, for syntax checks in tests. */
export const WINDOWS_SCRIPTS: Readonly<Record<string, string>> = {
  startApps: PS_START_APPS,
  startProcess: PS_START_PROCESS,
  listWindows: PS_LIST_WINDOWS,
  close: PS_CLOSE,
  focus: PS_FOCUS,
  mouse: PS_MOUSE,
  keys: PS_KEYS,
  volume: PS_VOLUME,
  mediaKey: PS_MEDIA_KEY,
  sleep: PS_SLEEP,
  displayOff: PS_DISPLAY_OFF,
  defaultBrowser: PS_DEFAULT_BROWSER,
  systemInfo: PS_SYSTEM_INFO,
  runCommand: PS_RUN_COMMAND
}

export const WINDOWS_MEDIA_KEYS_CSHARP = CS_MEDIA_KEYS
