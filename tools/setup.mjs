#!/usr/bin/env node
/**
 * setup.mjs —— 首次配置向导：**填 QQ 机器人的 appId / appSecret，就能得到一个自己的机器人**。
 *
 * 交互式跑（双击 install.cmd 就会走到这里）：
 *   node tools\setup.mjs
 * 也可以带参数跑（自动化/自测用）：
 *   node tools\setup.mjs --appId 123456 --appSecret xxxx --channel dsh --yes
 *   node tools\setup.mjs --check-only          # 只看当前配置对不对，不改任何东西
 *
 * 它做的事：
 *   1. 选"脑子"：`dsh`（连 DSH 本体，会干活）或 `openai`（任意 OpenAI 兼容的云端模型）
 *   2. 收 appId / appSecret（**只在本地用，明文只写进 config\secrets.json，不回显**）
 *   3. **先验证再落盘**：拿这对凭据去 QQ 换一次 access_token，换不到就不写
 *   4. 写 config\bots.json（只写 `${SECRET:...}` 引用）+ config\secrets.json
 *   5. （Windows）注册两个计划任务：登录自启 + 每分钟兜底看护
 *   6. 启动应用、打开面板
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CFG_DIR = path.join(ROOT, 'config');
const CFG = path.join(CFG_DIR, 'bots.json');
const SECRETS = path.join(CFG_DIR, 'secrets.json');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const val = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`,
};
const say = (s = '') => process.stdout.write(s + '\n');

/* ── --check-only：只看现状，**不问任何问题、不写任何文件**（必须放在最前面） ── */
if (flag('check-only')) {
  const has = fs.existsSync(CFG);
  if (!has) { say(c.y('还没有配置') + '（config\\bots.json 不存在）—— 运行 install.cmd 或 node tools\\setup.mjs 来配一个。'); process.exit(1); }
  try {
    const cur = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    say(c.g('✔ 已有配置：') + `${cur.bots?.length || 0} 个机器人、${cur.channels?.length || 0} 个通道`);
    for (const b of cur.bots || []) say(`   · ${b.id}（${b.alias || '无别名'}）→ 通道 ${b.channel}`);
    const s = fs.existsSync(SECRETS) ? Object.keys(JSON.parse(fs.readFileSync(SECRETS, 'utf8'))) : [];
    say(s.length ? c.g('✔ 密钥文件里有：') + s.join(', ') : c.r('✘ 没有密钥文件 config\\secrets.json'));
    process.exit(0);
  } catch (e) { say(c.r('配置读不出来：') + e.message); process.exit(1); }
}

/* ── 找 DSH（不写死路径） ── */
function findDsh() {
  const cands = [
    process.env.DSH_EXE,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ].filter(Boolean);
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

/* ── 拿凭据去 QQ 换一次 token（唯一的真验证） ── */
async function verifyQq(appId, appSecret) {
  try {
    const r = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
    });
    const j = await r.json();
    if (j.access_token) return { ok: true, expiresIn: j.expires_in };
    return { ok: false, why: `平台没给 token（返回字段：${Object.keys(j).join(',') || '空'}）` };
  } catch (e) {
    return { ok: false, why: '连不上 QQ 的鉴权接口：' + (e && e.message) };
  }
}

/* ── 注册计划任务（Windows；隐藏外壳 = 屏幕上不会弹窗口） ── */
function registerTasks() {
  if (process.platform !== 'win32') return '（不是 Windows，跳过计划任务）';
  const node = process.execPath;
  const vbs = path.join(HERE, 'run-hidden.vbs');   // 零窗口外壳（Task Scheduler 直接跑 node 会弹控制台窗口）
  const shell = fs.existsSync(vbs) ? { exe: 'wscript.exe', pre: `//nologo "${vbs}" ` } : { exe: node, pre: '' };
  const mk = (name, arg, trigger, mins) => {
    const ps = [
      `$a = New-ScheduledTaskAction -Execute '${shell.exe}' -Argument '${shell.pre}${arg}' -WorkingDirectory '${ROOT}'`,
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden`,
      `$p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Highest`,
      `$t = ${trigger}`,
      `Register-ScheduledTask -TaskName '${name}' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`,
    ].join('; ');
    try { execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'ignore', windowsHide: true }); return true; }
    catch { return false; }
  };
  const okSuper = mk('BotHub-Supervisor', 'bothub-supervisor.mjs',
    `New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 2)`);
  const okEnsure = mk('BotHub-Ensure', 'start-bothub-supervisor.mjs --ensure',
    `New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)`);
  return okSuper && okEnsure ? '已注册：BotHub-Supervisor / BotHub-Ensure（登录自启 + 每分钟兜底）'
                             : '计划任务没注册成功（不影响手动启动；多半是没有权限）';
}

/* ── 启动应用 + 打开面板 ── */
function startApp() {
  const sup = path.join(HERE, 'start-bothub-supervisor.mjs');
  if (fs.existsSync(sup)) {
    try { execFileSync(process.execPath, [sup, '--ensure'], { cwd: ROOT, stdio: 'ignore', windowsHide: true, timeout: 60000 }); } catch { /* ignore */ }
  } else {
    const out = fs.openSync(path.join(ROOT, 'data', 'logs', 'stdout.log'), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'main.mjs')], { cwd: ROOT, windowsHide: true, stdio: ['ignore', out, out] });
    child.unref();
  }
  // 等面板起来再开窗口
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = async () => {
      try { const r = await fetch('http://127.0.0.1:7788/api/health'); if (r.ok) return resolve(true); } catch { /* 还没起 */ }
      if (Date.now() - t0 > 30000) return resolve(false);
      setTimeout(tick, 800);
    };
    tick();
  });
}

/* ── 主流程 ── */
say('');
say(c.b('  BotHub 首次配置') + c.dim('  —— 一个属于你自己的 QQ 机器人'));
say(c.dim('  ─────────────────────────────────────────────'));
say('');

const dshExe = findDsh();
/**
 * 交互：**只有真的在终端里跑才开 readline**。
 * 踩过：从脚本/管道里跑（没有 TTY）时 `rl.question` 的 Promise **永远不 settle**，
 * 表现为"卡死 + unsettled top-level await"。管道场景一律走默认值/命令行参数。
 */
const interactive = process.stdin.isTTY && !flag('yes');
const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (q, dflt) => {
  if (!rl) return dflt;
  try {
    const a = (await rl.question(q + (dflt ? c.dim(` [${dflt}]`) : '') + '：')).trim();
    return a || dflt || '';
  } catch { return dflt || ''; }   // 输入被关掉也别卡住
};

// 1) 脑子
let kind = val('channel', null);
if (!kind) {
  say('机器人用什么"脑子"？');
  say('  ' + c.b('1') + ' 连 DSH（会读文件、跑命令、用技能 —— 推荐）' + (dshExe ? c.g('  ✔ 已找到 DSH') : c.y('  ⚠ 没找到 DSH，装好后需填路径')));
  say('  ' + c.b('2') + ' 任意云端模型（OpenAI 兼容接口，只会聊天）');
  kind = (await ask('选 1 还是 2', '1')) === '2' ? 'openai' : 'dsh';
}
if (kind !== 'openai') kind = 'dsh';

let channel;
if (kind === 'dsh') {
  const exe = val('dshExe', null) || dshExe || await ask('DSH 程序路径（DeepSeek Harness.exe）', '');
  channel = { id: 'dsh-local', kind: 'dsh', profile: await ask('DSH profile 名字（不知道就回车）', 'headless'), timeoutMs: 180000 };
  if (exe) channel.dshExe = exe;
  if (!exe) say(c.y('  ⚠ 没填 DSH 路径：机器人仍然能装好，但要等你在设置里填上它才会回话。'));
} else {
  const baseURL = await ask('模型接口地址 baseURL', 'https://api.openai.com/v1');
  const model = await ask('模型名 model', 'gpt-4o-mini');
  const key = val('apiKey', null) || await ask('模型 API Key（只写进本地文件，不回显）', '');
  channel = { id: 'cloud', kind: 'openai', baseURL, model, apiKey: '${SECRET:cloud.apiKey}' };
  if (key) {
    const obj = JSON.parse(fs.existsSync(SECRETS) ? fs.readFileSync(SECRETS, 'utf8') : '{}');
    obj.cloud = { ...(obj.cloud || {}), apiKey: key };
    fs.mkdirSync(CFG_DIR, { recursive: true });
    fs.writeFileSync(SECRETS, JSON.stringify(obj, null, 2), 'utf8');
  }
}

// 2) 凭据
const appId = val('appId', null) || await ask('QQ 机器人 appId', '');
const appSecret = val('appSecret', null) || await ask('QQ 机器人 appSecret（不回显、不写进日志）', '');
if (!appId || !appSecret) {
  say(c.r('缺少 appId 或 appSecret，没法继续。') + '（在 QQ 开放平台的"机器人"页面能看到这两个）');
  process.exit(2);
}

say('');
process.stdout.write('正在拿这对凭据向 QQ 验证… ');
const v = await verifyQq(appId, appSecret);
if (!v.ok) {
  say(c.r('失败'));
  say('  ' + v.why);
  say(c.dim('  → 我没写任何文件。请核对 appId / appSecret（appSecret 只在创建时显示一次，如果忘了要在控制台重置）。'));
  process.exit(3);
}
say(c.g('通过') + c.dim(`（token 有效期 ${v.expiresIn} 秒）`));

// 3) 落盘（明文只进 secrets.json，bots.json 只留引用）
fs.mkdirSync(CFG_DIR, { recursive: true });
const secrets = JSON.parse(fs.existsSync(SECRETS) ? fs.readFileSync(SECRETS, 'utf8') : '{}');
secrets['qq-main'] = { appId, appSecret };
fs.writeFileSync(SECRETS, JSON.stringify(secrets, null, 2), 'utf8');

const cfg = {
  http: { port: 7788, host: '127.0.0.1' },
  channels: [channel],
  bots: [{
    id: 'qq-main',
    alias: '我的机器人',
    platform: 'qq',
    channel: channel.id,
    credentials: { appId: '${SECRET:qq-main.appId}', appSecret: '${SECRET:qq-main.appSecret}' },
    mentionRequired: true,
    // 默认给一个安全又好用的权限：只能在它自己的工作目录里写（DSH 的权限预设）
    permission: 'workspace-write',
    persona: '你是老板电脑上的 AI 助手。中文回答，直接给结论，别客套、别写总结段、回答短一点。',
    commands: [
      { name: '/状态', desc: '看它还活着吗、收到多少条', action: 'status' },
      { name: '/帮助', desc: '看有哪些指令', action: 'help' },
    ],
    limits: { perPeerPerMin: 8 },
  }],
};
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2), 'utf8');
say(c.g('✔ 配置已写好') + c.dim(`（${path.relative(ROOT, CFG)}；明文只在 ${path.relative(ROOT, SECRETS)}）`));

// 4) 计划任务
say(c.dim('注册开机自启与看护… ') + registerTasks());

// 5) 起来
say('正在启动…');
const up = await startApp();
say(up ? c.g('✔ 起来了') + '：打开 ' + c.b('http://127.0.0.1:7788/') + ' 看它。'
       : c.y('⚠ 30 秒内没等到面板') + '：双击 start.cmd 再试，或用 check.cmd 看诊断。');
say('');
say(c.b('接下来：') + ' 在 QQ 里' + c.b('私聊它') + '（或群里 ' + c.b('@ 它') + '）发一条消息，发 ' + c.b('/帮助') + ' 看它能不能回。');
say(c.dim('注意：QQ 官方机器人**不能主动给你发消息**（平台限制），必须你先说话。'));
if (rl) rl.close();
