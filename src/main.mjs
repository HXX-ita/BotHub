/**
 * main.mjs —— BotHub 入口。把配置、机器人、面板、心跳串起来。
 *
 * 用法：
 *   node src/main.mjs              前台跑（老板平时双击 start-bothub.cmd）
 *   node src/main.mjs --check      只校验配置 + 试一次模型通道（不连 QQ）
 *   node src/main.mjs --status     读本机面板接口，打印一行状态
 *   node src/main.mjs --port 7788  换端口
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { BotInstance } from './bot.mjs';
import { loadConfig, writeExample, publicConfig, CONFIG_PATH, readConfigText, saveConfigText } from './config.mjs';
import { startWeb } from './web.mjs';
import { makeLogger, writeJson, readJson, DATA, stamp, mask, lightMask, SECRETS_PATH, writeBotHubSecret, listDshProfiles, dshHomePath } from './util.mjs';
import { listDshProviders, scanProfilePatches } from './models.mjs';

/**
 * `--compact-sessions`：**只压缩一次就退出**。
 * 为什么要它：Windows 上应用可能被直接强杀（没有信号钩子可跑），
 * 托盘"退出"和 `stop-bothub.mjs` 可以**先调这个**再杀 —— 保证"关闭时压缩"真的发生。
 */
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const log = makeLogger(null);
const HEARTBEAT = path.join(DATA, 'heartbeat.json');
const PIDFILE = path.join(DATA, 'bothub.pid');
const PWSH = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
let hostCache = null;   // 系统层信息缓存（面板 5 秒一刷，但问系统要几百毫秒）
/**
 * 机器人"资料"缓存（平台侧名字/头像）：**存盘**。
 * 为什么存盘：老板要求"资料常驻显示" —— 重启应用、平台一时连不上，界面上也得有头像和名字，
 * 而不是变成一片空白（空白会让人以为机器人没了）。
 */
/**
 * 把自己的运行时信息写下来（node 路径等），给托盘/脚本用。
 * 为什么：托盘是 PowerShell，它需要"用哪个 node 去跑 stop-bothub.mjs" ——
 * 以前那里写死了一个具体机器上的 node 路径。现在由应用自己报出来，谁装的都对。
 */
function saveRuntimeInfo() {
  try {
    writeJson(path.join(DATA, 'runtime.json'), {
      node: process.execPath, pid: process.pid, at: Date.now(), version: process.version,
    });
  } catch { /* 写不上不影响运行 */ }
}
saveRuntimeInfo();

const PROFILE_FILE = path.join(DATA, 'profiles.json');
const profileStore = readJson(PROFILE_FILE, {}) || {};

/**
 * 取"某个机器人自己的会话库"。
 * ⚠️ 会话库是**每个 BotInstance 一份**（`this.sessions`），main 里没有全局的 ——
 *    我第一次写维护功能时按全局变量找，结果接口回 "sessions is not defined"。
 */
const maintenance_ = {};   // 维护相关的进程内小缓存（目录大小）
const models_ = {};        // 模型清单缓存（dump-config 要一两秒）

/**
 * 这台电脑上 DSH 能用的模型（老板："机器人软件读取目前电脑上 DSH 可用的模型"）。
 * 合并**所有 profile**：能 dump 的就 dump（拿完整模型清单），dump 不了的（desktop 被 Electron 独占）
 * 就静态扫它的 patch。结果缓存 10 分钟 —— dump 一次要一两秒，面板不该每次都等。
 */
async function dshModelInventory(dshExe) {
  if (models_.dsh && Date.now() - models_.dsh.at < 600000) return models_.dsh.value;
  const profiles = listDshProfiles();
  const merged = new Map();
  const skipped = [], patched = [];
  for (const p of [...new Set(['headless', ...profiles])]) {
    const r = await listDshProviders(p, dshExe);
    if (!r.ok) {
      const provs = scanProfilePatches(dshHomePath(), p);
      if (provs.length) {
        for (const prov of provs) {
          const cur = merged.get(prov.id) || { ...prov, models: [], profiles: [] };
          cur.models = [...new Set([...cur.models, ...prov.models])];
          cur.profiles = [...new Set([...cur.profiles, p])];
          merged.set(prov.id, cur);
        }
        patched.push(p);
      } else skipped.push(p + '（' + String(r.error || '').slice(0, 50) + '）');
      continue;
    }
    for (const prov of r.providers) {
      const cur = merged.get(prov.id) || { ...prov, models: [], profiles: [] };
      cur.models = [...new Set([...cur.models, ...prov.models])];
      cur.profiles = [...new Set([...cur.profiles, p])];
      if (!cur.displayName && prov.displayName) cur.displayName = prov.displayName;
      merged.set(prov.id, cur);
    }
  }
  const value = { providers: [...merged.values()], profiles, skippedProfiles: skipped, patchedProfiles: patched };
  models_.dsh = { at: Date.now(), value };
  return value;
}

const storeOf = (id) => { const inst = byId.get(id); return inst ? inst.sessions : null; };
/**
 * 应用关闭时**压缩所有机器人的所有会话**（老板：「历史会话记录在应用关闭的时候会进行压缩，
 * 下次启动的时候也都能记住」）。压缩 = 保留最近 N 轮 + 一行摘要 + 关键词；**不清空**，
 * 所以下次启动接着聊还认得。这里必须**同步**做完（退出钩子里没法 await）。
 */
function compactAllSessions() {
  const done = [];
  for (const inst of byId.values()) {
    try {
      for (const f of inst.sessions.list(inst.cfg.id)) {
        if (!f.file.endsWith('.jsonl')) continue;
        const [scope, ...rest] = f.file.replace('.jsonl', '').split('__');
        const r = inst.sessions.compactNow(inst.cfg.id, scope, rest.join('__'), inst.cfg.historyTurns || 12);
        if (r.before !== r.after) done.push(`${inst.cfg.id}:${scope} ${r.before}→${r.after}`);
      }
    } catch (e) { appendLog('app.log', `[${stamp()}] WARN  退出前压缩会话失败（不影响退出）：${e.message}`); }
  }
  if (done.length) appendLog('app.log', `[${stamp()}] INFO  压缩会话：${done.join('，')}`);
  return done;
}
let exiting = false;
function shutdown(sig) {
  if (exiting) return;
  exiting = true;
  appendLog('app.log', `[${stamp()}] INFO  收到 ${sig}，退出前压缩会话`);
  /**
   * ⛔ 这里**绝对不能**自己 `process.exit` —— 文件末尾还有一个 `bye`（停机器人 + 清 pid 文件 + 退出）。
   *    退出钩子按注册顺序同步跑，我先 exit 的话 `bye` 就不跑了 → **pid 文件留在地上**，
   *    下次启动读到"已经在跑"直接退出（这个坑技能里记着：pid 文件一个进程一份、谁写谁清）。
   *    所以这里只做"压缩"这一件事，退出让给 `bye`。
   * ⛔ 另外注意：**Windows 上"被强杀"根本不会触发任何信号钩子**（Node 在 Windows 对 SIGINT/SIGTERM
   *    是不支持的直接终止；`stop-bothub.mjs` 也是直接 kill）。所以"关闭时压缩"不能只靠这里 ——
   *    真正的保险是三重：① 每轮超长时自动压缩；② **启动时补压一次**（把上次硬杀留下的收尾）；
   *    ③ 这个信号钩子（正常 Ctrl+C / 注销时也能压）。
   */
  try { compactAllSessions(); } catch { /* 压缩失败不能影响退出 */ }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
function saveProfiles() { try { writeJson(PROFILE_FILE, profileStore); } catch { /* 存不上不影响显示 */ } }

// ── --check：只校验配置和模型通道，用来在真正上线前先排掉低级错误 ──
if (has('--check')) {
  let cfg;
  try { cfg = loadConfig(); } catch (e) { console.error('❌ ' + e.message); process.exit(2); }
  console.log('✅ 配置能读：' + CONFIG_PATH);
  const pub = publicConfig(cfg);
  for (const c of pub.channels) {
    // 每种通道"该显示什么"不一样：echo 没有端点、dsh 没有模型名 —— 别把 undefined 打给用户看
    const desc = c.kind === 'echo' ? '本地假通道（不联网、不花额度，只用来验证链路）'
      : c.kind === 'dsh' ? `DSH 本体（会干活，profile=${c.profile || 'headless'}）`
      : `${c.baseURL} / ${c.model} / key ${c.apiKey}`;
    console.log(`   通道 ${c.id}（${c.kind}）：${desc}`);
  }
  for (const b of pub.bots) console.log(`   机器人 ${b.id}：通道 ${b.channel}，appId ${b.appId}，secret ${b.appSecret}，群里${b.mentionRequired ? '要 @' : '不用 @'}`);
  if (has('--ping')) {
    const { chat } = await import('./models.mjs');
    for (const ch of cfg.channels.values()) {
      const r = await chat(ch, [{ role: 'user', content: '只回两个字：收到' }], { maxTokens: 32, retries: 0 });
      console.log(r.error ? `   ❌ 通道 ${ch.id} 调用失败：${r.error.message}` : `   ✅ 通道 ${ch.id} 通：${JSON.stringify(r.text)}（${r.ms}ms）`);
    }
  }
  process.exit(0);
}

// ── --status：从面板接口读状态（面板没跑就退出码 1）──
if (has('--status')) {
  const port = Number(val('--port', 0)) || Number(readJson(CONFIG_PATH)?.http?.port) || 7788;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`);
    const s = await r.json();
    console.log(`BotHub 运行 ${Math.round(s.uptimeSec / 60)} 分钟 · 内存 ${s.rssMB} MB · 面板 http://127.0.0.1:${port}/`);
    for (const b of s.bots) {
      console.log(`  ${b.running ? '✅' : '❌'} ${b.id}  通道 ${b.channel}/${b.model}  收到 ${b.messagesIn} 回 ${b.repliesOut} 跳过 ${b.skipped}` +
        `  队列 ${b.queue.busyLanes}处理/${b.queue.queued}排队  最后消息 ${b.lastMessageSecAgo === null ? '—' : b.lastMessageSecAgo + ' 秒前'}` +
        (b.lastError ? `  ⚠️ ${b.lastError}` : ''));
    }
    process.exit(0);
  } catch (e) {
    console.error('❌ 面板接口连不上（应用没在跑？）：' + e.message);
    process.exit(1);
  }
}

// ── 正常启动 ──
if (writeExample()) log.info(`第一次运行，已生成示例配置：${CONFIG_PATH}（编辑好再启动）`);

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  log.error('配置有问题，先修配置再启动：\n' + e.message);
  process.exit(2);
}

// 防双开：同一个人不小心双击两次时，第二次直接退出（免得两个进程抢同一个 QQ 连接）
fs.mkdirSync(DATA, { recursive: true });   // ⚠️ 必须先建目录：第一次运行时读 pid 文件会 ENOENT 直接崩
if (!fs.existsSync(PIDFILE)) fs.writeFileSync(PIDFILE, '0', 'utf8');
const prevPid = Number(fs.readFileSync(PIDFILE, 'utf8').trim()) || 0;
if (prevPid && prevPid !== process.pid) {
  try { process.kill(prevPid, 0); log.error(`已经在跑了（pid ${prevPid}）—— 这次退出，避免两个进程抢同一个机器人连接`); process.exit(3); } catch { /* 旧的没了，正常 */ }
}
fs.writeFileSync(PIDFILE, String(process.pid), 'utf8');
process.on('exit', () => { try { if (Number(fs.readFileSync(PIDFILE, 'utf8').trim()) === process.pid) fs.rmSync(PIDFILE, { force: true }); } catch { /* ignore */ } });

const startedAt = Date.now();
const bots = [];
const byId = new Map();
for (const b of cfg.bots.values()) {
  if (!b.enabled) { log.info(`跳过 ${b.id}（配置里 enabled=false）`); continue; }
  const inst = new BotInstance({ cfg: b, channel: cfg.channels.get(b.channel), log: makeLogger(b.id) });
  bots.push(inst);
  byId.set(b.id, inst);
}

const hub = {
  /**
   * 公开配置（凭据清单、上限、初始机器人…）。
   * ⛔ 界面一直在调 `/api/config`，但服务端以前**没有这个路由**（只有 `/api/config/raw`）——
   *    结果凭据下拉永远是空的（显示「（还没有凭据）」），
   *    「新增机器人时能选初始机器人的初始凭据」这条需求实际上**没生效**。补上它。
   */
  publicConfig() {
    try { return publicConfig(cfg); } catch (e) { return { error: String(e && e.message) }; }
  },
  status() {
    return {
      at: new Date().toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      pid: process.pid,
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      config: cfg.path,
      bots: bots.map((b) => b.status()),
    };
  },
  async restartBot(id) {
    const inst = byId.get(id);
    if (!inst) return { ok: false, error: '没有这个机器人：' + id };
    log.info(`手动重启 ${id}`);
    try { inst.stop(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1000));
    await inst.start();
    return { ok: true };
  },
  /** 假机器人注入（验收测试）：只有 platform=mock 的能用 */
  async injectBot(id, payload) {
    const inst = byId.get(id);
    if (!inst) return { ok: false, error: '没有这个机器人：' + id };
    if (!inst.isMock) return { ok: false, error: `${id} 不是假机器人（platform=${inst.cfg.platform}）—— 真机器人请直接在 QQ 里发消息` };
    const before = inst.outbox.length;
    try {
      const info = await inst.inject(payload || {});
      return { ok: true, ...info, willReply: true, outboxBefore: before };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  },
  outbox(id) {
    const inst = byId.get(id);
    return inst ? inst.outbox : [];
  },
  /** 故障演练：掐断某个机器人的连接，验证它自己能接回来 */
  kickBot(id) {
    const inst = byId.get(id);
    if (!inst) return { ok: false, error: '没有这个机器人：' + id };
    return inst.kick('面板点了「断线重连演练」');
  },
  /** 让机器人主动说一句（验证出站链路 / 手动冒泡） */
  async sayBot(id, payload) {
    const inst = byId.get(id);
    if (!inst) return { ok: false, error: '没有这个机器人：' + id };
    try {
      await inst.say({ scope: payload?.scope || 'group', peerId: payload?.peerId, text: payload?.text });
      // 刚填完凭据 → 立刻把这个机器人拉起来（首次向导"保存并连接"要马上看到效果）
  try {
    const inst = byId.get(id);
    if (inst) { inst.cfg._appId = aid; inst.cfg._appSecret = secret; inst.cfg.credentialsMissing = false; await inst.start(); }
  } catch (e) { log.warn(`保存凭据后拉起机器人失败（不影响已保存）：${e.message}`); }
  return { ok: true, note: '已发出' };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  },

  /**
   * 机器人"资料"：**平台怎么认这个机器人**（名字/头像只能从平台读，改不了）。
   *
   * ★ 常驻显示的三条要求（老板："让机器人资料可以常驻显示"）：
   *   ① **存盘**（`data\profiles.json`）：重启应用、平台一时连不上，界面上照样有头像和名字；
   *   ② 刷新失败**绝不清空**：保留上一次的值并标明"多久前更新的"，而不是变成空白；
   *   ③ 缓存 10 分钟，`?force=1` 才真去问平台（面板上那个「刷新资料」按钮）。
   */
  async botProfile(id, { force = false } = {}) {
    const b = cfg.bots.get(id);
    if (!b) return { ok: false, error: '没有这个机器人：' + id };
    const cached = profileStore[id];
    const fresh = cached && (Date.now() - cached.at) < 10 * 60 * 1000;
    if (cached && fresh && !force) return { ok: true, ...cached.value, cachedAt: cached.at, fromCache: true };

    if (b.platform === 'mock') {
      const value = { platformName: '（假机器人，没连平台）', avatar: null, appIdMasked: mask(b._appId), alias: b.alias, readOnlyNote: '名字和头像由平台决定，这里改不了' };
      profileStore[id] = { at: Date.now(), value }; saveProfiles();
      return { ok: true, ...value, cachedAt: profileStore[id].at };
    }

    try {
      const tr = await (await fetch('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: b._appId, clientSecret: b._appSecret }),
      })).json();
      if (!tr.access_token) throw new Error('换 token 失败');
      const me = await (await fetch('https://api.sgroup.qq.com/users/@me', {
        headers: { authorization: `QQBot ${tr.access_token}` },
      })).json();
      /**
       * 老板要的「默认机器人的名字/头像跟现在这个一致」：
       * 别名还是占位名（`我的机器人` / 等于 id）时，**自动采用平台上的名字**。
       * 头像是平台给的，面板本来就跟着走；这里只动本地显示名，不动平台、也不覆盖用户自己填过的别名。
       */
      try {
        const inst = byId.get(id);
        if (inst && inst.maybeAdoptPlatformName(me.username)) {
          b.alias = inst.cfg.alias;
          const rawBot = cfg.raw.bots.find((x) => x.id === id);
          if (rawBot && rawBot.alias !== inst.cfg.alias) { rawBot.alias = inst.cfg.alias; try { saveConfigText(JSON.stringify(cfg.raw, null, 2)); } catch { /* 存不上只影响下次启动 */ } }
        }
      } catch { /* 改名失败不影响资料显示 */ }
      const value = {
        platformName: me.username || '（平台没返回名字）',
        avatar: me.avatar || null,
        shareUrl: me.share_url || null,
        appIdMasked: mask(b._appId),
        appIdShown: lightMask(b._appId),   // appId 不是秘密，界面上要能认出是哪一个
        secretMasked: mask(b._appSecret),
        alias: b.alias,
        credentialsFrom: (cfg.raw.bots.find((x) => x.id === id)?.credentials?.appSecret) || '（未填）',
        readOnlyNote: 'QQ 机器人的名字和头像在「QQ 开放平台」控制台里设置 —— 官方接口只提供读取，没有修改接口。',
        consoleUrl: 'https://bot.q.qq.com/',
      };
      profileStore[id] = { at: Date.now(), value };
      saveProfiles();
      return { ok: true, ...value, cachedAt: profileStore[id].at };
    } catch (e) {
      // 刷新失败：有旧的就用旧的（并说明是旧的），没有才报错 —— 界面上不该因为一次网络抖动就变空白
      if (cached) return { ok: true, ...cached.value, cachedAt: cached.at, stale: true, refreshError: String(e && e.message) };
      return { ok: false, error: '读不到平台资料：' + (e && e.message) };
    }
  },

  /**
   * 设置 / 轮换凭据（appId / appSecret）。
   *
   * 安全规矩（privacy-guard）：
   *   · 值从浏览器 POST 进来，**直接写进 config\secrets.json**，全程不打印、不回显、不进日志；
   *   · 改配置里的引用（`${SECRET:<id>.appSecret}`），**不把明文写进 bots.json**；
   *   · **先验证再落盘**：拿新凭据去换一次 access_token，换不到就**两个文件都回滚**（实测过的路径）；
   *   · 成功后才重启这个机器人让它用上新凭据。
   */
  async setCredentials(id, input) {
    const b = cfg.bots.get(id);
    if (!b) return { ok: false, error: '没有这个机器人：' + id };
    const appId = String(input?.appId || '').trim() || b._appId;
    /**
     * `useCurrent: true` = 把**现在正在用的**凭据搬进 BotHub 自己的密钥库
     * （以后不再依赖 DSH 的配置；也让"首次接管凭据"这件事不需要任何人在界面上重新粘贴一遍）。
     */
    const appSecret = input?.useCurrent ? b._appSecret : String(input?.appSecret || '').trim();
    if (!appSecret) return { ok: false, error: 'appSecret 没填（它是必填的）' };

    // ① 先用新凭据验证能不能换到 token（这一步不落盘）
    let verify;
    try {
      const r = await fetch('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
      });
      verify = await r.json();
    } catch (e) {
      return { ok: false, error: '连不上 QQ 的鉴权接口：' + (e && e.message) };
    }
    if (!verify.access_token) {
      return { ok: false, error: `这对 appId/appSecret 换不到 token（平台返回 ${JSON.stringify(Object.keys(verify))}）—— 没有改动任何文件。` };
    }

    // ② 落盘：先备份两个文件
    const secretsPath = SECRETS_PATH;
    const cfgPath = cfg.path;
    const bak = (p) => { try { fs.copyFileSync(p, p + '.bak'); } catch { /* 可能还没有 */ } };
    bak(secretsPath); bak(cfgPath);
    try {
      writeBotHubSecret(id, { appId, appSecret });
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const rb = raw.bots.find((x) => x.id === id);
      if (!rb) throw new Error('配置里找不到这个机器人');
      rb.credentials = { appId: `\${SECRET:${id}.appId}`, appSecret: `\${SECRET:${id}.appSecret}` };
      fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8');
      loadConfig();   // 再校验一遍（引用能不能解析）
    } catch (e) {
      // ③ 出问题就回滚
      for (const p of [secretsPath, cfgPath]) { try { if (fs.existsSync(p + '.bak')) fs.copyFileSync(p + '.bak', p); } catch { /* ignore */ } }
      loadConfig();
      return { ok: false, error: '写入失败，已回滚到原来的凭据：' + (e && e.message) };
    }

    // ④ 让改动真正生效：**整体重启应用**（不是只重启机器人）
    /**
     * 为什么不只重启机器人：机器人的凭据是**加载配置时解析好的**，实例里那个 cfg 对象还指着旧引用。
     * 只重启 bot 虽然"现在能用"（新旧引用指向同一个密钥），但面板显示、内存状态会和磁盘不一致 ——
     * 这种"看起来对了其实没生效"的状态最容易骗人。整体退出让守护进程拉起来，一切从磁盘重新读。
     */
    delete profileStore[id]; saveProfiles();
    hostCache = null;
    log.info('凭据已更新并通过验证 —— 应用将在 1 秒后重启，让新引用生效');
    setTimeout(() => process.exit(0), 1000);
    return { ok: true, note: '凭据已验证并保存（明文只在 config\\secrets.json，bots.json 里只留引用）。应用正在重启（几秒），这个页面刷新一下就好。' };
  },
  // ─────────────────────────────────────────────────────────────
  //  新增机器人 / 新增凭证（老板要求：面板上能自己加，不用手改 JSON）
  // ─────────────────────────────────────────────────────────────

  /**
   * 新增一个**空白机器人**：id + 用哪条通道 + 用哪条凭证（可选，空着就等填）。
   * `kind` 支持三种（老板要的"自主选择连 DSH / 云端 / 本地"）：
   *   · dsh   → 复用/新建一条 `dsh-local` 通道（会干活）
   *   · cloud → 新建一条 openai 通道（要 baseURL/model/key）
   *   · local → 同上，但默认指向本机推理服务（Ollama / LM Studio 那类兼容接口）
   */
  async addBot(input) {
    /**
     * 老板的规则：一个凭据挂满 4 个（**初始机器人不算**）之后，就不能再用它建新机器人。
     * 先在门口拦住并说清楚，别让用户填完一屏才看到"配置有问题"。
     */
    {
      let rawNow = null;
      try { rawNow = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { rawNow = null; }
      if (rawNow && Array.isArray(rawNow.bots) && rawNow.bots.length) {
        const initialId = String(rawNow.bots[0].id || '');
        const wantCred = (input && input.credential) ? String(input.credential) : ('implicit-' + initialId);
        const used = rawNow.bots.filter((b) => (b.credential || ('implicit-' + initialId)) === wantCred && b.id !== initialId).length;
        const cap = 4;
        if (used >= cap) {
          return { ok: false, error: `凭据 ${wantCred} 已经满了（${used}/${cap}，初始机器人不算）—— 先点「+ 新增凭证」，再用新凭据建机器人` };
        }
      }
    }
    const id = String(input?.id || '').trim();
    if (!/^[a-zA-Z0-9._-]{2,32}$/.test(id)) return { ok: false, error: '机器人 id 只能用字母数字和 . _ -（2~32 位）' };
    if (cfg.bots.has(id)) return { ok: false, error: `已经有叫 ${id} 的机器人了` };
    const kind = String(input?.kind || 'dsh');
    const raw = JSON.parse(fs.readFileSync(cfg.path, 'utf8'));
    raw.channels = raw.channels || [];
    raw.bots = raw.bots || [];

    // 挑/建通道
    let channelId = input?.channel || null;
    if (!channelId) {
      if (kind === 'dsh') {
        const exist = raw.channels.find((c) => c.kind === 'dsh');
        channelId = exist ? exist.id : 'dsh-local';
        if (!exist) raw.channels.push({ id: 'dsh-local', kind: 'dsh', profile: input?.profile || 'headless', timeoutMs: 240000 });
      } else if (kind === 'local') {
        channelId = `${id}-local`;
        raw.channels.push({
          id: channelId, kind: 'openai',
          baseURL: String(input?.baseURL || 'http://127.0.0.1:11434/v1'),
          apiKey: String(input?.apiKey || '${ENV:LOCAL_API_KEY}'),
          model: String(input?.model || 'qwen2.5:7b'),
          maxTokens: 2048, temperature: 0.7,
        });
      } else {
        channelId = `${id}-cloud`;
        raw.channels.push({
          id: channelId, kind: 'openai',
          baseURL: String(input?.baseURL || 'https://api.openai.com/v1'),
          apiKey: String(input?.apiKey || '${ENV:OPENAI_API_KEY}'),
          model: String(input?.model || 'gpt-4o-mini'),
          maxTokens: 2048, temperature: 0.7,
        });
      }
    }

    const bot = {
      id,
      alias: String(input?.alias || '').trim() || id,
      enabled: input?.enabled !== false,
      platform: String(input?.platform || 'qq'),
      channel: channelId,
      mentionRequired: input?.mentionRequired !== false,
      persona: String(input?.persona || ''),
      permission: input?.permission || 'workspace-write',
      commands: [{ name: '/状态', desc: '看它还活着吗', action: 'status' }],
      limits: { perPeerPerMin: 8 },
    };
    if (input?.credential) bot.credential = input.credential;

    // 校验：一个凭证最多 4 个（先把候选配置算出来，validate 会拦）
    if (bot.credential) {
      const same = raw.bots.filter((b) => b.credential === bot.credential).length;
      if (same >= 4) return { ok: false, error: `凭证 ${bot.credential} 已经有 4 个机器人了（一个凭证最多 4 个）—— 请先「+ 新增凭证」` };
    }
    raw.bots.push(bot);
    /**
     * ⛔ `saveConfigText` 是**返回** `{ ok:false, error }` 而不是抛异常 ——
     *    我第一次没看返回值，于是"接口回 ok、盘上什么都没写"（新机器人根本不出现）。
     *    凡是要落盘的地方，判据必须是**返回值**，不是"我调用了保存"。
     */
    const saved = saveConfigText(JSON.stringify(raw, null, 2));
    if (!saved.ok) {
      log.warn(`新增机器人 ${id} 被配置校验拦下：${String(saved.error).slice(0, 200)}`);
      return { ok: false, error: '配置校验没过，没有写入：\n' + saved.error };
    }
    loadConfig();
    log.info(`新增机器人 ${id}（通道 ${channelId}${bot.credential ? '，凭证 ' + bot.credential : ''}）`);
    setTimeout(() => process.exit(0), 800);   // 让守护拉起来，一切从磁盘重读
    return { ok: true, note: `已经加好机器人 ${id}（通道 ${channelId}）。应用正在重启，几秒后刷新页面就能看到它。` };
  },

  /** 新增一条**空白凭证**（只有名字；appId/appSecret 用「保存并验证」填，填之前不会有任何明文） */
  async addCredential(input) {
    const id = String(input?.id || '').trim() || `cred-${Date.now().toString(36)}`;
    if (!/^[a-zA-Z0-9._-]{2,32}$/.test(id)) return { ok: false, error: '凭证 id 只能用字母数字和 . _ -（2~32 位）' };
    const raw = JSON.parse(fs.readFileSync(cfg.path, 'utf8'));
    raw.credentials = raw.credentials || [];
    if (raw.credentials.some((c) => c.id === id)) return { ok: false, error: `已经有叫 ${id} 的凭证了` };
    raw.credentials.push({ id, label: String(input?.label || '').trim() || id });
    const saved = saveConfigText(JSON.stringify(raw, null, 2));
    if (!saved.ok) return { ok: false, error: '配置校验没过，没有写入：\n' + saved.error };
    loadConfig();
    log.info(`新增凭证 ${id}`);
    return { ok: true, note: `凭证 ${id} 建好了 —— 把它的 appId / appSecret 填上再点「保存并验证」。` };
  },

  /** 保存某条凭证的 appId/appSecret（先真换一次 token，换不到不落盘；明文只进 secrets.json） */
  async saveCredentialValues(credId, input) {
    const raw = JSON.parse(fs.readFileSync(cfg.path, 'utf8'));
    raw.credentials = raw.credentials || [];
    const cred = raw.credentials.find((c) => c.id === credId);
    if (!cred) return { ok: false, error: '没有这条凭证：' + credId };
    const appId = String(input?.appId || '').trim();
    const appSecret = String(input?.appSecret || '').trim();
    if (!appId || !appSecret) return { ok: false, error: 'appId 和 appSecret 都要填' };
    try {
      const r = await fetch('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
      });
      const v = await r.json();
      if (!v.access_token) return { ok: false, error: `这对 appId/appSecret 换不到 token（平台返回 ${JSON.stringify(Object.keys(v))}）—— 没有改动任何文件` };
    } catch (e) { return { ok: false, error: '连不上 QQ 鉴权接口：' + (e && e.message) }; }

    const bak = (f) => { try { fs.copyFileSync(f, f + '.bak'); } catch { /* ignore */ } };
    bak(SECRETS_PATH); bak(cfg.path);
    try {
      writeBotHubSecret(credId, { appId, appSecret });
      const raw2 = JSON.parse(fs.readFileSync(cfg.path, 'utf8'));
      const c2 = (raw2.credentials || []).find((c) => c.id === credId);
      if (!c2) throw new Error('配置里找不到这条凭证');
      c2.appId = '${SECRET:' + credId + '.appId}';
      c2.appSecret = '${SECRET:' + credId + '.appSecret}';
      fs.writeFileSync(cfg.path, JSON.stringify(raw2, null, 2), 'utf8');
      loadConfig();
    } catch (e) {
      for (const f of [SECRETS_PATH, cfg.path]) { try { if (fs.existsSync(f + '.bak')) fs.copyFileSync(f + '.bak', f); } catch { /* ignore */ } }
      loadConfig();
      return { ok: false, error: '写入失败，已回滚：' + (e && e.message) };
    }
    hostCache = null;
    log.info(`凭证 ${credId} 已更新并通过验证 —— 应用 1 秒后重启`);
    setTimeout(() => process.exit(0), 1000);
    return { ok: true, note: '凭证已验证并保存（明文只在 config\\secrets.json）。应用正在重启，刷新页面即可。' };
  },
  /**
   * ── 面板偏好（目前只有颜色模式）──
   *   · 存哪儿：`config/local.json`（本机专用、不进发布包、不进 git）
   *   · 「跟随 DSH」= 读 **DSH 自己的主题设置**：`profiles/desktop/cordis.patch.yml` 里
   *     `ui-theme.config.preference`（那正是老板在 DSH 界面里选的主题）。
   *     读不到就返回 null，前端退回系统偏好。
   */
  getPrefs: () => {
    // ⚠️ main.mjs 里**没有 ROOT**（只有 CONFIG_PATH/DATA 这些）—— 第一次写成 ROOT 直接报
    //    `ROOT is not defined`。配置目录就从 CONFIG_PATH 推。
    const local = readJson(path.join(path.dirname(CONFIG_PATH), 'local.json'), {}) || {};
    let dshTheme = null;
    try {
      const home = dshHomePath();
      for (const prof of ['desktop', 'headless']) {
        const f = path.join(home, 'profiles', prof, 'cordis.patch.yml');
        if (!fs.existsSync(f)) continue;
        const txt = fs.readFileSync(f, 'utf8');
        const i = txt.indexOf('ui-theme');
        if (i < 0) continue;
        const seg = txt.slice(i, i + 400);
        const m = /preference:\s*([a-zA-Z]+)/.exec(seg);
        if (m && ['dark', 'light'].includes(m[1].toLowerCase())) { dshTheme = m[1].toLowerCase(); break; }
      }
    } catch { /* 读不到就算了 */ }
    return { ok: true, theme: local.uiTheme || null, dshTheme, fontSize: local.uiFontSize || 'normal' };
  },

  /** 存颜色模式（写进 config\\local.json；失败只影响"下次打开"，不当成错误） */
  setPrefs: (input) => {
    /**
     * 全局字体大小：四档，存 `config/local.json`（跟颜色模式一起）。
     * 前端把它写成 `--fs`，其余字号都是相对 em → 一改全站跟着变。
     */
    const FONT_SIZES = { small: '13.5px', normal: '14.5px', large: '16px', xlarge: '17.5px' };
    const size = String(input?.fontSize || '');
    if (size && !FONT_SIZES[size]) return { ok: false, error: '不认识的字体大小：' + size };
    const theme = String(input?.theme || '');
    if (theme && !['light', 'dark', 'dsh'].includes(theme)) return { ok: false, error: '不认识的颜色模式：' + theme };
    const file = path.join(path.dirname(CONFIG_PATH), 'local.json');
    const local = readJson(file, {}) || {};
    if (theme) local.uiTheme = theme;
    if (size) local.uiFontSize = size;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(local, null, 2), 'utf8'); }
    catch (e) { return { ok: false, error: '存不上：' + e.message }; }
    return { ok: true, theme: local.uiTheme || null, fontSize: local.uiFontSize || 'normal' };
  },
  configPath: () => cfg.path,
  configText: () => readConfigText(),
  saveConfig: (text) => saveConfigText(text),
  /**
   * 系统层全貌（面板顶部那张卡）。
   *
   * 为什么要有：老板要"不用双击任何东西就能看全貌"。这里把原本只有体检脚本才查的东西
   * （守护进程数量、计划任务状态、到 QQ 网关的连接数、心跳新鲜度）也搬到面板上。
   *
   * ⚠️ 这些要起 PowerShell 去问系统，**一次几百毫秒** —— 所以**缓存 20 秒**，
   *    别让 5 秒一刷的面板把机器拖住。
   */
  async hostInfo() {
    const now = Date.now();
    if (hostCache && now - hostCache.at < 20000) return hostCache.value;
    const ps = (script) => new Promise((resolve) => {
      execFile(PWSH, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${script}`],
        { timeout: 20000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 << 20 },
        (err, stdout) => resolve(err ? null : String(stdout || '').trim()));
    });

    const procRaw = await ps(`
      @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -notlike '*dsh-subprocess*' } |
        ForEach-Object {
          $c = [string]$_.CommandLine
          $kind = if ($c -like '*bothub-supervisor.mjs*' -and $c -notlike '*start-bothub-supervisor*') { 'supervisor' }
                  elseif ($c -like '*main.mjs*') { 'app' } else { 'other' }
          [pscustomobject]@{ pid=[int]$_.ProcessId; kind=$kind }
        }) | ConvertTo-Json -Compress
    `);
    let procs = [];
    try { procs = JSON.parse(procRaw || '[]'); } catch { /* ignore */ }
    const sups = procs.filter((p) => p.kind === 'supervisor');
    const apps = procs.filter((p) => p.kind === 'app');

    const tasks = [];
    /**
     * 2026-10-15 改：旧机器人任务 `DSH-QQBot` 已经退役（搬去了 `_retired`），
     * 这里不该再列它 —— 面板上显示个"不存在"只会让人以为哪里坏了。
     * 现在看这三个：登录自启 / 每分钟兜底 / 看护自身。
     */
    for (const name of ['DSH-BotHub', 'DSH-BotHub-Ensure', 'DSH-BotHub-Supervisor']) {
      const out = await ps(`schtasks /query /tn "${name}" /fo LIST 2>$null | Out-String`);
      const status = out ? ((/Status:\s*(\S+)/i.exec(out) || [])[1] || '?') : '不存在';
      const lastResult = out ? ((/Last Result:\s*(-?\d+)/i.exec(out) || [])[1] || null) : null;
      tasks.push({ name, status, lastResult });
    }

    let qqConn = 0;
    if (apps.length === 1) {
      /**
       * 判据是**动态解析域名**，不是写死 IP 段。
       * 写死过一次（只认 101.91.* / 58.217.*），结果实际连的是 61.151.231.145 →
       * 面板/体检报"没有到 QQ 网关的连接"**假警报**。假警报比漏报更坏：喊多了真出事没人看。
       */
      const ipsRaw = await ps(`(Resolve-DnsName api.sgroup.qq.com -ErrorAction SilentlyContinue).IPAddress -join ','`);
      const ips = String(ipsRaw || '').split(',').map((s) => s.trim()).filter(Boolean);
      const match = ips.length
        ? ips.map((ip) => `$_.RemoteAddress -eq '${ip}'`).join(' -or ')
        : `$_.RemoteAddress -like '101.91.*' -or $_.RemoteAddress -like '58.217.*' -or $_.RemoteAddress -like '61.151.*'`;
      const n = await ps(`@(Get-NetTCPConnection -OwningProcess ${apps[0].pid} -State Established -ErrorAction SilentlyContinue |
        Where-Object { $_.RemotePort -eq 443 -and (${match}) }).Count`);
      qqConn = Number(n || 0);
    }

    const hb = readJson(HEARTBEAT);
    const lastInbound = bots.reduce((mx, b) => Math.max(mx, b.stats.lastMessageAt || 0), 0);
    /**
     * 提醒分两级（2026-10-15 修）：`info` 只是"说明"，`warn` 才是"要处理"。
     * 为什么改：第一版把所有提醒一视同仁，结果"还没收到过任何消息"（完全正常）
     * 也让面板顶部变成橙点"有需要注意的地方" —— **假警报会让真警报没人看**。
     */
    const notes = [];
    const note = (level, text) => notes.push({ level, text });
    if (sups.length === 0) note('warn', '没有守护进程：应用崩了不会自己起来。双击 start-supervisor.cmd 补一个。');
    if (sups.length > 1) note('warn', `守护进程有 ${sups.length} 个（应该只有 1 个）：跑 tools\\drill-recovery.mjs 可以清干净。`);
    if (apps.length > 1) note('warn', `应用起了 ${apps.length} 个：同一个 QQ appId 不能两个进程同时连，会互相抢事件。`);
    if (qqConn === 0 && apps.length) note('info', '此刻没有到 QQ 网关的连接：可能正在重连（刚启动或刚演练完的十几秒内属正常），几秒后会自动恢复。');
    // 旧任务如果**又出现**了才提醒（说明退役没做干净，它会跟 BotHub 抢同一个 QQ 连接）
    const stale = await ps('schtasks /query /tn "DSH-QQBot" /fo LIST 2>$null | Out-String');
    if (stale) note('warn', '发现旧任务 DSH-QQBot —— 它一起来就会跟 BotHub 抢同一个 QQ 连接（表现是"时好时坏"）。建议删掉：schtasks /Delete /TN "DSH-QQBot" /F');
    if (!lastInbound && apps.length) note('info', '还没收到过消息。群里要 @ 它、私聊不用；发一条就能看到从收到到回复的全过程。');
    else if (lastInbound && Date.now() - lastInbound > 6 * 3600 * 1000) note('info', `已经 ${Math.round((Date.now() - lastInbound) / 3600000)} 小时没收到消息了（只是提醒，不代表坏了）。`);

    const value = {
      at: new Date().toISOString(),
      app: { pid: process.pid, uptimeSec: Math.round((Date.now() - startedAt) / 1000), rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024), heartbeatAgeSec: hb && hb.at ? Math.round((Date.now() - hb.at) / 1000) : null },
      appCount: apps.length, appPids: apps.map((p) => p.pid),
      supervisor: { count: sups.length, pids: sups.map((p) => p.pid) },
      tasks, qqConn,
      lastInboundSecAgo: lastInbound ? Math.round((Date.now() - lastInbound) / 1000) : null,
      configPath: cfg.path,
      panelUrl: `http://${cfg.http.host}:${cfg.http.port}/`,
      notes,
    };
    hostCache = { at: Date.now(), value };
    return value;
  },
  /**
   * 维护：会话上下文 + 后台内存 + 数据占用（老板要求"能对会话上下文、后台内存做清理压缩"）。
   */
  maintenance: () => {
    const mu = process.memoryUsage();
    const dirSize = (p) => {
      let total = 0, files = 0;
      const walk = (d) => {
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f);
          else { try { total += fs.statSync(f).size; files++; } catch { /* ignore */ } }
        }
      };
      walk(p);
      return { bytes: total, files };
    };
    /**
     * 目录大小要遍历成千上万个文件（浏览器 profile 有 450 MB）—— **缓存 60 秒**，
     * 否则面板每次刷新（5 秒一次）都在狂读磁盘。
     */
    if (!maintenance_.dirCache || Date.now() - maintenance_.dirCache.at > 60000) {
      maintenance_.dirCache = {
        at: Date.now(),
        logs: dirSize(path.join(DATA, 'logs')),
        sessions: dirSize(path.join(DATA, 'sessions')),
        edge: dirSize(path.join(DATA, 'edge-profile')),
      };
    }
    const perBot = [];
    for (const [id] of cfg.bots) {
      const st0 = storeOf(id);
      const o = st0 ? st0.overview(id) : { peers: [], totalLines: 0, totalBytes: 0, keepTurns: 0 };
      perBot.push({
        bot: id, peers: o.peers.length, lines: o.totalLines, bytes: o.totalBytes, keepTurns: o.keepTurns,
        top: o.peers.slice(0, 5).map((p) => ({ peer: p.file.replace(/\.jsonl$/, ''), lines: p.lines, bytes: p.bytes })),
      });
    }
    const logs = maintenance_.dirCache.logs;
    const sessAll = maintenance_.dirCache.sessions;
    const edge = maintenance_.dirCache.edge;
    return {
      memory: {
        rssMB: Math.round(mu.rss / 1048576), heapUsedMB: Math.round(mu.heapUsed / 1048576),
        heapTotalMB: Math.round(mu.heapTotal / 1048576), externalMB: Math.round(mu.external / 1048576),
        uptimeSec: Math.round(process.uptime()), gcAvailable: typeof global.gc === 'function', pid: process.pid,
      },
      sessions: { perBot, bytes: sessAll.bytes, files: sessAll.files },
      data: { logsBytes: logs.bytes, logsFiles: logs.files, edgeBytes: edge.bytes },
    };
  },

  /**
   * 释放内存：① 主动 GC（要 `--expose-gc` 启动，守护进程已经带上）② 丢掉内部缓存。
   * 不重启进程 —— 重启是右上角那个按钮，两件事分开。
   */
  gc: () => {
    const before = process.memoryUsage();
    hostCache = null;
    let ran = false;
    if (typeof global.gc === 'function') { global.gc(); global.gc(); ran = true; }
    const after = process.memoryUsage();
    return {
      ok: true, ran,
      beforeMB: Math.round(before.rss / 1048576), afterMB: Math.round(after.rss / 1048576),
      heapBeforeMB: Math.round(before.heapUsed / 1048576), heapAfterMB: Math.round(after.heapUsed / 1048576),
      note: ran ? '已主动回收' : '这次启动没带 --expose-gc（重启应用后会带上）',
    };
  },

  /**
   * 这个机器人能选哪些模型（老板："模型要像 DSH 对话框里那样能手动选"）：
   *   · dsh 通道 → 读 DSH 该 profile 的供应商/模型清单（**他装了什么插件、有什么免费模型，这里就有什么**）
   *   · openai 通道 → 问一下 `{baseURL}/models`（OpenAI 兼容接口）
   * 结果缓存 10 分钟（dump-config 要一两秒）。
   */
  listModels: async (id) => {
    if (!id) id = [...cfg.bots.keys()][0];        // 不传就用第一个机器人
    const b = cfg.bots.get(id);
    if (!b) return { ok: false, error: '没有这个机器人：' + id };
    if (models_.cache && Date.now() - models_.cache.at < (models_.cache.ttl || 600000) && models_.cache.bot === id) {
      return { ok: true, ...models_.cache.value, fromCache: true };
    }
    const out = { bot: id, channel: b.channel, channelKind: b.channelKind, current: b.model || null, providers: [], openai: null };
    const ch = cfg.channels.get(b.channel) || {};
    // ① 这台电脑上 DSH 能用的模型（所有 profile 合并）—— 永远带上
    const inv = await dshModelInventory(ch.dshExe);
    out.providers = inv.providers;
    out.profiles = inv.profiles;
    if (inv.skippedProfiles.length) out.skippedProfiles = inv.skippedProfiles;
    if (inv.patchedProfiles.length) out.patchedProfiles = inv.patchedProfiles;
    // ② 如果这个机器人用的是云端模型通道，再问一下它自己的 /models
    if ((ch.kind || '') === 'openai' && ch.baseURL) {
      try {
        const key = ch._key || '';
        const res = await fetch(ch.baseURL.replace(/\/$/, '') + '/models', { headers: key ? { authorization: 'Bearer ' + key } : {} });
        const j = await res.json();
        out.openai = { channel: ch.id, baseURL: ch.baseURL, models: (j.data || []).map((m) => m.id).filter(Boolean).slice(0, 300) };
      } catch (e) { out.error = '问不到模型清单：' + (e && e.message); }
    }
    /**
     * ⛔ **失败的结果不许缓存**（2026-10-15 修）。
     *    病根：云端 `/models` 偶尔会因为限流/网络抖一下而失败 → 那次的 `out`（只有 DSH 那几个模型）
     *    被当成正常结果缓存 10 分钟 → 面板下拉**从 178 个变成 2 个**，10 分钟后才自己好。
     *    现在：有 error 就只缓存 30 秒（让它很快有机会重试），正常结果才缓存 10 分钟。
     */
    const okToCacheLong = !out.error;
    models_.cache = { at: Date.now(), bot: id, value: out, ttl: okToCacheLong ? 600000 : 30000 };
    return { ok: true, ...out };
  },
  /** 压缩会话：保留最近 keepTurns 轮，更早的压成一行摘要；`useModel` 时用模型总结旧历史 */
  /**
   * 压缩会话。**可以选机器人**（老板要的"维护的是哪个机器人要能选"）：
   *   `bots: ['a','b']` 只压这几个；`bots: []` / 不传 = 全部。
   */
  compactSessions: async ({ bot = null, bots = null, keepTurns = 6, useModel = false } = {}) => {
    const ids = (Array.isArray(bots) && bots.length) ? bots.filter((x) => cfg.bots.has(x)) : (bot ? [bot] : [...cfg.bots.keys()]);
    const results = [];
    for (const id of ids) {
      const st = storeOf(id);
      if (!st) { results.push({ bot: id, peer: '-', saved: 0, note: '这个机器人没在跑，跳过' }); continue; }
      const o = st.overview(id);
      for (const p of o.peers) {
        const file = p.file;
        /**
         * ⛔ 别用 `^[a-z]+__` 这种正则拆文件名：`c2c__` 里的 **2 是数字**，
         *    `[a-z]+` 匹配不到 → peer 变成 `c2c__demo` → 去读一个不存在的文件 → 永远"没什么可压的"。
         *    （实测踩到：诊断日志打出 peer=c2c__demo、readAll=0，而文件明明有 30 条。）
         */
        const [scope, ...restName] = file.split('__');
        const peer = restName.join('__').replace(/\.jsonl$/, '');
        if (!useModel) {
          const r = st.compact(id, scope, peer, keepTurns);
          if (r.saved > 0) results.push({ bot: id, peer: file, ...r });
          continue;
        }
        const inst = byId.get(id);
        const all = st.readAll(id, scope, peer);
        const keep = Math.max(2, keepTurns * 2);
        if (all.length <= keep || !inst) {
          const r = st.compact(id, scope, peer, keepTurns);
          if (r.saved > 0) results.push({ bot: id, peer: file, ...r, fellBack: true });
          continue;
        }
        const oldTxt = all.slice(0, all.length - keep)
          .map((i) => `${i.role === 'assistant' ? '我' : '对方'}: ${i.text}`).join('\n').slice(0, 6000);
        let summary = null;
        try {
          const r = await inst.summarize(oldTxt);
          summary = r && r.text ? String(r.text).trim().slice(0, 1200) : null;
        } catch (e) { log.warn(`智能总结失败，退回结构化压缩：${e && e.message}`); }
        const recent = all.slice(-keep);
        const items = [{
          role: 'user', at: (all[0] && all[0].at) || Date.now(), digest: true,
          text: summary ? `（更早的 ${all.length - keep} 条对话的摘要）${summary}` : `（更早的 ${all.length - keep} 条对话已压缩）`,
        }, ...recent];
        st.rewrite(id, scope, peer, items);
        results.push({ bot: id, peer: file, before: all.length, after: items.length, saved: all.length - items.length, byModel: !!summary });
      }
    }
    const saved = results.reduce((n, r) => n + (r.saved || 0), 0);
    return { ok: true, results, saved, note: saved ? `压缩了 ${results.length} 个对话，共省下 ${saved} 条` : '已经是最近的样子，没什么可压的' };
  },

  /** 清空会话（一个对话 / 一个机器人 / 全部）—— 不可撤销 */
  /** 清空会话。跟压缩一样支持多选：ots: ['a','b'] */
  clearSessions: ({ bot = null, bots = null, peerFile = null } = {}) => {
    const ids = (Array.isArray(bots) && bots.length) ? bots.filter((x) => cfg.bots.has(x)) : (bot ? [bot] : [...cfg.bots.keys()]);
    let n = 0;
    for (const id of ids) { const st = storeOf(id); if (st) n += st.clear(id, peerFile); }
    return { ok: true, removed: n, note: `清掉了 ${ids.length} 个机器人 / ${n} 个对话的历史` };
  },

  /** 清理日志：删掉 N 天前的日志文件 */
  pruneLogs: ({ days = 7 } = {}) => {
    const dir = path.join(DATA, 'logs');
    const cut = Date.now() - days * 86400000;
    let freed = 0, removed = 0, ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* ignore */ }
    for (const e of ents) {
      if (!e.isFile()) continue;
      const f = path.join(dir, e.name);
      try {
        const st = fs.statSync(f);
        if (st.mtimeMs < cut) { fs.rmSync(f, { force: true }); freed += st.size; removed++; }
      } catch { /* ignore */ }
    }
    maintenance_.dirCache = null;
    return { ok: true, removed, freedKB: Math.round(freed / 1024), note: `删了 ${removed} 个超过 ${days} 天的日志，省 ${Math.round(freed / 1024)} KB` };
  },

  /** 清理应用窗口的浏览器缓存（**只动 BotHub 自己的 profile**，不碰你平时用的浏览器） */
  clearBrowserCache: () => {
    const base = path.join(DATA, 'edge-profile');
    const targets = ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache', 'DawnGraphiteCache', 'DawnWebGPUCache'];
    let freed = 0, removed = 0;
    for (const t of targets) {
      const d = path.join(base, t);
      let size = 0;
      const walk = (p) => {
        let ents = [];
        try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const f = path.join(p, e.name);
          if (e.isDirectory()) walk(f);
          else { try { size += fs.statSync(f).size; } catch { /* ignore */ } }
        }
      };
      walk(d);
      try { fs.rmSync(d, { recursive: true, force: true }); freed += size; removed++; } catch { /* ignore */ }
    }
    maintenance_.dirCache = null;
    return { ok: true, removed, freedMB: Math.round(freed / 1048576), note: `清掉 ${removed} 个缓存目录，省 ${Math.round(freed / 1048576)} MB（登录态不动）` };
  },

  /** 面板/托盘/停止脚本用：把该压的会话压一遍（幂等，压过的不动） */
  compactAll: () => {
    const done = compactAllSessions();
    return { ok: true, compressed: done.length, detail: done };
  },
  restartApp: () => {
    log.info('面板点了「重启应用」—— 主动退出，等守护进程拉起');
    setTimeout(() => process.exit(0), 100);
  },
};

/**
 * 把"同一个凭证下的多个机器人"接起来：**连接者**收到消息后按白名单分流给其他机器人
 * （老板要的"一个凭证配 4 个机器人"）。
 *
 * 分流规则：
 *   ① 谁的白名单里明确列了这个群/这个人 → 交给谁（其余机器人不看这条）；
 *   ② 没人匹配 → **连接者自己处理**（默认机器人兜底）。
 * 为什么不做"平均分"：老板要的是"4 个机器人各管各的群"，猜来猜去会串味。
 * 为什么必须由连接者转交：一个 appId 只能有一条连接（两条 = 抢事件）。
 */
function wireCredentialRouting() {
  const groups = new Map();   // 凭证 id → { connector, others: [] }
  for (const inst of byId.values()) {
    const cid = inst.cfg.credential;
    if (!cid) continue;
    const g = groups.get(cid) || { connector: null, others: [] };
    if (inst.cfg.isConnector) g.connector = inst; else g.others.push(inst);
    groups.set(cid, g);
  }
  let wired = 0;
  for (const [cid, g] of groups) {
    if (!g.connector || !g.others.length) continue;
    const c = g.connector;
    c.route = (msg, info) => {
      for (const other of g.others) {
        const list = info.scope === 'group' ? (other.cfg.groupAllow || []) : (other.cfg.c2cAllow || []);
        if (list.includes(info.peerId)) {
          c.log.info('分流：' + info.scope + ':' + info.peerId + ' → ' + other.cfg.id);
          other.deliver(msg);
          return true;
        }
      }
      return false;   // 没人认领 → 连接者自己处理
    };
    wired++;
    log.info('凭证 ' + cid + '：' + c.cfg.id + ' 是连接者，另 ' + g.others.length + ' 个（' +
      g.others.map((x) => x.cfg.id).join('、') + '）靠白名单分流');
  }
  return wired;
}

for (const b of bots) await b.start();

// 接上"同凭证分流"（连接者转交，其余机器人不自己连）
try { wireCredentialRouting(); } catch (e) { log.warn('接分流失败（不影响启动）：' + e.message); }

/**
 * ① **启动时补压一次**：上次可能是被强杀/断电退出（Windows 硬杀不触发信号钩子），
 *    所以每次启动都把该压的会话压掉 —— 这样"关闭时压缩"这件事在事实上永远成立。
 * ② `--compact-sessions`：只压一次就退出（托盘"退出"和 `stop-bothub.mjs` 会先调它）。
 */
if (argv.includes('--compact-sessions')) {
  const done = compactAllSessions();
  log.info(`只做压缩后退出：压了 ${done.length} 个会话`);
  process.exit(0);
}
try { compactAllSessions(); } catch { /* 补压失败不能影响启动 */ }

const port = Number(val('--port', 0)) || cfg.http.port;
try {
  await startWeb({ port, host: cfg.http.host, hub, log });
} catch (e) {
  /**
   * 面板起不来要说清楚。最常见的两种：
   *   · `EADDRINUSE` —— 端口被占（很可能**已经有一个 BotHub 在跑**）
   *   · `EACCES` —— 端口被系统保留
   * 不包这层的话，进程会以一个 unhandled rejection 的栈告终，老板那边看到的就是"双击了没反应"。
   */
  const code = e && e.code;
  if (code === 'EADDRINUSE') log.error(`端口 ${port} 已经被占用 —— 多半是**已经有一个 BotHub 在跑**（同一个机器人不能同时挂两次）。先确认：双击 check-bothub.cmd；或改 config 里的 http.port。`);
  else if (code === 'EACCES') log.error(`端口 ${port} 没权限监听（被系统保留）——改 config 里 http.port 换个高位端口。`);
  else log.error('面板启动失败：' + (e && e.message));
  for (const b of bots) b.stop();
  process.exit(1);
}

// 心跳：给守护进程判断"是活着还是卡死了"用（光看进程在不在是不够的 —— 今天学到的）
const beat = () => writeJson(HEARTBEAT, { at: Date.now(), pid: process.pid, bots: bots.map((b) => ({ id: b.cfg.id, running: b.running, lastMessageAt: b.stats.lastMessageAt })) });
beat();
setInterval(beat, 15000);

// 进程级兜底：**绝不静默退出**
process.on('uncaughtException', (e) => log.error('未捕获异常（进程继续跑）：' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log.error('未处理的 Promise 拒绝：' + (e && e.stack || e)));
const bye = () => { log.info('收到退出信号，正在停止…'); for (const b of bots) b.stop(); setTimeout(() => process.exit(0), 500); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
process.on('SIGHUP', bye);

log.info(`BotHub 已启动：pid ${process.pid}，${bots.length} 个机器人，面板 http://${cfg.http.host}:${port}/`);
log.info(`机器：${os.hostname()} / Node ${process.version}`);
