/**
 * dsh-env-setup.mjs —— 「DSH 环境一键配置」
 *
 * 用户从 GitHub 下载 BotHub 后，双击 `DSH环境一键配置.cmd` 就会跑这个脚本。
 * 它只做**三件必要的事**（别的一概不碰，免得改坏用户的环境）：
 *
 *   ① 找到本机的 DSH（DeepSeek Harness）本体，并把路径写进 `config/local.json`
 *      → 之后 BotHub 启动就能自动连上它（不然用户得自己找路径）。
 *   ② 检查 DSH 里**有没有可用的模型**（读 `--dump-config` 的 providers/models）：
 *      没有就明确告诉他去 DSH 里配一个（或装免费模型插件），不要瞎猜。
 *   ③ 检查那几个**可选插件/常驻进程**在不在，只报告、不擅自安装
 *      （装插件要动用户的 DSH，属于"改人家环境"，必须他自己点头）。
 *
 * 用法：
 *   node dsh-env-setup.mjs            # 只检查 + 报告（默认，安全）
 *   node dsh-env-setup.mjs --apply    # 检查并把 DSH 路径写进 BotHub 配置
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');                       // BotHub 根目录
const APPLY = process.argv.includes('--apply');
const C = { ok: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m', dim: '\x1b[90m', off: '\x1b[0m' };
const say = (s) => console.log(s);
const ok = (t, d = '') => say(`  ${C.ok}✓${C.off} ${t}${d ? ` ${C.dim}${d}${C.off}` : ''}`);
const warn = (t, d = '') => say(`  ${C.warn}!${C.off} ${t}${d ? ` ${C.dim}${d}${C.off}` : ''}`);
const bad = (t, d = '') => say(`  ${C.bad}✗${C.off} ${t}${d ? ` ${C.dim}${d}${C.off}` : ''}`);

say('');
say('  ┌──────────────────────────────────────────────┐');
say('  │        DSH 环境一键配置（BotHub 附带）       │');
say('  └──────────────────────────────────────────────┘');
say('');

// ── ① 找 DSH 本体 ───────────────────────────────────────────
function findDsh() {
  const cands = [];
  // ① 命令行显式指定：--dsh "D:\\xxx\\DeepSeek Harness.exe"
  const dshArg = (process.argv.find((a) => a.startsWith('--dsh=')) || '').slice(6);
  if (dshArg) cands.push(dshArg.replace(/^"|"$/g, ''));
  // ② 各盘根目录下一层（用户的安装位置千奇百怪，C:\\Tools\\ 这种很常见）
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    try {
      for (const d of fs.readdirSync(drive, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        cands.push(path.join(drive + '\\', d.name, 'DeepSeek Harness.exe'));
        cands.push(path.join(drive + '\\', d.name, 'resources', 'DeepSeek Harness.exe'));
      }
    } catch { /* 没这个盘 */ }
  }
  if (process.env.DSH_EXE) cands.push(process.env.DSH_EXE);
  try {
    const local = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'local.json'), 'utf8'));
    if (local.dshExe) cands.push(local.dshExe);
  } catch { /* 没有这个文件很正常 */ }
  // 常见安装位置（不猜别的盘，就查用户目录和几个标准位置）
  for (const p of [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    'C:\\Program Files (x86)\\DeepSeek Harness\\DeepSeek Harness.exe',
  ]) cands.push(p);
  // 环境里已经装了 DSH 的话，它的 cli 会在 app.asar 里；顺着 asar 反推 exe 也行（先不做）
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}
const dshExe = findDsh();
if (dshExe) ok('找到 DSH 本体', dshExe);
else {
  bad('没找到 DSH（DeepSeek Harness）');
  say(`      请确认 DSH 已安装。也可以直接告诉它路径：`);
  say(`        ${C.dim}DSH环境一键配置.cmd --dsh "C:\\Tools\\DeepSeek Harness.exe"${C.off}`);
  say(`      或者手工写进 ${C.dim}config\\local.json${C.off} 的 ${C.dim}dshExe${C.off}。`);
  say('');
  process.exit(1);
}

/**
 * DSH 的 CLI 入口（BotHub 就是用 ELECTRON_RUN_AS_NODE 跑它的）。
 * ⛔ 注意：`resources\app.asar` 是**虚拟归档** —— 普通进程 `fs.existsSync` 永远返回 false
 *    （只有 Electron 自己的 fs 能读进去）。所以这里**不能靠 existsSync 判断**，
 *    直接把候选路径交给 DSH 本体去跑，跑通为准（这也是后面模型检查用的同一条路）。
 */
function findCli(exe) {
  const rels = [
    ['resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'],
    ['resources', 'app.asar', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'],
  ];
  return rels.map((r) => path.join(path.dirname(exe), ...r));
}
const cliCands = findCli(dshExe);
let dshCli = null;

// ── ② DSH 目录 / profiles ───────────────────────────────────
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
if (fs.existsSync(dshHome)) ok('DSH 数据目录', dshHome);
else warn('还没看到 DSH 的数据目录', dshHome + '（第一次打开 DSH 后才会生成）');

let profiles = [];
try {
  profiles = fs.readdirSync(path.join(dshHome, 'profiles'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
} catch { /* 还没有 */ }
if (profiles.length) ok('DSH 里的 profile', profiles.join('、'));
else warn('没读到 profile（DSH 还没跑过）');

// ── ③ 检查有没有可用模型（这才是"环境配好了没有"的关键） ──
const run = (args) => new Promise((res) => execFile(dshExe, args, {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  windowsHide: true, timeout: 90000, maxBuffer: 16 << 20, encoding: 'utf8',
}, (e, so) => res(e ? '' : String(so))));

let modelOk = false, modelNote = '';
if (cliCands.length) {
  const profile = profiles.includes('headless') ? 'headless' : (profiles[0] || 'headless');
  let dump = '';
  for (const c of cliCands) {                      // 候选路径挨个试，跑通为准
    dump = await run(['--expose-internals', c, '--profile', profile, '--dump-config']);
    if (dump) { dshCli = c; break; }
  }
  if (dshCli) ok('DSH 命令行能用', `（profile=${profile}）`);
  else warn('DSH 命令行跑不通（版本不同？）—— 跳过模型检查');
  /**
   * ⛔ 别用"/- id:/ 全捞"来数模型 —— 那会把**插件的 id**（tool-plugin-manager、timer、hmr…）
   *    全算进来（我第一版就报出"97 个模型"这种笑话）。只认 `models:` 段下面、缩进更深的那几行。
   */
  const parseModels = (text) => {
    const lines = String(text).split(/\r?\n/);
    const out = [];
    for (let k = 0; k < lines.length; k++) {
      const m = /^(\s*)models:\s*$/.exec(lines[k]);
      if (!m) continue;
      const base = m[1].length;
      for (let j = k + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) continue;
        const ind = (l.match(/^\s*/) || [''])[0].length;
        if (ind <= base) break;
        const id = /-\s*id:\s*([\w.\-/]+)/.exec(l);
        if (id) out.push(id[1]);
      }
    }
    return [...new Set(out)];
  };
  const models = parseModels(dump);
  const hasDefault = /agent-default-model/.test(dump);
  if (hasDefault && models.length) { modelOk = true; modelNote = `${profile} 里读到 ${models.length} 个模型：${models.slice(0, 4).join('、')}`; }
  else if (hasDefault) { modelOk = true; modelNote = `${profile} 里配了默认模型`; }
  else modelNote = `${profile} 里没读到模型配置`;
}
if (modelOk) ok('DSH 里有可用的模型', modelNote);
else {
  warn('没读到模型配置', modelNote);
  say(`      去 DSH 里配一个模型（设置 → 模型，或装"免费模型"插件），BotHub 才能替你回话。`);
}

// ── ④ 可选插件 / 常驻进程：只报告 ───────────────────────────
say('');
say(`  ${C.dim}可选（不装也能用，装了更省心）：${C.off}`);
const opt = [
  ['dsh-control-center', '控制中心插件（看插件/额度/日志）'],
  ['dsh-usage-dashboard', '用量面板（看额度）'],
  ['dsh-think-translate', '思考翻译'],
];
for (const [name, desc] of opt) {
  let found = false;
  for (const p of profiles) {
    try { if (fs.existsSync(path.join(dshHome, 'profiles', p, 'node_modules', name))) { found = true; break; } } catch { /* ignore */ }
  }
  if (found) ok(desc); else warn(`${desc} —— 没装`);
}
try {
} catch { /* ignore */ }

// 常驻辅助脚本：各家环境不一样，这里只提一句，不点名、不擅自装
say(`  ${C.dim}有想让 BotHub 顺手保活的常驻脚本，就写进 config\\local.json 的 keepAliveScripts。${C.off}`);

// ── ⑤ 写配置（--apply 才写） ───────────────────────────────
say('');
if (!APPLY) {
  warn('以上只做了检查。要顺便把 DSH 路径写进 BotHub 配置，加 --apply 再跑一次。');
} else {
  const file = path.join(ROOT, 'config', 'local.json');
  let local = {};
  try { local = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 新建 */ }
  const before = JSON.stringify(local);
  local.dshExe = dshExe;
  if (fs.existsSync(dshHome)) local.dshHome = dshHome;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(local, null, 2) + '\n', 'utf8');
    const back = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (back.dshExe === dshExe) ok('已把 DSH 路径写进 BotHub 配置', file);
    else bad('写了但回读不一致（请手工检查）');
  } catch (e) { bad('写入失败：' + e.message); }
  if (before === JSON.stringify(local)) say(`      ${C.dim}（配置本来就是这个值，没变化）${C.off}`);
}

say('');
say(modelOk ? `  ${C.ok}环境看起来没问题，可以直接启动 BotHub 了。${C.off}`
            : `  ${C.warn}还差模型配置 —— 配好之后再启动 BotHub。${C.off}`);
say('');
