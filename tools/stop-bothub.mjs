#!/usr/bin/env node
/**
 * stop-bothub.mjs —— 把 BotHub **干净地全部停掉**（应用 + 看护 + 托盘 + 应用窗口）。
 *
 * 为什么需要：托盘改成零窗口启动后，它不再有控制台窗口可以关 ——
 * 那"想彻底停掉"就必须有个明确入口（托盘右键里有这一项），否则就成了另一个"关不掉的东西"。
 *
 * ⚠️ 关键：**只杀进程不够**。现在有两条自动拉起链：
 *   · `DSH-BotHub-Ensure` 每分钟跑一次，看护不在就把它拉起来；
 *   · `DSH-BotHub-Supervisor` 带"失败自动重试"。
 *   所以默认行为是 **杀进程 + 禁用这两个任务**（真的停住）；要恢复就双击 `BotHub.cmd`（它会重新启用）。
 *
 * 用法：
 *   node tools\stop-bothub.mjs          停 + 禁用任务（真的停住，下次双击才回来）
 *   node tools\stop-bothub.mjs --soft   只杀进程，任务保持启用（一分钟内会被拉回来）
 *
 * ⛔ 判据纪律（今天栽过 4 次的坑）：
 *   · 只认 `Name='node.exe'` 的进程来找应用/看护 —— 我自己的 pwsh 不在候选里；
 *   · 托盘用的关键字**拆开拼接**（'bothub' + '-tray.ps1'），命令行文本里不存在完整串，绝不匹配自己；
 *   · 应用在命令行里是**相对路径**（`"src\main.mjs"`），按绝对路径匹配会漏掉它（第一版就漏了）。
 */
import { execFile } from 'node:child_process';

/**
 * 杀之前先让应用**压一遍会话**（老板要求「关闭时压缩」）。
 * Windows 上直接 kill 不会触发应用的信号钩子，所以只能"先问一句再动手"。
 * 失败无所谓（应用可能已经卡死），2 秒超时就跳过。
 */
async function askCompact(port) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${port}/api/app/compact`, { method: 'POST', signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    console.log('  ✅ 已让应用压缩会话：' + (j.compressed ?? 0) + ' 个');
  } catch { /* 应用可能没在跑/卡死，跳过 */ }
}

const PWSH = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const SOFT = process.argv.includes('--soft');

function ps(script) {
  return new Promise((resolve) => {
    execFile(PWSH, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
      { timeout: 30000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 << 20 },
      (err, out) => resolve(err ? '' : String(out || '').trim()));
  });
}

const trayPat = 'bothub' + '-tray.ps1';   // 拆开拼，避免自匹配

/**
 * 先问应用"端口是多少"（配置在 `config\bots.json` 的 `http.port`，别写死），
 * 再让它压一遍会话 —— 然后才动手杀。失败就跳过（应用可能已经卡死）。
 */
let httpPort = 7788;
try {
  const cfg = JSON.parse((await import('node:fs')).readFileSync(new URL('../config/bots.json', import.meta.url), 'utf8'));
  if (cfg?.http?.port) httpPort = cfg.http.port;
} catch { /* 读不到就用默认端口 */ }
if (!SOFT) await askCompact(httpPort);   // --soft 是"只杀进程"的快路径，不打扰应用

const victims = await ps(`
  $out = @()
  # ⚠️ 应用的命令行是**相对路径**（node 的绝对路径 + 相对路径的 src\main.mjs），
  #    第一版按 '*BotHub*src*main.mjs*' 去匹配 → 只匹配到看护、漏掉了应用本身（实测）。
  #    改成结构判据：node.exe + 含 main.mjs + 不含 supervisor。
  $out += @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*main.mjs*' -and $_.CommandLine -notlike '*supervisor*' } |
    ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; what='应用' } })
  $out += @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like '*bothub-supervisor.mjs*' -or $_.CommandLine -like '*start-bothub-supervisor.mjs*') -and $_.CommandLine -notlike '*dsh-subprocess*' } |
    ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; what='看护' } })
  $out += @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*${trayPat}*' -and $_.CommandLine -like '*-File*' } |
    ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; what='托盘' } })
  $out += @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*--app=http://127.0.0.1:7788*' } |
    ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; what='应用窗口' } })
  $out += @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*BotHub*start-bothub.cmd*' } |
    ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; what='启动器' } })
  $out | ConvertTo-Json -Compress
`);

let list = [];
try { list = JSON.parse(victims || '[]'); } catch { /* 没有就算了 */ }
if (!Array.isArray(list)) list = [list];

if (!list.length) console.log('没有在跑的 BotHub 进程');
for (const v of list) {
  console.log(`停止 ${v.what}（pid ${v.pid}）`);
  await ps(`Stop-Process -Id ${v.pid} -Force -ErrorAction SilentlyContinue`);
}

/**
 * ⚠️ 这里**故意不删锁文件**（`*-supervisor.lock` / `tray.lock`）。
 * 踩过：以前顺手 `Remove-Item ...lock`，但**正在跑的托盘/看护还拿着那把锁** ——
 * 锁没了，新实例就能再起一个 → 实测出现过两个托盘。
 * 死进程留下的旧锁不需要谁来清：每个脚本自己会判断"锁里的 pid 还活着吗"，
 * 不活就清掉重试（`open(...,'wx')` 那套）。**一个文件一个主人，别人不许替他清。**
 */
console.log('（锁文件保留：由各自脚本处理"死进程留下的旧锁"）');

if (SOFT) {
  console.log('（--soft：任务保持启用，所以一分钟内看护会被兜底任务拉回来）');
} else {
  // ⚠️ 只杀进程是停不住的：兜底任务每分钟都会把看护拉起来，看护又拉起应用。
  //    所以"真的停住"= 停掉任务实例 + 禁用这两个任务。
  //    任务名两种都试：老机器上是 `DSH-BotHub-*`，发布版装出来是 `BotHub-*`。
  const SUP = ['BotHub-Supervisor', 'DSH-BotHub-Supervisor'];
  const ENS = ['BotHub-Ensure', 'DSH-BotHub-Ensure'];
  console.log('停掉并禁用拉起链（Supervisor / Ensure 两个任务，两种命名都试）');
  for (const n of SUP) await ps(`schtasks /End /TN "${n}" 2>$null | Out-Null`);
  for (const n of [...SUP, ...ENS]) await ps(`schtasks /Change /TN "${n}" /DISABLE 2>$null | Out-Null`);
  console.log('（要恢复：双击 start.cmd / BotHub.cmd —— 它会重新启用并启动）');
}
console.log('已停止。');
