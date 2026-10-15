#!/usr/bin/env node
/**
 * start-bothub-supervisor.mjs —— 保证「BotHub 守护进程」活着（幂等）。
 * 谁需要它活着，谁就周期性调 `--ensure`（看门狗、计划任务都行）。
 *
 * 判断"是不是我们的守护进程"要**确认命令行**，不能只看 pid 数字 ——
 * pid 会被系统复用，把无关进程当成"已经在跑"就是假安心。
 *
 * 用法：--ensure（默认）/ --status / --restart
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';

const ROOT = process.env.BOTHUB_HOME || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const TOOLS = path.join(ROOT, 'tools');
const DAEMON = path.join(TOOLS, 'bothub-supervisor.mjs');
const PIDFILE = path.join(ROOT, 'data', 'bothub-supervisor.pid');
const LOG = path.join(ROOT, 'data', 'logs', 'supervisor.log');
const PWSH = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const argv = process.argv.slice(2);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readPid = () => { try { return Number(fs.readFileSync(PIDFILE, 'utf8').trim()) || 0; } catch { return 0; } };

function isOurDaemon(pid) {
  return new Promise((resolve) => {
    execFile(PWSH, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue
       if ($p -and $p.CommandLine -like '*bothub-supervisor.mjs*') { 'yes' } else { 'no' }`],
      { timeout: 15000, windowsHide: true, encoding: 'utf8' },
      (err, out) => resolve(!err && String(out).trim() === 'yes'));
  });
}

/**
 * 看护进程的计划任务名：老机器上叫 `DSH-BotHub-Supervisor`，发布版装出来叫 `BotHub-Supervisor`。
 * 两个都探测一遍（存在哪个用哪个），免得换台机器就得改代码。
 */
const SUPERVISOR_TASK = (() => {
  const names = ['BotHub-Supervisor', 'DSH-BotHub-Supervisor'];
  for (const n of names) {
    try { execFileSync('schtasks.exe', ['/Query', '/TN', n], { stdio: 'ignore', windowsHide: true }); return n; } catch { /* 试下一个 */ }
  }
  return names[0];
})();

/**
 * 输出：**自己写文件**，不依赖 stdout。
 * 为什么：现在这个脚本由**计划任务直接托管 node**（动作就是 node.exe，不经 cmd、不重定向）——
 * 计划任务起的进程可能没有 stdout，`console.log` 会抛。之前是 `cmd /c ... >> log`，
 * 但那个**每 1 分钟的 cmd.exe 就是老板看到"老是弹出 node.exe 窗口"的元凶**。
 */
const BOOT_LOG = path.join(ROOT, 'data', 'logs', 'supervisor-boot.log');
function say(msg) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`;
  try { fs.appendFileSync(BOOT_LOG, line + '\r\n', 'utf8'); } catch { /* ignore */ }
  try { console.log(line); } catch { /* 没有控制台是正常的 */ }
}

/** 顺手保证托盘在（原来这行在 start-supervisor.cmd 里；现在任务不再走 cmd，所以搬进来） */
function ensureTray() {
  try {
    const child = spawn('wscript.exe', ['//nologo', path.join(TOOLS, 'start-tray.vbs')], { detached: true, stdio: 'ignore', windowsHide: true, cwd: TOOLS });
    child.unref();
  } catch { /* 托盘起不来不影响机器人 */ }
}


/**
 * 启动看护进程 —— **交给计划任务来起**，不在本进程里 spawn。
 *
 * ⛔ 为什么改（第三次踩同一个坑，这次是"被控制台带走"）：
 *   之前在 ensure 脚本里 `spawn(node, [daemon])`：
 *     · 用 `detached: true` → Windows 给子进程**新建控制台**，Win11 用 Windows Terminal 托管，
 *       于是**弹出一个关不掉的窗口**（老板骂过两次）；
 *     · 改成 `detached: false` + `windowsHide: true`（本意是 `CREATE_NO_WINDOW`，零窗口）→
 *       窗口确实没了，**但它成了"控制台的子进程"**：ensure 那条 `cmd.exe` 退出、控制台一关，
 *       看护进程**跟着被杀**（实测：连着起了 3 个看护，日志里一条都没留下就死了）。
 *   正解：**让计划任务直接托管它**。任务的动作就是 `node.exe bothub-supervisor.mjs`
 *   （不经 cmd、不继承任何控制台），计划任务自己保证"只跑一个 + 挂了重试"。
 */
function runTask() {
  return new Promise((resolve) => {
    execFile('schtasks.exe', ['/Run', '/TN', SUPERVISOR_TASK], { windowsHide: true, timeout: 20000 },
      (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim() }));
  });
}

async function startDaemon() {
  const r = await runTask();
  if (!r.ok) {
    // 任务不存在（比如手工放到了别的机器上）→ 退回"直接起"，至少还能用
    console.log('计划任务 ' + SUPERVISOR_TASK + ' 起不来，退回直接启动（可能会有一个控制台窗口）');
    const out = fs.openSync(LOG, 'a');
    const child = spawn(process.execPath, [DAEMON], { detached: true, stdio: ['ignore', out, out], windowsHide: true, cwd: TOOLS });
    child.unref();
    return child.pid;
  }
  // 等它把锁写上（说明真的起来了）
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 500));
    if (lockHolder()) return lockHolder();
  }
  return 0;
}

const pid = readPid();
let running = pid > 0 && alive(pid) && await isOurDaemon(pid);

/**
 * ★ 先看**锁文件**（守护进程自己用 `open(...,'wx')` 原子建的，是权威的单实例标记）。
 * 为什么不用 pid 文件当第一判据：pid 文件可能过期/被覆盖，于是这里会**白起一个进程**，
 * 那个进程进去发现锁被人占着又立刻退出 —— 日志上就成了"已启动……（其实没起）"，
 * 看着像成功，实际什么都没干（第一次就是这么写的）。
 */
const LOCK = path.join(ROOT, 'data', 'bothub-supervisor.lock');
function lockHolder() {
  try {
    const p = Number(fs.readFileSync(LOCK, 'utf8').trim()) || 0;
    if (p && alive(p)) return p;
  } catch { /* 没锁文件 */ }
  return 0;
}
const holder = lockHolder();
if (holder) running = true;

if (argv.includes('--status')) {
  say(running ? `✅ BotHub 守护进程在跑（pid ${pid}）` : `❌ 没在跑（pid 文件：${pid || '空'}）`);
  process.exit(0);
}

if (argv.includes('--restart') && running) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 1500));
  running = false;
}

if (running) { say(`已经在跑${holder ? `（锁里的 pid ${holder}）` : `（pid ${pid}）`}`); ensureTray(); process.exit(0); }
// ⚠️ startDaemon 是 async 的：不 await 的话这里会打出一句 `pid [object Promise]`
//    （实测踩到，日志里看着像坏了，其实只是没等它）
const started = await startDaemon();
say(started ? `已启动 BotHub 守护进程（pid ${started}），日志 ${LOG}` : `已让计划任务启动 BotHub 守护进程，日志 ${LOG}`);
ensureTray();
