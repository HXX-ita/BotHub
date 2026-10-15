/**
 * util.mjs —— BotHub 的公共小工具：日志、密钥解析、时间、JSON 读写。
 *
 * 设计原则（都是这一天在 QQ 机器人上踩出来的）：
 *   ① **动作必须留痕**：任何"丢弃/排队/放弃"都要写一行日志，不许静默。
 *   ② **绝不打印密钥**：日志里只出现"长度/来源"，不出现值（mask）。
 *   ③ 日志按天切文件，避免长跑把盘写满。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ROOT = process.env.BOTHUB_HOME || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
export const DATA = path.join(ROOT, 'data');
export const LOGDIR = path.join(DATA, 'logs');

fs.mkdirSync(LOGDIR, { recursive: true });

const pad = (n) => String(n).padStart(2, '0');
export function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 一日一文件的追加日志；单文件超过 32MB 就换 .1（够用，不做完整轮转） */
export function appendLog(file, line) {
  try {
    fs.mkdirSync(LOGDIR, { recursive: true });
    const p = path.join(LOGDIR, file);
    try { if (fs.statSync(p).size > 32 * 1024 * 1024) fs.renameSync(p, p + '.1'); } catch { /* 不存在就算了 */ }
    fs.appendFileSync(p, line + '\r\n', 'utf8');
  } catch { /* 日志失败绝不影响主流程 */ }
}

/** 每个机器人一份日志 + 一份总日志 */
export function makeLogger(botId) {
  const write = (level, msg) => {
    const line = `[${stamp()}] ${level} ${botId ? `[${botId}] ` : ''}${msg}`;
    console.log(line);
    appendLog('app.log', line);
    if (botId) appendLog(`bot-${botId}.log`, line);
  };
  return {
    info: (m) => write('INFO ', m),
    warn: (m) => write('WARN ', m),
    error: (m) => write('ERROR', m),
    /** 入站全链路留痕：RAW / EVENT / ACK / PROCESSING / SENT / DROP —— 一行不许省 */
    trace: (m) => { const line = `[${stamp()}] TRACE ${botId ? `[${botId}] ` : ''}${m}`; appendLog(`bot-${botId}.log`, line); appendLog('inbound.log', line); if (process.env.BOTHUB_TRACE_STDOUT === '1') console.log(line); },
  };
}

/**
 * 解引用：字符串里可以写
 *   "${ENV:QIANWEN_API_KEY}"      → 环境变量
 *   "${FILE:D:\\path\\key.txt}"   → 文件内容（去掉首尾空白）
 *   "${DSHQqbot:appSecret}"       → 从 DSH 的 qqbot profile 配置里取（避免把密钥抄第二份）
 *   "${SECRET:qq-main.appSecret}" → 从 BotHub 自己的 config\secrets.json 取（面板里设置的那种）
 * 取不到就返回 null，并**只报来源、不报值**。
 */
export function resolveSecret(ref) {
  if (typeof ref !== 'string') return null;
  const m = /^\$\{([A-Za-z]+):([^}]+)\}$/.exec(ref.trim());
  if (!m) return ref.trim() || null;
  const [, kind, arg] = m;
  try {
    if (kind === 'ENV') return process.env[arg] || null;
    if (kind === 'FILE') return fs.readFileSync(arg.trim(), 'utf8').trim() || null;
    if (kind === 'DSHQqbot') return readDshQqbotConfig()[arg] || null;
    if (kind === 'SECRET') return readBotHubSecret(arg.trim());
  } catch { return null; }
  return null;
}

/** BotHub 自己的密钥库：config\secrets.json，形如 { "qq-main": { "appSecret": "..." } } */
export const SECRETS_PATH = path.join(ROOT, 'config', 'secrets.json');

export function readBotHubSecret(keyPath) {
  const all = readJson(SECRETS_PATH, {});
  const parts = String(keyPath).split('.');
  let cur = all;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || !(p in cur)) return null;
    cur = cur[p];
  }
  return typeof cur === 'string' && cur.trim() ? cur.trim() : null;
}

export function writeBotHubSecret(botId, obj) {
  const all = readJson(SECRETS_PATH, {}) || {};
  all[botId] = { ...(all[botId] || {}), ...obj };
  fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(all, null, 2), 'utf8');
  try { fs.chmodSync(SECRETS_PATH, 0o600); } catch { /* Windows 上尽力而为 */ }
}

/**
 * 从 DSH 的 qqbot profile 配置里读凭据（**只读，不打印值**）。
 * 为什么允许这么做：老板已经有一套跑着的机器人，密钥没必要抄第二份、抄了还多一处轮换点。
 */
/** 本机 DSH 有哪些 profile（模型清单要"把所有 profile 合起来看"） */
export function dshHomePath() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  try { const l = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'local.json'), 'utf8')); if (l.dshHome) return l.dshHome; } catch { /* ignore */ }
  return path.join(os.homedir(), '.dsh');
}

export function listDshProfiles() {
  const home = dshHomePath();
  try {
    return fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}
export function readDshQqbotConfig() {
  // 可移植：环境变量 → 用户目录下的 .dsh → 作者机器的位置（只在存在时才用）
  // 顺序：环境变量 → 本机私有文件 config\local.json（不进版本库）→ 用户目录下的 .dsh
  let localHome = null;
  try { localHome = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'local.json'), 'utf8')).dshHome || null; } catch { /* 没有这个文件是正常的 */ }
  const home = process.env.DSH_HOME || localHome || path.join(os.homedir(), '.dsh');
  const files = [
    path.join(home, 'profiles', 'qqbot', 'cordis.patch.yml'),
    path.join(home, 'profiles', 'qqbot', 'cordis.yml'),
  ];
  for (const f of files) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const pick = (key) => {
      const r = new RegExp(`^\\s*${key}\\s*:\\s*"?([^"\\r\\n]+)"?\\s*$`, 'm');
      const m = r.exec(txt);
      return m ? m[1].trim() : null;
    };
    const appId = pick('appId');
    const appSecret = pick('appSecret');
    if (appId && appSecret) {
      const debug = /^\s*debug\s*:\s*true\s*$/m.test(txt);
      return { appId, appSecret, debug };
    }
  }
  return {};
}

/** 掩码：证明"有值"但绝不泄露值本身 */
export const mask = (v) => (v ? `已取到(长度 ${String(v).length})` : '取不到');

export function readJson(file, dflt = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}
export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 轻掩码：给**不是秘密**的东西（例如 QQ 的 appId —— 它本来就出现在客户端流程里）用。
 * 为什么要有：`mask()` 返回的是"已取到(长度 10)"，放在界面上没法核对自己填的是哪一个；
 * 而 appId 需要能"一眼认出是不是它"。appSecret 仍然用严格掩码（绝不显示片段）。
 */
export function lightMask(s) {
  const v = String(s || '');
  if (!v) return '（未填）';
  if (v.length <= 6) return v[0] + '*'.repeat(Math.max(0, v.length - 1));
  return v.slice(0, 3) + '*'.repeat(Math.max(3, v.length - 5)) + v.slice(-2);
}