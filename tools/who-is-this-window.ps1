# who-is-this-window.ps1 -- tell me who owns the window you click on.
#
# How it works: wait 8 seconds, then read the FOREGROUND window (whatever you clicked).
# Log + print: process name, PID, class, title, rect, and the exe path.
# Nothing is closed or changed.

Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  public struct RECT { public int L,T,R,B; }
}
"@

Write-Host ''
Write-Host '  请在 8 秒内：用鼠标**点一下那个白窗口**（点它的标题栏或里面都行）。' -ForegroundColor Cyan
Write-Host '  8 秒后我会告出它是哪个程序。' -ForegroundColor DarkGray
Write-Host ''
for ($i = 8; $i -ge 1; $i--) { Write-Host ("    还有 {0} 秒…" -f $i); Start-Sleep -Seconds 1 }

$h = [FG]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { Write-Host '  没抓到（没有前台窗口？）' -ForegroundColor Yellow; exit 0 }

# 如果是子窗口，往上找到顶层
$root = [FG]::GetAncestor($h, 2)   # GA_ROOT
if ($root -ne [IntPtr]::Zero) { $h = $root }

$sb = New-Object System.Text.StringBuilder 256; [void][FG]::GetWindowText($h, $sb, 256)
$cn = New-Object System.Text.StringBuilder 256; [void][FG]::GetClassName($h, $cn, 256)
$procId = 0; [void][FG]::GetWindowThreadProcessId($h, [ref]$procId)
$r = New-Object FG+RECT; [void][FG]::GetWindowRect($h, [ref]$r)
$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
$path = if ($p) { $p.Path } else { '?' }

$lines = @(
  ('时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  ('进程：' + $(if ($p) { $p.ProcessName } else { '?' }) + '（PID ' + $procId + '）')
  ('可执行文件：' + $path)
  ('窗口类名：' + $cn.ToString())
  ('窗口标题：' + $(if ($sb.ToString().Trim()) { $sb.ToString().Trim() } else { '（空）' }))
  ('位置尺寸：' + ($r.R - $r.L) + 'x' + ($r.B - $r.T) + ' @' + $r.L + ',' + $r.T)
)
Write-Host ''
foreach ($l in $lines) { Write-Host ('  ' + $l) -ForegroundColor Green }
Write-Host ''
Write-Host '  （把上面这几行发给开发者就行）' -ForegroundColor DarkGray

$logDir = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Add-Content -Path (Join-Path $logDir 'who-is-this-window.log') -Value ($lines -join ' | ') -Encoding UTF8
Write-Host ''
