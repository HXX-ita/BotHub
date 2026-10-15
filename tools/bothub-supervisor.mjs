#!/usr/bin/env node
/**
 * bothub-supervisor.mjs —— BotHub 的守护进程：**秒级拉起 + 卡死检测**。
 *
 * 为什么不能只靠"计划任务 + 开机启动"：今天在 QQ 机器人上已经验证过，
 * 计划任务的 RestartOnFailure 会因为 `cmd /c 脚本` 一直算"正在运行"而**从不触发**，
 * 结果机器人死了半小时都没人管。
 *
 * 这里的判据有两条（缺一不可）：
 *   ① 进程还在（pid 文件里的 pid，且命令行确实是 BotHub）
 *   ② **心跳还新鲜**（应用每 15 秒写一次 data/heartbeat.json；超过 120 秒没写 = 卡死）
 * —— "进程在"不等于"活着"：卡死的进程照样在。
 *
 * 用法：
 *   node bothub-supervisor.mjs          前台跑（调试）
 *   node bothub-supervisor.mjs --once   只查一次
 *   node bothub-supervisor.mjs --status 只看不动手
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

const ROOT = process.env.BOTHUB_HOME || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const DATA = path.join(ROOT, 'data');
const LOGDIR = path.join(DATA, 'logs');
const LOG = path.join(LOGDIR, 'supervisor.log');
/**
 * ⛔ 这里**不能**用 `PIDFILE`（那是**应用**的 pid 文件，`data/bothub.pid`）。
 *    第一版就是这么写错的：守护进程把自己的 pid 覆盖进应用的 pid 文件 →
 *    应用下次启动时读到"已经在跑（pid = 守护进程）" → **直接退出**，
 *    表现成"怎么都起不来"。演练一跑就抓到了，但这个坑很隐蔽（两边都"没错"，只是共用了文件）。
 *    规矩：**谁的文件写谁的 pid**，一个文件只归一个进程所有。
 */
const SUPPID = path.join(DATA, 'bothub-supervisor.pid');
const PIDFILE = path.join(DATA, 'bothub.pid');        // ← 只读：应用的 pid 文件，**绝不写**
const HEARTBEAT = path.join(DATA, 'heartbeat.json');
const LAUNCHER = path.join(ROOT, 'start-bothub.cmd');
const PWSH = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const INTERVAL_MS = Number(process.env.BOTHUB_SUP_INTERVAL_MS || 5000);
const STALE_MS = Number(process.env.BOTHUB_SUP_STALE_MS || 120000);

const argv = process.argv.slice(2);
fs.mkdirSync(LOGDIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`;
  /**
   * ⚠️ 先写文件、再打控制台，而且**两边都各自 try/catch**。
   * 为什么：被计划任务直接托管的进程**没有 stdout**，`console.log` 可能直接抛
   * （而它排在写文件之前 → 那样连日志都没了）。实测踩到：看护"活着但一条日志都不写"，
   * 事后完全查不出它干了什么。
   */
  try { fs.appendFileSync(LOG, line + '\r\n', 'utf8'); } catch { /* ignore */ }
  try { console.log(line); } catch { /* 没有控制台是正常的 */ }
}

const readPid = () => { try { return Number(fs.readFileSync(PIDFILE, 'utf8').trim()) || 0; } catch { return 0; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readHeartbeat = () => { try { return JSON.parse(fs.readFileSync(HEARTBEAT, 'utf8')); } catch { return null; } };
const heartbeatAgeMs = () => { const h = readHeartbeat(); return h ? Date.now() - (h.at || 0) : Infinity; };

/** 确认那个 pid 真的是 BotHub（pid 会被系统复用，光看数字会认错人） */
function isBothub(pid) {
  return new Promise((resolve) => {
    execFile(PWSH, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue
       if ($p -and $p.CommandLine -like '*BotHub*src*main.mjs*') { 'yes' } else { 'no' }`],
      { timeout: 15000, windowsHide: true, encoding: 'utf8' },
      (err, out) => resolve(!err && String(out).trim() === 'yes'));
  });
}

/**
 * 拉起应用 —— **零窗口，而且不需要 cmd.exe / conhost**。
 *
 * ⛔ 这里踩过两次，第二次更隐蔽（老板的原话："我重启一下怎么卡半天，然后弹出来一个窗口又关不了了"）：
 *   ① 第一版：`spawn('cmd.exe', ['/c', launcher], { detached: true })` ——
 *      Windows 上 `detached: true` 会**新建控制台**，Win11 拿 Windows Terminal 托管 → 窗口关不掉。
 *   ② 第二版改成走 `wscript` + `WScript.Shell.Run(cmd, 0, False)`（"隐藏"）——
 *      窗口是不显示了，但**进程树里仍然有 cmd.exe 和 conhost.exe**，而 Win11 的
 *      "默认终端 = Windows Terminal" 会在 handoff 时把窗口显示出来 → **又冒出来一个**。
 *      实测证据：应用挂在 `cmd.exe` 下、它自己带着 `conhost.exe`，同时系统里出现
 *      一个 `WindowsTerminal.exe -Embedding` 窗口。
 *
 * 正解：**不经过 cmd、不 detached、windowsHide: true** ——
 *   这时 Node 用 `CREATE_NO_WINDOW` 起子进程，**根本不创建控制台**（连 conhost 都没有）。
 *   stdout/stderr 直接重定向到文件（不靠 cmd 的 `>>`）。
 *   副作用说明：子进程不再是"脱离"的，但 Windows 不会因为父进程退出就杀它 ——
 *   而且看护进程本来就由计划任务保证活着（它重启时会重新 ensure 应用）。
 */
function startApp() {
  const out = fs.openSync(path.join(DATA, 'logs', 'stdout.log'), 'a');
  // --expose-gc：面板上的「释放内存」要能主动回收（没有它就只能等系统自己收）
  const child = spawn(process.execPath, ['--expose-gc', path.join(ROOT, 'src', 'main.mjs')], {
    cwd: ROOT,
    windowsHide: true,
    detached: false,
    stdio: ['ignore', out, out],
    env: { ...process.env, BOTHUB_LAUNCHED_BY: 'supervisor' },
  });
  child.unref();
  return child.pid;
}

/**
 * 判断"应用还活着吗"——**以心跳为准，不去猜命令行**。
 *
 * 为什么改：第一版用命令行匹配（`*BotHub*src*main.mjs*`）来确认"这个 pid 是我们的"，
 * 结果应用是用相对路径启动的（命令行里只有 `"src\main.mjs"`，没有 "BotHub" 字样），
 * 于是守护进程**一直认为应用不在**，每 5 秒拉起一个新实例 —— 新实例又被防双开挡掉。
 * 实测就是这么空转的（日志里连着 "pid 被复用了"）。
 * 教训：**身份要靠应用自己报（心跳里的 pid），不要靠解析别人的命令行。**
 */
function liveness() {
  const pid = readPid();
  const hb = readHeartbeat();
  const hbAge = hb ? Date.now() - (hb.at || 0) : Infinity;
  const hbPid = hb && hb.pid ? Number(hb.pid) : 0;
  const alivePid = hbPid && alive(hbPid);
  return {
    pid,
    hbPid,
    hbAge,
    fresh: hbAge < STALE_MS,
    alive: alivePid,
    ok: alivePid && hbAge < STALE_MS,
  };
}

let lastTickAt = Date.now();
let lastTickOk = 0;

/**
 * 顺手保活"额外常驻脚本"（每 60 秒检查一次，不在就拉起来）。
 *
 * 为什么要做成配置驱动：以前这活是**别的看门狗**兼着的，而我要在 BotHub 里接手时
 * 顺手把那条脚本的绝对路径写死在代码里 —— 结果发布打包器直接拦下来：
 * **发布包里不许出现作者本机的路径/私有工具名**（打包器的这条断言是对的）。
 * 现在改成读 `config/local.json` 的 `keepAliveScripts`（本机专用、不进发布包）：
 *   { "keepAliveScripts": ["D:\\某个常驻脚本.mjs"] }
 */
let lastExtraCheck = 0;
function keepExtrasAlive() {
  if (Date.now() - lastExtraCheck < 60000) return;
  lastExtraCheck = Date.now();
  let list = [];
  try {
    const local = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'local.json'), 'utf8'));
    if (Array.isArray(local.keepAliveScripts)) list = local.keepAliveScripts.filter((s) => typeof s === 'string');
  } catch { return; }                       // 没有这个文件 = 没有要保活的（正常）
  for (const script of list) {
    try { if (!fs.existsSync(script)) continue;
      const child = spawn(process.execPath, [script, '--ensure'], { windowsHide: true, stdio: 'ignore' });
      child.unref();
    } catch { /* 保活失败不该影响看护本身 */ }
  }
}async function tick() {
  lastTickAt = Date.now();
  try {
    keepExtrasAlive();     // 顺手保活隐私监督进程（每 60 秒一次；这活原来挂在旧的 QQ 机器人看门狗上）
    const st = liveness();

    // 看起来没问题：静默（守护进程平时不该刷日志）
    if (st.ok) {
      // 兜底：万一 pid 文件和心跳不一致，顺手修一下
      if (st.hbPid !== st.pid) { try { fs.writeFileSync(PIDFILE, String(st.hbPid), 'utf8'); } catch { /* ignore */ } }
      return;
    }

    // 进程在、但心跳陈旧 → 卡死，杀掉重启（"进程在"不等于"活着"）
    if (st.alive && !st.fresh) {
      log(`⚠️ 进程在（pid ${st.hbPid}）但**心跳 ${Math.round(st.hbAge / 1000)} 秒没更新** —— 判定卡死，杀掉重启`);
      try { process.kill(st.hbPid, 'SIGKILL'); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      log(`🚨 BotHub 不在（心跳 ${Number.isFinite(st.hbAge) ? Math.round(st.hbAge / 1000) + ' 秒前' : '从未'}，pid ${st.pid || '无'}）—— 拉起`);
    }

    const launcherPid = startApp();
    log(`   已发出启动命令（pid ${launcherPid}），等它写心跳…`);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s2 = liveness();
      if (s2.ok) { log(`   ✅ 已起来：pid ${s2.hbPid}`); return; }
    }
    log('   ⚠️ 40 秒内没等到心跳 —— 看 data/logs/stdout.log 和 app.log');
  } catch (e) {
    /**
     * ⛔ tick 绝不允许把看护自己弄死，也绝不允许**静默失败**。
     * 实测踩到过：看护"活着但一条日志都不写"（CPU 0.06 秒、僵在那儿），
     * 应用死了两分钟它都没反应，事后完全查不出它当时在干什么。
     */
    log('❌ tick 出错（已捕获，看护继续跑）：' + String((e && e.stack) || e).split('\n')[0]);
  }
}

log(`守护进程启动（间隔 ${INTERVAL_MS}ms，心跳阈值 ${STALE_MS}ms，pid ${process.pid}，node ${process.version}）`);

/**
 * ★ 单实例守卫（2026-10-15 补，**用原子建锁**）
 *
 * 为什么不能只靠"数进程"：两个 `--ensure` 同时进来时（计划任务 + 手动双击、或者两次点击），
 * 两个守护进程**都还没来得及看到对方**，于是都留下了 —— 实测就攒出过 2 个。
 * 数进程只能当兜底，**真正的互斥要靠 `open(...,'wx')` 这种"文件不存在才创建"的原子操作**。
 *
 * 判据里为什么要排除 `start-bothub-supervisor.mjs`：那个文件名**包含** `bothub-supervisor.mjs`，
 * 不排除的话，新起的守护进程会把"刚启动它的进程"当成同类然后直接退出，表现成"应用再也起不来"。
 */
function countPeers() {
  return new Promise((resolve) => {
    execFile(PWSH, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -like '*bothub-supervisor.mjs*' -and
                         $_.CommandLine -notlike '*start-bothub-supervisor*' -and
                         $_.ProcessId -ne ${process.pid} }).Count`],
      { timeout: 15000, windowsHide: true, encoding: 'utf8' },
      (err, out) => resolve(err ? 0 : (Number(String(out).trim()) || 0)));
  });
}

const LOCK = path.join(DATA, 'bothub-supervisor.lock');
function lockHeldBy() {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8').trim()) || 0;
    if (!pid) return 0;
    try { process.kill(pid, 0); return pid; } catch { return 0; }   // 死进程留下的锁 → 视为没锁
  } catch { return 0; }
}
let gotLock = false;
try {
  fs.mkdirSync(DATA, { recursive: true });
  const fd = fs.openSync(LOCK, 'wx');          // ← 原子：文件已存在就抛 EEXIST
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);
  gotLock = true;
} catch (e) {
  const holder = lockHeldBy();
  if (holder) { log(`ℹ️ 已经有一个 BotHub 守护进程在跑（锁里的 pid ${holder}）—— 本次直接退出`); process.exit(0); }
  // 锁是死进程留下的：清掉，重试一次
  try { fs.rmSync(LOCK, { force: true }); const fd = fs.openSync(LOCK, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); gotLock = true; } catch { /* 还是拿不到 */ }
}
if (!gotLock) { log('ℹ️ 拿不到守护进程的锁（有另一个实例刚起来）—— 本次退出'); process.exit(0); }

// 兜底：万一锁机制失效（例如锁文件被误删），再用进程数拦一次
const peers = await countPeers();
if (peers > 0) {
  log(`ℹ️ 已经有 ${peers} 个 BotHub 守护进程在跑 —— 本次退出（同一个应用只需要一个看护）`);
  /**
   * ⚠️ 只清**自己刚建的那把锁**（`gotLock` = 我建的）。
   * 踩过：以前无条件 `rmSync(LOCK)` —— 但这时锁很可能是**那个正在跑的看护**持有的，
   * 我把它删了，等于"替别人把门打开"，锁就形同虚设（托盘那边也因此出过两个实例）。
   * 别人的锁，不许替他清。
   */
  if (gotLock) { try { fs.rmSync(LOCK, { force: true }); } catch { /* ignore */ } }
  process.exit(0);
}

const releaseLock = () => { try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.rmSync(LOCK, { force: true }); } catch { /* ignore */ } };
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { releaseLock(); process.exit(0); });

// 把自己写进**自己的** pid 文件（以前只有 ensure 脚本写，所以"先起的那个"会从记录里消失）
try { fs.mkdirSync(path.dirname(SUPPID), { recursive: true }); fs.writeFileSync(SUPPID, String(process.pid), 'utf8'); } catch { /* ignore */ }
process.on('exit', () => { try { if (Number(fs.readFileSync(SUPPID, 'utf8').trim()) === process.pid) fs.rmSync(SUPPID, { force: true }); } catch { /* ignore */ } });

if (argv.includes('--status')) {
  const pid = readPid();
  const hbAge = heartbeatAgeMs();
  console.log(`pid=${pid || '无'}  进程在=${pid ? alive(pid) : false}  心跳=${Number.isFinite(hbAge) ? Math.round(hbAge / 1000) + ' 秒前' : '从未'}`);
  process.exit(0);
}
await tick();
if (argv.includes('--once')) process.exit(0);
setInterval(() => tick().catch((e) => log('⚠️ tick 出错：' + (e && e.message))), INTERVAL_MS);

/**
 * ★ 自我看护：**"进程在"不等于"在干活"**（2026-10-15 实测踩到）。
 *
 * 那次的现象：看护进程活着（内存 38 MB、10 个线程、CPU 只用了 0.06 秒），
 * 日志里只有一行"守护进程启动" —— 应用死了两分钟它都**没有任何反应**，而且完全静默。
 * 事后查不出它当时在干什么。一条"活着但僵住"的看护比没有看护更坏：它看着像在保护你。
 *
 * 所以它现在会**看着自己**：超过 3 个 tick 周期没成功走过一轮，就主动退出，
 * 让计划任务（RestartOnFailure + 每分钟的兜底任务）换一个新的上来。
 */
setInterval(() => {
  const idle = Date.now() - lastTickAt;
  if (idle > INTERVAL_MS * 3 + 5000) {
    log(`❌ 自我看护：${Math.round(idle / 1000)} 秒没有正常跑过一轮 —— 主动退出，让计划任务换一个新的`);
    process.exit(1);
  }
}, Math.max(INTERVAL_MS, 5000));
