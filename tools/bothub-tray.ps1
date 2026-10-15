# bothub-tray.ps1 —— BotHub 的系统托盘图标（右键有菜单）
#
# 为什么要有它：一个"真正的应用"应该常驻在右下角，能一眼看到状态、随手点开面板，
# 而不是每次都去双击一个 .cmd。托盘菜单里的动作全部走面板的接口，所以**不会各管一摊**。
#
# ⚠️ 这个文件必须用 **UTF-8 带 BOM** 保存：Windows PowerShell 5.1 读 .ps1 时
#    默认按 ANSI(GBK) 解，中文会变成乱码、甚至把解析器搞崩（这个坑踩过）。
#
# 启动方式（BotHub.cmd 会自动做，也可以手动）：
#   powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File tools\bothub-tray.ps1

param(
  [int]$Port = 7788
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$base = "http://127.0.0.1:$Port"
$iconPath = Join-Path $root 'assets\bothub.ico'
$dataDir = Join-Path $root 'data'
$logDir = Join-Path $dataDir 'logs'
# 不再单独维护 tray.pid：锁文件（$lockPath）就是权威标记
$pidFile = Join-Path $dataDir 'tray.lock'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

# 找 node 和浏览器：**不写死作者机器的路径**（别人装在不同盘上也能用）
function Find-Node {
  # ① 应用自己报出来的 node（data\runtime.json，由 main.mjs 启动时写）—— 谁装的都准
  $rt = Join-Path $dataDir 'runtime.json'
  if (Test-Path $rt) {
    try {
      $n = (Get-Content -LiteralPath $rt -Raw | ConvertFrom-Json).node
      if ($n -and (Test-Path $n)) { return $n }
    } catch { }
  }
  # ② 随包携带的便携版 ③ 常见安装位置 ④ PATH 里的 node
  $cands = @(
    (Join-Path $root 'runtime\node\node.exe'),
    (Join-Path ${env:ProgramFiles} 'nodejs\node.exe'),
    (Join-Path ${env:LOCALAPPDATA} 'Programs\nodejs\node.exe')
  )
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}
$nodeExe = Find-Node

function Find-Edge {
  $cands = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:LOCALAPPDATA} 'Google\Chrome\Application\chrome.exe')
  )
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}
$edge = Find-Edge

function Tray-Log($msg) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $msg
  Add-Content -LiteralPath (Join-Path $logDir 'tray.log') -Value $line -Encoding UTF8
}

# 单实例：pid 文件里的进程如果还活着，而且确实是本脚本，就直接退出。
# ⚠️ 判据要排除**自己**（$PID）—— 我自己的命令行里也含这个脚本名，
#    不排除的话会"认为自己已经在跑"然后永远不启动（同类坑今天踩过三次）。
# 单实例：**先抢原子锁**（文件不存在才能创建，操作系统保证），抢不到就退出。
# ⚠️ 为什么不能只"数进程"：两个实例**同时启动**时，双方都还没看到对方 → 都留下（实测出现过 2 个托盘）。
$lockPath = Join-Path $dataDir 'tray.lock'
$mine = $PID
$gotLock = $false
try {
  $fsx = [System.IO.File]::Open($lockPath, 'CreateNew', 'Write')
  $b = [System.Text.Encoding]::ASCII.GetBytes([string]$mine)
  $fsx.Write($b, 0, $b.Length)
  $fsx.Close()
  $gotLock = $true
} catch {
  $holder = 0
  try { $holder = [int]([System.IO.File]::ReadAllText($lockPath)) } catch { }
  if ($holder -gt 0) {
    $aliveHolder = $false
    try { $null = Get-Process -Id $holder -ErrorAction Stop; $aliveHolder = $true } catch { }
    if ($aliveHolder) { Tray-Log "已经有托盘在跑（锁里的 pid $holder），本次退出"; exit 0 }
  }
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  try {
    $fsx = [System.IO.File]::Open($lockPath, 'CreateNew', 'Write')
    $bb = [System.Text.Encoding]::ASCII.GetBytes([string]$mine)
    $fsx.Write($bb, 0, $bb.Length); $fsx.Close(); $gotLock = $true
  } catch { }
}
if (-not $gotLock) { Tray-Log '抢不到托盘锁（有另一个实例刚起来），本次退出'; exit 0 }
# 拿到锁后再"确认写一遍"自己的 pid：实测出现过锁文件**内容为空**（并发下被删/重建过），
# 空锁的后果是下一个实例读不到持有人 → 可能又起一个。写一遍是幂等的，顺手把这种情况修掉。
try { [System.IO.File]::WriteAllText($lockPath, [string]$mine) } catch { }

$peers = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.ProcessId -ne $mine -and $_.CommandLine -and $_.CommandLine -like '*bothub-tray.ps1*' -and $_.CommandLine -like '*-File*' })
if ($peers.Count -gt 0) {
  Tray-Log "已经有托盘在跑（pid $($peers[0].ProcessId)），本次退出"
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  exit 0
}
# 只保留**锁文件**作为权威标记（原子创建、自带 pid）。
# 以前还额外写一个 tray.pid —— 两份记录迟早出现"谁和谁不一致"的困惑
# （实测看到过 tray.pid 指着已经退出的进程，而真正在跑的是另一个）。
$script:lockFile = $lockPath
Tray-Log "托盘启动（pid $mine）"

function Open-Panel {
  if (Test-Path $edge) {
    Start-Process -FilePath $edge -ArgumentList @(
      "--app=$base/",
      '--window-size=960,700',
      ("--user-data-dir=" + (Join-Path $dataDir 'edge-profile')),
      '--no-first-run', '--no-default-browser-check'
    )
  } else {
    Start-Process $base/
  }
}

function Get-State {
  try { return Invoke-RestMethod -Uri "$base/api/status" -TimeoutSec 3 } catch { return $null }
}

function Restart-App {
  try { Invoke-RestMethod -Uri "$base/api/app/restart" -Method Post -TimeoutSec 5 | Out-Null } catch { }
}

function Run-Doctor {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ("`"$root\check-bothub.cmd`"")
}

# ── 托盘本体 ──
$ni = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $iconPath) { $ni.Icon = New-Object System.Drawing.Icon($iconPath) }
else { $ni.Icon = [System.Drawing.SystemIcons]::Application }
$ni.Text = 'BotHub · 正在启动…'
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('打开面板')
$miStatus = $menu.Items.Add('状态：查询中…')
$miStatus.Enabled = $false
$menu.Items.Add('-') | Out-Null
$miRestart = $menu.Items.Add('重启应用')
$miDoctor = $menu.Items.Add('诊断（体检）')
$miLogs = $menu.Items.Add('打开日志文件夹')
$menu.Items.Add('-') | Out-Null
$miQuit = $menu.Items.Add('退出托盘（应用继续跑）')
$miStopAll = $menu.Items.Add('全部退出（应用 + 看护一起停）')

$miOpen.add_Click({ Open-Panel })
$miRestart.add_Click({ Restart-App; [System.Windows.Forms.MessageBox]::Show('已发出重启指令，几秒后自己回来。', 'BotHub') | Out-Null })
$miDoctor.add_Click({ Run-Doctor })
$miLogs.add_Click({ Start-Process explorer.exe (Join-Path $dataDir 'logs') })
$miStopAll.add_Click({
  $r = [System.Windows.Forms.MessageBox]::Show(
    "要把 BotHub 整个停掉吗？`n`n应用和看护进程都会停，机器人会离线；下次双击 BotHub.cmd 再开。",
    'BotHub', 'YesNo', 'Question')
  if ($r -eq 'Yes') {
    # 不写死作者机器的路径：node 用探测结果，脚本用本脚本所在目录
    $stopScript = Join-Path $PSScriptRoot 'stop-bothub.mjs'
    if ($nodeExe -and (Test-Path $stopScript)) {
      Start-Process -FilePath $nodeExe -ArgumentList ('"' + $stopScript + '"') -WindowStyle Hidden
    } else {
      [System.Windows.Forms.MessageBox]::Show('找不到 node.exe 或 stop-bothub.mjs，没法自动停 —— 请手动结束 node 进程。', 'BotHub') | Out-Null
    }
    $ni.Visible = $false
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    Tray-Log '托盘：全部退出'
    [System.Windows.Forms.Application]::Exit()
  }
})
$miQuit.add_Click({
  $ni.Visible = $false
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  Tray-Log '托盘退出'
  [System.Windows.Forms.Application]::Exit()
})
$ni.ContextMenuStrip = $menu
$ni.add_DoubleClick({ Open-Panel })

# 退出时放掉锁（否则下次会以为已经有托盘在跑）
Register-EngineEvent PowerShell.Exiting -Action { try { Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue } catch { } } | Out-Null

# 定时刷新提示文字（鼠标悬停能看到"在跑 / 停了 / 最后消息"）
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({
  $st = Get-State
  if (-not $st) { $ni.Text = 'BotHub · 连不上（应用没在跑？）'; $miStatus.Text = '状态：连不上应用'; return }
  $live = @($st.bots | Where-Object { $_.running }).Count
  $last = ($st.bots | Measure-Object -Property lastMessageSecAgo -Minimum).Minimum
  $lastTxt = if ($last -eq $null) { '还没收到过消息' }
             elseif ($last -lt 60) { "$([int]$last) 秒前收到消息" }
             elseif ($last -lt 3600) { "$([math]::Round($last/60)) 分钟前收到消息" }
             else { "$([math]::Round($last/3600)) 小时前收到消息" }
  $ni.Text = "BotHub · $live/$($st.bots.Count) 个机器人在跑 · $lastTxt"
  $miStatus.Text = "状态：$live/$($st.bots.Count) 个在跑 · $lastTxt"
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
