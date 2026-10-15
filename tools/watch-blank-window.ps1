# watch-blank-window.ps1 -- watch for the blank window and log the moment it shows up.
#
# Why: the boss sees a big white window "every time bothub.cmd starts", but when I list
# every visible window and re-run the launcher, that window is NOT created by BotHub
# (it was there before the launcher ran). So we need to catch it in the act:
# this script polls every 2 seconds; the moment an untitled blank UWP frame appears
# it writes a log line with the time AND the processes started in the previous minute.
#
# Log: data\logs\blank-window-watch.log

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # 脚本所在目录的上一层（不写死任何机器路径）
$logDir = Join-Path $root 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'blank-window-watch.log'

Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class WW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L,T,R,B; }
}
"@

function Get-BlankNow {
  $found = New-Object System.Collections.ArrayList
  $cb = [WW+EnumProc]{
    param($h, $l)
    if ([WW]::IsWindowVisible($h)) {
      $cn = New-Object System.Text.StringBuilder 256; [void][WW]::GetClassName($h, $cn, 256)
      if ($cn.ToString() -eq 'ApplicationFrameWindow') {
        $sb = New-Object System.Text.StringBuilder 256; [void][WW]::GetWindowText($h, $sb, 256)
        if ($sb.ToString().Trim() -eq '') {
          $procId = 0; [void][WW]::GetWindowThreadProcessId($h, [ref]$procId)
          $r = New-Object WW+RECT; [void][WW]::GetWindowRect($h, [ref]$r)
          $w = $r.R - $r.L; $hh = $r.B - $r.T
          if ($w -gt 300 -and $hh -gt 200) {
            $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
            [void]$found.Add(("{0} ({1}) {2}x{3} @{4},{5}" -f $(if ($p) { $p.ProcessName } else { '?' }), $procId, $w, $hh, $r.L, $r.T))
          }
        }
      }
    }
    return $true
  }
  [void][WW]::EnumWindows($cb, [IntPtr]::Zero)
  return $found
}

function Write-Log($text) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

Write-Host ''
Write-Host '  盯着"白窗口"：每 2 秒看一次，它一出现就记下时间 + 那前后启动了什么进程。' -ForegroundColor Cyan
Write-Host '  日志：data\logs\blank-window-watch.log' -ForegroundColor DarkGray
Write-Host '  想停就关掉这个窗口（或按 Ctrl+C）。跑 30 分钟会自动结束。' -ForegroundColor DarkGray
Write-Host ''
Write-Log ('开始盯梢 ' + $root)

$seen = $false
$until = (Get-Date).AddMinutes(30)
while ((Get-Date) -lt $until) {
  $now = Get-BlankNow
  if ($now.Count -gt 0 -and -not $seen) {
    $seen = $true
    Write-Log ('★ 出现白窗口：' + ($now -join ' ; '))
    $since = (Get-Date).AddMinutes(-1)
    $recent = Get-Process | Where-Object { $_.StartTime -gt $since } | Sort-Object StartTime |
      ForEach-Object { '{0}({1})' -f $_.ProcessName, $_.Id }
    Write-Log ('   这一分钟里启动的进程：' + ($(if ($recent) { $recent -join ', ' } else { '（没有新进程 —— 说明是老窗口又显示出来了）' })))
    Write-Log '   （提示：把这两行发给开发者，就能知道是谁干的）'
  }
  if ($now.Count -eq 0 -and $seen) { $seen = $false; Write-Log '白窗口又消失了' }
  Start-Sleep -Seconds 2
}
Write-Log '盯梢结束（30 分钟）'
Write-Host ''
Write-Host '  盯梢结束，日志在 data\logs\blank-window-watch.log' -ForegroundColor Green
Write-Host ''
