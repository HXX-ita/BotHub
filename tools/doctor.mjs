#!/usr/bin/env node
/**
 * doctor.mjs —— BotHub 体检：一条命令把"现在到底哪儿不对"说清楚。
 *
 * 为什么要有它：老板的原话是「**我不会用**」。所以"机器人坏了"这件事不能要求他去看日志、
 * 数进程、猜判据。双击一个 .cmd，出来一屏中文，每一行都带 ✅/⚠️/❌，最后给出**下一步该做什么**。
 *
 * 检查项（每一项都对应一次真实故障）：
 *   1. 配置：能不能读、能不能过校验（密钥取不取得到 —— 只报来源和长度，不打印值）
 *   2. 进程：应用在不在、心跳新不新鲜（"进程在"≠"活着"，卡死的进程照样在）
 *   3. 守护：在不在、**是不是只有一个**（实测攒到过 3 个）
 *   4. 计划任务：登录自启 + 每 5 分钟兜底 的状态；旧任务 DSH-QQBot 是否已禁用
 *   5. 面板：连不连得上；每个机器人在跑没有、网关就绪几次、最后一条消息多久前
 *   6. 网络：有没有到 QQ 网关的 TCP 连接
 *   7. 日志：最近有没有 ERROR；给出去哪看
 *
 * 用法：node tools\doctor.mjs         （或双击 check-bothub.cmd）
 *       退出码 0 = 全绿；1 = 有 ❌；2 = 有 ⚠️
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const DATA = path.join(ROOT, 'data');
const LOGDIR = path.join(DATA, 'logs');
const PWSH = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const BASE = process.env.BOTHUB_URL || 'http://127.0.0.1:7788';

const rows = [];
const add = (level, title, detail, advice) => rows.push({ level, title, detail, advice });
const ok = (t, d) => add('ok', t, d);
const warn = (t, d, a) => add('warn', t, d, a);
const bad = (t, d, a) => add('bad', t, d, a);

function ps(script, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(PWSH, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${script}`],
      { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 4 << 20 },
      (err, stdout) => resolve(err ? null : String(stdout || '').replace(/^\uFEFF/, '').trim()));
  });
}
const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const ageMin = (p) => { try { return (Date.now() - fs.statSync(p).mtimeMs) / 60000; } catch { return Infinity; } };

console.log('BotHub 体检 · ' + new Date().toLocaleString('zh-CN'));
console.log('='.repeat(64));

// ── 1. 配置 ────────────────────────────────────────────────
let cfgSummary = null;
try {
  const { loadConfig, publicConfig } = await import('../src/config.mjs');
  const cfg = loadConfig();
  const pub = publicConfig(cfg);
  cfgSummary = pub;
  ok('配置能读、能过校验', `${path.basename(pub.path)} · ${pub.channels.length} 个模型通道 · ${pub.bots.length} 个机器人`);
  for (const c of pub.channels) ok(`  通道 ${c.id}`, `${c.model} · key ${c.apiKey}`);
  for (const b of pub.bots) ok(`  机器人 ${b.id}`, `通道 ${b.channel} · appId ${b.appId} · secret ${b.appSecret} · 群里${b.mentionRequired ? '要 @' : '不用 @'}`);
} catch (e) {
  bad('配置有问题', String(e.message).split('\n').slice(0, 6).join(' / '), '改 config\\bots.json（面板底部也能改）；改完点面板的「重启应用」');
}

// ── 2 & 3. 进程与守护 ─────────────────────────────────────
const invRaw = await ps(`
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -notlike '*dsh-subprocess*' } |
    ForEach-Object {
      $c = [string]$_.CommandLine
      $kind = if ($c -like '*bothub-supervisor.mjs*' -and $c -notlike '*start-bothub-supervisor*') { 'supervisor' }
              elseif ($c -like '*main.mjs*') { 'app' } else { 'other' }
      [pscustomobject]@{ pid=[int]$_.ProcessId; kind=$kind }
    }) | ConvertTo-Json -Compress
`);
let inv = [];
try { inv = JSON.parse(invRaw || '[]'); } catch { /* ignore */ }
const sups = inv.filter((x) => x.kind === 'supervisor');
const apps = inv.filter((x) => x.kind === 'app');

const hb = readJson(path.join(DATA, 'heartbeat.json'));
const hbAgeSec = hb && hb.at ? Math.round((Date.now() - hb.at) / 1000) : null;
if (apps.length === 1 && hbAgeSec !== null && hbAgeSec < 60) ok('应用在跑且心跳新鲜', `pid ${apps[0].pid} · 心跳 ${hbAgeSec} 秒前`);
else if (apps.length === 0) bad('应用不在', hbAgeSec === null ? '从来没有心跳文件' : `心跳是 ${Math.round(hbAgeSec / 60)} 分钟前的`, '守护进程会在 5 秒内拉起它；如果一直起不来，看 data\\logs\\stdout.log');
else if (apps.length > 1) bad('应用起了多个', `${apps.length} 个：${apps.map((a) => a.pid).join(', ')}`, '同一个 QQ appId 不能两个进程同时连 —— 停掉多余的（或让守护只留一个）');
else if (hbAgeSec !== null && hbAgeSec >= 60) bad('应用在但**心跳停了**（卡死）', `pid ${apps[0].pid} · 心跳 ${Math.round(hbAgeSec / 60)} 分钟前`, '守护进程会杀掉重启；若反复如此，看 data\\logs\\app.log 里最后那条 ERROR');

if (sups.length === 1) ok('守护进程只有一个', `pid ${sups[0].pid}`);
else if (sups.length === 0) warn('没有守护进程', '应用现在没人看着（崩了不会自动起）', '双击 start-supervisor.cmd（或跑 tools\\start-bothub-supervisor.mjs --ensure）');
else bad('守护进程有多个', `${sups.length} 个：${sups.map((s) => s.pid).join(', ')}`, '跑 tools\\drill-recovery.mjs 会清干净并断言只剩一个');

// ── 4. 计划任务 ───────────────────────────────────────────
/**
 * 2026-10-15 改：旧的 DSH QQ 机器人（任务 `DSH-QQBot` / `DSH-QQBot-Watchdog`）已经退役
 * （BotHub 顶替了它，见 `_retired\qqbot-20261015`），所以这里不再检查它 ——
 * 否则体检会一直报"旧任务不存在"这种**已经没有意义**的提醒，把真问题淹掉。
 */
for (const [task, want] of [['DSH-BotHub', 'Ready'], ['DSH-BotHub-Ensure', 'Ready'], ['DSH-BotHub-Supervisor', 'Ready']]) {
  const out = await ps(`schtasks /query /tn "${task}" /fo LIST 2>$null | Out-String`);
  if (!out) { warn(`计划任务 ${task} 不存在`, '', '登录自启/兜底靠它；可以用 tools 里的脚本重建'); continue; }
  const status = (/Status:\s*(\S+)/i.exec(out) || [])[1] || '?';
  const lastRes = (/Last Result:\s*(-?\d+)/i.exec(out) || [])[1] || '?';
  if (status === want) ok(`计划任务 ${task}`, `状态 ${status}${lastRes !== '?' ? ` · 上次结果码 ${lastRes}` : ''}`);
  else warn(`计划任务 ${task} 状态是 ${status}`, '应该是 Ready（否则开机会起不来，或者崩了没人拉）', `schtasks /Change /TN "${task}" /ENABLE`);
}
{
  // 旧机器人那两个任务**不该再存在**（存在说明退役没做干净）
  for (const dead of ['DSH-QQBot', 'DSH-QQBot-Watchdog']) {
    const out = await ps(`schtasks /query /tn "${dead}" /fo LIST 2>$null | Out-String`);
    if (out) warn(`旧任务 ${dead} 还在`, '它是旧 QQ 机器人的（已被 BotHub 顶替），留着会跟 BotHub 抢同一个 QQ 连接', `schtasks /Delete /TN "${dead}" /F`);
  }
}

// ── 5. 面板 + 机器人 ─────────────────────────────────────
let status = null;
try {
  status = await (await fetch(BASE + '/api/status', { signal: AbortSignal.timeout(4000) })).json();
  ok('面板能访问', `${BASE}/ · 应用已跑 ${Math.round(status.uptimeSec / 60)} 分钟 · 内存 ${status.rssMB} MB`);
  for (const b of status.bots) {
    const lastMsg = b.lastMessageSecAgo === null ? '还没收到过消息' : `最后一条消息 ${b.lastMessageSecAgo < 60 ? b.lastMessageSecAgo + ' 秒' : Math.round(b.lastMessageSecAgo / 60) + ' 分钟'}前`;
    const line = `通道 ${b.channel}/${b.model} · 收到 ${b.messagesIn} 回 ${b.repliesOut} 跳过 ${b.skipped}（重复 ${b.duplicates} 限流 ${b.rateLimited}）· 网关就绪 ${b.gatewayUps} 次${b.gatewayResumes ? `（断线恢复 ${b.gatewayResumes} 次）` : ''} · ${lastMsg}`;
    if (!b.running) bad(`机器人 ${b.id} 没在跑`, line, '面板上点「重启这个机器人」，或看 data\\logs\\bot-' + b.id + '.log');
    else if (b.lastError) warn(`机器人 ${b.id} 在跑但有错`, `${line} · 最后错误：${b.lastError}`, '看 data\\logs\\app.log 里同时间的 ERROR');
    else ok(`机器人 ${b.id}`, line);
    if (b.queue.busyLanes > 0 || b.queue.queued > 0) warn(`机器人 ${b.id} 队列有积压`, `处理中 ${b.queue.busyLanes} · 排队 ${b.queue.queued}`, '正常情况下几秒就清了；一直不清看是否模型接口卡住');
  }
} catch (e) {
  bad('面板连不上', String(e.message), '应用可能没在跑 —— 双击 start-bothub.cmd，或看 data\\logs\\stdout.log');
}

// ── 6. 到 QQ 网关的连接 ──────────────────────────────────
if (apps.length === 1) {
  /**
   * ⚠️ 判据不能写死 IP 段（2026-10-15 修）。
   * 第一版只认 `101.91.*` / `58.217.*`，结果实际连的是 `61.151.231.145`
   * —— 体检报了"没有到 QQ 网关的连接"**假警报**，而它明明连着。
   * 假警报比漏报还坏：喊多了真出事就没人看。现在**动态解析域名**，解析不到才退回 IP 段。
   */
  const ipsRaw = await ps(`(Resolve-DnsName api.sgroup.qq.com -ErrorAction SilentlyContinue).IPAddress -join ','`);
  const ips = String(ipsRaw || '').split(',').map((s) => s.trim()).filter(Boolean);
  const match = ips.length
    ? ips.map((ip) => `$_.RemoteAddress -eq '${ip}'`).join(' -or ')
    : `$_.RemoteAddress -like '101.91.*' -or $_.RemoteAddress -like '58.217.*' -or $_.RemoteAddress -like '61.151.*'`;
  const conn = await ps(`@(Get-NetTCPConnection -OwningProcess ${apps[0].pid} -State Established -ErrorAction SilentlyContinue |
    Where-Object { $_.RemotePort -eq 443 -and (${match}) }).Count`);
  const n = Number(conn || 0);
  if (n > 0) ok('到 QQ 网关有 TCP 连接', `${n} 条${ips.length ? '（对端属于 api.sgroup.qq.com 的 ' + ips.length + ' 个地址）' : '（域名没解析出来，用的 IP 段判据）'}`);
  else warn('没有到 QQ 网关的连接', '可能正在重连（刚启动/刚演练完的十几秒内属正常）', '看日志里有没有 WebSocket closed / Reconnecting；拔线演练：node tools\\drill-reconnect.mjs');
}

// ── 7. 日志 ──────────────────────────────────────────────
for (const f of ['app.log', 'supervisor.log']) {
  const p = path.join(LOGDIR, f);
  const a = ageMin(p);
  if (!Number.isFinite(a)) { warn(`日志 ${f} 不存在`, '', `还没有写过；正常运行时它会自己出现`); continue; }
  /**
   * 只看**最近 60 分钟**的 ERROR。
   * 第一版把整份日志里的 ERROR 都翻出来，结果一条**早就修好**的旧错误永远挂着当提醒 ——
   * 报"有问题的东西"比漏报还糟：狼来了喊多了，真出事就没人看。
   */
  const cutoff = Date.now() - 60 * 60 * 1000;
  let errs = [];
  try {
    errs = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => {
      if (!l.includes(' ERROR')) return false;
      const m = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/.exec(l);
      return m ? new Date(m[1].replace(' ', 'T') + '+08:00').getTime() >= cutoff : true;
    }).slice(-2);
  } catch { /* ignore */ }
  if (errs.length) {
    // 已知无害的 ERROR：防双开守卫拦下第二次启动。它是**在干活**，不该报成故障。
    const benign = /已经在跑了/;
    const real = errs.filter((l) => !benign.test(l));
    if (real.length) warn(`日志 ${f} 最近 1 小时里有 ERROR`, real[0].slice(0, 140), `完整内容：${p}`);
    else ok(`日志 ${f} 的 ERROR 是已知无害的（防双开拦下重复启动）`, errs[0].slice(0, 100));
  } else ok(`日志 ${f} 最近 1 小时没有 ERROR`, `${Math.round(a)} 分钟前写过`);
}

// ── 汇总 ────────────────────────────────────────────────
console.log('');
for (const r of rows) {
  const icon = r.level === 'ok' ? '✅' : r.level === 'warn' ? '⚠️' : '❌';
  console.log(`${icon} ${r.title}${r.detail ? ' —— ' + r.detail : ''}`);
  if (r.advice) console.log(`     ↳ 怎么办：${r.advice}`);
}
const bads = rows.filter((r) => r.level === 'bad').length;
const warns = rows.filter((r) => r.level === 'warn').length;
console.log('='.repeat(64));
console.log(bads ? `❌ 有 ${bads} 项要处理` + (warns ? `，另有 ${warns} 项提醒` : '') : warns ? `⚠️ 没有大问题，有 ${warns} 项提醒` : '✅ 一切正常');
process.exit(bads ? 1 : warns ? 2 : 0);
