/**
 * config.mjs —— BotHub 配置：加载、校验、保存。
 *
 * 配置文件：`config/bots.json`
 * {
 *   "http": { "port": 7788, "host": "127.0.0.1" },
 *   "channels": [                       ← 模型通道（一个通道 = 一个 OpenAI 兼容端点 + 一个模型）
 *     { "id": "qwen-flash", "kind": "openai",
 *       "baseURL": "https://.../compatible-mode/v1",
 *       "apiKey": "${ENV:QIANWEN_API_KEY}",
 *       "model": "qwen3.8-flash", "maxTokens": 2048, "temperature": 0.7 }
 *   ],
 *   "bots": [                           ← 机器人实例（可以挂很多个，各自绑不同通道）
 *     { "id": "qq-main", "enabled": true, "platform": "qq",
 *       "channel": "qwen-flash",
 *       "credentials": { "appId": "${SECRET:qq-main.appId}", "appSecret": "${SECRET:qq-main.appSecret}" },
 *       "mentionRequired": true,        ← 群里必须 @ 才回（官方规范默认就该这样）
 *       "persona": "你是我的电脑助手……",
 *       "groupAllow": [], "c2cAllow": [],
 *       "historyTurns": 12, "idleTimeoutMin": 30,
 *       "queue": { "maxQueue": 20, "maxProcessingMs": 300000, "ackThrottleMs": 30000 },
 *       "model": { "maxTokens": 2048 } }
 *   ]
 * }
 *
 * 校验原则：**有错就当场报清楚是哪一项、缺什么**，不要等运行到一半才炸。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, writeJson, resolveSecret, mask } from './util.mjs';

export const CONFIG_PATH = process.env.BOTHUB_CONFIG || path.join(ROOT, 'config', 'bots.json');

const isStr = (v) => typeof v === 'string' && v.trim() !== '';

export function loadConfig() {
  const cfg = readJson(CONFIG_PATH);
  if (!cfg) throw new Error(`读不到配置或不是合法 JSON：${CONFIG_PATH}`);

  const errors = [];
  /**
   * 一个「凭证」= 一组 appId/appSecret，**最多挂 4 个机器人**（老板要求）。
   *
   * ⛔ 平台硬约束：**一个 appId 同时只能有一个连接**（两条连接会抢事件，
   *    表现就是当初那个"时好时坏、有时不理人"）。所以同一个凭证下的 4 个机器人
   *    **共用一条连接**：第一个启用的当"连接者"，其余按**群/私聊白名单分流**。
   */
  const MAX_BOTS_PER_CRED = 4;
  const credentialWarnings = [];
  const keyWarnings = [];          // 通道 key 没填：提醒，不算错   // 凭据没填：提醒，不算错
  const channels = new Map();
  for (const [i, ch] of (cfg.channels || []).entries()) {
    const where = `channels[${i}]`;
    if (!isStr(ch.id)) { errors.push(`${where}: 缺 id`); continue; }
    if (channels.has(ch.id)) errors.push(`${where}: id 重复（${ch.id}）`);
    // `kind: "echo"` 是本地假通道（测试用），不需要 baseURL/model/key
    if (ch.kind === 'echo') {
      channels.set(ch.id, { ...ch, _key: null });
      continue;
    }
    // `kind: "dsh"` 走 DSH 本体（会干活的那个），同样不需要 baseURL/model/key
    if (ch.kind === 'dsh') {
      channels.set(ch.id, { ...ch, profile: ch.profile || 'headless', _key: null });
      continue;
    }
    if (!isStr(ch.baseURL)) errors.push(`${where}(${ch.id}): 缺 baseURL`);
    if (!isStr(ch.model)) errors.push(`${where}(${ch.id}): 缺 model`);
    const key = resolveSecret(ch.apiKey);
    /**
     * ⛔ apiKey 取不到**不算配置错误**（2026-10-15 改，跟凭据同一条理由）：
     *    面板上「+ 新增机器人」时用户会先选"云端/本地"，baseURL 和 key 还来不及填；
     *    如果这里抛错，整个配置就非法 → 新机器人被回滚 → 用户看到"加了但没出现"（我实测踩到）。
     *    现在只提醒：通道以"缺 key"状态存在，填上 key 就能用，调用时会给出明确错误。
     */
    if (!key) keyWarnings.push(`${ch.id}: apiKey 还没填（${ch.apiKey}）`);
    channels.set(ch.id, { ...ch, _key: key, missingKey: !key });
  }
  if (!channels.size) errors.push('channels: 至少要有一个模型通道');

  /** 凭证表：id → { id, label, appId, appSecret, missing }（`credentials[]`，旧配置里机器人自带的也算一条隐式凭证） */
  const creds = new Map();
  for (const [i, c] of (cfg.credentials || []).entries()) {
    if (!isStr(c?.id)) { errors.push(`credentials[${i}]: 缺 id`); continue; }
    const appIdC = resolveSecret(c.appId);
    const appSecretC = resolveSecret(c.appSecret);
    creds.set(c.id, { id: c.id, label: c.label || c.id, appId: appIdC, appSecret: appSecretC, missing: !appIdC || !appSecretC });
  }
  const bots = new Map();
  for (const [i, b] of (cfg.bots || []).entries()) {
    const where = `bots[${i}]`;
    if (!isStr(b.id)) { errors.push(`${where}: 缺 id`); continue; }
    if (bots.has(b.id)) errors.push(`${where}: id 重复（${b.id}）`);
    if (!isStr(b.channel)) errors.push(`${where}(${b.id}): 缺 channel（要用哪个模型通道）`);
    else if (!channels.has(b.channel)) errors.push(`${where}(${b.id}): channel "${b.channel}" 不在 channels 里`);
    const platform = b.platform || 'qq';
    let appId = null, appSecret = null;
    /**
     * ⚠️ 凭据解析要**在 mock 判断之前**做：mock 机器人虽然不用凭据去连平台，
     *    但它也要**归属到某条凭证**上，否则"一个凭证挂 4 个机器人"的分流对它就不成立
     *    （我第一次把这段放在 `else`（qq 分支）里，结果 mock 机器人的 credential 是 null，
     *      分流一次都没接上 —— 用 mock 做端到端验证时才发现）。
     */
    /**
     * 老板的规则里「默认凭据」= **初始机器人自带的那条**（implicit-<初始机器人 id>）。
     * 所以：机器人没写 credential 也没写 credentials 时，一律落到这条上 ——
     * 这样"新增时选默认凭据"的新机器人跟初始机器人才是**同一条凭据**（共用连接、一起算 4 个配额）。
     * ⛔ 之前是"每个机器人各自隐式一条"，结果同一个 appId 被判成两个凭据 → 被"抢连接"规则拦下。
     */
    const initialIdEarly = String((cfg.bots && cfg.bots[0] && cfg.bots[0].id) || '');
    const implicitDefault = initialIdEarly ? ("implicit-" + initialIdEarly) : null;
    let cred = null;      // 声明在 if/else **外面**：下面机器人对象也要用它
    /**
     * ⛔ 关键：机器人**自带凭据**（`credentials: {appId: "${SECRET:…}"}`）时，
     *    即使配置里被写上了 `credential: "implicit-<它自己>"`，也必须走下面那条解析分支 ——
     *    否则密钥不会被解析（日志："还没填 appId / appSecret"）→ 机器人直接连不上。
     *    （老板的机器人 22:54 掉线就是这个原因：配置里有这行，被这个显式分支截走了。）
     */
    const ownImplicit = 'implicit-' + b.id;
    const isOwnImplicit = isStr(b.credential) && b.credential === ownImplicit;
    if (isStr(b.credential) && !(b.credentials && isOwnImplicit)) {
      cred = creds.get(b.credential) || null;
      /**
       * 「初始凭据」= 初始机器人自带的那条隐式凭据（implicit-<初始机器人 id>）。
       * 它不在 credentials[] 里（是内存里生成的），但**必须算合法** ——
       * 否则"新增机器人时选默认凭据"会被校验拦掉
       * （实测报过：credential "implicit-qq-main" 不在 credentials 里）。
       */
      const implicitOf = 'implicit-' + String((cfg.bots && cfg.bots[0] && cfg.bots[0].id) || '');
      if (!cred && b.credential === implicitOf) cred = { id: b.credential, label: '初始凭据（机器人自带）' };
      if (!cred) errors.push(`${where}(${b.id}): credential "${b.credential}" 不在 credentials 里`);
    } else if (b.credentials) {
      const cid = 'implicit-' + b.id;
      cred = {
        id: cid,
        label: (b.alias || b.id) + '（自带）',
        appId: resolveSecret(b.credentials.appId),
        appSecret: resolveSecret(b.credentials.appSecret),
        implicit: true,
      };
      cred.missing = !cred.appId || !cred.appSecret;
      creds.set(cid, cred);
    }
    if (platform === 'mock') {
      // 假机器人：本地测试用，不连平台（appId 只是占位，方便看日志）
      appId = 'mock-app';
      appSecret = 'mock-secret';
    } else {
      appId = cred?.appId || null;
      appSecret = cred?.appSecret || null;
      /**
       * ⛔ 凭据取不到**不算配置错误**（2026-10-15 改）：全新安装时用户手里还没有 appId/appSecret，
       *    如果这里抛错，应用起不来 → 面板打不开 → 首次向导永远没机会弹（死锁）。
       *    现在只记一条提醒，机器人以"等凭据"状态存在，面板向导填完立刻就能连。
       */
      if (!appId) credentialWarnings.push(`${b.id}: appId 还没填`);
      if (!appSecret) credentialWarnings.push(`${b.id}: appSecret 还没填`);
    }
    bots.set(b.id, {
      id: b.id,
      alias: (typeof b.alias === 'string' && b.alias.trim()) ? b.alias.trim() : b.id,
      // 面板上给这个机器人单独选的模型（空 = 跟随通道/DSH 默认）
      model: (typeof b.model === 'string' && b.model.trim()) ? b.model.trim() : null,
      provider: (typeof b.provider === 'string' && b.provider.trim()) ? b.provider.trim() : null,
      // 推理等级（低/中/高；空 = 跟随 DSH）
      reasoningEffort: (typeof b.reasoningEffort === 'string' && b.reasoningEffort.trim()) ? b.reasoningEffort.trim() : null,
      // 权限预设：read-only / workspace-write / danger-full-access（空 = 跟随 DSH）
      permission: (typeof b.permission === 'string' && b.permission.trim()) ? b.permission.trim() : null,
      // 只聊天：把工具插件全关掉（它只会说话，不动手）
      noTools: b.noTools === true,
      enabled: b.enabled !== false,
      platform,
      channel: b.channel,
      mentionRequired: b.mentionRequired !== false,
      persona: b.persona || '',
      groupAllow: b.groupAllow || [],
      c2cAllow: b.c2cAllow || [],
      historyTurns: Number.isFinite(b.historyTurns) ? b.historyTurns : 12,
      idleTimeoutMin: Number.isFinite(b.idleTimeoutMin) ? b.idleTimeoutMin : 30,   // ⚠️ 2026-10-15 起不再用于判定新会话（只有 /新会话 才开新的），保留只为兼容旧配置
      queue: {
        maxQueue: Number.isFinite(b.queue?.maxQueue) ? b.queue.maxQueue : 20,
        maxProcessingMs: Number.isFinite(b.queue?.maxProcessingMs) ? b.queue.maxProcessingMs : 5 * 60 * 1000,
        ackThrottleMs: Number.isFinite(b.queue?.ackThrottleMs) ? b.queue.ackThrottleMs : 30 * 1000,
      },
      limits: {
        perPeerPerMin: Number.isFinite(b.limits?.perPeerPerMin) ? b.limits.perPeerPerMin : 8,
        dedupeWindowMs: Number.isFinite(b.limits?.dedupeWindowMs) ? b.limits.dedupeWindowMs : 5 * 60 * 1000,
      },
      /**
       * 自定义指令（每个机器人一套）。四种动作：
       *   { name:'/状态', desc:'看它还活着吗', action:'status' }
       *   { name:'/重启', desc:'重启它自己',     action:'restart' }
       *   { name:'/日志', desc:'最近 10 行',     action:'logs' }
       *   { name:'/规矩', desc:'…', reply:'直接把这段话发出去' }
       *   { name:'/问',   desc:'…', prompt:'先按这个提示理解，再回答：' }   ← 剩下的内容交给模型
       * 匹配规则：整条消息等于指令名，或者以"指令名 + 空格"开头（都忽略大小写）。
       * 内置 `/帮助` 永远可用（列出这套指令）。
       */
      commands: Array.isArray(b.commands)
        ? b.commands.filter((c) => c && typeof c.name === 'string' && c.name.trim()).map((c) => ({
            name: c.name.trim(),
            desc: c.desc || '',
            enabled: c.enabled !== false,      // ← 界面上的开关：临时停用一条指令，不用删掉它
            action: c.action || null,          // status | restart | logs | help
            reply: typeof c.reply === 'string' ? c.reply : null,
            prompt: typeof c.prompt === 'string' ? c.prompt : null,
          }))
        : [],
      credential: cred?.id || null,
      credentialLabel: cred?.label || null,
      _appId: appId,
      _appSecret: appSecret,
      credentialsMissing: !appId || !appSecret,
    });
  }

  if (errors.length) {
    const e = new Error('配置有问题：\n  - ' + errors.join('\n  - '));
    e.configErrors = errors;
    throw e;
  }

  /**
   * ★ 同一个 appId 只能给一个机器人用（2026-10-15 补）。
   *
   * 为什么必须拦：今天最痛的那个故障就是"**两个进程抢同一个 QQ 连接**"——
   * 事件会被拆到两边，表现出来是"时好时坏、有时不理人"。如果在**同一个应用里**
   * 配两个机器人用同一个 appId，等于把那个故障原地复现一遍（两个 Bot 实例各自建连）。
   * 所以配置阶段就要拦住，而不是等它上线后时好时坏。
   * （`mock` 是本地假机器人，不连平台，不参与这条检查。）
   */
  /** 初始机器人 = 配置文件里的第一个（默认那个）；它不占凭据配额（老板的规则） */
  const initialBotId = String((cfg.bots && cfg.bots[0] && cfg.bots[0].id) || '');
  const byAppId = new Map();        // appId → 机器人（跨凭证也不许重复，会抢连接）
  const perCred = new Map();        // 凭证 id → [机器人]
  for (const b of bots.values()) {
    // ⚠️ mock 也参与分组：它是本地假机器人（不连平台），正好用来**验证"同凭证分流"**
    //    （真平台上没法用假凭据连着测）。
    // ① 一个凭证最多挂 4 个机器人
    if (b.credential) {
      /**
       * 老板的规则：**初始机器人不占配额** —— 初始凭据也还能再挂 4 个新机器人；
       * 一个凭据挂满 4 个（不含初始那个）之后，既不能再绑它、也不能用它建新机器人。
       * 「初始机器人」= 配置文件 bots[] 里的**第一个**（默认那个）。
       */
      const arr = perCred.get(b.credential) || [];
      arr.push(b);
      perCred.set(b.credential, arr);
      const countWithoutInitial = arr.filter((x) => x.id !== initialBotId).length;
      if (countWithoutInitial > MAX_BOTS_PER_CRED) {
        const e = new Error('配置有问题：\n  - 凭证 ' + b.credential + ' 挂了 ' + arr.length + ' 个机器人（' + arr.map((x) => x.id).join('、') + '）—— ' +
          '一个凭证最多 ' + MAX_BOTS_PER_CRED + ' 个（初始机器人不算在内）。多出来的请另开一个凭证（面板上「+ 新增凭证」）。');
        e.configErrors = [e.message];
        throw e;
      }
    }
    // ② 同一个 appId 不许出现在两个不同凭证里（同一凭证下共用一个连接是允许的）
    if (!b.enabled || !b._appId) continue;
    const seen = byAppId.get(b._appId);
    if (seen && seen.credential !== b.credential) {
      const e = new Error('配置有问题：\n  - 机器人 ' + seen.id + ' 和 ' + b.id + ' 分别在两个凭证里用了**同一个 appId** —— ' +
        '同一个机器人账号只能有一个连接（否则互相抢事件，表现成"时好时坏、有时不理人"）。\n' +
        '    把它们放进同一个凭证（一个凭证最多 4 个机器人），或者换一个 appId。');
      e.configErrors = [e.message];
      throw e;
    }
    if (!seen) byAppId.set(b._appId, b);
  }

  /**
   * 同一个凭证下的多个机器人 → **只让第一个启用的去连**（连接者），
   * 其余标成"共用连接"：消息进来时由连接者按**群/私聊白名单**分流给对应机器人。
   * 为什么必须这样：一个 appId 两条连接 = 抢事件（当初最痛的那个故障）。
   */
  for (const arr of perCred.values()) {
    const enabled = arr.filter((b) => b.enabled);
    const connector = enabled[0] || null;
    for (const b of arr) {
      b.sharedCredential = !!(connector && b.id !== connector.id);
      b.connectorId = connector ? connector.id : null;
      b.isConnector = !!(connector && b.id === connector.id);
    }
  }
  /** 面板用：凭证清单（只给 id/名字/掩码，绝不给明文）+ 每个机器人挂在哪条凭证上 */
  const credentialList = [...creds.values()].map((c) => ({
    id: c.id,
    label: c.label,
    implicit: !!c.implicit,
    missing: !!c.missing,
    appIdMasked: c.appId ? mask(c.appId) : null,
    // 轻掩码：appId 不是秘密，界面上要能认出是哪一个（跟 util.mjs 的 lightMask 同一套规则）
    appIdShown: c.appId ? String(c.appId).slice(0, 3) + '*****' + String(c.appId).slice(-2) : null,
    bots: [...bots.values()].filter((b) => b.credential === c.id).map((b) => b.id),
    maxBots: MAX_BOTS_PER_CRED,
  }));

  return {
    raw: cfg,
    http: { port: Number(cfg.http?.port) || 7788, host: cfg.http?.host || '127.0.0.1' },
    channels,
    credentials: creds,
    credentialList,
    keyWarnings,
    bots,
    path: CONFIG_PATH,
  };
}

/** 读原始配置文本（给面板的编辑器用）——**原文里只有 ${ENV:...} 之类的引用，没有真密钥** */
export function readConfigText() {
  try { return fs.readFileSync(CONFIG_PATH, 'utf8'); } catch { return ''; }
}

/**
 * 保存面板改过的配置：**先校验再落盘**，校验不过就一个字都不写。
 * 顺序很重要 —— 直接写盘的话，一个手滑就能让下次启动直接起不来（今天已经吃过一次配置炸的亏）。
 */
export function saveConfigText(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return { ok: false, error: 'JSON 语法错误：' + e.message }; }
  const bak = CONFIG_PATH + '.bak';
  try { if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, bak); } catch { /* ignore */ }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, text, 'utf8');
  try {
    loadConfig();           // 用真校验器验一遍（含密钥能否取到）
  } catch (e) {
    // 校验没过 → 回滚，绝不让坏配置留在盘上
    try { if (fs.existsSync(bak)) fs.copyFileSync(bak, CONFIG_PATH); } catch { /* ignore */ }
    return { ok: false, error: '配置校验没过（已回滚，盘上还是旧的）：\n' + e.message };
  }
  return { ok: true, backup: bak, note: '已保存并通过校验；要让新的机器人/通道生效，点「重启应用」。' };
}

/** 供面板展示：把密钥一律换成掩码 */
export function publicConfig(cfg) {
  return {
    path: cfg.path,
    http: cfg.http,
    /** 凭证清单（只给 id/名字/掩码；明文永远不出这个函数）+ 每条凭证挂了哪些机器人 */
    credentials: cfg.credentialList || [],
    maxBotsPerCred: 4,
    // 初始机器人 = Map 里的第一个（= 配置文件里的第一个）。界面靠它判断「初始机器人不占配额」。
    // ⛔ 这里**不能**直接写 initialBotId —— 那个常量在 loadConfig 的局部作用域里，
    //    在 publicConfig 里是未定义的（实测 doctor 直接报 "initialBotId is not defined"）。
    initialBotId: [...cfg.bots.keys()][0] || '',
    channels: [...cfg.channels.values()].map((c) => ({
      id: c.id, kind: c.kind || 'openai', baseURL: c.baseURL, model: c.model,
      apiKey: mask(c._key), maxTokens: c.maxTokens ?? null, temperature: c.temperature ?? null,
    })),
    bots: [...cfg.bots.values()].map((b) => ({
      id: b.id, alias: b.alias, enabled: b.enabled, platform: b.platform, channel: b.channel, model: b.model, provider: b.provider, reasoningEffort: b.reasoningEffort, permission: b.permission, noTools: b.noTools,
      credential: b.credential, credentialLabel: b.credentialLabel,
      sharedCredential: !!b.sharedCredential, connectorId: b.connectorId, isConnector: !!b.isConnector,
      mentionRequired: b.mentionRequired, personaLength: (b.persona || '').length,
      groupAllow: b.groupAllow, c2cAllow: b.c2cAllow,
      historyTurns: b.historyTurns, idleTimeoutMin: b.idleTimeoutMin,
      queue: b.queue,
      appId: mask(b._appId), appSecret: mask(b._appSecret),
    })),
  };
}

/** 写一份示例配置（第一次跑、或者老板想从模板开始） */
export function writeExample() {
  if (fs.existsSync(CONFIG_PATH)) return false;
  writeJson(CONFIG_PATH, {
    http: { port: 7788, host: '127.0.0.1' },
    channels: [
      {
        /**
         * 默认就是一条 **DSH 通道**（老板要求："默认开启就自动连接电脑上的 DSH"）——
         * 会干活（读文件、跑命令、用技能），也才谈得上"每个机器人单独的模型 / 推理等级 / 操作权限"。
         * DSH 本体在哪由 `resolveDshExe()` 自动找（环境变量 → 配置 → 标准安装位置），找不到会明确报错。
         * 想只用云端模型，再加一条 `kind: 'openai'` 的通道即可。
         */
        id: 'dsh-local',
        kind: 'dsh',
        profile: 'headless',
        timeoutMs: 240000,
      },
    ],
    bots: [
      {
        id: 'qq-main',
        enabled: true,
        platform: 'qq',
        channel: 'dsh-local',
        // 默认给一个安全又好用的权限：只能在它自己的工作目录里写
        permission: 'workspace-write',
        // 默认指向 BotHub 自己的密钥库（面板「凭据」里填的）；也可以用 ${DSHQqbot:appId} 指向 DSH 的 profile
    credentials: { appId: '${SECRET:qq-main.appId}', appSecret: '${SECRET:qq-main.appSecret}' },
        mentionRequired: true,
        persona: '你是老板电脑上的 AI 助手，中文说话，简洁直接。',
        groupAllow: [],
        c2cAllow: [],
        historyTurns: 12,
        idleTimeoutMin: 30,
        queue: { maxQueue: 20, maxProcessingMs: 300000, ackThrottleMs: 30000 },
      },
    ],
  });
  return true;
}
