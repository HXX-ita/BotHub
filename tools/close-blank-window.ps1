# close-blank-window.ps1 -- find and close the "blank white window" (a stuck UWP frame).
#
# IMPORTANT: that white window is NOT BotHub's.
#   BotHub owns exactly two visible things: the Edge app window "BotHub - <name>" and a tray icon.
#   All of its helpers run through wscript.exe with no window at all.
#   The white thing is an ApplicationFrameWindow (UWP app frame) with an EMPTY title,
#   owned by explorer.exe -- a Windows shell artifact (stuck widget / settings frame).
#
# Step 1: politely ask it to close (WM_CLOSE).
# Step 2: if it is still there, offer to restart explorer.exe (clears such stuck frames;
#         the taskbar blinks for a second, open windows stay).
# Nothing else is touched.

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class BW2 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr res);
  public struct RECT { public int L, T, R, B; }
}
"@

function Get-BlankFrames {
  $found = New-Object System.Collections.ArrayList
  $cb = [BW2+EnumProc]{
    param($h, $l)
    if ([BW2]::IsWindowVisible($h)) {
      $cn = New-Object System.Text.StringBuilder 256
      [void][BW2]::GetClassName($h, $cn, 256)
      if ($cn.ToString() -eq 'ApplicationFrameWindow') {
        $sb = New-Object System.Text.StringBuilder 256
        [void][BW2]::GetWindowText($h, $sb, 256)
        $procId = 0
        [void][BW2]::GetWindowThreadProcessId($h, [ref]$procId)
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        $r = New-Object BW2+RECT
        [void][BW2]::GetWindowRect($h, [ref]$r)
        $w = $r.R - $r.L; $hh = $r.B - $r.T
        if ($sb.ToString().Trim() -eq '' -and $w -gt 300 -and $hh -gt 200) {
          [void]$found.Add([pscustomobject]@{ Handle = $h; Process = if ($p) { $p.ProcessName } else { '?' }; Size = "$w x $hh" })
        }
      }
    }
    return $true
  }
  [void][BW2]::EnumWindows($cb, [IntPtr]::Zero)
  return $found
}

Write-Host ""
Write-Host "  说明：那个空白的白窗口不是 BotHub 的。" -ForegroundColor Cyan
Write-Host "  BotHub 只有『Edge 应用窗口（标题带 BotHub）』和右下角托盘图标；后台辅助进程都没有窗口。" -ForegroundColor DarkGray
Write-Host "  这个白窗口是 Windows 自己的（explorer.exe 持有的、没有标题的 UWP 框架）。" -ForegroundColor DarkGray
Write-Host ""

$frames = Get-BlankFrames
if ($frames.Count -eq 0) {
  Write-Host "  现在没有发现这种空白窗口。" -ForegroundColor Green
  Write-Host ""
  exit 0
}

Write-Host ("  找到 {0} 个空白窗口：" -f $frames.Count) -ForegroundColor Yellow
foreach ($f in $frames) { Write-Host ("    - 进程 {0} · 尺寸 {1}" -f $f.Process, $f.Size) }

$WM_CLOSE = 0x0010
foreach ($f in $frames) {
  $res = [IntPtr]::Zero
  [void][BW2]::SendMessageTimeout($f.Handle, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero, 2, 2000, [ref]$res)
}
Start-Sleep -Milliseconds 1200
$left = Get-BlankFrames
if ($left.Count -eq 0) {
  Write-Host "  已关闭。" -ForegroundColor Green
  Write-Host ""
  exit 0
}

Write-Host ("  它不接受关闭请求（还剩 {0} 个）—— 这种是 Windows 小组件/设置卡住了。" -f $left.Count) -ForegroundColor Yellow
$ans = Read-Host "  要重启一下 explorer 来清掉它吗？（任务栏会闪一下，已打开的窗口不受影响）[y/N]"
if ($ans -match '^[yY]') {
  Write-Host "  正在重启 explorer..." -ForegroundColor Cyan
  Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
  Start-Sleep -Seconds 3
  $after = Get-BlankFrames
  if ($after.Count -eq 0) { Write-Host "  清掉了。" -ForegroundColor Green } else { Write-Host "  还在：可能是别的 UWP 应用，重启电脑最稳。" -ForegroundColor Yellow }
} else {
  Write-Host "  好，那就先这样（它只是难看，不影响 BotHub 干活）。" -ForegroundColor DarkGray
}
Write-Host ""
